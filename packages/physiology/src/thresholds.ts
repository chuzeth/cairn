import type { LabTest, ParameterProvenance, PhysiologyModel } from '@cairn/core';
import {
  blendCriticalSpeed, csPriorFromThresholds, fitCriticalSpeed, maximalEffortSupport,
} from './criticalSpeed.js';
import { interpolateCurve, type MmpCurve } from './mmp.js';
import { clamp, quantile } from './units.js';

/**
 * Estimation et vieillissement du modèle physiologique.
 *
 * Un test de laboratoire est une photographie : précis le jour J, périmé six
 * mois plus tard. Un historique Strava est un film : bruité, mais continu.
 * Ce module fusionne les deux — le laboratoire sert d'a priori fort qui perd du
 * poids avec le temps, le terrain sert de correction permanente.
 *
 * Chaque paramètre garde la trace de son origine (`provenance`), pour que le
 * coach puisse dire « ta VMA vient de ton test, ton seuil vient de tes trois
 * dernières séances » plutôt que d'asséner un nombre sans généalogie.
 */

export interface FieldEvidence {
  /** Courbe vitesse-durée corrigée de la pente, enveloppe des 90 derniers jours. */
  gradedSpeedCurve: MmpCurve;
  /**
   * FC moyenne de l'effort qui a produit chaque point de `gradedSpeedCurve`.
   * C'est elle qui permet de savoir si la courbe atteste d'une limite ou d'une
   * aisance. Une durée absente est un point non testable, pas un point réfuté.
   */
  gradedSpeedCurveHr?: MmpCurve;
  /**
   * Âge, en jours, de l'effort qui a produit chaque point de `gradedSpeedCurve`.
   * Une preuve d'effort maximal s'escompte avec son âge : sans cette date, elle
   * compterait à plein jusqu'au jour où elle disparaît d'un coup.
   */
  gradedSpeedCurveAgeDays?: MmpCurve;
  /** FC maximales observées par activité, 12 derniers mois. */
  observedMaxHrs: number[];
  /** FC de repos matinales déclarées ou déduites. */
  restingHrs: number[];
  /** Masses corporelles récentes, kg. */
  bodyMasses: number[];
  /** Couples (vitesse graduée, FC) sur efforts stables, pour recaler les seuils. */
  hrSpeedPairs: { gradedSpeedMs: number; hr: number }[];
  /** Durabilité mesurée. */
  durability: {
    pctPerHour: number;
    pctPer1000mVert: number;
    confidence: number;
    /** Vrai quand la valeur vient d'une mesure et non d'un repli. Absent ⇒ repli. */
    measured?: { perHour: boolean; perVert: boolean };
  };
  /** Courbe VAM, m/h par durée. */
  vamCurve: Record<string, number>;
  /** Courbe de descente, m D−/h par durée. Absente : aucune séance ne l'a produite. */
  descentVamCurve?: Record<string, number>;
  /** Nombre de jours de données exploitables sur la fenêtre. */
  dataDays: number;
}

/** Demi-vie de la pertinence d'un test de laboratoire, en jours. */
const LAB_HALF_LIFE_DAYS = 270;

function daysBetween(a: string, b: string): number {
  return Math.abs(new Date(b).getTime() - new Date(a).getTime()) / 86_400_000;
}

/** Poids résiduel du laboratoire, décroissance exponentielle depuis la date du test. */
export function labWeight(labDate: string, asOf: string): number {
  return Math.pow(0.5, daysBetween(labDate, asOf) / LAB_HALF_LIFE_DAYS);
}

/**
 * FC maximale : le maximum observé est fragile (artefact de capteur optique,
 * pic parasite). On prend un centile haut plutôt que le maximum brut, et on ne
 * révise à la hausse la valeur du laboratoire que si le terrain est net.
 */
