import type { DailyCheckIn, PmcSeries, ReadinessScore, ReadinessSource } from '@cairn/core';
import { clamp, mean } from './units.js';

/**
 * Disponibilité à l'entraînement.
 *
 * Le TSB seul ment : il ignore le sommeil, le stress, les courbatures et l'état
 * du système nerveux autonome. Les modèles de charge sont des modèles de
 * *dose*, pas de *réponse*. Ce score combine les deux — objectif et subjectif —
 * et reste totalement explicable : chaque composante est visible, l'athlète
 * comprend pourquoi le coach lui propose de lever le pied.
 */

export interface ReadinessInput {
  date: string;
  pmc: PmcSeries;
  checkIns: DailyCheckIn[];
  /** Base de référence pour la HRV (moyenne des 30 derniers jours). */
  hrvBaseline?: number;
  /** Base de référence pour la FC de repos. */
  restingHrBaseline?: number;
}

const pointAt = <T extends { date: string }>(series: readonly T[], date: string): T | undefined =>
  series.find((p) => p.date === date) ?? series[series.length - 1];

/** Poids des quatre composantes dans le score final. */
const WEIGHT = { tsbMetabolic: 0.26, tsbMechanical: 0.22, subjective: 0.32, autonomic: 0.2 } as const;

/** Poids des cinq réponses dans la composante subjective — ils somment à 1. */
const SUBJECTIVE_WEIGHT = {
  sleepHours: 0.25,
  sleepQuality: 0.2,
  soreness: 0.25,
  stress: 0.15,
  motivation: 0.15,
} as const;

/** Valeur retenue quand rien n'est déclaré : ni bonne, ni mauvaise, ni mesurée. */
const NEUTRAL = 60;

