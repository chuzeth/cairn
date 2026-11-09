import type {
  Activity, AnswerQuestion, AthleteAnswer, DeviationCause, PainPattern, PainSite, PlannedSession, SessionType,
} from '@cairn/core';
import { deviationOf, medicalSubject, runSignals, judgeRun, bonePattern, type RunDeviation } from './reprise.js';
import { isIntensityBlock } from './sessionLibrary.js';

/**
 * Ce que Cairn demande à l'athlète, et seulement quand une décision en dépend.
 *
 * La plupart de ce qui décide se mesure : la montre dit la durée et le cœur,
 * Strava dit ce qui a été fait. Reste ce qu'aucun capteur ne voit : l'accord du
 * médecin, une douleur et la façon dont elle se comporte, l'effort d'une séance
 * faite sans montre, la raison d'une course qui n'a pas ressemblé au prévu, et
 * la semaine qui vient. Chacune se demande au moment où elle sert — l'accord
 * avant la première course, la douleur après chaque course et le lendemain
 * matin, l'effort quand le cœur manque, le pourquoi quand un chiffre s'écarte,
 * les jours chargés avant une semaine qui porte une séance dure — et se tait
 * une fois dite.
 *
 * Le pourquoi est la question d'un entraîneur, pas d'un formulaire : une allure
 * qui n'est pas tenue, un cœur qui monte, ne disent pas s'il faisait chaud ou
 * si la fatigue s'installe. Cairn demande, et la réponse change la décision.
 * Une question sans réponse ne bloque rien : la règle qui en a besoin fait sans,
 * en le disant (`reprise.ts`).
 */

export interface Choice {
  label: string;
  value: { choice?: 'yes' | 'not_yet' | 'no'; score?: number; cause?: DeviationCause; pattern?: PainPattern };
}

/** Un jour à cocher, pour une question qui en prend plusieurs. */
export interface DayOption {
  label: string;
  day: string;
}

export interface Question {
  /** `question:subject` : stable d'un affichage à l'autre. */
  id: string;
  question: AnswerQuestion;
  subject: string;
  prompt: string;
  /** Ce que la réponse décide, en une phrase. */
  why: string;
  choices: Choice[];
  /** Vrai : la réponse dit aussi où (une douleur au-dessus de 0). */
  asksSite: boolean;
  /** Des jours à cocher, plusieurs à la fois ; aucun coché se dit « Aucun ». */
  days?: DayOption[];
}

export const PAIN_SITES: { site: PainSite; label: string }[] = [
  { site: 'tibia', label: 'Tibia' },
  { site: 'achille', label: 'Tendon d\'Achille' },
  { site: 'mollet', label: 'Mollet' },
  { site: 'pied', label: 'Pied' },
  { site: 'genou', label: 'Genou' },
  { site: 'hanche', label: 'Hanche' },
  { site: 'autre', label: 'Ailleurs' },
];

const PAIN: Choice[] = [
  { label: 'Aucune', value: { score: 0 } },
  { label: '1 – à peine', value: { score: 1 } },
  { label: '2', value: { score: 2 } },
  { label: '3 – gênante', value: { score: 3 } },
  { label: '4', value: { score: 4 } },
  { label: '5 et plus', value: { score: 5 } },
];

const RPE: Choice[] = [3, 4, 5, 6, 7, 8, 9].map((n) => ({
  label: n === 3 ? '3 – facile' : n === 5 ? '5 – soutenu' : n === 7 ? '7 – dur' : n === 9 ? '9 – à bloc' : String(n),
  value: { score: n },
}));

const CAUSES: Choice[] = (
  [
    ['heat', 'Chaleur, peu bu'], ['sleep', 'Nuit courte'], ['stress', 'Journée chargée'], ['terrain', 'Terrain, vent'],
    ['time', 'Manque de temps'], ['illness', 'Malade, enrhumé'], ['fatigue', 'Fatigue qui dure'],
    ['pain', 'Une douleur'], ['unknown', 'Aucune idée'],
  ] as const
).map(([cause, label]) => ({ label, value: { cause } }));

const PATTERNS: Choice[] = (
  [
    ['eases', 'S\'est estompée en courant'], ['steady', 'Est restée pareille'], ['worsens', 'A monté en courant'],
    ['at_rest', 'Reste au repos, la nuit'],
  ] as const
).map(([pattern, label]) => ({ label, value: { pattern } }));

