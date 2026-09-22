import type {
  BlockKind, EccentricMovement, PhysiologyModel, SessionBlock, StrengthCircuit, StrengthExercise,
  ZoneDefinition, ZoneKey,
} from '@cairn/core';
import {
  ECCENTRIC_MOVEMENTS, ZONE_KEYS, buildZones, formatPace, hrProvenanceOf, speedProvenanceOf,
} from '@cairn/physiology';
import { checkVertical, declaresDescent, describeVerdict, verticalOf } from './plausibility.js';
import { checkReserve, describeReserve, describeShortfall } from './reserve.js';
import { resolveClimb, sessionTotals } from './sessionLibrary.js';

/**
 * Contenu de séance fourni par le coach.
 *
 * `modify_session` savait déplacer une séance, la renommer, multiplier sa
 * charge — rien de plus. Toute prescription qui n'était pas « la même séance,
 * ×N » lui était inexprimable : il changeait le titre et la justification, et
 * l'athlète continuait de lire des blocs qui contredisaient le titre. Un test
 * maximal annoncé, un tempo plafonné à 171 bpm prescrit.
 *
 * Ce module ouvre les blocs à l'écriture sans ouvrir la porte à n'importe quoi.
 * Ce n'est pas un langage d'écriture de séances : c'est la structure que le
 * planificateur produit déjà, vérifiée champ par champ et bornée par le modèle
 * physiologique de l'athlète. Deux règles la tiennent :
 *
 * — ce qui est omis est déduit de la zone, jamais laissé vide : un bloc affiché
 *   sans cible ne se prescrit pas ;
 * — ce qui est dérivé ne se saisit pas. L'allure en min/km est calculée depuis
 *   la fourchette de vitesse. C'est ce qui empêche le texte affiché de diverger
 *   des nombres qui le fondent, soit exactement le défaut qu'on corrige.
 *
 * Et une règle sur le chemin lui-même : il préserve ou il refuse, jamais il
 * n'ignore. Un champ du modèle absent de la table d'écriture ne se perdrait pas
 * bruyamment — il disparaîtrait du bloc réécrit, et avec lui ce qu'il portait.
 */

const MAX_BLOCKS = 24;
const MAX_BLOCK_DURATION_S = 6 * 3600;
const MAX_TOTAL_DURATION_S = 24 * 3600;
const MAX_BLOCK_DISTANCE_M = 100_000;
const MAX_REPEAT = 40;
const MAX_ELEVATION_GAIN_M = 5_000;
const MAX_VAM_MH = 2_500;
const MAX_LABEL_CHARS = 80;
const MAX_NOTES_CHARS = 400;
const MAX_EFFORT_CHARS = 200;
const MAX_ROUNDS = 10;
const MAX_EXERCISES = 12;
const MAX_REPS = 200;

/**
 * Les champs qu'un bloc peut porter à l'écriture, un par champ du modèle.
 *
 * La table est exhaustive par construction : `Record<K, true>` refuse à la
 * compilation qu'il en manque un ou qu'il y en ait un de trop. C'est ce qui
 * fait qu'un champ ajouté à `SessionBlock` ne peut plus être perdu en silence —
 * il faut soit l'accepter ici, soit l'exclure explicitement du type, et dans
 * les deux cas quelqu'un l'aura décidé. Le défaut corrigé : `kind` absent de la
 * liste, et le marqueur de souplesse effacé par un remplacement de blocs, avec
 * lui la fréquence hebdomadaire que le praticien avait prescrite.
 *
 * `paceRange`, `provenance` et `where` sont seuls exclus : le premier est
 * dérivé de `speedRangeMs`, le second dit d'où vient chaque cible et se déduit
 * donc de la façon dont elle a été obtenue, le troisième est un tronçon relevé
 * sur les traces de l'athlète. Les laisser écrire, ce serait laisser annoncer
 * « terrain » sur un nombre ou un endroit que personne n'a mesuré.
 */
type DerivedBlockField = 'paceRange' | 'provenance' | 'where';

const WRITABLE_BLOCK_FIELDS: Record<Exclude<keyof SessionBlock, DerivedBlockField>, true> = {
  label: true, kind: true, zone: true, durationS: true, distanceM: true, repeat: true,
  elevationGainM: true, elevationLossM: true, hrRange: true, speedRangeMs: true, vamTargetMh: true,
  cadenceTargetSpm: true, effort: true, recovery: true, circuit: true, notes: true,
};

