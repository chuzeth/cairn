import type {
  AppliedDirective, AthleteAmbition, AthleteConstraints, PhysiologyModel, PlannedSession,
  RaceGoal, SessionBlock, SessionType, TrainingDirective, TrainingPlan, TrainingWeek,
} from '@cairn/core';
import {
  ACWR_SPIKE, DURABILITY_MEASURABLE, interpretDurability, prescribedMechanicalLoad, projectFrom,
  projectLoadRatios, ratioExceedances, targetDistribution, targetRaceDayTsb, type DailyLoad,
  type LoadRatioExceedance,
} from '@cairn/physiology';
import {
  TAPER_SCALE_BOUNDS, addDays, buildPeriodization, mondayOf, type WeekPlanSpec,
} from './periodization.js';
import {
  applied, appliedAmbition, clampCadence, criteriaFor, durationDirectiveFor,
  formatDirectiveDuration, honourWeeklyFrequency, indexDirectives, isIntervalSession,
  nextIntervalFormat, type DirectiveSet,
} from './directives.js';
import { carryDecisions, type PlanCarryOver } from './preserve.js';
import * as lib from './sessionLibrary.js';
import type { SessionTemplate } from './sessionLibrary.js';

/**
 * Génération de la semaine d'entraînement.
 *
 * Le planificateur résout un petit problème de placement sous contraintes :
 *  · les jours disponibles et les jours de sortie longue de l'athlète ;
 *  · au moins 48 h entre deux séances de qualité ;
 *  · au moins 72 h après une grosse charge excentrique (descente, sortie longue
 *    très descendante) avant une nouvelle sollicitation du même type ;
 *  · une charge hebdomadaire qui atteint la cible sans la dépasser.
 *
 * Il résout aussi, depuis qu'il lit le dossier entier, les consignes que le
 * praticien a écrites en prose : plages de durée du travail foncier, fréquences
 * hebdomadaires, cible de cadence, un seul fractionné par semaine. Elles
 * arrivent par `directives` et sont appliquées dans `directives.ts` ; le
 * planificateur ne les invente pas et ne peut pas en produire d'autres.
 *
 * Le résultat est déterministe et auditable : chaque séance porte la raison de
 * sa présence à cette place dans la semaine, et l'extrait du dossier qui a
 * fixé sa forme.
 */

const uid = () => `ses_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`;

export interface WeekBuildInput {
  spec: WeekPlanSpec;
  model: PhysiologyModel;
  constraints: AthleteConstraints;
  athleteId: string;
  race: RaceGoal;
  /** Vitesse cible de course, m/s — pour les séances à allure spécifique. */
  racePaceMs?: number;
  /**
   * Directives issues du dossier. Absentes, le plan retombe sur ses quatre
   * nombres — ce qui reste possible, mais se voit.
   */
  directives?: TrainingDirective[];
  /** Ambition de long terme, quand elle est au dossier. */
  ambition?: AthleteAmbition;
  /**
   * Format du fractionné de la semaine. Le plan complet le fait alterner sur
   * toute la préparation ; une semaine construite seule retombe sur la parité
   * de son index.
   */
  intervalFormat?: 'short' | 'medium';
}

/** L'ambition qui change ce que le plan privilégie : la tenue dans la durée. */
function isLongFormat(ambition?: AthleteAmbition): boolean {
  return ambition?.format === 'trail_long' || ambition?.format === 'ultra';
}

/**
 * Choisit les séances de qualité de la semaine.
 *
 * Le compte rendu limite les fractionnés à un par semaine, en alternant court
 * et moyen, et range explicitement la résistance douce — tempo, fartlek
 * vallonné, descente, allure spécifique — parmi les séances intenses qui
 * restent permises à côté. La semaine porte donc au plus un fractionné ; le
 * second créneau, quand la phase en ouvre un, reçoit un stimulus continu.
 *
 * Le créneau moyen est une pyramide : ses paliers restent dans la fenêtre de
 * 3 à 12 min du dossier, et c'est le format que l'athlète exécute réellement.
 * Des répétitions égales (`lib.threshold`) prescrivent le même travail ; elles
 * ne sont pas moins bonnes, elles sont moins faites.
 *
 * L'ordre compte : le premier choisi obtient le meilleur jour. En phase
 * spécifique, c'est l'allure de course qui passe devant — et la semaine peut
 * alors n'avoir aucun fractionné, ce que la consigne autorise, sans que
 * l'alternance saute un tour pour autant.
 */
function selectQualitySessions(input: WeekBuildInput): SessionTemplate[] {
  const { spec, model } = input;
  const i = spec.index;

  // Le nombre de créneaux vient du squelette de périodisation, mais celui-ci a
  // pu être calculé avec des contraintes désormais périmées — l'athlète change
  // ses disponibilités depuis le chat sans que tout le plan soit reconstruit.
  // Les contraintes passées à `buildWeek` font foi.
  const slots = Math.min(spec.qualitySlots, input.constraints.maxQualitySessionsPerWeek);
  if (slots <= 0) return [];

  const format = input.intervalFormat ?? (i % 2 === 0 ? 'short' : 'medium');
  const medium = format === 'medium';
  const longAmbition = isLongFormat(input.ambition);

  // En décharge, on conserve **l'intensité** mais on coupe le **volume** de
  // travail : c'est ce qui permet d'assimiler sans rien perdre. Laisser la
  // séance de qualité à pleine dose ferait dépasser la cible hebdomadaire et
  // annulerait l'intérêt de la semaine.
  if (spec.isDeload) {
    return [medium ? lib.pyramid(model, [3, 5, 3]) : lib.vo2max(model, '30-30', 1, 8)];
  }

  const out: SessionTemplate[] = [];

  switch (spec.phase) {
    case 'base':
      out.push(medium ? lib.pyramid(model, [3, 5, 8, 5, 3]) : lib.hillRepeats(model, 8, 90, 0.1));
      if (slots >= 2) out.push(lib.tempo(model, 20));
      break;

    case 'build':
      out.push(medium ? lib.pyramid(model, [3, 5, 8, 8, 5, 3]) : lib.vo2max(model, '30-30', 2, 10));
      if (slots >= 2) {
        // La tolérance excentrique est le facteur limitant du trail long : quand
        // c'est là que l'athlète veut performer, la descente passe devant le
        // tempo sur le créneau de résistance douce.
        out.push(longAmbition || i % 2 === 1 ? lib.downhillSession(model, 6, 3) : lib.tempo(model, 25));
      }
      break;

    case 'specific':
      out.push(lib.racePace(model, 40, input.racePaceMs, 250));
      if (slots >= 2) out.push(medium ? lib.pyramid(model, [4, 8, 12, 8, 4]) : lib.vo2max(model, '1-1', 2, 8));
      break;

    case 'peak':
      out.push(medium ? lib.pyramid(model, [3, 6, 8, 6, 3]) : lib.vo2max(model, '30-30', 2, 8));
      if (slots >= 2) out.push(lib.racePace(model, 30, input.racePaceMs, 200));
      break;

    case 'taper':
      // On maintient l'intensité mais on coupe le volume : c'est ce qui préserve
      // les adaptations tout en libérant la fraîcheur. La semaine de course
      // échappe à l'alternance — ses six répétitions sont un rappel de foulée,
      // pas le fractionné de la semaine.
      out.push(
        spec.weeksToRace <= 0
          ? lib.vo2max(model, '30-30', 1, 6)
          : medium
            ? lib.pyramid(model, [3, 5, 3])
            : lib.vo2max(model, '30-30', 1, 8),
      );
      break;

    default:
      break;
  }

  return out.slice(0, Math.max(0, slots));
}

