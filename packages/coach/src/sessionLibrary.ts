import type {
  ParameterProvenance, PhysiologyModel, PlannedSession, SessionBlock, SessionSuccessCriterion, SessionType,
  StrengthCircuit, StrengthExercise, ZoneKey,
} from '@cairn/core';
import { sessionDuration } from '@cairn/core';
import {
  ECCENTRIC_MOVEMENTS, buildZones, eccentricStrengthLoad, formatPace, msToKmh,
  prescribedMechanicalLoad, speedForMetabolicPower, vam,
} from '@cairn/physiology';
import {
  PRESCRIPTION_MARGIN, PROVENANCE_FR, describeVerdict, fitVertical, locateVertical, verticalOf, type VerticalFit,
} from './plausibility.js';

/**
 * Bibliothèque de séances.
 *
 * Chaque séance est une **fonction du modèle physiologique**, jamais un texte
 * figé. « 6 × 3 min » ne veut rien dire ; « 6 × 3 min à 16,9-17,4 km/h,
 * 171-175 bpm, récupération 90 s en trottinant » est une prescription. Quand la
 * vitesse critique de Pierre bouge de 2 %, toutes les allures de toutes les
 * séances suivent, sans intervention.
 *
 * Les formats retenus suivent les recommandations du test du 24/07/2025 :
 * fractionné court 1'-1' et 30"-30" en PMA, fractionné moyen 3-12 min en
 * résistance dure, rando-course en montagne, et un seul fractionné par semaine
 * en alternant court et moyen.
 */

/**
 * Deux modèles du même athlète qui décrivent le même fait sans s'accorder.
 *
 * Une séance ne peut en suivre qu'un, mais elle ne tranche pas en silence : un
 * minimum pris sans rien dire fait passer une contradiction pour une précaution,
 * et plus personne ne cherche lequel des deux se trompe.
 */
export interface ModelDivergence {
  /** Durée sur laquelle les deux lectures portent, s. */
  durationS: number;
  /** Vitesse ascensionnelle que permet la puissance métabolique de Z2, m/h. */
  modelledMh: number;
  /** Meilleure vitesse ascensionnelle tenue sur cette durée, m/h. */
  observedMh: number;
  observedProvenance: ParameterProvenance;
  /** Écart du modèle à l'observation, %. */
  gapPct: number;
  /** La contradiction en clair, et ce que la séance en fait. */
  statement: string;
}

export interface SessionTemplate {
  key: string;
  type: SessionType;
  title: string;
  intent: string;
  /** Durée totale approximative, s — sert au placement dans la semaine. */
  durationS: number;
  /**
   * Dénivelé positif requis, m — **lu sur les blocs**, jamais déclaré.
   *
   * Une séance n'a qu'un dénivelé. Quand ce chiffre était posé à part, il
   * finissait par contredire le contenu : des côtes qui annonçaient 208 m dont
   * aucun bloc ne portait un mètre, une rando-course calibrée sur 1 384 m dont
   * les blocs en décrivaient 1 092. C'est le second chiffre que l'athlète
   * exécute, et le premier sur lequel le plancher de mesurabilité était posé.
   */
  elevationGainM: number;
  /**
   * Dénivelé négatif de la séance, m — la part de la charge mécanique que le
   * réalisé pourra vérifier. Lu sur les blocs qui le descendent, comme le D+ ;
   * seules les séances dont l'échauffement monte vers un terrain plat le
   * déclarent à part, à zéro : mieux vaut ne rien prêter à une séance que lui
   * prêter un dénivelé qu'elle n'a pas.
   */
  elevationLossM: number;
  /**
   * Ce que la construction a dû céder pour que la séance reste exécutable par
   * l'athlète, en clair. Absent quand rien n'a cédé.
   */
  amendments?: string[];
  /** Les modèles de l'athlète qui se contredisent sur ce que la séance prescrit. Absent quand ils s'accordent. */
  divergences?: ModelDivergence[];
  /**
   * Reconstruit la séance à une autre étendue — durée et dénivelé demandés
   * multipliés par `factor`.
   *
   * Présente sur les séances dont la forme dépend du temps disponible : la
   * sortie longue et la rando-course. Étirer une rando-course construite pour
   * 2 h 09 jusqu'à 3 h gardait des proportions qui ne valaient qu'à 2 h 09 — un
   * retour roulant de trois secondes, et des phrases sur un dénivelé que la
   * séance enregistrée ne portait plus.
   */
  rebuild?: (factor: number) => SessionTemplate;
  priority: 'key' | 'support' | 'optional';
  /** Phases où la séance a du sens. */
  phases: string[];
  blocks: SessionBlock[];
  plannedLoad: number;
  plannedMechanicalLoad: number;
  plannedDistanceM?: number;
}

interface Ctx {
  model: PhysiologyModel;
  zones: ReturnType<typeof buildZones>;
}

const ctxOf = (model: PhysiologyModel): Ctx => ({ model, zones: buildZones(model) });

const zoneOf = (c: Ctx, key: ZoneKey) => c.zones.find((z) => z.key === key)!;

/** Fourchette d'allure lisible, à partir d'une fourchette de vitesse. */
const paceRange = (lo: number, hi: number): [string, string] => [formatPace(hi), formatPace(lo)];

/**
 * Dénivelé de terrain des séances qui ne montent rien en propre.
 *
 * Un tempo, un seuil, une PMA se courent sur du roulant : le bloc de qualité a
 * besoin d'un profil plat pour que l'allure prescrite veuille dire quelque
 * chose, et ce qui monte, ce sont les kilomètres d'échauffement pour y aller.
 * Ces mètres-là existent — les ignorer sous-estimerait le D+ de la semaine —
 * mais ils appartiennent à un bloc, pas à l'en-tête de la séance.
 */
const TERRAIN_VERT_M = { tempo: 100, threshold: 80, vo2max: 40 } as const;

/**
 * Ce qu'un bloc admet en plus de son étendue.
 *
 * `vamTargetMh` n'y figure pas : une vitesse ascensionnelle posée à côté d'une
 * durée et d'un dénivelé fait trois nombres libres pour un même fait. Elle ne
 * s'écrit que par `climbBlock`, qui n'en accepte que deux.
 */
type BlockOpts = Omit<Partial<SessionBlock>, 'vamTargetMh'> & { speedLo?: number; speedHi?: number };

function block(
  c: Ctx,
  label: string,
  zone: ZoneKey,
  durationS: number,
  opts: BlockOpts = {},
): SessionBlock {
  const z = zoneOf(c, zone);
  const lo = opts.speedLo ?? z.speedMinMs;
  const hi = opts.speedHi ?? z.speedMaxMs;
  const b: SessionBlock = { label, zone, durationS };
  // Un bloc annexe ne se court pas : lui donner la FC et l'allure de sa zone
  // affichait une consigne intenable — dix minutes d'étirements prescrites
  // « 5:34-6:47/km ». `directives.ts` écrivait déjà les siens sans, les deux
  // chemins produisent enfin le même bloc.
  if (opts.kind) b.kind = opts.kind;
  else {
    b.hrRange = [Math.round(z.hrMin), Math.round(z.hrMax)];
    b.speedRangeMs = [lo, hi];
    b.paceRange = paceRange(lo, hi);
  }
  if (opts.circuit) b.circuit = opts.circuit;
  if (opts.repeat) b.repeat = opts.repeat;
  if (opts.recovery) b.recovery = opts.recovery;
  if (opts.notes) b.notes = opts.notes;
  if (opts.elevationGainM) b.elevationGainM = opts.elevationGainM;
  if (opts.elevationLossM) b.elevationLossM = opts.elevationLossM;
  if (opts.cadenceTargetSpm) b.cadenceTargetSpm = opts.cadenceTargetSpm;
  if (opts.distanceM) b.distanceM = opts.distanceM;
  return b;
}

