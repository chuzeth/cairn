import type {
  DecisionOrigin, PhysiologyModel, PlannedSession, SessionBlock, SessionHistoryEntry,
} from '@cairn/core';
import { anchorRelativeDates, decimal, sessionDuration, signedDecimal, writtenOn } from '@cairn/core';
import { DURABILITY_MEASURABLE } from '@cairn/physiology';
import { firstDescentNote } from './eccentric.js';
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

// ─────────────────────────────────────────────────────────────────────────────
// Les mots de Pierre
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pierre lit Cairn sans en connaître le vocabulaire. Ce qui s'adresse à lui
 * passe donc par ici, pour que les mêmes règles s'appliquent partout d'un coup :
 *
 *  · on lui parle à lui, à la deuxième personne — jamais « l'athlète » ;
 *  · d'abord ce que ça change pour lui — des secondes sur sa course, des minutes
 *    sur sa séance, un geste à faire —, puis le pourquoi en une phrase ;
 *  · aucun terme interne sans sa traduction : un chiffre du modèle s'écrit avec
 *    ce qu'il signifie ;
 *  · les nombres s'écrivent à la française.
 *
 * Le mécanisme complet n'est pas perdu pour autant : il tient dans un second
 * paragraphe, séparé par une ligne vide, que l'écran range sous un pli. Rien
 * n'est retiré au modèle — c'est l'ordre de lecture qui change.
 */

/** Ce qu'un écart coûte sur une course : « 11 secondes », « 3 minutes ». */
export const raceTime = (seconds: number): string => {
  const s = Math.round(Math.abs(seconds));
  if (s < 120) return `${s} seconde${s > 1 ? 's' : ''}`;
  const min = Math.round(s / 60);
  return `${min} minute${min > 1 ? 's' : ''}`;
};

/** Ce que « fraîcheur » veut dire, dit une fois, là où le chiffre apparaît. */
export const FRESHNESS_MEANS =
  'ta forme de fond moins la fatigue des derniers jours — plus le nombre est haut, plus tu pars reposé';

/**
 * Un texte en deux temps : ce que ça change, puis le mécanisme.
 *
 * La ligne vide n'est pas une mise en page, c'est la coupure que l'écran lit
 * pour ranger le second sous un pli — et que le coach lit, lui, en entier.
 */
export const twoParts = (plain: string, mechanism: string): string => `${plain}\n\n${mechanism}`;

/** Ce qu'un texte en deux temps dit d'abord. */
export const firstParagraph = (text: string): string => text.split('\n\n')[0] ?? text;

export interface TaperGap {
  /** Le jour de la course, tel qu'il s'écrit : « 18/10 ». */
  raceDay: string;
  /** Fraîcheur visée à la veille de la course, et celle que le plan y amène. */
  target: number;
  projected: number;
  /** Ce que l'écart coûte sur la course, s, et le temps prédit, s. Nuls si personne ne l'a mesuré. */
  costS: number;
  predictedS: number;
  /** L'affûtage bute sur l'une de ses bornes. */
  atFloor: boolean;
  atCeiling: boolean;
  /** Profondeur retenue, en multiple de la profondeur habituelle. */
  taperScale: number;
  weeks: number;
  taperWeeks: number;
  /** Forme de fond au départ du plan, en points. */
  startCtl: number;
  maxWeeklyHours: number;
}

/**
 * L'écart à la fraîcheur visée, dit à Pierre.
 *
 * Ce qu'il en retient tient en trois phrases : ce qu'il perdra le jour J en
 * secondes, pourquoi on ne va pas le chercher, et ce qu'il a à faire — rien,
 * le plus souvent. Le compte complet — profondeur d'affûtage, semaines, forme
 * de fond de départ, points de fraîcheur manquants — le suit, à un geste.
 *
 * Une cible manquée par le haut ne se dit pas en secondes : le jour J, plus de
 * fraîcheur ne coûte pas de temps, c'est le fond qui manque, et le temps qu'il
 * coûte n'est pas dans cet écart-là.
 */
