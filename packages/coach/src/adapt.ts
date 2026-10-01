import type {
  DeclaredAbsence, DecisionOrigin, IntervalPolicyDirective, PhysiologyModel, PlannedSession,
  SessionDecision,
} from '@cairn/core';
import * as db from '@cairn/db';
import { decimal, directivesFor, localDate, sessionDuration, writtenOn } from '@cairn/core';
import { ACWR_SPIKE } from '@cairn/physiology';
import { indexDirectives, isIntervalSession } from './directives.js';
import { descentReason, eccentricVerdicts, progressionReason, roundsLabel } from './eccentric.js';
import { addDays, mondayOf } from './periodization.js';
import { RECOVERY_MIN, isHardSession, isLongType } from './planner.js';
import { firstSentence, presentDecided, withHistory } from './presentation.js';
import {
  STRENGTH_INTENT, carriesEccentricStrength, easedLongRun, elevationGainOf, endurance, formatOf, isIntensityBlock,
  isMaximalTest, isPrescribed, recovery as decrassage, restDay, retitleFromContent, scaledRounds, sessionTotals,
  softenedQuality, totalDuration, transformSession, withoutEccentricStrength,
} from './sessionLibrary.js';
import { currentModel, type AthleteState } from './state.js';

/**
 * Ajustement automatique du plan.
 *
 * Les règles ci-dessous sont **déterministes et conservatrices**. Elles
 * s'exécutent après chaque nouvelle activité, avant toute intervention du
 * modèle de langage.
 *
 * Ce choix est délibéré : décharger, décaler ou annuler une séance sont des
 * décisions qui touchent au risque de blessure. Elles doivent être
 * reproductibles, explicables ligne à ligne et identiques d'un jour à l'autre
 * pour un même état. Le modèle de langage explique et propose ; il ne décide
 * pas seul de la charge.
 *
 * Les ajustements plus fins — changer la nature d'un bloc, réorganiser une
 * semaine autour d'un déplacement — passent, eux, par le chat, où l'athlète
 * valide.
 */

export interface Adjustment {
  sessionId: string;
  date: string;
  /**
   * `drop_strength` retire le renforcement excentrique de la séance, et laisse le reste.
   * `recover` fait de la séance le lendemain d'une séance clef — repos ou décrassage —,
   * au jour `newDate` quand il est donné. `free` libère un jour qui ne protège plus rien.
   * `soften` garde la forme d'une séance de qualité et en calme l'intensité ; `ease` la
   * fait courir facile, à durée égale ; `defer` la décale à `newDate` et laisse à sa
   * place un footing facile de même durée (`readinessAdjustment`).
   */
  action:
    | 'scale' | 'move' | 'swap' | 'mark_missed' | 'withdraw' | 'drop_strength' | 'recover' | 'free'
    | 'soften' | 'ease' | 'defer';
  /** Sur `defer` : le footing que la séance décalée remplace à `newDate`, retiré. */
  displaces?: string;
  /** Sur `ease` : la semaine fermée qui a arrêté le report — affûtage ou semaine de course. */
  heldBy?: WeekClosure;
  /** Sur `recover` : ce que la séance devient. */
  recovery?: 'rest' | 'recovery';
  /** Sur `recover` : le jour est vide, la séance s'écrit sous l'identifiant `sessionId`. */
  insert?: boolean;
  factor?: number;
  /** Facteur appliqué aux tours des circuits excentriques, sur `scale`. Absent : ils restent entiers. */
  eccentric?: number;
  /**
   * Facteur appliqué au nombre de répétitions, sur `scale`. Absent : c'est la
   * durée des répétitions qui suit le facteur.
   *
   * Il vaut pour les fractionnés, et pour eux seuls : leur format est prescrit
   * au dossier — 3 à 12 min pour le moyen, 30 s à 1 min pour le court — et un
   * allègement qui raccourcit les répétitions le quitte sans le dire.
   */
  repeats?: number;
  newDate?: string;
  /** Absence déclarée à l'origine du retrait, sur `withdraw`. */
  absenceId?: string;
  reason: string;
  /** Code de la règle déclenchée, pour l'auditabilité. */
  rule: string;
}

const dayMs = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const midnight = (date: string) => new Date(`${date}T00:00:00Z`).getTime();

/** Séances à forte contrainte excentrique. */
const ECCENTRIC_TYPES = new Set(['downhill', 'long_trail', 'long_run', 'race_pace']);

/** Une séance qui sollicite à nouveau l'excentrique : en descendant, ou par un circuit de renforcement. */
const carriesEccentric = (s: PlannedSession) =>
  ECCENTRIC_TYPES.has(s.type) || s.plannedMechanicalLoad >= 35 || carriesEccentricStrength(s.blocks);

/**
 * Ce qu'un allègement retire à un fractionné : des répétitions, jamais des
 * minutes de répétition.
 *
 * Le compte rendu prescrit le format, pas seulement le nombre. Allégée de 55 %,
 * une séance de 5 × 5 min au seuil voyait ses répétitions ramenées à 2 min 15 s
 * — hors de la plage 3-12 min, et sans que ni la séance ni le journal ne le
 * mentionnent. Ce qui cède, c'est le volume.
 */
function repetitionScaling(s: PlannedSession, factor: number): Pick<Adjustment, 'repeats'> {
  return isIntervalSession(s.type) ? { repeats: factor } : {};
}

/** Ce qu'un allègement retire aux répétitions d'une séance, en clair. */
function repsCut(s: PlannedSession, factor: number): string {
  if (!isIntervalSession(s.type)) return '';
  const cuts = s.blocks
    .map((b) => b.repeat)
    .filter((r): r is number => r != null && r > 1 && scaledRounds(r, factor) < r)
    .map((r) => `de ${r} à ${scaledRounds(r, factor)}`);
  return cuts.length
    ? `, répétitions ramenées ${cuts.join(' puis ')} — le format prescrit au dossier ne se raccourcit pas`
    : '';
}

/** Ce qu'un allègement excentrique retire aux circuits d'une séance, en clair. */
function roundsCut(s: PlannedSession, factor: number): string {
  const cuts = s.blocks
    .map((b) => b.circuit?.rounds)
    .filter((r): r is number => r != null && scaledRounds(r, factor) < r)
    .map((r) => `de ${r} à ${scaledRounds(r, factor)} tour${scaledRounds(r, factor) > 1 ? 's' : ''}`);
  return cuts.length ? `, et son circuit excentrique ramené ${cuts.join(' puis ')}` : '';
}

/** L'absence déclarée qui recouvre ce jour, s'il y en a une. Bornes incluses. */
export function absenceCovering(
  absences: DeclaredAbsence[],
  date: string,
): DeclaredAbsence | undefined {
  return absences.find((a) => a.startDate <= date && date <= a.endDate);
}

const KIND_FR: Record<DeclaredAbsence['kind'], string> = {
  chosen: 'coupure',
  illness: 'maladie',
  injury: 'blessure',
  unavailable: 'indisponibilité',
};