/**
 * Les deux nombres qui suffisent à décrire une montée.
 *
 * Durée, dénivelé et vitesse ascensionnelle sont trois vues d'un même fait :
 * D+ = VAM × durée. En laisser fixer trois, c'est laisser la séance se
 * démentir — et c'est ce qui a demandé 1 427 m/h pendant cinquante minutes,
 * au-delà du meilleur effort d'une minute de l'athlète et le double de ce
 * qu'il tient sur cette durée, parce que le dénivelé d'une sortie de trois
 * heures avait été versé dans le seul bloc de montée.
 */
export type ClimbSpec =
  | { elevationGainM: number; vamTargetMh: number; durationS?: undefined }
  | { durationS: number; vamTargetMh: number; elevationGainM?: undefined }
  | { durationS: number; elevationGainM: number; vamTargetMh?: undefined };

export interface Climb {
  durationS: number;
  elevationGainM: number;
  vamTargetMh: number;
}

/**
 * Complète une montée par le troisième de ses nombres.
 *
 * La vitesse ascensionnelle rendue est toujours celle que le bloc exige
 * réellement, une fois durée et dénivelé arrondis à l'entier : sur une
 * répétition de 90 s, un mètre d'arrondi vaut 40 m/h, et une cible affichée à
 * côté de ce que le bloc demande serait déjà l'écart qu'on ferme.
 */
export function resolveClimb(spec: ClimbSpec): Climb {
  const durationS =
    spec.durationS ?? Math.round((spec.elevationGainM / spec.vamTargetMh) * 3600);
  const elevationGainM =
    spec.elevationGainM ?? Math.round((spec.vamTargetMh * spec.durationS) / 3600);
  return {
    durationS,
    elevationGainM,
    vamTargetMh: durationS > 0 ? Math.round((elevationGainM / durationS) * 3600) : 0,
  };
}

/** Un bloc de montée, bâti sur deux nombres et jamais sur trois. */
function climbBlock(
  c: Ctx,
  label: string,
  zone: ZoneKey,
  climb: Climb,
  opts: Omit<BlockOpts, 'elevationGainM' | 'durationS'> = {},
): SessionBlock {
  const b = block(c, label, zone, climb.durationS, { ...opts, elevationGainM: climb.elevationGainM });
  b.vamTargetMh = climb.vamTargetMh;
  return b;
}

/**
 * Charge métabolique prévisionnelle d'une séance, par la même formule que le
 * réalisé (rTSS) : durée × IF², rapportée à une heure au seuil. Prévu et réalisé
 * sont ainsi directement comparables — condition sine qua non d'un PMC honnête.
 */
function estimateLoad(model: PhysiologyModel, blocks: SessionBlock[]): number {
  let tss = 0;
  for (const b of blocks) {
    // Un bloc annexe — souplesse, respiration — n'est pas couru : lui prêter la
    // vitesse de sa zone lui ferait produire une charge qui n'existe pas.
    if (b.kind) continue;
    const reps = b.repeat ?? 1;
    const dur = b.durationS ?? 0;
    const mid = b.speedRangeMs ? (b.speedRangeMs[0] + b.speedRangeMs[1]) / 2 : model.vt1.speedMs * 0.8;
    const intensity = mid / model.vt2.speedMs;
    tss += reps * (dur / 3600) * intensity ** 2 * 100;
    if (b.recovery) {
      const rIntensity = b.recovery.active ? 0.55 : 0.2;
      tss += reps * (b.recovery.durationS / 3600) * rIntensity ** 2 * 100;
    }
  }
  return Math.round(tss);
}

/**
 * Circuits excentriques portés par les blocs, tours déjà multipliés par `repeat`.
 *
 * Un bloc répété est autant de circuits : c'est la seule façon que `repeat` et
 * `rounds` disent la même chose au calcul qu'à l'athlète.
 */
export function circuitsOf(blocks: readonly SessionBlock[]): StrengthCircuit[] {
  const out: StrengthCircuit[] = [];
  for (const b of blocks) {
    if (!b.circuit) continue;
    out.push({ ...b.circuit, rounds: b.circuit.rounds * (b.repeat ?? 1) });
  }
  return out;
}

/**
 * Charge mécanique prévisionnelle — le seul chemin du côté plan.
 *
 * Descente et renforcement excentrique sont rendus séparément : le premier sera
 * confronté au réalisé, le second jamais, faute de flux. Confondre les deux
 * dans un total muet, c'est reperdre ce qu'on vient de gagner.
 */
export function mechanicalFor(
  blocks: readonly SessionBlock[],
  elevationLossM: number,
  distanceM?: number,
): { total: number; descent: number; eccentricStrength: number } {
  const m = prescribedMechanicalLoad({
    elevationLossM,
    distanceM: distanceM ?? totalDistance(blocks),
    circuits: circuitsOf(blocks),
  });
  // Le total est arrondi à l'entier — c'est le chiffre enregistré et affiché ;
  // les deux parts au dixième, parce qu'un renforcement seul pèse quelques
  // points et qu'un arrondi à l'entier en effacerait le palier.
  return {
    total: Math.round(m.total),
    descent: Math.round(m.descent * 10) / 10,
    eccentricStrength: Math.round(m.eccentricStrength * 10) / 10,
  };
}

/**
 * Part de la charge mécanique prescrite qu'aucun flux d'activité ne verra.
 *
 * Elle se relit sur les blocs, jamais sur le total enregistré : c'est ce qui
 * permet de dire, en face d'un réalisé à zéro, si l'athlète n'a rien fait ou si
 * c'est la mesure qui est aveugle.
 */
export function eccentricStrengthOf(blocks: readonly SessionBlock[]): number {
  return Math.round(eccentricStrengthLoad(circuitsOf(blocks)).score * 10) / 10;
}

/**
 * Décrit un circuit en toutes lettres, depuis sa structure.
 *
 * Le texte est dérivé, comme l'allure l'est de la vitesse : c'est ce qui
 * empêche une séance d'annoncer trois tours à l'athlète pendant qu'elle en
 * compte un dans la charge.
 */
export function describeCircuit(c: StrengthCircuit): string {
  const items = c.exercises.map((e) => {
    const spec = ECCENTRIC_MOVEMENTS[e.movement];
    if (e.movement === 'isometric') return `${spec.label} ${e.reps} s`;
    return `${spec.label} ${e.reps}${spec.unilateral ? '/jambe' : ''}`;
  });
  return `${c.rounds} tour${c.rounds > 1 ? 's' : ''} : ${items.join(' · ')}.`;
}

/** Freinage lent puis retour : ce que dure une répétition excentrique, s. */
const ECCENTRIC_REP_S = 4;
/** Passage d'un exercice au suivant, s. */
const CIRCUIT_TRANSITION_S = 30;
/** Récupération entre deux tours, s — celle que les consignes annoncent. */
const CIRCUIT_REST_S = 120;

