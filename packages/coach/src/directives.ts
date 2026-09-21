import type {
  AppliedDirective, AthleteAmbition, BlockKind, CadenceDirective, DescribedDirective,
  IntervalFormat, IntervalPolicyDirective, PlannedSession, SessionBlock, SessionDurationDirective,
  SessionSuccessCriterion, SessionType, SuccessCriterionDirective, TrainingDirective,
  WeeklyFrequencyDirective,
} from '@cairn/core';
import { DURABILITY_MEASURABLE, formatDuration } from '@cairn/physiology';
import { elevationGainOf, isPrescribed, totalDuration } from './sessionLibrary.js';

/**
 * Application des directives du dossier.
 *
 * `packages/core/src/prescription.ts` traduit la prose du compte rendu en
 * consignes ; ce module est le seul endroit qui les fait agir sur une semaine.
 * La séparation est volontaire : la lecture du document ne dépend pas du
 * planificateur, et le planificateur n'a aucun moyen d'inventer une consigne
 * qui ne serait pas au dossier.
 *
 * Une directive appliquée laisse une trace sur la séance (`directives`), avec
 * l'extrait qui la fonde. C'est la même exigence que la provenance d'un
 * paramètre physiologique : ce qu'on demande à l'athlète doit être remontable
 * jusqu'à la phrase qui l'a demandé. Ce que la directive produit sur la séance
 * ne s'écrit pas dans la trace : il se lit sur le contenu (`describeDirectives`).
 */

export interface DirectiveSet {
  all: TrainingDirective[];
  duration: SessionDurationDirective[];
  criteria: SuccessCriterionDirective[];
  frequency: WeeklyFrequencyDirective[];
  cadence?: CadenceDirective;
  intervals?: IntervalPolicyDirective;
}

export function indexDirectives(list: readonly TrainingDirective[] = []): DirectiveSet {
  const set: DirectiveSet = { all: [...list], duration: [], criteria: [], frequency: [] };
  for (const d of list) {
    switch (d.kind) {
      case 'session_duration': set.duration.push(d); break;
      case 'success_criterion': set.criteria.push(d); break;
      case 'weekly_frequency': set.frequency.push(d); break;
      case 'cadence_target': set.cadence = d; break;
      case 'interval_policy': set.intervals = d; break;
    }
  }
  return set;
}

// ─────────────────────────────────────────────────────────────────────────────
// Fractionnés
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Ce qui compte comme fractionné, et sous quel format.
 *
 * La distinction n'est pas cosmétique : le compte rendu limite les fractionnés
 * à un par semaine, mais range explicitement la résistance douce — tempo,
 * fartlek vallonné — parmi les séances intenses qui restent permises. Confondre
 * les deux ferait soit deux fractionnés dans la semaine, soit une semaine vide
 * d'intensité.
 */
export const INTERVAL_FORMAT: Partial<Record<SessionType, IntervalFormat>> = {
  vo2max: 'short',
  hill_repeats: 'short',
  threshold: 'medium',
};

export function isIntervalSession(type: SessionType): boolean {
  return INTERVAL_FORMAT[type] !== undefined;
}

/**
 * Format du prochain fractionné.
 *
 * Le compteur porte sur les fractionnés effectivement prescrits, pas sur les
 * semaines : une semaine sans fractionné — parce que la phase donne la priorité
 * à l'allure spécifique — ne doit pas faire sauter un tour à l'alternance.
 */
export function nextIntervalFormat(
  policy: IntervalPolicyDirective | undefined,
  countSoFar: number,
): IntervalFormat {
  const cycle = policy?.alternate?.length ? policy.alternate : (['short', 'medium'] as const);
  return cycle[countSoFar % cycle.length] as IntervalFormat;
}

