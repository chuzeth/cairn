import type {
  DecisionOrigin, PhysiologyModel, PlannedSession, SessionBlock, SessionHistoryEntry,
} from '@cairn/core';
import { anchorRelativeDates, sessionDuration, writtenOn } from '@cairn/core';
import { DURABILITY_MEASURABLE } from '@cairn/physiology';
import { locateVertical } from './plausibility.js';
import * as lib from './sessionLibrary.js';
import type { TerrainHint } from './terrain.js';

/**
 * La présentation d'une séance : ce qui se lit, par opposition à ce qui se fait.
 *
 * Une séance décidée — par le coach, par l'athlète, par les règles de charge —
 * l'est dans son contenu : date, type, durée, dénivelé, charge. Son commentaire
 * n'est pas la décision. Une reconstruction reprenait pourtant tout, textes
 * compris : le test maximal du 22/09 et la rando-course du 27/09 gardaient un
 * « pourquoi » de 2 713 et 2 136 caractères, et une consigne qui parlait du
 * « soir » où elle avait été écrite. Le contenu reste intact ; la présentation
 * suit les règles du jour, comme pour toute séance ; et ce qu'elle remplace
 * — raisonnement, consignes — passe dans l'historique de la séance, daté, à un
 * geste de distance.
 *
 * Module pur : ni base, ni réseau.
 */

export interface PresentationContext {
  model: PhysiologyModel;
  /** Le terrain de l'athlète : c'est par lui qu'une rando-course nomme sa montée. */
  terrain?: TerrainHint;
}

/**
 * La première phrase d'un texte.
 *
 * Une phrase finit sur un point suivi d'une majuscule, d'un guillemet ou de la
 * fin du texte : « 1,5 » ou « km/h. » au milieu d'une phrase ne la coupent pas.
 */
