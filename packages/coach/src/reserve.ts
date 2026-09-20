import type { ParameterProvenance, PhysiologyModel, SessionBlock, ZoneDefinition } from '@cairn/core';
import { PROVENANCE_FR, weakestProvenance } from '@cairn/core';
import { buildZones, formatDuration, msToKmh, wPrimeAfter } from '@cairn/physiology';
import { PRESCRIPTION_MARGIN } from './plausibility.js';

/**
 * Faisabilité d'une séance au regard de la réserve anaérobie.
 *
 * `plausibility.ts` vérifie ce qu'une séance demande de monter et de descendre.
 * Il ne dit rien de ce qu'elle demande de tenir : une série de répétitions
 * au-dessus de la vitesse critique vide D' à un rythme connu, et chaque
 * récupération n'en rend qu'une part. Passé un certain nombre de répétitions,
 * la réserve est à zéro et il n'y a plus de séance — l'athlète marche.
 *
 * Le modèle W'bal existait dans `packages/physiology` et ne servait qu'à relire
 * le réalisé. Le prescrit ne passait par aucun contrôle : rien n'empêchait
 * d'écrire dix répétitions là où la réserve n'en finance que six. Une séance
 * qui touche zéro avant son dernier bloc n'est pas une séance dure, c'est une
 * séance infaisable, et la différence n'est pas une nuance de vocabulaire —
 * l'athlète qui échoue sur une séance dure apprend quelque chose, celui qui
 * échoue sur une séance impossible apprend qu'il n'est pas à la hauteur.
 *
 * Deux verdicts, comme pour le dénivelé et pour la même raison : ce qui tient
 * tout juste ne se prescrit pas. `feasible` dit que la réserve reste positive
 * jusqu'au bout ; `prescribable` qu'il lui reste la marge sous laquelle un
 * écart d'allure de quelques pour cent ne fait pas s'écrouler la séance.
 *
 * Chaque segment est jugé au bas de sa fourchette : c'est l'exécution la plus
 * économe que la prescription autorise, et une séance refusée là est refusée
 * quelle que soit la façon de la courir. Une exception, et elle est écrite sur
 * le segment lui-même : une récupération *active* se juge au haut de sa bande,
 * parce que « active » est précisément la consigne de ne pas marcher. Une
 * récupération passive et un bloc qui ne se court pas — souplesse, respiration,
 * circuit de force — rechargent à l'arrêt.
 *
 * Un bloc qui hérite la bande entière de sa zone n'a pas d'allure prescrite : il
 * est jugé au plancher de cette bande, donc le plus souvent pas jugé du tout.
 * C'est voulu — le coach qui écrit « 20 min en Z4 » n'a pas prescrit d'allure, et
 * lui refuser sa séance au nom d'un milieu de bande qu'il n'a pas choisi serait
 * lui opposer un chiffre inventé.
 *
 * Toute fourchette d'allure est corrigée de la pente, montées comprises : c'est
 * ce que le type déclare, et c'est ce qui la rend comparable à la vitesse
 * critique, qui en est une aussi. La vitesse ascensionnelle cible du même bloc
 * décrit le terrain, pas l'intensité.
 */

/** Un segment de séance, tel que la réserve le voit. */
export interface ReserveSegment {
  block: number;
  part: 'work' | 'recovery';
  label: string;
  /** Rang de la répétition dans le bloc, 1 pour la première. */
  rep: number;
  repeat: number;
  durationS: number;
  /** Vitesse retenue, m/s — celle de la prescription. */
  speedMs: number;
  /** Bilan de réserve à l'entrée et à la sortie du segment, m. */
  fromM: number;
  toM: number;
  /** Ce que le segment retire (négatif) ou recharge (positif), m. */
  deltaM: number;
}

export interface ReserveCheck {
  /** Réserve de l'athlète, m, et provenance du couple CS / D'. */
  dPrimeM: number;
  criticalSpeedMs: number;
  provenance: ParameterProvenance;
  segments: ReserveSegment[];
  /** Plus bas niveau atteint, m, et le segment qui l'atteint. */
  lowM: number;
  lowAt: ReserveSegment | null;
  /** Marge exigée sous laquelle une séance ne se prescrit pas, m. */
  reserveM: number;
  /** La réserve reste positive jusqu'au dernier segment. */
  feasible: boolean;
  /** Elle garde en plus sa marge : la condition de toute prescription. */
  prescribable: boolean;
}

