import type { PlannedSession } from '@cairn/core';
import { desiredState, type LedgerEntry } from './reconcile.js';
import type { Rejection } from './sync.js';

/**
 * Ce que l'écran dit de chaque séance côté Garmin.
 *
 * Quatre états, et jamais « envoyée » : vérifiée — relue sur Garmin et
 * conforme —, écart — relue, et différente, et on dit en quoi —, en attente,
 * ou Garmin injoignable. Une séance vérifiée est « sur ta montre » quand la
 * montre s'est synchronisée après l'envoi, « sur Garmin Connect » sinon. Et
 * quand la version que porte la montre n'est plus celle du plan, l'écran le dit
 * tant que ce n'est pas réparé : c'est la seule façon qu'une séance fausse n'y
 * soit jamais sans que l'athlète le sache.
 */

export type GarminOutcome = 'ok' | 'unreachable' | 'reauth' | 'error';

/** L'état du dernier passage, tel que le registre le garde. */
export interface GarminSyncState {
  outcome: GarminOutcome | null;
  message: string | null;
  lastRunAt: string | null;
  lastSuccessAt: string | null;
  watchName: string | null;
  watchSyncedAt: string | null;
  rejections: Rejection[];
}

export type GarminConnection = 'ok' | 'reauth' | 'unreachable' | 'error' | 'disconnected';

export type GarminTone = 'good' | 'warn' | 'mute';

export interface SessionGarminStatus {
  state: 'verified' | 'mismatch' | 'pending' | 'unreachable' | 'reauth' | 'not_sent';
  label: string;
  /** Deux mots, pour la case d'un jour dans la grille du plan. */
  short: string;
  detail?: string;
  tone: GarminTone;
}

export interface GarminOverview {
  connection: GarminConnection;
  /** Ce qui ne va pas avec la liaison elle-même ; absent quand elle va bien. */
  problem: string | null;
  lastSuccessAt: string | null;
  watch: { name: string; syncedAt: string } | null;
  /** Séances de Cairn encore sur Garmin que le plan ne veut plus. */
  stale: { date: string; name: string }[];
}

export interface GarminView {
  overview: GarminOverview;
  bySession: Record<string, SessionGarminStatus>;
}

export function garminView(input: {
  today: string;
  sessions: readonly PlannedSession[];
  ledger: readonly LedgerEntry[];
  sync: GarminSyncState | null;
  /** Un fichier de session existe : Pierre s'est connecté au moins une fois. */
  connected: boolean;
}): GarminView {
  const { today, sessions, sync, connected } = input;
  const live = input.ledger.filter((e) => e.state !== 'deleted');
  const connection: GarminConnection =
    !connected && live.length === 0 ? 'disconnected'
    : !connected || sync?.outcome === 'reauth' ? 'reauth'
    : sync?.outcome === 'unreachable' ? 'unreachable'
    : sync?.outcome === 'error' ? 'error'
    : 'ok';

  const state = desiredState(sessions, today);
  const inWindow = (d: string) => d >= state.today && d <= state.horizon && !state.frozen.includes(d);
  const wanted = new Set(state.desired.map((d) => `${d.date}|${d.fingerprint}`));
  const stale = live.filter((e) => inWindow(e.date) && !wanted.has(`${e.date}|${e.fingerprint}`));

  const overview: GarminOverview = {
    connection,
    problem:
      connection === 'reauth' ? 'Reconnexion Garmin nécessaire : lance `npm run garmin -- login` sur le Mac.'
      : connection === 'unreachable' ? `Garmin injoignable${sync?.message ? ` : ${sync.message}` : '.'}`
      : connection === 'error' ? `La liaison Garmin a échoué${sync?.message ? ` : ${sync.message}` : '.'}`
      : null,
    lastSuccessAt: sync?.lastSuccessAt ?? null,
    watch: sync?.watchName && sync.watchSyncedAt ? { name: sync.watchName, syncedAt: sync.watchSyncedAt } : null,
    stale: stale.map((e) => ({ date: e.date, name: e.name })),
  };
  if (connection === 'disconnected') return { overview, bySession: {} };

  const bySession: Record<string, SessionGarminStatus> = {};
  const staleOn = (date: string) => stale.some((e) => e.date === date);

  /** Faute d'avoir pu envoyer : ce que la montre porte ce jour-là, dit franchement. */
  const blocked = (date: string): SessionGarminStatus | null => {
    const old = staleOn(date);
    if (connection === 'reauth') {
      return {
        state: 'reauth',
        label: 'Reconnexion Garmin nécessaire',
        short: 'reconnexion Garmin',
        detail: old ? "l'ancienne version est encore sur ta montre" : 'pas encore envoyée',
        tone: 'warn',
      };
    }
    if (connection === 'unreachable' || connection === 'error') {
      return {
        state: 'unreachable',
        label: 'Garmin injoignable',
        short: 'Garmin injoignable',
        detail: old ? "l'ancienne version est encore sur ta montre" : 'pas encore envoyée',
        tone: 'warn',
      };
    }
    return null;
  };

  for (const d of state.desired) {
    const mine = live.filter((e) => e.date === d.date && e.fingerprint === d.fingerprint);
    const entry = mine.find((e) => e.state === 'verified') ?? mine[0];
    if (entry?.state === 'verified') {
      const onWatch = Boolean(sync?.watchSyncedAt && entry.sentAt && sync.watchSyncedAt > entry.sentAt);
      bySession[d.sessionId] = {
        state: 'verified',
        label: onWatch ? 'Vérifiée, sur ta montre' : 'Vérifiée, sur Garmin Connect',
        short: onWatch ? 'sur la montre' : 'sur Garmin',
        ...(d.abridged.length ? { detail: d.abridged.join(' ; ') } : {}),
        tone: 'good',
      };
      continue;
    }
    if (entry?.state === 'mismatch') {
      bySession[d.sessionId] = {
        state: 'mismatch',
        label: 'Écart sur Garmin',
        short: 'écart Garmin',
        detail: (entry.discrepancies ?? []).join(' ; ') || 'relue différente de la prescription',
        tone: 'warn',
      };
      continue;
    }
    const rejected = sync?.rejections.find((r) => r.date === d.date && r.fingerprint === d.fingerprint);
    if (rejected) {
      bySession[d.sessionId] = {
        state: 'mismatch', label: 'Refusée par Garmin', short: 'refusée par Garmin', detail: rejected.message, tone: 'warn',
      };
      continue;
    }
    bySession[d.sessionId] = blocked(d.date) ?? {
      state: 'pending',
      label: entry ? 'Créée sur Garmin, en attente de relecture' : "En attente d'envoi à Garmin",
      short: 'Garmin en attente',
      ...(staleOn(d.date) ? { detail: "l'ancienne version est encore sur Garmin" } : {}),
      tone: 'mute',
    };
  }

  for (const u of state.unsent) {
    bySession[u.sessionId] = {
      state: 'not_sent', label: 'Pas envoyée à la montre', short: 'pas sur la montre', detail: u.reason, tone: 'mute',
    };
  }

  // Une séance retirée ou annulée dont la version Garmin n'est pas encore partie.
  for (const s of sessions) {
    if (bySession[s.id] || !inWindow(s.date) || !staleOn(s.date)) continue;
    if (s.status !== 'withdrawn' && s.status !== 'cancelled' && s.status !== 'missed') continue;
    bySession[s.id] = blocked(s.date) ?? {
      state: 'pending',
      label: 'Encore sur Garmin',
      short: 'encore sur Garmin',
      detail: 'retirée du plan, suppression en attente',
      tone: 'warn',
    };
  }

  return { overview, bySession };
}