export function firstSentence(text: string): string {
  const t = text.trim();
  return /^.*?[.!?…](?=\s+[\p{Lu}«"(—]|\s*$)/su.exec(t)?.[0] ?? t;
}

/** Vrai quand un texte tient en une phrase. */
export const isOneSentence = (text: string): boolean => firstSentence(text) === text.trim();

/**
 * Ajoute une entrée à l'historique d'une séance, dates relatives ancrées sur le
 * jour où elle a été écrite. Une entrée vide n'en est pas une.
 */
export function withHistory(
  history: readonly SessionHistoryEntry[] | undefined,
  entry: SessionHistoryEntry,
): SessionHistoryEntry[] {
  const text = anchorRelativeDates(entry.text.trim(), entry.at);
  const notes = entry.notes?.map((n) => anchorRelativeDates(n, entry.at)).filter(Boolean);
  if (!text && !notes?.length) return [...(history ?? [])];
  return [...(history ?? []), { at: entry.at, by: entry.by, text, ...(notes?.length ? { notes } : {}) }];
}

const BY: Record<DecisionOrigin, string> = {
  coach: 'par le coach',
  athlete: 'par toi',
  rules: 'par les règles de charge',
  developer: "par un appel direct à l'API",
};

/** La décision, dite en tête de phrase : « fixée par le coach le 18/09 ». */
const decided = (s: PlannedSession) =>
  s.decision ? `${BY[s.decision.by]} le ${writtenOn(s.decision.at)}` : '';

const measuresDurability = (s: Pick<PlannedSession, 'blocks' | 'plannedDurationS'>) =>
  s.plannedDurationS >= DURABILITY_MEASURABLE.minDurationS &&
  lib.elevationGainOf(s.blocks) >= DURABILITY_MEASURABLE.minVertM;

/**
 * Le « pourquoi » d'une séance décidée, en une phrase concrète.
 *
 * Il dit qui l'a fixée, quand, et ce qu'elle fait — pas le raisonnement qui y a
 * mené : celui-là est dans l'historique. Une décision des règles de charge se
 * dit par sa première phrase, qui nomme le signal qui l'a déclenchée.
 */
export function decidedWhy(s: PlannedSession, model: PhysiologyModel): string {
  const by = decided(s);
  if (s.decision?.by === 'rules') {
    const signal = anchorRelativeDates(firstSentence(s.decision.summary), s.decision.at);
    return `Ajustée ${by} — ${signal}`.replace(/\s*[.…]?$/, '.');
  }
  if (lib.isMaximalTest(s, model)) {
    const effort = s.blocks.find((b) => b.zone === 'Z5' || (b.hrRange?.[0] ?? 0) >= model.vt2.hr);
    const min = Math.round((effort?.durationS ?? 0) / 60);
    return `Test maximal fixé ${by} : ${min} min à fond sur le plat, la seule mesure qui ancre ta vitesse critique.`;
  }
  if (s.type === 'long_trail') {
    const what = `${sessionDuration(s.plannedDurationS)} et ${lib.elevationGainOf(s.blocks)} m D+`;
    return measuresDurability(s)
      ? `Rando-course fixée ${by} à ${what} : de quoi mesurer ta durabilité et préparer tes quadriceps à la descente.`
      : `Rando-course fixée ${by} à ${what}, en terrain de course.`;
  }
  const vert = lib.titleVertical(s.type, s.blocks);
  const mention = vert.m > 50 ? `, ${vert.m} m D${vert.sign}` : '';
  return `Séance fixée ${by} : ${sessionDuration(s.plannedDurationS)}${mention}.`;
}

/** Ce qu'une présentation a remplacé, en toutes lettres : titre, intention, consignes. */
function replaced(before: PlannedSession, after: Pick<PlannedSession, 'title' | 'intent' | 'blocks'>): string[] {
  const out: string[] = [];
  if (before.intent && before.intent !== after.intent) out.push(`Intention : ${before.intent}`);
  const kept = new Set(after.blocks.map((b) => b.notes).filter(Boolean));
  for (const b of before.blocks) {
    if (b.notes && !kept.has(b.notes)) out.push(`${b.label} : ${b.notes}`);
  }
  return out;
}

/**
 * La forme que les règles du jour donnent à un contenu décidé, quand elles en
 * ont une et qu'elle ne le change pas.
 *
 * Une rando-course se présente comme elle se court — une durée, un dénivelé,
 * une règle de marche : « 3 h, 680 m D+ » présentée ainsi reste « 3 h, 680 m
 * D+ ». Un test maximal garde ses blocs et ses cibles, et prend les mots des
 * tests. Ailleurs, les blocs restent ceux qui ont été décidés.
 */
function formFor(
  s: PlannedSession,
  ctx: PresentationContext,
): Pick<PlannedSession, 'title' | 'intent' | 'blocks'> | null {
  const { model } = ctx;
  if (s.type === 'long_trail' && s.blocks.length > 0) {
    // Un contenu dont les blocs ne portent pas le dénivelé décidé n'est pas une
    // rando-course qu'on puisse présenter autrement sans la changer.
    const gain = lib.elevationGainOf(s.blocks);
    if (gain !== Math.round(s.plannedElevationGainM ?? gain)) return null;
    const t = lib.longTrail(model, s.plannedDurationS / 60, gain, ctx.terrain);
    const intact =
      t.durationS === s.plannedDurationS &&
      t.elevationGainM === gain &&
      t.elevationLossM === lib.elevationLossOf(locateVertical(s.blocks, s.type));
    return intact ? { title: t.title, intent: t.intent, blocks: t.blocks } : null;
  }
  if (lib.isMaximalTest(s, model)) {
    const blocks = lib.timeTrialPresentation(s.blocks, model);
    const effort = blocks.find((b) => b.label.startsWith('Contre-la-montre'));
    const min = Math.round((effort?.durationS ?? 0) / 60);
    const t = lib.timeTrial(model, min);
    return { title: lib.sessionTitle(`Test maximal ${min} min`, s.type, blocks), intent: t.intent, blocks };
  }
  return null;
}

/**
 * Re-présente une séance décidée : contenu intact, présentation du jour.
 *
 * Le contenu, c'est la date, le type, la durée, le dénivelé et la charge, tels
 * qu'ils ont été décidés : ils sont repris à l'identique, et les blocs qu'on
 * présente les portent — même durée, même dénivelé. La présentation, c'est le
 * titre, l'intention, la phrase de « pourquoi » et les consignes : elles sont
 * celles que les règles écrivent aujourd'hui.
 *
 * Ce qu'elle remplace n'est pas effacé. Le raisonnement de la décision et les
 * consignes qui l'accompagnaient rejoignent l'historique, une fois, datés du
 * jour de la décision et leurs dates relatives ancrées sur lui : une seconde
 * reconstruction trouve l'entrée et n'en ajoute pas.
 */
export function presentDecided(s: PlannedSession, ctx: PresentationContext): PlannedSession {
  if (!s.decision) return s;
  const { at, by } = s.decision;
  const form = formFor(s, ctx);

  // Ailleurs que dans une forme connue, les blocs décidés restent, sur la
  // maille ronde quand elle ne change pas leur durée, et leurs consignes se
  // relisent n'importe quel jour.
  const own = (): SessionBlock[] => {
    const snapped = lib.snapToHumanGrid(s.blocks);
    const blocks = lib.totalDuration(snapped) === lib.totalDuration(s.blocks) ? snapped : s.blocks.map((b) => ({ ...b }));
    return blocks.map((b) => (b.notes ? { ...b, notes: anchorRelativeDates(b.notes, at) } : b));
  };
  const blocks = form?.blocks ?? own();
  // Une séance allégée par les règles le reste : c'est ce que sa décision a fait.
  const lightened = / · allégée$/.test(s.title) ? ' · allégée' : '';
  const title = `${form?.title ?? lib.retitleFromContent({ title: s.title, type: s.type, blocks })}${lightened}`;
  const intent = form?.intent ?? anchorRelativeDates(s.intent, at);

  const recorded = (s.history ?? []).some((h) => h.at === at);
  const history = recorded
    ? s.history
    : withHistory(s.history, {
        at,
        by,
        text: s.rationale?.trim() || s.decision.summary,
        notes: replaced(s, { title, intent, blocks }),
      });

  // Le résumé de la décision est un texte enregistré comme un autre : il se
  // relit n'importe quel jour.
  const decision = { ...s.decision, summary: anchorRelativeDates(s.decision.summary, at) };
  const presented: PlannedSession = {
    ...s, title, intent, blocks, decision, ...(history?.length ? { history } : {}),
  };
  return { ...presented, rationale: decidedWhy(presented, ctx.model) };
}

/**
 * Le « pourquoi » d'une séance qui n'a qu'une raison d'être là et, à part, ce
 * que sa construction a dû céder.
 *
 * Le planificateur accolait l'un à l'autre : « Séance clef le jeudi… » suivi de
 * trois phrases sur le dénivelé qu'il avait fallu rendre, 614 caractères sous
 * « pourquoi ». La raison reste ; le reste va à l'historique, daté.
 */
export function withConstruction(
  s: PlannedSession,
  reason: string | undefined,
  construction: readonly string[],
  at: string,
): PlannedSession {
  const text = construction.filter(Boolean).join(' ');
  const history = text ? withHistory(s.history, { at, by: 'planner', text }) : s.history;
  return {
    ...s,
    ...(reason ? { rationale: reason } : {}),
    ...(history?.length ? { history } : {}),
  };
}
