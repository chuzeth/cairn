import { sessionDuration } from '@cairn/core/format';

/**
 * Les appels partent de l'origine qui a servi la page — `/api/...`, jamais
 * `http://hôte:4000/api/...`. Next relaie vers l'API (voir `next.config.ts`) :
 * c'est ce qui permet d'ouvrir Cairn depuis le téléphone sans rien configurer,
 * et ce qui fait qu'aucun appel ne traverse d'origine.
 */
export async function get<T>(path: string): Promise<T> {
  const res = await fetch(path, { cache: 'no-store' });
  if (!res.ok) {
    const body = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((body as { error?: string }).error ?? `Erreur ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function post<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body ?? {}),
  });
  if (!res.ok) {
    const parsed = await res.json().catch(() => ({ error: res.statusText }));
    throw new Error((parsed as { error?: string }).error ?? `Erreur ${res.status}`);
  }
  return res.json() as Promise<T>;
}

export async function del<T>(path: string): Promise<T> {
  const res = await fetch(path, { method: 'DELETE' });
  if (!res.ok) throw new Error(`Erreur ${res.status}`);
  return res.json() as Promise<T>;
}

// ── Formatage ────────────────────────────────────────────────────────────────

export function pace(speedMs: number | null | undefined): string {
  if (!speedMs || speedMs <= 0) return '—';
  const s = 1000 / speedMs;
  if (s > 3600) return '—';
  const m = Math.floor(s / 60);
  const sec = Math.round(s % 60);
  return sec === 60 ? `${m + 1}:00` : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Durée d'une séance. La règle d'arrondi vient de `@cairn/core` : c'est la même
 * qui écrit la phrase du coach quand il annonce un allègement.
 */
export function duration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds)) return '—';
  return sessionDuration(seconds);
}

export function clock(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

/**
 * Durée d'un bloc de séance.
 *
 * Un arrondi à la minute transforme « 8 × 90 s » en « 8 × 2 min » : sur du
 * fractionné court, c'est une consigne fausse. On garde donc les secondes tant
 * que la durée n'est pas un multiple propre de la minute.
 */
export function blockDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  if (seconds >= 5400) return `${(seconds / 3600).toFixed(1)} h`;
  if (seconds >= 120 && seconds % 60 === 0) return `${seconds / 60} min`;
  if (seconds >= 120) {
    const m = Math.floor(seconds / 60);
    const s = seconds % 60;
    return `${m} min ${String(s).padStart(2, '0')} s`;
  }
  return `${Math.round(seconds)} s`;
}

/**
 * Minutes et secondes notées ′ et ″, comme dans le compte rendu du test d'effort.
 *
 * C'est la notation de la consigne : « 8 × 90″ » se lit d'un coup d'œil là où
 * « 8 × 1 min 30 s » se déchiffre. Au-delà de l'heure, l'apostrophe ne tient
 * plus le nombre et l'heure reprend la main.
 */
export function prime(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  if (s < 120) return `${s}\u2033`;
  if (s < 3600) {
    const m = Math.floor(s / 60);
    const rest = s % 60;
    return rest === 0 ? `${m}\u2032` : `${m}\u2032${String(rest).padStart(2, '0')}\u2033`;
  }
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  return m === 0 ? `${h}\u00a0h` : `${h}\u00a0h\u00a0${String(m).padStart(2, '0')}`;
}

/** La durée écrite en toutes lettres, pour la phrase qui ouvre la journée. */
export function spelledDuration(seconds: number | null | undefined): string {
  if (seconds == null || !Number.isFinite(seconds) || seconds <= 0) return '';
  const s = Math.round(seconds);
  if (s < 3600) return `${Math.round(s / 60)} minutes`;
  const h = Math.floor(s / 3600);
  const m = Math.round((s % 3600) / 60);
  if (m === 0) return h === 1 ? 'une heure' : `${h} heures`;
  return `${h}\u00a0h\u00a0${String(m).padStart(2, '0')}`;
}

/**
 * Ponctuation française : l'espace qui précède « : » ou ferme un guillemet ne
 * doit pas se retrouver en début de ligne. À 390 px, une ligne sur trois casse
 * à cet endroit.
 */
export const nbsp = (text: string): string =>
  text.replace(/ ([:;!?»])/g, '\u00a0$1').replace(/«\u0020/g, '«\u00a0');

const DAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];
const MONTHS = ['janv.', 'févr.', 'mars', 'avr.', 'mai', 'juin', 'juil.', 'août', 'sept.', 'oct.', 'nov.', 'déc.'];
const MONTHS_LONG = ['janvier', 'février', 'mars', 'avril', 'mai', 'juin', 'juillet', 'août', 'septembre', 'octobre', 'novembre', 'décembre'];

export function frDate(isoDate: string, opts: { weekday?: boolean; year?: boolean } = {}): string {
  const d = new Date(isoDate.length <= 10 ? `${isoDate}T12:00:00Z` : isoDate);
  if (Number.isNaN(d.getTime())) return isoDate;
  const day = `${d.getDate()} ${MONTHS[d.getMonth()]}`;
  const prefix = opts.weekday ? `${DAYS[d.getDay()]} ` : '';
  const suffix = opts.year ? ` ${d.getFullYear()}` : '';
  return `${prefix}${day}${suffix}`;
}

/** « Mardi 15 septembre » — la date telle qu'on la dit, en haut de l'écran du matin. */
export function longDate(isoDate: string): string {
  const d = new Date(isoDate.length <= 10 ? `${isoDate}T12:00:00Z` : isoDate);
  if (Number.isNaN(d.getTime())) return isoDate;
  const day = DAYS[d.getDay()] as string;
  return `${day[0]!.toUpperCase()}${day.slice(1)} ${d.getDate()} ${MONTHS_LONG[d.getMonth()]}`;
}

/**
 * L'objectif en un mot.
 *
 * « Trail des Grisemottes » ne tient pas à côté de la date sur 390 px, et ce
 * n'est pas la catégorie de l'épreuve qu'on compte en J−33 : c'est son nom.
 */
export function shortRace(name: string): string {
  return name
    .replace(/^[^\p{L}\d]+/u, '')
    .replace(/^(?:ultra[-\s]?)?(?:trail|course|marathon|semi|corrida|ekiden|kilomètre vertical|km vertical)\s+(?:de la |de l'|des |du |de |d'|le |la |les )?/iu, '')
    .trim() || name;
}

export function shortDate(isoDate: string): string {
  const d = new Date(isoDate.length <= 10 ? `${isoDate}T12:00:00Z` : isoDate);
  return Number.isNaN(d.getTime()) ? isoDate : `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}`;
}

export function dayName(dow: number): string {
  return DAYS[dow] ?? '';
}

export const todayIso = () => new Date().toISOString().slice(0, 10);
export const isoOffset = (days: number) =>
  new Date(Date.now() + days * 86_400_000).toISOString().slice(0, 10);

export const signed = (n: number, digits = 0) => `${n > 0 ? '+' : ''}${n.toFixed(digits)}`;

/** Rendu Markdown minimal — suffisant pour ce que le coach produit, sans dépendance. */
export function markdown(src: string): string {
  const esc = (s: string) => s.replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c] as string));
  const inline = (s: string) =>
    esc(s)
      .replace(/`([^`]+)`/g, '<code>$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(?<![*\w])\*([^*\n]+)\*(?!\*)/g, '<em>$1</em>');

  const out: string[] = [];
  let list: 'ul' | 'ol' | null = null;
  let table: string[][] | null = null;

  const closeList = () => { if (list) { out.push(`</${list}>`); list = null; } };
  const closeTable = () => {
    if (!table) return;
    const [head, ...rows] = table;
    out.push('<table><thead><tr>' + (head ?? []).map((c) => `<th>${inline(c)}</th>`).join('') + '</tr></thead><tbody>');
    for (const r of rows) out.push('<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>');
    out.push('</tbody></table>');
    table = null;
  };

  for (const rawLine of src.split('\n')) {
    const line = rawLine.trimEnd();

    if (/^\s*\|.*\|\s*$/.test(line)) {
      const cells = line.trim().slice(1, -1).split('|').map((c) => c.trim());
      if (cells.every((c) => /^:?-{2,}:?$/.test(c))) continue; // ligne de séparation
      closeList();
      (table ??= []).push(cells);
      continue;
    }
    closeTable();

    if (!line.trim()) { closeList(); continue; }

    const heading = /^(#{1,4})\s+(.*)$/.exec(line);
    if (heading) {
      closeList();
      const level = Math.min(4, (heading[1] as string).length + 1);
      out.push(`<h${level}>${inline(heading[2] as string)}</h${level}>`);
      continue;
    }

    const bullet = /^\s*[-*·]\s+(.*)$/.exec(line);
    if (bullet) {
      if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
      out.push(`<li>${inline(bullet[1] as string)}</li>`);
      continue;
    }

    const numbered = /^\s*\d+\.\s+(.*)$/.exec(line);
    if (numbered) {
      if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
      out.push(`<li>${inline(numbered[1] as string)}</li>`);
      continue;
    }

    closeList();
    out.push(`<p>${inline(line)}</p>`);
  }
  closeList();
  closeTable();
  return out.join('');
}

// ── Types partagés avec l'API ────────────────────────────────────────────────

export interface StateResponse {
  athlete: {
    id: string; name: string; constraints: Record<string, unknown>;
    /** L'ambition n'a pas de date : elle oriente, elle ne se coche pas. */
    ambition: { format: string; since: string; origin: DirectiveOriginRow[] } | null;
  };
  model: {
    asOf: string; bodyMassKg: number; hrMax: number; hrRest: number;
    criticalSpeedMs: number; criticalSpeedKmh: number; criticalPace: string;
    dPrimeM: number; vmaKmh: number; vo2maxRel: number;
    vt1: { hr: number; speedMs: number }; vt2: { hr: number; speedMs: number };
    vt1Kmh: number; vt2Kmh: number;
    durabilityPctPerHour: number; durabilityPctPer1000mVert: number;
    descentSkill?: number; confidence: number;
    criticalSpeedEvidence?: { support: number; lastProofAgeDays: number | null; weightLab: number };
    provenance: Record<string, string>;
    vamCurve: Record<string, number>;
  };
  zones: {
    key: string; label: string; purpose: string;
    hrMin: number; hrMax: number; speedMinKmh: number; speedMaxKmh: number;
    paceMin: string; paceMax: string;
  }[];
  today: {
    date: string; ctl: number; atl: number; tsb: number; mechanicalTsb: number;
    acwr: number; rampRate: number; monotony: number;
    tsbLabel: string; acwrLabel: string; acwrRisk: string;
  };
  readiness: Readiness;
  checkIn: CheckIn | null;
  /** Notes libres dont rien n'a encore été fait, la plus récente d'abord. */
  pendingNotes: { date: string; notes: string }[];
  absences: DeclaredAbsence[];
  weeklyTotals: { weekStart: string; load: number; mechanical: number; durationS: number; vertM: number }[];
  upcomingRaces: RaceRow[];
  hasPlan: boolean;
  labTest: Record<string, unknown> | null;
  /** Ce que le planificateur lit du dossier, au-delà des quatre nombres. */
  directives: {
    id: string; kind: string; origin: DirectiveOriginRow; derived?: string;
  }[];
}

/** Provenance d'une composante de disponibilité — miroir de `ReadinessSource`. */
export type ReadinessSource =
  | 'load' | 'declared' | 'partial' | 'baseline' | 'hrv' | 'resting-hr' | 'default';

export type ReadinessComponent = 'tsbMetabolic' | 'tsbMechanical' | 'subjective' | 'autonomic';

export interface Readiness {
  date?: string;
  score: number;
  verdict: 'green' | 'amber' | 'red';
  recommendation: string;
  components: Record<string, number>;
  sources: Record<ReadinessComponent, ReadinessSource>;
  /** Poids réellement appliqué à chaque composante ; une composante sans source pèse 0. */
  weights: Record<ReadinessComponent, number>;
  /** 1 quand rien n'est relevé nulle part, 0 dès qu'une seule source existe. */
  assumedShare: number;
}

/**
 * Une période datée sans entraînement, annoncée par l'athlète.
 *
 * Les séances qu'elle recouvre portent le statut `withdrawn` : retirées, ni à
 * faire ni manquées.
 */
export interface DeclaredAbsence {
  id: string;
  startDate: string;
  endDate: string;
  kind: 'chosen' | 'illness' | 'injury' | 'unavailable';
  /** Les mots de l'athlète, tels qu'il les a écrits. */
  reason: string;
  source: 'athlete' | 'coach';
  declaredAt: string;
  checkInDate?: string;
  /** Nombre de séances retirées, compté en base. */
  withdrawnSessions?: number;
}

export interface CheckIn {
  date: string;
  fatigue?: number;
  sleepHours?: number;
  sleepQuality?: number;
  soreness?: number;
  stress?: number;
  motivation?: number;
  restingHr?: number;
  hrvRmssd?: number;
  bodyMassKg?: number;
  notes?: string;
  /** Renseigné quand quelque chose a été fait de la note ; vide, elle est en attente. */
  noteHandledAt?: string;
  noteHandledAs?: string;
}

export interface CheckInResult {
  readiness: Readiness;
  checkIn: CheckIn | null;
  /** Nombre de séances réajustées par les règles de charge après ce relevé. */
  adjustments: number;
  adjustmentSummary: string | null;
}

export interface RaceRow {
  id: string; name: string; date: string; priority: 'A' | 'B' | 'C';
  daysUntil?: number;
  course: {
    distanceM: number; elevationGainM: number; elevationLossM: number;
    technicality: number; expectedTempC?: number; maxAltitudeM?: number; nightHours?: number;
  };
  target?: { timeS?: number; placing?: number; fieldSize?: number; previousEditions?: { year: number; placing: number; timeS: number }[] };
  notes?: string;
}

export interface ActivityRow {
  id: string; name: string; sportType: string; startDateLocal: string;
  distanceKm: number; durationLabel: string; pace: string;
  distanceM: number; movingTimeS: number;
  totalElevationGainM: number; totalElevationLossM: number;
  averageHr?: number; maxHr?: number; averageCadenceSpm?: number; averageTempC?: number;
  load: { metabolic: number; mechanical: number; intensityFactor: number; primarySource: string } | null;
  zones: { low: number; moderate: number; high: number } | null;
  decoupling: number | null;
  intervalCount: number;
  flags: number;
}

export interface PmcResponse {
  metabolic: { date: string; ctl: number; atl: number; tsb: number; load: number }[];
  mechanical: { date: string; ctl: number; atl: number; tsb: number; load: number }[];
  acwr: { date: string; value: number }[];
  rampRate: { date: string; value: number }[];
  monotony: { date: string; value: number }[];
}

export interface InsightRow {
  id: string; createdAt: string; scope: string; refId?: string;
  title: string; body: string; actions: string[];
  highlights: { label: string; value: string; delta?: string; direction?: string }[];
  severity: 'info' | 'good' | 'watch' | 'warn';
}

export interface PlanResponse {
  plan: {
    id: string;
    goalRaceId: string;
    targetRaceDayTsb: number;
    /** Ce que les charges du plan produisent la veille de la course. */
    projectedRaceDayTsb?: number;
    raceDayTsbShortfall?: string;
    revisionLog: { at: string; trigger: string; summary: string }[];
  } | null;
  weekSummaries: string[];
  sessions: SessionRow[];
  absences: DeclaredAbsence[];
  completedByDate: Record<string, { id: string; name: string }>;
}

/** D'où vient une consigne : le document, sa date, l'extrait littéral. */
export interface DirectiveOriginRow {
  source: 'lab_test' | 'athlete_notes' | 'athlete';
  date: string;
  author?: string;
  quote: string;
}

export interface SessionRow {
  id: string; date: string; type: string; title: string; intent: string;
  blocks: {
    label: string; zone: string; repeat?: number; durationS?: number; distanceM?: number;
    /** Bloc non couru dont la fréquence est prescrite au dossier. */
    kind?: 'mobility' | 'respiratory';
    /** Dénivelé du bloc, par répétition et hors récupération — le relief du profil. */
    elevationGainM?: number; elevationLossM?: number;
    hrRange?: [number, number]; paceRange?: [string, string]; vamTargetMh?: number;
    cadenceTargetSpm?: number; notes?: string;
    /** La récupération porte son propre dénivelé : la redescente d'une côte, la remontée d'une descente. */
    recovery?: { durationS: number; zone: string; active: boolean; elevationGainM?: number; elevationLossM?: number };
    /** Contenu excentrique du bloc : c'est lui qui porte la charge mécanique. */
    circuit?: { rounds: number; exercises: { movement: string; reps: number }[] };
  }[];
  /** Ce qui fait que la séance a atteint son but, tel que le dossier le formule. */
  successCriteria?: { metric: 'hr_drift'; maxValue?: number; origin: DirectiveOriginRow }[];
  /** Directives du dossier qui ont façonné la séance. */
  directives?: { directiveId: string; effect: string; origin: DirectiveOriginRow }[];
  plannedLoad: number; plannedMechanicalLoad: number; plannedDurationS: number;
  plannedElevationGainM?: number; plannedDistanceM?: number;
  priority: 'key' | 'support' | 'optional';
  status: string; rationale?: string;
  /** Activité qui a rattaché la séance — celle qui l'a réalisée ou remplacée. */
  completedActivityId?: string;
  /** Absence déclarée qui a retiré la séance, quand le statut vaut `withdrawn`. */
  absenceId?: string;
}
