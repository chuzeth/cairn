import { EXERCISES, isExerciseKey, type ExerciseSheet, type TestMeasure } from '@cairn/core/exercises';
import { blockDuration, duration, num, type SessionRow } from './api';

/**
 * Une séance de renforcement, telle qu'on la suit en la faisant.
 *
 * Le 09/10, Pierre : « chaque jour, j'ai une séance ; je clique dessus et
 * j'ai, exercice après exercice, le petit schéma, combien de séries, combien
 * de répétitions — avec des grandes parties : l'échauffement, les tests… ». La
 * fiche complète, où « tout se mélange », se déplie pour qui la demande ; ce
 * qui s'affiche d'abord, c'est ce qu'il y a à faire maintenant.
 *
 * Rien ici ne décide : les séries, les répétitions, le tempo et la réserve
 * viennent des blocs que le coach a posés (`@cairn/coach`, `blockDay`). Ce
 * module les dit, dans l'ordre, et les compte.
 */

export type Block = SessionRow['blocks'][number];

/** Le minuteur d'une étape : un maintien, un effort guidé, une durée, ou le chrono d'un test. */
export type StepTimer =
  | { kind: 'hold'; seconds: number }
  | { kind: 'pulse'; workS: number; restS: number; reps: number }
  | { kind: 'stopwatch'; max?: number; beatS?: number };

/** Une étape de la séance : un exercice, dans sa partie. */
export interface Step {
  /** Son rang dans la séance, de 1 à n. */
  n: number;
  /** Son rang dans les blocs de la séance : c'est à lui que se rattachent les séries cochées. */
  index: number;
  block: Block;
  sheet: ExerciseSheet | null;
  part: string;
  /** Le nom de l'étape, celui du bloc : « Fente bulgare ». */
  name: string;
  /** Ce qu'il y a à faire, en gros : « 3 × 10 », « 2 × 75 s », « 40 min ». */
  main: string;
  /** Ce qui précise `main` : « par jambe », « jambe gauche puis droite ». */
  mainNote: string;
  /** Le tempo, le repos, l'effort, le cœur : une ligne chacun, nommée. */
  details: Detail[];
  /** Les séries à cocher ; 1 pour ce qui se fait d'une traite. */
  sets: number;
  /** Le repos après chaque série, s ; 0 quand il n'y en a pas. */
  restS: number;
  timer: StepTimer | null;
  /** Un test : ce qu'il mesure. */
  measure: TestMeasure | null;
  /** La durée de l'étape, repos compris, s. */
  durationS: number;
}

/** Une ligne du détail : « Tempo — 3 s pour descendre… ». */
export interface Detail {
  label: 'Tempo' | 'Repos' | 'Récupération' | 'Effort' | 'Cœur';
  text: string;
}

export interface Part {
  name: string;
  steps: Step[];
  durationS: number;
}

/** Les mots d'un côté : « par jambe », « par côté ». */
const perSide = (b: Block) => (b.sides ? `par ${b.sides}` : '');

/** L'effort qui ne se lit nulle part ailleurs : ce que la réserve, le maintien ou le contrôle ne disent pas déjà. */
const GENERIC_EFFORT = /^(contrôlé|tenir sans trembler|\d+ répétitions? en réserve)$/i;

/** « Arrête-toi 2 répétitions avant l'échec. » */
export function reserveLine(reserve: number): string {
  return reserve === 0
    ? 'jusqu’à l’échec'
    : `arrête-toi ${num(reserve)} répétition${reserve > 1 ? 's' : ''} avant l’échec`;
}

/** La fréquence cardiaque d'un bloc, avec son unité. */
function heartLine(b: Block): string | null {
  if (!b.hrRange) return null;
  return b.hrRange[0] > 0 ? `entre ${num(b.hrRange[0])} et ${num(b.hrRange[1])} bpm` : `sous ${num(b.hrRange[1])} bpm`;
}

/** Une consigne écrite comme une phrase, dite comme une valeur : sans majuscule ni point final. */
const asValue = (text: string) => `${text[0]!.toLowerCase()}${text.slice(1)}`.replace(/\.$/, '');

