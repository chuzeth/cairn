import { describe, expect, it } from 'vitest';
import { blockDay } from '@cairn/coach';
import { PIERRE_MODEL } from './fixtures/pierre.js';
import {
  isWorkout, measureText, parseMeasure, stepsOf, workoutOf, workoutSummary, type Step,
} from '../apps/web/lib/workout';

/**
 * La séance à suivre : ce que l'écran dit de chaque exercice.
 *
 * Le 09/10, Pierre : « chaque jour, une séance ; je clique dessus et j'ai,
 * exercice après exercice, le petit schéma, combien de séries, combien de
 * répétitions, avec des grandes parties ». Ce qui se lit en gros doit être ce
 * que le coach a prescrit, et rien d'autre.
 */

const day = (i: number) => {
  const t = blockDay(PIERRE_MODEL, i);
  return { blocks: t.blocks, plannedDurationS: t.durationS };
};
const find = (steps: Step[], name: string) => steps.find((s) => s.name === name)!;

describe('La séance à suivre', () => {
  it('range la séance en grandes parties, dans l’ordre où elles se font', () => {
    // Le lundi 12/10 : Force 1.
    expect(workoutOf(day(3)).map((p) => p.name)).toEqual([
      'Échauffement', 'Jambes', 'Mollets', 'Bras valide', 'Tronc', 'Bras plâtré et respiration',
    ]);
    // Le vendredi 09/10 : les tests.
    expect(workoutOf(day(0)).map((p) => p.name)).toEqual(['Échauffement', 'Les tests', 'Bras plâtré et respiration']);
  });

  it('dit chaque exercice en séries et répétitions, par jambe, avec son tempo, son repos et sa réserve', () => {
    const fente = find(stepsOf(workoutOf(day(3))), 'Fente bulgare');
    expect([fente.main, fente.mainNote, fente.sets]).toEqual(['3 × 10', 'par jambe', 3]);
    expect(fente.details).toEqual([
      { label: 'Tempo', text: '3 s pour descendre, 1 s en bas, 1 s pour monter' },
      { label: 'Repos', text: '45 s après les deux jambes' },
      { label: 'Effort', text: 'arrête-toi 2 répétitions avant l’échec' },
    ]);
    expect(fente.sheet?.cues.length).toBeGreaterThanOrEqual(2);
  });

  it('minute les maintiens et rythme les efforts guidés', () => {
    const steps = stepsOf(workoutOf(day(3)));
    const chaise = find(steps, 'Chaise contre le mur');
    expect([chaise.main, chaise.timer]).toEqual(['2 × 75 s', { kind: 'hold', seconds: 75 }]);
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
    expect(tests.filter((s) => s.measure!.perSide).map((s) => s.sheet?.key)).toEqual([
      'test-mollets', 'test-pont', 'test-equilibre', 'test-cheville',
    ]);
  });

  it('dit la marche et le fractionné au cœur, la récupération en marchant', () => {
    const marche = find(stepsOf(workoutOf(day(4))), 'Marche tranquille');
    expect(marche.main).toBe('40 min');
    expect(marche.details).toContainEqual({ label: 'Cœur', text: 'sous 141 bpm' });
    const montees = stepsOf(workoutOf(day(6))).find((s) => s.name.startsWith('Montées rapides'))!;
    expect(montees.main).toBe('5 × 3 min');
    expect(montees.details).toContainEqual({ label: 'Récupération', text: '3 min en marchant, en redescendant' });
  });

  it('annonce la séance en parties, exercices et durée', () => {
    const d = day(3);
    expect(workoutSummary(workoutOf(d), d.plannedDurationS)).toMatch(/^6 parties · 13 exercices · 1 h 1\d$/);
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