/** Sortie longue de la semaine : format et volume dictés par la phase et l'objectif. */
function selectLongSession(input: WeekBuildInput): SessionTemplate | null {
  const { spec, model, race, constraints } = input;
  if (spec.phase === 'taper' && spec.weeksToRace <= 1) return null;

  const raceVertPerKm =
    race.course.distanceM > 0 ? (race.course.elevationGainM / race.course.distanceM) * 1000 : 0;
  const isMountain = raceVertPerKm > 25;
  const longAmbition = isLongFormat(input.ambition);

  // Le volume de la sortie longue est une part du temps dont l'athlète dispose :
  // ~38 % en base, jusqu'à 50 % en spécifique. L'ambition longue distance fait
  // monter la part : la durabilité se construit — et ne se mesure — que sur un
  // effort d'un seul tenant, jamais sur un cumul de footings de semaine.
  //
  // Le temps dont il s'agit est celui que l'athlète a déclaré, pondéré par le
  // poids de la semaine dans la préparation — une décharge ou un affûtage n'en
  // prennent pas autant qu'une semaine de pic. La part portait auparavant sur
  // une durée hebdomadaire obtenue en divisant la charge cible par 55 points
  // l'heure : le plafond déclaré n'y entrait pas, et le plan sortait d'un côté
  // des semaines de onze heures et demie, de l'autre des semaines qui en
  // laissaient quatre inutilisées.
  const share =
    spec.phase === 'specific'
      ? longAmbition ? 0.5 : 0.45
      : spec.phase === 'taper'
        ? 0.3
        : longAmbition ? 0.45 : 0.38;
  const durationMin = Math.round(
    Math.min((spec.maxDurationS * spec.loadShare * share) / 60, spec.phase === 'taper' ? 90 : 300),
  );
  const vert = Math.round(
    Math.min(spec.targetElevationGainM * 0.65, constraints.accessibleVertPerSession * 1.8),
  );

  // Planchers de mesurabilité : en dessous, la séance entraîne mais ne dit rien.
  // Ils ne s'appliquent ni en décharge ni en affûtage, où la semaine a une autre
  // fonction que de produire des données.
  const measuring = longAmbition && !spec.isDeload && spec.phase !== 'taper';
  const minDurationMin = measuring ? DURABILITY_MEASURABLE.minDurationS / 60 : 0;
  const minVert = measuring ? DURABILITY_MEASURABLE.minVertM : 0;

  // La rando-course est le format spécifique du compte rendu — « puis, de
  // manière spécifique ». Elle reste hors de la phase foncière, que le même
  // texte confie aux footings prolongés.
  if ((isMountain || longAmbition) && spec.phase !== 'base') {
    return lib.longTrail(
      model,
      Math.max(90, minDurationMin, durationMin),
      Math.max(400, minVert, vert),
    );
  }
  return lib.longRun(model, Math.max(60, minDurationMin, durationMin), Math.max(0, minVert, vert));
}

/**
 * Place les séances dans la semaine.
 *
 * Ordre de priorité : la sortie longue d'abord (elle contraint le plus), puis
 * les séances de qualité en respectant les espacements, puis le remplissage.
 */
export function buildWeek(input: WeekBuildInput): TrainingWeek {
  const { spec, model, constraints, athleteId } = input;
  const set = indexDirectives(input.directives);
  const available = new Set(constraints.availableDays);
  const longDays = constraints.longRunDays.filter((d) => available.has(d));

  const assigned = new Map<number, SessionTemplate>();
  const reasons = new Map<number, string>();

  // ── 1. Sortie longue ──────────────────────────────────────────────────────
  const longSession = selectLongSession(input);
  let longDay: number | null = null;
  if (longSession) {
    longDay = longDays[spec.index % Math.max(1, longDays.length)] ?? 6;
    assigned.set(longDay, longSession);
    reasons.set(
      longDay,
      `Sortie longue placée le ${dayName(longDay)} : jour le plus disponible, et 48 h de marge avant la première qualité de la semaine suivante.`,
    );
  }

  // ── 2. Séances de qualité ─────────────────────────────────────────────────
  const quality = selectQualitySessions(input);
  // Jours candidats : disponibles, ni la veille ni le lendemain de la sortie longue.
  const candidates = [2, 4, 1, 3, 5, 0, 6].filter(
    (d) =>
      available.has(d) &&
      !assigned.has(d) &&
      (longDay == null || circularDistance(d, longDay) >= 2),
  );

  const usedQualityDays: number[] = [];
  for (const session of quality) {
    const day = candidates.find(
      (d) => !assigned.has(d) && usedQualityDays.every((u) => circularDistance(d, u) >= 2),
    );
    if (day == null) break;
    assigned.set(day, session);
    usedQualityDays.push(day);
    reasons.set(
      day,
      `Séance clef le ${dayName(day)} : au moins 48 h de récupération de part et d'autre — c'est la condition pour que le stimulus soit assimilé.`,
    );
  }

  // ── 3. Remplissage : endurance, renforcement, récupération ────────────────
  const remaining = [1, 2, 3, 4, 5, 6, 0].filter((d) => available.has(d) && !assigned.has(d));
  // Une journée de repos complet au minimum, sauf en phase de décharge où il y en a deux.
  const restCount = spec.isDeload ? 2 : constraints.availableDays.length >= 7 ? 1 : 0;
  const restDays = pickRestDays(remaining, usedQualityDays, longDay, restCount);

  for (const d of remaining) {
    if (restDays.includes(d)) {
      assigned.set(d, lib.restDay());
      reasons.set(d, "Repos complet : c'est le jour où l'adaptation se produit.");
      continue;
    }
    // Lendemain d'une séance clef ou de la sortie longue → décrassage.
    const prev = (d + 6) % 7;
    const afterHard = usedQualityDays.includes(prev) || prev === longDay;
    if (afterHard) {
      assigned.set(d, lib.recovery(model, spec.isDeload ? 30 : 45));
      reasons.set(d, `Décrassage : lendemain d'une séance exigeante, on facilite la récupération sans ajouter de charge.`);
    } else {
      assigned.set(d, lib.endurance(model, 60, Math.round(spec.targetElevationGainM * 0.12)));
      reasons.set(d, 'Endurance fondamentale : le volume qui construit la base aérobie.');
    }
  }

  // ── 3 bis. Le footing prolongé du dossier ─────────────────────────────────
  // « Renforcer la qualité foncière par des footings prolongés d'1 h 30 à
  // 2 h 30 » : la directive ne vise que `long_run`, et la sortie longue de la
  // semaine est une rando-course dès qu'on quitte la phase foncière — vingt-deux
  // jours de plan sans une seule séance qui l'honore. On en place donc un, sur
  // le jour d'endurance le plus éloigné des séances exigeantes. Ni en décharge
  // ni en affûtage : ces semaines-là ont une autre fonction, et la trace de la
  // directive le retient déjà.
  const footing = durationDirectiveFor(set, 'long_run');
  if (footing && !spec.isDeload && spec.phase !== 'taper' && longSession?.type === 'long_trail') {
    const hard = [...usedQualityDays, ...(longDay != null ? [longDay] : [])];
    const day = remaining
      .filter((d) => !restDays.includes(d) && assigned.get(d)?.type === 'endurance')
      .sort((a, b) => minDistance(b, hard) - minDistance(a, hard))[0];
    if (day != null) {
      assigned.set(
        day,
        lib.longFooting(
          model,
          Math.round(footing.minS / 60),
          Math.round(spec.targetElevationGainM * 0.15),
        ),
      );
      reasons.set(
        day,
        `Footing prolongé le ${dayName(day)} : le dossier demande ` +
          `${formatDirectiveDuration(footing.minS)} à ${formatDirectiveDuration(footing.maxS)} d'un seul ` +
          `tenant sur du roulant, et la durabilité est le facteur limitant mesuré de cet athlète.`,
      );
    }
  }

  // Renforcement adossé à un jour d'endurance (jamais un jour de qualité).
  const strengthDay = remaining.find((d) => !restDays.includes(d) && assigned.get(d)?.type === 'endurance');
  if (strengthDay != null && spec.phase !== 'taper') {
    const existing = assigned.get(strengthDay)!;
    const s = lib.strength(model);
    const blocks = [...existing.blocks, ...s.blocks];
    // La charge mécanique se relit sur les blocs fusionnés, jamais par forfait :
    // un forfait fait peser un tour de circuit comme trois, et c'est justement
    // par le nombre de tours qu'on réintroduit l'excentrique après une coupure.
    assigned.set(strengthDay, {
      ...existing,
      title: lib.addFormatMention(existing.title, '+ renforcement'),
      blocks,
      durationS: existing.durationS + s.durationS,
      plannedLoad: existing.plannedLoad + s.plannedLoad,
      plannedMechanicalLoad: lib.mechanicalFor(blocks, existing.elevationLossM).total,
      intent: `${existing.intent} Le renforcement suit immédiatement : chaîne postérieure et souplesse.`,
    });
  }

  // ── 4. Calibration sur la charge cible ────────────────────────────────────
  const sessions = calibrateToTarget([...assigned.entries()], spec, athleteId, reasons, set, model);

  // ── 5. Directives du dossier ──────────────────────────────────────────────
  honourDirectives(sessions, set, input);

  // ── 6. Nombres humains, une fois le contenu complet ───────────────────────
  // Les blocs annexes qu'une fréquence hebdomadaire vient d'adosser font partie
  // de ce que l'athlète exécute : la séance retombe sur la maille après eux,
  // pas avant. Et le titre se relit sur le contenu final — c'est ici que se
  // ferme l'écart entre « Décrassage 40 min » et les 58 minutes enregistrées.
  for (const s of sessions) humanize(s, model);

  // ── 7. Plafond horaire ────────────────────────────────────────────────────
  capToWeeklyCeiling(sessions, spec, set, model);

  const dist = targetDistribution(spec.phase);
  return {
    weekStart: spec.weekStart,
    index: spec.index,
    phase: spec.phase,
    targetLoad: spec.targetLoad,
    plannedDurationS: writtenDurationS(sessions),
    targetElevationGainM: spec.targetElevationGainM,
    intensityDistribution: dist,
    isDeload: spec.isDeload,
    focus: spec.focus,
    sessions,
  };
}