export function computeReadiness(input: ReadinessInput): ReadinessScore {
  const { date, pmc, checkIns } = input;
  const today = checkIns.find((c) => c.date === date);

  const metabolic = pointAt(pmc.metabolic, date);
  const mechanical = pointAt(pmc.mechanical, date);
  const acwr = pointAt(pmc.acwr, date);

  // ── Composante métabolique ────────────────────────────────────────────────
  // Un TSB très négatif pèse, mais un TSB très positif n'est pas un bonus
  // infini : on plafonne, un athlète trop frais n'est pas mieux préparé.
  const tsbM = metabolic?.tsb ?? 0;
  const tsbMetabolic = clamp(50 + tsbM * 1.4, 0, 100);

  // ── Composante mécanique ──────────────────────────────────────────────────
  // La fatigue musculaire pèse plus lourd sur la disponibilité réelle en trail :
  // on peut avoir le cœur frais et des quadriceps hors service.
  const tsbMech = mechanical?.tsb ?? 0;
  const tsbMechanical = clamp(50 + tsbMech * 2.0, 0, 100);

  // ── Composante subjective ─────────────────────────────────────────────────
  // Une réponse partielle vaut mieux qu'aucune : chaque question absente
  // retombe sur la valeur neutre, et son poids est compté comme supposé.
  const answers: { key: keyof typeof SUBJECTIVE_WEIGHT; value: number | null }[] = [
    { key: 'sleepHours', value: today?.sleepHours != null ? clamp((today.sleepHours - 5) / 3, 0, 1) * 100 : null },
    { key: 'sleepQuality', value: today?.sleepQuality != null ? ((today.sleepQuality - 1) / 4) * 100 : null },
    { key: 'soreness', value: today?.soreness != null ? ((5 - today.soreness) / 4) * 100 : null },
    { key: 'stress', value: today?.stress != null ? ((5 - today.stress) / 4) * 100 : null },
    { key: 'motivation', value: today?.motivation != null ? ((today.motivation - 1) / 4) * 100 : null },
  ];

  let subjective = 0;
  let subjectiveAssumed = 0;
  for (const { key, value } of answers) {
    const w = SUBJECTIVE_WEIGHT[key];
    subjective += (value ?? NEUTRAL) * w;
    if (value == null) subjectiveAssumed += w;
  }

  // ── Composante autonome (HRV / FC de repos) ───────────────────────────────
  let autonomic = NEUTRAL;
  let autonomicSource: ReadinessSource = 'default';
  const hrvBase =
    input.hrvBaseline ??
    mean(checkIns.slice(-30).map((c) => c.hrvRmssd ?? null)) ??
    undefined;
  const rhrBase =
    input.restingHrBaseline ??
    mean(checkIns.slice(-30).map((c) => c.restingHr ?? null)) ??
    undefined;

  if (today?.hrvRmssd != null && hrvBase != null && hrvBase > 0) {
    // Un rMSSD de 10 % sous sa base est un signal fort de fatigue autonome.
    const ratio = today.hrvRmssd / hrvBase;
    autonomic = clamp(50 + (ratio - 1) * 320, 0, 100);
    autonomicSource = 'hrv';
  } else if (today?.restingHr != null && rhrBase != null && rhrBase > 0) {
    const delta = today.restingHr - rhrBase;
    autonomic = clamp(65 - delta * 7, 0, 100);
    autonomicSource = 'resting-hr';
  }

  // ── Pénalité de pic de charge ─────────────────────────────────────────────
  const acwrValue = acwr?.value ?? 0;
  const acwrPenalty =
    acwrValue > 1.5 ? -18 : acwrValue > 1.3 ? -8 : acwrValue > 0 && acwrValue < 0.7 ? -4 : 0;

  const score = clamp(
    tsbMetabolic * WEIGHT.tsbMetabolic +
      tsbMechanical * WEIGHT.tsbMechanical +
      subjective * WEIGHT.subjective +
      autonomic * WEIGHT.autonomic +
      acwrPenalty,
    0,
    100,
  );

  // ── Provenance ────────────────────────────────────────────────────────────
  // Un score dont la moitié du poids sort d'une valeur par défaut ne dit pas la
  // même chose qu'un score mesuré. On expose de quoi le dire.
  const sources: ReadinessScore['sources'] = {
    tsbMetabolic: metabolic ? 'load' : 'default',
    tsbMechanical: mechanical ? 'load' : 'default',
    subjective:
      subjectiveAssumed <= 1e-9 ? 'declared' : subjectiveAssumed >= 1 - 1e-9 ? 'default' : 'partial',
    autonomic: autonomicSource,
  };
  const assumedShare =
    WEIGHT.tsbMetabolic * (metabolic ? 0 : 1) +
    WEIGHT.tsbMechanical * (mechanical ? 0 : 1) +
    WEIGHT.subjective * subjectiveAssumed +
    WEIGHT.autonomic * (autonomicSource === 'default' ? 1 : 0);

  const verdict: ReadinessScore['verdict'] = score >= 68 ? 'green' : score >= 45 ? 'amber' : 'red';

  return {
    date,
    score: Math.round(score),
    components: {
      tsbMetabolic: Math.round(tsbMetabolic),
      tsbMechanical: Math.round(tsbMechanical),
      subjective: Math.round(subjective),
      autonomic: Math.round(autonomic),
      acwrPenalty,
    },
    sources,
    assumedShare: Math.round(assumedShare * 100) / 100,
    verdict,
    recommendation: recommend(verdict, {
      tsbM,
      tsbMech,
      acwr: acwrValue,
      soreness: today?.soreness,
      sleep: today?.sleepHours,
    }),
  };
}

function recommend(
  verdict: ReadinessScore['verdict'],
  ctx: { tsbM: number; tsbMech: number; acwr: number; soreness?: number; sleep?: number },
): string {
  const reasons: string[] = [];
  if (ctx.tsbMech < -12) reasons.push('fatigue musculaire élevée (charge excentrique récente)');
  if (ctx.tsbM < -25) reasons.push('charge métabolique très supérieure à la récupération');
  if (ctx.acwr > 1.5) reasons.push(`pic de charge marqué (ACWR ${ctx.acwr.toFixed(2)})`);
  if (ctx.soreness != null && ctx.soreness >= 4) reasons.push('courbatures importantes déclarées');
  if (ctx.sleep != null && ctx.sleep < 6) reasons.push(`sommeil court (${ctx.sleep} h)`);

  const because = reasons.length ? ` — ${reasons.join(', ')}` : '';

  switch (verdict) {
    case 'green':
      return `Feu vert : la séance prévue peut être exécutée telle quelle${because}.`;
    case 'amber':
      return (
        `Vigilance${because}. Garde la séance mais réduis le volume de 20-30 %, ou décale la ` +
        `qualité de 24 h si les sensations ne viennent pas à l'échauffement.`
      );
    case 'red':
      return (
        `Signal rouge${because}. Remplace la séance par de la récupération active ou du repos complet. ` +
        `Une séance forcée dans cet état coûte plus qu'elle ne rapporte.`
      );
  }
}
