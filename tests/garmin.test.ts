import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { chmodSync, mkdtempSync, rmSync, statSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createClient } from '@libsql/client';
import type { PlannedSession, SessionBlock } from '@cairn/core';
import {
  downhillSession, endurance, hillRepeats, longRun, longTrail, pyramid, racePace, recovery, strength, tempo,
  threshold, vo2max,
} from '@cairn/coach';
import { createStatements, tables } from '@cairn/db';
import {
  DESCRIPTION_MAX, GarminConnect, GarminReauthRequired, GarminRejected, GarminUnreachable, NOTE_MAX,
  PROBE_NAME, SessionFile, WORKOUT_PREFIX, alarmRule, compareWorkouts, decodeWorkout, desiredState, encodeWorkout,
  fingerprintOf, garminView, targetText,
  planReconciliation, prescribe, probeWorkout, reconcile, type CalendarWorkout, type GarminApi,
  type GarminSyncState, type GarminWorkoutPayload, type LedgerEntry, type LedgerStore, type WatchItem,
  type WatchStep, type WatchSync, type WatchWorkout,
} from '@cairn/garmin';
import { garminDue } from '../apps/api/src/garmin.js';
import { DECIDED_ON_2026_09_21, PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * La liaison Garmin.
 *
 * Le codec, le réconciliateur et l'état affiché sont purs : ils se testent ici
 * exhaustivement, sans réseau. Le passage complet tourne contre un faux Garmin
 * qui garde ses séances et son calendrier en mémoire — et qui sait les abîmer
 * comme le vrai pourrait le faire.
 */

const Z1 = { hrRange: [0, 141] as [number, number], speedRangeMs: [0, 2.4518] as [number, number] };
const Z2 = { hrRange: [141, 155] as [number, number], speedRangeMs: [2.4518, 2.99] as [number, number] };

/** La séance du 26/09 telle qu'enregistrée : endurance, activation, circuit, souplesse. */
const ENDURANCE_RENFORCEMENT: PlannedSession = {
  id: 'ses_0926', athleteId: 'pierre', date: '2026-09-26', type: 'endurance',
  title: 'Endurance fondamentale + renforcement — 1 h 08', intent: 'Foncier, puis chaîne postérieure.',
  priority: 'support', status: 'planned', plannedLoad: 40, plannedMechanicalLoad: 12, plannedDurationS: 4080,
  blocks: [
    {
      label: 'Footing en endurance aérobie', zone: 'Z2', durationS: 1560, ...Z2, notes: 'Cible 141-155 bpm.',
      elevationGainM: 47, elevationLossM: 47, cadenceTargetSpm: 172,
    },
    { label: 'Activation', zone: 'Z1', durationS: 240, ...Z1, notes: 'Cercles de hanches et de chevilles, 10 fentes marchées par jambe.' },
    {
      label: 'Circuit force', zone: 'Z2', durationS: 1680, ...Z2,
      circuit: {
        rounds: 3,
        exercises: [
          { movement: 'split_squat', reps: 8 }, { movement: 'step_down', reps: 10 },
          { movement: 'single_leg_deadlift', reps: 8 }, { movement: 'eccentric_calf', reps: 12 },
          { movement: 'isometric', reps: 45 },
        ],
      },
      notes: 'La charge se prend en freinant, jamais en poussant.',
    },
    { label: 'Souplesse chaîne postérieure', zone: 'Z1', durationS: 600, kind: 'mobility', notes: 'Maintiens de 45 s.' },
  ],
};

const LIBRARY = [
  recovery(PIERRE_MODEL), endurance(PIERRE_MODEL, 60, 200), longRun(PIERRE_MODEL), longTrail(PIERRE_MODEL),
  tempo(PIERRE_MODEL), threshold(PIERRE_MODEL), pyramid(PIERRE_MODEL), vo2max(PIERRE_MODEL, '30-30'),
  vo2max(PIERRE_MODEL, '1-1'), vo2max(PIERRE_MODEL, '15-15'), hillRepeats(PIERRE_MODEL), downhillSession(PIERRE_MODEL),
  racePace(PIERRE_MODEL),
];

const SENDABLE: { name: string; session: Pick<PlannedSession, 'type' | 'title' | 'intent' | 'blocks'> }[] = [
  ...LIBRARY.map((t) => ({ name: t.title, session: t })),
  ...DECIDED_ON_2026_09_21.map((s) => ({ name: s.title, session: s })),
  { name: ENDURANCE_RENFORCEMENT.title, session: ENDURANCE_RENFORCEMENT },
];

function workoutOf(session: Pick<PlannedSession, 'type' | 'title' | 'intent' | 'blocks'>): WatchWorkout {
  const p = prescribe(session);
  if (!p.sendable) throw new Error(p.reason);
  return p.workout;
}

/** Ce qui transite par le réseau : du JSON, rien d'autre. */
const wire = <T,>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

/** Les étapes à plat, répétitions déroulées une fois. */
const steps = (w: WatchWorkout): WatchStep[] => {
  const flat = (items: WatchItem[]): WatchStep[] => items.flatMap((i) => (i.kind === 'repeat' ? flat(i.items) : [i]));
  return flat(w.items);
};

// ─────────────────────────────────────────────────────────────────────────────
// Codec
// ─────────────────────────────────────────────────────────────────────────────

describe('Codec : séance → Garmin → séance', () => {
  it.each(SENDABLE)('décoder ce qu\'on a encodé redonne la séance — $name', ({ session }) => {
    const w = workoutOf(session);
    const back = decodeWorkout(wire(encodeWorkout(w)));
    expect(back).toEqual(w);
    expect(compareWorkouts(w, back)).toEqual([]);
  });

  it('la séance de test couvre chaque forme que Cairn écrit, et survit à l\'aller-retour', () => {
    const w = probeWorkout();
    expect(w.name).toBe(PROBE_NAME);
    const all = steps(w);
    expect(new Set(all.map((s) => s.end.type))).toEqual(new Set(['time', 'distance', 'lap']));
    expect(new Set(all.map((s) => s.target.type))).toEqual(new Set(['hr', 'none']));
    expect(all.some((s) => s.target.type === 'hr' && s.target.low === 0)).toBe(true);
    expect(all.some((s) => s.target.type === 'hr' && s.target.low > 0)).toBe(true);
    expect(w.items.some((i) => i.kind === 'repeat')).toBe(true);
    expect(decodeWorkout(wire(encodeWorkout(w)))).toEqual(w);
  });

  it('la FC part en plage personnalisée en bpm entiers, jamais en zone Garmin', () => {
    for (const { session } of SENDABLE) {
      const payload = encodeWorkout(workoutOf(session));
      const flat = (list: Record<string, unknown>[]): Record<string, unknown>[] =>
        list.flatMap((s) => (Array.isArray(s.workoutSteps) ? flat(s.workoutSteps as Record<string, unknown>[]) : [s]));
      for (const s of flat(payload.workoutSegments[0]!.workoutSteps)) {
        const key = (s.targetType as { workoutTargetTypeKey: string }).workoutTargetTypeKey;
        if (key !== 'heart.rate.zone') continue;
        expect(s.zoneNumber).toBeNull();
        expect(Number.isInteger(s.targetValueOne)).toBe(true);
        expect(Number.isInteger(s.targetValueTwo)).toBe(true);
      }
    }
  });

  it('une alarme se pose sur ce qu\'elle fait faire : plancher et plafond seulement sur la qualité à plat', () => {
    const rule = (type: PlannedSession['type'], block: Partial<SessionBlock>, part: 'work' | 'recovery' = 'work') =>
      alarmRule(type, { label: 'Bloc', zone: 'Z3', durationS: 600, hrRange: [155, 171], ...block } as SessionBlock, part);
    // Plancher et plafond : accélérer quand la FC retombe y est toujours juste.
    expect(rule('threshold', { label: 'Répétitions au seuil', zone: 'Z4' })).toEqual({ alarm: 'range', why: 'qualité à plat' });
    expect(rule('tempo', { label: 'Tempo continu' }).alarm).toBe('range');
    expect(rule('race_pace', { label: 'Bloc à allure course' }).alarm).toBe('range');
    // La plus restrictive l'emporte.
    expect(rule('threshold', { label: 'Contre-la-montre 20 min', zone: 'Z5' })).toEqual({ alarm: 'none', why: 'effort maximal' });
    expect(rule('race_pace', { elevationGainM: 250, elevationLossM: 250 })).toEqual({ alarm: 'ceiling', why: 'terrain vallonné' });
    expect(rule('threshold', { label: 'Échauffement', zone: 'Z2', elevationGainM: 80 }).alarm).toBe('ceiling');
    expect(rule('threshold', { label: 'Répétitions', recovery: { durationS: 120, zone: 'Z1', active: true } }, 'recovery'))
      .toEqual({ alarm: 'none', why: 'récupération entre répétitions' });
    // La remontée du 24/09 : 77 m en 4 min, une récupération qui monte ne sonne pas non plus.
    expect(rule('downhill', { recovery: { durationS: 240, zone: 'Z2', active: true, elevationGainM: 77 } }, 'recovery').alarm)
      .toBe('none');
    // Plafond seul : le risque est d'aller trop fort, jamais trop doucement.
    expect(rule('endurance', { label: 'Footing', zone: 'Z2' })).toEqual({ alarm: 'ceiling', why: 'endurance' });
    expect(rule('recovery', { label: 'Footing très souple', zone: 'Z1' })).toEqual({ alarm: 'ceiling', why: 'décrassage' });
    expect(rule('long_trail', { label: 'Montées', elevationGainM: 680 }).alarm).toBe('ceiling');
    expect(rule('hill_repeats', { label: 'Répétitions en montée', zone: 'Z4', elevationGainM: 20 }).alarm).toBe('ceiling');
    expect(rule('vo2max', { label: 'Pause entre séries', zone: 'Z1' }).alarm).toBe('ceiling');
    // Aucune : la FC n'y est pas la variable qu'on pilote.
    expect(rule('long_trail', { label: 'Descentes', elevationLossM: 680 })).toEqual({ alarm: 'none', why: 'descente' });
    expect(rule('hill_repeats', { recovery: { durationS: 90, zone: 'Z1', active: true, elevationLossM: 20 } }, 'recovery').alarm)
      .toBe('none');
    for (const label of ['Gammes', 'Gammes et mises en action', 'Gammes puis 3 lignes droites progressives', 'Activation', '6 accélérations']) {
      expect(rule('threshold', { label, zone: 'Z2' }).alarm).toBe('none');
    }
    expect(rule('vo2max', { label: 'Série 1/2 — 30″-30″', zone: 'Z5' }).alarm).toBe('none');
    expect(rule('endurance', { label: 'Circuit force', circuit: { rounds: 3, exercises: [] } }).alarm).toBe('none');
  });

  it('les six séances de la semaine partent avec les alarmes de la règle', () => {
    const alarms = (s: Pick<PlannedSession, 'type' | 'title' | 'intent' | 'blocks'>) =>
      steps(workoutOf(s)).map((x) => targetText(x.target));
    const DESCENTE_0924 = {
      type: 'downhill' as const, title: 'Descente technique 6 × 3 min — 1 h 15 · 462 m D−', intent: '',
      blocks: [
        { label: 'Échauffement', zone: 'Z2' as const, durationS: 1380, ...Z2 },
        {
          label: 'Descentes contrôlées', zone: 'Z3' as const, durationS: 180, repeat: 6, elevationLossM: 77,
          hrRange: [155, 171] as [number, number], speedRangeMs: [2.99, 3.806] as [number, number],
          recovery: { durationS: 240, zone: 'Z2' as const, active: true, elevationGainM: 77, ...Z2 },
        },
        { label: 'Retour au calme', zone: 'Z1' as const, durationS: 600, ...Z1 },
      ],
    };
    const DECRASSAGE = {
      type: 'recovery' as const, title: 'Décrassage — 1 h 05', intent: '',
      blocks: [
        { label: 'Footing très souple', zone: 'Z1' as const, durationS: 2700, ...Z1 },
        { label: 'Souplesse chaîne postérieure', zone: 'Z1' as const, durationS: 600, kind: 'mobility' as const },
      ],
    };
    const [clm, rando] = DECIDED_ON_2026_09_21;
    expect(alarms(clm!)).toEqual(['plafond 155 bpm', 'aucune alarme', 'aucune alarme', 'plafond 141 bpm']);
    expect(alarms(DECRASSAGE)).toEqual(['plafond 141 bpm', 'aucune alarme']);
    expect(alarms(DESCENTE_0924)).toEqual(['plafond 155 bpm', 'aucune alarme', 'aucune alarme', 'plafond 141 bpm']);
    expect(alarms(ENDURANCE_RENFORCEMENT)).toEqual(['plafond 155 bpm', ...Array(8).fill('aucune alarme')]);
    expect(alarms(rando!)).toEqual(['plafond 155 bpm', 'plafond 155 bpm', 'aucune alarme', 'plafond 141 bpm']);
    // Le plancher qui ne sonne plus reste une consigne : il est dans la note.
    expect(steps(workoutOf(clm!))[0]!.note).toMatch(/^Échauffement progressif : FC 141–155, allure à plat/);
  });

  it('rien n\'est perdu : ce qui n\'est pas cible est écrit tel quel dans la note', () => {
    const w = workoutOf({
      type: 'hill_repeats', title: 'Côtes', intent: '',
      blocks: [{
        label: 'Répétitions en montée', zone: 'Z4', durationS: 90, repeat: 8, elevationGainM: 20, vamTargetMh: 800,
        hrRange: [171, 181], speedRangeMs: [3.5, 3.9], cadenceTargetSpm: 180,
        recovery: { durationS: 90, zone: 'Z1', active: true, elevationLossM: 20, ...Z1 },
        notes: 'Buste penché, foulée courte.',
      }],
    });
    const [rep, rec] = steps(w);
    expect(rep!.note).toBe(
      'Répétitions en montée : FC 171–181, allure à plat 4:16–4:46/km, 800 m D+/h, 20 m D+, cadence 180 ppm. Buste penché, foulée courte.',
    );
    expect(rec!.note).toBe('Récupération active : FC sous 141, allure à plat plus lente que 6:48/km, 20 m D−.');
    expect(w.items).toEqual([{ kind: 'repeat', times: 8, items: [rep, rec] }]);
  });

  it('un circuit s\'écrit mouvement par mouvement, chaque tour au bouton, et le bloc annexe se chronomètre', () => {
    const w = workoutOf(ENDURANCE_RENFORCEMENT);
    const intro = w.items[2]!;
    const rounds = w.items[3]!;
    expect(intro).toMatchObject({ kind: 'step', type: 'other', end: { type: 'lap' }, target: { type: 'none' } });
    expect(intro.kind === 'step' && intro.note).toMatch(/^Circuit force, 3 tours de 5 exercices, environ 28 min : FC 141–155/);
    expect(rounds.kind === 'repeat' && rounds.times).toBe(3);
    expect(rounds.kind === 'repeat' && rounds.items.map((s) => s.kind === 'step' && s.note.split(' — ')[0])).toEqual([
      'squats bulgares 8/jambe', 'descentes lentes de marche 10/jambe', 'soulevés de terre unilatéraux 8/jambe',
      'mollets excentriques 12/jambe', 'gainage 45 s',
    ]);
    expect(w.items[4]).toEqual({
      kind: 'step', type: 'other', end: { type: 'time', seconds: 600 }, target: { type: 'none' },
      note: 'Souplesse chaîne postérieure. Maintiens de 45 s.',
    });
  });

  it('la distance prime, et la durée reste dans la note', () => {
    const w = workoutOf({
      type: 'tempo', title: 'Tempo', intent: '',
      blocks: [{ label: 'Tempo', zone: 'Z3', distanceM: 4000, durationS: 1200, hrRange: [155, 171], speedRangeMs: [3.0, 3.8] }],
    });
    expect(steps(w)[0]).toMatchObject({ end: { type: 'distance', meters: 4000 }, target: { type: 'hr', low: 155, high: 171 } });
    expect(steps(w)[0]!.note).toContain('environ 20 min');
  });

  it('une note plus longue que ce que Garmin garde se coupe à un blanc, et sa suite part dans la description', () => {
    const notes = 'Cadence haute, appuis courts, regard loin. '.repeat(12).trim();
    const p = prescribe({
      type: 'endurance', title: 'Longue', intent: 'Tenir.',
      blocks: [{ label: 'Footing', zone: 'Z2', durationS: 3600, ...Z2, notes }],
    });
    if (!p.sendable) throw new Error(p.reason);
    const [step] = steps(p.workout);
    expect(notes.length).toBeGreaterThan(NOTE_MAX);
    expect(step!.note.length).toBeLessThanOrEqual(NOTE_MAX);
    expect(step!.note).toMatch(/ … \(suite dans la description\)$/);
    const head = step!.note.replace(' … (suite dans la description)', '');
    const rest = p.workout.description.split('Étape 1, suite : ')[1]!;
    expect(`${head} ${rest}`).toBe(`Footing : FC 141–155, allure à plat 5:34–6:48/km. ${notes}`);
    expect(p.abridged).toEqual([]);
    expect(decodeWorkout(wire(encodeWorkout(p.workout)))).toEqual(p.workout);
  });

  it('une description qui ne tient pas se coupe, et la séance le dit', () => {
    const p = prescribe({
      type: 'endurance', title: 'Longue', intent: 'Tenir sans dériver. '.repeat(80),
      blocks: [{ label: 'Footing', zone: 'Z2', durationS: 3600, ...Z2 }],
    });
    if (!p.sendable) throw new Error(p.reason);
    expect(p.workout.description.length).toBeLessThanOrEqual(DESCRIPTION_MAX);
    expect(p.workout.description).toMatch(/texte complet dans Cairn\)$/);
    expect(p.abridged).toEqual(['description abrégée à la limite de Garmin, le texte complet est dans Cairn']);
  });

  it('le renforcement, le repos, la course ne partent pas — et disent pourquoi', () => {
    expect(prescribe(strength(PIERRE_MODEL))).toEqual({ sendable: false, reason: expect.stringContaining('renforcement') });
    expect(prescribe({ type: 'rest', title: 'Repos', intent: '', blocks: [] }).sendable).toBe(false);
    expect(prescribe({ type: 'race', title: 'Grisemottes', intent: '', blocks: [] })).toMatchObject({ sendable: false });
    expect(prescribe({ type: 'endurance', title: 'Vide', intent: '', blocks: [] })).toEqual({ sendable: false, reason: 'séance sans contenu' });
  });

  it('le nom porte la signature de Cairn et le titre avant son tiret ; le titre entier ouvre la description', () => {
    const w = workoutOf(DECIDED_ON_2026_09_21[0]!);
    expect(w.name).toBe(`${WORKOUT_PREFIX}Contre-la-montre 20 min`);
    expect(w.description).toBe('Contre-la-montre 20 min — test maximal.');
  });
});

