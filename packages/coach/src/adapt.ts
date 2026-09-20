import type {
  DeclaredAbsence, DecisionOrigin, PhysiologyModel, PlannedSession, SessionDecision,
} from '@cairn/core';
import * as db from '@cairn/db';
import { sessionDuration } from '@cairn/core';
import { ACWR_SPIKE } from '@cairn/physiology';
import {
  eccentricStrengthOf, elevationGainOf, restateVert, scaledRounds, transformSession,
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
  action: 'scale' | 'move' | 'swap' | 'mark_missed' | 'withdraw';
  factor?: number;
  /** Facteur appliqué aux tours des circuits excentriques, sur `scale`. Absent : ils restent entiers. */
  eccentric?: number;
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
  ECCENTRIC_TYPES.has(s.type) || s.plannedMechanicalLoad >= 35 || eccentricStrengthOf(s.blocks) > 0;

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

  // Les jours d'absence sortent du plan pour toutes les règles suivantes : une
  // séance retirée n'a pas à être allégée, ni à décaler celle qui la suit.
  const future = upcoming.filter(
    (s) =>
      s.date >= today &&
      s.status === 'planned' &&
      s.type !== 'rest' &&
      !absenceCovering(absences, s.date),
  );

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
        rule: 'mechanical_fatigue',
        reason:
          `TSB mécanique à ${state.today.mechanicalTsb.toFixed(0)} : les dégâts musculaires de la descente ne sont pas résorbés. ` +
          `Volume de cette séance réduit de 40 % pour éviter d'empiler la contrainte excentrique.`,
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
        rule: 'mechanical_acwr_spike',
        reason:
          `Ratio charge aiguë/chronique excentrique à ${state.today.mechanicalAcwr.toFixed(2)} : au-delà de ` +
          `${ACWR_SPIKE.mechanical}, les tissus encaissent plus de freinage que les semaines passées ne les y ont préparés. ` +
          `Séance allégée de 25 %${roundsCut(s, factor)}.`,
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
        rule: 'acwr_spike',
        reason:
          `Ratio charge aiguë/chronique à ${state.today.acwr.toFixed(2)} : au-delà de 1,5, le risque de blessure augmente nettement. ` +
          `Les séances secondaires des cinq prochains jours sont allégées de 25 %.`,
      });
    }
  }

  // ── Règle 4 : disponibilité au rouge ──────────────────────────────────────
  if (state.readiness.verdict === 'red') {
    const next = future.find((s) => daysUntil(s.date) <= 1);
    if (next && next.plannedLoad > 40) {
      const factor = 0.45;
      push({
        sessionId: next.id,
        date: next.date,
        action: 'scale',
        factor,
        rule: 'readiness_red',
        reason:
          `Disponibilité à ${state.readiness.score}/100. ${state.readiness.recommendation} ` +
          // La durée annoncée est celle que l'allègement produira, écrite comme
          // l'écran l'écrira. Calculée à part, elle promettait 31 min là où la
          // séance enregistrée en affichait 30, et c'est la phrase qu'on croit.
          `Séance ramenée à ${sessionDuration(transformSession(next, factor, state.model).plannedDurationS)} en récupération.`,
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
        rule: 'ramp_too_fast',
        reason:
          `La charge chronique progresse de ${state.today.rampRate.toFixed(1)} points par semaine, au-dessus du seuil prudentiel de 8. ` +
          `Les séances facultatives sont allégées le temps que l'adaptation suive.`,
      });
    }
  }

  // ── Règle 6 : espacement des séances de qualité ───────────────────────────
  // Deux séances exigeantes à moins de 48 h : la seconde est repoussée.
  const keySessions = future.filter((s) => s.priority === 'key').sort((a, b) => a.date.localeCompare(b.date));
  for (let i = 1; i < keySessions.length; i++) {
    const prev = keySessions[i - 1]!;
    const cur = keySessions[i]!;
    const gap = Math.round(
      (new Date(`${cur.date}T00:00:00Z`).getTime() - new Date(`${prev.date}T00:00:00Z`).getTime()) / dayMs,
    );
    if (gap < 2) {
      push({
        sessionId: cur.id,
        date: cur.date,
        action: 'move',
        newDate: iso(new Date(new Date(`${prev.date}T00:00:00Z`).getTime() + 2 * dayMs)),
        rule: 'quality_spacing',
        reason:
          `Deux séances clefs séparées de ${gap} jour(s). Un stimulus intense demande 48 h pour être assimilé : la seconde est décalée.`,
      });
    }
  }

  return out;
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
  const decided = (summary: string): SessionDecision => ({
    at: new Date().toISOString(),
    by: origin,
    summary,
  });

  for (const adj of adjustments) {
    const session = byId.get(adj.sessionId);
    if (!session) continue;

    switch (adj.action) {
      case 'mark_missed':
        await db.updateSession(adj.sessionId, {
          status: 'missed',
          rationale: adj.reason,
          decision: decided(adj.reason),
        });
        break;

      case 'withdraw':
        await db.updateSession(adj.sessionId, {
          status: 'withdrawn',
          absenceId: adj.absenceId ?? null,
          rationale: adj.reason,
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
          { duration: adj.factor ?? 1, eccentric: adj.eccentric ?? 1 },
          model,
        );
        const title =
          content.plannedElevationGainM !== elevationGainOf(session.blocks)
            ? restateVert(session.title, content.plannedElevationGainM)
            : session.title;
        await db.updateSession(adj.sessionId, {
          ...content,
          title: `${title} · allégée`,
          rationale: [adj.reason, ...amendments].join(' '),
          decision: decided([adj.reason, ...amendments].join(' ')),
        } as never);
        break;
      }

      case 'move':
        if (adj.newDate) {
          await db.updateSession(adj.sessionId, {
            date: adj.newDate,
            status: 'moved',
            rationale: adj.reason,
            decision: decided(adj.reason),
          });
        }
        break;

      case 'swap':
        await db.updateSession(adj.sessionId, { rationale: adj.reason, decision: decided(adj.reason) });
        break;
    }
  }

  const plan = await db.getActivePlan(athleteId);
  if (plan) {
    await db.appendPlanRevision(plan.plan.id, {
      at: new Date().toISOString(),
      trigger,
      origin,
      summary: `${adjustments.length} ajustement(s) automatique(s) : ${[...new Set(adjustments.map((a) => a.rule))].join(', ')}.`,
      changes: adjustments.map((a) => ({
        date: a.date,
        before: byId.get(a.sessionId)?.title ?? a.sessionId,
        after:
          a.action === 'scale'
            ? `charge × ${a.factor}${a.eccentric != null ? `, tours excentriques × ${a.eccentric}` : ''}`
            : a.action === 'move'
              ? `déplacée au ${a.newDate}`
              : a.action === 'withdraw'
                ? 'retirée (absence déclarée)'
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
          ? `allégée de ${Math.round((1 - (a.factor ?? 1)) * 100)} %`
          : a.action === 'move'
            ? `déplacée au ${a.newDate}`
            : a.action === 'mark_missed'
              ? 'marquée manquée'
              : a.action === 'withdraw'
                ? 'retirée'
                : 'ajustée';
      return `- **${a.date}** — séance ${what}. ${a.reason}`;
    })
    .join('\n');
}
