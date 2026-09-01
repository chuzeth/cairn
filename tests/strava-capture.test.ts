import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { StravaClient, type StravaOAuthConfig, type TokenStore } from '@cairn/strava';

/** Réponse plausible de /activities/:id/streams : trois points, dont des positions. */
const STREAMS = {
  time: { data: [0, 5, 10] },
  distance: { data: [0, 12.4, 25.9] },
  altitude: { data: [212.6, 213.1, 214.8] },
  heartrate: { data: [118, 131, 140] },
  latlng: { data: [[45.1885, 5.7245], [45.1886, 5.7247], [45.1888, 5.7251]] },
  moving: { data: [true, true, true] },
};

const store: TokenStore = {
  async get() {
    return {
      accessToken: 'jeton-de-test',
      refreshToken: 'rafraichissement-de-test',
      expiresAt: Math.floor(Date.now() / 1000) + 3600, // large, donc aucun renouvellement
    };
  },
  async set() {},
};

const config: StravaOAuthConfig = {
  clientId: '0', clientSecret: 'secret', redirectUri: 'http://localhost:4000/auth/strava/callback',
};

it('capture une réponse Strava puis la rejoue à l\'identique, réseau coupé', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-capture-'));
  const vraiFetch = globalThis.fetch;
  let appelsReseau = 0;

  try {
    // 1. Capture — le seul appel réseau de tout le test, servi par un fetch factice.
    globalThis.fetch = async () => {
      appelsReseau++;
      return new Response(JSON.stringify(STREAMS), {
        status: 200,
        headers: { 'x-ratelimit-limit': '100,1000', 'x-ratelimit-usage': '7,42' },
      });
    };
    process.env.CAIRN_CAPTURE_DIR = dir;
    const captured = await new StravaClient(store, config).getStreams(14_582_331);
    expect(appelsReseau).toBe(1);
    expect(readdirSync(dir)).toHaveLength(1);

    // 2. Rejeu — réseau coupé : toute sortie fait échouer le test.
    delete process.env.CAIRN_CAPTURE_DIR;
    process.env.CAIRN_REPLAY_DIR = dir;
    globalThis.fetch = () => {
      throw new Error('réseau coupé : le rejeu ne doit pas appeler fetch');
    };
    const rejoue = await new StravaClient(store, config).getStreams(14_582_331);

    expect(rejoue).toEqual(captured);
    expect(appelsReseau).toBe(1);
  } finally {
    globalThis.fetch = vraiFetch;
    delete process.env.CAIRN_CAPTURE_DIR;
    delete process.env.CAIRN_REPLAY_DIR;
    rmSync(dir, { recursive: true, force: true });
  }
});
