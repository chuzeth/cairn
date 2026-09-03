/**
 * Cairn — modèle de domaine.
 *
 * Toutes les vitesses sont en m/s, les distances en mètres, les durées en
 * secondes, les dénivelés en mètres, les masses en kg, sauf mention contraire
 * explicite dans le nom du champ (ex. `speedKmh`, `durationMin`).
 * Cette discipline d'unités est volontaire : elle supprime toute une classe de
 * bugs de conversion dans le moteur physiologique.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Profil athlète
// ─────────────────────────────────────────────────────────────────────────────

/** Résultat d'un test d'effort en laboratoire (gold standard, ancre du modèle). */
export interface LabTest {
  id: string;
  date: string; // ISO date
  lab: string;
  protocol: string;
  ergometer: 'treadmill' | 'bike' | 'field';

  bodyMassKg: number;
  heightCm?: number;
  bodyFatPct?: number;
  leanMassKg?: number;

  /** Vitesse Maximale Aérobie, m/s. */
  vmaMs: number;
  /** VO2max relatif, ml/kg/min. */
  vo2maxRel: number;
  /** VO2max absolu, L/min. */
  vo2maxAbs?: number;
  /** VO2 de repos mesurée, ml/kg/min (>5 ⇒ fatigue/stress au moment du test). */
  vo2RestRel?: number;
  /** Quotient respiratoire maximal. */
  rerMax?: number;

  hrMax: number;
  /** FC de repos telle que mesurée au labo — souvent surestimée (masque, stress). */
  hrRestLab?: number;
  /** FC 4 min après l'arrêt de l'effort. */
  hrRecovery4min?: number;

  /** Seuil ventilatoire 1 (seuil aérobie). */
  vt1: { hr: number; speedMs: number; vo2Abs?: number };
  /** Seuil ventilatoire 2 (seuil anaérobie / lactique). */
  vt2: { hr: number; speedMs: number; vo2Abs?: number };

  /** Ventilation. */
  vitalCapacityL?: number;
  veMaxLMin?: number;
  respRateMax?: number;
  tidalVolumeMaxL?: number;
  /** Coefficient d'utilisation pulmonaire, %. */
  pulmonaryUseCoefPct?: number;

  cadenceMeanSpm?: number;
  cadenceMaxSpm?: number;

  /** Flexion avant debout, cm (>0 = bon). */
  sitAndReachCm?: number;

  /** Commentaires bruts du physiologiste, conservés tels quels pour le LLM. */
  practitionerNotes?: string[];
  /** Interprétation longue rédigée par le préparateur physique. */
  interpretation?: string;
}

/** Contraintes de vie qui bornent la planification. */
export interface AthleteConstraints {
  /** Jours disponibles pour s'entraîner (0 = dimanche … 6 = samedi). */
  availableDays: number[];
  /** Jours où une sortie longue est possible. */
  longRunDays: number[];
  /** Volume horaire max par semaine, heures. */
  maxWeeklyHours: number;
  /** Nombre max de séances qualité par semaine. */
  maxQualitySessionsPerWeek: number;
  /** Accès au dénivelé : m D+ atteignables sans déplacement majeur. */
  accessibleVertPerSession: number;
  /** Accès piste / tapis. */
  hasTrackAccess: boolean;
  hasTreadmillAccess: boolean;
  /** Notes libres (blessures anciennes, travail, voyages…). */
  notes?: string[];
}

/** Modèle physiologique courant, ré-estimé en continu depuis les données terrain. */
export interface PhysiologyModel {
  /** Date d'évaluation du modèle (ISO). */
  asOf: string;

  bodyMassKg: number;

  hrMax: number;
  /** FC de repos réelle, estimée depuis le terrain (≠ valeur labo). */
  hrRest: number;
  hrReserve: number;

  /** Vitesse critique (CS), m/s — l'asymptote de la courbe puissance-durée. */
  criticalSpeedMs: number;
  /** D' — capacité de distance au-dessus de CS, en mètres. */
  dPrimeM: number;
  /** VMA courante estimée, m/s. */
  vmaMs: number;
  /** VO2max courant estimé, ml/kg/min. */
  vo2maxRel: number;

  /** Seuil 1 (aérobie) courant. */
  vt1: { hr: number; speedMs: number };
  /** Seuil 2 (anaérobie) courant. */
  vt2: { hr: number; speedMs: number };

