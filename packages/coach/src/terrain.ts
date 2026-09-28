import type { ActivityStreams, ParameterProvenance, StretchGround, TerrainPoint, TerrainStretch } from '@cairn/core';
import { stairsOf, streetKey, streetName, viaStreets, withArticle } from '@cairn/core';
import { computeGrade, mean, quantile } from '@cairn/physiology';
import { distanceToTrack, groundBetween, nameOf, streetsOf, trackBetween, type MatchedTrack } from './ground.js';

/**
 * Le terrain.
 *
 * Cairn conserve la trace complète de chaque sortie — position, altitude,
 * fréquence cardiaque à la seconde — et n'en lisait que le temps et le
 * dénivelé cumulé. Le coach savait donc ce que Pierre a couru, jamais où. Ce
 * module extrait des flux les montées qu'il emprunte et les endroits d'où il
 * part, pour qu'une prescription de dénivelé puisse désigner une montée réelle
 * au lieu d'un nombre de mètres.
 *
 * Tout ici est pur : un flux entre, un résultat sort. Ni base, ni réseau. Le sol
 * d'une montée arrive déjà calé sur OpenStreetMap (`ground.ts`), lu ailleurs.
 *
 * **Rien n'est inventé.** Une montée se nomme par la voie qu'OpenStreetMap
 * place sous sa trace, jamais par un toponyme deviné : sans voie relevée, elle
 * s'identifie par ses chiffres et les titres des activités où elle apparaît —
 * « KV de Rochefort » est un nom que Strava porte, pas un lieu que nous aurions
 * résolu. Ce qui est mesuré au GPS porte la provenance `field` : c'est du
 * terrain, jamais du laboratoire.
 */

/** Dénivelé minimal pour qu'une montée compte comme telle, m. */
export const CLIMB_MIN_GAIN_M = 30;

/** Pente moyenne minimale d'une montée, fraction (0.03 = 3 %). */
export const CLIMB_MIN_GRADE = 0.03;

/** Au-delà de cette distance sans monter, la montée est terminée, m. */
export const CLIMB_BREAK_M = 50;

/**
 * Sous cette pente, l'échantillon ne monte pas : c'est du replat.
 *
 * Plus basse que la pente moyenne exigée, et pour une raison : une montée à 3 %
 * de moyenne passe par des portions à 2,5 %, et un seuil de continuation placé
 * à 3 % la découperait en morceaux dont aucun n'atteindrait 30 m de gain.
 */
const CLIMB_HOLD_GRADE = 0.02;

/** Fenêtre de calcul de la pente, m — celle du reste du moteur. */
const GRADE_WINDOW_M = 30;

/**
 * Une montée soutenue, telle qu'une trace la donne.
 *
 * Distincte du `Climb` de la bibliothèque de séances, qui est une montée
 * prescrite : celle-ci a été courue, et porte ce qu'on en a mesuré.
 */
export interface MeasuredClimb {
  /** Indices du bas et du sommet dans le flux. */
  startIndex: number;
  endIndex: number;
  /** Coordonnées du bas de la montée, si la trace en porte. */
  start: [number, number] | null;
  /** Coordonnées du sommet, si la trace en porte. */
  top: [number, number] | null;
  startAltitudeM: number;
  /** Distance parcourue du bas au sommet, m. */
  lengthM: number;
  /** Dénivelé net, m. */
  gainM: number;
  /** Pente moyenne, fraction. */
  grade: number;
  /** Durée en mouvement, s — une pause au sommet ne gonfle pas la montée. */
  durationS: number;
  /** Vitesse ascensionnelle, m D+/h. */
  vamMh: number;
  /** FC moyenne sur la montée, null si la trace n'en porte pas. */
  avgHr: number | null;
  /**
   * Le profil du pied au sommet, un point tous les 5 m. C'est lui qui situe un
   * point de la montée par son dénivelé : le demi-tour d'une descente de 78 m
   * est à 405 m sous le haut, à 19 %, là où la pente moyenne de la montée en
   * aurait annoncé 610 à 13 %.
   */
  profile: ProfilePoint[];
  provenance: ParameterProvenance;
}

/** Un point du profil d'une montée : distance depuis le pied, altitude, position. */
export interface ProfilePoint {
  d: number;
  z: number;
  at: [number, number] | null;
}

/** Pas du profil conservé, m : de quoi situer un demi-tour au mètre près sans garder la trace. */
const PROFILE_STEP_M = 5;

/**
 * Extrait les montées soutenues d'une trace.
 *
 * Une montée court tant que l'athlète monte, et survit à un replat court : ce
 * sont plus de 50 m sans gagner d'altitude qui la coupent. Une descente y coupe
 * aussi, par la même règle — un col suivi d'un creux puis d'une seconde rampe
 * fait deux montées, pas une.
 *
 * La durée retenue est le temps en mouvement. Un arrêt n'avance pas la
 * distance, donc ne coupe pas la montée ; il ne doit pas non plus écraser la
 * vitesse ascensionnelle, qui mesure comment il grimpe et non combien il
 * s'arrête.
 */
export function detectClimbs(stream: ActivityStreams): MeasuredClimb[] {
  const { distance, altitude, time } = stream;
  const n = Math.min(distance.length, altitude.length, time.length);
  if (n < 2) return [];

  const grade =
    stream.grade.length >= n ? stream.grade : computeGrade(distance, altitude, GRADE_WINDOW_M);

  const climbs: MeasuredClimb[] = [];
  let foot = -1; // bas de la montée en cours
  let top = -1; // dernier échantillon clairement montant
  let flatM = 0;

  for (let i = 1; i < n; i++) {
    const rising = (grade[i] ?? 0) >= CLIMB_HOLD_GRADE;
    if (rising) {
      if (foot < 0) foot = i - 1;
      top = i;
      flatM = 0;
      continue;
    }
    if (foot < 0) continue;
    flatM += (distance[i] as number) - (distance[i - 1] as number);
    if (flatM > CLIMB_BREAK_M) {
      const climb = measureClimb(stream, foot, top);
      if (climb) climbs.push(climb);
      foot = -1;
      top = -1;
      flatM = 0;
    }
  }
  if (foot >= 0 && top > foot) {
    const climb = measureClimb(stream, foot, top);
    if (climb) climbs.push(climb);
  }
  return climbs;
}

/** Mesure une montée délimitée, ou `null` si elle n'en est pas une. */
function measureClimb(stream: ActivityStreams, foot: number, top: number): MeasuredClimb | null {
  if (top <= foot) return null;
  const { distance, altitude, time } = stream;
  const lengthM = (distance[top] as number) - (distance[foot] as number);
  const gainM = (altitude[top] as number) - (altitude[foot] as number);
  if (lengthM <= 0 || gainM < CLIMB_MIN_GAIN_M) return null;
  const grade = gainM / lengthM;
  if (grade < CLIMB_MIN_GRADE) return null;

  // Temps en mouvement, avec repli sur le temps écoulé quand la trace ne dit
  // pas le mouvement. Une montée sans durée n'est pas mesurable : on la jette
  // plutôt que d'en tirer une vitesse ascensionnelle infinie.
  let movingS = 0;
  for (let i = foot + 1; i <= top; i++) {
    if (stream.moving && stream.moving[i] === false) continue;
    movingS += (time[i] as number) - (time[i - 1] as number);
  }
  const durationS = movingS > 0 ? movingS : (time[top] as number) - (time[foot] as number);
  if (durationS <= 0) return null;

  const hr = stream.heartrate ? mean(stream.heartrate.slice(foot, top + 1)) : null;

  const profile: ProfilePoint[] = [];
  const from = distance[foot] as number;
  for (let i = foot; i <= top; i++) {
    const d = (distance[i] as number) - from;
    const last = profile[profile.length - 1];
    if (last && d - last.d < PROFILE_STEP_M && i < top) continue;
    const p = stream.latlng?.[i];
    profile.push({
      d: Math.round(d * 10) / 10,
      z: Math.round((altitude[i] as number) * 10) / 10,
      at: p ? [p[0], p[1]] : null,
    });
  }

  return {
    startIndex: foot,
    endIndex: top,
    start: firstFix(stream.latlng, foot, top),
    top: lastFix(stream.latlng, foot, top),
    startAltitudeM: Math.round(altitude[foot] as number),
    lengthM: Math.round(lengthM),
    gainM: Math.round(gainM),
    grade: Math.round(grade * 1000) / 1000,
    durationS: Math.round(durationS),
    vamMh: Math.round((gainM / durationS) * 3600),
    avgHr: hr == null ? null : Math.round(hr),
    profile,
    provenance: 'field',
  };
}

