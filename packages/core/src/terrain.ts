import type { GroundKind, StretchGround, TerrainPoint, TerrainStretch } from './types.js';

/**
 * Le terrain d'une séance, tel qu'on le lit : par où, sur quel sol, et où
 * ouvrir la carte.
 *
 * Partagé par l'écran, la montre et le coach : trois écritures d'un même
 * tronçon, c'est trois façons de le mal décrire.
 */

const ROLE_LABEL: Record<TerrainPoint['role'], string> = { pied: 'Pied', haut: 'Haut', 'demi-tour': 'Demi-tour' };

/** « Demi-tour · 8 montée Saint-Barthélémy » : le nom de l'épingle sur la carte. */
export const pointLabel = (p: TerrainPoint): string =>
  p.address ? `${ROLE_LABEL[p.role]} · ${p.address}` : ROLE_LABEL[p.role];

const latLng = (p: TerrainPoint) => `${p.at[0].toFixed(6)},${p.at[1].toFixed(6)}`;

/**
 * Le lien qui pose une épingle sur un point, par ses coordonnées.
 *
 * Plans d'Apple, en URL unifiée (iOS 18.4 et après) : `/place` pose l'épingle à
 * la coordonnée et lui donne le nom qu'on passe. L'ancien `?ll=…&q=haut` faisait
 * de `q` une recherche — « haut » renvoyait des lieux quelconques.
 */
export function mapUrl(p: TerrainPoint): string {
  return `https://maps.apple.com/place?coordinate=${latLng(p)}&name=${encodeURIComponent(pointLabel(p))}`;
}

/**
 * L'itinéraire à pied jusqu'à un point, depuis là où l'on est. Le départ n'est
 * pas dans le lien : c'est le téléphone qui le connaît, pas Cairn.
 */
export function directionsUrl(p: TerrainPoint): string {
  return `https://maps.apple.com/directions?destination=${latLng(p)}&mode=walking`;
}

const pct = (grade: number) => `${Math.round(grade * 100)} %`;
const metres = (m: number) => `${Math.round(m)} m`;

/** « du haut au demi-tour, 405 m à 19 % » — les trois rôles sont masculins, l'article se contracte. */
export function stretchSpan(w: TerrainStretch): string {
  return `du ${w.from.role} au ${w.to.role}, ${metres(w.lengthM)} à ${pct(w.grade)}`;
}

/** Des coordonnées qu'on peut recopier dans une carte — sur la montre, qui n'ouvre pas de lien. */
export const coordinates = (p: TerrainPoint): string => `${p.at[0].toFixed(6)}, ${p.at[1].toFixed(6)}`;

/**
 * Une récupération qui remonte. Elle se marche, et se termine en haut : sa
 * durée est ce que la marche y prend, pas un temps après lequel repartir.
 */
export const climbsBack = (r?: { elevationGainM?: number } | null): boolean => (r?.elevationGainM ?? 0) > 0;

// ─────────────────────────────────────────────────────────────────────────────
// Les noms de voies, à la française
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le genre des mots qui ouvrent un nom de voie. OpenStreetMap écrit « Montée
 * Saint-Barthélémy » ; une phrase dit « la montée Saint-Barthélémy », et « du
 * chemin de Montauban ».
 */
const GENERIC: Record<string, 'f' | 'm' | 'p'> = {
  rue: 'f', ruelle: 'f', montée: 'f', descente: 'f', côte: 'f', rampe: 'f', place: 'f', placette: 'f',
  avenue: 'f', impasse: 'f', allée: 'f', route: 'f', voie: 'f', esplanade: 'f', promenade: 'f',
  traverse: 'f', cité: 'f', galerie: 'f', passerelle: 'f', terrasse: 'f', piste: 'f', grande: 'f', petite: 'f',
  chemin: 'm', boulevard: 'm', quai: 'm', passage: 'm', cours: 'm', sentier: 'm', escalier: 'm', square: 'm',
  parc: 'm', jardin: 'm', clos: 'm', pont: 'm', tunnel: 'm', mail: 'm', parvis: 'm', port: 'm', carrefour: 'm',
  'rond-point': 'm', raidillon: 'm', faubourg: 'm', hameau: 'm',
  escaliers: 'p', degrés: 'p', jardins: 'p',
};

