import type { PmcPoint, PmcSeries } from '@cairn/core';
import { clamp, mean, stdev } from './units.js';

/**
 * Chart de gestion de la performance (PMC) — modèle à réponse impulsionnelle
 * de Banister : chaque séance dépose une trace de « forme » à décroissance
 * lente et une trace de « fatigue » à décroissance rapide ; leur différence
 * approxime la disponibilité à performer.
 *
 * Cairn en fait tourner **deux en parallèle**, avec des constantes de temps
 * distinctes, parce que les deux fatigues qu'il modélise ne récupèrent pas au
 * même rythme.
 */

/** Constantes de temps de la filière métabolique (usage historique : 42 / 7 jours). */
export const TAU_METABOLIC = { chronic: 42, acute: 7 } as const;

/**
 * Filière mécanique. La destruction musculaire culmine à 24-48 h et se résorbe
 * en 5 à 10 jours (aigu court), tandis que la protection acquise — l'effet de
 * séance répétée — se construit sur plusieurs semaines (chronique plus court
 * que le métabolique, car elle se perd aussi plus vite).
 */
export const TAU_MECHANICAL = { chronic: 28, acute: 5 } as const;

export interface DailyLoad {
  date: string; // YYYY-MM-DD
  metabolic: number;
  mechanical: number;
}

const dayMs = 86_400_000;
const toKey = (d: Date) => d.toISOString().slice(0, 10);

/** Remplit les jours sans activité avec une charge nulle — indispensable au calcul EWMA. */
export function densifyDailyLoads(
  loads: readonly DailyLoad[],
  from?: string,
  to?: string,
): DailyLoad[] {
  if (loads.length === 0) return [];
  const byDate = new Map<string, DailyLoad>();
  for (const l of loads) {
    const prev = byDate.get(l.date);
    if (prev) {
      prev.metabolic += l.metabolic;
      prev.mechanical += l.mechanical;
    } else {
      byDate.set(l.date, { ...l });
    }
  }
  const keys = [...byDate.keys()].sort();
  const start = new Date(`${from ?? keys[0]}T00:00:00Z`);
  const end = new Date(`${to ?? keys[keys.length - 1]}T00:00:00Z`);
  const out: DailyLoad[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += dayMs) {
    const key = toKey(new Date(t));
    out.push(byDate.get(key) ?? { date: key, metabolic: 0, mechanical: 0 });
  }
  return out;
}

/** Série CTL/ATL/TSB pour une filière donnée. */
export function computePmc(
  daily: readonly { date: string; load: number }[],
  tau: { chronic: number; acute: number },
  seed: { ctl: number; atl: number } = { ctl: 0, atl: 0 },
): PmcPoint[] {
  const kC = 1 - Math.exp(-1 / tau.chronic);
  const kA = 1 - Math.exp(-1 / tau.acute);
  let ctl = seed.ctl;
  let atl = seed.atl;
  const out: PmcPoint[] = [];
  for (const d of daily) {
    const load = Number.isFinite(d.load) ? d.load : 0;
    ctl += (load - ctl) * kC;
    atl += (load - atl) * kA;
    out.push({
      date: d.date,
      load: round1(load),
      ctl: round1(ctl),
      atl: round1(atl),
      tsb: round1(ctl - atl),
    });
  }
  return out;
}

/**
 * Ratio charge aiguë / charge chronique, méthode EWMA (Williams et al., 2017),
 * plus fidèle que la moyenne glissante car elle pondère les jours récents.
 * Fenêtre de confort : 0,8-1,3. Au-delà du seuil de pic de sa filière
 * (`ACWR_SPIKE`), le risque de blessure grimpe.
 */
