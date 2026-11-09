import type { Activity, AthleteAnswer, PlannedSession, SessionProgram } from '@cairn/core';
import { runDurationOf } from '@cairn/physiology';

/**
 * La reprise de la course, jugée course après course.
 *
 * Un programme écrit d'avance ne sait pas ce que le tendon dira demain. Celui-ci
 * se décide sur ce qui est arrivé : chaque course de la reprise occupe une marche
 * (`SessionProgram.level`), et la suivante ne s'ouvre que si la précédente s'est
 * bien passée — courue en entier, sans douleur pendant ni le lendemain matin,
 * le cœur dans sa zone. Les règles, dans l'ordre où elles s'appliquent :
 *
 *  · douleur de 5 sur 10 ou plus, pendant ou le lendemain : plus de course tant
 *    qu'un matin ne la redit pas sous 3 ; le vélo à sa place ;
 *  · douleur de 3 ou 4 : une marche plus bas ;
 *  · douleur de 2, course écourtée de plus d'un cinquième, effort perçu de 8 ou
 *    plus sur un footing, ou cœur au-dessus de l'endurance : on reste sur la
 *    même marche ;
 *  · sinon, on monte d'une marche.
 *
 * La douleur compte plus que tout le reste : c'est le premier signe d'une
 * fracture de fatigue ou d'une tendinopathie, et le seul que les données ne
 * voient pas. Elle se demande (`questions.ts`) ; sans réponse, la reprise
 * continue sur les autres signaux, et la question reste posée.
 *
 * Une règle ne fait jamais monter une séance au-dessus de la marche que le
 * programme lui avait donnée (`planned`) : elle ne fait que la retenir.
 */

export type RepriseStep = 'up' | 'hold' | 'down' | 'stop';

/** Ce qu'une course de la reprise a donné. */
export interface RunSignal {
  sessionId: string;
  date: string;
  level: number;
  kind: SessionProgram['kind'];
  done: boolean;
  /** Part de la durée prévue réellement courue, quand une activité la mesure. */
  completion?: number;
  painDuring?: number;
  painMorning?: number;
  rpe?: number;
  avgHr?: number;
}

export interface RepriseVerdict {
  step: RepriseStep;
  /** La marche que la prochaine course peut prendre au plus ; 0 : pas de course. */
  level: number;
  reason: string;
}

/** Le seuil de douleur au-delà duquel on ne court plus. */
export const PAIN_STOP = 5;
/** Le seuil de douleur au-delà duquel on redescend. */
export const PAIN_DOWN = 3;
/** Le seuil de douleur qui retient sur la même marche. */
export const PAIN_HOLD = 2;

const isReprise = (s: PlannedSession) => s.program?.name === 'reprise';
const isRun = (s: PlannedSession) => isReprise(s) && s.program!.kind !== 'cross' && s.program!.kind !== 'race';
const DONE = new Set(['completed', 'replaced', 'partial']);

const nextDay = (date: string) => new Date(Date.parse(`${date}T12:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

const answerFor = (answers: readonly AthleteAnswer[], question: AthleteAnswer['question'], subject: string) =>
  answers.find((a) => a.question === question && a.subject === subject);

/**
 * Les courses de la reprise passées — avant `today`, ou faites aujourd'hui —,
 * avec ce qu'elles ont donné : l'activité qui les a réalisées, les réponses.
 */
export function runSignals(
  sessions: readonly PlannedSession[],
  activities: readonly Activity[],
  answers: readonly AthleteAnswer[],
  today: string,
): RunSignal[] {
  return sessions
    .filter((s) => isRun(s) && (s.date < today || (s.date === today && DONE.has(s.status))))
    .filter((s) => s.status !== 'cancelled' && s.status !== 'withdrawn')
    .sort((a, b) => a.date.localeCompare(b.date))
    .map((s) => {
      const done = DONE.has(s.status);
      const activity = s.completedActivityId ? activities.find((a) => a.id === s.completedActivityId) : undefined;
      const during = answerFor(answers, 'run_pain', s.id)?.value.score;
      const morning = answerFor(answers, 'morning_pain', nextDay(s.date))?.value.score;
      const rpe = answerFor(answers, 'run_rpe', s.id)?.value.score;
      return {
        sessionId: s.id,
        date: s.date,
        level: s.program!.level,
        kind: s.program!.kind,
        done,
        // Ce qui se court, sans les dix minutes de kiné ni la respiration, que l'activité ne compte pas.
        ...(activity && runDurationOf(s) > 0 ? { completion: Math.min(1.5, activity.movingTimeS / runDurationOf(s)) } : {}),
        ...(during != null ? { painDuring: during } : {}),
        ...(morning != null ? { painMorning: morning } : {}),
        ...(rpe != null ? { rpe } : {}),
        ...(activity?.averageHr != null ? { avgHr: activity.averageHr } : {}),
      };
    });
}

/** Le verdict d'une course faite, pris seul. */
export function judgeRun(run: RunSignal, easyCeiling: number): { step: RepriseStep; reason: string } {
  const pain = Math.max(run.painDuring ?? 0, run.painMorning ?? 0);
  const said = run.painDuring != null || run.painMorning != null;
  const when = run.painMorning != null && run.painMorning >= (run.painDuring ?? 0) ? 'le lendemain matin' : 'pendant la course';
  if (pain >= PAIN_STOP) {
    return { step: 'stop', reason: `une douleur de ${pain} sur 10 ${when} : plus de course tant qu'elle ne retombe pas sous ${PAIN_DOWN}` };
  }
  if (pain >= PAIN_DOWN) return { step: 'down', reason: `une douleur de ${pain} sur 10 ${when}` };
  if (pain >= PAIN_HOLD) return { step: 'hold', reason: `une douleur de ${pain} sur 10 ${when}` };
  if (run.completion != null && run.completion < 0.8) {
    return { step: 'hold', reason: `${Math.round(run.completion * 100)} % de la durée prévue courue` };
  }
  const easy = run.kind === 'easy' || run.kind === 'run_walk' || run.kind === 'long';
  if (easy && run.rpe != null && run.rpe >= 8) return { step: 'hold', reason: `un effort perçu de ${run.rpe} sur 10 sur une course facile` };
  if (easy && run.avgHr != null && run.avgHr > easyCeiling + 3) {
    return { step: 'hold', reason: `un cœur moyen de ${Math.round(run.avgHr)} bpm, au-dessus de l'endurance (${easyCeiling})` };
  }
  return { step: 'up', reason: said ? 'sans douleur' : 'courue en entier — la douleur n\'a pas été dite' };
}

