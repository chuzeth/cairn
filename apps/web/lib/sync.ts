'use client';
import { useSyncExternalStore } from 'react';
import { flush } from './offline';

/**
 * Où en est le téléphone par rapport au Mac — la réponse à « est-ce que ce que
 * je lis est à jour ? », sans avoir à ouvrir l'ordinateur pour le vérifier.
 *
 * Le 10/11, Pierre : « j'ai toujours un doute sur l'état de la synchronisation ».
 * Deux choses seulement comptent, et elles se disent en une ligne : le Mac
 * répond-il en ce moment (`live`), et de quand date la dernière fois où le
 * téléphone a tout relu (`syncedAt`). La première vient du pouls (`lib/live.ts`),
 * la seconde du service worker, qui synchronise à l'ouverture, au retour au
 * premier plan, et à chaque notification du Mac — app fermée comprise.
 */

export interface SyncState {
  /** Le Mac répond-il ? `null` tant qu'on ne le sait pas. */
  live: boolean | null;
  /** La dernière synchronisation complète, ISO ; `null` si aucune n'est connue. */
  syncedAt: string | null;
}

const INITIAL: SyncState = { live: null, syncedAt: null };
let state = INITIAL;
const watchers = new Set<() => void>();

function publish(next: Partial<SyncState>): void {
  const merged = { ...state, ...next };
  if (merged.live === state.live && merged.syncedAt === state.syncedAt) return;
  state = merged;
  for (const watcher of watchers) watcher();
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

export function useSync(): SyncState {
  return useSyncExternalStore(subscribe, () => state, () => INITIAL);
}

/** Ce que le pouls vient d'apprendre : le Mac a répondu, ou non. */
export function noteContact(ok: boolean): void {
  publish({ live: ok });
  // Le Mac revient : le téléphone en profite pour tout envoyer et tout relire.
  if (ok) void requestSync();
}

/** La date que le service worker garde de sa dernière synchronisation. */
async function readSyncedAt(): Promise<void> {
  try {
    const res = await fetch('/__synchro', { cache: 'no-store' });
    if (!res.ok || !(res.headers.get('content-type') ?? '').includes('json')) return;
    const sync = (await res.json()) as { at?: string; full?: string };
    const at = sync.full ?? sync.at ?? null;
    if (at) publish({ syncedAt: at });
  } catch {
    // Sans service worker, rien ne se garde : la ligne ne dit que ce qu'elle sait.
  }
}

/** Entre deux synchronisations demandées par la page, ms : le pouls bat toutes les dix secondes. */
export const SYNC_EVERY_MS = 5 * 60_000;
let lastAskedAt = 0;

/**
 * Demande au service worker de tout envoyer et de tout relire. Sans effet
 * hors ligne, sans worker, ou si la dernière demande est toute récente.
 */
export async function requestSync(force = false): Promise<void> {
  if (typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
  const now = Date.now();
  if (!force && now - lastAskedAt < SYNC_EVERY_MS) return;
  const worker = navigator.serviceWorker.controller;
  if (!worker) return;
  lastAskedAt = now;
  const channel = new MessageChannel();
  channel.port1.onmessage = (event) => {
    const result = event.data as { ok?: boolean } | null;
    if (result?.ok) publish({ syncedAt: new Date().toISOString(), live: true });
    // Une synchronisation manquée se redemandera au prochain pouls.
    else lastAskedAt = 0;
  };
  worker.postMessage({ type: 'sync' }, [channel.port2]);
}

let started = false;

/** À l'ouverture : ce que le worker sait déjà, et ce qu'il dira ensuite. */
export function watchSync(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  void readSyncedAt();
  if (!('serviceWorker' in navigator)) return;
  navigator.serviceWorker.addEventListener('message', (event) => {
    const message = event.data as { type?: string; ok?: boolean; sent?: number } | null;
    // Le Mac a répondu après que l'écran s'est affiché sur sa réserve : il se relit.
    if (message?.type === 'frais') window.dispatchEvent(new Event('cairn:changement'));
    if (message?.type === 'synchro') {
      if (message.ok) publish({ syncedAt: new Date().toISOString(), live: true });
      // Le worker a vidé la file : la page recompte ce qui attend encore, et les
      // écrans relisent ce que le Mac a fait de ces réponses.
      if (message.sent) {
        void flush();
        window.dispatchEvent(new Event('cairn:changement'));
      }
    }
  });
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void readSyncedAt();
  });
}

/** « à 18 h 38 », « hier à 18 h 38 », « le 9 nov. à 18 h 38 » : la date d'une synchronisation, relative au jour. */
export function syncedLabel(iso: string, now = new Date()): string {
  const at = new Date(iso);
  const day = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  const days = Math.round((day(now) - day(at)) / 86_400_000);
  const time = `${at.getHours()} h ${String(at.getMinutes()).padStart(2, '0')}`;
  if (days <= 0) return `à ${time}`;
  if (days === 1) return `hier à ${time}`;
  if (days < 7) return `${['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'][at.getDay()]} à ${time}`;
  const months = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
  return `le ${at.getDate()} ${months[at.getMonth()]}`;
}
