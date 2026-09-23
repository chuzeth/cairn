import { describe, expect, it } from 'vitest';
import type { PlannedSession, SessionBlock } from '@cairn/core';
import {
  canonicalAddress, directionsUrl, groundText, itinerary, mapUrl, streetKey, withArticle,
} from '@cairn/core';
import {
  COOLDOWN_TO_FOOT, WARMUP_TO_TOP, addressFrom, descentPick, describeClimb, downhillSession, groundBetween,
  groupRecurring, hillRepeats, hitFrom, kindOf, matchTrack, onTerrain, overpassQuery, queryTrack, streetsOf,
  trackBetween, waysFromOverpass, type ClimbOccurrence, type OsmWay, type ProfilePoint, type RecurringClimb,
  type TerrainHint,
} from '@cairn/coach';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Un quartier inventé, bâti comme celui de Pierre.
 *
 * La montée « des Marches », sa plus courue, passe par un escalier de 500
 * marches ; la montée « Saint-Barthélémy » est une rue en asphalte à 11 %, que
 * croise un escalier et que longe un trottoir sans nom. Rien ici n'est une trace
 * de Pierre : les positions sont posées au mètre sur un plan local.
 */

const LAT0 = 45.76;
const LNG0 = 4.83;
const KX = 111_320 * Math.cos((LAT0 * Math.PI) / 180);
const KY = 110_574;
/** La position à `x` mètres à l'est et `y` mètres au nord de l'origine. */
const at = (x: number, y: number): [number, number] => [
  Math.round((LAT0 + y / KY) * 1e7) / 1e7,
  Math.round((LNG0 + x / KX) * 1e7) / 1e7,
];

interface Leg {
  to: [number, number];
  grade: number;
}

/** Le profil d'un passage le long de segments, un point tous les 5 m. */
function passage(from: [number, number], legs: Leg[], z0 = 170): ProfilePoint[] {
  const out: ProfilePoint[] = [{ d: 0, z: z0, at: at(...from) }];
  let [x, y] = from;
  let d = 0;
  let z = z0;
  for (const leg of legs) {
    const [tx, ty] = leg.to;
    const len = Math.hypot(tx - x, ty - y);
    const n = Math.round(len / 5);
    for (let i = 1; i <= n; i++) {
      const f = i / n;
      out.push({
        d: Math.round((d + f * len) * 10) / 10,
        z: Math.round((z + f * len * leg.grade) * 10) / 10,
        at: at(x + f * (tx - x), y + f * (ty - y)),
      });
    }
    d += len;
    z += len * leg.grade;
    [x, y] = [tx, ty];
  }
  return out;
}

function occurrence(profile: ProfilePoint[], date: string, activityId: string): ClimbOccurrence {
  const first = profile[0]!;
  const last = profile[profile.length - 1]!;
  const lengthM = Math.round(last.d);
  const gainM = Math.round(last.z - first.z);
  return {
    startIndex: 0, endIndex: profile.length - 1, start: first.at, top: last.at, startAltitudeM: Math.round(first.z),
    lengthM, gainM, grade: Math.round((gainM / lengthM) * 1000) / 1000, durationS: 600, vamMh: 700, avgHr: 150,
    profile, provenance: 'field', activityId, activityName: 'Trail dans l’après-midi', date,
  };
}

const way = (id: number, tags: Record<string, string>, pts: [number, number][]): OsmWay => ({
  id, tags, geometry: pts.map(([x, y]) => at(x, y)),
});

const WAYS: OsmWay[] = [
  way(1, { highway: 'residential', name: 'Rue du Bas', surface: 'asphalt', sidewalk: 'both' }, [[0, -20], [0, 200]]),
  way(2, { highway: 'steps', name: 'Montée des Marches', surface: 'concrete', step_count: '500' }, [[0, 200], [0, 500]]),
  way(3, { highway: 'living_street', name: 'Place du Haut', surface: 'asphalt' }, [[0, 500], [0, 620]]),
  // La rue, écrite de deux façons, comme OpenStreetMap écrit la vraie.
  way(4, { highway: 'residential', name: 'Montée Saint-Barthélémy', surface: 'asphalt', sidewalk: 'both' },
    [[300, -20], [300, 700]]),
  way(5, { highway: 'residential', name: 'Montée Saint Barthélémy', surface: 'asphalt', sidewalk: 'both' },
    [[300, 700], [300, 1020]]),
  // Un trottoir sans nom, tracé à part, que la trace suit un moment.
  way(6, { highway: 'footway', footway: 'sidewalk', surface: 'asphalt' }, [[306, 100], [306, 400]]),
  // Un escalier qui débouche en travers de la rue : la trace passe à son pied.
  way(7, { highway: 'steps', name: 'Escalier du Travers', step_count: '80' }, [[301, 600], [380, 600]]),
];

