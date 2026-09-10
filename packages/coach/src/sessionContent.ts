import type {
  BlockKind, EccentricMovement, PhysiologyModel, SessionBlock, StrengthCircuit, StrengthExercise,
  ZoneDefinition, ZoneKey,
} from '@cairn/core';
import { ECCENTRIC_MOVEMENTS, ZONE_KEYS, buildZones, formatPace } from '@cairn/physiology';
import { sessionTotals } from './sessionLibrary.js';

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
 * `paceRange` est seul exclu : il est dérivé de `speedRangeMs` et ne se saisit
 * pas.
 */
const WRITABLE_BLOCK_FIELDS: Record<Exclude<keyof SessionBlock, 'paceRange'>, true> = {
  label: true, kind: true, zone: true, durationS: true, distanceM: true, repeat: true,
  elevationGainM: true, hrRange: true, speedRangeMs: true, vamTargetMh: true,
  cadenceTargetSpm: true, recovery: true, circuit: true, notes: true,
};

const WRITABLE_RECOVERY_FIELDS: Record<keyof NonNullable<SessionBlock['recovery']>, true> = {
  durationS: true, zone: true, active: true,
};
const WRITABLE_CIRCUIT_FIELDS: Record<keyof StrengthCircuit, true> = { rounds: true, exercises: true };
const WRITABLE_EXERCISE_FIELDS: Record<keyof StrengthExercise, true> = { movement: true, reps: true };
/** Même exigence sur les natures de bloc : la liste ne peut pas prendre du retard sur le type. */
const WRITABLE_BLOCK_KINDS: Record<BlockKind, true> = { mobility: true, respiratory: true };

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

  const durationS = raw.durationS === undefined
    ? undefined
    : Math.round(number(raw.durationS, `${at}.durationS`, 1, MAX_BLOCK_DURATION_S));
  const distanceM = raw.distanceM === undefined
    ? undefined
    : Math.round(number(raw.distanceM, `${at}.distanceM`, 1, MAX_BLOCK_DISTANCE_M));
  if (durationS === undefined && distanceM === undefined) {
    throw new Error(`${at} : durationS ou distanceM requis — un bloc sans étendue ne se prescrit pas.`);
  }

  const block: SessionBlock = { label: text(raw.label, `${at}.label`, MAX_LABEL_CHARS), zone };
  if (kind !== undefined) block.kind = kind;
  if (durationS !== undefined) block.durationS = durationS;
  if (distanceM !== undefined) block.distanceM = distanceM;

  // Les cibles omises viennent de la zone. Une cible explicite peut sortir de la
  // bande — un test maximal vise au-delà du plafond de Z4 — mais reste bornée
  // par la physiologie de l'athlète.
  if (kind === undefined) {
    const hrRange = raw.hrRange === undefined
      ? ([Math.round(z.hrMin), Math.round(z.hrMax)] as [number, number])
      : range(raw.hrRange, `${at}.hrRange`, 0, model.hrMax, true);
    const speedRangeMs = raw.speedRangeMs === undefined
      ? ([z.speedMinMs, z.speedMaxMs] as [number, number])
      : range(raw.speedRangeMs, `${at}.speedRangeMs`, 0, model.vmaMs * 1.5, false);
    block.hrRange = hrRange;
    block.speedRangeMs = speedRangeMs;
    block.paceRange = [formatPace(speedRangeMs[1]), formatPace(speedRangeMs[0])];
  }

  if (raw.repeat !== undefined) {
    block.repeat = Math.round(number(raw.repeat, `${at}.repeat`, 1, MAX_REPEAT));
  }
  if (raw.elevationGainM !== undefined) {
    block.elevationGainM = Math.round(number(raw.elevationGainM, `${at}.elevationGainM`, 0, MAX_ELEVATION_GAIN_M));
  }
  if (raw.vamTargetMh !== undefined) {
    block.vamTargetMh = Math.round(number(raw.vamTargetMh, `${at}.vamTargetMh`, 1, MAX_VAM_MH));
  }
  if (raw.cadenceTargetSpm !== undefined) {
    block.cadenceTargetSpm = Math.round(number(raw.cadenceTargetSpm, `${at}.cadenceTargetSpm`, 120, 240));
  }
  if (raw.recovery !== undefined) {
    block.recovery = parseRecovery(raw.recovery, `${at}.recovery`);
  }
  if (raw.circuit !== undefined) {
    block.circuit = parseCircuit(raw.circuit, `${at}.circuit`);
  }
  if (raw.notes !== undefined) {
    block.notes = text(raw.notes, `${at}.notes`, MAX_NOTES_CHARS);
  }
  return block;
}

function parseRecovery(raw: unknown, at: string): NonNullable<SessionBlock['recovery']> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    throw new Error(`${at} : objet attendu.`);
  }
  const r = raw as Record<string, unknown>;
  for (const key of Object.keys(r)) {
    if (!RECOVERY_FIELDS.has(key)) throw new Error(`${at}.${key} : champ inconnu.`);
  }
  return {
    durationS: Math.round(number(r.durationS, `${at}.durationS`, 1, MAX_BLOCK_DURATION_S)),
    zone: zoneKey(r.zone, `${at}.zone`),
    active: r.active === undefined ? true : boolean(r.active, `${at}.active`),
  };
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
