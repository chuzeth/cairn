import { describe, expect, it } from 'vitest';
import { LAB_TEST_2025_07_24, PIERRE, type PlannedSession, type RaceGoal } from '@cairn/core';
import { modelFromLabOnly, msToKmh } from '@cairn/physiology';
import {
  allocatePhases, assumedCtl, buildPeriodization, buildTrainingPlan, buildWeek,
  evaluateAdjustments, mondayOf, taperWeeks, weeksBetween,
} from '@cairn/coach';
// La bibliothèque de séances est ré-exportée par l'index du paquet.
import * as lib from '@cairn/coach';

const model = modelFromLabOnly(LAB_TEST_2025_07_24, '2026-09-01');

const RACE: RaceGoal = {
  id: 'race_test',
  athleteId: 'pierre',
  name: 'Trail test',
  date: '2026-12-05',
  priority: 'A',
  course: { distanceM: 32000, elevationGainM: 1200, elevationLossM: 1200, technicality: 3, expectedTempC: 10 },
  target: { placing: 10 },
};

describe('Périodisation', () => {
  it('calcule le lundi de la semaine', () => {
    expect(mondayOf('2026-09-01')).toBe('2026-08-31'); // mardi → lundi précédent
    expect(mondayOf('2026-08-31')).toBe('2026-08-31');
    expect(mondayOf('2026-09-06')).toBe('2026-08-31'); // dimanche → lundi de sa semaine
  });

  it('allonge l\'affûtage avec la durée de la course', () => {
    expect(taperWeeks(45 * 60)).toBe(1);
    expect(taperWeeks(3 * 3600)).toBe(2);
    expect(taperWeeks(12 * 3600)).toBe(3);
  });

  it('répartit les phases dans le bon ordre et sans perte de semaine', () => {
    const phases = allocatePhases(16, 2);
    expect(phases).toHaveLength(16);
    expect(phases.slice(-2)).toEqual(['taper', 'taper']);
    const order = ['base', 'build', 'specific', 'taper'];
    let last = -1;
    for (const p of phases) {
      const i = order.indexOf(p);
      expect(i).toBeGreaterThanOrEqual(last);
      last = i;
    }
  });

  it('sacrifie la base avant la spécificité quand le temps manque', () => {
    const phases = allocatePhases(5, 2);
    expect(phases).toHaveLength(5);
    expect(phases.filter((p) => p === 'specific').length).toBeGreaterThan(0);
  });

  it('place une décharge toutes les quatre semaines de construction', () => {
    const specs = buildPeriodization({
      startDate: '2026-09-01', race: RACE, estimatedRaceDurationS: 3 * 3600,
      currentCtl: 45, constraints: PIERRE.constraints, raceElevationGainM: 1200,
    });
    const deloads = specs.filter((s) => s.isDeload);
    expect(deloads.length).toBeGreaterThan(0);
    for (const d of deloads) {
      const prev = specs[d.index - 1];
      if (prev) expect(d.targetLoad).toBeLessThan(prev.targetLoad);
    }
  });

  it('respecte le plafond horaire déclaré', () => {
    const specs = buildPeriodization({
      startDate: '2026-01-01', race: { ...RACE, date: '2026-12-05' }, estimatedRaceDurationS: 3 * 3600,
      currentCtl: 60, constraints: { ...PIERRE.constraints, maxWeeklyHours: 6 }, raceElevationGainM: 1200,
    });
    for (const s of specs) expect(s.targetLoad).toBeLessThanOrEqual(6 * 55 + 1);
  });

  it('estime une charge de départ plausible depuis les heures déclarées', () => {
    expect(assumedCtl({ ...PIERRE.constraints, maxWeeklyHours: 9 })).toBeGreaterThan(30);
    expect(assumedCtl({ ...PIERRE.constraints, maxWeeklyHours: 9 })).toBeLessThan(70);
    expect(assumedCtl({ ...PIERRE.constraints, maxWeeklyHours: 4 })).toBeLessThan(
      assumedCtl({ ...PIERRE.constraints, maxWeeklyHours: 12 }),
    );
  });
});

