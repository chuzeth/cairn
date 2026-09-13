import type { ParameterProvenance, PhysiologyModel, SessionBlock, SessionType } from '@cairn/core';
import { sessionDuration } from '@cairn/core';
import { verticalCapacity, type VerticalBound, type VerticalCapacity } from '@cairn/physiology';

/**
 * Plausibilité verticale d'une séance.
 *
 * Le temps d'une séance est un budget. Corriger un bloc au cas par cas prend le
 * temps d'un autre : la montée d'une rando-course ramenée à une vitesse tenable
 * a pris ses minutes à la descente, qui exigeait alors 5 190 m/h. L'invariant ne
 * porte donc pas sur un bloc mais sur chaque segment chronométré — l'effort d'un
 * bloc, ou sa récupération : ce qu'il monte doit pouvoir se monter, et ce qu'il
 * descend se descendre, dans le temps qu'il dure, d'après les courbes de
 * l'athlète. Un segment qui ne tient pas rend la séance inexécutable, quel que
 * soit l'état des autres.
 *
 * Pour que le contrôle voie tout, chaque mètre doit être situé. Le D− l'est
 * désormais sur les blocs comme le D+ ; un contenu écrit avant l'est par la
 * règle de la boucle (`locateVertical`), la même que le calcul de charge
 * mécanique supposait déjà sans jamais dire où.
 */

export interface AthleteVertical {
  climb: VerticalCapacity;
  descent: VerticalCapacity;
}

const byModel = new WeakMap<PhysiologyModel, AthleteVertical>();

/**
 * Les deux courbes de l'athlète, construites à la demande et une fois par
 * modèle : un plan en juge des centaines de segments.
 */
export function verticalOf(model: PhysiologyModel): AthleteVertical {
  const cacheable = typeof model === 'object' && model !== null;
  const known = cacheable ? byModel.get(model) : undefined;
  if (known) return known;
  let climb: VerticalCapacity | undefined;
  let descent: VerticalCapacity | undefined;
  const vertical: AthleteVertical = {
    get climb() {
      return (climb ??= verticalCapacity(model, 'climb'));
    },
    get descent() {
      return (descent ??= verticalCapacity(model, 'descent'));
    },
  };
  if (cacheable) byModel.set(model, vertical);
  return vertical;
}

/** Une seconde d'arrondi ne rend pas une séance impossible. */
const TOLERANCE_S = 1;

const PROVENANCE_FR: Record<ParameterProvenance, string> = {
  lab: 'laboratoire',
  field: 'terrain',
  blended: 'mixte',
  default: 'valeur par défaut',
};

const isRunning = (b: SessionBlock) => !b.kind && !b.circuit;
const hasVertical = (b: SessionBlock) =>
  (b.elevationGainM ?? 0) > 0 || (b.elevationLossM ?? 0) > 0 ||
  (b.recovery?.elevationGainM ?? 0) > 0 || (b.recovery?.elevationLossM ?? 0) > 0;

/** Vrai quand le contenu dit lui-même où il descend, zéro compris. */
export function declaresDescent(blocks: readonly SessionBlock[]): boolean {
  return blocks.some((b) => b.elevationLossM !== undefined || b.recovery?.elevationLossM !== undefined);
}

/**
 * Situe le dénivelé d'un contenu qui ne déclare pas où il descend.
 *
 * C'est la boucle que le calcul de charge supposait, rendue explicite :
 * — une montée à vitesse cible occupe tout son temps à monter : elle est
 *   redescendue par le bloc couru suivant qui ne porte aucun dénivelé ;
 * — un bloc répété qui monte redescend dans sa récupération — la côte ;
 * — sauf une séance de descente, dont la répétition descend et la récupération
 *   remonte : c'est ainsi que la bibliothèque l'écrivait ;
 * — tout autre bloc qui monte descend ce qu'il monte, dans son propre temps.
 *
 * Un contenu qui déclare son D−, même à zéro, est rendu tel quel.
 */
