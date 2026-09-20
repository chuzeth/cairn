import type {
  ParameterProvenance, PhysiologyModel, PlannedSession, SessionBlock, SessionSuccessCriterion, SessionType,
  StrengthCircuit, StrengthExercise, ZoneKey,
} from '@cairn/core';
import { PROVENANCE_FR, describeMovement, sessionDuration, weakestProvenance } from '@cairn/core';
import {
  ECCENTRIC_MOVEMENTS, buildZones, eccentricStrengthLoad, formatPace, gradeAdjustedSpeed,
  hrProvenanceOf, msToKmh, prescribedMechanicalLoad, speedForMetabolicPower, speedProvenanceOf, vam,
} from '@cairn/physiology';
import {
  PRESCRIPTION_MARGIN, describeVerdict, fitVertical, locateVertical, verticalOf, type VerticalFit,
} from './plausibility.js';
import { checkReserve, describeReserve, describeShortfall } from './reserve.js';

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

/** Provenance d'un paramètre du modèle, telle qu'il la porte. */
const provenanceOf = (model: PhysiologyModel, key: string): ParameterProvenance =>
  model.provenance?.[key] ?? 'default';

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
 *
 * `speedProvenance` accompagne une fourchette d'allure explicite : une cible
 * resserrée autour du SV2 ou d'un pourcentage de VMA ne repose plus sur les
 * bornes de sa zone, et c'est le paramètre dont elle est tirée qui la fonde.
 */
type BlockOpts = Omit<Partial<SessionBlock>, 'vamTargetMh'> & {
  speedLo?: number;
  speedHi?: number;
  speedProvenance?: ParameterProvenance;
};

function block(
  c: Ctx,
  label: string,
  zone: ZoneKey,
  durationS: number,
  opts: BlockOpts = {},
): SessionBlock {
  const z = zoneOf(c, zone);
  const lo = opts.speedLo ?? z.speedMinMs;
  // Une zone sans plafond mesuré n'en prête pas un : le bloc doit l'écrire.
  const hi = opts.speedHi ?? z.speedMaxMs;
  if (hi == null) {
    throw new Error(
      `${label} : la zone ${zone} n'a pas de borne haute de vitesse mesurée — écris speedHi.`,
    );
  }
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
    // Ce qu'on demande de tenir porte sa provenance, comme n'importe quel
    // paramètre physiologique : « 171-175 bpm » est une mesure de laboratoire,
    // « 13,6-14,0 km/h » la sortie d'une régression sur quinze séances, et rien
    // ne les distinguait à l'écran.
    b.provenance = {
      hr: hrProvenanceOf(z),
      speed: opts.speedProvenance ?? speedProvenanceOf(z),
    };
  }
  if (opts.circuit) b.circuit = opts.circuit;
  if (opts.repeat) b.repeat = opts.repeat;
  if (opts.recovery) b.recovery = recoveryTargets(c, opts.recovery);
  if (opts.notes) b.notes = opts.notes;
  if (opts.elevationGainM) b.elevationGainM = opts.elevationGainM;
  if (opts.elevationLossM) b.elevationLossM = opts.elevationLossM;
  if (opts.cadenceTargetSpm) b.cadenceTargetSpm = opts.cadenceTargetSpm;
  if (opts.distanceM) b.distanceM = opts.distanceM;
  return b;
}

/**
 * Complète une récupération par ce qu'il y a à y tenir.
 *
 * « Récup 90 s active » ne se court pas : l'athlète ne sait pas à quelle allure,
 * et le moteur la devinait — 2,4 m/s posés en dur dans le calcul de distance,
 * quelle que soit la zone écrite à côté. Une récupération est un segment de la
 * séance comme un autre : elle porte les bornes de sa zone et leur provenance,
 * et c'est sur elles qu'on juge ce qu'elle recharge.
 */
