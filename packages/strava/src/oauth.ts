import type { StravaTokenResponse } from './types.js';

/**
 * OAuth Strava.
 *
 * Les portées demandées sont volontairement explicites :
 *  · `activity:read_all` — indispensable pour lire aussi les sorties privées ;
 *  · `profile:read_all`  — donne le poids et les zones cardiaques déclarées.
 * Aucune portée d'écriture n'est demandée : Cairn ne modifie jamais Strava.
 */
export const STRAVA_SCOPES = 'read,activity:read_all,profile:read_all';

export interface StravaOAuthConfig {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
}

export function readOAuthConfig(): StravaOAuthConfig {
  const clientId = process.env.STRAVA_CLIENT_ID;
  const clientSecret = process.env.STRAVA_CLIENT_SECRET;
  const redirectUri = process.env.STRAVA_REDIRECT_URI ?? 'http://localhost:4000/auth/strava/callback';
  if (!clientId || !clientSecret) {
    throw new Error(
      'STRAVA_CLIENT_ID et STRAVA_CLIENT_SECRET sont requis. ' +
        'Crée une application sur https://www.strava.com/settings/api puis renseigne le fichier .env.',
    );
  }
  return { clientId, clientSecret, redirectUri };
}

/** URL d'autorisation à ouvrir dans le navigateur. */
export function authorizeUrl(config: StravaOAuthConfig, state?: string): string {
  const params = new URLSearchParams({
    client_id: config.clientId,
    redirect_uri: config.redirectUri,
    response_type: 'code',
    approval_prompt: 'auto',
    scope: STRAVA_SCOPES,
  });
  if (state) params.set('state', state);
  return `https://www.strava.com/oauth/authorize?${params.toString()}`;
}

/** Échange le code d'autorisation contre un couple de jetons. */
export async function exchangeCode(
  config: StravaOAuthConfig,
  code: string,
): Promise<StravaTokenResponse> {
  return tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code,
    grant_type: 'authorization_code',
  });
}

/** Renouvelle le jeton d'accès à partir du jeton de rafraîchissement. */
export async function refreshAccessToken(
  config: StravaOAuthConfig,
  refreshToken: string,
): Promise<StravaTokenResponse> {
  return tokenRequest({
    client_id: config.clientId,
    client_secret: config.clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  });
}

async function tokenRequest(body: Record<string, string>): Promise<StravaTokenResponse> {
  const res = await fetch('https://www.strava.com/oauth/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams(body).toString(),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`Échec de l'échange de jeton Strava (${res.status}) : ${text.slice(0, 300)}`);
  }
  return (await res.json()) as StravaTokenResponse;
}
