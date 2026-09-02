import type { PhysiologyModel, SessionBlock, ZoneDefinition, ZoneKey } from '@cairn/core';
import { ZONE_KEYS, buildZones, formatPace } from '@cairn/physiology';
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

const BLOCK_FIELDS = new Set([
  'label', 'zone', 'durationS', 'distanceM', 'repeat', 'elevationGainM',
  'hrRange', 'speedRangeMs', 'vamTargetMh', 'cadenceTargetSpm', 'recovery', 'notes',
]);

const RECOVERY_FIELDS = new Set(['durationS', 'zone', 'active']);

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

  const durationS = raw.durationS === undefined
    ? undefined
    : Math.round(number(raw.durationS, `${at}.durationS`, 1, MAX_BLOCK_DURATION_S));
  const distanceM = raw.distanceM === undefined
    ? undefined
    : Math.round(number(raw.distanceM, `${at}.distanceM`, 1, MAX_BLOCK_DISTANCE_M));
  if (durationS === undefined && distanceM === undefined) {
    throw new Error(`${at} : durationS ou distanceM requis — un bloc sans étendue ne se prescrit pas.`);
  }

  // Les cibles omises viennent de la zone. Une cible explicite peut sortir de la
  // bande — un test maximal vise au-delà du plafond de Z4 — mais reste bornée
  // par la physiologie de l'athlète.
  const hrRange = raw.hrRange === undefined
    ? ([Math.round(z.hrMin), Math.round(z.hrMax)] as [number, number])
    : range(raw.hrRange, `${at}.hrRange`, 0, model.hrMax, true);
  const speedRangeMs = raw.speedRangeMs === undefined
    ? ([z.speedMinMs, z.speedMaxMs] as [number, number])
    : range(raw.speedRangeMs, `${at}.speedRangeMs`, 0, model.vmaMs * 1.5, false);

  const block: SessionBlock = { label: text(raw.label, `${at}.label`, MAX_LABEL_CHARS), zone };
  if (durationS !== undefined) block.durationS = durationS;
  if (distanceM !== undefined) block.distanceM = distanceM;
  block.hrRange = hrRange;
  block.speedRangeMs = speedRangeMs;
  block.paceRange = [formatPace(speedRangeMs[1]), formatPace(speedRangeMs[0])];

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