/**
 * Temps d'entraînement qu'une semaine écrit.
 *
 * La course n'en fait pas partie : le plafond porte sur ce que l'athlète
 * s'impose à l'entraînement, et une épreuve de onze heures n'est pas une
 * semaine trop chargée — c'est l'objet de la préparation.
 */
export function writtenDurationS(sessions: readonly PlannedSession[]): number {
  return sessions.filter((s) => s.type !== 'race').reduce((a, s) => a + s.plannedDurationS, 0);
}

/**
 * Ce qui se négocie dans une séance : son contenu facile.
 *
 * Ce que le dossier prescrit — tours d'un circuit, souplesse, respiration — n'en
 * fait pas partie, et `transformSession` le tient déjà hors de ses facteurs. Le
 * plafond horaire n'a pas à défaire ce que le praticien a écrit.
 */
function negotiableS(s: PlannedSession): number {
  return lib.totalDuration(s.blocks.filter((b) => !lib.isPrescribed(b)));
}

/**
 * Ramène la semaine sous le plafond horaire déclaré.
 *
 * Le plafond était converti en charge — neuf heures valaient 495 points — puis
 * appliqué là. Du volume facile à 45 points l'heure le franchissait de plus de
 * deux heures sans qu'aucune ligne ne le dise. Il porte maintenant sur ce que la
 * semaine écrit, et il ne se dépasse pas.
 *
 * Ce qui cède, dans l'ordre : le décrassage, puis le volume facile, puis la
 * sortie longue ; et s'il le faut la plage du dossier elle-même, puis un jour
 * qui devient repos. Jamais les séances de qualité : leur dosage est
 * physiologique, et une semaine qui déborde n'est pas une semaine trop intense,
 * c'est une semaine trop longue.
 *
 * Que la plage du dossier puisse céder n'est pas une licence. Un dossier qui
 * prescrit trois heures de rando-course et une heure et demie de foncier ne
 * tient pas dans six heures hebdomadaires avec deux séances de qualité : le
 * conflit est réel, et le trancher en faveur du temps déclaré est le seul choix
 * exécutable. La séance le porte (`exemption: 'ceiling'`) — elle n'a pas
 * silencieusement quitté sa plage.
 */
function capToWeeklyCeiling(
  sessions: PlannedSession[],
  spec: WeekPlanSpec,
  set: DirectiveSet,
  model: PhysiologyModel,
): void {
  const over = () => writtenDurationS(sessions) - spec.maxDurationS;
  if (over() <= 0) return;

  // La décharge et l'affûtage dispensent du plancher du dossier, ici comme
  // partout : ces semaines-là ont une autre fonction que de construire.
  const exempt = spec.isDeload || spec.phase === 'taper';
  const prescribedFloor = (s: PlannedSession) =>
    exempt ? 0 : durationDirectiveFor(set, s.type)?.minS ?? 0;

  const isVolume = (s: PlannedSession) => s.type === 'recovery' || s.type === 'endurance';
  const isWithLong = (s: PlannedSession) =>
    isVolume(s) || s.type === 'long_run' || s.type === 'long_trail';
  const volume = sessions.filter(isVolume);
  const withLong = sessions.filter(isWithLong);

  for (const [pool, honourDossier] of [
    [sessions.filter((s) => s.type === 'recovery'), true],
    [volume, true],
    [withLong, true],
    [withLong, false],
  ] as const) {
    // En deçà d'un quart d'heure, une séance n'a plus de forme : on la retire
    // plutôt que de la raboter.
    const floorOf = (s: PlannedSession) =>
      Math.max(lib.SESSION_GRID_S, honourDossier ? prescribedFloor(s) : 0);
    // La maille du quart d'heure fait qu'un facteur ne tombe pas juste du
    // premier coup : on réduit, on remesure, on recommence tant qu'il reste du
    // mou.
    for (let pass = 0; pass < 4 && over() > 0; pass++) {
      const movable = pool
        .map((x) => ({ x, body: negotiableS(x), room: negotiableS(x) - floorOf(x) }))
        .filter((m) => m.room > 0 && m.body > 0);
      const room = movable.reduce((a, m) => a + m.room, 0);
      if (room <= 0) break;
      // Chacun cède au prorata de ce qu'il peut céder : le plafond ne vide pas
      // la première séance venue pour épargner la suivante.
      const share = Math.min(1, over() / room);
      for (const m of movable) {
        const factor = (m.body - m.room * share) / m.body;
        // Une sortie qui mesurait la durabilité continue de la mesurer : le
        // plafond lui prend du temps, pas le dénivelé qui la rend lisible. Ce
        // que l'athlète ne peut pas tenir sur le temps qui reste cède quand
        // même — les courbes décident, et la séance le dit.
        const carried = lib.elevationGainOf(m.x.blocks);
        const measuring =
          carried >= DURABILITY_MEASURABLE.minVertM &&
          m.body * factor >= DURABILITY_MEASURABLE.minDurationS;
        const vertical = measuring
          ? Math.max(factor, DURABILITY_MEASURABLE.minVertM / carried)
          : factor;
        const t = lib.transformSession(m.x, { duration: factor, vertical }, model);
        m.x.blocks = t.blocks;
        if (t.amendments.length) {
          m.x.rationale = [m.x.rationale, ...t.amendments].filter(Boolean).join(' ');
        }
        humanize(m.x, model);
      }
    }
  }

  // Dernier recours : le plafond fait tomber un jour, et la semaine le dit — un
  // jour retiré faute de temps n'est pas un jour de repos choisi. Les jours qui
  // portent un bloc du dossier passent en dernier : la fréquence hebdomadaire
  // qu'ils honorent ne se rattrape nulle part ailleurs.
  const droppable = volume
    .filter((x) => x.plannedDurationS > 0)
    .sort(
      (a, b) =>
        Number(a.blocks.some((x) => x.kind)) - Number(b.blocks.some((x) => x.kind)) ||
        a.plannedLoad - b.plannedLoad ||
        a.date.localeCompare(b.date),
    );
  for (const x of droppable) {
    if (over() <= 0) break;
    const rest = lib.restDay();
    x.type = 'rest';
    x.title = rest.title;
    x.intent = rest.intent;
    x.blocks = rest.blocks;
    x.plannedLoad = 0;
    x.plannedMechanicalLoad = 0;
    x.plannedDurationS = 0;
    x.plannedElevationGainM = 0;
    x.plannedDistanceM = 0;
    x.directives = undefined;
    x.rationale =
      `Jour retiré par le plafond horaire : la semaine dépassait les ` +
      `${formatHours(spec.maxDurationS)} déclarées, et le volume facile ne pouvait plus reculer.`;
  }

  // La trace suit ce qui a cédé. Une séance sortie de sa plage sans que rien ne
  // l'explique ferait passer le dossier pour bafoué ; c'est le plafond qui a
  // tranché, et c'est lui qu'on écrit.
  for (const x of sessions) {
    const directive = durationDirectiveFor(set, x.type);
    if (!directive || negotiableS(x) >= directive.minS) continue;
    x.directives = x.directives?.map((t) =>
      t.directiveId === directive.id && !t.exemption ? { ...t, exemption: 'ceiling' as const } : t,
    );
  }
}