/**
 * Ce que les répétitions d'un fractionné durent, et si c'est ce que le dossier
 * prescrit.
 *
 * Le compte rendu ne dit pas seulement combien de fractionnés par semaine : il
 * dit de quoi ils sont faits — 3 à 12 min pour le moyen, 30 s à 1 min pour le
 * court. Ces bornes n'existaient nulle part dans le code, et la seule chose qui
 * les respectait était le choix de paramètres du planificateur. Rien ne les
 * vérifiait après coup, et un allègement les quittait sans un mot.
 *
 * Le contrôle se lit sur le contenu actuel, comme les autres effets de
 * directive : une séance réécrite se juge sur ce qu'elle est devenue.
 */
export interface IntervalFormatCheck {
  format: IntervalFormat;
  spec: NonNullable<IntervalPolicyDirective['formats'][IntervalFormat]>;
  /** Durées de répétition trouvées sur les blocs répétés, s. */
  workS: number[];
  /** Ce qui sort de la fenêtre prescrite, en clair. Vide quand tout y est. */
  offences: string[];
}

export function checkIntervalFormat(
  session: Pick<PlannedSession, 'type' | 'blocks'>,
  policy: IntervalPolicyDirective | undefined,
): IntervalFormatCheck | null {
  // La fenêtre est celle du format *qui décrit cette séance*, pas celle du
  // créneau qu'elle occupe dans l'alternance : les côtes comptent comme le
  // fractionné court de la semaine, et le document ne leur donne aucune durée
  // de répétition. Leur opposer celle de la PMA serait inventer une consigne.
  const entries = Object.entries(policy?.formats ?? {}) as [
    IntervalFormat,
    NonNullable<IntervalPolicyDirective['formats'][IntervalFormat]>,
  ][];
  const found = entries.find(([, spec]) => spec.appliesTo.includes(session.type));
  if (!found) return null;
  const [format, spec] = found;

  // Un bloc de travail est un bloc qu'une récupération suit, qu'il soit répété
  // ou non : les paliers d'une pyramide sont prescrits un par un, et la fenêtre
  // de 3 à 12 min du dossier vaut pour eux comme pour des répétitions égales.
  const work = session.blocks.filter(
    (b) => !isPrescribed(b) && b.durationS && ((b.repeat ?? 1) > 1 || b.recovery),
  );
  const workS = work.map((b) => b.durationS as number);
  const offences: string[] = [];
  const window = `${formatDuration(spec.minWorkS)}-${formatDuration(spec.maxWorkS)}`;

  for (const b of work) {
    const d = b.durationS as number;
    if (d >= spec.minWorkS && d <= spec.maxWorkS) continue;
    offences.push(
      `« ${b.label} » : répétitions de ${formatDuration(d)}, hors de la plage ${window} prescrite.`,
    );
  }
  if (spec.hr) {
    for (const b of work) {
      const hr = b.hrRange;
      if (!hr || (hr[0] >= spec.hr[0] && hr[1] <= spec.hr[1])) continue;
      offences.push(
        `« ${b.label} » : cible ${hr[0]}-${hr[1]} bpm, hors de la fenêtre ${spec.hr[0]}-${spec.hr[1]} bpm prescrite.`,
      );
    }
  }
  return { format, spec, workS, offences };
}

// ─────────────────────────────────────────────────────────────────────────────
// Durées, cadence, critères
// ─────────────────────────────────────────────────────────────────────────────

export function durationDirectiveFor(
  set: DirectiveSet,
  type: SessionType,
): SessionDurationDirective | undefined {
  return set.duration.find((d) => d.appliesTo.includes(type));
}

export function criteriaFor(set: DirectiveSet, type: SessionType): SessionSuccessCriterion[] {
  return set.criteria
    .filter((d) => d.appliesTo.includes(type))
    .map((d) => ({ metric: d.metric, ...(d.maxValue != null ? { maxValue: d.maxValue } : {}), origin: d.origin }));
}

/**
 * Ramène les cibles de cadence dans la fenêtre prescrite.
 *
 * La bibliothèque de séances demandait jusqu'à 182 ppm en descente et en PMA,
 * au-dessus de la cible 170-180 du compte rendu. Une cible hors fenêtre n'est
 * pas un détail : c'est la seule consigne technique que l'athlète peut suivre
 * en temps réel.
 */