/**
 * Statuts qu'une absence peut retirer.
 *
 * `missed` en fait partie : une séance déjà marquée manquée sur une période
 * ensuite déclarée absente a été comptée comme une faute qui n'a pas eu lieu.
 * L'absence répare le registre au lieu de le laisser mentir. Ce qui a
 * réellement eu lieu — `completed`, `partial`, `replaced` — n'est jamais
 * touché : une séance faite pendant une coupure reste une séance faite.
 */
const WITHDRAWABLE = new Set(['planned', 'missed']);

/**
 * Ce qu'une absence déclarée impose au plan : retirer les séances qu'elle
 * recouvre. Ni à faire, ni manquées.
 *
 * Une seule implémentation, appelée par l'ajustement automatique comme par
 * l'outil du coach : le plan ne peut pas répondre deux choses différentes à la
 * même absence selon la porte par laquelle elle est entrée.
 */
export function withdrawalsFor(
  absence: DeclaredAbsence,
  sessions: PlannedSession[],
): Adjustment[] {
  return sessions
    .filter(
      (s) =>
        s.date >= absence.startDate &&
        s.date <= absence.endDate &&
        // Un jour de repos n'est pas une séance à retirer : il n'y avait rien à faire.
        s.type !== 'rest' &&
        WITHDRAWABLE.has(s.status),
    )
    .map((s) => ({
      sessionId: s.id,
      date: s.date,
      action: 'withdraw' as const,
      absenceId: absence.id,
      rule: 'declared_absence',
      reason:
        `Séance retirée du plan, ni à faire ni manquée : tu as déclaré ${KIND_FR[absence.kind]} ` +
        `du ${writtenOn(absence.startDate)} au ${writtenOn(absence.endDate)}. Tes mots : « ${absence.reason} »`,
    }));
}

const dayMonth = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

/** Le pire des cinq crans du point du jour : fatigue « vidé », courbatures « sévères ». */
const WORST = 5;

/** Ce qu'une séance peut devenir au lendemain d'une séance clef, et ce qui protège une date. */
const EASY_TYPES = new Set(['rest', 'recovery', 'endurance']);
const PROTECTIVE_TYPES = new Set(['rest', 'recovery']);

/** Une séance que les règles peuvent réécrire : personne d'autre ne l'a décidée. */
const rulesMay = (s: PlannedSession) => !s.decision || s.decision.by === 'rules';
const live = (s: PlannedSession) => s.status !== 'cancelled' && s.status !== 'withdrawn';

/** Ce qui allège une séance : ce qu'une même règle ne fait qu'une fois. */
const LIGHTENING: ReadonlySet<Adjustment['action']> = new Set(['scale', 'drop_strength', 'soften', 'ease', 'defer']);

/**
 * La règle a-t-elle déjà allégé cette séance ?
 *
 * Les règles se réévaluent à chaque sortie, à chaque point du jour : tant que le
 * signal durait, elles réallégeaient la même séance — 0,75 × 0,75 sur un pic de
 * charge. Une descente ramenée à 45 % pour une disponibilité rouge restait
 * au-dessus des 40 points de la règle, ses remontées à pied ne raccourcissant
 * pas, et un second point du jour au rouge l'allégeait encore. Le signal a été
 * pris en compte une fois ; la séance le porte.
 */
const lightenedBy = (s: PlannedSession | undefined, rule: string): boolean =>
  s?.lightenings?.some((l) => l.rule === rule) ?? false;

/**
 * Ce que la règle pose au lendemain d'une séance clef réalisée, et pourquoi.
 *
 * C'est la règle du planificateur : repos ou décrassage. Après une sortie
 * longue, le repos, là où il vaut le plus ; après une autre séance clef, le
 * décrassage. Après un test maximal, le décrassage aussi — il soulage les
 * courbatures et ajoute du volume facile —, et le repos ne l'emporte que le
 * jour même (`day`), sur une disponibilité rouge ou un point du jour « vidé » ou
 * « courbatures sévères ». La veille, personne ne sait ce que le corps dira.
 */
function aftermathOf(
  k: PlannedSession,
  test: boolean,
  day: Pick<AthleteState, 'readiness' | 'todayCheckIn'> | null,
): { kind: 'rest' | 'recovery'; reason: string } {
  const realized = dayMonth(k.date);
  const planned = k.plannedDate && k.plannedDate !== k.date ? dayMonth(k.plannedDate) : null;
  if (test) {
    const who = `Test maximal ${planned ? `prévu le ${planned}, couru le ${realized}` : `couru le ${realized}`}`;
    const signal = !day
      ? null
      : day.readiness.verdict === 'red'
        ? `la disponibilité est rouge (${day.readiness.score}/100)`
        : day.todayCheckIn?.fatigue === WORST
          ? 'le point du jour dit « vidé »'
          : day.todayCheckIn?.soreness === WORST
            ? 'le point du jour dit « courbatures sévères »'
            : null;
    return signal
      ? { kind: 'rest', reason: `${who}, et ${signal} : son lendemain est un repos complet plutôt qu'un décrassage.` }
      : {
          kind: 'recovery',
          reason:
            `${who} : son lendemain est un décrassage, qui soulage les courbatures et ajoute du volume facile. ` +
            `Le repos ne l'emporte que sur une disponibilité rouge, ou un point du jour « vidé » ou « courbatures sévères ».`,
        };
  }
  const who = `Séance clef « ${formatOf(k.title)} » prévue le ${planned ?? realized}, réalisée le ${realized}`;
  return isLongType(k.type)
    ? { kind: 'rest', reason: `${who} : son lendemain est un repos complet, le jour où il vaut le plus.` }
    : {
        kind: 'recovery',
        reason: `${who} : son lendemain est un décrassage, on facilite la récupération sans ajouter de charge.`,
      };
}

/**
 * Les voisines d'une séance clef réalisée, réévaluées sans reconstruction.
 *
 * Le test maximal prévu le 22/09 a été couru le 21/09. Le rattachement l'a
 * reconnu et a libéré le 22/09 ; restaient le 22/09 vide et le 23/09 en
 * « Repos complet », posé comme lendemain du test à son ancienne date.
 * Personne n'avait décidé ces deux jours de repos.
 *
 * Réalisée un autre jour que prévu, une séance clef emporte ses voisines :
 *  · son lendemain réel reçoit ce que la règle pose après elle (`aftermathOf`)
 *    — sur la séance facile qui l'occupe ; jour vide, sur la protection de
 *    l'ancienne date, qui suit la séance à son nouveau lendemain ; à défaut,
 *    sur une séance écrite pour lui ;
 *  · ce qui protégeait l'ancienne date — son lendemain, et sa veille pour un
 *    test — est libéré, à moins de protéger encore autre chose.
 * Un test maximal couru à sa date n'a que son lendemain à réévaluer.
 *
 * Seuls bougent les jours à venir, les séances que personne d'autre que les
 * règles n'a décidées, et les jours que l'athlète a déclarés disponibles. Un
 * lendemain qui porte une séance exigeante, décidée ou déjà faite reste tel
 * quel.
 */