/** Un nombre d'heures tel qu'on l'écrit à l'athlète — « 9 h », « 7 h 30 ». */
function formatHours(seconds: number): string {
  const min = Math.round(seconds / 60);
  return min % 60 === 0 ? `${min / 60} h` : `${Math.floor(min / 60)} h ${String(min % 60).padStart(2, '0')}`;
}

/**
 * Ajuste le volume pour atteindre la charge cible.
 *
 * Les séances de qualité ne sont jamais étirées ni raccourcies : leur dosage
 * est physiologique, pas comptable. La sortie longue non plus, depuis que sa
 * durée est prescrite : elle passe la première, on la borne dans la plage du
 * dossier, et c'est le volume facile qui absorbe le reste — ce que fait
 * n'importe quel entraîneur sérieux, et ce que le plan faisait à l'envers.
 */
function calibrateToTarget(
  entries: [number, SessionTemplate][],
  spec: WeekPlanSpec,
  athleteId: string,
  reasons: Map<number, string>,
  set: DirectiveSet,
  model: PhysiologyModel,
): PlannedSession[] {
  const isLong = (s: SessionTemplate) => s.type === 'long_run' || s.type === 'long_trail';
  const isFiller = (s: SessionTemplate) => s.type === 'endurance';
  const fixedLoad = entries
    .filter(([, s]) => !isLong(s) && !isFiller(s))
    .reduce((a, [, s]) => a + s.plannedLoad, 0);
  const adjustableLoad = entries
    .filter(([, s]) => isLong(s) || isFiller(s))
    .reduce((a, [, s]) => a + s.plannedLoad, 0);

  const wanted = Math.max(0, spec.targetLoad - fixedLoad);
  const scale = adjustableLoad > 0 ? clamp(wanted / adjustableLoad, 0.55, 1.7) : 1;

  // La sortie longue d'abord : sa durée relève de la prescription, pas du solde
  // de la semaine.
  const longFactors = new Map<SessionTemplate, number>();
  for (const [, s] of entries.filter(([, x]) => isLong(x))) {
    longFactors.set(s, longFactor(s, scale, spec, set));
  }
  const longLoad = [...longFactors].reduce((a, [s, f]) => a + s.plannedLoad * f, 0);

  // Ce qui reste retombe sur le volume facile. Le plancher est plus bas que le
  // facteur commun d'avant : une sortie longue prescrite doit pouvoir faire
  // reculer les footings de semaine, sinon la plage n'est pas honorée.
  const fillerLoad = entries
    .filter(([, s]) => isFiller(s))
    .reduce((a, [, s]) => a + s.plannedLoad, 0);
  const fillerScale =
    fillerLoad > 0 ? clamp((spec.targetLoad - fixedLoad - longLoad) / fillerLoad, 0.35, 1.7) : 1;

  // Filet de sécurité : quand les séances non ajustables pèsent déjà plus que
  // la cible de la semaine (décharge, affûtage, semaine très courte), le volume
  // facile ne suffit plus comme variable d'ajustement. On réduit alors aussi
  // les séances de qualité — en dernier recours, et jamais en dessous de 65 %.
  const globalScale =
    fixedLoad > spec.targetLoad && spec.targetLoad > 0
      ? clamp(spec.targetLoad / fixedLoad, 0.65, 1)
      : 1;

  return entries
    .sort(([a], [b]) => weekOrder(a) - weekOrder(b))
    .map(([day, s]) => {
      const factor = isLong(s)
        ? (longFactors.get(s) as number)
        : isFiller(s)
          ? cappedFactor(s, fillerScale)
          : globalScale;
      const date = addDays(spec.weekStart, weekOrder(day));
      const said = (amendments: readonly string[] = []) =>
        [reasons.get(day), ...amendments].filter(Boolean).join(' ') || undefined;
      const common = {
        id: uid(),
        athleteId,
        date,
        type: s.type as SessionType,
        intent: s.intent,
        priority: s.priority,
        status: 'planned' as const,
      };

      // Un jour de repos n'a rien à mettre à l'échelle.
      if (s.durationS === 0) {
        return {
          ...common,
          title: s.title,
          blocks: s.blocks,
          plannedLoad: 0,
          plannedMechanicalLoad: 0,
          plannedDurationS: 0,
          plannedElevationGainM: 0,
          rationale: said(s.amendments),
        };
      }

      // La sortie longue ne s'étire pas : elle se reconstruit à la durée que la
      // calibration lui donne, avec le dénivelé demandé mis à la même échelle.
      // Sa forme dépend du temps disponible — la montée et la descente prennent
      // ce que les courbes de l'athlète exigent, le reste va au terrain plat —,
      // et la phrase qui dit ce qui a cédé parle de la séance enregistrée, pas
      // d'un gabarit que l'athlète ne verra jamais.
      if (isLong(s) && s.rebuild) {
        const built = factor !== 1 ? s.rebuild(factor) : s;
        return {
          ...common,
          title: built.title,
          blocks: built.blocks,
          plannedLoad: built.plannedLoad,
          plannedMechanicalLoad: built.plannedMechanicalLoad,
          plannedDurationS: built.durationS,
          plannedDistanceM: built.plannedDistanceM,
          plannedElevationGainM: built.elevationGainM,
          rationale: said([...(built.amendments ?? []), ...(built.divergences ?? []).map((d) => d.statement)]),
        };
      }

      // Tout le reste passe par le chemin commun à toute transformation : durée
      // et dénivelé ensemble, ce que l'athlète ne peut pas exécuter fait céder
      // le dénivelé, et la durée retombe sur la maille humaine avant d'être
      // prescrite. Les totaux qui en sortent sont **mesurés sur le contenu** —
      // le facteur dit ce qu'on visait, les blocs disent ce qu'on a écrit. Un
      // fractionné réduit perd des répétitions et non la durée des siennes :
      // c'est elle que le dossier prescrit.
      const change = isIntervalSession(s.type as SessionType) && factor < 1
        ? { duration: factor, repeats: factor }
        : factor;
      const t = lib.transformSession(
        {
          type: s.type,
          blocks: s.blocks,
          plannedLoad: s.plannedLoad,
          plannedMechanicalLoad: s.plannedMechanicalLoad,
          plannedDurationS: s.durationS,
          plannedDistanceM: s.plannedDistanceM,
        },
        change,
        model,
      );
      return {
        ...common,
        title: lib.retitleFromContent({ title: s.title, type: s.type as SessionType, blocks: t.blocks }),
        blocks: t.blocks,
        plannedLoad: t.plannedLoad,
        plannedMechanicalLoad: t.plannedMechanicalLoad,
        plannedDurationS: t.plannedDurationS,
        plannedDistanceM: t.plannedDistanceM,
        plannedElevationGainM: t.plannedElevationGainM,
        rationale: said([...(s.amendments ?? []), ...t.amendments]),
      };
    });
}

/**
 * Facteur d'échelle de la sortie longue.
 *
 * La plage prescrite prime sur le calcul de charge, sauf en décharge et en
 * affûtage : ces semaines-là ont une autre fonction, et un plancher d'1 h 30
 * appliqué à un affûtage n'est plus un affûtage. Le plafond, lui, tient
 * toujours — rien ne justifie de dépasser ce que le praticien a écrit.
 */
function longFactor(
  s: SessionTemplate,
  scale: number,
  spec: WeekPlanSpec,
  set: DirectiveSet,
): number {
  const factor = cappedFactor(s, scale);
  const directive = durationDirectiveFor(set, s.type as SessionType);
  if (!directive || s.durationS <= 0) return factor;
  const ceiling = Math.min(factor, directive.maxS / s.durationS);
  if (spec.isDeload || spec.phase === 'taper') return ceiling;
  return Math.max(ceiling, Math.min(directive.minS / s.durationS, directive.maxS / s.durationS));
}