/**
 * Vitesse d'un segment de travail : le bas de la fourchette prescrite.
 *
 * Un bloc non couru ne produit aucune vitesse : il recharge comme un arrêt.
 */
function workSpeed(b: SessionBlock): number {
  if (b.kind || b.circuit) return 0;
  return b.speedRangeMs?.[0] ?? 0;
}

/**
 * Vitesse d'une récupération.
 *
 * Elle se lit d'abord sur ce que la récupération déclare — depuis que la
 * bibliothèque l'écrit. Un contenu écrit avant retombe sur la bande de sa zone :
 * son plafond quand elle est active, zéro quand elle est passive. C'est la règle
 * que le calcul de distance appliquait déjà sans le dire, avec 2,4 m/s posés en
 * dur à la place du plafond de Z1.
 */
function recoverySpeed(r: NonNullable<SessionBlock['recovery']>, zones: ZoneDefinition[]): number {
  if (r.speedRangeMs) return r.active ? r.speedRangeMs[1] : 0;
  if (!r.active) return 0;
  const z = zones.find((x) => x.key === r.zone);
  return z?.speedMaxMs ?? 0;
}

/** Segments d'une séance, répétitions déroulées. */
export function reserveSegments(
  blocks: readonly SessionBlock[],
  zones: ZoneDefinition[],
): Omit<ReserveSegment, 'fromM' | 'toM' | 'deltaM'>[] {
  const out: Omit<ReserveSegment, 'fromM' | 'toM' | 'deltaM'>[] = [];
  blocks.forEach((b, i) => {
    const repeat = b.repeat ?? 1;
    const work = b.durationS ?? 0;
    const speed = workSpeed(b);
    for (let rep = 1; rep <= repeat; rep++) {
      if (work > 0) {
        out.push({ block: i, part: 'work', label: b.label, rep, repeat, durationS: work, speedMs: speed });
      }
      if (b.recovery && b.recovery.durationS > 0) {
        out.push({
          block: i,
          part: 'recovery',
          label: `${b.label} — récupération`,
          rep,
          repeat,
          durationS: b.recovery.durationS,
          speedMs: recoverySpeed(b.recovery, zones),
        });
      }
    }
  });
  return out;
}

/** Juge une séance sur ce qu'elle demande à la réserve anaérobie. */
export function checkReserve(blocks: readonly SessionBlock[], model: PhysiologyModel): ReserveCheck {
  const cs = model?.criticalSpeedMs ?? 0;
  const dPrime = model?.dPrimeM ?? 0;
  const provenance = weakestProvenance(
    model?.provenance?.criticalSpeedMs ?? 'default',
    model?.provenance?.dPrimeM,
  );
  const reserveM = dPrime * PRESCRIPTION_MARGIN;
  const base = {
    dPrimeM: dPrime,
    criticalSpeedMs: cs,
    provenance,
    reserveM,
  };
  if (!(cs > 0) || !(dPrime > 0)) {
    return { ...base, segments: [], lowM: dPrime, lowAt: null, feasible: true, prescribable: true };
  }

  const zones = buildZones(model);
  let balance = dPrime;
  let lowM = dPrime;
  let lowAt: ReserveSegment | null = null;

  const segments = reserveSegments(blocks, zones).map((s): ReserveSegment => {
    const fromM = balance;
    balance = wPrimeAfter(balance, s.speedMs, cs, dPrime, s.durationS);
    const segment: ReserveSegment = {
      ...s,
      fromM: Math.round(fromM * 10) / 10,
      toM: Math.round(balance * 10) / 10,
      deltaM: Math.round((balance - fromM) * 10) / 10,
    };
    if (balance < lowM) {
      lowM = balance;
      lowAt = segment;
    }
    return segment;
  });

  return {
    ...base,
    segments,
    lowM: Math.round(lowM * 10) / 10,
    lowAt,
    feasible: lowM > 0,
    prescribable: lowM >= reserveM,
  };
}

const speed = (ms: number) => `${msToKmh(ms).toFixed(1)} km/h`;

