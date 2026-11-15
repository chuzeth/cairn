import { describe, expect, it } from 'vitest';
import { localIso, nextWeekOf, weekDone, weekStartOf } from '../apps/web/lib/today';

/**
 * Le 15/11, dimanche, Pierre fait la séance du jour et demande pourquoi l'app ne
 * montre pas les séances de la semaine qui vient : le plan s'ouvrait encore sur
 * la semaine finie, et l'écran du matin n'annonçait que la prochaine séance.
 * Une semaine dont il ne reste rien à faire cède la place à la suivante.
 */

const s = (date: string, type: string, status = 'planned') => ({ date, type, status });

const week = [
  s('2026-11-09', 'endurance', 'completed'), s('2026-11-10', 'rest'), s('2026-11-11', 'endurance', 'completed'),
  s('2026-11-12', 'rest'), s('2026-11-13', 'threshold', 'replaced'), s('2026-11-14', 'rest'),
  s('2026-11-15', 'long_run', 'planned'), s('2026-11-17', 'hill_repeats'),
];

describe('Une semaine dont il ne reste rien à faire', () => {
  it('est finie quand la dernière séance est faite, même si son jour n’est pas passé', () => {
    expect(weekDone(week, '2026-11-15')).toBe(false);
    const done = week.map((x) => (x.date === '2026-11-15' ? { ...x, status: 'replaced' } : x));
    expect(weekDone(done, '2026-11-15')).toBe(true);
    // Un repos ou une séance retirée ne retiennent pas la semaine.
    expect(weekDone([...done, s('2026-11-15', 'rest'), s('2026-11-14', 'endurance', 'withdrawn')], '2026-11-15')).toBe(true);
  });

  it('cède la place à la suivante — et pas avant', () => {
    const done = week.map((x) => (x.date === '2026-11-15' ? { ...x, status: 'replaced' } : x));
    expect(nextWeekOf(done, '2026-11-15')).toBe('2026-11-16');
    expect(nextWeekOf(week, '2026-11-15')).toBeNull();
    // Le jeudi, la semaine a encore du travail : on y reste.
    expect(nextWeekOf(week, '2026-11-12')).toBeNull();
  });

  it('se compte au jour du téléphone, pas au jour UTC : à 0 h 30 à Lyon, c’est déjà demain', () => {
    // 15/11 23:30 UTC = 16/11 0:30 à Paris.
    const d = new Date('2026-11-15T23:30:00Z');
    expect(localIso(d, -60)).toBe('2026-11-16');
    expect(weekStartOf(localIso(d, -60))).toBe('2026-11-16');
  });
});