export function taperGapText(g: TaperGap): string {
  const depth = `L'affûtage est à ${Math.round(g.taperScale * 100)} % de sa profondeur habituelle`;
  const frame =
    `${g.weeks} semaine${g.weeks > 1 ? 's' : ''} dont ${g.taperWeeks} d'affûtage, ` +
    `en partant d'une forme de fond de ${Math.round(g.startCtl)} points`;
  const scale =
    `${signedDecimal(g.projected)} contre ${signedDecimal(g.target)} visés — la fraîcheur, c'est ${FRESHNESS_MEANS}.`;

  if (g.projected < g.target) {
    const cost = g.costS > 0 && g.predictedS > 0
      ? ` : ${raceTime(g.costS)} sur ${sessionDuration(g.predictedS)}`
      : '';
    const why = g.atFloor
      ? 'Alléger davantage te ferait perdre plus de forme que tu ne gagnerais de fraîcheur.'
      : "D'ici là, il n'y a pas assez de semaines pour aller chercher le reste.";
    const floor = g.atFloor
      ? ", son plancher : en dessous, ta forme de fond se perdrait plus vite que la fatigue ne s'évacue, " +
        'et la fraîcheur gagnée coûterait la forme.'
      : '.';
    const missing = Math.abs(g.target - g.projected);
    return twoParts(
      `Tu seras un peu moins frais que l'idéal le ${g.raceDay}${cost}. ${why} Rien à faire.`,
      `${depth}${floor} ${frame} : il manque ${decimal(missing)} point${missing >= 2 ? 's' : ''} de ` +
        `fraîcheur, ${scale}`,
    );
  }
  return twoParts(
    `Le ${g.raceDay}, tu partiras plus reposé que l'idéal, mais moins entraîné : tes ` +
      `${g.maxWeeklyHours} h par semaine ne laissent pas la place de construire plus de fond d'ici là. ` +
      `Rien à faire, sinon courir davantage chaque semaine — et ça se décide, ça ne se rattrape pas.`,
    `${depth}${g.atCeiling ? ", son plafond — au-delà, la fin de préparation ne serait plus un affûtage" : ''}. ` +
      `${frame}, ${g.maxWeeklyHours} h par semaine au plus : cette charge ne construit pas le fond qu'une ` +
      `fraîcheur de ${signedDecimal(g.target)} suppose. ${scale}`,
  );
}

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
  if (s.type === 'long_trail') return trailForm(s, ctx);
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
 * Une rando-course telle qu'elle se court — une durée, un dénivelé, une règle
 * de marche, et la montée qui porte ce dénivelé quand le terrain en connaît une
 * —, pourvu que cette forme ne change pas son contenu.
 */
function trailForm(
  s: PlannedSession,
  ctx: PresentationContext,
): Pick<PlannedSession, 'title' | 'intent' | 'blocks'> | null {
  if (s.blocks.length === 0) return null;
  // Un contenu dont les blocs ne portent pas le dénivelé décidé n'est pas une
  // rando-course qu'on puisse présenter autrement sans la changer.
  const gain = lib.elevationGainOf(s.blocks);
  if (gain !== Math.round(s.plannedElevationGainM ?? gain)) return null;
  const t = lib.longTrail(ctx.model, s.plannedDurationS / 60, gain, ctx.terrain);
  const intact =
    t.durationS === s.plannedDurationS &&
    t.elevationGainM === gain &&
    t.elevationLossM === lib.elevationLossOf(locateVertical(s.blocks, s.type));
  return intact ? { title: t.title, intent: t.intent, blocks: t.blocks } : null;
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

export interface TerrainContext extends PresentationContext {
  /** Ce qui est avant ne se réécrit pas. */
  today: string;
  /** Séances de descente faites avant `today` : sans aucune, la première à venir le dit. */
  descentsDone: number;
}

/**
 * Pose sur le terrain de l'athlète les séances de terrain à venir, sans rien
 * reconstruire.
 *
 * Une descente que personne n'a décidée est posée sur sa montée (`layDescent`) :
 * tronçon, remontée à pied, consigne d'effort, et la durée qui suit. La première
 * descente à venir dit ce que ses courbatures toucheront. Une rando-course prend
 * la forme des règles du jour, qui nomment sa montée : décidée, par
 * `presentDecided` ; sinon par la même forme, quand elle ne change rien à son
 * contenu. Une séance décidée d'un autre type, passée ou réalisée est rendue
 * telle quelle — la même instance.
 *
 * C'est le chemin du planificateur comme de la relève : une séance se pose de
 * la même façon, qu'elle vienne d'être écrite ou qu'elle attende son jour.
 */
export function onTerrain(sessions: readonly PlannedSession[], ctx: TerrainContext): PlannedSession[] {
  const upcoming = (s: PlannedSession) => s.date >= ctx.today && s.status === 'planned';
  // La première descente à venir, faute d'aucune de faite : celle qui dit quoi
  // ménager. Une descente prévue compte dès qu'elle précède — celle d'après
  // n'est plus une première.
  const first = ctx.descentsDone > 0
    ? undefined
    : [...sessions]
        .filter((s) => upcoming(s) && s.type === 'downhill')
        .sort((a, b) => a.date.localeCompare(b.date))[0];

  return sessions.map((s) => {
    if (!upcoming(s)) return s;
    if (s.type === 'downhill') {
      // Une descente décidée l'est dans son contenu, durées comprises.
      if (s.decision) return s;
      const exposure = s === first ? firstDescentNote(s.date, sessions) : undefined;
      const laid = lib.layDescent(s, ctx.model, ctx.terrain, exposure);
      return laid ? { ...s, ...laid } : s;
    }
    if (s.type === 'long_trail') {
      if (s.decision) return presentDecided(s, ctx);
      const form = trailForm(s, ctx);
      return form ? { ...s, ...form } : s;
    }
    return s;
  });
}
