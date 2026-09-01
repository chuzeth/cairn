import type { PlannedSession } from '@cairn/core';
import * as db from '@cairn/db';
import { formatDuration } from '@cairn/physiology';
import type { AthleteState } from './state.js';

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
  action: 'scale' | 'move' | 'swap' | 'mark_missed';
  factor?: number;
  newDate?: string;
  reason: string;
  /** Code de la règle déclenchée, pour l'auditabilité. */
  rule: string;
}

const dayMs = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysUntil = (date: string) => Math.round((new Date(`${date}T00:00:00Z`).getTime() - Date.now()) / dayMs);

/** Séances à forte contrainte excentrique. */
const ECCENTRIC_TYPES = new Set(['downhill', 'long_trail', 'long_run', 'race_pace']);

export function evaluateAdjustments(
  state: AthleteState,
  upcoming: PlannedSession[],
): Adjustment[] {
  const out: Adjustment[] = [];
  const today = iso(new Date());
  const seen = new Set<string>();

  const push = (adj: Adjustment) => {
    // Une seule règle par séance : la première déclenchée, la plus protectrice.
    if (seen.has(adj.sessionId)) return;
    seen.add(adj.sessionId);
    out.push(adj);
  };

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

  const future = upcoming.filter((s) => s.date >= today && s.status === 'planned' && s.type !== 'rest');

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

  // ── Règle 3 : pic de charge ───────────────────────────────────────────────
  if (state.today.acwr > 1.5) {
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
      push({
        sessionId: next.id,
        date: next.date,
        action: 'scale',
        factor: 0.45,
        rule: 'readiness_red',
        reason:
          `Disponibilité à ${state.readiness.score}/100. ${state.readiness.recommendation} ` +
          `Séance ramenée à ${Math.round(next.plannedDurationS * 0.45 / 60)} min en récupération.`,
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
  trigger: 'new_activity' | 'readiness' | 'missed_session' = 'new_activity',
): Promise<number> {
  if (adjustments.length === 0) return 0;

  const from = iso(new Date(Date.now() - 30 * dayMs));
  const to = iso(new Date(Date.now() + 400 * dayMs));
  const all = await db.listPlannedSessions(athleteId, from, to);
  const byId = new Map(all.map((s) => [s.id, s]));

  for (const adj of adjustments) {
    const session = byId.get(adj.sessionId);
    if (!session) continue;

    switch (adj.action) {
      case 'mark_missed':
        await db.updateSession(adj.sessionId, { status: 'missed', rationale: adj.reason });
        break;

      case 'scale': {
        const f = adj.factor ?? 1;
        await db.updateSession(adj.sessionId, {
          plannedLoad: Math.round(session.plannedLoad * f),
          plannedDurationS: Math.round(session.plannedDurationS * f),
          plannedMechanicalLoad: Math.round(session.plannedMechanicalLoad * f),
          blocks: session.blocks.map((b) => ({
            ...b,
            durationS: b.durationS ? Math.round(b.durationS * f) : b.durationS,
          })),
          title: `${session.title} · allégée`,
          rationale: adj.reason,
        } as never);
        break;
      }

      case 'move':
        if (adj.newDate) {
          await db.updateSession(adj.sessionId, { date: adj.newDate, status: 'moved', rationale: adj.reason });
        }
        break;

      case 'swap':
        await db.updateSession(adj.sessionId, { rationale: adj.reason });
        break;
    }
  }

  const plan = await db.getActivePlan(athleteId);
  if (plan) {
    await db.appendPlanRevision(plan.plan.id, {
      at: new Date().toISOString(),
      trigger,
      summary: `${adjustments.length} ajustement(s) automatique(s) : ${[...new Set(adjustments.map((a) => a.rule))].join(', ')}.`,
      changes: adjustments.map((a) => ({
        date: a.date,
        before: byId.get(a.sessionId)?.title ?? a.sessionId,
        after:
          a.action === 'scale'
            ? `charge × ${a.factor}`
            : a.action === 'move'
              ? `déplacée au ${a.newDate}`
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
              : 'ajustée';
      return `- **${a.date}** — séance ${what}. ${a.reason}`;
    })
    .join('\n');
}