/**
 * Ce que dure un circuit, depuis son contenu.
 *
 * Un circuit dure ce que durent ses tours. Sa durée venait d'ailleurs — du
 * paramètre de la séance, puis du facteur de calibration de la semaine — et
 * elle ne suivait pas les tours : le 14/09, treize minutes étaient prescrites
 * pour un tour de cinq exercices. Le nombre de tours est le levier par lequel
 * on réintroduit l'excentrique ; qu'il ne touche pas au temps qu'on y passe
 * n'avait aucun sens.
 */
export function circuitDurationS(c: StrengthCircuit): number {
  const work = c.exercises.reduce((a, e) => {
    const spec = ECCENTRIC_MOVEMENTS[e.movement];
    // Un gainage se prescrit en secondes de maintien, tout le reste en
    // répétitions — et un mouvement unilatéral se fait des deux côtés.
    const perSide = e.movement === 'isometric' ? e.reps : e.reps * ECCENTRIC_REP_S;
    return a + perSide * (spec.unilateral ? 2 : 1);
  }, 0);
  const round = work + Math.max(0, c.exercises.length - 1) * CIRCUIT_TRANSITION_S;
  return c.rounds * round + Math.max(0, c.rounds - 1) * CIRCUIT_REST_S;
}

/**
 * Dénivelé positif d'un contenu de séance.
 *
 * Seule origine du chiffre d'en-tête, partout : bibliothèque, calibration du
 * planificateur, remplacement de blocs par le coach. Un en-tête calculé
 * ailleurs redeviendrait une seconde vérité, et c'est de là que venait l'écart.
 */
export function elevationGainOf(blocks: readonly SessionBlock[]): number {
  return blocks.reduce(
    (a, b) => a + (b.repeat ?? 1) * ((b.elevationGainM ?? 0) + (b.recovery?.elevationGainM ?? 0)),
    0,
  );
}

/** Dénivelé négatif d'un contenu, tel que ses blocs le déclarent — récupérations comprises. */
export function elevationLossOf(blocks: readonly SessionBlock[]): number {
  return blocks.reduce(
    (a, b) => a + (b.repeat ?? 1) * ((b.elevationLossM ?? 0) + (b.recovery?.elevationLossM ?? 0)),
    0,
  );
}

export function totalDuration(blocks: readonly SessionBlock[]): number {
  return blocks.reduce((a, b) => {
    const reps = b.repeat ?? 1;
    return a + reps * ((b.durationS ?? 0) + (b.recovery?.durationS ?? 0));
  }, 0);
}

/**
 * Blocs dont la durée est prescrite, non calibrée.
 *
 * Les blocs annexes — souplesse, respiration — tiennent leur durée du dossier.
 * Un circuit tient la sienne de son contenu : ses tours ne suivent aucun
 * facteur, sa durée ne le peut donc pas non plus. Elle le suivait pourtant, et
 * prescrivait treize minutes pour un tour de cinq exercices.
 *
 * La règle est la même quelle que soit la porte — calibration d'une semaine ou
 * allègement décidé par les règles de charge. Deux lectures divergentes, ce
 * serait la même séance réduite différemment selon qui la réduit.
 */
export const isPrescribed = (b: SessionBlock): boolean => Boolean(b.kind || b.circuit);

/**
 * Ce qu'une transformation reçoit d'une séance déjà écrite.
 *
 * Le type y figure parce qu'un contenu écrit avant que les blocs ne portent
 * leur D− se situe par la règle de la bibliothèque qui l'a produit
 * (`locateVertical`).
 */
export type TransformableSession = Pick<
  PlannedSession,
  'type' | 'blocks' | 'plannedLoad' | 'plannedMechanicalLoad' | 'plannedDurationS' | 'plannedDistanceM'
>;

export interface TransformedSession {
  blocks: SessionBlock[];
  plannedDurationS: number;
  plannedLoad: number;
  plannedMechanicalLoad: number;
  plannedElevationGainM: number;
  plannedDistanceM?: number;
  /** Ce que la séance a dû céder pour rester exécutable, en clair. Vide quand rien n'a cédé. */
  amendments: string[];
}

/**
 * Le seul chemin par lequel une séance écrite change d'étendue.
 *
 * Calibration d'une semaine, allègement décidé par les règles de charge, facteur
 * demandé par le coach, relèvement du dénivelé jusqu'au plancher de
 * mesurabilité : quatre portes, qui mettaient chacune « × 0,7 » à sa façon — la
 * calibration réduisait durée et dénivelé, l'allègement la durée seule, le coach
 * la durée seule, circuits compris. Un bloc de montée allégé gardait son D+ sur
 * moins de temps, et la vitesse ascensionnelle exigée montait d'autant.
 *
 * Ici, une transformation est deux facteurs : `duration` s'applique au temps de
 * ce qui se court, `vertical` au dénivelé — les deux ensemble par défaut, parce
 * que ce sont les deux étendues d'un même terrain. Ce que le dossier prescrit —
 * tours d'un circuit, souplesse, respiration — garde son temps. Puis chaque
 * segment est confronté aux courbes de l'athlète ; celui qui ne tient pas fait
 * céder le dénivelé de toute la séance, et la séance le dit. La durée, elle,
 * reste celle qu'on a demandée : une séance allégée qui s'allongerait pour garder
 * sa montée ne serait plus allégée.
 */
export function transformSession(
  session: TransformableSession,
  change: number | { duration: number; vertical?: number },
  model: PhysiologyModel,
): TransformedSession {
  const { duration, vertical = duration } = typeof change === 'number' ? { duration: change } : change;
  const located = locateVertical(session.blocks, session.type);
  const seconds = scaledDurations(located, duration);
  const round = (m: number | undefined) => (m === undefined ? undefined : Math.round(m * vertical));

  const scaled = located.map((b, i): SessionBlock => {
    const out: SessionBlock = { ...b };
    if (isPrescribed(b)) return out;
    if (b.durationS) out.durationS = seconds[i];
    if (b.elevationGainM !== undefined) out.elevationGainM = round(b.elevationGainM);
    if (b.elevationLossM !== undefined) out.elevationLossM = round(b.elevationLossM);
    if (b.recovery) {
      out.recovery = { ...b.recovery };
      if (b.recovery.elevationGainM !== undefined) out.recovery.elevationGainM = round(b.recovery.elevationGainM);
      if (b.recovery.elevationLossM !== undefined) out.recovery.elevationLossM = round(b.recovery.elevationLossM);
    }
    if (b.vamTargetMh !== undefined && out.durationS) {
      out.vamTargetMh = resolveClimb({ durationS: out.durationS, elevationGainM: out.elevationGainM ?? 0 }).vamTargetMh;
    }
    return out;
  });

  const fit = fitVertical(scaled, verticalOf(model), session.type);
  const blocks = fit.blocks;
  // Une séance dont les blocs ne portent aucune durée n'a que ses totaux : faute
  // de contenu écrit, ce sont eux qu'on met à l'échelle. Dès qu'il y a du
  // contenu, c'est lui qui fait foi.
  const written = totalDuration(session.blocks) > 0;
  return {
    blocks,
    plannedDurationS: written ? totalDuration(blocks) : Math.round(session.plannedDurationS * duration),
    plannedLoad: Math.round(session.plannedLoad * duration),
    plannedMechanicalLoad: written
      ? mechanicalFor(blocks, elevationLossOf(blocks)).total
      : Math.round(session.plannedMechanicalLoad * duration),
    plannedElevationGainM: elevationGainOf(blocks),
    ...(session.plannedDistanceM ? { plannedDistanceM: Math.round(session.plannedDistanceM * duration) } : {}),
    amendments: fit.share < 1 ? [shedNote(scaled, fit)] : [],
  };
}

