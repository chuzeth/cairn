import type { SessionRow } from './api';
import type { Part } from './workout';

/**
 * Ce que l'écran du jour dit d'une séance en chiffres et en formes — la
 * refonte du 21/10.
 *
 * Rien ici ne décide : tout se lit sur les blocs et les charges que le coach a
 * posés. Le module les regroupe et les traduit, pour que « 86 » cesse d'être un
 * nombre sans unité.
 */

/** La nature d'une partie : ce que sa couleur dit dans le déroulé. */
export type PartKind = 'warm' | 'cardio' | 'renfo' | 'mobi';

export const KIND_LABEL: Record<PartKind, string> = {
  warm: 'Échauffement',
  cardio: 'Endurance',
  renfo: 'Renforcement',
  mobi: 'Mobilité, souffle',
};

type Block = SessionRow['blocks'][number];

const isMobility = (b: Block) => b.kind === 'mobility' || b.kind === 'respiratory';

/**
 * Une partie est de la mobilité si tous ses blocs le sont, un échauffement si
 * elle le dit, de l'endurance si elle se pilote au cœur ou monte en continu,
 * du renforcement sinon. L'ordre compte : les « deux montées faciles » d'un
 * échauffement montent, elles restent l'échauffement.
 */
export function partKind(part: Pick<Part, 'name' | 'steps'>): PartKind {
  const blocks = part.steps.map((s) => s.block);
  if ((blocks.length > 0 && blocks.every(isMobility)) || /mobilité|souplesse/i.test(part.name)) return 'mobi';
  if (/échauffement|activation/i.test(part.name)) return 'warm';
  if (blocks.some((b) => b.hrRange || ((b.elevationGainM ?? 0) > 0 && !b.reps))) return 'cardio';
  return 'renfo';
}

export interface FlowSegment { name: string; minutes: number; kind: PartKind }
export interface FlowGroup { label: string; minutes: number; kind: PartKind }

/**
 * Le déroulé : une barre par partie, à sa durée, et la légende par nature.
 *
 * Une nature qui ne compte qu'une partie prend le nom de cette partie —
 * « Escalier » dit plus qu'« Endurance » ; à plusieurs, c'est la nature qui
 * les nomme.
 */
export function flowOf(parts: Pick<Part, 'name' | 'steps' | 'durationS'>[]): { segments: FlowSegment[]; groups: FlowGroup[]; minutes: number } {
  // Les minutes de chaque partie se répartissent au plus fort reste : leur somme
  // est la durée de la séance telle que la case « Durée » l'écrit — en minutes
  // entamées, comme `sessionDuration` (`@cairn/core`). Arrondies chacune, les
  // parties d'une séance de 85,6 minutes faisaient « 86 min » sous « 1 h 25 ».
  const timed = parts.filter((p) => p.durationS > 0);
  const exact = timed.map((p) => p.durationS / 60);
  const minutes = exact.map(Math.floor);
  let left = Math.floor(exact.reduce((a, m) => a + m, 0)) - minutes.reduce((a, m) => a + m, 0);
  for (const i of exact.map((m, i) => i).sort((a, b) => (exact[b]! % 1) - (exact[a]! % 1))) {
    if (left <= 0) break;
    minutes[i]! += 1;
    left -= 1;
  }
  const segments = timed.map((p, i) => ({ name: p.name, minutes: Math.max(1, minutes[i]!), kind: partKind(p) }));
  const groups: (FlowGroup & { names: string[] })[] = [];
  for (const s of segments) {
    const g = groups.find((x) => x.kind === s.kind);
    if (g) {
      g.minutes += s.minutes;
      if (!g.names.includes(s.name)) g.names.push(s.name);
    } else {
      groups.push({ label: '', minutes: s.minutes, kind: s.kind, names: [s.name] });
    }
  }
  return {
    segments,
    groups: groups.map(({ names, ...g }) => ({ ...g, label: names.length === 1 ? names[0]! : KIND_LABEL[g.kind] })),
    minutes: segments.reduce((a, s) => a + s.minutes, 0),
  };
}