/** Dernière position relevée entre deux indices. */
function lastFix(
  latlng: ActivityStreams['latlng'],
  from: number,
  to: number,
): [number, number] | null {
  if (!latlng) return null;
  for (let i = Math.min(to, latlng.length - 1); i >= from; i--) {
    const p = latlng[i];
    if (p) return [p[0], p[1]];
  }
  return null;
}

/** Première position relevée entre deux indices — le GPS accroche parfois tard. */
function firstFix(
  latlng: ActivityStreams['latlng'],
  from: number,
  to: number,
): [number, number] | null {
  if (!latlng) return null;
  for (let i = from; i <= to && i < latlng.length; i++) {
    const p = latlng[i];
    if (p) return [p[0], p[1]];
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// Montées récurrentes
// ─────────────────────────────────────────────────────────────────────────────

/** Rayon sous lequel deux montées partent du même endroit, m. */
export const SAME_START_M = 80;

/** Rapport de longueur sous lequel deux montées ne sont plus la même. */
export const SAME_LENGTH_RATIO = 0.75;

/** Sorties minimales sous lesquelles une tendance ne veut rien dire. */
const TREND_MIN_OUTINGS = 3;

/** Écart relatif sous lequel deux VAM médianes se valent. */
const TREND_BAND = 0.03;

/** Une montée, rattachée à la sortie où elle a été mesurée. */
export interface ClimbOccurrence extends MeasuredClimb {
  activityId: string;
  /** Titre de l'activité, tel que Strava le porte. */
  activityName: string;
  /** Jour de la sortie, YYYY-MM-DD. */
  date: string;
}

export interface RecurringClimb {
  /** Départ retenu : la médiane des passages. */
  start: [number, number];
  /** Longueur, dénivelé et pente médians des passages. */
  lengthM: number;
  gainM: number;
  grade: number;
  /** Nombre de montées, toutes sorties confondues. */
  passages: number;
  /** Nombre de sorties distinctes — deux répétitions le même jour font une sortie. */
  outings: number;
  firstDate: string;
  lastDate: string;
  /** Meilleure vitesse ascensionnelle mesurée, et le passage qui la porte. */
  bestVamMh: number;
  best: ClimbOccurrence;
  /**
   * Le dernier passage : c'est son chemin qu'une séance désigne — le haut, le
   * demi-tour —, celui que l'athlète a pris le plus récemment.
   */
  latest: ClimbOccurrence;
  medianVamMh: number;
  /** Sens de la meilleure VAM par sortie au fil du temps. */
  trend: 'up' | 'flat' | 'down' | 'unknown';
  /** Titres des activités où elle apparaît — ce sont eux qui la nomment. */
  activityNames: string[];
  occurrences: ClimbOccurrence[];
  provenance: ParameterProvenance;
  /**
   * Le chemin du dernier passage, calé sur les voies d'OpenStreetMap. Absent :
   * personne ne l'a lu ; `null` : la lecture a échoué. Dans les deux cas, rien
   * ne dit que la montée est sans marches.
   */
  ground?: MatchedTrack | null;
}

/**
 * Regroupe les montées de plusieurs sorties en montées récurrentes.
 *
 * Deux montées sont la même quand elles partent du même endroit à 80 m près,
 * que leurs longueurs sont comparables et qu'elles suivent le même chemin : le
 * rayon seul confondrait la côte de dix minutes et le col d'une heure qui
 * commencent au même carrefour ; départ et longueur seuls réunissaient la
 * montée Saint-Barthélémy et les escaliers de la montée Nicolas de Lange, qui
 * partent tous deux du quai et montent tous deux à Fourvière.
 *
 * Une montée vue une seule fois n'est pas récurrente et ne sort pas d'ici.
 */
export function groupRecurring(climbs: readonly ClimbOccurrence[]): RecurringClimb[] {
  const located = climbs.filter((c) => c.start != null);
  const ordered = [...located].sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      a.activityId.localeCompare(b.activityId) ||
      a.startIndex - b.startIndex,
  );

  // Agrégation par chef de file : chaque montée rejoint le premier groupe dont
  // le fondateur lui ressemble, sinon elle en fonde un.
  const groups: ClimbOccurrence[][] = [];
  for (const climb of ordered) {
    const group = groups.find((g) => sameClimb(g[0] as ClimbOccurrence, climb));
    if (group) group.push(climb);
    else groups.push([climb]);
  }

  return groups
    .filter((g) => g.length >= 2)
    .map(summarizeGroup)
    .sort((a, b) => b.passages - a.passages || b.gainM - a.gainM);
}

/** Même départ, longueur comparable, même chemin. */
function sameClimb(a: ClimbOccurrence, b: ClimbOccurrence): boolean {
  if (!a.start || !b.start) return false;
  if (haversineM(a.start, b.start) > SAME_START_M) return false;
  const ratio = Math.min(a.lengthM, b.lengthM) / Math.max(a.lengthM, b.lengthM);
  return ratio >= SAME_LENGTH_RATIO && samePath(a, b);
}

/** Écart au-delà duquel un passage a quitté le chemin d'un autre, m : une rue plus loin. */
export const SAME_PATH_M = 40;

/**
 * Le plus court des deux passages suit-il le chemin du plus long ? Lu au quart,
 * à la moitié, aux trois quarts et au bout. Sans profil positionné — une trace
 * sans GPS —, rien ne permet d'en douter.
 */
function samePath(a: ClimbOccurrence, b: ClimbOccurrence): boolean {
  const [short, long] = a.lengthM <= b.lengthM ? [a, b] : [b, a];
  const path = long.profile.flatMap((p) => (p.at ? [p.at] : []));
  const own = short.profile.filter((p) => p.at != null);
  if (path.length < 2 || own.length < 2) return true;
  const end = own[own.length - 1]!.d;
  return [0.25, 0.5, 0.75, 1].every((f) => {
    const p = own.find((q) => q.d >= f * end) ?? own[own.length - 1]!;
    return distanceToTrack(p.at!, path) <= SAME_PATH_M;
  });
}

function summarizeGroup(group: ClimbOccurrence[]): RecurringClimb {
  const starts = group.map((c) => c.start as [number, number]);
  const dates = group.map((c) => c.date).sort();
  const best = group.reduce((a, b) => (b.vamMh > a.vamMh ? b : a));
  const lastDate = dates[dates.length - 1] as string;
  const latest = group.filter((c) => c.date === lastDate).reduce((a, b) => (b.vamMh > a.vamMh ? b : a));
  const lengthM = Math.round(quantile(group.map((c) => c.lengthM), 0.5));
  const gainM = Math.round(quantile(group.map((c) => c.gainM), 0.5));
  const outings = new Set(group.map((c) => c.activityId));

  return {
    start: [
      Math.round(quantile(starts.map((p) => p[0]), 0.5) * 1e6) / 1e6,
      Math.round(quantile(starts.map((p) => p[1]), 0.5) * 1e6) / 1e6,
    ],
    lengthM,
    gainM,
    grade: lengthM > 0 ? Math.round((gainM / lengthM) * 1000) / 1000 : 0,
    passages: group.length,
    outings: outings.size,
    firstDate: dates[0] as string,
    lastDate,
    bestVamMh: best.vamMh,
    best,
    latest,
    medianVamMh: Math.round(quantile(group.map((c) => c.vamMh), 0.5)),
    trend: trendOf(group),
    activityNames: [...new Set(group.map((c) => c.activityName))],
    occurrences: group,
    provenance: 'field',
  };
}

/**
 * Sens de la progression sur une montée.
 *
 * Mesuré sur la **meilleure** VAM de chaque sortie, jamais sur tous les
 * passages : dans une séance de côtes, la cinquième répétition est plus lente
 * que la première, et compter les deux ferait passer une bonne séance pour une
 * régression. En dessous de trois sorties il n'y a pas de tendance, seulement
 * deux points : on le dit plutôt que d'en inventer une.
 */
function trendOf(group: readonly ClimbOccurrence[]): RecurringClimb['trend'] {
  const byOuting = new Map<string, { date: string; vamMh: number }>();
  for (const c of group) {
    const seen = byOuting.get(c.activityId);
    if (!seen || c.vamMh > seen.vamMh) byOuting.set(c.activityId, { date: c.date, vamMh: c.vamMh });
  }
  const series = [...byOuting.values()].sort((a, b) => a.date.localeCompare(b.date));
  if (series.length < TREND_MIN_OUTINGS) return 'unknown';

  const half = Math.floor(series.length / 2);
  const before = quantile(series.slice(0, half).map((s) => s.vamMh), 0.5);
  const after = quantile(series.slice(series.length - half).map((s) => s.vamMh), 0.5);
  if (before <= 0) return 'unknown';
  const change = (after - before) / before;
  return change > TREND_BAND ? 'up' : change < -TREND_BAND ? 'down' : 'flat';
}

// ─────────────────────────────────────────────────────────────────────────────
// Terrains d'entraînement
// ─────────────────────────────────────────────────────────────────────────────

/** Rayon d'un terrain d'entraînement, m. */
export const HOME_GROUND_RADIUS_M = 1500;

/** Le départ d'une sortie, réduit à ce dont le regroupement a besoin. */
export interface OutingStart {
  activityId: string;
  date: string;
  start: [number, number];
  elevationGainM: number;
}

export interface HomeGround {
  /** Centre retenu : la médiane des départs. */
  center: [number, number];
  outings: number;
  firstDate: string;
  lastDate: string;
  /** Dénivelé médian d'une sortie partie d'ici — c'est ce que le terrain offre. */
  medianElevationGainM: number;
  activityIds: string[];
  provenance: ParameterProvenance;
}

/**
 * Les points de départ récurrents.
 *
 * À 1,5 km près : c'est la maille qui réunit les départs d'un même quartier
 * sans confondre deux vallées. Un départ unique n'est pas un terrain
 * d'entraînement et ne sort pas d'ici — un déplacement d'un week-end ne fait
 * pas une habitude.
 */
export function homeGrounds(outings: readonly OutingStart[]): HomeGround[] {
  const ordered = [...outings].sort(
    (a, b) => a.date.localeCompare(b.date) || a.activityId.localeCompare(b.activityId),
  );

  const groups: OutingStart[][] = [];
  for (const outing of ordered) {
    const group = groups.find(
      (g) => haversineM((g[0] as OutingStart).start, outing.start) <= HOME_GROUND_RADIUS_M,
    );
    if (group) group.push(outing);
    else groups.push([outing]);
  }

  return groups
    .filter((g) => g.length >= 2)
    .map((g) => {
      const dates = g.map((o) => o.date).sort();
      return {
        center: [
          Math.round(quantile(g.map((o) => o.start[0]), 0.5) * 1e6) / 1e6,
          Math.round(quantile(g.map((o) => o.start[1]), 0.5) * 1e6) / 1e6,
        ] as [number, number],
        outings: g.length,
        firstDate: dates[0] as string,
        lastDate: dates[dates.length - 1] as string,
        medianElevationGainM: Math.round(quantile(g.map((o) => o.elevationGainM), 0.5)),
        activityIds: g.map((o) => o.activityId),
        provenance: 'field' as ParameterProvenance,
      };
    })
    .sort((a, b) => b.outings - a.outings || b.medianElevationGainM - a.medianElevationGainM);
}

/** Distance orthodromique entre deux positions, m. */
export function haversineM(a: readonly [number, number], b: readonly [number, number]): number {
  const R = 6_371_000;
  const toRad = Math.PI / 180;
  const dLat = (b[0] - a[0]) * toRad;
  const dLng = (b[1] - a[1]) * toRad;
  const lat1 = a[0] * toRad;
  const lat2 = b[0] * toRad;
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(lat1) * Math.cos(lat2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(h)));
}

