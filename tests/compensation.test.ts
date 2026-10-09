import { describe, expect, it } from 'vitest';
import { EXERCISES, FORCE_BLOCK_DAYS, annexOf, isExerciseKey, type ExerciseKey, type StrengthTestResult } from '@cairn/core';
import { blockDay, blockWeekOf, compensationDay, compensationHomeDay, remeasured, weakSides } from '@cairn/coach';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Le programme de compensation du coude cassé (03/10) : quatre semaines sans
 * course, une séance par jour.
 */

const days = Array.from({ length: 28 }, (_, i) => compensationDay(PIERRE_MODEL, i));
const weekOf = (i: number) => days.slice(i * 7, i * 7 + 7);
/** Le temps d'entraînement de la semaine : sans les soins du bras ni la respiration, qui sont de chaque jour. */
const minutes = (week: number) =>
  weekOf(week).reduce((a, s) => a + s.durationS - (annexOf(s.blocks)?.durationS ?? 0), 0) / 60;

describe('Le programme de compensation', () => {
  it('ne fait jamais courir : du renforcement et du cardio sans impact, chaque jour', () => {
    for (const s of days) expect(['strength', 'cross_training']).toContain(s.type);
    // Aucune allure à suivre nulle part : rien ici ne se court.
    for (const b of days.flatMap((s) => s.blocks)) {
      expect(b.speedRangeMs, b.label).toBeUndefined();
      expect(b.paceRange, b.label).toBeUndefined();
    }
  });

  it('renvoie chaque bloc à une fiche qui existe : on sait toujours comment faire', () => {
    for (const s of days) {
      for (const b of s.blocks) {
        expect(b.exercise, `${s.title} — ${b.label}`).toBeDefined();
        expect(isExerciseKey(b.exercise!), b.exercise).toBe(true);
        expect(EXERCISES[b.exercise as keyof typeof EXERCISES].cast.length).toBeGreaterThan(0);
      }
    }
  });

  it('place deux séances de force par semaine, à 72 h l’une de l’autre', () => {
    for (let w = 0; w < 4; w++) {
      const strength = weekOf(w).map((s, i) => (s.type === 'strength' ? i : -1)).filter((i) => i >= 0);
      expect(strength, `semaine ${w + 1}`).toHaveLength(2);
      expect(strength[1]! - strength[0]!).toBe(3);
    }
  });

  it('garde un fractionné par semaine, de plus en plus intense, puis allégé', () => {
    const zones = [0, 1, 2, 3].map((w) => {
      const intervals = weekOf(w).filter((s) => s.title.startsWith('Intervalles'));
      expect(intervals, `semaine ${w + 1}`).toHaveLength(1);
      return intervals[0]!.blocks.find((b) => (b.repeat ?? 1) > 1)!.zone;
    });
    expect(zones).toEqual(['Z3', 'Z4', 'Z5', 'Z4']);
  });

  it('monte trois semaines, puis allège la quatrième', () => {
    expect(minutes(1)).toBeGreaterThan(minutes(0));
    expect(minutes(2)).toBeGreaterThan(minutes(1));
    expect(minutes(3)).toBeLessThan(minutes(2) * 0.8);
    // Son temps disponible est de neuf heures par semaine.
    for (const w of [0, 1, 2, 3]) expect(minutes(w)).toBeLessThan(9 * 60);
  });

  it('respire et soigne le bras tous les jours', () => {
    for (const s of days) {
      expect(s.blocks.some((b) => b.exercise === 'respiration'), s.title).toBe(true);
      expect(s.blocks.some((b) => b.exercise === 'soins-bras'), s.title).toBe(true);
    }
  });

  it('garde ses chiffres quand la charge se recompte : une marche ne devient pas des kilomètres de course', () => {
    // À chaque sortie synchronisée, les séances décidées se remesurent avec le modèle du jour.
    for (const s of days) {
      const decided = {
        type: s.type, blocks: s.blocks, plannedDurationS: s.durationS, plannedLoad: s.plannedLoad,
        plannedMechanicalLoad: s.plannedMechanicalLoad, plannedDistanceM: s.plannedDistanceM,
      };
      const m = remeasured(decided, PIERRE_MODEL);
      expect([m.plannedLoad, m.plannedDistanceM, m.plannedMechanicalLoad], s.title).toEqual([
        s.plannedLoad, s.plannedDistanceM, s.plannedMechanicalLoad,
      ]);
    }
  });

  it('dit les répétitions des exercices, pas leurs secondes', () => {
    const presse = days[1]!.blocks.find((b) => b.exercise === 'presse')!;
    expect(presse.repeat).toBe(3);
    expect(presse.reps).toBe(8);
    expect(presse.effort).toContain('3 répétitions en réserve');
  });
});