/**
 * Les points de charge en minutes à son seuil : cent points valent une heure au
 * seuil (`GLOSSARY.points`, `@cairn/coach`). C'est la seule traduction exacte
 * qu'on puisse en donner : l'intensité compte au carré, et « 86 points » ne
 * vaut pas « 86 minutes faciles ».
 */
export const thresholdMinutes = (points: number): number => Math.round(points * 0.6);

/** Le lundi de la semaine d'une date, en ISO. */
export function weekStartOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  return new Date(d.getTime() + (dow === 0 ? -6 : 1 - dow) * 86_400_000).toISOString().slice(0, 10);
}

/** Ce qui pèse encore dans une semaine : une séance retirée ou annulée ne compte plus. */
export const held = (s: Pick<SessionRow, 'status'>) => s.status !== 'withdrawn' && s.status !== 'cancelled';

/**
 * La part de la semaine que pèse une séance, en pour cent entier ; `null` si
 * la semaine ne pèse rien.
 */
export function weekShare(
  session: Pick<SessionRow, 'date' | 'plannedLoad'>,
  sessions: Pick<SessionRow, 'date' | 'plannedLoad' | 'status'>[],
): number | null {
  const monday = weekStartOf(session.date);
  const total = sessions
    .filter((s) => held(s) && weekStartOf(s.date) === monday)
    .reduce((a, s) => a + s.plannedLoad, 0);
  return total > 0 ? Math.round((session.plannedLoad / total) * 100) : null;
}

/**
 * La cible cardiaque qui tient le plus longtemps dans la séance, avec ce sur
 * quoi elle repose : une fréquence qu'on demande de tenir est un paramètre
 * physiologique, et elle ne s'affiche pas sans sa provenance.
 */
export function heartTarget(blocks: Block[]): { range: [number, number]; provenance: string | null } | null {
  let best: Block | null = null;
  let bestS = 0;
  for (const b of blocks) {
    if (!b.hrRange) continue;
    const s = (b.durationS ?? 0) * (b.repeat ?? 1);
    if (s > bestS) { best = b; bestS = s; }
  }
  return best?.hrRange ? { range: best.hrRange, provenance: best.provenance?.hr ?? null } : null;
}

/** Un jour du calendrier qui mène à la course. */
export interface CountdownDay {
  date: string;
  /** La nature du travail prévu ou fait ce jour-là ; `rest` : rien de prévu, ou un repos. */
  kind: PartKind | 'rest' | 'race';
  past: boolean;
  today: boolean;
}

/**
 * La nature dominante d'une séance : celle qui y prend le plus de minutes,
 * l'échauffement mis à part. Une séance sans parties — une course — est de
 * l'endurance.
 */
export function sessionKind(parts: Pick<Part, 'name' | 'steps' | 'durationS'>[]): PartKind {
  const { groups } = flowOf(parts);
  const main = groups.filter((g) => g.kind !== 'warm').sort((a, b) => b.minutes - a.minutes)[0];
  return main?.kind ?? 'cardio';
}

/**
 * Les jours d'aujourd'hui moins `back` jusqu'à la course incluse, chacun avec
 * la nature de ce qui s'y fait. Le calendrier ne lit que les séances qui
 * pèsent encore ; un jour sans elles est un jour sans rien de prévu.
 */
export function countdownDays<S extends Pick<SessionRow, 'date' | 'type' | 'status'>>(
  today: string,
  raceDate: string,
  sessions: S[],
  kindOf: (s: S) => PartKind,
  back = 11,
): CountdownDay[] {
  const start = new Date(new Date(`${today}T00:00:00Z`).getTime() - back * 86_400_000);
  const end = new Date(`${raceDate}T00:00:00Z`);
  const days: CountdownDay[] = [];
  for (let t = start.getTime(); t <= end.getTime(); t += 86_400_000) {
    const date = new Date(t).toISOString().slice(0, 10);
    const day = sessions.filter((s) => s.date === date && held(s) && s.type !== 'rest');
    const kind: CountdownDay['kind'] = date === raceDate
      ? 'race'
      : day.length === 0 ? 'rest' : kindOf(day[0]!);
    days.push({ date, kind, past: date < today, today: date === today });
  }
  return days;
}
