import type {
  DeclaredAbsence, DecisionOrigin, IntervalPolicyDirective, PhysiologyModel, PlannedSession,
  SessionDecision,
} from '@cairn/core';
import * as db from '@cairn/db';
import { directivesFor, sessionDuration } from '@cairn/core';
import { ACWR_SPIKE } from '@cairn/physiology';
import { indexDirectives, isIntervalSession } from './directives.js';
import { descentReason, eccentricVerdicts, progressionReason, roundsLabel } from './eccentric.js';
import { addDays, mondayOf } from './periodization.js';
import { RECOVERY_MIN, isHardSession, isLongType } from './planner.js';
import { firstSentence, presentDecided, withHistory } from './presentation.js';
import {
  STRENGTH_INTENT, carriesEccentricStrength, elevationGainOf, formatOf, isMaximalTest, recovery as decrassage,
  restDay, retitleFromContent, scaledRounds, transformSession, withoutEccentricStrength,
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
   */
  action: 'scale' | 'move' | 'swap' | 'mark_missed' | 'withdraw' | 'drop_strength' | 'recover' | 'free';
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
        `Séance retirée : ${KIND_FR[absence.kind]} déclarée du ${absence.startDate} au ${absence.endDate}. ` +
        `Motif de l'athlète : « ${absence.reason} » Une absence annoncée n'est pas une séance manquée.`,
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

  const push = (adj: Adjustment) => {
    // Une seule règle par séance : la première déclenchée, la plus protectrice.
    if (seen.has(adj.sessionId)) return;
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

  // ── Règle 2 : fatigue musculaire excentrique ──────────────────────────────
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
          `TSB mécanique à ${state.today.mechanicalTsb.toFixed(0)} : les dégâts musculaires de la descente ne sont pas résorbés. ` +
          `Volume de cette séance réduit de 40 % pour éviter d'empiler la contrainte excentrique${repsCut(s, 0.6)}.`,
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
          `Ratio charge aiguë/chronique excentrique à ${state.today.mechanicalAcwr.toFixed(2)} : au-delà de ` +
          `${ACWR_SPIKE.mechanical}, les tissus encaissent plus de freinage que les semaines passées ne les y ont préparés. ` +
          `Séance allégée de 25 %${roundsCut(s, factor)}${repsCut(s, factor)}.`,
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
          `Ratio charge aiguë/chronique à ${state.today.acwr.toFixed(2)} : au-delà de 1,5, le risque de blessure augmente nettement. ` +
          `Les séances secondaires des cinq prochains jours sont allégées de 25 %${repsCut(s, 0.75)}.`,
      });
    }
  }

  // ── Règle 4 : disponibilité au rouge ──────────────────────────────────────
  if (state.readiness.verdict === 'red') {
    const next = future.find((s) => daysUntil(s.date) <= 1);
    if (next && next.plannedLoad > 40) {
      const factor = 0.45;
      const change = { duration: factor, ...repetitionScaling(next, factor) };
      push({
        sessionId: next.id,
        date: next.date,
        action: 'scale',
        factor,
        ...repetitionScaling(next, factor),
        rule: 'readiness_red',
        reason:
          `Disponibilité à ${state.readiness.score}/100. ${state.readiness.recommendation} ` +
          // La durée annoncée est celle que l'allègement produira, écrite comme
          // l'écran l'écrira. Calculée à part, elle promettait 31 min là où la
          // séance enregistrée en affichait 30, et c'est la phrase qu'on croit.
          `Séance ramenée à ${sessionDuration(transformSession(next, change, state.model).plannedDurationS)} ` +
          `en récupération${repsCut(next, factor)}.`,
      });
    }
  }

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
          `La charge chronique progresse de ${state.today.rampRate.toFixed(1)} points par semaine, au-dessus du seuil prudentiel de 8. ` +
          `Les séances facultatives sont allégées le temps que l'adaptation suive${repsCut(s, 0.7)}.`,
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
  const dates = adjustments.map((a) => a.date).sort();
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
          title: presented.title,
          intent: presented.intent,
          blocks: presented.blocks,
          rationale: presented.rationale,
          history: presented.history ?? null,
          decision: presented.decision,
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
          title: presented.title,
          intent: presented.intent,
          blocks: presented.blocks,
          rationale: presented.rationale,
          history: presented.history ?? null,
          decision: presented.decision,
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
      const what =
        a.action === 'scale'
          ? (a.factor ?? 1) < 1
            ? `allégée de ${Math.round((1 - (a.factor ?? 1)) * 100)} %`
            : 'allégée'
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
