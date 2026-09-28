import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { ActivityStreams, AthleteHome, PlannedSession, SessionRoute } from '@cairn/core';
import { itinerary, passagesOf, routeTrack, toGpx } from '@cairn/core';
import {
  HOME_PRIVACY_M, MIN_DETOUR_S, altitudeIndex, buildRoute, climbAndDrop, crossingsOf, descentLoopFit, detectClimbs,
  directions, findLoops, footRouteFrom, groupRecurring, haversineM, lightTrace, longTrail, loopRefusal, maneuverText,
  matchTrack, onTerrain, profileAlong, reliefOf, trailPick, type AltitudeIndex, type ClimbLoop, type ClimbOccurrence,
  type FootRoute, type LightTrace, type OsmWay, type RouteServices, type TerrainHint,
} from '@cairn/coach';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * L'itinéraire de porte à porte.
 *
 * Le terrain est synthétique : un escalier qui monte au nord, une montée
 * goudronnée au nord-est, parties du même pied, et une sortie qui est passée
 * d'un haut à l'autre. Le domicile est un point de test à 600 m du pied — pas
 * celui de l'athlète, qui n'est écrit nulle part dans le dépôt.
 */

const O: [number, number] = [45.75, 4.8];
const KX = 111_320 * Math.cos((O[0] * Math.PI) / 180);
/** Un point à `n` mètres au nord et `e` mètres à l'est de l'origine. */
const at = (n: number, e: number): [number, number] => [
  Math.round((O[0] + n / 111_320) * 1e6) / 1e6,
  Math.round((O[1] + e / KX) * 1e6) / 1e6,
];

type Way3 = [number, number, number];
/** Une sortie à 2,5 m/s le long de ces points : nord, est, altitude. */
function stream(path: Way3[]): ActivityStreams {
  const time = [0];
  const distance = [0];
  const altitude = [path[0]![2]];
  const grade = [0];
  const velocity = [0];
  const latlng: ([number, number] | null)[] = [at(path[0]![0], path[0]![1])];
  let t = 0;
  let d = 0;
  for (let k = 1; k < path.length; k++) {
    const [n0, e0, z0] = path[k - 1]!;
    const [n1, e1, z1] = path[k]!;
    const len = Math.hypot(n1 - n0, e1 - e0);
    const steps = Math.max(1, Math.round(len / 2.5));
    for (let s = 1; s <= steps; s++) {
      const f = s / steps;
      t += 1;
      d += len / steps;
      time.push(t);
      distance.push(d);
      altitude.push(z0 + f * (z1 - z0));
      grade.push(len > 0 ? (z1 - z0) / len : 0);
      velocity.push(len / steps);
      latlng.push(at(n0 + f * (n1 - n0), e0 + f * (e1 - e0)));
    }
  }
  return { time, distance, altitude, grade, velocity, latlng };
}

const START: Way3 = [-100, 0, 170];
const FOOT: Way3 = [0, 0, 170];
const TOP_A: Way3 = [500, 0, 270];
const TOP_B: Way3 = [636, 636, 260];
const CROSS: Way3[] = [TOP_A, [560, 320, 272], TOP_B];

const ACTIVITIES: { id: string; date: string; path: Way3[] }[] = [
  // La boucle : l'escalier, le plateau, la montée redescendue.
  { id: 'act-1', date: '2026-08-01', path: [START, FOOT, TOP_A, ...CROSS.slice(1), FOOT] },
  { id: 'act-2', date: '2026-08-05', path: [START, FOOT, TOP_A, FOOT] },
  { id: 'act-3', date: '2026-08-08', path: [START, FOOT, TOP_B, FOOT] },
  { id: 'act-4', date: '2026-08-10', path: [START, FOOT, TOP_B, FOOT, START] },
];

const STREAMS = ACTIVITIES.map((a) => ({ ...a, streams: stream(a.path) }));
const TRACES: LightTrace[] = STREAMS.map((a) => lightTrace(a.id, a.date, a.streams));

const way = (id: number, tags: Record<string, string>, pts: [number, number][]): OsmWay => ({
  id,
  tags,
  geometry: pts.map(([n, e]) => at(n, e)),
});
const STAIRS = way(1, { highway: 'steps', name: 'Escaliers du Test', step_count: '600' }, [[-10, 0], [510, 0]]);
const STAIRS_B = way(4, { highway: 'steps', name: 'Montée du Test' }, [[-7, -7], [643, 643]]);
const ROAD_B = way(2, { highway: 'residential', name: 'Montée du Test', surface: 'asphalt' }, [[-7, -7], [643, 643]]);
const PLATEAU = way(3, { highway: 'residential', name: 'Rue du Plateau', surface: 'asphalt' }, [[500, -10], [560, 320], [643, 643]]);
const READ_AT = '2026-09-23T12:00:00.000Z';