describe('Bibliothèque de séances', () => {
  it('prescrit des allures issues du modèle, pas des valeurs figées', () => {
    const s = lib.threshold(model, 5, 5);
    const work = s.blocks.find((b) => b.zone === 'Z4');
    expect(work).toBeDefined();
    const [lo, hi] = work!.speedRangeMs!;
    // Le seuil 2 est à 16,8 km/h : les répétitions doivent être juste au-dessus.
    expect(msToKmh(lo)).toBeGreaterThan(16.8);
    expect(msToKmh(hi)).toBeLessThan(17.6);
    expect(work!.hrRange![0]).toBe(171);
  });

  it('suit le modèle quand la vitesse critique évolue', () => {
    const fitter = { ...model, vt2: { ...model.vt2, speedMs: model.vt2.speedMs * 1.05 } };
    const before = lib.threshold(model, 5, 5).blocks.find((b) => b.zone === 'Z4')!.speedRangeMs![0];
    const after = lib.threshold(fitter, 5, 5).blocks.find((b) => b.zone === 'Z4')!.speedRangeMs![0];
    expect(after).toBeGreaterThan(before * 1.04);
  });

  it('cible la PMA au-dessus de la VMA sur le fractionné court', () => {
    const s = lib.vo2max(model, '30-30', 2, 10);
    const work = s.blocks.find((b) => b.zone === 'Z5')!;
    expect(work.durationS).toBe(30);
    expect(work.repeat).toBe(20);
    expect(msToKmh(work.speedRangeMs![0])).toBeGreaterThan(msToKmh(model.vmaMs) * 1.03);
  });

  it('donne une vitesse ascensionnelle cible en côte', () => {
    const s = lib.hillRepeats(model, 8, 90, 0.1);
    const work = s.blocks.find((b) => b.vamTargetMh)!;
    expect(work.vamTargetMh).toBeGreaterThan(700);
    expect(work.vamTargetMh).toBeLessThan(1800);
  });

  it('attribue une charge mécanique à la séance de descente, pas au tempo', () => {
    expect(lib.downhillSession(model, 6, 150).plannedMechanicalLoad).toBeGreaterThan(
      lib.tempo(model, 25).plannedMechanicalLoad,
    );
  });

  it('estime une charge cohérente : une heure au seuil vaut ~100 points', () => {
    const s = lib.threshold(model, 6, 10); // 60 min de travail au seuil
    expect(s.plannedLoad).toBeGreaterThan(95);
    expect(s.plannedLoad).toBeLessThan(190); // échauffement et retour au calme inclus
  });
});

describe('Construction de la semaine', () => {
  const specs = buildPeriodization({
    startDate: '2026-09-01', race: RACE, estimatedRaceDurationS: 3 * 3600,
    currentCtl: 45, constraints: PIERRE.constraints, raceElevationGainM: 1200,
  });

  it('place la sortie longue sur un jour autorisé', () => {
    for (const spec of specs.slice(0, 6)) {
      const week = buildWeek({ spec, model, constraints: PIERRE.constraints, athleteId: 'pierre', race: RACE });
      const long = week.sessions.find((s) => s.type === 'long_run' || s.type === 'long_trail');
      if (!long) continue;
      const dow = new Date(`${long.date}T00:00:00Z`).getUTCDay();
      expect(PIERRE.constraints.longRunDays).toContain(dow);
    }
  });

  it('espace les séances clefs d\'au moins 48 h', () => {
    for (const spec of specs) {
      const week = buildWeek({ spec, model, constraints: PIERRE.constraints, athleteId: 'pierre', race: RACE });
      const keys = week.sessions
        .filter((s) => s.priority === 'key')
        .map((s) => new Date(`${s.date}T00:00:00Z`).getTime())
        .sort((a, b) => a - b);
      for (let i = 1; i < keys.length; i++) {
        expect((keys[i]! - keys[i - 1]!) / 86_400_000).toBeGreaterThanOrEqual(2);
      }
    }
  });

  it('ne dépasse pas le nombre de séances de qualité autorisé', () => {
    // La sortie longue est une séance clef mais pas une séance *de qualité* :
    // la contrainte porte sur les stimuli intenses.
    const LONG = new Set(['long_run', 'long_trail', 'race']);
    const constraints = { ...PIERRE.constraints, maxQualitySessionsPerWeek: 1 };
    for (const spec of specs) {
      const week = buildWeek({ spec, model, constraints, athleteId: 'pierre', race: RACE });
      const quality = week.sessions.filter((s) => s.priority === 'key' && !LONG.has(s.type));
      expect(quality.length).toBeLessThanOrEqual(1);
    }
  });

  it('approche la charge cible sans la dépasser massivement', () => {
    for (const spec of specs.filter((s) => s.phase !== 'taper')) {
      const week = buildWeek({ spec, model, constraints: PIERRE.constraints, athleteId: 'pierre', race: RACE });
      const total = week.sessions.reduce((a, s) => a + s.plannedLoad, 0);
      expect(total).toBeGreaterThan(spec.targetLoad * 0.6);
      expect(total).toBeLessThan(spec.targetLoad * 1.55);
    }
  });

  it('borne la durée des footings de semaine', () => {
    for (const spec of specs) {
      const week = buildWeek({ spec, model, constraints: PIERRE.constraints, athleteId: 'pierre', race: RACE });
      for (const s of week.sessions.filter((x) => x.type === 'endurance')) {
        expect(s.plannedDurationS).toBeLessThanOrEqual(115 * 60);
      }
    }
  });

  it('n\'utilise que des jours disponibles', () => {
    const constraints = { ...PIERRE.constraints, availableDays: [1, 3, 5, 6], longRunDays: [6] };
    const week = buildWeek({ spec: specs[2]!, model, constraints, athleteId: 'pierre', race: RACE });
    for (const s of week.sessions) {
      expect(constraints.availableDays).toContain(new Date(`${s.date}T00:00:00Z`).getUTCDay());
    }
  });
});

