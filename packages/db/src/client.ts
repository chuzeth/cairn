import { createClient, type Client } from '@libsql/client';
import { drizzle, type LibSQLDatabase } from 'drizzle-orm/libsql';
import { gunzipSync, gzipSync } from 'node:zlib';
import { mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.js';

export type Database = LibSQLDatabase<typeof schema>;

let cached: { db: Database; client: Client } | null = null;

/**
 * Racine du dépôt, déduite de l'emplacement de ce fichier
 * (`<racine>/packages/db/src/client.ts`).
 *
 * Sans cet ancrage, un chemin `file:./data/…` désignerait un fichier différent
 * selon que l'API, le serveur MCP ou une migration est lancé depuis la racine
 * ou depuis son propre paquet — et l'application se retrouverait à écrire dans
 * plusieurs bases sans que rien ne le signale.
 */
export const REPO_ROOT = resolve(fileURLToPath(new URL('../../..', import.meta.url)));

/** URL de base de données, avec repli sur un fichier à la racine du dépôt. */
export function databaseUrl(): string {
  const raw = process.env.DATABASE_URL ?? 'file:./data/cairn.sqlite';
  if (!raw.startsWith('file:')) return raw;
  const path = raw.slice(5);
  return `file:${resolve(REPO_ROOT, path)}`;
}

/**
 * Connexion partagée. libsql fonctionne aussi bien en fichier local qu'en
 * remote (Turso) : la même application se déploie sans changement de code.
 */
export function getDb(): Database {
  if (cached) return cached.db;

  const url = databaseUrl();
  if (url.startsWith('file:')) {
    const path = resolve(url.slice(5));
    mkdirSync(dirname(path), { recursive: true });
  }

  const client = createClient({
    url,
    ...(process.env.DATABASE_AUTH_TOKEN ? { authToken: process.env.DATABASE_AUTH_TOKEN } : {}),
  });
  const db = drizzle(client, { schema });
  cached = { db, client };
  return db;
}

export function closeDb(): void {
  cached?.client.close();
  cached = null;
}

/**
 * Compression des flux. Une sortie de 3 h à 1 Hz pèse ~1,5 Mo en JSON et
 * ~90 ko une fois compressée : la différence décide de la viabilité d'un
 * historique de plusieurs années en SQLite.
 */
export function packStreams(value: unknown): Buffer {
  return gzipSync(Buffer.from(JSON.stringify(value), 'utf8'), { level: 6 });
}

export function unpackStreams<T>(payload: Buffer | Uint8Array | ArrayBuffer): T {
  const buf = Buffer.isBuffer(payload)
    ? payload
    : Buffer.from(payload instanceof ArrayBuffer ? new Uint8Array(payload) : payload);
  return JSON.parse(gunzipSync(buf).toString('utf8')) as T;
}

export { schema };