// ─────────────────────────────────────────────────────────────────────────────
// La montée où se court un dénivelé prescrit
// ─────────────────────────────────────────────────────────────────────────────

/** Ce que le planificateur sait du terrain de l'athlète. */
export interface TerrainHint {
  /** Montées récurrentes, mesurées sur ses traces. */
  climbs: readonly RecurringClimb[];
  /** Les boucles que ses montées forment : monter par l'une, redescendre par l'autre. */
  loops?: readonly ClimbLoop[];
  /** Son départ habituel : le centre du terrain le plus fréquenté. */
  home?: readonly [number, number];
}

// ─────────────────────────────────────────────────────────────────────────────
// Les traces, allégées
// ─────────────────────────────────────────────────────────────────────────────

/** Une sortie réduite à son tracé : un point tous les 5 m, positionné, avec son altitude. */
export interface LightTrace {
  activityId: string;
  date: string;
  /** Indice de chaque point dans le flux d'origine. */
  i: number[];
  /** Distance depuis le départ, m. */
  d: number[];
  z: number[];
  at: [number, number][];
}

/** Pas d'une trace allégée, m : celui du profil d'une montée. */
const LIGHT_STEP_M = 5;

/** La trace d'une sortie, un point positionné tous les 5 m. */
export function lightTrace(activityId: string, date: string, stream: ActivityStreams): LightTrace {
  const out: LightTrace = { activityId, date, i: [], d: [], z: [], at: [] };
  const n = Math.min(stream.distance.length, stream.altitude.length);
  let last = -Infinity;
  for (let k = 0; k < n; k++) {
    const p = stream.latlng?.[k];
    const d = stream.distance[k] as number;
    if (!p || d - last < LIGHT_STEP_M) continue;
    out.i.push(k);
    out.d.push(d);
    out.z.push(stream.altitude[k] as number);
    out.at.push([p[0], p[1]]);
    last = d;
  }
  return out;
}