export function afterKeySessions(state: AthleteState, upcoming: readonly PlannedSession[]): Adjustment[] {
  const today = state.today.date;
  const model = state.model;
  // La séance clef se lit aussi dans le plan entier : le point du jour ne passe
  // aux règles que ce qui vient, et elle a pu être courue la veille.
  const known = new Map<string, PlannedSession>();
  for (const s of [...(state.plan?.weeks.flatMap((w) => w.sessions) ?? []), ...upcoming]) known.set(s.id, s);
  const all = [...known.values()].filter(live);
  const available = new Set(state.profile?.constraints.availableDays ?? [0, 1, 2, 3, 4, 5, 6]);
  const isAvailable = (date: string) => available.has(new Date(`${date}T00:00:00Z`).getUTCDay());
  // Un jour protège encore s'il est le lendemain d'une autre séance exigeante,
  // ou la veille d'un autre test.
  const stillGuards = (date: string, k: PlannedSession) =>
    all.some(
      (x) =>
        x.id !== k.id &&
        ((x.date === addDays(date, -1) && isHardSession(x, model)) ||
          (x.date === addDays(date, 1) && isMaximalTest(x, model))),
    );

  const out: Adjustment[] = [];
  for (const k of all) {
    if (k.priority !== 'key' || k.status !== 'completed' || !isHardSession(k, model)) continue;
    const test = isMaximalTest(k, model);
    const moved = k.plannedDate != null && k.plannedDate !== k.date;
    if (!moved && !test) continue;

    const after = addDays(k.date, 1);
    // Le lendemain de l'ancienne date en premier : c'est lui qui suit la séance.
    const guards = moved ? [addDays(k.plannedDate!, 1), ...(test ? [addDays(k.plannedDate!, -1)] : [])] : [];
    const freed = guards.flatMap((date) =>
      upcoming.filter(
        (s) =>
          s.date === date && date !== after && date >= today && s.status === 'planned' &&
          PROTECTIVE_TYPES.has(s.type) && rulesMay(s) && !stillGuards(date, k),
      ),
    );

    if (after >= today && isAvailable(after) && !absenceCovering(state.absences, after)) {
      const want = aftermathOf(k, test, after === today ? state : null);
      const day = upcoming.filter((s) => s.date === after && live(s));
      const easy = day.filter((s) => s.status === 'planned' && EASY_TYPES.has(s.type) && rulesMay(s));
      if (easy.length === day.length) {
        const recover = {
          date: after, action: 'recover' as const, recovery: want.kind, rule: 'day_after_key', reason: want.reason,
        };
        const [here] = easy;
        if (here) {
          if (here.type !== want.kind) out.push({ ...recover, sessionId: here.id });
        } else if (freed.length > 0) {
          const source = freed.shift()!;
          out.push({
            ...recover,
            sessionId: source.id,
            date: source.date,
            newDate: after,
            reason:
              `${want.reason} ${source.type === 'rest' ? 'Le repos' : 'Le décrassage'} posé le ` +
              `${dayMonth(source.date)} pour protéger l'ancienne date passe au ${dayMonth(after)}.`,
          });
        } else {
          out.push({ ...recover, sessionId: `${k.id}-lendemain`, insert: true });
        }
      }
    }

    for (const s of freed) {
      out.push({
        sessionId: s.id,
        date: s.date,
        action: 'free',
        rule: 'protection_freed',
        reason:
          `Libéré : la séance « ${formatOf(k.title)} », prévue le ${dayMonth(k.plannedDate!)}, a été réalisée le ` +
          `${dayMonth(k.date)} — ${s.type === 'rest' ? 'ce repos' : 'ce décrassage'} ne protège plus rien.`,
      });
    }
  }
  return out;
}

/**
 * Le contenu d'un lendemain de séance clef : le repos complet, ou le décrassage
 * du planificateur. Un décrassage qui ne fait que suivre la séance à son
 * nouveau lendemain garde le sien, souplesse et respiration comprises.
 */
function recoveryContent(kind: 'rest' | 'recovery', from: PlannedSession | undefined, model: PhysiologyModel) {
  if (kind === 'recovery' && from?.type === 'recovery') {
    const { type, title, intent, priority, blocks, plannedLoad, plannedMechanicalLoad, plannedDurationS } = from;
    return {
      type, title, intent, priority, blocks, plannedLoad, plannedMechanicalLoad, plannedDurationS,
      plannedElevationGainM: from.plannedElevationGainM, plannedDistanceM: from.plannedDistanceM,
      directives: from.directives, successCriteria: from.successCriteria,
    };
  }
  const t = kind === 'rest' ? restDay() : decrassage(model, RECOVERY_MIN);
  return {
    type: t.type, title: t.title, intent: t.intent, priority: t.priority, blocks: t.blocks,
    plannedLoad: t.plannedLoad, plannedMechanicalLoad: t.plannedMechanicalLoad, plannedDurationS: t.durationS,
    plannedElevationGainM: t.elevationGainM, plannedDistanceM: t.plannedDistanceM,
    directives: undefined, successCriteria: undefined,
  };
}

/**
 * Une séance de qualité : fractionné, seuil, allure spécifique, descente, test —
 * ou une sortie longue qui porte un bloc d'intensité. Sans lui, une sortie
 * longue est du volume facile, et un footing n'est jamais une séance de qualité.
 */
export function isQualitySession(s: Pick<PlannedSession, 'type' | 'blocks'>, model: PhysiologyModel): boolean {
  if (EASY_TYPES.has(s.type) || s.type === 'race') return false;
  if (isLongType(s.type)) return s.blocks.some(isIntensityBlock);
  return isHardSession(s, model);
}

/** Ce qui ferme une semaine à toute séance de qualité venue d'ailleurs. */
export type WeekClosure = 'taper' | 'race';

const CLOSURE_FR: Record<WeekClosure, string> = { taper: "l'affûtage", race: 'la semaine de course' };

/**
 * Une semaine fermée à toute séance de qualité venue d'ailleurs : l'affûtage
 * et la semaine de course gardent leurs propres séances d'intensité, et n'en
 * accueillent pas d'autres. La semaine de course se lit à sa course, quelle que
 * soit la phase que le plan lui donne.
 */
function weekClosure(
  state: Pick<AthleteState, 'plan'>,
  sessions: readonly PlannedSession[],
  date: string,
): WeekClosure | null {
  const week = mondayOf(date);
  const weeks = state.plan?.weeks ?? [];
  const phase = weeks.find((w) => w.weekStart === week)?.phase;
  if (phase === 'taper' || phase === 'race') return 'taper';
  const all = [...weeks.flatMap((w) => w.sessions), ...sessions];
  return all.some((s) => s.type === 'race' && live(s) && mondayOf(s.date) === week) ? 'race' : null;
}

/** Jusqu'où une séance de qualité décalée par la disponibilité cherche son jour. */
const DEFER_WINDOW_DAYS = 7;

