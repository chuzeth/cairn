import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ActivityPoller, DEFAULT_POLL_INTERVAL_MS, activityPollerStatus,
  startActivityPoller, stopActivityPoller, type BackfillFn,
} from '../apps/api/src/poller.js';
import type { BackfillProgress } from '../apps/api/src/sync.js';

const MIN = 60_000;

/**
 * Fait tourner l'horloge. `start()` ne bloque jamais sur la première relève —
 * l'API doit répondre pendant qu'un rattrapage de quarante séances tourne —
 * donc même une relève immédiate passe par le tour de boucle suivant.
 */
const tourner = (ms = 0) => vi.advanceTimersByTimeAsync(ms);

/** Résultat d'un import, avec le minimum de bruit dans les tests. */
function progress(patch: Partial<BackfillProgress> = {}): BackfillProgress {
  return {
    fetched: 0, ingested: 0, skipped: 0, errors: [], rateLimited: false, message: '', ...patch,
  };
}

/** Relève jamais démarrée automatiquement : chaque test contrôle son horloge. */
function poller(run: BackfillFn, opts: { intervalMs?: number; lastSuccessAt?: number | null } = {}) {
  return new ActivityPoller({
    athleteId: 'pierre',
    intervalMs: opts.intervalMs ?? DEFAULT_POLL_INTERVAL_MS,
    run,
    lastSuccessAt: async () => opts.lastSuccessAt ?? null,
  });
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-09-02T12:00:00.000Z'));
});

afterEach(() => {
  stopActivityPoller();
  vi.useRealTimers();
});