describe('Plan complet', () => {
  const { plan, weeks } = buildTrainingPlan({
    athleteId: 'pierre', model, constraints: PIERRE.constraints, race: RACE,
    currentCtl: 0, estimatedRaceDurationS: 3 * 3600, startDate: '2026-09-01',
  });

  it('couvre toutes les semaines jusqu\'à la course', () => {
    expect(weeks.length).toBe(weeksBetween('2026-09-01', RACE.date) + 1);
    expect(weeks[weeks.length - 1]!.phase).toBe('taper');
  });

  it('insère la course le jour J et remplace la séance prévue', () => {
    const all = weeks.flatMap((w) => w.sessions);
    const raceDay = all.filter((s) => s.date === RACE.date);
    expect(raceDay).toHaveLength(1);
    expect(raceDay[0]!.type).toBe('race');
  });

  it('signale une charge de départ estimée quand l\'historique est vide', () => {
    expect(plan.revisionLog[0]!.summary).toContain('estimée');
  });

  it('ne produit aucune date en double', () => {
    const all = weeks.flatMap((w) => w.sessions).map((s) => s.date);
    expect(new Set(all).size).toBe(all.length);
  });

  it('vise un TSB positif le jour de la course', () => {
    expect(plan.targetRaceDayTsb).toBeGreaterThan(0);
  });
});