/**
 * Ce que la disponibilité du jour fait à la séance de qualité du jour ou du
 * lendemain.
 *
 * Les protocoles d'entraînement guidé par l'état du jour ajustent l'intensité
 * des séances dures, et laissent les footings tels quels :
 *  · vert, rien ne change ;
 *  · vigilance, la séance garde sa forme : ses cibles se calent sur le bas de
 *    leur fourchette, et sa dernière répétition devient facultative — ou son
 *    bloc d'intensité continu perd d'autant (`softenedQuality`). Un test
 *    maximal n'a ni fourchette à baisser ni répétition à retirer : il reste ;
 *  · rouge, la séance se court facile, à durée égale, et la qualité passe au
 *    premier jour libre — vide, ou qu'un footing posé par les règles occupe —
 *    sans séance exigeante la veille ni le lendemain, et dans une semaine qui
 *    peut encore porter un fractionné. Sans jour libre dans la semaine, elle
 *    n'est pas reprogrammée, et le motif le dit. Une sortie longue ne se
 *    décale pas : c'est son bloc d'intensité qui se court facile.
 *
 * Une séance facile n'est jamais touchée. La règle ne décide rien d'autre que ce
 * qui précède, et le même niveau ne s'applique qu'une fois à une séance
 * (`lightenedBy`) : un second point du jour au rouge ne décale pas deux fois.
 */
export function readinessAdjustment(
  state: AthleteState,
  upcoming: readonly PlannedSession[],
): Adjustment | null {
  const { verdict, score } = state.readiness;
  if (verdict === 'green') return null;
  const today = state.today.date;
  const model = state.model;
  const tomorrow = addDays(today, 1);
  const quality = upcoming
    .filter(
      (s) =>
        s.date >= today && s.date <= tomorrow && (s.status === 'planned' || s.status === 'moved') &&
        !absenceCovering(state.absences, s.date) && isQualitySession(s, model),
    )
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  if (!quality) return null;
  const name = `« ${formatOf(quality.title)} »`;
  const base = { sessionId: quality.id, date: quality.date };

  // Un test maximal ne se court pas fatigué : à l'orange, il se décale comme au rouge.
  const test = isMaximalTest(quality, model);
  if (verdict === 'amber' && !test) {
    const soft = softenedQuality(quality.blocks);
    const parts = [
      ...(soft.lowered ? ['ses cibles se calent sur le bas de leur fourchette'] : []),
      ...(soft.lastOptional ? ['sa dernière répétition devient facultative'] : []),
      ...(soft.shortened
        ? [
            `son bloc d'intensité passe de ${sessionDuration(soft.shortened.fromS)} à ` +
              `${sessionDuration(soft.shortened.toS)}, le reste couru facile`,
          ]
        : []),
    ];
    if (parts.length === 0) return null;
    return {
      ...base,
      action: 'soften',
      rule: 'readiness_amber',
      reason:
        `Disponibilité en vigilance (${score}/100) : ${name} garde sa forme, ${joined(parts)}. ` +
        `Un jour de vigilance ajuste l'intensité des séances dures, jamais les footings.`,
    };
  }

  const rule = verdict === 'red' ? 'readiness_red' : 'readiness_amber';
  const signal = verdict === 'red' ? `Disponibilité au rouge (${score}/100)` : `Disponibilité en vigilance (${score}/100)`;
  if (isLongType(quality.type)) {
    return {
      ...base,
      action: 'ease',
      rule,
      reason:
        `${signal} : le bloc d'intensité de ${name} se court facile, à durée égale — la sortie garde ses ` +
        `${sessionDuration(quality.plannedDurationS)} et son dénivelé.`,
    };
  }
  const easy = `${sessionDuration(quality.plannedDurationS)} de footing facile à la place de ${name}`;
  const why = test
    ? ` Un test maximal couru fatigué mesure la fatigue, pas la capacité : la vitesse critique qu'il nourrit en ` +
      `sortirait sous-estimée, et toutes les allures avec elle.`
    : '';
  const day = freeDayFor(state, upcoming, quality);
  if (!day || 'heldBy' in day) {
    return {
      ...base,
      action: 'ease',
      rule,
      ...(day ? { heldBy: day.heldBy } : {}),
      reason: day
        ? `${signal} : ${easy}, sans report : à partir du ${dayMonth(day.from)}, ${CLOSURE_FR[day.heldBy]} garde ` +
          `ses propres séances d'intensité et n'en accueille pas d'autres.${why}`
        : `${signal} : ${easy}. Aucun jour d'ici le ${dayMonth(addDays(quality.date, DEFER_WINDOW_DAYS))} ne la ` +
          `loge sans séance exigeante la veille ou le lendemain : elle n'est pas reprogrammée.${why}`,
    };
  }
  return {
    ...base,
    action: 'defer',
    rule,
    newDate: day.date,
    ...(day.displaces ? { displaces: day.displaces } : {}),
    reason:
      `${signal} : ${easy}, qui passe au ${dayMonth(day.date)} — le premier jour libre sans séance exigeante ` +
      `la veille ni le lendemain.${day.displaces ? " Le footing qui l'occupait est retiré." : ''}${why}`,
  };
}

const joined = (parts: string[]) =>
  parts.length <= 1 ? parts.join('') : `${parts.slice(0, -1).join(', ')} et ${parts.at(-1)}`;

/**
 * Le premier jour où loger une séance de qualité décalée : disponible, hors
 * absence, vide ou occupé par un seul footing que les règles ont posé et qui ne
 * porte rien du dossier, sans
 * séance exigeante la veille ni le lendemain, et dans une semaine qui peut
 * encore porter le fractionné qu'elle est.
 */
function freeDayFor(
  state: AthleteState,
  upcoming: readonly PlannedSession[],
  quality: PlannedSession,
): { date: string; displaces?: string } | { heldBy: WeekClosure; from: string } | null {
  const model = state.model;
  const known = new Map<string, PlannedSession>();
  for (const s of [...(state.plan?.weeks.flatMap((w) => w.sessions) ?? []), ...upcoming]) known.set(s.id, s);
  const all = [...known.values()].filter((s) => live(s) && s.id !== quality.id);
  const available = new Set(state.profile?.constraints.availableDays ?? [0, 1, 2, 3, 4, 5, 6]);
  const perWeek = intervalPolicy(state)?.maxPerWeek ?? Infinity;

  for (let d = 1; d <= DEFER_WINDOW_DAYS; d++) {
    const date = addDays(quality.date, d);
    // Le report s'arrête à la première semaine fermée : les suivantes mènent à la course.
    const closure = weekClosure(state, upcoming, date);
    if (closure) return { heldBy: closure, from: date };
    if (!available.has(new Date(`${date}T00:00:00Z`).getUTCDay()) || absenceCovering(state.absences, date)) continue;
    const there = all.filter((s) => s.date === date);
    // Un footing qui porte la souplesse ou la respiration du dossier ne se retire
    // pas : sa fréquence hebdomadaire est prescrite.
    const footing = (s: PlannedSession) =>
      s.status === 'planned' && (s.type === 'endurance' || s.type === 'recovery') && rulesMay(s) &&
      !s.blocks.some(isPrescribed);
    if (there.length > 1 || !there.every(footing)) continue;
    const near = [addDays(date, -1), addDays(date, 1)];
    if (all.some((s) => near.includes(s.date) && isHardSession(s, model))) continue;
    if (
      // Un test maximal n'est pas un fractionné, quel que soit son type.
      isIntervalSession(quality.type) && !isMaximalTest(quality, model) && Number.isFinite(perWeek) &&
      all.filter((s) => isIntervalSession(s.type) && mondayOf(s.date) === mondayOf(date)).length >= perWeek
    ) {
      continue;
    }
    return { date, ...(there[0] ? { displaces: there[0].id } : {}) };
  }
  return null;
}