const firstWord = (name: string) => name.split(/[\s']/)[0]!.toLowerCase();
const elides = (word: string) => /^[aeiouyàâéèêëîïôûœ]/i.test(word);

/**
 * Ce qui fait qu'un nom de voie est le même qu'un autre. OpenStreetMap écrit
 * « Montée Saint-Barthélémy » sur deux tronçons et « Montée Saint Barthélémy »
 * sur le troisième : une même rue, que l'itinéraire ne doit pas citer deux fois.
 */
export function streetKey(name: string): string {
  return name
    .normalize('NFD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[-'’.]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** « Montée Saint-Barthélémy » → « montée Saint-Barthélémy » ; un nom sans mot de voie reste tel quel. */
export function streetName(osmName: string): string {
  const name = osmName.trim();
  const word = firstWord(name);
  return word in GENERIC ? `${name[0]!.toLowerCase()}${name.slice(1)}` : name;
}

/** « la montée Saint-Barthélémy », « le chemin de Montauban », « l'allée du Rosaire ». */
export function withArticle(name: string): string {
  const word = firstWord(name);
  const g = GENERIC[word];
  if (!g) return name;
  if (g === 'p') return `les ${name}`;
  if (elides(word)) return `l'${name}`;
  return `${g === 'f' ? 'la' : 'le'} ${name}`;
}

// ─────────────────────────────────────────────────────────────────────────────
// Le sol
// ─────────────────────────────────────────────────────────────────────────────

const KIND_FR: Record<GroundKind, string> = { route: 'route', chemin: 'chemin', sentier: 'sentier', escalier: 'escalier' };

/** Les marches d'un tronçon : leur longueur, et leur nombre quand OpenStreetMap le donne. */
export function stairsOf(g: StretchGround | undefined): { lengthM: number; steps: number } {
  const runs = g?.runs.filter((r) => r.kind === 'escalier') ?? [];
  return {
    lengthM: runs.reduce((s, r) => s + r.lengthM, 0),
    steps: runs.reduce((s, r) => s + (r.steps ?? 0), 0),
  };
}

/** Ce que disent les trottoirs de la voie qui domine. */
function sidewalks(g: StretchGround, kind: GroundKind): string {
  const on = g.runs.filter((r) => r.kind === kind);
  const long = (tag: string) => on.filter((r) => r.sidewalk === tag).reduce((s, r) => s + r.lengthM, 0);
  const total = on.reduce((s, r) => s + r.lengthM, 0);
  if (total <= 0) return '';
  if (long('both') >= total * 0.5) return ', trottoirs des deux côtés';
  if (long('both') + long('separate') + long('sidewalk') >= total * 0.5) return ', avec trottoirs';
  if (long('left') + long('right') >= total * 0.5) return ", trottoir d'un côté";
  return '';
}

/**
 * Le sol d'un tronçon en une ligne : « route en asphalte, trottoirs des deux
 * côtés » quand une nature domine, sinon ses parts dans l'ordre où on les
 * rencontre — « 90 m de route en asphalte, 260 m d'escalier (562 marches) ».
 */
export function groundText(g: StretchGround | undefined): string {
  if (!g || g.runs.length === 0) return '';
  const parts: { kind: GroundKind; surface?: string; lengthM: number; steps: number }[] = [];
  for (const r of g.runs) {
    const same = parts.find((p) => p.kind === r.kind && p.surface === r.surface);
    if (same) {
      same.lengthM += r.lengthM;
      same.steps += r.steps ?? 0;
    } else {
      parts.push({ kind: r.kind, ...(r.surface ? { surface: r.surface } : {}), lengthM: r.lengthM, steps: r.steps ?? 0 });
    }
  }
  const total = parts.reduce((s, p) => s + p.lengthM, 0);
  const phrase = (p: (typeof parts)[number]) =>
    `${KIND_FR[p.kind]}${p.surface ? ` en ${p.surface}` : ''}${p.kind === 'escalier' && p.steps > 0 ? ` (${p.steps} marches)` : ''}`;
  const main = parts.find((p) => p.lengthM >= total * 0.9);
  if (main) return `${phrase(main)}${sidewalks(g, main.kind)}`;
  return parts
    .filter((p) => p.lengthM >= Math.min(20, total * 0.05))
    .map((p) => `${Math.max(5, Math.round(p.lengthM / 5) * 5)} m ${elides(KIND_FR[p.kind]) ? "d'" : 'de '}${phrase(p)}`)
    .join(', ');
}

// ─────────────────────────────────────────────────────────────────────────────
// La consigne, dite comme un itinéraire
// ─────────────────────────────────────────────────────────────────────────────

/** « 3 min », « 90 s », « 1 min 30 » : une durée qu'on dit en courant. */
function spoken(seconds: number): string {
  const s = Math.round(seconds);
  if (s < 60) return `${s} s`;
  const m = Math.floor(s / 60);
  const r = s % 60;
  return r === 0 ? `${m} min` : `${m} min ${String(r).padStart(2, '0')}`;
}

/** Le numéro et la voie d'une adresse : « 49 montée Saint-Barthélémy » → 49, « montée Saint-Barthélémy ». */
function splitAddress(address: string): { number: string | null; street: string } {
  const m = address.match(/^(\d+\s?(?:bis|ter)?)\s+(.*)$/i);
  return m ? { number: m[1]!, street: m[2]! } : { number: null, street: address };
}

/**
 * Une adresse écrite avec la variante du nom que la séance emploie déjà :
 * « 49 montée Saint Barthélémy » sur un tronçon de la montée Saint-Barthélémy
 * devient « 49 montée Saint-Barthélémy ».
 */
export function canonicalAddress(address: string, names: readonly string[]): string {
  const { number, street } = splitAddress(address);
  const variant = names.find((n) => streetKey(n) === streetKey(street));
  return variant ? (number ? `${number} ${variant}` : variant) : address;
}

/** La montée qu'on court se nomme-t-elle comme cette voie ? */
const onClimb = (street: string, w: TerrainStretch) => streetKey(w.climb).endsWith(streetKey(street));

/**
 * L'adresse d'un point quand elle en dit plus que la voie qu'on court : un
 * numéro — « au n° 49 » sur la montée même —, ou une autre voie.
 */
function landmark(p: TerrainPoint, w: TerrainStretch): string | null {
  if (!p.address) return null;
  const { number, street } = splitAddress(p.address);
  if (number) return onClimb(street, w) ? `au n° ${number}` : `au ${p.address}`;
  // La voie qu'on court ne situe rien sur elle-même.
  if (onClimb(street, w)) return null;
  const a = withArticle(street);
  return a.startsWith('le ') ? `au ${a.slice(3)}` : a.startsWith('les ') ? `aux ${a.slice(4)}` : `à ${a}`;
}

/** Ce qu'il faut d'un bloc pour dire son itinéraire — celui d'une séance comme celui que lit l'écran. */
export interface ItineraryBlock {
  where?: TerrainStretch;
  durationS?: number;
  elevationGainM?: number;
  recovery?: { elevationGainM?: number; elevationLossM?: number; betweenReps?: boolean } | null;
}

/** Combien de fois un bloc parcourt sa montée entière : son dénivelé, rapporté à celui de la montée. */
function passagesOf(b: ItineraryBlock, w: TerrainStretch): number {
  const perPassage = w.grade * w.lengthM;
  return perPassage > 0 ? Math.max(1, Math.round((b.elevationGainM ?? 0) / perPassage)) : 1;
}

/**
 * Ce que fait un bloc sur son tronçon, dit comme on le court : « Monte la
 * montée Saint-Barthélémy jusqu'en haut, au n° 49. », « Descends 3 min jusqu'à
 * la rue François Vernay, fais demi-tour, remonte en marchant entre les
 * descentes. »
 *
 * Aucune position relative : on se repère à la voie, aux adresses et à la carte,
 * pas à « 510 m à l'ouest ». Vide pour un bloc qu'aucun tronçon ne situe.
 */
export function itinerary(b: ItineraryBlock): string {
  const w = b.where;
  if (!w) return '';
  const { from, to } = w;
  const cap = (s: string) => `${s[0]!.toUpperCase()}${s.slice(1)}`;
  const mark = landmark(to, w);
  const top = mark ? `, ${mark}` : '';

  // La montée entière : l'échauffement qui mène au haut, ou les passages d'une rando-course.
  if (from.role === 'pied' && to.role === 'haut') {
    const n = passagesOf(b, w);
    return n > 1
      ? `Monte ${w.climb} jusqu'en haut${top}, redescends au pied, ${n} fois.`
      : `Monte ${w.climb} jusqu'en haut${top}.`;
  }

  // La dernière descente ne remonte pas quand la remontée sépare les descentes :
  // la séance rentre alors par le bas.
  const back = b.recovery
    ? climbsBack(b.recovery)
      ? `remonte en marchant${b.recovery.betweenReps ? ' entre les descentes' : ''}`
      : (b.recovery.elevationLossM ?? 0) > 0
        ? 'redescends en trottinant'
        : 'récupère'
    : '';
  const time = b.durationS ? ` ${spoken(b.durationS)}` : '';

  if (from.role === 'haut' && to.role === 'demi-tour') {
    return `Descends${time}${mark ? ` jusqu'${mark}` : ''}, fais demi-tour${back ? `, ${back}` : ''}.`;
  }
  if (from.role === 'pied' && to.role === 'demi-tour') {
    return `Monte${time} depuis le pied${mark ? ` jusqu'${mark}` : ''}, fais demi-tour${back ? `, ${back}` : ''}.`;
  }
  if (from.role === 'demi-tour' && to.role === 'pied') {
    return `Après la dernière descente, continue de descendre jusqu'en bas${top}.`;
  }
  return cap(stretchSpan(w)) + '.';
}
