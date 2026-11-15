import { describe, expect, it, vi } from 'vitest';
import { getStamped, todayFor } from '../apps/web/lib/api';
import { noteContact, syncedLabel } from '../apps/web/lib/sync';

/**
 * Le téléphone sert quand le Mac dort : il s'ouvre sur ce qu'il a relevé la
 * veille. Le 10/11, l'écran du matin prenait le jour de ce relevé pour
 * aujourd'hui — la séance d'hier sous « Aujourd'hui », et un point du jour daté
 * d'hier dans la file.
 */
describe('Le jour que l’écran tient pour aujourd’hui', () => {
  it('est celui du Mac quand il vient de répondre', () => {
    expect(todayFor('2026-11-10', null)).toBe('2026-11-10');
  });

  it('est celui du téléphone quand la lecture date de la veille', () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date('2026-11-11T06:30:00Z'));
      expect(todayFor('2026-11-10', '2026-11-10T17:38:00.000Z')).toBe('2026-11-11');
      // Relevée ce matin même : le jour est le même, rien ne bouge.
      expect(todayFor('2026-11-11', '2026-11-11T05:00:00.000Z')).toBe('2026-11-11');
      // Jamais en arrière : une horloge de téléphone en retard ne ramène pas à hier.
      expect(todayFor('2026-11-12', '2026-11-11T05:00:00.000Z')).toBe('2026-11-12');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('La date d’une synchronisation, telle qu’on la lit', () => {
  const now = new Date(2026, 10, 11, 7, 30);
  it('se dit par rapport au jour', () => {
    expect(syncedLabel(new Date(2026, 10, 11, 7, 12).toISOString(), now)).toBe('à 7 h 12');
    expect(syncedLabel(new Date(2026, 10, 10, 18, 38).toISOString(), now)).toBe('hier à 18 h 38');
    expect(syncedLabel(new Date(2026, 10, 8, 9, 5).toISOString(), now)).toBe('dimanche à 9 h 05');
    expect(syncedLabel(new Date(2026, 9, 20, 11, 55).toISOString(), now)).toBe('le 20 oct.');
  });
});

describe('Une lecture datée quand le Mac répond', () => {
  it('se refait au réseau, sans passer par la réserve du worker', async () => {
    const calls: string[] = [];
    const fetchMock = vi.fn(async (url: string) => {
      calls.push(url);
      return url.includes('frais=1')
        ? new Response('{"v":"frais"}', { status: 200, headers: { 'content-type': 'application/json' } })
        : new Response('{"v":"garde"}', { status: 200, headers: { 'content-type': 'application/json', 'x-cairn-recorded-at': '2026-11-15T16:09:05Z' } });
    });
    vi.stubGlobal('fetch', fetchMock);
    try {
      // Le Mac ne répond pas encore : la réserve, datée.
      expect(await getStamped('/api/plan?weeks=9')).toEqual({ data: { v: 'garde' }, recordedAt: '2026-11-15T16:09:05Z' });
      // Le pouls vient de passer : la réserve ne suffit plus, la lecture se refait au réseau.
      noteContact(true);
      expect(await getStamped('/api/plan?weeks=9')).toEqual({ data: { v: 'frais' }, recordedAt: null });
      expect(calls.at(-1)).toBe('/api/plan?weeks=9&frais=1');
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