describe('Règles d\'ajustement automatique', () => {
  const session = (over: Partial<PlannedSession>): PlannedSession => ({
    id: 's1', athleteId: 'pierre', date: '2026-09-02', type: 'downhill',
    title: 'Descente', intent: '', blocks: [], plannedLoad: 60, plannedMechanicalLoad: 50,
    plannedDurationS: 3600, priority: 'support', status: 'planned', ...over,
  });

  const baseState = (over: Record<string, unknown> = {}) =>
    ({
      today: { date: '2026-09-01', ctl: 50, atl: 55, tsb: -5, mechanicalTsb: 0, acwr: 1.0, rampRate: 3, monotony: 1.4, tsbLabel: '', acwrLabel: '', acwrRisk: 'low' },
      readiness: { date: '2026-09-01', score: 75, verdict: 'green', components: {}, recommendation: '' },
      ...over,
    }) as never;

  it('allège une séance excentrique quand les quadriceps ne sont pas récupérés', () => {
    const state = baseState({
      today: { date: '2026-09-01', ctl: 50, atl: 55, tsb: -5, mechanicalTsb: -30, acwr: 1.0, rampRate: 3, monotony: 1.4, tsbLabel: '', acwrLabel: '', acwrRisk: 'low' },
    });
    const adj = evaluateAdjustments(state, [session({ date: '2026-09-02' })]);
    expect(adj).toHaveLength(1);
    expect(adj[0]!.rule).toBe('mechanical_fatigue');
    expect(adj[0]!.factor).toBeLessThan(1);
  });

  it('ne touche à rien quand tout est au vert', () => {
    expect(evaluateAdjustments(baseState(), [session({ date: '2026-09-05' })])).toHaveLength(0);
  });

  it('marque manquée une séance passée non réalisée', () => {
    const adj = evaluateAdjustments(baseState(), [session({ date: '2026-08-20', type: 'endurance' })]);
    expect(adj.some((a) => a.rule === 'missed_session')).toBe(true);
  });

  it('allège les séances secondaires sur un pic de charge', () => {
    const state = baseState({
      today: { date: '2026-09-01', ctl: 50, atl: 90, tsb: -40, mechanicalTsb: 0, acwr: 1.8, rampRate: 3, monotony: 1.4, tsbLabel: '', acwrLabel: '', acwrRisk: 'high' },
    });
    const adj = evaluateAdjustments(state, [session({ date: '2026-09-03', type: 'endurance', plannedMechanicalLoad: 5 })]);
    expect(adj.some((a) => a.rule === 'acwr_spike')).toBe(true);
  });

  it('protège le lendemain quand la disponibilité est au rouge', () => {
    const state = baseState({
      readiness: { date: '2026-09-01', score: 30, verdict: 'red', components: {}, recommendation: 'Repos.' },
    });
    const tomorrow = session({ date: '2026-09-02', type: 'threshold', plannedLoad: 80, plannedMechanicalLoad: 5 });
    expect(evaluateAdjustments(state, [tomorrow]).some((a) => a.rule === 'readiness_red')).toBe(true);

    // Le verdict se lit dans l'état, pas dans l'horloge : la même séance, jugée
    // depuis un état daté d'une semaine plus tôt, n'est plus « le lendemain ».
    // Sans cette garantie la règle change d'avis en franchissant minuit, et le
    // test ci-dessus pourrit tout seul.
    const earlier = baseState({
      today: { date: '2026-08-26', ctl: 50, atl: 55, tsb: -5, mechanicalTsb: 0, acwr: 1.0, rampRate: 3, monotony: 1.4, tsbLabel: '', acwrLabel: '', acwrRisk: 'low' },
      readiness: { date: '2026-08-26', score: 30, verdict: 'red', components: {}, recommendation: 'Repos.' },
    });
    expect(evaluateAdjustments(earlier, [tomorrow]).some((a) => a.rule === 'readiness_red')).toBe(false);
  });

  it('n\'applique qu\'une règle par séance', () => {
    const state = baseState({
      today: { date: '2026-09-01', ctl: 50, atl: 95, tsb: -45, mechanicalTsb: -35, acwr: 1.9, rampRate: 12, monotony: 2.5, tsbLabel: '', acwrLabel: '', acwrRisk: 'high' },
      readiness: { date: '2026-09-01', score: 20, verdict: 'red', components: {}, recommendation: '' },
    });
    const adj = evaluateAdjustments(state, [session({ date: '2026-09-02' })]);
    expect(adj.filter((a) => a.sessionId === 's1')).toHaveLength(1);
  });
});

describe('Cycle de charge 3:1', () => {
  const specs = buildPeriodization({
    startDate: '2026-01-05',
    race: { ...RACE, date: '2026-12-05' },
    estimatedRaceDurationS: 3 * 3600,
    currentCtl: 40,
    constraints: { ...PIERRE.constraints, maxWeeklyHours: 12 },
    raceElevationGainM: 1200,
  });

  it('rebondit au-dessus du pic après une semaine de décharge', () => {
    for (let i = 1; i < specs.length - 1; i++) {
      const deload = specs[i]!;
      const next = specs[i + 1]!;
      if (!deload.isDeload || next.phase === 'taper' || next.isDeload) continue;
      const peakBefore = Math.max(...specs.slice(0, i).map((s) => s.targetLoad));
      // La semaine qui suit une décharge doit repartir du pic, pas du plancher.
      expect(next.targetLoad).toBeGreaterThan(deload.targetLoad * 1.2);
      expect(next.targetLoad).toBeGreaterThanOrEqual(peakBefore * 0.98);
    }
  });

  it("n'affûte jamais au-dessus du pic de charge atteint", () => {
    const peak = Math.max(...specs.filter((s) => s.phase !== 'taper').map((s) => s.targetLoad));
    for (const s of specs.filter((x) => x.phase === 'taper')) {
      expect(s.targetLoad).toBeLessThan(peak);
    }
  });

  it('fait décroître les semaines d\'affûtage jusqu\'à la course', () => {
    const taper = specs.filter((s) => s.phase === 'taper');
    for (let i = 1; i < taper.length; i++) {
      expect(taper[i]!.targetLoad).toBeLessThan(taper[i - 1]!.targetLoad);
    }
  });
});