/**
 * Une séance facile de même durée, à la place d'une séance de qualité un jour
 * rouge — à la seconde près : la maille de cinq minutes du footing en ferait
 * une séance plus longue que celle qu'elle remplace.
 */
function easyContent(model: PhysiologyModel, durationS: number) {
  const t = endurance(model, Math.max(1, Math.round(durationS / 60)));
  const blocks = t.blocks.map((b, i) => (i === 0 ? { ...b, durationS } : b));
  const totals = sessionTotals(model, blocks);
  return {
    type: t.type, title: t.title, intent: t.intent, priority: t.priority, blocks,
    plannedLoad: totals.load, plannedMechanicalLoad: totals.mechanicalLoad, plannedDurationS: totals.durationS,
    plannedElevationGainM: t.elevationGainM, plannedDistanceM: Math.round(totals.distanceM),
    directives: undefined, successCriteria: undefined,
  };
}

export function evaluateAdjustments(
  state: AthleteState,
  upcoming: PlannedSession[],
): Adjustment[] {
  const out: Adjustment[] = [];
  // Le jour de référence vient de l'état évalué, jamais de l'horloge. Sans cela
  // les règles changent de verdict à minuit sur un état identique — ce que la
  // promesse d'auditabilité ci-dessus interdit, et ce qu'aucun test ne peut
  // fixer dans le temps.
  const today = state.today.date;
  const daysUntil = (date: string) => Math.round((midnight(date) - midnight(today)) / dayMs);
  const seen = new Set<string>();
  const byId = new Map(upcoming.map((s) => [s.id, s]));

  const push = (adj: Adjustment) => {
    // Une seule règle par séance : la première déclenchée, la plus protectrice.
    if (seen.has(adj.sessionId)) return;
    // Et une règle n'allège qu'une fois une même séance : ce qu'elle a déjà
    // allégé ne l'est pas deux fois, et laisse passer la règle suivante.
    if (LIGHTENING.has(adj.action) && lightenedBy(byId.get(adj.sessionId), adj.rule)) return;
    seen.add(adj.sessionId);
    out.push(adj);
  };

  // ── Règle 0 : périodes d'absence déclarées ────────────────────────────────
  // Elle passe avant tout le reste, et notamment avant `missed_session` : une
  // séance qu'une absence recouvre ne doit jamais être jugée par une autre
  // règle, puisqu'elle n'était plus au programme.
  const absences = state.absences;
  for (const absence of absences) {
    for (const adj of withdrawalsFor(absence, upcoming)) push(adj);
  }

  // ── Règle 1 : séances passées jamais réalisées ────────────────────────────
  for (const s of upcoming) {
    if (s.date < today && s.status === 'planned' && s.type !== 'rest') {
      push({
        sessionId: s.id,
        date: s.date,
        action: 'mark_missed',
        rule: 'missed_session',
        reason: `Séance du ${s.date} non réalisée : statut passé à « manquée » pour que le suivi de charge reste honnête.`,
      });
    }
  }

  // ── Règle 1 ter : le lendemain d'une séance clef réalisée ────────────────
  // Réalisée un autre jour que prévu, une séance clef emporte ses voisines :
  // son lendemain réel reçoit ce que le planificateur pose après elle, et ce
  // qui protégeait l'ancienne date est libéré. Rien n'est reconstruit. Après un
  // test maximal, le décrassage est le choix par défaut, test couru à sa date
  // ou non ; le repos ne l'emporte que le jour même, sur ce que le corps dit.
  for (const adj of afterKeySessions(state, upcoming)) push(adj);

  // Les jours d'absence sortent du plan pour toutes les règles suivantes : une
  // séance retirée n'a pas à être allégée, ni à décaler celle qui la suit.
  const future = upcoming.filter(
    (s) =>
      s.date >= today &&
      s.status === 'planned' &&
      s.type !== 'rest' &&
      !absenceCovering(absences, s.date),
  );

  // ── Règle 1 bis : renforcement excentrique ────────────────────────────────
  // Les deux règles du planificateur (`eccentric.ts`), sur le plan tel qu'il
  // est devenu — une séance déplacée, un circuit réécrit par le coach, un
  // circuit manqué qui décale la progression : aucun circuit dans les 48 h qui
  // précèdent une séance qui descend, et un athlète sans historique commence à
  // un tour. Elles passent avant les règles de fatigue, qui allègent ce qui se
  // court et laissent le circuit entier. Elles jugent la semaine qui vient ; au
  // delà, le plan peut encore bouger.
  const ahead = upcoming.filter(
    (s) => s.date >= today && (s.status === 'planned' || s.status === 'moved') && !absenceCovering(absences, s.date),
  );
  for (const v of eccentricVerdicts(ahead, state.eccentricCircuitsDone ?? 0, today)) {
    if (daysUntil(v.session.date) > 7) continue;
    if (v.before) {
      push({
        sessionId: v.session.id,
        date: v.session.date,
        action: 'drop_strength',
        rule: 'eccentric_before_descent',
        reason: `Renforcement excentrique retiré : ${descentReason(v.before)} Le reste de la séance est maintenu.`,
      });
    } else if (v.prescribed > v.allowed) {
      push({
        sessionId: v.session.id,
        date: v.session.date,
        action: 'scale',
        factor: 1,
        eccentric: v.allowed / v.prescribed,
        rule: 'eccentric_progression',
        reason: `Circuit ramené de ${v.prescribed} à ${roundsLabel(v.allowed)} : ${progressionReason(v.rank)}`,
      });
    }
  }

  // ── Règle 2 : disponibilité au rouge ──────────────────────────────────────
  // Elle passe avant les règles de fatigue : courir facile protège plus qu'un
  // allègement d'un quart, et une séance n'en reçoit qu'une.
  const readiness = readinessAdjustment(state, upcoming);
  if (readiness?.rule === 'readiness_red') push(readiness);

  // ── Règle 2 bis : fatigue musculaire excentrique ──────────────────────────
  // La charge mécanique récupère plus lentement que la métabolique : on protège
  // spécifiquement les séances qui la sollicitent à nouveau.
  if (state.today.mechanicalTsb < -22) {
    for (const s of future) {
      const d = daysUntil(s.date);
      if (d > 3) continue;
      if (!ECCENTRIC_TYPES.has(s.type) && s.plannedMechanicalLoad < 35) continue;
      push({
        sessionId: s.id,
        date: s.date,
        action: 'scale',
        factor: 0.6,
        ...repetitionScaling(s, 0.6),
        rule: 'mechanical_fatigue',
        reason:
          `Séance allégée de 40 %${repsCut(s, 0.6)} : tes jambes n'ont pas fini de réparer les dégâts ` +
          `de la dernière descente — leur fraîcheur est à ${decimal(state.today.mechanicalTsb, 0)}, et c'est ` +
          `sous −22 qu'on cesse d'empiler du freinage.`,
      });
    }
  }

  // ── Règle 3 : pic de charge excentrique ───────────────────────────────────
  // Le ratio de la filière mécanique, circuits de renforcement faits compris,
  // contre son propre seuil (`ACWR_SPIKE`). Elle passe avant le pic
  // métabolique : pour une séance qui descend ou qui porte un circuit, elle
  // allège autant, et retire en plus des tours — sans quoi un palier
  // excentrique, la charge même qui s'emballe, restait intact.
  if (state.today.mechanicalAcwr > ACWR_SPIKE.mechanical) {
    const factor = 0.75;
    for (const s of future.filter((x) => daysUntil(x.date) <= 5 && x.priority !== 'key' && carriesEccentric(x))) {
      push({
        sessionId: s.id,
        date: s.date,
        action: 'scale',
        factor,
        eccentric: factor,
        ...repetitionScaling(s, factor),
        rule: 'mechanical_acwr_spike',
        reason:
          `Séance allégée de 25 %${roundsCut(s, factor)}${repsCut(s, factor)} : ces sept derniers jours, tu as ` +
          `freiné en descente ${decimal(state.today.mechanicalAcwr, 2)} fois ce que tes quatre dernières semaines ` +
          `t'ont préparé à encaisser — au-delà de ${decimal(ACWR_SPIKE.mechanical, 1)}, les tissus lâchent avant les jambes.`,
      });
    }
  }

  // ── Règle 3 bis : pic de charge métabolique ───────────────────────────────
  if (state.today.acwr > ACWR_SPIKE.metabolic) {
    for (const s of future.filter((x) => daysUntil(x.date) <= 5 && x.priority !== 'key')) {
      push({
        sessionId: s.id,
        date: s.date,
        action: 'scale',
        factor: 0.75,
        ...repetitionScaling(s, 0.75),
        rule: 'acwr_spike',
        reason:
          `Séances secondaires des cinq prochains jours allégées de 25 %${repsCut(s, 0.75)} : ces sept derniers ` +
          `jours, tu as couru ${decimal(state.today.acwr, 2)} fois ce que tes quatre dernières semaines t'ont ` +
          `préparé à encaisser — au-delà de 1,5, le risque de blessure augmente nettement.`,
      });
    }
  }

  // ── Règle 4 : disponibilité en vigilance ──────────────────────────────────
  // Après les règles de charge : un allègement d'un quart protège davantage que
  // des cibles au bas de leur fourchette.
  if (readiness?.rule === 'readiness_amber') push(readiness);

  // ── Règle 5 : progression de charge trop rapide ───────────────────────────
  if (state.today.rampRate > 8) {
    for (const s of future.filter((x) => daysUntil(x.date) <= 7 && x.priority === 'optional')) {
      push({
        sessionId: s.id,
        date: s.date,
        action: 'scale',
        factor: 0.7,
        ...repetitionScaling(s, 0.7),
        rule: 'ramp_too_fast',
        reason:
          `Séances facultatives allégées le temps que ton corps suive${repsCut(s, 0.7)} : ta forme de fond monte de ` +
          `${decimal(state.today.rampRate)} points par semaine, au-dessus des 8 qu'on s'autorise — ` +
          `au-delà, c'est le tendon qui encaisse la progression.`,
      });
    }
  }

  // ── Règle 6 : espacement des séances de qualité ───────────────────────────
  // Deux séances exigeantes à moins de 48 h : la seconde est repoussée. Le jour
  // retenu respecte en plus la politique du dossier — un seul fractionné par
  // semaine —, sans quoi décaler d'un dimanche au lundi suivant en logeait deux
  // dans la même semaine, et rien ne l'aurait dit.
  const policy = intervalPolicy(state);
  const keySessions = future.filter((s) => s.priority === 'key').sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < keySessions.length; i++) {
    const prev = keySessions[i - 1]!;
    const cur = keySessions[i]!;
    const gap = Math.round(
      (new Date(`${cur.date}T00:00:00Z`).getTime() - new Date(`${prev.date}T00:00:00Z`).getTime()) / dayMs,
    );
    if (gap < 2) {
      const moved = freeDateFor(cur, prev.date, future, policy);
      push({
        sessionId: cur.id,
        date: cur.date,
        action: 'move',
        newDate: moved.date,
        rule: 'quality_spacing',
        reason:
          `Deux séances clefs séparées de ${gap} jour(s). Un stimulus intense demande 48 h pour être assimilé : ` +
          `la seconde est décalée.${moved.note}`,
      });
    }
  }

  return out;
}

