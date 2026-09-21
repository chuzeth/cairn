import { createHash } from 'node:crypto';
import {
  describeMovement, sessionDuration, type PlannedSession, type SessionBlock, type SessionType,
} from '@cairn/core';

/**
 * Une séance de Cairn telle qu'une montre Garmin l'exécute, et retour.
 *
 * Trois fonctions pures, et une propriété qui les tient ensemble : décoder ce
 * qu'on a encodé redonne la séance. `prescribe` écrit la séance dans les unités
 * que l'athlète lit — secondes, mètres, bpm entiers, allure à la seconde par
 * kilomètre —, `encodeWorkout` la traduit dans le format de Garmin Connect,
 * `decodeWorkout` relit ce que Garmin a enregistré dans les mêmes unités, et
 * `compareWorkouts` dit ce qui diffère. C'est dans ces unités qu'on compare :
 * deux vitesses qui donnent la même allure affichée sont la même consigne, une
 * seconde d'écart n'en est pas une.
 *
 * Sur une montre, une cible n'est pas une description : c'est une alarme, et
 * elle se décide sur ce qu'elle fait faire (`alarmRule`). Elle est cardiaque,
 * en plage personnalisée en bpm, jamais en zone Garmin : ses zones ne sont pas
 * celles de Cairn. Tout le reste de la prescription — la plage cardiaque
 * complète quand seul son plafond sonne, l'allure à plat, la vitesse
 * ascensionnelle, le dénivelé, la cadence, les mouvements de renforcement — est
 * écrit tel quel dans la note de l'étape. Rien n'est perdu en silence : ce qui
 * ne sonne pas se lit.
 */

export type WatchStepType = 'warmup' | 'interval' | 'recovery' | 'rest' | 'cooldown' | 'other';

export type WatchEnd =
  | { type: 'time'; seconds: number }
  | { type: 'distance'; meters: number }
  | { type: 'lap' }
  /** Lu sur Garmin, jamais écrit : une fin que Cairn ne prescrit pas. */
  | { type: 'unknown'; key: string; value: number | null };

export type WatchTarget =
  | { type: 'none' }
  /** bpm entiers. `low` à 0 : un plafond seul, « sous 141 ». */
  | { type: 'hr'; low: number; high: number }
  /** Secondes par kilomètre, entières : `slow` > `fast`. */
  | { type: 'pace'; slow: number; fast: number }
  /** Une zone Garmin : lue, jamais écrite — ce ne sont pas les zones de Cairn. */
  | { type: 'zone'; metric: string; zone: number }
  | { type: 'unknown'; key: string; low: number | null; high: number | null };

export interface WatchStep {
  kind: 'step';
  type: WatchStepType;
  end: WatchEnd;
  target: WatchTarget;
  note: string;
}

export interface WatchRepeat {
  kind: 'repeat';
  times: number;
  items: WatchItem[];
}

export type WatchItem = WatchStep | WatchRepeat;

export interface WatchWorkout {
  name: string;
  description: string;
  items: WatchItem[];
}

export type Prescription =
  /** `abridged` : ce que Garmin ne pouvait pas porter en entier, dit en clair. Vide le plus souvent. */
  | { sendable: true; workout: WatchWorkout; abridged: string[] }
  | { sendable: false; reason: string };

/** Le préfixe qui signe une séance écrite par Cairn, sur le calendrier comme sur la montre. */
export const WORKOUT_PREFIX = 'Cairn — ';

/**
 * Ce qu'une alarme cardiaque fait faire, et donc où elle a sa place.
 *
 * `range` — plancher et plafond : seulement sur le travail des séances de
 * qualité à plat (seuil, tempo, pyramide, allure spécifique), là où accélérer
 * quand la FC retombe est toujours juste. `ceiling` — plafond seul, de 0 à la
 * borne haute : échauffement, récupération, endurance, décrassage, retour au
 * calme, montées ; le risque y est d'aller trop fort, jamais trop doucement.
 * `none` — aucune alarme : effort maximal, descente, gammes et accélérations,
 * renforcement ; la FC n'y est pas la variable qu'on pilote, et la consigne
 * reste dans la note. Ailleurs, plafond seul : une alarme qui pousse à
 * accélérer ne se pose que là où c'est toujours juste.
 */
export type Alarm = 'range' | 'ceiling' | 'none';

export interface AlarmRule {
  alarm: Alarm;
  /** Ce qui a décidé, en un mot : « descente », « effort maximal »… */
  why: string;
}

