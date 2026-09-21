/**
 * `npm run garmin -- <commande>` : la liaison Garmin depuis le Terminal.
 *
 *   login    connexion — e-mail, mot de passe, code MFA si Garmin l'exige ; seuls les jetons sont gardés
 *   status   état de la liaison, de la montre et des séances des sept jours, sans appeler Garmin
 *   test     aller-retour sur une séance jetable « Cairn — test de liaison », calendrier intact
 *   preview  ce que le réconciliateur ferait maintenant, sans rien écrire chez Garmin
 *   logout   oublie les jetons de ce Mac
 *
 * La connexion est la seule commande qui voit un identifiant, et elle ne le
 * voit pas : le terminal le passe directement à python-garminconnect.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { closeDb, getGarminSync, hasGarminTables, listGarminWorkouts, listPlannedSessions } from '@cairn/db';
import {
  GarminConnect, PROBE_NAME, SessionFile, addDays, compareWorkouts, decodeWorkout, describeWorkout,
  encodeWorkout, garminView, monthsOf, planReconciliation, probeWorkout, HORIZON_DAYS, type CalendarWorkout,
} from '@cairn/garmin';
import { env } from './env.js';
import { loadDesired, localToday } from './garmin.js';

const A = env.athleteId;
const LOGIN_SCRIPT = fileURLToPath(new URL('../../../packages/garmin/login.py', import.meta.url));

const fr = (iso: string) =>
  new Date(iso).toLocaleString('fr-FR', { day: '2-digit', month: '2-digit', hour: '2-digit', minute: '2-digit' });
const day = (date: string) =>
  new Date(`${date}T12:00:00`).toLocaleDateString('fr-FR', { weekday: 'short', day: '2-digit', month: '2-digit' });

async function main(): Promise<number> {
  const [command] = process.argv.slice(2);
  const session = new SessionFile();
  switch (command) {
    case 'login':
      return login(session);
    case 'status':
      return status(session);
    case 'test':
      return probe(session);
    case 'preview':
      return preview(session);
    case 'logout':
      session.remove();
      console.log(`Jetons Garmin effacés de ce Mac (${session.path}).`);
      return 0;
    default:
      console.log(`Commandes :
  npm run garmin -- login     connexion à Garmin Connect (e-mail, mot de passe, code MFA si demandé)
  npm run garmin -- status    état de la liaison et des séances des sept jours
  npm run garmin -- test      aller-retour sur la séance jetable « ${PROBE_NAME} »
  npm run garmin -- preview   ce que le réconciliateur ferait maintenant, sans rien écrire
  npm run garmin -- logout    oublie les jetons de ce Mac`);
      return command ? 64 : 0;
  }
}

// ─────────────────────────────────────────────────────────────────────────────

/**
 * `uv` exécute le script de connexion avec la version de Python et de
 * python-garminconnect qu'il déclare, sans rien installer ailleurs que dans son
 * propre cache.
 */
function findUv(): string | null {
  const candidates = [
    ...(process.env.PATH ?? '').split(delimiter).map((d) => join(d, 'uv')),
    join(homedir(), '.local/bin/uv'),
    join(homedir(), '.cargo/bin/uv'),
    '/opt/homebrew/bin/uv',
  ];
  return candidates.find((p) => existsSync(p)) ?? null;
}

/**
 * Le processus Python ne reçoit que ce qu'il lui faut : pas les secrets de
 * `.env` — clef Anthropic, secret Strava — qu'une bibliothèque tierce n'a pas
 * à voir.
 */
