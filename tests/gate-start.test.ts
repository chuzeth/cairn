import { spawn } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';

/**
 * La porte telle que le service la lance : le processus démarre, écoute, et
 * sert de quoi se connecter. Un module introuvable au démarrage ne se voit dans
 * aucun test en mémoire — seulement au moment où launchd relance tout.
 */
it('démarre, sert SimpleWebAuthn et refuse le reste', async () => {
  const child = spawn(process.execPath, ['--import', 'tsx', 'src/index.ts'], {
    cwd: fileURLToPath(new URL('../apps/gate', import.meta.url)),
    env: {
      ...process.env,
      CAIRN_GATE_PORT: '0',
      CAIRN_GATE_UPSTREAM: '9',
      CAIRN_AUTH_DB: join(mkdtempSync(join(tmpdir(), 'cairn-gate-')), 'auth.sqlite'),
      CAIRN_PUBLIC_ORIGIN: 'https://cairn.test',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  try {
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
    const script = await fetch(`http://127.0.0.1:${port}/connexion/webauthn.js`);
    expect(script.status).toBe(200);
    expect(await script.text()).toContain('SimpleWebAuthnBrowser');
    expect((await fetch(`http://127.0.0.1:${port}/api/state`)).status).toBe(401);
  } finally {
    child.kill();
  }
}, 20_000);