/** Les séances de qualité dont le travail, à plat, porte plancher et plafond. */
const QUALITY: readonly SessionType[] = ['threshold', 'tempo', 'race_pace'];
/** Les séances dont tout le contenu se court sous un plafond. */
const EASY: Partial<Record<SessionType, string>> = {
  endurance: 'endurance', long_run: 'endurance', long_trail: 'endurance', recovery: 'décrassage',
};
/**
 * Gammes, accélérations, activation : le modèle de séance n'a pas de champ pour
 * les dire, seulement le nom du bloc — c'est donc lui qu'on lit, pour tous les
 * blocs et de la même façon.
 */
const UNPILOTED = /(?<!\p{L})(gammes|éducatifs|accélérations?|lignes droites|mises? en action|activation)(?!\p{L})/iu;

const STRICTNESS: Record<Alarm, number> = { none: 2, ceiling: 1, range: 0 };

/**
 * La règle d'alarme d'un segment : la plus restrictive de celles qui s'y
 * appliquent. Un effort maximal sur le plat, dans une séance de seuil, n'a
 * aucune alarme.
 */
export function alarmRule(type: SessionType, block: SessionBlock, part: 'work' | 'recovery'): AlarmRule {
  const seg = part === 'work' ? block : block.recovery;
  const gain = seg?.elevationGainM ?? 0;
  const loss = seg?.elevationLossM ?? 0;
  const rules: AlarmRule[] = [];
  if (block.circuit || block.kind) rules.push({ alarm: 'none', why: 'renforcement' });
  if (part === 'work' && block.zone === 'Z5') rules.push({ alarm: 'none', why: 'effort maximal' });
  if (loss > 0 && gain === 0) rules.push({ alarm: 'none', why: 'descente' });
  if (part === 'work' && UNPILOTED.test(block.label)) rules.push({ alarm: 'none', why: 'gammes ou accélérations' });
  // Entre deux répétitions, la FC part toujours d'en haut : un plafond sonnerait
  // au début de chaque récupération, et en côte pendant toute la remontée.
  if (part === 'recovery') rules.push({ alarm: 'none', why: 'récupération entre répétitions' });
  if (part === 'work' && roleOf(block.label) === 'warmup') rules.push({ alarm: 'ceiling', why: 'échauffement' });
  if (part === 'work' && roleOf(block.label) === 'cooldown') rules.push({ alarm: 'ceiling', why: 'retour au calme' });
  if (EASY[type]) rules.push({ alarm: 'ceiling', why: EASY[type]! });
  if (gain > 0) rules.push({ alarm: 'ceiling', why: loss > 0 ? 'terrain vallonné' : 'montée' });
  if (part === 'work' && QUALITY.includes(type) && gain === 0 && loss === 0) {
    rules.push({ alarm: 'range', why: 'qualité à plat' });
  }
  if (rules.length === 0) rules.push({ alarm: 'ceiling', why: 'plafond par défaut' });
  return rules.reduce((a, b) => (STRICTNESS[b.alarm] > STRICTNESS[a.alarm] ? b : a));
}

/** L'alarme qu'une règle pose sur une plage cardiaque prescrite. */
function targetFor(rule: AlarmRule, hr: [number, number] | undefined): WatchTarget {
  if (rule.alarm === 'none' || !hr || hr[1] <= 0) return { type: 'none' };
  const high = Math.round(hr[1]);
  return rule.alarm === 'range' ? { type: 'hr', low: Math.max(0, Math.round(hr[0])), high } : { type: 'hr', low: 0, high };
}

/**
 * Ce que la montre n'exécute pas, et qui reste dans Cairn.
 *
 * Une séance de renforcement lancée en course à pied enregistrerait une sortie
 * immobile de quarante minutes, et ses mouvements n'ont pas d'équivalent que la
 * montre sache compter : elle n'est pas envoyée, et elle le dit.
 */
const NOT_ON_WATCH: Partial<Record<SessionType, string>> = {
  strength: 'renforcement : la montre ne sait pas en exécuter les mouvements, la séance reste dans Cairn',
  mobility: 'mobilité : rien que la montre sache exécuter, la séance reste dans Cairn',
  cross_training: "hors course à pied : Cairn n'envoie que des séances de course",
  race: "jour de course : le plan d'allure reste dans Cairn",
  rest: 'jour de repos',
};

// ─────────────────────────────────────────────────────────────────────────────
// Séance → montre
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ce que Garmin garde d'un texte, mesuré le 21/09/2026 sur la séance de test :
 * 512 caractères par note d'étape, 1 024 pour la description. Au-delà, il coupe
 * et ajoute « ... » — en silence. Cairn coupe donc lui-même, à un blanc, et dit
 * où est la suite.
 */
