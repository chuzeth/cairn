import type { AthleteConstraints, RaceGoal, TrainingPhase } from '@cairn/core';

/**
 * Périodisation inverse : on part de la date de course et on remonte.
 *
 * La logique est celle d'une préparation d'endurance classique — construire la
 * base, puis la puissance, puis la spécificité, puis récupérer la fraîcheur —
 * avec deux ajustements propres au trail :
 *  · la spécificité porte autant sur le **dénivelé** que sur l'allure ;
 *  · l'affûtage est plus long quand la course est longue, car la charge
 *    mécanique accumulée met plus de temps à se dissiper que la charge
 *    cardiovasculaire.
 */

export interface WeekPlanSpec {
  index: number;
  weekStart: string;
  phase: TrainingPhase;
  isDeload: boolean;
  /**
   * Charge métabolique cible pour la semaine.
   *
   * Elle oriente le choix des séances et leur calibration. Elle ne fabrique
   * aucune durée : une séance porte son contenu, sa charge se mesure dessus.
   */
  targetLoad: number;
  /**
   * Plafond horaire déclaré par l'athlète, en secondes de semaine.
   *
   * C'est une contrainte dure, pas une cible : le volume écrit ne la dépasse
   * jamais, et rien n'oblige à l'atteindre. Elle remplace une durée cible qui
   * se déduisait de la charge par une constante de 55 points par heure — donc
   * ni le plafond dans un sens, ni le contenu réel dans l'autre.
   */
  maxDurationS: number;
  /**
   * Poids de la semaine dans la préparation : sa charge cible rapportée à celle
   * de la semaine la plus lourde du plan.
   *
   * Sans dimension — c'est un rapport de deux charges. C'est lui qui rend à une
   * décharge ou à un affûtage la place qu'ils prennent réellement, là où une
   * durée cible le faisait en convertissant des points en heures à taux fixe.
   */
  loadShare: number;
  targetElevationGainM: number;
  /** Nombre de séances de qualité autorisées. */
  qualitySlots: number;
  focus: string;
  /** Semaines restantes avant la course. */
  weeksToRace: number;
}

const DAY = 86_400_000;

export function mondayOf(date: string | Date): string {
  const d = new Date(typeof date === 'string' ? `${date.slice(0, 10)}T00:00:00Z` : date);
  const dow = d.getUTCDay(); // 0 = dimanche
  const shift = dow === 0 ? -6 : 1 - dow;
  return new Date(d.getTime() + shift * DAY).toISOString().slice(0, 10);
}

export function addDays(date: string, n: number): string {
  return new Date(new Date(`${date}T00:00:00Z`).getTime() + n * DAY).toISOString().slice(0, 10);
}

export function weeksBetween(from: string, to: string): number {
  return Math.round(
    (new Date(`${mondayOf(to)}T00:00:00Z`).getTime() - new Date(`${mondayOf(from)}T00:00:00Z`).getTime()) / (7 * DAY),
  );
}

/** Durée d'affûtage, en semaines, selon la durée estimée de la course. */
export function taperWeeks(estimatedRaceDurationS: number): number {
  const h = estimatedRaceDurationS / 3600;
  if (h < 1.5) return 1;
  if (h < 5) return 2;
  return 3;
}

/**
 * Répartit les semaines disponibles entre les phases.
 * Quand le temps manque, on sacrifie la base avant la spécificité : mieux vaut
 * arriver moins foncier mais spécifiquement prêt que l'inverse.
 */
export function allocatePhases(totalWeeks: number, taper: number): TrainingPhase[] {
  if (totalWeeks <= 0) return [];
  if (totalWeeks <= taper) return Array(totalWeeks).fill('taper');

  const remaining = totalWeeks - taper;
  const specific = Math.min(4, Math.max(1, Math.round(remaining * 0.28)));
  const build = Math.min(Math.max(1, Math.round(remaining * 0.3)), remaining - specific);
  const base = Math.max(0, remaining - specific - build);

  return [
    ...Array<TrainingPhase>(base).fill('base'),
    ...Array<TrainingPhase>(build).fill('build'),
    ...Array<TrainingPhase>(specific).fill('specific'),
    ...Array<TrainingPhase>(taper).fill('taper'),
  ];
}

