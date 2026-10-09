import { describe, expect, it } from 'vitest';
import { blockDay, weakSides } from '@cairn/coach';
import type { StrengthTestResult } from '@cairn/core';
import { PIERRE_MODEL } from './fixtures/pierre.js';
import {
  isWorkout, measureText, parseMeasure, setLabel, stepRx, stepsOf, workoutOf, workoutSummary, type Step,
} from '../apps/web/lib/workout';

/**
 * La séance à suivre : ce que l'écran dit de chaque exercice.
 *
 * Le 09/10, Pierre : « chaque jour, une séance ; je clique dessus et j'ai,
 * exercice après exercice, le petit schéma, combien de séries, combien de
 * répétitions, avec des grandes parties ». Ce qui se lit en gros doit être ce
 * que le coach a prescrit, et rien d'autre.
 */

const TESTS_0910: StrengthTestResult[] = [
  { date: '2026-10-09', test: 'test-mollets', left: 91, right: 117, updatedAt: '' },
  { date: '2026-10-09', test: 'test-pont', left: 32, right: 36, updatedAt: '' },
  { date: '2026-10-09', test: 'test-equilibre', left: 22, right: 60, updatedAt: '' },
  { date: '2026-10-09', test: 'test-cheville', left: 11, right: 9, updatedAt: '' },
];
const weak = weakSides(TESTS_0910, '2026-10-10');
const day = (i: number, w = {}) => {
  const t = blockDay(PIERRE_MODEL, i, w);
  return { blocks: t.blocks, plannedDurationS: t.durationS };
};
const find = (steps: Step[], name: string) => steps.find((s) => s.name === name)!;

