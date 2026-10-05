import { describe, expect, it } from 'vitest';
import { EXERCISES, annexOf, isExerciseKey, type ExerciseKey } from '@cairn/core';
import { compensationDay, compensationHomeDay, remeasured } from '@cairn/coach';
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
