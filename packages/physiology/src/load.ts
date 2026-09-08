import type {
  EccentricMovement, MechanicalLoadCoverage, PhysiologyModel, StrengthCircuit, TrainingLoad,
} from '@cairn/core';
import { gradeAdjustedSpeed, metabolicPower } from './grade.js';
import { clamp, G, movingAverage, powerMean } from './units.js';

/**
 * Quantification de la charge d'entraînement.
 *
 * Cairn calcule **deux charges en parallèle**, et c'est le choix de conception
 * le plus important du moteur :
 *
 *  1. la charge **métabolique** (cardiovasculaire, oxydative) — celle que
 *     mesurent tous les outils du marché ;
 *  2. la charge **mécanique excentrique** — la destruction musculaire produite
 *     par la descente, invisible pour un TSS classique.
 *
 * Un coureur sur route peut se contenter de la première. En trail, c'est la
 * seconde qui explique pourquoi on arrive « cuit » sur une course alors que le
 * TSB annonce une forme parfaite : 2 500 m de D− ne coûtent presque rien au
 * cœur et démolissent les quadriceps pour dix jours.
 */

export interface LoadSample {
  dt: number;
  speedMs: number;
  grade: number;
  hr: number | null;
}

/**
 * Échelle de la charge mécanique : calibrée pour que 1 000 m de D− à pente et
 * vitesse modérées valent ≈ 40 points, soit l'ordre de grandeur du coût
 * métabolique d'une sortie longue vallonnée. Les deux échelles sont ainsi
 * lisibles côte à côte.
 */
const MECHANICAL_SCALE = 300;
/** Charge mécanique de l'appui à plat, par mètre parcouru. */
const FLAT_IMPACT_PER_M = 1 / 2500;
/**
 * Sévérité moyenne d'une descente d'entraînement, quand on ne dispose que du
 * dénivelé négatif : la pondération pente × vitesse que `mechanicalLoad`
 * applique échantillon par échantillon vaut ≈ 1,25 sur un terrain roulant.
 */
const DESCENT_SEVERITY = 1.25;

/** TRIMP de Banister (pondération exponentielle masculine, Morton et al. 1990). */
export function trimp(samples: readonly LoadSample[], model: PhysiologyModel, sex: 'M' | 'F' = 'M'): number {
  const k = sex === 'M' ? 1.92 : 1.67;
  const coef = sex === 'M' ? 0.64 : 0.86;
  const reserve = Math.max(1, model.hrMax - model.hrRest);
  let total = 0;
  for (const s of samples) {
    if (s.hr == null || !Number.isFinite(s.hr)) continue;
    const ratio = clamp((s.hr - model.hrRest) / reserve, 0, 1.05);
    total += (s.dt / 60) * ratio * coef * Math.exp(k * ratio);
  }
  return total;
}

/**
 * Vitesse graduée normalisée : moyenne d'ordre 4 des vitesses corrigées de la
 * pente, lissées sur 30 s. La puissance quatrième pénalise les variations
 * d'intensité, qui coûtent physiologiquement plus qu'un effort constant de même
 * moyenne — exactement ce qui se passe sur un sentier.
 */
export function normalizedGradedSpeed(samples: readonly LoadSample[]): number {
  if (samples.length === 0) return 0;
  const gap = samples.map((s) => gradeAdjustedSpeed(s.speedMs, s.grade));
  const smoothed = movingAverage(gap, 30);
  return powerMean(smoothed, 4);
}

/**
 * rTSS — charge métabolique rapportée au seuil.
 * TSS = (durée / 3600) × IF² × 100, avec IF = NGS / vitesse au seuil.
 * Une heure exactement au seuil vaut 100 points, par construction.
 */
export function runningTss(
  samples: readonly LoadSample[],
  thresholdSpeedMs: number,
): { tss: number; ngs: number; intensityFactor: number } {
  const ngs = normalizedGradedSpeed(samples);
  const durationS = samples.reduce((a, s) => a + s.dt, 0);
  if (thresholdSpeedMs <= 0 || durationS <= 0) {
    return { tss: 0, ngs, intensityFactor: 0 };
  }
  const intensityFactor = ngs / thresholdSpeedMs;
  const tss = (durationS / 3600) * intensityFactor ** 2 * 100;
  return { tss, ngs, intensityFactor };
}

