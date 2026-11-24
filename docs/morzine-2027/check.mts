import * as db from '/Users/pchuze/Documents/Trail Running/packages/db/src/index.ts';
import { spikesAlong } from '/Users/pchuze/Documents/Trail Running/packages/physiology/src/index.ts';
const ss = (await db.listPlannedSessions('pierre', '2026-11-30', '2027-06-20')).filter(s => s.status !== 'cancelled' && s.status !== 'withdrawn' && s.type !== 'rest');
const by = new Map<string, any[]>();
const monday = (d: string) => { const t = new Date(d + 'T12:00:00Z'); const k = (t.getUTCDay() + 6) % 7; return new Date(t.getTime() - k * 864e5).toISOString().slice(0, 10); };
for (const s of ss) by.set(monday(s.date), [...(by.get(monday(s.date)) ?? []), s]);
const loss = (s: any) => s.blocks.reduce((a: number, b: any) => a + ((b.elevationLossM ?? 0) + (b.recovery?.elevationLossM ?? 0)) * (b.repeat ?? 1), 0);
for (const [w, list] of [...by].sort()) {
  const h = list.filter(s => s.type !== 'race').reduce((a, s) => a + s.plannedDurationS, 0) / 3600;
  const dp = list.reduce((a, s) => a + (s.plannedElevationGainM ?? 0), 0);
  const dm = list.reduce((a, s) => a + loss(s), 0);
  const L = list.filter(s => s.type !== 'race').sort((a, b) => b.plannedDurationS - a.plannedDurationS)[0]; const longest = (L?.plannedDurationS ?? 0) / 3600;
  const km = list.filter(s => s.type !== 'race').reduce((a, s) => a + (s.plannedDistanceM ?? 0), 0) / 1000;
  const q = list.filter(s => ['vo2max','threshold','tempo','hill_repeats','downhill','race_pace'].includes(s.type)).length;
  console.log(w, `${h.toFixed(1)} h`.padStart(7), `${Math.round(km)} km`.padStart(7), `D+ ${dp}`.padStart(9), `D− ${dm}`.padStart(9), `long ${longest.toFixed(1)} h ${((L?.plannedDistanceM ?? 0)/1000).toFixed(0)} km ${L?.plannedElevationGainM ?? 0} m`, `qual ${q}`, list.length + ' séances');
}
const acts = await db.listActivities('pierre', { from: '2026-10-25', limit: 50 });
const done = acts.filter(a => ['Run','TrailRun'].includes(a.sportType)).map(a => ({ date: a.startDateLocal.slice(0,10), distanceM: a.distanceM }));
const planned = ss.filter(s => s.type !== 'race' && s.plannedDistanceM).map(s => ({ id: s.id, date: s.date, distanceM: s.plannedDistanceM! }));
const spikes = spikesAlong(done, planned).filter(v => v.cls !== 'none' && v.cls !== 'no_reference');
console.log('pics de distance (> +10 % de la plus longue des 30 j):', spikes.map(v => `${v.date} ${(v.distanceM/1000).toFixed(1)} km (+${Math.round((v.ratio??0)*100)} %)`).join(' · '));
