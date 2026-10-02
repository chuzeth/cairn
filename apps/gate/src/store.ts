import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Ce que la porte retient : les clés d'accès de Pierre, les sessions ouvertes,
 * le code d'enregistrement en cours.
 *
 * Une base à part de `cairn.sqlite` : elle n'a rien à voir avec l'entraînement,
 * `npm run service -- passkey | logout-all` l'ouvre sans passer par l'API, et
 * la perdre ne coûte qu'un nouveau Face ID. Rien n'y est gardé en clair qui
 * ouvrirait la porte : un jeton de session ou un code ne s'y trouvent que
 * hachés — une copie de la base ne donne accès à rien.
 */

/**
 * Face ID à chaque ouverture de l'app (Pierre, le 02/10). Une session se ferme
 * après deux minutes sans une requête : l'app ouverte en envoie une toutes les
 * trente secondes, l'app refermée n'en envoie plus, et la rouvrir redemande
 * Face ID. Elle durait 90 jours : Face ID une fois, au premier jour, puis plus
 * jamais.
 */
export const SESSION_IDLE_MS = 2 * 60_000;
/** Au-delà, même servie sans arrêt, une session se referme. */
export const SESSION_TTL_MS = 12 * 3600_000;
/** En deçà, une requête ne réécrit pas l'heure de la dernière : la base n'écrit pas à chaque fragment. */
const TOUCH_EVERY_MS = 5_000;
/** Le code affiché dans le Terminal du Mac. */
export const CODE_TTL_MS = 10 * 60_000;
/** Au-delà, le code est brûlé : il faut en redemander un au Mac. */
export const CODE_MAX_ATTEMPTS = 5;
/** Sans 0/O ni 1/I/L : il se recopie d'un écran à l'autre sans ambiguïté. */
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ';
const CODE_LENGTH = 8;

export interface Passkey {
  id: string;
  publicKey: Uint8Array<ArrayBuffer>;
  counter: number;
  transports: string[];
}

export type CodeCheck = 'ok' | 'wrong' | 'none';

const sha256 = (s: string): string => createHash('sha256').update(s).digest('hex');

/** « abcd efgh », « ABCD-EFGH » : c'est le même code. */
export const normalizeCode = (raw: string): string => raw.toUpperCase().replace(/[^0-9A-Z]/g, '');