  /**
   * Indice de durabilité : perte de rendement (%) par 1000 m D+ cumulés.
   * Métrique clef en trail long — c'est elle qui sépare un bon coureur d'un
   * finisseur de 100 km.
   */
  durabilityPctPer1000mVert: number;
  /** Perte de rendement (%) par heure d'effort continu. */
  durabilityPctPerHour: number;

  /** Vitesse ascensionnelle max soutenue, m D+/h, par durée de référence. */
  vamCurve: Record<string, number>;

  /**
   * Aisance en descente, relative à un bon trailer de référence (1,0).
   * Apprise depuis les vitesses réellement tenues par tranche de pente. C'est
   * une compétence, pas une qualité physiologique : elle se travaille vite et
   * constitue souvent le gisement de temps le plus rentable en trail.
   */
  descentSkill?: number;

  /**
   * État de la preuve qui soutient la vitesse critique. Sans elle, un athlète ne
   * peut pas savoir si son chiffre repose sur un effort maximal récent ou sur
   * trois mois de footings réguliers — les deux produisent le même r².
   */
  criticalSpeedEvidence?: {
    /** Part de l'ajustement adossée à une preuve d'effort maximal, âge compris. */
    support: number;
    /** Âge de la preuve la plus récente, en jours. `null` si aucune. */
    lastProofAgeDays: number | null;
    /** Part du chiffre effectivement empruntée au test de laboratoire. */
    weightLab: number;
  };

  /** Confiance dans le modèle (0–1), pondérée par la fraîcheur et le volume de données. */
  confidence: number;
  /** Provenance de chaque paramètre : 'lab' | 'field' | 'blended' | 'default'. */
  provenance: Record<string, ParameterProvenance>;
}

export type ParameterProvenance = 'lab' | 'field' | 'blended' | 'default';