export function computeAcwr(daily: readonly { date: string; load: number }[]): { date: string; value: number }[] {
  const lambdaA = 2 / (7 + 1);
  const lambdaC = 2 / (28 + 1);
  let acute = 0;
  let chronic = 0;
  const out: { date: string; value: number }[] = [];
  daily.forEach((d, i) => {
    const load = Number.isFinite(d.load) ? d.load : 0;
    acute = i === 0 ? load : load * lambdaA + acute * (1 - lambdaA);
    chronic = i === 0 ? load : load * lambdaC + chronic * (1 - lambdaC);
    out.push({ date: d.date, value: chronic > 1 ? round2(acute / chronic) : 0 });
  });
  return out;
}

/**
 * Monotonie de Foster : moyenne des charges quotidiennes sur 7 jours divisée par
 * leur écart-type. Une valeur > 2 signale un entraînement trop uniforme —
 * facteur de risque documenté indépendamment du volume.
 */
export function computeMonotony(daily: readonly { date: string; load: number }[]): { date: string; value: number }[] {
  const out: { date: string; value: number }[] = [];
  for (let i = 0; i < daily.length; i++) {
    const window = daily.slice(Math.max(0, i - 6), i + 1).map((d) => d.load);
    if (window.length < 7) {
      out.push({ date: daily[i]!.date, value: 0 });
      continue;
    }
    const m = mean(window) ?? 0;
    const sd = stdev(window);
    out.push({ date: daily[i]!.date, value: sd > 0.5 ? round2(m / sd) : m > 0 ? 3 : 0 });
  }
  return out;
}

/** Contrainte de Foster = charge hebdomadaire × monotonie. */
export function computeStrain(
  daily: readonly { date: string; load: number }[],
  monotony: readonly { date: string; value: number }[],
): { date: string; value: number }[] {
  return daily.map((d, i) => {
    const weekly = daily.slice(Math.max(0, i - 6), i + 1).reduce((a, x) => a + x.load, 0);
    return { date: d.date, value: round1(weekly * (monotony[i]?.value ?? 0)) };
  });
}

/** Vitesse de progression de la CTL, en points par semaine. */
export function computeRampRate(pmc: readonly PmcPoint[]): { date: string; value: number }[] {
  return pmc.map((p, i) => {
    const ref = pmc[Math.max(0, i - 7)];
    return { date: p.date, value: ref ? round1(p.ctl - ref.ctl) : 0 };
  });
}

/**
 * Seuil de pic du ratio charge aiguë / charge chronique, par filière.
 *
 * Métabolique, 1,5 : la borne au-delà de laquelle la littérature EWMA (Gabbett
 * 2016, Williams et al. 2017) voit le risque de blessure grimper nettement, et
 * que l'historique de Pierre n'a jamais franchie (1,46 au plus, du 27/05 au
 * 13/09/2026).
 *
 * Mécanique, 1,6 : la charge excentrique est concentrée par nature — le jour
 * le plus lourd de la semaine en porte 49 %, contre 37 % de la métabolique —,
 * si bien que le jour de pointe d'une semaine ordinaire sort déjà plus haut
 * (1,27 contre 1,20), et qu'à 1,5 la règle aurait allégé la semaine après une
 * sortie ordinaire de 490 m (1,53 le 09/07). Pas davantage pour autant : les
 * dégâts excentriques croissent avec la nouveauté du stimulus bien plus que la
 * fatigue cardiovasculaire, et à 1,6 la règle se déclenche après les deux plus
 * grosses sorties de l'été (1,99 le 26/07, 1,61 le 29/08).
 */
export const ACWR_SPIKE = { metabolic: 1.5, mechanical: 1.6 } as const;

/** Assemble la série PMC complète, sur les deux filières. */
export function buildPmcSeries(loads: readonly DailyLoad[], from?: string, to?: string): PmcSeries {
  const daily = densifyDailyLoads(loads, from, to);
  const metaDaily = daily.map((d) => ({ date: d.date, load: d.metabolic }));
  const mechDaily = daily.map((d) => ({ date: d.date, load: d.mechanical }));

  const metabolic = computePmc(metaDaily, TAU_METABOLIC);
  const mechanical = computePmc(mechDaily, TAU_MECHANICAL);
  const monotony = computeMonotony(metaDaily);

  return {
    metabolic,
    mechanical,
    acwr: computeAcwr(metaDaily),
    mechanicalAcwr: computeAcwr(mechDaily),
    monotony,
    strain: computeStrain(metaDaily, monotony),
    rampRate: computeRampRate(metabolic),
  };
}

