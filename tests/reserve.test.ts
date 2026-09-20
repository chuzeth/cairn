import { describe, expect, it } from 'vitest';
import {
  PIERRE, directivesFor, weakestProvenance, type PlannedSession, type SessionBlock,
} from '@cairn/core';
import { msToKmh, wPrimeAfter, wPrimeBalance } from '@cairn/physiology';
import * as lib from '@cairn/coach';
import { PIERRE_MODEL } from './fixtures/pierre.js';

const model = PIERRE_MODEL;
const CS = model.criticalSpeedMs;
const DP = model.dPrimeM;

describe('Bilan de réserve anaérobie', () => {
  it('vide au rythme du dépassement et recharge de façon asymptotique', () => {
    // Au-dessus de CS, la perte est exacte : (v − CS) × t.
    expect(wPrimeAfter(DP, CS + 1, CS, DP, 30)).toBeCloseTo(DP - 30, 6);
    // En dessous, on remonte vers D' sans jamais le dépasser.
    const recharged = wPrimeAfter(DP - 100, CS - 1, CS, DP, 60);
    expect(recharged).toBeGreaterThan(DP - 100);
    expect(recharged).toBeLessThan(DP);
    expect(wPrimeAfter(DP, CS - 1, CS, DP, 3600)).toBe(DP);
  });

  it('donne la même chose intégré d\'un trait ou seconde par seconde', () => {
    // C'est la condition pour qu'une séance et un flux d'activité se jugent sur
    // le même modèle : deux implémentations, ce serait deux verdicts possibles.
    const series = wPrimeBalance(new Array(120).fill(CS + 0.8), CS, DP);
    expect(series[119]).toBeCloseTo(wPrimeAfter(DP, CS + 0.8, CS, DP, 120), 6);
  });

  it('ne descend pas indéfiniment sous zéro', () => {
    expect(wPrimeAfter(0, CS + 5, CS, DP, 3600)).toBeCloseTo(-DP * 0.2, 6);
  });
});

/** Une série de répétitions au-dessus de CS, avec sa récupération. */
const series = (reps: number, workS: number, speedMs: number, restS: number): SessionBlock[] => [
  {
    label: 'Répétitions', zone: 'Z5', durationS: workS, repeat: reps,
    speedRangeMs: [speedMs, speedMs * 1.03],
    recovery: { durationS: restS, zone: 'Z1', active: true, speedRangeMs: [0, 2.4] },
  },
];

describe('Faisabilité d\'une séance au D′', () => {
  it('refuse une séance dont la réserve tombe à zéro avant le dernier bloc', () => {
    // À 2 m/s au-dessus de la vitesse critique, chaque minute coûte 120 m : la
    // réserve de Pierre n'en finance pas trois, même avec de la récupération.
    const check = lib.checkReserve(series(6, 60, CS + 2, 60), model);
    expect(check.feasible).toBe(false);
    expect(check.prescribable).toBe(false);
    expect(check.lowAt!.rep).toBeLessThan(6);
    expect(lib.describeShortfall(check)).toMatch(/réserve anaérobie est à sec/);
  });

  it('juge la récupération sur ce qu\'elle recharge, pas sur sa durée', () => {
    // Même travail, même durée totale de récupération : trottiner rend beaucoup
    // moins que s'arrêter, et c'est cela qui décide du nombre de répétitions.
    const trot = lib.checkReserve(series(5, 60, CS + 1, 90), model);
    const arret = lib.checkReserve(
      [
        {
          ...(series(5, 60, CS + 1, 90)[0] as SessionBlock),
          recovery: { durationS: 90, zone: 'Z1', active: false, speedRangeMs: [0, 2.4] },
        },
      ],
      model,
    );
    expect(arret.lowM).toBeGreaterThan(trot.lowM);
    const [dit] = lib.describeRecoveries(trot);
    expect(dit).toMatch(/rechargent \d+ m de réserve pour \d+ m dépensés/);
  });

  it('ne fait rien payer à un bloc sous la vitesse critique', () => {
    const facile = lib.checkReserve(
      [{ label: 'Endurance', zone: 'Z2', durationS: 7200, speedRangeMs: [CS * 0.7, CS * 0.8] }],
      model,
    );
    expect(facile.lowM).toBe(DP);
    expect(facile.prescribable).toBe(true);
  });

  it('juge chaque segment au bas de sa fourchette', () => {
    // Une fourchette large est une fourchette peu prescriptive : c'est son
    // plancher qui dit ce que la séance exige vraiment.
    const large = lib.checkReserve(
      [{ label: 'Bloc', zone: 'Z4', durationS: 1200, speedRangeMs: [CS * 0.98, CS * 1.2] }],
      model,
    );
    expect(large.lowM).toBe(DP);
  });
});