export const NOTE_MAX = 512;
export const DESCRIPTION_MAX = 1024;
const NOTE_CONTINUED = ' … (suite dans la description)';
const DESCRIPTION_CUT = ' … (texte complet dans Cairn)';

export function prescribe(session: Pick<PlannedSession, 'type' | 'title' | 'intent' | 'blocks'>): Prescription {
  const refused = NOT_ON_WATCH[session.type];
  if (refused) return { sendable: false, reason: refused };
  if (session.blocks.length === 0) return { sendable: false, reason: 'séance sans contenu' };
  const { items, overflow } = fitNotes(session.blocks.flatMap((b) => itemsOf(b, session.type)));
  const abridged: string[] = [];
  let description = text([sentence(session.title), session.intent, ...overflow].filter(Boolean).join(' '));
  if (description.length > DESCRIPTION_MAX) {
    description = `${cut(description, DESCRIPTION_MAX - DESCRIPTION_CUT.length)[0]}${DESCRIPTION_CUT}`;
    abridged.push('description abrégée à la limite de Garmin, le texte complet est dans Cairn');
  }
  return { sendable: true, workout: { name: workoutName(session.title), description, items }, abridged };
}

/**
 * Une note plus longue que ce que Garmin garde se coupe à un blanc, et sa suite
 * part dans la description, étape nommée. La cible et les quantités viennent en
 * tête de note : ce qui se coupe, ce sont les conseils qui les suivent.
 */
function fitNotes(items: WatchItem[]): { items: WatchItem[]; overflow: string[] } {
  const overflow: string[] = [];
  const walk = (list: WatchItem[], prefix: string): WatchItem[] =>
    list.map((item, i) => {
      const at = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      if (item.kind === 'repeat') return { ...item, items: walk(item.items, at) };
      if (item.note.length <= NOTE_MAX) return item;
      const [head, rest] = cut(item.note, NOTE_MAX - NOTE_CONTINUED.length);
      overflow.push(`Étape ${at}, suite : ${rest}`);
      return { ...item, note: `${head}${NOTE_CONTINUED}` };
    });
  return { items: walk(items, ''), overflow };
}

/** Coupe à un blanc au plus tard à `max` caractères : la tête, puis le reste. */
function cut(s: string, max: number): [string, string] {
  const space = s.lastIndexOf(' ', max);
  const at = space > max / 2 ? space : max;
  return [s.slice(0, at).trimEnd(), s.slice(at).trim()];
}

/**
 * Le nom sur le calendrier et sur la montre : le titre avant son premier tiret,
 * qui ne fait que redire la durée et le dénivelé que la séance porte déjà. Le
 * titre entier ouvre la description.
 */
function workoutName(title: string): string {
  const head = text(title.split(' — ')[0] ?? title);
  return `${WORKOUT_PREFIX}${head || 'séance'}`;
}

function itemsOf(block: SessionBlock, type: SessionType): WatchItem[] {
  const times = Math.max(1, Math.round(block.repeat ?? 1));
  if (block.circuit) return circuitItems(block, times);
  const steps: WatchStep[] = [mainStep(block, type)];
  if (block.recovery) steps.push(recoveryStep(block, type));
  return times > 1 ? [{ kind: 'repeat', times, items: steps }] : steps;
}

/** Le segment d'un bloc ou de sa récupération, vu par ce qui décide de sa cible. */
interface Segment {
  hrRange?: [number, number];
  speedRangeMs?: [number, number];
  vamTargetMh?: number;
  elevationGainM?: number;
  elevationLossM?: number;
  cadenceTargetSpm?: number;
}

function mainStep(block: SessionBlock, type: SessionType): WatchStep {
  const end = endOf(block);
  // Un bloc annexe — souplesse, respiration — ne se court pas : il se chronomètre.
  if (block.kind) {
    return { kind: 'step', type: 'other', end, target: { type: 'none' }, note: note(block.label, [], block.notes) };
  }
  const target = targetFor(alarmRule(type, block, 'work'), block.hrRange);
  const extra = end.type === 'distance' && block.durationS ? [`environ ${sessionDuration(block.durationS)}`] : [];
  return {
    kind: 'step',
    type: roleOf(block.label),
    end,
    target,
    note: note(block.label, [...quantities(block, target), ...extra], block.notes),
  };
}