/**
 * Ce qu'un profil monte et descend, sans le bruit de l'altimètre : une variation
 * ne compte qu'une fois qu'elle dépasse `threshold` mètres depuis le dernier
 * sommet ou le dernier creux.
 */
export function climbAndDrop(z: readonly number[], threshold = 2): { gainM: number; lossM: number } {
  let gainM = 0;
  let lossM = 0;
  let ref = z[0];
  if (ref == null) return { gainM, lossM };
  for (const v of z) {
    if (v - ref >= threshold) {
      gainM += v - ref;
      ref = v;
    } else if (ref - v >= threshold) {
      lossM += ref - v;
      ref = v;
    }
  }
  return { gainM: Math.round(gainM), lossM: Math.round(lossM) };
}

// ─────────────────────────────────────────────────────────────────────────────
// Les boucles
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le chemin d'un haut à l'autre, tel que l'athlète l'a couru : un morceau de sa
 * trace. Le moteur d'itinéraire n'y passe pas toujours — il ne connaît pas le
 * passage par l'esplanade de Fourvière, et y fait 1,6 km de détour quand Pierre
 * y met 636 m.
 */
export interface LoopCrossing {
  activityId: string;
  date: string;
  /** Indices du départ et de l'arrivée dans le flux d'origine. */
  startIndex: number;
  endIndex: number;
  /** Depuis le haut de la montée qu'on vient de monter, un point tous les 5 m. */
  profile: ProfilePoint[];
  lengthM: number;
  gainM: number;
  lossM: number;
  /** Le chemin calé sur OpenStreetMap ; absent ou `null` : son sol n'est pas connu. */
  ground?: MatchedTrack | null;
}

/** Une boucle : on monte par `up`, on passe d'un haut à l'autre par `over`, on redescend par `down`. */
export interface ClimbLoop {
  up: RecurringClimb;
  down: RecurringClimb;
  over: LoopCrossing;
}

/** Deux pieds à moins de 60 m l'un de l'autre sont le même départ : on revient là d'où l'on est parti. */
export const LOOP_FEET_M = 60;
/** Au-delà, deux hauts ne sont plus reliés par un chemin de crête. */
export const LOOP_TOPS_M = 1200;
/** Une trace passe par un haut quand elle en approche à 30 m. */
const CROSSING_REACH_M = 30;
/** Plus long, le passage d'un haut à l'autre n'est plus un raccord. */
const CROSSING_MAX_M = 1500;
/** Un raccord reste en haut : il ne redescend pas plus bas que ça sous le plus bas des deux hauts, m. */
const CROSSING_DIP_M = 25;

const footOf = (c: RecurringClimb): [number, number] => c.latest.start ?? c.start;

/** La même montée récurrente, qu'on la tienne de la même relève ou d'une copie : son dernier passage l'identifie. */
const sameClimbAs = (a: RecurringClimb, b: RecurringClimb) =>
  a === b || (a.latest.activityId === b.latest.activityId && a.latest.startIndex === b.latest.startIndex);

/** Deux raccords dont les longueurs diffèrent de moins que ça sont le même chemin, m. */
const SAME_CROSSING_M = 25;
/** Au-delà, un raccord de plus n'apprend rien : Overpass n'a pas à le lire. */
const MAX_CROSSINGS = 4;

/**
 * Les chemins que l'athlète a pris du haut de `up` au haut de `down`, lus sur
 * ses traces, du plus court au plus long — un par chemin, le plus récent. Le
 * plus court n'est pas toujours celui qu'une boucle peut prendre : celui du
 * 17/08 descend douze marches rue Roger-Radisson, celui du 11/08 non.
 */
export function crossingsOf(
  up: RecurringClimb,
  down: RecurringClimb,
  traces: readonly LightTrace[],
): LoopCrossing[] {
  const from = up.latest.top;
  const to = down.latest.top;
  if (!from || !to) return [];
  const found: LoopCrossing[] = [];
  for (const t of traces) {
    for (let a = 0; a < t.at.length; a++) {
      if (haversineM(t.at[a]!, from) > CROSSING_REACH_M) continue;
      // Le point le plus proche du haut, dans ce passage.
      while (a + 1 < t.at.length && haversineM(t.at[a + 1]!, from) < haversineM(t.at[a]!, from)) a++;
      let b = a + 1;
      while (b < t.at.length && t.d[b]! - t.d[a]! <= CROSSING_MAX_M && haversineM(t.at[b]!, to) > CROSSING_REACH_M) b++;
      if (b >= t.at.length || t.d[b]! - t.d[a]! > CROSSING_MAX_M) continue;
      while (b + 1 < t.at.length && haversineM(t.at[b + 1]!, to) < haversineM(t.at[b]!, to)) b++;
      const floor = Math.min(t.z[a]!, t.z[b]!) - CROSSING_DIP_M;
      if (t.z.slice(a, b + 1).some((z) => z < floor)) continue;
      const lengthM = Math.round(t.d[b]! - t.d[a]!);
      const profile: ProfilePoint[] = [];
      for (let k = a; k <= b; k++) {
        profile.push({ d: Math.round((t.d[k]! - t.d[a]!) * 10) / 10, z: Math.round(t.z[k]! * 10) / 10, at: t.at[k]! });
      }
      found.push({
        activityId: t.activityId,
        date: t.date,
        startIndex: t.i[a]!,
        endIndex: t.i[b]!,
        profile,
        lengthM,
        ...climbAndDrop(profile.map((p) => p.z)),
      });
      // Le passage suivant par ce haut, pas le point d'à côté du même passage.
      while (a + 1 < t.at.length && haversineM(t.at[a + 1]!, from) <= CROSSING_REACH_M) a++;
    }
  }
  // Le plus récent d'abord : c'est lui qu'on garde quand deux passages prennent le même chemin.
  found.sort((x, y) => y.date.localeCompare(x.date) || x.lengthM - y.lengthM);
  const distinct: LoopCrossing[] = [];
  for (const c of found) {
    if (!distinct.some((d) => Math.abs(d.lengthM - c.lengthM) < SAME_CROSSING_M)) distinct.push(c);
  }
  return distinct.sort((x, y) => x.lengthM - y.lengthM).slice(0, MAX_CROSSINGS);
}

/**
 * Les boucles que forment les montées de l'athlète : deux montées qu'une séance
 * peut désigner, parties du même endroit, dont les hauts sont reliés par un
 * chemin qu'il a déjà pris — une boucle par chemin, du plus court au plus long.
 */
export function findLoops(
  climbs: readonly RecurringClimb[],
  traces: readonly LightTrace[],
  home?: readonly [number, number],
): ClimbLoop[] {
  const usable = candidates({ climbs, ...(home ? { home } : {}) });
  const loops: ClimbLoop[] = [];
  for (const up of usable) {
    for (const down of usable) {
      if (up === down || haversineM(footOf(up), footOf(down)) > LOOP_FEET_M) continue;
      if (haversineM(up.latest.top!, down.latest.top!) > LOOP_TOPS_M) continue;
      for (const over of crossingsOf(up, down, traces)) loops.push({ up, down, over });
    }
  }
  return loops;
}

/** Ce qu'un tour de boucle monte, et donc descend : la montée, et les bosses du chemin d'un haut à l'autre. */
export const loopGain = (l: ClimbLoop): number => Math.round(l.up.gainM + l.over.gainM);

/**
 * Ce qui écarte une boucle : on la redescend en courant, et rien ne descend vite
 * des marches. La montée qu'on redescend doit être sans marches et son sol lu ;
 * le chemin d'un haut à l'autre aussi, sauf des marches qu'il monte. La montée
 * qu'on monte peut en porter : on les monte à pied. `null` quand elle convient.
 */
