import { readFileSync } from 'node:fs';

/**
 * La version qui répond, et ce que le service a tenté après elle.
 *
 * Le service construit chaque instantané à partir d'un commit et démarre l'API
 * avec ce commit et la date de sa mise en service (`scripts/service.mjs`,
 * `run`). L'app compare le sien à celui-ci et se recharge s'ils diffèrent.
 * Hors service — `npm run dev` —, il n'y a pas de version : /health le dit par
 * `null` plutôt que d'en inventer une.
 */
export interface RunningVersion {
  /** Le commit court de l'instantané. */
  commit: string;
  /** Sa mise en service. */
  deployedAt: string | null;
}

export function runningVersion(env: NodeJS.ProcessEnv = process.env): RunningVersion | null {
  const commit = env.CAIRN_COMMIT?.trim();
  return commit ? { commit, deployedAt: env.CAIRN_DEPLOYED_AT || null } : null;
}

/**
 * La dernière mise à jour tentée. Un commit refusé ne doit pas se taire : sans
 * elle, l'app retarderait sur main et rien ne le dirait.
 */
export interface DeployAttempt {
  commit: string;
  /** `interrupted` : marquée en cours par un processus qui n'existe plus. */
  state: 'running' | 'refused' | 'deployed' | 'interrupted';
  /** L'étape qui a refusé : `npm test`, `npx tsc -b`, `next build`, `démarrage`. */
  step: string | null;
  at: string;
}

const STATES = new Set(['running', 'refused', 'deployed']);

export function lastDeploy(env: NodeJS.ProcessEnv = process.env): DeployAttempt | null {
  const file = env.CAIRN_DEPLOY_FILE;
  if (!file) return null;
  let raw: { short?: unknown; state?: unknown; step?: unknown; at?: unknown; pid?: unknown };
  try {
    raw = JSON.parse(readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
  if (typeof raw.short !== 'string' || typeof raw.at !== 'string' || !STATES.has(raw.state as string)) return null;
  const state = raw.state === 'running' && !alive(raw.pid) ? 'interrupted' : (raw.state as DeployAttempt['state']);
  return { commit: raw.short, state, step: typeof raw.step === 'string' ? raw.step : null, at: raw.at };
}

function alive(pid: unknown): boolean {
  if (typeof pid !== 'number' || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'EPERM';
  }
}