function recoveryStep(block: SessionBlock, type: SessionType): WatchStep {
  const r = block.recovery!;
  const target = targetFor(alarmRule(type, block, 'recovery'), r.hrRange);
  return {
    kind: 'step',
    type: r.active ? 'recovery' : 'rest',
    end: { type: 'time', seconds: Math.round(r.durationS) },
    target,
    note: note(`Récupération ${r.active ? 'active' : 'passive'}`, quantities(r, target)),
  };
}

/**
 * Un circuit sur la montre : une étape qui l'annonce, puis ses tours, un
 * mouvement par étape, chacun avec sa dose et son exécution. On passe au suivant
 * au bouton tour — un mouvement excentrique se compte en répétitions, pas en
 * secondes.
 */
function circuitItems(block: SessionBlock, times: number): WatchItem[] {
  const circuit = block.circuit!;
  const rounds = circuit.rounds * times;
  const n = circuit.exercises.length;
  const head =
    `${block.label}, ${rounds} tour${rounds > 1 ? 's' : ''} de ${n} exercice${n > 1 ? 's' : ''}` +
    (block.durationS ? `, environ ${sessionDuration(block.durationS * times)}` : '');
  const intro: WatchStep = {
    kind: 'step',
    type: 'other',
    end: { type: 'lap' },
    target: { type: 'none' },
    note: note(head, quantities(block, { type: 'none' }), block.notes),
  };
  const exercises: WatchStep[] = circuit.exercises.map((e) => ({
    kind: 'step',
    type: 'other',
    end: { type: 'lap' },
    target: { type: 'none' },
    note: text(`${describeMovement(e.movement, e.reps)}.`),
  }));
  return rounds > 1 ? [intro, { kind: 'repeat', times: rounds, items: exercises }] : [intro, ...exercises];
}

/** Une étape nommée « échauffement » en est un ; « retour au calme » aussi. Le reste se court. */
function roleOf(label: string): WatchStepType {
  if (/^\s*échauffement/iu.test(label)) return 'warmup';
  if (/^\s*retour au calme/iu.test(label)) return 'cooldown';
  return 'interval';
}

/** La distance prime quand elle est écrite : c'est ce que le modèle de séance déclare. */
function endOf(block: SessionBlock): WatchEnd {
  if (block.distanceM) return { type: 'distance', meters: Math.round(block.distanceM) };
  if (block.durationS) return { type: 'time', seconds: Math.round(block.durationS) };
  return { type: 'lap' };
}

/**
 * Ce que l'alarme ne porte pas, en toutes lettres et dans l'ordre où on le lit.
 * Une plage cardiaque dont seul le plafond sonne s'écrit entière dans la note :
 * son plancher reste une consigne, il n'est simplement plus une alarme.
 */
function quantities(seg: Segment, target: WatchTarget): string[] {
  const out: string[] = [];
  const hr = seg.hrRange;
  const sounded = target.type === 'hr' && hr && target.low === Math.max(0, Math.round(hr[0])) && target.high === Math.round(hr[1]);
  if (hr && !sounded) out.push(`FC ${hrText(hr[0], hr[1])}`);
  if (seg.speedRangeMs) {
    const [lo, hi] = seg.speedRangeMs;
    if (hi > 0) out.push(`allure à plat ${lo > 0 ? `${pace(paceSeconds(hi))}–${pace(paceSeconds(lo))}` : `plus lente que ${pace(paceSeconds(hi))}`}/km`);
  }
  if (seg.vamTargetMh) out.push(`${Math.round(seg.vamTargetMh)} m D+/h`);
  if (seg.elevationGainM) out.push(`${Math.round(seg.elevationGainM)} m D+`);
  if (seg.elevationLossM) out.push(`${Math.round(seg.elevationLossM)} m D−`);
  if (seg.cadenceTargetSpm) out.push(`cadence ${Math.round(seg.cadenceTargetSpm)} ppm`);
  return out;
}

function note(head: string, parts: string[], notes?: string): string {
  const first = parts.length > 0 ? `${text(head)} : ${parts.join(', ')}` : text(head);
  return text([sentence(first), notes ?? ''].join(' '));
}

// ─────────────────────────────────────────────────────────────────────────────
// Montre → Garmin Connect
// ─────────────────────────────────────────────────────────────────────────────