/** Ratios charge aiguë / charge chronique d'une journée, sur les deux filières. */
export interface LoadRatioPoint {
  date: string;
  metabolic: number;
  mechanical: number;
}

/** Une journée où un ratio dépasse le seuil de pic de sa filière. */
export interface LoadRatioExceedance {
  date: string;
  channel: 'metabolic' | 'mechanical';
  value: number;
  limit: number;
}

/**
 * Ratios de charge sur les deux filières, d'une date à une autre, sur des
 * charges connues puis prévues.
 *
 * `known` est ce qui a déjà eu lieu, ou qu'on attend encore avant la fenêtre ;
 * `planned`, ce que la fenêtre prévoit — seules comptent ses charges datées
 * entre `from` et `to`. Les deux s'additionnent jour par jour, et les jours sans
 * charge valent zéro. La série part du premier jour connu : un ratio calculé
 * sans la charge chronique qui le précède ne mesure rien.
 *
 * C'est ce qui permet de voir un pic au moment où une séance s'écrit, et pas
 * seulement le soir où sa charge est réalisée.
 */
export function projectLoadRatios(
  known: readonly DailyLoad[],
  planned: readonly DailyLoad[],
  from: string,
  to: string,
): LoadRatioPoint[] {
  if (to < from) return [];
  const loads = [
    { date: from, metabolic: 0, mechanical: 0 },
    ...known.filter((l) => l.date <= to),
    ...planned.filter((l) => l.date >= from && l.date <= to),
  ];
  const first = loads.reduce((a, l) => (l.date < a ? l.date : a), from);
  const daily = densifyDailyLoads(loads, first, to);
  const metabolic = computeAcwr(daily.map((d) => ({ date: d.date, load: d.metabolic })));
  const mechanical = computeAcwr(daily.map((d) => ({ date: d.date, load: d.mechanical })));
  return daily.flatMap((d, i) =>
    d.date < from
      ? []
      : [{ date: d.date, metabolic: metabolic[i]!.value, mechanical: mechanical[i]!.value }],
  );
}

/** Les journées où un ratio dépasse son seuil de pic, filière par filière. */
export function ratioExceedances(
  points: readonly LoadRatioPoint[],
  limits: { metabolic: number; mechanical: number } = ACWR_SPIKE,
): LoadRatioExceedance[] {
  return points.flatMap((p) =>
    (['metabolic', 'mechanical'] as const)
      .filter((channel) => p[channel] > limits[channel])
      .map((channel) => ({ date: p.date, channel, value: p[channel], limit: limits[channel] })),
  );
}

/**
 * Projection du PMC sur des charges futures planifiées. C'est l'outil qui rend
 * l'affûtage pilotable : on essaie des scénarios de charge et on lit le TSB
 * obtenu le jour J.
 */
export function projectPmc(
  last: { ctl: number; atl: number },
  futureLoads: readonly { date: string; load: number }[],
  tau: { chronic: number; acute: number } = TAU_METABOLIC,
): PmcPoint[] {
  return computePmc(futureLoads, tau, last);
}

/**
 * Déroule le PMC d'un jour à un autre sur des charges connues ou prévues.
 *
 * `seed` est l'état au soir de la veille de `from`, et les jours absents de
 * `loads` valent zéro : c'est ce qui fait qu'une coupure se paie, au lieu de
 * laisser la forme figée entre deux séances. C'est la fonction qui permet de
 * mesurer un plan au lieu de le déclarer — reporter une forme à la date de
 * départ d'un plan, puis lire ce que ses charges produisent à la veille de la
 * course.
 */