export function loopRefusal(l: ClimbLoop): SkippedClimb | null {
  const down = fastRefusal(l.down, topDistance(l.down), 0);
  if (down) return down;
  const g = l.over.ground;
  if (!g) return { climb: describeClimb(l.down), reason: 'sol inconnu' };
  const over = groundBetween(g, 0, l.over.lengthM);
  if ((over.offM ?? 0) > FAST_OFF_SHARE * l.over.lengthM) return { climb: describeClimb(l.down), reason: 'sol inconnu' };
  // Une volée de marches ne se prend qu'en montant.
  const zAt = (d: number) => l.over.profile.reduce((a, p) => (Math.abs(p.d - d) < Math.abs(a.d - d) ? p : a)).z;
  let at = 0;
  for (const r of over.runs) {
    if (r.kind === 'escalier' && zAt(at + r.lengthM) - zAt(at) < 2) {
      return { climb: describeClimb(l.down), reason: 'escalier', stairsM: r.lengthM, ...(r.steps ? { steps: r.steps } : {}) };
    }
    at += r.lengthM;
  }
  return null;
}

/**
 * Le retour d'une boucle, du haut de la montée à son pied : le chemin d'un haut
 * à l'autre, puis la montée qu'on redescend. Sa pente est ce qu'un tour
 * descend — ce qu'il monte, puisqu'il revient à son pied — rapporté à sa
 * longueur.
 */
export function loopBack(l: ClimbLoop): TerrainStretch {
  const downTop = topDistance(l.down);
  const over = l.over.ground ? groundBetween(l.over.ground, 0, l.over.lengthM) : null;
  const down = l.down.ground ? groundBetween(l.down.ground, downTop, 0) : null;
  const runs = [...(over?.runs ?? []), ...(down?.runs ?? [])];
  const offM = (over?.offM ?? 0) + (down?.offM ?? 0);
  const ground: StretchGround | null =
    over && down
      ? { runs, ...(offM ? { offM } : {}), readAt: [over.readAt, down.readAt].sort()[1]! }
      : null;
  const track = [
    ...trackBetween(l.over.profile, 0, l.over.lengthM),
    ...trackBetween(l.down.latest.profile, downTop, 0),
  ];
  const lengthM = Math.round(l.over.lengthM + downTop);
  // Le haut de la montée qu'on vient de monter se prolonge parfois sur sa
  // propre voie : « redescends par la montée Nicolas de Lange » ferait croire
  // qu'on reprend l'escalier. Le retour commence à la voie suivante.
  const upName = climbName(l.up);
  const streets = (ground ? streetsOf(ground) : []).filter(
    (s, i, all) => !(upName && all.slice(0, i + 1).every((x) => streetKey(x) === streetKey(upName))),
  );
  return {
    climb: describeClimb(l.down),
    from: { role: 'haut', at: l.up.latest.top! },
    to: { role: 'pied', at: footOf(l.up) },
    lengthM,
    grade: Math.round((loopGain(l) / lengthM) * 1000) / 1000,
    provenance: 'field',
    ...(streets.length > 0 ? { streets } : {}),
    ...(ground ? { ground } : {}),
    ...(track.length >= 2 ? { track } : {}),
  };
}

/** Écart toléré entre ce que les passages font et ce que la séance prescrit. */
export const PASSAGES_TOLERANCE = 0.1;
/** Au-delà, ce n'est plus une sortie de terrain mais une séance de côtes. */
export const MAX_PASSAGES = 8;

export interface ClimbChoice {
  climb: RecurringClimb;
  passages: number;
  /** Ce que ces passages montent, m. */
  gainM: number;
  /** Quand on ne redescend pas par où l'on est monté : la boucle, dont `climb` est la montée. */
  loop?: ClimbLoop;
}

/**
 * La montée récurrente qui convient à un dénivelé prescrit, s'il y en a une.
 *
 * Elle convient quand l'athlète l'a courue lors de deux sorties au moins, près
 * de son départ habituel ; qu'elle est assez raide pour qu'on y marche — c'est
 * l'alternance que la séance travaille ; et qu'un nombre entier de passages,
 * huit au plus, fait le dénivelé à 10 % près. Entre deux qui conviennent, la
 * plus longue : moins de passages, c'est plus de terrain et moins de tours. Le
 * terrain dit où, jamais combien : une montée qui ne tombe pas juste n'est pas
 * nommée, et le dénivelé prescrit ne se rabote pas pour elle.
 *
 * Et jamais en descendant des marches : une rando-course prépare la descente
 * sur sentier, et chaque passage redescend la montée entière. Les 27/09 et
 * 03/10 passaient six et sept fois par les escaliers de la montée Nicolas de
 * Lange. Une montée qui en porte, ou dont on n'a pas pu lire le sol, est
 * écartée comme pour une séance rapide, et rendue avec la montée retenue.
 *
 * Sauf en boucle : on monte l'escalier à pied et l'on redescend par une autre
 * montée, sans marches (`loopRefusal`). C'est la bonne forme quand le terrain
 * en offre une — on ne redescend pas par où l'on vient de monter, et les
 * marches travaillent la montée sans jamais se descendre. Une boucle qui tombe
 * juste passe donc avant un aller-retour.
 */
export function trailPick(
  terrain: TerrainHint | undefined,
  gainM: number,
  walkingGrade: number,
): { choice: ClimbChoice | null; skipped: SkippedClimb[] } {
  const skipped: SkippedClimb[] = [];
  if (!terrain || gainM <= 0) return { choice: null, skipped };
  const near = (c: RecurringClimb) =>
    !terrain.home || haversineM(terrain.home, c.start) <= HOME_GROUND_RADIUS_M;
  const fitting = <T>(x: T, perPassage: number) => {
    const passages = Math.max(1, Math.round(gainM / perPassage));
    const total = Math.round(passages * perPassage);
    return passages <= MAX_PASSAGES && Math.abs(total - gainM) <= PASSAGES_TOLERANCE * gainM
      ? { x, passages, total }
      : null;
  };
  const byPassages = <T extends { passages: number }>(pick: (t: T) => RecurringClimb) => (a: T, b: T) =>
    a.passages - b.passages || byHabit(pick(a), pick(b));

  const loops = (terrain.loops ?? [])
    .filter((l) => l.up.grade >= walkingGrade && near(l.up))
    .flatMap((l) => fitting(l, loopGain(l)) ?? [])
    .sort(byPassages((f) => f.x.up));
  for (const { x: loop, passages, total } of loops) {
    const refusal = loopRefusal(loop);
    if (refusal) {
      skipped.push(refusal);
      continue;
    }
    // Un autre chemin d'un haut à l'autre a pu être écarté : la montée qu'on
    // redescend, elle, ne l'est pas.
    const down = describeClimb(loop.down);
    return { choice: { climb: loop.up, passages, gainM: total, loop }, skipped: skipped.filter((s) => s.climb !== down) };
  }

  const fits = terrain.climbs
    .filter((c) => c.outings >= 2 && c.gainM > 0 && c.grade >= walkingGrade && near(c))
    .flatMap((c) => fitting(c, c.gainM) ?? [])
    .sort(byPassages((f) => f.x));
  for (const { x: c, passages, total } of fits) {
    const refusal = fastRefusal(c, 0, topDistance(c));
    if (refusal) {
      if (!skipped.some((s) => s.climb === refusal.climb)) skipped.push(refusal);
      continue;
    }
    return { choice: { climb: c, passages, gainM: total }, skipped };
  }
  return { choice: null, skipped };
}

