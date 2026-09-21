/**
 * Cairn installé comme une application : un LaunchAgent utilisateur démarre
 * l'API et le site en mode production à l'ouverture de session et les relance
 * s'ils tombent ; Tailscale Serve les expose en HTTPS au réseau privé, et à lui
 * seul — les deux serveurs n'écoutent que sur 127.0.0.1.
 *
 * Le service n'exécute que du code construit et vérifié, et ce code est un
 * commit. `install` et `update` extraient HEAD dans un instantané
 * (`.service.nosync/releases/<date>`) — jamais le dossier de travail, qu'ils
 * refusent tant qu'il n'est pas commité —, y passent `npm test` et `npx tsc -b`,
 * y construisent le site, puis basculent `.service.nosync/current` dessus.
 * launchd ne lance que `current` : un plantage, un réveil ou une ouverture de
 * session relancent le code vérifié, quoi que le dossier contienne entre-temps.
 * L'instantané porte son commit (`release.json`) : le site le grave dans la page,
 * l'API le rend sur /health, et l'app se recharge quand les deux diffèrent.
 *
 * Un commit sur main suffit : les crochets git lancent `follow`, qui met main en
 * service en arrière-plan, par les mêmes étapes et avec les mêmes garde-fous.
 * Chaque tentative laisse sa trace dans `deploy.json` — en cours, refusée,
 * faite —, que `status` affiche et que /health rend : un refus se lit jusque
 * sur le téléphone.
 *
 *   npm run service -- install     vérifie, construit, installe, démarre, expose, pose les crochets
 *   npm run service -- update      met HEAD en service sans attendre de commit, ou retente un refus
 *   npm run service -- uninstall   arrête, désinstalle, retire l'exposition, les crochets, les instantanés
 *   npm run service -- status      état launchd, version, dernière tentative, réponses, adresse HTTPS
 *
 * `run` est la commande que launchd exécute, depuis l'instantané ; `follow` celle
 * des crochets, qui détache `deploy`.
 */
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import {
  chmodSync, copyFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync,
  renameSync, rmSync, statSync, symlinkSync, writeFileSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseEnv } from 'node:util';

const SELF = fileURLToPath(import.meta.url);
/** Le code qui s'exécute : le dossier de travail pour les commandes, l'instantané pour `run`. */
const CODE = dirname(dirname(SELF));
/** Le dépôt, où vivent la base, `node_modules` et les instantanés (`<dépôt>/.service.nosync/releases/<date>`). */
const REPO = basename(dirname(CODE)) === 'releases' ? dirname(dirname(dirname(CODE))) : CODE;
/** `.nosync` : Documents est synchronisé par iCloud, les instantanés et leurs builds n'ont pas à y monter. */
const SERVICE = join(REPO, '.service.nosync');
const RELEASES = join(SERVICE, 'releases');
const CURRENT = join(SERVICE, 'current');
const LOCK = join(SERVICE, 'lock');
/** Ce que la surveillance a constaté : dernier contact, dernières reprises. */
const WATCH = join(SERVICE, 'watch.json');
/** La dernière mise à jour tentée — commit, issue, étape en cause —, lue par `status` et par /health. */
const DEPLOY = join(SERVICE, 'deploy.json');
const NEXT = join(REPO, 'node_modules/next/dist/bin/next');

/** La branche que le service suit, et les crochets par lesquels elle avance : commit, fusion, réécriture. */
const BRANCH = 'main';
const HOOKS = ['post-commit', 'post-merge', 'post-rewrite'];
/** Ce qui distingue nos crochets de ceux que d'autres auraient écrits, et qu'on ne remplace pas. */
const HOOK_MARK = 'cairn:service';

const LABEL = 'com.pchuze.cairn';
const DOMAIN = `gui/${process.getuid()}`;
const PLIST = join(homedir(), 'Library/LaunchAgents', `${LABEL}.plist`);
const LOG = join(homedir(), 'Library/Logs/Cairn/cairn.log');
/** Ce que les mises à jour d'arrière-plan écrivent : tests, typage, construction. */
const DEPLOY_LOG = join(homedir(), 'Library/Logs/Cairn/deploy.log');