/** La politique de fractionné du dossier, quand l'athlète en a une. */
function intervalPolicy(state: AthleteState): IntervalPolicyDirective | undefined {
  return state.profile ? indexDirectives(directivesFor(state.profile)).intervals : undefined;
}

/**
 * Le jour où décaler une séance clef : 48 h après la précédente, et pas dans une
 * semaine qui porte déjà le fractionné qu'elle a le droit de porter.
 *
 * Quand aucun jour de la semaine suivante ne convient, le décalage a lieu quand
 * même — l'espacement protège du risque de blessure, l'alternance ne fait
 * qu'organiser la charge — et la phrase dit ce que la semaine porte alors.
 */
function freeDateFor(
  session: PlannedSession,
  after: string,
  future: readonly PlannedSession[],
  policy: IntervalPolicyDirective | undefined,
): { date: string; note: string } {
  const earliest = iso(new Date(midnight(after) + 2 * dayMs));
  const perWeek = policy?.maxPerWeek ?? Infinity;
  if (!isIntervalSession(session.type) || !Number.isFinite(perWeek)) return { date: earliest, note: '' };

  const others = future.filter((s) => s.id !== session.id && isIntervalSession(s.type));
  const carried = (week: string) => others.filter((s) => mondayOf(s.date) === week).length;

  for (let d = 0; d <= 6; d++) {
    const date = iso(new Date(midnight(earliest) + d * dayMs));
    if (carried(mondayOf(date)) < perWeek) {
      return {
        date,
        note:
          d === 0
            ? ''
            : ` Reporté de ${d} jour(s) de plus : le dossier n'autorise qu'un fractionné par semaine, ` +
              `et la semaine du ${mondayOf(earliest)} porte déjà le sien.`,
      };
    }
  }
  return {
    date: earliest,
    note:
      ` ⚠ La semaine du ${mondayOf(earliest)} portera deux fractionnés, ce que le dossier n'autorise pas : ` +
      `aucun jour des sept suivants n'en était libre.`,
  };
}

