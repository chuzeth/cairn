import type { DecisionOrigin, PlannedSession, SessionStatus, TrainingWeek } from '@cairn/core';

/**
 * Ce qu'une reconstruction n'a pas le droit de réécrire.
 *
 * Reconstruire un plan, c'est demander au planificateur d'écrire à nouveau
 * toutes les semaines qui restent. Tant qu'il écrivait par-dessus tout, il
 * emportait avec lui ce que personne ne lui avait demandé de refaire : les
 * jours déjà vécus, les séances réalisées, celles qu'une absence déclarée
 * avait retirées, et celles qu'un coach ou l'athlète avait ajustées à la main.
 * Le journal du plan gardait la trace de ces décisions ; les séances, non.
 *
 * Une séance qui porte une décision se reprend telle quelle, à sa date, avec
 * son identifiant, son statut et ses liens. Le plan neuf s'écrit autour.
 *
 * Module pur : aucune base, aucun réseau. La règle qui décide de la reprise
 * est la même que celle qui l'annonce en aperçu — ce que l'athlète voit avant
 * de cliquer est exactement ce qui sera fait.
 */

/**
 * Pourquoi une séance est reprise.
 *
 * Tout statut autre que `planned` est déjà une décision ou un fait acquis. Les
 * deux autres raisons couvrent ce qu'aucun statut ne dit : un jour passé, et
 * une séance à venir dont le contenu a été changé après coup.
 */
export type PreservationReason = Exclude<SessionStatus, 'planned'> | 'edited' | 'past';

export interface PreservedDecision {
  session: PlannedSession;
  reason: PreservationReason;
  /** Ce que la séance porte, en une phrase, pour l'aperçu comme pour le journal. */
  statement: string;
}

/** Une journée que la reconstruction change : ce qui était là, ce qui la remplace. */
export interface PlanChange {
  date: string;
  before: string | null;
  after: string | null;
  /**
   * Ce qui change entre les deux, quand ce n'est pas le titre : « charge 18 →
   * 21 », « D+ 414 → 420 m ». Deux séances peuvent porter le même nom et ne
   * pas peser la même chose, et c'est alors la seule façon de voir ce que la
   * reconstruction ferait.
   */
  differences: string[];
  /**
   * La séance écrite est celle qui était là : même titre, même charge, même
   * durée, même dénivelé. Elle est bien remplacée — nouvel identifiant, blocs
   * réécrits —, mais l'athlète ne verra pas la différence.
   *
   * La distinction existe pour que l'aperçu reste lisible : un plan de cinq
   * semaines rejoue à l'identique la quasi-totalité de ses journées, et une
   * liste de trente lignes indistinctes enterre la seule qui change.
   */
  identical: boolean;
}

export interface PlanCarryOver {
  /** Les semaines à écrire : le plan neuf, décisions reprises à leur place. */
  weeks: TrainingWeek[];
  /** Ce que la reconstruction reprend au lieu de le réécrire. */
  preserved: PreservedDecision[];
  /** Ce qu'elle remplace : une séance sans décision, contre celle qu'elle écrit. */
  replaced: PlanChange[];
  /** Ce qu'elle ajoute : un jour que le plan en place ne couvrait pas. */
  added: PlanChange[];
  /** Ce qu'elle retire : un jour prescrit que le plan neuf ne prescrit plus. */
  removed: PlanChange[];
}

const STATUS_STATEMENT: Record<Exclude<SessionStatus, 'planned'>, string> = {
  completed: 'réalisée',
  partial: 'réalisée en partie',
  replaced: "autre chose a été fait ce jour-là",
  missed: 'non réalisée',
  moved: 'déplacée',
  cancelled: 'annulée',
  withdrawn: 'retirée par une absence déclarée',
};

const ORIGIN_LABEL: Record<DecisionOrigin, string> = {
  athlete: "par l'athlète",
  coach: 'par le coach',
  rules: 'par les règles de charge',
  developer: 'par un appel direct à l\'API',
};

/** Comment nommer la provenance d'une décision, pour un humain. */
export const describeOrigin = (origin: DecisionOrigin): string => ORIGIN_LABEL[origin];

/**
 * La décision que porte une séance, s'il y en a une.
 *
 * L'ordre compte : un statut est plus précis qu'une modification, et une
 * modification est plus précise que « c'était hier ».
 */
export function decisionOn(session: PlannedSession, today: string): PreservedDecision | null {
  if (session.status !== 'planned') {
    return { session, reason: session.status, statement: STATUS_STATEMENT[session.status] };
  }
  if (session.decision) {
    const { at, by, summary } = session.decision;
    return {
      session,
      reason: 'edited',
      statement: `modifiée le ${at.slice(0, 10)} ${ORIGIN_LABEL[by]} — ${summary}`,
    };
  }
  if (session.date < today) {
    return { session, reason: 'past', statement: 'jour passé' };
  }
  return null;
}

const sessionsOf = (weeks: readonly TrainingWeek[]): PlannedSession[] =>
  weeks.flatMap((w) => w.sessions);

/** Le titre d'une séance, ou rien quand il n'y en a pas ce jour-là. */
const titleOf = (s: PlannedSession | undefined): string | null => s?.title ?? null;

const minutes = (s: number) => `${Math.round(s / 60)} min`;

