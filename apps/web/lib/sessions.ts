/**
 * Le vocabulaire d'une séance : comment on la nomme, comment on la colore,
 * comment on écrit son contenu.
 *
 * Partagé par le plan (bureau) et l'écran du matin (téléphone). Deux tables de
 * libellés divergentes, c'est la même séance appelée « Renforcement » d'un côté
 * et « Force » de l'autre — l'athlète croit lire deux séances.
 */
import { frDate, prime } from './api';
import type { DirectiveOriginRow, SessionRow } from './api';

export const TYPE_LABELS: Record<string, string> = {
  recovery: 'Récupération', endurance: 'Endurance', long_run: 'Sortie longue',
  long_trail: 'Rando-course', tempo: 'Tempo', threshold: 'Seuil', vo2max: 'PMA',
  hill_repeats: 'Côtes', downhill: 'Descente', fartlek: 'Fartlek',
  race_pace: 'Allure course', strength: 'Renforcement', mobility: 'Mobilité',
  cross_training: 'Cross-training', race: 'Course', rest: 'Repos',
};

export const TYPE_COLORS: Record<string, string> = {
  recovery: 'var(--z1)', endurance: 'var(--z2)', long_run: 'var(--z2)', long_trail: 'var(--accent)',
  tempo: 'var(--z3)', threshold: 'var(--z4)', vo2max: 'var(--z5)', hill_repeats: 'var(--z4)',
  downhill: 'var(--mechanical)', race_pace: 'var(--z3)', strength: 'var(--text-faint)',
  race: 'var(--good)', rest: 'var(--border-strong)',
};

/**
 * Ce qu'on annonce en haut de l'écran du matin, en trois mots.
 *
 * Une séance répétée se dit par sa structure — « 8 côtes de 90″ » — parce que
 * c'est elle qu'on exécute et qu'on retient. Les autres se disent par leur nom,
 * amputé de ce que la ligne suivante répète déjà : la durée et le dénivelé sont
 * dans le sous-titre, les répéter ici coûterait deux lignes de titre à 54 px.
 */
export function sessionHeadline(session: SessionRow): string {
  const rep = session.blocks.find((b) => (b.repeat ?? 0) > 1 && (b.durationS ?? 0) > 0);
  if (rep) {
    const n = rep.repeat as number;
    const d = prime(rep.durationS);
    const shape = REPEAT_HEADLINE[session.type];
    return shape ? shape(n, d) : `${n} × ${d}`;
  }
  const head = (session.title.split(' — ')[0] as string)
    .split(' · ')[0]!
    .replace(/^[^\p{L}\d]+/u, '')
    .replace(/\s+\d+(?:[.,]\d+)?\s*(?:min|h|s)$/i, '')
    .trim();
  return head.length > 0 && head.length <= 30 ? head : TYPE_LABELS[session.type] ?? session.type;
}

const REPEAT_HEADLINE: Record<string, (n: number, d: string) => string> = {
  hill_repeats: (n, d) => `${n} côtes de ${d}`,
  downhill: (n, d) => `${n} descentes de ${d}`,
  vo2max: (n, d) => `${n} × ${d} en PMA`,
  threshold: (n, d) => `${n} × ${d} au seuil`,
  tempo: (n, d) => `${n} × ${d} en tempo`,
  race_pace: (n, d) => `${n} × ${d} à l'allure course`,
  fartlek: (n, d) => `${n} × ${d} en fartlek`,
  strength: (n, d) => `${n} tours de ${d}`,
};

/**
 * La pente, telle que le planificateur l'a écrite dans le titre.
 *
 * Recalculée depuis l'allure cible, elle sortirait juste la plupart du temps et
 * fausse le reste du temps — l'allure d'un bloc en côte est une allure à plat à
 * corriger de la pente, donc précisément pas de quoi retrouver la pente.
 */
export const slopeOf = (session: SessionRow): string | null =>
  /à\s+(\d+(?:[.,]\d+)?)\s*%/.exec(session.title)?.[0].replace(/\s+/, '\u00a0') ?? null;

export const CRITERION_LABELS: Record<string, string> = {
  hr_drift: 'pas de dérive cardiaque (Pa:HR) sur la séance',
};

export const MOVEMENT_LABELS: Record<string, { label: string; perSide: boolean; seconds?: boolean }> = {
  split_squat: { label: 'squats bulgares', perSide: true },
  step_down: { label: 'descentes lentes de marche', perSide: true },
  single_leg_deadlift: { label: 'soulevés de terre unilatéraux', perSide: true },
  eccentric_calf: { label: 'mollets excentriques', perSide: true },
  nordic_curl: { label: 'nordic hamstring', perSide: false },
  drop_jump: { label: 'sauts en contrebas', perSide: false },
  isometric: { label: 'gainage', perSide: false, seconds: true },
};

/**
 * Le circuit s'écrit depuis sa structure, jamais à côté d'elle : c'est la même
 * structure qui produit la charge mécanique affichée en haut de la séance.
 */
export function circuitText(c: NonNullable<SessionRow['blocks'][number]['circuit']>): string {
  const items = c.exercises.map((e) => {
    const m = MOVEMENT_LABELS[e.movement] ?? { label: e.movement, perSide: false };
    return `${m.label} ${e.reps}${m.seconds ? ' s' : m.perSide ? '/jambe' : ''}`;
  });
  return `${c.rounds} tour${c.rounds > 1 ? 's' : ''} : ${items.join(' · ')}.`;
}

/** Nomme le document d'où l'extrait est tiré, et sa date. */
export function originLabel(o: DirectiveOriginRow): string {
  const what =
    o.source === 'lab_test' ? "test d'effort" : o.source === 'athlete_notes' ? 'notes du dossier' : 'toi';
  return `${what}, ${frDate(o.date)}`;
}