/** Le service garde les ports documentés ; `npm run dev` prend 3001 et 4001. */
const WEB_PORT = 3000;
const API_PORT = Number(readEnv(CODE).API_PORT ?? 4000);
/** Tailscale standalone n'installe pas de commande dans le PATH : c'est le binaire de l'application. */
const TAILSCALE = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];
/** La maille de la surveillance : assez fine pour qu'un réveil se rattrape avant le matin. */
const WATCH_EVERY_MS = 5 * 60_000;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function readEnv(dir) {
  try {
    return parseEnv(readFileSync(join(dir, '.env'), 'utf8'));
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

  // La base appartient au dépôt, pas à l'instantané : `packages/db` résout un
  // chemin relatif depuis l'emplacement de son propre code, qui est ici la
  // copie — il y créerait une base vide à côté de la vraie, sans rien signaler.
  const raw = readEnv(CODE).DATABASE_URL ?? 'file:./data/cairn.sqlite';
  const database = raw.startsWith('file:') ? `file:${resolve(REPO, raw.slice(5))}` : raw;
  if (database.startsWith('file:') && !existsSync(database.slice(5))) {
    log('service', `base introuvable : ${database.slice(5)}`);
    process.exit(1);
  }

  // La version que /health rend, et le fichier où lire ce que le service a
  // tenté depuis. Le site, lui, porte déjà son commit : gravé à la construction.
  const version = readRelease(CODE);
  const env = {
    ...process.env,
    NODE_ENV: 'production',
    DATABASE_URL: database,
    CAIRN_DEPLOY_FILE: DEPLOY,
    ...(version?.short && { CAIRN_COMMIT: version.short }),
    ...(version?.deployedAt && { CAIRN_DEPLOYED_AT: version.deployedAt }),
  };
  const stdio = ['ignore', 'pipe', 'pipe'];
  const servers = {
    api: spawn(process.execPath, [`--env-file-if-exists=${join(CODE, '.env')}`, '--import', 'tsx', 'src/index.ts'], {
      cwd: join(CODE, 'apps/api'), env, stdio,
    }),
    web: spawn(process.execPath, [NEXT, 'start', '-p', String(WEB_PORT), '-H', '127.0.0.1'], {
      cwd: join(CODE, 'apps/web'), env, stdio,
    }),
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
    log('service', ok
      ? `prêt en ${((Date.now() - t0) / 1000).toFixed(1)} s, instantané ${basename(CODE)}`
      : 'ne répond toujours pas après 2 min'),
  );

  watch();
}

// ─────────────────────────────────────────────────────────────────────────────
// Surveillance du chemin du téléphone
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Les deux serveurs peuvent tourner, répondre sur 127.0.0.1, et Cairn rester
 * injoignable : le téléphone ne l'atteint que par Tailscale, dont le démon
 * s'arrête au réveil ou perd son `serve` sans que rien ne le signale — sinon
 * une erreur réseau sur le téléphone, au moment précis où on en a besoin.
 *
 * Toutes les cinq minutes : le démon tourne-t-il, et sert-il le site ? Sinon,
 * `tailscale up --accept-routes` puis réaffirmation de `tailscale serve`, et la
 * reprise est journalisée — c'est la trace qui dira, au bout d'un mois, si le
 * problème du 19 septembre était le sommeil du Mac ou autre chose.
 *
 * Le dernier passage où la chaîne tenait est écrit dans `watch.json` : c'est la
 * seule mesure qu'on ait de l'accessibilité réelle, et c'est elle que
 * `status` affiche.
 */
function watch() {
  const tick = () => {
    let seen;
    try {
      seen = inspect();
    } catch (e) {
      log('veille', `surveillance en échec : ${e.message}`);
      return;
    }
    const now = new Date().toISOString();
    const before = readWatch();
    writeWatch({
      lastCheckAt: now,
      lastContactAt: seen.reachable ? now : before.lastContactAt ?? null,
      lastRecoveryAt: seen.recovered ? now : before.lastRecoveryAt ?? null,
      recoveries: (before.recoveries ?? 0) + (seen.recovered ? 1 : 0),
    });
  };
  tick();
  // Sans `unref`, l'intervalle retiendrait le processus après l'arrêt des serveurs.
  setInterval(tick, WATCH_EVERY_MS).unref();
}

/**
 * Un passage : constate, répare, dit ce qu'il a fait.
 *
 * `spawnSync` bloque ici le processus de service — quelques dizaines de
 * millisecondes pour un `status`, quelques secondes pour un `up`. Les deux
 * serveurs sont des processus séparés : ils continuent de répondre pendant ce
 * temps, seul le journal attend.
 */
function inspect() {
  const state = backendState();
  if (state === null) {
    log('veille', 'tailscale introuvable : rien à relancer');
    return { reachable: false, recovered: false };
  }
  // « Starting » est un état de passage : le tick suivant tranchera.
  if (state === 'Starting') return { reachable: false, recovered: false };

  let recovered = false;

  if (state !== 'Running') {
    const up = tailscaleCli('up', '--accept-routes');
    if (up.status !== 0) {
      log('veille', `tailscale ${state} ; up : ${message(up)}`);
      return { reachable: false, recovered: false };
    }
    log('veille', `reprise : tailscale était ${state}, up --accept-routes a rendu la main`);
    recovered = true;
  }

  // `up` remet le démon en route, pas l'exposition : un `serve` perdu rend le
  // site aussi injoignable qu'un démon arrêté.
  if (!serving()) {
    const res = tailscaleCli('serve', '--bg', '--https=443', `http://127.0.0.1:${WEB_PORT}`);
    if (res.status !== 0) {
      log('veille', `tailscale serve : ${message(res)}`);
      return { reachable: false, recovered };
    }
    log('veille', `reprise : serve réaffirmé, https://…:443 → 127.0.0.1:${WEB_PORT}`);
    recovered = true;
  }

  return { reachable: true, recovered };
}

/** L'état du démon ; `null` quand Tailscale ne répond pas du tout. */
function backendState() {
  const res = tailscaleCli('status', '--json');
  if (res.error) return null;
  try {
    return JSON.parse(res.stdout || '{}').BackendState ?? null;
  } catch {
    return null;
  }
}

const message = (res) => (res.stderr || res.stdout || String(res.error ?? '')).trim();

/** « il y a 4 min », « il y a 37 h » : c'est l'écart qui se lit, pas l'horodatage. */
function ago(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60_000));
  if (minutes < 1) return 'à l\'instant';
  if (minutes < 60) return `il y a ${minutes} min`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `il y a ${hours} h` : `il y a ${Math.round(hours / 24)} jours`;
}

