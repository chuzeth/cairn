import type { ParameterProvenance, PhysiologyModel, SessionBlock, SessionType } from '@cairn/core';
import { sessionDuration } from '@cairn/core';
import {
  verticalCapacity, weakestProvenance, type VerticalBound, type VerticalCapacity,
} from '@cairn/physiology';

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
 * Un segment n'est pas couru frais : il est borné par la capacité qui reste à
 * l'instant où il commence, une fois retiré ce que la séance a déjà coûté. Et
 * une prescription n'est pas une frontière : elle laisse une marge sous cette
 * borne. Les deux rando-courses reconstruites exigeaient exactement le meilleur
 * de ce que l'athlète avait démontré, la descente jugée comme s'il partait de
 * chez lui — la moindre perte de rendement les rendait infaisables, et c'est
 * cette perte qu'elles existent pour mesurer.
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

/**
 * Marge qu'une prescription laisse sous la borne de l'instant.
 *
 * La borne de l'instant retranche une perte de rendement estimée, et c'est cette
 * estimation que la rando-course existe pour mesurer : une prescription doit
 * rester exécutable si la perte réelle est au bout haut de ce qu'on en sait. Au
 * 13/09/2026, les 23 mesures de durabilité de bonne qualité de Pierre placent
 * leur médiane sous 10,1 %/h à 95 % de confiance, contre 5,7 retenus — et à deux
 * heures de séance, cet écart retire 10 % à la borne.
 */
export const PRESCRIPTION_MARGIN = 0.1;

/** Une seconde d'arrondi ne rend pas une séance impossible. */
const TOLERANCE_S = 1;

