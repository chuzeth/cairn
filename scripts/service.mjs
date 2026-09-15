/**
 * Cairn installé comme une application : un LaunchAgent utilisateur démarre
 * l'API et le site en mode production à l'ouverture de session et les relance
 * s'ils tombent ; Tailscale Serve les expose en HTTPS au réseau privé, et à lui
 * seul — les deux serveurs n'écoutent que sur 127.0.0.1.
 *
 *   npm run service -- install     construit, installe, démarre, expose
 *   npm run service -- update      après un changement de code : reconstruit, redémarre
 *   npm run service -- uninstall   arrête, désinstalle, retire l'exposition
 *   npm run service -- status      état launchd, réponses des serveurs, adresse HTTPS
 *
 * `run` est la commande que launchd exécute. En production rien ne se recharge
 * seul : une modification n'atteint le téléphone qu'après `update`.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
const ROOT = dirname(dirname(SELF));
const WEB = join(ROOT, 'apps/web');
const NEXT = join(ROOT, 'node_modules/next/dist/bin/next');

const LABEL = 'com.pchuze.cairn';
const DOMAIN = `gui/${process.getuid()}`;
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), 'Library/Logs/Cairn/cairn.log');

/** Le service garde les ports documentés ; `npm run dev` prend 3001 et 4001. */
const WEB_PORT = 3000;
const API_PORT = Number(readEnv().API_PORT ?? 4000);
/** Dossier de build du service, distinct du `.next` des builds de vérification. */
const DIST_DIR = '.next-service';
/** Tailscale standalone n'installe pas de commande dans le PATH : c'est le binaire de l'application. */
const TAILSCALE = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnv() {
  try {
    return parseEnv(readFileSync(join(ROOT, '.env'), 'utf8'));
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Ce que launchd exécute
// ─────────────────────────────────────────────────────────────────────────────

function run() {
  // Sur secteur, pas de veille tant que Cairn tourne. Sur batterie, powerd
  // ignore cette assertion et le Mac dort normalement ; la relève rattrape au
  // réveil. `-w` la lie à ce processus : elle tombe avec lui, quoi qu'il arrive.
  spawn('/usr/bin/caffeinate', ['-s', '-w', String(process.pid)], { stdio: 'ignore' }).unref();

  const env = { ...process.env, NODE_ENV: 'production', CAIRN_WEB_DIST_DIR: DIST_DIR };
  const stdio = ['ignore', 'pipe', 'pipe'];
  const servers = {
    api: spawn(process.execPath, [`--env-file-if-exists=${join(ROOT, '.env')}`, '--import', 'tsx', 'src/index.ts'], {
      cwd: join(ROOT, 'apps/api'), env, stdio,
    }),
    web: spawn(process.execPath, [NEXT, 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'], { cwd: WEB, env, stdio }),
  };

  let stopping = false;
  let alive = Object.keys(servers).length;
  const stop = (code) => {
    if (stopping) return;
    stopping = true;
    process.exitCode = code;
    for (const child of Object.values(servers)) child.kill('SIGTERM');
    setTimeout(() => process.exit(code), 10_000).unref();
  };

  for (const [name, child] of Object.entries(servers)) {
    createInterface({ input: child.stdout }).on('line', (line) => log(name, line));
    createInterface({ input: child.stderr }).on('line', (line) => log(name, line));
    child.on('exit', (code, signal) => {
      // Un serveur tombé emporte l'autre et launchd relance l'ensemble : les
      // relances se comptent dans `launchctl print` au lieu d'être masquées ici.
      if (!stopping) log('service', `${name} arrêté (${signal ?? `code ${code}`}) : relance par launchd`);
      stop(1);
      if (--alive === 0) process.exit(process.exitCode);
    });
  }
  process.on('SIGTERM', () => stop(0));
  process.on('SIGINT', () => stop(0));

  const t0 = Date.now();
  void waitReady(120_000).then((ok) =>
    log('service', ok ? `prêt en ${((Date.now() - t0) / 1000).toFixed(1)} s` : 'ne répond toujours pas après 2 min'),
  );
}

const LEVELS = { 40: 'ATTENTION', 50: 'ERREUR', 60: 'FATAL' };

/** Une ligne par évènement, horodatée ; le JSON de Fastify est réduit à ce qui se lit. */
function log(source, line) {
  let time = Date.now();
  let text = line.trim();
  if (!text) return;
  if (text.startsWith('{')) {
    try {
      const j = JSON.parse(text);
      time = j.time ?? time;
      text = [
        LEVELS[j.level],
        j.msg,
        j.req && `${j.req.method} ${j.req.url}`,
        j.res && `→ ${j.res.statusCode} en ${Math.round(j.responseTime)} ms`,
        j.err?.stack,
      ].filter(Boolean).join(' ');
    } catch {
      // Pas du JSON de Fastify : la ligne telle quelle.
    }
  }
  process.stdout.write(`${new Date(time).toLocaleString('sv-SE')}  ${source.padEnd(7)} ${text}\n`);
}

async function probe(port, path) {
  const t0 = performance.now();
  try {
    const res = await fetch(`http://127.0.0.1:${port}${path}`, { signal: AbortSignal.timeout(5000) });
    const body = await res.text();
    return { ok: res.ok, status: res.status, ms: Math.round(performance.now() - t0), body };
  } catch (e) {
    return { ok: false, status: e.cause?.code ?? e.name, ms: Math.round(performance.now() - t0), body: '' };
  }
}

/**
 * Prêt quand les deux serveurs répondent, puis quand l'état du jour traverse le
 * relais — ce qui chauffe au passage le chemin qu'ouvre le téléphone. L'API est
 * interrogée directement d'abord : par le relais, son absence au démarrage
 * remplirait le journal d'erreurs de connexion.
 */
async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [api, page] = await Promise.all([probe(API_PORT, '/health'), probe(WEB_PORT, '/')]);
    if (api.ok && page.ok) return (await probe(WEB_PORT, '/api/state')).ok;
    await sleep(500);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commandes
// ─────────────────────────────────────────────────────────────────────────────

async function install() {
  build();
  mkdirSync(dirname(LOG), { recursive: true });
  rotateLog();
  writeFileSync(PLIST, plist());
  await unload();
  const loaded = launchctl('bootstrap', DOMAIN, PLIST);
  if (loaded.status !== 0) fail(`launchctl bootstrap : ${loaded.stderr.trim()}`);
  await started(null);
  expose();
  await status();
}

async function update() {
  const previous = servicePid();
  if (previous == null) fail('Service non installé : npm run service -- install');
  build();
  rotateLog();
  launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`);
  await started(previous);
  expose();
  await status();
}

async function uninstall() {
  const tailscale = tailnet();
  if (!tailscale.error && serving()) tailscaleCli('serve', '--https=443', 'off');
  await unload();
  rmSync(PLIST, { force: true });
  console.log(`Service désinstallé. Journaux conservés : ${LOG}`);
}

/** `bootout` rend la main avant que launchd ait fini : on attend que le service ait disparu. */
async function unload() {
  if (servicePid() == null) return;
  launchctl('bootout', `${DOMAIN}/${LABEL}`);
  for (let i = 0; servicePid() != null && i < 100; i++) await sleep(200);
  if (servicePid() != null) fail("launchd n'a pas déchargé le service.");
}

async function status() {
  const job = launchctl('print', `${DOMAIN}/${LABEL}`);
  if (job.status !== 0) return console.log(`${LABEL} : non installé`);
  const field = (key) => new RegExp(`\\n\\s*${key} = ([^\\n]+)`).exec(job.stdout)?.[1];
  const pid = field('pid');
  console.log(`launchd   ${LABEL} : ${field('state')}, pid ${pid ?? '—'}, ${field('runs')} démarrage(s), dernier arrêt ${field('last exit code')}`);

  const [page, state, health] = [await probe(WEB_PORT, '/'), await probe(WEB_PORT, '/api/state'), await probe(API_PORT, '/health')];
  console.log(`site      http://127.0.0.1:${WEB_PORT}/ → ${page.status} en ${page.ms} ms ; /api/state → ${state.status} en ${state.ms} ms`);
  if (health.ok) {
    const { poll } = JSON.parse(health.body);
    const at = (iso) => new Date(iso).toLocaleString('sv-SE');
    const last = poll?.lastRunAt ? `dernière ${at(poll.lastRunAt)} (${poll.lastOutcome})` : 'aucune depuis le démarrage';
    console.log(`relève    ${poll?.enabled ? `${poll.running ? 'en cours' : `prochaine ${at(poll.nextRunAt)}`} ; ${last}` : 'désactivée'}`);
  }

  const power = spawnSync('/usr/bin/pmset', ['-g', 'ps'], { encoding: 'utf8' }).stdout.includes("'AC Power'") ? 'secteur' : 'batterie';
  const assertion = pid && spawnSync('/usr/bin/pgrep', ['-f', `caffeinate -s -w ${pid}`]).status === 0;
  console.log(`veille    ${assertion ? 'assertion caffeinate -s en place' : 'aucune assertion'} ; sur ${power}, ${power === 'secteur' ? 'le Mac reste éveillé' : 'il dort normalement'}`);

  const tailscale = tailnet();
  console.log(`https     ${tailscale.error ?? (serving() ? tailscale.url : `${tailscale.url} (Serve non configuré : npm run service -- install)`)}`);
  console.log(`journaux  ${LOG}`);
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * `next build` vide son dossier avant de compiler : une copie (clone APFS,
 * instantanée) laisse le service sur la version précédente si le build échoue.
 * Next réécrit aussi `next-env.d.ts` vers ce dossier ; le fichier est suivi par
 * git, il retrouve son contenu.
 */
function build() {
  const dist = join(WEB, DIST_DIR);
  const backup = `${dist}.prev`;
  const nextEnv = join(WEB, 'next-env.d.ts');
  const typings = readFileSync(nextEnv);

  rmSync(backup, { recursive: true, force: true });
  if (existsSync(dist)) execFileSync('/bin/cp', ['-cR', dist, backup]);
  const { status: code } = spawnSync(process.execPath, [NEXT, 'build'], {
    cwd: WEB,
    stdio: 'inherit',
    env: { ...process.env, NODE_ENV: 'production', CAIRN_WEB_DIST_DIR: DIST_DIR },
  });
  writeFileSync(nextEnv, typings);

  if (code !== 0) {
    if (existsSync(backup)) {
      rmSync(dist, { recursive: true, force: true });
      renameSync(backup, dist);
      fail('Build du site en échec : le service reste sur la version précédente.');
    }
    fail('Build du site en échec.');
  }
  rmSync(backup, { recursive: true, force: true });
}

/** launchd rouvre le journal à chaque démarrage : le renommer juste avant suffit à le faire tourner. */
function rotateLog() {
  try {
    if (statSync(LOG).size > 5_000_000) renameSync(LOG, `${LOG}.1`);
  } catch {
    // Pas encore de journal.
  }
}

function plist() {
  const string = (s) => `<string>${s.replaceAll('&', '&amp;').replaceAll('<', '&lt;')}</string>`;
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>${string(LABEL)}
  <key>ProgramArguments</key>
  <array>${string(process.execPath)}${string(SELF)}${string('run')}</array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>${string(`${dirname(process.execPath)}:/usr/bin:/bin:/usr/sbin:/sbin`)}
  </dict>
  <key>RunAtLoad</key><true/>
  <key>KeepAlive</key><true/>
  <key>ProcessType</key><string>Interactive</string>
  <key>StandardOutPath</key>${string(LOG)}
  <key>StandardErrorPath</key>${string(LOG)}
</dict>
</plist>
`;
}

function launchctl(...args) {
  return spawnSync('/bin/launchctl', args, { encoding: 'utf8' });
}

/** `null` : pas chargé ; `0` : chargé, sans processus. */
function servicePid() {
  const job = launchctl('print', `${DOMAIN}/${LABEL}`);
  if (job.status !== 0) return null;
  return Number(/\n\s*pid = (\d+)/.exec(job.stdout)?.[1] ?? 0);
}

/** Attend un processus neuf, puis des serveurs qui répondent. */
async function started(previous) {
  const deadline = Date.now() + 90_000;
  for (let pid = servicePid(); !pid || pid === previous; pid = servicePid()) {
    if (Date.now() > deadline) fail("launchd n'a pas démarré le service.", true);
    await sleep(200);
  }
  if (!(await waitReady(90_000))) fail('Le service tourne mais ne répond pas.', true);
}

function tailscaleCli(...args) {
  return spawnSync(TAILSCALE.find((p) => existsSync(p)) ?? 'tailscale', args, { encoding: 'utf8', timeout: 30_000 });
}

function tailnet() {
  const res = tailscaleCli('status', '--json');
  if (res.error) return { error: `Tailscale introuvable (${res.error.code})` };
  const state = JSON.parse(res.stdout || '{}');
  if (state.BackendState !== 'Running') {
    return { error: `Tailscale non connecté (${state.BackendState ?? res.stderr.trim()}) : connecte-toi depuis la barre de menus, puis npm run service -- install` };
  }
  return { url: `https://${state.Self.DNSName.replace(/\.$/, '')}` };
}

function serving() {
  return tailscaleCli('serve', 'status', '--json').stdout?.includes(`http://127.0.0.1:${WEB_PORT}`) ?? false;
}

function expose() {
  const tailscale = tailnet();
  if (tailscale.error) return console.log(`⚠ ${tailscale.error}`);
  const res = tailscaleCli('serve', '--bg', '--https=443', `http://127.0.0.1:${WEB_PORT}`);
  if (res.status !== 0) console.log(`⚠ tailscale serve : ${(res.stderr || res.stdout || String(res.error)).trim()}`);
}

function fail(message, withLog = false) {
  console.error(`✗ ${message}`);
  if (withLog && existsSync(LOG)) console.error(readFileSync(LOG, 'utf8').trimEnd().split('\n').slice(-25).join('\n'));
  process.exit(1);
}

const commands = { install, update, uninstall, status, run };
const command = commands[process.argv[2]];
if (!command) {
  console.error('usage : npm run service -- install | update | uninstall | status');
  process.exit(1);
}
await command();
