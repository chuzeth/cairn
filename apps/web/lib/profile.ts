/**
 * Le profil de la séance : le temps en abscisse, le relief en ordonnée.
 *
 * Il se calcule sur les blocs réels — durées, répétitions, récupérations,
 * dénivelé — et jamais sur un tracé figé : c'est la même structure qui produit
 * la charge prévue, la ligne de consigne sous le dessin et la forme qu'on lit
 * au réveil. Un tracé décoratif finirait par contredire la séance qu'il illustre.
 *
 * Deux reliefs, un seul tracé. La montée en est un : elle se dessine en pente,
 * et l'ocre lui est réservé. L'intensité en est un autre : elle se dessine en
 * palier, marche verticale à chaque changement de zone. Une séance de seuil sur
 * terrain plat a une forme — un banc bas, trois plateaux hauts — là où un profil
 * purement altimétrique l'aurait dessinée comme une ligne morte, impossible à
 * distinguer d'un décrassage. C'est la réponse à la seule chose que la maquette
 * laissait ouverte.
 *
 * La hauteur n'a pas d'unité et le dessin n'a pas d'axe vertical : le nombre est
 * dans la légende, jamais dans le trait. C'est ce qui autorise le tracé à
 * remplir sa boîte quelles que soient les valeurs — et ce qui interdit de lire
 * une dent comme une mesure.
 */
import type { SessionRow } from './api';

type Block = SessionRow['blocks'][number];

/** Hauteur propre d'une zone : l'effort est un relief, du plat de la Z1 au mur de la Z5. */
const ZONE_LEVEL: Record<string, number> = { Z1: 0, Z2: 0.25, Z3: 0.5, Z4: 0.75, Z5: 1 };

/**
 * Part de la hauteur qui revient à chacun des deux reliefs. La montée pèse le
 * double de la zone : un jour de côtes doit se reconnaître à ses dents, pas à
 * ses paliers. Sur une séance sans dénivelé, la part de la montée vaut zéro et
 * le tracé s'étire sur les seuls paliers — c'est le même calcul, pas un repli.
 */
const ZONE_SHARE = 0.34;
const CLIMB_SHARE = 0.66;

/** Ce qui fait d'un bloc le corps de la séance, et non son entrée ou sa sortie. */
const isWork = (b: Block) =>
  (b.repeat ?? 0) > 1 ||
  (ZONE_LEVEL[b.zone] ?? 0) >= 0.5 ||
  (b.elevationGainM ?? 0) >= 50 ||
  (b.elevationLossM ?? 0) >= 50;

const isEasy = (b: Block) => !b.repeat && (ZONE_LEVEL[b.zone] ?? 0) <= 0.25;

/**
 * Un échauffement est une minorité du temps de la séance.
 *
 * Sans cette part, le corps d'une sortie longue — un bloc facile de soixante-
 * quinze minutes qui porte les 460 m de la journée — se ferait prendre pour un
 * échauffement et la sortie se dessinerait plate.
 */
const MAX_WARMUP_SHARE = 0.5;

export interface Leg {
  /** Bloc d'origine, pour relier le tracé à la ligne de consigne. */
  block: number;
  durationS: number;
  gainM: number;
  lossM: number;
  zone: string;
  /** Une récupération n'est pas du travail : elle redescend ce que la répétition a monté. */
  recovery: boolean;
  /**
   * Échauffement et retour au calme se dessinent à plat. Leur dénivelé existe et
   * reste compté, mais dessiné il ferait de l'échauffement le point haut d'une
   * séance de seuil — l'emphase à l'envers, sur la partie qui ne décide de rien.
   */
  flat: boolean;
}

/**
 * Trois registres, trois traits.
 *
 * `climb` monte : c'est le seul à porter l'ocre. `work` est le corps de la
 * séance là où il ne monte pas — le plateau d'un seuil sur terrain plat, qui
 * doit se voir. `ease` est tout le reste : échauffement, récupération, retour
 * au calme, et les marches verticales d'un changement de zone.
 */
export type SegmentTone = 'climb' | 'work' | 'ease';

export interface ProfileSegment {
  x0: number; y0: number; x1: number; y1: number;
  tone: SegmentTone;
}