/** hrTSS — filet de sécurité quand la vitesse GPS est inexploitable (forêt dense, canyon). */
export function heartRateTss(samples: readonly LoadSample[], model: PhysiologyModel, sex: 'M' | 'F' = 'M'): number {
  const sessionTrimp = trimp(samples, model, sex);
  // TRIMP d'une heure exactement au seuil 2 : référence à 100 points.
  const reserve = Math.max(1, model.hrMax - model.hrRest);
  const thresholdRatio = clamp((model.vt2.hr - model.hrRest) / reserve, 0, 1);
  const coef = sex === 'M' ? 0.64 : 0.86;
  const k = sex === 'M' ? 1.92 : 1.67;
  const refTrimp = 60 * thresholdRatio * coef * Math.exp(k * thresholdRatio);
  return refTrimp > 0 ? (sessionTrimp / refTrimp) * 100 : 0;
}

/**
 * Charge mécanique excentrique **mesurée sur un flux d'activité**.
 *
 * Le travail négatif absorbé vaut m·g·Δh, mais tous les mètres de descente ne
 * se valent pas : une pente raide concentre la même énergie sur moins d'appuis
 * (force par appui plus élevée), et une descente rapide augmente la vitesse
 * d'impact. Les deux pondérations sont appliquées échantillon par échantillon.
 *
 * Ce que cette fonction ne voit pas, et ne verra jamais : l'excentrique produit
 * hors descente courue. Un circuit de force n'est pas dans Strava ; il n'a ni
 * pente, ni vitesse, ni flux. Le résultat porte donc `coverage`, et tout ce qui
 * l'affiche doit le dire — un zéro par cécité n'est pas un zéro mesuré.
 * Le côté prescrit, lui, sait ce qu'il a prescrit : voir
 * {@link prescribedMechanicalLoad}.
 */
export function mechanicalLoad(samples: readonly LoadSample[]): {
  score: number;
  eccentricWorkKjPerKg: number;
  descentM: number;
  coverage: MechanicalLoadCoverage;
} {
  let weighted = 0;
  let rawJPerKg = 0;
  let descentM = 0;
  let flatDistance = 0;

  for (const s of samples) {
    const dist = s.speedMs * s.dt;
    if (!Number.isFinite(dist) || dist <= 0) continue;
    flatDistance += dist;

    if (s.grade >= -0.01) continue; // pas de descente exploitable
    const drop = dist * Math.sin(Math.atan(-s.grade));
    if (!Number.isFinite(drop) || drop <= 0) continue;

    descentM += drop;
    const energy = G * drop; // J/kg absorbés
    rawJPerKg += energy;

    // Pente : plus c'est raide, plus la force par appui est élevée.
    const steepness = Math.min(0.45, -s.grade);
    const wGrade = 1 + 1.6 * steepness;
    // Vitesse : l'énergie d'impact croît avec la vitesse de descente.
    const wSpeed = Math.pow(Math.max(0.4, s.speedMs) / 2.5, 0.6);

    weighted += energy * wGrade * wSpeed;
  }

  return {
    score: weighted / MECHANICAL_SCALE + flatDistance * FLAT_IMPACT_PER_M,
    eccentricWorkKjPerKg: rawJPerKg / 1000,
    descentM,
    coverage: 'running_descent',
  };
}

/**
 * Catalogue des mouvements excentriques prescriptibles.
 *
 * Chaque mouvement est décrit par ce qu'il freine — la fraction de masse
 * corporelle réellement retenue, et la course sur laquelle elle l'est — puis
 * par sa `severity` : les dégâts par joule absorbé, relativement à un appui de
 * descente courue qui vaut 1 par définition. Une répétition lente, en fin
 * d'amplitude, sur une jambe, abîme davantage qu'un appui de course qui absorbe
 * la même énergie en 150 ms ; c'est tout ce que dit ce coefficient.
 *
 * Ces valeurs ne sont pas mesurées sur l'athlète : ce sont des ordres de
 * grandeur, écrits ici pour être discutés plutôt que devinés. Ce qu'elles
 * rendent vrai n'est pas le niveau absolu — c'est que trois tours pèsent trois
 * fois un tour, que des mollets excentriques ne pèsent pas comme des squats
 * bulgares, et que du gainage ne pèse rien.
 */
export const ECCENTRIC_MOVEMENTS: Record<
  EccentricMovement,
  {
    label: string;
    /** Fraction de la masse corporelle effectivement freinée. */
    bodyFraction: number;
    /** Course du freinage, m. */
    rangeM: number;
    /** Dégâts par joule absorbé, relativement à un appui de descente courue. */
    severity: number;
    /** Le mouvement se compte par côté : les répétitions prescrites sont doublées. */
    unilateral: boolean;
  }