type Recovery = NonNullable<SessionBlock['recovery']>;

const WRITABLE_RECOVERY_FIELDS: Record<
  Exclude<keyof Recovery, DerivedBlockField | 'hrRange' | 'speedRangeMs'>,
  true
> = {
  durationS: true, zone: true, active: true, betweenReps: true, elevationGainM: true, elevationLossM: true,
};
const WRITABLE_CIRCUIT_FIELDS: Record<keyof StrengthCircuit, true> = { rounds: true, exercises: true };
const WRITABLE_EXERCISE_FIELDS: Record<keyof StrengthExercise, true> = { movement: true, reps: true };
/** Même exigence sur les natures de bloc : la liste ne peut pas prendre du retard sur le type. */
const WRITABLE_BLOCK_KINDS: Record<BlockKind, true> = { mobility: true, respiratory: true, activation: true };

// Des ensembles, pas les tables elles-mêmes : `key in table` répondrait vrai
// pour `toString`, et laisserait passer un champ inconnu par la chaîne de
// prototypes.
const BLOCK_FIELDS = new Set(Object.keys(WRITABLE_BLOCK_FIELDS));
const RECOVERY_FIELDS = new Set(Object.keys(WRITABLE_RECOVERY_FIELDS));
const CIRCUIT_FIELDS = new Set(Object.keys(WRITABLE_CIRCUIT_FIELDS));
const EXERCISE_FIELDS = new Set(Object.keys(WRITABLE_EXERCISE_FIELDS));
const BLOCK_KINDS = Object.keys(WRITABLE_BLOCK_KINDS);
const MOVEMENTS = Object.keys(ECCENTRIC_MOVEMENTS) as EccentricMovement[];

/**
 * Cibles qui présupposent qu'on court le bloc.
 *
 * Un bloc annexe ne se court pas : lui prêter une allure, une FC ou une cadence
 * afficherait une consigne que l'athlète ne peut pas suivre, et le déduire de
 * la zone la lui afficherait sans que personne l'ait écrite.
 */
const RUNNING_TARGETS = [
  'hrRange', 'speedRangeMs', 'vamTargetMh', 'cadenceTargetSpm', 'distanceM', 'circuit',
] as const;

/**
 * Valide un contenu de séance et le complète depuis les zones de l'athlète.
 * Lève une erreur nommant le champ fautif : le coach doit pouvoir corriger et
 * réessayer sans deviner.
 */
export function parseSessionBlocks(raw: unknown, model: PhysiologyModel): SessionBlock[] {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('blocks : un tableau d\'au moins un bloc est attendu.');
  }
  if (raw.length > MAX_BLOCKS) {
    throw new Error(`blocks : ${raw.length} blocs, maximum ${MAX_BLOCKS}.`);
  }

  const zones = buildZones(model);
  const blocks = raw.map((entry, i) => parseBlock(entry, `blocks[${i}]`, zones, model));

  const { durationS } = sessionTotals(model, blocks);
  if (durationS > MAX_TOTAL_DURATION_S) {
    throw new Error(
      `blocks : durée totale de ${Math.round(durationS / 360) / 10} h, maximum ${MAX_TOTAL_DURATION_S / 3600} h.`,
    );
  }

  // Chaque segment doit pouvoir s'exécuter : ce qu'il monte et ce qu'il descend,
  // dans le temps qu'il dure, d'après les courbes de l'athlète. Le chemin
  // d'écriture refuse ce qu'il ne peut pas prescrire — il ne corrige pas en
  // silence un contenu que le coach a choisi.
  // Chaque segment est jugé à l'instant où il commence, marge de prescription
  // comprise ; un segment impossible se nomme avant un segment sans marge.
  const verdicts = checkVertical(blocks, verticalOf(model));
  const refused = verdicts.find((v) => !v.feasible) ?? verdicts.find((v) => !v.prescribable);
  if (refused) {
    const at = `blocks[${refused.block}]${refused.part === 'recovery' ? '.recovery' : ''}`;
    const located =
      refused.lossM > 0 && !declaresDescent(blocks)
        ? " Aucun bloc ne déclare son D− : il est situé par la règle de la boucle. Déclare elevationLossM " +
          'sur le segment où la descente a lieu.'
        : '';
    throw new Error(`${at} : ${describeVerdict(refused)}${located}`);
  }

  // Et la réserve anaérobie doit financer ce que la séance demande de tenir.
  // Une série de répétitions au-dessus de la vitesse critique la vide à un
  // rythme connu ; passé un certain nombre, il n'y a plus de séance. Le chemin
  // d'écriture refuse ce qu'il ne peut pas prescrire — il ne retire pas en
  // silence des répétitions que le coach a choisies.
  const reserve = checkReserve(blocks, model);
  if (!reserve.prescribable && reserve.lowAt) {
    throw new Error(
      `blocks[${reserve.lowAt.block}] : ${describeShortfall(reserve)} ${describeReserve(reserve)}`,
    );
  }
  return blocks;
}

