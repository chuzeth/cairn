import { readFileSync } from 'node:fs';
import type { NextConfig } from 'next';

/**
 * L'API est servie sous l'origine du site, pas sous la sienne.
 *
 * Une adresse absolue dans le navigateur — `http://localhost:4000` — n'a de sens
 * que sur la machine qui fait tourner l'API : depuis le téléphone, « localhost »
 * désigne le téléphone. Next relaie donc `/api`, `/health` et `/auth` vers l'API,
 * et le navigateur n'appelle jamais qu'une seule origine : celle qui lui a servi
 * la page. Aucune adresse à configurer, et plus rien à autoriser côté CORS —
 * l'appel ne traverse plus d'origine.
 */
const apiOrigin = (): string =>
  process.env.CAIRN_API_ORIGIN ?? `http://127.0.0.1:${process.env.API_PORT ?? rootEnv('API_PORT') ?? 4000}`;

/**
 * `.env` est à la racine du dépôt, que Next ne lit pas : sans cette relecture,
 * un `API_PORT` changé casserait le relais en silence.
 */
function rootEnv(key: string): string | undefined {
  try {
    const line = readFileSync(new URL('../../.env', import.meta.url), 'utf8')
      .split('\n')
      .find((l) => l.trimStart().startsWith(`${key}=`));
    return line?.slice(line.indexOf('=') + 1).trim() || undefined;
  } catch {
    return undefined;
  }
}

/**
 * Le commit de cette construction.
 *
 * Le service construit le site dans un instantané tiré d'un commit, où il a
 * écrit `release.json` (`scripts/service.mjs`). Le commit est gravé dans la
 * page — dans le code, et dans `<meta name="cairn-commit">` que relit le
 * service worker : c'est lui que l'app compare à /health pour savoir si elle
 * est la version en service. Hors instantané — `npm run dev` —, pas de version,
 * et l'app ne se compare à rien.
 */
function builtCommit(): string {
  try {
    const release = JSON.parse(readFileSync(new URL('../../release.json', import.meta.url), 'utf8')) as { short?: string };
    return release.short ?? '';
  } catch {
    return '';
  }
}

const config: NextConfig = {
  reactStrictMode: true,
  env: { CAIRN_COMMIT: builtCommit() },
  // Les paquets du monorepo sont consommés directement en TypeScript source.
  transpilePackages: ['@cairn/core'],
  typescript: { ignoreBuildErrors: false },
  // Next génère sinon des AGENTS.md / CLAUDE.md à chaque build : bruit inutile
  // dans un dépôt qui documente déjà son architecture.
  agentRules: false,
  // La pastille de développement se pose en bas à gauche, exactement sur le
  // premier onglet de la barre du téléphone.
  devIndicators: false,
  async rewrites() {
    const api = apiOrigin();
    return [
      { source: '/api/:path*', destination: `${api}/api/:path*` },
      { source: '/health', destination: `${api}/health` },
      { source: '/auth/:path*', destination: `${api}/auth/:path*` },
    ];
  },
};

export default config;