function readWatch() {
  try {
    return JSON.parse(readFileSync(WATCH, 'utf8'));
  } catch {
    return {};
  }
}

function writeWatch(next) {
  try {
    mkdirSync(dirname(WATCH), { recursive: true });
    writeFileSync(WATCH, `${JSON.stringify(next, null, 2)}\n`);
  } catch (e) {
    log('veille', `surveillance non enregistrée : ${e.message}`);
  }
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
 * Prêt quand l'état du jour traverse le relais du site jusqu'à l'API — ce qui
 * chauffe au passage le chemin qu'ouvre le téléphone. `/` ne prouve rien : un
 * `next dev` d'un autre projet peut écouter sur le port 3000 de toutes les
 * interfaces et répondre à la place d'un site pas encore démarré. L'API est
 * interrogée directement d'abord : par le relais, son absence au démarrage
 * remplirait le journal d'erreurs de connexion.
 */
async function waitReady(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probe(API_PORT, '/health')).ok) {
      const state = await probe(WEB_PORT, '/api/state');
      if (state.ok && state.body.includes('"athlete"')) return true;
    }
    await sleep(500);
  }
  return false;
}

// ─────────────────────────────────────────────────────────────────────────────
// Commandes
// ─────────────────────────────────────────────────────────────────────────────