> = {
  split_squat:         { label: 'squats bulgares',              bodyFraction: 0.85, rangeM: 0.40, severity: 3.0, unilateral: true },
  step_down:           { label: 'descentes lentes de marche',   bodyFraction: 0.90, rangeM: 0.30, severity: 3.0, unilateral: true },
  single_leg_deadlift: { label: 'soulevés de terre unilatéraux', bodyFraction: 0.68, rangeM: 0.45, severity: 2.5, unilateral: true },
  eccentric_calf:      { label: 'mollets excentriques',         bodyFraction: 0.95, rangeM: 0.12, severity: 3.0, unilateral: true },
  nordic_curl:         { label: 'nordic hamstring',             bodyFraction: 0.60, rangeM: 0.55, severity: 5.0, unilateral: false },
  drop_jump:           { label: 'sauts en contrebas',           bodyFraction: 1.00, rangeM: 0.35, severity: 2.0, unilateral: false },
  // Le gainage n'a pas de phase de freinage : il tient la position. Il a sa
  // place dans le circuit, aucune dans la charge excentrique.
  isometric:           { label: 'gainage',                      bodyFraction: 0,    rangeM: 0,    severity: 0,   unilateral: false },
};

/** Travail négatif absorbé par répétition et par côté, J/kg. */
export function eccentricWorkPerRep(movement: EccentricMovement): number {
  const m = ECCENTRIC_MOVEMENTS[movement];
  return m.bodyFraction * G * m.rangeM;
}

/** Charge mécanique d'un ou plusieurs circuits de renforcement. */
export function eccentricStrengthLoad(circuits: readonly StrengthCircuit[]): {
  score: number;
  negativeWorkJPerKg: number;
  reps: number;
} {
  let weighted = 0;
  let raw = 0;
  let reps = 0;
  for (const c of circuits) {
    const rounds = Number.isFinite(c.rounds) ? Math.max(0, c.rounds) : 0;
    for (const e of c.exercises) {
      const spec = ECCENTRIC_MOVEMENTS[e.movement];
      if (!spec) continue;
      const n = rounds * (Number.isFinite(e.reps) ? Math.max(0, e.reps) : 0) * (spec.unilateral ? 2 : 1);
      const work = n * eccentricWorkPerRep(e.movement);
      raw += work;
      weighted += work * spec.severity;
      if (spec.severity > 0) reps += n;
    }
  }
  return { score: weighted / MECHANICAL_SCALE, negativeWorkJPerKg: raw, reps };
}

/**
 * Charge mécanique **prescrite** — l'unique formule du côté plan.
 *
 * Même échelle que `mechanicalLoad`, mêmes constantes, et les deux composantes
 * séparées parce qu'elles ne se vérifient pas de la même façon :
 *
 * — `descent` est ce que le réalisé confirmera ou démentira, le flux Strava
 *   portant la pente et la vitesse ;
 * — `eccentricStrength` ne sera jamais confirmé par rien. Le circuit n'est pas
 *   dans le flux. Le chiffre prescrit est tout ce qui existe de ce travail-là,
 *   et une comparaison prévu/réalisé qui l'ignore lit un manque là où il y a
 *   une cécité.
 */
export function prescribedMechanicalLoad(input: {
  elevationLossM: number;
  distanceM?: number;
  circuits?: readonly StrengthCircuit[];
}): { total: number; descent: number; eccentricStrength: number } {
  const lossM = Math.max(0, input.elevationLossM || 0);
  const distanceM = Math.max(0, input.distanceM ?? 0);
  const descent = (lossM * G * DESCENT_SEVERITY) / MECHANICAL_SCALE + distanceM * FLAT_IMPACT_PER_M;
  const eccentricStrength = input.circuits?.length ? eccentricStrengthLoad(input.circuits).score : 0;
  return { total: descent + eccentricStrength, descent, eccentricStrength };
}

/** Travail vertical positif, kJ/kg. */
export function positiveVerticalWork(samples: readonly LoadSample[]): number {
  let j = 0;
  for (const s of samples) {
    if (s.grade <= 0.01) continue;
    const dist = s.speedMs * s.dt;
    const rise = dist * Math.sin(Math.atan(s.grade));
    if (Number.isFinite(rise) && rise > 0) j += G * rise;
  }
  return j / 1000;
}

/**
 * Dépense énergétique. Le coût de Minetti est un coût *net* : on ajoute le
 * métabolisme de repos pour obtenir une dépense totale comparable aux montres.
 */
