import { GarminRejected, type GarminApi, type WatchSync } from './connect.js';
import {
  monthsOf, planReconciliation, type CalendarWorkout, type DesiredState, type DesiredWorkout, type LedgerEntry,
} from './reconcile.js';
import { compareWorkouts, decodeWorkout, encodeWorkout } from './workout.js';

/**
 * Un passage du réconciliateur : relire, décider, écrire, relire.
 *
 * Chaque séance créée est relue aussitôt et comparée étape par étape à sa
 * prescription ; le calendrier est relu à la fin pour vérifier que ce qui
 * devait y être y est, et que ce qui devait en partir en est parti. Rien n'est
 * « envoyé » sans relecture : une séance créée et pas encore relue reste « en
 * attente » dans le registre, et c'est lui que l'écran lit.
 *
 * Le registre est écrit au fil de l'eau — une séance créée y entre avant même
 * d'être planifiée. Un passage interrompu, par le réseau ou par le sommeil du
 * Mac, laisse donc un état que le passage suivant sait reprendre.
 */

export interface LedgerStore {
  list(): Promise<LedgerEntry[]>;
  insert(entry: LedgerEntry): Promise<void>;
  update(workoutId: number, patch: Partial<LedgerEntry>): Promise<void>;
}

/** Une séance que Garmin a refusée, et ce qu'il en a dit. */
export interface Rejection {
  date: string;
  fingerprint: string;
  message: string;
}

export interface ReconcileReport {
  created: number;
  removed: number;
  kept: number;
  verified: number;
  mismatched: number;
  rejected: Rejection[];
  watch: WatchSync | null;
}

export async function reconcile(
  api: GarminApi,
  ledger: LedgerStore,
  state: DesiredState,
  now: () => Date = () => new Date(),
): Promise<ReconcileReport> {
  const stamp = () => now().toISOString();
  const readCalendar = async (): Promise<CalendarWorkout[]> => {
    const out: CalendarWorkout[] = [];
    for (const m of monthsOf(state.today, state.horizon)) out.push(...(await api.calendar(m.year, m.month)));
    return out;
  };

  const report: ReconcileReport = { created: 0, removed: 0, kept: 0, verified: 0, mismatched: 0, rejected: [], watch: null };
  const ops = planReconciliation({ state, ledger: await ledger.list(), calendar: await readCalendar() });

  const verify = async (workoutId: number, desired: DesiredWorkout) => {
    const back = await api.getWorkout(workoutId);
    const discrepancies = back == null
      ? ['La séance créée est introuvable sur Garmin.']
      : compareWorkouts(desired.workout, decodeWorkout(back)).map((d) => d.text);
    await ledger.update(workoutId, {
      state: discrepancies.length ? 'mismatch' : 'verified',
      discrepancies: discrepancies.length ? discrepancies : null,
      verifiedAt: stamp(),
    });
    if (discrepancies.length) report.mismatched++;
    else report.verified++;
  };

  // Les retraits d'abord : la montre peut rester un moment sans séance pour ce
  // jour, jamais avec deux versions dont une fausse.
  // Une séance retirée ne passe « supprimée » au registre qu'une fois le
  // calendrier relu sans elle : interrompu avant, le passage suivant la
  // retrouve vivante et termine le travail.
  const removedWorkouts = new Set<number>();
  const removedSchedules = new Set<number>();
  for (const op of ops) {
    if (op.op !== 'remove') continue;
    if (op.deleteWorkout) {
      await api.deleteWorkout(op.entry.workoutId);
      removedWorkouts.add(op.entry.workoutId);
    } else {
      for (const id of op.scheduleIds) {
        await api.unschedule(id);
        removedSchedules.add(id);
      }
    }
    report.removed++;
  }

  const created = new Map<number, DesiredWorkout>();
  for (const op of ops) {
    if (op.op !== 'create') continue;
    const d = op.desired;
    let workoutId: number;
    try {
      workoutId = await api.createWorkout(encodeWorkout(d.workout));
    } catch (e) {
      if (!(e instanceof GarminRejected)) throw e;
      report.rejected.push({ date: d.date, fingerprint: d.fingerprint, message: e.message });
      continue;
    }
    await ledger.insert({
      workoutId, scheduleId: null, sessionId: d.sessionId, date: d.date, fingerprint: d.fingerprint,
      name: d.workout.name, state: 'sending', discrepancies: null, sentAt: null, verifiedAt: null, deletedAt: null,
    });
    report.created++;
    try {
      const scheduleId = await api.schedule(workoutId, d.date);
      await ledger.update(workoutId, { scheduleId, sentAt: stamp() });
    } catch (e) {
      if (!(e instanceof GarminRejected)) throw e;
      await ledger.update(workoutId, { state: 'mismatch', discrepancies: [`Garmin refuse de la planifier : ${e.message}`] });
      report.mismatched++;
      continue;
    }
    created.set(workoutId, d);
    await verify(workoutId, d);
  }

  for (const op of ops) {
    if (op.op !== 'keep') continue;
    report.kept++;
    if (op.verify) await verify(op.entry.workoutId, op.desired);
  }

  // Ce que le calendrier porte après coup : chaque séance créée à sa date, et
  // plus rien de ce qu'on a retiré. Une planification qui aurait survécu à la
  // suppression de sa séance est retirée, puis vérifiée à son tour.
  if (created.size > 0 || report.removed > 0) {
    const leftover = (cal: CalendarWorkout[]) =>
      cal.filter((i) => (i.workoutId != null && removedWorkouts.has(i.workoutId)) || removedSchedules.has(i.scheduleId));
    let after = await readCalendar();
    const survivors = leftover(after);
    if (survivors.length > 0) {
      for (const s of survivors) await api.unschedule(s.scheduleId);
      after = await readCalendar();
      const stubborn = leftover(after);
      if (stubborn.length > 0) {
        throw new Error(
          `Retrait non confirmé par le calendrier Garmin : ${stubborn.map((s) => `« ${s.title} » le ${s.date}`).join(', ')}.`,
        );
      }
    }
    for (const workoutId of removedWorkouts) await ledger.update(workoutId, { state: 'deleted', deletedAt: stamp() });
    for (const [workoutId, d] of created) {
      if (after.some((i) => i.workoutId === workoutId && i.date === d.date)) continue;
      const entry = (await ledger.list()).find((e) => e.workoutId === workoutId);
      await ledger.update(workoutId, {
        state: 'mismatch',
        discrepancies: [...(entry?.discrepancies ?? []), `Absente du calendrier Garmin au ${d.date}.`],
      });
      if (entry?.state === 'verified') {
        report.verified--;
        report.mismatched++;
      }
    }
  }

  // L'heure de synchronisation de la montre n'est qu'un complément : sans elle,
  // l'écran dit « sur Garmin Connect » au lieu de « sur ta montre ».
  report.watch = await api.watch().catch(() => null);
  return report;
}
