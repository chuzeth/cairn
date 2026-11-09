import type { Activity, AthleteAnswer, DeviationCause, PainPattern, PainSite, PlannedSession, SessionProgram } from '@cairn/core';
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
 *    qu'un matin ne la redit pas sous 3 ; la marche à plat à sa place ;
 *  · une douleur qui monte à mesure qu'on court, ou qui reste au repos et la
 *    nuit, ou une douleur de 3 ou plus à l'os — tibia, pied — deux courses en
 *    quinze jours : plus de course avant l'accord d'un médecin. C'est le motif
 *    d'une fracture de fatigue, et une reprise après six semaines sans impact
 *    est le moment où elle arrive ;
 *  · douleur de 3 ou 4 : une marche plus bas ;
 *  · douleur de 2, ou course écourtée de plus d'un cinquième : on reste sur la
 *    même marche ;
 *  · effort perçu de 8 ou plus sur un footing, ou cœur au-dessus de
 *    l'endurance : on reste, sauf si la cause est de celles qui passent — la
 *    chaleur, une nuit courte, une journée chargée, le terrain. Le cœur d'un jour
 *    varie de cinq à dix battements pour ces seules raisons : le prendre seul
 *    pour juge retiendrait la reprise sur un jour chaud. Deux courses de suite
 *    au-dessus, expliquées ou non, retiennent : ce n'est plus un hasard ;
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

/** Les causes qui passent d'un jour à l'autre : elles expliquent un écart sans le faire compter. */
export const TRANSIENT_CAUSES: ReadonlySet<DeviationCause> = new Set(['heat', 'sleep', 'stress', 'terrain']);

/** L'os : une douleur qui s'y répète n'est pas une gêne de tendon. */
export const BONE_SITES: ReadonlySet<PainSite> = new Set(['tibia', 'pied']);

/** Le motif d'une douleur qui arrête la course jusqu'à l'avis d'un médecin. */
export const RED_FLAG_PATTERNS: ReadonlySet<PainPattern> = new Set(['worsens', 'at_rest']);

/** Fenêtre où deux douleurs à l'os font un motif, en jours. */
export const BONE_WINDOW_DAYS = 15;

const CAUSE_FR: Record<DeviationCause, string> = {
  heat: 'la chaleur', sleep: 'une nuit courte', stress: 'une journée chargée', terrain: 'le terrain',
  time: 'le manque de temps', illness: 'un rhume ou une maladie', fatigue: 'une fatigue qui dure',
  pain: 'une douleur', unknown: 'sans cause connue',
};

/** Ce qui s'est écarté du prévu dans une course faite, du plus lourd au plus léger. */
export type RunDeviation = 'short' | 'effort' | 'heart';

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
  /** Où, quand la douleur a été située. */
  site?: PainSite;
  /** Comment la douleur s'est comportée pendant la course. */
  pattern?: PainPattern;
  /** Ce que Pierre a donné comme cause d'un écart. */
  cause?: DeviationCause;
  rpe?: number;
  avgHr?: number;
}

export interface RepriseVerdict {
  step: RepriseStep;
  /** La marche que la prochaine course peut prendre au plus ; 0 : pas de course. */
  level: number;
  reason: string;
  /** Vrai : l'arrêt attend l'accord d'un médecin, et non un matin sans douleur. */
  medical?: boolean;
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
      const duringAnswer = answerFor(answers, 'run_pain', s.id)?.value;
      const morningAnswer = answerFor(answers, 'morning_pain', nextDay(s.date))?.value;
      const during = duringAnswer?.score;
      const morning = morningAnswer?.score;
      const site = (during ?? 0) >= (morning ?? 0) ? duringAnswer?.site ?? morningAnswer?.site : morningAnswer?.site ?? duringAnswer?.site;
      const pattern = answerFor(answers, 'pain_pattern', s.id)?.value.pattern;
      const cause = answerFor(answers, 'deviation_cause', s.id)?.value.cause;
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
        ...(site ? { site } : {}),
        ...(pattern ? { pattern } : {}),
        ...(cause ? { cause } : {}),
        ...(rpe != null ? { rpe } : {}),
        ...(activity?.averageHr != null ? { avgHr: activity.averageHr } : {}),
      };
    });
}

/** Ce qui s'est écarté du prévu dans une course faite — sans la douleur, qui se juge à part. */
export function deviationOf(run: RunSignal, easyCeiling: number): RunDeviation | null {
  if (!run.done) return null;
  if (run.completion != null && run.completion < 0.8) return 'short';
  const easy = run.kind === 'easy' || run.kind === 'run_walk' || run.kind === 'long';
  if (easy && run.rpe != null && run.rpe >= 8) return 'effort';
  if (easy && run.avgHr != null && run.avgHr > easyCeiling + 3) return 'heart';
  return null;
}

