'use client';
import { useCallback, useEffect, useState } from 'react';
import { get, post } from './api';
import { behindGate } from './lock';

/**
 * Les notifications : ce qui tient l'app à jour sans qu'on l'ouvre.
 *
 * Le téléphone sert quand le Mac dort, et une app web fermée ne se réveille que
 * par une notification. Activées — un toucher, une fois —, le Mac prévient le
 * téléphone dès qu'il a du neuf : la séance du jour le matin, une sortie
 * analysée, une séance réécrite, une question. Le service worker en profite
 * pour envoyer ce qui attendait et tout relire (`public/sw.js`).
 *
 * Sur iPhone, cela n'existe que pour l'app installée sur l'écran d'accueil, et
 * la permission ne se demande que sur un geste.
 */

export type PushStatus =
  /** Pas encore su. */
  | 'checking'
  /** Ce navigateur ne sait pas, ou l'app n'est pas derrière la porte (le Mac lui-même). */
  | 'unsupported'
  /** Jamais demandé : l'invitation se montre. */
  | 'off'
  /** Refusé dans les réglages du téléphone : seul Pierre peut le rouvrir. */
  | 'denied'
  | 'on';

const supported = () =>
  typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window &&
  behindGate(location);

async function current(): Promise<PushStatus> {
  if (!supported()) return 'unsupported';
  if (Notification.permission === 'denied') return 'denied';
  if (Notification.permission !== 'granted') return 'off';
  const registration = await navigator.serviceWorker.ready;
  return (await registration.pushManager.getSubscription()) ? 'on' : 'off';
}

/** La clef du Mac, telle que le navigateur l'attend : des octets, pas du base64url. */
function keyBytes(key: string): Uint8Array<ArrayBuffer> {
  const base64 = key.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(key.length / 4) * 4, '=');
  const raw = atob(base64);
  const out = new Uint8Array(new ArrayBuffer(raw.length));
  for (let i = 0; i < raw.length; i++) out[i] = raw.charCodeAt(i);
  return out;
}

const device = () => (/iPhone/.test(navigator.userAgent) ? 'iPhone' : /iPad/.test(navigator.userAgent) ? 'iPad' : /Android/.test(navigator.userAgent) ? 'Android' : 'navigateur');

/** Demande la permission, abonne l'appareil, le dit au Mac. À appeler sur un geste. */
async function enable(): Promise<PushStatus> {
  if (!supported()) return 'unsupported';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return permission === 'denied' ? 'denied' : 'off';
  const registration = await navigator.serviceWorker.ready;
  const { publicKey } = await get<{ publicKey: string }>('/api/push/key');
  const subscription =
    (await registration.pushManager.getSubscription()) ??
    (await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) }));
  await post('/api/push/subscribe', { subscription: subscription.toJSON(), origin: location.origin, device: device() });
  return 'on';
}

/** Où en sont les notifications sur cet appareil, et de quoi les activer. */
export function usePush(): { status: PushStatus; busy: boolean; error: string | null; enable: () => Promise<void> } {
  const [status, setStatus] = useState<PushStatus>('checking');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void current().then((s) => { if (alive) setStatus(s); }).catch(() => { if (alive) setStatus('unsupported'); });
    return () => { alive = false; };
  }, []);

  const turnOn = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      setStatus(await enable());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, []);

  return { status, busy, error, enable: turnOn };
}