export interface SessionProfile {
  legs: Leg[];
  totalS: number;
  /** Segments en coordonnées normalisées : x fraction du temps, y de 0 (bas) à 1 (haut). */
  segments: ProfileSegment[];
  /** Repères de l'abscisse : le zéro, les bornes du corps de séance, la fin. */
  marks: { at: number; seconds: number }[];
  /** Dénivelé du corps de séance, celui que le tracé montre. */
  drawnGainM: number;
  drawnLossM: number;
  /** Dénivelé total déclaré, échauffement compris. */
  gainM: number;
  lossM: number;
  /** Ce que la légende dit du relief, et si elle parle d'une montée. */
  caption: string;
  captionIsClimb: boolean;
  /** Hauteur atteinte par le tracé, pour recadrer une séance qui ne monte nulle part. */
  height: number;
}

/**
 * Déplie les blocs en segments de temps réels.
 *
 * Une répétition et sa récupération alternent autant de fois que le bloc se
 * répète, récupération comprise après la dernière : c'est ainsi que la durée
 * prévue de la séance se retrouve, et la contredire décalerait l'abscisse.
 */
export function legsOf(session: Pick<SessionRow, 'blocks'>): Leg[] {
  const blocks = session.blocks ?? [];
  const last = blocks.length - 1;
  const span = (b: Block) =>
    ((b.durationS ?? 0) + (b.recovery?.durationS ?? 0)) * Math.max(1, b.repeat ?? 1);
  const total = blocks.reduce((a, b) => a + span(b), 0);
  const brief = (b: Block) => total > 0 && span(b) < total * MAX_WARMUP_SHARE;
  const warmup =
    blocks.length >= 2 && isEasy(blocks[0]!) && brief(blocks[0]!) && blocks.slice(1).some(isWork) ? 0 : -1;
  const cooldown =
    blocks.length >= 2 && isEasy(blocks[last]!) && brief(blocks[last]!) && blocks.slice(0, last).some(isWork)
      ? last
      : -1;

  const legs: Leg[] = [];
  blocks.forEach((b, i) => {
    const durationS = b.durationS ?? 0;
    if (durationS <= 0) return;
    const flat = i === warmup || i === cooldown;
    const n = Math.max(1, b.repeat ?? 1);
    const r = b.recovery;
    // Ce qui monte redescend. Une répétition qui gagne 26 m et dont la
    // récupération ne déclare rien redescend par elle : sans cette fermeture,
    // huit côtes dessineraient un escalier de 208 m que personne ne monte.
    const recGain = r ? r.elevationGainM ?? (r.elevationLossM == null ? b.elevationLossM ?? 0 : 0) : 0;
    const recLoss = r ? r.elevationLossM ?? (r.elevationGainM == null ? b.elevationGainM ?? 0 : 0) : 0;

    for (let k = 0; k < n; k++) {
      legs.push({
        block: i, durationS, zone: b.zone, recovery: false, flat,
        gainM: b.elevationGainM ?? 0, lossM: b.elevationLossM ?? 0,
      });
      if (r && r.durationS > 0) {
        legs.push({
          block: i, durationS: r.durationS, zone: r.zone, recovery: true, flat,
          gainM: recGain, lossM: recLoss,
        });
      }
    }
  });
  return legs;
}

