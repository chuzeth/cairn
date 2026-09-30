import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { fakeTailscaleApp } from './fixtures/tailscale';

/**
 * La porte telle que le service la lance : le processus démarre, écoute, et
 * sert de quoi se connecter. Un module introuvable au démarrage ne se voit dans
 * aucun test en mémoire — seulement au moment où launchd relance tout.
 */
async function startGate(env: Record<string, string>) {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('../apps/gate', import.meta.url)),
    env: {
      PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      CAIRN_GATE_PORT: '0',
      CAIRN_GATE_UPSTREAM: '9',
      CAIRN_AUTH_DB: join(mkdtempSync(join(tmpdir(), 'cairn-gate-')), 'auth.sqlite'),
      ...env,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let output = '';
  const port = await new Promise<number>((resolve, reject) => {
    const seen = (chunk: Buffer) => {
      output += chunk.toString();
      const m = /porte → http:\/\/127\.0\.0\.1:(\d+)/.exec(output);
      if (m) resolve(Number(m[1]));
    };
    child.stdout.on('data', seen);
    child.stderr.on('data', seen);
    child.on('error', reject);
    child.on('exit', (code) => reject(new Error(`porte arrêtée (code ${code}) :\n${output}`)));
  });
  return { url: `http://127.0.0.1:${port}`, stop: () => child.kill() };
}

it('démarre, sert SimpleWebAuthn et refuse le reste', async () => {
  const gate = await startGate({ CAIRN_PUBLIC_ORIGIN: 'https://cairn.test' });
  try {
    const script = await fetch(`${gate.url}/connexion/webauthn.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('SimpleWebAuthnBrowser');
    expect((await fetch(`${gate.url}/api/state`)).status).toBe(401);
  } finally {
    gate.stop();
  }
}, 20_000);

/**
 * Sans adresse dans `.env`, la porte demande la sienne à Tailscale — depuis
 * launchd, donc sans terminal. 503 : elle ne l'a pas obtenue ; 409 : elle l'a,
 * et il ne manque qu'une clé d'accès.
 */
it('obtient son adresse publique de Tailscale, lancée comme par launchd', async () => {
  const gate = await startGate({ CAIRN_TAILSCALE: fakeTailscaleApp() });
  try {
    const res = await fetch(`${gate.url}/connexion/options`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(409);
  } finally {
    gate.stop();
  }
}, 20_000);