/**
 * Applique à la semaine ce que le dossier prescrit et ce que l'ambition
 * privilégie, et en laisse la trace sur chaque séance concernée.
 */
function honourDirectives(sessions: PlannedSession[], set: DirectiveSet, input: WeekBuildInput): void {
  const longAmbition = isLongFormat(input.ambition);
  const spec = input.spec;

  for (const s of sessions) {
    const traces: AppliedDirective[] = [...(s.directives ?? [])];

    const cadence = clampCadence(s.blocks, set.cadence);
    if (cadence.changed && set.cadence) {
      s.blocks = cadence.blocks;
      traces.push(applied(set.cadence));
    }

    const criteria = criteriaFor(set, s.type);
    if (criteria.length > 0) s.successCriteria = criteria;

    // Les traces disent quelle consigne a façonné la séance, pas ce qu'elle y a
    // produit : la durée retenue et le dénivelé se lisent sur le contenu
    // (`describeDirectives`), qui peut être réécrit après la construction. La
    // semaine, elle, ne se lit sur aucun contenu : une décharge ou un affûtage
    // dispense du plancher, et la trace le retient.
    const duration = durationDirectiveFor(set, s.type);
    if (duration && s.plannedDurationS > 0) {
      traces.push(applied(duration, spec.isDeload ? 'deload' : spec.phase === 'taper' ? 'taper' : undefined));
    }

    if (set.intervals && isIntervalSession(s.type)) traces.push(applied(set.intervals));

    if (longAmbition && input.ambition && (s.type === 'long_run' || s.type === 'long_trail')) {
      if (!spec.isDeload && spec.phase !== 'taper') raiseVertToMeasurable(s, input.model);
      traces.push(appliedAmbition(input.ambition));
    }

    if (traces.length > 0) s.directives = traces;
  }

  honourWeeklyFrequency(sessions, set);
}

/**
 * Relève le dénivelé de la sortie longue jusqu'au seuil de mesurabilité.
 *
 * La calibration met le dénivelé à l'échelle de la durée : une sortie ramenée
 * de 3 h 30 à 2 h 30 pour tenir dans la plage prescrite perd un tiers de son
 * D+, et repasse sous ce qu'il faut pour que la régression produise une pente
 * par 1 000 m. La séance entraînerait quand même — mais elle ne dirait rien,
 * et c'est exactement le défaut qu'on corrige : une durabilité jamais mesurée
 * parce que rien dans le plan n'a la forme qui la mesure.
 */
function raiseVertToMeasurable(s: PlannedSession, model: PhysiologyModel): void {
  const floor = DURABILITY_MEASURABLE.minVertM;
  const carried = lib.elevationGainOf(s.blocks);
  if (carried >= floor || carried <= 0) return;

  // Le dénivelé monte par le chemin de toute transformation, à durée
  // inchangée : le plancher de mesurabilité ne prime pas sur ce que l'athlète
  // peut exécuter. Relevé en prenant le temps des autres blocs, il avait vidé
  // la descente d'une rando-course — un bloc sans dénivelé déclaré passait pour
  // du temps disponible. Quand un segment ne tient plus, le relèvement
  // s'arrête là, et la séance dit pourquoi.
  const t = lib.transformSession(s, { duration: 1, vertical: floor / carried }, model);
  // Le plancher est visé, pas décrété : ce qui est enregistré est ce que les
  // blocs portent, et le titre suit.
  s.blocks = t.blocks;
  s.plannedElevationGainM = t.plannedElevationGainM;
  s.plannedMechanicalLoad = t.plannedMechanicalLoad;
  s.plannedDurationS = t.plannedDurationS;
  s.title = lib.restateVert(s.title, t.plannedElevationGainM);
  if (t.amendments.length) s.rationale = [s.rationale, ...t.amendments].filter(Boolean).join(' ');
}

/**
 * Plafond de durée par type de séance.
 *
 * Le calibrage sur la charge hebdomadaire est un ajustement comptable : sans
 * borne, il produit des footings de semaine de deux heures et demie parce que
 * c'était le seul moyen d'atteindre le chiffre. Une séance a une forme, pas
 * seulement un poids.
 */
const MAX_DURATION_S: Partial<Record<SessionType, number>> = {
  endurance: 105 * 60,
  recovery: 55 * 60,
  long_run: 210 * 60,
  long_trail: 330 * 60,
};

function cappedFactor(s: SessionTemplate, factor: number): number {
  const cap = MAX_DURATION_S[s.type as SessionType];
  if (!cap || s.durationS <= 0) return factor;
  return Math.min(factor, cap / s.durationS);
}

/** Lundi = 0 … dimanche = 6, pour trier une semaine dans l'ordre calendaire. */
function weekOrder(dow: number): number {
  return (dow + 6) % 7;
}

function circularDistance(a: number, b: number): number {
  const d = Math.abs(weekOrder(a) - weekOrder(b));
  return Math.min(d, 7 - d);
}

/** Distance au plus proche des jours donnés — 7 quand il n'y en a aucun. */
function minDistance(day: number, others: readonly number[]): number {
  return others.length === 0 ? 7 : Math.min(...others.map((o) => circularDistance(day, o)));
}

/**
 * Ramène une séance écrite sur la maille humaine, titre compris.
 *
 * Dernière porte avant l'enregistrement : quoi qu'il soit arrivé aux blocs —
 * calibration, dénivelé relevé, bloc annexe adossé —, ce qui sort se prescrit
 * au quart d'heure et se lit dans le titre. La charge est ensuite **mesurée**
 * sur ce contenu : c'est l'inversion, la durée n'est plus le quotient d'un
 * budget.
 */
function humanize(s: PlannedSession, model: PhysiologyModel): void {
  if (s.blocks.length === 0) return;
  const blocks = lib.snapToHumanGrid(s.blocks);
  // Le dénivelé négatif est celui que les blocs déclarent — c'est ce que la
  // bibliothèque a écrit à la construction, et une semaine calibrée n'a pas à
  // en inférer un autre.
  const totals = lib.sessionTotals(model, blocks, lib.elevationLossOf(blocks));
  s.blocks = blocks;
  s.plannedDurationS = totals.durationS;
  s.plannedLoad = totals.load;
  s.plannedMechanicalLoad = totals.mechanicalLoad;
  s.plannedElevationGainM = totals.elevationGainM;
  s.plannedDistanceM = Math.round(totals.distanceM);
  s.title = lib.retitleFromContent(s);
}

function pickRestDays(remaining: number[], qualityDays: number[], longDay: number | null, count: number): number[] {
  if (count <= 0) return [];
  // On privilégie le jour le plus éloigné des séances exigeantes… sauf le
  // lendemain de la sortie longue, où le repos complet a le plus de valeur.
  const scored = remaining.map((d) => {
    const prev = (d + 6) % 7;
    const dayAfterLong = longDay != null && prev === longDay;
    const minDistance = Math.min(
      ...[...qualityDays, ...(longDay != null ? [longDay] : [])].map((q) => circularDistance(d, q)),
      7,
    );
    return { d, score: dayAfterLong ? 100 : -minDistance };
  });
  return scored.sort((a, b) => b.score - a.score).slice(0, count).map((x) => x.d);
}

const DAY_NAMES = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const dayName = (dow: number) => DAY_NAMES[dow] ?? '';
const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

// ─────────────────────────────────────────────────────────────────────────────
// Plan complet
// ─────────────────────────────────────────────────────────────────────────────