describe('La semaine du 05/10 à la maison', () => {
  // « Cette semaine, je vais faire principalement de la marche tranquille et des exercices chez moi tout seul. »
  const home = Array.from({ length: 7 }, (_, i) => compensationHomeDay(PIERRE_MODEL, i));

  it('ne demande ni salle ni machine', () => {
    for (const s of home) {
      for (const b of s.blocks) {
        expect(EXERCISES[b.exercise as ExerciseKey].where, `${s.title} — ${b.label}`).not.toEqual(['salle']);
      }
    }
  });

  it('garde deux séances de force à 72 h, et marche tranquillement les autres jours', () => {
    expect(home.map((s) => s.type)).toEqual([
      'cross_training', 'strength', 'cross_training', 'cross_training', 'strength', 'cross_training', 'cross_training',
    ]);
    for (const s of home.filter((x) => x.type === 'cross_training')) {
      for (const b of s.blocks.filter((x) => !x.kind)) expect(b.zone, `${s.title} — ${b.label}`).toBe('Z1');
    }
  });

  it('dit chaque exercice d’une jambe par jambe, et en répétitions', () => {
    const fente = home[1]!.blocks.find((b) => b.exercise === 'split-squat-maison')!;
    expect(fente.label).toContain('3 séries par jambe');
    expect([fente.repeat, fente.reps]).toEqual([6, 10]);
    expect(fente.effort).toContain('3 répétitions en réserve');
  });

  it('dit quoi faire sans le kit d’élastiques, s’il n’est pas arrivé', () => {
    // Le 05/10, Pierre attend le kit pour le lendemain, jour de la séance A.
    const kit = home.flatMap((s) => s.blocks).filter((b) =>
      ['tirage-elastique', 'bras-elastique', 'anti-rotation'].includes(b.exercise!));
    expect(kit.length).toBeGreaterThan(0);
    for (const b of kit) expect(b.notes, b.label).toContain('Sans le kit');
  });

  it('se fait avec le tabouret de 40 cm, pas avec une marche qu’il n’a pas', () => {
    const exercises = home.flatMap((s) => s.blocks.map((b) => b.exercise));
    expect(exercises).toContain('montee-tabouret');
    expect(exercises).not.toContain('descente-marche');
    expect(exercises).not.toContain('mollets-excentriques');
  });

  it('se recompte sans devenir des kilomètres', () => {
    for (const s of home) {
      const m = remeasured({
        type: s.type, blocks: s.blocks, plannedDurationS: s.durationS, plannedLoad: s.plannedLoad,
        plannedMechanicalLoad: s.plannedMechanicalLoad, plannedDistanceM: s.plannedDistanceM,
      }, PIERRE_MODEL);
      expect(m.plannedDistanceM, s.title).toBe(s.plannedDistanceM);
    }
  });
});

