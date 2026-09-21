'use client';
import { useEffect, useSyncExternalStore } from 'react';

/**
 * L'app se vérifie elle-même.
 *
 * Une version, c'est un commit : le service construit chaque instantané à partir
 * d'un commit, le grave dans la page (`next.config.ts`) et le rend sur /health.
 * Le service worker sert la coquille depuis son cache avant tout réseau : après
 * un déploiement, la première ouverture montrerait la version précédente face à
 * une API nouvelle, en silence. À l'ouverture et à chaque retour au premier
 * plan, la page compare donc son commit à celui du Mac. S'ils diffèrent, elle
 * fait ranger la coquille neuve par le service worker, puis se recharge — une
 * fois, et seulement si rien n'a encore été touché : une saisie en cours passe
 * avant la version, qui attend alors l'ouverture suivante.
 */

/** Le commit de cette page ; `null` hors instantané (`npm run dev`), où rien ne se compare. */
export const BUILD: string | null = process.env.CAIRN_COMMIT || null;

/** Ce que /health dit de la version en service. */
export interface Served {
  commit: string;
  deployedAt: string | null;
}

/** La dernière mise à jour tentée par le service — miroir de `apps/api/src/release.ts`. */
export interface DeployAttempt {
  commit: string;
  state: 'running' | 'refused' | 'deployed' | 'interrupted';
  step: string | null;
  at: string;
}

export interface VersionState {
  status: 'checking' | 'current' | 'offline' | 'behind' | 'stuck' | 'unversioned' | 'dev';
  /** La version du Mac ; hors ligne, seulement si c'est celle de la page. */
  served: Served | null;
  deploy: DeployAttempt | null;
}

export type Verdict = 'dev' | 'offline' | 'unversioned' | 'current' | 'stuck' | 'typing' | 'touched' | 'reload';

/**
 * Ce que fait la page une fois la réponse du Mac connue.
 *
 * L'ordre est celui des garanties : jamais deux fois pour la même version,
 * jamais au milieu d'une saisie, jamais après un geste — une recharge sous le
 * doigt emporterait ce qu'il était en train de faire.
 */
export function decide(o: {
  build: string | null;
  served: string | null;
  offline: boolean;
  reloadedFor: string | null;
  typing: boolean;
  touched: boolean;
}): Verdict {
  if (!o.build) return 'dev';
  if (o.offline) return 'offline';
  if (!o.served) return 'unversioned';
  if (o.served === o.build) return 'current';
  if (o.reloadedFor === o.served) return 'stuck';
  if (o.typing) return 'typing';
  if (o.touched) return 'touched';
  return 'reload';
}

export interface VersionLine {
  text: string;
  warn: boolean;
}

/**
 * La version en une ligne — « à jour · f4c1e4a · 21 sept., 11 h 21 » —, puis ce
 * que le service a tenté après elle sans y parvenir. Hors ligne, la dernière
 * tentative connue date du dernier contact : elle ne se dit pas.
 */
export function describeVersion(v: VersionState, build: string | null, stamp: (iso: string) => string): VersionLine[] {
  if (!build) return [{ text: 'développement · dossier de travail', warn: false }];
  const line = (...parts: (string | null)[]) => parts.filter(Boolean).join(' · ');
  const date = v.served?.commit === build && v.served.deployedAt ? stamp(v.served.deployedAt) : null;
  const next = v.served?.commit ?? '?';
  const lines: VersionLine[] = [];
  switch (v.status) {
    case 'current': lines.push({ text: line('à jour', build, date), warn: false }); break;
    case 'offline': lines.push({ text: line('hors ligne', build, date), warn: false }); break;
    case 'behind': lines.push({ text: line('en retard', build, `${next} à la prochaine ouverture`), warn: true }); break;
    case 'stuck': lines.push({ text: line('en retard', build, `${next} ne se charge pas`), warn: true }); break;
    case 'unversioned': lines.push({ text: line(build, 'le Mac ne dit pas sa version'), warn: false }); break;
    default: lines.push({ text: line(build, 'vérification…'), warn: false });
  }
  const d = v.deploy;
  if (d && d.commit !== v.served?.commit && v.status !== 'offline') {
    if (d.state === 'refused') {
      lines.push({ text: line(`${d.commit} refusé`, `${d.step ?? 'vérification'} en échec`, stamp(d.at)), warn: true });
    } else if (d.state === 'running') {
      lines.push({ text: line(`${d.commit} en vérification`, stamp(d.at)), warn: false });
    } else if (d.state === 'interrupted') {
      lines.push({ text: line(`${d.commit} interrompu`, stamp(d.at)), warn: true });
    }
  }
  return lines;
}

