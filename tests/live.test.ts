import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { pulseEffect } from '../apps/web/lib/live';

/**
 * L'app ouverte se tient à jour d'elle-même (Pierre, le 14/10 : « updaté en
 * live »). Le Mac rend une empreinte de ce que montrent les écrans ; l'app la
 * compare à la précédente, et la version en service à la sienne.
 */

describe('Ce que l’app fait d’un pouls', () => {
  it('ne se relit pas au premier pouls, ni quand rien n’a bougé ; se relit quand l’empreinte change', () => {
    expect(pulseEffect(null, { stamp: 'a', commit: 'c1' }, 'c1')).toEqual({ stamp: 'a', changed: false, newVersion: false });
    expect(pulseEffect('a', { stamp: 'a', commit: 'c1' }, 'c1').changed).toBe(false);
    expect(pulseEffect('a', { stamp: 'b', commit: 'c1' }, 'c1')).toEqual({ stamp: 'b', changed: true, newVersion: false });
  });

  it('se met à jour quand le Mac sert un autre commit, jamais en développement', () => {
    expect(pulseEffect('a', { stamp: 'a', commit: 'c2' }, 'c1').newVersion).toBe(true);
    expect(pulseEffect('a', { stamp: 'a', commit: 'c2' }, null).newVersion).toBe(false);
    expect(pulseEffect('a', { stamp: 'a', commit: null }, 'c1').newVersion).toBe(false);
  });

  it('garde l’empreinte connue quand la réponse ne dit rien d’utilisable', () => {
    expect(pulseEffect('a', {}, 'c1')).toEqual({ stamp: 'a', changed: false, newVersion: false });
  });
});

const dir = mkdtempSync(join(tmpdir(), 'cairn-live-'));
let db: typeof import('@cairn/db');

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(dir, 'cairn.sqlite')}`;
  db = await import('@cairn/db');
  // Les colonnes que l'empreinte lit, rien de plus : c'est elle qu'on éprouve ici.
  for (const statement of [
    'create table planned_sessions (id text, athlete_id text, created_at text, updated_at text)',
    'create table training_plans (id text, athlete_id text, updated_at text)',
    'create table activities (id text, athlete_id text, created_at text)',
    'create table activity_analyses (activity_id text, athlete_id text, computed_at text)',
    'create table physiology_models (id text, athlete_id text, created_at text)',
    `create table daily_check_ins (athlete_id text, date text, fatigue integer, sleep_hours real, sleep_quality integer,
      soreness integer, stress integer, motivation integer, resting_hr integer, hrv_rmssd real, notes text, note_handled_at text)`,
    'create table strength_tests (athlete_id text, date text, test text, updated_at text)',
    'create table race_goals (id text, athlete_id text, updated_at text)',
    'create table declared_absences (id text, athlete_id text, created_at text)',
    'create table coach_insights (id text, athlete_id text, created_at text)',
  ]) await db.getDb().run(sql.raw(statement));
});

afterAll(() => {
  db.closeDb?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('L’empreinte de ce que montrent les écrans', () => {
  it('ne bouge pas sans écriture, bouge à chaque séance, point du jour ou test écrits', async () => {
    const run = (statement: string) => db.getDb().run(sql.raw(statement));
    let last = await db.changeStamp('pierre');
    const moved = async () => {
      const now = await db.changeStamp('pierre');
      const changed = now !== last;
      last = now;
      return changed;
    };
    expect(await moved()).toBe(false);

    await run("insert into planned_sessions values ('s1', 'pierre', '2026-10-14T10:00:00Z', '2026-10-14T10:00:00Z')");
    expect(await moved()).toBe(true);
    // Le coach réécrit la séance : seule sa date de mise à jour change.
    await run("update planned_sessions set updated_at = '2026-10-14T10:05:00Z' where id = 's1'");
    expect(await moved()).toBe(true);

    // Le point du jour réécrit le même jour : aucune date ne bouge, son contenu si.
    await run("insert into daily_check_ins (athlete_id, date, fatigue) values ('pierre', '2026-10-14', 3)");
    expect(await moved()).toBe(true);
    await run("update daily_check_ins set fatigue = 4 where athlete_id = 'pierre' and date = '2026-10-14'");
    expect(await moved()).toBe(true);
    await run("update daily_check_ins set note_handled_at = '2026-10-14T11:00:00Z' where athlete_id = 'pierre'");
    expect(await moved()).toBe(true);

    await run("insert into strength_tests values ('pierre', '2026-11-01', 'test-mollets', '2026-11-01T18:00:00Z')");
    expect(await moved()).toBe(true);
    await run("insert into physiology_models values ('m2', 'pierre', '2026-10-14T12:00:00Z')");
    expect(await moved()).toBe(true);

    expect(await moved()).toBe(false);
    // Un autre athlète n'y change rien.
    await run("insert into daily_check_ins (athlete_id, date, fatigue) values ('autre', '2026-10-14', 1)");
    expect(await moved()).toBe(false);
  });
});