describe('Le bloc de force, du 09/10 au 01/11', () => {
  // « Je vais commencer le renforcement musculaire de façon quotidienne. De façon bien énervée. »
  // Le soir des tests : « concentre-toi sur le renforcement plutôt que les marches longues […]
  // spécifique trail, spécifique mon profil et mes lacunes ».
  /** Les tests du 09/10, tels que Pierre les a notés. */
  const TESTS_0910: StrengthTestResult[] = [
    { date: '2026-10-09', test: 'test-mollets', left: 91, right: 117, updatedAt: '' },
    { date: '2026-10-09', test: 'test-pont', left: 32, right: 36, updatedAt: '' },
    { date: '2026-10-09', test: 'test-chaise', value: 130, updatedAt: '' },
    { date: '2026-10-09', test: 'test-gainage', value: 117, updatedAt: '' },
    { date: '2026-10-09', test: 'test-equilibre', left: 22, right: 60, updatedAt: '' },
    { date: '2026-10-09', test: 'test-cheville', left: 11, right: 9, updatedAt: '' },
    { date: '2026-10-09', test: 'test-souplesse', value: 0, updatedAt: '' },
  ];
  const weak = weakSides(TESTS_0910, '2026-10-10');
  const block = Array.from({ length: 24 }, (_, i) => blockDay(PIERRE_MODEL, i, weak));
  /** Le jour `i` du bloc tombe un vendredi pour i = 0 : lundi = 0. */
  const dow = (i: number) => (i + 4) % 7;
  const weeks = [1, 2, 3].map((w) => block.filter((_, i) => blockWeekOf(i) === w));
  const blocksOf = (key: ExerciseKey) => block.flatMap((s) => s.blocks).filter((b) => b.exercise === key);
  /** Ce qui charge lourdement un groupe : les exercices comptés en répétitions, hors marche. */
  const HEAVY: Record<string, ExerciseKey[]> = {
    genoux: ['split-squat-maison', 'descente-marche', 'reverse-nordic', 'squat-une-jambe'],
    'chaîne arrière': ['souleve-une-jambe', 'hip-thrust', 'leg-curl-serviette'],
  };
  /** Les séries de force de la semaine : tout ce qui se compte en répétitions ou se tient, hors marche, soins et tests. */
  const sets = (days: typeof block) =>
    days
      .flatMap((s) => s.blocks)
      .filter((b) => !b.kind && b.zone !== 'Z1' && (b.reps || b.effort) && !EXERCISES[b.exercise as ExerciseKey]?.measure)
      .reduce((a, b) => a + (b.repeat ?? 1), 0);
  const TESTS = ['test-mollets', 'test-pont', 'test-chaise', 'test-gainage', 'test-equilibre', 'test-cheville', 'test-souplesse'];

  it('lit les côtés faibles des tests : plus de 10 % d’écart, ou 1,5 cm à la cheville', () => {
    expect(weak).toEqual({
      calves: { side: 'gauche', measured: 'au test, 91 montées contre 117' },
      hips: { side: 'gauche', measured: 'au test, 32 ponts contre 36' },
      balance: { side: 'gauche', measured: 'au test, 22 s contre 60 s' },
      ankle: { side: 'droite', measured: 'au test, 9 cm contre 11' },
    });
    // Sous le seuil, aucun côté n'est faible ; et ce sont les derniers tests qui comptent.
    expect(weakSides([{ date: '2026-10-09', test: 'test-pont', left: 34, right: 36, updatedAt: '' }], '2026-10-10')).toEqual({});
    expect(weakSides(TESTS_0910, '2026-10-08')).toEqual({});
  });

  it('donne une série de plus au côté faible, et le dit', () => {
    const rdl = blocksOf('souleve-une-jambe')[0]!;
    expect([rdl.repeat, rdl.extra]).toEqual([9, { side: 'gauche', sets: 1 }]);
    expect(rdl.notes).toContain('Jambe gauche : une série de plus — au test, 32 ponts contre 36.');
    expect(blocksOf('mollets-iso')[0]!.extra).toEqual({ side: 'gauche', sets: 1 });
    expect(blocksOf('equilibre')[0]!.extra).toEqual({ side: 'gauche', sets: 2 });
    expect(blocksOf('cheville-mobilite')[0]!.extra).toEqual({ side: 'droite', sets: 1 });
    // Sans test, pas de série en plus.
    expect(blockDay(PIERRE_MODEL, 4).blocks.find((b) => b.exercise === 'souleve-une-jambe')!.extra).toBeUndefined();
  });

  it('donne un entraînement chaque jour, sans rien à courir', () => {
    expect(block).toHaveLength(24);
    for (const s of block) {
      expect(['strength', 'cross_training']).toContain(s.type);
      for (const b of s.blocks) {
        expect(b.speedRangeMs, `${s.title} — ${b.label}`).toBeUndefined();
        expect(b.paceRange, `${s.title} — ${b.label}`).toBeUndefined();
      }
    }
  });

  it('se fait sans salle : rien, le step, le kit d’élastiques, un sac chargé, la rue', () => {
    for (const s of block) {
      for (const b of s.blocks) {
        expect(isExerciseKey(b.exercise!), `${s.title} — ${b.label}`).toBe(true);
        expect(EXERCISES[b.exercise as ExerciseKey].where, `${s.title} — ${b.label}`).not.toEqual(['salle']);
      }
    }
  });

  it('ne dit « lesté » que d’un exercice qui se fait avec le sac', () => {
    for (const s of block) {
      for (const b of s.blocks.filter((x) => /lesté/.test(x.label))) {
        expect(b.notes ?? '', `${s.title} — ${b.label}`).toMatch(/[Ll]e sac à dos de \d/);
      }
    }
  });

  it('se concentre sur la force : plus de marche longue, cinq séances de force par semaine', () => {
    for (const s of block) {
      for (const b of s.blocks.filter((x) => x.exercise === 'marche' || x.exercise === 'marche-cote')) {
        expect(b.durationS!, `${s.title} — ${b.label}`).toBeLessThanOrEqual(30 * 60);
      }
    }
    for (const w of weeks.slice(0, 2)) expect(w.filter((s) => s.type === 'strength')).toHaveLength(5);
  });

  it('renforce chaque jour, sans jamais charger les mêmes muscles lourds deux jours de suite', () => {
    for (const s of block) expect(s.blocks.some((b) => !b.kind && b.zone !== 'Z1' && (b.reps || b.effort)), s.title).toBe(true);
    for (const [group, keys] of Object.entries(HEAVY)) {
      const days = block.map((s, i) => (s.blocks.some((b) => b.reps && keys.includes(b.exercise as ExerciseKey)) ? i : -1)).filter((i) => i >= 0);
      for (let k = 1; k < days.length; k++) expect(days[k]! - days[k - 1]!, `${group} : jours ${days.join(', ')}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('ouvre et ferme sur les mêmes sept tests, un par étape, dans le même ordre', () => {
    const testsOf = (i: number) => block[i]!.blocks.filter((b) => TESTS.includes(b.exercise!)).map((b) => b.exercise);
    expect(testsOf(0)).toEqual(TESTS);
    expect(testsOf(23)).toEqual(TESTS);
    expect(block.filter((s) => s.blocks.some((b) => TESTS.includes(b.exercise!)))).toHaveLength(2);
  });

  it('se suit en parties : chaque bloc dit la sienne, et une partie ne s’ouvre qu’une fois', () => {
    for (const s of block) {
      const parts = s.blocks.map((b) => b.part);
      expect(parts.every(Boolean), s.title).toBe(true);
      const opened = parts.filter((p, i) => i === 0 || parts[i - 1] !== p);
      expect(new Set(opened).size, `${s.title} : ${opened.join(' / ')}`).toBe(opened.length);
      expect(parts[0], s.title).toMatch(/^(Échauffement|Marche)$/);
      expect(parts.at(-1), s.title).toBe('Bras plâtré et respiration');
    }
  });

  it('dit chaque exercice d’une jambe par jambe : autant de séries de chaque côté, plus celles du côté faible', () => {
    for (const b of block.flatMap((s) => s.blocks).filter((x) => x.sides)) {
      expect(((b.repeat ?? 1) - (b.extra?.sets ?? 0)) % 2, b.label).toBe(0);
    }
    const fente = block[3]!.blocks.find((b) => b.exercise === 'split-squat-maison')!;
    expect([fente.repeat, fente.reps, fente.sides, fente.reserve]).toEqual([8, 8, 'jambe', 2]);
    expect(fente.tempo).toContain('3 s pour descendre');
    expect(fente.notes).toContain('6 à 8 kg');
  });

  it('suit la semaine type, et ses titres sont ceux que la page Exercices annonce', () => {
    for (const w of weeks.slice(0, 2)) {
      expect(w.map((s) => s.type)).toEqual([
        'strength', 'strength', 'cross_training', 'strength', 'strength', 'strength', 'cross_training',
      ]);
    }
    block.forEach((s, i) => {
      if (i <= 2 || i === 23) return;
      expect(s.title.startsWith(FORCE_BLOCK_DAYS[dow(i)]!.title), s.title).toBe(true);
    });
    // Le samedi 10/10, le lendemain des tests : la force A, sans les mollets vidés la veille.
    expect(block[1]!.title.startsWith('Force A')).toBe(true);
    expect(block[1]!.blocks.some((b) => b.exercise === 'mollets-iso')).toBe(false);
  });

  it('construit, charge, puis allège avant les tests de fin', () => {
    const [w1, w2, w3] = weeks.map(sets);
    expect(w2).toBeGreaterThan(w1!);
    expect(w3).toBeLessThan(w1! * 0.8);
    // Le temps d'entraînement, sans les soins du bras ni la respiration : moins de dix heures.
    for (const w of weeks) {
      const minutes = w.reduce((a, s) => a + s.durationS - (annexOf(s.blocks)?.durationS ?? 0), 0) / 60;
      expect(minutes).toBeLessThan(10 * 60);
    }
  });

  it('garde l’intensité une fois par semaine, au seuil, dans les escaliers et pas sur le step', () => {
    const moteurs = block.filter((s) => s.title.startsWith('Moteur et mollets'));
    expect(moteurs).toHaveLength(3);
    const reps = moteurs.map((s) => s.blocks.find((b) => b.part === 'Fractionné')!);
    expect(reps.map((b) => [b.zone, b.exercise])).toEqual([['Z4', 'marche-cote'], ['Z4', 'marche-cote'], ['Z4', 'marche-cote']]);
    expect(reps[2]!.repeat).toBeLessThan(reps[1]!.repeat!);
  });

  it('charge le mollet trois fois par semaine : l’isométrie lourde deux fois, lesté une fois', () => {
    for (const w of weeks.slice(0, 2)) {
      expect(w.filter((s) => s.blocks.some((b) => b.exercise === 'mollets-iso'))).toHaveLength(2);
      expect(w.filter((s) => s.blocks.some((b) => b.exercise === 'mollets-charges'))).toHaveLength(1);
    }
  });

  it('entretient le bras plâtré tous les jours, et l’imagine forcer cinq jours sur sept', () => {
    for (const s of block) expect(s.blocks.some((b) => b.exercise === 'soins-bras'), s.title).toBe(true);
    for (const w of weeks) expect(w.filter((s) => s.blocks.some((b) => b.label.startsWith('Imagerie'))).length).toBe(5);
  });

  it('se recompte sans devenir des kilomètres', () => {
    for (const s of block) {
      const m = remeasured({
        type: s.type, blocks: s.blocks, plannedDurationS: s.durationS, plannedLoad: s.plannedLoad,
        plannedMechanicalLoad: s.plannedMechanicalLoad, plannedDistanceM: s.plannedDistanceM,
      }, PIERRE_MODEL);
      expect([m.plannedLoad, m.plannedDistanceM, m.plannedMechanicalLoad], s.title).toEqual([
        s.plannedLoad, s.plannedDistanceM, s.plannedMechanicalLoad,
      ]);
    }
  });
});
