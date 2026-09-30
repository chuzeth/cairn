import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createGate } from './gate.js';
import { GateStore } from './store.js';

/**
 * La porte, telle que le service la lance (`scripts/service.mjs`, `run`) :
 * sur la boucle locale, devant le site. Funnel la joint ; rien d'autre.
 *
 *   CAIRN_GATE_PORT       son port (3100)
 *   CAIRN_GATE_UPSTREAM   le port du site qu'elle relaie (3000)
 *   CAIRN_PUBLIC_ORIGIN   l'adresse publique, que WebAuthn vérifie ; à défaut,
 *                         le nom du Mac sur Tailscale (CAIRN_TAILSCALE)
 *   CAIRN_AUTH_DB         la base des clés d'accès et des sessions
 */
const port = Number(process.env.CAIRN_GATE_PORT ?? 3100);
const upstream = Number(process.env.CAIRN_GATE_UPSTREAM ?? 3000);
const configured = process.env.CAIRN_PUBLIC_ORIGIN?.trim() || null;
const dbPath = process.env.CAIRN_AUTH_DB;
if (!dbPath) {
  console.error('CAIRN_AUTH_DB manquant : la porte ne démarre pas sans sa base.');
  process.exit(1);
}

// Le paquet n'exporte que son point d'entrée : le fichier autonome se trouve à
// partir de lui, à sa place dans le paquet publié.
const browserScript = readFileSync(
  join(dirname(createRequire(import.meta.url).resolve('@simplewebauthn/browser')), '../dist/bundle/index.umd.min.js'),
  'utf8',
);
/**
 * L'adresse publique, telle que Tailscale la donne. Relue tant qu'elle manque —
 * le démon peut démarrer après la porte —, puis gardée : le nom du Mac sur le
 * tailnet ne change pas sous un processus qui tourne.
 */
let known: string | null = configured;
function origin(): string | null {
  if (known) return known;
  try {
    const out = execFileSync(process.env.CAIRN_TAILSCALE ?? 'tailscale', ['status', '--json'], { encoding: 'utf8', timeout: 5000 });
    const state = JSON.parse(out) as { BackendState?: string; Self?: { DNSName?: string } };
    if (state.BackendState === 'Running' && state.Self?.DNSName) known = `https://${state.Self.DNSName.replace(/\.$/, '')}`;
  } catch {
    // Tailscale absent ou arrêté : pas de connexion possible pour l'instant.
  }
  return known;
}

const store = new GateStore(dbPath);
const server = createGate({
  store, origin, browserScript,
  upstream: { host: '127.0.0.1', port: upstream },
  log: (line) => console.log(line),
});

server.listen(port, '127.0.0.1', () => {
  const { port: bound } = server.address() as { port: number };
  console.log(`porte → http://127.0.0.1:${bound}, relaie vers 127.0.0.1:${upstream} ; ${origin() ?? 'adresse publique inconnue pour l\'instant'}`);
});

const stop = () => server.close(() => { store.close(); process.exit(0); });
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
