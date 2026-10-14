import { BUILD, checkWhileOpen } from './version';

/**
 * L'app ouverte se tient à jour d'elle-même.
 *
 * Le 14/10, Pierre : « j'ai envie que ça soit updaté en live ». Elle ne se
 * relisait qu'à l'ouverture et au retour au premier plan : une séance réécrite
 * par le coach, une sortie arrivée de Strava, une version neuve restaient
 * invisibles tant qu'on ne quittait pas l'app.
 *
 * Toutes les dix secondes, tant qu'elle est sous les yeux et déverrouillée, elle
 * demande au Mac son pouls (`/api/pulse`) : l'empreinte de ce que montrent les
 * écrans, et la version en service. L'empreinte bouge : les écrans se relisent
 * (`cairn:changement`, que `onForeground` écoute). La version bouge : elle se met
 * à jour dès qu'on la laisse un moment (`checkWhileOpen`). Sans réseau, rien :
 * l'écran garde sa lecture datée.
 */

export const PULSE_MS = 10_000;

/** Ce que l'app fait d'un pouls, la précédente empreinte connue. */
export function pulseEffect(
  seen: string | null,
  pulse: { stamp?: unknown; commit?: unknown },
  build: string | null,
): { stamp: string | null; changed: boolean; newVersion: boolean } {
  const stamp = typeof pulse.stamp === 'string' ? pulse.stamp : null;
  const commit = typeof pulse.commit === 'string' ? pulse.commit : null;
  return {
    stamp: stamp ?? seen,
    changed: seen !== null && stamp !== null && stamp !== seen,
    newVersion: build !== null && commit !== null && commit !== build,
  };
}

let started = false;
let seen: string | null = null;
let busy = false;

/** L'écran d'ouverture est là : la porte refuserait, et rien ne s'affiche de toute façon. */
const locked = () => document.querySelector('.lock[role="dialog"]') != null;

async function beat(): Promise<void> {
  if (busy || document.hidden || locked()) return;
  busy = true;
  try {
    const res = await fetch('/api/pulse', { cache: 'no-store', signal: AbortSignal.timeout(8_000) });
    if (!res.ok) return;
    const effect = pulseEffect(seen, (await res.json()) as { stamp?: unknown; commit?: unknown }, BUILD);
    seen = effect.stamp;
    if (effect.changed) window.dispatchEvent(new Event('cairn:changement'));
    if (effect.newVersion) checkWhileOpen();
  } catch {
    // Sans réseau : la lecture affichée reste, datée par l'écran.
  } finally {
    busy = false;
  }
}

export function watchLive(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  window.setInterval(() => void beat(), PULSE_MS);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) void beat();
  });
  // Face ID passé : le pouls reprend tout de suite, sans attendre son tour.
  window.addEventListener('cairn:deverrouille', () => void beat());
  void beat();
}
