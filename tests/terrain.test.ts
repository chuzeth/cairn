import { describe, expect, it } from 'vitest';
import type { ActivityStreams } from '@cairn/core';
import {
  detectClimbs, groupRecurring, haversineM, homeGrounds,
  type ClimbOccurrence, type OutingStart,
} from '@cairn/coach';

/** Un segment de trace : une durée tenue à vitesse et pente constantes. */
interface Segment {
  /** Durée, s. */
  s: number;
  /** Vitesse horizontale, m/s. */
  v: number;
  /** Pente, fraction. */
  g: number;
  hr?: number;
  /** false : à l'arrêt — la distance n'avance plus. */
  moving?: boolean;
}

/**
 * Flux synthétique à 1 Hz.
 *
 * La pente est écrite telle que le segment la porte : les seuils se testent
 * alors sur la segmentation elle-même, et non sur le lissage qui la précède.
 */
function trace(segments: Segment[], origin: [number, number] = [45.76, 4.83]): ActivityStreams {
  const first = segments[0] as Segment;
  const time = [0];
  const distance = [0];
  const altitude = [0];
  const grade = [0];
  const velocity = [0];
  const heartrate: (number | null)[] = [first.hr ?? null];
  const moving = [true];
  let t = 0;
  let d = 0;
  let z = 0;
  for (const seg of segments) {
    const still = seg.moving === false;
    for (let i = 0; i < seg.s; i++) {
      const dx = still ? 0 : seg.v;
      t += 1;
      d += dx;
      z += dx * seg.g;
      time.push(t);
      distance.push(d);
      altitude.push(z);
      grade.push(still ? 0 : seg.g);
      velocity.push(dx);
      heartrate.push(seg.hr ?? null);
      moving.push(!still);
    }
  }
  const latlng = distance.map((m) => [origin[0] + m / 111_320, origin[1]] as [number, number]);
  return { time, distance, altitude, grade, velocity, heartrate, moving, latlng };
}

