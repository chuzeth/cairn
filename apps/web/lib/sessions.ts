/**
 * Le vocabulaire d'une séance : comment on la nomme, comment on la colore,
 * comment on écrit son contenu.
 *
 * Partagé par le plan (bureau) et l'écran du matin (téléphone). Deux tables de
 * libellés divergentes, c'est la même séance appelée « Renforcement » d'un côté
 * et « Force » de l'autre — l'athlète croit lire deux séances.
 */
import { describeMovement } from '@cairn/core/movements';
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

/**
 * Le circuit s'écrit depuis sa structure, jamais à côté d'elle : c'est la même
 * structure qui produit la charge mécanique affichée en haut de la séance.
 *
 * Chaque mouvement arrive avec sa consigne d'exécution, depuis la table du
 * noyau : l'écran en tenait sa propre copie, qui nommait les cinq exercices
 * sans dire comment les faire — et l'athlète n'en a jamais fait aucun.
 */
export function circuitText(c: NonNullable<SessionRow['blocks'][number]['circuit']>): string {
  const items = c.exercises.map((e) => describeMovement(e.movement, e.reps));
  return `${c.rounds} tour${c.rounds > 1 ? 's' : ''} : ${items.join(' ; ')}.`;
}

/**
 * D'où vient une cible, dit court.
 *
 * Une FC, une allure, une vitesse ascensionnelle sont des paramètres
 * physiologiques dès lors qu'on demande à l'athlète de les tenir : elles
 * s'affichent avec leur provenance, comme la vitesse critique sur l'écran de
 * physiologie. Sans elle, « 171-175 bpm » et « 13,6-14,0 km/h » se lisent du
 * même œil alors que l'un est une mesure de laboratoire et l'autre la sortie
 * d'une régression.
 */
export const PROVENANCE_SHORT: Record<string, string> = {
  lab: 'labo', field: 'terrain', blended: 'labo + terrain', default: 'par défaut',
};

/** La provenance des cibles d'un bloc, en un mot quand elles s'accordent. */
export function provenanceText(p: SessionRow['blocks'][number]['provenance']): string {
  if (!p) return '';
  const parts = [
    ['FC', p.hr],
    ['allure', p.speed],
    ['D+/h', p.vam],
  ].filter(([, v]) => v) as [string, string][];
  if (parts.length === 0) return '';
  const unique = [...new Set(parts.map(([, v]) => v))];
  return unique.length === 1
    ? (PROVENANCE_SHORT[unique[0] as string] as string)
    : parts.map(([k, v]) => `${k} ${PROVENANCE_SHORT[v] ?? v}`).join(' · ');
}

/** Nomme le document d'où l'extrait est tiré, et sa date. */
export function originLabel(o: DirectiveOriginRow): string {
  const what =
    o.source === 'lab_test' ? "test d'effort" : o.source === 'athlete_notes' ? 'notes du dossier' : 'toi';
  return `${what}, ${frDate(o.date)}`;
}
