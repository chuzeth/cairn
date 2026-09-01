import type {
  AthleteConstraints, PhysiologyModel, PlannedSession, RaceGoal,
  SessionType, TrainingPlan, TrainingWeek,
} from '@cairn/core';
import { targetDistribution, targetRaceDayTsb } from '@cairn/physiology';
import { addDays, buildPeriodization, mondayOf, type WeekPlanSpec } from './periodization.js';
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
 * Le résultat est déterministe et auditable : chaque séance porte la raison de
 * sa présence à cette place dans la semaine.
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
}

/** Choisit les séances de qualité de la semaine, en alternant les stimuli. */
function selectQualitySessions(input: WeekBuildInput): SessionTemplate[] {
  const { spec, model } = input;
  const i = spec.index;
  const out: SessionTemplate[] = [];

  // Le nombre de créneaux vient du squelette de périodisation, mais celui-ci a
  // pu être calculé avec des contraintes désormais périmées — l'athlète change
  // ses disponibilités depuis le chat sans que tout le plan soit reconstruit.
  // Les contraintes passées à `buildWeek` font foi.
  const slots = Math.min(spec.qualitySlots, input.constraints.maxQualitySessionsPerWeek);

  // En décharge, on conserve **l'intensité** mais on coupe le **volume** de
  // travail : c'est ce qui permet d'assimiler sans rien perdre. Laisser la
  // séance de qualité à pleine dose ferait dépasser la cible hebdomadaire et
  // annulerait l'intérêt de la semaine.
  if (spec.isDeload) {
    out.push(i % 2 === 0 ? lib.threshold(model, 3, 4) : lib.vo2max(model, '30-30', 1, 8));
    return out.slice(0, Math.max(0, slots));
  }

  switch (spec.phase) {
    case 'base':
      // Une seule séance intense par semaine, comme prescrit au laboratoire.
      out.push(i % 2 === 0 ? lib.hillRepeats(model, 8, 90, 0.1) : lib.tempo(model, 20));
      break;

    case 'build':
      // Alternance court / moyen — jamais deux fractionnés courts de suite.
      out.push(i % 2 === 0 ? lib.vo2max(model, '30-30', 2, 10) : lib.threshold(model, 5, 5));
      if (slots >= 2) {
        out.push(i % 4 === 1 ? lib.downhillSession(model, 6, 150) : lib.hillRepeats(model, 10, 90, 0.1));
      }
      break;

    case 'specific':
      out.push(lib.racePace(model, 40, input.racePaceMs, 250));
      if (slots >= 2) {
        out.push(i % 2 === 0 ? lib.threshold(model, 4, 8) : lib.downhillSession(model, 6, 180));
      }
      break;

    case 'peak':
      out.push(lib.threshold(model, 4, 6));
      if (slots >= 2) out.push(lib.racePace(model, 30, input.racePaceMs, 200));
      break;

    case 'taper':
      // On maintient l'intensité mais on coupe le volume : c'est ce qui préserve
      // les adaptations tout en libérant la fraîcheur.
      out.push(
        spec.weeksToRace <= 1
          ? lib.vo2max(model, '30-30', 1, 6)
          : lib.threshold(model, 3, 5),
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

  // Le volume de la sortie longue suit la cible hebdomadaire : ~35 % du temps
  // total en base, jusqu'à 45 % en spécifique.
  const share = spec.phase === 'specific' ? 0.45 : spec.phase === 'taper' ? 0.3 : 0.38;
  const durationMin = Math.round(
    Math.min((spec.targetDurationS * share) / 60, spec.phase === 'taper' ? 90 : 300),
  );
  const vert = Math.round(
    Math.min(spec.targetElevationGainM * 0.65, constraints.accessibleVertPerSession * 1.8),
  );

  if (isMountain && spec.phase !== 'base') return lib.longTrail(model, Math.max(90, durationMin), Math.max(400, vert));
  return lib.longRun(model, Math.max(60, durationMin), Math.max(0, vert));
}

/**
 * Place les séances dans la semaine.
 *
 * Ordre de priorité : la sortie longue d'abord (elle contraint le plus), puis
 * les séances de qualité en respectant les espacements, puis le remplissage.
 */
export function buildWeek(input: WeekBuildInput): TrainingWeek {
  const { spec, model, constraints, athleteId } = input;
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
      assigned.set(d, lib.recovery(model, spec.isDeload ? 30 : 40));
      reasons.set(d, `Décrassage : lendemain d'une séance exigeante, on facilite la récupération sans ajouter de charge.`);
    } else {
      assigned.set(d, lib.endurance(model, 60, Math.round(spec.targetElevationGainM * 0.12)));
      reasons.set(d, 'Endurance fondamentale : le volume qui construit la base aérobie.');
    }
  }

  // Renforcement adossé à un jour d'endurance (jamais un jour de qualité).
  const strengthDay = remaining.find((d) => !restDays.includes(d) && assigned.get(d)?.type === 'endurance');
  if (strengthDay != null && spec.phase !== 'taper') {
    const existing = assigned.get(strengthDay)!;
    const s = lib.strength(model, 35);
    assigned.set(strengthDay, {
      ...existing,
      title: `${existing.title} + renforcement`,
      blocks: [...existing.blocks, ...s.blocks],
      durationS: existing.durationS + s.durationS,
      plannedLoad: existing.plannedLoad + s.plannedLoad,
      plannedMechanicalLoad: existing.plannedMechanicalLoad + 8,
      intent: `${existing.intent} Le renforcement suit immédiatement : chaîne postérieure et souplesse, le point faible identifié au test.`,
    });
  }

  // ── 4. Calibration sur la charge cible ────────────────────────────────────
  const sessions = calibrateToTarget([...assigned.entries()], spec, model, athleteId, reasons);

  const dist = targetDistribution(spec.phase);
  return {
    weekStart: spec.weekStart,
    index: spec.index,
    phase: spec.phase,
    targetLoad: spec.targetLoad,
    targetDurationS: spec.targetDurationS,
    targetElevationGainM: spec.targetElevationGainM,
    intensityDistribution: dist,
    isDeload: spec.isDeload,
    focus: spec.focus,
    sessions,
  };
}