describe('Montées lues dans une trace', () => {
  it('mesure une montée soutenue', () => {
    const [climb, ...rest] = detectClimbs(trace([{ s: 600, v: 2, g: 0.1, hr: 158 }]));
    expect(rest).toHaveLength(0);
    expect(climb).toMatchObject({
      lengthM: 1200,
      gainM: 120,
      grade: 0.1,
      durationS: 600,
      vamMh: 720,
      avgHr: 158,
      provenance: 'field',
    });
    expect(climb?.start?.[1]).toBeCloseTo(4.83, 5);
  });

  it('ignore une bosse qui ne gagne pas 30 m', () => {
    expect(detectClimbs(trace([{ s: 125, v: 2, g: 0.1 }]))).toHaveLength(0);
  });

  it('ignore une pente moyenne sous 3 %', () => {
    // 2,5 % sur 2 km : 50 m de gain, donc au-dessus du seuil de dénivelé, et
    // rejetée sur la seule pente.
    const climbs = detectClimbs(trace([{ s: 1000, v: 2, g: 0.025 }]));
    expect(climbs).toHaveLength(0);
  });

  it('absorbe un replat de moins de 50 m', () => {
    const climbs = detectClimbs(
      trace([
        { s: 300, v: 2, g: 0.08 },
        { s: 20, v: 2, g: 0 },
        { s: 300, v: 2, g: 0.08 },
      ]),
    );
    expect(climbs).toHaveLength(1);
    expect(climbs[0]).toMatchObject({ gainM: 96, lengthM: 1240 });
  });

  it('coupe au-delà de 50 m de replat', () => {
    const climbs = detectClimbs(
      trace([
        { s: 300, v: 2, g: 0.08 },
        { s: 40, v: 2, g: 0 },
        { s: 300, v: 2, g: 0.08 },
      ]),
    );
    expect(climbs).toHaveLength(2);
    expect(climbs.map((c) => c.gainM)).toEqual([48, 48]);
  });

  it('coupe sur une descente, qui n\'est pas un replat', () => {
    const climbs = detectClimbs(
      trace([
        { s: 300, v: 2, g: 0.08 },
        { s: 60, v: 2, g: -0.1 },
        { s: 300, v: 2, g: 0.08 },
      ]),
    );
    expect(climbs).toHaveLength(2);
  });

  it('ne compte pas une pause dans la durée de la montée', () => {
    const [climb] = detectClimbs(
      trace([
        { s: 300, v: 2, g: 0.1 },
        { s: 120, v: 0, g: 0, moving: false },
        { s: 300, v: 2, g: 0.1 },
      ]),
    );
    // 120 m montés en 600 s de mouvement : la pause n'écrase pas la VAM.
    expect(climb).toMatchObject({ gainM: 120, durationS: 600, vamMh: 720 });
  });

  it('ne trouve rien sur une trace plate', () => {
    expect(detectClimbs(trace([{ s: 1800, v: 3, g: 0 }]))).toHaveLength(0);
  });

  it('calcule la pente quand le flux ne la porte pas', () => {
    const stream = { ...trace([{ s: 900, v: 2, g: 0.12 }]), grade: [] };
    const [climb] = detectClimbs(stream);
    expect(climb?.gainM).toBe(216);
    expect(climb?.grade).toBeCloseTo(0.12, 2);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const occurrence = (
  o: Partial<ClimbOccurrence> & { date: string; start: [number, number] },
): ClimbOccurrence => ({
  startIndex: 0,
  endIndex: 360,
  top: null,
  profile: [],
  startAltitudeM: 200,
  lengthM: 600,
  gainM: 90,
  grade: 0.15,
  durationS: 360,
  vamMh: 900,
  avgHr: 155,
  provenance: 'field',
  activityId: `act-${o.date}`,
  activityName: 'Intervals',
  ...o,
});

describe('Montées récurrentes', () => {
  it('réunit deux passages partis du même endroit', () => {
    const [climb, ...rest] = groupRecurring([
      occurrence({ date: '2026-06-01', start: [45.76, 4.83], vamMh: 820 }),
      // 56 m plus au nord : le même pied de montée, relevé par un autre point.
      occurrence({ date: '2026-07-04', start: [45.7605, 4.83], vamMh: 940 }),
    ]);
    expect(rest).toHaveLength(0);
    expect(climb).toMatchObject({
      passages: 2,
      outings: 2,
      firstDate: '2026-06-01',
      lastDate: '2026-07-04',
      bestVamMh: 940,
      medianVamMh: 880,
      lengthM: 600,
      gainM: 90,
      provenance: 'field',
    });
    expect(climb?.best.date).toBe('2026-07-04');
    expect(climb?.activityNames).toEqual(['Intervals']);
  });

  it('sépare deux montées parties de 200 m de distance', () => {
    expect(
      groupRecurring([
        occurrence({ date: '2026-06-01', start: [45.76, 4.83] }),
        occurrence({ date: '2026-07-04', start: [45.7618, 4.83] }),
      ]),
    ).toHaveLength(0);
  });

  it('sépare la côte du col qui partent du même carrefour', () => {
    expect(
      groupRecurring([
        occurrence({ date: '2026-06-01', start: [45.76, 4.83], lengthM: 400, gainM: 60 }),
        occurrence({ date: '2026-07-04', start: [45.76, 4.83], lengthM: 2200, gainM: 330 }),
      ]),
    ).toHaveLength(0);
  });

  it('laisse de côté une montée vue une seule fois', () => {
    expect(groupRecurring([occurrence({ date: '2026-06-01', start: [45.76, 4.83] })])).toHaveLength(0);
  });

  it('compte les répétitions d\'une même séance en passages, pas en sorties', () => {
    const repeats = [1, 2, 3, 4].map((i) =>
      occurrence({ date: '2026-06-01', start: [45.76, 4.83], startIndex: i * 1000, vamMh: 1000 - i * 40 }),
    );
    const [climb] = groupRecurring(repeats);
    expect(climb).toMatchObject({ passages: 4, outings: 1, bestVamMh: 960, trend: 'unknown' });
  });

  it('ne dit la tendance qu\'à partir de trois sorties', () => {
    const rising = ['2026-06-01', '2026-07-01', '2026-08-01'].map((date, i) =>
      occurrence({ date, start: [45.76, 4.83], vamMh: 800 + i * 100 }),
    );
    expect(groupRecurring(rising)[0]?.trend).toBe('up');
    expect(groupRecurring(rising.slice(0, 2))[0]?.trend).toBe('unknown');

    const falling = rising.map((c, i) => ({ ...c, vamMh: 1000 - i * 100 }));
    expect(groupRecurring(falling)[0]?.trend).toBe('down');

    const steady = rising.map((c) => ({ ...c, vamMh: 900 }));
    expect(groupRecurring(steady)[0]?.trend).toBe('flat');
  });

  it('lit la tendance sur la meilleure VAM de chaque sortie', () => {
    // Trois séances de côtes en progression, chacune avec des répétitions qui
    // s'essoufflent : compter tous les passages ferait lire un recul.
    const climbs = ['2026-06-01', '2026-07-01', '2026-08-01'].flatMap((date, s) =>
      [0, 1, 2].map((r) =>
        occurrence({ date, start: [45.76, 4.83], startIndex: r * 1000, vamMh: 850 + s * 80 - r * 60 }),
      ),
    );
    const [climb] = groupRecurring(climbs);
    expect(climb).toMatchObject({ passages: 9, outings: 3, trend: 'up', bestVamMh: 1010 });
  });

  it('classe les montées par nombre de passages', () => {
    const groups = groupRecurring([
      ...['2026-06-01', '2026-06-08'].map((date) => occurrence({ date, start: [45.76, 4.83] })),
      ...['2026-06-02', '2026-06-09', '2026-06-16'].map((date) =>
        occurrence({ date, start: [45.9, 4.83] }),
      ),
    ]);
    expect(groups.map((g) => g.passages)).toEqual([3, 2]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────

const outing = (o: Partial<OutingStart> & { date: string; start: [number, number] }): OutingStart => ({
  activityId: `act-${o.date}`,
  elevationGainM: 200,
  ...o,
});

describe('Terrains d\'entraînement', () => {
  it('réunit les départs à 1,5 km près', () => {
    const [ground, ...rest] = homeGrounds([
      outing({ date: '2026-06-01', start: [45.763, 4.835], elevationGainM: 180 }),
      outing({ date: '2026-06-08', start: [45.766, 4.838], elevationGainM: 220 }),
      outing({ date: '2026-07-02', start: [45.764, 4.836], elevationGainM: 260 }),
    ]);
    expect(rest).toHaveLength(0);
    expect(ground).toMatchObject({
      outings: 3,
      firstDate: '2026-06-01',
      lastDate: '2026-07-02',
      medianElevationGainM: 220,
      provenance: 'field',
    });
    expect(ground?.center[0]).toBeCloseTo(45.764, 3);
  });

  it('sépare deux vallées et oublie le départ unique', () => {
    const grounds = homeGrounds([
      outing({ date: '2026-06-01', start: [45.763, 4.835] }),
      outing({ date: '2026-06-08', start: [45.763, 4.835] }),
      outing({ date: '2026-06-15', start: [46.157, 4.627], elevationGainM: 500 }),
      outing({ date: '2026-06-22', start: [46.157, 4.627], elevationGainM: 480 }),
      outing({ date: '2026-07-01', start: [35.24, 23.7] }),
    ]);
    expect(grounds).toHaveLength(2);
    expect(grounds.map((g) => g.outings)).toEqual([2, 2]);
    expect(grounds[0]?.medianElevationGainM).toBeGreaterThan(grounds[1]?.medianElevationGainM ?? 0);
  });

  it('classe les terrains par nombre de sorties', () => {
    const grounds = homeGrounds([
      ...['2026-06-01', '2026-06-08'].map((date) => outing({ date, start: [46.157, 4.627] })),
      ...['2026-06-02', '2026-06-09', '2026-06-16'].map((date) =>
        outing({ date, start: [45.763, 4.835] }),
      ),
    ]);
    expect(grounds.map((g) => g.outings)).toEqual([3, 2]);
  });
});

describe('Distance entre deux positions', () => {
  it('mesure un degré de latitude', () => {
    expect(haversineM([45, 4], [46, 4])).toBeCloseTo(111_195, -2);
  });

  it('est nulle sur place et symétrique', () => {
    expect(haversineM([45.76, 4.83], [45.76, 4.83])).toBe(0);
    expect(haversineM([45.76, 4.83], [45.77, 4.84])).toBeCloseTo(
      haversineM([45.77, 4.84], [45.76, 4.83]),
      9,
    );
  });
});