export function energyExpenditure(
  samples: readonly LoadSample[],
  bodyMassKg: number,
): { kcal: number; netKj: number } {
  let netJ = 0;
  let durationS = 0;
  for (const s of samples) {
    netJ += metabolicPower(s.speedMs, s.grade) * bodyMassKg * s.dt;
    durationS += s.dt;
  }
  // Métabolisme de repos ≈ 1 kcal·kg⁻¹·h⁻¹.
  const restingKcal = (bodyMassKg * durationS) / 3600;
  return { kcal: netJ / 4184 + restingKcal, netKj: netJ / 1000 };
}

/**
 * Cibles nutritionnelles. Les glucides deviennent limitants au-delà de ~75 min ;
 * au-delà de 3 h, un intestin entraîné tolère 90-120 g/h avec un mélange
 * glucose:fructose. L'hydratation suit la contrainte thermique.
 */
export function fuelingTargets(
  durationS: number,
  intensityFactor: number,
  tempC: number | null,
): { carbGPerHour: number; fluidMlPerHour: number; sodiumMgPerHour: number } {
  const hours = durationS / 3600;
  let carb: number;
  if (hours < 1.25) carb = intensityFactor > 0.85 ? 30 : 0;
  else if (hours < 2) carb = 45;
  else if (hours < 3) carb = 65;
  else if (hours < 5) carb = 80;
  else carb = 90;
  carb *= clamp(0.85 + 0.3 * intensityFactor, 0.85, 1.2);

  const t = tempC ?? 15;
  const fluid = clamp(450 + Math.max(0, t - 12) * 55, 400, 1000);
  const sodium = clamp(400 + Math.max(0, t - 15) * 60, 400, 1200);

  return {
    carbGPerHour: Math.round(carb / 5) * 5,
    fluidMlPerHour: Math.round(fluid / 50) * 50,
    sodiumMgPerHour: Math.round(sodium / 100) * 100,
  };
}

/**
 * Agrégation : produit l'objet `TrainingLoad` complet et choisit la source
 * primaire de charge métabolique selon la qualité des données disponibles.
 */
export function computeTrainingLoad(
  samples: readonly LoadSample[],
  model: PhysiologyModel,
  opts: { sex?: 'M' | 'F'; gpsQuality?: 'good' | 'poor' | 'none'; rpe?: number } = {},
): TrainingLoad {
  const sex = opts.sex ?? 'M';
  const durationS = samples.reduce((a, s) => a + s.dt, 0);
  const { tss: rtss, ngs, intensityFactor } = runningTss(samples, model.vt2.speedMs);
  const trimpValue = trimp(samples, model, sex);
  const hrTssValue = heartRateTss(samples, model, sex);
  const mech = mechanicalLoad(samples);

  const hrCoverage =
    samples.length === 0 ? 0 : samples.filter((s) => s.hr != null && s.hr > 0).length / samples.length;

  let primary = rtss;
  let primarySource: TrainingLoad['primarySource'] = 'rtss';

  if (opts.gpsQuality === 'none' || ngs <= 0.1) {
    if (hrCoverage > 0.6) {
      primary = hrTssValue;
      primarySource = 'hrtss';
    } else if (opts.rpe != null) {
      // sRPE de Foster : RPE (1-10) × durée en minutes, remis à l'échelle TSS.
      primary = (opts.rpe * durationS) / 60 / 6;
      primarySource = 'rpe';
    } else {
      primary = (durationS / 3600) * 45;
      primarySource = 'estimated';
    }
  } else if (opts.gpsQuality === 'poor' && hrCoverage > 0.8) {
    // GPS douteux mais cardio fiable : moyenne des deux, pondérée vers la FC.
    primary = rtss * 0.4 + hrTssValue * 0.6;
    primarySource = 'hrtss';
  }

  return {
    metabolic: round1(primary),
    mechanical: round1(mech.score),
    mechanicalCoverage: mech.coverage,
    trimp: round1(trimpValue),
    hrTss: round1(hrTssValue),
    primary: round1(primary),
    primarySource,
    intensityFactor: round3(intensityFactor),
    normalizedGradedSpeedMs: round3(ngs),
    verticalWorkKj: round1(positiveVerticalWork(samples) * model.bodyMassKg),
    eccentricWorkKj: round1(mech.eccentricWorkKjPerKg * model.bodyMassKg),
  };
}

const round1 = (v: number) => Math.round(v * 10) / 10;
const round3 = (v: number) => Math.round(v * 1000) / 1000;