// ── Ce que l'écran en sait ───────────────────────────────────────────────────

const INITIAL: VersionState = { status: BUILD ? 'checking' : 'dev', served: null, deploy: null };
let state = INITIAL;
const watchers = new Set<() => void>();

function publish(next: VersionState): void {
  state = next;
  for (const watcher of watchers) watcher();
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

export function useVersion(): VersionState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

// ── Toucher, saisir ──────────────────────────────────────────────────────────

/** Un doigt ou une touche depuis la dernière ouverture. */
let touched = false;
/** Les champs que l'athlète a remplis ; ceux qui ont quitté l'écran ne comptent plus. */
const filled = new Set<Element>();
/** Les saisies qu'un écran garde hors des champs, déclarées par {@link useUnsent}. */
const unsent = new Set<object>();

/**
 * Une saisie qu'un écran garde hors d'un champ : des réponses choisies, pas
 * encore envoyées. Un champ rempli se voit tout seul ; un bouton pressé, non —
 * il peut aussi bien avoir déjà envoyé sa réponse.
 */
export function useUnsent(active: boolean): void {
  useEffect(() => {
    if (!active) return;
    const token = {};
    unsent.add(token);
    return () => {
      unsent.delete(token);
    };
  }, [active]);
}

const NOT_TEXT = new Set(['button', 'submit', 'reset', 'checkbox', 'radio', 'range', 'color', 'file', 'hidden', 'image']);

/** Un champ où l'on écrit, ou choisit. */
function editable(el: Element): boolean {
  if (el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) return true;
  if (el instanceof HTMLInputElement) return !NOT_TEXT.has(el.type);
  return el instanceof HTMLElement && el.isContentEditable;
}

/** Un champ changé qui porte encore ce qu'on y a mis. */
function holds(el: Element): boolean {
  if (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) return true;
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) return el.value.trim() !== '';
  if (el instanceof HTMLSelectElement) return true;
  return (el.textContent ?? '').trim() !== '';
}

/** Un champ sous le doigt, un champ rempli encore à l'écran, ou une saisie déclarée. */
function typing(): boolean {
  if (unsent.size > 0) return true;
  const focused = document.activeElement;
  if (focused && editable(focused)) return true;
  for (const el of filled) {
    if (!el.isConnected) filled.delete(el);
    else if (holds(el)) return true;
  }
  return false;
}

// ── Se comparer au Mac ───────────────────────────────────────────────────────

/** La version pour laquelle la page s'est déjà rechargée : jamais deux fois. */
const RELOADED_FOR = 'cairn-reloaded-for';

function reloadedFor(): string | null {
  try {
    return sessionStorage.getItem(RELOADED_FOR);
  } catch {
    return null;
  }
}

/** Faux si la marque ne tient pas : sans elle, rien ne garantit une seule recharge, et il n'y en a aucune. */
function markReload(commit: string): boolean {
  try {
    sessionStorage.setItem(RELOADED_FOR, commit);
    return sessionStorage.getItem(RELOADED_FOR) === commit;
  } catch {
    return false;
  }
}

/**
 * Ce que le Mac sert. La requête passe par le service worker, réseau d'abord :
 * une réponse datée (`x-cairn-recorded-at`) sort de sa réserve, et veut dire
 * que le Mac n'a pas répondu.
 */
async function askMac(): Promise<{ served: Served | null; deploy: DeployAttempt | null; offline: boolean }> {
  try {
    const res = await fetch('/health', { cache: 'no-store', signal: AbortSignal.timeout(10_000) });
    if (!res.ok) return { served: null, deploy: null, offline: true };
    const health = (await res.json()) as { version?: Served | null; deploy?: DeployAttempt | null };
    return { served: health.version ?? null, deploy: health.deploy ?? null, offline: res.headers.has('x-cairn-recorded-at') };
  } catch {
    return { served: null, deploy: null, offline: true };
  }
}

const STATUS: Record<Verdict, VersionState['status']> = {
  dev: 'dev', offline: 'offline', unversioned: 'unversioned', current: 'current',
  stuck: 'stuck', typing: 'behind', touched: 'behind', reload: 'behind',
};

let checking = false;

