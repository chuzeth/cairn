'use client';
import { useSyncExternalStore } from 'react';
import { post } from './api';

/**
 * Ce que le téléphone garde quand le Mac ne répond pas.
 *
 * La lecture est au service worker (`public/sw.js`) : il garde la dernière
 * réponse réussie et la ressert datée. L'écriture est ici, dans la page, et pas
 * dans le worker — parce qu'une file n'a de valeur que si l'athlète la voit.
 * « Enregistré » et « en attente d'envoi » ne sont pas la même phrase : un point
 * du jour qui n'est pas parti n'est pas un point du jour, et personne ne doit
 * découvrir trois jours plus tard que ses réponses n'ont jamais quitté le
 * téléphone.
 *
 * Le rejeu est sûr parce que l'API fusionne : `/api/checkin` complète le relevé
 * du jour au lieu de l'écraser. Une écriture partie dont la réponse s'est perdue
 * sera rejouée, et ne fera rien de plus.
 */

const DB_NAME = 'cairn';
const STORE = 'outbox';

interface Queued {
  id?: number;
  path: string;
  body: unknown;
  queuedAt: string;
}

export interface Outbox {
  /** Écritures qui n'ont pas quitté le téléphone. */
  pending: number;
  /** Ce que le serveur a refusé au rejeu : l'écriture est perdue, on le dit. */
  refused: string | null;
}

// ── La file ──────────────────────────────────────────────────────────────────

function open(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      if (!req.result.objectStoreNames.contains(STORE)) {
        req.result.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error ?? new Error('IndexedDB indisponible'));
  });
}

async function run<T>(mode: IDBTransactionMode, op: (store: IDBObjectStore) => IDBRequest<T>): Promise<T> {
  const database = await open();
  try {
    return await new Promise<T>((resolve, reject) => {
      const req = op(database.transaction(STORE, mode).objectStore(STORE));
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error ?? new Error('Écriture locale impossible'));
    });
  } finally {
    database.close();
  }
}

const enqueue = (item: Queued) => run('readwrite', (s) => s.add(item) as IDBRequest<IDBValidKey>);
const waiting = () => run('readonly', (s) => s.getAll() as IDBRequest<Queued[]>);
const forget = (id: number) => run('readwrite', (s) => s.delete(id) as IDBRequest<undefined>);

// ── Ce que l'interface en sait ───────────────────────────────────────────────

const EMPTY: Outbox = { pending: 0, refused: null };
let state: Outbox = EMPTY;
const watchers = new Set<() => void>();

function publish(next: Outbox): void {
  state = next;
  for (const watcher of watchers) watcher();
}

function subscribe(watcher: () => void): () => void {
  watchers.add(watcher);
  return () => watchers.delete(watcher);
}

/** Ce qui attend d'être envoyé, tel que l'écran doit le dire. */
export function useOutbox(): Outbox {
  return useSyncExternalStore(subscribe, () => state, () => EMPTY);
}

// ── Envoyer, ou garder ───────────────────────────────────────────────────────

/**
 * Une panne de réseau, pas un refus du serveur.
 *
 * `fetch` rejette avec un `TypeError` quand la requête ne part pas ou n'arrive
 * pas ; un 400 remonte, lui, par `post`, avec le message du serveur. Mettre un
 * refus en file le rejouerait à chaque retour du réseau, sans fin.
 */
const unreachable = (e: unknown) =>
  e instanceof TypeError || (typeof navigator !== 'undefined' && !navigator.onLine);

const said = (e: unknown) => (e instanceof Error ? e.message : String(e));

/**
 * Envoie, ou met en file. `null` : rien n'est parti, et rien n'est enregistré.
 *
 * L'appelant a alors une seule chose à faire — le dire. Afficher un résultat
 * calculé localement serait pire que l'attente : ce serait un score que le
 * serveur n'a pas produit.
 */
export async function sendOrQueue<T>(path: string, body: unknown): Promise<T | null> {
  try {
    return await post<T>(path, body);
  } catch (e) {
    if (!unreachable(e)) throw e;
    try {
      await enqueue({ path, body, queuedAt: new Date().toISOString() });
    } catch {
      // Pas de file possible : l'erreur de réseau remonte, elle est plus vraie
      // qu'un « en attente d'envoi » qui n'attendrait rien.
      throw e;
    }
    publish({ pending: state.pending + 1, refused: null });
    return null;
  }
}

let flushing = false;

/**
 * Rejoue la file, dans l'ordre où elle s'est formée.
 *
 * Toujours hors réseau : on s'arrête, la file attend. Refusé par le serveur : le
 * rejeu ne passera jamais, l'écriture sort de la file et le refus est dit.
 */
export async function flush(): Promise<void> {
  if (flushing || typeof indexedDB === 'undefined') return;
  flushing = true;
  try {
    let refused = state.refused;
    for (const item of await waiting()) {
      try {
        await post(item.path, item.body);
      } catch (e) {
        if (unreachable(e)) break;
        refused = said(e);
      }
      if (item.id != null) await forget(item.id);
    }
    publish({ pending: (await waiting()).length, refused });
  } catch {
    // File illisible : rien n'est perdu, le prochain retour du réseau réessaiera.
  } finally {
    flushing = false;
  }
}

let started = false;

/**
 * Le service worker, et les moments où la file repart.
 *
 * `online` ne suffit pas sur un téléphone : l'application revient d'arrière-plan
 * bien plus souvent qu'elle ne change d'état réseau, et c'est à ce moment-là
 * qu'on la regarde.
 */
export function boot(): void {
  if (started || typeof window === 'undefined') return;
  started = true;

  if ('serviceWorker' in navigator) {
    // `updateViaCache: 'none'` : le worker ne doit pas être servi par le cache
    // HTTP, sinon une correction ici mettrait un jour à atteindre le téléphone.
    navigator.serviceWorker.register('/sw.js', { updateViaCache: 'none' }).catch(() => {
      // Contexte non sécurisé ou navigation privée : Cairn marche comme avant,
      // en ligne seulement.
    });
  }

  const wake = () => { if (navigator.onLine) void flush(); };
  window.addEventListener('online', wake);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) wake(); });
  void flush();
}