describe('La bibliothèque ne prescrit pas ce que la réserve ne finance pas', () => {
  it('ramène le nombre de répétitions d\'un fractionné court, et dit pourquoi', () => {
    const s = lib.vo2max(model, '30-30', 2, 10);
    const work = s.blocks.filter((b) => b.zone === 'Z5');
    expect(work[0]!.repeat).toBeLessThan(10);
    expect(lib.checkReserve(s.blocks, model).prescribable).toBe(true);
    expect(s.amendments?.join(' ')).toMatch(/Répétitions ramenées de 10 à \d/);
    expect(s.amendments?.join(' ')).toMatch(/vitesse critique/);
  });

  it('laisse intacte une séance que la réserve finance', () => {
    const s = lib.threshold(model, 5, 5);
    expect(s.blocks.find((b) => b.zone === 'Z4')!.repeat).toBe(5);
    expect(s.amendments).toBeUndefined();
  });

  it('cale le seuil au-dessus de la vitesse critique, pas sous elle', () => {
    // Le moteur tire le SV2 de la CS en la divisant par 1,02 : calée sur le SV2,
    // la moitié basse de la fourchette était sous l'asymptote — donc à une
    // intensité qui a un état stable, et qui ne produit aucun stimulus de seuil.
    const work = lib.threshold(model, 5, 5).blocks.find((b) => b.zone === 'Z4')!;
    expect(model.vt2.speedMs).toBeLessThan(CS);
    expect(work.speedRangeMs![0]).toBeGreaterThan(CS);
    expect(work.hrRange).toEqual([171, 175]);
  });

  it('refuse au coach une séance que la réserve ne finance pas', () => {
    expect(() =>
      lib.parseSessionBlocks(
        [{
          label: 'Série impossible', zone: 'Z5', durationS: 60, repeat: 12,
          speedRangeMs: [CS + 2, CS + 2.2],
          recovery: { durationS: 60, zone: 'Z1', active: true },
        }],
        model,
      ),
    ).toThrow(/réserve anaérobie/);
  });
});

