import type { PlannedSession } from '@cairn/core';
import { raceCriteria, type CriterionStatus } from './criteria.js';
import { pendingQuestions } from './questions.js';
import type { AthleteState } from './state.js';

/**
 * Le fil de la préparation, en une page, recalculé à chaque appel.
 *
 * Un modèle de langage qui suit une préparation dans une conversation perd le
 * fil : plus l'échange s'allonge, plus il pèse les derniers messages et oublie
 * les premiers — la dégradation est mesurée sur tous les modèles, même loin de
 * la limite de leur fenêtre (« context rot », Chroma 2025 ; « lost in the
 * middle », Liu et al. 2024). Douze semaines de préparation ne tiennent pas dans
 * un fil de discussion.
 *
 * Ici, rien ne repose sur la mémoire de la conversation. La préparation vit en
 * base ; ce brief en est la lecture du jour, ordonnée par ce qui décide :
 * l'objectif et ses critères, la séance du jour et la règle qui l'a écrite, ce
 * que Cairn attend de Pierre, ce que les règles ont décidé récemment, et ce que
 * Cairn ne sait pas. Court par construction : les détails se lisent avec les
 * autres outils, quand une question les demande.
 */

const MARK: Record<CriterionStatus, string> = { met: 'tenu', open: 'ouvert', failed: 'manqué', info: 'à savoir' };
const dm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const daysBetween = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / 86_400_000);
const first = (text: string) => (text.match(/^.*?[.!?](\s|$)/)?.[0] ?? text).trim();

export function buildCoachingBrief(
  state: AthleteState,
  sessions: readonly PlannedSession[],
  known: { lastCheckInDate?: string } = {},
): string {
  const today = state.today.date;
  const lines: string[] = [`# Le fil — ${today}`];

  // L'objectif, et ce qui doit être vrai pour l'atteindre.
  const race = [...(state.upcomingRaces ?? [])].filter((r) => r.date.slice(0, 10) >= today).sort((a, b) => a.date.localeCompare(b.date))[0];
  if (race) {
    const target = race.target?.timeS ? `, visé en ${Math.floor(race.target.timeS / 3600)} h ${String(Math.round((race.target.timeS % 3600) / 60)).padStart(2, '0')}` : '';
    lines.push('', `**Objectif** : ${race.name}, le ${dm(race.date)} (J−${daysBetween(today, race.date.slice(0, 10))})${target}.`);
  }
  const criteria = raceCriteria(state, sessions);
  if (criteria) {
    lines.push('', `## Critères du dossard — décision le ${dm(criteria.gateDate)}, repli : ${criteria.fallbackTitle}`);
    for (const c of criteria.criteria) lines.push(`- [${MARK[c.status]}] ${c.label} — ${c.evidence}`);
  }

  // Aujourd'hui, et ce qui l'a décidé.
  const live = (s: PlannedSession) => s.status !== 'cancelled' && s.status !== 'withdrawn';
  const todays = sessions.filter((s) => s.date === today && live(s));
  const next = sessions.filter((s) => s.date > today && live(s) && s.type !== 'rest').sort((a, b) => a.date.localeCompare(b.date))[0];
  lines.push('', '## Aujourd\'hui');
  if (todays.length === 0) lines.push('- Rien de prévu.');
  for (const s of todays) {
    const by = s.decision ? ` — décidé par ${s.decision.by === 'rules' ? 'les règles' : s.decision.by === 'athlete' ? 'Pierre' : 'le coach'} : ${first(s.decision.summary)}` : '';
    lines.push(`- ${s.title} (${s.status})${by}`);
  }
  if (next) lines.push(`- Ensuite, le ${dm(next.date)} : ${next.title}.`);

  // Ce que Cairn attend de Pierre.
  const easyCeiling = Math.round(state.zones.find((z) => z.key === 'Z2')?.hrMax ?? 155);
  const asked = pendingQuestions({ today, sessions, activities: state.recentActivities, answers: state.answers, easyCeiling });
  lines.push('', '## En attente de Pierre');
  if (asked.length === 0) lines.push('- Rien.');
  for (const q of asked) lines.push(`- ${q.prompt} (${q.why})`);

  // Ce que les règles ont décidé ces derniers jours, dans l'ordre.
  // Une même décision qui a touché plusieurs séances se dit une fois, avec les jours qu'elle couvre.
  const grouped: { at: string; from: string; to: string; n: number; reason: string }[] = [];
  for (const r of (state.plan?.plan.revisionLog ?? []).filter((x) => daysBetween(x.at.slice(0, 10), today) <= 10)) {
    for (const c of r.changes) {
      const reason = first(c.reason);
      const last = grouped.at(-1);
      if (last && last.reason === reason && last.at === r.at.slice(0, 10)) {
        last.n++;
        if (c.date < last.from) last.from = c.date;
        if (c.date > last.to) last.to = c.date;
      } else grouped.push({ at: r.at.slice(0, 10), from: c.date, to: c.date, n: 1, reason });
    }
  }
  lines.push('', '## Décisions récentes');
  if (grouped.length === 0) lines.push('- Aucune en dix jours.');
  for (const g of grouped.slice(-8)) {
    const what = g.n === 1 ? `séance du ${dm(g.from)}` : `${g.n} séances du ${dm(g.from)} au ${dm(g.to)}`;
    lines.push(`- ${dm(g.at)}, ${what} : ${g.reason}`);
  }

  // Ce que Pierre a dit — douleurs, causes —, la matière des règles.
  const said = state.answers
    .filter((a) => daysBetween(a.answeredAt.slice(0, 10), today) <= 14 && a.question !== 'clearance' && a.question !== 'week_load')
    .sort((a, b) => a.answeredAt.localeCompare(b.answeredAt))
    .map((a) => {
      const v = a.value;
      const what = v.score != null ? `${v.score}${a.question === 'run_rpe' ? '/10 d\'effort' : '/10'}${v.site ? ` (${v.site})` : ''}` : v.cause ?? v.pattern ?? '';
      return `- ${dm(a.answeredAt.slice(0, 10))} ${a.question} ${a.subject} : ${what}`;
    });
  if (said.length > 0) lines.push('', '## Ce que Pierre a répondu (14 jours)', ...said);

  // Ce que Cairn ne sait pas : ce qui manque se dit, ne se comble pas.
  const unknown: string[] = [];
  const lastCheckIn = state.todayCheckIn?.date ?? known.lastCheckInDate;
  if (!lastCheckIn || daysBetween(lastCheckIn, today) > 3) {
    unknown.push(`sommeil, stress, fatigue : aucun point du jour depuis ${lastCheckIn ? `le ${dm(lastCheckIn)}` : 'le début'} — la disponibilité ne lit que la charge`);
  }
  const lastRun = [...state.recentActivities].sort((a, b) => b.startDateLocal.localeCompare(a.startDateLocal))[0];
  if (lastRun && lastRun.averageHr == null) unknown.push(`la dernière activité (${dm(lastRun.startDateLocal)}) n'a pas de fréquence cardiaque`);
  lines.push('', '## Ce que Cairn ne sait pas');
  lines.push(...(unknown.length ? unknown.map((u) => `- ${u}`) : ['- Rien de notable.']));

  lines.push(
    '',
    '_Lecture du jour, recalculée à chaque appel : elle fait foi sur tout ce qui a été dit plus haut dans la conversation._',
  );
  return lines.join('\n');
}
