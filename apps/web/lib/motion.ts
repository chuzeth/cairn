/**
 * Le rythme d'un schéma animé : celui que la séance prescrit.
 *
 * Un tempo s'écrit « 3 s pour descendre, 1 s en bas, 1 s pour monter » : un
 * premier mouvement — de la position de départ, en pointillé, à la position
 * dessinée —, un maintien, le retour, et ce qu'on attend avant de repartir. Le
 * schéma bouge à ces secondes-là : ce qu'une consigne écrite laisse à
 * l'interprétation — la vitesse, l'amplitude —, l'image le montre.
 *
 * Sans tempo écrit, un geste posé : 1,4 s pour aller, 0,6 s tenu, 1,4 s pour
 * revenir, 0,8 s avant de repartir.
 */

export interface Cycle {
  /** De la position de départ à la position dessinée, s. */
  go: number;
  /** Tenu dans la position dessinée, s. */
  hold: number;
  /** Le retour, s. */
  back: number;
  /** Tenu dans la position de départ, avant de repartir, s. */
  rest: number;
}

export const DEFAULT_CYCLE: Cycle = { go: 1.4, hold: 0.6, back: 1.4, rest: 0.8 };

/** Une seconde lue dans un morceau de tempo : « 3 s », « 1,5 s ». */
const secondsIn = (text: string): number | null => {
  const m = /(\d+(?:[.,]\d+)?)\s*s\b/.exec(text);
  return m ? Number(m[1]!.replace(',', '.')) : null;
};

/** Ce qui se tient, sans bouger : en bas, en haut, tenu, serré, au mur. */
const HOLD = /\b(en bas|en haut|tenu|tenue|tenues|tenus|serrée?s?|au mur)\b/;

const clamp = (s: number) => Math.min(6, Math.max(0.4, s));

/**
 * Le cycle d'un tempo écrit. Les morceaux se lisent dans l'ordre : le premier
 * mouvement est l'aller, le second le retour ; un maintien entre les deux est
 * tenu dans la position dessinée, un maintien après le retour avant de
 * repartir. « Le plus vite possible » dure une demi-seconde.
 */
export function cycleOf(tempo: string | undefined | null): Cycle {
  if (!tempo) return DEFAULT_CYCLE;
  const moves: number[] = [];
  let hold: number | null = null;
  let rest: number | null = null;
  for (const raw of tempo.toLowerCase().split(/,|\bpuis\b/)) {
    const part = raw.trim();
    if (!part) continue;
    const s = secondsIn(part);
    const isHold = HOLD.test(part) && !/\bpour\b/.test(part);
    if (isHold && s != null) {
      if (moves.length === 0 && hold == null) {
        // « 2 s au mur, puis tu reviens » : l'aller n'est pas dit, le maintien l'est.
        moves.push(DEFAULT_CYCLE.go);
        hold = s;
      } else if (moves.length === 1 && hold == null) hold = s;
      else rest = s;
    } else if (s != null) moves.push(s);
    else if (/vite/.test(part)) moves.push(0.5);
    else if (/reviens|revenir|retour/.test(part) && moves.length === 1) moves.push(DEFAULT_CYCLE.back);
  }
  if (moves.length === 0) return { ...DEFAULT_CYCLE, ...(hold != null ? { hold: clamp(hold) } : {}) };
  const go = moves[0]!;
  const back = moves[1] ?? Math.max(0.8, go * 0.6);
  return {
    go: clamp(go),
    hold: clamp(hold ?? 0.5),
    back: clamp(back),
    rest: clamp(rest ?? 0.8),
  };
}

/** Le tour complet, ms. */
export const cycleMs = (c: Cycle): number => (c.go + c.hold + c.back + c.rest) * 1000;

/** Une accélération douce au départ, une arrivée douce : un geste, pas un métronome. */
const ease = (x: number): number => 0.5 - Math.cos(Math.PI * x) / 2;

/**
 * Où en est le mouvement, de 0 (départ) à 1 (position dessinée), `ms` après
 * le début du tour.
 */
export function phaseAt(c: Cycle, ms: number): number {
  const total = cycleMs(c);
  let at = ((ms % total) + total) % total / 1000;
  if (at < c.go) return ease(at / c.go);
  at -= c.go;
  if (at < c.hold) return 1;
  at -= c.hold;
  if (at < c.back) return 1 - ease(at / c.back);
  return 0;
}
