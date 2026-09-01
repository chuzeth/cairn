import type { DailyCheckIn, PmcSeries, ReadinessScore } from '@cairn/core';
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
  let subjective = 60;
  if (today) {
    const sleepScore = today.sleepHours != null ? clamp((today.sleepHours - 5) / 3, 0, 1) * 100 : 60;
    const sleepQ = today.sleepQuality != null ? ((today.sleepQuality - 1) / 4) * 100 : 60;
    const soreness = today.soreness != null ? ((5 - today.soreness) / 4) * 100 : 60;
    const stress = today.stress != null ? ((5 - today.stress) / 4) * 100 : 60;
    const motivation = today.motivation != null ? ((today.motivation - 1) / 4) * 100 : 60;
    subjective =
      sleepScore * 0.25 + sleepQ * 0.2 + soreness * 0.25 + stress * 0.15 + motivation * 0.15;
  }

  // ── Composante autonome (HRV / FC de repos) ───────────────────────────────
  let autonomic = 60;
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
  } else if (today?.restingHr != null && rhrBase != null && rhrBase > 0) {
    const delta = today.restingHr - rhrBase;
    autonomic = clamp(65 - delta * 7, 0, 100);
  }

  // ── Pénalité de pic de charge ─────────────────────────────────────────────
  const acwrValue = acwr?.value ?? 0;
  const acwrPenalty =
    acwrValue > 1.5 ? -18 : acwrValue > 1.3 ? -8 : acwrValue > 0 && acwrValue < 0.7 ? -4 : 0;

  const score = clamp(
    tsbMetabolic * 0.26 +
      tsbMechanical * 0.22 +
      subjective * 0.32 +
      autonomic * 0.2 +
      acwrPenalty,
    0,
    100,
  );

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
