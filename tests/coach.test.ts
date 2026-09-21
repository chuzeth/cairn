import { describe, expect, it } from 'vitest';
import {
  ECCENTRIC_MOVEMENT_TEXT, LAB_TEST_2025_07_24, PIERRE, buildDirectives, directivesFor,
  sessionDuration,
  type DeclaredAbsence, type PlannedSession, type RaceGoal, type TrainingWeek,
} from '@cairn/core';
import { DURABILITY_MEASURABLE, modelFromLabOnly, msToKmh, projectFrom } from '@cairn/physiology';
import {
  INTERVAL_FORMAT, TAPER_SCALE_BOUNDS, absenceCovering, allocatePhases, assumedCtl,
  buildPeriodization, buildTrainingPlan, buildWeek, carryDecisions, carryFitness, decisionOn,
  evaluateAdjustments, isIntervalSession, mondayOf, taperWeeks, weeksBetween, withdrawalsFor,
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

  it('porte le plafond horaire déclaré sans en fabriquer une durée', () => {
    const specs = buildPeriodization({
      startDate: '2026-01-01', race: { ...RACE, date: '2026-12-05' }, estimatedRaceDurationS: 3 * 3600,
      currentCtl: 60, constraints: { ...PIERRE.constraints, maxWeeklyHours: 6 }, raceElevationGainM: 1200,
    });
    // Le squelette ne dit pas combien de temps dure une semaine — il ne sait pas
    // ce qu'elle contiendra. Il dit ce qu'elle vise et ce qu'elle n'a pas le
    // droit de dépasser.
    for (const s of specs) {
      expect(s).not.toHaveProperty('targetDurationS');
      expect(s.maxDurationS).toBe(6 * 3600);
    }
    // Le poids d'une semaine est un rapport de deux charges, sans conversion.
    const peak = Math.max(...specs.map((x) => x.targetLoad));
    for (const s of specs) expect(s.loadShare).toBeCloseTo(s.targetLoad / peak, 6);
    expect(Math.max(...specs.map((x) => x.loadShare))).toBe(1);
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
    // Le domaine sévère commence à la vitesse critique, pas au SV2 : le moteur
    // tire le second du premier en le divisant par 1,02, et une répétition calée
    // sous l'asymptote n'entame pas la réserve — ce n'est pas du seuil.
    expect(lo).toBeGreaterThan(model.criticalSpeedMs);
    expect(msToKmh(hi)).toBeLessThan(msToKmh(model.criticalSpeedMs) * 1.05);
    // La bande de FC, elle, reste celle du compte rendu.
    expect(work!.hrRange![0]).toBe(171);
    expect(work!.hrRange![1]).toBe(175);
  });

  it('suit le modèle quand la vitesse critique évolue', () => {
    const fitter = { ...model, criticalSpeedMs: model.criticalSpeedMs * 1.05 };
    const before = lib.threshold(model, 5, 5).blocks.find((b) => b.zone === 'Z4')!.speedRangeMs![0];
    const after = lib.threshold(fitter, 5, 5).blocks.find((b) => b.zone === 'Z4')!.speedRangeMs![0];
    expect(after).toBeGreaterThan(before * 1.04);
  });

  it('cible la PMA au-dessus de la VMA sur le fractionné court', () => {
    const s = lib.vo2max(model, '30-30', 2, 10);
    // Deux séries, deux blocs, et la pause de quatre minutes entre eux : elle
    // était une phrase dans les notes, donc invisible à la charge comme au
    // bilan de réserve anaérobie.
    const series = s.blocks.filter((b) => b.zone === 'Z5');
    expect(series).toHaveLength(2);
    expect(series.every((b) => b.durationS === 30)).toBe(true);
    expect(s.blocks.some((b) => b.label.startsWith('Pause entre séries'))).toBe(true);
    expect(msToKmh(series[0]!.speedRangeMs![0])).toBeGreaterThan(msToKmh(model.vmaMs) * 1.03);
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

  it('ne pose plus de forfait mécanique sur le renforcement', () => {
    // La séance « endurance + renforcement » valait `mécanique + 8`, quel que
    // soit le circuit. Elle vaut désormais ce que ses blocs prescrivent, par la
    // même fonction que tout le reste du plan.
    let seen = 0;
    for (const spec of specs) {
      const week = buildWeek({ spec, model, constraints: PIERRE.constraints, athleteId: 'pierre', race: RACE });
      for (const s of week.sessions.filter((x) => x.blocks.some((b) => b.circuit))) {
        seen++;
        expect(s.plannedMechanicalLoad).toBe(
          lib.sessionTotals(model, s.blocks, s.plannedElevationGainM ?? 0).mechanicalLoad,
        );
        expect(lib.eccentricStrengthOf(s.blocks)).toBeGreaterThan(0);
      }
    }
    expect(seen).toBeGreaterThan(0);
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

  it('ne laisse à aucune séance deux dénivelés', () => {
    // L'invariant : le chiffre d'en-tête se refait depuis le contenu, ou la
    // séance dit d'où il vient. Vingt séances sur trente-cinq annonçaient un D+
    // que leurs blocs ne portaient pas — dans les deux sens, jusqu'à 540 m — et
    // c'est le contenu que l'athlète exécute. La course est le seul cas qui ne
    // se dérive pas : elle n'a pas de blocs, et son parcours est un relevé.
    const all = weeks.flatMap((w) => w.sessions);
    expect(all.length).toBeGreaterThan(30);
    let releves = 0;
    for (const s of all) {
      const annonce = Math.round(s.plannedElevationGainM ?? 0);
      if (s.blocks.length === 0 && annonce > 0) {
        releves++;
        expect(s.rationale ?? '', s.date).toMatch(/parcours/);
        continue;
      }
      expect(lib.elevationGainOf(s.blocks), `${s.date} ${s.title}`).toBe(annonce);
      // Et le titre annonce le même, quand il l'annonce.
      const dansLeTitre = / · (\d+) m D\+/.exec(s.title);
      if (dansLeTitre) expect(Number(dansLeTitre[1]), s.date).toBe(annonce);
    }
    expect(releves).toBe(1);
  });

  it('ne produit aucune date en double', () => {
    const all = weeks.flatMap((w) => w.sessions).map((s) => s.date);
    expect(new Set(all).size).toBe(all.length);
  });

  it('vise un TSB positif le jour de la course', () => {
    expect(plan.targetRaceDayTsb).toBeGreaterThan(0);
  });
});

describe('Le plan est mesuré contre la cible qu\'il se donne', () => {
  const build = (over: Partial<Parameters<typeof buildTrainingPlan>[0]> = {}) =>
    buildTrainingPlan({
      athleteId: 'pierre', model, constraints: PIERRE.constraints, race: RACE,
      currentCtl: 45, currentAtl: 45, estimatedRaceDurationS: 3 * 3600,
      startDate: '2026-09-01', ...over,
    });

  /** Re-projection indépendante, depuis les seules séances du plan. */
  const measure = (
    weeks: TrainingWeek[],
    seed: { ctl: number; atl: number },
    from: string,
    to: string,
  ) => {
    const loads = weeks.flatMap((w) => w.sessions.map((s) => ({ date: s.date, load: s.plannedLoad })));
    const points = projectFrom(seed, loads, from, to);
    return points[points.length - 1]!.tsb;
  };

  it('mesure les charges réellement prescrites, pas les cibles de semaine', () => {
    const { weeks, tsbCheck } = build();
    expect(tsbCheck.projected).toBe(measure(weeks, { ctl: 45, atl: 45 }, '2026-08-31', tsbCheck.date));
  });

  it('lit le TSB la veille de la course, pas le jour J', () => {
    const { tsbCheck } = build();
    expect(tsbCheck.date).toBe('2026-12-04');
    // Le jour J porte la charge de la course : y lire le TSB donnerait l'état
    // d'arrivée, très négatif, au lieu de celui du départ.
    const { weeks } = build();
    expect(measure(weeks, { ctl: 45, atl: 45 }, '2026-08-31', RACE.date))
      .toBeLessThan(tsbCheck.projected);
  });

  it('atteint la cible quand la préparation en laisse le temps', () => {
    const { plan, tsbCheck } = build();
    expect(tsbCheck.onTarget).toBe(true);
    expect(Math.abs(tsbCheck.gap)).toBeLessThanOrEqual(0.5);
    expect(tsbCheck.shortfall).toBeNull();
    expect(plan.projectedRaceDayTsb).toBe(tsbCheck.projected);
    expect(plan.raceDayTsbShortfall).toBeUndefined();
  });

  it('dit ce qui manque quand la place manque, au lieu de manquer la cible en silence', () => {
    // Quatre semaines, charge de départ basse : la fraîcheur ne peut pas monter
    // jusqu'à la cible sans défaire la forme que ces semaines construisent.
    const { plan, tsbCheck } = build({
      race: { ...RACE, date: '2026-10-18' },
      currentCtl: 32, currentAtl: 12, startDate: '2026-09-21',
    });
    expect(tsbCheck.onTarget).toBe(false);
    expect(tsbCheck.gap).toBeLessThan(0);
    expect(tsbCheck.shortfall).toContain('plancher');
    expect(plan.raceDayTsbShortfall).toBe(tsbCheck.shortfall);
    // Et le journal du plan le porte, avec les deux nombres.
    expect(plan.revisionLog[0]!.summary).toContain('veille de course');
    expect(plan.revisionLog[0]!.summary).toContain(`${tsbCheck.projected.toFixed(1)}`);
  });

  it('dit aussi l\'écart dans l\'autre sens : plus frais que visé, donc moins entraîné', () => {
    // Forme très haute, mais plus que trois heures par semaine pour la tenir :
    // le plan ne peut plus construire la charge que la cible suppose.
    const { tsbCheck } = build({
      constraints: { ...PIERRE.constraints, maxWeeklyHours: 3 },
      race: { ...RACE, date: '2026-10-25' },
      currentCtl: 95, currentAtl: 95, estimatedRaceDurationS: 2 * 3600, startDate: '2026-09-07',
    });
    expect(tsbCheck.gap).toBeGreaterThan(0);
    expect(tsbCheck.taperScale).toBe(TAPER_SCALE_BOUNDS.max);
    expect(tsbCheck.shortfall).toContain('plafond');
  });

  it('garde l\'affûtage dans ses bornes', () => {
    for (const start of ['2026-09-01', '2026-09-14', '2026-10-19']) {
      const { tsbCheck } = build({ startDate: start, race: { ...RACE, date: '2026-12-05' } });
      expect(tsbCheck.taperScale).toBeGreaterThanOrEqual(TAPER_SCALE_BOUNDS.min);
      expect(tsbCheck.taperScale).toBeLessThanOrEqual(TAPER_SCALE_BOUNDS.max);
    }
  });

  it('ne laisse aucune semaine d\'affûtage dépasser le pic de la préparation', () => {
    const { weeks } = build();
    const peak = Math.max(...weeks.filter((w) => w.phase !== 'taper').map((w) => w.targetLoad));
    for (const w of weeks.filter((x) => x.phase === 'taper')) {
      expect(w.targetLoad).toBeLessThanOrEqual(peak);
    }
  });

  it('part de la fatigue qu\'on lui donne, tant qu\'elle pèse encore', () => {
    // Trois semaines : la fatigue de départ n'a pas fini de s'effacer, et deux
    // athlètes de même forme mais de fraîcheur opposée n'ont pas besoin du même
    // affûtage pour arriver au même TSB.
    const short = { race: { ...RACE, date: '2026-09-20' } };
    const fresh = build({ ...short, currentCtl: 45, currentAtl: 20 });
    const tired = build({ ...short, currentCtl: 45, currentAtl: 70 });
    expect(fresh.tsbCheck.taperScale).toBeGreaterThan(tired.tsbCheck.taperScale);
    // Sur quatorze semaines, la constante de temps de sept jours l'a effacée :
    // c'est la charge chronique qui commande, et le plan converge au même point.
    expect(build({ currentCtl: 45, currentAtl: 20 }).tsbCheck.taperScale)
      .toBe(build({ currentCtl: 45, currentAtl: 70 }).tsbCheck.taperScale);
  });

  it('calibre la première semaine sur la charge du jour du départ, pas sur celle d\'aujourd\'hui', () => {
    // Le cas du dossier : CTL 40,5 aujourd'hui, onze jours de coupure avant que
    // le plan ne commence. Calibrer sur 40,5 propose une semaine de reprise que
    // l'athlète ne peut plus tenir.
    const today = { date: '2026-09-03', ctl: 40.5, atl: 48.6 };
    const carried = carryFitness(today, '2026-09-14', [], []);
    const race = { ...RACE, date: '2026-10-18' };

    const naive = build({ race, startDate: '2026-09-14', currentCtl: today.ctl, currentAtl: today.atl });
    const honest = build({ race, startDate: '2026-09-14', currentCtl: carried.ctl, currentAtl: carried.atl });

    expect(naive.weeks[0]!.targetLoad).toBe(303);
    expect(honest.weeks[0]!.targetLoad).toBe(239);
    expect(honest.weeks[0]!.targetLoad).toBeLessThan(naive.weeks[0]!.targetLoad);
  });
});

describe('Forme reportée au premier jour du plan', () => {
  const today = { date: '2026-09-03', ctl: 40.5, atl: 48.6 };
  const planned = (date: string, over: Partial<PlannedSession> = {}): PlannedSession => ({
    id: `s_${date}`, athleteId: 'pierre', date, type: 'endurance', title: 'Endurance',
    intent: '', blocks: [], plannedLoad: 60, plannedMechanicalLoad: 10,
    plannedDurationS: 3600, priority: 'support', status: 'planned', ...over,
  });

  it('ne reporte rien quand le plan commence demain', () => {
    const carried = carryFitness(today, '2026-09-04', [], []);
    expect(carried).toEqual({ ctl: 40.5, atl: 48.6, gapDays: 0, gapLoad: 0 });
  });

  it('fait payer la coupure : onze jours sans rien font tomber la charge chronique', () => {
    const carried = carryFitness(today, '2026-09-14', [], []);
    expect(carried.gapDays).toBe(10);
    expect(carried.gapLoad).toBe(0);
    expect(carried.ctl).toBeLessThan(today.ctl);
    // La fatigue s'efface plus vite que la forme : c'est ce qui rend le départ
    // frais, et c'est aussi ce que la calibration sur « aujourd'hui » ignorait.
    expect(carried.atl).toBeLessThan(carried.ctl);
  });

  it('compte les séances qui tiennent encore', () => {
    const sessions = ['2026-09-05', '2026-09-08', '2026-09-11'].map((d) => planned(d));
    const carried = carryFitness(today, '2026-09-14', sessions, []);
    expect(carried.gapLoad).toBe(180);
    expect(carried.ctl).toBeGreaterThan(carryFitness(today, '2026-09-14', [], []).ctl);
  });

  it('ne compte pas une séance retirée par une absence déclarée', () => {
    const sessions = ['2026-09-05', '2026-09-08'].map((d) => planned(d));
    const absence: DeclaredAbsence = {
      id: 'abs1', athleteId: 'pierre', startDate: '2026-09-04', endDate: '2026-09-13',
      kind: 'chosen', reason: 'Je coupe.', source: 'athlete', declaredAt: '2026-09-03T07:00:00.000Z',
    };
    expect(carryFitness(today, '2026-09-14', sessions, [absence]).gapLoad).toBe(0);
    // Le statut dit la même chose par l'autre bout.
    const withdrawn = sessions.map((s) => ({ ...s, status: 'withdrawn' as const }));
    expect(carryFitness(today, '2026-09-14', withdrawn, []).gapLoad).toBe(0);
  });

  it('ignore ce qui tombe hors de l\'intervalle', () => {
    const outside = [planned('2026-09-03'), planned('2026-09-14'), planned('2026-09-20')];
    expect(carryFitness(today, '2026-09-14', outside, []).gapLoad).toBe(0);
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
      absences: [],
      // Un état sans modèle n'existe pas en production : les règles de charge
      // annoncent la durée qu'un allègement produira, et c'est le modèle qui la
      // calcule.
      model,
      profile: PIERRE,
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

  it('annonce la durée que la séance portera, pas une minute de plus', () => {
    const state = baseState({
      readiness: { date: '2026-09-01', score: 30, verdict: 'red', components: {}, recommendation: 'Repos.' },
    });
    // 4 089 s allégées de 55 % font 1 840 s, que la maille humaine prescrit à
    // 30 min. Arrondie à part, la phrase en promettait 31 : deux nombres pour la
    // même séance, et c'est la phrase qu'on croit.
    const tomorrow = session({
      date: '2026-09-02', type: 'threshold', plannedLoad: 80, plannedMechanicalLoad: 5,
      plannedDurationS: 4089, blocks: [{ label: 'Bloc continu', zone: 'Z3', durationS: 4089 }],
    });
    const [adj] = evaluateAdjustments(state, [tomorrow]);
    expect(adj!.rule).toBe('readiness_red');
    expect(lib.transformSession(tomorrow, adj!.factor!, model).plannedDurationS).toBe(1800);
    expect(adj!.reason).toContain('ramenée à 30 min');
    expect(adj!.reason).not.toContain('31 min');
  });

  it('protège la filière mécanique quand son ratio s\'emballe, circuit excentrique compris', () => {
    const palier = session({
      id: 'palier', date: '2026-09-02', type: 'endurance', plannedLoad: 25, plannedMechanicalLoad: 10,
      blocks: [
        { label: 'Footing en endurance aérobie', zone: 'Z2', durationS: 1260 },
        {
          label: 'Circuit force', zone: 'Z2', durationS: 420,
          circuit: {
            rounds: 3,
            exercises: [{ movement: 'split_squat', reps: 8 }, { movement: 'eccentric_calf', reps: 12 }],
          },
        },
      ],
    });
    // Le métabolique est calme ; seul l'excentrique a dépassé son seuil.
    const state = baseState({
      today: { date: '2026-09-01', ctl: 50, atl: 55, tsb: -5, mechanicalTsb: 0, acwr: 1.0, mechanicalAcwr: 1.87, rampRate: 3, monotony: 1.4, tsbLabel: '', acwrLabel: '', acwrRisk: 'low' },
    });
    const [adj] = evaluateAdjustments(state, [palier]);
    expect(adj!.rule).toBe('mechanical_acwr_spike');
    expect(adj!.reason).toContain('de 3 à 2 tours');
    const lighter = lib.transformSession(palier, { duration: adj!.factor!, eccentric: adj!.eccentric! }, model);
    const circuit = lighter.blocks[1]!.circuit!;
    expect(circuit.rounds).toBe(2);
    expect(lighter.blocks[1]!.durationS).toBe(lib.circuitDurationS(circuit));
    expect(lighter.plannedMechanicalLoad).toBeLessThan(lib.sessionTotals(model, palier.blocks).mechanicalLoad);

    // Le pic métabolique seul allège ce qui se court et laisse les trois tours :
    // c'était la seule règle, et l'excentrique n'était protégé par rien.
    const metabolic = baseState({
      today: { date: '2026-09-01', ctl: 50, atl: 90, tsb: -40, mechanicalTsb: 0, acwr: 1.8, mechanicalAcwr: 1.0, rampRate: 3, monotony: 1.4, tsbLabel: '', acwrLabel: '', acwrRisk: 'high' },
    });
    const [spike] = evaluateAdjustments(metabolic, [palier]);
    expect(spike!.rule).toBe('acwr_spike');
    expect(lib.transformSession(palier, spike!.factor!, model).blocks[1]!.circuit!.rounds).toBe(3);
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

describe('Allègement d\'une séance', () => {
  const withCircuit = (): PlannedSession => ({
    id: 's1', athleteId: 'pierre', date: '2026-09-14', type: 'endurance',
    title: 'Endurance fondamentale + renforcement', intent: '',
    blocks: [
      { label: 'Footing en endurance aérobie', zone: 'Z2', durationS: 2326 },
      {
        label: 'Circuit force', zone: 'Z2', durationS: 775,
        circuit: {
          rounds: 3,
          exercises: [
            { movement: 'split_squat', reps: 8 },
            { movement: 'step_down', reps: 10 },
            { movement: 'eccentric_calf', reps: 12 },
          ],
        },
      },
      { label: 'Souplesse chaîne postérieure', zone: 'Z1', kind: 'mobility', durationS: 600 },
    ],
    plannedLoad: 45, plannedMechanicalLoad: 30, plannedDurationS: 3701,
    priority: 'support', status: 'planned',
  });

  it('raccourcit ce qui se court, et laisse entier ce que le dossier prescrit', () => {
    const out = lib.transformSession(withCircuit(), 0.45, model);
    // 2 326 s allégées de 55 % font 1 047 s, que le corps de séance prescrit à
    // un quart d'heure : une durée est une consigne, pas le reste d'une division.
    expect(out.blocks[0]!.durationS).toBe(900);
    // Les tours ne suivent pas le facteur ; la durée du circuit ne le peut donc
    // pas non plus, sans quoi la séance prescrit « 5 min » en face de trois
    // tours de trois exercices.
    expect(out.blocks[1]!.circuit!.rounds).toBe(3);
    expect(out.blocks[1]!.durationS).toBe(775);
    expect(out.blocks[2]!.durationS).toBe(600);
  });

  it('relit la durée totale sur les blocs allégés, jamais à côté d\'eux', () => {
    const out = lib.transformSession(withCircuit(), 0.45, model);
    expect(out.plannedDurationS).toBe(900 + 775 + 600);
    // Mise à l'échelle à son tour, elle aurait annoncé 1 665 s pour un contenu
    // qui en dure 2 275 : l'en-tête et les blocs ne disaient plus la même chose.
    expect(out.plannedDurationS).not.toBe(Math.round(3701 * 0.45));
  });

  it('met à l\'échelle le total quand la séance n\'a aucun contenu écrit', () => {
    const bare: PlannedSession = {
      ...withCircuit(), blocks: [], plannedDurationS: 3600,
    };
    expect(lib.transformSession(bare, 0.5, model).plannedDurationS).toBe(1800);
  });
});

describe('Absences déclarées', () => {
  const absence = (over: Partial<DeclaredAbsence> = {}): DeclaredAbsence => ({
    id: 'abs1',
    athleteId: 'pierre',
    startDate: '2026-09-03',
    endDate: '2026-09-13',
    kind: 'chosen',
    reason: 'Je coupe jusqu\'au 13, c\'était prévu.',
    source: 'athlete',
    declaredAt: '2026-09-03T07:00:00.000Z',
    ...over,
  });

  const session = (over: Partial<PlannedSession>): PlannedSession => ({
    id: 's1', athleteId: 'pierre', date: '2026-09-05', type: 'endurance',
    title: 'Endurance', intent: '', blocks: [], plannedLoad: 60, plannedMechanicalLoad: 10,
    plannedDurationS: 3600, priority: 'support', status: 'planned', ...over,
  });

  const stateWith = (absences: DeclaredAbsence[], over: Record<string, unknown> = {}) =>
    ({
      today: { date: '2026-09-14', ctl: 50, atl: 30, tsb: 20, mechanicalTsb: 5, acwr: 0.6, rampRate: -4, monotony: 1.1, tsbLabel: '', acwrLabel: '', acwrRisk: 'low' },
      readiness: { date: '2026-09-14', score: 80, verdict: 'green', components: {}, recommendation: '' },
      absences,
      ...over,
    }) as never;

  it('couvre ses deux bornes', () => {
    const a = [absence()];
    expect(absenceCovering(a, '2026-09-03')?.id).toBe('abs1');
    expect(absenceCovering(a, '2026-09-13')?.id).toBe('abs1');
    expect(absenceCovering(a, '2026-09-02')).toBeUndefined();
    expect(absenceCovering(a, '2026-09-14')).toBeUndefined();
  });

  it('retire les séances de la période, et rien au-delà', () => {
    const out = withdrawalsFor(absence(), [
      session({ id: 'avant', date: '2026-09-02' }),
      session({ id: 'dedans', date: '2026-09-08' }),
      session({ id: 'apres', date: '2026-09-14' }),
    ]);
    expect(out.map((w) => w.sessionId)).toEqual(['dedans']);
    expect(out[0]!.action).toBe('withdraw');
    expect(out[0]!.absenceId).toBe('abs1');
    // Le motif de l'athlète voyage avec le retrait : c'est lui qu'on relira.
    expect(out[0]!.reason).toContain('Je coupe jusqu\'au 13');
  });

  it('ne retire ni un jour de repos ni ce qui a réellement eu lieu', () => {
    const out = withdrawalsFor(absence(), [
      session({ id: 'repos', date: '2026-09-06', type: 'rest' }),
      session({ id: 'faite', date: '2026-09-07', status: 'completed' }),
      session({ id: 'remplacee', date: '2026-09-09', status: 'replaced' }),
      session({ id: 'partielle', date: '2026-09-10', status: 'partial' }),
    ]);
    expect(out).toHaveLength(0);
  });

  it('répare une séance déjà comptée manquée sur la période', () => {
    const out = withdrawalsFor(absence(), [session({ id: 'faussement_manquee', status: 'missed' })]);
    expect(out).toHaveLength(1);
    expect(out[0]!.action).toBe('withdraw');
  });

  it('empêche la règle « séance manquée » de se déclencher sur une absence annoncée', () => {
    const sessions = [
      session({ id: 'coupure', date: '2026-09-08', type: 'tempo' }),
      session({ id: 'hors_coupure', date: '2026-09-01', type: 'tempo' }),
    ];
    const adj = evaluateAdjustments(stateWith([absence()]), sessions);
    const byId = new Map(adj.map((a) => [a.sessionId, a]));
    expect(byId.get('coupure')!.rule).toBe('declared_absence');
    expect(byId.get('hors_coupure')!.rule).toBe('missed_session');
    // Onze jours annoncés ne produisent aucune faute : c'est tout l'enjeu.
    expect(adj.filter((a) => a.rule === 'missed_session' && a.date >= '2026-09-03')).toHaveLength(0);
  });

  it('prime sur les autres règles : une séance retirée n\'est pas allégée', () => {
    const state = stateWith([absence({ startDate: '2026-09-14', endDate: '2026-09-24' })], {
      today: { date: '2026-09-14', ctl: 50, atl: 90, tsb: -40, mechanicalTsb: -30, acwr: 1.8, rampRate: 12, monotony: 2.5, tsbLabel: '', acwrLabel: '', acwrRisk: 'high' },
      readiness: { date: '2026-09-14', score: 25, verdict: 'red', components: {}, recommendation: '' },
    });
    const adj = evaluateAdjustments(state, [session({ id: 'demain', date: '2026-09-15', type: 'downhill', plannedMechanicalLoad: 60 })]);
    expect(adj).toHaveLength(1);
    expect(adj[0]!.rule).toBe('declared_absence');
  });

  it('ne décale pas une séance clef à cause d\'une séance retirée', () => {
    // Sans exclusion, la séance du 16 serait repoussée pour s'espacer d'une
    // séance du 15 que plus personne n'a l'intention de faire.
    const state = stateWith([absence({ startDate: '2026-09-15', endDate: '2026-09-15' })]);
    const adj = evaluateAdjustments(state, [
      session({ id: 'retiree', date: '2026-09-15', priority: 'key' }),
      session({ id: 'apres', date: '2026-09-16', priority: 'key' }),
    ]);
    expect(adj.some((a) => a.sessionId === 'apres')).toBe(false);
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

  it('préserve le marqueur d\'un bloc annexe, et ne lui prête aucune allure', () => {
    // Le défaut : `kind` inexprimable à l'écriture, donc effacé au premier
    // remplacement de blocs. Le contenu restait, mais la fréquence « 2 ×/semaine »
    // du praticien ne comptait plus qu'une séance sur les deux qui la portaient.
    const [b] = lib.parseSessionBlocks(
      [{ label: 'Souplesse chaîne postérieure', zone: 'Z1', durationS: 600, kind: 'mobility' }],
      model,
    );
    expect(b!.kind).toBe('mobility');
    // Un bloc qui ne se court pas n'affiche ni allure ni FC : les déduire de la
    // zone donnerait à des étirements une allure au kilomètre.
    expect(b!.paceRange).toBeUndefined();
    expect(b!.hrRange).toBeUndefined();
    expect(lib.sessionTotals(model, [b!]).load).toBe(0);

    const bad = (over: Record<string, unknown>) => () =>
      lib.parseSessionBlocks(
        [{ label: 'Souplesse', zone: 'Z1', durationS: 600, kind: 'mobility', ...over }],
        model,
      );
    expect(bad({ speedRangeMs: [1, 2] })).toThrow(/ne se court pas/);
    expect(bad({ cadenceTargetSpm: 175 })).toThrow(/ne se court pas/);
    // Et un champ inconnu reste inconnu, même s'il porte le nom d'une méthode
    // d'Object : la table des champs est un ensemble, pas un objet interrogé.
    expect(bad({ toString: 'x' })).toThrow(/champ inconnu/);
    expect(bad({ kind: 'meditation' })).toThrow(/nature attendue/);
    expect(bad({ durationS: undefined })).toThrow(/durationS/);
  });

  it('rend au coach une séance réécrite sans rien lui retirer', () => {
    // Le cas réel : le renforcement du 14/09 réécrit par le coach, revenu sans
    // le `kind` de son bloc de souplesse. Un aller-retour ne doit rien perdre —
    // seul `paceRange` s'en va, parce qu'il se déduit et se refait.
    const avant = lib.strength(model, 2).blocks;
    const ecrit = avant.map(
      ({ paceRange, provenance, ...reste }) => reste as Record<string, unknown>,
    );
    const apres = lib.parseSessionBlocks(ecrit, model);
    expect(apres).toEqual(avant);
    expect(apres.filter((b) => b.kind === 'mobility')).toHaveLength(1);
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

  it('accepte un circuit déclaré et refuse un mouvement qu\'il ne sait pas peser', () => {
    const withCircuit = (circuit: unknown) =>
      lib.parseSessionBlocks([{ label: 'Circuit force', zone: 'Z2', durationS: 1200, circuit }], model);

    const [b] = withCircuit({
      rounds: 2,
      exercises: [{ movement: 'step_down', reps: 10 }, { movement: 'eccentric_calf', reps: 12 }],
    });
    expect(b!.circuit!.rounds).toBe(2);
    expect(lib.sessionTotals(model, [b!]).mechanical.eccentricStrength).toBeGreaterThan(0);

    // Un mouvement libre n'a ni course de freinage ni sévérité : le compter
    // zéro en silence ferait exactement le défaut qu'on corrige.
    expect(() => withCircuit({ rounds: 2, exercises: [{ movement: 'burpees', reps: 10 }] }))
      .toThrow(/mouvement attendu parmi/);
    expect(() => withCircuit({ rounds: 2, exercises: [] })).toThrow(/au moins un exercice/);
    expect(() => withCircuit({ rounds: 0, exercises: [{ movement: 'step_down', reps: 10 }] }))
      .toThrow(/hors bornes/);
    expect(() => withCircuit({ rounds: 2, exercises: [{ movement: 'step_down', reps: 10, tempo: 3 }] }))
      .toThrow(/champ inconnu/);
  });

  it('fait varier la charge mécanique prescrite avec le nombre de tours', () => {
    // Le palier de réintroduction de l'excentrique : 1 tour, puis 2, puis 3.
    // Sans cela, il n'existe que dans le texte d'une séance.
    const tour = (rounds: number) =>
      lib.sessionTotals(
        model,
        lib.parseSessionBlocks(
          [
            { label: 'Footing', zone: 'Z2', durationS: 1260, elevationGainM: 156 },
            {
              label: 'Circuit force', zone: 'Z2', durationS: 420,
              circuit: {
                rounds,
                exercises: [
                  { movement: 'split_squat', reps: 8 },
                  { movement: 'step_down', reps: 10 },
                  { movement: 'single_leg_deadlift', reps: 8 },
                  { movement: 'eccentric_calf', reps: 12 },
                  { movement: 'isometric', reps: 45 },
                ],
              },
            },
          ],
          model,
        ),
        156,
      );
    const [un, deux, trois] = [tour(1), tour(2), tour(3)];
    expect(un.mechanicalLoad).toBeLessThan(deux.mechanicalLoad);
    expect(deux.mechanicalLoad).toBeLessThan(trois.mechanicalLoad);
    // La part descente ne bouge pas : c'est bien le circuit qui porte le palier.
    expect(un.mechanical.descent).toBe(trois.mechanical.descent);
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

  it('fait suivre la charge mécanique au dénivelé remplacé', () => {
    const long = (vertM: number) =>
      lib.sessionTotals(
        model,
        lib.parseSessionBlocks(
          [
            { label: 'Corps de sortie', zone: 'Z2', durationS: 5100, elevationGainM: vertM },
            { label: 'Progression finale', zone: 'Z3', durationS: 1200 },
          ],
          model,
        ),
      );

    // Le défaut : une sortie longue réduite de 700 à 350 m D+ qui gardait la
    // charge mécanique des 700 m. Le PMC mécanique protège les quadriceps ; il
    // ne peut pas le faire sur un chiffre qui décrit la séance d'avant.
    const avant = long(700);
    const apres = long(350);
    expect(apres.elevationGainM).toBe(350);
    expect(apres.mechanicalLoad).toBeLessThan(avant.mechanicalLoad);
    // À défaut de dénivelé négatif sur les blocs, on suppose une boucle.
    expect(apres.mechanicalLoad).toBe(
      lib.sessionTotals(model, lib.parseSessionBlocks(
        [{ label: 'Corps de sortie', zone: 'Z2', durationS: 5100, elevationGainM: 350 },
         { label: 'Progression finale', zone: 'Z3', durationS: 1200 }], model,
      ), 350).mechanicalLoad,
    );
  });

  it('fait porter la charge mécanique par le contenu du circuit', () => {
    const un = lib.strength(model, 1);
    const deux = lib.strength(model, 2);
    const trois = lib.strength(model, 3);

    // Le défaut : un forfait de 8 points, quel que soit le circuit. Un tour et
    // trois tours pesaient pareil, et un palier de réintroduction de
    // l'excentrique n'existait que dans le texte d'une séance.
    expect(un.plannedMechanicalLoad).toBeGreaterThan(0);
    expect(deux.plannedMechanicalLoad).toBeGreaterThan(un.plannedMechanicalLoad);
    expect(trois.plannedMechanicalLoad).toBeGreaterThan(deux.plannedMechanicalLoad);

    // C'est bien le circuit qui fait bouger le chiffre, et lui seul.
    const mech = (t: { blocks: typeof trois.blocks }) => lib.sessionTotals(model, t.blocks).mechanical;
    expect(mech(un).eccentricStrength).toBeLessThan(mech(deux).eccentricStrength);
    expect(mech(deux).eccentricStrength).toBeLessThan(mech(trois).eccentricStrength);
    expect(lib.eccentricStrengthOf(trois.blocks)).toBe(mech(trois).eccentricStrength);

    // Un renforcement ne descend rien : la part que le réalisé saurait
    // confirmer est négligeable, tout le reste est hors flux.
    expect(mech(trois).descent).toBeLessThan(1);
  });

  it('donne la même charge mécanique par la bibliothèque et par les blocs', () => {
    // Deux chemins pour une même séance donnaient deux valeurs : celle que
    // l'athlète lisait dépendait de quel code l'avait touchée en dernier.
    for (const rounds of [1, 2, 3]) {
      const s = lib.strength(model, rounds);
      expect(lib.sessionTotals(model, s.blocks).mechanicalLoad).toBe(s.plannedMechanicalLoad);
    }
  });

  it('décrit le circuit depuis sa structure, jamais à côté', () => {
    const s = lib.strength(model, 2);
    const circuit = s.blocks.find((b) => b.circuit)!.circuit!;
    expect(circuit.rounds).toBe(2);
    expect(lib.describeCircuit(circuit)).toContain('2 tours');
    // Le texte des notes n'annonce aucun décompte : une seule source, donc
    // aucune occasion d'annoncer trois tours et d'en compter un.
    expect(s.blocks.every((b) => !/\d+\s*tours?/.test(b.notes ?? ''))).toBe(true);
  });

  it('fait porter aux blocs le dénivelé que la séance annonce', () => {
    // Le défaut : la descente annonçait 540 m D+ que pas un bloc ne portait, et
    // les côtes 208 m de même. Une navette remonte ce qu'elle descend — c'est
    // la récupération de chaque répétition — et une côte monte ce que ses
    // répétitions montent. Les deux chiffres se refont depuis le contenu.
    const descente = lib.downhillSession(model, 6, 150);
    // Ce n'est plus 540 m : chaque remontée garde sa marge sous la borne de l'instant.
    expect(descente.elevationGainM).toBeGreaterThan(0);
    expect(lib.elevationGainOf(descente.blocks)).toBe(descente.elevationGainM);

    const cotes = lib.hillRepeats(model, 8, 90, 0.1);
    expect(cotes.elevationGainM).toBeGreaterThan(0);
    expect(lib.elevationGainOf(cotes.blocks)).toBe(cotes.elevationGainM);
    expect(lib.hillRepeats(model, 4, 90, 0.1).elevationGainM).toBe(cotes.elevationGainM / 2);
  });

  it('laisse la bibliothèque imposer sa descente quand elle la connaît', () => {
    // Le tempo monte ses cent mètres en s'échauffant mais ne descend rien qui
    // compte : la boucle supposée lui prêterait une contrainte excentrique
    // qu'il n'a pas. Le D− déclaré prime sur ce que les blocs laisseraient
    // deviner — c'est la raison d'être du paramètre.
    const t = lib.tempo(model, 25);
    expect(t.elevationGainM).toBe(100);
    expect(t.elevationLossM).toBe(0);
    expect(t.plannedMechanicalLoad).toBeLessThan(
      lib.sessionTotals(model, t.blocks).mechanicalLoad,
    );
  });
});

describe('Directives du dossier', () => {
  const directives = directivesFor(PIERRE);
  const interpretation = LAB_TEST_2025_07_24.interpretation as string;
  const notes = [
    ...(LAB_TEST_2025_07_24.practitionerNotes ?? []),
    ...(PIERRE.constraints.notes ?? []),
  ];

  it('cite le document sans le reformuler', () => {
    expect(directives.length).toBeGreaterThan(0);
    for (const d of directives) {
      const literal = interpretation.includes(d.origin.quote) || notes.includes(d.origin.quote);
      expect(literal, `${d.id} — « ${d.origin.quote} »`).toBe(true);
    }
  });

  it('échoue au lieu de laisser vivre une citation orpheline', () => {
    expect(() =>
      buildDirectives({ ...LAB_TEST_2025_07_24, interpretation: 'Rien à signaler.' }, PIERRE.constraints.notes),
    ).toThrow(/Extrait introuvable/);
  });

  it('traduit les plages du praticien en secondes, sans les arrondir à sa façon', () => {
    expect(directives.find((d) => d.id === 'foncier_duree')).toMatchObject({
      kind: 'session_duration', minS: 90 * 60, maxS: 150 * 60, appliesTo: ['long_run'],
    });
    expect(directives.find((d) => d.id === 'rando_course_duree')).toMatchObject({
      kind: 'session_duration', minS: 180 * 60, maxS: 300 * 60, appliesTo: ['long_trail'],
    });
  });

  it('nomme ce que le planificateur a tranché et que le dossier ne dit pas', () => {
    // Le dossier constate le déficit ventilatoire sans fixer de fréquence.
    expect(directives.find((d) => d.id === 'respiration')?.derived).toBeTruthy();
    // La cadence, elle, est intégralement portée par sa citation.
    expect(directives.find((d) => d.id === 'cadence')?.derived).toBeUndefined();
  });

  it('ne produit aucune directive quand personne n\'a dépouillé la prose', () => {
    expect(directivesFor({ ...PIERRE, labTests: [] })).toEqual([]);
    expect(buildDirectives({ ...LAB_TEST_2025_07_24, interpretation: undefined })).toEqual([]);
  });
});

describe('Plan qui lit le dossier entier', () => {
  const directives = directivesFor(PIERRE);
  const common = {
    athleteId: 'pierre', model, constraints: PIERRE.constraints, race: RACE,
    currentCtl: 45, estimatedRaceDurationS: 3 * 3600, startDate: '2026-09-01',
  };
  const { weeks } = buildTrainingPlan({ ...common, directives, ambition: PIERRE.ambition });
  const plain = buildTrainingPlan(common).weeks;
  // Ni la décharge ni l'affûtage n'ont à honorer un plancher de durée : ces
  // semaines ont une autre fonction que de construire.
  const building = weeks.filter((w) => !w.isDeload && w.phase !== 'taper');
  const longOf = (w: (typeof weeks)[number]) =>
    w.sessions.find((s) => s.type === 'long_run' || s.type === 'long_trail');

  it('tient le travail foncier dans les plages prescrites', () => {
    for (const w of building) {
      const long = longOf(w);
      if (!long) continue;
      const d = directives.find(
        (x) => x.kind === 'session_duration' && x.appliesTo.includes(long.type),
      );
      expect(d, long.type).toBeDefined();
      if (d?.kind !== 'session_duration') continue;
      expect(long.plannedDurationS, `${w.weekStart} ${long.type}`).toBeGreaterThanOrEqual(d.minS);
      expect(long.plannedDurationS, `${w.weekStart} ${long.type}`).toBeLessThanOrEqual(d.maxS);
    }
  });

  it('corrige aussi bien le défaut que l\'excès', () => {
    // Sans directives, le planificateur produisait des rando-courses trop
    // courtes en début de préparation et des footings trop longs à la fin.
    const tooShort = plain.some((w) => {
      const l = longOf(w);
      return l?.type === 'long_trail' && !w.isDeload && w.phase !== 'taper' && l.plannedDurationS < 180 * 60;
    });
    const tooLong = plain.some((w) => {
      const l = longOf(w);
      return l?.type === 'long_run' && l.plannedDurationS > 150 * 60;
    });
    expect(tooShort || tooLong).toBe(true);
  });

  it('laisse la décharge et l\'affûtage hors du plancher', () => {
    const deloads = weeks.filter((w) => w.isDeload).map(longOf).filter((s) => s != null);
    expect(deloads.length).toBeGreaterThan(0);
    for (const long of deloads) {
      const d = directives.find(
        (x) => x.kind === 'session_duration' && x.appliesTo.includes(long.type),
      );
      if (d?.kind !== 'session_duration') continue;
      expect(long.plannedDurationS).toBeLessThan(d.minS);
    }
  });

  it('fait reculer le volume facile, jamais la séance prescrite', () => {
    // Le plancher de la sortie longue est honoré sans que la semaine explose.
    for (const w of building) {
      const total = w.sessions.reduce((a, s) => a + s.plannedLoad, 0);
      expect(total, w.weekStart).toBeLessThan(w.targetLoad * 1.15);
    }
  });

  it('ne prescrit qu\'un fractionné par semaine, en alternant court et moyen', () => {
    const sequence: ('short' | 'medium')[] = [];
    for (const w of weeks) {
      const intervals = w.sessions.filter((s) => isIntervalSession(s.type));
      expect(intervals.length, w.weekStart).toBeLessThanOrEqual(1);
      // La semaine de course fait exception : ses six répétitions sont un rappel
      // de foulée, pas le fractionné de la semaine.
      const isRaceWeek = w.sessions.some((s) => s.type === 'race');
      if (intervals[0] && !isRaceWeek) {
        sequence.push(INTERVAL_FORMAT[intervals[0].type] as 'short' | 'medium');
      }
    }
    expect(sequence.length).toBeGreaterThan(4);
    for (let i = 1; i < sequence.length; i++) {
      expect(sequence[i], `position ${i} de ${sequence.join(',')}`).not.toBe(sequence[i - 1]);
    }
  });

  it('honore les fréquences hebdomadaires, sur des jours distincts', () => {
    for (const w of weeks) {
      for (const kind of ['mobility', 'respiratory'] as const) {
        const days = new Set(
          w.sessions.filter((s) => s.blocks.some((b) => b.kind === kind)).map((s) => s.date),
        );
        expect(days.size, `${w.weekStart} ${kind}`).toBe(2);
      }
      // Jamais un jour de repos : ce jour a une fonction.
      for (const s of w.sessions.filter((x) => x.type === 'rest')) {
        expect(s.blocks).toHaveLength(0);
      }
    }
  });

  it('ne prescrit plus de cadence hors de la fenêtre du praticien', () => {
    const cadences = weeks.flatMap((w) =>
      w.sessions.flatMap((s) => s.blocks.map((b) => b.cadenceTargetSpm)),
    ).filter((c): c is number => c != null);
    expect(cadences.length).toBeGreaterThan(20);
    for (const c of cadences) {
      expect(c).toBeGreaterThanOrEqual(170);
      expect(c).toBeLessThanOrEqual(180);
    }
    // Sans directives, la bibliothèque demandait jusqu'à 182 ppm.
    const before = plain.flatMap((w) =>
      w.sessions.flatMap((s) => s.blocks.map((b) => b.cadenceTargetSpm)),
    ).filter((c): c is number => c != null);
    expect(Math.max(...before)).toBeGreaterThan(180);
  });

  it('attache le critère de dérive cardiaque, avec la phrase qui le demande', () => {
    const aerobic = weeks.flatMap((w) =>
      w.sessions.filter((s) => ['endurance', 'long_run', 'long_trail'].includes(s.type)),
    );
    expect(aerobic.length).toBeGreaterThan(10);
    for (const s of aerobic) {
      const criterion = s.successCriteria?.find((c) => c.metric === 'hr_drift');
      expect(criterion, `${s.date} ${s.type}`).toBeDefined();
      expect((LAB_TEST_2025_07_24.interpretation as string).includes(criterion!.origin.quote)).toBe(true);
    }
    // Aucune sur les séances que le dossier ne vise pas.
    for (const s of weeks.flatMap((w) => w.sessions).filter((x) => x.type === 'threshold')) {
      expect(s.successCriteria ?? []).toHaveLength(0);
    }
  });

  it('laisse sur chaque séance l\'extrait qui a fixé sa forme', () => {
    const traced = weeks.flatMap((w) => w.sessions).filter((s) => (s.directives?.length ?? 0) > 0);
    expect(traced.length).toBeGreaterThan(20);
    for (const s of traced) {
      for (const d of lib.describeDirectives(s, directives)) {
        expect(d.origin.quote.length).toBeGreaterThan(10);
        expect(d.origin.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
        expect(d.effect.length).toBeGreaterThan(10);
      }
    }
    // Sans directives, rien n'est tracé : le plan ne prétend pas lire ce qu'il ne lit pas.
    expect(plain.flatMap((w) => w.sessions).every((s) => s.directives == null)).toBe(true);
  });
});

describe('Ratios de charge du plan écrit', () => {
  const race: RaceGoal = {
    id: 'grisemottes', athleteId: 'pierre', name: 'Trail des Grisemottes', date: '2026-10-18', priority: 'A',
    course: { distanceM: 32000, elevationGainM: 1200, elevationLossM: 1200, technicality: 3, expectedTempC: 12 },
  };
  // Trois mois réguliers, puis onze jours de coupure avant le plan.
  const history = Array.from({ length: 90 }, (_, i) => {
    const date = new Date(Date.UTC(2026, 5, 16 + i)).toISOString().slice(0, 10);
    return date >= '2026-09-03'
      ? { date, metabolic: 0, mechanical: 0 }
      : { date, metabolic: 50, mechanical: 8 };
  });
  const common = {
    athleteId: 'pierre', model, constraints: PIERRE.constraints, race,
    currentCtl: 33.3, currentAtl: 18.3, estimatedRaceDurationS: 13162, startDate: '2026-09-14',
    directives: directivesFor(PIERRE), ambition: PIERRE.ambition,
  };

  it('montre au moment où le plan s\'écrit le pic excentrique que le TSB ne voit pas', () => {
    const { plan, ratioCheck } = buildTrainingPlan({ ...common, loadHistory: history });
    expect(ratioCheck).toMatchObject({ from: '2026-09-14', to: '2026-10-17', historyDays: 90 });
    const mechanical = ratioCheck.exceedances.filter((e) => e.channel === 'mechanical');
    expect(mechanical.length).toBeGreaterThan(0);
    for (const e of ratioCheck.exceedances) {
      expect(e.value).toBeGreaterThan(e.limit);
      expect(e.date >= ratioCheck.from && e.date <= ratioCheck.to).toBe(true);
    }
    // Le journal du plan le dit, avec la date et la valeur.
    expect(plan.revisionLog[0]!.summary).toContain(`mécanique ${mechanical[0]!.value.toFixed(2)} le ${mechanical[0]!.date}`);
  });
});

describe('Ce qu\'une reconstruction n\'a pas le droit de réécrire', () => {
  const base = (over: Partial<PlannedSession> & { id: string; date: string }): PlannedSession => ({
    athleteId: 'pierre', type: 'endurance', title: 'Endurance fondamentale', intent: '',
    blocks: [{ label: 'Course', zone: 'Z2', durationS: 3600 }],
    plannedLoad: 50, plannedMechanicalLoad: 20, plannedDurationS: 3600,
    priority: 'support', status: 'planned', ...over,
  });

  const week = (weekStart: string, sessions: PlannedSession[]): TrainingWeek => ({
    weekStart, index: 0, phase: 'base', targetLoad: 250, plannedDurationS: 5 * 3600,
    targetElevationGainM: 500, intensityDistribution: { low: 0.8, moderate: 0.1, high: 0.1 },
    isDeload: false, focus: '', sessions,
  });

  const TODAY = '2026-09-18';

  it('une séance à venir, jamais touchée, ne porte aucune décision', () => {
    expect(decisionOn(base({ id: 'a', date: '2026-09-25' }), TODAY)).toBeNull();
  });

  it('un jour passé en porte une, même sans rien d\'autre', () => {
    expect(decisionOn(base({ id: 'a', date: '2026-09-17' }), TODAY)?.reason).toBe('past');
  });

  it('le statut nomme la décision, et prime sur le reste', () => {
    const cases: [PlannedSession['status'], string][] = [
      ['completed', 'réalisée'],
      ['replaced', 'autre chose a été fait ce jour-là'],
      ['withdrawn', 'retirée par une absence déclarée'],
      ['missed', 'non réalisée'],
    ];
    for (const [status, statement] of cases) {
      const d = decisionOn(base({ id: 'a', date: '2026-09-25', status }), TODAY);
      expect(d?.reason).toBe(status);
      expect(d?.statement).toBe(statement);
    }
  });

  it('une séance à venir modifiée à la main porte sa décision et sa provenance', () => {
    const d = decisionOn(
      base({
        id: 'a', date: '2026-09-27',
        decision: { at: '2026-09-17T18:20:00.000Z', by: 'coach', summary: 'Ramenée à 760 m.' },
      }),
      TODAY,
    );
    expect(d?.reason).toBe('edited');
    expect(d?.statement).toBe('modifiée le 2026-09-17 par le coach — Ramenée à 760 m.');
  });

  it('la décision remplace la séance écrite pour ce jour-là, et rien d\'autre', () => {
    const decided = base({ id: 'vieille', date: '2026-09-22', title: 'Test maximal', status: 'completed' });
    const previous = [week('2026-09-21', [decided, base({ id: 'sans', date: '2026-09-23' })])];
    const fresh = [
      week('2026-09-21', [
        base({ id: 'neuve-1', date: '2026-09-22', title: 'Seuil 5 × 5 min' }),
        base({ id: 'neuve-2', date: '2026-09-23', title: 'Décrassage' }),
      ]),
    ];
    const carry = carryDecisions(previous, fresh, TODAY);

    expect(carry.weeks[0]!.sessions.map((s) => s.id)).toEqual(['vieille', 'neuve-2']);
    expect(carry.preserved.map((d) => d.session.id)).toEqual(['vieille']);
    expect(carry.replaced).toEqual([{
      date: '2026-09-23',
      before: 'Endurance fondamentale',
      after: 'Décrassage',
      differences: ['« Endurance fondamentale » → « Décrassage »'],
      identical: false,
    }]);
  });

  it('une journée réécrite à l\'identique se distingue de celle qui change', () => {
    const previous = [week('2026-09-21', [
      base({ id: 'v1', date: '2026-09-23' }),
      base({ id: 'v2', date: '2026-09-24', title: 'PMA', plannedLoad: 90 }),
    ])];
    const fresh = [week('2026-09-21', [
      base({ id: 'n1', date: '2026-09-23' }),
      base({ id: 'n2', date: '2026-09-24', title: 'PMA', plannedLoad: 74 }),
    ])];
    const carry = carryDecisions(previous, fresh, TODAY);

    expect(carry.replaced.find((c) => c.date === '2026-09-23')?.identical).toBe(true);
    const changed = carry.replaced.find((c) => c.date === '2026-09-24')!;
    expect(changed.identical).toBe(false);
    // Deux séances du même nom qui ne pèsent pas la même chose : sans le
    // détail, l'aperçu afficherait « PMA → PMA » et ne dirait rien.
    expect(changed.differences).toEqual(['charge 90 → 74']);
  });

  it('un écart que l\'affichage arrondit n\'est pas une différence', () => {
    const previous = [week('2026-09-21', [base({ id: 'v', date: '2026-09-23', plannedDurationS: 3600 })])];
    const fresh = [week('2026-09-21', [base({ id: 'n', date: '2026-09-23', plannedDurationS: 3602 })])];
    const carry = carryDecisions(previous, fresh, TODAY);

    // « durée 60 min → 60 min » occuperait la place d'une information.
    expect(carry.replaced[0]!.differences).toEqual([]);
    expect(carry.replaced[0]!.identical).toBe(true);
  });

  it('une décision plus ancienne que le plan neuf ramène sa semaine avec elle', () => {
    const previous = [week('2026-09-07', [base({ id: 'vieille', date: '2026-09-09', status: 'completed' })])];
    const fresh = [week('2026-09-21', [base({ id: 'neuve', date: '2026-09-22' })])];
    const carry = carryDecisions(previous, fresh, TODAY);

    expect(carry.weeks.map((w) => w.weekStart)).toEqual(['2026-09-07', '2026-09-21']);
    expect(carry.weeks.map((w) => w.index)).toEqual([0, 1]);
    expect(carry.weeks[0]!.sessions.map((s) => s.id)).toEqual(['vieille']);
  });

  it('un jour que le plan neuf ne prescrit plus se voit, il ne disparaît pas en silence', () => {
    const previous = [week('2026-09-21', [base({ id: 'sans', date: '2026-09-24', title: 'PMA' })])];
    const carry = carryDecisions(previous, [week('2026-09-21', [])], TODAY);

    expect(carry.removed).toEqual([
      { date: '2026-09-24', before: 'PMA', after: null, differences: [], identical: false },
    ]);
    expect(carry.preserved).toHaveLength(0);
  });
});

describe('Ambition longue distance', () => {
  const directives = directivesFor(PIERRE);
  const common = {
    athleteId: 'pierre', model, constraints: PIERRE.constraints, race: RACE,
    currentCtl: 45, estimatedRaceDurationS: 3 * 3600, startDate: '2026-09-01', directives,
  };
  const withAmbition = buildTrainingPlan({ ...common, ambition: PIERRE.ambition }).weeks;
  const without = buildTrainingPlan(common).weeks;
  const longOf = (w: (typeof withAmbition)[number]) =>
    w.sessions.find((s) => s.type === 'long_run' || s.type === 'long_trail');

  it('existe comme un fait du dossier, distinct des courses', () => {
    expect(PIERRE.ambition?.format).toBe('trail_long');
    // Elle ne porte pas de date d'échéance : elle oriente, elle ne se coche pas.
    expect(PIERRE.ambition).not.toHaveProperty('date');
    expect(PIERRE.ambition?.origin.length).toBeGreaterThanOrEqual(2);
    const labQuote = PIERRE.ambition?.origin.find((o) => o.source === 'lab_test')?.quote as string;
    expect((LAB_TEST_2025_07_24.interpretation as string).includes(labQuote)).toBe(true);
  });

  it('donne plus de place à la sortie longue', () => {
    const first = longOf(withAmbition[0]!)!;
    const plainFirst = longOf(without[0]!)!;
    expect(first.plannedDurationS).toBeGreaterThan(plainFirst.plannedDurationS);
  });

  it('rend la durabilité mesurable au lieu de la supposer', () => {
    const building = withAmbition.filter((w) => !w.isDeload && w.phase !== 'taper');
    for (const w of building) {
      const long = longOf(w);
      if (!long) continue;
      expect(long.plannedDurationS, w.weekStart).toBeGreaterThanOrEqual(DURABILITY_MEASURABLE.minDurationS);
      expect(long.plannedElevationGainM ?? 0, w.weekStart).toBeGreaterThanOrEqual(DURABILITY_MEASURABLE.minVertM);
    }
    // Sans l'ambition, le plan produisait des sorties trop plates pour que la
    // régression donne une pente par 1 000 m de D+.
    const flat = without
      .filter((w) => !w.isDeload && w.phase !== 'taper')
      .some((w) => (longOf(w)?.plannedElevationGainM ?? 0) < DURABILITY_MEASURABLE.minVertM);
    expect(flat).toBe(true);
  });
});

describe('Le plafond horaire est une contrainte dure', () => {
  const directives = directivesFor(PIERRE);
  const plan = (maxWeeklyHours: number, over: Partial<Parameters<typeof buildTrainingPlan>[0]> = {}) =>
    buildTrainingPlan({
      athleteId: 'pierre', model, constraints: { ...PIERRE.constraints, maxWeeklyHours },
      race: RACE, currentCtl: 45, estimatedRaceDurationS: 3 * 3600, startDate: '2026-09-01',
      directives, ambition: PIERRE.ambition, ...over,
    });

  it('ne laisse aucune semaine dépasser les heures déclarées', () => {
    // Le plafond était converti en charge à 55 points l'heure : du volume facile
    // en coûte 45, et la semaine dépassait de deux heures sans que rien ne le
    // dise. Trois plafonds très différents, aucun franchi.
    for (const hours of [6, 9, 14]) {
      for (const w of plan(hours).weeks) {
        expect(w.plannedDurationS, `${hours} h — ${w.weekStart}`).toBeLessThanOrEqual(hours * 3600);
      }
    }
  });

  it('mesure la durée de la semaine sur ses séances, course exclue', () => {
    const { weeks } = plan(9);
    for (const w of weeks) {
      const written = w.sessions
        .filter((x) => x.type !== 'race')
        .reduce((a, x) => a + x.plannedDurationS, 0);
      expect(w.plannedDurationS, w.weekStart).toBe(written);
    }
    // Une course de quatorze heures n'est pas une semaine trop chargée : c'est
    // l'objet de la préparation, et elle ne mange pas le plafond.
    const ultra = plan(9, { estimatedRaceDurationS: 14 * 3600 }).weeks;
    const raceWeek = ultra.find((w) => w.sessions.some((x) => x.type === 'race'))!;
    const total = raceWeek.sessions.reduce((a, x) => a + x.plannedDurationS, 0);
    expect(total).toBeGreaterThan(9 * 3600);
    expect(raceWeek.plannedDurationS).toBe(total - 14 * 3600);
    expect(raceWeek.plannedDurationS).toBeLessThanOrEqual(9 * 3600);
  });

  it('ne fait plus correspondre la durée à la charge par un taux fixe', () => {
    const sessions = plan(9).weeks.flatMap((w) => w.sessions).filter((x) => x.plannedLoad > 0);
    // Deux séances de même charge et de durées différentes existent — c'est le
    // fait physiologique que la constante niait : le seuil coûte plus l'heure
    // que le volume facile.
    const pairs = sessions.flatMap((a) =>
      sessions.filter((b) => b.plannedLoad === a.plannedLoad && b.plannedDurationS !== a.plannedDurationS),
    );
    expect(pairs.length).toBeGreaterThan(0);
    // Et la semaine ne dit plus ses heures comme un quotient de sa charge.
    for (const w of plan(9).weeks) {
      expect(w.plannedDurationS).not.toBe(Math.round((w.targetLoad / 55) * 3600));
    }
  });

  it('dit que la plage du dossier a cédé, quand le plafond ne la contient pas', () => {
    // Le dossier prescrit 3 à 5 h de rando-course et 1 h 30 à 2 h 30 de foncier.
    // Six heures par semaine avec deux séances de qualité ne les contiennent
    // pas : le temps réel de l'athlète tranche, et la séance le porte.
    const building = plan(6).weeks.filter((w) => !w.isDeload && w.phase !== 'taper');
    const traces = building
      .flatMap((w) => w.sessions)
      .flatMap((x) => x.directives ?? [])
      .filter((t) => t.exemption === 'ceiling');
    expect(traces.length).toBeGreaterThan(0);
    // À neuf heures, le conflit n'existe pas : rien ne sort de sa plage.
    const roomy = plan(9)
      .weeks.filter((w) => !w.isDeload && w.phase !== 'taper')
      .flatMap((w) => w.sessions)
      .flatMap((x) => x.directives ?? [])
      .filter((t) => t.exemption === 'ceiling');
    expect(roomy).toHaveLength(0);
  });

  it('tient aussi quand des séances conservées remplissent la semaine', () => {
    // Sept heures et demie conservées dans une semaine de construction : les
    // conservées ne cèdent pas, ce sont les séances du planificateur qui
    // tombent — la qualité en tout dernier, mais elle tombe.
    const spec = buildPeriodization({
      startDate: '2026-09-01', race: RACE, estimatedRaceDurationS: 3 * 3600, currentCtl: 45,
      constraints: PIERRE.constraints, raceElevationGainM: 1200,
    }).find((s) => s.phase === 'build' && !s.isDeload)!;
    const held = (offset: number, type: PlannedSession['type'], hours: number): PlannedSession => ({
      id: `garde-${offset}`, athleteId: 'pierre', date: lib.addDays(spec.weekStart, offset), type,
      title: `Conservée ${hours} h`, intent: '', blocks: [{ label: 'Course', zone: 'Z2', durationS: hours * 3600 }],
      plannedLoad: hours * 50, plannedMechanicalLoad: 10, plannedDurationS: hours * 3600, priority: 'key',
      status: 'planned', decision: { at: '2026-09-01T08:00:00.000Z', by: 'coach', summary: 'Décidée à la main.' },
    });
    const fixed = [held(0, 'endurance', 3), held(6, 'long_trail', 4.5)];
    const week = buildWeek({
      spec, model, constraints: PIERRE.constraints, athleteId: 'pierre', race: RACE, directives,
      ambition: PIERRE.ambition, fixed,
    });

    expect(week.plannedDurationS).toBeLessThanOrEqual(9 * 3600);
    for (const kept of fixed) expect(week.sessions.find((s) => s.date === kept.date)).toEqual(kept);
    expect(week.sessions.filter((s) => s.type === 'long_trail')).toHaveLength(1);
  });

  it('ne rabote jamais une séance de qualité pour tenir sous le plafond', () => {
    const quality = plan(6).weeks.flatMap((w) => w.sessions).filter((x) => x.priority === 'key');
    // Une semaine qui déborde n'est pas une semaine trop intense : le plafond
    // prend sur le volume, jamais sur le stimulus.
    for (const x of quality) {
      if (x.type === 'race' || x.type === 'long_run' || x.type === 'long_trail') continue;
      expect(x.plannedDurationS, `${x.date} ${x.title}`).toBeGreaterThanOrEqual(30 * 60);
    }
  });

  it('dit le temps laissé sous le plafond quand la durabilité est le facteur limitant mesuré', () => {
    // Quatorze heures déclarées, une préparation qui n'en écrit que onze : la
    // place restante n'est pas neutre pour qui perd du rendement à l'heure.
    const measured = {
      ...model,
      durabilityPctPerHour: 4.2,
      provenance: { ...model.provenance, durabilityPctPerHour: 'field' as const },
    };
    const { volumeCheck } = plan(14, { model: measured });
    expect(volumeCheck.ceilingS).toBe(14 * 3600);
    expect(volumeCheck.durabilityLimiting).toBe(true);
    expect(volumeCheck.underused.length).toBeGreaterThan(0);
    for (const u of volumeCheck.underused) expect(u.unusedS).toBeGreaterThan(2 * 3600);
    expect(volumeCheck.statement).toContain('volume');
    expect(volumeCheck.statement).toContain('14 h');
  });

  it('se tait quand la durabilité n\'est qu\'un repli de population', () => {
    // Le même plan, la même place laissée — mais rien ne l'a mesurée. Une
    // recommandation de volume bâtie sur un repli propagerait une erreur
    // silencieuse jusqu'à la prédiction de course.
    const { volumeCheck } = plan(14);
    expect(model.provenance.durabilityPctPerHour).toBe('default');
    expect(volumeCheck.underused.length).toBeGreaterThan(0);
    expect(volumeCheck.durabilityLimiting).toBe(false);
    expect(volumeCheck.statement).toBeNull();
  });

  it('se tait aussi quand le plan occupe le temps déclaré', () => {
    const measured = {
      ...model,
      durabilityPctPerHour: 4.2,
      provenance: { ...model.provenance, durabilityPctPerHour: 'field' as const },
    };
    const { volumeCheck } = plan(9, { model: measured });
    expect(volumeCheck.durabilityLimiting).toBe(true);
    expect(volumeCheck.underused).toHaveLength(0);
    expect(volumeCheck.statement).toBeNull();
  });
});

describe('Une séance se prescrit en nombres humains', () => {
  const directives = directivesFor(PIERRE);
  const { weeks } = buildTrainingPlan({
    athleteId: 'pierre', model, constraints: PIERRE.constraints, race: RACE,
    currentCtl: 45, currentAtl: 45, estimatedRaceDurationS: 3 * 3600, startDate: '2026-09-01',
    directives, ambition: PIERRE.ambition,
  });
  const sessions = weeks.flatMap((w) => w.sessions).filter((s) => s.blocks.length > 0);

  /** Ce qui se court, hors des blocs que le dossier prescrit à part. */
  const running = (s: PlannedSession) =>
    lib.totalDuration(s.blocks.filter((b) => !lib.isPrescribed(b)));

  it('prescrit le corps de séance au quart d\'heure', () => {
    for (const s of sessions) {
      if (s.type === 'race') continue;
      expect(running(s) % (15 * 60), `${s.date} ${s.title} — ${running(s)} s`).toBe(0);
    }
  });

  it('prescrit les blocs à la minute ronde, jamais à la seconde', () => {
    for (const s of sessions) {
      if (s.type === 'race') continue;
      for (const b of s.blocks) {
        // Un format écrit en secondes — « 30"-30" » — est une consigne du
        // dossier, pas le reste d'une division : lui seul y échappe.
        if ((b.repeat ?? 1) > 1) continue;
        expect((b.durationS ?? 0) % 60, `${s.date} « ${b.label} »`).toBe(0);
        expect((b.recovery?.durationS ?? 0) % 60, `${s.date} récup de « ${b.label} »`).toBe(0);
      }
    }
  });

  it('dit dans le titre la durée que la séance entière porte', () => {
    for (const s of sessions) {
      if (s.type === 'race') continue;
      expect(s.title, `${s.date} — ${s.plannedDurationS} s`).toContain(
        `— ${sessionDuration(s.plannedDurationS)}`,
      );
      expect(s.plannedDurationS, s.date).toBe(lib.totalDuration(s.blocks));
    }
  });

  it('chiffre une descente par ce qu\'elle descend, pas par ses remontées', () => {
    const down = sessions.filter((s) => s.type === 'downhill');
    expect(down.length).toBeGreaterThan(0);
    for (const s of down) {
      expect(s.title, s.date).toContain(`${lib.elevationLossOf(s.blocks)} m D−`);
      expect(s.title, s.date).not.toContain('m D+');
    }
  });
});

describe('Le footing prolongé du dossier', () => {
  const directives = directivesFor(PIERRE);
  const { weeks } = buildTrainingPlan({
    athleteId: 'pierre', model, constraints: PIERRE.constraints, race: RACE,
    currentCtl: 45, currentAtl: 45, estimatedRaceDurationS: 3 * 3600, startDate: '2026-09-01',
    directives, ambition: PIERRE.ambition,
  });
  const foncier = directives.find((d) => d.id === 'foncier_duree');
  const building = weeks.filter((w) => !w.isDeload && w.phase !== 'taper' && w.phase !== 'race');

  it('place un footing dans la plage prescrite chaque semaine de construction', () => {
    expect(foncier?.kind).toBe('session_duration');
    if (foncier?.kind !== 'session_duration') return;
    expect(building.length).toBeGreaterThan(4);
    for (const w of building) {
      const footings = w.sessions.filter((s) => s.type === 'long_run');
      expect(footings.length, w.weekStart).toBeGreaterThan(0);
      for (const f of footings) {
        const run = lib.totalDuration(f.blocks.filter((b) => !lib.isPrescribed(b)));
        expect(run, `${w.weekStart} ${f.title}`).toBeGreaterThanOrEqual(foncier.minS);
        expect(run, `${w.weekStart} ${f.title}`).toBeLessThanOrEqual(foncier.maxS);
      }
    }
  });

  it('honore la directive sur les semaines que la rando-course occupait seule', () => {
    // Le défaut corrigé : sur les vingt-deux jours du plan actif, deux séances
    // seulement dépassaient 1 h 30, et c'étaient les deux rando-courses.
    const withTrail = building.filter((w) => w.sessions.some((s) => s.type === 'long_trail'));
    expect(withTrail.length).toBeGreaterThan(0);
    for (const w of withTrail) {
      expect(w.sessions.some((s) => s.type === 'long_run'), w.weekStart).toBe(true);
    }
  });
});

describe('La pyramide, fractionné moyen du dossier', () => {
  const policy = directivesFor(PIERRE).find((d) => d.kind === 'interval_policy');

  it('tient ses paliers dans la fenêtre de 3 à 12 min', () => {
    const s = lib.pyramid(model, [3, 5, 8, 5, 3]);
    const steps = s.blocks.filter((b) => b.zone === 'Z4').map((b) => b.durationS);
    expect(steps).toEqual([180, 300, 480, 300, 180]);
    expect(s.title).toContain('Pyramide 3-5-8-5-3 min');
    if (policy?.kind !== 'interval_policy') throw new Error('politique absente');
    const check = lib.checkIntervalFormat({ type: s.type, blocks: s.blocks }, policy);
    expect(check?.offences).toEqual([]);
    expect(check?.format).toBe('medium');
  });

  it('raccourcit l\'échelle par ses extrémités, jamais ses paliers', () => {
    const court = lib.pyramid(model, [3, 5, 8, 5, 3]).blocks;
    const allege = lib.transformSession(
      { type: 'threshold', blocks: court, plannedLoad: 80, plannedMechanicalLoad: 5, plannedDurationS: lib.totalDuration(court) },
      0.6,
      model,
    );
    expect(allege.blocks.filter((b) => b.zone === 'Z4').map((b) => b.durationS)).toEqual(
      [180, 300, 480, 300, 180],
    );
  });

  it('ne met qu\'un fractionné par semaine, pyramide comprise', () => {
    const { weeks } = buildTrainingPlan({
      athleteId: 'pierre', model, constraints: PIERRE.constraints, race: RACE,
      currentCtl: 45, currentAtl: 45, estimatedRaceDurationS: 3 * 3600, startDate: '2026-09-01',
      directives: directivesFor(PIERRE), ambition: PIERRE.ambition,
    });
    for (const w of weeks) {
      const n = w.sessions.filter((s) => isIntervalSession(s.type)).length;
      expect(n, w.weekStart).toBeLessThanOrEqual(1);
    }
  });
});

describe('Un mouvement demandé est un mouvement expliqué', () => {
  it('donne à chaque exercice du circuit sa phrase exécutable', () => {
    const s = lib.strength(model, 3);
    const circuit = s.blocks.find((b) => b.circuit)!.circuit!;
    const text = lib.describeCircuit(circuit);
    for (const e of circuit.exercises) {
      const m = ECCENTRIC_MOVEMENT_TEXT[e.movement];
      expect(m.cue.length, e.movement).toBeGreaterThan(20);
      expect(text).toContain(m.cue);
    }
  });

  it('explique les gammes, que l\'athlète n\'a jamais faites', () => {
    for (const s of [lib.pyramid(model), lib.threshold(model), lib.vo2max(model)]) {
      const gammes = s.blocks.find((b) => b.label.startsWith('Gammes'))!;
      expect(gammes.notes, s.title).toMatch(/montées de genou/);
      expect(gammes.notes, s.title).toMatch(/talons-fesses/);
    }
  });
});
