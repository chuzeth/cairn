import { describe, expect, it } from 'vitest';
import { EXERCISES, FORCE_BLOCK_DAYS, annexOf, isExerciseKey, type ExerciseKey } from '@cairn/core';
import { blockDay, blockWeekOf, compensationDay, compensationHomeDay, remeasured } from '@cairn/coach';
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
  const block = Array.from({ length: 24 }, (_, i) => blockDay(PIERRE_MODEL, i));
  /** Le jour `i` du bloc tombe un vendredi pour i = 0 : lundi = 0. */
  const dow = (i: number) => (i + 4) % 7;
  const weeks = [1, 2, 3].map((w) => block.filter((_, i) => blockWeekOf(i) === w));
  const LEGS_HEAVY: Record<string, ExerciseKey[]> = {
    genoux: ['split-squat-maison', 'descente-marche', 'reverse-nordic'],
    ischios: ['leg-curl-serviette', 'souleve-une-jambe'],
  };
  /** Les séries de force de la semaine : tout ce qui se compte en répétitions ou se tient, hors marche, soins et tests. */
  const sets = (days: typeof block) =>
    days
      .flatMap((s) => s.blocks)
      .filter((b) => !b.kind && b.zone !== 'Z1' && (b.reps || b.effort) && !EXERCISES[b.exercise as ExerciseKey]?.measure)
      .reduce((a, b) => a + (b.repeat ?? 1), 0);
  const TESTS = ['test-mollets', 'test-pont', 'test-chaise', 'test-gainage', 'test-equilibre', 'test-cheville', 'test-souplesse'];

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

  it('se fait sans salle : rien, le step, le kit d’élastiques, la rue', () => {
    for (const s of block) {
      for (const b of s.blocks) {
        expect(isExerciseKey(b.exercise!), `${s.title} — ${b.label}`).toBe(true);
        expect(EXERCISES[b.exercise as ExerciseKey].where, `${s.title} — ${b.label}`).not.toEqual(['salle']);
      }
    }
  });

  it('renforce chaque jour, sans jamais charger les mêmes muscles deux jours de suite', () => {
    for (const s of block) expect(s.blocks.some((b) => !b.kind && b.zone !== 'Z1' && (b.reps || b.effort)), s.title).toBe(true);
    for (const [group, keys] of Object.entries(LEGS_HEAVY)) {
      const days = block.map((s, i) => (s.blocks.some((b) => keys.includes(b.exercise as ExerciseKey)) ? i : -1)).filter((i) => i >= 0);
      for (let k = 1; k < days.length; k++) expect(days[k]! - days[k - 1]!, `${group} : jours ${days.join(', ')}`).toBeGreaterThanOrEqual(2);
    }
  });

  it('porte les titres que la page Exercices annonce, jour par jour', () => {
    block.forEach((s, i) => {
      if (i === 0 || i === 23) return;
      expect(s.title.startsWith(FORCE_BLOCK_DAYS[dow(i)]!.title), s.title).toBe(true);
    });
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

  it('dit chaque exercice d’une jambe par jambe, avec ses séries paires', () => {
    for (const b of block.flatMap((s) => s.blocks).filter((x) => x.sides)) {
      expect((b.repeat ?? 1) % 2, b.label).toBe(0);
    }
    const fente = block[3]!.blocks.find((b) => b.exercise === 'split-squat-maison')!;
    expect([fente.repeat, fente.reps, fente.sides, fente.reserve]).toEqual([6, 10, 'jambe', 2]);
    expect(fente.tempo).toContain('3 s pour descendre');
  });

  it('suit la semaine type : trois séances de force à 48 h, un fractionné, une longue marche le samedi', () => {
    for (const w of weeks.slice(0, 2)) {
      expect(w.map((s) => s.type)).toEqual([
        'strength', 'cross_training', 'strength', 'cross_training', 'strength', 'cross_training', 'cross_training',
      ]);
    }
    expect(block.filter((_, i) => dow(i) === 5).every((s) => s.title.startsWith('Longue marche en côte'))).toBe(true);
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

  it('garde l’intensité une fois par semaine, dans les escaliers et pas sur le step', () => {
    const moteurs = block.filter((s) => s.title.startsWith('Fractionné en côte'));
    expect(moteurs).toHaveLength(3);
    const reps = moteurs.map((s) => s.blocks.find((b) => (b.repeat ?? 1) > 1)!);
    expect(reps.map((b) => b.zone)).toEqual(['Z3', 'Z4', 'Z4']);
    expect(reps.map((b) => b.exercise)).toEqual(['marche-cote', 'marche-cote', 'marche-cote']);
    // La semaine allégée garde l'intensité et coupe le volume.
    expect(reps[2]!.repeat).toBeLessThan(reps[1]!.repeat!);
  });

  it('charge le tendon d’Achille quatre fois par semaine, comme dans l’étude', () => {
    for (const w of weeks.slice(0, 2)) {
      expect(w.filter((s) => s.blocks.some((b) => b.exercise === 'mollets-iso'))).toHaveLength(4);
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
