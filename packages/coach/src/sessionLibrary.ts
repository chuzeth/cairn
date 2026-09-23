import type {
  ParameterProvenance, PhysiologyModel, PlannedSession, SessionBlock, SessionSuccessCriterion, SessionType,
  StrengthCircuit, StrengthExercise, TerrainStretch, ZoneKey,
} from '@cairn/core';
import {
  PROVENANCE_FR, annexOf, climbsBack, describeMovement, groundText, itinerary, mapUrl, pointLabel, recoveryTimes,
  sessionDuration, weakestProvenance,
} from '@cairn/core';
import {
  ACTIVE_RECOVERY_INTENSITY, ECCENTRIC_MOVEMENTS, FLAT_RUNNING_COST, buildZones, easyClimbRate, easySpeedOf,
  eccentricStrengthLoad, formatPace, gradeAdjustedSpeed, hrProvenanceOf, isEasyZone, maximalEffortIndex, msToKmh,
  prescribedMechanicalLoad, speedForMetabolicPower, speedProvenanceOf, steadyRunLoad, vam, walkingGrade,
} from '@cairn/physiology';
import { describeVerdict, fitVertical, locateVertical, verticalOf, type VerticalFit } from './plausibility.js';
import { checkReserve, describeReserve, describeShortfall } from './reserve.js';
import {
  climbFor, descentAccess, descentPick, descentStretch, describeClimbChoice, hillPick, skippedNote, trailStretch,
  type TerrainHint,
} from './terrain.js';

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
  // chemins produisent enfin le même bloc. Un bloc piloté à l'effort — une
  // descente — n'a pas davantage de FC ni d'allure à tenir : sa consigne est
  // un effort et une technique.
  if (opts.kind) b.kind = opts.kind;
  else if (opts.effort) b.effort = opts.effort;
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
  if (opts.where) b.where = opts.where;
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
  // Une remontée se marche : une allure à plat n'y veut rien dire, et sa durée
  // vient de la marche (`climbBack`), qui a déjà écrit ce qu'il y a à tenir.
  if (z.speedMaxMs == null || climbsBack(r)) return { ...r };
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
function estimateLoad(model: PhysiologyModel, blocks: readonly SessionBlock[]): number {
  const vt2 = model.vt2.speedMs;
  let tss = 0;
  for (const b of blocks) {
    // Un bloc annexe — souplesse, respiration — n'est pas couru : lui prêter la
    // vitesse de sa zone lui ferait produire une charge qui n'existe pas.
    if (b.kind) continue;
    tss += (b.repeat ?? 1) * steadyRunLoad(b.durationS ?? 0, paceOf(model, b).flatMs, vt2);
    if (b.recovery) {
      tss += recoveryTimes(b) * steadyRunLoad(b.recovery.durationS, recoveryPaceOf(model, b).flatMs, vt2);
    }
  }
  return Math.round(tss);
}

/** Ce qu'un segment parcourt au sol et ce qu'il vaut à plat, m/s. */
interface Pace {
  groundMs: number;
  flatMs: number;
}

/**
 * La vitesse à laquelle un bloc se court — au sol pour la distance, à plat pour
 * la charge, comme la charge réalisée se compte sur la vitesse corrigée du
 * relief. Une seule lecture pour les deux.
 *
 * Ce qui se court sous un plafond de FC — les zones faciles — se compte à
 * l'allure que l'athlète tient sous ce plafond, lue dans ses sorties
 * (`easySpeedOf`), jamais sur la bande de vitesse de sa zone : celle de la Z1
 * commence à 0 km/h, et son milieu comptait un décrassage de 45 min pour
 * 8 points, l'allure de la marche. Une descente se court à ce que son tracé
 * impose, dans sa durée ; elle valait 80 % de la vitesse au SV1 quelle que soit
 * sa pente, deux à trois fois ce qu'elle coûte. Le reste se court à ce que le
 * bloc prescrit : le milieu de sa fourchette.
 */
function paceOf(model: PhysiologyModel, b: SessionBlock): Pace {
  const mid = b.speedRangeMs ? (b.speedRangeMs[0] + b.speedRangeMs[1]) / 2 : null;
  // Un circuit ne se parcourt pas. Sa charge métabolique se compte encore à la
  // bande de sa zone : rien ne mesure ce qu'il coûte, et ce n'est pas une
  // allure qu'on court.
  if (b.circuit) return { groundMs: 0, flatMs: mid ?? 0 };
  if (b.effort && (b.elevationLossM ?? 0) > 0) return descentPace(b);
  if (isEasyZone(b.zone)) {
    const easy = easySpeedOf(model, b.zone);
    return { groundMs: easy.groundSpeedMs, flatMs: easy.speedMs };
  }
  if (mid != null) return { groundMs: mid, flatMs: mid };
  // Un contenu écrit avant que les blocs portent leurs cibles : la bande de sa
  // zone, ouverte au-delà de la VMA pour la Z5.
  const z = zoneOf(ctxOf(model), b.zone);
  const v = z.speedMaxMs == null ? z.speedMinMs : (z.speedMinMs + z.speedMaxMs) / 2;
  return { groundMs: v, flatMs: v };
}

/**
 * Une descente pilotée à l'effort : elle parcourt son tronçon — ou son
 * dénivelé sur la pente d'une descente ordinaire — dans sa durée, et ne coûte
 * à plat que ce que cette pente laisse.
 */
function descentPace(b: SessionBlock): Pace {
  const grade = b.where?.grade ?? DEFAULT_DESCENT_GRADE;
  const run = b.distanceM ?? (b.elevationLossM as number) / Math.sin(Math.atan(grade));
  const ground = (b.durationS ?? 0) > 0 ? run / (b.durationS as number) : 0;
  return { groundMs: ground, flatMs: gradeAdjustedSpeed(ground, -grade) };
}

/**
 * La vitesse d'une récupération. Active, elle se trottine sous le plafond de sa
 * zone, à l'allure que l'athlète y tient ; une remontée se marche, à
 * l'intensité dont sa durée est tirée (`easyClimbRate`). Passive, elle ne se
 * court pas — la charge réalisée ne compte pas l'athlète à l'arrêt.
 */