export function locateVertical(blocks: readonly SessionBlock[], type?: SessionType): SessionBlock[] {
  const out = blocks.map((b) => ({ ...b, ...(b.recovery ? { recovery: { ...b.recovery } } : {}) }));
  if (declaresDescent(out)) return out;

  for (let i = 0; i < out.length; i++) {
    const b = out[i]!;
    const gain = b.elevationGainM ?? 0;
    if (gain <= 0 || !isRunning(b)) continue;

    if (b.recovery && (b.repeat ?? 1) > 1) {
      if (type === 'downhill' && !b.vamTargetMh) {
        b.elevationLossM = gain;
        b.elevationGainM = 0;
        b.recovery.elevationGainM = gain;
      } else {
        b.recovery.elevationLossM = gain;
      }
      continue;
    }
    if (b.vamTargetMh) {
      const into = out
        .slice(i + 1)
        .find((x) => isRunning(x) && !hasVertical(x) && !x.repeat && (x.durationS ?? 0) > 0);
      if (into) {
        into.elevationLossM = gain * (b.repeat ?? 1);
        continue;
      }
    }
    b.elevationLossM = gain;
  }
  return out;
}

/** Un segment chronométré, pour une répétition : l'effort d'un bloc ou sa récupération. */
export interface VerticalSegment {
  block: number;
  part: 'work' | 'recovery';
  label: string;
  durationS: number;
  gainM: number;
  lossM: number;
}

export interface SegmentVerdict extends VerticalSegment {
  /** Temps minimal que les courbes accordent à ce dénivelé, s. */
  climbS: number;
  descentS: number;
  minimalS: number;
  /** Vitesses exigées sur la durée du segment, m/h. */
  climbMh: number;
  descentMh: number;
  /** Bornes sur la durée du segment, quand il ne fait que monter ou que descendre. */
  climbBound?: VerticalBound;
  descentBound?: VerticalBound;
  /** Provenance des temps minimaux : la plus faible des deux. */
  provenance: ParameterProvenance;
  feasible: boolean;
}

export function verticalSegments(blocks: readonly SessionBlock[]): VerticalSegment[] {
  const out: VerticalSegment[] = [];
  blocks.forEach((b, i) => {
    if ((b.elevationGainM ?? 0) > 0 || (b.elevationLossM ?? 0) > 0) {
      out.push({
        block: i, part: 'work', label: b.label, durationS: b.durationS ?? 0,
        gainM: b.elevationGainM ?? 0, lossM: b.elevationLossM ?? 0,
      });
    }
    const r = b.recovery;
    if (r && ((r.elevationGainM ?? 0) > 0 || (r.elevationLossM ?? 0) > 0)) {
      out.push({
        block: i, part: 'recovery', label: `${b.label} — récupération`, durationS: r.durationS,
        gainM: r.elevationGainM ?? 0, lossM: r.elevationLossM ?? 0,
      });
    }
  });
  return out;
}

export function judgeSegment(s: VerticalSegment, vertical: AthleteVertical): SegmentVerdict {
  const up = s.gainM > 0 ? vertical.climb.timeFor(s.gainM) : null;
  const down = s.lossM > 0 ? vertical.descent.timeFor(s.lossM) : null;
  const climbS = up?.durationS ?? 0;
  const descentS = down?.durationS ?? 0;
  const minimalS = climbS + descentS;
  const perHour = (m: number) => (s.durationS > 0 ? Math.round((m / s.durationS) * 3600) : Infinity);
  const provenances = [up?.provenance, down?.provenance].filter((p): p is ParameterProvenance => p != null);
  return {
    ...s,
    climbS,
    descentS,
    minimalS,
    climbMh: s.gainM > 0 ? perHour(s.gainM) : 0,
    descentMh: s.lossM > 0 ? perHour(s.lossM) : 0,
    ...(s.gainM > 0 && s.lossM <= 0 ? { climbBound: vertical.climb.at(s.durationS) } : {}),
    ...(s.lossM > 0 && s.gainM <= 0 ? { descentBound: vertical.descent.at(s.durationS) } : {}),
    provenance: provenances.includes('default') ? 'default' : (provenances[0] ?? 'field'),
    feasible: s.durationS > 0 && minimalS <= s.durationS + TOLERANCE_S,
  };
}

/** Juge chaque segment d'un contenu, une fois son dénivelé situé. */
export function checkVertical(
  blocks: readonly SessionBlock[],
  vertical: AthleteVertical,
  type?: SessionType,
): SegmentVerdict[] {
  return verticalSegments(locateVertical(blocks, type)).map((s) => judgeSegment(s, vertical));
}

const minutes = (s: number) => (Number.isFinite(s) ? sessionDuration(s) : 'plus d’une journée');