export interface BuildPlanInput {
  athleteId: string;
  model: PhysiologyModel;
  constraints: AthleteConstraints;
  race: RaceGoal;
  /**
   * Charge chronique **au premier jour du plan**, pas au jour où on le
   * construit. Onze jours de coupure entre les deux dates suffisent à faire
   * proposer une semaine de reprise que l'athlète ne peut plus tenir.
   */
  currentCtl: number;
  /**
   * Charge aiguë au premier jour du plan. Absente, on la suppose égale à la
   * chronique — TSB nul au départ. C'est neutre, et c'est faux après une
   * coupure : l'appelant la calcule dès qu'il en a les moyens.
   */
  currentAtl?: number;
  estimatedRaceDurationS: number;
  racePaceMs?: number;
  startDate?: string;
  /** Directives issues du dossier de l'athlète. */
  directives?: TrainingDirective[];
  /** Ambition de long terme, distincte de la course cible. */
  ambition?: AthleteAmbition;
  /**
   * Charges quotidiennes connues avant le premier jour du plan : le réalisé,
   * puis ce qui reste attendu d'ici là. C'est la charge chronique sur laquelle
   * se lisent les ratios du plan ; sans elle, ils partent de rien.
   */
  loadHistory?: readonly DailyLoad[];
  /**
   * Le plan en place, dont les décisions doivent survivre à la reconstruction.
   *
   * Absent, le planificateur écrit sur une page blanche — c'est le cas d'un
   * premier plan. Présent, les séances qui portent une décision sont reprises
   * telles quelles, et le plan neuf s'écrit autour d'elles.
   */
  previous?: readonly TrainingWeek[];
  /**
   * Le jour où la reconstruction a lieu : ce qui est avant est du passé, et le
   * passé ne se réécrit pas. Par défaut, le premier jour du plan.
   */
  today?: string;
}

/**
 * Ce que le plan produit, mesuré contre la cible qu'il s'est donnée.
 *
 * La mesure se lit **la veille de la course**, pas le jour J : la charge de la
 * course elle-même entre dans le calcul du jour J, et ce qu'on y lirait serait
 * l'état d'arrivée, pas celui du départ.
 *
 * Elle porte sur les charges des séances effectivement produites — plafonds de
 * durée, plages du dossier et planchers de calibration compris — et non sur les
 * charges cibles des semaines, qu'aucune séance n'est tenue d'atteindre.
 */
export interface RaceDayTsbCheck {
  /** Veille de course : le dernier jour dont la charge pèse sur le matin du départ. */
  date: string;
  /** TSB visé, fonction de la durée de l'épreuve. */
  target: number;
  /** TSB que les charges du plan produisent à cette date. */
  projected: number;
  /** Projeté moins cible. Négatif : l'athlète prend le départ encore chargé. */
  gap: number;
  onTarget: boolean;
  /** Profondeur d'affûtage retenue, en multiple de sa forme nominale. */
  taperScale: number;
  /**
   * Ce qui a empêché d'atteindre la cible, en clair. `null` quand elle est
   * atteinte — une cible manquée sans explication est une cible manquée en
   * silence, c'est-à-dire le défaut lui-même.
   */
  shortfall: string | null;
}

/**
 * Ratios de charge aiguë / chronique que le plan produit, contre le seuil de
 * pic de chaque filière.
 *
 * Le planificateur projetait le TSB et rien d'autre : un plan pouvait porter la
 * filière mécanique à 1,87 la veille d'un palier de trois tours sans qu'aucune
 * ligne ne le dise avant le soir où la charge serait réalisée. Comme le TSB, la
 * mesure s'arrête à la veille de course. Elle ne corrige rien : un dépassement
 * se montre, les règles de `adapt.ts` décident.
 */
export interface LoadRatioCheck {
  from: string;
  to: string;
  limits: { metabolic: number; mechanical: number };
  exceedances: LoadRatioExceedance[];
  /** Jours de charge connus avant le plan. Zéro : les ratios partent de rien et ne mesurent pas grand-chose. */
  historyDays: number;
}

/**
 * Ce que le plan fait du temps que l'athlète a déclaré pouvoir donner.
 *
 * Le plafond hebdomadaire était traité dans les deux sens : converti en charge,
 * il laissait prescrire onze heures et demie là où neuf étaient permises, et il
 * en laissait quatre inutilisées ailleurs. Il est maintenant une contrainte dure,
 * vérifiée sur ce que les semaines écrivent. La place qu'elles n'utilisent pas
 * n'est pas une faute en soi — mais quand la durabilité est le facteur limitant
 * **mesuré** de l'athlète, elle se paie : le volume est le seul levier qui la
 * construit, et du temps disponible non prescrit est du gain laissé de côté.
 *
 * Les semaines de décharge et d'affûtage en sont exclues : elles laissent du mou
 * par construction, et le leur reprocher noierait le signal.
 */
export interface WeeklyVolumeCheck {
  /** Plafond horaire déclaré, en secondes de semaine. */
  ceilingS: number;
  /** Le plus haut volume d'entraînement qu'une semaine de construction écrit. */
  peakS: number;
  /** Semaines de construction laissant plus de deux heures sous le plafond. */
  underused: { weekStart: string; writtenS: number; unusedS: number }[];
  /** La durabilité est-elle un facteur limitant mesuré, et non un repli de population ? */
  durabilityLimiting: boolean;
  /** Ce qu'il faut en dire. `null` quand il n'y a rien à dire. */
  statement: string | null;
}

/** Au-delà, la place laissée sous le plafond n'est plus un arrondi de planning. */
const VOLUME_SLACK_S = 2 * 3600;

/**
 * La durabilité est-elle le facteur limitant **mesuré** de cet athlète ?
 *
 * Deux conditions, et la première n'est pas négociable : le chiffre vient du
 * terrain, pas du repli de population. Une durabilité par défaut jugée faible
 * ne dit rien de l'athlète — elle dit qu'on ne l'a pas encore mesurée, et bâtir
 * une recommandation de volume dessus propagerait une erreur silencieuse.
 */
function durabilityIsLimiting(model: PhysiologyModel): boolean {
  if ((model.provenance.durabilityPctPerHour ?? 'default') === 'default') return false;
  const { tier } = interpretDurability(model.durabilityPctPerHour);
  return tier === 'moyen' || tier === 'fragile';
}

function checkWeeklyVolume(
  weeks: readonly TrainingWeek[],
  model: PhysiologyModel,
  constraints: AthleteConstraints,
  from: string,
): WeeklyVolumeCheck {
  const ceilingS = Math.round(constraints.maxWeeklyHours * 3600);
  const building = weeks.filter((w) => w.weekStart >= from && w.phase !== 'taper' && !w.isDeload);
  const measured = building.map((w) => ({
    weekStart: w.weekStart,
    writtenS: writtenDurationS(w.sessions),
    unusedS: ceilingS - writtenDurationS(w.sessions),
  }));
  const underused = measured.filter((m) => m.unusedS > VOLUME_SLACK_S);
  const durabilityLimiting = durabilityIsLimiting(model);

  const statement =
    underused.length === 0 || !durabilityLimiting
      ? null
      : `${underused.length} semaine${underused.length > 1 ? 's' : ''} de construction sur ` +
        `${building.length} laisse${underused.length > 1 ? 'nt' : ''} plus de deux heures sous le ` +
        `plafond de ${formatHours(ceilingS)} — ` +
        `${underused
          .slice(0, 4)
          .map((m) => `${m.weekStart} : ${formatHours(m.writtenS)}`)
          .join(', ')}${underused.length > 4 ? ', …' : ''}. ` +
        `La durabilité est le facteur limitant mesuré de cet athlète ` +
        `(−${model.durabilityPctPerHour.toFixed(1)} %/h, relevée sur le terrain), et le volume est le ` +
        `seul levier qui la construit : ce temps déclaré et non prescrit est du gain laissé de côté.`;

  return {
    ceilingS,
    peakS: measured.reduce((a, m) => Math.max(a, m.writtenS), 0),
    underused,
    durabilityLimiting,
    statement,
  };
}

const CHANNEL_FR = { metabolic: 'métabolique', mechanical: 'mécanique' } as const;

/** Dépassements de ratio en une phrase, filière par filière. */
export function describeRatioExceedances(list: readonly LoadRatioExceedance[]): string {
  return (['mechanical', 'metabolic'] as const)
    .map((channel) => {
      const days = list.filter((e) => e.channel === channel);
      if (days.length === 0) return null;
      return (
        `${CHANNEL_FR[channel]} ${days.map((e) => `${e.value.toFixed(2)} le ${e.date}`).join(', ')} ` +
        `(seuil ${days[0]!.limit})`
      );
    })
    .filter(Boolean)
    .join(' ; ');
}

/**
 * Tolérance sur la cible de TSB.
 *
 * Un demi-point de TSB ne correspond à aucune différence lisible sur le
 * terrain : viser plus fin donnerait une précision inventée.
 */