describe('Le dossier borne le format du fractionné', () => {
  const policy = lib.indexDirectives(directivesFor(PIERRE)).intervals!;
  const planned = (t: lib.SessionTemplate): PlannedSession => ({
    id: 'x', athleteId: 'pierre', date: '2026-09-22', type: t.type, title: t.title, intent: t.intent,
    blocks: t.blocks, plannedLoad: t.plannedLoad, plannedMechanicalLoad: t.plannedMechanicalLoad,
    plannedDurationS: t.durationS, priority: t.priority, status: 'planned',
    directives: [{ directiveId: 'fractionne_hebdomadaire', origin: policy.origin }],
  });

  it('lit les bornes dans le compte rendu, verbatim', () => {
    expect(policy.formats.medium).toMatchObject({ minWorkS: 180, maxWorkS: 720, hr: [171, 175] });
    expect(policy.formats.medium!.origin.quote).toBe(
      'résistance dure en fractionné moyen 3-12 min à 171-175 bpm',
    );
    expect(policy.formats.short).toMatchObject({ minWorkS: 30, maxWorkS: 60 });
  });

  it('ne borne que les séances que le document décrit', () => {
    // Le compte rendu donne les durées du fractionné court *en PMA*, et range le
    // fractionné court *en montée* parmi les objectifs de Z4 sans lui en fixer.
    // Les côtes occupent le créneau court de l'alternance ; leur opposer la
    // fenêtre de la PMA leur imposerait une borne que personne n'a écrite.
    expect(lib.isIntervalSession('hill_repeats')).toBe(true);
    expect(lib.checkIntervalFormat(planned(lib.hillRepeats(model, 8, 90, 0.1)), policy)).toBeNull();
    expect(lib.checkIntervalFormat(planned(lib.vo2max(model, '30-30', 2, 10)), policy)!.offences).toEqual([]);
  });

  it('constate qu\'un raccourcissement sort de la plage prescrite', () => {
    const s = planned(lib.threshold(model, 5, 5));
    expect(lib.checkIntervalFormat(s, policy)!.offences).toEqual([]);
    const court = lib.transformSession(s, 0.45, model);
    expect(lib.checkIntervalFormat({ ...s, blocks: court.blocks }, policy)!.offences[0]).toMatch(
      /hors de la plage 3'00"-12'00" prescrite/,
    );
  });

  it('allège un fractionné en retirant des répétitions, pas des minutes', () => {
    const s = planned(lib.threshold(model, 5, 5));
    const allege = lib.transformSession(s, { duration: 0.45, repeats: 0.45 }, model);
    const work = allege.blocks.find((b) => (b.repeat ?? 1) > 1)!;
    expect(work.durationS).toBe(300);
    expect(work.repeat).toBe(2);
    expect(lib.checkIntervalFormat({ ...s, blocks: allege.blocks }, policy)!.offences).toEqual([]);
  });

  it('fait passer les règles de charge par ce chemin', () => {
    const state = {
      today: {
        date: '2026-09-21', ctl: 50, atl: 90, tsb: -40, mechanicalTsb: 0, acwr: 1.0,
        mechanicalAcwr: 1.0, rampRate: 3, monotony: 1.4, tsbLabel: '', acwrLabel: '', acwrRisk: 'low',
      },
      readiness: { date: '2026-09-21', score: 30, verdict: 'red', components: {}, recommendation: 'Repos.' },
      absences: [], model, profile: PIERRE,
    } as never;
    const seuil = planned(lib.threshold(model, 5, 5));
    const [adj] = lib.evaluateAdjustments(state, [{ ...seuil, date: '2026-09-22' }]);
    expect(adj!.rule).toBe('readiness_red');
    expect(adj!.repeats).toBe(adj!.factor);
    expect(adj!.reason).toMatch(/répétitions ramenées de 5 à 2/);
  });

  it('ne décale pas un fractionné dans une semaine qui porte déjà le sien', () => {
    const state = {
      today: {
        date: '2026-09-21', ctl: 50, atl: 55, tsb: -5, mechanicalTsb: 0, acwr: 1.0,
        mechanicalAcwr: 1.0, rampRate: 3, monotony: 1.4, tsbLabel: '', acwrLabel: '', acwrRisk: 'low',
      },
      readiness: { date: '2026-09-21', score: 75, verdict: 'green', components: {}, recommendation: '' },
      absences: [], model, profile: PIERRE,
    } as never;
    // Dimanche une séance clef, lundi un fractionné : l'espacement le pousse au
    // mardi, où la semaine porte déjà celui du mercredi.
    const dimanche = { ...planned(lib.threshold(model, 5, 5)), id: 'a', date: '2026-09-27' };
    const lundi = { ...planned(lib.vo2max(model, '30-30', 2, 10)), id: 'b', date: '2026-09-28' };
    const mercredi = { ...planned(lib.hillRepeats(model)), id: 'c', date: '2026-09-30' };
    const [adj] = lib.evaluateAdjustments(state, [dimanche, lundi, mercredi]);
    expect(adj!.rule).toBe('quality_spacing');
    expect(lib.mondayOf(adj!.newDate!)).not.toBe(lib.mondayOf('2026-09-30'));
    expect(adj!.reason).toMatch(/qu'un fractionné par semaine/);
  });
});

describe('Chaque cible prescrite porte sa provenance', () => {
  it('sur le bloc et sur sa récupération', () => {
    const work = lib.threshold(model, 5, 5).blocks.find((b) => b.zone === 'Z4')!;
    // La FC vient du SV2, l'allure du couple SV2 / vitesse critique sur lequel
    // la cible est calée : chacune porte celle de ce qui l'a produite, et elles
    // ne valent pas forcément la même chose.
    expect(work.provenance!.hr).toBe(model.provenance['vt2.hr']);
    expect(work.provenance!.speed).toBe(
      weakestProvenance(model.provenance['vt2.speedMs']!, model.provenance.criticalSpeedMs),
    );
    // La récupération se court : elle porte ce qu'il y a à y tenir, et d'où ça vient.
    expect(work.recovery!.speedRangeMs).toBeDefined();
    expect(work.recovery!.hrRange).toBeDefined();
    expect(work.recovery!.provenance).toBeDefined();
    expect(msToKmh(work.recovery!.speedRangeMs![1])).toBeGreaterThan(0);
  });

  it('et une montée porte celle de sa vitesse ascensionnelle', () => {
    const climb = lib.hillRepeats(model, 8, 90, 0.1).blocks.find((b) => b.vamTargetMh)!;
    expect(climb.provenance!.vam).toBe(model.provenance.vmaMs);
    // Et sa fourchette d'allure est corrigée de la pente, comme les autres :
    // annoncée au sol, elle plaçait un bloc de Z4 à une allure de Z2.
    expect(climb.speedRangeMs![0]).toBeGreaterThan(CS);
  });
});