const NUMBERS = ['zéro', 'une', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix', 'onze', 'douze'];

/**
 * Les mètres à la française : espace insécable, jamais de virgule.
 *
 * L'espace fine (U+202F) serait la bonne, mais Archivo la dessine à un pixel :
 * « 1 010 m » se lirait « 1010 m » sur le tracé, à onze pixels de corps.
 */
export const metres = (m: number): string =>
  `${String(Math.round(m)).replace(/\B(?=(\d{3})+(?!\d))/g, '\u00a0')}\u00a0m`;

export function sessionProfile(session: Pick<SessionRow, 'blocks'>): SessionProfile {
  const legs = legsOf(session);
  const totalS = legs.reduce((a, l) => a + l.durationS, 0);

  const gainM = legs.reduce((a, l) => a + l.gainM, 0);
  const lossM = legs.reduce((a, l) => a + l.lossM, 0);
  const drawn = legs.filter((l) => !l.flat);
  const drawnGainM = drawn.reduce((a, l) => a + l.gainM, 0);
  const drawnLossM = drawn.reduce((a, l) => a + l.lossM, 0);

  // Altitude cumulée, puis ramenée à sa propre amplitude : le dessin n'a pas
  // d'axe vertical, donc pas d'échelle à trahir.
  const alts: number[] = [0];
  let alt = 0;
  for (const l of legs) {
    alt += l.flat ? 0 : l.gainM - l.lossM;
    alts.push(alt);
  }
  const span = Math.max(...alts) - Math.min(...alts);
  const floor = Math.min(...alts);
  const climbAt = (i: number) => (span > 0 ? (alts[i]! - floor) / span : 0);

  const points: { x: number; y: number }[] = [];
  const tones: SegmentTone[] = [];
  let t = 0;
  legs.forEach((l, i) => {
    const level = ZONE_SHARE * (ZONE_LEVEL[l.zone] ?? 0);
    const from = { x: t, y: level + CLIMB_SHARE * climbAt(i) };
    t += l.durationS;
    const to = { x: t, y: level + CLIMB_SHARE * climbAt(i + 1) };
    // Un changement de zone est une marche, pas une pente : il ne prend pas de
    // temps. C'est ce qui empêche de lire un palier comme une colline.
    if (points.length > 0) tones.push('ease');
    points.push(from, to);
    tones.push(
      !l.flat && l.gainM > l.lossM ? 'climb' : !l.flat && !l.recovery ? 'work' : 'ease',
    );
  });

  // Le tracé remplit sa boîte. Une séance sans le moindre relief reste une
  // ligne basse, et non une ligne centrée qui ferait croire à une hauteur.
  const ys = points.map((p) => p.y);
  const lo = Math.min(...ys, 0);
  const hi = Math.max(...ys, 0);
  const fit = (y: number) => (hi - lo > 1e-6 ? (y - lo) / (hi - lo) : 0.12);

  const segments: ProfileSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    if (a.x === b.x && Math.abs(a.y - b.y) < 1e-9) continue;
    segments.push({
      x0: totalS > 0 ? a.x / totalS : 0, y0: fit(a.y),
      x1: totalS > 0 ? b.x / totalS : 0, y1: fit(b.y),
      tone: tones[i] ?? 'ease',
    });
  }

  // Les bornes : le zéro, l'entrée dans le corps de séance, sa sortie, la fin.
  const bounds = new Set<number>([0, totalS]);
  let cursor = 0;
  for (const l of legs) {
    const next = cursor + l.durationS;
    if (l.flat && cursor === 0) bounds.add(next);
    if (l.flat && next === totalS) bounds.add(cursor);
    cursor = next;
  }
  const marks = [...bounds]
    .sort((a, b) => a - b)
    .map((seconds) => ({ at: totalS > 0 ? seconds / totalS : 0, seconds }));

  const height = segments.reduce((a, g) => Math.max(a, g.y0, g.y1), 0);
  const floorY = segments.reduce((a, g) => Math.min(a, g.y0, g.y1), height);
  return {
    legs, totalS, segments, marks, height,
    gainM, lossM, drawnGainM, drawnLossM,
    ...caption(legs, drawnGainM, drawnLossM, height - floorY > 1e-6),
  };
}

/**
 * Ce que la légende dit du relief.
 *
 * Elle porte le nombre que le trait ne porte pas. Quand rien ne monte ni ne
 * descend, elle dit à quoi tient la hauteur — sans quoi un jour plat laisserait
 * lire ses paliers comme une montagne.
 */
function caption(
  legs: Leg[], gainM: number, lossM: number, relief: boolean,
): { caption: string; captionIsClimb: boolean } {
  const work = legs.filter((l) => !l.flat && !l.recovery);
  const up = work.filter((l) => l.gainM > l.lossM);
  const down = work.filter((l) => l.lossM > l.gainM);
  const repeated = (set: Leg[]) => set.length > 1 && set.every((l) => l.block === set[0]!.block);

  if (up.length > 0 && gainM >= lossM) {
    const per = up[0]!.gainM;
    if (repeated(up)) {
      const times = NUMBERS[up.length] ?? String(up.length);
      return { caption: `+${metres(per)}, ${times} fois`, captionIsClimb: true };
    }
    const total = up.reduce((a, l) => a + l.gainM, 0);
    const back = lossM >= total * 0.9 ? ` puis −${metres(lossM)}` : '';
    return { caption: `+${metres(total)}${back}`, captionIsClimb: true };
  }
  if (down.length > 0) {
    const per = down[0]!.lossM;
    if (repeated(down)) {
      const times = NUMBERS[down.length] ?? String(down.length);
      return { caption: `−${metres(per)}, ${times} fois`, captionIsClimb: false };
    }
    return { caption: `−${metres(down.reduce((a, l) => a + l.lossM, 0))}`, captionIsClimb: false };
  }
  // Un tracé qui ne varie pas non plus en hauteur n'a pas d'échelle à expliquer :
  // il n'y a ni relief ni changement d'intensité, et c'est tout ce qu'il dit.
  return {
    caption: relief ? "à plat : ici la hauteur est l'intensité" : 'à plat, d’un bout à l’autre',
    captionIsClimb: false,
  };
}