/** Applique les ajustements et journalise la révision du plan. */
export async function applyAdjustments(
  athleteId: string,
  adjustments: Adjustment[],
  trigger: 'new_activity' | 'readiness' | 'missed_session' | 'declared_absence' = 'new_activity',
  origin: DecisionOrigin = 'rules',
): Promise<number> {
  if (adjustments.length === 0) return 0;

  // La fenêtre de relecture vient des ajustements eux-mêmes, pas de l'horloge :
  // une absence déclarée après coup peut recouvrir des séances plus anciennes
  // que n'importe quelle fenêtre fixe, et elles seraient silencieusement
  // ignorées.
  // Une séance décalée remplace le footing de son nouveau jour : lui aussi se relit.
  const dates = adjustments.flatMap((a) => (a.newDate ? [a.date, a.newDate] : [a.date])).sort();
  const all = await db.listPlannedSessions(athleteId, dates[0]!, dates[dates.length - 1]!);
  const byId = new Map(all.map((s) => [s.id, s]));
  // Les courbes de l'athlète ne servent qu'à l'allègement : on ne va les
  // chercher que s'il y en a un.
  let model: PhysiologyModel | undefined;

  // Un ajustement est une décision de charge : elle reste sur la séance, et
  // une reconstruction la reprendra au lieu de l'écraser.
  const at = new Date().toISOString();
  const decided = (summary: string): SessionDecision => ({ at, by: origin, summary });
  // Le « pourquoi » d'une séance tient en une phrase : celle qui nomme le signal.
  // Le motif entier — diagnostic, action, ce qui a dû céder — rejoint son
  // historique, daté.
  const told = (session: PlannedSession, text: string) => ({
    rationale: firstSentence(text),
    history: withHistory(session.history, { at, by: origin, text }),
  });
  // Ce que pèsent les blocs qu'on enregistre : ceux que la présentation écrit,
  // mesurés avec le modèle du jour.
  const measuredOf = (p: PlannedSession) => ({
    plannedLoad: p.plannedLoad,
    plannedMechanicalLoad: p.plannedMechanicalLoad,
    ...(p.plannedDistanceM != null ? { plannedDistanceM: p.plannedDistanceM } : {}),
  });
  // Un allègement garde la trace de sa règle et de son jour : c'est ce qui
  // empêche la même règle de l'alléger une seconde fois (`lightenedBy`).
  const traced = (session: PlannedSession, rule: string) => ({
    lightenings: [...(session.lightenings ?? []), { rule, on: localDate(at) }],
  });

  const plan = await db.getActivePlan(athleteId);
  // Une séance qui change de semaine prend la phase de celle qui l'accueille.
  const weekOf = (date: string) => {
    const weekStart = mondayOf(date);
    const weeks = plan?.weeks ?? [];
    const phase = weeks.filter((w) => w.weekStart <= weekStart).at(-1)?.phase ?? weeks[0]?.phase ?? 'base';
    return { weekStart, phase };
  };

  for (const adj of adjustments) {
    const session = byId.get(adj.sessionId);

    // Un lendemain de séance clef resté vide, sans protection à y déplacer : la
    // séance s'écrit.
    if (adj.action === 'recover' && adj.insert) {
      if (!plan || session) continue;
      model ??= await currentModel(athleteId);
      const written = presentDecided(
        {
          id: adj.sessionId, athleteId, date: adj.date, status: 'planned',
          ...recoveryContent(adj.recovery ?? 'recovery', undefined, model),
          decision: decided(adj.reason), rationale: adj.reason,
        },
        { model },
      );
      await db.insertSession(plan.plan.id, written, weekOf(adj.date));
      continue;
    }
    if (!session) continue;

    switch (adj.action) {
      case 'mark_missed':
        await db.updateSession(adj.sessionId, {
          status: 'missed',
          ...told(session, adj.reason),
          decision: decided(adj.reason),
        });
        break;

      case 'withdraw':
        await db.updateSession(adj.sessionId, {
          status: 'withdrawn',
          absenceId: adj.absenceId ?? null,
          ...told(session, adj.reason),
          decision: decided(adj.reason),
        });
        break;

      case 'scale': {
        // Alléger raccourcit ce qui se court — durée et dénivelé ensemble —, et
        // rien de ce que le dossier prescrit. Le détail est dans
        // `transformSession`, le chemin de toute transformation, partagé avec la
        // phrase qui l'annonce plus haut. Ce que la séance a dû céder pour rester
        // exécutable s'ajoute au motif.
        model ??= await currentModel(athleteId);
        const { amendments, ...content } = transformSession(
          session,
          { duration: adj.factor ?? 1, eccentric: adj.eccentric ?? 1, repeats: adj.repeats ?? 1 },
          model,
        );
        const motive = [adj.reason, ...amendments].join(' ');
        const title = `${retitleFromContent({ ...session, blocks: content.blocks }).replace(/ · allégée$/, '')} · allégée`;
        // Allégée, elle reste une séance à venir : elle se présente comme toute
        // séance, et son motif rejoint l'historique.
        const presented = presentDecided(
          { ...session, ...content, title, decision: decided(motive), rationale: motive },
          { model },
        );
        await db.updateSession(adj.sessionId, {
          ...content,
          ...measuredOf(presented),
          title: presented.title,
          intent: presented.intent,
          blocks: presented.blocks,
          rationale: presented.rationale,
          history: presented.history ?? null,
          decision: presented.decision,
          ...traced(session, adj.rule),
        } as never);
        break;
      }

      case 'drop_strength': {
        // Le circuit part, et l'activation qui l'ouvrait ; la course, la
        // souplesse et la respiration restent, et se présentent comme toute
        // séance. Une séance qui n'était que renforcement n'a plus lieu.
        model ??= await currentModel(athleteId);
        const content = withoutEccentricStrength(session, model);
        if (content.plannedDurationS === 0) {
          await db.updateSession(adj.sessionId, {
            status: 'cancelled',
            ...told(session, adj.reason),
            decision: decided(adj.reason),
          });
          break;
        }
        const title = `${retitleFromContent({ ...session, blocks: content.blocks }).replace(/ · allégée$/, '')} · allégée`;
        const intent = session.intent.replace(` ${STRENGTH_INTENT}`, '');
        const presented = presentDecided(
          { ...session, ...content, title, intent, decision: decided(adj.reason), rationale: adj.reason },
          { model },
        );
        await db.updateSession(adj.sessionId, {
          ...content,
          ...measuredOf(presented),
          title: presented.title,
          intent: presented.intent,
          blocks: presented.blocks,
          rationale: presented.rationale,
          history: presented.history ?? null,
          decision: presented.decision,
          ...traced(session, adj.rule),
        } as never);
        break;
      }

      case 'move':
        if (adj.newDate) {
          await db.updateSession(adj.sessionId, {
            date: adj.newDate,
            status: 'moved',
            ...told(session, adj.reason),
            decision: decided(adj.reason),
          });
        }
        break;

      case 'recover': {
        // Le lendemain d'une séance clef, à son jour : la séance facile qui
        // l'occupait, ou la protection de l'ancienne date qui y passe.
        model ??= await currentModel(athleteId);
        const date = adj.newDate ?? adj.date;
        const content = recoveryContent(adj.recovery ?? 'recovery', session, model);
        const presented = presentDecided(
          { ...session, ...content, date, decision: decided(adj.reason), rationale: adj.reason },
          { model },
        );
        await db.updateSession(adj.sessionId, {
          ...content,
          plannedDistanceM: content.plannedDistanceM ?? null,
          ...measuredOf(presented),
          directives: content.directives ?? null,
          successCriteria: content.successCriteria ?? null,
          date,
          ...(date !== session.date ? weekOf(date) : {}),
          title: presented.title,
          intent: presented.intent,
          blocks: presented.blocks,
          rationale: presented.rationale,
          history: presented.history ?? null,
          decision: presented.decision,
        } as never);
        break;
      }

      case 'free':
        // Le jour ne protège plus rien : il n'impose plus rien.
        await db.updateSession(adj.sessionId, {
          status: 'cancelled',
          ...told(session, adj.reason),
          decision: decided(adj.reason),
        });
        break;

      case 'soften': {
        // La forme reste, l'intensité se calme : mêmes blocs, cibles au bas de
        // leur fourchette, dernière répétition facultative ou bloc écourté.
        model ??= await currentModel(athleteId);
        const blocks = softenedQuality(session.blocks).blocks;
        const presented = presentDecided(
          { ...session, blocks, decision: decided(adj.reason), rationale: adj.reason },
          { model },
        );
        await db.updateSession(adj.sessionId, {
          blocks: presented.blocks,
          plannedDurationS: totalDuration(presented.blocks) || session.plannedDurationS,
          plannedElevationGainM: elevationGainOf(presented.blocks),
          ...measuredOf(presented),
          title: presented.title,
          intent: presented.intent,
          rationale: presented.rationale,
          history: presented.history ?? null,
          decision: presented.decision,
          ...traced(session, adj.rule),
        } as never);
        break;
      }

      case 'ease': {
        // Courue facile, à durée égale : une sortie longue perd son intensité
        // et garde son terrain ; une autre séance devient un footing.
        model ??= await currentModel(athleteId);
        const content = isLongType(session.type)
          ? { blocks: easedLongRun(session.blocks) }
          : easyContent(model, session.plannedDurationS);
        const presented = presentDecided(
          { ...session, ...content, decision: decided(adj.reason), rationale: adj.reason },
          { model },
        );
        await db.updateSession(adj.sessionId, {
          ...content,
          ...('directives' in content
            ? { directives: null, successCriteria: null, plannedDistanceM: content.plannedDistanceM ?? null }
            : {}),
          ...measuredOf(presented),
          plannedDurationS: totalDuration(presented.blocks) || session.plannedDurationS,
          plannedElevationGainM: elevationGainOf(presented.blocks),
          title: presented.title,
          intent: presented.intent,
          blocks: presented.blocks,
          rationale: presented.rationale,
          history: presented.history ?? null,
          decision: presented.decision,
          ...traced(session, adj.rule),
        } as never);
        break;
      }

      case 'defer': {
        // La qualité part à son nouveau jour, avec son histoire ; à sa place, un
        // footing facile de même durée ; au nouveau jour, le footing qui
        // l'occupait est retiré.
        if (!adj.newDate) break;
        model ??= await currentModel(athleteId);
        await db.updateSession(adj.sessionId, {
          date: adj.newDate,
          status: 'moved',
          ...(mondayOf(adj.newDate) !== mondayOf(session.date) ? weekOf(adj.newDate) : {}),
          ...told(session, adj.reason),
          decision: decided(adj.reason),
          ...traced(session, adj.rule),
        } as never);
        const displaced = adj.displaces ? byId.get(adj.displaces) : undefined;
        if (displaced) {
          const why =
            `Retiré : « ${formatOf(session.title)} » passe à ce jour, décalée du ${dayMonth(session.date)} par une ` +
            `disponibilité rouge.`;
          await db.updateSession(displaced.id, { status: 'cancelled', ...told(displaced, why), decision: decided(why) });
        }
        if (plan) {
          const written = presentDecided(
            {
              id: `${session.id}-facile-${session.date}`, athleteId, date: session.date, status: 'planned',
              ...easyContent(model, session.plannedDurationS),
              decision: decided(adj.reason), rationale: adj.reason,
              lightenings: [{ rule: adj.rule, on: localDate(at) }],
            },
            { model },
          );
          await db.insertSession(plan.plan.id, written, weekOf(session.date));
        }
        break;
      }

      case 'swap':
        await db.updateSession(adj.sessionId, { ...told(session, adj.reason), decision: decided(adj.reason) });
        break;
    }
  }

  if (plan) {
    await db.appendPlanRevision(plan.plan.id, {
      at: new Date().toISOString(),
      trigger,
      origin,
      summary: `${adjustments.length} ajustement(s) automatique(s) : ${[...new Set(adjustments.map((a) => a.rule))].join(', ')}.`,
      changes: adjustments.map((a) => ({
        date: a.date,
        before: a.insert ? '—' : byId.get(a.sessionId)?.title ?? a.sessionId,
        after:
          a.action === 'scale'
            ? `charge × ${a.factor}` +
              `${a.eccentric != null ? `, tours excentriques × ${Math.round(a.eccentric * 100) / 100}` : ''}` +
              `${a.repeats != null ? `, répétitions × ${a.repeats}` : ''}`
            : a.action === 'move'
              ? `déplacée au ${a.newDate}`
              : a.action === 'withdraw'
                ? 'retirée (absence déclarée)'
                : a.action === 'drop_strength'
                  ? 'renforcement excentrique retiré'
                  : a.action === 'recover'
                    ? recoveredAs(a)
                    : a.action === 'free'
                      ? 'libérée'
                      : a.action === 'soften' || a.action === 'ease' || a.action === 'defer'
                        ? readinessChange(a)
                        : a.action,
        reason: a.reason,
      })),
    });
  }

  return adjustments.length;
}