/** Une ouverture : se comparer, se recharger s'il le faut et si on le peut, dire où on en est. */
async function check(): Promise<void> {
  if (!BUILD || checking) return;
  checking = true;
  try {
    const { served, deploy, offline } = await askMac();
    const verdict = decide({
      build: BUILD, served: served?.commit ?? null, offline, reloadedFor: reloadedFor(), typing: typing(), touched,
    });
    // Ranger la coquille prend un moment : un geste pendant ce temps l'emporte.
    if (verdict === 'reload' && served && (await prepare(served.commit)) && !touched && !typing() && markReload(served.commit)) {
      location.reload();
      return;
    }
    publish({
      status: STATUS[verdict],
      served: offline ? ([served, state.served].find((s) => s?.commit === BUILD) ?? null) : served,
      deploy: offline ? null : deploy,
    });
  } finally {
    checking = false;
  }
}

/**
 * Fait ranger la coquille neuve avant de recharger : sans cela, le service
 * worker resservirait l'ancienne et la recharge ne changerait rien.
 *
 * Si le commit apporte un nouveau worker, il prend la main d'abord : c'est lui
 * qui servira la page rechargée. Le worker range ensuite les écrans du matin et
 * leurs fragments, et ne répond oui que s'ils portent bien ce commit.
 */
async function prepare(commit: string): Promise<boolean> {
  if (!('serviceWorker' in navigator)) return true;
  const registration = await navigator.serviceWorker.getRegistration();
  // Aucun worker : la recharge ira au réseau, qui sert déjà la version neuve.
  if (!registration) return true;
  await registration.update().catch(() => undefined);
  const incoming = registration.installing ?? registration.waiting;
  if (incoming && !(await takeOver(incoming))) return false;
  const worker = navigator.serviceWorker.controller;
  if (!worker) return true;
  return request(worker, { type: 'renew-shell', commit });
}

/** Un worker neuf prend la main : installé d'abord, activé ensuite, à la demande de la page. */
async function takeOver(worker: ServiceWorker): Promise<boolean> {
  if (!(await settled(worker)) || worker.state === 'redundant') return false;
  if (navigator.serviceWorker.controller === worker) return true;
  const taken = new Promise<boolean>((resolve) => {
    const timer = setTimeout(() => resolve(false), 10_000);
    navigator.serviceWorker.addEventListener('controllerchange', () => {
      clearTimeout(timer);
      resolve(true);
    }, { once: true });
  });
  worker.postMessage({ type: 'skip-waiting' });
  return taken;
}

/** La fin de l'installation d'un worker, réussie ou non ; `false` au-delà du délai. */
function settled(worker: ServiceWorker, timeoutMs = 20_000): Promise<boolean> {
  return new Promise((resolve) => {
    if (worker.state !== 'installing') return resolve(true);
    const done = () => {
      if (worker.state === 'installing') return;
      clearTimeout(timer);
      worker.removeEventListener('statechange', done);
      resolve(true);
    };
    const timer = setTimeout(() => {
      worker.removeEventListener('statechange', done);
      resolve(false);
    }, timeoutMs);
    worker.addEventListener('statechange', done);
  });
}

/** Une demande au worker ; muet au-delà du délai, c'est non. */
function request(worker: ServiceWorker, message: unknown, timeoutMs = 30_000): Promise<boolean> {
  return new Promise((resolve) => {
    const channel = new MessageChannel();
    const timer = setTimeout(() => resolve(false), timeoutMs);
    channel.port1.onmessage = (event) => {
      clearTimeout(timer);
      resolve((event.data as { ok?: unknown } | null)?.ok === true);
    };
    worker.postMessage(message, [channel.port2]);
  });
}

let started = false;

/**
 * À l'ouverture, puis à chaque retour au premier plan. Un geste pendant une
 * ouverture la rend intouchable jusqu'à la suivante.
 */
export function watchVersion(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  const touch = () => {
    touched = true;
  };
  const options = { capture: true, passive: true };
  document.addEventListener('pointerdown', touch, options);
  document.addEventListener('keydown', touch, options);
  document.addEventListener('input', (event) => {
    touched = true;
    if (event.target instanceof Element) filled.add(event.target);
  }, options);
  const reopen = () => {
    touched = false;
    void check();
  };
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) reopen();
  });
  window.addEventListener('pageshow', (event) => {
    if (event.persisted) reopen();
  });
  void check();
}

/**
 * Une erreur de rendu, envoyée au Mac qui la journalise. Sans réseau elle se
 * perd : ce n'est pas une écriture de l'athlète, rien à mettre en file.
 */
export function reportError(error: Error & { digest?: string }, screen: string): void {
  void fetch('/api/errors', {
    method: 'POST',
    keepalive: true,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      screen, commit: BUILD, message: error.message, digest: error.digest, stack: error.stack?.slice(0, 8000),
    }),
  }).catch(() => undefined);
}