/** Ce qui rend un segment impossible, en une phrase. */
export function describeVerdict(v: SegmentVerdict): string {
  const where = `« ${v.label} »`;
  if (v.durationS <= 0) {
    return `${where} : un dénivelé ne se prescrit que sur une durée, et ce segment n'en a pas.`;
  }
  if (v.climbBound) {
    return (
      `${where} : ${v.gainM} m de D+ en ${minutes(v.durationS)} exigent ${v.climbMh} m/h ; ta courbe de montée ` +
      `atteste ${Math.round(v.climbBound.vamMh)} m/h sur cette durée (${PROVENANCE_FR[v.climbBound.provenance]}). ` +
      `Il faut au moins ${minutes(Math.ceil(v.climbS))} pour ce dénivelé.`
    );
  }
  if (v.descentBound) {
    return (
      `${where} : ${v.lossM} m de D− en ${minutes(v.durationS)} exigent ${v.descentMh} m/h ; ta courbe de descente ` +
      `atteste ${Math.round(v.descentBound.vamMh)} m/h sur cette durée (${PROVENANCE_FR[v.descentBound.provenance]}). ` +
      `Il faut au moins ${minutes(Math.ceil(v.descentS))} pour ce dénivelé.`
    );
  }
  return (
    `${where} : ${v.gainM} m de D+ et ${v.lossM} m de D− demandent au moins ${minutes(Math.ceil(v.minimalS))} ` +
    `(${minutes(Math.ceil(v.climbS))} de montée, ${minutes(Math.ceil(v.descentS))} de descente, ` +
    `${PROVENANCE_FR[v.provenance]}) ; le segment en dure ${minutes(v.durationS)}.`
  );
}

/**
 * Met à l'échelle le dénivelé d'un contenu, D+ et D− ensemble, effort et
 * récupération : une boucle qui perd de la montée perd la descente qui la
 * redescend. Arrondi au mètre inférieur — ce qu'on retire pour rendre une
 * séance exécutable ne doit pas revenir par l'arrondi.
 */
export function scaleVertical(blocks: readonly SessionBlock[], k: number): SessionBlock[] {
  const cut = (m: number | undefined) => (m === undefined ? undefined : Math.floor(m * k + 1e-9));
  return blocks.map((b) => {
    const out: SessionBlock = { ...b };
    if (b.elevationGainM !== undefined) out.elevationGainM = cut(b.elevationGainM);
    if (b.elevationLossM !== undefined) out.elevationLossM = cut(b.elevationLossM);
    if (b.recovery) {
      out.recovery = { ...b.recovery };
      if (b.recovery.elevationGainM !== undefined) out.recovery.elevationGainM = cut(b.recovery.elevationGainM);
      if (b.recovery.elevationLossM !== undefined) out.recovery.elevationLossM = cut(b.recovery.elevationLossM);
    }
    if (b.vamTargetMh !== undefined && (out.durationS ?? 0) > 0) {
      out.vamTargetMh = Math.round(((out.elevationGainM ?? 0) / (out.durationS as number)) * 3600);
    }
    return out;
  });
}

export interface VerticalFit {
  /** Contenu exécutable, dénivelé situé. */
  blocks: SessionBlock[];
  /** Part du dénivelé conservée : 1 quand tout tenait. */
  share: number;
  /** Les segments qui ne tenaient pas, avant correction. */
  refused: SegmentVerdict[];
}

/**
 * Rend un contenu exécutable en retirant du dénivelé, et seulement du dénivelé.
 *
 * La durée est ce qu'on a demandé à la séance ; c'est le dénivelé qui cède,
 * dans la même proportion partout, pour que la séance garde sa forme et que sa
 * boucle se referme. La part retenue est la plus grande qui fait tenir chaque
 * segment.
 */
export function fitVertical(
  blocks: readonly SessionBlock[],
  vertical: AthleteVertical,
  type?: SessionType,
): VerticalFit {
  const located = locateVertical(blocks, type);
  const allFit = (content: readonly SessionBlock[]) =>
    verticalSegments(content).every((s) => judgeSegment(s, vertical).feasible);
  const segments = verticalSegments(located);
  if (segments.length === 0 || allFit(located)) return { blocks: located, share: 1, refused: [] };

  const refused = segments.map((s) => judgeSegment(s, vertical)).filter((v) => !v.feasible);
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (allFit(scaleVertical(located, mid))) lo = mid;
    else hi = mid;
  }
  return { blocks: scaleVertical(located, lo), share: lo, refused };
}