/** La montée d'une rando-course, sans ce qui a été écarté pour elle (`trailPick`). */
export function climbFor(
  terrain: TerrainHint | undefined,
  gainM: number,
  walkingGrade: number,
): ClimbChoice | null {
  return trailPick(terrain, gainM, walkingGrade).choice;
}

const metres = (m: number) =>
  m >= 1000 ? `${(Math.round(m / 100) / 10).toLocaleString('fr-FR')} km` : `${Math.round(m / 10) * 10} m`;
const dayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** La distance du pied au haut sur le chemin du dernier passage, m. */
const topDistance = (climb: RecurringClimb): number =>
  climb.latest.profile[climb.latest.profile.length - 1]?.d ?? climb.latest.lengthM;

/**
 * La montée désignée comme on la retrouve : par la voie qui la porte — « la
 * montée Saint-Barthélémy » — quand OpenStreetMap en place une sous sa trace ;
 * sinon par sa longueur, sa pente et la dernière sortie où l'athlète l'a prise,
 * sous le titre que Strava lui donne. Jamais par sa position par rapport au
 * domicile : « à 510 m à l'ouest de ton départ habituel », personne ne s'y
 * repère.
 */
/** La voie qui nomme une montée, s'il y en a une. */
const climbName = (climb: RecurringClimb): string | null =>
  climb.ground ? nameOf(climb.ground, 0, topDistance(climb)) : null;

export function describeClimb(climb: RecurringClimb): string {
  const name = climbName(climb);
  if (name) return withArticle(streetName(name));
  return (
    `ta montée de ${metres(climb.lengthM)} à ${Math.round(climb.grade * 100)} % (${climb.gainM} m), ` +
    `courue lors de ${climb.outings} sorties — la dernière le ${dayMonth(climb.lastDate)} (« ${climb.latest.activityName} »)`
  );
}

/**
 * Ce que les passages font du dénivelé prescrit. La montée elle-même est
 * désignée par le tronçon du bloc (`trailStretch`) ; le nombre de passages est
 * un entier, le dénivelé prescrit non : on dit les deux quand ils diffèrent,
 * plutôt que de laisser croire qu'ils coïncident.
 */
export function describeClimbChoice(choice: ClimbChoice, prescribedM: number): string {
  const { climb, passages, gainM, loop } = choice;
  const total = gainM === prescribedM ? '' : `, ${gainM} m en tout`;
  const named = climb.ground ? nameOf(climb.ground, 0, topDistance(climb)) : null;
  const which = named ? describeClimb(climb) : `ta montée de ${metres(climb.lengthM)}`;
  if (loop) {
    const stairs = climb.ground ? stairsOf(groundBetween(climb.ground, 0, topDistance(climb))) : null;
    const walk = stairs && stairs.lengthM > 0 ? ' à pied' : '';
    return (
      `Les ${prescribedM} m, c'est ${passages} tour${passages > 1 ? 's' : ''} : monte${walk} ${which}, ` +
      `redescends par ${viaStreets(loopBack(loop))} — ${loopGain(loop)} m par tour${total}.`
    );
  }
  return (
    `Les ${prescribedM} m, c'est ${passages} passage${passages > 1 ? 's' : ''} de ${which}, ` +
    `du pied au haut : ${climb.gainM} m par passage${total}.`
  );
}

/**
 * La montée entière, du pied au haut : celle que les passages d'une
 * rando-course parcourent. En boucle, elle porte son retour (`back`).
 */
export function trailStretch(choice: ClimbChoice): TerrainStretch | null {
  const { climb, loop } = choice;
  const top = climb.latest.top;
  if (!top) return null;
  const up = stretchOf(
    climb,
    [{ role: 'pied', at: climb.latest.start ?? climb.start }, { role: 'haut', at: top }],
    climb.lengthM,
    climb.gainM,
    [0, topDistance(climb)],
  );
  return loop ? { ...up, back: loopBack(loop) } : up;
}

// ─────────────────────────────────────────────────────────────────────────────
// Les répétitions : un tronçon de montée, situé par son dénivelé
// ─────────────────────────────────────────────────────────────────────────────

/** Une montée écartée d'une séance rapide, et ce qui l'écarte. */
export interface SkippedClimb {
  /** La montée, désignée comme les séances la désignent. */
  climb: string;
  reason: 'escalier' | 'sol inconnu';
  /** Marches du tronçon écarté, quand OpenStreetMap les compte. */
  steps?: number;
  /** Longueur d'escalier du tronçon écarté, m. */
  stairsM?: number;
}

/**
 * Part d'un tronçon rapide qu'on accepte hors de toute voie connue : le GPS
 * s'écarte parfois de trente mètres entre deux immeubles, un escalier jamais
 * cartographié ne se devine pas au-delà.
 */
const FAST_OFF_SHARE = 0.25;

/**
 * Ce qui écarte un tronçon d'une séance rapide — descente, côte, fractionné —
 * ou d'une rando-course, dont les passages redescendent la montée : des
 * marches, ou un sol qu'on n'a pas pu lire. Rien ne descend vite un escalier,
 * et un tronçon dont on ne sait pas s'il en porte n'est pas un tronçon sans
 * marches. `null` quand il convient.
 */
function fastRefusal(climb: RecurringClimb, fromD: number, toD: number): SkippedClimb | null {
  if (!climb.ground) return { climb: describeClimb(climb), reason: 'sol inconnu' };
  const g = groundBetween(climb.ground, fromD, toD);
  const stairs = stairsOf(g);
  if (stairs.lengthM > 0) {
    return {
      climb: describeClimb(climb),
      reason: 'escalier',
      stairsM: Math.round(stairs.lengthM),
      ...(stairs.steps > 0 ? { steps: stairs.steps } : {}),
    };
  }
  if ((g.offM ?? 0) > FAST_OFF_SHARE * Math.abs(toD - fromD)) return { climb: describeClimb(climb), reason: 'sol inconnu' };
  return null;
}

/** Pourquoi une séance évite les marches, et où se courir quand aucune montée ne s'y prête. */
const STEPS_RULE = {
  descentes: {
    rule: 'on ne descend pas vite sur des marches',
    elsewhere: 'cours ces descentes sur une route ou un chemin sans marches',
  },
  côtes: {
    rule: 'une côte ne se court pas sur des marches',
    elsewhere: 'cours ces côtes sur une route ou un chemin sans marches',
  },
  'rando-course': {
    rule: 'une rando-course prépare la descente sur sentier, et ses descentes ne passent pas par des marches',
    elsewhere: 'cours ce dénivelé sur un sentier ou une route sans marches',
  },
} as const;

/**
 * Ce qu'une séance dit des montées qu'elle n'a pas prises : l'escalier qu'elle
 * évite, ou le sol qu'elle n'a pas pu lire. Posée ailleurs, elle nomme la
 * première écartée — celle que l'athlète court le plus. Posée nulle part, elle
 * dit où se courir. Vide quand rien n'a été écarté.
 */