export function estimateHrMax(observed: number[], lab: number): { value: number; provenance: ParameterProvenance } {
  const clean = observed.filter((h) => h > lab * 0.75 && h < lab * 1.15);
  if (clean.length < 5) return { value: lab, provenance: 'lab' };
  const p98 = quantile(clean, 0.98);
  // On ne descend jamais la FCmax sous la valeur du labo : une FCmax ne baisse
  // pas parce qu'on n'a pas fait d'effort maximal récemment.
  const value = Math.max(lab, Math.round(p98));
  return { value, provenance: value > lab ? 'field' : 'lab' };
}

/**
 * FC de repos réelle. La valeur du laboratoire (87 bpm chez Pierre) a été prise
 * debout, avec un masque, avant un test maximal : elle est inexploitable comme
 * repos. On lui préfère systématiquement le terrain dès qu'il existe, et à
 * défaut une estimation depuis la FCmax et la VO2max.
 */
export function estimateHrRest(
  reported: number[],
  labStanding: number | undefined,
  hrMax: number,
  vo2maxRel: number,
): { value: number; provenance: ParameterProvenance; note?: string } {
  const clean = reported.filter((h) => h > 28 && h < 90);
  if (clean.length >= 3) {
    return { value: Math.round(quantile(clean, 0.2)), provenance: 'field' };
  }
  // Corrélation VO2max ↔ bradycardie de repos : un athlète à 64 ml/kg/min se
  // situe typiquement entre 46 et 54 bpm au réveil.
  const estimated = Math.round(clamp(65 - (vo2maxRel - 40) * 0.55, 40, 70));
  return {
    value: estimated,
    provenance: 'default',
    note: labStanding
      ? `FC de repos du labo (${labStanding} bpm) écartée : mesurée debout sous masque avant test maximal. Valeur estimée à ${estimated} bpm — à confirmer par une mesure au réveil.`
      : undefined,
  };
}

/**
 * Seuil 2 depuis la vitesse critique. La CS se situe légèrement au-dessus du
 * SV2 mesuré en laboratoire ; on inverse la relation pour rester cohérent avec
 * la grille de zones prescrite.
 */
export function vt2FromCs(csMs: number): number {
  return csMs / 1.02;
}

/**
 * FC au seuil 2, recalée sur le terrain. On cherche la FC moyenne observée aux
 * vitesses proches de la vitesse seuil, ce qui capture les dérives réelles
 * (baisse de FC seuil avec l'entraînement, hausse avec la fatigue chronique).
 */
export function estimateVt2Hr(
  pairs: readonly { gradedSpeedMs: number; hr: number }[],
  vt2SpeedMs: number,
  labHr: number,
): { value: number; provenance: ParameterProvenance; n: number } {
  const band = pairs.filter(
    (p) => Math.abs(p.gradedSpeedMs - vt2SpeedMs) / vt2SpeedMs < 0.04 && p.hr > 100,
  );
  if (band.length < 20) return { value: labHr, provenance: 'lab', n: band.length };
  const median = quantile(band.map((p) => p.hr), 0.5);
  // Garde-fou : on n'accepte pas plus de 6 bpm d'écart avec le laboratoire sans
  // preuve massive — le bruit terrain est réel.
  const bounded = clamp(median, labHr - 6, labHr + 6);
  return { value: Math.round(bounded), provenance: 'blended', n: band.length };
}

/**
 * VMA courante. Deux estimateurs :
 *  · la meilleure vitesse graduée soutenue ~5 min (proche de vVO2max) ;
 *  · le modèle CS + D' extrapolé à 5-6 min.
 * On prend le meilleur des deux, plafonné par cohérence avec le laboratoire.
 */