function recoveryPaceOf(model: PhysiologyModel, b: SessionBlock): Pace {
  const r = b.recovery!;
  if (!r.active) return { groundMs: PASSIVE_RECOVERY_MS, flatMs: 0 };
  if (climbsBack(r)) return { groundMs: 0, flatMs: ACTIVE_RECOVERY_INTENSITY * model.vt2.speedMs };
  const easy = easySpeedOf(model, isEasyZone(r.zone) ? r.zone : 'Z1');
  return { groundMs: easy.groundSpeedMs, flatMs: easy.speedMs };
}

/** Ce qu'une récupération passive parcourt : presque rien, à pied. */
const PASSIVE_RECOVERY_MS = 0.5;

/**
 * Ce qu'une récupération parcourt. Celle qui remonte ou redescend un tronçon en
 * refait la longueur ; une remontée qu'aucun tronçon ne situe, son dénivelé sur
 * la pente d'une descente ordinaire. Les autres, leur durée à leur allure.
 */
function recoveryDistance(model: PhysiologyModel, b: SessionBlock): number {
  const r = b.recovery;
  if (!r) return 0;
  if (b.where && ((r.elevationGainM ?? 0) > 0 || (r.elevationLossM ?? 0) > 0)) return b.where.lengthM;
  if (climbsBack(r)) return (r.elevationGainM as number) / Math.sin(Math.atan(DEFAULT_DESCENT_GRADE));
  return r.durationS * recoveryPaceOf(model, b).groundMs;
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
  model: PhysiologyModel,
  blocks: readonly SessionBlock[],
  elevationLossM: number,
  distanceM?: number,
): { total: number; descent: number; eccentricStrength: number } {
  const m = prescribedMechanicalLoad({
    elevationLossM,
    distanceM: distanceM ?? totalDistance(model, blocks),
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
 * Un circuit qui freine : du renforcement excentrique, par opposition au
 * gainage. Ce qui en fait un n'est pas ce que la filière mécanique en retient —
 * un nordic freine, et ne coûte presque rien aux quadriceps.
 */
export const isEccentricCircuit = (b: SessionBlock): boolean =>
  Boolean(b.circuit) && eccentricStrengthLoad(circuitsOf([b])).reps > 0;

/** La séance porte-t-elle du renforcement excentrique ? */
export const carriesEccentricStrength = (blocks: readonly SessionBlock[]): boolean =>
  blocks.some(isEccentricCircuit);

/** Tours que portent les circuits excentriques d'une séance. */
export const eccentricRoundsOf = (blocks: readonly SessionBlock[]): number =>
  circuitsOf(blocks.filter(isEccentricCircuit)).reduce((a, c) => a + c.rounds, 0);

/**
 * La séance sans son renforcement excentrique : le circuit qui freine part, et
 * l'activation qui l'ouvrait avec lui quand plus aucun circuit ne reste. La
 * course, la souplesse, la respiration demeurent, et les totaux se relisent sur
 * ce qui reste.
 */
export function withoutEccentricStrength(
  session: TransformableSession,
  model: PhysiologyModel,
): Omit<TransformedSession, 'amendments'> {
  const kept = locateVertical(session.blocks, session.type).filter((b) => !isEccentricCircuit(b));
  const blocks = kept.some((b) => b.circuit) ? kept : kept.filter((b) => b.kind !== 'activation');
  const totals = sessionTotals(model, blocks, elevationLossOf(blocks));
  return {
    blocks,
    plannedDurationS: totals.durationS,
    plannedLoad: totals.load,
    plannedMechanicalLoad: totals.mechanicalLoad,
    plannedElevationGainM: totals.elevationGainM,
    ...(session.plannedDistanceM ? { plannedDistanceM: Math.round(totals.distanceM) } : {}),
  };
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
  // Aux cinq minutes supérieures : « 27'27" de circuit force » est un temps de
  // passage, et « 28 min » un reste — ni l'un ni l'autre n'est une consigne.
  // Vers le haut, parce que les tours sont ce qu'on a prescrit et qu'il faut le
  // temps de les faire.
  return Math.ceil(total / ROUND_S) * ROUND_S;
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
    (a, b) =>
      a + (b.repeat ?? 1) * (b.elevationGainM ?? 0) + recoveryTimes(b) * (b.recovery?.elevationGainM ?? 0),
    0,
  );
}

/** Dénivelé négatif d'un contenu, tel que ses blocs le déclarent — récupérations comprises. */
export function elevationLossOf(blocks: readonly SessionBlock[]): number {
  return blocks.reduce(
    (a, b) =>
      a + (b.repeat ?? 1) * (b.elevationLossM ?? 0) + recoveryTimes(b) * (b.recovery?.elevationLossM ?? 0),
    0,
  );
}

export function totalDuration(blocks: readonly SessionBlock[]): number {
  return blocks.reduce(
    (a, b) => a + (b.repeat ?? 1) * (b.durationS ?? 0) + recoveryTimes(b) * (b.recovery?.durationS ?? 0),
    0,
  );
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
 * c'est la trace d'une division. Pour un coureur, une durée ronde est un
 * multiple de cinq minutes — pas une minute entière : des blocs de 23, 26 ou
 * 22 min se lisaient comme ce qu'ils étaient, des restes. Échauffement, corps
 * de sortie, retour au calme et blocs annexes s'y posent, et la séance entière
 * aussi ; les répétitions gardent la durée que le dossier prescrit. La charge
 * se mesure ensuite sur ce qui est écrit, et quand elle s'écarte de la cible,
 * c'est la cible qui plie.
 */
export const ROUND_S = 5 * 60;
/** En deçà d'un quart d'heure, une séance n'a plus de forme : on la retire plutôt que de la raboter. */
export const SESSION_FLOOR_S = 15 * 60;
/** Ce qui ne tombe pas sur la maille ronde — gammes, pauses, récupérations — se prescrit à la minute. */
export const BLOCK_GRID_S = 60;

/** En deçà, le dénivelé d'une séance ne dit rien de ce qu'elle demande. */
const VERT_MENTION_FLOOR_M = 50;

const onGrid = (s: number, grid: number) => Math.max(grid, Math.round(s / grid) * grid);

/**
 * La durée demandée à une séance, ramenée à ce qui se prescrit.
 *
 * L'appelant demande ce que la charge de la semaine laisse — 101,95 minutes ; la
 * séance répond en minutes rondes. C'est l'inversion, prise à l'entrée plutôt
 * qu'en sortie : ce qui est construit l'est déjà sur des nombres humains, et
 * tous les chiffres qu'on en déduit ensuite — durée d'une montée, dénivelé
 * tenable — portent sur la séance qu'on prescrira, pas sur un gabarit
 * intermédiaire.
 */
export const prescribableMinutes = (min: number): number =>
  Math.max(SESSION_FLOOR_S / 60, Math.round(min / (ROUND_S / 60)) * (ROUND_S / 60));

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
 * Un bloc de liaison : gammes, lignes droites, pause entre deux séries.
 *
 * Il n'a pas de durée à lui — deux passages de gammes prennent quatre minutes
 * ou six —, et c'est ce qui en fait le seul bloc capable de rendre la séance
 * ronde quand ses répétitions ne le sont pas : huit fois 30"-30" font huit
 * minutes, et ni l'échauffement ni le retour au calme ne doivent pour autant
 * tomber à treize. Le modèle de séance n'a pas de champ pour le dire, seulement
 * le nom du bloc : c'est lui qu'on lit, comme la montre le lit.
 */
const LINK = /(?<!\p{L})(gammes|éducatifs|lignes droites|accélérations?|mises? en action|pause entre)(?!\p{L})/iu;
const isLink = (b: SessionBlock): boolean => isFlexible(b) && LINK.test(b.label);
/** Ce qu'un bloc de liaison peut céder ou prendre : deux minutes et demie, de quoi couvrir toute la maille. */
const LINK_SLACK_S = ROUND_S / 2;
const LINK_MIN_S = 2 * BLOCK_GRID_S;

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
 * Chaque bloc libre passe aux cinq minutes, et l'écart que ces arrondis font sur
 * leur somme est versé au plus long des blocs faciles — échauffement, corps de
 * sortie, retour au calme —, jamais à un bloc dont le titre annonce la durée :
 * « Allure spécifique 40 min » au-dessus d'un bloc de 43 est la contradiction
 * qu'on ferme. Le travail n'y entre pas : il vaut par sa durée.
 *
 * Puis la séance entière retombe sur la maille. Quand ses répétitions ne sont
 * pas rondes — huit fois 30"-30" font huit minutes —, c'est le bloc de liaison
 * qui prend ou rend ce qui manque, à la minute ; faute de liaison, la séance
 * garde le reste plutôt que de le faire porter à un bloc qui doit être rond.
 */
export function snapToHumanGrid(blocks: readonly SessionBlock[]): SessionBlock[] {
  const out = blocks.map((b) => ({ ...b }));
  const indexed = out.map((b, i) => ({ b, i }));
  const links = indexed.filter(({ b }) => isLink(b));
  const round = indexed.filter(({ b }) => isFlexible(b) && !isLink(b));

  for (const { b, i } of links) out[i] = { ...b, durationS: onGrid(b.durationS as number, BLOCK_GRID_S) };

  if (round.length > 0) {
    const asked = round.reduce((a, { b }) => a + (b.durationS as number), 0);
    for (const { b, i } of round) out[i] = { ...b, durationS: onGrid(b.durationS as number, ROUND_S) };
    const got = round.reduce((a, { i }) => a + (out[i]!.durationS as number), 0);
    const easy = round.filter(({ b }) => b.zone === 'Z1' || b.zone === 'Z2');
    const longest = (easy.length > 0 ? easy : round).reduce((a, x) =>
      (out[x.i]!.durationS as number) > (out[a.i]!.durationS as number) ? x : a,
    );
    const gap = onGrid(asked, ROUND_S) - got;
    out[longest.i] = {
      ...out[longest.i]!,
      durationS: Math.max(ROUND_S, (out[longest.i]!.durationS as number) + gap),
    };
  }

  const off = totalDuration(out) % ROUND_S;
  const link = links[0];
  if (off !== 0 && link) {
    const d = out[link.i]!.durationS as number;
    out[link.i] = {
      ...out[link.i]!,
      durationS: off <= LINK_SLACK_S && d - off >= LINK_MIN_S ? d - off : d + (ROUND_S - off),
    };
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// Titres
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Le titre d'une séance : ce qu'elle est, ce qu'elle dure, ce qu'elle monte ou
 * descend — dans cet ordre et toujours aux mêmes places.
 *
 * Le titre distingue ce qui se court de ce qui s'ajoute. « Endurance
 * fondamentale — 35 min » pour quinze minutes de course et vingt de souplesse
 * et de respiration disait une séance que personne n'allait courir ; « Footing
 * 15 min + souplesse et respiration 20 min » dit celle qu'on fait. Une séance
 * sans rien d'annexe garde sa durée entière après le tiret. Un titre dit la
 * séance entière, et les places fixes sont ce qui permet de le relire quand le
 * contenu change.
 */
export function sessionTitle(format: string, type: SessionType, blocks: readonly SessionBlock[]): string {
  const vert = titleVertical(type, blocks);
  const mention = vert.m > VERT_MENTION_FLOOR_M ? ` · ${vert.m} m D${vert.sign}` : '';
  const total = totalDuration(blocks);
  const annex = annexOf(blocks);
  const run = total - (annex?.durationS ?? 0);
  if (!annex || run <= 0) return `${format} — ${sessionDuration(total)}${mention}`;
  return `${format} ${sessionDuration(run)} + ${annex.name} ${sessionDuration(annex.durationS)}${mention}`;
}

/**
 * Le format d'un titre : ce que la séance est, sans ce qu'elle mesure.
 *
 * Il se relit sur toutes les écritures qu'un titre a connues — « Décrassage —
 * 1 h 05 », « Footing 15 min + souplesse 10 min », et les anciennes :
 * « Endurance fondamentale + renforcement — 1 h 08 », « Rando-course 3 h ·
 * 680 m D+ ». Un format qui porte des nombres — « Seuil 5 × 5 min » — ne
 * s'écrit qu'avant un tiret, et c'est le tiret qui le borne.
 */
export function formatOf(title: string): string {
  const dash = title.indexOf(' — ');
  const head = dash >= 0 ? title.slice(0, dash) : title;
  const cut = dash >= 0 ? -1 : head.search(/ \d+(?:[.,]\d+)? ?(?:min|h)(?![\p{L}])/u);
  return (cut >= 0 ? head.slice(0, cut) : head)
    .replace(/ · .*$/, '')
    .replace(/ \+ renforcement$/, '')
    .trim();
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
 * Relit le titre d'une séance sur son contenu : ce qui se court, ce qui
 * s'ajoute, le dénivelé signé.
 *
 * C'est le seul endroit qui rend un titre vérifiable — quiconque touche aux
 * blocs passe par là, et le titre suit sans que personne ait à y penser. Un
 * jour de repos ou de course n'a pas de blocs à relire : son titre reste le sien.
 */
export function retitleFromContent(s: {
  title: string;
  type: SessionType;
  blocks: readonly SessionBlock[];
}): string {
  if (s.blocks.length === 0 || s.type === 'rest' || s.type === 'race') return s.title;
  return sessionTitle(restateFormatMinutes(formatOf(s.title), s.blocks), s.type, s.blocks);
}

/**
 * Les minutes qu'un format annonce suivent le bloc qu'elles décrivent.
 *
 * « Allure spécifique 40 min » et « Tempo 25 min » nomment leur bloc continu :
 * une calibration qui le ramène à 35 min laissait le titre en annoncer 40 au-
 * dessus de lui. Un format de répétitions — « Seuil 5 × 5 min », « Pyramide
 * 4-8-12-8-4 min » — n'est pas concerné : ses durées sont celles du dossier, et
 * aucune transformation ne les touche.
 */
function restateFormatMinutes(format: string, blocks: readonly SessionBlock[]): string {
  const m = /^(.*\p{L}) (\d+) min$/u.exec(format);
  if (!m) return format;
  const continuous = blocks.filter(
    (b) => !isPrescribed(b) && !b.recovery && (b.repeat ?? 1) <= 1 && ['Z3', 'Z4', 'Z5'].includes(b.zone),
  );
  if (continuous.length !== 1) return format;
  return `${m[1]} ${Math.round((continuous[0]!.durationS ?? 0) / 60)} min`;
}

/** Distance estimée depuis la vitesse à laquelle chaque bloc se court (`paceOf`). */
function totalDistance(model: PhysiologyModel, blocks: readonly SessionBlock[]): number {
  return blocks.reduce((a, b) => {
    // Un bloc annexe ou un circuit de force ne se parcourt pas. Lui prêter la
    // vitesse de sa zone lui ferait produire des kilomètres qui n'existent pas,
    // et par eux une charge d'impact à plat tout aussi inventée.
    if (b.kind || b.circuit) return a;
    // La distance écrite prime, comme sur la montre : une descente posée sur un
    // tronçon de 405 m en fait 405, quel que soit le temps qu'elle prend.
    const work = b.distanceM ?? (b.durationS ?? 0) * paceOf(model, b).groundMs;
    return a + (b.repeat ?? 1) * work + recoveryTimes(b) * recoveryDistance(model, b);
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
  const distanceM = totalDistance(model, blocks);
  const elevationGainM = elevationGainOf(blocks);
  const mechanical = mechanicalFor(
    model,
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
    title: sessionTitle(base.title, base.type, blocks),
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
    // Le nom que le coureur lui donne : c'est un footing. « Endurance
    // fondamentale » nomme une zone, et se lisait comme un format.
    title: 'Footing',
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

/**
 * Rando-course : le format spécifique recommandé par le laboratoire pour les
 * trails longs.
 *
 * Elle se prescrit comme elle se court : une durée, un dénivelé, et une règle
 * de marche en côte. Elle était découpée en approche, montée, descente et
 * retour — 40, 62, 56 et 22 minutes, un partage du modèle que personne ne peut
 * courir, puisque sur un sentier on monte et on descend dix fois. Le terrain se
 * juge d'un seul tenant : ce qu'il monte et ce qu'il descend doivent tenir dans
 * sa durée d'après les courbes de l'athlète, marge comprise, et quand ils ne
 * tiennent pas, c'est le dénivelé qui cède — et la séance le dit.
 *
 * La règle de marche vient du seuil de bascule que le modèle calcule déjà : à
 * la puissance du haut de la Z2, la pente au-delà de laquelle courir ne va plus
 * plus vite que marcher. Quand le terrain connaît une montée récurrente de
 * l'athlète qui porte ce dénivelé, la séance la nomme et dit combien de
 * passages le font.
 */
export function longTrail(
  model: PhysiologyModel,
  durationMin = 210,
  vertM = 1200,
  terrain?: TerrainHint,
): SessionTemplate {
  const c = ctxOf(model);
  const minutes = prescribableMinutes(durationMin);
  const z2 = zoneOf(c, 'Z2');
  const cooldownS = 20 * 60;
  const terrainS = Math.max(ROUND_S, minutes * 60 - cooldownS);
  const walkAt = walkingGrade(FLAT_RUNNING_COST * (z2.speedMaxMs as number));
  const pct = Math.round(walkAt * 100);

  const content = (gainM: number, notes?: string, where?: TerrainStretch | null): SessionBlock[] => [
    block(c, `Sur sentier, marche dès ${pct} % de pente`, 'Z2', terrainS, {
      elevationGainM: gainM,
      elevationLossM: gainM,
      cadenceTargetSpm: 172,
      ...(notes ? { notes } : {}),
      ...(where ? { where } : {}),
    }),
    block(c, 'Retour au calme', 'Z1', cooldownS, {
      notes: 'Vingt minutes très souples sur le plat : c\'est là que la clairance se fait.',
    }),
  ];

  // Le dénivelé d'abord, les mots ensuite : la montée qu'on nomme et le nombre
  // de passages portent sur ce que la séance prescrira, pas sur ce qu'on lui a
  // demandé.
  const asked = Math.max(0, Math.round(vertM));
  const provisional = snapToHumanGrid(content(asked));
  const fit = fitVertical(provisional, verticalOf(model), 'long_trail');
  const gain = fit.share < 1 ? elevationGainOf(fit.blocks) : asked;
  const amendments = fit.share < 1 ? [shedNote(provisional, fit)] : [];
  const climb = climbFor(terrain, gain, walkAt);

  const rule =
    `Cours tant que la pente reste sous ${pct} %, marche au-dessus : passé ce seuil, courir en Z2 ne va pas ` +
    `plus vite que marcher, et coûte davantage (seuil calculé sur ta vitesse au SV1, de provenance ` +
    `${PROVENANCE_FR[provenanceOf(model, 'vt1.speedMs')]}). En montée, mains sur les cuisses, buste droit ; ` +
    `en descente, cadence haute et appuis courts.`;

  const session = finalize(c, {
    key: 'long_trail',
    type: 'long_trail',
    title: 'Rando-course',
    intent:
      'Tenir plusieurs heures en alternant marche et course selon la pente, sans dérive : la seule séance qui prépare les quadriceps à la descente du jour J.',
    priority: 'key',
    phases: ['base', 'build', 'specific'],
    ...(amendments.length ? { amendments } : {}),
    blocks: content(
      gain,
      climb ? `${rule} ${describeClimbChoice(climb, gain)}` : rule,
      climb ? trailStretch(climb) : null,
    ),
  });
  return {
    ...session,
    rebuild: (k: number) => longTrail(model, durationMin * k, Math.round(vertM * k), terrain),
  };
}

/**
 * Test maximal : un contre-la-montre qui ancre la vitesse critique sur un
 * effort mesuré.
 *
 * Ses consignes se lisent sur ses propres cibles — le bas de la fourchette
 * d'allure, la FC qui en fait une preuve d'effort maximal —, jamais sur un
 * chiffre du jour où il a été écrit : relu le matin du test, « ta meilleure
 * moyenne de ce soir » parlait d'un soir que l'athlète n'avait pas couru.
 */
export function timeTrial(model: PhysiologyModel, minutes = 20): SessionTemplate {
  const c = ctxOf(model);
  const lo = model.criticalSpeedMs;
  const hi = model.criticalSpeedMs * 1.04;
  return finalize(
    c,
    {
      key: 'time_trial',
      type: 'threshold',
      title: `Test maximal ${minutes} min`,
      intent:
        'Ancrer ta vitesse critique sur un effort maximal mesuré : toutes tes allures et la prédiction de course en dépendent.',
      priority: 'key',
      phases: ['base', 'build', 'specific'],
      blocks: timeTrialPresentation(
        [
          block(c, 'Échauffement progressif', 'Z2', 20 * 60, { cadenceTargetSpm: 172 }),
          block(c, 'Gammes et accélérations', 'Z2', 5 * 60, {}),
          {
            // Au-delà du plafond de Z4 : c'est la FC qui fait d'un effort une
            // preuve maximale. La bande de Z5, elle, serait intenable vingt minutes.
            ...block(c, `Contre-la-montre ${minutes} min`, 'Z5', minutes * 60, {
              speedLo: lo,
              speedHi: hi,
              speedProvenance: provenanceOf(model, 'criticalSpeedMs'),
              cadenceTargetSpm: 175,
            }),
            hrRange: [Math.round(model.vt2.hr), Math.round(model.hrMax * 0.97)] as [number, number],
          },
          block(c, 'Retour au calme', 'Z1', 15 * 60, {}),
        ],
        model,
      ),
    },
    0,
  );
}

/**
 * Un test maximal, lu sur le contenu : un effort d'un seul tenant — ni répété,
 * ni coupé de récupérations — prescrit au-delà du seuil 2, et assez long pour
 * entrer dans l'ajustement de la vitesse critique. C'est la signature de la
 * preuve d'effort maximal du modèle, lue sur ce qu'on demande à l'athlète.
 */
export function isMaximalTest(s: Pick<PlannedSession, 'blocks'>, model: PhysiologyModel): boolean {
  return maximalEffortIndex(s.blocks, model) >= 0;
}

/**
 * Les mots d'un test maximal, posés sur ses blocs : échauffement, gammes,
 * effort, retour au calme. Rien d'autre que les libellés et les consignes ne
 * change — durées et cibles sont celles du contenu, décidé ou non.
 */
export function timeTrialPresentation(blocks: readonly SessionBlock[], model: PhysiologyModel): SessionBlock[] {
  const effort = maximalEffortIndex(blocks, model);
  return blocks.map((b, i) => {
    if (i === effort) {
      const min = Math.round((b.durationS ?? 0) / 60);
      const speed = b.speedRangeMs ? `, ${msToKmh(b.speedRangeMs[0]).toFixed(1).replace('.', ',')} km/h,` : '';
      const hr = b.hrRange
        ? ` La FC doit passer ${b.hrRange[0]} et finir vers ${b.hrRange[1]} : c'est ce qui fait du test une preuve d'effort maximal.`
        : '';
      return {
        ...b,
        label: `Contre-la-montre ${min} min`,
        notes:
          `Effort maximal régulier, sur le plat, départ lancé : pars sur le bas de la fourchette${speed} tiens, ` +
          `et ne lâche que sur les trois dernières minutes.${hr} Un test couru fatigué mesure la fatigue : ` +
          `si ta disponibilité est au rouge ce matin-là, ne le cours pas et parles-en au coach.`,
      };
    }
    if (i < effort && isLink(b)) {
      return {
        ...b,
        label: 'Gammes et accélérations',
        notes: `${GAMMES_CUE} Puis 3 accélérations de 30 s à l'allure visée, récupération complète : elles calibrent la sensation, elles ne fatiguent pas.`,
      };
    }
    if (i < effort && !isPrescribed(b)) {
      return {
        ...b,
        label: 'Échauffement progressif',
        notes:
          'Sur piste ou plat roulant. Un test sur un échauffement court mesure ton échauffement, pas ta vitesse critique.',
      };
    }
    if (i > effort && !isPrescribed(b)) {
      return { ...b, label: 'Retour au calme', notes: 'Très souple : tu viens de vider ta réserve anaérobie, laisse la clairance se faire.' };
    }
    return { ...b };
  });
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
        // La récupération se prescrit à la minute entière : « récup
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

/**
 * Côtes : le fractionné court en montée recommandé par le laboratoire.
 *
 * Posées sur une montée de l'athlète quand son terrain en porte une, elles se
 * courent du pied jusqu'au point où la répétition a monté ce qu'elle monte, et
 * sur la pente de ce tronçon : c'est elle, et non une pente de gabarit, qui dit
 * ce qu'on monte en quatre-vingt-dix secondes.
 */
export function hillRepeats(
  model: PhysiologyModel,
  reps = 8,
  repS = 90,
  grade = 0.10,
  terrain?: TerrainHint,
): SessionTemplate {
  const { found, skipped } = hillPick(
    terrain,
    (g) => resolveClimb({ durationS: repS, vamTargetMh: hillVam(model, g) }).elevationGainM,
  );
  const ground = skippedNote(skipped, found != null, 'côtes');
  return fitRepetitions(
    (n) => hillRepeatsContent(model, n, repS, found ? found.stretch.grade : grade, found, ground),
    reps,
    model,
  );
}

/** La vitesse ascensionnelle d'une côte à la puissance de la répétition, sur une pente. */
const hillVam = (model: PhysiologyModel, grade: number): number =>
  Math.round(vam(speedForMetabolicPower(3.6 * model.vmaMs * 0.96, grade), grade));

function hillRepeatsContent(
  model: PhysiologyModel,
  reps: number,
  repS: number,
  grade: number,
  on: { stretch: TerrainStretch; gainM: number } | null,
  /** Ce que la séance dit des montées écartées pour leurs marches (`skippedNote`). */
  ground = '',
): SessionTemplate {
  const c = ctxOf(model);
  const z4 = zoneOf(c, 'Z4');
  const power = 3.6 * model.vmaMs * 0.96;
  const speed = speedForMetabolicPower(power, grade);
  const targetVam = hillVam(model, grade);
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
  // Posée sur un tronçon, la répétition monte ce qu'il monte : le demi-tour est
  // situé sur ces mètres-là, et la cible ne doit pas s'en écarter d'un arrondi.
  const climb = on
    ? resolveClimb({ durationS: repS, elevationGainM: on.gainM })
    : resolveClimb({ durationS: repS, vamTargetMh: targetVam });
  return finalize(c, {
    key: 'hill_repeats',
    type: 'hill_repeats',
    title: `Côtes ${reps} × ${repS} s à ${Math.round(grade * 100)} %`,
    intent: 'Prendre une intensité cardiaque haute pour des impacts faibles : c\'est ce que la pente permet et que le plat interdit.',
    priority: 'key',
    phases: ['base', 'build', 'specific'],
    blocks: [
      block(c, 'Échauffement jusqu\'au pied de la côte', 'Z2', 20 * 60, {}),
      // Les gammes au pied de la côte : c'est aussi le bloc qui rend la séance
      // ronde, huit côtes de 90 s et leurs descentes faisant vingt-quatre minutes.
      block(c, 'Gammes', 'Z2', 5 * 60, { notes: GAMMES_CUE }),
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
        ...(on ? { where: on.stretch } : {}),
        notes:
          `Cible ${climb.vamTargetMh} m D+/h, ${Math.round(z4.hrMin)}-${Math.round(z4.hrMax)} bpm en fin de répétition. ` +
          `Buste penché, foulée courte, bras actifs. Redescends en trottinant.${ground ? ` ${ground}` : ''}`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  });
}

/**
 * La consigne d'une descente. Ni FC ni allure : la FC y reste basse quoi qu'on
 * fasse, et une allure à plat n'y veut rien dire. Ce qui se tient, c'est un
 * effort et une technique.
 */
export const DESCENT_EFFORT =
  'Vite mais maîtrisé : foulée courte et rapide, pieds sous le bassin, regard trois ou quatre mètres devant.';

const DESCENT_STOP = 'Arrête dès que le contrôle se dégrade.';

/** L'échauffement d'une descente posée sur une montée : il mène à son sommet, d'où elle part. */
export const WARMUP_TO_TOP = "Échauffement jusqu'au haut de la montée";

/**
 * Le retour au calme d'une descente posée : la dernière descente laisse au
 * demi-tour, et il reste le bas de la montée à descendre pour rentrer.
 */
export const COOLDOWN_TO_FOOT = 'Retour au calme, du demi-tour au pied';

/**
 * Pente d'une remontée qu'aucun tronçon ne situe : celle d'une descente
 * technique ordinaire. C'est une valeur par défaut, et elle se déclare comme
 * telle dans la provenance de la remontée.
 */
const DEFAULT_DESCENT_GRADE = 0.15;

/**
 * La remontée d'une descente : à allure facile, en marchant.
 *
 * Sa durée se déduit de ce qu'elle remonte et de la marche facile que le modèle
 * donne sur la pente du tronçon (`easyClimbRate`), à la minute supérieure : 78 m
 * à 19 %, c'est 675 m/h, 7 min. Elle valait 1,4 fois la descente — 4 min, soit
 * 1 170 m/h —, et la courbe de montée, qui dit ce que l'athlète tient à fond, la
 * laissait passer. La plage cardiaque de la Z1 dit ce qu'est « facile » ; une
 * allure à plat, en marchant sur 19 %, ne dirait rien. Sur la montre, elle se
 * termine au bouton du tour : sa durée est une estimation, pas un temps au bout
 * duquel repartir.
 */
function climbBack(
  c: Ctx,
  gainM: number,
  grade: number,
  gradeProvenance: ParameterProvenance,
): NonNullable<SessionBlock['recovery']> {
  const z1 = zoneOf(c, 'Z1');
  const rate = easyClimbRate(c.model, grade > 0 ? grade : DEFAULT_DESCENT_GRADE);
  return {
    durationS: Math.max(1, Math.ceil(gainM / rate.vamMh * 60)) * BLOCK_GRID_S,
    zone: 'Z1',
    active: true,
    elevationGainM: gainM,
    hrRange: [Math.round(z1.hrMin), Math.round(z1.hrMax)],
    provenance: { hr: hrProvenanceOf(z1), vam: weakestProvenance(rate.provenance, gradeProvenance) },
  };
}

/**
 * Le tronçon d'une descente de `dropM`, et ce que la séance dit des montées
 * écartées pour lui : celle que l'athlète court le plus passe peut-être par un
 * escalier, et la séance le dit plutôt que de changer de montée en silence.
 */
function descentOn(terrain: TerrainHint | undefined, dropM: number): { where: TerrainStretch | null; ground: string } {
  const { skipped } = descentPick(terrain, dropM);
  const where = descentStretch(terrain, dropM);
  return { where, ground: skippedNote(skipped, where != null, 'descentes') };
}

interface DescentSpec {
  label: string;
  zone: ZoneKey;
  repeat: number;
  /** Ce que dure une descente, s — une estimation quand elle se termine au demi-tour. */
  durationS: number;
  dropM: number;
  cadenceTargetSpm?: number;
  where: TerrainStretch | null;
  /** Ce qu'une première descente doit à la séance qui la suit (`firstDescentNote`). */
  exposure?: string;
  /** Ce que la séance dit des montées écartées pour leurs marches (`skippedNote`). */
  ground?: string;
  /** La dernière descente ne remonte pas : la remontée sépare les descentes. */
  lastGoesDown?: boolean;
}

/**
 * Les descentes répétées : du haut au demi-tour quand un tronçon les situe, et
 * c'est alors lui qui les borne — la distance écrite prime sur la montre. Chaque
 * descente remonte à pied ce qu'elle a descendu.
 */
function descentBlock(c: Ctx, d: DescentSpec): SessionBlock {
  const b = block(c, d.label, d.zone, d.durationS, {
    repeat: d.repeat,
    effort: DESCENT_EFFORT,
    elevationLossM: d.dropM,
    ...(d.cadenceTargetSpm ? { cadenceTargetSpm: d.cadenceTargetSpm } : {}),
    ...(d.where ? { where: d.where, distanceM: d.where.lengthM } : {}),
    notes: [d.ground, d.exposure, DESCENT_STOP].filter(Boolean).join(' '),
  });
  b.recovery = d.where
    ? climbBack(c, d.dropM, d.where.grade, d.where.provenance)
    : climbBack(c, d.dropM, DEFAULT_DESCENT_GRADE, 'default');
  if (d.lastGoesDown) b.recovery.betweenReps = true;
  return b;
}

/**
 * Descente : la séance que presque personne ne fait, et qui rapporte le plus en
 * trail. Elle prépare spécifiquement à l'agression excentrique de la course.
 *
 * Posée sur une montée de l'athlète quand son terrain en porte une : du haut
 * jusqu'au point où l'on a descendu ce qu'une descente descend, puis retour au
 * haut en marchant. Jamais sur des marches : une montée qui en porte est
 * écartée, et la séance le dit.
 */
export function downhillSession(
  model: PhysiologyModel,
  reps = 6,
  repMin = 3,
  terrain?: TerrainHint,
): SessionTemplate {
  const c = ctxOf(model);
  const lossPerRep = 90;
  const { where, ground } = descentOn(terrain, lossPerRep);
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
      block(c, where ? WARMUP_TO_TOP : 'Échauffement', 'Z2', 20 * 60, {}),
      block(c, 'Gammes', 'Z2', 5 * 60, { notes: GAMMES_CUE }),
      descentBlock(c, {
        label: 'Descentes contrôlées', zone: 'Z3', repeat: reps, durationS: repMin * 60, dropM: lossPerRep,
        cadenceTargetSpm: 182, where, ...(ground ? { ground } : {}),
      }),
      block(c, 'Retour au calme', 'Z1', 10 * 60, {}),
    ],
  });
}

/**
 * Pose une séance de descente déjà écrite sur le terrain du jour, sans toucher
 * à sa prescription.
 *
 * La prescription, c'est ce qui a été fixé : combien de descentes, ce que chacune
 * descend, le temps qu'on y passe. Ce qui s'en déduit suit les règles du jour —
 * le tronçon où elle se court, la remontée qui se marche, la consigne d'effort —,
 * et la durée de la séance suit la remontée. `null` quand la séance n'a pas de
 * descente répétée à poser.
 *
 * L'accès en fait partie : l'échauffement monte la montée entière, et la
 * dernière descente ne remonte pas — elle continue par le bas de la montée
 * jusqu'au pied. Ces mètres-là se montent et se descendent comme les autres.
 */
export function layDescent(
  session: TransformableSession & Pick<PlannedSession, 'title'>,
  model: PhysiologyModel,
  terrain: TerrainHint | undefined,
  exposure?: string,
): (Omit<TransformedSession, 'amendments'> & { title: string }) | null {
  if (session.type !== 'downhill') return null;
  const c = ctxOf(model);
  const located = locateVertical(session.blocks, session.type);
  const i = located.findIndex(
    (b) => !b.kind && !b.circuit && (b.elevationLossM ?? 0) > 0 && b.recovery != null && (b.durationS ?? 0) > 0,
  );
  const rep = located[i];
  if (!rep) return null;
  const dropM = rep.elevationLossM as number;
  const { where, ground } = descentOn(terrain, dropM);
  const access = where ? descentAccess(terrain, dropM) : null;
  // Le dernier bloc couru ramène au pied quand l'accès est connu : c'est lui qui
  // porte ce qu'il reste à descendre sous le demi-tour.
  const back = access
    ? located.reduce((last, b, k) => (k > i && !b.kind && !b.circuit ? k : last), -1)
    : -1;
  const laid = located.map((b, k): SessionBlock => {
    if (k === i) {
      return descentBlock(c, {
        label: rep.label, zone: rep.zone, repeat: rep.repeat ?? 1, durationS: rep.durationS as number, dropM,
        where, ...(rep.cadenceTargetSpm ? { cadenceTargetSpm: rep.cadenceTargetSpm } : {}),
        ...(exposure ? { exposure } : {}),
        ...(ground ? { ground } : {}),
        // La dernière descente ne remonte pas : la séance rentre par le bas.
        ...(access ? { lastGoesDown: true } : {}),
      });
    }
    // L'échauffement mène au haut de la montée quand la descente y est posée, et
    // la monte : c'est la montée entière.
    if (k === 0 && k < i && /^échauffement$/iu.test(b.label.trim()) && where) {
      return { ...b, label: WARMUP_TO_TOP, ...(access ? { elevationGainM: access.upM, where: access.up } : {}) };
    }
    if (k === 0 && b.label === WARMUP_TO_TOP) {
      if (where) return { ...b, ...(access ? { elevationGainM: access.upM, where: access.up } : {}) };
      const bare = { ...b, label: 'Échauffement' };
      delete bare.elevationGainM;
      delete bare.where;
      return bare;
    }
    if (k === back && access) {
      return { ...b, label: COOLDOWN_TO_FOOT, elevationLossM: access.downM, where: access.down };
    }
    return b;
  });
  const blocks = snapToHumanGrid(laid);
  const totals = sessionTotals(model, blocks, elevationLossOf(blocks));
  return {
    blocks,
    title: retitleFromContent({ title: session.title, type: session.type, blocks }),
    plannedDurationS: totals.durationS,
    plannedLoad: totals.load,
    plannedMechanicalLoad: totals.mechanicalLoad,
    plannedElevationGainM: totals.elevationGainM,
    ...(session.plannedDistanceM ? { plannedDistanceM: Math.round(totals.distanceM) } : {}),
  };
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

/** Ce que le renforcement ajoute à l'intention du footing qui le porte. */
export const STRENGTH_INTENT = 'Le renforcement suit immédiatement : chaîne postérieure et souplesse.';

export function strength(model: PhysiologyModel, rounds = 3): SessionTemplate {
  const c = ctxOf(model);
  const circuit: StrengthCircuit = { rounds, exercises: STRENGTH_CIRCUIT.map((e) => ({ ...e })) };
  // La séance dure ce que durent ses blocs, et le circuit dure ses tours. La
  // durée était un paramètre : elle annonçait quarante minutes quel que soit le
  // contenu, et le circuit gardait vingt minutes qu'il y ait un tour ou trois.
  const circuitS = circuitDurationS(circuit);
  const activationS = 5 * 60;
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
      // L'activation ne se court pas : elle ouvre le renforcement, et c'est à lui
      // que le titre la compte.
      block(c, 'Activation', 'Z1', activationS, {
        kind: 'activation',
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
          `une pour remonter.${rounds > 1 ? ' Deux minutes de récupération entre les tours.' : ''}`,
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
    const dur = b.durationS
      ? `${formatBlockDuration(b.durationS)}${b.distanceM ? ` (${b.distanceM} m)` : ''}`
      : b.distanceM ? `${b.distanceM} m` : '';
    const hr = b.hrRange ? ` · ${b.hrRange[0]}-${b.hrRange[1]} bpm` : '';
    const pace = paceText(b.paceRange);
    const vamText = b.vamTargetMh ? ` · ${b.vamTargetMh} m D+/h` : '';
    const vert = verticalText(b.elevationGainM, b.elevationLossM);
    const recPace = paceText(b.recovery?.paceRange);
    const recHr = b.recovery?.hrRange && !b.recovery.paceRange ? ` · FC sous ${b.recovery.hrRange[1]}` : '';
    // Une remontée se marche jusqu'en haut : elle se dit par ce qu'elle fait, et
    // sa durée par ce qu'elle est — une estimation, la montre attend le tour.
    const rec = b.recovery
      ? (climbsBack(b.recovery)
          ? ` — remontée en marchant${b.recovery.betweenReps ? ' entre les descentes' : ''}, environ ` +
            `${formatBlockDuration(b.recovery.durationS)} (bouton tour en haut)`
          : ` — récup ${formatBlockDuration(b.recovery.durationS)} ${b.recovery.active ? 'active' : 'passive'}`) +
        recPace +
        recHr +
        verticalText(b.recovery.elevationGainM, b.recovery.elevationLossM) +
        (climbsBack(b.recovery) && b.recovery.provenance?.vam
          ? ` [durée : marche facile, ${PROVENANCE_FR[b.recovery.provenance.vam]}]`
          : '')
      : '';
    // Un bloc piloté à l'effort n'a pas de zone à tenir : elle n'en décrit que le relief.
    const zone = b.effort ? '' : ` (${b.zone})`;
    lines.push(`• ${reps}${dur} — ${b.label}${zone}${hr}${pace}${vert}${vamText}${rec}${originOf(b)}`);
    if (b.effort) lines.push(`  ↳ ${b.effort}`);
    if (b.where) {
      // Un itinéraire, les voies dans l'ordre, le sol, et chaque bout ouvert sur
      // la carte par son épingle : de quoi courir le tronçon sans rien deviner.
      const w = b.where;
      const streets = w.streets?.length ? ` Par ${w.streets.join(', puis ')}.` : '';
      const ground = w.ground
        ? ` Sol : ${groundText(w.ground)} (OpenStreetMap).`
        : ' Sol non relevé sur OpenStreetMap.';
      lines.push(
        `  ↳ ${itinerary(b)}${streets}${ground} ${Math.round(w.lengthM)} m à ${Math.round(w.grade * 100)} % — ` +
          `[${pointLabel(w.from)}](${mapUrl(w.from)}), [${pointLabel(w.to)}](${mapUrl(w.to)}) ` +
          `[trace ${PROVENANCE_FR[w.provenance]}].`,
      );
    }
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