describe('Cadence', () => {
  it('relève au démarrage puis à chaque quart d\'heure', async () => {
    const run = vi.fn(async () => progress());
    const p = poller(run);
    await p.start();
    await tourner();

    expect(run).toHaveBeenCalledTimes(1); // le démarrage vaut relève
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(run).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(45 * MIN);
    expect(run).toHaveBeenCalledTimes(5);

    p.stop();
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(run).toHaveBeenCalledTimes(5); // arrêtée, l'horloge ne repart pas
  });

  it('tient le quart d\'heure par défaut', () => {
    expect(DEFAULT_POLL_INTERVAL_MS).toBe(15 * MIN);
  });

  it('ne relève rien quand la cadence est nulle', async () => {
    const run = vi.fn(async () => progress());
    const p = poller(run, { intervalMs: 0 });
    await p.start();
    await vi.advanceTimersByTimeAsync(24 * 60 * MIN);

    expect(run).not.toHaveBeenCalled();
    expect(p.status().enabled).toBe(false);
    expect(p.status().nextRunAt).toBeNull();
  });

  it('attend le reste de l\'intervalle si un import vient d\'aboutir', async () => {
    // Un redémarrage — `tsx watch` en provoque un à chaque sauvegarde — ne doit
    // pas se payer en quota Strava.
    const run = vi.fn(async () => progress());
    const p = poller(run, { lastSuccessAt: Date.now() - 5 * MIN });
    await p.start();
    await tourner();

    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(9 * MIN);
    expect(run).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1 * MIN + 1);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('rattrape dans la minute qui suit le réveil une relève échue pendant la veille', async () => {
    // Pendant la veille du Mac, l'heure avance mais rien ne garantit que le
    // délai d'un minuteur compte ce temps : une nuit de sommeil ne doit pas
    // repousser la relève d'un quart d'heure après le réveil.
    const run = vi.fn(async () => progress());
    const p = poller(run);
    await p.start();
    await tourner();
    await vi.advanceTimersByTimeAsync(5 * MIN);
    expect(run).toHaveBeenCalledTimes(1);

    vi.setSystemTime(Date.now() + 8 * 60 * MIN); // la nuit : l'heure saute, les minuteurs n'avancent pas
    await vi.advanceTimersByTimeAsync(1 * MIN);
    expect(run).toHaveBeenCalledTimes(2);
    p.stop();
  });
});

describe('Tolérance aux pannes', () => {
  it('poursuit après un échec et compte les échecs consécutifs', async () => {
    const run = vi
      .fn<BackfillFn>()
      .mockResolvedValueOnce(progress({ ingested: 1, message: 'ok' }))
      .mockRejectedValueOnce(new Error('fetch failed'))
      .mockRejectedValueOnce(new Error('jeton expiré'))
      .mockResolvedValue(progress({ message: 'rien de neuf' }));

    const p = poller(run);
    await p.start();
    await tourner();
    expect(p.status().consecutiveFailures).toBe(0);

    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(p.status().lastOutcome).toBe('error');
    expect(p.status().lastMessage).toBe('fetch failed');
    expect(p.status().consecutiveFailures).toBe(1);

    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(p.status().consecutiveFailures).toBe(2);

    // La quatrième relève a bien lieu : l'échec n'a pas arrêté l'horloge.
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(run).toHaveBeenCalledTimes(4);
    expect(p.status().lastOutcome).toBe('ok');
    expect(p.status().consecutiveFailures).toBe(0);
    expect(p.status().ingested).toBe(1);
  });

  it('traite un import interrompu comme un échec, pas comme un passage à vide', async () => {
    const run = vi.fn(async () =>
      progress({ interrupted: 'Aucun jeton Strava enregistré.', message: 'Import interrompu : …' }),
    );
    const p = poller(run);
    await p.start();
    await tourner();

    expect(p.status().lastOutcome).toBe('error');
    expect(p.status().lastMessage).toBe('Aucun jeton Strava enregistré.');
    expect(p.status().consecutiveFailures).toBe(1);
  });

  it('ne compte pas le quota atteint comme un échec', async () => {
    // Le frein de quota est prévu : la relève suivante reprend où celle-ci
    // s'est arrêtée, il n'y a rien à réparer.
    const run = vi.fn(async () => progress({ ingested: 12, rateLimited: true, message: 'Quota…' }));
    const p = poller(run);
    await p.start();
    await tourner();

    expect(p.status().lastOutcome).toBe('rate-limited');
    expect(p.status().consecutiveFailures).toBe(0);
    expect(p.status().lastIngested).toBe(12);
  });

  it('ne dédouble pas une relève qui dure plus qu\'un intervalle', async () => {
    let release: (() => void) | null = null;
    const run = vi.fn<BackfillFn>(
      () => new Promise((resolve) => { release = () => resolve(progress()); }),
    );
    const p = poller(run);
    await p.start();
    await tourner();

    expect(p.status().running).toBe(true);
    await vi.advanceTimersByTimeAsync(60 * MIN);
    expect(run).toHaveBeenCalledTimes(1);
    expect(await p.runOnce()).toBeNull(); // un appel manuel ne s'y superpose pas
    expect(run).toHaveBeenCalledTimes(1);

    release!();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(run).toHaveBeenCalledTimes(2); // la cadence repart après coup
  });
});

describe('Dépendances', () => {
  it('ne demande jamais l\'analyse rédigée', async () => {
    // La relève ne doit dépendre d'aucune clé Anthropic : les chiffres entrent
    // en base sans elle.
    const run = vi.fn<BackfillFn>(async () => progress());
    const p = poller(run);
    await p.start();
    await vi.advanceTimersByTimeAsync(15 * MIN);
    expect(run.mock.calls.length).toBeGreaterThan(1);

    for (const call of run.mock.calls) {
      expect(call[0]).toBe('pierre');
      expect(call[1].withInsights).toBe(false);
    }
  });

  it('relève quand même si le dernier import est illisible', async () => {
    const run = vi.fn(async () => progress());
    const p = new ActivityPoller({
      athleteId: 'pierre',
      run,
      lastSuccessAt: async () => { throw new Error('base indisponible'); },
    });
    await p.start();
    await tourner();
    expect(run).toHaveBeenCalledTimes(1);
    p.stop();
  });
});

describe('État exposé par /health', () => {
  it('passe de nul à renseigné, et redevient nul à l\'arrêt', async () => {
    expect(activityPollerStatus()).toBeNull();

    const run = vi.fn(async () => progress({ ingested: 1, message: '1 activité importée.' }));
    await startActivityPoller({ athleteId: 'pierre', run, lastSuccessAt: async () => null });
    await tourner();

    const status = activityPollerStatus();
    expect(status).toMatchObject({
      enabled: true,
      intervalMs: DEFAULT_POLL_INTERVAL_MS,
      running: false,
      lastOutcome: 'ok',
      lastIngested: 1,
      runs: 1,
      consecutiveFailures: 0,
    });
    // Prochaine relève annoncée : sans elle, personne ne sait si l'horloge tourne.
    expect(status!.lastRunAt).toBe('2026-09-02T12:00:00.000Z');
    expect(status!.nextRunAt).toBe('2026-09-02T12:15:00.000Z');

    stopActivityPoller();
    expect(activityPollerStatus()).toBeNull();
  });
});