function terrainWith(ways: OsmWay[]): TerrainHint {
  const occurrences: ClimbOccurrence[] = STREAMS.flatMap((a) =>
    detectClimbs(a.streams).map((c) => ({ ...c, activityId: a.id, activityName: 'Sortie', date: a.date })),
  );
  const climbs = groupRecurring(occurrences).map((c) => ({ ...c, ground: matchTrack(c.latest.profile, ways, READ_AT) }));
  const loops: ClimbLoop[] = findLoops(climbs, TRACES).map((l) => ({
    ...l,
    over: { ...l.over, ground: matchTrack(l.over.profile, ways, READ_AT) },
  }));
  return { climbs, loops };
}

const TERRAIN = terrainWith([STAIRS, ROAD_B, PLATEAU]);
const HOME: AthleteHome = { at: at(0, 600), address: '1 rue du Test' };
const FLAT: AltitudeIndex = { at: () => 170 };

/** Un monde sans réseau : des trajets en ligne droite, des noms de test, et chaque question notée. */
function world() {
  const asked: { kind: string; at: readonly [number, number] }[] = [];
  const line = (pts: readonly (readonly [number, number])[]): FootRoute => {
    const steps = pts.slice(1).map((p, k) => ({
      distanceM: Math.round(haversineM(pts[k]!, p) * 10) / 10,
      name: k === 0 ? '' : 'Quai du Test',
      type: k === 0 ? 'depart' : 'continue',
      modifier: 'straight',
      at: [pts[k]![0], pts[k]![1]] as [number, number],
      track: [[pts[k]![0], pts[k]![1]], [p[0], p[1]]] as [number, number][],
    }));
    const last = pts[pts.length - 1]!;
    return {
      distanceM: steps.reduce((s, x) => s + x.distanceM, 0),
      track: pts.map((p) => [p[0], p[1]] as [number, number]),
      steps: [...steps, { distanceM: 0, name: '', type: 'arrive', at: [last[0], last[1]], track: [[last[0], last[1]]] }],
    };
  };
  const services: RouteServices = {
    route: async (pts) => {
      asked.push({ kind: 'route', at: pts[0]! });
      return line(pts);
    },
    table: async (from, to) => to.map((t) => Math.round(haversineM(from, t) * 1.2)),
    road: async (p) => {
      asked.push({ kind: 'road', at: p });
      return 'Rue du Test';
    },
    address: async (p) => {
      asked.push({ kind: 'address', at: p });
      return '12 quai du Test';
    },
    landmark: async (p) => {
      asked.push({ kind: 'landmark', at: p });
      return null;
    },
  };
  return { asked, services };
}

const perBlock = (r: SessionRoute) => {
  const out = new Map<number, number>();
  for (const l of r.legs) out.set(l.block, (out.get(l.block) ?? 0) + l.durationS);
  return out;
};

// ─────────────────────────────────────────────────────────────────────────────