export function clampCadence(
  blocks: readonly SessionBlock[],
  cadence: CadenceDirective | undefined,
): { blocks: SessionBlock[]; changed: boolean } {
  if (!cadence) return { blocks: [...blocks], changed: false };
  let changed = false;
  const out = blocks.map((b) => {
    if (b.cadenceTargetSpm == null) return b;
    const clamped = Math.min(cadence.maxSpm, Math.max(cadence.minSpm, b.cadenceTargetSpm));
    if (clamped === b.cadenceTargetSpm) return b;
    changed = true;
    return { ...b, cadenceTargetSpm: clamped };
  });
  return { blocks: out, changed };
}

// ─────────────────────────────────────────────────────────────────────────────
// Fréquences hebdomadaires
// ─────────────────────────────────────────────────────────────────────────────

const BLOCK_LABEL: Record<BlockKind, string> = {
  mobility: 'Souplesse chaîne postérieure',
  respiratory: 'Travail respiratoire',
};

const BLOCK_NOTES: Record<BlockKind, string> = {
  mobility:
    'Ischio-jambiers, mollets, chaîne postérieure du rachis. Maintiens de 45 s, deux passages, ' +
    'sans à-coups. Le déficit relevé au test (flexion avant à −1 cm) ne se corrige que par la répétition.',
  respiratory:
    "Respiration diaphragmatique allongé : 5 min à 6 cycles/min, expiration deux fois plus longue que " +
    "l'inspiration. Puis 30 respirations contre résistance inspiratoire (EMT) si tu en disposes. " +
    "On vise le coefficient d'utilisation pulmonaire, pas l'essoufflement.",
};

/** Un bloc annexe, non couru : ni allure, ni fréquence cardiaque à tenir. */
export function ancillaryBlock(kind: BlockKind, durationS: number): SessionBlock {
  return { label: BLOCK_LABEL[kind], kind, zone: 'Z1', durationS, notes: BLOCK_NOTES[kind] };
}

/** Types de séance auxquels un bloc annexe peut s'adosser, du plus au moins indiqué. */
const ANCILLARY_HOSTS: SessionType[] = ['recovery', 'endurance', 'long_run', 'long_trail'];

/**
 * Honore les fréquences hebdomadaires en complétant ce qui manque.
 *
 * Les blocs déjà présents comptent — le renforcement porte sa propre séquence
 * de souplesse. On n'en ajoute jamais un jour de repos : ce jour a une fonction,
 * et l'occuper reviendrait à ne plus avoir de jour de repos.
 */
