import type { NextConfig } from 'next';

const config: NextConfig = {
  reactStrictMode: true,
  // Les paquets du monorepo sont consommés directement en TypeScript source.
  transpilePackages: ['@cairn/core'],
  typescript: { ignoreBuildErrors: false },
  // Next génère sinon des AGENTS.md / CLAUDE.md à chaque build : bruit inutile
  // dans un dépôt qui documente déjà son architecture.
  agentRules: false,
  env: {
    NEXT_PUBLIC_API_URL: process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000',
  },
};

export default config;