function parseBlock(
  entry: unknown,
  at: string,
  zones: ZoneDefinition[],
  model: PhysiologyModel,
): SessionBlock {
  if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
    throw new Error(`${at} : objet attendu.`);
  }
  const raw = entry as Record<string, unknown>;

  for (const key of Object.keys(raw)) {
    if (BLOCK_FIELDS.has(key)) continue;
    if (key === 'paceRange') {
      throw new Error(`${at}.paceRange : l'allure en min/km est déduite de speedRangeMs, elle ne se saisit pas.`);
    }
    if (key === 'provenance') {
      throw new Error(
        `${at}.provenance : la provenance d'une cible se déduit de ce qui l'a produite, elle ne se déclare pas.`,
      );
    }
    if (key === 'where') {
      throw new Error(
        `${at}.where : le tronçon d'une montée se relève sur les traces de l'athlète, il ne se déclare pas.`,
      );
    }
    throw new Error(`${at}.${key} : champ inconnu.`);
  }

  const zone = zoneKey(raw.zone, `${at}.zone`);
  const z = zones.find((x) => x.key === zone)!;

  // Un bloc annexe — souplesse, respiration — n'est pas couru. C'est `kind` qui
  // le dit, et c'est par lui que la fréquence hebdomadaire prescrite au dossier
  // se compte : un bloc de souplesse qui le perd cesse d'honorer la consigne
  // sans que rien ne l'annonce.
  const kind = raw.kind === undefined ? undefined : blockKind(raw.kind, `${at}.kind`);
  if (kind !== undefined) {
    const offending = RUNNING_TARGETS.filter((f) => raw[f] !== undefined);
    if (offending.length > 0) {
      throw new Error(
        `${at}.${offending[0]} : un bloc ${kind} ne se court pas — ni allure, ni FC, ni cadence, ` +
          `ni distance, ni circuit de force.`,
      );
    }
    if (raw.durationS === undefined) {
      throw new Error(`${at}.durationS : requis sur un bloc ${kind} — sa durée est ce qui se prescrit.`);
    }
  }

  // Un bloc piloté à l'effort — une descente — a pour consigne un effort et une
  // technique. Lui prêter la FC et l'allure de sa zone, c'est afficher une cible
  // qu'on ne peut pas suivre : la FC d'une descente reste basse quoi qu'on
  // fasse, et une allure à plat n'y veut rien dire.
  const effort = raw.effort === undefined ? undefined : text(raw.effort, `${at}.effort`, MAX_EFFORT_CHARS);
  if (effort !== undefined) {
    if (kind !== undefined) throw new Error(`${at}.effort : un bloc ${kind} ne se court pas.`);
    const offending = (['hrRange', 'speedRangeMs'] as const).filter((f) => raw[f] !== undefined);
    if (offending.length > 0) {
      throw new Error(
        `${at}.${offending[0]} : un bloc piloté à l'effort ne se pilote ni à la FC ni à l'allure — ` +
          `sa consigne d'effort les remplace.`,
      );
    }
  }

  const statedDurationS = raw.durationS === undefined
    ? undefined
    : Math.round(number(raw.durationS, `${at}.durationS`, 1, MAX_BLOCK_DURATION_S));
  const distanceM = raw.distanceM === undefined
    ? undefined
    : Math.round(number(raw.distanceM, `${at}.distanceM`, 1, MAX_BLOCK_DISTANCE_M));
  const elevationGainM = raw.elevationGainM === undefined
    ? undefined
    : Math.round(number(raw.elevationGainM, `${at}.elevationGainM`, 0, MAX_ELEVATION_GAIN_M));
  const elevationLossM = raw.elevationLossM === undefined
    ? undefined
    : Math.round(number(raw.elevationLossM, `${at}.elevationLossM`, 0, MAX_ELEVATION_GAIN_M));
  const vamTargetMh = raw.vamTargetMh === undefined
    ? undefined
    : Math.round(number(raw.vamTargetMh, `${at}.vamTargetMh`, 1, MAX_VAM_MH));

  // Durée, dénivelé et vitesse ascensionnelle d'une montée décrivent un même
  // fait : deux suffisent, le troisième s'en déduit. Les trois s'écrivaient
  // librement, et c'est ainsi qu'une rando-course a prescrit 1 384 m en 55 min
  // sous une cible de 854 m/h — 1 501 m/h exigés, soit au-delà du meilleur
  // effort d'une minute de l'athlète, tenu cinquante.
  const durationS =
    statedDurationS === undefined && elevationGainM !== undefined && vamTargetMh !== undefined
      ? resolveClimb({ elevationGainM, vamTargetMh }).durationS
      : statedDurationS;
  if (durationS !== undefined && durationS > MAX_BLOCK_DURATION_S) {
    throw new Error(
      `${at} : ${elevationGainM} m à ${vamTargetMh} m/h demandent ${Math.round(durationS / 360) / 10} h ` +
        `de montée, maximum ${MAX_BLOCK_DURATION_S / 3600} h par bloc.`,
    );
  }
  if (durationS !== undefined && elevationGainM !== undefined && vamTargetMh !== undefined) {
    const climbedM = (vamTargetMh * durationS) / 3600;
    if (Math.abs(elevationGainM - climbedM) > 1 + 0.01 * climbedM) {
      throw new Error(
        `${at} : ${elevationGainM} m en ${Math.round(durationS / 60)} min exigent ` +
          `${Math.round((elevationGainM / durationS) * 3600)} m/h, pour une cible annoncée à ${vamTargetMh} m/h. ` +
          `Durée, dénivelé et vitesse ascensionnelle décrivent un même fait : deux suffisent, ` +
          `le troisième s'en déduit — n'en écris que deux.`,
      );
    }
  }
  if (durationS === undefined && distanceM === undefined) {
    throw new Error(`${at} : durationS ou distanceM requis — un bloc sans étendue ne se prescrit pas.`);
  }
  if (vamTargetMh !== undefined && (elevationLossM ?? 0) > 0) {
    throw new Error(
      `${at}.elevationLossM : une montée à vitesse cible monte pendant toute sa durée — sa descente se déclare ` +
        `sur le segment qui la redescend.`,
    );
  }

  const block: SessionBlock = { label: text(raw.label, `${at}.label`, MAX_LABEL_CHARS), zone };
  if (kind !== undefined) block.kind = kind;
  if (durationS !== undefined) block.durationS = durationS;
  if (distanceM !== undefined) block.distanceM = distanceM;

  // Les cibles omises viennent de la zone. Une cible explicite peut sortir de la
  // bande — un test maximal vise au-delà du plafond de Z4 — mais reste bornée
  // par la physiologie de l'athlète.
  if (effort !== undefined) {
    block.effort = effort;
    if (vamTargetMh !== undefined) block.provenance = { vam: 'default' };
  } else if (kind === undefined) {
    const hrRange = raw.hrRange === undefined
      ? ([Math.round(z.hrMin), Math.round(z.hrMax)] as [number, number])
      : range(raw.hrRange, `${at}.hrRange`, 0, model.hrMax, true);
    // Une zone sans plafond mesuré n'en prête pas un : Z5 s'ouvre au-delà de la
    // VMA, et un bloc qui s'y court doit écrire la fourchette qu'il vise.
    if (raw.speedRangeMs === undefined && z.speedMaxMs == null) {
      throw new Error(
        `${at}.speedRangeMs : la zone ${zone} n'a pas de borne haute de vitesse mesurée — ` +
          `écris la fourchette visée plutôt que d'en hériter une.`,
      );
    }
    const speedRangeMs = raw.speedRangeMs === undefined
      ? ([z.speedMinMs, z.speedMaxMs as number] as [number, number])
      : range(raw.speedRangeMs, `${at}.speedRangeMs`, 0, model.vmaMs * 1.5, false);
    block.hrRange = hrRange;
    block.speedRangeMs = speedRangeMs;
    block.paceRange = [formatPace(speedRangeMs[1]), formatPace(speedRangeMs[0])];
    // Une cible qui est la bande de sa zone en porte la provenance, qu'elle ait
    // été omise ou réécrite à l'identique — c'est la même origine. Une cible que
    // le coach resserre ou déplace ne repose, elle, sur rien de mesuré : elle se
    // déclare comme telle plutôt que d'emprunter la crédibilité de la bande
    // qu'elle remplace.
    const asBand = (r: [number, number], lo: number, hi: number) =>
      Math.abs(r[0] - lo) < 1e-9 && Math.abs(r[1] - hi) < 1e-9;
    block.provenance = {
      hr: asBand(hrRange, Math.round(z.hrMin), Math.round(z.hrMax)) ? hrProvenanceOf(z) : 'default',
      speed: asBand(speedRangeMs, z.speedMinMs, z.speedMaxMs as number)
        ? speedProvenanceOf(z)
        : 'default',
      ...(vamTargetMh !== undefined ? { vam: 'default' as const } : {}),
    };
  }

  if (raw.repeat !== undefined) {
    block.repeat = Math.round(number(raw.repeat, `${at}.repeat`, 1, MAX_REPEAT));
  }
  if (elevationGainM !== undefined) block.elevationGainM = elevationGainM;
  if (elevationLossM !== undefined) block.elevationLossM = elevationLossM;
  if (vamTargetMh !== undefined) block.vamTargetMh = vamTargetMh;
  if (raw.cadenceTargetSpm !== undefined) {
    block.cadenceTargetSpm = Math.round(number(raw.cadenceTargetSpm, `${at}.cadenceTargetSpm`, 120, 240));
  }
  if (raw.recovery !== undefined) {
    block.recovery = parseRecovery(raw.recovery, `${at}.recovery`, zones);
  }
  if (raw.circuit !== undefined) {
    block.circuit = parseCircuit(raw.circuit, `${at}.circuit`);
  }
  if (raw.notes !== undefined) {
    block.notes = text(raw.notes, `${at}.notes`, MAX_NOTES_CHARS);
  }
  return block;
}

