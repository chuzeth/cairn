import { DEFAULT_GARMIN_CHECK_MS } from './garmin.js';
import { DEFAULT_POLL_INTERVAL_MS } from './poller.js';

/** Configuration d'exécution, lue une fois et validée au démarrage. */
export const env = {
  port: Number(process.env.API_PORT ?? 4000),
  /**
   * La boucle locale seulement : l'API n'a aucune authentification, et sur un
   * wifi partagé n'importe qui lirait les données et écrirait dans le plan. Le
   * téléphone passe par Tailscale Serve, qui relaie vers le site, qui relaie ici.
   */
  host: process.env.API_HOST ?? '127.0.0.1',
  webOrigin: process.env.WEB_ORIGIN ?? 'http://localhost:3000',
  publicBaseUrl: process.env.PUBLIC_BASE_URL ?? `http://localhost:${process.env.API_PORT ?? 4000}`,
  webhookVerifyToken: process.env.STRAVA_WEBHOOK_VERIFY_TOKEN ?? 'cairn-verify-me',
  /** Athlète unique de cette instance — l'application est mono-utilisateur par conception. */
  athleteId: process.env.CAIRN_ATHLETE_ID ?? 'pierre',
  /** Cadence de la relève Strava, en millisecondes. `0` la désactive. */
  pollIntervalMs: pollIntervalMs(),
  /**
   * Relecture périodique du calendrier Garmin, en millisecondes. `0` coupe la
   * liaison Garmin de ce processus — c'est ce que fait `npm run dev`.
   */
  garminCheckMs: minutes('CAIRN_GARMIN_CHECK_MIN', DEFAULT_GARMIN_CHECK_MS),
};

/**
 * Cadence de la relève, en minutes, avec repli sur le quart d'heure — le
 * raisonnement sur le quota est dans `poller.ts`. Une valeur illisible vaut
 * absence de valeur : mieux vaut la cadence par défaut qu'une relève muette.
 */
function pollIntervalMs(): number {
  return minutes('CAIRN_POLL_INTERVAL_MIN', DEFAULT_POLL_INTERVAL_MS);
}

function minutes(name: string, fallbackMs: number): number {
  const raw = process.env[name];
  if (raw == null || raw.trim() === '') return fallbackMs;
  const value = Number(raw);
  if (!Number.isFinite(value) || value < 0) return fallbackMs;
  return Math.round(value * 60_000);
}

/**
 * Une variable laissée à sa valeur d'exemple est *plus* trompeuse qu'une variable
 * absente : l'application se déclare configurée et échoue au premier appel réel.
 * On traite donc les gabarits de `.env.example` comme non renseignés.
 */
const PLACEHOLDERS = [/^sk-ant-\.\.\.$/, /^\s*$/, /^x{3,}$/i, /^<.*>$/, /^changeme$/i, /^your[-_]/i];

const isSet = (value: string | undefined): boolean =>
  value != null && !PLACEHOLDERS.some((p) => p.test(value.trim()));

/**
 * Ce sans quoi l'import Strava — donc tout le système — ne peut pas fonctionner.
 *
 * `ANTHROPIC_API_KEY` n'y figure pas : elle n'ouvre que le chat intégré et les
 * analyses rédigées, et elle est facturée à l'usage. Tous les calculs sont
 * déterministes et tournent sans elle ; le coach reste accessible par le serveur
 * MCP, où le modèle est fourni par le client. Une clé absente n'est donc pas une
 * configuration incomplète, c'est un choix.
 */
export function missingConfig(): string[] {
  const missing: string[] = [];
  if (!isSet(process.env.STRAVA_CLIENT_ID)) missing.push('STRAVA_CLIENT_ID');
  if (!isSet(process.env.STRAVA_CLIENT_SECRET)) missing.push('STRAVA_CLIENT_SECRET');
  return missing;
}