const STEP_TYPES = {
  warmup: { stepTypeId: 1, stepTypeKey: 'warmup', displayOrder: 1 },
  cooldown: { stepTypeId: 2, stepTypeKey: 'cooldown', displayOrder: 2 },
  interval: { stepTypeId: 3, stepTypeKey: 'interval', displayOrder: 3 },
  recovery: { stepTypeId: 4, stepTypeKey: 'recovery', displayOrder: 4 },
  rest: { stepTypeId: 5, stepTypeKey: 'rest', displayOrder: 5 },
  repeat: { stepTypeId: 6, stepTypeKey: 'repeat', displayOrder: 6 },
  other: { stepTypeId: 7, stepTypeKey: 'other', displayOrder: 7 },
} as const;

const CONDITIONS = {
  lap: { conditionTypeId: 1, conditionTypeKey: 'lap.button', displayOrder: 1, displayable: true },
  time: { conditionTypeId: 2, conditionTypeKey: 'time', displayOrder: 2, displayable: true },
  distance: { conditionTypeId: 3, conditionTypeKey: 'distance', displayOrder: 3, displayable: true },
  iterations: { conditionTypeId: 7, conditionTypeKey: 'iterations', displayOrder: 7, displayable: false },
} as const;

const TARGETS = {
  none: { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target', displayOrder: 1 },
  hr: { workoutTargetTypeId: 4, workoutTargetTypeKey: 'heart.rate.zone', displayOrder: 4 },
  pace: { workoutTargetTypeId: 6, workoutTargetTypeKey: 'pace.zone', displayOrder: 6 },
} as const;

const RUNNING = { sportTypeId: 1, sportTypeKey: 'running', displayOrder: 1 } as const;

/** Le corps qu'attend `POST /workout-service/workout`. */
export interface GarminWorkoutPayload {
  workoutName: string;
  description: string | null;
  sportType: typeof RUNNING;
  estimatedDurationInSecs: number;
  workoutSegments: { segmentOrder: number; sportType: typeof RUNNING; workoutSteps: Record<string, unknown>[] }[];
}

export function encodeWorkout(w: WatchWorkout): GarminWorkoutPayload {
  let order = 0;
  let group = 0;
  const encode = (items: WatchItem[], childStepId: number | null): Record<string, unknown>[] =>
    items.map((item) => {
      order += 1;
      if (item.kind === 'repeat') {
        group += 1;
        const id = group;
        const stepOrder = order;
        return {
          type: 'RepeatGroupDTO',
          stepOrder,
          stepType: STEP_TYPES.repeat,
          childStepId: id,
          numberOfIterations: item.times,
          smartRepeat: false,
          endCondition: CONDITIONS.iterations,
          endConditionValue: item.times,
          workoutSteps: encode(item.items, id),
        };
      }
      return {
        type: 'ExecutableStepDTO',
        stepOrder: order,
        stepType: STEP_TYPES[item.type],
        childStepId,
        description: item.note || null,
        ...encodeEnd(item.end),
        ...encodeTarget(item.target),
      };
    });
  return {
    workoutName: w.name,
    description: w.description || null,
    sportType: RUNNING,
    estimatedDurationInSecs: timedSeconds(w.items),
    workoutSegments: [{ segmentOrder: 1, sportType: RUNNING, workoutSteps: encode(w.items, null) }],
  };
}

function encodeEnd(end: WatchEnd): Record<string, unknown> {
  switch (end.type) {
    case 'time':
      return { endCondition: CONDITIONS.time, endConditionValue: end.seconds };
    case 'distance':
      return { endCondition: CONDITIONS.distance, endConditionValue: end.meters, preferredEndConditionUnit: { unitKey: 'kilometer' } };
    case 'lap':
      return { endCondition: CONDITIONS.lap, endConditionValue: null };
    default:
      throw new Error(`Fin d'étape « ${end.key} » : Cairn ne l'écrit pas.`);
  }
}

function encodeTarget(target: WatchTarget): Record<string, unknown> {
  switch (target.type) {
    case 'none':
      return { targetType: TARGETS.none };
    // Plage personnalisée : c'est `zoneNumber` à null qui le dit à Garmin.
    case 'hr':
      return { targetType: TARGETS.hr, targetValueOne: target.low, targetValueTwo: target.high, zoneNumber: null };
    // Garmin stocke une allure en vitesse, m/s, la plus lente d'abord.
    case 'pace':
      return {
        targetType: TARGETS.pace,
        targetValueOne: 1000 / target.slow,
        targetValueTwo: 1000 / target.fast,
        zoneNumber: null,
      };
    default:
      throw new Error(`Cible « ${target.type} » : Cairn ne l'écrit pas.`);
  }
}

/** Ce que durent les étapes chronométrées, répétitions comprises. */
function timedSeconds(items: WatchItem[]): number {
  return items.reduce(
    (a, it) => a + (it.kind === 'repeat' ? it.times * timedSeconds(it.items) : it.end.type === 'time' ? it.end.seconds : 0),
    0,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Garmin Connect → montre
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Relit une séance Garmin dans les unités de l'athlète.
 *
 * Tolérant par construction : ce que Cairn n'écrit pas — une zone Garmin, une
 * cible de puissance, une fin aux calories — se relit tel quel pour être nommé
 * par la comparaison, au lieu de faire échouer la lecture.
 */
export function decodeWorkout(raw: unknown): WatchWorkout {
  const w = (raw ?? {}) as Record<string, unknown>;
  const segments = Array.isArray(w.workoutSegments) ? (w.workoutSegments as Record<string, unknown>[]) : [];
  const steps = segments.flatMap((s) => (Array.isArray(s.workoutSteps) ? (s.workoutSteps as Record<string, unknown>[]) : []));
  return {
    name: text(typeof w.workoutName === 'string' ? w.workoutName : ''),
    description: text(typeof w.description === 'string' ? w.description : ''),
    items: decodeItems(steps),
  };
}

function decodeItems(steps: Record<string, unknown>[]): WatchItem[] {
  return [...steps]
    .sort((a, b) => Number(a.stepOrder ?? 0) - Number(b.stepOrder ?? 0))
    .map((s): WatchItem => {
      const key = keyOf(s.stepType, 'stepTypeKey');
      if (s.type === 'RepeatGroupDTO' || key === 'repeat') {
        const times = Number(s.numberOfIterations ?? s.endConditionValue ?? 0);
        return {
          kind: 'repeat',
          times: Math.round(times),
          items: decodeItems(Array.isArray(s.workoutSteps) ? (s.workoutSteps as Record<string, unknown>[]) : []),
        };
      }
      return {
        kind: 'step',
        type: key in STEP_TYPES && key !== 'repeat' ? (key as WatchStepType) : 'other',
        end: decodeEnd(s),
        target: decodeTarget(s),
        note: text(typeof s.description === 'string' ? s.description : ''),
      };
    });
}

function decodeEnd(s: Record<string, unknown>): WatchEnd {
  const key = keyOf(s.endCondition, 'conditionTypeKey');
  const value = typeof s.endConditionValue === 'number' ? s.endConditionValue : null;
  if (key === 'time' && value != null) return { type: 'time', seconds: Math.round(value) };
  if (key === 'distance' && value != null) return { type: 'distance', meters: Math.round(value) };
  if (key === 'lap.button') return { type: 'lap' };
  return { type: 'unknown', key: key || 'aucune', value };
}

function decodeTarget(s: Record<string, unknown>): WatchTarget {
  const key = keyOf(s.targetType, 'workoutTargetTypeKey');
  const one = typeof s.targetValueOne === 'number' ? s.targetValueOne : null;
  const two = typeof s.targetValueTwo === 'number' ? s.targetValueTwo : null;
  const zone = typeof s.zoneNumber === 'number' ? s.zoneNumber : null;
  if (!key || key === 'no.target') return { type: 'none' };
  if ((key === 'heart.rate.zone' || key === 'pace.zone') && zone != null) {
    return { type: 'zone', metric: key === 'heart.rate.zone' ? 'FC' : 'allure', zone };
  }
  if (key === 'heart.rate.zone' && one != null && two != null) {
    return { type: 'hr', low: Math.round(Math.min(one, two)), high: Math.round(Math.max(one, two)) };
  }
  if (key === 'pace.zone' && one != null && two != null && one > 0 && two > 0) {
    return { type: 'pace', slow: paceSeconds(Math.min(one, two)), fast: paceSeconds(Math.max(one, two)) };
  }
  return { type: 'unknown', key, low: one, high: two };
}

const keyOf = (v: unknown, field: string): string => {
  const k = v && typeof v === 'object' ? (v as Record<string, unknown>)[field] : undefined;
  return typeof k === 'string' ? k : '';
};

// ─────────────────────────────────────────────────────────────────────────────
// Comparaison
// ─────────────────────────────────────────────────────────────────────────────

export interface Discrepancy {
  /** « nom », « séance », « étape 3 », « étape 3.2 » (deuxième étape de la répétition 3). */
  at: string;
  field: 'nom' | 'description' | 'structure' | 'type' | 'fin' | 'alarme' | 'cible' | 'note' | 'répétitions';
  expected: string;
  actual: string;
  /** La phrase qu'on montre : ce que Garmin porte, au lieu de ce que Cairn prescrit. */
  text: string;
}

/** Compare la prescription à ce que Garmin a relu, étape par étape, dans les unités de l'athlète. */
export function compareWorkouts(expected: WatchWorkout, actual: WatchWorkout): Discrepancy[] {
  const out: Discrepancy[] = [];
  if (expected.name !== actual.name) out.push(differ('nom', 'nom', quote(expected.name), quote(actual.name)));
  if (expected.description !== actual.description) {
    out.push(differ('description', 'description', '', textChange(expected.description, actual.description)));
  }
  compareItems(expected.items, actual.items, '', out);
  return out;
}

function compareItems(expected: WatchItem[], actual: WatchItem[], prefix: string, out: Discrepancy[]): void {
  if (expected.length !== actual.length) {
    out.push(differ(prefix ? `étape ${prefix}` : 'séance', 'structure', steps(expected.length), steps(actual.length)));
  }
  for (let i = 0; i < Math.min(expected.length, actual.length); i++) {
    const at = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
    const e = expected[i]!;
    const a = actual[i]!;
    if (e.kind === 'repeat' || a.kind === 'repeat') {
      if (e.kind !== 'repeat' || a.kind !== 'repeat') {
        out.push(differ(`étape ${at}`, 'structure', itemKind(e), itemKind(a)));
        continue;
      }
      if (e.times !== a.times) out.push(differ(`étape ${at}`, 'répétitions', `${e.times} fois`, `${a.times} fois`));
      compareItems(e.items, a.items, at, out);
      continue;
    }
    if (e.type !== a.type) out.push(differ(`étape ${at}`, 'type', STEP_LABEL[e.type], STEP_LABEL[a.type]));
    if (endText(e.end) !== endText(a.end)) out.push(differ(`étape ${at}`, 'fin', endText(e.end), endText(a.end)));
    // La règle d'alarme se vérifie avant la valeur : un plancher apparu là où
    // Cairn ne pose qu'un plafond change ce que la montre fait faire, quel que
    // soit le chiffre.
    const change = alarmChange(e.target, a.target);
    if (change) out.push(differ(`étape ${at}`, 'alarme', targetText(e.target), change));
    else if (targetText(e.target) !== targetText(a.target)) {
      out.push(differ(`étape ${at}`, 'cible', targetText(e.target), targetText(a.target)));
    }
    if (e.note !== a.note) out.push(differ(`étape ${at}`, 'note', '', textChange(e.note, a.note)));
  }
}

function differ(at: string, field: Discrepancy['field'], expected: string, actual: string): Discrepancy {
  const where = `${at[0]!.toUpperCase()}${at.slice(1)}`;
  const phrase =
    field === 'note' || field === 'description' ? `${where} — ${field} ${actual}`
    : field === 'alarme' ? `${where} — alarme : ${actual}`
    : `${where} — ${field} : ${actual} au lieu ${of(expected)}`;
  return { at, field, expected, actual, text: phrase };
}

/** « au lieu de plafond 155 bpm », « au lieu d'aucune alarme ». */
const of = (s: string) => (/^[aeiouyéèêàâôh]/i.test(s) ? `d'${s}` : `de ${s}`);

/** Ce qu'une cible fait sonner : rien, un plafond, ou un plancher et un plafond. */
export function alarmOf(t: WatchTarget): Alarm | 'unknown' {
  if (t.type === 'none') return 'none';
  if (t.type === 'hr') return t.low > 0 ? 'range' : 'ceiling';
  if (t.type === 'pace' || t.type === 'zone') return 'range';
  return 'unknown';
}

/** Une alarme d'une autre nature que la prescrite, dite par ce qu'elle ferait faire. */
function alarmChange(e: WatchTarget, a: WatchTarget): string | null {
  if (alarmOf(e) === alarmOf(a)) return null;
  const floor = alarmOf(a) === 'range' ? ' — un plancher : la montre pousserait à accélérer' : '';
  return `${targetText(a)} au lieu ${of(targetText(e))}${floor}`;
}

/** Ce qu'un texte est devenu : tronqué, ou modifié à tel endroit. */
function textChange(expected: string, actual: string): string {
  if (!actual) return 'absente';
  if (expected.startsWith(actual)) return `tronquée après ${actual.length} caractères sur ${expected.length}`;
  // Garmin coupe ce qui dépasse sa limite et le signale par « ... ».
  const kept = actual.endsWith('...') ? actual.slice(0, -3) : null;
  if (kept && expected.startsWith(kept)) {
    return `tronquée par Garmin après ${kept.length} caractères sur ${expected.length}`;
  }
  let i = 0;
  while (i < expected.length && i < actual.length && expected[i] === actual[i]) i++;
  const around = (s: string) => `${i > 12 ? '…' : ''}${s.slice(Math.max(0, i - 12), i + 18)}${s.length > i + 18 ? '…' : ''}`;
  return `modifiée : « ${around(actual)} » au lieu de « ${around(expected)} »`;
}

const steps = (n: number) => `${n} étape${n > 1 ? 's' : ''}`;
const itemKind = (i: WatchItem) => (i.kind === 'repeat' ? `une répétition de ${i.times} fois` : `une étape`);
const quote = (s: string) => `« ${s} »`;

const STEP_LABEL: Record<WatchStepType, string> = {
  warmup: 'échauffement',
  interval: 'course',
  recovery: 'récupération',
  rest: 'repos',
  cooldown: 'retour au calme',
  other: 'autre',
};

// ─────────────────────────────────────────────────────────────────────────────
// Écritures, dans les unités qu'on lit
// ─────────────────────────────────────────────────────────────────────────────

export function endText(end: WatchEnd): string {
  switch (end.type) {
    case 'time':
      return clock(end.seconds);
    case 'distance':
      return `${end.meters} m`;
    case 'lap':
      return 'bouton tour';
    default:
      return `${end.key}${end.value != null ? ` ${end.value}` : ''}`;
  }
}

export function targetText(target: WatchTarget): string {
  switch (target.type) {
    case 'none':
      return 'aucune alarme';
    case 'hr':
      return target.low > 0 ? `${target.low}–${target.high} bpm` : `plafond ${target.high} bpm`;
    case 'pace':
      return `${pace(target.fast)}–${pace(target.slow)}/km`;
    case 'zone':
      return `zone Garmin ${target.zone} (${target.metric})`;
    default:
      return `${target.key} ${target.low ?? '?'}–${target.high ?? '?'}`;
  }
}

/** Une séance en lignes, pour le terminal. */
export function describeWorkout(w: WatchWorkout): string[] {
  const lines = [w.name];
  const walk = (items: WatchItem[], prefix: string, indent: string) =>
    items.forEach((it, i) => {
      const at = prefix ? `${prefix}.${i + 1}` : `${i + 1}`;
      if (it.kind === 'repeat') {
        lines.push(`${indent}${at}. ${it.times} fois :`);
        walk(it.items, at, `${indent}   `);
      } else {
        lines.push(`${indent}${at}. ${STEP_LABEL[it.type]} · ${endText(it.end)} · ${targetText(it.target)} — ${it.note}`);
      }
    });
  walk(w.items, '', '  ');
  return lines;
}

const hrText = (low: number, high: number) => (low > 0 ? `${Math.round(low)}–${Math.round(high)}` : `sous ${Math.round(high)}`);

export const paceSeconds = (speedMs: number): number => Math.round(1000 / speedMs);

function pace(seconds: number): string {
  const m = Math.floor(seconds / 60);
  return `${m}:${String(seconds - m * 60).padStart(2, '0')}`;
}

/** Une durée à la seconde, comme la montre l'affiche : « 20:00 », « 1:05:00 ». */
export function clock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${sec}` : `${m}:${sec}`;
}

/**
 * Le texte tel que Garmin le garde : espaces insécables rendus ordinaires,
 * blancs resserrés. Appliqué des deux côtés, il fait qu'une espace fine devant
 * un deux-points ne se lit pas comme un écart.
 */
export function text(s: string): string {
  return s.replace(/[  ]/g, ' ').replace(/\s+/g, ' ').trim();
}

const sentence = (s: string) => {
  const t = text(s);
  return !t || /[.!?…]$/.test(t) ? t : `${t}.`;
};

// ─────────────────────────────────────────────────────────────────────────────
// Empreinte
// ─────────────────────────────────────────────────────────────────────────────

/**
 * L'identité d'une séance envoyée : son jour et son contenu. Deux séances
 * identiques le même jour ont la même empreinte, quel que soit l'identifiant
 * que la dernière reconstruction du plan leur a donné — c'est ce qui évite de
 * réécrire sept séances sur la montre chaque fois que le plan est reconstruit
 * sans rien changer.
 */
export function fingerprintOf(date: string, workout: WatchWorkout): string {
  return createHash('sha256').update(JSON.stringify([date, workout])).digest('hex').slice(0, 16);
}