export interface PeriodizationInput {
  startDate: string;
  race: RaceGoal;
  estimatedRaceDurationS: number;
  /** CTL métabolique au premier jour du plan — point de départ de la progression. */
  currentCtl: number;
  constraints: AthleteConstraints;
  /** Dénivelé positif de la course, sert à cadencer la progression verticale. */
  raceElevationGainM: number;
  /**
   * Profondeur de l'affûtage, en multiple de sa forme nominale. À 1, les
   * proportions de la littérature. Le planificateur la résout pour amener le
   * TSB de la veille de course sur sa cible : la forme nominale est un point de
   * départ plausible, pas une garantie d'y arriver.
   */
  taperScale?: number;
}

/**
 * Bornes de la profondeur d'affûtage que le planificateur a le droit de
 * chercher. Elles existent pour que la recherche du TSB cible reste un
 * affûtage : hors de ces bornes, on n'ajuste plus la fraîcheur, on change la
 * nature de la fin de préparation.
 */
export const TAPER_SCALE_BOUNDS = { min: 0.6, max: 1.2 } as const;

/**
 * Bornes d'une semaine d'affûtage, en fraction de la semaine la plus lourde.
 *
 * Sous un quart du pic, la semaine n'affûte plus : la charge chronique se perd
 * plus vite que la fatigue ne s'évacue, et la fraîcheur gagnée se paie en forme
 * perdue. Au-dessus de 85 %, ce n'est pas un affûtage.
 */
const TAPER_WEEK_BOUNDS = { min: 0.25, max: 0.85 } as const;

/** Décroissance nominale du volume, semaine d'affûtage par semaine d'affûtage. */
const TAPER_SHAPE = [0.75, 0.58, 0.42] as const;

/**
 * Construit le squelette de la préparation : une charge cible par semaine, et
 * le temps que la semaine n'a pas le droit de dépasser.
 *
 * Les garde-fous appliqués sont ceux de la littérature sur la charge :
 * progression de 5 à 8 % par semaine, décharge toutes les 3-4 semaines. Le
 * squelette ne prescrit aucune durée — il ne sait pas ce que la semaine
 * contiendra, et le volume facile ne coûte pas l'heure du travail au seuil.
 */