/**
 * Les séances qu'une journée chargée gâche, et que la règle `charged_day`
 * rend progressives : celles qui portent de l'intensité. Une sortie longue
 * facile se court à son allure quel que soit le jour, une course ne se change
 * pas : demander pour elles promettrait un ajustement qui n'aura pas lieu.
 */
const DEMANDING: ReadonlySet<SessionType> = new Set([
  'tempo', 'threshold', 'vo2max', 'hill_repeats', 'downhill', 'fartlek', 'race_pace',
]);
const demands = (s: PlannedSession) =>
  DEMANDING.has(s.type) || ((s.type === 'long_run' || s.type === 'long_trail') && s.blocks.some(isIntensityBlock));

const DONE = new Set(['completed', 'replaced', 'partial']);
const dayMs = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const SHORT_DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];
const mondayOf = (date: string) => shift(date, -((new Date(`${date}T12:00:00Z`).getUTCDay() + 6) % 7));
const dayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const dayName = (date: string, today: string) =>
  date === today ? 'd\'aujourd\'hui' : date === shift(today, -1) ? 'd\'hier' : `de ${DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]}`;

const isRepriseRun = (s: PlannedSession) =>
  s.program?.name === 'reprise' && s.program.kind !== 'cross' && s.program.kind !== 'race';
/** Une course prévue par la reprise, même remplacée par l'escalier faute d'accord : c'est elle que l'accord rendra. */
const plannedAsRun = (s: PlannedSession) =>
  s.program?.name === 'reprise' && s.program.plannedKind !== 'cross' && s.program.plannedKind !== 'race';

/**
 * Les questions du jour, la plus utile d'abord : l'accord du médecin avant tout
 * (sans lui, aucune course n'a lieu), puis la douleur de la dernière course, le
 * matin qui suit, l'effort d'une course faite sans montre.
 */
