import { describe, expect, it } from 'vitest';
import { blockDay } from '@cairn/coach';
import { sessionDuration } from '@cairn/core';
import type { SessionRow } from '../apps/web/lib/api';
import { workoutOf } from '../apps/web/lib/workout';
import {
  countdownDays, flowOf, heartTarget, partKind, sessionKind, thresholdMinutes, weekShare, weekStartOf,
} from '../apps/web/lib/today';
import { PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * L'écran du jour, refondu le 21/10 : la séance dite en chiffres et en formes.
 * Ce que la barre du déroulé colore, ce que « 86 » veut dire, et le calendrier
 * qui mène à la course.
 */

const parts = (i: number) => workoutOf({ blocks: blockDay(PIERRE_MODEL, i).blocks as SessionRow['blocks'] });

describe('Le déroulé d’une séance', () => {
  it('colore chaque partie par sa nature', () => {
    // Le 20/10 : « Escalier, hanches et tronc ».
    const kinds = parts(11).map((p) => `${p.name}:${partKind(p)}`);
    expect(kinds).toEqual([
      'Échauffement:warm', 'Escalier:cardio', 'Hanches:renfo', 'Adducteurs:renfo', 'Tronc:renfo',
      'Souplesse:mobi', 'Coude et respiration:mobi',
    ]);
  });

  it('laisse l’échauffement à l’échauffement, même quand il monte des marches', () => {
    const warm = parts(10).find((p) => p.name === 'Échauffement')!;
    expect(warm.steps.some((s) => (s.block.elevationGainM ?? 0) > 0)).toBe(true);
    expect(partKind(warm)).toBe('warm');
  });

  it('nomme un groupe d’une seule partie par son nom, et plusieurs par leur nature', () => {
    const { groups, minutes, segments } = flowOf(parts(11));
    expect(groups.map((g) => g.label)).toEqual(['Échauffement', 'Escalier', 'Renforcement', 'Mobilité, souffle']);
    expect(groups.reduce((a, g) => a + g.minutes, 0)).toBe(minutes);
    expect(segments).toHaveLength(7);
  });

  it('range la mobilité d’un jour de récupération avec la mobilité', () => {
    expect(partKind(parts(2).find((p) => p.name === 'Mobilité')!)).toBe('mobi');
  });

  it('dit d’une séance la nature qui y prend le plus de temps', () => {
    expect(sessionKind(parts(11))).toBe('cardio');
    expect(sessionKind(parts(10))).toBe('renfo');
    expect(sessionKind(parts(15))).toBe('cardio');
    expect(sessionKind([])).toBe('cardio');
  });
});

describe('Les points de charge, traduits', () => {
  it('compte cent points pour une heure au seuil', () => {
    expect(thresholdMinutes(100)).toBe(60);
    expect(thresholdMinutes(86)).toBe(52);
    expect(thresholdMinutes(518)).toBe(311);
  });

  it('rapporte une séance à sa semaine, du lundi au dimanche, sans ce qui a été retiré', () => {
    const s = (date: string, plannedLoad: number, status = 'planned') => ({ date, plannedLoad, status }) as SessionRow;
    const week = [
      s('2026-10-19', 55, 'completed'), s('2026-10-20', 86), s('2026-10-21', 48), s('2026-10-22', 117),
      s('2026-10-23', 53), s('2026-10-24', 116), s('2026-10-25', 43),
      // La semaine suivante et une séance annulée ne pèsent pas.
      s('2026-10-26', 36), s('2026-10-21', 200, 'cancelled'),
    ];
    expect(weekShare(week[1]!, week)).toBe(17);
    expect(weekShare(s('2026-11-30', 10), [])).toBeNull();
    expect(weekStartOf('2026-10-25')).toBe('2026-10-19');
    expect(weekStartOf('2026-10-19')).toBe('2026-10-19');
  });
});

describe('La cible cardiaque du jour', () => {
  it('prend celle qui tient le plus longtemps, avec sa provenance', () => {
    const target = heartTarget(blockDay(PIERRE_MODEL, 11).blocks as SessionRow['blocks']);
    expect(target?.range).toEqual([expect.any(Number), expect.any(Number)]);
    expect(target?.provenance).not.toBeUndefined();
  });

  it('ne dit rien d’une séance sans cible', () => {
    expect(heartTarget([{ label: 'Jambes', zone: 'Z3', durationS: 600 }])).toBeNull();
  });
});

describe('Le calendrier jusqu’à la course', () => {
  const sessions = [
    { date: '2026-10-19', type: 'strength', status: 'completed' },
    { date: '2026-10-20', type: 'strength', status: 'replaced' },
    { date: '2026-10-21', type: 'strength', status: 'planned' },
    { date: '2026-10-22', type: 'cross_training', status: 'withdrawn' },
    { date: '2026-10-23', type: 'rest', status: 'planned' },
  ] as SessionRow[];
  const days = countdownDays('2026-10-20', '2026-11-07', sessions, () => 'renfo', 2);

  it('va de deux jours avant aujourd’hui jusqu’à la course incluse', () => {
    expect(days[0]!.date).toBe('2026-10-18');
    expect(days.at(-1)).toMatchObject({ date: '2026-11-07', kind: 'race' });
    expect(days).toHaveLength(21);
  });

  it('marque le passé, aujourd’hui, et un jour retiré ou de repos comme un repos', () => {
    expect(days.filter((d) => d.today).map((d) => d.date)).toEqual(['2026-10-20']);
    expect(days.find((d) => d.date === '2026-10-19')).toMatchObject({ past: true, kind: 'renfo' });
    expect(days.find((d) => d.date === '2026-10-22')!.kind).toBe('rest');
    expect(days.find((d) => d.date === '2026-10-23')!.kind).toBe('rest');
  });
});

describe('Les minutes du déroulé', () => {
  it('somment à la durée que la case « Durée » écrit, pas à la somme des arrondis', () => {
    // Le 21/10, Force C : 5 139 s, « 1 h 25 » dans la case, « 86 min » au déroulé.
    const p = parts(6);
    expect(sessionDuration(p.reduce((a, x) => a + x.durationS, 0))).toBe('1 h 20');
    const total = Math.floor(p.reduce((a, x) => a + x.durationS, 0) / 60);
    const { minutes, segments } = flowOf(p);
    expect(minutes).toBe(total);
    expect(segments.reduce((a, s) => a + s.minutes, 0)).toBe(total);
  });
});