describe('Comparaison, dans les unités que Pierre lit', () => {
  const w: WatchWorkout = {
    name: 'Cairn — Seuil', description: 'Seuil.',
    items: [
      { kind: 'step', type: 'warmup', end: { type: 'time', seconds: 1200 }, target: { type: 'hr', low: 0, high: 155 }, note: 'Échauffement : FC 141–155.' },
      {
        kind: 'repeat', times: 4,
        items: [
          { kind: 'step', type: 'interval', end: { type: 'time', seconds: 300 }, target: { type: 'hr', low: 171, high: 181 }, note: 'Répétition.' },
          { kind: 'step', type: 'recovery', end: { type: 'time', seconds: 90 }, target: { type: 'none' }, note: 'Récupération.' },
        ],
      },
      { kind: 'step', type: 'interval', end: { type: 'time', seconds: 30 }, target: { type: 'pace', slow: 267, fast: 256 }, note: 'Allure.' },
    ],
  };
  const garmin = () => wire(encodeWorkout(w)) as GarminWorkoutPayload & Record<string, unknown>;
  const stepsOf = (p: GarminWorkoutPayload) => p.workoutSegments[0]!.workoutSteps;
  const inRepeat = (p: GarminWorkoutPayload, i: number) => (stepsOf(p)[1]!.workoutSteps as Record<string, unknown>[])[i]!;

  it('deux vitesses qui donnent la même allure à la seconde sont la même consigne', () => {
    const p = garmin();
    const pace = stepsOf(p)[2] as Record<string, number>;
    pace.targetValueOne = Math.round(pace.targetValueOne! * 1000) / 1000;
    pace.targetValueTwo = Math.round(pace.targetValueTwo! * 1000) / 1000;
    expect(compareWorkouts(w, decodeWorkout(p))).toEqual([]);
  });

  it('une seconde d\'allure, un bpm, une seconde de durée : chacun est un écart, dit en clair', () => {
    const p = garmin();
    const warm = stepsOf(p)[0] as Record<string, number>;
    warm.targetValueTwo = 154;
    warm.endConditionValue = 1199;
    (inRepeat(p, 0) as Record<string, number>).targetValueOne = 170;
    (stepsOf(p)[2] as Record<string, number>).targetValueTwo = 1000 / 255;
    expect(compareWorkouts(w, decodeWorkout(p)).map((d) => d.text)).toEqual([
      'Étape 1 — fin : 19:59 au lieu de 20:00',
      'Étape 1 — cible : plafond 154 bpm au lieu de plafond 155 bpm',
      'Étape 2.1 — cible : 170–181 bpm au lieu de 171–181 bpm',
      'Étape 3 — cible : 4:15–4:27/km au lieu de 4:16–4:27/km',
    ]);
  });

  it('une alarme d\'une autre nature que la règle ne passe pas : plancher ajouté, alarme en trop, alarme perdue', () => {
    const p = garmin();
    (stepsOf(p)[0] as Record<string, number>).targetValueOne = 141;
    const rep = inRepeat(p, 0);
    rep.targetType = { workoutTargetTypeId: 1, workoutTargetTypeKey: 'no.target', displayOrder: 1 };
    const rec = inRepeat(p, 1);
    Object.assign(rec, {
      targetType: { workoutTargetTypeId: 4, workoutTargetTypeKey: 'heart.rate.zone', displayOrder: 4 },
      targetValueOne: 150, targetValueTwo: 160, zoneNumber: null,
    });
    expect(compareWorkouts(w, decodeWorkout(p)).map((d) => d.text)).toEqual([
      'Étape 1 — alarme : 141–155 bpm au lieu de plafond 155 bpm — un plancher : la montre pousserait à accélérer',
      'Étape 2.1 — alarme : aucune alarme au lieu de 171–181 bpm',
      "Étape 2.2 — alarme : 150–160 bpm au lieu d'aucune alarme — un plancher : la montre pousserait à accélérer",
    ]);
  });

  it('une zone Garmin n\'est pas une plage de Cairn, une note tronquée se dit tronquée', () => {
    const p = garmin();
    const warm = stepsOf(p)[0] as Record<string, unknown>;
    warm.zoneNumber = 2;
    warm.description = String(warm.description).slice(0, 10);
    const texts = compareWorkouts(w, decodeWorkout(p)).map((d) => d.text);
    expect(texts[0]).toBe('Étape 1 — alarme : zone Garmin 2 (FC) au lieu de plafond 155 bpm — un plancher : la montre pousserait à accélérer');
    expect(texts[1]).toMatch(/^Étape 1 — note tronquée après 10 caractères sur \d+$/);
  });

  it('ce que Garmin coupe et marque de « ... » se dit coupé par Garmin', () => {
    const p = garmin();
    const warm = stepsOf(p)[0] as Record<string, unknown>;
    const note = String(warm.description);
    warm.description = `${note.slice(0, 20)}...`;
    expect(compareWorkouts(w, decodeWorkout(p)).map((d) => d.text)).toEqual([
      `Étape 1 — note tronquée par Garmin après 20 caractères sur ${note.length}`,
    ]);
  });

  it('une structure différente se nomme au lieu de tout désaligner', () => {
    const p = garmin();
    stepsOf(p).pop();
    expect(compareWorkouts(w, decodeWorkout(p)).map((d) => d.text)).toEqual([
      'Séance — structure : 2 étapes au lieu de 3 étapes',
    ]);
    const q = garmin();
    (stepsOf(q)[1] as Record<string, unknown>).numberOfIterations = 3;
    expect(compareWorkouts(w, decodeWorkout(q)).map((d) => d.text)).toEqual([
      'Étape 2 — répétitions : 3 fois au lieu de 4 fois',
    ]);
  });
});