export function pendingQuestions(input: {
  today: string;
  sessions: readonly PlannedSession[];
  activities: readonly Activity[];
  answers: readonly AthleteAnswer[];
  /** Le haut de l'endurance, bpm : au-dessus, un footing a été couru trop dur. */
  easyCeiling?: number;
}): Question[] {
  const { today, sessions, activities, answers } = input;
  const ceiling = input.easyCeiling ?? 155;
  const has = (question: AnswerQuestion, subject: string) => answers.some((a) => a.question === question && a.subject === subject);
  const out: Question[] = [];
  const runs = sessions.filter(isRepriseRun).sort((a, b) => a.date.localeCompare(b.date));

  // L'accord du médecin : à partir de trois jours avant la première course de la reprise, jusqu'à un oui.
  const first = sessions.filter(plannedAsRun).sort((a, b) => a.date.localeCompare(b.date))[0];
  const cleared = answers.some((a) => a.question === 'clearance' && a.value.choice === 'yes');
  if (first && !cleared && first.date <= shift(today, 3)) {
    const lastNo = answers.filter((a) => a.question === 'clearance').sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))[0];
    // « Pas encore » se redemande le lendemain : l'avis peut venir d'un jour à l'autre.
    if (!lastNo || lastNo.answeredAt.slice(0, 10) < today) {
      out.push({
        id: `clearance:reprise`, question: 'clearance', subject: 'reprise',
        prompt: 'Ton médecin t\'autorise-t-il à recourir ?',
        why: 'Sans son accord, les courses de la reprise se font dans l\'escalier, et le dossard du 28/11 attend.',
        choices: [
          { label: 'Oui', value: { choice: 'yes' } },
          { label: 'Pas encore', value: { choice: 'not_yet' } },
          { label: 'Non', value: { choice: 'no' } },
        ],
        asksSite: false,
      });
    }
  }

  // La douleur pendant la course, puis au réveil le lendemain.
  const recent = runs.filter((s) => DONE.has(s.status) && s.date >= shift(today, -3) && s.date <= today);
  for (const s of recent.slice().reverse()) {
    if (!has('run_pain', s.id)) {
      out.push({
        id: `run_pain:${s.id}`, question: 'run_pain', subject: s.id,
        prompt: `Ta course ${dayName(s.date, today)} : une douleur, pendant ou juste après ?`,
        why: 'C\'est ce qui décide si la prochaine course monte d\'une marche, reste, ou redescend.',
        choices: PAIN, asksSite: true,
      });
    }
  }
  const yesterday = shift(today, -1);
  if (recent.some((s) => s.date === yesterday) && !has('morning_pain', today)) {
    out.push({
      id: `morning_pain:${today}`, question: 'morning_pain', subject: today,
      prompt: 'Ce matin, au réveil et aux premiers pas : une douleur ?',
      why: 'Une douleur qui apparaît le lendemain en dit plus que celle de la course : le tendon et l\'os parlent en retard.',
      choices: PAIN, asksSite: true,
    });
  }

  // Comment une douleur s'est comportée : une qui s'estompe se surveille, une qui monte arrête.
  for (const s of recent.slice().reverse()) {
    const pain = answers.find((a) => a.question === 'run_pain' && a.subject === s.id)?.value.score ?? 0;
    if (pain >= 2 && !has('pain_pattern', s.id)) {
      out.push({
        id: `pain_pattern:${s.id}`, question: 'pain_pattern', subject: s.id,
        prompt: `Cette douleur, pendant ta course ${dayName(s.date, today)} :`,
        why: 'Une douleur qui s\'estompe se surveille en courant ; une qui monte, ou qui reste au repos, arrête la course jusqu\'à l\'avis d\'un médecin.',
        choices: PATTERNS, asksSite: false,
      });
    }
  }

  // Après le motif d'une fracture de fatigue, l'avis du médecin — et lui seul — rouvre la course.
  const signals = runSignals(sessions.filter((s) => s.program?.name === 'reprise'), activities, answers, today);
  const flagged = [bonePattern(signals.filter((r) => r.done)), ...signals.filter((r) => judgeRun(r, ceiling).medical)]
    .filter((r): r is NonNullable<typeof r> => r != null)
    .sort((a, b) => b.date.localeCompare(a.date))[0];
  if (flagged) {
    const subject = medicalSubject(flagged.sessionId);
    const said = answers.filter((a) => a.question === 'clearance' && a.subject === subject)
      .sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))[0];
    if (said?.value.choice !== 'yes' && (!said || said.answeredAt.slice(0, 10) < today)) {
      out.unshift({
        id: `clearance:${subject}`, question: 'clearance', subject,
        prompt: `La douleur de ta course ${dayName(flagged.date, today)} : un médecin l'a-t-il vue, et t'autorise-t-il à recourir ?`,
        why: 'Une douleur qui monte en courant, qui reste au repos, ou qui revient à l\'os, peut être une fracture de fatigue : d\'ici son avis, la marche à plat remplace la course.',
        choices: [
          { label: 'Oui, je peux recourir', value: { choice: 'yes' } },
          { label: 'Pas encore vu', value: { choice: 'not_yet' } },
          { label: 'Non', value: { choice: 'no' } },
        ],
        asksSite: false,
      });
    }
  }

  // Pourquoi une course s'est écartée du prévu : une cause qui passe ne compte pas, une fatigue qui dure, si.
  for (const r of signals.filter((x) => x.done && x.date >= shift(today, -3)).reverse()) {
    const deviation = deviationOf(r, ceiling);
    if (!deviation || has('deviation_cause', r.sessionId)) continue;
    const pain = Math.max(r.painDuring ?? 0, r.painMorning ?? 0);
    if (pain >= 2) continue; // La douleur a déjà dit pourquoi.
    out.push({
      id: `deviation_cause:${r.sessionId}`, question: 'deviation_cause', subject: r.sessionId,
      prompt: deviationPrompt(deviation, r, ceiling, dayName(r.date, today)),
      why: deviation === 'short'
        ? 'Écourtée, la course reste sur sa marche quoi qu\'il arrive ; la cause dit si c\'est un hasard ou un signal.'
        : 'Une cause qui passe — chaleur, nuit courte, journée chargée, terrain — ne retient pas la reprise ; une fatigue qui dure, si.',
      choices: CAUSES, asksSite: false,
    });
  }

  // L'effort d'une course sans fréquence cardiaque : sans lui, rien ne dit ce qu'elle a coûté.
  for (const s of recent) {
    const activity = s.completedActivityId ? activities.find((a) => a.id === s.completedActivityId) : undefined;
    if (activity && activity.averageHr == null && !has('run_rpe', s.id)) {
      out.push({
        id: `run_rpe:${s.id}`, question: 'run_rpe', subject: s.id,
        prompt: `Ta course ${dayName(s.date, today)}, sans montre au poignet : quel effort, de 1 à 10 ?`,
        why: 'Sans fréquence cardiaque, c\'est la seule mesure de ce que la course t\'a coûté.',
        choices: RPE, asksSite: false,
      });
    }
  }
  // La semaine qui vient : où sont les jours chargés, avant qu'une séance dure y tombe.
  const weekday = new Date(`${today}T12:00:00Z`).getUTCDay();
  const week = weekday === 6 || weekday === 0 ? shift(mondayOf(today), 7) : mondayOf(today);
  const asksWeek = weekday === 6 || weekday === 0 || weekday === 1;
  const demanding = sessions.filter(
    (s) => (s.status === 'planned' || s.status === 'moved') && demands(s) && s.date >= today &&
      s.date >= week && s.date <= shift(week, 6),
  );
  if (asksWeek && demanding.length > 0 && !has('week_load', week)) {
    const days = Array.from({ length: 7 }, (_, i) => shift(week, i)).filter((d) => d >= today);
    out.push({
      id: `week_load:${week}`, question: 'week_load', subject: week,
      prompt: `Du ${dayMonth(week)} au ${dayMonth(shift(week, 6))} : des jours chargés — travail, déplacement, nuit courte ?`,
      why: `Une séance dure un jour chargé se court progressive, en bas de sa fourchette : ${demanding.map((s) => `${SHORT_DAYS[new Date(`${s.date}T12:00:00Z`).getUTCDay()]} ${dayMonth(s.date)}`).join(', ')}.`,
      choices: [], asksSite: false,
      days: days.map((d) => ({ label: `${SHORT_DAYS[new Date(`${d}T12:00:00Z`).getUTCDay()]} ${dayMonth(d)}`, day: d })),
    });
  }

  return out;
}

