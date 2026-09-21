import {
  chmodSync, closeSync, constants, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync,
  writeSync,
} from 'node:fs';
import { randomBytes } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

/**
 * Les jetons de la session Garmin, et rien d'autre.
 *
 * Le mot de passe ne passe jamais par Cairn : `npm run garmin -- login` le
 * confie à python-garminconnect, qui n'en garde que ces trois valeurs. Elles
 * vivent hors du dépôt — donc hors de git, et hors de Documents que synchronise
 * iCloud —, dans un fichier lisible par le seul compte de Pierre (600, dossier
 * en 700), et ne s'écrivent dans aucun journal : aucun message d'erreur de ce
 * paquet ne les contient.
 */
export interface GarminTokens {
  di_token: string;
  di_refresh_token: string | null;
  di_client_id: string | null;
}

export function defaultSessionPath(): string {
  return process.env.CAIRN_GARMIN_SESSION ?? join(homedir(), 'Library/Application Support/Cairn/garmin/session.json');
}

export class SessionFile {
  constructor(readonly path: string = defaultSessionPath()) {}

  exists(): boolean {
    return existsSync(this.path);
  }

  /** Date de la dernière écriture, epoch ms — une reconnexion la fait avancer. */
  mtimeMs(): number | null {
    try {
      return statSync(this.path).mtimeMs;
    } catch {
      return null;
    }
  }

  /**
   * Lit les jetons, sans jamais suivre un lien symbolique, et remet le fichier
   * en 600 s'il a été élargi entre-temps. `null` quand il n'y a pas de session.
   */
  read(): GarminTokens | null {
    let fd: number;
    try {
      fd = openSync(this.path, constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
      throw new Error(`Session Garmin illisible (${(e as NodeJS.ErrnoException).code ?? 'erreur'}) : ${this.path}`);
    }
    let raw: string;
    try {
      raw = readFileSync(fd, 'utf8');
    } finally {
      closeSync(fd);
    }
    if ((statSync(this.path).mode & 0o077) !== 0) chmodSync(this.path, 0o600);
    let data: Record<string, unknown>;
    try {
      data = JSON.parse(raw) as Record<string, unknown>;
    } catch {
      throw new Error(`Session Garmin corrompue : ${this.path}`);
    }
    if (typeof data.di_token !== 'string' || !data.di_token) return null;
    return {
      di_token: data.di_token,
      di_refresh_token: typeof data.di_refresh_token === 'string' ? data.di_refresh_token : null,
      di_client_id: typeof data.di_client_id === 'string' ? data.di_client_id : null,
    };
  }

  /**
   * Écrit les jetons d'un seul coup : un fichier temporaire créé en 600 à côté
   * du vrai, puis renommé. Un lecteur concurrent — le service pendant que le
   * terminal renouvelle — ne voit jamais un fichier à moitié écrit.
   */
  write(tokens: GarminTokens): void {
    const dir = dirname(this.path);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    chmodSync(dir, 0o700);
    const tmp = join(dir, `.session.${randomBytes(6).toString('hex')}.tmp`);
    const fd = openSync(tmp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    try {
      writeSync(fd, JSON.stringify({
        di_token: tokens.di_token,
        di_refresh_token: tokens.di_refresh_token,
        di_client_id: tokens.di_client_id,
      }));
    } finally {
      closeSync(fd);
    }
    try {
      chmodSync(tmp, 0o600);
      renameSync(tmp, this.path);
    } catch (e) {
      rmSync(tmp, { force: true });
      throw e;
    }
  }

  remove(): void {
    rmSync(this.path, { force: true });
  }
}