/** Où en est la séance quand la réserve atteint son plus bas, en une phrase. */
export function describeReserve(check: ReserveCheck): string {
  const at = check.lowAt;
  if (!at) return 'Aucun segment couru : la réserve anaérobie n\'est pas sollicitée.';
  const where =
    at.repeat > 1
      ? `« ${at.label} » (${at.rep}ᵉ répétition sur ${at.repeat})`
      : `« ${at.label} »`;
  const margin = `${Math.round(PRESCRIPTION_MARGIN * 100)} %`;
  const state = check.feasible
    ? `il en reste ${Math.round(check.lowM)} m sur ${check.dPrimeM}`
    : `elle est à sec`;
  return (
    `Réserve anaérobie au plus bas sur ${where} : ${state}, à ${speed(at.speedMs)} pour une vitesse ` +
    `critique de ${speed(check.criticalSpeedMs)} (${PROVENANCE_FR[check.provenance]}). Une prescription ` +
    `garde ${margin} de D' de marge, soit ${Math.round(check.reserveM)} m.`
  );
}

/**
 * Pourquoi la réserve ne finance pas ce qui est demandé, en une phrase.
 *
 * Elle nomme le segment, ce qu'une répétition coûte, et ce que la récupération
 * qui la suit en rend : les trois nombres dont se déduit le nombre de
 * répétitions tenables, et les seuls qui rendent la décision vérifiable.
 */
export function describeShortfall(check: ReserveCheck): string {
  const at = check.lowAt;
  if (!at) return 'la réserve anaérobie n\'est pas sollicitée.';
  const where =
    at.repeat > 1 ? `la ${at.rep}ᵉ répétition de « ${at.label} »` : `« ${at.label} »`;
  const state = check.feasible
    ? `il ne reste que ${Math.round(check.lowM)} m de réserve anaérobie sur ${check.dPrimeM}`
    : 'la réserve anaérobie est à sec';
  const spent = cost(check);
  return (
    `sur ${where}, ${state} — ${spent}pour une vitesse critique de ` +
    `${speed(check.criticalSpeedMs)} (${PROVENANCE_FR[check.provenance]}).`
  );
}

/**
 * Ce qu'une répétition coûte et ce que sa récupération rend.
 *
 * C'est la première répétition du bloc qui est décrite, pas celle où la réserve
 * touche le fond : au fond, le bilan bute sur son plancher et la recharge qui
 * suit paraît énorme — 41 m rendus là où la deuxième répétition n'en voyait
 * que 8. Le rapport qui explique le nombre de répétitions tenables est celui du
 * départ, quand la réserve est pleine.
 */
function cost(check: ReserveCheck): string {
  const block = check.lowAt?.block;
  const work = check.segments.find((s) => s.block === block && s.part === 'work' && s.deltaM < 0);
  if (!work) return '';
  const rest = check.segments[check.segments.indexOf(work) + 1];
  const back =
    rest?.part === 'recovery' && rest.deltaM > 0
      ? ` et ${formatDuration(rest.durationS)} de récupération à ${speed(rest.speedMs)} n'en rendent que ` +
        `${Math.round(rest.deltaM)} m, `
      : ', ';
  return (
    `chaque ${formatDuration(work.durationS)} à ${speed(work.speedMs)} en coûte ` +
    `${Math.round(-work.deltaM)} m${back}`
  );
}

/**
 * Ce que recharge chaque récupération, rapporté à ce que la répétition
 * précédente a coûté.
 *
 * C'est la seule lecture qui dise si une récupération fait son travail : sa
 * durée ne le dit pas. Quatre-vingt-dix secondes rendent tout après une
 * répétition au seuil et le quart après une répétition en PMA, et c'est ce
 * rapport-là qui décide du nombre de répétitions tenables.
 */
export function describeRecoveries(check: ReserveCheck): string[] {
  const out: string[] = [];
  const seen = new Set<number>();
  for (let i = 1; i < check.segments.length; i++) {
    const rest = check.segments[i] as ReserveSegment;
    const work = check.segments[i - 1] as ReserveSegment;
    if (rest.part !== 'recovery' || work.part !== 'work' || seen.has(rest.block)) continue;
    if (work.deltaM >= 0) continue;
    seen.add(rest.block);
    const spent = -work.deltaM;
    const share = Math.round((rest.deltaM / spent) * 100);
    out.push(
      `${formatDuration(rest.durationS)} de récupération à ${speed(rest.speedMs)} rechargent ` +
        `${Math.round(rest.deltaM)} m de réserve pour ${Math.round(spent)} m dépensés sur la répétition, ` +
        `soit ${share} %.`,
    );
  }
  return out;
}