const READ_AT = '2026-09-23T12:00:00.000Z';

/** Trois passages par l'escalier, deux par la rue — courus sur le trottoir, trois mètres à l'est de l'axe. */
const MARCHES = passage([0, 0], [
  { to: [0, 200], grade: 0.05 },
  { to: [0, 500], grade: 0.25 },
  { to: [0, 600], grade: 0.05 },
]);
const RUE = passage([303, 0], [{ to: [303, 1000], grade: 0.11 }]);

const grounded = (climbs: RecurringClimb[], ways = WAYS): RecurringClimb[] =>
  climbs.map((c) => ({ ...c, ground: matchTrack(c.latest.profile, ways, READ_AT) }));

const CLIMBS = groupRecurring([
  occurrence(MARCHES, '2026-08-10', 'a1'),
  occurrence(MARCHES, '2026-08-11', 'a2'),
  occurrence(MARCHES, '2026-08-17', 'a3'),
  occurrence(RUE, '2026-06-04', 'b1'),
  occurrence(RUE, '2026-08-20', 'b2'),
]);
const HOME = at(150, -800);
const TERRAIN: TerrainHint = { climbs: grounded(CLIMBS), home: HOME };
const byName = (name: string) => TERRAIN.climbs.find((c) => describeClimb(c) === name)!;

describe('Le sol d\'une montée se lit sur OpenStreetMap, le long de la trace', () => {
  it('nomme chaque montée par la voie qui la porte', () => {
    expect(TERRAIN.climbs.map(describeClimb).sort()).toEqual(['la montée Saint-Barthélémy', 'la montée des Marches']);
  });

  it('suit la rue que la trace suit, pas l\'escalier qui la croise au carrefour', () => {
    const rue = byName('la montée Saint-Barthélémy');
    const g = groundBetween(rue.ground!, 0, 1000);
    expect(g.runs.some((r) => r.kind === 'escalier')).toBe(false);
    expect(g.runs.every((r) => r.kind === 'route')).toBe(true);
    expect(g.offM).toBe(0);
  });

  it('reconnaît un escalier qu\'on suit, et compte les marches de la part qu\'on en prend', () => {
    const marches = byName('la montée des Marches');
    const whole = groundBetween(marches.ground!, 600, 0);
    const stairs = whole.runs.filter((r) => r.kind === 'escalier');
    expect(stairs).toHaveLength(1);
    expect(stairs[0]).toMatchObject({ name: 'montée des Marches', surface: 'béton', steps: 500, way: 2 });
    expect(stairs[0]!.lengthM).toBeCloseTo(300, -1);
    // Du haut à mi-escalier : la moitié de la volée.
    const half = groundBetween(marches.ground!, 600, 350).runs.find((r) => r.kind === 'escalier')!;
    expect(half.steps).toBeCloseTo(250, -1);
  });

  it('donne à un trottoir sans nom le nom de la rue qu\'il longe', () => {
    const g = groundBetween(byName('la montée Saint-Barthélémy').ground!, 0, 1000);
    expect(g.runs.every((r) => streetKey(r.name ?? '') === streetKey('montée Saint-Barthélémy'))).toBe(true);
  });

  it('dit les voies dans l\'ordre de la course, une rue une fois quelle que soit son écriture', () => {
    const marches = byName('la montée des Marches');
    expect(streetsOf(groundBetween(marches.ground!, 600, 0))).toEqual(['place du Haut', 'montée des Marches', 'rue du Bas']);
    expect(streetsOf(groundBetween(marches.ground!, 0, 600))).toEqual(['rue du Bas', 'montée des Marches', 'place du Haut']);
    expect(streetsOf(groundBetween(byName('la montée Saint-Barthélémy').ground!, 0, 1000))).toEqual([
      'montée Saint-Barthélémy',
    ]);
  });

  it('dit le sol en une ligne : la nature qui domine, sinon ses parts', () => {
    expect(groundText(groundBetween(byName('la montée Saint-Barthélémy').ground!, 1000, 0))).toBe(
      'route en asphalte, trottoirs des deux côtés',
    );
    expect(groundText(groundBetween(byName('la montée des Marches').ground!, 600, 0))).toBe(
      '300 m de route en asphalte, 300 m d\'escalier en béton (500 marches)',
    );
  });

  it('classe les voies : route, chemin, sentier, escalier', () => {
    expect(kindOf({ highway: 'steps' })).toBe('escalier');
    expect(kindOf({ highway: 'residential', surface: 'sett' })).toBe('route');
    expect(kindOf({ highway: 'footway', footway: 'sidewalk' })).toBe('route');
    expect(kindOf({ highway: 'footway', surface: 'paving_stones' })).toBe('chemin');
    expect(kindOf({ highway: 'track', surface: 'gravel' })).toBe('chemin');
    expect(kindOf({ highway: 'path', surface: 'ground' })).toBe('sentier');
    expect(kindOf({ highway: 'path' })).toBe('sentier');
  });

  it('dessine le tronçon par sa trace, allégée, dans le sens de la course', () => {
    const track = trackBetween(byName('la montée Saint-Barthélémy').latest.profile, 1000, 180);
    // Une ligne droite : ses deux bouts suffisent.
    expect(track).toHaveLength(2);
    expect(track[0]).toEqual(at(303, 1000).map((v) => Math.round(v * 1e6) / 1e6));
    expect(track[1]![0]).toBeLessThan(track[0]![0]);
  });
});