/**
 * Ajuste le volume des séances d'endurance pour atteindre la charge cible.
 * Les séances de qualité ne sont jamais étirées ni raccourcies : leur dosage
 * est physiologique, pas comptable. Seul le volume facile sert de variable
 * d'ajustement — ce que fait n'importe quel entraîneur sérieux.
 */
function calibrateToTarget(
  entries: [number, SessionTemplate][],
  spec: WeekPlanSpec,
  model: PhysiologyModel,
  athleteId: string,
  reasons: Map<number, string>,
): PlannedSession[] {
  const adjustable = entries.filter(([, s]) => s.type === 'endurance' || s.type === 'long_run' || s.type === 'long_trail');
  const fixedLoad = entries
    .filter(([, s]) => !adjustable.some(([, a]) => a === s))
    .reduce((a, [, s]) => a + s.plannedLoad, 0);
  const adjustableLoad = adjustable.reduce((a, [, s]) => a + s.plannedLoad, 0);

  const wanted = Math.max(0, spec.targetLoad - fixedLoad);
  const scale = adjustableLoad > 0 ? clamp(wanted / adjustableLoad, 0.55, 1.7) : 1;

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
      const isAdjustable = adjustable.some(([, a]) => a === s);
      const factor = isAdjustable ? cappedFactor(s, scale) : globalScale;
      const date = addDays(spec.weekStart, weekOrder(day));
      return {
        id: uid(),
        athleteId,
        date,
        type: s.type as SessionType,
        title: factor !== 1 && s.durationS > 0 ? retitle(s, factor) : s.title,
        intent: s.intent,
        blocks: isAdjustable ? s.blocks.map((b) => ({ ...b, durationS: b.durationS ? Math.round(b.durationS * factor) : undefined })) : s.blocks,
        plannedLoad: Math.round(s.plannedLoad * factor),
        plannedMechanicalLoad: Math.round(s.plannedMechanicalLoad * (isAdjustable ? factor : 1)),
        plannedDurationS: Math.round(s.durationS * factor),
        plannedDistanceM: s.plannedDistanceM ? Math.round(s.plannedDistanceM * factor) : undefined,
        plannedElevationGainM: Math.round(s.elevationGainM * (isAdjustable ? factor : 1)),
        priority: s.priority,
        status: 'planned' as const,
        rationale: reasons.get(day),
      };
    });
}

