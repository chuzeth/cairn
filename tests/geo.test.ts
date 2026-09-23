import { afterEach, describe, expect, it, vi } from 'vitest';
import type { PlannedSession } from '@cairn/core';
import type { ClimbOccurrence, ProfilePoint } from '@cairn/coach';

/**
 * Ce qui sort du Mac vers OpenStreetMap : des points des montées, jamais le
 * domicile ; une question Nominatim par seconde au plus ; aucune question posée
 * deux fois. La base et le réseau sont simulés — rien ne part ici.
 */

const store = new Map<string, { value: unknown; fetchedAt: string }>();
vi.mock('@cairn/db', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@cairn/db')>()),
  getGeo: async (key: string) => store.get(key) ?? null,
  putGeo: async (key: string, value: unknown, fetchedAt = new Date().toISOString()) => {
    store.set(key, { value, fetchedAt });
  },
}));

/** Un module neuf à chaque test : le rythme de Nominatim et le repos d'Overpass sont des états du processus. */
const fresh = async () => {
  vi.resetModules();
  return import('@cairn/coach');
};

afterEach(() => {
  store.clear();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const HOME: [number, number] = [45.763281, 4.835553];
const FOOT: [number, number] = [45.764502, 4.829131];
const TOP: [number, number] = [45.760057, 4.822667];

const TRAIL_SESSION: Pick<PlannedSession, 'blocks'> = {
  blocks: [
    { label: 'Échauffement', zone: 'Z2', durationS: 1200 },
    {
      label: "Échauffement jusqu'au haut de la montée", zone: 'Z2', durationS: 1200,
      where: {
        climb: 'la montée Saint-Barthélémy', from: { role: 'pied', at: FOOT }, to: { role: 'haut', at: TOP },
        lengthM: 1012, grade: 0.092, provenance: 'field', streets: ['montée Saint-Barthélémy'],
      },
    },
  ],
};

describe('Nominatim', () => {
  it('ne reçoit que les bouts des tronçons, une requête par seconde au plus, et dit qui demande', async () => {
    const { USER_AGENT, withAddresses } = await fresh();
    vi.useFakeTimers({ now: new Date('2026-09-23T12:00:00Z') });
    const calls: { url: URL; at: number; agent: string | null }[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      calls.push({ url, at: Date.now(), agent: new Headers(init?.headers).get('user-agent') });
      const street = url.searchParams.get('zoom') === '17';
      const body = street
        ? { category: 'highway', name: 'Montée Saint-Barthélémy', address: { road: 'Montée Saint-Barthélémy' } }
        : { address: { road: 'Montée Saint Barthélémy', house_number: '49' } };
      return new Response(JSON.stringify(body), { status: 200 });
    });

    const pending = withAddresses([TRAIL_SESSION]);
    await vi.runAllTimersAsync();
    const [out] = await pending;

    expect(out!.blocks[1]!.where!.to.address).toBe('49 montée Saint-Barthélémy');
    // Deux points, deux zooms chacun : la voie, puis la maison.
    expect(calls).toHaveLength(4);
    for (const c of calls) {
      expect(c.url.origin + c.url.pathname).toBe('https://nominatim.openstreetmap.org/reverse');
      expect(c.agent).toBe(USER_AGENT);
      const p: [number, number] = [Number(c.url.searchParams.get('lat')), Number(c.url.searchParams.get('lon'))];
      expect([FOOT, TOP]).toContainEqual(p);
      expect(p).not.toEqual(HOME);
    }
    for (let i = 1; i < calls.length; i++) expect(calls[i]!.at - calls[i - 1]!.at).toBeGreaterThanOrEqual(1000);
    // L'application se nomme ; elle ne dit pas qui est l'athlète.
    expect(USER_AGENT).toMatch(/^Cairn\//);
    expect(USER_AGENT).not.toMatch(/@/);

    // Une seconde relève : tout sort de la base, rien ne repart.
    const again = withAddresses([TRAIL_SESSION]);
    await vi.runAllTimersAsync();
    await again;
    expect(calls).toHaveLength(4);
  });
});

/** Une ligne droite vers le nord, un point tous les 5 m, à 11 %. */
function straight(origin: [number, number], lengthM: number): ProfilePoint[] {
  return Array.from({ length: lengthM / 5 + 1 }, (_, i) => ({
    d: i * 5,
    z: 170 + i * 5 * 0.11,
    at: [origin[0] + (i * 5) / 110_574, origin[1]] as [number, number],
  }));
}

const occurrence = (profile: ProfilePoint[], date: string, id: string): ClimbOccurrence => ({
  startIndex: 0, endIndex: profile.length - 1, start: profile[0]!.at, top: profile[profile.length - 1]!.at,
  startAltitudeM: 170, lengthM: profile[profile.length - 1]!.d, gainM: Math.round(profile[profile.length - 1]!.z - 170),
  grade: 0.11, durationS: 600, vamMh: 700, avgHr: 150, profile, provenance: 'field', activityId: id,
  activityName: 'Trail', date,
});

describe('Overpass', () => {
  it('reçoit une requête pour toutes les montées proches, faite de leurs traces seules, et plus jamais ensuite', async () => {
    const { groupRecurring, withGround } = await fresh();
    const near = straight(FOOT, 400);
    // Une montée de week-end, à 45 km : elle ne vaut pas une question.
    const far = straight([46.17, 4.61], 400);
    const climbs = groupRecurring([
      occurrence(near, '2026-06-04', 'n1'), occurrence(near, '2026-08-20', 'n2'),
      occurrence(far, '2026-07-17', 'f1'), occurrence(far, '2026-08-01', 'f2'),
    ]);
    const bodies: string[] = [];
    vi.stubGlobal('fetch', async (input: string, init?: RequestInit) => {
      expect(input).toBe('https://overpass-api.de/api/interpreter');
      bodies.push(decodeURIComponent(String(init?.body)));
      const way = {
        type: 'way', id: 52769021,
        tags: { highway: 'residential', name: 'Montée Saint-Barthélémy', surface: 'asphalt' },
        geometry: [{ lat: FOOT[0] - 0.0002, lon: FOOT[1] }, { lat: FOOT[0] + 0.005, lon: FOOT[1] }],
      };
      return new Response(JSON.stringify({ elements: [way] }), { status: 200 });
    });

    const out = await withGround(climbs, HOME);
    expect(bodies).toHaveLength(1);
    expect(bodies[0]).toContain(`${FOOT[0].toFixed(5)},${FOOT[1].toFixed(5)}`);
    expect(bodies[0]).not.toContain(HOME[0].toFixed(5));
    expect(bodies[0]).not.toContain('46.17');
    const read = out.find((c) => c.start[0] < 46);
    expect(read!.ground!.ways.map((w) => w.id)).toEqual([52769021]);
    expect(out.find((c) => c.start[0] > 46)!.ground).toBeUndefined();

    await withGround(climbs, HOME);
    expect(bodies).toHaveLength(1);
  });

  it('laisse le sol inconnu quand l\'instance refuse, et ne réinsiste pas avant la relève suivante', async () => {
    const { groupRecurring, withGround } = await fresh();
    vi.useFakeTimers({ now: new Date('2026-09-23T12:00:00Z') });
    const near = straight(FOOT, 400);
    const climbs = groupRecurring([occurrence(near, '2026-06-04', 'n1'), occurrence(near, '2026-08-20', 'n2')]);
    let calls = 0;
    vi.stubGlobal('fetch', async () => {
      calls++;
      return new Response('Too Many Requests', { status: 429 });
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});

    const pending = withGround(climbs, HOME);
    await vi.runAllTimersAsync();
    const out = await pending;
    // Refusée deux fois — la seconde après dix secondes —, la montée garde un sol inconnu.
    expect(calls).toBe(2);
    expect(out[0]!.ground).toBeNull();
    expect(store.size).toBe(0);

    const later = withGround(climbs, HOME);
    await vi.runAllTimersAsync();
    await later;
    expect(calls).toBe(2);
    warn.mockRestore();
  });
});