export function skippedNote(
  skipped: readonly SkippedClimb[],
  placed: boolean,
  what: keyof typeof STEPS_RULE,
): string {
  const first = skipped[0];
  if (!first) return '';
  const why = (s: SkippedClimb) =>
    s.reason === 'escalier'
      ? `qui passe par ${s.steps ? `un escalier de ${s.steps} marches` : 'un escalier'}`
      : `dont le sol n'a pas pu être lu sur OpenStreetMap`;
  const { rule, elsewhere } = STEPS_RULE[what];
  if (placed) return `Pas sur ${first.climb}, ${why(first)} : ${rule}.`;
  if (skipped.every((s) => s.reason === 'sol inconnu')) {
    return `Le sol de tes montées n'a pas pu être lu sur OpenStreetMap : ${elsewhere}.`;
  }
  const others = skipped.length - 1;
  return (
    `Aucune de tes montées ne s'y prête — ${first.climb}, ${why(first)}` +
    `${others > 0 ? `, et ${others} autre${others > 1 ? 's' : ''}` : ''} : ${elsewhere}.`
  );
}

function candidates(terrain: TerrainHint): RecurringClimb[] {
  return terrain.climbs.filter(
    (c) =>
      c.outings >= 2 &&
      c.latest.top != null &&
      c.latest.profile.length >= 2 &&
      (!terrain.home || haversineM(terrain.home, c.start) <= HOME_GROUND_RADIUS_M),
  );
}

/** Entre deux montées qui conviennent, celle que l'athlète prend le plus souvent : c'est celle qu'il connaît. */
const byHabit = (a: RecurringClimb, b: RecurringClimb) => b.outings - a.outings || b.lastDate.localeCompare(a.lastDate);

/** Un point du profil, et la longueur qui le sépare du bout d'où l'on part. */
interface Located {
  at: [number, number];
  lengthM: number;
}

/** La montée d'une descente, son haut et son demi-tour — sur le chemin du dernier passage. */
interface DescentPick {
  climb: RecurringClimb;
  top: [number, number];
  turn: Located;
  /** Distance du pied au haut, m, sur ce chemin. */
  topD: number;
}

/**
 * La montée où se courent des descentes de `dropM` chacune, et celles qu'il a
 * fallu écarter pour elle.
 *
 * Deux sorties au moins, près du départ habituel ; un dernier passage qui porte
 * les mètres d'une descente ; et un tronçon, du haut au demi-tour, sans marches
 * et sur un sol relu. Entre deux qui conviennent, celle que l'athlète prend le
 * plus souvent : une descente technique se court sur un terrain connu.
 */
export function descentPick(
  terrain: TerrainHint | undefined,
  dropM: number,
): { pick: DescentPick | null; skipped: SkippedClimb[] } {
  const skipped: SkippedClimb[] = [];
  if (!terrain || !(dropM > 0)) return { pick: null, skipped };
  for (const climb of candidates(terrain).filter((c) => c.latest.gainM >= dropM).sort(byHabit)) {
    const top = climb.latest.top;
    const turn = pointBelowTop(climb.latest.profile, dropM);
    if (!top || !turn || turn.lengthM <= 0) continue;
    const topD = topDistance(climb);
    const refusal = fastRefusal(climb, topD, topD - turn.lengthM);
    if (refusal) {
      skipped.push(refusal);
      continue;
    }
    return { pick: { climb, top, turn, topD }, skipped };
  }
  return { pick: null, skipped };
}

/**
 * Le point situé `meters` sous le sommet, en redescendant le chemin : le premier
 * point du profil qui passe sous cette altitude, interpolé entre ses voisins.
 */
export function pointBelowTop(profile: readonly ProfilePoint[], meters: number): Located | null {
  const top = profile[profile.length - 1];
  if (!top || !(meters > 0)) return null;
  const target = top.z - meters;
  for (let j = profile.length - 2; j >= 0; j--) {
    const p = profile[j] as ProfilePoint;
    if (p.z > target) continue;
    return interpolate(p, profile[j + 1] as ProfilePoint, target, top.d, 'down');
  }
  return null;
}

/** Le point situé `meters` au-dessus du pied, en montant le chemin. */
export function pointAboveFoot(profile: readonly ProfilePoint[], meters: number): Located | null {
  const foot = profile[0];
  if (!foot || !(meters > 0)) return null;
  const target = foot.z + meters;
  for (let j = 1; j < profile.length; j++) {
    const p = profile[j] as ProfilePoint;
    if (p.z < target) continue;
    return interpolate(profile[j - 1] as ProfilePoint, p, target, foot.d, 'up');
  }
  return null;
}

/** Entre deux points du profil, là où l'altitude vaut `z` ; la longueur se compte depuis `origin`. */
function interpolate(
  a: ProfilePoint,
  b: ProfilePoint,
  z: number,
  origin: number,
  way: 'up' | 'down',
): Located | null {
  const f = b.z === a.z ? 0 : Math.min(1, Math.max(0, (z - a.z) / (b.z - a.z)));
  const d = a.d + f * (b.d - a.d);
  const at =
    a.at && b.at
      ? ([a.at[0] + f * (b.at[0] - a.at[0]), a.at[1] + f * (b.at[1] - a.at[1])] as [number, number])
      : (f < 0.5 ? a.at : b.at) ?? a.at ?? b.at;
  if (!at) return null;
  const round6 = (v: number) => Math.round(v * 1e6) / 1e6;
  return { at: [round6(at[0]), round6(at[1])], lengthM: way === 'down' ? origin - d : d - origin };
}

/**
 * Le tronçon d'une montée entre deux de ses points : ses bouts, sa longueur et
 * sa pente, et — lus sur le chemin du dernier passage, de `range[0]` vers
 * `range[1]` — son tracé, son sol et ses voies dans l'ordre où on les court.
 */
function stretchOf(
  climb: RecurringClimb,
  ends: [TerrainPoint, TerrainPoint],
  lengthM: number,
  meters: number,
  range: [number, number],
): TerrainStretch {
  const [fromD, toD] = range;
  const track = trackBetween(climb.latest.profile, fromD, toD);
  const g = climb.ground ? groundBetween(climb.ground, fromD, toD) : null;
  const ground: StretchGround | null = g
    ? { runs: g.runs, ...(g.offM ? { offM: g.offM } : {}), readAt: g.readAt }
    : null;
  const streets = ground ? streetsOf(ground) : [];
  return {
    climb: describeClimb(climb),
    from: ends[0],
    to: ends[1],
    lengthM: Math.round(lengthM),
    grade: Math.round((meters / lengthM) * 1000) / 1000,
    provenance: 'field',
    ...(streets.length > 0 ? { streets } : {}),
    ...(ground ? { ground } : {}),
    ...(track.length >= 2 ? { track } : {}),
  };
}

/**
 * Le tronçon d'une descente de `dropM` : du haut de la montée jusqu'au point où
 * l'on a descendu ces mètres, là où l'on fait demi-tour. Sa pente est celle de
 * ce tronçon, pas celle de la montée : 78 m sous le haut de la montée de 942 m
 * à 13 %, c'est 405 m à 19 %. Jamais sur des marches (`descentPick`).
 */
export function descentStretch(terrain: TerrainHint | undefined, dropM: number): TerrainStretch | null {
  const { pick } = descentPick(terrain, dropM);
  if (!pick) return null;
  const { climb, top, turn, topD } = pick;
  const ends: [TerrainPoint, TerrainPoint] = [{ role: 'haut', at: top }, { role: 'demi-tour', at: turn.at }];
  return stretchOf(climb, ends, turn.lengthM, dropM, [topD, topD - turn.lengthM]);
}

/** Un morceau d'une remontée à pied : ce qu'il parcourt, monte et descend. */
export interface WalkPart {
  lengthM: number;
  gainM: number;
  lossM: number;
}