function deviationPrompt(d: RunDeviation, r: { completion?: number; rpe?: number; avgHr?: number }, ceiling: number, when: string): string {
  if (d === 'short') return `Ta course ${when} s'est arrêtée à ${Math.round((r.completion ?? 0) * 100)} % de sa durée. Pourquoi ?`;
  if (d === 'effort') return `Ta course ${when} : ${r.rpe} sur 10 d'effort pour un footing. Qu'est-ce qui l'explique ?`;
  return `Ta course ${when} : ${Math.round(r.avgHr ?? 0)} bpm de moyenne, au-dessus de ton endurance (${ceiling}). Qu'est-ce qui l'explique ?`;
}

const CAUSE_KEYS: ReadonlySet<string> = new Set(['heat', 'sleep', 'stress', 'terrain', 'time', 'illness', 'fatigue', 'pain', 'unknown']);
const PATTERN_KEYS: ReadonlySet<string> = new Set(['eases', 'steady', 'worsens', 'at_rest']);
const ISO_DAY = /^\d{4}-\d{2}-\d{2}$/;

/** Une réponse est-elle de celles que la question attend ? */
export function validAnswer(
  question: AnswerQuestion,
  value: { choice?: unknown; score?: unknown; site?: unknown; cause?: unknown; pattern?: unknown; days?: unknown },
): string | null {
  if (question === 'clearance') {
    return value.choice === 'yes' || value.choice === 'not_yet' || value.choice === 'no' ? null : 'choice : yes, not_yet ou no.';
  }
  if (question === 'deviation_cause') {
    return typeof value.cause === 'string' && CAUSE_KEYS.has(value.cause) ? null : `cause : ${[...CAUSE_KEYS].join(', ')}.`;
  }
  if (question === 'pain_pattern') {
    return typeof value.pattern === 'string' && PATTERN_KEYS.has(value.pattern) ? null : `pattern : ${[...PATTERN_KEYS].join(', ')}.`;
  }
  if (question === 'week_load') {
    const days = value.days;
    return Array.isArray(days) && days.length <= 7 && days.every((d) => typeof d === 'string' && ISO_DAY.test(d))
      ? null
      : 'days : une liste de jours AAAA-MM-JJ, vide si aucun.';
  }
  const score = value.score;
  const [lo, hi] = question === 'run_rpe' ? [1, 10] : [0, 10];
  if (typeof score !== 'number' || !Number.isInteger(score) || score < lo || score > hi) return `score : un entier de ${lo} à ${hi}.`;
  if (value.site != null && !PAIN_SITES.some((p) => p.site === value.site)) return 'site : un des endroits proposés.';
  return null;
}