export class GateStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 2000;
      CREATE TABLE IF NOT EXISTS passkeys (
        id TEXT PRIMARY KEY,
        public_key BLOB NOT NULL,
        counter INTEGER NOT NULL,
        transports TEXT NOT NULL,
        created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        passkey_id TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS registration_codes (
        code_hash TEXT PRIMARY KEY,
        expires_at INTEGER NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
    `);
    // La dernière requête de chaque session. Une base d'avant n'en a pas : ses
    // sessions valent zéro, donc sont closes — la prochaine ouverture redemande
    // Face ID, ce qui est la règle.
    const columns = this.db.prepare('PRAGMA table_info(sessions)').all() as { name: string }[];
    if (!columns.some((c) => c.name === 'seen_at')) {
      this.db.exec('ALTER TABLE sessions ADD COLUMN seen_at INTEGER NOT NULL DEFAULT 0');
    }
  }

  close(): void {
    this.db.close();
  }

  // ── Clés d'accès ───────────────────────────────────────────────────────────

  passkeys(): Passkey[] {
    const rows = this.db.prepare('SELECT id, public_key, counter, transports FROM passkeys').all() as {
      id: string; public_key: Uint8Array; counter: number; transports: string;
    }[];
    return rows.map((r) => ({
      id: r.id, publicKey: new Uint8Array(r.public_key), counter: r.counter, transports: JSON.parse(r.transports) as string[],
    }));
  }

  passkey(id: string): Passkey | null {
    return this.passkeys().find((p) => p.id === id) ?? null;
  }

  addPasskey(p: Passkey, now: number): void {
    this.db.prepare('INSERT INTO passkeys (id, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(p.id, p.publicKey, p.counter, JSON.stringify(p.transports), now);
  }

  setCounter(id: string, counter: number): void {
    this.db.prepare('UPDATE passkeys SET counter = ? WHERE id = ?').run(counter, id);
  }

  // ── Sessions ───────────────────────────────────────────────────────────────

  /** Le jeton, rendu une seule fois : seul son haché est gardé. Chaque Face ID en ouvre une. */
  openSession(passkeyId: string, now: number): { token: string; expiresAt: number } {
    const token = randomBytes(32).toString('base64url');
    const expiresAt = now + SESSION_TTL_MS;
    this.db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR seen_at <= ?').run(now, now - SESSION_IDLE_MS);
    this.db.prepare('INSERT INTO sessions (token_hash, passkey_id, created_at, expires_at, seen_at) VALUES (?, ?, ?, ?, ?)')
      .run(sha256(token), passkeyId, now, expiresAt, now);
    return { token, expiresAt };
  }

  /**
   * Une session ouverte, lue sans la toucher : depuis quand Face ID a eu lieu,
   * depuis quand elle a servi. `null` : inconnue, expirée, restée deux minutes
   * sans requête, ou sa clé d'accès n'existe plus.
   */
  sessionInfo(token: string | undefined, now: number): { verifiedAt: number; seenAt: number } | null {
    if (!token) return null;
    const row = this.db.prepare(
      'SELECT s.created_at, s.expires_at, s.seen_at FROM sessions s JOIN passkeys p ON p.id = s.passkey_id ' +
        'WHERE s.token_hash = ?',
    ).get(sha256(token)) as { created_at: number; expires_at: number; seen_at: number } | undefined;
    if (!row || row.expires_at <= now || row.seen_at <= now - SESSION_IDLE_MS) return null;
    return { verifiedAt: row.created_at, seenAt: row.seen_at };
  }

  /** Valide, et repoussée : la requête qui la présente la garde ouverte deux minutes de plus. */
  validSession(token: string | undefined, now: number): boolean {
    const info = this.sessionInfo(token, now);
    if (!info) return false;
    if (now - info.seenAt >= TOUCH_EVERY_MS) {
      this.db.prepare('UPDATE sessions SET seen_at = ? WHERE token_hash = ?').run(now, sha256(token!));
    }
    return true;
  }

  closeSession(token: string): void {
    this.db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(sha256(token));
  }

  /** `npm run service -- logout-all` : tous les appareils redemandent Face ID. */
  closeAllSessions(): number {
    return Number(this.db.prepare('DELETE FROM sessions').run().changes);
  }

  /** Les sessions qui servent encore : ni expirées, ni restées deux minutes sans requête. */
  sessionCount(now: number): number {
    return (this.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE expires_at > ? AND seen_at > ?')
      .get(now, now - SESSION_IDLE_MS) as { n: number }).n;
  }

  // ── Code d'enregistrement ──────────────────────────────────────────────────

  /** Un nouveau code remplace le précédent : il n'y en a jamais qu'un valable. */
  issueCode(now: number): { code: string; expiresAt: number } {
    let code = '';
    for (let i = 0; i < CODE_LENGTH; i++) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
    const expiresAt = now + CODE_TTL_MS;
    this.db.exec('DELETE FROM registration_codes');
    this.db.prepare('INSERT INTO registration_codes (code_hash, expires_at) VALUES (?, ?)').run(sha256(code), expiresAt);
    return { code, expiresAt };
  }

  /**
   * Un essai contre le code en cours. Chaque erreur compte ; à la cinquième, le
   * code est brûlé. Le code n'est pas consommé ici — seulement à la fin d'un
   * enregistrement réussi (`consumeCode`) : une cérémonie abandonnée ne le perd pas.
   */
  checkCode(raw: string, now: number): CodeCheck {
    this.db.prepare('DELETE FROM registration_codes WHERE expires_at <= ? OR attempts >= ?').run(now, CODE_MAX_ATTEMPTS);
    const row = this.db.prepare('SELECT code_hash FROM registration_codes').get() as { code_hash: string } | undefined;
    if (!row) return 'none';
    const given = Buffer.from(sha256(normalizeCode(raw)), 'hex');
    if (timingSafeEqual(given, Buffer.from(row.code_hash, 'hex'))) return 'ok';
    this.db.prepare('UPDATE registration_codes SET attempts = attempts + 1').run();
    return 'wrong';
  }

  /** Rend vrai si le code était encore valable, et le détruit. */
  consumeCode(raw: string, now: number): boolean {
    const res = this.db.prepare('DELETE FROM registration_codes WHERE code_hash = ? AND expires_at > ? AND attempts < ?')
      .run(sha256(normalizeCode(raw)), now, CODE_MAX_ATTEMPTS);
    return Number(res.changes) === 1;
  }
}
