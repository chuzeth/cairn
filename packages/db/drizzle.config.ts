import type { Config } from 'drizzle-kit';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Même ancrage que `client.ts` : le chemin ne doit pas dépendre du répertoire
// depuis lequel la commande est lancée.
const REPO_ROOT = resolve(fileURLToPath(new URL('../..', import.meta.url)));
const raw = process.env.DATABASE_URL ?? 'file:./data/cairn.sqlite';
const url = raw.startsWith('file:') ? `file:${resolve(REPO_ROOT, raw.slice(5))}` : raw;

export default {
  schema: './src/schema.ts',
  out: './migrations',
  dialect: 'turso',
  dbCredentials: {
    url,
    ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}),
  },
} satisfies Config;