export const PROVENANCE_FR: Record<ParameterProvenance, string> = {
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

/**
 * Un segment chronométré : l'effort d'un bloc ou sa récupération.
 *
 * Un bloc répété se juge sur sa dernière répétition, la plus entamée : c'est
 * elle que la séance doit encore pouvoir faire exécuter.
 */
export interface VerticalSegment {
  block: number;
  part: 'work' | 'recovery';
  label: string;
  /** Répétitions du bloc ; le segment décrit la dernière. */
  repeat: number;
  durationS: number;
  gainM: number;
  lossM: number;
  /** Heure de départ du segment dans la séance, s. */
  startS: number;
  /** Dénivelés déjà franchis quand il commence, m. */
  gainBeforeM: number;
  lossBeforeM: number;
}

export interface SegmentVerdict extends VerticalSegment {
  /** Temps minimal qu'une prescription accorde à ce dénivelé — capacité de l'instant, marge comprise —, s. */
  climbS: number;
  descentS: number;
  minimalS: number;
  /** Vitesses exigées sur la durée du segment, m/h. */
  climbMh: number;
  descentMh: number;
  /**
   * Bornes sur la durée du segment, quand il ne fait que monter ou que
   * descendre : fraîche, puis à l'instant où il commence.
   */
  climbBound?: VerticalBound;
  descentBound?: VerticalBound;
  climbBoundNow?: VerticalBound;
  descentBoundNow?: VerticalBound;
  /** Ce qu'une prescription peut exiger au plus sur cette durée, m/h : la borne de l'instant, moins la marge. */
  ceilingMh?: number;
  /** Provenance des temps minimaux : la plus faible. */
  provenance: ParameterProvenance;
  /** Dans la borne de l'instant : l'athlète peut l'exécuter. */
  feasible: boolean;
  /** Sous la borne de l'instant, marge laissée : la condition de toute prescription. */
  prescribable: boolean;
}

export function verticalSegments(blocks: readonly SessionBlock[]): VerticalSegment[] {
  const out: VerticalSegment[] = [];
  let clockS = 0;
  let gainM = 0;
  let lossM = 0;
  blocks.forEach((b, i) => {
    const repeat = b.repeat ?? 1;
    const r = b.recovery;
    const work = { s: b.durationS ?? 0, gain: b.elevationGainM ?? 0, loss: b.elevationLossM ?? 0 };
    const rest = { s: r?.durationS ?? 0, gain: r?.elevationGainM ?? 0, loss: r?.elevationLossM ?? 0 };
    const done = repeat - 1;
    const last = {
      s: clockS + done * (work.s + rest.s),
      gain: gainM + done * (work.gain + rest.gain),
      loss: lossM + done * (work.loss + rest.loss),
    };
    if (work.gain > 0 || work.loss > 0) {
      out.push({
        block: i, part: 'work', label: b.label, repeat, durationS: work.s, gainM: work.gain, lossM: work.loss,
        startS: last.s, gainBeforeM: last.gain, lossBeforeM: last.loss,
      });
    }
    if (r && (rest.gain > 0 || rest.loss > 0)) {
      out.push({
        block: i, part: 'recovery', label: `${b.label} — récupération`, repeat, durationS: rest.s,
        gainM: rest.gain, lossM: rest.loss,
        startS: last.s + work.s, gainBeforeM: last.gain + work.gain, lossBeforeM: last.loss + work.loss,
      });
    }
    clockS += repeat * (work.s + rest.s);
    gainM += repeat * (work.gain + rest.gain);
    lossM += repeat * (work.loss + rest.loss);
  });
  return out;
}

export function judgeSegment(s: VerticalSegment, vertical: AthleteVertical): SegmentVerdict {
  const before = { elapsedS: s.startS, gainM: s.gainBeforeM, lossM: s.lossBeforeM };
  const climb = s.gainM > 0 ? vertical.climb.after(before) : null;
  const descent = s.lossM > 0 ? vertical.descent.after(before) : null;
  const keep = 1 - PRESCRIPTION_MARGIN;
  const up = climb?.timeFor(s.gainM / keep);
  const down = descent?.timeFor(s.lossM / keep);
  const climbS = up?.durationS ?? 0;
  const descentS = down?.durationS ?? 0;
  const minimalS = climbS + descentS;
  const within = (seconds: number) => s.durationS > 0 && seconds <= s.durationS + TOLERANCE_S;
  const prescribable = within(minimalS);
  // Ce qui laisse sa marge tient a fortiori dans la borne : le temps de
  // l'impossible ne se cherche que pour ce qui ne la laisse pas.
  const feasible =
    prescribable ||
    within((climb?.timeFor(s.gainM).durationS ?? 0) + (descent?.timeFor(s.lossM).durationS ?? 0));
  const perHour = (m: number) => (s.durationS > 0 ? Math.round((m / s.durationS) * 3600) : Infinity);
  const onlyUp = s.gainM > 0 && s.lossM <= 0;
  const onlyDown = s.lossM > 0 && s.gainM <= 0;
  const now = onlyUp ? climb?.at(s.durationS) : onlyDown ? descent?.at(s.durationS) : undefined;
  const [first, ...rest] = [up?.provenance, down?.provenance].filter((p): p is ParameterProvenance => p != null);
  return {
    ...s,
    climbS,
    descentS,
    minimalS,
    climbMh: s.gainM > 0 ? perHour(s.gainM) : 0,
    descentMh: s.lossM > 0 ? perHour(s.lossM) : 0,
    ...(onlyUp ? { climbBound: vertical.climb.at(s.durationS), climbBoundNow: now } : {}),
    ...(onlyDown ? { descentBound: vertical.descent.at(s.durationS), descentBoundNow: now } : {}),
    ...(now ? { ceilingMh: Math.round(now.vamMh * keep) } : {}),
    provenance: first ? weakestProvenance(first, ...rest) : 'default',
    feasible,
    prescribable,
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

/** Ce qui empêche de prescrire un segment, en une phrase. */
export function describeVerdict(v: SegmentVerdict): string {
  const where = `« ${v.label} »${v.repeat > 1 ? ` (${v.repeat}ᵉ répétition)` : ''}`;
  if (v.durationS <= 0) {
    return `${where} : un dénivelé ne se prescrit que sur une durée, et ce segment n'en a pas.`;
  }
  const margin = `${Math.round(PRESCRIPTION_MARGIN * 100)} %`;
  const instant =
    v.startS > 0
      ? `à ${minutes(v.startS)} de séance, après ${v.gainBeforeM} m de D+` +
        (v.lossBeforeM > 0 ? ` et ${v.lossBeforeM} m de D−` : '')
      : null;
  const single =
    v.climbBound && v.climbBoundNow
      ? { meters: `${v.gainM} m de D+`, asked: v.climbMh, curve: 'montée', fresh: v.climbBound, now: v.climbBoundNow, needS: v.climbS }
      : v.descentBound && v.descentBoundNow
        ? { meters: `${v.lossM} m de D−`, asked: v.descentMh, curve: 'descente', fresh: v.descentBound, now: v.descentBoundNow, needS: v.descentS }
        : null;
  if (single) {
    const later = instant ? `, ${Math.round(single.now.vamMh)} m/h ${instant} (${PROVENANCE_FR[single.now.provenance]})` : '';
    return (
      `${where} : ${single.meters} en ${minutes(v.durationS)} exigent ${single.asked} m/h ; ta courbe de ${single.curve} ` +
      `atteste ${Math.round(single.fresh.vamMh)} m/h sur cette durée (${PROVENANCE_FR[single.fresh.provenance]})${later}, ` +
      `et une prescription garde ${margin} de marge sous cette borne : ${v.ceilingMh} m/h au plus. ` +
      `Il faut au moins ${minutes(Math.ceil(single.needS))} pour ce dénivelé.`
    );
  }
  return (
    `${where} : ${v.gainM} m de D+ et ${v.lossM} m de D− demandent au moins ${minutes(Math.ceil(v.minimalS))} ` +
    `(${minutes(Math.ceil(v.climbS))} de montée, ${minutes(Math.ceil(v.descentS))} de descente, marge de ${margin} ` +
    `comprise${instant ? `, ${instant}` : ''} — ${PROVENANCE_FR[v.provenance]}) ; le segment en dure ${minutes(v.durationS)}.`
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
  /** Contenu prescriptible, dénivelé situé. */
  blocks: SessionBlock[];
  /** Part du dénivelé conservée : 1 quand tout tenait. */
  share: number;
  /** Les segments qui ne se prescrivaient pas, avant correction — les impossibles d'abord. */
  refused: SegmentVerdict[];
}

/**
 * Rend un contenu prescriptible en retirant du dénivelé, et seulement du dénivelé.
 *
 * La durée est ce qu'on a demandé à la séance ; c'est le dénivelé qui cède,
 * dans la même proportion partout, pour que la séance garde sa forme et que sa
 * boucle se referme. La part retenue est la plus grande qui laisse à chaque
 * segment sa marge sous la borne de l'instant.
 */
export function fitVertical(
  blocks: readonly SessionBlock[],
  vertical: AthleteVertical,
  type?: SessionType,
): VerticalFit {
  const located = locateVertical(blocks, type);
  const allFit = (content: readonly SessionBlock[]) =>
    verticalSegments(content).every((s) => judgeSegment(s, vertical).prescribable);
  const segments = verticalSegments(located);
  if (segments.length === 0 || allFit(located)) return { blocks: located, share: 1, refused: [] };

  const refused = segments
    .map((s) => judgeSegment(s, vertical))
    .filter((v) => !v.prescribable)
    .sort((a, b) => Number(a.feasible) - Number(b.feasible));
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 30; i++) {
    const mid = (lo + hi) / 2;
    if (allFit(scaleVertical(located, mid))) lo = mid;
    else hi = mid;
  }
  return { blocks: scaleVertical(located, lo), share: lo, refused };
}
