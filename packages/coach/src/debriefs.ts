import type { Activity, AthleteAnswer, PhysiologyModel, PlannedSession, PmcSeries } from '@cairn/core';
import { debriefSession, referenceGapOf, type DebriefRun, type SessionDebrief } from '@cairn/physiology';

/**
 * Les comptes rendus de plusieurs sorties à partir de ce qui est déjà chargé —
 * l'historique, le plan, les réponses, la charge —, sans rien aller chercher.
 * L'état de l'athlète (`state.ts`) et l'écran d'une sortie (`lessons.ts`) le
 * partagent : la même sortie dit la même chose partout.
 */

const RUNS = new Set(['Run', 'TrailRun', 'VirtualRun']);
export const isRunActivity = (a: Pick<Activity, 'sportType'>) => RUNS.has(a.sportType);

/** L'allure de référence de l'athlète, tirée de son test de laboratoire. */
export function referenceGapFor(profile: { labTests: { vt1: { speedMs: number } }[] }, model: PhysiologyModel): number {
  return referenceGapOf(profile.labTests[0]?.vt1.speedMs ?? model.vt1.speedMs);
}

/** Ce que l'athlète a dit d'une séance : sa douleur, son effort. */
export function saidAbout(
  answers: readonly AthleteAnswer[],
  sessionId: string | undefined,
  activity: Pick<Activity, 'rpe'>,
): { pain: { score: number; site?: string | null } | null; rpe: number | null } {
  const latest = (question: AthleteAnswer['question']) =>
    sessionId
      ? answers
          .filter((a) => a.question === question && a.subject === sessionId)
          .sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))[0]
      : undefined;
  const pain = latest('run_pain');
  const rpe = latest('run_rpe');
  return {
    pain: pain?.value.score != null ? { score: pain.value.score, site: pain.value.site ?? null } : null,
    rpe: rpe?.value.score ?? activity.rpe ?? null,
  };
}

/** La charge au matin d'un jour : le point de la veille. */
export function loadOnMorning(pmc: PmcSeries, date: string) {
  const before = (xs: { date: string }[]) => xs.filter((p) => p.date < date).at(-1);
  const met = before(pmc.metabolic) as PmcSeries['metabolic'][number] | undefined;
  const mech = before(pmc.mechanical) as PmcSeries['mechanical'][number] | undefined;
  return met && mech ? { ctl: met.ctl, atl: met.atl, tsb: met.tsb, mechanicalTsb: mech.tsb } : null;
}

export interface DebriefWorld {
  history: readonly DebriefRun[];
  model: PhysiologyModel;
  referenceGapMs: number;
  /** Les séances du plan autour des sorties : celle qu'une sortie réalise s'y trouve. */
  sessions: readonly PlannedSession[];
  answers: readonly AthleteAnswer[];
  pmc: PmcSeries | null;
}

/** Le compte rendu d'une sortie de l'historique. */
export function debriefRun(run: DebriefRun, world: DebriefWorld): SessionDebrief {
  const date = run.activity.startDateLocal.slice(0, 10);
  const planned =
    world.sessions.find((s) => s.completedActivityId === run.activity.id) ??
    (run.analysis?.compliance ? world.sessions.find((s) => s.id === run.analysis!.compliance!.plannedSessionId) : undefined) ??
    null;
  const said = saidAbout(world.answers, planned?.id, run.activity);
  return debriefSession({
    run,
    history: world.history,
    model: world.model,
    referenceGapMs: world.referenceGapMs,
    context: {
      load: world.pmc ? loadOnMorning(world.pmc, date) : null,
      planned,
      pain: said.pain,
      rpe: said.rpe,
      airTempC: null,
    },
  });
}