function cleanEnv(): NodeJS.ProcessEnv {
  const keep = ['PATH', 'HOME', 'USER', 'LOGNAME', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TERM', 'TMPDIR', 'SSL_CERT_FILE'];
  return Object.fromEntries(
    Object.entries(process.env).filter(([k]) => keep.includes(k) || k.startsWith('UV_') || k.startsWith('XDG_')),
  );
}

async function login(session: SessionFile): Promise<number> {
  const uv = findUv();
  if (!uv) {
    console.log(`La connexion passe par python-garminconnect, que lance l'outil uv — absent de ce Mac.
Installe-le une fois (Astral, installateur officiel) :

  curl -LsSf https://astral.sh/uv/install.sh | sh

puis relance : npm run garmin -- login`);
    return 1;
  }
  console.log(`Connexion à Garmin Connect.
Ton mot de passe va directement à python-garminconnect, dans ce terminal : Cairn ne le voit pas
et il n'est écrit nulle part. Seuls les jetons de session sont gardés, dans
${session.path} (lisible par ton seul compte).
La première fois, uv télécharge Python et la bibliothèque : une vingtaine de secondes.
`);
  const r = spawnSync(uv, ['run', '--script', LOGIN_SCRIPT, session.path], { stdio: 'inherit', env: cleanEnv() });
  if (r.status !== 0) {
    console.log('\nConnexion non établie : aucun jeton n’a été écrit.');
    return r.status ?? 1;
  }
  const mode = (statSync(session.path).mode & 0o777).toString(8);
  // La preuve que la session sert : Cairn l'utilise elle-même, de ce Mac.
  const api = new GarminConnect(session);
  let name: string | null;
  try {
    name = await api.profileName();
  } catch (e) {
    console.log(
      `\nJetons enregistrés (${mode}, ${session.path}), mais Garmin refuse que Cairn s'en serve : ` +
        `${e instanceof Error ? e.message : String(e)}`,
    );
    return 1;
  }
  const watch = await api.watch().catch(() => null);
  console.log(`\nConnecté${name ? ` : ${name}` : ''}. Jetons en ${mode} dans ${session.path}.`);
  console.log(watch ? `Montre : ${watch.name}, synchronisée le ${fr(watch.syncedAt)}.` : 'Heure de synchronisation de la montre : non exposée.');
  return 0;
}

/**
 * Le registre, s'il existe. Les commandes de lecture ne créent rien : les
 * tables naissent au démarrage du service, qui seul écrit chez Garmin.
 */
async function readLedger() {
  if (!(await hasGarminTables())) return { ledger: [], sync: null };
  const [ledger, sync] = await Promise.all([listGarminWorkouts(A), getGarminSync(A)]);
  return { ledger, sync };
}

async function status(session: SessionFile): Promise<number> {
  const today = localToday();
  const sessions = await listPlannedSessions(A, today, addDays(today, HORIZON_DAYS - 1));
  const { ledger, sync } = await readLedger();
  const view = garminView({ today, sessions, ledger, sync, connected: session.exists() });
  const exp = session.exists() ? new GarminConnect(session).expiresAt() : null;
  console.log(`Session : ${session.exists() ? `${session.path}${exp ? ` · jeton d'accès valable jusqu'au ${fr(new Date(exp * 1000).toISOString())}` : ''}` : 'aucune — npm run garmin -- login'}`);
  console.log(`Liaison : ${view.overview.problem ?? (view.overview.connection === 'disconnected' ? 'jamais connectée' : 'en ordre')}`);
  if (sync?.lastRunAt) console.log(`Dernier passage : ${fr(sync.lastRunAt)} — ${sync.outcome} · ${sync.message ?? ''}`);
  if (view.overview.watch) console.log(`Montre : ${view.overview.watch.name}, synchronisée le ${fr(view.overview.watch.syncedAt)}`);
  console.log(`\nSéances du ${day(today)} au ${day(addDays(today, HORIZON_DAYS - 1))} :`);
  for (const s of sessions) {
    const g = view.bySession[s.id];
    if (!g && s.type === 'rest') continue;
    console.log(`  ${day(s.date)}  ${s.title}\n             ${g ? `${g.label}${g.detail ? ` — ${g.detail}` : ''}` : `(${s.status})`}`);
  }
  for (const s of view.overview.stale) console.log(`  ${day(s.date)}  ${s.name} — encore sur Garmin, à retirer`);
  return 0;
}

/**
 * L'aller-retour réel, sur une séance que personne n'exécutera.
 *
 * Créée, relue, comparée étape par étape, supprimée, et la suppression
 * vérifiée — la séance introuvable, et absente de la bibliothèque. Elle n'est
 * jamais planifiée : le calendrier est relu avant et après, et doit être
 * identique.
 */
async function probe(session: SessionFile): Promise<number> {
  const api = new GarminConnect(session);
  const today = localToday();
  const months = monthsOf(today, addDays(today, 30));
  const snapshot = async () => (await Promise.all(months.map((m) => api.calendarSnapshot(m.year, m.month)))).flat();

  // Un vrai renouvellement, pas le jeton du fichier : c'est le chemin que le
  // service prendra chaque jour, et il doit passer depuis ce Mac.
  const previous = api.expiresAt();
  await api.refresh({ force: true });
  const exp = api.expiresAt();
  console.log(
    `Session renouvelée auprès de Garmin : jeton valable jusqu'au ${exp ? fr(new Date(exp * 1000).toISOString()) : '?'}` +
      `${previous && exp && exp > previous ? '' : ' (échéance inchangée)'}.`,
  );
  const before = await snapshot();
  console.log(`Calendrier relu : ${before.length} élément(s) sur ${months.length} mois.`);

  const workout = probeWorkout();
  const id = await api.createWorkout(encodeWorkout(workout));
  console.log(`\nCréée : « ${workout.name} », n° ${id}.`);
  let failures = 0;
  try {
    const raw = await api.getWorkout(id);
    if (raw == null) {
      console.log('Relue : introuvable juste après sa création.');
      failures++;
    } else {
      if (process.argv.includes('--raw')) console.log(JSON.stringify(raw, null, 2));
      const read = decodeWorkout(raw);
      const diffs = compareWorkouts(workout, read);
      console.log(diffs.length === 0 ? 'Relue et comparée étape par étape : conforme.' : `Relue : ${diffs.length} écart(s).`);
      for (const d of diffs) console.log(`  ${d.text}`);
      failures += diffs.length;
      console.log(describeWorkout(read).map((l) => `  ${l}`).join('\n'));
    }
  } finally {
    await api.deleteWorkout(id);
    const gone = (await api.getWorkout(id)) === null;
    const listed = (await api.allWorkouts()).some((w) => w.workoutId === id);
    console.log(`\nSupprimée : ${gone && !listed ? 'vérifié — introuvable, et absente de la bibliothèque' : `NON VÉRIFIÉ (relue : ${gone ? 'absente' : 'présente'}, bibliothèque : ${listed ? 'présente' : 'absente'})`}.`);
    if (!gone || listed) failures++;
  }

  const after = await snapshot();
  const intact = before.length === after.length && before.every((x, i) => x === after[i]);
  console.log(`Calendrier : ${intact ? 'intact' : 'MODIFIÉ'} (${after.length} élément(s)).`);
  if (!intact) failures++;

  const watch = await api.watch().catch(() => null);
  console.log(watch ? `Montre : ${watch.name}, synchronisée le ${fr(watch.syncedAt)}.` : 'Heure de synchronisation de la montre : non exposée.');
  console.log(`\n${failures === 0 ? 'Liaison vérifiée.' : `${failures} problème(s).`} ${api.calls} appels à Garmin.`);
  return failures === 0 ? 0 : 1;
}

/** Ce que le réconciliateur ferait maintenant, et ce qu'il laisse intact — sans rien écrire chez Garmin. */
async function preview(session: SessionFile): Promise<number> {
  const api = new GarminConnect(session);
  const state = await loadDesired(A, localToday());
  const calendar: CalendarWorkout[] = [];
  for (const m of monthsOf(state.today, state.horizon)) calendar.push(...(await api.calendar(m.year, m.month)));
  const { ledger } = await readLedger();
  const ops = planReconciliation({ state, ledger, calendar });
  const ours = new Set(ledger.map((e) => e.workoutId));

  console.log(`État voulu, du ${day(state.today)} au ${day(state.horizon)} :`);
  for (const d of state.desired) console.log(`  ${day(d.date)}  ${d.workout.name}`);
  for (const u of state.unsent) console.log(`  ${day(u.date)}  non envoyée — ${u.reason}`);
  console.log('\nOpérations :');
  if (ops.every((o) => o.op === 'keep')) console.log('  aucune écriture');
  for (const o of ops) {
    if (o.op === 'create') console.log(`  créer     ${day(o.desired.date)}  ${o.desired.workout.name}`);
    if (o.op === 'keep') console.log(`  garder    ${day(o.desired.date)}  ${o.entry.name}${o.verify ? ' (à relire)' : ''}`);
    if (o.op === 'remove') console.log(`  retirer   ${day(o.entry.date)}  ${o.entry.name} — ${o.reason}`);
  }
  const theirs = calendar.filter((c) => c.workoutId == null || !ours.has(c.workoutId));
  if (theirs.length) {
    console.log('\nLaissées intactes (pas créées par Cairn) :');
    for (const c of theirs) console.log(`  ${day(c.date)}  ${c.title}`);
  }
  console.log(`\n${api.calls} appel(s) à Garmin, en lecture seule.`);
  return 0;
}

main()
  .then((code) => {
    closeDb();
    process.exit(code);
  })
  .catch((e) => {
    closeDb();
    console.error(e instanceof Error ? e.message : e);
    process.exit(1);
  });
