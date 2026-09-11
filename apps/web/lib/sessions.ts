/**
 * Le vocabulaire d'une séance : comment on la nomme, comment on la colore,
 * comment on écrit son contenu.
 *
 * Partagé par le plan (bureau) et l'écran du matin (téléphone). Deux tables de
 * libellés divergentes, c'est la même séance appelée « Renforcement » d'un côté
 * et « Force » de l'autre — l'athlète croit lire deux séances.
 */
import { frDate } from './api';
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