function parseRecovery(raw: unknown, at: string, zones: ZoneDefinition[]): Recovery {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${at} : objet attendu.`);
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!RECOVERY_FIELDS.has(key)) throw new Error(`${at}.${key} : champ inconnu.`);
  }
  const zone = zoneKey(r.zone, `${at}.zone`);
  const z = zones.find((x) => x.key === zone)!;
  const recovery: Recovery = {
    durationS: Math.round(number(r.durationS, `${at}.durationS`, 1, MAX_BLOCK_DURATION_S)),
    zone,
    active: r.active === undefined ? true : boolean(r.active, `${at}.active`),
  };
  // Une récupération qui sépare les répétitions n'en suit pas la dernière : la
  // durée, le dénivelé et la charge de la séance la comptent une fois de moins.
  if (r.betweenReps !== undefined && boolean(r.betweenReps, `${at}.betweenReps`)) {
    recovery.betweenReps = true;
  }
  // La remontée d'une descente, la descente d'une côte : une récupération qui
  // franchit du dénivelé le déclare, et son temps se contrôle comme un autre.
  if (r.elevationGainM !== undefined) {
    recovery.elevationGainM = Math.round(number(r.elevationGainM, `${at}.elevationGainM`, 0, MAX_ELEVATION_GAIN_M));
  }
  if (r.elevationLossM !== undefined) {
    recovery.elevationLossM = Math.round(number(r.elevationLossM, `${at}.elevationLossM`, 0, MAX_ELEVATION_GAIN_M));
  }
  // Une récupération est un segment de la séance : elle porte ce qu'il y a à y
  // tenir, comme les blocs. Sans cela, « récup 90 s active » s'exécute au juger,
  // et le bilan de réserve anaérobie doit deviner la vitesse au lieu de la lire.
  // Une remontée se marche : sa plage cardiaque dit ce qu'est « facile », une
  // allure à plat n'y dirait rien.
  if (z.speedMaxMs != null) {
    recovery.hrRange = [Math.round(z.hrMin), Math.round(z.hrMax)];
    if ((recovery.elevationGainM ?? 0) > 0) {
      recovery.provenance = { hr: hrProvenanceOf(z) };
    } else {
      recovery.speedRangeMs = [z.speedMinMs, z.speedMaxMs];
      recovery.paceRange = [formatPace(z.speedMaxMs), formatPace(z.speedMinMs)];
      recovery.provenance = { hr: hrProvenanceOf(z), speed: speedProvenanceOf(z) };
    }
  }
  return recovery;
}

/**
 * Valide un circuit de renforcement.
 *
 * La liste des mouvements est fermée, et c'est la condition pour que le contenu
 * atteigne le chiffre : un mouvement inventé n'a ni course de freinage ni
 * sévérité, donc pas de charge. Le refuser vaut mieux que le compter zéro
 * pendant que l'athlète le fait.
 */
function parseCircuit(raw: unknown, at: string): StrengthCircuit {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${at} : objet attendu.`);
  }
  const c = raw as Record<string, unknown>;
  for (const key of Object.keys(c)) {
    if (!CIRCUIT_FIELDS.has(key)) throw new Error(`${at}.${key} : champ inconnu.`);
  }
  const rounds = Math.round(number(c.rounds, `${at}.rounds`, 1, MAX_ROUNDS));
  if (!Array.isArray(c.exercises) || c.exercises.length === 0) {
    throw new Error(`${at}.exercises : un tableau d'au moins un exercice est attendu.`);
  }
  if (c.exercises.length > MAX_EXERCISES) {
    throw new Error(`${at}.exercises : ${c.exercises.length} exercices, maximum ${MAX_EXERCISES}.`);
  }
  const exercises = c.exercises.map((entry, i) => {
    const where = `${at}.exercises[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      throw new Error(`${where} : objet attendu.`);
    }
    const e = entry as Record<string, unknown>;
    for (const key of Object.keys(e)) {
      if (!EXERCISE_FIELDS.has(key)) throw new Error(`${where}.${key} : champ inconnu.`);
    }
    if (typeof e.movement !== 'string' || !(MOVEMENTS as string[]).includes(e.movement)) {
      throw new Error(`${where}.movement : mouvement attendu parmi ${MOVEMENTS.join(', ')}.`);
    }
    return {
      movement: e.movement as EccentricMovement,
      reps: Math.round(number(e.reps, `${where}.reps`, 1, MAX_REPS)),
    };
  });
  return { rounds, exercises };
}

// ─── Primitives ──────────────────────────────────────────────────────────────

const show = (n: number) => (Number.isInteger(n) ? String(n) : String(Math.round(n * 100) / 100));

function number(v: unknown, at: string, min: number, max: number): number {
  if (typeof v !== 'number' || !Number.isFinite(v)) throw new Error(`${at} : nombre attendu.`);
  if (v < min || v > max) throw new Error(`${at} : ${show(v)} hors bornes [${show(min)}, ${show(max)}].`);
  return v;
}

function range(v: unknown, at: string, min: number, max: number, integer: boolean): [number, number] {
  if (!Array.isArray(v) || v.length !== 2) throw new Error(`${at} : deux nombres attendus, [min, max].`);
  const lo = number(v[0], `${at}[0]`, min, max);
  const hi = number(v[1], `${at}[1]`, min, max);
  if (lo >= hi) throw new Error(`${at} : borne basse ${show(lo)} ≥ borne haute ${show(hi)}.`);
  return integer ? [Math.round(lo), Math.round(hi)] : [lo, hi];
}

function text(v: unknown, at: string, max: number): string {
  if (typeof v !== 'string') throw new Error(`${at} : texte attendu.`);
  const s = v.trim();
  if (!s) throw new Error(`${at} : ne peut pas être vide.`);
  if (s.length > max) throw new Error(`${at} : ${s.length} caractères, maximum ${max}.`);
  return s;
}

function boolean(v: unknown, at: string): boolean {
  if (typeof v !== 'boolean') throw new Error(`${at} : booléen attendu.`);
  return v;
}

function zoneKey(v: unknown, at: string): ZoneKey {
  if (typeof v !== 'string' || !(ZONE_KEYS as string[]).includes(v)) {
    throw new Error(`${at} : zone attendue parmi ${ZONE_KEYS.join(', ')}.`);
  }
  return v as ZoneKey;
}

function blockKind(v: unknown, at: string): BlockKind {
  if (typeof v !== 'string' || !BLOCK_KINDS.includes(v)) {
    throw new Error(`${at} : nature attendue parmi ${BLOCK_KINDS.join(', ')}.`);
  }
  return v as BlockKind;
}