describe('Une montée est un chemin, pas seulement un départ', () => {
  it('sépare deux itinéraires partis du même pied, de même longueur', () => {
    const detour = passage([0, 0], [
      { to: [0, 200], grade: 0.05 },
      { to: [-300, 400], grade: 0.2 },
      { to: [-300, 450], grade: 0.05 },
    ]);
    const groups = groupRecurring([
      occurrence(MARCHES, '2026-08-10', 'a1'),
      occurrence(MARCHES, '2026-08-11', 'a2'),
      occurrence(detour, '2026-07-19', 'c1'),
      occurrence(detour, '2026-07-20', 'c2'),
    ]);
    expect(groups).toHaveLength(2);
    expect(groups.map((g) => g.outings)).toEqual([2, 2]);
  });
});

const Z2 = { hrRange: [141, 155] as [number, number], speedRangeMs: [2.46, 3.0] as [number, number] };
const STORED: PlannedSession = {
  id: 'ses_2409', athleteId: 'pierre', date: '2026-09-24', type: 'downhill', status: 'planned', priority: 'support',
  title: 'Descente technique 6 × 3 min — 1 h 35 · 571 m D−',
  intent: 'Habituer les quadriceps au freinage.',
  blocks: [
    { label: 'Échauffement', zone: 'Z2', durationS: 1200, ...Z2 },
    { label: 'Gammes', zone: 'Z2', durationS: 120, ...Z2 },
    {
      label: 'Descentes contrôlées', zone: 'Z3', durationS: 180, repeat: 6, elevationLossM: 90,
      cadenceTargetSpm: 180, recovery: { durationS: 540, zone: 'Z1', active: true, elevationGainM: 90 },
    },
    { label: 'Retour au calme', zone: 'Z1', durationS: 600, hrRange: [0, 141], speedRangeMs: [0, 2.46] },
  ],
  plannedLoad: 57, plannedMechanicalLoad: 24, plannedDurationS: 5700, plannedElevationGainM: 571,
};
const ctx = (terrain?: TerrainHint) => ({ model: PIERRE_MODEL, terrain, today: '2026-09-23', descentsDone: 1 });
const rep = (s: Pick<PlannedSession, 'blocks'>) => s.blocks.find((b) => b.repeat === 6) as SessionBlock;