async function install() {
  const sha = committed();
  lock();
  const built = release(sha, 'manuel');
  mkdirSync(dirname(LOG), { recursive: true });
  mkdirSync(dirname(PLIST), { recursive: true });
  rotateLog(LOG);
  await unload();
  writeFileSync(PLIST, plist());
  await activate(built);
  hooks();
  expose();
  await status();
}

async function update() {
  if (servicePid() == null) fail('Service non installé : npm run service -- install');
  const sha = committed();
  lock();
  const built = release(sha, 'manuel');
  rotateLog(LOG);
  await activate(built);
  hooks();
  expose();
  await status();
}

/**
 * Ce que lancent les crochets git quand main avance : rend la main au commit
 * tout de suite, la mise à jour part en arrière-plan. Détachée, elle survit au
 * terminal ou à la session qui a commité ; sa sortie va dans `deploy.log`.
 */
function follow() {
  mkdirSync(dirname(DEPLOY_LOG), { recursive: true });
  rotateLog(DEPLOY_LOG);
  const out = openSync(DEPLOY_LOG, 'a');
  // Git passe au crochet son propre environnement — un index temporaire, entre
  // autres — qui ne vaut que le temps du commit : la mise à jour part sans lui.
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GIT_')));
  spawn(process.execPath, [SELF, 'deploy'], { cwd: REPO, env, detached: true, stdio: ['ignore', out, out] }).unref();
  console.log('Cairn : mise en service de main en arrière-plan — npm run service -- status');
}

/**
 * La mise à jour qu'un commit déclenche : main, vérifié et construit comme par
 * `update`. Le verrou s'attend au lieu de refuser — une rafale de commits met
 * chaque processus en file, et chacun, à son tour, ne construit que si main a
 * changé depuis ce qui tourne. Un commit déjà refusé ne se reconstruit pas à
 * chaque crochet : `update` le retente, sur demande.
 */
async function deploy() {
  console.log(`\n══ ${new Date().toLocaleString('sv-SE')} ${BRANCH} a avancé`);
  if (servicePid() == null) return console.log('Service non installé : rien à mettre en service.');
  if (!(await waitLock(30 * 60_000))) {
    return console.log('Le verrou est tenu depuis 30 min : abandon. npm run service -- update pour reprendre.');
  }
  const sha = git('rev-parse', '--verify', `refs/heads/${BRANCH}^{commit}`);
  const short = git('rev-parse', '--short=7', sha);
  if (readRelease(currentRelease())?.commit === sha) return console.log(`${short} est déjà en service.`);
  const last = readDeploy();
  if (last?.commit === sha && last.state === 'refused') {
    return console.log(`${short} a déjà été refusé (${last.step}) : npm run service -- update pour le retenter.`);
  }
  const built = release(sha, 'commit');
  rotateLog(LOG);
  await activate(built);
  expose();
  await status();
}

async function uninstall() {
  lock();
  if (!tailnet().error && serving()) tailscaleCli('serve', '--https=443', 'off');
  await unload();
  rmSync(PLIST, { force: true });
  for (const file of ourHooks()) rmSync(file, { force: true });
  rmSync(SERVICE, { recursive: true, force: true });
  console.log(`Service désinstallé. Journaux conservés : ${LOG}`);
}