/**
 * La marche que la prochaine course peut prendre, d'après les courses passées.
 *
 * Aucune course encore : la première marche. La dernière manquée : on reste sur
 * la dernière faite. Un arrêt pour douleur ne se lève que sur un matin qui la
 * dit sous 3, après lui : la reprise repart alors une marche sous la course qui
 * l'a provoqué.
 */
export function allowedLevel(
  runs: readonly RunSignal[],
  answers: readonly AthleteAnswer[],
  easyCeiling: number,
): RepriseVerdict {
  const done = runs.filter((r) => r.done);
  const last = runs.at(-1);
  if (!last) return { step: 'up', level: 1, reason: 'la première course de la reprise' };
  const lastDone = done.at(-1);
  if (!lastDone) return { step: 'hold', level: 1, reason: 'aucune course de la reprise n\'a encore été faite' };

  // Un arrêt en cours : la plus récente course faite qui l'a déclenché, puis un matin sous le seuil.
  const stopped = [...done].reverse().find((r) => judgeRun(r, easyCeiling).step === 'stop');
  if (stopped) {
    const relief = answers
      .filter((a) => a.question === 'morning_pain' && a.subject > stopped.date && (a.value.score ?? 10) < PAIN_DOWN)
      .sort((a, b) => a.subject.localeCompare(b.subject))[0];
    const after = done.filter((r) => r.date > stopped.date);
    if (!relief && after.length === 0) {
      return { step: 'stop', level: 0, reason: judgeRun(stopped, easyCeiling).reason };
    }
    if (after.length === 0) {
      return {
        step: 'down', level: Math.max(1, stopped.level - 1),
        reason: `la douleur est retombée (${relief!.value.score} sur 10 le ${relief!.subject}) : on repart une marche plus bas`,
      };
    }
  }

  if (last !== lastDone) {
    return { step: 'hold', level: lastDone.level, reason: `la course du ${last.date} n'a pas été faite : on reste sur la marche ${lastDone.level}` };
  }
  const verdict = judgeRun(lastDone, easyCeiling);
  const level =
    verdict.step === 'up' ? lastDone.level + 1
      : verdict.step === 'hold' ? lastDone.level
        : verdict.step === 'down' ? Math.max(1, lastDone.level - 1)
          : 0;
  return { step: verdict.step, level, reason: verdict.reason };
}

/**
 * Le critère du dossard : la sortie longue (marche 5) faite au plus tard le
 * jour du critère, sans douleur au-dessus de 2, ni elle ni aucune course après
 * elle, et aucun arrêt en cours.
 */
export function raceGate(
  runs: readonly RunSignal[],
  answers: readonly AthleteAnswer[],
  easyCeiling: number,
): { met: boolean; reason: string } {
  const long = runs.filter((r) => r.done && r.level >= 5).at(-1);
  if (!long) return { met: false, reason: 'la sortie longue de 1 h 15 n\'a pas été faite' };
  const since = runs.filter((r) => r.done && r.date >= long.date);
  const sore = since.find((r) => Math.max(r.painDuring ?? 0, r.painMorning ?? 0) > PAIN_HOLD);
  if (sore) {
    return { met: false, reason: `une douleur de ${Math.max(sore.painDuring ?? 0, sore.painMorning ?? 0)} sur 10 après la course du ${sore.date}` };
  }
  if (allowedLevel(runs, answers, easyCeiling).step === 'stop') return { met: false, reason: 'un arrêt pour douleur est en cours' };
  return { met: true, reason: `la sortie longue du ${long.date} faite sans douleur` };
}