/** Rend les ajustements lisibles, pour l'affichage et le chat. */
export function describeAdjustments(adjustments: Adjustment[]): string {
  if (adjustments.length === 0) return 'Aucun ajustement nécessaire : le plan tient tel quel.';
  return adjustments
    .map((a) => {
      // Le facteur de la règle n'est pas ce que la séance perd : une descente
      // ramenée à 45 % garde ses remontées à pied, et passait de 1 h 35 à 1 h 20
      // sous un « allégée de 55 % ». Ce qu'elle devient est dans le motif.
      const what =
        a.action === 'scale'
          ? 'allégée'
          : a.action === 'drop_strength'
            ? 'allégée de son renforcement'
            : a.action === 'move'
              ? `déplacée au ${a.newDate}`
              : a.action === 'mark_missed'
                ? 'marquée manquée'
                : a.action === 'withdraw'
                  ? 'retirée'
                  : a.action === 'recover'
                    ? recoveredAs(a)
                    : a.action === 'free'
                      ? 'libérée'
                      : a.action === 'soften' || a.action === 'ease' || a.action === 'defer'
                        ? readinessChange(a)
                        : 'ajustée';
      return `- **${a.date}** — séance ${what}. ${a.reason}`;
    })
    .join('\n');
}

/** Ce que devient le lendemain d'une séance clef, en clair. */
function recoveredAs(a: Adjustment): string {
  const kind = a.recovery === 'rest' ? 'repos complet' : 'décrassage';
  return a.insert ? `ajoutée : ${kind}` : a.newDate ? `déplacée au ${a.newDate} : ${kind}` : `réécrite : ${kind}`;
}

/** Ce que la disponibilité a fait d'une séance de qualité, en clair. */
function readinessChange(a: Adjustment): string {
  return a.action === 'soften'
    ? 'gardée, intensité calmée'
    : a.action === 'defer'
      ? `courue facile, qualité déplacée au ${a.newDate}`
      : 'courue facile';
}