/** Le verdict d'une course faite, pris seul. */
export function judgeRun(run: RunSignal, easyCeiling: number): { step: RepriseStep; reason: string; medical?: boolean } {
  const pain = Math.max(run.painDuring ?? 0, run.painMorning ?? 0);
  const said = run.painDuring != null || run.painMorning != null;
  const when = run.painMorning != null && run.painMorning >= (run.painDuring ?? 0) ? 'le lendemain matin' : 'pendant la course';
  if (pain >= PAIN_STOP) {
    return { step: 'stop', reason: `une douleur de ${pain} sur 10 ${when} : plus de course tant qu'elle ne retombe pas sous ${PAIN_DOWN}` };
  }
  if (pain > 0 && run.pattern && RED_FLAG_PATTERNS.has(run.pattern)) {
    return {
      step: 'stop', medical: true,
      reason: `une douleur ${run.pattern === 'worsens' ? 'qui montait à mesure que tu courais' : 'qui reste au repos ou la nuit'} : ` +
        `c'est le motif d'une fracture de fatigue — plus de course avant l'avis d'un médecin`,
    };
  }
  if (pain >= PAIN_DOWN) return { step: 'down', reason: `une douleur de ${pain} sur 10 ${when}` };
  if (pain >= PAIN_HOLD) return { step: 'hold', reason: `une douleur de ${pain} sur 10 ${when}` };
  const deviation = deviationOf(run, easyCeiling);
  if (deviation === 'short') {
    return {
      step: 'hold',
      reason: `${Math.round(run.completion! * 100)} % de la durée prévue courue${run.cause ? ` (${CAUSE_FR[run.cause]})` : ''}`,
    };
  }
  if (deviation) {
    const what = deviation === 'effort'
      ? `un effort perçu de ${run.rpe} sur 10 sur une course facile`
      : `un cœur moyen de ${Math.round(run.avgHr!)} bpm, au-dessus de l'endurance (${easyCeiling})`;
    if (run.cause && TRANSIENT_CAUSES.has(run.cause)) {
      return { step: 'up', reason: `${what}, expliqué par ${CAUSE_FR[run.cause]} : un écart d'un jour, qui ne retient pas la reprise` };
    }
    return { step: 'hold', reason: run.cause ? `${what} — ${CAUSE_FR[run.cause]}` : what };
  }
  return { step: 'up', reason: said ? 'sans douleur' : 'courue en entier — la douleur n\'a pas été dite' };
}

/**
 * Une douleur à l'os qui se répète : deux courses faites en quinze jours, à
 * 3 ou plus, au tibia ou au pied. La dernière des deux.
 */
export function bonePattern(runs: readonly RunSignal[]): RunSignal | undefined {
  const sore = runs.filter(
    (r) => r.done && r.site != null && BONE_SITES.has(r.site) && Math.max(r.painDuring ?? 0, r.painMorning ?? 0) >= PAIN_DOWN,
  );
  for (let i = sore.length - 1; i > 0; i--) {
    const a = sore[i]!;
    const b = sore.slice(0, i).reverse().find((r) => r.site === a.site);
    if (b && (Date.parse(`${a.date}T12:00:00Z`) - Date.parse(`${b.date}T12:00:00Z`)) / 86_400_000 <= BONE_WINDOW_DAYS) return a;
  }
  return undefined;
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

  // Un arrêt médical : le motif d'une fracture de fatigue. Seul un oui du médecin, donné après, le lève.
  const bone = bonePattern(done);
  const flagged = [...done].reverse().find((r) => judgeRun(r, easyCeiling).medical);
  const medical = [bone, flagged].filter((r): r is RunSignal => r != null).sort((a, b) => b.date.localeCompare(a.date))[0];
  if (medical) {
    const cleared = answers.some(
      (a) => a.question === 'clearance' && a.subject === medicalSubject(medical.sessionId) && a.value.choice === 'yes',
    );
    const after = done.filter((r) => r.date > medical.date);
    if (!cleared) {
      return {
        step: 'stop', level: 0, medical: true,
        reason: medical === bone && medical !== flagged
          ? `une douleur de ${Math.max(medical.painDuring ?? 0, medical.painMorning ?? 0)} sur 10 au ${medical.site} pour la deuxième fois en ${BONE_WINDOW_DAYS} jours : ` +
            `c'est le motif d'une fracture de fatigue — plus de course avant l'avis d'un médecin`
          : judgeRun(medical, easyCeiling).reason,
      };
    }
    if (after.length === 0) {
      return { step: 'down', level: Math.max(1, medical.level - 1), reason: 'ton médecin a dit oui : on repart une marche sous la course qui avait inquiété' };
    }
  }

  // Un arrêt en cours : la plus récente course faite qui l'a déclenché, puis un matin sous le seuil.
  const stopped = [...done].reverse().find((r) => judgeRun(r, easyCeiling).step === 'stop' && !judgeRun(r, easyCeiling).medical);
  if (stopped && !(medical && medical.date >= stopped.date)) {
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
  // Deux courses de suite au-dessus du cœur ou de l'effort prévus : expliquées ou non, ce n'est plus un jour.
  const before = done.at(-2);
  if (verdict.step === 'up' && before) {
    const a = deviationOf(lastDone, easyCeiling);
    const b = deviationOf(before, easyCeiling);
    if ((a === 'heart' || a === 'effort') && (b === 'heart' || b === 'effort')) {
      return {
        step: 'hold', level: lastDone.level,
        reason: `deux courses de suite plus dures que prévu (${before.date} et ${lastDone.date}) : ce n'est plus un écart d'un jour`,
      };
    }
  }
  const level =
    verdict.step === 'up' ? lastDone.level + 1
      : verdict.step === 'hold' ? lastDone.level
        : verdict.step === 'down' ? Math.max(1, lastDone.level - 1)
          : 0;
  return { step: verdict.step, level, reason: verdict.reason, ...(verdict.medical ? { medical: true } : {}) };
}

/** Le sujet de la question au médecin qu'un arrêt médical rouvre. */
export const medicalSubject = (sessionId: string) => `after:${sessionId}`;

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