export function honourWeeklyFrequency(
  sessions: PlannedSession[],
  set: DirectiveSet,
): void {
  for (const directive of set.frequency) {
    const existing = sessions.filter((s) => s.blocks.some((b) => b.kind === directive.block));
    // Une séance qui portait déjà le bloc — le renforcement a sa propre séquence
    // de souplesse — porte aussi son origine : sinon l'athlète voit la consigne
    // sur un jour et pas sur l'autre, pour la même prescription.
    for (const s of existing) s.directives = [...(s.directives ?? []), applied(directive)];

    const carriers = new Set(existing.map((s) => s.date));
    let missing = directive.timesPerWeek - carriers.size;
    if (missing <= 0) continue;

    const hosts = sessions
      .filter((s) => ANCILLARY_HOSTS.includes(s.type) && !carriers.has(s.date))
      .sort(
        (a, b) =>
          ANCILLARY_HOSTS.indexOf(a.type) - ANCILLARY_HOSTS.indexOf(b.type) ||
          a.plannedLoad - b.plannedLoad,
      );

    for (const host of hosts) {
      if (missing <= 0) break;
      host.blocks = [...host.blocks, ancillaryBlock(directive.block, directive.durationS)];
      // La durée suit ; la charge, non. Ni les étirements ni la respiration au
      // calme ne produisent de stress cardiovasculaire : les compter mangerait
      // la cible hebdomadaire au détriment de la course.
      host.plannedDurationS += directive.durationS;
      host.directives = [...(host.directives ?? []), applied(directive)];
      carriers.add(host.date);
      missing--;
    }
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Traces
// ─────────────────────────────────────────────────────────────────────────────

/** Durée lisible, pour les phrases qui rendent compte d'une directive. */
export const formatDirectiveDuration = (s: number): string =>
  s >= 3600
    ? `${Math.floor(s / 3600)} h ${String(Math.round((s % 3600) / 60)).padStart(2, '0')}`
    : `${Math.round(s / 60)} min`;

/** Trace d'une directive appliquée : laquelle, d'où elle vient, et ce dont la semaine dispense. */
export function applied(
  directive: TrainingDirective,
  exemption?: AppliedDirective['exemption'],
): AppliedDirective {
  return { directiveId: directive.id, origin: directive.origin, ...(exemption ? { exemption } : {}) };
}

/** Trace d'une séance façonnée par l'ambition plutôt que par le dossier. */
export function appliedAmbition(ambition: AthleteAmbition): AppliedDirective {
  return { directiveId: 'ambition', origin: ambition.origin[0] as AppliedDirective['origin'] };
}

/** Ce que `describeDirectives` lit d'une séance. */
export type DescribableSession = Pick<
  PlannedSession,
  'type' | 'blocks' | 'plannedDurationS' | 'plannedElevationGainM' | 'directives'
>;

/**
 * Les traces d'une séance, lues sur son contenu actuel.
 *
 * Ce qu'une directive produit — la durée retenue dans une plage, le dénivelé
 * d'un seul tenant, la cadence tenue — se déduit du contenu, et se déduit ici,
 * chaque fois qu'on le montre. Écrit dans la trace au moment de la
 * construction, il survivait aux réécritures : deux rando-courses réécrites à
 * 3 h / 1 010 m et 3 h 30 / 1 146 m annonçaient encore « 3 h 00 retenues » et
 * 1 227 / 1 384 m D+. Une trace enregistrée avant ce changement porte encore
 * cette phrase ; elle n'est plus lue.
 *
 * `dossier` est la liste des directives de l'athlète (`directivesFor`) : elle
 * donne les bornes d'une plage ou d'une fenêtre.
 */
export function describeDirectives(
  session: DescribableSession,
  dossier: readonly TrainingDirective[],
): DescribedDirective[] {
  return (session.directives ?? []).map(({ directiveId, origin, exemption }) => {
    const trace: AppliedDirective = { directiveId, origin, ...(exemption ? { exemption } : {}) };
    return { ...trace, effect: effectOf(trace, dossier.find((d) => d.id === directiveId), session) };
  });
}

function effectOf(
  trace: AppliedDirective,
  directive: TrainingDirective | undefined,
  s: DescribableSession,
): string {
  // Le temps d'un seul tenant : ce qui se court, sans les blocs annexes qu'une
  // fréquence hebdomadaire a pu adosser à la séance.
  const running = s.blocks.length
    ? totalDuration(s.blocks.filter((b) => !isPrescribed(b)))
    : s.plannedDurationS;
  const retained = formatDirectiveDuration(running);

  if (trace.directiveId === 'ambition') {
    const vert = s.blocks.length ? elevationGainOf(s.blocks) : Math.round(s.plannedElevationGainM ?? 0);
    const measurable =
      running >= DURABILITY_MEASURABLE.minDurationS && vert >= DURABILITY_MEASURABLE.minVertM;
    return measurable
      ? `Sortie longue privilégiée par l'ambition trail long : ${retained} et ${vert} m D+ d'un seul tenant, ` +
          `de quoi mesurer la perte horaire au lieu de la supposer.`
      : `Sortie longue privilégiée par l'ambition trail long, mais trop courte cette semaine pour produire ` +
          `une mesure de durabilité — il y faut ${formatDirectiveDuration(DURABILITY_MEASURABLE.minDurationS)} ` +
          `et ${DURABILITY_MEASURABLE.minVertM} m D+.`;
  }
  if (!directive) return `Consigne « ${trace.directiveId} », absente du dossier actuel.`;

  switch (directive.kind) {
    case 'session_duration': {
      const plage = `${formatDirectiveDuration(directive.minS)} – ${formatDirectiveDuration(directive.maxS)}`;
      if (running >= directive.minS && running <= directive.maxS) {
        return `Plage prescrite ${plage} : ${retained} retenues.`;
      }
      // Dire « plancher dispensé » d'une séance que rien ne dispense serait un
      // mensonge de plus dans une trace censée expliquer d'où vient la consigne.
      if (running < directive.minS && trace.exemption) {
        const why =
          trace.exemption === 'deload'
            ? "semaine de décharge, le plancher ne s'y applique pas"
            : trace.exemption === 'taper'
              ? "semaine d'affûtage, le plancher ne s'y applique pas"
              : 'la plage ne tenait pas sous le plafond horaire déclaré, qui prime';
        return `Plage prescrite ${plage} ; ${retained} retenues — ${why}.`;
      }
      return `Plage prescrite ${plage} ; ${retained} retenues — hors de la plage.`;
    }
    case 'cadence_target': {
      const off = s.blocks.find(
        (b) =>
          b.cadenceTargetSpm != null &&
          (b.cadenceTargetSpm < directive.minSpm || b.cadenceTargetSpm > directive.maxSpm),
      );
      return off
        ? `Cadence hors de la fenêtre ${directive.minSpm}-${directive.maxSpm} ppm : ${off.cadenceTargetSpm} ppm sur « ${off.label} ».`
        : `Cadence tenue dans la fenêtre ${directive.minSpm}-${directive.maxSpm} ppm.`;
    }
    case 'weekly_frequency':
      return s.blocks.some((b) => b.kind === directive.block)
        ? describe(directive)
        : `${BLOCK_LABEL[directive.block]} — ${directive.timesPerWeek} × ${formatDirectiveDuration(directive.durationS)} ` +
            `par semaine prescrits, absente de cette séance.`;
    case 'interval_policy': {
      const format = INTERVAL_FORMAT[s.type];
      if (!format) return describe(directive);
      const head =
        `Le fractionné de la semaine, format ${format === 'short' ? 'court' : 'moyen'} — ` +
        `le dossier n'en autorise qu'un, en alternant court et moyen.`;
      // Ce que le format admet se relit sur les blocs : une séance allégée ou
      // réécrite peut l'avoir quitté depuis que le planificateur l'a écrite.
      const check = checkIntervalFormat(s, directive);
      if (!check) return head;
      const window = `${formatDuration(check.spec.minWorkS)}-${formatDuration(check.spec.maxWorkS)}`;
      if (check.offences.length > 0) return `${head} ⚠ ${check.offences.join(' ')}`;
      if (check.workS.length === 0) return head;
      const unique = [...new Set(check.workS)];
      const told =
        unique.length === 1
          ? `Répétitions de ${formatDuration(unique[0] as number)}`
          : `Paliers de ${check.workS.map((w) => formatDuration(w)).join(', ')}`;
      return `${head} ${told}, dans la plage ${window} prescrite.`;
    }
    case 'success_criterion':
      return describe(directive);
  }
}

function describe(d: TrainingDirective): string {
  switch (d.kind) {
    case 'session_duration':
      return `Durée tenue dans la plage prescrite, ${formatDirectiveDuration(d.minS)} à ${formatDirectiveDuration(d.maxS)}.`;
    case 'weekly_frequency':
      return `${BLOCK_LABEL[d.block]} — ${d.timesPerWeek} × ${formatDirectiveDuration(d.durationS)} par semaine.`;
    case 'cadence_target':
      return `Cadence ramenée dans la fenêtre ${d.minSpm}-${d.maxSpm} ppm.`;
    case 'interval_policy':
      return `Le fractionné de la semaine — il n'y en a qu'un, en alternant court et moyen.`;
    case 'success_criterion':
      return `Critère de réussite attaché à la séance.`;
  }
}