/**
 * La remontée en boucle d'une descente de `dropM` : au lieu de remonter la
 * montée qu'on vient de descendre, on finit de la descendre jusqu'au pied, on
 * monte par l'autre montée d'une boucle — un escalier se monte à pied —, et
 * l'on rejoint le haut par le chemin d'un haut à l'autre. Tout se marche : les
 * marches ne s'y descendent jamais vite.
 *
 * Rend chaque boucle possible avec ses morceaux et le tronçon qui la dit, du
 * demi-tour au haut : c'est à la séance de juger si elle tient dans la
 * récupération prescrite.
 */
export function descentLoops(
  terrain: TerrainHint | undefined,
  dropM: number,
): { loop: ClimbLoop; parts: WalkPart[]; stretch: TerrainStretch }[] {
  const { pick } = descentPick(terrain, dropM);
  if (!pick || !terrain?.loops) return [];
  const { climb, turn, topD } = pick;
  const lowerM = Math.max(0, climb.lengthM - turn.lengthM);
  const lowerDropM = Math.max(0, Math.round(climb.gainM - dropM));
  return terrain.loops
    .filter((l) => sameClimbAs(l.down, climb) && l.up.latest.top != null)
    .map((loop) => {
      const { up, over } = loop;
      const lower = stretchOf(climb, [{ role: 'demi-tour', at: turn.at }, { role: 'pied', at: footOf(climb) }], lowerM || 1, lowerDropM, [topD - turn.lengthM, 0]);
      const rise = stretchOf(up, [{ role: 'pied', at: footOf(up) }, { role: 'haut', at: up.latest.top! }], up.lengthM, up.gainM, [0, topDistance(up)]);
      const across = over.ground ? groundBetween(over.ground, 0, over.lengthM) : null;
      const parts: WalkPart[] = [
        { lengthM: lowerM, gainM: 0, lossM: lowerDropM },
        { lengthM: up.lengthM, gainM: up.gainM, lossM: 0 },
        { lengthM: over.lengthM, gainM: over.gainM, lossM: over.lossM },
      ];
      const lengthM = Math.round(parts.reduce((s, p) => s + p.lengthM, 0));
      const runs = [...(lower.ground?.runs ?? []), ...(rise.ground?.runs ?? []), ...(across?.runs ?? [])];
      const streets = streetsOf({ runs, readAt: '' });
      const stretch: TerrainStretch = {
        climb: describeClimb(up),
        from: { role: 'demi-tour', at: turn.at },
        to: { role: 'haut', at: pick.top },
        lengthM,
        grade: Math.round(((up.gainM + over.gainM) / Math.max(1, lengthM)) * 1000) / 1000,
        provenance: 'field',
        ...(streets.length > 0 ? { streets } : {}),
        ...(lower.ground && rise.ground && across
          ? { ground: { runs, readAt: [lower.ground.readAt, rise.ground.readAt, across.readAt].sort()[2]! } }
          : {}),
        track: [...(lower.track ?? []), ...(rise.track ?? []), ...trackBetween(over.profile, 0, over.lengthM)],
      };
      return { loop, parts, stretch };
    });
}

/**
 * Ce qu'une descente posée sur une montée coûte pour y aller et pour en
 * revenir : l'accès, du pied au haut, et le bas de la montée, du demi-tour au
 * pied.
 *
 * L'échauffement monte au haut — c'est la montée entière — et, la dernière
 * descente faite, on est au demi-tour : il reste à descendre ce que la montée
 * a de plus bas que lui. Ces mètres-là se courent comme les autres ; tant
 * qu'aucun bloc ne les portait, la séance annonçait 468 m quand elle en
 * montait 511.
 */
export function descentAccess(
  terrain: TerrainHint | undefined,
  dropM: number,
): { up: TerrainStretch; down: TerrainStretch; upM: number; downM: number } | null {
  const { pick } = descentPick(terrain, dropM);
  const foot = pick?.climb.latest.start;
  if (!pick || !foot) return null;
  const { climb, top, turn, topD } = pick;
  // Ce que la montée monte est ce qu'elle annonce — le dénivelé médian de ses
  // passages, celui que la séance nomme juste à côté. Prendre celui du dernier
  // passage écrirait 120 m sous un tronçon qui en dit 121.
  const upM = Math.round(climb.gainM);
  const downM = upM - Math.round(dropM);
  // Ce qui reste sous le demi-tour, sur la montée telle qu'elle s'annonce : le
  // tronçon de descente et le bas se recomposent alors en une montée, et non en
  // deux mesures qui ne se rejoignent pas.
  const lowerM = climb.lengthM - turn.lengthM;
  if (downM <= 0 || lowerM <= 0) return null;
  return {
    // L'accès, c'est la montée entière : elle se dit avec les chiffres qu'elle
    // annonce, les mêmes que ceux d'une rando-course qui la monte.
    up: stretchOf(climb, [{ role: 'pied', at: foot }, { role: 'haut', at: top }], climb.lengthM, upM, [0, topD]),
    down: stretchOf(
      climb,
      [{ role: 'demi-tour', at: turn.at }, { role: 'pied', at: foot }],
      lowerM,
      downM,
      [topD - turn.lengthM, 0],
    ),
    upM,
    downM,
  };
}

/**
 * Le tronçon d'une côte : du pied jusqu'au point où l'on a monté ce que la
 * répétition monte. Ce qu'elle monte dépend de la pente — à puissance égale, on
 * monte plus vite une pente plus raide —, et la pente, du tronçon : `gainAt`
 * dit les mètres d'une répétition pour une pente, et le tronçon se resserre
 * jusqu'à ce que les deux s'accordent. Jamais sur des marches ; les montées
 * écartées pour cela sont rendues avec le tronçon retenu.
 */
export function hillPick(
  terrain: TerrainHint | undefined,
  gainAt: (grade: number) => number,
): { found: { stretch: TerrainStretch; gainM: number } | null; skipped: SkippedClimb[] } {
  const skipped: SkippedClimb[] = [];
  if (!terrain) return { found: null, skipped };
  for (const climb of candidates(terrain).sort(byHabit)) {
    const foot = climb.latest.start;
    if (!foot) continue;
    let grade = climb.grade;
    let found: { at: Located; gainM: number } | null = null;
    for (let i = 0; i < 6; i++) {
      const gainM = Math.round(gainAt(grade));
      const at = pointAboveFoot(climb.latest.profile, gainM);
      if (!at || at.lengthM <= 0) {
        found = null;
        break;
      }
      found = { at, gainM };
      const next = gainM / at.lengthM;
      if (Math.abs(next - grade) < 0.002) break;
      grade = next;
    }
    if (!found) continue;
    const refusal = fastRefusal(climb, 0, found.at.lengthM);
    if (refusal) {
      skipped.push(refusal);
      continue;
    }
    return {
      found: {
        stretch: stretchOf(
          climb,
          [{ role: 'pied', at: foot }, { role: 'demi-tour', at: found.at.at }],
          found.at.lengthM,
          found.gainM,
          [0, found.at.lengthM],
        ),
        gainM: found.gainM,
      },
      skipped,
    };
  }
  return { found: null, skipped };
}

/** Le tronçon d'une côte, sans ce qui a été écarté pour lui (`hillPick`). */
export function hillStretch(
  terrain: TerrainHint | undefined,
  gainAt: (grade: number) => number,
): { stretch: TerrainStretch; gainM: number } | null {
  return hillPick(terrain, gainAt).found;
}