/**
 * Ce qui change d'une séance à celle qui la remplace, dans les termes où
 * l'athlète la lit. Vide : rien n'a bougé pour lui.
 *
 * La comparaison porte sur la valeur **affichée**, pas sur la valeur brute :
 * deux secondes d'écart sur une heure produiraient « durée 39 min → 39 min »,
 * une ligne qui occupe la place d'une information sans en être une.
 */
function differencesBetween(before: PlannedSession, after: PlannedSession): string[] {
  const out: string[] = [];
  const say = (
    label: string,
    a: number | undefined,
    b: number | undefined,
    fmt: (v: number) => string = String,
  ) => {
    if (a == null || b == null) return;
    const [x, y] = [fmt(a), fmt(b)];
    if (x === y) return;
    out.push(`${label} ${x} → ${y}`);
  };
  if (before.title !== after.title) out.push(`« ${before.title} » → « ${after.title} »`);
  say('charge', before.plannedLoad, after.plannedLoad);
  say('charge mécanique', before.plannedMechanicalLoad, after.plannedMechanicalLoad);
  say('durée', before.plannedDurationS, after.plannedDurationS, minutes);
  say('D+', before.plannedElevationGainM, after.plannedElevationGainM, (v) => `${v} m`);
  return out;
}

/**
 * Reporte les décisions du plan en place dans le plan que le planificateur
 * vient d'écrire, et dit ce que la reconstruction ferait.
 *
 * Les jours que le plan neuf ne couvre pas — les semaines déjà écoulées, que
 * la reconstruction démarre après — gardent leur semaine d'origine : sans
 * elles, la reconstruction viderait le registre d'observance en même temps
 * qu'elle écrit l'avenir.
 */
export function carryDecisions(
  previous: readonly TrainingWeek[],
  fresh: readonly TrainingWeek[],
  today: string,
): PlanCarryOver {
  const decisions = new Map<string, PreservedDecision>();
  const previousByDate = new Map<string, PlannedSession>();
  const previousWeekOf = new Map<string, TrainingWeek>();
  for (const week of previous) {
    for (const s of week.sessions) {
      previousByDate.set(s.date, s);
      previousWeekOf.set(s.date, week);
      const decision = decisionOn(s, today);
      if (decision) decisions.set(s.date, decision);
    }
  }

  const freshByDate = new Map<string, PlannedSession>();
  for (const s of sessionsOf(fresh)) freshByDate.set(s.date, s);

  // Le plan neuf, la décision mise à la place de la séance que le
  // planificateur avait écrite pour ce jour-là.
  const weeks: TrainingWeek[] = fresh.map((w) => ({
    ...w,
    sessions: w.sessions.map((s) => decisions.get(s.date)?.session ?? s),
  }));

  // Les décisions que le plan neuf ne recouvre pas rejoignent la semaine
  // qu'elles avaient, recréée au besoin.
  const covered = new Set(weeks.map((w) => w.weekStart));
  const orphans = [...decisions.values()].filter((d) => !freshByDate.has(d.session.date));
  const rebuilt = new Map<string, TrainingWeek>();
  for (const { session } of orphans) {
    const week = previousWeekOf.get(session.date)!;
    if (covered.has(week.weekStart)) {
      weeks.find((w) => w.weekStart === week.weekStart)!.sessions.push(session);
      continue;
    }
    const held = rebuilt.get(week.weekStart) ?? { ...week, sessions: [] };
    held.sessions.push(session);
    rebuilt.set(week.weekStart, held);
  }

  const all = [...rebuilt.values(), ...weeks]
    .sort((a, b) => a.weekStart.localeCompare(b.weekStart))
    .map((w, index) => ({
      ...w,
      index,
      sessions: [...w.sessions].sort((a, b) => a.date.localeCompare(b.date)),
    }));

  const dates = new Set([...previousByDate.keys(), ...freshByDate.keys()]);
  const replaced: PlanChange[] = [];
  const added: PlanChange[] = [];
  const removed: PlanChange[] = [];
  for (const date of [...dates].sort()) {
    if (decisions.has(date)) continue;
    const before = previousByDate.get(date);
    const after = freshByDate.get(date);
    if (before && after) {
      const differences = differencesBetween(before, after);
      replaced.push({
        date,
        before: titleOf(before),
        after: titleOf(after),
        differences,
        identical: differences.length === 0,
      });
    } else if (after) {
      added.push({ date, before: null, after: titleOf(after), differences: [], identical: false });
    } else if (before) {
      removed.push({ date, before: titleOf(before), after: null, differences: [], identical: false });
    }
  }

  return {
    weeks: all,
    preserved: [...decisions.values()].sort((a, b) => a.session.date.localeCompare(b.session.date)),
    replaced,
    added,
    removed,
  };
}

/** Une ligne par mouvement, dans l'ordre des dates : le diff tel qu'il se lit. */
export function describeCarryOver(carry: PlanCarryOver): string[] {
  return [
    ...carry.preserved.map((d) => `${d.session.date} — conservée : ${d.session.title} (${d.statement})`),
    ...carry.replaced
      .filter((c) => !c.identical)
      .map((c) => `${c.date} — remplacée : ${c.differences.join(', ')}`),
    ...carry.added.map((c) => `${c.date} — ajoutée : ${c.after}`),
    ...carry.removed.map((c) => `${c.date} — retirée : ${c.before}`),
  ].sort();
}