/** Ce qu'une séance fait d'un bloc. */
function stepOf(b: Block, index: number, n: number): Step {
  const sheet = b.exercise && isExerciseKey(b.exercise) ? EXERCISES[b.exercise] : null;
  const measure = sheet?.measure ?? null;
  const repeat = b.repeat ?? 1;
  const sides = b.sides ? 2 : 1;
  const sets = Math.max(1, Math.round(repeat / sides));
  const restS = b.recovery?.durationS ?? 0;
  const setS = b.durationS ?? 0;
  const details: Detail[] = [];
  let main: string;
  let mainNote = '';
  let timer: StepTimer | null = null;

  if (measure) {
    // Un test ne se compte pas en séries : il se mène à son terme, et se note.
    main = b.effort ?? 'La mesure';
    mainNote = measure.perSide ? (sets > 1 ? `${sets} essais par jambe` : 'une jambe, puis l’autre') : '';
    if (measure.guide) timer = { kind: 'stopwatch', max: measure.max, beatS: measure.beatS };
  } else if (b.pulse && b.reps) {
    // L'effort guidé : « 4 × 3 s », le minuteur dit quand pousser et quand relâcher.
    main = sets > 1 ? `${sets} × ${b.reps}` : `${b.reps} fois`;
    mainNote = [perSide(b), `${b.pulse.workS} s à fond, ${b.pulse.restS} s relâché`].filter(Boolean).join(' · ');
    timer = { kind: 'pulse', workS: b.pulse.workS, restS: b.pulse.restS, reps: b.reps };
  } else if (b.reps) {
    main = `${sets} × ${b.reps}`;
    mainNote = perSide(b);
  } else if (!b.hrRange && !b.kind && setS > 0 && setS <= 300) {
    // Un maintien : la chaise, le gainage, l'équilibre.
    main = sets > 1 ? `${sets} × ${blockDuration(setS)}` : blockDuration(setS);
    mainNote = perSide(b);
    timer = { kind: 'hold', seconds: setS };
  } else if (repeat > 1) {
    // Le fractionné : des répétitions, une récupération qui se marche.
    main = `${repeat} × ${blockDuration(setS)}`;
  } else {
    main = blockDuration(setS) || '—';
  }

  if (b.tempo) details.push({ label: 'Tempo', text: asValue(b.tempo) });
  const heart = heartLine(b);
  if (heart) details.push({ label: 'Cœur', text: heart });
  if (restS > 0 && measure) {
    // Un test se repose entre les deux jambes, puis avant le test suivant.
    details.push({
      label: 'Repos',
      text: measure.perSide ? `${blockDuration(restS)} entre les deux jambes, puis avant la suite` : `${blockDuration(restS)} avant la suite`,
    });
  } else if (restS > 0 && (sets > 1 || repeat > 1)) {
    details.push(
      b.recovery?.active
        ? { label: 'Récupération', text: `${blockDuration(restS)} en marchant${b.recovery.elevationLossM ? ', en redescendant' : ''}` }
        : {
            label: 'Repos',
            text: b.sides
              ? `${blockDuration(restS)} après les deux ${b.sides === 'jambe' ? 'jambes' : 'côtés'}`
              : `${blockDuration(restS)} entre les séries`,
          },
    );
  }
  if (b.reserve != null) details.push({ label: 'Effort', text: reserveLine(b.reserve) });
  else if (b.effort && !measure && !GENERIC_EFFORT.test(b.effort)) details.push({ label: 'Effort', text: asValue(b.effort) });

  // La durée : les séries, et les repos entre elles.
  const span = repeat * setS + Math.max(0, repeat - 1) * restS;
  return {
    n, index, block: b, sheet, part: b.part ?? (b.kind ? 'Souplesse et respiration' : 'Séance'), name: b.label,
    main, mainNote, details, sets, restS, timer, measure, durationS: span,
  };
}

/**
 * La séance en parties et en étapes, dans l'ordre de ses blocs.
 *
 * Deux blocs voisins de la même partie y restent ensemble ; une partie qui
 * revient plus loin — rare — se rouvre sous son nom, à sa place.
 */
export function workoutOf(session: Pick<SessionRow, 'blocks'>): Part[] {
  const parts: Part[] = [];
  session.blocks.forEach((b, index) => {
    const step = stepOf(b, index, index + 1);
    const last = parts[parts.length - 1];
    if (last && last.name === step.part) last.steps.push(step);
    else parts.push({ name: step.part, steps: [step], durationS: 0 });
  });
  for (const p of parts) p.durationS = p.steps.reduce((a, s) => a + s.durationS, 0);
  return parts;
}

/** Les étapes à la suite, sans leurs parties. */
export const stepsOf = (parts: Part[]): Step[] => parts.flatMap((p) => p.steps);

/** Une séance qui se suit exercice par exercice : celle dont les blocs disent leur partie. */
export const isWorkout = (session: Pick<SessionRow, 'blocks'>): boolean =>
  session.blocks.length > 0 && session.blocks.every((b) => b.part);

/** « 3 parties · 11 exercices · 1 h 07 ». */
export function workoutSummary(parts: Part[], totalS: number): string {
  const steps = stepsOf(parts).length;
  return [
    `${parts.length} partie${parts.length > 1 ? 's' : ''}`,
    `${steps} exercice${steps > 1 ? 's' : ''}`,
    duration(totalS),
  ].join(' · ');
}

/** La durée d'une partie, à la minute la plus proche : 110 s font 2 min, pas 1. */
export const partDuration = (part: Part): string => duration(Math.max(60, Math.round(part.durationS / 60) * 60));

/** Ce qu'une partie annonce : « 5 exercices · 26 min ». */
export function partSummary(part: Part): string {
  const n = part.steps.length;
  return `${n} exercice${n > 1 ? 's' : ''} · ${partDuration(part)}`;
}

/** Ce que la case d'une série dit : « jambe gauche puis droite » pour un exercice d'une jambe. */
export function setLabel(step: Step, i: number): string {
  const which = step.block.sides === 'jambe' ? ' · gauche, puis droite' : step.block.sides === 'côté' ? ' · un côté, puis l’autre' : '';
  return `Série ${i + 1} sur ${step.sets}${which}`;
}

/** Un nombre écrit à la française, pour un champ : « 1,5 » se lit comme 1.5. */
export function parseMeasure(text: string): number | null {
  const t = text.trim().replace(/\s/g, '').replace(',', '.').replace(/^[−–]/, '-');
  if (t === '' || !/^-?\d+(\.\d+)?$/.test(t)) return null;
  return Number(t);
}

/** Un résultat de test, dit avec son unité : « 28 », « 1 min 35 s », « −1 cm ». */
export function measureText(value: number | undefined, unit: TestMeasure['unit']): string {
  if (value == null) return '—';
  if (unit === 'secondes') {
    if (value < 60) return `${num(value, value % 1 ? 1 : 0)} s`;
    const s = Math.round(value);
    return s % 60 === 0 ? `${s / 60} min` : `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
  }
  if (unit === 'cm') return `${value > 0 ? '+' : ''}${num(value, value % 1 ? 1 : 0)} cm`;
  return num(value);
}