describe('Remplacement du contenu d\'une séance', () => {
  const blocks = (over: Record<string, unknown>[] = []) => [
    { label: 'Échauffement progressif', zone: 'Z2', durationS: 1500 },
    ...over,
  ];

  it('déduit des zones les cibles omises et l\'allure de la vitesse', () => {
    const [b] = lib.parseSessionBlocks(blocks(), model);
    const z2 = model.vt1;
    expect(b!.hrRange).toEqual([Math.round(0.91 * z2.hr), z2.hr]);
    expect(b!.speedRangeMs![1]).toBeCloseTo(z2.speedMs, 6);
    // L'allure est dérivée de la vitesse, dans l'ordre lisible (plus rapide d'abord).
    expect(b!.paceRange![0] < b!.paceRange![1]).toBe(true);
  });

  it('accepte une cible qui sort de la bande de zone, jusqu\'à la FC maximale', () => {
    // Le défaut corrigé : un test maximal exige une FC moyenne ≥ SV2, que le
    // plafond de Z4 (1,023 × SV2) interdit d'exprimer. La borne est la
    // physiologie de l'athlète, pas la bande de zone.
    const [b] = lib.parseSessionBlocks(
      [{ label: 'Contre-la-montre 20 min', zone: 'Z4', durationS: 1200, hrRange: [model.vt2.hr, model.hrMax] }],
      model,
    );
    expect(b!.hrRange).toEqual([model.vt2.hr, model.hrMax]);
    expect(b!.hrRange![1]).toBeGreaterThan(Math.round(1.023 * model.vt2.hr));

    expect(() =>
      lib.parseSessionBlocks(
        [{ label: 'Impossible', zone: 'Z5', durationS: 600, hrRange: [180, model.hrMax + 5] }],
        model,
      ),
    ).toThrow(/hors bornes/);
  });

  it('refuse une allure saisie à la main, un champ inconnu, un bloc sans étendue', () => {
    const bad = (b: Record<string, unknown>) => () => lib.parseSessionBlocks([b], model);
    expect(bad({ label: 'x', zone: 'Z3', durationS: 600, paceRange: ['4:00', '4:30'] })).toThrow(/déduite/);
    expect(bad({ label: 'x', zone: 'Z3', durationS: 600, tempoMax: 12 })).toThrow(/champ inconnu/);
    expect(bad({ label: 'x', zone: 'Z3' })).toThrow(/durationS ou distanceM/);
    expect(bad({ label: '  ', zone: 'Z3', durationS: 600 })).toThrow(/vide/);
    expect(bad({ label: 'x', zone: 'Z9', durationS: 600 })).toThrow(/zone attendue/);
    expect(bad({ label: 'x', zone: 'Z3', durationS: 600, hrRange: [170, 150] })).toThrow(/borne basse/);
    expect(() => lib.parseSessionBlocks([], model)).toThrow(/au moins un bloc/);
  });

  it('fait suivre les totaux de la séance au contenu remplacé', () => {
    const replaced = lib.parseSessionBlocks(
      [
        { label: 'Échauffement progressif', zone: 'Z2', durationS: 1500 },
        { label: 'Contre-la-montre 20 min', zone: 'Z4', durationS: 1200, hrRange: [model.vt2.hr, model.hrMax] },
        { label: 'Retour au calme', zone: 'Z1', durationS: 600 },
      ],
      model,
    );
    const totals = lib.sessionTotals(model, replaced);
    expect(totals.durationS).toBe(3300);
    // Vingt minutes au-dessus du seuil coûtent plus qu'un tempo de même durée :
    // la charge se déduit du contenu, elle ne reste pas sur celle d'avant.
    const tempo = lib.sessionTotals(
      model,
      lib.parseSessionBlocks(
        [
          { label: 'Échauffement progressif', zone: 'Z2', durationS: 1500 },
          { label: 'Tempo continu', zone: 'Z3', durationS: 1200 },
          { label: 'Retour au calme', zone: 'Z1', durationS: 600 },
        ],
        model,
      ),
    );
    expect(totals.load).toBeGreaterThan(tempo.load);
    expect(totals.durationS).toBe(tempo.durationS);
  });

  it('somme le dénivelé des répétitions', () => {
    const totals = lib.sessionTotals(
      model,
      lib.parseSessionBlocks(
        [{ label: 'Côte', zone: 'Z4', durationS: 180, repeat: 6, elevationGainM: 50, recovery: { durationS: 120, zone: 'Z1' } }],
        model,
      ),
    );
    expect(totals.elevationGainM).toBe(300);
    expect(totals.durationS).toBe(6 * 300);
  });
});