const TSB_TOLERANCE = 0.5;

/**
 * Charge chronique de départ présumée quand l'historique est vide ou trop mince.
 *
 * Une CTL à 0 ne signifie pas « athlète détraîné » : elle signifie le plus
 * souvent « Strava pas encore synchronisé ». Bâtir un plan là-dessus produit des
 * sorties longues de 45 minutes pour quelqu'un qui court 2 heures — une erreur
 * qui décrédibilise tout le reste. On repart donc du volume que l'athlète
 * déclare pouvoir tenir, en supposant qu'il en réalise environ 70 %, et on
 * marque l'hypothèse dans le journal du plan pour qu'elle soit corrigée dès la
 * première synchronisation.
 */
export function assumedCtl(constraints: AthleteConstraints): number {
  const realizedHours = constraints.maxWeeklyHours * 0.7;
  // ~50 points de charge par heure d'entraînement à dominante endurance.
  return Math.round((realizedHours * 50) / 7);
}

/** Une tentative de plan et ce qu'elle produit à la veille de la course. */
interface PlanAttempt {
  weeks: TrainingWeek[];
  taperScale: number;
  projectedTsb: number;
}

/** Construit les semaines pour une profondeur d'affûtage donnée. */
function buildWeeks(input: BuildPlanInput, startDate: string, ctl: number, taperScale: number): TrainingWeek[] {
  const specs = buildPeriodization({
    startDate,
    race: input.race,
    estimatedRaceDurationS: input.estimatedRaceDurationS,
    currentCtl: ctl,
    constraints: input.constraints,
    raceElevationGainM: input.race.course.elevationGainM,
    taperScale,
  });

  // L'alternance court / moyen porte sur les fractionnés effectivement
  // prescrits, pas sur les semaines : une semaine sans fractionné — la phase
  // spécifique donne la priorité à l'allure de course — ne fait pas sauter un
  // tour à l'alternance.
  const policy = indexDirectives(input.directives).intervals;
  let intervals = 0;
  return specs.map((spec) => {
    const week = buildWeek({
      spec,
      model: input.model,
      constraints: input.constraints,
      athleteId: input.athleteId,
      race: input.race,
      racePaceMs: input.racePaceMs,
      directives: input.directives,
      ambition: input.ambition,
      intervalFormat: nextIntervalFormat(policy, intervals),
    });
    if (week.sessions.some((s) => isIntervalSession(s.type))) intervals++;
    return week;
  });
}

/**
 * Résout la profondeur d'affûtage qui amène le TSB de la veille sur sa cible.
 *
 * Alléger l'affûtage monte la fraîcheur, l'alourdir la fait baisser : la
 * fonction est monotone, une dichotomie suffit. Quand la cible reste hors
 * d'atteinte à l'une des deux bornes, on rend la tentative la plus proche —
 * c'est elle qui portera l'explication de l'écart, plutôt que de laisser croire
 * à une cible tenue.
 */
function solveTaperScale(attempt: (k: number) => PlanAttempt, target: number): PlanAttempt {
  const distance = (a: PlanAttempt) => Math.abs(a.projectedTsb - target);

  // Affûtage le plus profond permis : c'est lui qui donne le TSB le plus haut.
  let lo = attempt(TAPER_SCALE_BOUNDS.min);
  if (lo.projectedTsb <= target + TSB_TOLERANCE) return lo;
  // Affûtage le plus léger permis : le TSB le plus bas.
  let hi = attempt(TAPER_SCALE_BOUNDS.max);
  if (hi.projectedTsb >= target - TSB_TOLERANCE) return hi;

  let best = distance(lo) <= distance(hi) ? lo : hi;
  for (let i = 0; i < 12 && distance(best) > TSB_TOLERANCE; i++) {
    const mid = attempt((lo.taperScale + hi.taperScale) / 2);
    if (distance(mid) < distance(best)) best = mid;
    if (mid.projectedTsb > target) lo = mid;
    else hi = mid;
  }
  return best;
}

/**
 * Explique un écart à la cible de TSB, quand il en reste un.
 *
 * Les deux directions ne se corrigent pas de la même façon : trop chargé, il
 * manque du temps ou l'affûtage bute sur son plancher ; trop frais, c'est la
 * charge disponible qui n'a pas suffi à construire la forme que la cible
 * suppose.
 */
function tsbShortfall(
  gap: number,
  target: number,
  taperScale: number,
  weeks: number,
  taper: number,
  startCtl: number,
  maxWeeklyHours: number,
): string {
  const atFloor = taperScale <= TAPER_SCALE_BOUNDS.min + 1e-6;
  const atCeiling = taperScale >= TAPER_SCALE_BOUNDS.max - 1e-6;
  const depth = `L'affûtage est à ${Math.round(taperScale * 100)} % de sa profondeur nominale`;
  const frame =
    `${weeks} semaine${weeks > 1 ? 's' : ''} dont ${taper} d'affûtage, ` +
    `charge chronique de départ ${Math.round(startCtl)}`;

  if (gap < 0) {
    return (
      `Cible manquée par le bas : l'athlète prendrait le départ encore chargé. ` +
      (atFloor
        ? `${depth}, son plancher — en dessous, la charge chronique se perdrait plus vite que la ` +
          `fatigue ne s'évacue, et la fraîcheur gagnée coûterait la forme. `
        : `${depth}. `) +
      `${frame} : il n'y a pas la place d'aller chercher les ${Math.abs(gap).toFixed(1)} points qui manquent.`
    );
  }
  return (
    `Cible dépassée par le haut : l'athlète prendrait le départ plus frais que visé, donc moins entraîné. ` +
    (atCeiling
      ? `${depth}, son plafond — au-delà, la fin de préparation ne serait plus un affûtage. `
      : `${depth}. `) +
    `${frame}, plafond de ${maxWeeklyHours} h par semaine : la charge disponible ne construit pas ` +
    `la forme qu'un TSB de ${signed(target)} suppose.`
  );
}

const signed = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;

