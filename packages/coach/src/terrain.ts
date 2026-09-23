import type { ActivityStreams, ParameterProvenance, StretchGround, TerrainPoint, TerrainStretch } from '@cairn/core';
import { stairsOf, streetName, withArticle } from '@cairn/core';
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
  /** Son départ habituel : le centre du terrain le plus fréquenté. */
  home?: readonly [number, number];
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
 */
export function climbFor(
  terrain: TerrainHint | undefined,
  gainM: number,
  walkingGrade: number,
): ClimbChoice | null {
  if (!terrain || gainM <= 0) return null;
  const near = (c: RecurringClimb) =>
    !terrain.home || haversineM(terrain.home, c.start) <= HOME_GROUND_RADIUS_M;
  const fits = terrain.climbs
    .filter((c) => c.outings >= 2 && c.gainM > 0 && c.grade >= walkingGrade && near(c))
    .map((c) => {
      const passages = Math.max(1, Math.round(gainM / c.gainM));
      return { c, passages, total: passages * c.gainM };
    })
    .filter((x) => x.passages <= MAX_PASSAGES && Math.abs(x.total - gainM) <= PASSAGES_TOLERANCE * gainM)
    .sort(
      (a, b) =>
        a.passages - b.passages || b.c.outings - a.c.outings || b.c.lastDate.localeCompare(a.c.lastDate),
    );
  const best = fits[0];
  if (!best) return null;
  return { climb: best.c, passages: best.passages, gainM: best.total };
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
export function describeClimb(climb: RecurringClimb): string {
  const name = climb.ground ? nameOf(climb.ground, 0, topDistance(climb)) : null;
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
  const { climb, passages, gainM } = choice;
  const total = gainM === prescribedM ? '' : `, ${gainM} m en tout`;
  const named = climb.ground ? nameOf(climb.ground, 0, topDistance(climb)) : null;
  const which = named ? describeClimb(climb) : `ta montée de ${metres(climb.lengthM)}`;
  return (
    `Les ${prescribedM} m, c'est ${passages} passage${passages > 1 ? 's' : ''} de ${which}, ` +
    `du pied au haut : ${climb.gainM} m par passage${total}.`
  );
}

/** La montée entière, du pied au haut : celle que les passages d'une rando-course parcourent. */
export function trailStretch(choice: ClimbChoice): TerrainStretch | null {
  const { climb } = choice;
  const top = climb.latest.top;
  if (!top) return null;
  return stretchOf(
    climb,
    [{ role: 'pied', at: climb.latest.start ?? climb.start }, { role: 'haut', at: top }],
    climb.lengthM,
    climb.gainM,
    [0, topDistance(climb)],
  );
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
 * Ce qui écarte un tronçon d'une séance rapide — descente, côte, fractionné :
 * des marches, ou un sol qu'on n'a pas pu lire. Rien ne descend vite un
 * escalier, et un tronçon dont on ne sait pas s'il en porte n'est pas un
 * tronçon sans marches. `null` quand il convient.
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

/**
 * Ce qu'une séance rapide dit des montées qu'elle n'a pas prises : l'escalier
 * qu'elle évite, ou le sol qu'elle n'a pas pu lire. Posée ailleurs, elle nomme
 * la première écartée — celle que l'athlète court le plus. Posée nulle part,
 * elle dit où se courir. Vide quand rien n'a été écarté.
 */
export function skippedNote(skipped: readonly SkippedClimb[], placed: boolean, what: 'descentes' | 'côtes'): string {
  const first = skipped[0];
  if (!first) return '';
  const why = (s: SkippedClimb) =>
    s.reason === 'escalier'
      ? `qui passe par ${s.steps ? `un escalier de ${s.steps} marches` : 'un escalier'}`
      : `dont le sol n'a pas pu être lu sur OpenStreetMap`;
  const rule =
    what === 'descentes'
      ? 'on ne descend pas vite sur des marches'
      : 'une côte ne se court pas sur des marches';
  if (placed) return `Pas sur ${first.climb}, ${why(first)} : ${rule}.`;
  if (skipped.every((s) => s.reason === 'sol inconnu')) {
    return (
      `Le sol de tes montées n'a pas pu être lu sur OpenStreetMap : cours ces ${what} sur une route ou un ` +
      `chemin sans marches.`
    );
  }
  const others = skipped.length - 1;
  return (
    `Aucune de tes montées ne s'y prête — ${first.climb}, ${why(first)}` +
    `${others > 0 ? `, et ${others} autre${others > 1 ? 's' : ''}` : ''} : cours ces ${what} sur une route ou ` +
    `un chemin sans marches.`
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
