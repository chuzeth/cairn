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

/**
 * Poids nominaux des quatre composantes.
 *
 * Ils ne s'appliquent qu'à ce qui a une source. Une composante muette est
 * retirée du calcul et son poids se répartit sur les autres au prorata :
 * réserver un cinquième du score à un signal absent revient à diluer les
 * signaux présents d'autant.
 */
const WEIGHT = { tsbMetabolic: 0.26, tsbMechanical: 0.22, subjective: 0.32, autonomic: 0.2 } as const;
type Component = keyof typeof WEIGHT;
const COMPONENTS = Object.keys(WEIGHT) as Component[];

/**
 * Poids des six réponses dans la composante subjective — ils somment à 1.
 *
 * L'échelle de Hooper suit fatigue, sommeil, courbatures, stress et humeur.
 * La fatigue perçue y est l'item qui répond le plus vite à la charge : elle
 * pèse le plus lourd. La même règle qu'au-dessus s'applique en dessous — une
 * question sans réponse ne pèse pas.
 */
const SUBJECTIVE_WEIGHT = {
  fatigue: 0.25,
  sleepHours: 0.18,
  sleepQuality: 0.15,
  soreness: 0.18,
  stress: 0.12,
  motivation: 0.12,
} as const;
type Item = keyof typeof SUBJECTIVE_WEIGHT;
const ITEMS = Object.keys(SUBJECTIVE_WEIGHT) as Item[];

/** Valeur retenue quand *rien* n'est relevé : ni bonne, ni mauvaise, ni mesurée. */
const NEUTRAL = 60;

/**
 * Chaque réponse ramenée sur 0–100, dans le sens « plus haut, mieux ».
 *
 * C'est la seule échelle absolue du fichier, et elle ne sert qu'à défaut de
 * ligne de base personnelle.
 */
const NORMALIZE: Record<Item, (c: DailyCheckIn) => number | null> = {
  fatigue: (c) => (c.fatigue != null ? ((5 - c.fatigue) / 4) * 100 : null),
  sleepHours: (c) => (c.sleepHours != null ? clamp((c.sleepHours - 5) / 3, 0, 1) * 100 : null),
  sleepQuality: (c) => (c.sleepQuality != null ? ((c.sleepQuality - 1) / 4) * 100 : null),
  soreness: (c) => (c.soreness != null ? ((5 - c.soreness) / 4) * 100 : null),
  stress: (c) => (c.stress != null ? ((5 - c.stress) / 4) * 100 : null),
  motivation: (c) => (c.motivation != null ? ((c.motivation - 1) / 4) * 100 : null),
};

/**
 * Ligne de base du ressenti.
 *
 * Le rMSSD se lit contre sa propre moyenne ; une échelle 1–5 doit se lire
 * pareil. Six heures et demie de sommeil ne sont un déficit que pour qui dort
 * huit heures. Sous BASELINE_MIN déclarations d'une question, sa moyenne n'est
 * que du bruit et l'échelle absolue reste seule ; à BASELINE_FULL elle la
 * remplace entièrement ; entre les deux les deux lectures se mélangent, pour
 * qu'aucune journée ne fasse basculer le score d'un coup.
 */
const BASELINE_WINDOW = 30;
const BASELINE_MIN = 7;
const BASELINE_FULL = 28;
/** Un cran d'écart (25 points) sous sa propre norme vaut 50 → 20 : un signal, pas un frisson. */
const BASELINE_GAIN = 1.2;