describe('Aucune séance rapide sur un escalier', () => {
  it('écarte la montée la plus courue quand son tronçon passe par des marches, et prend une rue', () => {
    const { pick, skipped } = descentPick(TERRAIN, 90);
    expect(describeClimb(pick!.climb)).toBe('la montée Saint-Barthélémy');
    expect(skipped).toEqual([{ climb: 'la montée des Marches', reason: 'escalier', stairsM: 300, steps: 500 }]);
  });

  it('pose la descente écrite sur la rue, et dit pourquoi pas sur l\'escalier', () => {
    const [laid] = onTerrain([STORED], ctx(TERRAIN));
    const r = rep(laid!);
    expect(r.where!.climb).toBe('la montée Saint-Barthélémy');
    expect(r.where!.ground!.runs.some((x) => x.kind === 'escalier')).toBe(false);
    expect(r.where!.streets).toEqual(['montée Saint-Barthélémy']);
    expect(r.where!.track!.length).toBeGreaterThanOrEqual(2);
    expect(r.notes).toContain(
      'Pas sur la montée des Marches, qui passe par un escalier de 500 marches : on ne descend pas vite sur des marches.',
    );
    // L'accès et le retour se posent sur la même rue.
    expect(laid!.blocks[0]!).toMatchObject({ label: WARMUP_TO_TOP, where: { climb: 'la montée Saint-Barthélémy' } });
    expect(laid!.blocks[laid!.blocks.length - 1]!).toMatchObject({ label: COOLDOWN_TO_FOOT });
  });

  it('ne pose la descente nulle part quand toutes les montées ont des marches, et le dit', () => {
    const only = { climbs: TERRAIN.climbs.filter((c) => describeClimb(c) === 'la montée des Marches'), home: HOME };
    const s = downhillSession(PIERRE_MODEL, 6, 3, only);
    const r = s.blocks.find((b) => b.repeat === 6)!;
    expect(r.where).toBeUndefined();
    expect(r.notes).toContain(
      'Aucune de tes montées ne s\'y prête — la montée des Marches, qui passe par un escalier de 500 marches : ' +
        'cours ces descentes sur une route ou un chemin sans marches.',
    );
  });

  it('ne pose rien sur un sol qu\'on n\'a pas pu lire : rien ne dit qu\'il est sans marches', () => {
    const unread: TerrainHint = { climbs: TERRAIN.climbs.map((c) => ({ ...c, ground: null })), home: HOME };
    const s = downhillSession(PIERRE_MODEL, 6, 3, unread);
    const r = s.blocks.find((b) => b.repeat === 6)!;
    expect(r.where).toBeUndefined();
    expect(r.notes).toContain(
      'Le sol de tes montées n\'a pas pu être lu sur OpenStreetMap : cours ces descentes sur une route ou un chemin sans marches.',
    );
  });

  it('pose les côtes sur la rue aussi, et le dit', () => {
    const s = hillRepeats(PIERRE_MODEL, 8, 90, 0.1, TERRAIN);
    const r = s.blocks.find((b) => (b.repeat ?? 0) > 1)!;
    expect(r.where).toMatchObject({ climb: 'la montée Saint-Barthélémy', from: { role: 'pied' }, to: { role: 'demi-tour' } });
    expect(r.notes).toContain('Pas sur la montée des Marches, qui passe par un escalier');
    expect(r.notes).toContain('une côte ne se court pas sur des marches.');
  });

  it('aucun tronçon d\'une séance rapide ne passe par un escalier', () => {
    const [laid] = onTerrain([STORED], ctx(TERRAIN));
    const fast = [...laid!.blocks, ...hillRepeats(PIERRE_MODEL, 8, 90, 0.1, TERRAIN).blocks].filter(
      (b) => b.where && (b.repeat ?? 0) > 1,
    );
    expect(fast.length).toBeGreaterThan(0);
    for (const b of fast) expect(b.where!.ground!.runs.filter((x) => x.kind === 'escalier')).toEqual([]);
  });
});

describe('La consigne se lit comme un itinéraire', () => {
  const [laid] = onTerrain([STORED], ctx(TERRAIN));
  const addressed = laid!.blocks.map((b) => {
    if (!b.where) return b;
    const address = { pied: '2 rue François Vernay', haut: '49 montée Saint-Barthélémy', 'demi-tour': '12 montée Saint-Barthélémy' };
    return {
      ...b,
      where: {
        ...b.where,
        from: { ...b.where.from, address: address[b.where.from.role] },
        to: { ...b.where.to, address: address[b.where.to.role] },
      },
    };
  });

  it('monte la rue jusqu\'en haut, descend, fait demi-tour, remonte en marchant', () => {
    expect(itinerary(addressed[0]!)).toBe('Monte la montée Saint-Barthélémy jusqu\'en haut, au n° 49.');
    expect(itinerary(rep({ blocks: addressed }))).toBe(
      'Descends 3 min jusqu\'au n° 12, fais demi-tour, remonte en marchant entre les descentes.',
    );
    expect(itinerary(addressed[addressed.length - 1]!)).toBe(
      'Après la dernière descente, continue de descendre jusqu\'en bas, au 2 rue François Vernay.',
    );
  });

  it('ne dit plus aucune position relative au domicile', () => {
    expect(JSON.stringify(laid)).not.toMatch(/départ habituel|à l'ouest|à l'est|au nord|au sud/);
  });

  it('se lit sans adresse : la voie et le geste suffisent', () => {
    expect(itinerary(laid!.blocks[0]!)).toBe('Monte la montée Saint-Barthélémy jusqu\'en haut.');
    expect(itinerary(rep(laid!))).toBe('Descends 3 min, fais demi-tour, remonte en marchant entre les descentes.');
  });

  it('dit les passages d\'une rando-course', () => {
    const b = { where: addressed[0]!.where, elevationGainM: 110 * 6 };
    expect(itinerary(b)).toBe('Monte la montée Saint-Barthélémy jusqu\'en haut, au n° 49, redescends au pied, 6 fois.');
  });
});

