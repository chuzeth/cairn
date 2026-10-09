import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

/**
 * Les résultats des tests de force, enregistrés sur une base jetable.
 *
 * Le 09/10, Pierre note ses tests pendant qu'il les fait : la jambe gauche,
 * puis la droite, puis une correction. Rien de ce qui a été noté ne doit se
 * perdre en chemin.
 */

const dir = mkdtempSync(join(tmpdir(), 'cairn-tests-'));
let db: typeof import('@cairn/db');

beforeAll(async () => {
  process.env.DATABASE_URL = `file:${join(dir, 'cairn.sqlite')}`;
  db = await import('@cairn/db');
});

afterAll(() => {
  db.closeDb?.();
  rmSync(dir, { recursive: true, force: true });
});

describe('Les résultats des tests', () => {
  it('gardent la jambe gauche quand la droite arrive, et effacent sur demande', async () => {
    await db.saveStrengthTest('pierre', '2026-10-09', 'test-mollets', { left: 28 });
    await db.saveStrengthTest('pierre', '2026-10-09', 'test-mollets', { right: 31 });
    let [r] = await db.listStrengthTests('pierre');
    expect([r!.test, r!.left, r!.right]).toEqual(['test-mollets', 28, 31]);

    await db.saveStrengthTest('pierre', '2026-10-09', 'test-mollets', { left: 29, right: null });
    [r] = await db.listStrengthTests('pierre');
    expect([r!.left, r!.right]).toEqual([29, undefined]);
  });

  it('rangent un résultat par test et par jour, du premier jour au dernier', async () => {
    await db.saveStrengthTest('pierre', '2026-11-01', 'test-chaise', { value: 185 });
    await db.saveStrengthTest('pierre', '2026-10-09', 'test-chaise', { value: 150 });
    const chaise = (await db.listStrengthTests('pierre')).filter((r) => r.test === 'test-chaise');
    expect(chaise.map((r) => [r.date, r.value])).toEqual([['2026-10-09', 150], ['2026-11-01', 185]]);
  });
});