/**
 * Durées mises à l'échelle, sans que l'arrondi ne déplace le total.
 *
 * Arrondir chaque bloc séparément donnait 10 799 s de contenu sous un en-tête
 * de 10 800 : la seconde manquante suffit à faire passer une sortie sous le
 * plancher de trois heures que le dossier prescrit. Le reste de la division va
 * aux blocs dont la partie fractionnaire est la plus grande.
 */
function scaledDurations(blocks: readonly SessionBlock[], factor: number): (number | undefined)[] {
  const out = blocks.map((b) => {
    if (isPrescribed(b) || !b.durationS) return b.durationS;
    return (b.repeat ?? 1) > 1 ? Math.round(b.durationS * factor) : Math.floor(b.durationS * factor + 1e-9);
  });
  const singles = blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => !isPrescribed(b) && b.durationS && (b.repeat ?? 1) <= 1);
  const wanted = Math.round(singles.reduce((a, { b }) => a + (b.durationS as number) * factor, 0));
  let missing = wanted - singles.reduce((a, { i }) => a + (out[i] as number), 0);
  const byRemainder = [...singles].sort(
    (x, y) => (((y.b.durationS as number) * factor) % 1) - (((x.b.durationS as number) * factor) % 1),
  );
  for (const { i } of byRemainder) {
    if (missing <= 0) break;
    out[i] = (out[i] as number) + 1;
    missing--;
  }
  return out;
}

/** Ce que le dénivelé a cédé, et le segment qui l'a imposé. */
function shedNote(before: readonly SessionBlock[], fit: VerticalFit): string {
  const why = fit.refused[0] ? ` ${describeVerdict(fit.refused[0])}` : '';
  return (
    `Dénivelé ramené de ${elevationGainOf(before)} à ${elevationGainOf(fit.blocks)} m D+ et de ` +
    `${elevationLossOf(before)} à ${elevationLossOf(fit.blocks)} m D− pour que la séance reste exécutable, ` +
    `marge de prescription comprise.${why}`
  );
}

const VERT_MENTION = / · \d+ m D\+/;

/**
 * Réécrit le dénivelé qu'un titre annonce, sans toucher au reste.
 *
 * Toute porte qui change le dénivelé d'une séance passe par ici : sans quoi les
 * deux nombres reparaissent à l'endroit précis où l'athlète les lit.
 */
export function restateVert(title: string, vert: number): string {
  const mention = ` · ${vert} m D+`;
  if (VERT_MENTION.test(title)) return title.replace(VERT_MENTION, mention);
  const suffix = title.indexOf(' + ');
  return suffix < 0 ? title + mention : title.slice(0, suffix) + mention + title.slice(suffix);
}

/** Distance estimée depuis la vitesse moyenne pondérée des blocs. */
function totalDistance(blocks: readonly SessionBlock[]): number {
  return blocks.reduce((a, b) => {
    // Un bloc annexe ou un circuit de force ne se parcourt pas. Lui prêter la
    // vitesse de sa zone lui ferait produire des kilomètres qui n'existent pas,
    // et par eux une charge d'impact à plat tout aussi inventée.
    if (b.kind || b.circuit) return a;
    const reps = b.repeat ?? 1;
    const mid = b.speedRangeMs ? (b.speedRangeMs[0] + b.speedRangeMs[1]) / 2 : 2.8;
    const rec = b.recovery ? b.recovery.durationS * (b.recovery.active ? 2.4 : 0.5) : 0;
    return a + reps * ((b.durationS ?? 0) * mid + rec);
  }, 0);
}

/**
 * Totaux d'une séance, déduits de ses blocs.
 *
 * Une séance dont les blocs sont remplacés doit voir *tous* ses totaux suivre —
 * durée, charge, distance, dénivelé et charge mécanique. Des totaux figés en
 * face d'un contenu neuf, c'est la même contradiction, un cran plus haut : une
 * sortie longue ramenée à 350 m D+ qui continue d'afficher la charge mécanique
 * des 700 m d'avant fausse le PMC mécanique, donc la règle qui protège les
 * quadriceps.
 *
 * Le dénivelé négatif est celui que les blocs déclarent. Un contenu qui ne le
 * déclare nulle part est une boucle : il descend ce qu'il monte, aux endroits
 * que situe `locateVertical`. `elevationLossM` ne sert plus qu'aux séances qui
 * déclarent ne rien descendre qui compte.
 */
export function sessionTotals(
  model: PhysiologyModel,
  blocks: SessionBlock[],
  elevationLossM?: number,
): {
  durationS: number;
  distanceM: number;
  elevationGainM: number;
  load: number;
  mechanicalLoad: number;
  /** Ce que recouvre `mechanicalLoad`, dont la part qu'aucun flux ne verra. */
  mechanical: { total: number; descent: number; eccentricStrength: number };
} {
  const distanceM = totalDistance(blocks);
  const elevationGainM = elevationGainOf(blocks);
  const mechanical = mechanicalFor(
    blocks,
    elevationLossM ?? elevationLossOf(locateVertical(blocks)),
    distanceM,
  );
  return {
    durationS: totalDuration(blocks),
    distanceM,
    elevationGainM,
    load: estimateLoad(model, blocks),
    mechanicalLoad: mechanical.total,
    mechanical,
  };
}

/**
 * Ferme une séance sur ses totaux, tous relus sur ses blocs.
 *
 * `elevationGainM` n'est plus un paramètre : une séance qui pourrait l'annoncer
 * à part pourrait l'annoncer faux. Ce que la séance monte est ce que ses blocs
 * montent, et rien d'autre ne peut l'écrire.
 *
 * La construction est tenue au même invariant que les transformations : un
 * segment que l'athlète ne peut pas exécuter fait céder le dénivelé de la
 * séance, et la séance le dit.
 */
