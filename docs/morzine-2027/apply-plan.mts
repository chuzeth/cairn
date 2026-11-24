import * as db from '/Users/pchuze/Documents/Trail Running/packages/db/src/index.ts';
import { executeTool, sessionTotals } from '/Users/pchuze/Documents/Trail Running/packages/coach/src/index.ts';
import { WEEKS } from './plan-spec.mts';
const APPLY = process.env.APPLY === '1';
const FROM = Number(process.env.FROM_WEEK ?? 1);
const TO = Number(process.env.TO_WEEK ?? 99);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function tool(name: string, input: any): Promise<any> {
  for (let i = 0; ; i++) {
    try { return await executeTool('pierre', name, input); }
    catch (e: any) { if (i < 20 && /SQLITE_BUSY|database is locked/.test(String(e?.message ?? e) + String(e?.cause ?? ''))) { await sleep(1500); continue; } throw e; }
  }
}
const add = (d: string, n: number) => new Date(Date.parse(d + 'T12:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(b + 'T12:00:00Z') - Date.parse(a + 'T12:00:00Z')) / 864e5);
const model = (await db.getLatestModel('pierre'))!;
const sessions = await db.listPlannedSessions('pierre', '2026-11-30', '2027-06-20');
const live = sessions.filter(s => s.status !== 'cancelled' && s.status !== 'withdrawn');
// Les distances de référence : les courses faites, puis celles du plan au fil de l'écriture.
const acts = await db.listActivities('pierre', { from: '2026-10-25', limit: 80 });
const refs: { date: string; m: number }[] = acts.filter(a => ['Run', 'TrailRun'].includes(a.sportType)).map(a => ({ date: a.startDateLocal.slice(0, 10), m: a.distanceM }));
const capOn = (date: string) => 1.1 * Math.max(0, ...refs.filter(r => r.date < date && days(r.date, date) <= 30).map(r => r.m));
/** Ramène une sortie sous le plafond de pic : le plat d'abord, puis une montée. */
function fit(blocks: any[], cap: number): { blocks: any[]; note?: string } {
  let b = structuredClone(blocks);
  const dist = () => sessionTotals(model, b).distanceM;
  const before = dist();
  if (before <= cap) return { blocks: b };
  for (let i = 0; i < 60 && dist() > cap; i++) {
    const flats = b.filter((x: any) => /approche|^Retour$|^Footing$|^Sortie longue vallonnée$/.test(x.label) && x.durationS > 600);
    if (flats.length) { for (const f of flats) f.durationS = Math.max(600, Math.round(f.durationS * 0.9 / 30) * 30); continue; }
    const climbs = b.filter((x: any) => /^Montées/.test(x.label) && (x.repeat ?? 1) > 1);
    if (climbs.length) { climbs.at(-1).repeat -= 1; continue; }
    break;
  }
  return { blocks: b, note: `ramenée de ${(before / 1000).toFixed(1)} à ${(dist() / 1000).toFixed(1)} km (plafond de pic ${(cap / 1000).toFixed(1)} km)` };
}
let ok = 0, refused: string[] = [], missing: string[] = [], cancelled = 0, fitted: string[] = [];
for (const w of WEEKS) {
  if (w.n > TO) break;
  if (w.n < FROM) {
    for (let i = 0; i < 7; i++) { const date = add(w.monday, i); const s = live.find(x => x.date === date && x.type !== 'race' && x.type !== 'rest'); if (s && w.days[i]) refs.push({ date, m: sessionTotals(model, w.days[i]!.blocks).distanceM }); }
    continue;
  }
  for (let i = 0; i < 7; i++) {
    const date = add(w.monday, i);
    const day = w.days[i];
    const here = live.filter(s => s.date === date);
    if (here.some(s => s.type === 'race')) continue;
    if (!day) {
      for (const s of here.filter(s => s.type !== 'rest')) {
        if (APPLY) await tool('modify_session', { session_id: s.id, status: 'cancelled', apply: true, rationale: `Plan Morzine 2027, semaine ${w.n} : jour de repos.` });
        cancelled++;
      }
      continue;
    }
    const s = here[0];
    if (!s) { missing.push(date); continue; }
    const cap = capOn(date);
    const f = cap > 0 ? fit(day.blocks, cap) : { blocks: day.blocks };
    if (f.note) fitted.push(`${date} ${f.note}`);
    const input = { session_id: s.id, type: day.type, blocks: f.blocks, apply: APPLY, rationale: `Plan Morzine 2027, semaine ${w.n} (${w.phase}) : ${day.why}` };
    try {
      await tool('modify_session', input);
      refs.push({ date, m: sessionTotals(model, f.blocks).distanceM });
      ok++;
    } catch (e: any) {
      refused.push(`${date} ${day.why.slice(0, 50)} → ${String(e.message).slice(0, 300)}`);
    }
  }
}
console.log({ ok, cancelled, missing, refused: refused.length });
for (const r of refused) console.log(' ✗', r);
for (const r of fitted) console.log(' ↘', r);