export function buildTrainingPlan(input: BuildPlanInput): {
  plan: TrainingPlan;
  weeks: TrainingWeek[];
  tsbCheck: RaceDayTsbCheck;
  ratioCheck: LoadRatioCheck;
  /** Ce que le plan fait du temps déclaré — plafond tenu, place laissée. */
  volumeCheck: WeeklyVolumeCheck;
  /** Ce que la reconstruction reprend, remplace, ajoute et retire. */
  carryOver: PlanCarryOver;
} {
  const startDate = input.startDate ?? new Date().toISOString().slice(0, 10);

  const estimated = assumedCtl(input.constraints);
  const ctlIsAssumed = input.currentCtl < estimated * 0.45;
  const effectiveCtl = ctlIsAssumed ? estimated : input.currentCtl;
  // Une charge chronique supposée ne peut pas s'accompagner d'une charge aiguë
  // mesurée : la paire n'aurait plus de sens, et le TSB de départ non plus.
  const seed = {
    ctl: effectiveCtl,
    atl: ctlIsAssumed ? effectiveCtl : input.currentAtl ?? effectiveCtl,
  };

  // ── Cible de TSB, et mesure de ce que le plan en fait ──────────────────────
  const tsb = targetRaceDayTsb(input.estimatedRaceDurationS);
  const raceDate = input.race.date.slice(0, 10);
  const eve = addDays(raceDate, -1);
  const planStart = mondayOf(startDate);

  const attempt = (taperScale: number): PlanAttempt => {
    const built = buildWeeks(input, startDate, effectiveCtl, taperScale);
    const loads = built.flatMap((w) => w.sessions.map((s) => ({ date: s.date, load: s.plannedLoad })));
    const points = projectFrom(seed, loads, planStart, eve);
    return {
      weeks: built,
      taperScale,
      projectedTsb: points[points.length - 1]?.tsb ?? Math.round((seed.ctl - seed.atl) * 10) / 10,
    };
  };

  const solved = solveTaperScale(attempt, tsb.metabolic);
  const fresh = solved.weeks;
  const taperCount = fresh.filter((w) => w.phase === 'taper').length;

  // La course elle-même remplace la séance du jour.
  const raceWeek = fresh.find((w) => w.sessions.some((s) => s.date === raceDate));
  if (raceWeek) {
    raceWeek.sessions = raceWeek.sessions.filter((s) => s.date !== raceDate);
    raceWeek.sessions.push({
      id: uid(),
      athleteId: input.athleteId,
      date: raceDate,
      type: 'race',
      title: `🏁 ${input.race.name}`,
      intent: `Objectif ${input.race.priority}. ${Math.round(input.race.course.distanceM / 100) / 10} km, ${input.race.course.elevationGainM} m D+.`,
      blocks: [],
      plannedLoad: Math.round((input.estimatedRaceDurationS / 3600) * 85),
      plannedMechanicalLoad: Math.round(
        prescribedMechanicalLoad({ elevationLossM: input.race.course.elevationLossM }).total,
      ),
      plannedDurationS: input.estimatedRaceDurationS,
      plannedDistanceM: input.race.course.distanceM,
      // Le seul dénivelé du plan qui ne se relit pas sur des blocs : une course
      // ne se prescrit pas en blocs, elle se subit telle que le parcours est
      // tracé. Il porte donc sa provenance, faute de quoi il serait le dernier
      // chiffre du plan qu'aucun contenu ne peut refaire — et rien ne le dirait.
      plannedElevationGainM: input.race.course.elevationGainM,
      priority: 'key',
      status: 'planned',
      rationale:
        `Jour J. Distance et dénivelé sont ceux du parcours (${input.race.course.elevationGainM} m D+), ` +
        `relevés sur la course et non prescrits : une course n'a pas de blocs à exécuter.`,
    });
    raceWeek.sessions.sort((a, b) => a.date.localeCompare(b.date));
  }

  // ── Ce qu'une reconstruction n'a pas le droit de réécrire ──────────────────
  // Le planificateur vient d'écrire le plan qu'il aurait écrit sur une page
  // blanche. Les décisions du plan en place reprennent maintenant leur place :
  // jours passés, séances réalisées ou remplacées, séances retirées par une
  // absence déclarée, séances ajustées à la main.
  const carryOver = carryDecisions(input.previous ?? [], fresh, input.today ?? planStart);
  const weeks = carryOver.weeks;

  // La durée d'une semaine se mesure sur ses séances : elle suit donc ce que la
  // course substituée et la reprise des décisions viennent d'y changer. Écrite
  // une fois pour toutes à la construction, elle annoncerait le volume d'un plan
  // qu'on n'enregistre pas.
  for (const w of weeks) w.plannedDurationS = writtenDurationS(w.sessions);

  // ── Ce que le plan écrit produit, mesuré sur le plan écrit ─────────────────
  // La profondeur d'affûtage s'est résolue sur ce que le planificateur peut
  // encore écrire — il ne rattrapera pas une cible en réécrivant une séance
  // décidée. La mesure, elle, porte sur le plan tel qu'il sera enregistré :
  // annoncer le TSB d'un plan qu'on n'enregistre pas propagerait une erreur
  // silencieuse jusqu'au jour de la course.
  const written = weeks.flatMap((w) => w.sessions).filter((s) => s.date >= planStart);
  const points = projectFrom(seed, written.map((s) => ({ date: s.date, load: s.plannedLoad })), planStart, eve);
  const projected = points[points.length - 1]?.tsb ?? Math.round((seed.ctl - seed.atl) * 10) / 10;
  const gap = Math.round((projected - tsb.metabolic) * 10) / 10;
  const tsbCheck: RaceDayTsbCheck = {
    date: eve,
    target: tsb.metabolic,
    projected,
    gap,
    onTarget: Math.abs(gap) <= TSB_TOLERANCE,
    taperScale: Math.round(solved.taperScale * 100) / 100,
    shortfall:
      Math.abs(gap) <= TSB_TOLERANCE
        ? null
        : tsbShortfall(
            gap,
            tsb.metabolic,
            solved.taperScale,
            fresh.length,
            taperCount,
            effectiveCtl,
            input.constraints.maxWeeklyHours,
          ),
  };

  // ── Ratios de charge, sur ce que les séances produites pèsent ──────────────
  const history = (input.loadHistory ?? []).filter((l) => l.date < planStart);
  const firstKnown = history.reduce<string | null>((a, l) => (a == null || l.date < a ? l.date : a), null);
  const ratioCheck: LoadRatioCheck = {
    from: planStart,
    to: eve,
    limits: { ...ACWR_SPIKE },
    exceedances: ratioExceedances(
      projectLoadRatios(
        history,
        written.map((s) => ({ date: s.date, metabolic: s.plannedLoad, mechanical: s.plannedMechanicalLoad })),
        planStart,
        eve,
      ),
    ),
    historyDays: firstKnown
      ? Math.round((Date.parse(`${planStart}T00:00:00Z`) - Date.parse(`${firstKnown}T00:00:00Z`)) / 86_400_000)
      : 0,
  };

  // ── Ce que le plan fait du temps déclaré ───────────────────────────────────
  const volumeCheck = checkWeeklyVolume(weeks, input.model, input.constraints, planStart);

  const now = new Date().toISOString();

  return {
    plan: {
      id: `plan_${Math.random().toString(36).slice(2, 9)}`,
      athleteId: input.athleteId,
      createdAt: now,
      updatedAt: now,
      goalRaceId: input.race.id,
      weeks,
      targetRaceDayTsb: tsb.metabolic,
      projectedRaceDayTsb: tsbCheck.projected,
      raceDayTsbShortfall: tsbCheck.shortfall ?? undefined,
      revisionLog: [
        {
          at: now,
          trigger: 'initial',
          summary:
            `Plan construit sur ${fresh.length} semaines jusqu'à « ${input.race.name} » (${input.race.date.slice(0, 10)}). ` +
            `Départ de CTL ${Math.round(effectiveCtl)}. Cible de TSB à la veille de course (${eve}) : ` +
            `${signed(tsb.metabolic)} ; les charges du plan y amènent ${signed(tsbCheck.projected)} ` +
            `(écart ${signed(gap)}, affûtage à ${Math.round(solved.taperScale * 100)} % de sa profondeur nominale).` +
            (tsbCheck.shortfall ? ` ⚠ ${tsbCheck.shortfall}` : '') +
            (ratioCheck.exceedances.length
              ? ` ⚠ Ratio charge aiguë/chronique projeté au-delà de son seuil — ` +
                `${describeRatioExceedances(ratioCheck.exceedances)}.`
              : '') +
            (volumeCheck.statement ? ` ⚠ ${volumeCheck.statement}` : '') +
            (input.directives?.length
              ? ` ${input.directives.length} directives du dossier honorées (durées du travail foncier, ` +
                `critère de dérive cardiaque, fréquences hebdomadaires, cadence, un fractionné par semaine).`
              : ' Aucune directive au dossier : le plan ne repose que sur les paramètres physiologiques.') +
            (input.ambition
              ? ` Ambition portée au modèle : ${input.ambition.format.replace('_', ' ')}, depuis le ${input.ambition.since}.`
              : '') +
            (ctlIsAssumed
              ? ` ⚠ Historique d'entraînement insuffisant : la charge de départ est estimée depuis ` +
                `les ${input.constraints.maxWeeklyHours} h/semaine déclarées, et non mesurée. ` +
                `Synchronise Strava puis reconstruis le plan pour qu'il parte de ta charge réelle.`
              : ''),
          changes: [],
        },
      ],
    },
    weeks,
    tsbCheck,
    ratioCheck,
    volumeCheck,
    carryOver,
  };
}

/** Résumé lisible d'une semaine — utilisé dans le chat et l'export. */
export function summarizeWeek(week: TrainingWeek): string {
  const hours = Math.round((week.plannedDurationS / 3600) * 10) / 10;
  const header =
    `**Semaine du ${week.weekStart}** — ${week.phase}${week.isDeload ? ' (décharge)' : ''} · ` +
    `charge ${week.targetLoad} · ${hours} h · ${week.targetElevationGainM} m D+`;
  const lines = week.sessions
    .filter((s) => s.type !== 'rest')
    .map((s) => `  ${s.date.slice(8, 10)}/${s.date.slice(5, 7)} — ${s.title} (${s.plannedLoad} pts)`);
  return [header, week.focus, ...lines].join('\n');
}