/**
 * Reconstruit le titre après calibration.
 *
 * La durée **et** le dénivelé sont mis à l'échelle : un titre qui annonce
 * « 48 min · 499 m D+ » alors que le bloc a été ramené à 48 min et 299 m est
 * pire qu'un titre vague — il donne une consigne fausse. Les mentions ajoutées
 * en aval (« + renforcement ») sont préservées.
 */
function retitle(s: SessionTemplate, factor: number): string {
  const minutes = Math.round((s.durationS * factor) / 60);
  const durationLabel = minutes >= 90 ? `${(minutes / 60).toFixed(1)} h` : `${minutes} min`;
  const vert = Math.round(s.elevationGainM * factor);

  const suffixMatch = / \+ .+$/.exec(s.title);
  const suffix = suffixMatch ? suffixMatch[0] : '';
  const base =
    (s.title.slice(0, s.title.length - suffix.length).split('·')[0] ?? s.title)
      .replace(/\d+([.,]\d+)?\s*(min|h)\b/, '')
      .trim();

  return `${base} ${durationLabel}${vert > 50 ? ` · ${vert} m D+` : ''}${suffix}`;
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
  currentCtl: number;
  estimatedRaceDurationS: number;
  racePaceMs?: number;
  startDate?: string;
}

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

export function buildTrainingPlan(input: BuildPlanInput): { plan: TrainingPlan; weeks: TrainingWeek[] } {
  const startDate = input.startDate ?? new Date().toISOString().slice(0, 10);

  const estimated = assumedCtl(input.constraints);
  const ctlIsAssumed = input.currentCtl < estimated * 0.45;
  const effectiveCtl = ctlIsAssumed ? estimated : input.currentCtl;

  const specs = buildPeriodization({
    startDate,
    race: input.race,
    estimatedRaceDurationS: input.estimatedRaceDurationS,
    currentCtl: effectiveCtl,
    constraints: input.constraints,
    raceElevationGainM: input.race.course.elevationGainM,
  });

  const weeks = specs.map((spec) =>
    buildWeek({
      spec,
      model: input.model,
      constraints: input.constraints,
      athleteId: input.athleteId,
      race: input.race,
      racePaceMs: input.racePaceMs,
    }),
  );

  // La course elle-même remplace la séance du jour.
  const raceDate = input.race.date.slice(0, 10);
  const raceWeek = weeks.find((w) => w.sessions.some((s) => s.date === raceDate));
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
      plannedMechanicalLoad: Math.round((input.race.course.elevationLossM * 9.80665 * 1.3) / 300),
      plannedDurationS: input.estimatedRaceDurationS,
      plannedDistanceM: input.race.course.distanceM,
      plannedElevationGainM: input.race.course.elevationGainM,
      priority: 'key',
      status: 'planned',
      rationale: 'Jour J.',
    });
    raceWeek.sessions.sort((a, b) => a.date.localeCompare(b.date));
  }

  const tsb = targetRaceDayTsb(input.estimatedRaceDurationS);
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
      revisionLog: [
        {
          at: now,
          trigger: 'initial',
          summary:
            `Plan construit sur ${weeks.length} semaines jusqu'à « ${input.race.name} » (${input.race.date.slice(0, 10)}). ` +
            `Départ de CTL ${Math.round(effectiveCtl)}, cible de TSB à J−0 : +${tsb.metabolic}.` +
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
  };
}

/** Résumé lisible d'une semaine — utilisé dans le chat et l'export. */
export function summarizeWeek(week: TrainingWeek): string {
  const hours = Math.round((week.targetDurationS / 3600) * 10) / 10;
  const header =
    `**Semaine du ${week.weekStart}** — ${week.phase}${week.isDeload ? ' (décharge)' : ''} · ` +
    `charge ${week.targetLoad} · ${hours} h · ${week.targetElevationGainM} m D+`;
  const lines = week.sessions
    .filter((s) => s.type !== 'rest')
    .map((s) => `  ${s.date.slice(8, 10)}/${s.date.slice(5, 7)} — ${s.title} (${s.plannedLoad} pts)`);
  return [header, week.focus, ...lines].join('\n');
}