function finalize(
  c: Ctx,
  base: Omit<
    SessionTemplate,
    'durationS' | 'elevationGainM' | 'plannedLoad' | 'plannedMechanicalLoad' | 'elevationLossM'
  >,
  elevationLossM?: number,
): SessionTemplate {
  const located = locateVertical(base.blocks, base.type);
  const fit = fitVertical(base.blocks, verticalOf(c.model), base.type);
  const shed = fit.share < 1;
  const blocks = shed ? fit.blocks : base.blocks;
  const loss =
    elevationLossM === undefined
      ? elevationLossOf(shed ? blocks : located)
      : Math.floor(elevationLossM * fit.share);
  const { durationS, distanceM, elevationGainM, load, mechanicalLoad } = sessionTotals(c.model, blocks, loss);
  const amendments = [...(base.amendments ?? []), ...(shed ? [shedNote(located, fit)] : [])];
  return {
    ...base,
    title: shed ? restateVert(base.title, elevationGainM) : base.title,
    blocks,
    ...(amendments.length ? { amendments } : {}),
    elevationGainM,
    elevationLossM: loss,
    durationS,
    plannedDistanceM: Math.round(distanceM),
    plannedLoad: load,
    plannedMechanicalLoad: mechanicalLoad,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Séances
// ─────────────────────────────────────────────────────────────────────────────

export function recovery(model: PhysiologyModel, durationMin = 40): SessionTemplate {
  const c = ctxOf(model);
  return finalize(c, {
    key: 'recovery',
    type: 'recovery',
    title: `Décrassage ${durationMin} min`,
    intent:
      "Accélérer la clairance métabolique sans ajouter la moindre contrainte. Le seul indicateur qui compte : la FC doit rester basse même si l'allure paraît ridicule.",
    priority: 'optional',
    phases: ['base', 'build', 'specific', 'peak', 'taper', 'recovery', 'transition'],
    blocks: [
      block(c, 'Footing très souple', 'Z1', durationMin * 60, {
        notes: 'Terrain plat et roulant. Si la FC dépasse la borne haute, marche — ce n\'est pas négociable.',
        cadenceTargetSpm: 172,
      }),
    ],
  });
}

export function endurance(model: PhysiologyModel, durationMin = 60, vertM = 0): SessionTemplate {
  const c = ctxOf(model);
  const z2 = zoneOf(c, 'Z2');
  return finalize(c, {
    key: 'endurance',
    type: 'endurance',
    title: `Endurance fondamentale ${durationMin} min${vertM ? ` · ${vertM} m D+` : ''}`,
    intent:
      'Développer la densité capillaire et la capacité oxydative : c\'est la zone qui construit le moteur des trails longs. Aisance respiratoire permanente, aucune dérive cardiaque.',
    priority: 'support',
    phases: ['base', 'build', 'specific', 'peak', 'taper', 'transition'],
    blocks: [
      block(c, 'Footing en endurance aérobie', 'Z2', durationMin * 60, {
        elevationGainM: vertM,
        elevationLossM: vertM,
        cadenceTargetSpm: 172,
        notes: `Cible ${Math.round(z2.hrMin)}-${Math.round(z2.hrMax)} bpm. Tu dois pouvoir tenir une conversation par phrases complètes.`,
      }),
    ],
  });
}

export function longRun(model: PhysiologyModel, durationMin = 105, vertM = 300): SessionTemplate {
  const c = ctxOf(model);
  const rebuild = (k: number) => longRun(model, Math.round(durationMin * k), Math.round(vertM * k));
  return { ...longRunContent(c, durationMin, vertM), rebuild };
}

function longRunContent(c: Ctx, durationMin: number, vertM: number): SessionTemplate {
  return finalize(c, {
    key: 'long_run',
    type: 'long_run',
    title: `Sortie longue ${Math.round(durationMin / 60 * 10) / 10} h · ${vertM} m D+`,
    intent:
      'Étendre la durabilité : maintenir un rendement stable sur la durée. C\'est ici que se gagne la seconde moitié des courses.',
    priority: 'key',
    phases: ['base', 'build', 'specific', 'peak'],
    blocks: [
      block(c, 'Corps de sortie en endurance', 'Z2', (durationMin - 20) * 60, {
        elevationGainM: vertM,
        elevationLossM: vertM,
        cadenceTargetSpm: 172,
        notes:
          'Surveille la dérive cardiaque : à allure constante, la FC ne doit pas monter de plus de 5 % entre la première et la seconde moitié.',
      }),
      block(c, 'Progression finale', 'Z3', 20 * 60, {
        notes: 'Vingt dernières minutes montées d\'un cran, sans jamais forcer la respiration. Habitue le corps à produire sur fatigue.',
      }),
    ],
  });
}

/** Rando-course : le format spécifique recommandé par le laboratoire pour les trails longs. */
export function longTrail(model: PhysiologyModel, durationMin = 210, vertM = 1200): SessionTemplate {
  const c = ctxOf(model);
  const z2 = zoneOf(c, 'Z2');
  const vertical = verticalOf(model);
  // Vitesse ascensionnelle cible : celle que permet la puissance métabolique de Z2 haute.
  const climbPower = 3.6 * z2.speedMaxMs * 0.94;
  const climbSpeed = speedForMetabolicPower(climbPower, 0.15);
  const targetVam = Math.round(vam(climbSpeed, 0.15));

  // Le temps d'une rando-course est un budget, et la boucle le partage : ce
  // qu'elle monte, elle le redescend. La montée prend le temps de sa vitesse
  // visée, sans jamais passer sous celui que la courbe de l'athlète accorde à
  // ce dénivelé ; la descente, au moins le sien. Corriger l'un sans l'autre a
  // déjà produit deux séances impossibles, chacune à un bout : 1 384 m montés en
  // 55 min, puis 1 384 m descendus en 16. Quand les deux ne tiennent pas dans le
  // temps de terrain, c'est le dénivelé qui cède — et la séance le dit.
  //
  // Ces temps sont ceux de l'instant où chaque segment commence, marge de
  // prescription comprise : la montée part après l'approche, la descente après
  // la montée et tout son D+. Jugée fraîche, la descente du 03/10 était
  // prescrite à 1 703 m/h quand il n'en restait que 1 465 à ce moment-là.
  const approachS = 25 * 60;
  const cooldownS = 20 * 60;
  const mobileS = Math.max(0, durationMin * 60 - approachS - cooldownS);
  const keep = 1 - PRESCRIPTION_MARGIN;
  const margin = `${Math.round(PRESCRIPTION_MARGIN * 100)} %`;
  const climbing = vertical.climb.after({ elapsedS: approachS, gainM: 0, lossM: 0 });
  const climbTime = (m: number) =>
    Math.ceil(Math.max((m / targetVam) * 3600, climbing.timeFor(m / keep).durationS));
  const descentTime = (m: number) =>
    Math.ceil(
      vertical.descent.after({ elapsedS: approachS + climbTime(m), gainM: m, lossM: 0 }).timeFor(m / keep).durationS,
    );
  const fits = (m: number) => climbTime(m) + descentTime(m) <= mobileS;

  const asked = Math.max(0, Math.round(vertM));
  let gain = asked;
  if (!fits(gain)) {
    let lo = 0;
    let hi = gain;
    while (lo < hi) {
      const mid = Math.ceil((lo + hi) / 2);
      if (fits(mid)) lo = mid;
      else hi = mid - 1;
    }
    gain = lo;
  }
  const climb = resolveClimb({ durationS: climbTime(gain), elevationGainM: gain });
  // Descente et retour roulant se partagent le reste dans la proportion qu'ils
  // avaient — 35 et 20 points sur les 55 qui ne montaient pas —, la descente ne
  // passant jamais sous son temps minimal. Un retour de quelques secondes n'est
  // pas une consigne : sous la minute, il revient à la descente.
  const remainingS = Math.max(0, mobileS - climb.durationS);
  const shareS = Math.min(remainingS, Math.max(descentTime(gain), Math.round((remainingS * 0.35) / 0.55)));
  const returnS = remainingS - shareS >= 60 ? remainingS - shareS : 0;
  const descentS = remainingS - returnS;

  const amendments: string[] = [];
  if (gain < asked) {
    amendments.push(
      `Dénivelé ramené de ${asked} à ${gain} m : ${asked} m demandent ${sessionDuration(climbTime(asked))} de ` +
        `montée et ${sessionDuration(descentTime(asked))} de descente d'après ce que tes courbes laissent à ce ` +
        `moment de la séance, marge de ${margin} comprise — au-delà des ${sessionDuration(mobileS)} de terrain que ` +
        `laisse une sortie de ${sessionDuration(durationMin * 60)}.`,
    );
  }
  if (gain > 0 && climb.vamTargetMh < targetVam) {
    amendments.push(
      `Vitesse ascensionnelle ramenée de ${targetVam} à ${climb.vamTargetMh} m/h : c'est ce que ta courbe de montée ` +
        `laisse sur ${sessionDuration(climb.durationS)} après ${sessionDuration(approachS)} d'approche, marge de ` +
        `${margin} comprise (${PROVENANCE_FR[climbing.at(climb.durationS).provenance]}).`,
    );
  }

  // La cible métabolique et la courbe décrivent le même fait : ce que l'athlète
  // monte en Z2 sur cette durée. Quand la première dépasse le meilleur effort
  // jamais tenu, les deux modèles se contredisent — la séance n'en suit qu'un,
  // et le dit.
  const record = vertical.climb.at(climb.durationS);
  const divergences: ModelDivergence[] = [];
  if (gain > 0 && targetVam > record.vamMh) {
    const observedMh = Math.round(record.vamMh);
    const gapPct = Math.round(((targetVam - record.vamMh) / record.vamMh) * 100);
    const follows =
      record.provenance === 'default'
        ? 'La séance suit la plus prudente des deux ; aucune n\'est une mesure sur cette durée.'
        : 'La séance suit la courbe en attendant : des deux, c\'est la seule mesure.';
    divergences.push({
      durationS: climb.durationS,
      modelledMh: targetVam,
      observedMh,
      observedProvenance: record.provenance,
      gapPct,
      statement:
        `Deux lectures de ta montée en Z2 divergent de ${gapPct} % sur ${sessionDuration(climb.durationS)} : ` +
        `${targetVam} m/h d'après la puissance de ton SV1 sur une pente régulière de 15 %, ${observedMh} m/h au mieux ` +
        `d'après ta courbe (${PROVENANCE_FR[record.provenance]}). Si ta meilleure montée sur cette durée a été courue ` +
        `en Z2 ou plus fort, c'est la cible métabolique qui se trompe — elle ignore le relief d'un vrai sentier ; ` +
        `sinon, c'est la courbe qui sous-estime ce que tu tiens. ${follows}`,
    });
  }

  const session = finalize(c, {
    key: 'long_trail',
    type: 'long_trail',
    // Le titre annonce ce que les blocs montent, pas ce qu'on a demandé : quand
    // la soupape a joué, les deux diffèrent, et c'est le premier chiffre que
    // l'athlète lit.
    title: `Rando-course ${Math.round(durationMin / 60 * 10) / 10} h · ${climb.elevationGainM} m D+`,
    intent:
      "Spécificité trail pure : alterner marche et course selon la pente, tenir plusieurs heures sans dérive, et habituer les quadriceps à la descente. C'est la séance qui différencie un coureur de route d'un traileur.",
    priority: 'key',
    phases: ['base', 'build', 'specific'],
    ...(amendments.length ? { amendments } : {}),
    ...(divergences.length ? { divergences } : {}),
    blocks: [
      block(c, 'Approche en endurance', 'Z2', approachS, { cadenceTargetSpm: 172 }),
      climbBlock(c, 'Montées — marche active ou course selon la pente', 'Z2', climb, {
        notes:
          `Cible ${climb.vamTargetMh} m D+/h. Au-delà de 15 % de pente, marche : mains sur les cuisses, buste droit, petits pas. Courir là serait 25 % plus coûteux pour la même vitesse.`,
      }),
      block(c, 'Descentes — travail technique', 'Z2', descentS, {
        elevationLossM: climb.elevationGainM,
        notes:
          'Cadence haute, appuis courts et légers, regard 4-5 m devant, épaules relâchées. Cherche la fluidité, pas la vitesse pure : c\'est ici que se construit la tolérance excentrique.',
        cadenceTargetSpm: 180,
      }),
      ...(returnS > 0 ? [block(c, 'Retour roulant', 'Z2', returnS, {})] : []),
      block(c, 'Retour au calme', 'Z1', cooldownS, {}),
    ],
  });
  return {
    ...session,
    rebuild: (k: number) => longTrail(model, Math.round(durationMin * k), Math.round(vertM * k)),
  };
}

export function tempo(model: PhysiologyModel, blockMin = 25): SessionTemplate {
  const c = ctxOf(model);
  const z3 = zoneOf(c, 'Z3');
  return finalize(c, {
    key: 'tempo',
    type: 'tempo',
    title: `Tempo ${blockMin} min en résistance douce`,
    intent:
      'Travailler la zone transitionnelle entre les deux seuils — l\'allure réelle des trails courts et moyens. Développe la capacité à recycler le lactate plutôt qu\'à l\'éviter.',
    priority: 'support',
    phases: ['base', 'build', 'specific', 'peak'],
    blocks: [
      // Le dénivelé de la séance est celui du terrain parcouru en s'échauffant :
      // le bloc de tempo se court sur du roulant, sans quoi l'allure prescrite
      // ne veut plus rien dire. Porté ici, il se relit ; posé sur l'en-tête, il
      // ne se refaisait depuis aucun bloc.
      block(c, 'Échauffement progressif', 'Z2', 20 * 60, { elevationGainM: TERRAIN_VERT_M.tempo }),
      block(c, `Tempo continu`, 'Z3', blockMin * 60, {
        speedLo: z3.speedMinMs * 1.02,
        speedHi: z3.speedMaxMs * 0.97,
        notes: 'Effort « confortablement dur ». Respiration ample et rythmée, mais tu ne peux plus parler qu\'en phrases courtes.',
        cadenceTargetSpm: 176,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  }, 0);
}

/** Fractionné moyen 3-12 min : le format « résistance dure » du compte rendu. */
export function threshold(model: PhysiologyModel, reps = 5, repMin = 5): SessionTemplate {
  const c = ctxOf(model);
  const z4 = zoneOf(c, 'Z4');
  // Cible resserrée juste au-dessus du seuil 2 : le stimulus utile est étroit.
  const lo = model.vt2.speedMs * 1.005;
  const hi = model.vt2.speedMs * 1.04;
  return finalize(c, {
    key: 'threshold',
    type: 'threshold',
    title: `${reps} × ${repMin} min au seuil`,
    intent:
      "Repousser le seuil anaérobie : élever la vitesse maximale soutenable, donc l'allure tenable sur 1 à 3 h. Le levier n°1 sur les formats trail courts et moyens.",
    priority: 'key',
    // Le « fractionné moyen 3-12 min » du compte rendu : rien ne le réserve à
    // la phase de développement, et l'alternance court/moyen en a besoin dès la
    // construction foncière.
    phases: ['base', 'build', 'specific', 'peak'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, { elevationGainM: TERRAIN_VERT_M.threshold }),
      block(c, 'Gammes (montées de genou, talons-fesses, foulées bondissantes)', 'Z2', 5 * 60, {
        notes: 'Trois passages de 20 s de chaque éducatif, récupération en marchant.',
      }),
      block(c, `Répétitions au seuil`, 'Z4', repMin * 60, {
        repeat: reps,
        speedLo: lo,
        speedHi: hi,
        recovery: { durationS: Math.round(repMin * 60 * 0.35), zone: 'Z1', active: true },
        cadenceTargetSpm: 178,
        notes:
          `${msToKmh(lo).toFixed(1)}-${msToKmh(hi).toFixed(1)} km/h, ${Math.round(z4.hrMin)}-${Math.round(z4.hrMax)} bpm. ` +
          `La première répétition doit sembler trop facile : si elle est difficile, tu es parti trop vite.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  }, 0);
}

/** Fractionné court en PMA : 30"-30" ou 1'-1', un seul par semaine. */
export function vo2max(model: PhysiologyModel, format: '30-30' | '1-1' | '15-15' = '30-30', sets = 2, repsPerSet = 10): SessionTemplate {
  const c = ctxOf(model);
  const spec = {
    '30-30': { work: 30, rest: 30, pct: 1.1, label: '30"-30"' },
    '1-1': { work: 60, rest: 60, pct: 1.05, label: "1'-1'" },
    '15-15': { work: 15, rest: 15, pct: 1.2, label: '15"-15"' },
  }[format];
  const target = model.vmaMs * spec.pct;
  return finalize(c, {
    key: `vo2max_${format}`,
    type: 'vo2max',
    title: `PMA — ${sets} × ${repsPerSet} × ${spec.label}`,
    intent:
      `Solliciter VO2max au plus près du plafond. À ${Math.round(spec.pct * 100)} % de VMA, le temps passé à haute fraction de VO2max est maximal — c'est le stimulus, pas la vitesse elle-même.`,
    priority: 'key',
    phases: ['build', 'specific', 'peak'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, { elevationGainM: TERRAIN_VERT_M.vo2max }),
      block(c, 'Gammes + 3 lignes droites progressives', 'Z3', 8 * 60, {}),
      block(c, `Série ${spec.label}`, 'Z5', spec.work, {
        repeat: sets * repsPerSet,
        speedLo: target * 0.97,
        speedHi: target * 1.03,
        recovery: { durationS: spec.rest, zone: 'Z1', active: format !== '15-15' },
        cadenceTargetSpm: 182,
        notes:
          `${msToKmh(target).toFixed(1)} km/h (${Math.round(spec.pct * 100)} % VMA). ` +
          `Récupération ${format === '15-15' ? 'passive' : 'active en trottinant'}. ` +
          `Pause de 4 min entre les ${sets} séries. La FC n'a pas le temps de monter : ne la regarde pas, tiens l'allure.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  }, 0);
}

/** Côtes : le fractionné court en montée recommandé par le laboratoire. */
export function hillRepeats(model: PhysiologyModel, reps = 8, repS = 90, grade = 0.10): SessionTemplate {
  const c = ctxOf(model);
  const z4 = zoneOf(c, 'Z4');
  const power = 3.6 * model.vmaMs * 0.96;
  const speed = speedForMetabolicPower(power, grade);
  const targetVam = Math.round(vam(speed, grade));
  // La répétition dure ce qui est prescrit ; ce qu'elle monte s'en déduit, à la
  // vitesse ascensionnelle visée. Le dénivelé se recalculait ici par sa propre
  // formule : deux chemins pour un même mètre, donc deux occasions de diverger.
  const climb = resolveClimb({ durationS: repS, vamTargetMh: targetVam });
  return finalize(c, {
    key: 'hill_repeats',
    type: 'hill_repeats',
    title: `Côtes — ${reps} × ${repS} s à ${Math.round(grade * 100)} %`,
    intent:
      'Puissance spécifique en montée avec une contrainte articulaire réduite : la pente permet une intensité cardiaque élevée pour des forces d\'impact bien plus faibles qu\'à plat.',
    priority: 'key',
    phases: ['base', 'build', 'specific'],
    blocks: [
      block(c, 'Échauffement jusqu\'au pied de la côte', 'Z2', 20 * 60, {}),
      // Le dénivelé de la séance *est* celui des répétitions : une côte qui
      // annonçait 208 m dont aucun bloc ne portait un mètre laissait le
      // chiffre d'en-tête vivre sa vie. Porté par la répétition, il suit le
      // nombre de répétitions sans que personne ait à le recalculer.
      climbBlock(c, `Répétitions en montée`, 'Z4', climb, {
        repeat: reps,
        speedLo: speed * 0.95,
        speedHi: speed * 1.05,
        // La récupération redescend ce que la répétition a monté : c'est un
        // segment chronométré, et ses mètres se contrôlent comme les autres.
        recovery: { durationS: repS, zone: 'Z1', active: true, elevationLossM: climb.elevationGainM },
        cadenceTargetSpm: 180,
        notes:
          `Cible ${climb.vamTargetMh} m D+/h, ${Math.round(z4.hrMin)}-${Math.round(z4.hrMax)} bpm en fin de répétition. ` +
          `Buste légèrement penché, foulée courte et fréquente, bras actifs. Descente en récupération, très souple.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  });
}

/**
 * Descente : la séance que presque personne ne fait, et qui rapporte le plus en
 * trail. Elle prépare spécifiquement à l'agression excentrique de la course.
 */
export function downhillSession(model: PhysiologyModel, reps = 6, repS = 150): SessionTemplate {
  const c = ctxOf(model);
  const lossPerRep = 90;
  return finalize(c, {
    key: 'downhill',
    type: 'downhill',
    title: `Descente technique — ${reps} × ${Math.round(repS / 60 * 10) / 10} min`,
    intent:
      "Conditionner les quadriceps à la contrainte excentrique et automatiser le pilotage en descente. Effet de séance répétée : trois semaines de ce travail réduisent nettement les dégâts musculaires du jour J.",
    priority: 'support',
    phases: ['build', 'specific'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, {}),
      block(c, 'Descentes contrôlées', 'Z3', repS, {
        repeat: reps,
        // Ce qui se descend se remonte : la répétition descend, sa récupération
        // remonte, et chacune porte ses mètres. Posés ensemble sur la
        // répétition, ils laissaient croire que la remontée n'avait pas de
        // temps à respecter.
        elevationLossM: lossPerRep,
        recovery: { durationS: Math.round(repS * 1.4), zone: 'Z2', active: true, elevationGainM: lossPerRep },
        cadenceTargetSpm: 182,
        notes:
          'Cadence très haute, appuis courts sous le centre de gravité, jamais de freinage talon. ' +
          'Regard porté loin. Remontée en récupération. Arrête la séance dès que le contrôle se dégrade : ' +
          'au-delà, tu accumules des dégâts sans bénéfice technique.',
      }),
      block(c, 'Retour au calme', 'Z1', 10 * 60, {}),
    ],
  });
}

/** Allure course : simulation spécifique sur profil proche de l'objectif. */
export function racePace(model: PhysiologyModel, blockMin = 40, targetSpeedMs?: number, vertM = 250): SessionTemplate {
  const c = ctxOf(model);
  const speed = targetSpeedMs ?? model.vt2.speedMs * 0.9;
  return finalize(c, {
    key: 'race_pace',
    type: 'race_pace',
    title: `Allure spécifique — ${blockMin} min`,
    intent:
      "Ancrer l'allure de course dans les sensations et vérifier que le couple allure/FC tient sur terrain réel. Séance de répétition générale, pas de développement.",
    priority: 'key',
    phases: ['specific', 'peak', 'taper'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, {}),
      block(c, 'Bloc à allure course, sur profil vallonné', 'Z3', blockMin * 60, {
        speedLo: speed * 0.97,
        speedHi: speed * 1.03,
        elevationGainM: vertM,
        elevationLossM: vertM,
        notes:
          `Cible ${msToKmh(speed).toFixed(1)} km/h à plat, corrigée de la pente. ` +
          `Teste aussi ta stratégie de ravitaillement : mange et bois exactement comme le jour J.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  });
}

/**
 * Le circuit du dossier : chaîne postérieure et tolérance excentrique.
 *
 * Il est déclaré, pas raconté. Le nombre de tours est le paramètre par lequel
 * on réintroduit l'excentrique après une coupure, et c'est lui qui doit
 * atteindre la charge mécanique prescrite — sans quoi un palier de reprise
 * n'existe que dans le texte d'une séance.
 */
const STRENGTH_CIRCUIT: StrengthExercise[] = [
  { movement: 'split_squat', reps: 8 },
  { movement: 'step_down', reps: 10 },
  { movement: 'single_leg_deadlift', reps: 8 },
  { movement: 'eccentric_calf', reps: 12 },
  { movement: 'isometric', reps: 45 },
];

export function strength(model: PhysiologyModel, rounds = 3): SessionTemplate {
  const c = ctxOf(model);
  const circuit: StrengthCircuit = { rounds, exercises: STRENGTH_CIRCUIT.map((e) => ({ ...e })) };
  // La séance dure ce que durent ses blocs, et le circuit dure ses tours. La
  // durée était un paramètre : elle annonçait quarante minutes quel que soit le
  // contenu, et le circuit gardait vingt minutes qu'il y ait un tour ou trois.
  const circuitS = circuitDurationS(circuit);
  const activationS = 10 * 60;
  const mobilityS = 10 * 60;
  return finalize(c, {
    key: 'strength',
    type: 'strength',
    title:
      `Renforcement spécifique ${Math.round((activationS + circuitS + mobilityS) / 60)} min · ` +
      `${rounds} tour${rounds > 1 ? 's' : ''}`,
    intent:
      "Renforcer la chaîne postérieure et la tolérance excentrique, et corriger le déficit de souplesse relevé au test (flexion avant à −1 cm). Prévention et économie de course.",
    priority: 'support',
    phases: ['base', 'build', 'specific', 'transition', 'recovery'],
    blocks: [
      block(c, 'Activation', 'Z1', activationS, {
        notes: 'Mobilité hanches/chevilles, fentes marchées, ponts fessiers.',
      }),
      // Le contenu du circuit n'est pas dans les notes : il est dans `circuit`,
      // d'où sortent à la fois le texte affiché, la durée et la charge
      // mécanique. Les écrire deux fois, c'est se donner deux occasions de se
      // contredire — et une durée annoncée dans l'intitulé en était une.
      block(c, 'Circuit force', 'Z2', circuitS, {
        circuit,
        notes:
          'Descentes lentes et mollets excentriques sont le cœur de la séance : la charge se prend en ' +
          'freinant, jamais en poussant. Deux minutes de récupération entre les tours.',
      }),
      block(c, 'Souplesse chaîne postérieure', 'Z1', mobilityS, {
        kind: 'mobility',
        notes:
          'Ischio-jambiers, mollets, chaîne postérieure du rachis. Maintiens de 45 s, deux passages. ' +
          'C\'est le point faible identifié au test : à faire deux fois par semaine, sans exception.',
      }),
    ],
  });
}

export function restDay(): SessionTemplate {
  return {
    key: 'rest',
    type: 'rest',
    title: 'Repos complet',
    intent: "L'adaptation se produit au repos, pas à l'entraînement. Ce jour fait partie du plan.",
    durationS: 0,
    elevationGainM: 0,
    elevationLossM: 0,
    priority: 'support',
    phases: ['base', 'build', 'specific', 'peak', 'taper', 'race', 'recovery', 'transition'],
    blocks: [],
    plannedLoad: 0,
    plannedMechanicalLoad: 0,
  };
}

/**
 * Rend une séance lisible en texte, pour le chat et l'export.
 *
 * Le critère de réussite y figure quand il y en a un : une séance dont on ne
 * sait pas ce qui la réussit n'est qu'une durée à passer dehors.
 */
export function renderSession(
  s:
    | SessionTemplate
    | {
        title: string;
        intent: string;
        blocks: SessionBlock[];
        successCriteria?: SessionSuccessCriterion[];
      },
): string {
  const lines = [`**${s.title}**`, `_${s.intent}_`, ''];
  const criteria = 'successCriteria' in s ? s.successCriteria : undefined;
  if (criteria?.length) {
    for (const c of criteria) {
      lines.push(`Réussite : ${CRITERION_LABEL[c.metric]}${c.maxValue != null ? ` ≤ ${c.maxValue}` : ''}`);
      lines.push(`  ↳ « ${c.origin.quote} » — ${c.origin.source === 'lab_test' ? 'test d\'effort' : 'dossier'} du ${c.origin.date}`);
    }
    lines.push('');
  }
  for (const b of s.blocks) {
    const reps = b.repeat ? `${b.repeat} × ` : '';
    const dur = b.durationS ? formatBlockDuration(b.durationS) : b.distanceM ? `${b.distanceM} m` : '';
    const hr = b.hrRange ? ` · ${b.hrRange[0]}-${b.hrRange[1]} bpm` : '';
    const pace = b.paceRange ? ` · ${b.paceRange[0]}-${b.paceRange[1]}/km` : '';
    const vamText = b.vamTargetMh ? ` · ${b.vamTargetMh} m D+/h` : '';
    const vert = verticalText(b.elevationGainM, b.elevationLossM);
    const rec = b.recovery
      ? ` — récup ${formatBlockDuration(b.recovery.durationS)} ${b.recovery.active ? 'active' : 'passive'}` +
        verticalText(b.recovery.elevationGainM, b.recovery.elevationLossM)
      : '';
    lines.push(`• ${reps}${dur} — ${b.label} (${b.zone})${hr}${pace}${vert}${vamText}${rec}`);
    if (b.circuit) lines.push(`  ↳ ${describeCircuit(b.circuit)}`);
    if (b.notes) lines.push(`  ↳ ${b.notes}`);
  }
  return lines.join('\n');
}

const CRITERION_LABEL: Record<SessionSuccessCriterion['metric'], string> = {
  hr_drift: 'pas de dérive cardiaque (Pa:HR) sur la séance',
};

function verticalText(gainM: number | undefined, lossM: number | undefined): string {
  return `${gainM ? ` · ${gainM} m D+` : ''}${lossM ? ` · ${lossM} m D−` : ''}`;
}

function formatBlockDuration(s: number): string {
  if (s >= 3600) return `${Math.round((s / 3600) * 10) / 10} h`;
  if (s >= 60) return `${Math.round(s / 60)} min`;
  return `${s} s`;
}