export function projectFrom(
  seed: { ctl: number; atl: number },
  loads: readonly { date: string; load: number }[],
  from: string,
  to: string,
  tau: { chronic: number; acute: number } = TAU_METABOLIC,
): PmcPoint[] {
  const start = Date.parse(`${from}T00:00:00Z`);
  const end = Date.parse(`${to}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];

  const byDate = new Map<string, number>();
  for (const l of loads) {
    if (!Number.isFinite(l.load)) continue;
    byDate.set(l.date, (byDate.get(l.date) ?? 0) + l.load);
  }

  const series: { date: string; load: number }[] = [];
  for (let t = start; t <= end; t += dayMs) {
    const key = toKey(new Date(t));
    series.push({ date: key, load: byDate.get(key) ?? 0 });
  }
  return computePmc(series, tau, seed);
}

/**
 * TSB recommandé le jour de course, selon la durée de l'épreuve.
 *
 * Un 10 km se court « affûté mais pas vidé » (+10/+15) ; un ultra tolère — et
 * réclame — une charge chronique plus haute, donc un TSB plus modeste, sous
 * peine de perdre la caisse acquise. La contrainte mécanique, elle, doit être
 * franchement basse : on ne prend pas le départ d'un trail avec des quadriceps
 * déjà entamés.
 */
export function targetRaceDayTsb(raceDurationS: number): { metabolic: number; mechanicalTsbMin: number } {
  const h = raceDurationS / 3600;
  if (h < 1) return { metabolic: 15, mechanicalTsbMin: 0 };
  if (h < 2.5) return { metabolic: 14, mechanicalTsbMin: 2 };
  if (h < 5) return { metabolic: 12, mechanicalTsbMin: 5 };
  if (h < 10) return { metabolic: 10, mechanicalTsbMin: 8 };
  return { metabolic: 8, mechanicalTsbMin: 10 };
}

/** Lecture qualitative d'un TSB, pour l'affichage et le raisonnement du coach. */
export function interpretTsb(tsb: number): { label: string; state: 'fresh' | 'neutral' | 'productive' | 'strained' } {
  if (tsb > 20) return { label: 'Très frais — risque de désentraînement si prolongé', state: 'fresh' };
  if (tsb > 5) return { label: 'Frais, prêt à performer', state: 'fresh' };
  if (tsb >= -10) return { label: 'Équilibré, zone d\'entraînement neutre', state: 'neutral' };
  if (tsb >= -30) return { label: 'Zone productive : la charge dépasse la récupération, l\'adaptation se construit', state: 'productive' };
  return { label: 'Surcharge marquée — surveiller de près la tolérance', state: 'strained' };
}

/** Lecture de l'ACWR, contre le seuil de pic de sa filière. */
export function interpretAcwr(
  acwr: number,
  spike: number = ACWR_SPIKE.metabolic,
): { label: string; risk: 'low' | 'moderate' | 'high' } {
  if (acwr === 0) return { label: 'Données insuffisantes', risk: 'low' };
  if (acwr < 0.8) return { label: 'Charge aiguë faible : détraînement possible', risk: 'moderate' };
  if (acwr <= 1.3) return { label: 'Zone optimale de progression', risk: 'low' };
  if (acwr <= spike) return { label: 'Progression rapide — vigilance', risk: 'moderate' };
  return { label: 'Pic de charge : risque de blessure nettement accru', risk: 'high' };
}

/**
 * Charge hebdomadaire maximale admissible pour rester dans une progression sûre,
 * compte tenu de la CTL actuelle. Borne haute utilisée par le planificateur.
 */
export function maxSafeWeeklyLoad(ctl: number, phase: 'base' | 'build' | 'specific' | 'taper'): number {
  const weeklyEquivalent = ctl * 7;
  const rampCeiling = phase === 'taper' ? 0.75 : phase === 'base' ? 1.12 : phase === 'build' ? 1.15 : 1.1;
  return clamp(weeklyEquivalent * rampCeiling, 100, 2000);
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round2 = (v: number) => Math.round(v * 100) / 100;