async function status() {
  const job = launchctl('print', `${DOMAIN}/${LABEL}`);
  if (job.status !== 0) return console.log(`${LABEL} : non installé`);
  const field = (key) => new RegExp(`\\n\\s*${key} = ([^\\n]+)`).exec(job.stdout)?.[1];
  const pid = field('pid');
  const current = currentRelease();
  const version = readRelease(current);
  const at = (iso) => new Date(iso).toLocaleString('sv-SE');
  console.log(`launchd   ${LABEL} : ${field('state')}, pid ${pid ?? '—'}, ${field('runs')} démarrage(s), dernier arrêt ${field('last exit code')}`);
  const since = version?.deployedAt ? `, en service depuis le ${at(version.deployedAt)}` : '';
  console.log(`code      ${version ? `${version.short}${since}` : 'version inconnue'} (instantané ${current ? basename(current) : 'aucun'})`);
  console.log(`suivi     ${following(version)}`);

  const [page, state, health] = [await probe(WEB_PORT, '/'), await probe(WEB_PORT, '/api/state'), await probe(API_PORT, '/health')];
  console.log(`site      http://127.0.0.1:${WEB_PORT}/ → ${page.status} en ${page.ms} ms ; /api/state → ${state.status} en ${state.ms} ms`);
  if (health.ok) {
    const { poll } = JSON.parse(health.body);
    const last = poll?.lastRunAt ? `dernière ${at(poll.lastRunAt)} (${poll.lastOutcome})` : 'aucune depuis le démarrage';
    console.log(`relève    ${poll?.enabled ? `${poll.running ? 'en cours' : `prochaine ${at(poll.nextRunAt)}`} ; ${last}` : 'désactivée'}`);
  }

  const power = spawnSync('/usr/bin/pmset', ['-g', 'ps'], { encoding: 'utf8' }).stdout.includes("'AC Power'") ? 'secteur' : 'batterie';
  const assertion = pid && spawnSync('/usr/bin/pgrep', ['-f', `caffeinate -s -w ${pid}`]).status === 0;
  console.log(`veille    ${assertion ? 'assertion caffeinate -s en place' : 'aucune assertion'} ; sur ${power}, ${power === 'secteur' ? 'le Mac reste éveillé' : 'il dort normalement'}`);

  const tailscale = tailnet();
  console.log(`https     ${tailscale.error ?? (serving() ? tailscale.url : `${tailscale.url} (Serve non configuré : npm run service -- install)`)}`);

  // Ce que le téléphone aurait trouvé s'il avait ouvert Cairn : la dernière fois
  // que Tailscale tournait et servait le site. Un contact vieux de deux jours
  // dit ce qu'aucune autre ligne ne dit — l'application n'a pas existé.
  const seen = readWatch();
  const when = (iso) => new Date(iso).toLocaleString('sv-SE');
  const reprises = seen.recoveries
    ? ` ; ${seen.recoveries} reprise${seen.recoveries > 1 ? 's' : ''}, dernière ${when(seen.lastRecoveryAt)}`
    : '';
  console.log(`contact   ${seen.lastContactAt ? `${when(seen.lastContactAt)}, ${ago(seen.lastContactAt)}` : 'aucun enregistré (surveillance démarrée au prochain lancement)'}${reprises}`);

  console.log(`journaux  ${LOG} ; mises à jour ${DEPLOY_LOG}`);
}

/**
 * Où en est main par rapport à ce qui tourne, en une ligne : la dernière
 * tentative quand elle porte sur un autre commit, sinon l'écart, sinon rien.
 * Sans crochets, un commit n'atteint plus le téléphone : cela se dit aussi.
 */
function following(version) {
  const at = (iso) => new Date(iso).toLocaleString('sv-SE');
  const hooked = ourHooks().length === HOOKS.length ? '' : ' ; ⚠ crochets git absents : npm run service -- update';
  const last = readDeploy();
  if (last && last.commit !== version?.commit) {
    if (last.state === 'running' && alive(last.pid)) return `${last.short} en vérification depuis le ${at(last.at)}, voir ${DEPLOY_LOG}${hooked}`;
    if (last.state === 'running') return `${last.short} interrompu le ${at(last.at)} : npm run service -- update${hooked}`;
    if (last.state === 'refused') return `${last.short} refusé le ${at(last.at)}, ${last.step} en échec : voir ${DEPLOY_LOG}${hooked}`;
  }
  let main;
  try {
    main = git('rev-parse', '--verify', '--quiet', `refs/heads/${BRANCH}^{commit}`);
  } catch {
    return `pas de branche ${BRANCH}${hooked}`;
  }
  if (!version) return `${BRANCH} à ${main.slice(0, 7)}, version en service inconnue : npm run service -- update${hooked}`;
  if (main !== version.commit) return `${BRANCH} à ${main.slice(0, 7)}, pas en service : npm run service -- update${hooked}`;
  return `${BRANCH} en service${hooked || ' ; chaque commit y part de lui-même'}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Instantanés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le commit qu'`install` et `update` mettent en service : HEAD, et seulement si
 * le dossier de travail n'a rien d'autre. Construire HEAD par-dessus des
 * modifications non commitées laisserait croire qu'elles sont en service ; les
 * construire, elles, donnerait à la version un nom qui ne la désigne pas.
 */
function committed() {
  const dirty = git('status', '--porcelain').split('\n').filter(Boolean);
  if (dirty.length > 0) {
    const shown = dirty.slice(0, 8).map((line) => `  ${line}`).join('\n');
    const more = dirty.length > 8 ? `\n  … et ${dirty.length - 8} autres` : '';
    fail(`Arbre non commité — le service se construit à partir d'un commit :\n${shown}${more}\nCommite ou mets de côté, puis relance.`);
  }
  return git('rev-parse', '--verify', 'HEAD^{commit}');
}