export interface AthleteProfile {
  id: string;
  name: string;
  birthDate: string;
  sex: 'M' | 'F';
  stravaAthleteId?: number;
  labTests: LabTest[];
  constraints: AthleteConstraints;
  /** Préférences narratives : ton du coach, langue, unités. */
  preferences: {
    locale: 'fr' | 'en';
    coachTone: 'direct' | 'pedagogue' | 'clinique';
    paceUnit: 'min_per_km' | 'kmh';
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Activités & flux
// ─────────────────────────────────────────────────────────────────────────────

export type SportType =
  | 'Run' | 'TrailRun' | 'VirtualRun' | 'Ride' | 'VirtualRide' | 'Hike'
  | 'Walk' | 'AlpineSki' | 'BackcountrySki' | 'NordicSki' | 'Swim'
  | 'WeightTraining' | 'Workout' | 'Elliptical' | 'Other';

/** Flux temporels normalisés, ré-échantillonnés à 1 Hz. */
export interface ActivityStreams {
  /** Secondes depuis le début, pas de 1 s après normalisation. */
  time: number[];
  /** Distance cumulée, m. */
  distance: number[];
  /** Altitude, m — lissée et corrigée du bruit barométrique. */
  altitude: number[];
  /** Vitesse instantanée, m/s. */
  velocity: number[];
  /** Pente fractionnelle (0.10 = +10 %), lissée. */
  grade: number[];
  heartrate?: (number | null)[];
  /** Cadence en pas/min (Strava renvoie des cycles/min pour la course : ×2). */
  cadence?: (number | null)[];
  /** Puissance en watts si capteur présent. */
  watts?: (number | null)[];
  temperature?: (number | null)[];
  latlng?: ([number, number] | null)[];
  /** true si l'athlète est en mouvement (filtre les pauses). */
  moving?: boolean[];
}

export interface Activity {
  id: string;
  stravaId?: number;
  athleteId: string;
  name: string;
  description?: string;
  sportType: SportType;
  startDate: string; // ISO
  startDateLocal: string;
  timezone?: string;

  distanceM: number;
  movingTimeS: number;
  elapsedTimeS: number;
  totalElevationGainM: number;
  totalElevationLossM: number;
  elevHighM?: number;
  elevLowM?: number;

  averageSpeedMs: number;
  maxSpeedMs?: number;
  averageHr?: number;
  maxHr?: number;
  averageCadenceSpm?: number;
  averageWatts?: number;
  averageTempC?: number;
  calories?: number;

  /** Relative Effort Strava, conservé comme signal de comparaison. */
  sufferScore?: number;
  gearId?: string;
  deviceName?: string;
  trainer?: boolean;
  commute?: boolean;
  manual?: boolean;

  /** Rattachement éventuel à une séance planifiée. */
  plannedSessionId?: string;
  /** Ressenti déclaré par l'athlète. */
  rpe?: number;
  feel?: 1 | 2 | 3 | 4 | 5;
}

// ─────────────────────────────────────────────────────────────────────────────
// Analyse
// ─────────────────────────────────────────────────────────────────────────────

export type ZoneKey = 'Z1' | 'Z2' | 'Z3' | 'Z4' | 'Z5';

export interface ZoneDefinition {
  key: ZoneKey;
  label: string;
  /** Description physiologique de ce qu'on développe dans cette zone. */
  purpose: string;
  hrMin: number;
  hrMax: number;
  /** Vitesse à plat équivalente, m/s. */
  speedMinMs: number;
  speedMaxMs: number;
}

export interface ZoneDistribution {
  /** Secondes passées dans chaque zone. */
  seconds: Record<ZoneKey, number>;
  /** Part de chaque zone, 0–1. */
  fraction: Record<ZoneKey, number>;
  /** Modèle 3 zones : sous SV1 / entre SV1 et SV2 / au-dessus de SV2. */
  threeZone: { low: number; moderate: number; high: number };
  /** Indice de polarisation (Treff et al.). >2 ⇒ entraînement polarisé. */
  polarizationIndex: number;
}

/** Les charges d'entraînement, calculées en parallèle sur deux filières. */
export interface TrainingLoad {
  /** Charge métabolique/cardiovasculaire (rTSS sur vitesse corrigée de la pente). */
  metabolic: number;
  /** Charge mécanique excentrique — la fatigue « descente », propre au trail. */
  mechanical: number;
  /** TRIMP de Banister (pondération exponentielle de la FC de réserve). */
  trimp: number;
  /** TSS cardiaque, filet de sécurité quand la vitesse GPS est douteuse. */
  hrTss: number;
  /** Charge retenue pour le PMC métabolique (meilleure source disponible). */
  primary: number;
  /** Source retenue pour `primary`. */
  primarySource: 'rtss' | 'hrtss' | 'trimp' | 'rpe' | 'estimated';
  /** Intensité relative moyenne (NGS / vitesse seuil). */
  intensityFactor: number;
  /** Vitesse graduée normalisée, m/s (moyenne d'ordre 4 sur fenêtre 30 s). */
  normalizedGradedSpeedMs: number;
  /** Travail vertical positif, kJ (m·g·Δh). */
  verticalWorkKj: number;
  /** Travail vertical négatif absorbé, kJ. */
  eccentricWorkKj: number;
}

export interface DecouplingResult {
  /** Dérive cardiaque : (EF 1ʳᵉ moitié − EF 2ᵈᵉ moitié) / EF 1ʳᵉ moitié, en %. */
  pctDrift: number | null;
  /** Efficiency Factor = vitesse graduée normalisée / FC moyenne. */
  efficiencyFactor: number | null;
  efFirstHalf: number | null;
  efSecondHalf: number | null;
  /** Vrai si l'effort était assez stable/long pour que la mesure ait un sens. */
  valid: boolean;
  reason?: string;
}

export interface IntervalDetection {
  index: number;
  startS: number;
  endS: number;
  durationS: number;
  distanceM: number;
  avgSpeedMs: number;
  avgGradedSpeedMs: number;
  avgGrade: number;
  avgHr: number | null;
  maxHr: number | null;
  avgCadence: number | null;
  zone: ZoneKey;
  /** Écart à la cible si la séance était planifiée, en %. */
  deviationFromTargetPct?: number;
}

export interface ActivityAnalysis {
  activityId: string;
  computedAt: string;

  load: TrainingLoad;
  zones: ZoneDistribution;
  decoupling: DecouplingResult;

  /** Courbe vitesse-durée de cette séance : durée (s) → meilleure vitesse graduée. */
  meanMaximalSpeed: Record<string, number>;
  /**
   * FC moyenne sur la fenêtre qui a produit chaque point de `meanMaximalSpeed`.
   * Sans elle, la courbe ne distingue pas un effort maximal d'une sortie facile.
   * Absent sur les analyses produites avant l'introduction du champ.
   */
  meanMaximalSpeedHr?: Record<string, number>;
  /** Courbe VAM : durée (s) → meilleure vitesse ascensionnelle (m/h). */
  meanMaximalVam: Record<string, number>;

  /** Répartition du temps par tranche de pente. */
  gradeProfile: GradeBucket[];
  /** Blocs d'effort détectés automatiquement (fractionné, côtes, tempo…). */
  intervals: IntervalDetection[];

  /** W'bal minimal atteint (m) — proximité de l'épuisement anaérobie. */
  wPrimeBalanceMinM: number | null;
  /** Réserve de durabilité consommée sur la séance. */
  durabilitySignal: {
    efDeclinePctPer1000mVert: number | null;
    efDeclinePctPerHour: number | null;
    sampleQuality: 'good' | 'partial' | 'insufficient';
  };

  /** Coût énergétique estimé, kcal, et besoins glucidiques associés. */
  energy: { kcal: number; carbTargetGPerHour: number; fluidTargetMlPerHour: number };

  /** Contexte environnemental et son impact estimé sur la performance. */
  environment: {
    avgTempC: number | null;
    heatStressFactor: number; // 1.0 = neutre, >1 = pénalisant
    avgAltitudeM: number | null;
    altitudeFactor: number;
  };

  /** Écarts vs la séance prescrite, si applicable. */
  compliance?: SessionCompliance;

  /** Signaux d'alerte détectés automatiquement. */
  flags: AnalysisFlag[];
}

export interface GradeBucket {
  /** Borne basse de pente (fractionnelle, ex. -0.10). */
  from: number;
  to: number;
  seconds: number;
  distanceM: number;
  avgSpeedMs: number;
  /** Vitesse ascensionnelle sur les tranches montantes, m/h. */
  vamMh?: number;
}

export interface AnalysisFlag {
  code: string;
  severity: 'info' | 'watch' | 'warn' | 'critical';
  message: string;
  /** Données chiffrées qui motivent le drapeau. */
  evidence?: Record<string, number | string | null>;
}

export interface SessionCompliance {
  plannedSessionId: string;
  /** Écart de charge, %. */
  loadDeviationPct: number;
  /** Écart de durée, %. */
  durationDeviationPct: number;
  /** Écart d'intensité sur les blocs clefs, %. */
  intensityDeviationPct: number | null;
  /**
   * La séance prescrite a-t-elle eu lieu, ou l'activité s'y est-elle substituée ?
   * `verdict` note l'exécution ; celui-ci dit de quelle séance on parle.
   */
  outcome: 'fulfilled' | 'replaced';
  verdict: 'on_target' | 'under' | 'over' | 'wrong_stimulus' | 'missed';
  detail: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Charge chronique (PMC) & disponibilité
// ─────────────────────────────────────────────────────────────────────────────

export interface PmcPoint {
  date: string;
  load: number;
  /** Chronic Training Load (constante de temps longue). */
  ctl: number;
  /** Acute Training Load (constante de temps courte). */
  atl: number;
  /** Training Stress Balance = ctl − atl. */
  tsb: number;
}

export interface PmcSeries {
  /** PMC de la filière métabolique. */
  metabolic: PmcPoint[];
  /** PMC de la filière mécanique/excentrique — la fatigue musculaire du trail. */
  mechanical: PmcPoint[];
  /** Ratio charge aiguë / charge chronique (EWMA), sur la filière métabolique. */
  acwr: { date: string; value: number }[];
  /** Monotonie de Foster (moyenne/écart-type des charges quotidiennes sur 7 j). */
  monotony: { date: string; value: number }[];
  /** Contrainte de Foster = charge hebdo × monotonie. */
  strain: { date: string; value: number }[];
  /** Vitesse de progression de la CTL, points/semaine. */
  rampRate: { date: string; value: number }[];
}

export interface DailyCheckIn {
  date: string;
  athleteId: string;
  /** Heures de sommeil. */
  sleepHours?: number;
  /** Qualité perçue du sommeil, 1–5. */
  sleepQuality?: number;
  /** Courbatures/douleurs, 1 (aucune) – 5 (sévères). */
  soreness?: number;
  /** Stress perçu, 1–5. */
  stress?: number;
  /** Motivation, 1–5. */
  motivation?: number;
  /** FC de repos matinale mesurée. */
  restingHr?: number;
  /** HRV (rMSSD) si disponible via un capteur externe. */
  hrvRmssd?: number;
  bodyMassKg?: number;
  notes?: string;
}

/**
 * Ce sur quoi repose une composante de la disponibilité.
 *
 * `default` n'est pas une mesure : c'est la valeur retenue faute de relevé.
 * La distinguer est la seule façon d'empêcher qu'un score à moitié inventé
 * se lise comme un score mesuré.
 */
export type ReadinessSource =
  | 'load'
  | 'declared'
  | 'partial'
  | 'hrv'
  | 'resting-hr'
  | 'default';

export interface ReadinessScore {
  date: string;
  /** Score global 0–100. */
  score: number;
  /** Contributions détaillées, pour l'explicabilité. */
  components: {
    tsbMetabolic: number;
    tsbMechanical: number;
    subjective: number;
    autonomic: number;
    acwrPenalty: number;
  };
  /** Provenance de chaque composante. */
  sources: {
    tsbMetabolic: ReadinessSource;
    tsbMechanical: ReadinessSource;
    subjective: ReadinessSource;
    autonomic: ReadinessSource;
  };
  /** Part du score (0–1) produite par des valeurs par défaut, faute de relevé. */
  assumedShare: number;
  verdict: 'green' | 'amber' | 'red';
  recommendation: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Objectifs & planification
// ─────────────────────────────────────────────────────────────────────────────

export type RacePriority = 'A' | 'B' | 'C';

export interface CourseProfile {
  /** Points du profil : distance cumulée (m) → altitude (m). */
  points?: { distanceM: number; altitudeM: number }[];
  distanceM: number;
  elevationGainM: number;
  elevationLossM: number;
  maxAltitudeM?: number;
  /**
   * Technicité 1 (piste roulante) – 5 (alpin très technique).
   * Applique une pénalité multiplicative à la vitesse en descente et sur le plat.
   */
  technicality: 1 | 2 | 3 | 4 | 5;
  /** Part du parcours sur sentier (0–1), le reste étant roulant. */
  trailFraction?: number;
  expectedTempC?: number;
  /** Départ de nuit / portion nocturne, en heures. */
  nightHours?: number;
}

export interface RaceGoal {
  id: string;
  athleteId: string;
  name: string;
  date: string; // ISO
  priority: RacePriority;
  course: CourseProfile;
  /** Ambition : temps cible et/ou classement visé. */
  target?: {
    timeS?: number;
    placing?: number;
    /** Nombre de partants attendu, pour situer le classement. */
    fieldSize?: number;
    /** Résultats des éditions précédentes, pour calibrer le classement. */
    previousEditions?: { year: number; placing: number; timeS: number }[];
  };
  notes?: string;
}

export type SessionType =
  | 'recovery'          // décrassage
  | 'endurance'         // footing / endurance fondamentale
  | 'long_run'          // sortie longue
  | 'long_trail'        // rando-course spécifique
  | 'tempo'             // allure seuil 1 → 2
  | 'threshold'         // seuil (SV2)
  | 'vo2max'            // PMA / fractionné court
  | 'hill_repeats'      // côtes
  | 'downhill'          // travail de descente (excentrique)
  | 'fartlek'
  | 'race_pace'         // allure spécifique course
  | 'strength'          // PPG / renforcement
  | 'mobility'
  | 'cross_training'
  | 'race'
  | 'rest';

/** Un bloc élémentaire d'une séance (échauffement, répétition, récupération…). */
export interface SessionBlock {
  label: string;
  repeat?: number;
  /** Durée cible, s (ou distance si `distanceM` est fourni). */
  durationS?: number;
  distanceM?: number;
  /** Dénivelé positif visé sur le bloc. */
  elevationGainM?: number;
  zone: ZoneKey;
  /** Fourchette de FC cible. */
  hrRange?: [number, number];
  /** Fourchette d'allure cible à plat, m/s (à corriger de la pente sur le terrain). */
  speedRangeMs?: [number, number];
  /** Allure cible exprimée en min/km, pré-calculée pour la lisibilité. */
  paceRange?: [string, string];
  /** Vitesse ascensionnelle cible, m/h, pour les blocs en côte. */
  vamTargetMh?: number;
  cadenceTargetSpm?: number;
  recovery?: { durationS: number; zone: ZoneKey; active: boolean };
  notes?: string;
}

export interface PlannedSession {
  id: string;
  athleteId: string;
  date: string; // ISO date (jour)
  type: SessionType;
  title: string;
  /** L'intention physiologique, en une phrase — le « pourquoi » de la séance. */
  intent: string;
  blocks: SessionBlock[];
  /** Charge métabolique prévue. */
  plannedLoad: number;
  /** Charge mécanique prévue (impact descente). */
  plannedMechanicalLoad: number;
  plannedDurationS: number;
  plannedDistanceM?: number;
  plannedElevationGainM?: number;
  /** Priorité : une séance `key` ne doit pas être déplacée à la légère. */
  priority: 'key' | 'support' | 'optional';
  /**
   * `completed` : la séance prescrite a eu lieu. `replaced` : une activité a bien
   * été courue ce jour-là, mais elle s'écarte matériellement de ce qui était
   * prescrit — le stimulus prévu n'a pas été délivré. Confondre les deux fait
   * lire au coach une conformité là où le plan a été quitté.
   */
  status: 'planned' | 'completed' | 'partial' | 'missed' | 'moved' | 'cancelled' | 'replaced';
  completedActivityId?: string;
  /** Justification produite par le coach lors de la (re)planification. */
  rationale?: string;
}

export type TrainingPhase =
  | 'transition' | 'base' | 'build' | 'specific' | 'peak' | 'taper' | 'race' | 'recovery';

export interface TrainingWeek {
  weekStart: string; // lundi ISO
  index: number;
  phase: TrainingPhase;
  /** Charge métabolique cible pour la semaine. */
  targetLoad: number;
  targetDurationS: number;
  targetElevationGainM: number;
  /** Répartition d'intensité visée (modèle 3 zones), fractions sommant à 1. */
  intensityDistribution: { low: number; moderate: number; high: number };
  isDeload: boolean;
  focus: string;
  sessions: PlannedSession[];
}

export interface TrainingPlan {
  id: string;
  athleteId: string;
  createdAt: string;
  updatedAt: string;
  /** Course cible principale. */
  goalRaceId: string;
  weeks: TrainingWeek[];
  /** TSB visé le jour de la course. */
  targetRaceDayTsb: number;
  /** Chaîne de décisions ayant abouti au plan, pour l'auditabilité. */
  revisionLog: PlanRevision[];
}

export interface PlanRevision {
  at: string;
  trigger: 'initial' | 'new_activity' | 'chat_request' | 'missed_session' | 'readiness' | 'goal_change';
  summary: string;
  /** Diff lisible : ce qui a bougé et pourquoi. */
  changes: { date: string; before: string; after: string; reason: string }[];
}

// ─────────────────────────────────────────────────────────────────────────────
// Prédiction de course
// ─────────────────────────────────────────────────────────────────────────────

export interface RacePrediction {
  raceId: string;
  computedAt: string;
  /** Temps médian prédit, s. */
  predictedTimeS: number;
  /** Intervalle de confiance à 80 %. */
  rangeS: [number, number];
  /** Distance équivalente à plat, m (coût métabolique du profil intégré). */
  flatEquivalentDistanceM: number;
  /** Intensité relative soutenable pour cette durée (fraction de CS). */
  sustainableFractionOfCs: number;
  /** Facteurs appliqués, pour l'explicabilité. */
  factors: {
    terrain: number;
    heat: number;
    altitude: number;
    durability: number;
    freshness: number;
  };
  /** Probabilité estimée d'atteindre l'objectif de classement. */
  goalProbability?: number;
  /** Plan d'allure segment par segment. */
  pacing: PacingSegment[];
  /** Stratégie nutritionnelle. */
  fueling: { carbGPerHour: number; fluidMlPerHour: number; sodiumMgPerHour: number; totalCarbG: number };
  /** Ce qui limite la performance aujourd'hui, classé par impact. */
  limiters: { factor: string; impactS: number; explanation: string }[];
}

export interface PacingSegment {
  index: number;
  label: string;
  fromM: number;
  toM: number;
  elevationGainM: number;
  elevationLossM: number;
  avgGrade: number;
  targetSpeedMs: number;
  targetVamMh?: number;
  targetHrRange: [number, number];
  estimatedDurationS: number;
  cumulativeTimeS: number;
  /** Consigne verbale (« garde 2 dents de marge », « mange ici »…). */
  cue: string;
}

// ─────────────────────────────────────────────────────────────────────────────
// Coach / conversation
// ─────────────────────────────────────────────────────────────────────────────

export interface CoachInsight {
  id: string;
  athleteId: string;
  createdAt: string;
  scope: 'activity' | 'week' | 'block' | 'race' | 'physiology';
  refId?: string;
  title: string;
  /** Analyse rédigée, en français, adressée à l'athlète. */
  body: string;
  /** Points d'action concrets. */
  actions: string[];
  /** Métriques mises en avant, pour l'affichage. */
  highlights: { label: string; value: string; delta?: string; direction?: 'up' | 'down' | 'flat' }[];
  severity: 'info' | 'good' | 'watch' | 'warn';
}

export interface ChatMessage {
  id: string;
  athleteId: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  /** Outils appelés par le coach durant ce tour, pour la transparence. */
  toolCalls?: { name: string; input: unknown; summary: string }[];
}