describe('La séance à suivre', () => {
  it('range la séance en grandes parties, dans l’ordre où elles se font', () => {
    // Le lundi 12/10 : la force A.
    expect(workoutOf(day(3)).map((p) => p.name)).toEqual([
      'Échauffement', 'Jambes', 'Mollets', 'Bras valide', 'Tronc', 'Bras plâtré et respiration',
    ]);
    // Le mercredi 14/10 : le moteur et les mollets.
    expect(workoutOf(day(5)).map((p) => p.name)).toEqual([
      'Échauffement', 'Fractionné', 'Retour au calme', 'Mollets et pieds', 'Chevilles et équilibre', 'Bras plâtré et respiration',
    ]);
    // Le vendredi 09/10 : les tests.
    expect(workoutOf(day(0)).map((p) => p.name)).toEqual(['Échauffement', 'Les tests', 'Bras plâtré et respiration']);
  });

  it('dit chaque exercice en séries et répétitions, par jambe, avec son tempo, son repos et sa réserve', () => {
    const fente = find(stepsOf(workoutOf(day(3))), 'Fente bulgare lestée');
    expect([fente.main, fente.mainNote, fente.sets]).toEqual(['4 × 8', 'par jambe', 4]);
    expect(fente.details).toEqual([
      { label: 'Tempo', text: '3 s pour descendre, 1 s en bas, 1 s pour monter' },
      { label: 'Repos', text: '90 s après les deux jambes' },
      { label: 'Effort', text: 'arrête-toi 2 répétitions avant l’échec' },
    ]);
    expect(fente.block.notes).toContain('6 à 8 kg');
    expect(fente.sheet?.cues.length).toBeGreaterThanOrEqual(2);
  });

  it('ajoute les séries du côté faible des tests, à cocher à part', () => {
    const rdl = find(stepsOf(workoutOf(day(4, weak))), 'Soulevé de terre sur une jambe, lesté');
    expect([rdl.main, rdl.mainNote, rdl.base, rdl.sets]).toEqual(['4 × 8', 'par jambe, +1 à gauche', 4, 5]);
    expect(setLabel(rdl, 0)).toBe('Série 1 sur 4 · gauche, puis droite');
    expect(setLabel(rdl, 4)).toBe('Série en plus, jambe gauche seule');
    // Le sommaire le dit aussi : c'est là que se prépare la séance.
    expect(stepRx(rdl)).toBe('4 × 8 par jambe, +1 à gauche');
    expect(stepRx(find(stepsOf(workoutOf(day(4))), 'Soulevé de terre sur une jambe, lesté'))).toBe('4 × 8 par jambe');
    const equilibre = find(stepsOf(workoutOf(day(5, weak))), 'Équilibre yeux fermés');
    expect([equilibre.main, equilibre.mainNote, equilibre.sets]).toEqual(['45 s', 'par jambe, +2 à gauche', 3]);
  });

  it('minute les maintiens et rythme les efforts guidés', () => {
    const steps = stepsOf(workoutOf(day(3)));
    const chaise = find(steps, 'Chaise sur une jambe');
    expect([chaise.main, chaise.mainNote, chaise.timer]).toEqual(['3 × 30 s', 'par jambe', { kind: 'hold', seconds: 30 }]);
    const mollet = find(steps, 'Mollet sous le cadre de porte');
    expect([mollet.main, mollet.mainNote]).toEqual(['4 × 4', 'par jambe · 3 s à fond, 3 s relâché']);
    expect(mollet.timer).toEqual({ kind: 'pulse', workS: 3, restS: 3, reps: 4 });
  });

  it('fait des tests des étapes à mesurer : le chrono, le métronome des mollets, un champ par jambe', () => {
    const tests = stepsOf(workoutOf(day(0))).filter((s) => s.measure);
    expect(tests.map((s) => s.sheet?.key)).toEqual([
      'test-mollets', 'test-pont', 'test-chaise', 'test-gainage', 'test-equilibre', 'test-cheville', 'test-souplesse',
    ]);
    expect(tests[0]!.timer).toEqual({ kind: 'stopwatch', max: undefined, beatS: 2 });
    expect(tests[2]!.timer).toEqual({ kind: 'stopwatch', max: undefined, beatS: undefined });
    expect(tests[4]!.timer).toEqual({ kind: 'stopwatch', max: 60, beatS: undefined });
    expect(tests[5]!.timer).toBeNull();
  });

  it('dit le fractionné au cœur, la récupération en marchant, et les montées lestées en continu', () => {
    const montees = stepsOf(workoutOf(day(5))).find((s) => s.name.startsWith('Montées rapides'))!;
    expect(montees.main).toBe('5 × 3 min');
    expect(montees.details).toContainEqual({ label: 'Récupération', text: '3 min en marchant, en redescendant' });
    const endurance = find(stepsOf(workoutOf(day(8))), 'Montées continues lestées');
    expect(endurance.main).toBe('3 × 6 min');
    expect(endurance.details).toContainEqual({ label: 'Cœur', text: 'entre 141 et 155 bpm' });
  });

  it('annonce la séance en parties, exercices et durée', () => {
    const d = day(3);
    expect(workoutSummary(workoutOf(d), d.plannedDurationS)).toMatch(/^6 parties · 12 exercices · 1 h \d\d$/);
    expect(isWorkout(d)).toBe(true);
    expect(isWorkout({ blocks: [{ label: 'Footing', zone: 'Z2', durationS: 2400 }] })).toBe(false);
  });

  it('lit un résultat écrit à la française, et le redit avec son unité', () => {
    expect(parseMeasure('1,5')).toBe(1.5);
    expect(parseMeasure('−3')).toBe(-3);
    expect(parseMeasure(' 28 ')).toBe(28);
    expect(parseMeasure('vingt')).toBeNull();
    expect(measureText(95, 'secondes')).toBe('1 min 35 s');
    expect(measureText(42, 'secondes')).toBe('42 s');
    expect(measureText(-1, 'cm')).toBe('−1 cm');
    expect(measureText(3, 'cm')).toBe('+3 cm');
  });
});