export function computeReadiness(input: ReadinessInput): ReadinessScore {
  const { date, pmc, checkIns } = input;
  const today = checkIns.find((c) => c.date === date);
  // Strictement avant aujourd'hui : une moyenne qui contient le jour qu'elle
  // sert à juger atténue l'écart qu'on cherche à voir.
  const history = checkIns
    .filter((c) => c.date < date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-BASELINE_WINDOW);

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
  // Chaque réponse est lue contre la norme de l'athlète dès qu'il en a une, et
  // les questions restées vides ne pèsent pas : leur poids revient aux autres.
  let subjectiveSum = 0;
  let subjectiveWeight = 0;
  let answered = 0;
  let baselined = 0;
  for (const item of ITEMS) {
    const absolute = today ? NORMALIZE[item](today) : null;
    if (absolute == null) continue;
    answered++;

    const past = history.map(NORMALIZE[item]).filter((v): v is number => v != null);
    const trust = clamp((past.length - BASELINE_MIN) / (BASELINE_FULL - BASELINE_MIN), 0, 1);
    let value = absolute;
    if (trust > 0) {
      const norm = mean(past) ?? absolute;
      const relative = clamp(50 + (absolute - norm) * BASELINE_GAIN, 0, 100);
      value = absolute + (relative - absolute) * trust;
      baselined++;
    }

    subjectiveSum += value * SUBJECTIVE_WEIGHT[item];
    subjectiveWeight += SUBJECTIVE_WEIGHT[item];
  }
  const subjective = subjectiveWeight > 0 ? subjectiveSum / subjectiveWeight : NEUTRAL;

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

  // ── Poids effectifs ───────────────────────────────────────────────────────
  // Ce que personne n'a mesuré ne vote pas. Faute de la moindre source, on garde
  // les poids nominaux sur des valeurs neutres — et on l'avoue par assumedShare.
  const value: Record<Component, number> = { tsbMetabolic, tsbMechanical, subjective, autonomic };
  const sourced: Record<Component, boolean> = {
    tsbMetabolic: metabolic != null,
    tsbMechanical: mechanical != null,
    subjective: answered > 0,
    autonomic: autonomicSource !== 'default',
  };
  const sourcedWeight = COMPONENTS.reduce((s, k) => s + (sourced[k] ? WEIGHT[k] : 0), 0);
  const weights = roundToPercent(
    COMPONENTS.reduce((acc, k) => {
      acc[k] = sourcedWeight > 0 ? (sourced[k] ? WEIGHT[k] / sourcedWeight : 0) : WEIGHT[k];
      return acc;
    }, {} as Record<Component, number>),
  );

  const score = clamp(
    COMPONENTS.reduce((s, k) => s + value[k] * weights[k], 0) + acwrPenalty,
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
      answered === 0 ? 'default'
      : answered < ITEMS.length ? 'partial'
      : baselined === answered ? 'baseline'
      : 'declared',
    autonomic: autonomicSource,
  };
  const assumedShare = sourcedWeight > 0 ? 0 : 1;

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
    weights,
    assumedShare,
    verdict,
    recommendation: recommend(verdict, {
      tsbM,
      tsbMech,
      acwr: acwrValue,
      fatigue: today?.fatigue,
      soreness: today?.soreness,
      sleep: today?.sleepHours,
    }),
  };
}

/**
 * Arrondit des poids au pour cent en gardant leur somme à 1 (plus fort reste).
 *
 * Le score est calculé avec ces poids-là, pas avec les poids exacts : ce qui est
 * affiché est ce qui a servi, et quatre pourcentages affichés font bien 100.
 */
function roundToPercent(w: Record<Component, number>): Record<Component, number> {
  const parts = COMPONENTS.map((key) => {
    const exact = w[key] * 100;
    return { key, pct: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left =
    Math.round(COMPONENTS.reduce((s, k) => s + w[k] * 100, 0)) -
    parts.reduce((s, p) => s + p.pct, 0);
  for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left-- <= 0) break;
    p.pct++;
  }
  return parts.reduce((acc, p) => {
    acc[p.key] = p.pct / 100;
    return acc;
  }, {} as Record<Component, number>);
}

function recommend(
  verdict: ReadinessScore['verdict'],
  ctx: {
    tsbM: number;
    tsbMech: number;
    acwr: number;
    fatigue?: number;
    soreness?: number;
    sleep?: number;
  },
): string {
  const reasons: string[] = [];
  if (ctx.fatigue != null && ctx.fatigue >= 4) reasons.push('fatigue perçue élevée');
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