/**
 * Un instantané : un commit, vérifié et construit sur place. Ce qui tourne
 * ensuite est exactement ce qui a été vérifié, et porte le nom de ce commit —
 * le dossier de travail peut changer pendant ce temps, rien n'en entre.
 *
 * La tentative est écrite avant de commencer et une fois tranchée : un refus
 * reste lisible, dans `status` comme dans l'app, jusqu'à ce qu'un autre commit
 * passe.
 */
function release(sha, trigger) {
  const short = git('rev-parse', '--short=7', sha);
  const dir = join(RELEASES, new Date().toLocaleString('sv-SE').replace(' ', '_').replaceAll(':', ''));
  const attempt = { commit: sha, short, trigger, pid: process.pid };
  writeDeploy({ ...attempt, state: 'running', at: new Date().toISOString() });

  const refuse = (step) => {
    rmSync(dir, { recursive: true, force: true });
    writeDeploy({ ...attempt, state: 'refused', step, at: new Date().toISOString() });
    const current = currentRelease();
    fail(`${short} refusé, ${step} en échec : rien n'est remplacé, le service reste sur ${current ? `l'instantané ${basename(current)}` : 'ce qui tourne'}.`);
  };

  try {
    extract(sha, dir);
    writeRelease(dir, { commit: sha, short, committedAt: git('show', '-s', '--format=%cI', sha) });
  } catch (e) {
    console.error(e.message);
    refuse('extraction');
  }
  const steps = [
    ['npm test', 'npm', ['test'], dir],
    ['npx tsc -b', 'npx', ['tsc', '-b'], dir],
    ['next build', process.execPath, [NEXT, 'build'], join(dir, 'apps/web')],
  ];
  for (const [label, command, args, cwd] of steps) {
    console.log(`\n── ${label} (${short}, ${dir})`);
    if (spawnSync(command, args, { cwd, stdio: 'inherit' }).status !== 0) refuse(label);
  }
  return { dir, attempt };
}

/**
 * Les fichiers du commit, et rien d'autre — plus `.env`, qui n'est pas du code
 * mais la configuration de cette machine. Sans le verrou npm, Next prend le
 * dépôt pour racine, là où sont les `node_modules` ; les paquets `@cairn/*`,
 * eux, se résolvent dans la copie et jamais dans le dépôt.
 */
function extract(sha, dir) {
  mkdirSync(dir, { recursive: true });
  const tar = execFileSync('git', ['archive', '--format=tar', sha], { cwd: REPO, maxBuffer: 1 << 30 });
  execFileSync('tar', ['-x', '-f', '-', '-C', dir], { input: tar });
  rmSync(join(dir, 'package-lock.json'), { force: true });
  if (existsSync(join(REPO, '.env'))) copyFileSync(join(REPO, '.env'), join(dir, '.env'));
  mkdirSync(join(dir, 'node_modules/@cairn'), { recursive: true });
  symlinkSync(join(REPO, 'node_modules/.bin'), join(dir, 'node_modules/.bin'));
  for (const pkg of readdirSync(join(dir, 'packages'))) {
    const { name } = JSON.parse(readFileSync(join(dir, 'packages', pkg, 'package.json'), 'utf8'));
    symlinkSync(join('../../packages', pkg), join(dir, 'node_modules', name));
  }
}

/**
 * Bascule `current` sur le nouvel instantané et redémarre. L'ancien reste en
 * place tant que le nouveau n'a pas répondu ; s'il ne répond pas, `current`
 * revient sur l'ancien et le service redémarre dessus. La date de mise en
 * service s'écrit juste avant la bascule : c'est elle que /health rend.
 */
async function activate({ dir, attempt }) {
  const previous = currentRelease();
  writeRelease(dir, { ...readRelease(dir), deployedAt: new Date().toISOString() });
  point(dir);
  if (!(await restart())) {
    writeDeploy({ ...attempt, state: 'refused', step: 'démarrage', at: new Date().toISOString() });
    if (!previous) {
      await unload();
      fail('Le nouvel instantané ne démarre pas.', true);
    }
    point(previous);
    const back = await restart();
    rmSync(dir, { recursive: true, force: true });
    fail(`Le nouvel instantané ne démarre pas : ${back ? 'retour' : 'échec du retour'} sur l'instantané ${basename(previous)}.`, true);
  }
  writeDeploy({ ...attempt, state: 'deployed', at: new Date().toISOString() });
  for (const name of readdirSync(RELEASES)) {
    if (join(RELEASES, name) !== dir) rmSync(join(RELEASES, name), { recursive: true, force: true });
  }
}

/** `rename` remplace le lien d'un seul coup : launchd ne lit jamais un `current` absent. */
function point(dir) {
  const next = `${CURRENT}.next`;
  rmSync(next, { force: true });
  symlinkSync(join('releases', basename(dir)), next);
  renameSync(next, CURRENT);
}

function currentRelease() {
  try {
    return realpathSync(CURRENT);
  } catch {
    return null;
  }
}

/** La version d'un instantané : son commit, et depuis quand il est en service. */
function readRelease(dir) {
  if (!dir) return null;
  try {
    return JSON.parse(readFileSync(join(dir, 'release.json'), 'utf8'));
  } catch {
    return null;
  }
}

function writeRelease(dir, version) {
  writeFileSync(join(dir, 'release.json'), `${JSON.stringify(version, null, 2)}\n`);
}

function readDeploy() {
  try {
    return JSON.parse(readFileSync(DEPLOY, 'utf8'));
  } catch {
    return null;
  }
}

/** Remplacé d'un coup : /health le relit à chaque ouverture de l'app, jamais à moitié écrit. */
function writeDeploy(attempt) {
  mkdirSync(dirname(DEPLOY), { recursive: true });
  writeFileSync(`${DEPLOY}.next`, `${JSON.stringify(attempt, null, 2)}\n`);
  renameSync(`${DEPLOY}.next`, DEPLOY);
}

/** git dans le dépôt, sans prendre le verrou d'index qu'une autre session tient peut-être. */
function git(...args) {
  return execFileSync('git', args, {
    cwd: REPO, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' },
  }).trimEnd();
}

/** Deux commandes simultanées se disputeraient `current`, launchd et les ports. */
function lock() {
  const holder = tryLock();
  if (holder) fail(`Une autre commande du service est en cours (pid ${holder}).`);
}

/** Le verrou attendu plutôt que refusé : une mise à jour déclenchée par un commit passe après la précédente. */
async function waitLock(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (tryLock()) {
    if (Date.now() > deadline) return false;
    await sleep(2000);
  }
  return true;
}

/**
 * Prend le verrou, ou rend le pid qui le tient. Le verrou d'un processus mort
 * se lève ; un verrou vide est en train de s'écrire, il compte comme tenu.
 */
function tryLock() {
  mkdirSync(dirname(LOCK), { recursive: true });
  for (;;) {
    try {
      writeFileSync(LOCK, String(process.pid), { flag: 'wx' });
      process.on('exit', unlock);
      return null;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let holder;
    try {
      holder = Number(readFileSync(LOCK, 'utf8'));
    } catch {
      continue; // Levé entre-temps.
    }
    if (!holder || alive(holder)) return holder || 'inconnu';
    rmSync(LOCK, { force: true });
  }
}

function unlock() {
  try {
    if (Number(readFileSync(LOCK, 'utf8')) === process.pid) rmSync(LOCK, { force: true });
  } catch {
    // Déjà levé.
  }
}

function alive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Crochets git
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Les crochets qui font suivre main au service. Écrits plutôt que versionnés :
 * comme le plist, ils portent le chemin de ce Node, et celui de l'instantané en
 * service — c'est son `service.mjs`, vérifié, qui déploie le commit suivant, et
 * non celui du dossier de travail, peut-être en cours d'édition. Un crochet que
 * Cairn n'a pas écrit reste en place, et on le dit.
 */
function hooks() {
  const quote = (s) => `'${s.replaceAll("'", "'\\''")}'`;
  const script = `#!/bin/sh
# ${HOOK_MARK} — écrit par npm run service -- install | update.
# Un commit sur ${BRANCH} part en service en arrière-plan : tests, typage et
# construction dans un instantané, rien de remplacé si l'un échoue. L'issue se lit
# dans npm run service -- status, et dans l'app.
[ "$(git symbolic-ref -q --short HEAD)" = ${BRANCH} ] || exit 0
exec ${quote(process.execPath)} ${quote(join(CURRENT, 'scripts/service.mjs'))} follow
`;
  const dir = hooksDir();
  mkdirSync(dir, { recursive: true });
  for (const name of HOOKS) {
    const file = join(dir, name);
    if (existsSync(file) && !readFileSync(file, 'utf8').includes(HOOK_MARK)) {
      console.log(`⚠ ${file} n'est pas de Cairn : laissé en place, ${name} ne mettra pas le service à jour.`);
      continue;
    }
    writeFileSync(file, script);
    chmodSync(file, 0o755);
  }
}

function ourHooks() {
  const dir = hooksDir();
  return HOOKS.map((name) => join(dir, name)).filter((file) => {
    try {
      return readFileSync(file, 'utf8').includes(HOOK_MARK);
    } catch {
      return false;
    }
  });
}

function hooksDir() {
  return resolve(REPO, git('rev-parse', '--git-path', 'hooks'));
}

// ─────────────────────────────────────────────────────────────────────────────
// launchd, journal, Tailscale
// ─────────────────────────────────────────────────────────────────────────────

/** Un journal se rouvre à chaque démarrage — par launchd, ou par `follow` : le renommer juste avant suffit à le faire tourner. */
function rotateLog(file) {
  try {
    if (statSync(file).size > 5_000_000) renameSync(file, `${file}.1`);
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
  <array>${string(process.execPath)}${string(join(CURRENT, 'scripts/service.mjs'))}${string('run')}</array>
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

/** (Re)démarre le job, puis attend un processus neuf qui réponde. */
async function restart() {
  const previous = servicePid();
  const res = previous == null
    ? launchctl('bootstrap', DOMAIN, PLIST)
    : launchctl('kickstart', '-k', `${DOMAIN}/${LABEL}`);
  if (res.status !== 0) fail(`launchctl : ${res.stderr.trim()}`);
  const deadline = Date.now() + 60_000;
  for (let pid = servicePid(); !pid || pid === previous; pid = servicePid()) {
    if (Date.now() > deadline) return false;
    await sleep(200);
  }
  return waitReady(60_000);
}

/** `bootout` rend la main avant que launchd ait fini : on attend que le service ait disparu. */
async function unload() {
  if (servicePid() == null) return;
  launchctl('bootout', `${DOMAIN}/${LABEL}`);
  for (let i = 0; servicePid() != null && i < 100; i++) await sleep(200);
  if (servicePid() != null) fail("launchd n'a pas déchargé le service.");
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

const commands = { install, update, uninstall, status, run, follow, deploy };
const command = commands[process.argv[2]];
if (!command) {
  console.error('usage : npm run service -- install | update | uninstall | status');
  process.exit(1);
}
await command();