export function estimateVma(
  curve: MmpCurve,
  cs: number,
  dPrime: number,
  labVma: number,
  labW: number,
): { value: number; provenance: ParameterProvenance } {
  const observed5 = interpolateCurve(curve, 330);
  const modelled = cs > 0 ? cs + dPrime / 330 : 0;
  const field = Math.max(observed5 ?? 0, modelled);

  if (field <= 0) return { value: labVma, provenance: 'lab' };
  // Un effort de terrain n'est presque jamais un vrai test maximal : on applique
  // un léger relèvement pour compenser le sous-maximalisme, puis on mélange.
  const fieldVma = field * 1.02;
  const value = fieldVma * (1 - labW) + labVma * labW;
  return {
    value,
    provenance: labW > 0.6 ? 'lab' : labW > 0.2 ? 'blended' : 'field',
  };
}

/** VO2max déduit de la VMA (relation de Léger : VO2max ≈ VMA[km/h] × 3,5). */
export function vo2FromVma(vmaMs: number): number {
  return vmaMs * 3.6 * 3.5;
}

/**
 * Construit le modèle physiologique courant.
 * C'est la fonction pivot du moteur : tout le reste consomme sa sortie.
 */
export function buildPhysiologyModel(
  lab: LabTest,
  field: FieldEvidence,
  asOf: string,
): PhysiologyModel {
  const labW = labWeight(lab.date, asOf);
  const provenance: Record<string, ParameterProvenance> = {};

  // ── Masse corporelle ───────────────────────────────────────────────────────
  const bodyMassKg =
    field.bodyMasses.length > 0 ? quantile(field.bodyMasses, 0.5) : lab.bodyMassKg;
  provenance.bodyMassKg = field.bodyMasses.length > 0 ? 'field' : 'lab';

  // ── Fréquences cardiaques ──────────────────────────────────────────────────
  const hrMaxEst = estimateHrMax(field.observedMaxHrs, lab.hrMax);
  provenance.hrMax = hrMaxEst.provenance;

  // ── Vitesse critique ───────────────────────────────────────────────────────
  const fit = fitCriticalSpeed(field.gradedSpeedCurve);
  const prior = csPriorFromThresholds(lab.vt2.speedMs, lab.vmaMs);
  // La preuve d'effort maximal se juge à la FC du seuil 2 du laboratoire : elle
  // est disponible avant toute ré-estimation de seuil — la FC seuil terrain,
  // elle, dépendrait de la vitesse critique qu'on cherche à établir.
  const support = maximalEffortSupport(
    fit,
    field.gradedSpeedCurveHr ?? {},
    lab.vt2.hr,
    field.gradedSpeedCurveAgeDays ?? {},
  );
  const blended = blendCriticalSpeed(fit, prior, support.support, labW);
  // La provenance suit la part réellement empruntée au laboratoire : quand celui-ci
  // a vieilli, le nombre reste majoritairement du terrain même sans preuve fraîche.
  provenance.criticalSpeedMs =
    blended.weightLab > 0.7 ? 'lab' : blended.weightLab > 0.2 ? 'blended' : 'field';
  provenance.dPrimeM = provenance.criticalSpeedMs;

  // ── VMA & VO2max ───────────────────────────────────────────────────────────
  const vmaEst = estimateVma(
    field.gradedSpeedCurve,
    blended.criticalSpeedMs,
    blended.dPrimeM,
    lab.vmaMs,
    labW,
  );
  provenance.vmaMs = vmaEst.provenance;

  // On suit l'évolution de la VMA **en proportion**, plutôt que de repasser par
  // la relation de Léger (VMA × 3,5). Celle-ci donnerait 70 ml/kg/min pour une
  // VMA de 20 km/h, alors que la mesure directe donne 64,6 : Pierre a une
  // économie de course qui lui est propre, et le modèle doit la préserver au
  // lieu de la remplacer par une moyenne de population.
  const vo2maxRel = lab.vmaMs > 0 ? lab.vo2maxRel * (vmaEst.value / lab.vmaMs) : lab.vo2maxRel;
  provenance.vo2maxRel = vmaEst.provenance === 'lab' ? 'lab' : 'blended';

  const hrRestEst = estimateHrRest(field.restingHrs, lab.hrRestLab, hrMaxEst.value, vo2maxRel);
  provenance.hrRest = hrRestEst.provenance;

  // ── Seuils ─────────────────────────────────────────────────────────────────
  const vt2Speed = vt2FromCs(blended.criticalSpeedMs);
  const vt2Hr = estimateVt2Hr(field.hrSpeedPairs, vt2Speed, lab.vt2.hr);
  provenance['vt2.speedMs'] = provenance.criticalSpeedMs as ParameterProvenance;
  provenance['vt2.hr'] = vt2Hr.provenance;

  // Le SV1 est très difficile à mesurer sur le terrain. On conserve le rapport
  // SV1/SV2 du laboratoire — physiologiquement stable chez un même athlète —
  // et on l'applique aux valeurs de seuil 2 réactualisées.
  const vt1SpeedRatio = lab.vt1.speedMs / lab.vt2.speedMs;
  const vt1HrRatio = lab.vt1.hr / lab.vt2.hr;
  const vt1Speed = vt2Speed * vt1SpeedRatio;
  const vt1Hr = Math.round(vt2Hr.value * vt1HrRatio);
  provenance['vt1.speedMs'] = 'blended';
  provenance['vt1.hr'] = 'blended';

  // ── Durabilité ─────────────────────────────────────────────────────────────
  // Les deux indices se qualifient séparément : le terrain peut mesurer la perte
  // horaire sans rien établir sur le dénivelé. Une valeur issue du repli — parce
  // qu'aucune séance ne l'a produite, ou parce que l'agrégat a atteint sa borne
  // de plausibilité — est annoncée comme telle.
  const durabilityMeasured = field.durability.measured ?? { perHour: false, perVert: false };
  const durabilityProvenance = (measured: boolean): ParameterProvenance =>
    measured && field.durability.confidence > 0.4 ? 'field' : 'default';
  provenance.durabilityPctPerHour = durabilityProvenance(durabilityMeasured.perHour);
  provenance.durabilityPctPer1000mVert = durabilityProvenance(durabilityMeasured.perVert);

  // ── Courbes verticales ─────────────────────────────────────────────────────
  // Elles ne portent que des points mesurés. Là où une courbe manque, la borne
  // qu'on en tire est une valeur par défaut (`verticalCapacity`), et sa
  // provenance le dit point par point ; celle-ci dit si la courbe existe.
  const descentVamCurve = field.descentVamCurve ?? {};
  const measuredCurve = (c: Record<string, number>): ParameterProvenance =>
    Object.values(c).some((v) => v > 0) ? 'field' : 'default';
  provenance.vamCurve = measuredCurve(field.vamCurve);
  provenance.descentVamCurve = measuredCurve(descentVamCurve);

  // ── Confiance globale ──────────────────────────────────────────────────────
  // La qualité de l'ajustement n'entre qu'à hauteur de ce qu'une preuve d'effort
  // maximal soutient — et cette preuve s'escompte avec son âge. La confiance
  // décroît donc d'elle-même à mesure que le dernier effort maximal s'éloigne,
  // au lieu de rester haute sur la seule régularité des footings.
  const dataScore = clamp(field.dataDays / 90, 0, 1);
  const fitScore =
    (fit.quality === 'strong' ? 1 : fit.quality === 'usable' ? 0.7 : 0.35) * support.support;
  const confidence = clamp(0.35 + 0.35 * dataScore + 0.2 * fitScore + 0.1 * labW, 0.2, 0.97);

  return {
    asOf,
    bodyMassKg: Math.round(bodyMassKg * 10) / 10,
    hrMax: hrMaxEst.value,
    hrRest: hrRestEst.value,
    hrReserve: hrMaxEst.value - hrRestEst.value,
    criticalSpeedMs: round3(blended.criticalSpeedMs),
    dPrimeM: Math.round(blended.dPrimeM),
    vmaMs: round3(vmaEst.value),
    vo2maxRel: Math.round(vo2maxRel * 10) / 10,
    vt1: { hr: vt1Hr, speedMs: round3(vt1Speed) },
    vt2: { hr: vt2Hr.value, speedMs: round3(vt2Speed) },
    durabilityPctPer1000mVert: field.durability.pctPer1000mVert,
    durabilityPctPerHour: field.durability.pctPerHour,
    vamCurve: field.vamCurve,
    descentVamCurve,
    criticalSpeedEvidence: {
      support: Math.round(support.support * 1000) / 1000,
      lastProofAgeDays:
        support.lastProofAgeDays == null ? null : Math.round(support.lastProofAgeDays),
      weightLab: Math.round(blended.weightLab * 1000) / 1000,
    },
    confidence: Math.round(confidence * 100) / 100,
    provenance,
  };
}

