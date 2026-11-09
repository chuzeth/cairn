/**
 * Le pic d'une séance : sa distance contre la plus longue course des trente
 * jours qui la précèdent.
 *
 * C'est la mesure de charge la mieux étayée chez le coureur aujourd'hui.
 * Frandsen et al. (BJSM 2025, 5 205 coureurs suivis 18 mois au GPS Garmin,
 * 588 000 sorties) : le taux de blessure de surmenage monte dès qu'une sortie
 * dépasse de plus de 10 % la plus longue des trente jours précédents — ×1,64
 * entre 10 et 30 %, ×1,52 entre 30 et 100 %, ×2,28 au-delà du double. Dans la
 * même cohorte, le ratio aigu:chronique et la variation d'une semaine à l'autre
 * ne prédisent rien. Les auteurs jugent la règle des 10 % trop généreuse, et
 * l'étude exploratoire : blessures déclarées, à confirmer.
 *
 * Ce module classe ; il ne décide pas. Une reprise après une coupure part de
 * zéro, et chaque sortie y dépasse la précédente — `no_reference` le dit au
 * lieu de compter un pic infini. Une course objectif est un pic choisi : le
 * classer sert à le dire, pas à l'interdire.
 */

export type SpikeClass = 'none' | 'small' | 'moderate' | 'large' | 'no_reference';

/** Les bornes de l'étude, en part au-dessus de la référence. */
export const SPIKE_BANDS = { small: 0.1, moderate: 0.3, large: 1 } as const;

/** Le facteur de risque publié pour chaque classe, contre ≤ 10 %. */
export const SPIKE_HAZARD: Record<Exclude<SpikeClass, 'no_reference'>, number> = {
  none: 1,
  small: 1.64,
  moderate: 1.52,
  large: 2.28,
};

/** La fenêtre de l'étude. */
export const SPIKE_WINDOW_DAYS = 30;

export interface RunDistance {
  date: string;
  distanceM: number;
}

export interface SpikeVerdict {
  cls: SpikeClass;
  /** Part au-dessus de la référence : 0,55 pour +55 %. Absente sans référence. */
  ratio?: number;
  referenceM?: number;
  referenceDate?: string;
}

const dayMs = 86_400_000;
const at = (date: string) => Date.parse(`${date.slice(0, 10)}T12:00:00Z`);

/** La plus longue course des `window` jours strictement avant `date`. */
export function longestBefore(
  runs: readonly RunDistance[],
  date: string,
  window = SPIKE_WINDOW_DAYS,
): RunDistance | undefined {
  const end = at(date);
  const start = end - window * dayMs;
  let best: RunDistance | undefined;
  for (const r of runs) {
    const t = at(r.date);
    if (t >= end || t < start || !(r.distanceM > 0)) continue;
    if (!best || r.distanceM > best.distanceM) best = r;
  }
  return best;
}

/** Classe une distance contre une référence. */
export function classifySpike(distanceM: number, reference: RunDistance | undefined): SpikeVerdict {
  if (!reference || !(reference.distanceM > 0)) return { cls: 'no_reference' };
  // Au millionième : 11 km contre 10 font 0,1000000000000001 en flottant, et +10 % tout rond n'est pas un pic.
  const ratio = Math.round((distanceM / reference.distanceM - 1) * 1e6) / 1e6;
  const cls: SpikeClass =
    ratio > SPIKE_BANDS.large ? 'large' : ratio > SPIKE_BANDS.moderate ? 'moderate' : ratio > SPIKE_BANDS.small ? 'small' : 'none';
  return { cls, ratio, referenceM: reference.distanceM, referenceDate: reference.date.slice(0, 10) };
}

/**
 * Les pics d'une suite de sorties prévues, chacune jugée contre ce qui aura été
 * couru avant elle : les sorties réalisées, puis les prévues qui la précèdent,
 * comptées comme faites. Une sortie longue du samedi est la référence de la
 * course du samedi suivant, qu'elle ait encore eu lieu ou non.
 */
export function spikesAlong(
  done: readonly RunDistance[],
  planned: readonly (RunDistance & { id: string })[],
): (SpikeVerdict & { id: string; date: string; distanceM: number })[] {
  const ordered = [...planned].sort((a, b) => a.date.localeCompare(b.date));
  const seen: RunDistance[] = [...done];
  return ordered.map((p) => {
    const verdict = classifySpike(p.distanceM, longestBefore(seen, p.date));
    seen.push(p);
    return { ...verdict, id: p.id, date: p.date, distanceM: p.distanceM };
  });
}
