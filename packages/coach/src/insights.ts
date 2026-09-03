import Anthropic from '@anthropic-ai/sdk';
import type { Activity, ActivityAnalysis, CoachInsight } from '@cairn/core';
import * as db from '@cairn/db';
import { formatDuration, summarizeForCoach } from '@cairn/physiology';
import { ACTIVITY_ANALYSIS_PROMPT } from './prompts.js';
import { loadAthleteState, type AthleteState } from './state.js';
import { formatAnthropicError } from './agent.js';

/**
 * Analyse rédigée d'une séance.
 *
 * Produite automatiquement à chaque nouvelle activité Strava. Le modèle ne
 * reçoit que des faits déjà calculés et répond en JSON structuré : la sortie
 * est stockable, affichable et vérifiable, et un modèle qui divague sur le
 * format échoue bruyamment plutôt que d'écrire n'importe quoi en base.
 */

const MODEL = process.env.CAIRN_MODEL_FAST ?? process.env.CAIRN_MODEL ?? 'claude-opus-5';

interface AnalysisJson {
  titre: string;
  corps: string;
  actions: string[];
  faits_marquants: { label: string; valeur: string; delta?: string | null; direction?: string }[];
  gravite: 'info' | 'good' | 'watch' | 'warn';
  ajustement_recommande: string | null;
}

const ANALYSIS_SCHEMA = {
  type: 'object',
  properties: {
    titre: { type: 'string' },
    corps: { type: 'string' },
    actions: { type: 'array', items: { type: 'string' } },
    faits_marquants: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          label: { type: 'string' },
          valeur: { type: 'string' },
          delta: { type: ['string', 'null'] },
          direction: { type: 'string', enum: ['up', 'down', 'flat'] },
        },
        required: ['label', 'valeur'],
        additionalProperties: false,
      },
    },
    gravite: { type: 'string', enum: ['info', 'good', 'watch', 'warn'] },
    ajustement_recommande: { type: ['string', 'null'] },
  },
  required: ['titre', 'corps', 'actions', 'faits_marquants', 'gravite', 'ajustement_recommande'],
  additionalProperties: false,
} as const;

