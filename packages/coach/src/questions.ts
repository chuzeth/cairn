import type { Activity, AnswerQuestion, AthleteAnswer, PainSite, PlannedSession } from '@cairn/core';

/**
 * Ce que Cairn demande à l'athlète, et seulement quand une décision en dépend.
 *
 * La plupart de ce qui décide se mesure : la montre dit la durée et le cœur,
 * Strava dit ce qui a été fait. Restent trois choses qu'aucun capteur ne voit,
 * et dont la reprise de la course dépend : l'accord du médecin, une douleur,
 * l'effort d'une séance faite sans montre. Chacune se demande au moment où elle
 * sert — l'accord avant la première course, la douleur après chaque course et
 * le lendemain matin, l'effort quand le cœur manque — et se tait une fois dite.
 * Une question sans réponse ne bloque rien : la règle qui en a besoin fait sans,
 * en le disant (`reprise.ts`).
 */

export interface Choice {
  label: string;
  value: { choice?: 'yes' | 'not_yet' | 'no'; score?: number };
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

const DONE = new Set(['completed', 'replaced', 'partial']);
const dayMs = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const dayName = (date: string, today: string) =>
  date === today ? 'd\'aujourd\'hui' : date === shift(today, -1) ? 'd\'hier' : `de ${DAYS[new Date(`${date}T12:00:00Z`).getUTCDay()]}`;

const isRepriseRun = (s: PlannedSession) =>
  s.program?.name === 'reprise' && s.program.kind !== 'cross' && s.program.kind !== 'race';

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
}): Question[] {
  const { today, sessions, activities, answers } = input;
  const has = (question: AnswerQuestion, subject: string) => answers.some((a) => a.question === question && a.subject === subject);
  const out: Question[] = [];
  const runs = sessions.filter(isRepriseRun).sort((a, b) => a.date.localeCompare(b.date));

  // L'accord du médecin : à partir de trois jours avant la première course de la reprise, jusqu'à un oui.
  const first = runs[0];
  const cleared = answers.some((a) => a.question === 'clearance' && a.value.choice === 'yes');
  if (first && !cleared && first.date <= shift(today, 3)) {
    const lastNo = answers.filter((a) => a.question === 'clearance').sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))[0];
    // « Pas encore » se redemande le lendemain : l'avis peut venir d'un jour à l'autre.
    if (!lastNo || lastNo.answeredAt.slice(0, 10) < today) {
      out.push({
        id: `clearance:reprise`, question: 'clearance', subject: 'reprise',
        prompt: 'Ton médecin t\'autorise-t-il à recourir ?',
        why: 'Sans son accord, les courses de la reprise se font à vélo, et le dossard du 28/11 attend.',
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
  return out;
}

/** Une réponse est-elle de celles que la question attend ? */
export function validAnswer(question: AnswerQuestion, value: { choice?: unknown; score?: unknown; site?: unknown }): string | null {
  if (question === 'clearance') {
    return value.choice === 'yes' || value.choice === 'not_yet' || value.choice === 'no' ? null : 'choice : yes, not_yet ou no.';
  }
  const score = value.score;
  const [lo, hi] = question === 'run_rpe' ? [1, 10] : [0, 10];
  if (typeof score !== 'number' || !Number.isInteger(score) || score < lo || score > hi) return `score : un entier de ${lo} à ${hi}.`;
  if (value.site != null && !PAIN_SITES.some((p) => p.site === value.site)) return 'site : un des endroits proposés.';
  return null;
}
