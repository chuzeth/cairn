import { describe, expect, it } from 'vitest';
import type { ActivityStreams, PlannedSession, SessionBlock } from '@cairn/core';
import { mapUrl } from '@cairn/core';
import { easyClimbRate } from '@cairn/physiology';
import {
  COOLDOWN_TO_FOOT, DESCENT_EFFORT, WARMUP_TO_TOP, descentStretch, detectClimbs, downhillSession,
  elevationGainOf, elevationLossOf, groupRecurring, matchTrack, onTerrain, parseSessionBlocks, pointBelowTop,
  totalDuration, type ClimbOccurrence, type OsmWay, type TerrainHint,
} from '@cairn/coach';
import { prescribe, type WatchItem, type WatchStep } from '@cairn/garmin';
import { DECIDED_ON_2026_09_21, PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * La descente du 24/09 telle qu'elle était écrite : six descentes de 78 m, une
 * remontée de 4 min — 1 170 m/h, quand le meilleur passage de Pierre sur cette
 * montée est à 915 m/h, à fond —, et aucune montée nommée.
 */

/** Une montée qui se raidit en haut : 480 m à 9 %, puis 400 m à 19,5 % — 78 m. */
function climbTrace(): ActivityStreams {
  const segments = [
    { s: 240, v: 2, g: 0.09 },
    { s: 200, v: 2, g: 0.195 },
    { s: 60, v: 2, g: 0 },
  ];
  const time = [0];
  const distance = [0];
  const altitude = [170];
  const grade = [0];
  const velocity = [0];
  let t = 0;
  let d = 0;
  let z = 170;
  for (const seg of segments) {
    for (let i = 0; i < seg.s; i++) {
      t += 1;
      d += seg.v;
      z += seg.v * seg.g;
      time.push(t);
      distance.push(d);
      altitude.push(z);
      grade.push(seg.g);
      velocity.push(seg.v);
    }
  }
  const latlng = distance.map((m) => [45.7644 - m / 111_320, 4.8291] as [number, number]);
  return { time, distance, altitude, grade, velocity, latlng };
}

const passages = (dates: string[]): ClimbOccurrence[] =>
  dates.map((date, i) => ({
    ...detectClimbs(climbTrace())[0]!,
    activityId: `act-${i}`,
    activityName: i === dates.length - 1 ? 'Trail dans l’après-midi' : 'Intervals',
    date,
  }));

/** La rue que suit la trace, telle qu'OpenStreetMap la donne : de l'asphalte, sans une marche. */
const STREET: OsmWay = {
  id: 1,
  tags: { highway: 'residential', name: 'Montée des Essais', surface: 'asphalt' },
  geometry: [[45.7644 + 20 / 111_320, 4.8291], [45.7644 - 1100 / 111_320, 4.8291]],
};

const TERRAIN: TerrainHint = {
  climbs: groupRecurring(passages(['2026-08-10', '2026-08-11', '2026-08-17'])).map((c) => ({
    ...c,
    ground: matchTrack(c.latest.profile, [STREET], '2026-09-23T12:00:00.000Z'),
  })),
  home: [45.7644, 4.8356],
};

const Z2 = { hrRange: [141, 155] as [number, number], speedRangeMs: [2.46, 3.0] as [number, number] };

const STORED_2409: PlannedSession = {
  id: 'ses_2409', athleteId: 'pierre', date: '2026-09-24', type: 'downhill', status: 'planned', priority: 'support',
  title: 'Descente technique 6 × 3 min — 1 h 15 · 468 m D−',
  intent: 'Habituer les quadriceps au freinage.',
  blocks: [
    { label: 'Échauffement', zone: 'Z2', durationS: 1200, ...Z2 },
    { label: 'Gammes', zone: 'Z2', durationS: 180, ...Z2, notes: 'Deux passages.' },
    {
      label: 'Descentes contrôlées', zone: 'Z3', durationS: 180, repeat: 6, elevationLossM: 78,
      hrRange: [155, 171], speedRangeMs: [3.005, 3.825], cadenceTargetSpm: 180,
      recovery: { durationS: 240, zone: 'Z2', active: true, elevationGainM: 78, ...Z2 },
      notes: 'Cadence très haute, regard porté loin. Remontée en trottinant. Arrête dès que le contrôle se dégrade.',
    },
    { label: 'Retour au calme', zone: 'Z1', durationS: 600, hrRange: [0, 141], speedRangeMs: [0, 2.46] },
  ],
  plannedLoad: 57, plannedMechanicalLoad: 24, plannedDurationS: 4500, plannedElevationGainM: 468,
};

const RANDO_2709 = DECIDED_ON_2026_09_21[1]!;
const ctx = { model: PIERRE_MODEL, terrain: TERRAIN, today: '2026-09-22', descentsDone: 0 };
const repOf = (s: Pick<PlannedSession, 'blocks'>) => s.blocks.find((b) => b.repeat === 6) as SessionBlock;

describe('Le demi-tour se situe sur le profil de la montée', () => {
  it('garde du passage son sommet et son profil', () => {
    const [climb] = detectClimbs(climbTrace());
    expect(climb!.top).not.toBeNull();
    expect(climb!.profile.length).toBeGreaterThan(100);
    expect(climb!.profile[0]!.d).toBe(0);
  });

  it('78 m sous le haut, c\'est le haut de la montée, pas sa pente moyenne', () => {
    const [climb] = detectClimbs(climbTrace());
    const turn = pointBelowTop(climb!.profile, 78);
    expect(turn!.lengthM).toBeCloseTo(400, 0);
    // À la pente moyenne de la montée — 14 % —, on aurait annoncé 560 m.
    expect(78 / climb!.grade).toBeGreaterThan(540);
  });

  it('désigne la montée, le haut, le demi-tour, la longueur et la pente du tronçon', () => {
    const w = descentStretch(TERRAIN, 78)!;
    expect(w).toMatchObject({ from: { role: 'haut' }, to: { role: 'demi-tour' }, lengthM: 400, grade: 0.195 });
    expect(w.provenance).toBe('field');
    expect(w.climb).toBe('la montée des Essais');
    expect(w.ground!.runs).toEqual([
      { kind: 'route', lengthM: 400, name: 'montée des Essais', surface: 'asphalte', way: 1 },
    ]);
    expect(mapUrl(w.to)).toMatch(/^https:\/\/maps\.apple\.com\/place\?coordinate=45\.\d{6},4\.829100&name=Demi-tour$/);
  });

  it('ne désigne rien quand aucune montée ne porte le dénivelé d\'une descente', () => {
    expect(descentStretch(TERRAIN, 130)).toBeNull();
    expect(descentStretch(undefined, 78)).toBeNull();
  });
});

describe('La descente du 24/09 se lit comme une séance qu\'on court', () => {
  const [laid, rando] = onTerrain([STORED_2409, RANDO_2709], ctx);
  const rep = repOf(laid!);

  it('garde ce qui a été prescrit : six descentes de 78 m, trois minutes chacune', () => {
    expect(rep).toMatchObject({ repeat: 6, elevationLossM: 78, durationS: 180, cadenceTargetSpm: 180 });
    expect(laid!.title).toMatch(/^Descente technique 6 × 3 min — .* · 511 m D−$/);
  });

  it('se court du haut au demi-tour, et l\'échauffement mène au haut', () => {
    expect(rep.where).toMatchObject({ from: { role: 'haut' }, to: { role: 'demi-tour' }, lengthM: 400 });
    expect(rep.distanceM).toBe(400);
    expect(laid!.blocks[0]!.label).toBe(WARMUP_TO_TOP);
  });

  it('compte l\'accès : l\'échauffement monte la montée entière, 121 m', () => {
    const warmup = laid!.blocks[0]!;
    expect(warmup.elevationGainM).toBe(121);
    expect(warmup.where).toMatchObject({ from: { role: 'pied' }, to: { role: 'haut' }, lengthM: 880 });
  });

  it('ne remonte pas après la dernière descente : elle rentre par le bas, 43 m', () => {
    const back = laid!.blocks[laid!.blocks.length - 1]!;
    expect(rep.recovery!.betweenReps).toBe(true);
    expect(back).toMatchObject({ label: COOLDOWN_TO_FOOT, elevationLossM: 43 });
    expect(back.where).toMatchObject({ from: { role: 'demi-tour' }, to: { role: 'pied' }, grade: 0.09 });
    // 121 m d'accès, cinq remontées de 78 m ; six descentes de 78 m, 43 m pour rentrer.
    expect(elevationGainOf(laid!.blocks)).toBe(511);
    expect(elevationLossOf(laid!.blocks)).toBe(511);
    expect(laid!.plannedElevationGainM).toBe(511);
  });

  it('remonte en marchant, le temps que la marche facile y prend', () => {
    const rate = easyClimbRate(PIERRE_MODEL, rep.where!.grade).vamMh;
    expect(rep.recovery).toMatchObject({ zone: 'Z1', active: true, elevationGainM: 78 });
    expect(rep.recovery!.durationS).toBe(Math.ceil((78 / rate) * 60) * 60);
    expect(rep.recovery!.durationS).toBeGreaterThanOrEqual(7 * 60);
    expect(rep.recovery!.speedRangeMs).toBeUndefined();
    expect(rep.recovery!.provenance?.vam).toBeDefined();
    // La séance suit : sa durée est celle de ses blocs, sur la maille de cinq minutes.
    expect(laid!.plannedDurationS).toBe(totalDuration(laid!.blocks));
    expect(laid!.plannedDurationS % 300).toBe(0);
    expect(laid!.plannedDurationS).toBeGreaterThan(STORED_2409.plannedDurationS);
  });

  it('se pilote à l\'effort et à la technique, ni à la FC ni à une allure à plat', () => {
    expect(rep.effort).toBe(DESCENT_EFFORT);
    expect(rep.hrRange).toBeUndefined();
    expect(rep.speedRangeMs).toBeUndefined();
    expect(rep.paceRange).toBeUndefined();
    expect(rep.notes).not.toMatch(/regard porté loin|trottinant/);
  });

  it('dit, pour une première descente, que « maîtrisé » l\'emporte, et ce que les courbatures toucheront', () => {
    expect(rep.notes).toContain('Première séance de descente : « maîtrisé » l\'emporte sur « vite »');
    expect(rep.notes).toContain('pendant la rando-course du 27/09');
    const [second] = onTerrain([STORED_2409, RANDO_2709], { ...ctx, descentsDone: 1 });
    expect(repOf(second!).notes).not.toContain('Première');
  });

  it('nomme la montée de la rando-course, du pied au haut, sans toucher à son contenu', () => {
    const w = rando!.blocks[0]!.where;
    expect(w).toMatchObject({ from: { role: 'pied' }, to: { role: 'haut' } });
    for (const k of ['plannedDurationS', 'plannedLoad', 'plannedMechanicalLoad', 'plannedElevationGainM'] as const) {
      expect(rando![k]).toEqual(RANDO_2709[k]);
    }
  });

  it('ne change plus une séance déjà posée', () => {
    const again = onTerrain([laid!, rando!], ctx);
    expect(JSON.stringify(again)).toBe(JSON.stringify([laid, rando]));
  });

  it('laisse intacte une descente décidée, et le passé', () => {
    const decided = { ...STORED_2409, decision: { at: '2026-09-21T10:00:00Z', by: 'coach' as const, summary: 'Gardée.' } };
    const past = { ...STORED_2409, date: '2026-09-21' };
    const [a, b] = onTerrain([decided, past], ctx);
    expect(a).toBe(decided);
    expect(b).toBe(past);
  });

  it('remonte à la marche facile même sans montée connue, et le déclare par défaut', () => {
    const [bare] = onTerrain([STORED_2409], { ...ctx, terrain: undefined });
    const r = repOf(bare!);
    expect(r.where).toBeUndefined();
    expect(bare!.blocks[0]!.label).toBe('Échauffement');
    expect(r.recovery!.durationS).toBe(Math.ceil((78 / easyClimbRate(PIERRE_MODEL, 0.15).vamMh) * 60) * 60);
    expect(r.recovery!.provenance?.vam).toBe('default');
  });
});

describe('Sur la montre, la remontée attend l\'athlète en haut', () => {
  const [laid] = onTerrain([STORED_2409], ctx);
  const p = prescribe(laid!);
  if (!p.sendable) throw new Error('séance non envoyable');
  const group = p.workout.items.find((i): i is Extract<WatchItem, { kind: 'repeat' }> => i.kind === 'repeat')!;
  const [down, up] = group.items as WatchStep[];

  it('la descente s\'arrête au demi-tour, la remontée au bouton du tour', () => {
    // Cinq descentes remontent, la sixième non : elle se tient seule après le
    // groupe, et c'est le retour au calme qui ramène au pied.
    expect(group.times).toBe(5);
    const at = p.workout.items.indexOf(group);
    expect((p.workout.items[at + 1] as WatchStep).note).toBe(down!.note);
    expect(down!.end).toEqual({ type: 'distance', meters: 400 });
    expect(up!.end).toEqual({ type: 'lap' });
    expect(down!.target).toEqual({ type: 'none' });
    expect(up!.target).toEqual({ type: 'none' });
  });

  it('la note dit l\'effort, le tronçon et le demi-tour, jamais une FC ni une allure', () => {
    expect(down!.note).toContain(DESCENT_EFFORT);
    expect(down!.note).toContain('Descends 3 min, fais demi-tour, remonte en marchant entre les descentes. Demi-tour : 45.');
    expect(down!.note).not.toMatch(/FC|allure à plat/);
    expect(up!.note).toMatch(/^Remontée en marchant jusqu'au haut : FC sous 141, 78 m D\+, environ \d+ min\. Tour en haut/);
  });
});

describe('Une remontée se juge sur la marche, pas sur la courbe à fond', () => {
  const descent = (recoveryS: number) => [
    {
      label: 'Descentes', zone: 'Z3', durationS: 180, repeat: 6, elevationLossM: 78, effort: DESCENT_EFFORT,
      recovery: { durationS: recoveryS, zone: 'Z1', elevationGainM: 78 },
    },
  ];

  it('refuse 78 m remontés en 4 min, et dit le temps que la marche y prend', () => {
    expect(() => parseSessionBlocks(descent(240), PIERRE_MODEL)).toThrow(
      /78 m de D\+ en 4 min exigent 1170 m\/h ; une récupération qui remonte se fait à allure facile, \d+ m\/h en marchant/,
    );
  });

  it('accepte la remontée que la marche finance, sans allure à plat ni FC sur la descente', () => {
    const [b] = parseSessionBlocks(descent(8 * 60), PIERRE_MODEL);
    expect(b).toMatchObject({ effort: DESCENT_EFFORT });
    expect(b!.hrRange).toBeUndefined();
    expect(b!.recovery!.speedRangeMs).toBeUndefined();
    expect(b!.recovery!.hrRange).toBeDefined();
  });

  it('refuse une FC posée sur un bloc piloté à l\'effort, et un tronçon saisi à la main', () => {
    expect(() => parseSessionBlocks([{ ...descent(480)[0], hrRange: [150, 170] }], PIERRE_MODEL)).toThrow(
      /blocks\[0\]\.hrRange : un bloc piloté à l'effort/,
    );
    expect(() => parseSessionBlocks([{ ...descent(480)[0], where: {} }], PIERRE_MODEL)).toThrow(/blocks\[0\]\.where/);
  });

  it('laisse au gabarit sa descente entière : la remontée n\'impose plus de raboter', () => {
    const s = downhillSession(PIERRE_MODEL, 6, 3, TERRAIN);
    const r = repOf(s);
    expect(s.amendments).toBeUndefined();
    expect(r.elevationLossM).toBe(90);
    expect(r.where).toMatchObject({ from: { role: 'haut' } });
    expect(r.recovery!.durationS).toBe(Math.ceil((90 / easyClimbRate(PIERRE_MODEL, r.where!.grade).vamMh) * 60) * 60);
  });
});