function recoveryTargets(
  c: Ctx,
  r: NonNullable<SessionBlock['recovery']>,
): NonNullable<SessionBlock['recovery']> {
  const z = zoneOf(c, r.zone);
  if (z.speedMaxMs == null) return { ...r };
  return {
    ...r,
    hrRange: [Math.round(z.hrMin), Math.round(z.hrMax)],
    speedRangeMs: [z.speedMinMs, z.speedMaxMs],
    paceRange: paceRange(z.speedMinMs, z.speedMaxMs),
    provenance: { hr: hrProvenanceOf(z), speed: speedProvenanceOf(z) },
  };
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

/**
 * Un bloc de montée, bâti sur deux nombres et jamais sur trois.
 *
 * `vamProvenance` est celle des paramètres qui ont produit la cible : la
 * puissance métabolique d'une zone, un pourcentage de VMA, et le cas échéant la
 * courbe de montée qui l'a rabotée. Sans elle, une vitesse ascensionnelle
 * extrapolée au-delà du plus long point mesuré s'afficherait comme une mesure.
 */
function climbBlock(
  c: Ctx,
  label: string,
  zone: ZoneKey,
  climb: Climb,
  vamProvenance: ParameterProvenance,
  opts: Omit<BlockOpts, 'elevationGainM' | 'durationS'> = {},
): SessionBlock {
  const b = block(c, label, zone, climb.durationS, { ...opts, elevationGainM: climb.elevationGainM });
  b.vamTargetMh = climb.vamTargetMh;
  b.provenance = { ...b.provenance, vam: vamProvenance };
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
  // Le mouvement et sa consigne d'exécution arrivent ensemble : un circuit qui
  // nomme cinq mouvements que l'athlète n'a jamais faits n'est pas une
  // prescription.
  const items = c.exercises.map((e) => describeMovement(e.movement, e.reps));
  return `${c.rounds} tour${c.rounds > 1 ? 's' : ''} : ${items.join(' ; ')}.`;
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
  const total = c.rounds * round + Math.max(0, c.rounds - 1) * CIRCUIT_REST_S;
  // À la minute supérieure : « 27'27" de circuit force » est un temps de
  // passage, pas une consigne. Vers le haut, parce que les tours sont ce qu'on
  // a prescrit et qu'il faut le temps de les faire.
  return Math.ceil(total / BLOCK_GRID_S) * BLOCK_GRID_S;
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
 *
 * Un troisième facteur, `eccentric`, ne sert qu'à la règle qui protège la
 * filière mécanique : il retire des tours aux circuits (`scaledRounds`), et le
 * circuit dure alors ce que durent les tours qui restent. Sans lui, aucun
 * allègement ne touchait jamais un palier excentrique.
 *
 * Un quatrième, `repeats`, fait la même chose sur un fractionné : il retire des
 * répétitions et laisse à celles qui restent leur durée. C'est ce qu'il fallait
 * pour que le dossier soit respecté — le compte rendu prescrit des répétitions
 * de 3 à 12 min, et un allègement à 0,45 les ramenait à 2 min 15 s, ce qui
 * n'est plus un fractionné moyen abrégé mais un autre stimulus. Alléger un
 * fractionné, c'est en faire moins, pas en faire de plus courts.
 */
export function transformSession(
  session: TransformableSession,
  change: number | { duration: number; vertical?: number; eccentric?: number; repeats?: number },
  model: PhysiologyModel,
): TransformedSession {
  const { duration, vertical = duration, eccentric = 1, repeats = 1 } =
    typeof change === 'number' ? { duration: change } : change;
  const located = locateVertical(session.blocks, session.type);
  const seconds = scaledDurations(located, duration);
  const round = (m: number | undefined) => (m === undefined ? undefined : Math.round(m * vertical));

  const scaled = located.map((b, i): SessionBlock => {
    const out: SessionBlock = { ...b };
    if (b.circuit && scaledRounds(b.circuit.rounds, eccentric) < b.circuit.rounds) {
      const circuit = { ...b.circuit, rounds: scaledRounds(b.circuit.rounds, eccentric) };
      return { ...out, circuit, durationS: circuitDurationS(circuit) };
    }
    if (isPrescribed(b)) return out;
    // Un bloc de travail garde la durée qu'il porte ; ce qui cède, c'est le
    // nombre de répétitions, jamais le temps de chacune.
    if (isWork(b)) {
      return (b.repeat ?? 1) > 1 && repeats < 1
        ? { ...out, repeat: scaledRounds(b.repeat as number, repeats) }
        : out;
    }
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

  // La maille humaine passe avant les courbes : ce qu'on soumet à l'athlète est
  // la durée qu'on lui prescrira, pas celle qu'une multiplication a produite.
  const snapped = snapToHumanGrid(scaled);
  const fit = fitVertical(snapped, verticalOf(model), session.type);
  const blocks = fit.blocks;
  // Une séance dont les blocs ne portent aucune durée n'a que ses totaux : faute
  // de contenu écrit, ce sont eux qu'on met à l'échelle. Dès qu'il y a du
  // contenu, c'est lui qui fait foi — y compris pour ce que la séance coûte :
  // le facteur demandé dit ce qu'on visait, les blocs disent ce qu'on a écrit,
  // et c'est sur les seconds que se mesure la charge.
  const written = totalDuration(session.blocks) > 0;
  const totals = written ? sessionTotals(model, blocks, elevationLossOf(blocks)) : null;
  return {
    blocks,
    plannedDurationS: totals ? totals.durationS : Math.round(session.plannedDurationS * duration),
    plannedLoad: totals ? totals.load : Math.round(session.plannedLoad * duration),
    plannedMechanicalLoad: totals
      ? totals.mechanicalLoad
      : Math.round(session.plannedMechanicalLoad * duration),
    plannedElevationGainM: elevationGainOf(blocks),
    ...(session.plannedDistanceM
      ? { plannedDistanceM: totals ? Math.round(totals.distanceM) : Math.round(session.plannedDistanceM * duration) }
      : {}),
    // Une séance transformée est une séance neuve : elle se juge sur son
    // contenu, pas sur celui qu'on a mis à l'échelle. Un allègement qui raccourcit
    // les répétitions rend le fractionné plus dense, jamais plus facile.
    amendments: [...(fit.share < 1 ? [shedNote(snapped, fit)] : []), ...reserveNote(blocks, model)],
  };
}

/**
 * Tours qu'un circuit garde quand sa charge excentrique est allégée d'un
 * facteur : au tour inférieur — ce qu'on retire ne revient pas par l'arrondi —,
 * jamais sous un tour, jamais au-delà de ce qui était prescrit.
 */
export function scaledRounds(rounds: number, factor: number): number {
  return Math.min(rounds, Math.max(1, Math.floor(rounds * factor + 1e-9)));
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
    if (isPrescribed(b) || isWork(b) || !b.durationS) return b.durationS;
    return (b.repeat ?? 1) > 1 ? Math.round(b.durationS * factor) : Math.floor(b.durationS * factor + 1e-9);
  });
  const singles = blocks
    .map((b, i) => ({ b, i }))
    .filter(({ b }) => !isPrescribed(b) && !isWork(b) && b.durationS && (b.repeat ?? 1) <= 1);
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

// ─────────────────────────────────────────────────────────────────────────────
// Nombres humains
// ─────────────────────────────────────────────────────────────────────────────

/**
 * La maille sur laquelle une séance se prescrit.
 *
 * Une durée de séance est une consigne qu'on exécute montre au poignet, pas le
 * quotient d'un budget de charge : « 1 h 01'57" » n'est pas une prescription,
 * c'est la trace d'une division. Le corps de séance se prescrit au quart
 * d'heure, ses blocs à la minute ronde ; la charge se mesure ensuite sur ce qui
 * est écrit, et quand elle s'écarte de la cible, c'est la cible qui plie.
 */
export const SESSION_GRID_S = 15 * 60;
export const BLOCK_GRID_S = 60;

/** En deçà, le dénivelé d'une séance ne dit rien de ce qu'elle demande. */
const VERT_MENTION_FLOOR_M = 50;

const onGrid = (s: number, grid: number) => Math.max(grid, Math.round(s / grid) * grid);

/**
 * La durée demandée à une séance, ramenée à ce qui se prescrit.
 *
 * L'appelant demande ce que la charge de la semaine laisse — 101,95 minutes ; la
 * séance répond au quart d'heure. C'est l'inversion, prise à l'entrée plutôt
 * qu'en sortie : ce qui est construit l'est déjà sur des nombres humains, et
 * tous les chiffres qu'on en déduit ensuite — durée d'une montée, vitesse
 * ascensionnelle, contradiction entre deux modèles — portent sur la séance
 * qu'on prescrira, pas sur un gabarit intermédiaire.
 */
export const prescribableMinutes = (min: number): number =>
  Math.max(SESSION_GRID_S / 60, Math.round(min / (SESSION_GRID_S / 60)) * (SESSION_GRID_S / 60));

/** Une durée en secondes, ramenée à la minute supérieure. */
const upToMinute = (s: number) => Math.ceil(s / BLOCK_GRID_S) * BLOCK_GRID_S;
/** Une durée en secondes, ramenée à la minute la plus proche. */
const toMinute = (s: number) => Math.round(s / BLOCK_GRID_S) * BLOCK_GRID_S;

/**
 * Un bloc dont la durée se négocie.
 *
 * Ce que le dossier ou le format prescrit ne se négocie pas : les répétitions
 * d'un fractionné (« 30"-30" » est une consigne, pas un arrondi), les tours
 * d'un circuit, les blocs annexes. Le reste — échauffement, corps de sortie,
 * retour au calme — absorbe ce qu'il faut pour que la séance tombe juste.
 */
const isFlexible = (b: SessionBlock): boolean =>
  !isPrescribed(b) && !isWork(b) && (b.repeat ?? 1) <= 1 && (b.durationS ?? 0) > 0;

/**
 * Un bloc de travail : celui qu'une récupération suit.
 *
 * Sa durée *est* le format — « 5 min au seuil », « 30" à 110 % de VMA », le
 * palier de 8 min d'une pyramide. Le dossier la prescrit et la borne ; personne
 * d'autre ne la fixe. Alléger un fractionné, c'est en faire moins, jamais en
 * faire de plus courts, et un palier qu'un facteur ramène à 2 min 06 dément le
 * titre qui l'annonce.
 */
const isWork = (b: SessionBlock): boolean =>
  !isPrescribed(b) && b.recovery != null && (b.durationS ?? 0) > 0;

/**
 * Ramène un contenu sur la maille humaine.
 *
 * Chaque bloc libre passe à la minute, puis l'écart qui sépare **ce qui se
 * court** du quart d'heure le plus proche est versé au plus long d'entre eux —
 * jamais au travail, qui vaut par sa durée.
 *
 * Le quart d'heure porte sur le corps de séance et non sur le total : les blocs
 * que le dossier prescrit — tours d'un circuit, souplesse, respiration — ont
 * leur propre durée, et la leur faire tirer le footing d'à côté reviendrait à
 * rallonger de quatre minutes une séance qu'on vient d'alléger de moitié. Sous
 * un quart d'heure, le corps garde ses minutes : arrondir huit minutes à quinze
 * ne serait plus un arrondi.
 */
export function snapToHumanGrid(blocks: readonly SessionBlock[]): SessionBlock[] {
  const out = blocks.map((b) =>
    isFlexible(b) ? { ...b, durationS: onGrid(b.durationS as number, BLOCK_GRID_S) } : { ...b },
  );
  const flexible = out.map((b, i) => ({ b, i })).filter(({ b }) => isFlexible(b));
  if (flexible.length === 0) return out;

  const prescribedS = out
    .filter(isPrescribed)
    .reduce((a, b) => a + (b.repeat ?? 1) * (b.durationS ?? 0), 0);
  const runS = totalDuration(out) - prescribedS;
  const wantedRun = runS >= SESSION_GRID_S ? Math.round(runS / SESSION_GRID_S) * SESSION_GRID_S : runS;

  // L'écart se verse sur un bloc facile — échauffement, retour au calme, corps
  // de sortie —, jamais sur un bloc dont le titre annonce la durée : « Allure
  // spécifique 40 min » au-dessus d'un bloc de 43 est la contradiction qu'on
  // ferme. À défaut, le plus long ; il n'y a alors rien d'autre à faire céder.
  const easy = flexible.filter(({ b }) => b.zone === 'Z1' || b.zone === 'Z2');
  const longest = (easy.length > 0 ? easy : flexible).reduce((a, x) =>
    (x.b.durationS as number) > (a.b.durationS as number) ? x : a,
  );
  const adjusted = (longest.b.durationS as number) + (wantedRun - runS);
  out[longest.i] = { ...longest.b, durationS: Math.max(BLOCK_GRID_S, adjusted) };
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Titres
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le titre d'une séance : ce qu'elle est, ce qu'elle dure, ce qu'elle monte ou
 * descend — dans cet ordre et toujours aux mêmes places.
 *
 * Le titre nommait le bloc principal pendant que la durée enregistrée comptait
 * tout : deux « Décrassage 40 min » de 58 et 48 minutes, et une descente
 * décrite par son dénivelé positif. Un titre dit la séance entière, et les
 * places fixes sont ce qui permet de le relire quand le contenu change.
 */
export function sessionTitle(
  format: string,
  durationS: number,
  vert?: { m: number; sign: '+' | '−' },
): string {
  const head = `${format} — ${sessionDuration(durationS)}`;
  return vert && vert.m > VERT_MENTION_FLOOR_M ? `${head} · ${vert.m} m D${vert.sign}` : head;
}

const DURATION_MENTION = / — [^·+]*?(?=( ·| \+)|$)/;
const VERT_MENTION = / · \d+ m D[+−]/;

/**
 * Réécrit la durée qu'un titre annonce, sans toucher au reste.
 *
 * Toute porte qui change ce que dure une séance passe par ici — calibration,
 * allègement, bloc annexe adossé par une fréquence hebdomadaire. Sinon le titre
 * continue d'annoncer la séance d'avant, à l'endroit précis où l'athlète la lit.
 */
export function restateDuration(title: string, durationS: number): string {
  const mention = ` — ${sessionDuration(durationS)}`;
  if (DURATION_MENTION.test(title)) return title.replace(DURATION_MENTION, mention);
  const suffix = title.search(/ [·+] /);
  return suffix < 0 ? title + mention : title.slice(0, suffix) + mention + title.slice(suffix);
}

/**
 * Réécrit le dénivelé qu'un titre annonce, sans toucher au reste.
 *
 * Le signe compte : une séance de descente annonçait « 414 m D+ », qui est ce
 * que ses remontées de récupération cumulaient — le seul chiffre du titre ne
 * décrivait pas la séance.
 */
export function restateVert(title: string, vert: number, sign: '+' | '−' = '+'): string {
  const mention = vert > VERT_MENTION_FLOOR_M ? ` · ${vert} m D${sign}` : '';
  if (VERT_MENTION.test(title)) return title.replace(VERT_MENTION, mention);
  return mention ? title + mention : title;
}

/**
 * Ajoute une mention au format d'un titre, devant la durée et le dénivelé.
 *
 * « Endurance fondamentale + renforcement — 1 h 30 · 120 m D+ » : la mention
 * appartient à ce qu'est la séance, pas à ce qu'elle mesure. Collée en fin de
 * titre, elle passait derrière le dénivelé et les deux se lisaient ensemble.
 */
export function addFormatMention(title: string, mention: string): string {
  const i = title.indexOf(' — ');
  return i < 0 ? `${title} ${mention}` : `${title.slice(0, i)} ${mention}${title.slice(i)}`;
}

/**
 * Le dénivelé qu'une séance annonce, et son signe.
 *
 * Une descente se décrit par ce qu'elle descend ; tout le reste par ce qu'il
 * monte. Le chiffre se lit sur les blocs, comme partout ailleurs.
 */
export function titleVertical(
  type: SessionType,
  blocks: readonly SessionBlock[],
): { m: number; sign: '+' | '−' } {
  return type === 'downhill'
    ? { m: elevationLossOf(blocks), sign: '−' }
    : { m: elevationGainOf(blocks), sign: '+' };
}

/**
 * Relit le titre d'une séance sur son contenu : durée entière, dénivelé signé.
 *
 * C'est le seul endroit qui rend un titre vérifiable — quiconque touche aux
 * blocs passe par là, et le titre suit sans que personne ait à y penser.
 */
export function retitleFromContent(s: {
  title: string;
  type: SessionType;
  blocks: readonly SessionBlock[];
}): string {
  const vert = titleVertical(s.type, s.blocks);
  return restateVert(restateDuration(s.title, totalDuration(s.blocks)), vert.m, vert.sign);
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
    // La récupération se parcourt à ce qu'elle prescrit : le haut de sa bande
    // quand elle est active, presque rien quand elle est passive. Les 2,4 m/s
    // posés en dur étaient le plafond de Z1 recopié à la main — un second
    // chiffre pour le même fait, qui ne suivait pas le modèle. Ils restent le
    // repli des contenus écrits avant que la récupération porte ses cibles.
    const rec = b.recovery
      ? b.recovery.durationS *
        (b.recovery.active ? b.recovery.speedRangeMs?.[1] ?? 2.4 : 0.5)
      : 0;
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
 * `title` n'est plus un titre mais le **format** de la séance — « Décrassage »,
 * « Seuil 3 × 5 min ». La durée et le dénivelé s'y ajoutent ici, mesurés sur le
 * contenu : c'est ce qui rend titre et contenu vérifiables l'un par l'autre. Un
 * titre écrit à la main pouvait annoncer 40 minutes sur une séance qui en
 * durait 58.
 *
 * `elevationGainM` n'est pas davantage un paramètre : ce que la séance monte
 * est ce que ses blocs montent, et rien d'autre ne peut l'écrire.
 *
 * Le contenu passe d'abord sur la maille humaine, ensuite seulement devant les
 * courbes de l'athlète : c'est la durée prescrite qu'il s'agit de juger, pas
 * celle qu'une division a produite.
 */
function finalize(
  c: Ctx,
  base: Omit<
    SessionTemplate,
    'durationS' | 'elevationGainM' | 'plannedLoad' | 'plannedMechanicalLoad' | 'elevationLossM'
  >,
  elevationLossM?: number,
): SessionTemplate {
  const snapped = snapToHumanGrid(base.blocks);
  const located = locateVertical(snapped, base.type);
  const fit = fitVertical(snapped, verticalOf(c.model), base.type);
  const shed = fit.share < 1;
  const blocks = shed ? fit.blocks : snapped;
  const loss =
    elevationLossM === undefined
      ? elevationLossOf(shed ? blocks : located)
      : Math.floor(elevationLossM * fit.share);
  const { durationS, distanceM, elevationGainM, load, mechanicalLoad } = sessionTotals(c.model, blocks, loss);
  const amendments = [
    ...(base.amendments ?? []),
    ...(shed ? [shedNote(located, fit)] : []),
    ...reserveNote(blocks, c.model),
  ];
  return {
    ...base,
    title: sessionTitle(base.title, durationS, titleVertical(base.type, blocks)),
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

/**
 * Ce que la séance a à dire de la réserve anaérobie, quand il y a quelque chose
 * à en dire.
 *
 * Le dénivelé cède ; la réserve, non. Un dénivelé se rabote sans changer la
 * nature de la séance, alors que retirer des répétitions à un fractionné, c'est
 * choisir à la place de qui a écrit le format — et le nombre de répétitions est
 * précisément ce que le dossier et la phase prescrivent. La séance dit donc ce
 * qu'elle demande, et laisse la décision à `adapt.ts` ou à l'athlète.
 */
function reserveNote(blocks: readonly SessionBlock[], model: PhysiologyModel): string[] {
  const check = checkReserve(blocks, model);
  if (check.prescribable) return [];
  const head = check.feasible
    ? 'Séance à la limite de la réserve anaérobie'
    : 'Séance infaisable en l\'état : la réserve anaérobie tombe à zéro avant le dernier bloc';
  return [`${head} — ${describeShortfall(check)} ${describeReserve(check)}`];
}

/** Répétitions en deçà desquelles un fractionné n'est plus un fractionné. */
const MIN_REPETITIONS = 3;

/**
 * Ramène un fractionné au nombre de répétitions que la réserve anaérobie
 * finance, et dit ce qu'il a perdu.
 *
 * C'est la même soupape que pour le dénivelé, sur l'autre grandeur : le
 * dénivelé cède parce que le temps est ce qu'on a demandé, les répétitions
 * cèdent parce que l'allure et la durée d'une répétition sont ce que le dossier
 * prescrit. Ce qui ne cède jamais, c'est le format.
 *
 * Quand même le plancher ne tient pas, la séance est rendue telle qu'on l'a
 * demandée : `finalize` y a déjà écrit qu'elle est infaisable, et une séance
 * réduite à deux répétitions ne serait plus celle que la phase appelle.
 */
function fitRepetitions(
  build: (reps: number) => SessionTemplate,
  asked: number,
  model: PhysiologyModel,
): SessionTemplate {
  const wanted = build(asked);
  if (asked <= MIN_REPETITIONS || checkReserve(wanted.blocks, model).prescribable) return wanted;

  for (let reps = asked - 1; reps >= MIN_REPETITIONS; reps--) {
    const s = build(reps);
    if (!checkReserve(s.blocks, model).prescribable) continue;
    return {
      ...s,
      amendments: [
        ...(s.amendments ?? []),
        `Répétitions ramenées de ${asked} à ${reps} : à ${asked}, ` +
          describeShortfall(checkReserve(wanted.blocks, model)),
      ],
    };
  }
  return wanted;
}

// ─────────────────────────────────────────────────────────────────────────────
// Séances
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un éducatif que l'athlète n'a jamais fait se décrit, ou ne se demande pas.
 *
 * Son historique est du fractionné, des pyramides et du footing. « Gammes
 * (montées de genou, talons-fesses, foulées bondissantes) » nomme trois
 * mouvements sans dire comment les exécuter : ce n'est pas une prescription,
 * c'est un mot de passe entre entraîneurs.
 */
const GAMMES_CUE =
  '20 s de chaque, retour en marchant : montées de genou (cuisse à l\'horizontale, appui bref), ' +
  'talons-fesses (talon au fessier, genou sous la hanche), foulées bondissantes (pousse vers le haut, ' +
  'grande amplitude, réception amortie). Deux passages.';

/**
 * Ce que dure la récupération entre deux répétitions, en minutes rondes.
 *
 * Environ un tiers du travail, comme avant — mais arrondi : « récup 1'45" » est
 * le quotient d'une multiplication, pas une consigne qu'on lit sur une montre.
 */
const recoveryMinutes = (workMin: number): number => Math.max(1, Math.round(workMin * 0.35));

export function recovery(model: PhysiologyModel, durationMin = 40): SessionTemplate {
  const c = ctxOf(model);
  return finalize(c, {
    key: 'recovery',
    type: 'recovery',
    title: 'Décrassage',
    intent: "Faire circuler sans rien coûter : la FC reste sous la borne haute, quitte à marcher.",
    priority: 'optional',
    phases: ['base', 'build', 'specific', 'peak', 'taper', 'recovery', 'transition'],
    blocks: [
      block(c, 'Footing très souple', 'Z1', durationMin * 60, {
        notes: 'Terrain plat et roulant. FC au-dessus de la borne haute : tu marches.',
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
    title: 'Endurance fondamentale',
    intent: 'Construire le moteur aérobie : tu dois pouvoir parler par phrases complètes du début à la fin.',
    priority: 'support',
    phases: ['base', 'build', 'specific', 'peak', 'taper', 'transition'],
    blocks: [
      block(c, 'Footing en endurance aérobie', 'Z2', durationMin * 60, {
        elevationGainM: vertM,
        elevationLossM: vertM,
        cadenceTargetSpm: 172,
        notes: `Cible ${Math.round(z2.hrMin)}-${Math.round(z2.hrMax)} bpm.`,
      }),
    ],
  });
}

export function longRun(model: PhysiologyModel, durationMin = 105, vertM = 300): SessionTemplate {
  const c = ctxOf(model);
  const minutes = prescribableMinutes(durationMin);
  const rebuild = (k: number) => longRun(model, durationMin * k, Math.round(vertM * k));
  return { ...longRunContent(c, minutes, vertM), rebuild };
}

function longRunContent(c: Ctx, durationMin: number, vertM: number): SessionTemplate {
  return finalize(c, {
    key: 'long_run',
    type: 'long_run',
    title: 'Sortie longue',
    intent: 'Tenir un rendement stable sur la durée : c\'est la seconde moitié des courses qui se joue ici.',
    priority: 'key',
    phases: ['base', 'build', 'specific', 'peak'],
    blocks: [
      block(c, 'Corps de sortie en endurance', 'Z2', (durationMin - 20) * 60, {
        elevationGainM: vertM,
        elevationLossM: vertM,
        cadenceTargetSpm: 172,
        notes: 'À allure constante, la FC ne doit pas monter de plus de 5 % entre la première et la seconde moitié.',
      }),
      block(c, 'Progression finale', 'Z3', 20 * 60, {
        notes: 'Vingt dernières minutes montées d\'un cran, sans forcer la respiration.',
      }),
    ],
  });
}

/**
 * Le footing prolongé du compte rendu : « 1 h 30 à 2 h 30 sur du roulant à
 * 141-155 bpm ».
 *
 * La consigne était au dossier, traduite par `prescription.ts`, et n'atteignait
 * aucune séance : elle ne vise que `long_run`, et la sortie longue de la semaine
 * est une rando-course dès qu'on quitte la phase foncière. Vingt-deux jours de
 * plan, deux séances au-delà d'1 h 30, toutes deux des rando-courses. Celle-ci
 * est la séance que la directive décrit : du roulant, une seule zone, et la
 * durée pour tout contenu.
 */
export function longFooting(model: PhysiologyModel, durationMin = 105, vertM = 150): SessionTemplate {
  const c = ctxOf(model);
  const z2 = zoneOf(c, 'Z2');
  const minutes = prescribableMinutes(durationMin);
  const session = finalize(c, {
    key: 'long_footing',
    type: 'long_run',
    title: 'Footing prolongé',
    intent:
      "Allonger ce que tu tiens d'un seul tenant : la durabilité est ton facteur limitant mesuré, et elle se construit par la durée.",
    priority: 'key',
    phases: ['base', 'build', 'specific', 'peak'],
    blocks: [
      block(c, 'Footing en endurance, terrain roulant', 'Z2', minutes * 60, {
        elevationGainM: vertM,
        elevationLossM: vertM,
        cadenceTargetSpm: 172,
        notes:
          `${Math.round(z2.hrMin)}-${Math.round(z2.hrMax)} bpm d'un bout à l'autre. ` +
          `Si la FC dérive de plus de 5 % à allure constante, la séance est finie.`,
      }),
    ],
  });
  return {
    ...session,
    rebuild: (k: number) => longFooting(model, durationMin * k, Math.round(vertM * k)),
  };
}

/** Rando-course : le format spécifique recommandé par le laboratoire pour les trails longs. */
export function longTrail(model: PhysiologyModel, durationMin = 210, vertM = 1200): SessionTemplate {
  const c = ctxOf(model);
  // Le budget de terrain se calcule sur la durée qu'on prescrira, jamais sur
  // celle qu'un facteur a produite : tout ce qui s'en déduit — temps de montée,
  // vitesse ascensionnelle visée, contradiction entre les deux modèles — porte
  // alors sur la séance que l'athlète lira.
  const minutes = prescribableMinutes(durationMin);
  const z2 = zoneOf(c, 'Z2');
  const vertical = verticalOf(model);
  // Vitesse ascensionnelle cible : celle que permet la puissance métabolique de Z2 haute.
  // Z2 est toujours bornée en haut : son plafond est le SV1.
  const climbPower = 3.6 * (z2.speedMaxMs as number) * 0.94;
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
  const mobileS = Math.max(0, minutes * 60 - approachS - cooldownS);
  const keep = 1 - PRESCRIPTION_MARGIN;
  const margin = `${Math.round(PRESCRIPTION_MARGIN * 100)} %`;
  const climbing = vertical.climb.after({ elapsedS: approachS, gainM: 0, lossM: 0 });
  const climbTime = (m: number) =>
    upToMinute(Math.max((m / targetVam) * 3600, climbing.timeFor(m / keep).durationS));
  const descentTime = (m: number) =>
    upToMinute(
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
  const shareS = Math.min(remainingS, Math.max(descentTime(gain), toMinute((remainingS * 0.35) / 0.55)));
  const returnS = remainingS - shareS >= 60 ? remainingS - shareS : 0;
  const descentS = remainingS - returnS;

  const amendments: string[] = [];
  if (gain < asked) {
    amendments.push(
      `Dénivelé ramené de ${asked} à ${gain} m : ${asked} m demandent ${sessionDuration(climbTime(asked))} de ` +
        `montée et ${sessionDuration(descentTime(asked))} de descente d'après ce que tes courbes laissent à ce ` +
        `moment de la séance, marge de ${margin} comprise — au-delà des ${sessionDuration(mobileS)} de terrain que ` +
        `laisse une sortie de ${sessionDuration(minutes * 60)}.`,
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
  // La cible vient de la puissance de Z2 — donc du SV1 —, éventuellement rabotée
  // par ce que la courbe de montée laisse à cet instant de la séance. Elle ne
  // vaut pas mieux que le plus faible des deux.
  const climbProvenance = weakestProvenance(
    provenanceOf(model, 'vt1.speedMs'),
    climb.vamTargetMh < targetVam ? climbing.at(climb.durationS).provenance : null,
  );
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
    title: 'Rando-course',
    intent:
      'Alterner marche et course selon la pente, plusieurs heures sans dérive : la seule séance qui prépare les quadriceps à la descente du jour J.',
    priority: 'key',
    phases: ['base', 'build', 'specific'],
    ...(amendments.length ? { amendments } : {}),
    ...(divergences.length ? { divergences } : {}),
    blocks: [
      block(c, 'Approche en endurance', 'Z2', approachS, { cadenceTargetSpm: 172 }),
      climbBlock(c, 'Montées — marche active ou course selon la pente', 'Z2', climb, climbProvenance, {
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
    rebuild: (k: number) => longTrail(model, durationMin * k, Math.round(vertM * k)),
  };
}

export function tempo(model: PhysiologyModel, blockMin = 25): SessionTemplate {
  const c = ctxOf(model);
  const z3 = zoneOf(c, 'Z3');
  return finalize(c, {
    key: 'tempo',
    type: 'tempo',
    title: `Tempo ${blockMin} min`,
    intent: 'Apprendre à recycler le lactate plutôt qu\'à l\'éviter : c\'est l\'allure réelle des trails courts.',
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
        speedHi: (z3.speedMaxMs as number) * 0.97,
        notes: 'Confortablement dur : respiration ample, phrases courtes seulement.',
        cadenceTargetSpm: 176,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  }, 0);
}

/** Fractionné moyen 3-12 min : le format « résistance dure » du compte rendu. */
export function threshold(model: PhysiologyModel, reps = 5, repMin = 5): SessionTemplate {
  return fitRepetitions((n) => thresholdContent(model, n, repMin), reps, model);
}

/**
 * La fourchette d'allure du travail au seuil, et d'où elle vient.
 *
 * Cible resserrée juste au-dessus du début du domaine sévère : le stimulus
 * utile est étroit. Ce début est la vitesse critique dès qu'elle dépasse le
 * SV2 — ce que la construction du modèle produit toujours, le SV2 étant la CS
 * divisée par 1,02. Calée sur le seul SV2, la séance prescrivait
 * 13,55-14,03 km/h pour une vitesse critique à 13,98 : la moitié basse de la
 * fourchette était sous l'asymptote, donc à une intensité dont le modèle dit
 * lui-même qu'elle a un état stable — elle n'entame pas la réserve anaérobie et
 * ne produit aucun stimulus de seuil. La bande de FC, elle, reste celle de Z4,
 * qui est la prescription du compte rendu.
 *
 * Répétitions égales et pyramide la partagent : deux formats du même travail ne
 * peuvent pas prescrire deux allures.
 */
function severeRange(model: PhysiologyModel): {
  lo: number;
  hi: number;
  speedProvenance: ParameterProvenance;
} {
  const severe = Math.max(model.vt2.speedMs, model.criticalSpeedMs);
  return {
    lo: severe * 1.005,
    hi: severe * 1.04,
    speedProvenance: weakestProvenance(
      provenanceOf(model, 'vt2.speedMs'),
      provenanceOf(model, 'criticalSpeedMs'),
    ),
  };
}

function thresholdContent(model: PhysiologyModel, reps: number, repMin: number): SessionTemplate {
  const c = ctxOf(model);
  const z4 = zoneOf(c, 'Z4');
  const { lo, hi, speedProvenance } = severeRange(model);
  return finalize(c, {
    key: 'threshold',
    type: 'threshold',
    title: `Seuil ${reps} × ${repMin} min`,
    intent: "Élever la vitesse maximale soutenable, donc l'allure que tu tiens sur 1 à 3 h.",
    priority: 'key',
    // Le « fractionné moyen 3-12 min » du compte rendu : rien ne le réserve à
    // la phase de développement, et l'alternance court/moyen en a besoin dès la
    // construction foncière.
    phases: ['base', 'build', 'specific', 'peak'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, { elevationGainM: TERRAIN_VERT_M.threshold }),
      block(c, 'Gammes', 'Z2', 5 * 60, { notes: GAMMES_CUE }),
      block(c, `Répétitions au seuil`, 'Z4', repMin * 60, {
        repeat: reps,
        speedLo: lo,
        speedHi: hi,
        speedProvenance,
        // La récupération se prescrit à la minute ronde comme le reste : « récup
        // 1'45" » est un quotient, pas une consigne.
        recovery: { durationS: recoveryMinutes(repMin) * 60, zone: 'Z1', active: true },
        cadenceTargetSpm: 178,
        notes:
          `${msToKmh(lo).toFixed(1)}-${msToKmh(hi).toFixed(1)} km/h, ${Math.round(z4.hrMin)}-${Math.round(z4.hrMax)} bpm. ` +
          `La première répétition doit sembler trop facile.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  }, 0);
}

/**
 * Pyramide : le fractionné moyen que l'athlète exécute réellement.
 *
 * Rien ne la rend physiologiquement supérieure à des répétitions égales — même
 * zone, mêmes bornes que le compte rendu, 3 à 12 min à 171-175 bpm, une séance
 * par semaine. Ce qu'elle a pour elle est qu'il la fait, et un format exécuté
 * vaut mieux qu'un format prescrit.
 */
export function pyramid(
  model: PhysiologyModel,
  steps: readonly number[] = [3, 5, 8, 5, 3],
): SessionTemplate {
  return fitRepetitions((n) => pyramidContent(model, trimLadder(steps, n)), steps.length, model);
}

/**
 * Raccourcit l'échelle par ses extrémités, en gardant son sommet.
 *
 * C'est la seule façon de retirer du travail à une pyramide sans en faire autre
 * chose : raboter le sommet changerait le stimulus, couper d'un seul côté ne
 * serait plus une pyramide.
 */
function trimLadder(steps: readonly number[], n: number): number[] {
  const drop = Math.max(0, steps.length - n);
  const head = Math.ceil(drop / 2);
  return steps.slice(head, steps.length - (drop - head));
}

function pyramidContent(model: PhysiologyModel, steps: readonly number[]): SessionTemplate {
  const c = ctxOf(model);
  const z4 = zoneOf(c, 'Z4');
  const { lo, hi, speedProvenance } = severeRange(model);
  return finalize(
    c,
    {
      key: 'pyramid',
      type: 'threshold',
      title: `Pyramide ${steps.join('-')} min`,
      intent:
        "Monter puis redescendre l'échelle des durées au seuil : même travail que des répétitions égales, dans le format que tu tiens.",
      priority: 'key',
      phases: ['base', 'build', 'specific', 'peak'],
      blocks: [
        block(c, 'Échauffement', 'Z2', 20 * 60, { elevationGainM: TERRAIN_VERT_M.threshold }),
        block(c, 'Gammes', 'Z2', 5 * 60, { notes: GAMMES_CUE }),
        ...steps.map((min, i) =>
          block(c, `Palier ${i + 1}/${steps.length}`, 'Z4', min * 60, {
            speedLo: lo,
            speedHi: hi,
            speedProvenance,
            recovery: { durationS: recoveryMinutes(min) * 60, zone: 'Z1', active: true },
            cadenceTargetSpm: 178,
            ...(i === 0
              ? {
                  notes:
                    `${msToKmh(lo).toFixed(1)}-${msToKmh(hi).toFixed(1)} km/h, ` +
                    `${Math.round(z4.hrMin)}-${Math.round(z4.hrMax)} bpm sur tous les paliers. ` +
                    `Le premier doit sembler trop facile.`,
                }
              : {}),
          }),
        ),
        block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
      ],
    },
    0,
  );
}

/** Pause entre deux séries de fractionné court, s — celle que les consignes annonçaient. */
const SET_REST_S = 4 * 60;

/**
 * Fractionné court en PMA : 30"-30" ou 1'-1', un seul par semaine.
 *
 * Les séries sont des blocs, pas une phrase. « 2 × 10 × 30"-30" » s'écrivait
 * comme une seule répétition de vingt, la pause de quatre minutes entre les deux
 * séries reléguée dans les notes : ni la charge, ni la distance, ni le bilan de
 * réserve anaérobie ne la voyaient, et la séance se jugeait comme vingt
 * répétitions d'affilée — ce que personne ne prescrit et ce que le modèle
 * déclare infaisable. La pause est le bloc qui rend la séance exécutable ; elle
 * appartient au contenu.
 */
export function vo2max(model: PhysiologyModel, format: '30-30' | '1-1' | '15-15' = '30-30', sets = 2, repsPerSet = 10): SessionTemplate {
  return fitRepetitions((reps) => vo2maxContent(model, format, sets, reps), repsPerSet, model);
}

function vo2maxContent(
  model: PhysiologyModel,
  format: '30-30' | '1-1' | '15-15',
  sets: number,
  repsPerSet: number,
): SessionTemplate {
  const c = ctxOf(model);
  const spec = {
    '30-30': { work: 30, rest: 30, pct: 1.1, label: '30"-30"' },
    '1-1': { work: 60, rest: 60, pct: 1.05, label: "1'-1'" },
    '15-15': { work: 15, rest: 15, pct: 1.2, label: '15"-15"' },
  }[format];
  const target = model.vmaMs * spec.pct;
  const series = (index: number): SessionBlock[] => [
    ...(index > 0 ? [block(c, `Pause entre séries`, 'Z1', SET_REST_S, {
      notes: 'Marche ou trot très souple.',
    })] : []),
    block(c, sets > 1 ? `Série ${index + 1}/${sets} — ${spec.label}` : `Série ${spec.label}`, 'Z5', spec.work, {
      repeat: repsPerSet,
      speedLo: target * 0.97,
      speedHi: target * 1.03,
      speedProvenance: provenanceOf(model, 'vmaMs'),
      recovery: { durationS: spec.rest, zone: 'Z1', active: format !== '15-15' },
      cadenceTargetSpm: 182,
      notes:
        `${msToKmh(target).toFixed(1)} km/h (${Math.round(spec.pct * 100)} % VMA), ` +
        `récupération ${format === '15-15' ? 'passive' : 'active en trottinant'}. ` +
        `La FC n'a pas le temps de monter : ne la regarde pas, tiens l'allure.`,
    }),
  ];
  return finalize(c, {
    key: `vo2max_${format}`,
    type: 'vo2max',
    title: `PMA ${sets} × ${repsPerSet} × ${spec.label}`,
    intent: `Accumuler du temps près du plafond de VO2max : à ${Math.round(spec.pct * 100)} % de VMA, c'est ce temps-là le stimulus, pas la vitesse.`,
    priority: 'key',
    phases: ['build', 'specific', 'peak'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, { elevationGainM: TERRAIN_VERT_M.vo2max }),
      block(c, 'Gammes puis 3 lignes droites progressives', 'Z3', 8 * 60, {
        notes: `${GAMMES_CUE} Puis 3 × 80 m en montant progressivement jusqu'à l'allure de la séance, retour en marchant.`,
      }),
      ...Array.from({ length: Math.max(1, sets) }, (_, i) => series(i)).flat(),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  }, 0);
}

/** Côtes : le fractionné court en montée recommandé par le laboratoire. */
export function hillRepeats(model: PhysiologyModel, reps = 8, repS = 90, grade = 0.10): SessionTemplate {
  return fitRepetitions((n) => hillRepeatsContent(model, n, repS, grade), reps, model);
}

function hillRepeatsContent(
  model: PhysiologyModel,
  reps: number,
  repS: number,
  grade: number,
): SessionTemplate {
  const c = ctxOf(model);
  const z4 = zoneOf(c, 'Z4');
  const power = 3.6 * model.vmaMs * 0.96;
  const speed = speedForMetabolicPower(power, grade);
  const targetVam = Math.round(vam(speed, grade));
  // La fourchette d'allure d'un bloc est une allure à plat — c'est ce que le
  // type déclare, et ce qui la rend comparable aux zones et à la vitesse
  // critique. Une côte déclarait sa vitesse au sol : 10,4 km/h annoncés sur un
  // bloc de Z4, c'est-à-dire une allure de Z2 sous une étiquette de résistance
  // dure, et une séance de côtes que le bilan de réserve anaérobie lisait comme
  // une récupération. Ce qu'il y a à tenir dans la pente, c'est la vitesse
  // ascensionnelle, et elle est juste à côté.
  const flat = gradeAdjustedSpeed(speed, grade);
  // La répétition dure ce qui est prescrit ; ce qu'elle monte s'en déduit, à la
  // vitesse ascensionnelle visée. Le dénivelé se recalculait ici par sa propre
  // formule : deux chemins pour un même mètre, donc deux occasions de diverger.
  const climb = resolveClimb({ durationS: repS, vamTargetMh: targetVam });
  return finalize(c, {
    key: 'hill_repeats',
    type: 'hill_repeats',
    title: `Côtes ${reps} × ${repS} s à ${Math.round(grade * 100)} %`,
    intent: 'Prendre une intensité cardiaque haute pour des impacts faibles : c\'est ce que la pente permet et que le plat interdit.',
    priority: 'key',
    phases: ['base', 'build', 'specific'],
    blocks: [
      block(c, 'Échauffement jusqu\'au pied de la côte', 'Z2', 20 * 60, {}),
      // Le dénivelé de la séance *est* celui des répétitions : une côte qui
      // annonçait 208 m dont aucun bloc ne portait un mètre laissait le
      // chiffre d'en-tête vivre sa vie. Porté par la répétition, il suit le
      // nombre de répétitions sans que personne ait à le recalculer.
      climbBlock(c, `Répétitions en montée`, 'Z4', climb, provenanceOf(model, 'vmaMs'), {
        repeat: reps,
        speedLo: flat * 0.95,
        speedHi: flat * 1.05,
        speedProvenance: provenanceOf(model, 'vmaMs'),
        // La récupération redescend ce que la répétition a monté : c'est un
        // segment chronométré, et ses mètres se contrôlent comme les autres.
        recovery: { durationS: repS, zone: 'Z1', active: true, elevationLossM: climb.elevationGainM },
        cadenceTargetSpm: 180,
        notes:
          `Cible ${climb.vamTargetMh} m D+/h, ${Math.round(z4.hrMin)}-${Math.round(z4.hrMax)} bpm en fin de répétition. ` +
          `Buste penché, foulée courte, bras actifs. Redescends en trottinant.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  });
}

/**
 * Descente : la séance que presque personne ne fait, et qui rapporte le plus en
 * trail. Elle prépare spécifiquement à l'agression excentrique de la course.
 */
export function downhillSession(model: PhysiologyModel, reps = 6, repMin = 3): SessionTemplate {
  const c = ctxOf(model);
  const lossPerRep = 90;
  return finalize(c, {
    key: 'downhill',
    type: 'downhill',
    // Une descente se nomme par ses minutes rondes et se chiffre par ce qu'elle
    // descend : « 6 × 2.5 min · 414 m D+ » annonçait les remontées de
    // récupération d'une séance dont le sujet est la descente.
    title: `Descente technique ${reps} × ${repMin} min`,
    intent:
      'Habituer les quadriceps au freinage : trois semaines de ce travail réduisent nettement les dégâts du jour J.',
    priority: 'support',
    phases: ['build', 'specific'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, {}),
      block(c, 'Descentes contrôlées', 'Z3', repMin * 60, {
        repeat: reps,
        // Ce qui se descend se remonte : la répétition descend, sa récupération
        // remonte, et chacune porte ses mètres. Posés ensemble sur la
        // répétition, ils laissaient croire que la remontée n'avait pas de
        // temps à respecter.
        elevationLossM: lossPerRep,
        recovery: {
          durationS: Math.max(1, Math.round(repMin * 1.4)) * 60,
          zone: 'Z2',
          active: true,
          elevationGainM: lossPerRep,
        },
        cadenceTargetSpm: 182,
        notes:
          'Cadence très haute, appuis courts sous le bassin, jamais de freinage talon, regard porté loin. ' +
          'Remontée en trottinant. Arrête dès que le contrôle se dégrade.',
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
    title: `Allure spécifique ${blockMin} min`,
    intent: "Vérifier que le couple allure/FC de course tient sur le terrain. Répétition générale, pas développement.",
    priority: 'key',
    phases: ['specific', 'peak', 'taper'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, {}),
      block(c, 'Bloc à allure course, sur profil vallonné', 'Z3', blockMin * 60, {
        speedLo: speed * 0.97,
        speedHi: speed * 1.03,
        // Une allure de course visée n'est pas une mesure : elle vient d'une
        // prédiction. Sans elle, la cible retombe sur le SV2 et en hérite.
        speedProvenance: targetSpeedMs ? 'blended' : provenanceOf(model, 'vt2.speedMs'),
        elevationGainM: vertM,
        elevationLossM: vertM,
        notes:
          `Cible ${msToKmh(speed).toFixed(1)} km/h à plat, corrigée de la pente. ` +
          `Mange et bois exactement comme le jour J.`,
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
    title: `Renforcement ${rounds} tour${rounds > 1 ? 's' : ''}`,
    intent:
      'Chaîne postérieure et tolérance excentrique, plus le déficit de souplesse du test (flexion avant à −1 cm).',
    priority: 'support',
    phases: ['base', 'build', 'specific', 'transition', 'recovery'],
    blocks: [
      block(c, 'Activation', 'Z1', activationS, {
        notes:
          'Cercles de hanches et de chevilles, 10 fentes marchées par jambe, 15 ponts fessiers ' +
          '(dos au sol, pieds à plat, monte le bassin jusqu\'à la ligne épaules-genoux).',
      }),
      // Le contenu du circuit n'est pas dans les notes : il est dans `circuit`,
      // d'où sortent à la fois le texte affiché, la durée et la charge
      // mécanique. Les écrire deux fois, c'est se donner deux occasions de se
      // contredire — et une durée annoncée dans l'intitulé en était une.
      block(c, 'Circuit force', 'Z2', circuitS, {
        circuit,
        notes:
          'La charge se prend en freinant, jamais en poussant : trois secondes pour descendre, ' +
          'une pour remonter. Deux minutes de récupération entre les tours.',
      }),
      block(c, 'Souplesse chaîne postérieure', 'Z1', mobilityS, {
        kind: 'mobility',
        notes:
          'Ischio-jambiers, mollets, chaîne postérieure du rachis : maintiens de 45 s, deux passages. ' +
          'Le point faible du test, deux fois par semaine.',
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
    const pace = paceText(b.paceRange);
    const vamText = b.vamTargetMh ? ` · ${b.vamTargetMh} m D+/h` : '';
    const vert = verticalText(b.elevationGainM, b.elevationLossM);
    const recPace = paceText(b.recovery?.paceRange);
    const rec = b.recovery
      ? ` — récup ${formatBlockDuration(b.recovery.durationS)} ${b.recovery.active ? 'active' : 'passive'}` +
        recPace +
        verticalText(b.recovery.elevationGainM, b.recovery.elevationLossM)
      : '';
    lines.push(`• ${reps}${dur} — ${b.label} (${b.zone})${hr}${pace}${vert}${vamText}${rec}${originOf(b)}`);
    if (b.circuit) lines.push(`  ↳ ${describeCircuit(b.circuit)}`);
    if (b.notes) lines.push(`  ↳ ${b.notes}`);
  }
  return lines.join('\n');
}

/**
 * D'où viennent les cibles d'un bloc, en fin de ligne.
 *
 * C'est le rendu que lisent le chat et l'export : une cible y arrivait sans
 * origine, et « 171-175 bpm » — une mesure de laboratoire — s'y lisait comme
 * « 13,6-14,0 km/h », qui est la sortie d'une régression sur quinze séances.
 */
function originOf(b: SessionBlock): string {
  const p = b.provenance;
  if (!p) return '';
  const found = [p.hr, p.speed, p.vam].filter((x): x is ParameterProvenance => x != null);
  if (found.length === 0) return '';
  const unique = [...new Set(found)];
  return unique.length === 1
    ? ` [${PROVENANCE_FR[unique[0] as ParameterProvenance]}]`
    : ` [FC ${PROVENANCE_FR[p.hr ?? 'default']} · allure ${PROVENANCE_FR[p.speed ?? 'default']}` +
      `${p.vam ? ` · D+/h ${PROVENANCE_FR[p.vam]}` : ''}]`;
}

const CRITERION_LABEL: Record<SessionSuccessCriterion['metric'], string> = {
  hr_drift: 'pas de dérive cardiaque (Pa:HR) sur la séance',
};

/**
 * Une fourchette d'allure, dite comme l'athlète la lit.
 *
 * Une zone sans plancher de vitesse n'a pas de borne lente : « 6:48-—/km » est
 * un tiret qu'on demande de courir. L'écran l'écrivait déjà « plus lent que »,
 * le rendu texte non.
 */
function paceText(range: [string, string] | undefined): string {
  if (!range) return '';
  return range[1] === '—' ? ` · plus lent que ${range[0]}/km` : ` · ${range[0]}-${range[1]}/km`;
}

function verticalText(gainM: number | undefined, lossM: number | undefined): string {
  return `${gainM ? ` · ${gainM} m D+` : ''}${lossM ? ` · ${lossM} m D−` : ''}`;
}

/**
 * La durée d'un bloc, sans l'arrondir à ce qu'il n'est pas.
 *
 * Une répétition de 90 s s'affichait « 2 min » : la minute de trop est celle
 * qu'on court. Les secondes ne disparaissent que lorsqu'il n'y en a pas.
 */
function formatBlockDuration(s: number): string {
  // Au-delà de l'heure, la même écriture que partout ailleurs : « 1 h 45 », pas
  // « 1.8 h » — un dixième d'heure n'est pas une durée qu'on lit sur une montre.
  if (s >= 3600) return sessionDuration(s);
  if (s < 60) return `${s} s`;
  const min = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return sec === 0 ? `${min} min` : `${min} min ${String(sec).padStart(2, '0')}`;
}