describe('Les boucles du terrain', () => {
  it("trouve le chemin d'un haut à l'autre sur la trace qui l'a couru", () => {
    const [a, b] = [...TERRAIN.climbs].sort((x, y) => x.gainM - y.gainM).reverse();
    const crossings = crossingsOf(a!, b!, TRACES);
    expect(crossings).toHaveLength(1);
    expect(crossings[0]!.activityId).toBe('act-1');
    expect(crossings[0]!.lengthM).toBeGreaterThan(600);
    expect(crossings[0]!.lengthM).toBeLessThan(720);
    // Personne n'est allé du haut de la montée au haut de l'escalier.
    expect(crossingsOf(b!, a!, TRACES)).toHaveLength(0);
  });

  it("monte l'escalier à pied et redescend par la montée sans marches", () => {
    const { choice, skipped } = trailPick(TERRAIN, 680, 0.09);
    expect(choice?.loop).toBeDefined();
    expect(choice!.climb.gainM).toBe(100);
    expect(skipped).toHaveLength(0);
    // 100 m d'escalier et les bosses du plateau par tour : sept tours font les 680 m à 10 % près.
    expect(choice!.passages).toBe(7);
    expect(Math.abs(choice!.gainM - 680)).toBeLessThanOrEqual(68);
  });

  it("n'accepte pas une boucle qui redescend des marches", () => {
    const stairsDown = terrainWith([STAIRS, STAIRS_B, PLATEAU]);
    expect(loopRefusal(stairsDown.loops![0]!)).toMatchObject({ reason: 'escalier' });
    const { choice } = trailPick(stairsDown, 680, 0.09);
    expect(choice).toBeNull();
  });

  it("n'accepte pas une boucle dont le chemin d'un haut à l'autre n'a pas pu être lu", () => {
    const unread = { ...TERRAIN, loops: TERRAIN.loops!.map((l) => ({ ...l, over: { ...l.over, ground: null } })) };
    expect(loopRefusal(unread.loops[0]!)).toMatchObject({ reason: 'sol inconnu' });
    // Sans boucle, la rando-course redescend la montée goudronnée par où elle l'a montée.
    const { choice } = trailPick(unread, 680, 0.09);
    expect(choice?.loop).toBeUndefined();
    expect(choice?.climb.gainM).toBe(90);
  });

  it('se dit comme on la court : monter à pied, redescendre par une autre voie, n fois', () => {
    const t = longTrail(PIERRE_MODEL, 180, 680, TERRAIN);
    const b = t.blocks.find((x) => x.where)!;
    expect(b.where!.back).toBeDefined();
    expect(passagesOf(b, b.where!)).toBe(7);
    expect(itinerary(b)).toMatch(/^Monte à pied .*jusqu'en haut, redescends par la rue du Plateau puis la montée du Test, 7 fois\.$/);
    expect(b.notes).toMatch(/7 tours : monte à pied/);
  });
});

describe('La remontée en boucle ne se prescrit que si elle tient dans la récupération', () => {
  it('se juge sur ce que la marche y prend', () => {
    const fit = descentLoopFit(PIERRE_MODEL, TERRAIN, 78, 3600);
    expect(fit?.fits).toBe(true);
    const tight = descentLoopFit(PIERRE_MODEL, TERRAIN, 78, 60);
    expect(tight?.fits).toBe(false);
    expect(tight!.walkS).toBe(fit!.walkS);
  });
});

describe("Les indications d'un trajet", () => {
  it('se disent au présent, à la deuxième personne', () => {
    expect(maneuverText('turn', 'left', 'rue Cléberg')).toBe('Prends à gauche la rue Cléberg');
    expect(maneuverText('turn', 'slight right', 'pont Bonaparte')).toBe('Prends légèrement à droite et traverse le pont Bonaparte');
    expect(maneuverText('end of road', 'left', null)).toBe('Au bout, tourne à gauche');
    expect(maneuverText('new name', 'straight', 'quai Pierre Scize')).toBe('Continue sur le quai Pierre Scize');
    expect(maneuverText('roundabout', undefined, 'avenue du Test', 2)).toBe('Au rond-point, prends la 2e sortie, l\'avenue du Test');
  });

  const SAINT_PAUL = footRouteFrom(JSON.parse(readFileSync(new URL('./fixtures/osrm-saint-paul.json', import.meta.url), 'utf8')))!;

  it("nomment par géocodage inverse ce qu'OSRM ne nomme pas, et fusionnent les portions d'une même voie", async () => {
    const { services } = world();
    const far: AthleteHome = { at: at(-5000, 0), address: 'ailleurs' };
    const steps = await directions(SAINT_PAUL, { home: far, services });
    // Quinze manœuvres d'OSRM, dont les minuscules : quelques lignes.
    expect(SAINT_PAUL.steps).toHaveLength(15);
    expect(steps.length).toBeLessThan(6);
    expect(steps.every((s) => /^\p{Lu}.*\.$/u.test(s.text))).toBe(true);
    expect(steps.reduce((s, x) => s + x.distanceM, 0)).toBeCloseTo(SAINT_PAUL.distanceM, -1);
  });

  it("n'envoient aucun point proche du domicile au géocodage", async () => {
    const { asked, services } = world();
    // Le domicile de test au départ du trajet : 311 m, dont l'essentiel dans son rayon.
    const home: AthleteHome = { at: SAINT_PAUL.track[0]!, address: 'gare' };
    await directions(SAINT_PAUL, { home, services }, { fromHome: true });
    for (const q of asked.filter((x) => x.kind !== 'route')) {
      expect(haversineM(q.at, home.at)).toBeGreaterThanOrEqual(HOME_PRIVACY_M);
    }
  });
});

describe("L'itinéraire d'une séance", () => {
  const Z2 = { hrRange: [141, 155] as [number, number], speedRangeMs: [2.46, 3.0] as [number, number] };
  const STORED: PlannedSession = {
    id: 'ses_test', athleteId: 'pierre', date: '2026-09-24', type: 'downhill', status: 'planned', priority: 'support',
    title: 'Descente technique 6 × 3 min', intent: 'Freiner.',
    blocks: [
      { label: 'Échauffement', zone: 'Z2', durationS: 1200, ...Z2 },
      { label: 'Gammes', zone: 'Z2', durationS: 120, ...Z2 },
      {
        label: 'Descentes contrôlées', zone: 'Z3', durationS: 180, repeat: 6, elevationLossM: 78,
        hrRange: [155, 171], speedRangeMs: [3.005, 3.825],
        recovery: { durationS: 240, zone: 'Z2', active: true, elevationGainM: 78, ...Z2 },
      },
      { label: 'Retour au calme', zone: 'Z1', durationS: 600, hrRange: [0, 141], speedRangeMs: [0, 2.46] },
    ],
    plannedLoad: 57, plannedMechanicalLoad: 24, plannedDurationS: 4500, plannedElevationGainM: 468,
  };
  const [laid] = onTerrain([STORED], { model: PIERRE_MODEL, terrain: TERRAIN, today: '2026-09-22', descentsDone: 1 });

  it('fait durer chaque bloc ce qu\'il prescrit, un détour nommé complétant le chemin', async () => {
    const { services } = world();
    const route = (await buildRoute(laid!, { home: HOME, model: PIERRE_MODEL, altitude: FLAT, terrain: TERRAIN, traces: TRACES, services }))!;
    const sums = perBlock(route);
    laid!.blocks.forEach((b, i) => {
      const prescribed = (b.durationS ?? 0) * (b.repeat ?? 1) +
        (b.recovery ? ((b.repeat ?? 1) - (b.recovery.betweenReps ? 1 : 0)) * b.recovery.durationS : 0);
      expect(Math.abs((sums.get(i) ?? 0) - prescribed)).toBeLessThan(1);
    });
    const detours = route.legs.filter((l) => l.kind === 'detour');
    expect(detours.length).toBeGreaterThan(0);
    for (const d of detours) {
      expect(d.label).toMatch(/^Détour par /);
      expect(d.durationS).toBeGreaterThanOrEqual(MIN_DETOUR_S);
      expect(d.steps[d.steps.length - 1]!.text).toMatch(/fais demi-tour et reviens par le même chemin/);
    }
    expect(route.durationS).toBe(laid!.plannedDurationS);
  });

  it('part de chez soi et y revient', async () => {
    const { services } = world();
    const route = (await buildRoute(laid!, { home: HOME, model: PIERRE_MODEL, altitude: FLAT, terrain: TERRAIN, traces: TRACES, services }))!;
    expect(route.legs[0]!.kind).toBe('access');
    expect(route.legs[0]!.steps[0]!.text).toMatch(/^Sors de chez toi/);
    expect(route.legs[0]!.track[0]).toEqual(HOME.at);
    const home = route.legs.find((l) => l.kind === 'home')!;
    expect(home.steps[home.steps.length - 1]!.text).toBe('Tu es chez toi.');
    expect(home.track[home.track.length - 1]).toEqual(HOME.at);
  });

  it("dit pourquoi une boucle qui ne tient pas dans la récupération n'est pas prise", async () => {
    const { services } = world();
    const route = (await buildRoute(laid!, { home: HOME, model: PIERRE_MODEL, altitude: FLAT, terrain: TERRAIN, traces: TRACES, services }))!;
    const rep = laid!.blocks.find((b) => b.repeat === 6)!;
    expect(rep.where?.back).toBeUndefined();
    expect(route.notes.join(' ')).toMatch(/^Pas de boucle par .*la récupération en prévoit/);
  });

  it("ne demande au géocodage aucun point près du domicile, et le domicile ne part qu'au moteur d'itinéraire", async () => {
    const { asked, services } = world();
    const close: AthleteHome = { at: at(0, 150), address: '1 rue du Test' };
    await buildRoute(laid!, { home: close, model: PIERRE_MODEL, altitude: FLAT, terrain: TERRAIN, traces: TRACES, services });
    const geocoded = asked.filter((q) => q.kind !== 'route');
    expect(geocoded.length).toBeGreaterThan(0);
    for (const q of geocoded) expect(haversineM(q.at, close.at)).toBeGreaterThanOrEqual(HOME_PRIVACY_M);
    expect(asked.some((q) => q.kind === 'route' && haversineM(q.at, close.at) < 1)).toBe(true);
  });

  it('répartit le plat dans chaque tour quand un seul détour ne suffit pas', async () => {
    const { services } = world();
    const t = longTrail(PIERRE_MODEL, 180, 680, TERRAIN);
    const rando = { blocks: t.blocks };
    const route = (await buildRoute(rando, { home: HOME, model: PIERRE_MODEL, altitude: FLAT, terrain: TERRAIN, traces: TRACES, services }))!;
    const flat = route.legs.find((l) => l.kind === 'detour' && l.repeat);
    const motif = route.legs.find((l) => l.kind === 'motif')!;
    expect(flat?.repeat).toBe(motif.repeat);
    expect(flat!.steps[0]!.text).toMatch(/^À chaque tour, avant de monter : \d+ min à plat\.$/);
    expect(motif.steps[0]!.text).toMatch(/^Monte à pied .* et ses \d+ marches jusqu'en haut/);
    expect(motif.steps[1]!.text).toMatch(/^Redescends en courant par /);
    const sums = perBlock(route);
    t.blocks.forEach((b, i) => expect(Math.abs((sums.get(i) ?? 0) - (b.durationS ?? 0))).toBeLessThan(1));
  });
});

describe('Le relief lu sur les traces', () => {
  it("prend la médiane des sorties qui passent : un altimètre décalé n'y fait rien", () => {
    const shifted = (id: string, dz: number): LightTrace => ({ ...TRACES[3]!, activityId: id, z: TRACES[3]!.z.map((z) => z + dz) });
    const index = altitudeIndex([shifted('a', 0), shifted('b', 1), shifted('c', 9)]);
    expect(index.at(at(0, 0))).toBeCloseTo(171, 0);
  });

  it("ne fait pas monter un quai plat de ce que l'altimètre oscille", () => {
    const quay = Array.from({ length: 100 }, (_, k) => at(k * 20, 1000));
    const noisy: AltitudeIndex = { at: (p) => 172 + 2 * Math.sin((p[0] - O[0]) * 1e5) };
    expect(reliefOf(profileAlong(quay, noisy)).gainM).toBe(0);
    expect(climbAndDrop([170, 172, 171, 180, 179, 170], 2)).toEqual({ gainM: 10, lossM: 10 });
  });
});

describe('La trace GPX', () => {
  const route: SessionRoute = {
    basis: 'x', computedAt: READ_AT, home: HOME, notes: [], durationS: 900, distanceM: 1400, gainM: 0, lossM: 0,
    legs: [
      { label: 'Accès', block: 0, kind: 'access', durationS: 300, distanceM: 600, gainM: 0, lossM: 0, steps: [], track: [HOME.at, at(0, 0)] },
      { label: 'Détour par le quai du Test', block: 0, kind: 'detour', durationS: 300, distanceM: 200, gainM: 0, lossM: 0, steps: [], track: [at(0, 0), at(-100, 0)] },
      { label: 'Montée', block: 0, kind: 'motif', repeat: 3, durationS: 300, distanceM: 600, gainM: 0, lossM: 0, steps: [], track: [at(0, 0), at(500, 0)] },
    ],
  };

  it('suit l\'itinéraire dans l\'ordre, détour aller et retour, motif une fois', () => {
    expect(routeTrack(route)).toEqual([HOME.at, at(0, 0), at(-100, 0), at(0, 0), at(500, 0)]);
  });

  it('est un GPX 1.1 avec le départ et la trace', () => {
    const gpx = toGpx(route, 'Descente & remontées <test>');
    expect(gpx.startsWith('<?xml version="1.0" encoding="UTF-8"?>\n<gpx version="1.1"')).toBe(true);
    expect(gpx).toContain('<name>Départ et arrivée</name>');
    expect(gpx).toContain('<name>Montée (3 fois)</name>');
    expect(gpx).toContain('Descente &amp; remontées &lt;test&gt;');
    expect(gpx.match(/<trkpt /g)).toHaveLength(5);
  });
});