describe('Empreinte', () => {
  it('ne dépend que du jour et du contenu — pas de l\'identifiant que la reconstruction a donné', () => {
    const a = workoutOf(DECIDED_ON_2026_09_21[1]!);
    const b = workoutOf({ ...DECIDED_ON_2026_09_21[1]! });
    expect(fingerprintOf('2026-09-27', a)).toBe(fingerprintOf('2026-09-27', b));
    expect(fingerprintOf('2026-09-28', a)).not.toBe(fingerprintOf('2026-09-27', a));
    const lighter = workoutOf({
      ...DECIDED_ON_2026_09_21[1]!,
      blocks: DECIDED_ON_2026_09_21[1]!.blocks.map((b, i) => (i === 0 ? { ...b, durationS: 1800 } : b)),
    });
    expect(fingerprintOf('2026-09-27', lighter)).not.toBe(fingerprintOf('2026-09-27', a));
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Réconciliateur
// ─────────────────────────────────────────────────────────────────────────────

const TODAY = '2026-09-22';

function session(over: Partial<PlannedSession> & { id: string; date: string }): PlannedSession {
  return {
    athleteId: 'pierre', type: 'endurance', title: `Endurance fondamentale — ${over.date}`, intent: 'Construire le foncier.',
    blocks: [{ label: 'Footing', zone: 'Z2', durationS: 3600, ...Z2 } as SessionBlock],
    plannedLoad: 50, plannedMechanicalLoad: 5, plannedDurationS: 3600, priority: 'support', status: 'planned',
    ...over,
  };
}

function entryFor(s: PlannedSession, workoutId: number, over: Partial<LedgerEntry> = {}): LedgerEntry {
  const w = workoutOf(s);
  return {
    workoutId, scheduleId: workoutId + 1, sessionId: s.id, date: s.date, fingerprint: fingerprintOf(s.date, w),
    name: w.name, state: 'verified', discrepancies: null, sentAt: '2026-09-21T08:00:00.000Z',
    verifiedAt: '2026-09-21T08:00:01.000Z', deletedAt: null, ...over,
  };
}

const placed = (e: LedgerEntry, date = e.date): CalendarWorkout => ({
  scheduleId: e.scheduleId!, workoutId: e.workoutId, date, title: e.name,
});

/** Les séances que Pierre a construites lui-même : jamais touchées. */
const HIS: CalendarWorkout[] = [
  { scheduleId: 9001, workoutId: 777, date: '2026-09-23', title: 'Long Pyramid' },
  { scheduleId: 9002, workoutId: 778, date: '2026-09-25', title: 'Uphill Intervals' },
  { scheduleId: 9003, workoutId: 779, date: '2026-09-24', title: `${WORKOUT_PREFIX}ma version à moi` },
];

describe('Réconciliateur : ce qu\'il fait', () => {
  const a = session({ id: 'a', date: '2026-09-22' });
  const b = session({ id: 'b', date: '2026-09-24' });

  it('fenêtre de sept jours, aujourd\'hui compris', () => {
    const s = desiredState([a, b, session({ id: 'far', date: '2026-09-29' })], TODAY);
    expect(s.horizon).toBe('2026-09-28');
    expect(s.desired.map((d) => d.sessionId)).toEqual(['a', 'b']);
  });

  it('Garmin vide : il crée ce que le plan prévoit', () => {
    const state = desiredState([a, b], TODAY);
    expect(planReconciliation({ state, ledger: [], calendar: HIS }).map((o) => o.op)).toEqual(['create', 'create']);
  });

  it('déjà en place : aucune écriture', () => {
    const state = desiredState([a, b], TODAY);
    const ledger = [entryFor(a, 1), entryFor(b, 3)];
    const ops = planReconciliation({ state, ledger, calendar: [...HIS, ...ledger.map((e) => placed(e))] });
    expect(ops.map((o) => o.op)).toEqual(['keep', 'keep']);
  });

  it('une reconstruction qui ne change rien ne réécrit rien, même avec d\'autres identifiants', () => {
    const ledger = [entryFor(a, 1), entryFor(b, 3)];
    const rebuilt = [{ ...a, id: 'a2' }, { ...b, id: 'b2' }];
    const ops = planReconciliation({ state: desiredState(rebuilt, TODAY), ledger, calendar: ledger.map((e) => placed(e)) });
    expect(ops.every((o) => o.op === 'keep')).toBe(true);
  });

  it('une séance allégée remplace sa version : le retrait d\'abord, la création ensuite', () => {
    const old = entryFor(b, 3);
    const lighter = { ...b, blocks: [{ label: 'Footing', zone: 'Z2' as const, durationS: 2700, ...Z2 }] };
    const ops = planReconciliation({ state: desiredState([lighter], TODAY), ledger: [old], calendar: [placed(old)] });
    expect(ops).toMatchObject([
      { op: 'remove', entry: { workoutId: 3 }, deleteWorkout: true },
      { op: 'create', desired: { sessionId: 'b', date: '2026-09-24' } },
    ]);
  });

  it('une séance décalée quitte son ancien jour et arrive au nouveau', () => {
    const old = entryFor(b, 3);
    const moved = { ...b, date: '2026-09-26', status: 'moved' as const };
    const ops = planReconciliation({ state: desiredState([moved], TODAY), ledger: [old], calendar: [placed(old)] });
    expect(ops.map((o) => o.op)).toEqual(['remove', 'create']);
    expect(ops[1]).toMatchObject({ desired: { date: '2026-09-26' } });
  });

  it('une séance retirée ou annulée est supprimée de Garmin', () => {
    const e = entryFor(b, 3);
    for (const status of ['withdrawn', 'cancelled'] as const) {
      const ops = planReconciliation({ state: desiredState([{ ...b, status }], TODAY), ledger: [e], calendar: [placed(e)] });
      expect(ops).toMatchObject([{ op: 'remove', entry: { workoutId: 3 }, deleteWorkout: true }]);
    }
  });

  it('une séance de Cairn effacée à la main sur Garmin est nettoyée puis renvoyée', () => {
    const e = entryFor(b, 3);
    const ops = planReconciliation({ state: desiredState([b], TODAY), ledger: [e], calendar: [] });
    expect(ops).toMatchObject([
      { op: 'remove', entry: { workoutId: 3 }, reason: 'absente du calendrier Garmin' },
      { op: 'create', desired: { sessionId: 'b' } },
    ]);
  });

  it('le doublon que Garmin renvoie pour chaque planification ne fait rien retirer', () => {
    const e = entryFor(b, 3);
    const twice = [placed(e), placed(e), ...HIS, ...HIS];
    expect(planReconciliation({ state: desiredState([b], TODAY), ledger: [e], calendar: twice }).map((o) => o.op)).toEqual(['keep']);
  });

  it('une séance créée mais jamais relue est relue, pas recréée', () => {
    const e = entryFor(b, 3, { state: 'sending' });
    const ops = planReconciliation({ state: desiredState([b], TODAY), ledger: [e], calendar: [placed(e)] });
    expect(ops).toMatchObject([{ op: 'keep', verify: true }]);
  });
});

describe('Réconciliateur : ce qu\'il ne touche jamais', () => {
  it('les séances que Pierre a construites — même nommées comme les nôtres, même le jour d\'une des nôtres', () => {
    const b = session({ id: 'b', date: '2026-09-24' });
    const e = entryFor(b, 3);
    const withdrawn = { ...b, status: 'withdrawn' as const };
    for (const sessions of [[], [b], [withdrawn], [session({ id: 'c', date: '2026-09-23' })]]) {
      const ops = planReconciliation({ state: desiredState(sessions, TODAY), ledger: [e], calendar: [...HIS, placed(e)] });
      const touched = ops.filter((o) => o.op === 'remove').flatMap((o) => (o.op === 'remove' ? [o.entry.workoutId, ...o.scheduleIds] : []));
      for (const his of HIS) {
        expect(touched).not.toContain(his.workoutId);
        expect(touched).not.toContain(his.scheduleId);
      }
    }
  });

  it('le passé : une séance d\'hier n\'est ni retirée ni remplacée', () => {
    const y = session({ id: 'y', date: '2026-09-21' });
    const e = entryFor(y, 5);
    const ops = planReconciliation({ state: desiredState([{ ...y, status: 'missed' }], TODAY), ledger: [e], calendar: [placed(e)] });
    expect(ops).toEqual([]);
  });

  it('la journée dont la séance est faite reste telle quelle', () => {
    const t = session({ id: 't', date: TODAY });
    const e = entryFor(t, 7);
    const done = { ...t, status: 'completed' as const };
    expect(planReconciliation({ state: desiredState([done], TODAY), ledger: [e], calendar: [placed(e)] })).toEqual([]);
    expect(planReconciliation({ state: desiredState([done], TODAY), ledger: [e], calendar: [] })).toEqual([]);
  });

  it('une séance planifiée aussi dans le passé perd sa planification périmée, pas son historique', () => {
    const b = session({ id: 'b', date: '2026-09-24' });
    const e = entryFor(b, 3);
    const ops = planReconciliation({
      state: desiredState([], TODAY),
      ledger: [e],
      calendar: [placed(e), { ...placed(e), scheduleId: 42, date: '2026-09-20' }],
    });
    expect(ops).toMatchObject([{ op: 'remove', scheduleIds: [e.scheduleId], deleteWorkout: false }]);
  });

  it('au-delà de l\'horizon, rien ne bouge', () => {
    const f = session({ id: 'f', date: '2026-10-02' });
    const e = entryFor(f, 9);
    expect(planReconciliation({ state: desiredState([], TODAY), ledger: [e], calendar: [placed(e)] })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Passage complet contre un faux Garmin
// ─────────────────────────────────────────────────────────────────────────────

function garminLimits(w: Record<string, unknown>): void {
  const clip = (v: unknown, max: number) => (typeof v === 'string' && v.length > max ? `${v.slice(0, max - 3)}...` : v);
  w.description = clip(w.description, 1024);
  const walk = (list: Record<string, unknown>[]) =>
    list.forEach((s) => {
      s.description = clip(s.description, 512);
      if (Array.isArray(s.workoutSteps)) walk(s.workoutSteps as Record<string, unknown>[]);
    });
  walk((w.workoutSegments as { workoutSteps: Record<string, unknown>[] }[])[0]!.workoutSteps);
}

class FakeGarmin implements GarminApi {
  workouts = new Map<number, Record<string, unknown>>();
  items: (CalendarWorkout & { itemType: string })[] = HIS.map((c) => ({ ...c, itemType: 'workout' }));
  log: string[] = [];
  watchSync: WatchSync | null = { name: 'Venu 2', syncedAt: '2026-09-22T06:00:00.000Z' };
  /**
   * Ce que Garmin fait subir à une séance en l'enregistrant. Par défaut, ce
   * qu'on a mesuré sur le vrai le 21/09/2026 : au-delà de 512 caractères pour
   * une note et de 1 024 pour la description, il coupe et ajoute « ... ».
   */
  alter: (w: Record<string, unknown>) => void = garminLimits;
  deleteKeepsSchedules = false;
  failOn: Partial<Record<string, Error>> = {};
  private next = 1000;

  constructor() {
    for (const c of HIS) this.workouts.set(c.workoutId!, { workoutId: c.workoutId, workoutName: c.title });
  }

  private hit(op: string) {
    this.log.push(op);
    const e = this.failOn[op.split(':')[0]!];
    if (e) throw e;
  }

  /** Comme le vrai : chaque élément du mois revient deux fois. */
  async calendar(year: number, month: number) {
    this.hit('calendar');
    const prefix = `${year}-${String(month + 1).padStart(2, '0')}`;
    const once = this.items.filter((i) => i.date.startsWith(prefix)).map(({ itemType: _, ...c }) => ({ ...c }));
    return [...once, ...once.map((c) => ({ ...c }))];
  }
  async createWorkout(payload: GarminWorkoutPayload) {
    this.hit('create');
    const id = this.next++;
    const stored = { ...wire(payload), workoutId: id } as Record<string, unknown>;
    this.alter(stored);
    this.workouts.set(id, stored);
    return id;
  }
  async getWorkout(id: number) {
    this.hit(`get:${id}`);
    return this.workouts.has(id) ? wire(this.workouts.get(id)) : null;
  }
  async deleteWorkout(id: number) {
    this.hit(`delete:${id}`);
    this.workouts.delete(id);
    if (!this.deleteKeepsSchedules) this.items = this.items.filter((i) => i.workoutId !== id);
  }
  async schedule(workoutId: number, date: string) {
    this.hit(`schedule:${workoutId}`);
    const w = this.workouts.get(workoutId);
    if (!w) throw new GarminRejected('séance inconnue', 404);
    const id = this.next++;
    this.items.push({ scheduleId: id, workoutId, date, title: String(w.workoutName), itemType: 'workout' });
    return id;
  }
  async unschedule(scheduleId: number) {
    this.hit(`unschedule:${scheduleId}`);
    this.items = this.items.filter((i) => i.scheduleId !== scheduleId);
  }
  async watch() {
    this.hit('watch');
    return this.watchSync;
  }

  /** Les séances de Cairn que porte le calendrier ce jour-là. */
  cairnOn(date: string) {
    return this.items.filter((i) => i.date === date && i.title.startsWith(WORKOUT_PREFIX) && i.workoutId !== 779);
  }
  writes() {
    return this.log.filter((l) => !/^(calendar|get|watch)/.test(l));
  }
}

function memoryLedger(): LedgerStore & { all: LedgerEntry[] } {
  const all: LedgerEntry[] = [];
  return {
    all,
    list: async () => all.filter((e) => e.state !== 'deleted').map((e) => ({ ...e })),
    insert: async (e) => void all.push({ ...e }),
    update: async (id, patch) => void Object.assign(all.find((e) => e.workoutId === id)!, patch),
  };
}

const clock = () => new Date('2026-09-22T07:00:00.000Z');

describe('Passage complet', () => {
  const week = [
    session({ id: 'a', date: '2026-09-22' }),
    session({ id: 'b', date: '2026-09-24' }),
    { ...session({ id: 's', date: '2026-09-25' }), type: 'strength' as const },
    session({ id: 'c', date: '2026-09-27' }),
  ];

  it('crée, planifie, relit et vérifie ; au passage suivant, plus aucune écriture', async () => {
    const g = new FakeGarmin();
    const ledger = memoryLedger();
    const r = await reconcile(g, ledger, desiredState(week, TODAY), clock);
    expect(r).toMatchObject({ created: 3, verified: 3, mismatched: 0, removed: 0, rejected: [] });
    expect(ledger.all.map((e) => e.state)).toEqual(['verified', 'verified', 'verified']);
    for (const d of ['2026-09-22', '2026-09-24', '2026-09-27']) expect(g.cairnOn(d)).toHaveLength(1);
    // La séance de renforcement ne part pas.
    expect(g.cairnOn('2026-09-25')).toHaveLength(0);

    g.log = [];
    const again = await reconcile(g, ledger, desiredState(week, TODAY), clock);
    expect(again).toMatchObject({ created: 0, removed: 0, kept: 3 });
    expect(g.writes()).toEqual([]);
    expect(g.log).toEqual(['calendar', 'watch']);
  });

  it('allégée : l\'ancienne version part avant que la nouvelle n\'arrive, et la suppression est vérifiée', async () => {
    const g = new FakeGarmin();
    const ledger = memoryLedger();
    await reconcile(g, ledger, desiredState(week, TODAY), clock);
    const old = ledger.all.find((e) => e.date === '2026-09-24')!;
    const lighter = week.map((s) => (s.id === 'b' ? { ...s, blocks: [{ label: 'Footing', zone: 'Z2' as const, durationS: 2700, ...Z2 }] } : s));
    g.log = [];
    const r = await reconcile(g, ledger, desiredState(lighter, TODAY), clock);
    expect(r).toMatchObject({ created: 1, removed: 1, verified: 1 });
    expect(g.writes().indexOf(`delete:${old.workoutId}`)).toBeLessThan(g.writes().indexOf('create'));
    expect(g.cairnOn('2026-09-24')).toHaveLength(1);
    expect(ledger.all.find((e) => e.workoutId === old.workoutId)!.state).toBe('deleted');
    expect(g.workouts.has(old.workoutId)).toBe(false);
  });

  it('les séances de Pierre sortent intactes de n\'importe quel passage', async () => {
    const g = new FakeGarmin();
    const ledger = memoryLedger();
    await reconcile(g, ledger, desiredState(week, TODAY), clock);
    await reconcile(g, ledger, desiredState([], TODAY), clock);
    for (const his of HIS) {
      expect(g.workouts.has(his.workoutId!)).toBe(true);
      expect(g.items.some((i) => i.scheduleId === his.scheduleId)).toBe(true);
    }
    expect(g.log.filter((l) => /(777|778|779|900[123])$/.test(l) && !l.startsWith('get'))).toEqual([]);
  });

  it('les vraies séances de la semaine passent la relecture d\'un Garmin qui coupe comme le vrai', async () => {
    const g = new FakeGarmin();
    const ledger = memoryLedger();
    const long = session({
      id: 'l', date: '2026-09-23',
      blocks: [{ label: 'Footing', zone: 'Z2', durationS: 3600, ...Z2, notes: 'Appuis courts. '.repeat(60).trim() }],
    });
    const week = [...DECIDED_ON_2026_09_21, ENDURANCE_RENFORCEMENT, long].filter((s) => s.date <= '2026-09-28');
    const r = await reconcile(g, ledger, desiredState(week, TODAY), clock);
    expect(r).toMatchObject({ created: 4, verified: 4, mismatched: 0 });
  });

  it('une valeur que Garmin a changée est un écart nommé, et la séance n\'est pas renvoyée en boucle', async () => {
    const g = new FakeGarmin();
    g.alter = (w) => {
      garminLimits(w);
      const s = (w.workoutSegments as { workoutSteps: Record<string, number>[] }[])[0]!.workoutSteps[0]!;
      s.targetValueTwo = s.targetValueTwo! - 1;
    };
    const ledger = memoryLedger();
    const r = await reconcile(g, ledger, desiredState([week[1]!], TODAY), clock);
    expect(r).toMatchObject({ created: 1, mismatched: 1, verified: 0 });
    expect(ledger.all[0]!.discrepancies).toEqual(['Étape 1 — cible : plafond 154 bpm au lieu de plafond 155 bpm']);
    g.log = [];
    await reconcile(g, ledger, desiredState([week[1]!], TODAY), clock);
    expect(g.writes()).toEqual([]);
  });

  it('une planification qui survit à la suppression de sa séance est retirée, puis vérifiée', async () => {
    const g = new FakeGarmin();
    const ledger = memoryLedger();
    await reconcile(g, ledger, desiredState([week[1]!], TODAY), clock);
    g.deleteKeepsSchedules = true;
    await reconcile(g, ledger, desiredState([], TODAY), clock);
    expect(g.cairnOn('2026-09-24')).toEqual([]);
    expect(g.log.some((l) => l.startsWith('unschedule'))).toBe(true);
  });

  it('interrompu entre la création et la planification, le passage suivant répare', async () => {
    const g = new FakeGarmin();
    const ledger = memoryLedger();
    g.failOn.schedule = new GarminUnreachable('réseau coupé');
    await expect(reconcile(g, ledger, desiredState([week[1]!], TODAY), clock)).rejects.toThrow('réseau coupé');
    expect(ledger.all).toMatchObject([{ state: 'sending', scheduleId: null }]);
    delete g.failOn.schedule;
    const r = await reconcile(g, ledger, desiredState([week[1]!], TODAY), clock);
    expect(r).toMatchObject({ removed: 1, created: 1, verified: 1 });
    expect(g.cairnOn('2026-09-24')).toHaveLength(1);
    expect([...g.workouts.values()].filter((w) => String(w.workoutName).startsWith(WORKOUT_PREFIX) && w.workoutId !== 779)).toHaveLength(1);
  });

  it('une séance que Garmin refuse est signalée, sans rien laisser derrière elle', async () => {
    const g = new FakeGarmin();
    g.failOn.create = new GarminRejected('Garmin refuse POST /workout-service/workout (400) : invalid step', 400);
    const ledger = memoryLedger();
    const r = await reconcile(g, ledger, desiredState([week[1]!], TODAY), clock);
    expect(r.rejected).toMatchObject([{ date: '2026-09-24', message: expect.stringContaining('invalid step') }]);
    expect(ledger.all).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Ce que l'écran dit
// ─────────────────────────────────────────────────────────────────────────────

describe('État affiché', () => {
  const b = session({ id: 'b', date: '2026-09-24' });
  const sync = (over: Partial<GarminSyncState> = {}): GarminSyncState => ({
    outcome: 'ok', message: null, lastRunAt: '2026-09-22T07:00:00.000Z', lastSuccessAt: '2026-09-22T07:00:00.000Z',
    watchName: 'Venu 2', watchSyncedAt: '2026-09-22T06:00:00.000Z', rejections: [], ...over,
  });
  const view = (sessions: PlannedSession[], ledger: LedgerEntry[], s: GarminSyncState | null = sync(), connected = true) =>
    garminView({ today: TODAY, sessions, ledger, sync: s, connected });

  it('vérifiée : sur ta montre quand elle s\'est synchronisée après l\'envoi, sur Garmin Connect sinon', () => {
    const e = entryFor(b, 3, { sentAt: '2026-09-22T05:00:00.000Z' });
    expect(view([b], [e]).bySession.b).toMatchObject({ state: 'verified', label: 'Vérifiée, sur ta montre' });
    const later = { ...e, sentAt: '2026-09-22T06:30:00.000Z' };
    expect(view([b], [later]).bySession.b).toMatchObject({ state: 'verified', label: 'Vérifiée, sur Garmin Connect' });
    expect(view([b], [later], sync({ watchSyncedAt: null })).bySession.b!.label).toBe('Vérifiée, sur Garmin Connect');
  });

  it('vérifiée mais abrégée : la séance le dit', () => {
    const long = { ...b, intent: 'Tenir sans dériver. '.repeat(80) };
    const w = workoutOf(long);
    const e = { ...entryFor(long, 3), fingerprint: fingerprintOf(long.date, w) };
    expect(view([long], [e]).bySession.b).toMatchObject({ state: 'verified', detail: expect.stringContaining('abrégée') });
  });

  it('écart : lequel', () => {
    const e = entryFor(b, 3, { state: 'mismatch', discrepancies: ['Étape 1 — cible : plafond 154 bpm au lieu de plafond 155 bpm'] });
    expect(view([b], [e]).bySession.b).toEqual({
      state: 'mismatch', label: 'Écart sur Garmin', short: 'écart Garmin',
      detail: 'Étape 1 — cible : plafond 154 bpm au lieu de plafond 155 bpm', tone: 'warn',
    });
  });

  it('modifiée et pas encore renvoyée : en attente, et l\'ancienne version est nommée', () => {
    const e = entryFor(b, 3);
    const lighter = { ...b, blocks: [{ label: 'Footing', zone: 'Z2' as const, durationS: 2700, ...Z2 }] };
    expect(view([lighter], [e]).bySession.b).toMatchObject({
      state: 'pending', detail: "l'ancienne version est encore sur Garmin",
    });
    expect(view([lighter], [e], sync({ outcome: 'unreachable', message: 'réseau coupé' })).bySession.b).toMatchObject({
      state: 'unreachable', label: 'Garmin injoignable', detail: "l'ancienne version est encore sur ta montre",
    });
    expect(view([lighter], [e]).overview.stale).toEqual([{ date: '2026-09-24', name: e.name }]);
  });

  it('jeton mort : reconnexion Garmin nécessaire, jusque dans chaque séance en attente', () => {
    const v = view([b], [], sync({ outcome: 'reauth' }));
    expect(v.overview.problem).toMatch(/^Reconnexion Garmin nécessaire/);
    expect(v.bySession.b).toMatchObject({ state: 'reauth', label: 'Reconnexion Garmin nécessaire' });
    expect(view([b], [entryFor({ ...b, id: 'x', date: '2026-09-23' }, 9)], null, false).overview.connection).toBe('reauth');
  });

  it('jamais connecté : rien n\'est affirmé', () => {
    expect(view([b], [], null, false)).toMatchObject({ overview: { connection: 'disconnected' }, bySession: {} });
  });

  it('non envoyée, et pourquoi ; retirée mais encore sur Garmin', () => {
    const s = { ...session({ id: 's', date: '2026-09-25' }), type: 'strength' as const };
    expect(view([s], []).bySession.s).toMatchObject({ state: 'not_sent', detail: expect.stringContaining('renforcement') });
    const e = entryFor(b, 3);
    expect(view([{ ...b, status: 'withdrawn' }], [e]).bySession.b).toMatchObject({ label: 'Encore sur Garmin' });
  });
});

describe('Quand parler à Garmin', () => {
  const base = { signature: 'S', now: Date.parse('2026-09-22T08:00:00Z'), checkEveryMs: 3_600_000, sessionWrittenAt: null };
  const row = (over: object) => ({
    outcome: 'ok' as const, message: null, lastRunAt: '2026-09-22T07:50:00Z', lastSuccessAt: '2026-09-22T07:50:00Z',
    signature: 'S', failures: 0, watchName: null, watchSyncedAt: null, rejections: [], ...over,
  });

  it('au premier passage, quand le plan change, et chaque heure — pas entre-temps', () => {
    expect(garminDue({ ...base, sync: null })).toBe(true);
    expect(garminDue({ ...base, sync: row({}) })).toBe(false);
    expect(garminDue({ ...base, sync: row({ signature: 'autre' }) })).toBe(true);
    expect(garminDue({ ...base, sync: row({ lastRunAt: '2026-09-22T06:59:00Z' }) })).toBe(true);
  });

  it('après un échec, des tentatives espacées ; après un jeton mort, seulement une fois reconnecté', () => {
    expect(garminDue({ ...base, sync: row({ outcome: 'unreachable', failures: 3 }) })).toBe(true);
    expect(garminDue({ ...base, sync: row({ outcome: 'unreachable', failures: 4 }) })).toBe(false);
    expect(garminDue({ ...base, sync: row({ outcome: 'reauth', signature: 'autre' }) })).toBe(false);
    expect(garminDue({ ...base, sync: row({ outcome: 'reauth' }), sessionWrittenAt: Date.parse('2026-09-22T07:55:00Z') })).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Session et client
// ─────────────────────────────────────────────────────────────────────────────

describe('Session et client Garmin', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'cairn-garmin-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  const jwt = (claims: object) =>
    `${Buffer.from('{"alg":"RS256"}').toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.sig`;
  const NOW = Date.parse('2026-09-22T08:00:00Z');
  const fresh = jwt({ exp: NOW / 1000 + 3600, client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI' });

  function fakeFetch(routes: (url: string, init: RequestInit) => Response | Promise<Response>) {
    const calls: { url: string; init: RequestInit }[] = [];
    const f = (async (url: string | URL, init: RequestInit = {}) => {
      calls.push({ url: String(url), init });
      return routes(String(url), init);
    }) as typeof fetch;
    return { f, calls };
  }
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });

  it('les jetons s\'écrivent en 600 dans un dossier en 700, et un lien symbolique n\'est jamais suivi', () => {
    const s = new SessionFile(join(dir, 'garmin', 'session.json'));
    s.write({ di_token: fresh, di_refresh_token: 'R1', di_client_id: 'C' });
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    expect(statSync(join(dir, 'garmin')).mode & 0o777).toBe(0o700);
    expect(s.read()).toEqual({ di_token: fresh, di_refresh_token: 'R1', di_client_id: 'C' });
    chmodSync(s.path, 0o644);
    s.read();
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
    const link = new SessionFile(join(dir, 'lien.json'));
    symlinkSync(s.path, link.path);
    expect(() => link.read()).toThrow(/illisible/);
  });

  it('un 401 renouvelle le jeton, rejoue la requête, et garde le jeton tourné — jamais dans un message', async () => {
    const s = new SessionFile(join(dir, 'session.json'));
    s.write({ di_token: 'OLD', di_refresh_token: 'R1', di_client_id: 'C' });
    const { f, calls } = fakeFetch((url, init) => {
      if (url.includes('diauth')) return json(200, { access_token: fresh, refresh_token: 'R2' });
      const auth = (init.headers as Record<string, string>).Authorization;
      return auth === `Bearer ${fresh}` ? json(200, { calendarItems: [] }) : json(401, {});
    });
    const api = new GarminConnect(s, { fetch: f, now: () => NOW });
    await expect(api.calendar(2026, 8)).resolves.toEqual([]);
    expect(calls.map((c) => c.url.replace(/^https:\/\/([^/]+).*/, '$1'))).toEqual([
      'connectapi.garmin.com', 'diauth.garmin.com', 'connectapi.garmin.com',
    ]);
    expect(s.read()).toMatchObject({ di_token: fresh, di_refresh_token: 'R2', di_client_id: 'GARMIN_CONNECT_MOBILE_ANDROID_DI' });
    expect(statSync(s.path).mode & 0o777).toBe(0o600);
  });

  it('un jeton qui ne se renouvelle plus : reconnexion nécessaire ; une panne : Garmin injoignable', async () => {
    const s = new SessionFile(join(dir, 'session.json'));
    s.write({ di_token: 'OLD', di_refresh_token: 'R1', di_client_id: 'C' });
    const dead = fakeFetch((url) => (url.includes('diauth') ? json(400, { error: 'invalid_grant' }) : json(401, {})));
    const err = await new GarminConnect(s, { fetch: dead.f, now: () => NOW }).calendar(2026, 8).catch((e) => e);
    expect(err).toBeInstanceOf(GarminReauthRequired);
    expect(String(err.message)).not.toContain('R1');

    s.write({ di_token: fresh, di_refresh_token: 'R1', di_client_id: 'C' });
    for (const reply of [() => json(429, {}), () => json(503, {}), () => { throw new TypeError('fetch failed'); }]) {
      const down = fakeFetch(reply);
      const e = await new GarminConnect(s, { fetch: down.f, now: () => NOW }).calendar(2026, 8).catch((x) => x);
      expect(e).toBeInstanceOf(GarminUnreachable);
      expect(String(e.message)).not.toContain(fresh);
    }
  });

  it('un jeton sur le point d\'expirer se renouvelle avant l\'appel ; un autre processus l\'a déjà fait, on le reprend', async () => {
    const s = new SessionFile(join(dir, 'session.json'));
    const soon = jwt({ exp: NOW / 1000 + 60 });
    s.write({ di_token: soon, di_refresh_token: 'R1', di_client_id: 'C' });
    const renewed = fakeFetch((url) => (url.includes('diauth') ? json(200, { access_token: fresh }) : json(200, { calendarItems: [] })));
    await new GarminConnect(s, { fetch: renewed.f, now: () => NOW }).calendar(2026, 8);
    expect(renewed.calls[0]!.url).toContain('diauth');
    expect(s.read()!.di_refresh_token).toBe('R1');

    const api = new GarminConnect(s, { fetch: renewed.f, now: () => NOW });
    s.write({ di_token: soon, di_refresh_token: 'R1', di_client_id: 'C' });
    await api.calendar(2026, 8).catch(() => undefined);
    const other = jwt({ exp: NOW / 1000 + 7200 });
    s.write({ di_token: other, di_refresh_token: 'R9', di_client_id: 'C' });
    const quiet = fakeFetch(() => json(200, { calendarItems: [] }));
    const api2 = new GarminConnect(s, { fetch: quiet.f, now: () => NOW });
    await api2.refresh();
    expect(quiet.calls).toEqual([]);

    // Forcé, il demande vraiment à Garmin — c'est ce que vérifie `npm run garmin -- test`.
    const forced = fakeFetch(() => json(200, { access_token: fresh }));
    await new GarminConnect(s, { fetch: forced.f, now: () => NOW }).refresh({ force: true });
    expect(forced.calls.map((c) => new URL(c.url).host)).toEqual(['diauth.garmin.com']);
    expect(s.read()).toMatchObject({ di_token: fresh, di_refresh_token: 'R9' });
  });

  it('l\'heure de synchronisation ne vaut que pour la montre principale', async () => {
    const s = new SessionFile(join(dir, 'session.json'));
    s.write({ di_token: fresh, di_refresh_token: 'R1', di_client_id: 'C' });
    const at = Date.parse('2026-09-20T10:35:16Z');
    const reply = (last: string) =>
      fakeFetch((url) =>
        url.endsWith('/deviceregistration/devices')
          ? json(200, [{ productDisplayName: 'Venu 2', displayName: 'Venu 2', primary: true }, { productDisplayName: 'Index S2', primary: false }])
          : json(200, { lastUsedDeviceName: last, lastUsedDeviceUploadTime: at }),
      );
    expect(await new GarminConnect(s, { fetch: reply('Venu 2').f, now: () => NOW }).watch()).toEqual({
      name: 'Venu 2', syncedAt: '2026-09-20T10:35:16.000Z',
    });
    expect(await new GarminConnect(s, { fetch: reply('Index S2').f, now: () => NOW }).watch()).toBeNull();
  });

  it('le calendrier ne rend que des séances planifiées, une fois chacune, avec leur numéro et celui de leur planification', async () => {
    const s = new SessionFile(join(dir, 'session.json'));
    s.write({ di_token: fresh, di_refresh_token: 'R1', di_client_id: 'C' });
    const pyramid = { id: 11, itemType: 'workout', workoutId: 777, workoutScheduleId: 11, date: '2026-09-23', title: 'Long Pyramid' };
    const { f } = fakeFetch(() =>
      json(200, {
        calendarItems: [pyramid, { id: 12, itemType: 'activity', workoutId: null, date: '2026-09-21', title: 'Trail' }, pyramid],
      }),
    );
    expect(await new GarminConnect(s, { fetch: f, now: () => NOW }).calendar(2026, 8)).toEqual([
      { scheduleId: 11, workoutId: 777, date: '2026-09-23', title: 'Long Pyramid' },
    ]);
  });
});

describe('Tables Garmin', () => {
  it('se créent depuis la définition Drizzle, sans db:push, et deux fois sans dommage', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cairn-db-'));
    const client = createClient({ url: `file:${join(dir, 'x.sqlite')}` });
    try {
      for (let pass = 0; pass < 2; pass++) {
        for (const table of [tables.garminWorkouts, tables.garminSync]) {
          for (const statement of createStatements(table)) await client.execute(statement);
        }
      }
      const cols = await client.execute("select name, type, pk, \"notnull\" from pragma_table_info('garmin_workouts')");
      expect(cols.rows.map((r) => r.name)).toEqual([
        'workout_id', 'athlete_id', 'session_id', 'date', 'fingerprint', 'name', 'schedule_id', 'state',
        'discrepancies', 'sent_at', 'verified_at', 'deleted_at', 'created_at', 'updated_at',
      ]);
      const idx = await client.execute("select name from sqlite_master where type = 'index' and tbl_name = 'garmin_workouts'");
      expect(idx.rows.map((r) => r.name)).toContain('garmin_workouts_athlete_date_idx');
    } finally {
      client.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