export async function generateActivityInsight(
  athleteId: string,
  activity: Activity,
  analysis: ActivityAnalysis,
  state?: AthleteState,
): Promise<CoachInsight | null> {
  const s = state ?? (await loadAthleteState(athleteId));

  const payload = {
    seance: summarizeForCoach(activity, analysis, s.model),
    contexte_forme: {
      ctl: s.today.ctl,
      atl: s.today.atl,
      tsb_metabolique: s.today.tsb,
      tsb_mecanique: s.today.mechanicalTsb,
      acwr: s.today.acwr,
      lecture_acwr: s.today.acwrLabel,
      progression_ctl_par_semaine: s.today.rampRate,
      disponibilite: s.readiness.score,
    },
    modele_physiologique: {
      vitesse_critique_ms: s.model.criticalSpeedMs,
      sv1: s.model.vt1,
      sv2: s.model.vt2,
      fc_max: s.model.hrMax,
      durabilite_pct_par_heure: s.model.durabilityPctPerHour,
      confiance: s.model.confidence,
    },
    semaine_en_cours: s.weeklyTotals.slice(-2),
    seances_a_venir: (s.plan?.weeks ?? [])
      .flatMap((w) => w.sessions)
      .filter((x) => x.date >= activity.startDateLocal.slice(0, 10))
      .slice(0, 4)
      .map((x) => ({ date: x.date, titre: x.title, charge: x.plannedLoad, priorite: x.priority })),
    courses_a_venir: s.upcomingRaces.slice(0, 2).map((r) => ({
      nom: r.name,
      date: r.date,
      jours_restants: Math.round((new Date(r.date).getTime() - Date.now()) / 86_400_000),
    })),
  };

  try {
    const response = await new Anthropic().messages.create({
      model: MODEL,
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: {
        effort: 'medium',
        format: { type: 'json_schema', schema: ANALYSIS_SCHEMA },
      },
      system: ACTIVITY_ANALYSIS_PROMPT,
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');

    const parsed = parseJson(text);
    if (!parsed) return null;

    const insight: Omit<CoachInsight, 'id'> = {
      athleteId,
      createdAt: new Date().toISOString(),
      scope: 'activity',
      refId: activity.id,
      title: parsed.titre,
      body: parsed.ajustement_recommande
        ? `${parsed.corps}\n\n**Ajustement :** ${parsed.ajustement_recommande}`
        : parsed.corps,
      actions: parsed.actions ?? [],
      highlights: (parsed.faits_marquants ?? []).map((h) => ({
        label: h.label,
        value: h.valeur,
        delta: h.delta ?? undefined,
        direction: (h.direction as 'up' | 'down' | 'flat' | undefined) ?? undefined,
      })),
      severity: parsed.gravite ?? 'info',
    };

    const id = await db.saveInsight(insight);
    return { id, ...insight };
  } catch (e) {
    // Une panne d'analyse rédigée ne doit jamais bloquer l'ingestion : les
    // chiffres, eux, sont déjà en base et restent consultables.
    console.error('[insight] échec de génération :', formatAnthropicError(e));
    return null;
  }
}

function parseJson(text: string): AnalysisJson | null {
  const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/, '').trim();
  try {
    return JSON.parse(cleaned) as AnalysisJson;
  } catch {
    // Repli : extraire le premier objet JSON équilibré du texte.
    const start = cleaned.indexOf('{');
    if (start < 0) return null;
    let depth = 0;
    for (let i = start; i < cleaned.length; i++) {
      if (cleaned[i] === '{') depth++;
      else if (cleaned[i] === '}') {
        depth--;
        if (depth === 0) {
          try {
            return JSON.parse(cleaned.slice(start, i + 1)) as AnalysisJson;
          } catch {
            return null;
          }
        }
      }
    }
    return null;
  }
}

/** Analyse hebdomadaire : bilan de la semaine écoulée et cadrage de la suivante. */
export async function generateWeeklyReview(athleteId: string): Promise<CoachInsight | null> {
  const s = await loadAthleteState(athleteId);
  const week = s.weeklyTotals[s.weeklyTotals.length - 1];
  if (!week) return null;

  const activities = s.recentActivities.filter((a) => a.startDateLocal.slice(0, 10) >= week.weekStart);
  const analyses = await db.getAnalyses(activities.map((a) => a.id));

  const payload = {
    semaine: week.weekStart,
    volume: {
      duree: formatDuration(week.durationS),
      charge_metabolique: week.load,
      charge_mecanique: week.mechanical,
      denivele_m: week.vertM,
      seances: activities.length,
    },
    etat: s.today,
    disponibilite: s.readiness,
    seances: activities.map((a) => {
      const an = analyses.get(a.id);
      return {
        date: a.startDateLocal.slice(0, 10),
        nom: a.name,
        charge: an?.load.metabolic ?? null,
        derive_pct: an?.decoupling.pctDrift ?? null,
        alertes: an?.flags.filter((f) => f.severity !== 'info').map((f) => f.message) ?? [],
      };
    }),
    plan_semaine_suivante: (s.plan?.weeks ?? [])
      .flatMap((w) => w.sessions)
      .filter((x) => x.date > s.today.date)
      .slice(0, 7)
      .map((x) => ({ date: x.date, titre: x.title, charge: x.plannedLoad })),
    historique_hebdomadaire: s.weeklyTotals.slice(-6),
    // Sans cette ligne, une semaine à zéro se raconte comme un abandon. La
    // chute de charge est réelle ; ce qui manquait, c'est qu'elle était prévue.
    absences_declarees: s.absences
      .filter((a) => a.endDate >= week.weekStart)
      .map((a) => ({ du: a.startDate, au: a.endDate, nature: a.kind, motif: a.reason, source: a.source })),
  };

  try {
    const response = await new Anthropic().messages.create({
      model: process.env.CAIRN_MODEL ?? 'claude-opus-5',
      max_tokens: 4000,
      thinking: { type: 'adaptive' },
      output_config: { effort: 'high', format: { type: 'json_schema', schema: ANALYSIS_SCHEMA } },
      system:
        ACTIVITY_ANALYSIS_PROMPT.replace('la séance ci-dessous', 'la semaine ci-dessous').replace(
          'ce que cette séance a été',
          'ce que cette semaine a été',
        ),
      messages: [{ role: 'user', content: JSON.stringify(payload) }],
    });

    const text = response.content
      .filter((b): b is Anthropic.TextBlock => b.type === 'text')
      .map((b) => b.text)
      .join('');
    const parsed = parseJson(text);
    if (!parsed) return null;

    const insight: Omit<CoachInsight, 'id'> = {
      athleteId,
      createdAt: new Date().toISOString(),
      scope: 'week',
      refId: week.weekStart,
      title: parsed.titre,
      body: parsed.ajustement_recommande
        ? `${parsed.corps}\n\n**Ajustement :** ${parsed.ajustement_recommande}`
        : parsed.corps,
      actions: parsed.actions ?? [],
      highlights: (parsed.faits_marquants ?? []).map((h) => ({
        label: h.label,
        value: h.valeur,
        delta: h.delta ?? undefined,
        direction: (h.direction as 'up' | 'down' | 'flat' | undefined) ?? undefined,
      })),
      severity: parsed.gravite ?? 'info',
    };
    const id = await db.saveInsight(insight);
    return { id, ...insight };
  } catch (e) {
    console.error('[weekly] échec :', formatAnthropicError(e));
    return null;
  }
}