export function buildPeriodization(input: PeriodizationInput): WeekPlanSpec[] {
  const { startDate, race, currentCtl, constraints, raceElevationGainM } = input;
  const start = mondayOf(startDate);
  const raceWeek = mondayOf(race.date);
  const totalWeeks = Math.max(1, weeksBetween(start, raceWeek) + 1);
  const taper = taperWeeks(input.estimatedRaceDurationS);
  const phases = allocatePhases(totalWeeks, taper);

  // Charge de départ : la charge chronique actuelle, exprimée en équivalent
  // hebdomadaire. On ne repart jamais de zéro, ni d'un chiffre arbitraire.
  const baselineWeekly = Math.max(currentCtl * 7, 180);
  // Borne de la progression, pas le plafond de la semaine : l'ordre de grandeur
  // de ce que coûte le temps déclaré, qui empêche la rampe de s'emballer et
  // l'affûtage de partir d'un pic jamais écrit. Le plafond, lui, porte sur les
  // heures et se vérifie sur le contenu (`maxDurationS`).
  const rampCeiling = constraints.maxWeeklyHours * 55;
  const maxDurationS = Math.round(constraints.maxWeeklyHours * 3600);

  const out: WeekPlanSpec[] = [];
  let load = baselineWeekly;
  let consecutiveBuild = 0;
  // Charge la plus haute effectivement planifiée : c'est d'elle que part
  // l'affûtage. La calculer en composant le taux de progression sur toutes les
  // semaines de construction produit une explosion exponentielle sur une
  // préparation longue — et un affûtage plus lourd que le pic lui-même.
  let peakLoad = baselineWeekly;
  let justDeloaded = false;

  for (let i = 0; i < totalWeeks; i++) {
    const phase = phases[i] ?? 'base';
    const weeksToRace = totalWeeks - 1 - i;
    const weekStart = addDays(start, i * 7);

    // Décharge toutes les 4 semaines de construction (rythme 3:1).
    const isDeload = phase !== 'taper' && consecutiveBuild >= 3;

    if (phase === 'taper') {
      // Affûtage exponentiel : le volume chute, l'intensité est maintenue.
      const taperIndex = taper - weeksToRace; // 1 = première semaine d'affûtage
      const shape = TAPER_SHAPE[Math.min(2, Math.max(0, taperIndex - 1))] ?? 0.5;
      const factor = Math.min(
        TAPER_WEEK_BOUNDS.max,
        Math.max(TAPER_WEEK_BOUNDS.min, shape * (input.taperScale ?? 1)),
      );
      load = peakLoad * factor;
      consecutiveBuild = 0;
    } else if (isDeload) {
      load = load * 0.62;
      consecutiveBuild = 0;
      justDeloaded = true;
    } else {
      const rampRate = phase === 'base' ? 1.07 : phase === 'build' ? 1.055 : 1.03;
      // Après une décharge, on repart du **pic** précédent et non de la semaine
      // allégée : c'est la raison d'être du cycle 3:1. Repartir du niveau
      // déchargé transformerait chaque décharge en plafonnement définitif de la
      // progression, et l'athlète stagnerait en croyant progresser.
      const base = justDeloaded ? peakLoad : load;
      load = Math.min(base * rampRate, rampCeiling);
      peakLoad = Math.max(peakLoad, load);
      consecutiveBuild++;
      justDeloaded = false;
    }

    // Aucune branche ne sort de la borne : décharge et affûtage partent du pic,
    // qui y est déjà tenu.
    load = Math.min(load, rampCeiling);

    // Progression du dénivelé : on vise 90 % du D+ de la course en une semaine,
    // atteint au pic de la phase spécifique.
    const vertProgress = Math.min(1, (i + 1) / Math.max(1, totalWeeks - taper));
    const targetVert = Math.round(
      Math.min(raceElevationGainM * 1.6, Math.max(300, raceElevationGainM * 0.45 + raceElevationGainM * 0.95 * vertProgress)) *
        (isDeload ? 0.55 : phase === 'taper' ? 0.4 : 1),
    );

    out.push({
      index: i,
      weekStart,
      phase,
      isDeload,
      targetLoad: Math.round(load),
      maxDurationS,
      // Renseigné une fois toutes les semaines écrites : la plus lourde n'est
      // connue qu'à la fin.
      loadShare: 1,
      targetElevationGainM: targetVert,
      qualitySlots: qualitySlotsFor(phase, isDeload, constraints.maxQualitySessionsPerWeek),
      focus: focusFor(phase, isDeload, weeksToRace),
      weeksToRace,
    });
  }

  const peak = out.reduce((a, w) => Math.max(a, w.targetLoad), 0);
  return peak > 0 ? out.map((w) => ({ ...w, loadShare: w.targetLoad / peak })) : out;
}

function qualitySlotsFor(phase: TrainingPhase, isDeload: boolean, max: number): number {
  if (isDeload) return Math.min(1, max);
  switch (phase) {
    case 'base': return Math.min(1, max);
    case 'build': return Math.min(2, max);
    case 'specific': return Math.min(2, max);
    case 'peak': return Math.min(2, max);
    case 'taper': return Math.min(2, max);
    default: return 0;
  }
}

function focusFor(phase: TrainingPhase, isDeload: boolean, weeksToRace: number): string {
  if (isDeload) return 'Semaine de décharge — assimiler la charge des trois précédentes. Le volume baisse, la qualité reste légère.';
  switch (phase) {
    case 'base':
      return 'Construction foncière : volume en endurance aérobie, dénivelé progressif, une seule séance intense par semaine.';
    case 'build':
      return 'Développement : introduction du seuil et de la PMA, montée du dénivelé hebdomadaire.';
    case 'specific':
      return 'Spécificité : allure et profil de course, travail de descente, simulation des conditions du jour J.';
    case 'peak':
      return 'Affinage : on maintient l\'intensité, on réduit le volume accessoire.';
    case 'taper':
      return weeksToRace === 0
        ? "Semaine de course : volume minimal, un seul rappel d'allure court. Objectif unique — arriver frais."
        : weeksToRace === 1
          ? "Avant-dernière semaine : le volume chute franchement, l'intensité est maintenue pour ne rien perdre."
          : "Début d'affûtage : on réduit le volume accessoire, on garde les séances clefs.";
    case 'race':
      return 'Semaine de course.';
    default:
      return 'Reprise progressive.';
  }
}
