/**
 * Le Mac répond-il à la page, en ce moment ? Le pouls le dit (`lib/live.ts`), la
 * lecture le lit (`lib/api.ts`) : à part, pour que ni l'un ni l'autre n'importe
 * l'autre.
 *
 * Le 15/11, le service worker ne joignait plus le Mac alors que la page si : il
 * resservait sa réserve, et l'écran restait sur « Mise à jour… ». Une lecture
 * datée, quand le Mac répond, se refait donc au réseau, sans le worker — et un
 * écran qui s'est affiché sur la réserve se relit dès que le Mac répond.
 */
let live = false;
let staleShown = false;
const listeners = new Set<() => void>();

export const isLive = (): boolean => live;

/** Le pouls vient de passer, ou d'échouer. Vrai si un écran affiche une lecture datée qu'il faut relire. */
export function setLive(ok: boolean): boolean {
  live = ok;
  if (!ok || !staleShown) return false;
  staleShown = false;
  for (const l of listeners) l();
  return true;
}

/** Un écran vient de s'afficher sur une lecture datée. */
export function markStale(): void {
  staleShown = true;
}

export function onLiveAgain(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