/**
 * Modèle de repli, construit sur le seul test de laboratoire. Utilisé au premier
 * lancement, avant toute synchronisation Strava — l'app est immédiatement
 * utilisable, avec une confiance annoncée comme faible.
 */
export function modelFromLabOnly(lab: LabTest, asOf: string): PhysiologyModel {
  return buildPhysiologyModel(
    lab,
    {
      gradedSpeedCurve: {},
      observedMaxHrs: [],
      restingHrs: [],
      bodyMasses: [],
      hrSpeedPairs: [],
      durability: {
        pctPerHour: 3.0,
        pctPer1000mVert: 4.0,
        confidence: 0.15,
        measured: { perHour: false, perVert: false },
      },
      vamCurve: {},
      dataDays: 0,
    },
    asOf,
  );
}

/** Différence lisible entre deux modèles — sert à annoncer les évolutions. */
export function diffModels(before: PhysiologyModel, after: PhysiologyModel): {
  field: string;
  before: string;
  after: string;
  deltaPct: number;
}[] {
  const rows: { field: string; before: number; after: number; unit: 'kmh' | 'bpm' | 'ml' | 'kg' | 'pct' }[] = [
    { field: 'Vitesse critique', before: before.criticalSpeedMs, after: after.criticalSpeedMs, unit: 'kmh' },
    { field: 'VMA', before: before.vmaMs, after: after.vmaMs, unit: 'kmh' },
    { field: 'Vitesse SV2', before: before.vt2.speedMs, after: after.vt2.speedMs, unit: 'kmh' },
    { field: 'FC SV2', before: before.vt2.hr, after: after.vt2.hr, unit: 'bpm' },
    { field: 'VO2max estimé', before: before.vo2maxRel, after: after.vo2maxRel, unit: 'ml' },
    { field: 'Masse', before: before.bodyMassKg, after: after.bodyMassKg, unit: 'kg' },
    {
      field: 'Durabilité (perte/h)',
      before: before.durabilityPctPerHour,
      after: after.durabilityPctPerHour,
      unit: 'pct',
    },
  ];

  const fmt = (v: number, unit: string) =>
    unit === 'kmh' ? `${(v * 3.6).toFixed(2)} km/h`
      : unit === 'bpm' ? `${Math.round(v)} bpm`
      : unit === 'ml' ? `${v.toFixed(1)} ml/kg/min`
      : unit === 'kg' ? `${v.toFixed(1)} kg`
      : `${v.toFixed(1)} %`;

  return rows
    .filter((r) => Math.abs(r.after - r.before) > Math.abs(r.before) * 0.002)
    .map((r) => ({
      field: r.field,
      before: fmt(r.before, r.unit),
      after: fmt(r.after, r.unit),
      deltaPct: r.before !== 0 ? Math.round(((r.after - r.before) / r.before) * 1000) / 10 : 0,
    }));
}

const round3 = (v: number) => Math.round(v * 1000) / 1000;