describe('Les liens posent une épingle, sans passer par une recherche', () => {
  const p = { role: 'demi-tour' as const, at: [45.765591, 4.827695] as [number, number], address: '12 montée Saint-Barthélémy' };

  it('ouvre la fiche d\'un lieu à la coordonnée, nommée par son rôle et son adresse', () => {
    expect(mapUrl(p)).toBe(
      'https://maps.apple.com/place?coordinate=45.765591,4.827695&name=Demi-tour%20%C2%B7%2012%20mont%C3%A9e%20Saint-Barth%C3%A9l%C3%A9my',
    );
    expect(mapUrl(p)).not.toMatch(/[?&]q=/);
  });

  it('ouvre l\'itinéraire à pied jusqu\'au départ, depuis là où l\'on est', () => {
    expect(directionsUrl(p)).toBe('https://maps.apple.com/directions?destination=45.765591,4.827695&mode=walking');
  });
});

describe('Les noms de voies, à la française', () => {
  it('met l\'article, et l\'élide', () => {
    expect(withArticle('montée Saint-Barthélémy')).toBe('la montée Saint-Barthélémy');
    expect(withArticle('chemin de Montauban')).toBe('le chemin de Montauban');
    expect(withArticle('allée du Rosaire')).toBe("l'allée du Rosaire");
    expect(withArticle('Gourguillon')).toBe('Gourguillon');
  });

  it('écrit une adresse comme la séance écrit sa voie', () => {
    expect(canonicalAddress('49 montée Saint Barthélémy', ['montée Saint-Barthélémy'])).toBe('49 montée Saint-Barthélémy');
    expect(canonicalAddress('rue Juiverie', ['montée Saint-Barthélémy'])).toBe('rue Juiverie');
  });
});

describe('Ce qu\'on demande à OpenStreetMap, et ce qu\'on en garde', () => {
  it('une seule requête Overpass pour plusieurs montées, un point tous les 25 m', () => {
    const track = queryTrack(RUE);
    expect(track.length).toBe(41);
    const q = overpassQuery([track, queryTrack(MARCHES)]);
    expect(q.match(/way\["highway"\]\(around:30,/g)).toHaveLength(2);
    expect(q).toMatch(/^\[out:json\]\[timeout:40\];\(.*\);out tags geom;$/);
  });

  it('garde d\'une voie sa nature, son nom, son sol, ses marches — rien d\'autre', () => {
    const [w] = waysFromOverpass({
      elements: [
        {
          type: 'way', id: 10375207, geometry: [{ lat: 45.766139, lon: 4.824554 }, { lat: 45.764302, lon: 4.822698 }],
          tags: { highway: 'steps', name: 'Montée Nicolas de Lange', step_count: '562', surface: 'concrete', incline: 'up', wikidata: 'Q1' },
        },
        { type: 'node', id: 1, lat: 45.7, lon: 4.8 },
      ],
    });
    expect(w).toEqual({
      id: 10375207,
      tags: { highway: 'steps', name: 'Montée Nicolas de Lange', surface: 'concrete', step_count: '562', incline: 'up' },
      geometry: [[45.766139, 4.824554], [45.764302, 4.822698]],
    });
  });

  it('ne prend le numéro d\'une maison que s\'il donne sur la voie du point', () => {
    const street = hitFrom({ category: 'highway', name: 'Montée Saint-Barthélémy', address: { road: 'Montée Saint-Barthélémy' } });
    const house = hitFrom({ address: { road: 'Montée Saint-Barthélémy', house_number: '43;45' } });
    const school = hitFrom({ address: { road: 'Montée du Garillan' } });
    expect(addressFrom(street, house)).toBe('43 montée Saint-Barthélémy');
    expect(addressFrom(street, school)).toBe('montée Saint-Barthélémy');
    expect(addressFrom(null, null)).toBeNull();
  });
});
