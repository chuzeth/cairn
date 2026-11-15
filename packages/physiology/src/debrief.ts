import type { Activity, ActivityAnalysis, PhysiologyModel, PlannedSession } from '@cairn/core';
import { decimal, sessionDuration } from '@cairn/core';
import type { ClimbSegment, SessionMarkers, SteadyWindow } from './markers.js';
import { SPIKE_HAZARD, classifySpike, longestBefore, type RunDistance } from './spike.js';
import { runDurationOf } from './sessionMatch.js';
import { measuresGroundSpeed } from './streams.js';
import { clamp, quantile } from './units.js';

/**
 * Ce qu'une sortie apprend : le compte rendu d'un entraîneur, pas un tableau de
 * bord.
 *
 * Une analyse dit ce qui s'est passé. Un compte rendu dit ce que ça change — ce
 * que la sortie révèle de la forme, de la fatigue, de l'endurance, des montées,
 * des descentes, du risque —, chaque constat lu contre l'historique de
 * l'athlète, et non contre une norme de population. La comparaison au prévu en
 * fait partie, sans en être le centre.
 *
 * Les principes viennent de ce que font les meilleurs entraîneurs et de ce que
 * reprochent les études aux plateformes qui l'automatisent :
 *  · un écart plus petit que le bruit de la mesure ne se dit pas (Hopkins) ;
 *  · un constat de forme ne se tire pas d'une seule sortie : une sortie seule
 *    est un signal à surveiller, deux dans le même sens sont une tendance ;
 *  · ce que le terrain explique n'est pas une faute — le cœur passe le seuil 1
 *    dans chaque côte ;
 *  · une donnée douteuse retire le constat qu'elle fonde, elle ne le décore pas ;
 *  · alléger demande moins de preuves que progresser.
 *
 * Tout est déterministe : les mêmes sorties donnent le même compte rendu. Les
 * décisions qui en découlent sont prises par les règles du coach (`adapt.ts`),
 * qui lisent `implications`.
 */

export type FindingDomain =
  | 'risk' | 'body' | 'fitness' | 'fatigue' | 'durability' | 'climb' | 'descent' | 'performance'
  | 'intensity' | 'plan' | 'data';

export type FindingTone = 'positive' | 'negative' | 'neutral' | 'caution';

export interface Finding {
  code: string;
  domain: FindingDomain;
  tone: FindingTone;
  /** Ce qui ordonne les constats, 0–100. */
  weight: number;
  confidence: 'high' | 'medium' | 'low';
  /** Le constat, en une ligne. */
  title: string;
  /** Le même, en quelques mots, pour le verdict qui en assemble plusieurs. */
  gist: string;
  /** Contre quoi il se lit, et ce qu'il veut dire. */
  detail: string;
  /** Les chiffres qui le fondent, et ce à quoi ils se comparent. */
  evidence: { label: string; value: string; reference?: string }[];
}

/**
 * Ce que la sortie change pour la suite, sous une forme que les règles lisent.
 *
 * `recovery` : jusqu'à quand une séance dure, ou une descente rapide, se paie
 * plus cher qu'elle ne rapporte. `cardiac` : la réponse du cœur à allure égale,
 * contre la tendance des sorties d'avant — le signal objectif de fatigue que
 * le score de disponibilité n'avait pas sans mesure de variabilité cardiaque.
 */
export interface DebriefImplications {
  recovery: {
    /** Heures avant une nouvelle séance de qualité. */
    qualityHours: number;
    /** Heures avant une descente rapide ou une séance excentrique. */
    eccentricHours: number;
    /** Ce qui fixe ces durées, en clair. */
    reasons: string[];
  };
  cardiac: {
    /** Écart à la tendance des sorties d'avant, bpm ; positif = cœur plus haut à allure égale. */
    deltaBpm: number;
    /** Bruit d'une sortie à l'autre, bpm. */
    typicalErrorBpm: number;
    /**
     * Sorties consécutives du même côté de leur tendance, d'au moins une erreur
     * type, celle-ci comprise : positif au-dessus, négatif au-dessous.
     */
    streak: number;
  } | null;
  /** La sortie dépasse la plus longue des 30 jours d'avant de plus de 30 % : la suivante consolide. */
  spike: { ratio: number; referenceM: number; referenceDate: string } | null;
}

export interface SessionDebrief {
  activityId: string;
  date: string;
  /** Ce qui a réellement été fait, en une ligne. */
  what: string;
  /** Le verdict, en une ou deux phrases. */
  headline: string;
  /** Les constats, du plus important au moins important. */
  findings: Finding[];
  implications: DebriefImplications;
  /** Ce qui a été écarté et pourquoi : l'athlète a le droit de savoir ce qui n'a pas été lu. */
  limits: string[];
  /** La FC à allure de référence, sortie par sortie, pour la tracer. */
  aerobicTrend: AerobicPoint[];
  /** L'allure de référence de `aerobicTrend`, m/s. */
  referenceGapMs: number;
  /** Ce que la chaleur retire à la FC, bpm/°C au-dessus de 15 °C, et d'où vient ce coefficient. */
  heat: { bpmPerC: number; provenance: 'field' | 'default' };
}

export interface DebriefRun {
  activity: Activity;
  analysis: (ActivityAnalysis & { markers?: SessionMarkers }) | null;
  /** La température de l'air pendant la sortie, °C, d'une archive météo — jamais celle de la montre. */
  airTempC?: number | null;
}

export interface DebriefContext {
  /** La charge au matin de la sortie, avant elle. */
  load?: { ctl: number; atl: number; tsb: number; mechanicalTsb: number } | null;
  /** La séance que la sortie réalisait, si elle en réalisait une. */
  planned?: Pick<PlannedSession, 'title' | 'type' | 'intent' | 'plannedDurationS' | 'blocks'> | null;
  /** La douleur déclarée pendant la course (0–10), et son endroit. */
  pain?: { score: number; site?: string | null } | null;
  /** L'effort perçu, 1–10. */
  rpe?: number | null;
  /** La température de l'air, °C, si elle est connue. */
  airTempC?: number | null;
}

export interface DebriefInput {
  run: DebriefRun;
  /** Les sorties d'avant, dans n'importe quel ordre ; celles d'après sont ignorées. */
  history: readonly DebriefRun[];
  model: PhysiologyModel;
  /** L'allure de référence de la FC à allure égale, m/s (`referenceGapOf`). */
  referenceGapMs: number;
  context?: DebriefContext;
}

// ── Réglages ────────────────────────────────────────────────────────────────

const RUN_SPORTS = new Set(['Run', 'TrailRun', 'VirtualRun']);
/** Une sortie compte dans la FC à allure égale à partir de 4 fenêtres stables (5 min). */
const MIN_WINDOWS = 4;
/** Les fenêtres trop loin de l'allure de référence extrapolent : elles sont écartées. */
const WINDOW_SPAN_MS = 0.8;
/** Après trois minutes au-dessus du seuil 2, une fenêtre dit la séance, pas l'état du jour. */
const HARD_BEFORE_MAX_S = 180;
/** Pente commune FC-vitesse, bornée : bpm par m/s. */
const SLOPE = { min: 12, max: 32, fallback: 20 } as const;
/**
 * Erreur type de la FC à allure égale, bpm. Mesurée sur l'athlète dès huit
 * paires de sorties rapprochées ; avant, celle de la littérature pour une FC
 * sous-maximale au poignet, sur le terrain : 3 à 5 bpm (Buchheit 2014).
 */
const TYPICAL_ERROR = { fallback: 4, min: 3, max: 9, minPairs: 8, pairDays: 10 } as const;
/** Un écart d'une seule sortie ne se dit qu'au-delà de deux erreurs types. */
const SIGNAL_TE = 2;
/** Une coupure de course : 14 jours ou plus sans sortie. */
const BREAK_DAYS = 14;
const DAY_MS = 86_400_000;

const dateOf = (a: Pick<Activity, 'startDateLocal'>) => a.startDateLocal.slice(0, 10);
const days = (a: string, b: string) => Math.round((Date.parse(`${b}T12:00:00Z`) - Date.parse(`${a}T12:00:00Z`)) / DAY_MS);
const dm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const km = (m: number) => decimal(m / 1000, 1);
const kmh = (ms: number) => decimal(ms * 3.6, 1);
const bpm = (v: number) => `${Math.round(v)} bpm`;
const median = (xs: readonly number[]) => (xs.length ? quantile(xs, 0.5) : NaN);
const isRun = (a: Pick<Activity, 'sportType'>) => RUN_SPORTS.has(a.sportType);

/**
 * L'allure de référence : 85 % de la vitesse au seuil 1 du test de laboratoire,
 * arrondie au demi-km/h — une allure d'endurance, celle des footings, où se
 * trouvent les fenêtres stables et où rien ne s'extrapole. Elle tient du test,
 * qui ne bouge pas, pour qu'un chiffre dit en novembre se compare à celui de
 * septembre.
 */
export function referenceGapOf(labVt1SpeedMs: number): number {
  return (Math.round(labVt1SpeedMs * 0.85 * 3.6 * 2) / 2) / 3.6;
}

// ── FC à allure égale ───────────────────────────────────────────────────────

export interface AerobicPoint {
  activityId: string;
  date: string;
  /** FC à l'allure de référence, ramenée à 15 °C quand la température de l'air est connue, bpm. */
  hr: number;
  /** Fenêtres qui la fondent. */
  windows: number;
  /** La température de l'air, °C, si elle est connue. */
  tempC?: number | null;
  /** Ce que la chaleur a retiré à la FC mesurée, bpm. */
  heatBpm?: number;
}

/**
 * La chaleur à allure égale : au-dessus de 15 °C, chaque degré fait monter la FC
 * (dérive cardiovasculaire, débit cutané). Le coefficient se mesure sur
 * l'athlète, une fois la tendance de forme retirée — chaque sortie contre les
 * sorties des trois semaines qui l'entourent, sinon l'été et la progression se
 * confondent. Pierre, mai–novembre 2026 : 0,35 bpm/°C sur 35 sorties. Avant
 * 20 sorties à température connue, le repli de 0,4 ; borné entre 0 et 1.
 */
export const HEAT = { baseC: 15, fallback: 0.4, min: 0, max: 1, minPoints: 20, neighbourDays: 21 } as const;

const usableWindows = (m: SessionMarkers | undefined, ref: number): SteadyWindow[] =>
  m && m.hr.verdict !== 'unusable'
    ? m.steady.filter((w) => w.hardBeforeS < HARD_BEFORE_MAX_S && Math.abs(w.gap - ref) <= WINDOW_SPAN_MS)
    : [];

/**
 * La pente FC-vitesse commune à toutes les sorties : chaque sortie centrée sur
 * sa propre moyenne, pour que ce qui diffère d'un jour à l'autre — la forme, la
 * chaleur, la fatigue — ne se confonde pas avec la pente.
 */
export function cardiacSlope(runs: readonly DebriefRun[]): number {
  let sxy = 0;
  let sxx = 0;
  for (const r of runs) {
    const w = r.analysis?.markers?.steady.filter((x) => x.hardBeforeS < HARD_BEFORE_MAX_S) ?? [];
    if (w.length < MIN_WINDOWS) continue;
    const mg = w.reduce((s, x) => s + x.gap, 0) / w.length;
    const mh = w.reduce((s, x) => s + x.hr, 0) / w.length;
    for (const x of w) {
      sxy += (x.gap - mg) * (x.hr - mh);
      sxx += (x.gap - mg) ** 2;
    }
  }
  // Moins de 0,5 (m/s)² d'étendue cumulée : la pente n'est pas mesurée.
  if (sxx < 0.5) return SLOPE.fallback;
  return clamp(sxy / sxx, SLOPE.min, SLOPE.max);
}

/** Le coefficient de chaleur de l'athlète, bpm/°C au-dessus de 15 °C, et d'où il vient. */
export function heatCoefficient(points: readonly AerobicPoint[]): { bpmPerC: number; provenance: 'field' | 'default' } {
  const warm = (t: number) => Math.max(0, t - HEAT.baseC);
  const known = points.filter((p): p is AerobicPoint & { tempC: number } => p.tempC != null);
  if (known.length < HEAT.minPoints) return { bpmPerC: HEAT.fallback, provenance: 'default' };
  let sxy = 0;
  let sxx = 0;
  for (const p of known) {
    const near = known.filter((q) => q !== p && Math.abs(days(q.date, p.date)) <= HEAT.neighbourDays);
    if (near.length < 3) continue;
    const r = p.hr - median(near.map((q) => q.hr));
    const dt = warm(p.tempC) - median(near.map((q) => warm(q.tempC)));
    sxy += dt * r;
    sxx += dt * dt;
  }
  if (sxx < 50) return { bpmPerC: HEAT.fallback, provenance: 'default' };
  return { bpmPerC: Math.round(clamp(sxy / sxx, HEAT.min, HEAT.max) * 100) / 100, provenance: 'field' };
}

/** La même série, ramenée à 15 °C. */
export function withoutHeat(points: readonly AerobicPoint[], bpmPerC: number): AerobicPoint[] {
  return points.map((p) => {
    if (p.tempC == null) return p;
    const heatBpm = Math.round(bpmPerC * Math.max(0, p.tempC - HEAT.baseC) * 10) / 10;
    return { ...p, hr: Math.round((p.hr - heatBpm) * 10) / 10, heatBpm };
  });
}

/** La FC qu'une sortie aurait eue à l'allure de référence, ou rien si elle ne le dit pas. */
export function aerobicPointOf(run: DebriefRun, ref: number, slope: number): AerobicPoint | null {
  if (!isRun(run.activity) || !run.analysis || !measuresGroundSpeed(run.activity, run.analysis.gpsQuality)) return null;
  const w = usableWindows(run.analysis.markers, ref);
  if (w.length < MIN_WINDOWS) return null;
  return {
    activityId: run.activity.id,
    date: dateOf(run.activity),
    hr: Math.round(median(w.map((x) => x.hr - slope * (x.gap - ref))) * 10) / 10,
    windows: w.length,
    tempC: run.airTempC ?? null,
  };
}

/**
 * Le bruit de la FC à allure égale d'une sortie à l'autre, sur les paires de
 * sorties à moins de dix jours d'écart : chaleur, heure, sommeil, capteur.
 * Pour deux mesures d'erreur σ, la médiane de |x − y| vaut 0,954 σ.
 */
export function typicalError(points: readonly AerobicPoint[]): number {
  const sorted = [...points].sort((a, b) => a.date.localeCompare(b.date));
  const diffs: number[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (days(sorted[i - 1]!.date, sorted[i]!.date) <= TYPICAL_ERROR.pairDays) {
      diffs.push(Math.abs(sorted[i]!.hr - sorted[i - 1]!.hr));
    }
  }
  if (diffs.length < TYPICAL_ERROR.minPairs) return TYPICAL_ERROR.fallback;
  return Math.round(clamp(median(diffs) / 0.954, TYPICAL_ERROR.min, TYPICAL_ERROR.max) * 10) / 10;
}

// ── Le compte rendu ─────────────────────────────────────────────────────────

export function debriefSession(input: DebriefInput): SessionDebrief {
  const { run, model, referenceGapMs: ref } = input;
  const context = { ...input.context, airTempC: input.context?.airTempC ?? input.run.airTempC ?? null };
  const date = dateOf(run.activity);
  const startedAt = run.activity.startDateLocal;
  const before = input.history
    .filter((h) => h.activity.id !== run.activity.id && h.activity.startDateLocal < startedAt)
    .sort((a, b) => a.activity.startDateLocal.localeCompare(b.activity.startDateLocal));
  const markers = run.analysis?.markers;
  const findings: Finding[] = [];
  const limits: string[] = [];

  // ── Qualité des données ────────────────────────────────────────────────────
  const hrVerdict = markers?.hr.verdict ?? (run.activity.averageHr != null ? 'good' : 'unusable');
  const groundSpeed = run.analysis ? measuresGroundSpeed(run.activity, run.analysis.gpsQuality) : false;
  if (markers && markers.hr.verdict !== 'good') {
    findings.push({
      code: 'hr_quality',
      domain: 'data',
      tone: 'caution',
      weight: markers.hr.verdict === 'unusable' ? 55 : 30,
      confidence: 'high',
      title: markers.hr.verdict === 'unusable' ? 'Cardio inexploitable' : 'Cardio douteux par endroits',
      gist: 'un cardio douteux',
      detail:
        `${markers.hr.reasons.join(', ')}. ` +
        (markers.hr.verdict === 'unusable'
          ? 'Rien de ce qui se lit sur le cœur — zones, dérive, forme — n\'est retenu de cette sortie.'
          : 'Les passages en cause sont écartés ; le reste se lit avec prudence.'),
      evidence: [],
    });
  }
  if (run.analysis && !groundSpeed) {
    limits.push('Vitesse non mesurée au sol (tapis, ou sortie sans coordonnées) : ni allure, ni record, ni FC à allure égale.');
  }

  // ── Douleur ───────────────────────────────────────────────────────────────
  const pain = context.pain;
  if (pain && pain.score >= 2) {
    findings.push({
      code: 'pain',
      domain: 'body',
      tone: 'negative',
      weight: 100,
      confidence: 'high',
      title: `Douleur à ${pain.score}/10${pain.site ? ` (${pain.site})` : ''}`,
      gist: `une douleur à ${pain.score}/10`,
      detail:
        'Ce que tu as dit passe avant tout ce que mesure la montre : la suite de la reprise se règle sur elle.',
      evidence: [{ label: 'Douleur déclarée', value: `${pain.score}/10` }],
    });
  }

  // ── Pic de distance ──────────────────────────────────────────────────────
  const runsBefore: RunDistance[] = before.filter((h) => isRun(h.activity)).map((h) => ({
    date: dateOf(h.activity),
    distanceM: h.activity.distanceM,
  }));
  let spike: DebriefImplications['spike'] = null;
  if (isRun(run.activity) && run.activity.distanceM > 0) {
    const reference = longestBefore(runsBefore, date);
    const verdict = classifySpike(run.activity.distanceM, reference);
    if ((verdict.cls === 'moderate' || verdict.cls === 'large' || verdict.cls === 'small') && verdict.ratio != null) {
      const pct = Math.round(verdict.ratio * 100);
      const hazard = SPIKE_HAZARD[verdict.cls];
      if (verdict.cls !== 'small') {
        spike = { ratio: verdict.ratio, referenceM: verdict.referenceM!, referenceDate: verdict.referenceDate! };
      }
      const painFree = pain != null && pain.score <= 1;
      findings.push({
        code: 'distance_spike',
        domain: 'risk',
        tone: 'caution',
        weight: verdict.cls === 'small' ? 50 : 85,
        confidence: 'high',
        title: `${km(run.activity.distanceM)} km : ${pct} % de plus que ta plus longue sortie du mois`,
        gist: `une sortie ${pct} % plus longue que tout le mois`,
        detail:
          `La plus longue des 30 jours d'avant faisait ${km(verdict.referenceM!)} km (${dm(verdict.referenceDate!)}). ` +
          `Au-delà de +${verdict.cls === 'small' ? 10 : 30} %, le risque de blessure de surmenage est multiplié par ` +
          `${decimal(hazard, 2)} (Frandsen, BJSM 2025). ` +
          (painFree ? 'Sans douleur déclarée : c\'est bon signe, et c\'est le lendemain qui le confirme. ' : '') +
          `La prochaine sortie longue consolide cette distance avant d'en ajouter.`,
        evidence: [
          { label: 'Distance', value: `${km(run.activity.distanceM)} km`, reference: `${km(verdict.referenceM!)} km le ${dm(verdict.referenceDate!)}` },
        ],
      });
    }
  }

  // ── Descente nouvelle ────────────────────────────────────────────────────
  const descentBefore = before
    .filter((h) => isRun(h.activity) && days(dateOf(h.activity), date) <= 30)
    .map((h) => h.activity.totalElevationLossM ?? 0);
  const maxDescent = descentBefore.length ? Math.max(...descentBefore) : 0;
  const descentM = run.activity.totalElevationLossM ?? 0;
  const novelDescent = descentM >= 250 && descentM > 1.3 * maxDescent;
  if (novelDescent) {
    findings.push({
      code: 'descent_novelty',
      domain: 'risk',
      tone: 'caution',
      weight: 70,
      confidence: 'high',
      title: `${Math.round(descentM)} m de descente, ${maxDescent > 0 ? `${Math.round((descentM / maxDescent - 1) * 100)} % de plus` : 'plus'} que ce que tes cuisses ont vu en 30 jours`,
      gist: 'plus de descente que tout le mois',
      detail:
        `La plus grosse descente du mois faisait ${Math.round(maxDescent)} m. Le muscle qui freine se répare en 48 à ` +
        `72 h, et ne se protège qu'en ayant déjà été exposé : les courbatures culminent le surlendemain. Pas de descente ` +
        `rapide d'ici là.`,
      evidence: [{ label: 'Descente', value: `${Math.round(descentM)} m D−`, reference: `${Math.round(maxDescent)} m au plus en 30 jours` }],
    });
  }

  // ── FC à allure égale ────────────────────────────────────────────────────
  const all = [...before, run];
  const slope = cardiacSlope(all);
  const measured = all
    .map((r) => aerobicPointOf(r, ref, slope))
    .filter((p): p is AerobicPoint => p != null);
  const heatCoef = heatCoefficient(measured);
  const series = withoutHeat(measured, heatCoef.bpmPerC);
  const point = series.find((p) => p.activityId === run.activity.id) ?? null;
  const past = series.filter((p) => p.activityId !== run.activity.id && days(p.date, date) <= 180);
  const te = typicalError(series.filter((p) => days(p.date, date) <= 180));
  let cardiac: DebriefImplications['cardiac'] = null;
  const heat = context.airTempC != null && context.airTempC >= 22;
  const breakStart = lastBreak(before, date);

  if (point && hrVerdict !== 'unusable') {
    const recent = past.filter((p) => days(p.date, date) <= 21).slice(-3);
    const trend = recent.length ? median(recent.map((p) => p.hr)) : null;
    const confidence: Finding['confidence'] = point.windows >= 8 && hrVerdict === 'good' && !heat ? 'high' : 'medium';
    if (point.tempC == null) limits.push('Température de l\'air inconnue : la chaleur n\'est pas retirée de la FC à allure égale.');
    const evidenceRef = `${kmh(ref)} km/h à plat`;

    if (trend != null) {
      const delta = point.hr - trend;
      // Combien de sorties d'affilée au-dessus de leur propre tendance ?
      // Combien de sorties d'affilée au-dessus (positif) ou au-dessous (négatif)
      // de leur propre tendance, d'au moins une erreur type ?
      let streak = 0;
      const ordered = [...past.filter((p) => days(p.date, date) <= 60), point];
      const sign = Math.sign(delta);
      for (let i = ordered.length - 1; i >= 0; i--) {
        const p = ordered[i]!;
        const prior = ordered.slice(Math.max(0, i - 3), i);
        if (prior.length === 0) break;
        if ((p.hr - median(prior.map((x) => x.hr))) * sign >= te) streak += sign;
        else break;
      }
      cardiac = { deltaBpm: Math.round(delta * 10) / 10, typicalErrorBpm: te, streak };

      if (Math.abs(delta) >= SIGNAL_TE * te) {
        const up = delta > 0;
        const why = up
          ? heat
            ? `Il faisait ${Math.round(context.airTempC!)} °C : la chaleur seule fait monter le cœur de plusieurs battements.`
            : context.load && context.load.tsb < -15
              ? `Ta fraîcheur était à ${decimal(context.load.tsb, 0)} au départ : c'est la fatigue accumulée qui se lit.`
              : streak >= 2
                ? 'C\'est la deuxième sortie d\'affilée : ce n\'est plus du bruit.'
                : 'Une sortie seule ne fait pas une tendance — chaleur, nuit courte, début de maladie le font aussi. À surveiller.'
          : streak <= -2
            ? 'Deux sorties de suite : la forme monte.'
            : 'Le cœur travaille moins pour la même allure : forme qui monte ou fraîcheur retrouvée, à confirmer sur la prochaine sortie.';
        findings.push({
          code: up ? 'cardiac_strain' : 'cardiac_ease',
          domain: up ? 'fatigue' : 'fitness',
          tone: up ? (streak >= 2 && !heat ? 'negative' : 'caution') : 'positive',
          weight: up ? (streak >= 2 ? 80 : 60) : streak <= -2 ? 70 : 55,
          confidence: Math.abs(streak) >= 2 ? confidence : 'medium',
          title: `${up ? '+' : '−'}${Math.round(Math.abs(delta))} bpm à allure égale par rapport à tes dernières sorties`,
          gist: up ? `un cœur ${Math.round(delta)} bpm plus haut que d'habitude` : `un cœur ${Math.round(-delta)} bpm plus bas que d'habitude`,
          detail:
            `À ${kmh(ref)} km/h à plat, ton cœur était à ${bpm(point.hr)}${heatNote(point)}, contre ${bpm(trend)} sur ` +
            `${recent.length > 1 ? `tes ${recent.length} sorties` : 'ta sortie'} d'avant ; d'une sortie à l'autre, ce chiffre varie ` +
            `d'environ ${Math.round(te)} bpm. ${why}`,
          evidence: [{ label: `FC à ${evidenceRef}`, value: bpm(point.hr), reference: `${bpm(trend)} en tendance` }],
        });
      }
    }

    // Contre la meilleure forme des six derniers mois.
    const best = bestForm(past);
    if (best && point.hr - best.hr >= 2 * te) {
      const gap = point.hr - best.hr;
      const sinceBreak = breakStart ? series.filter((p) => p.date >= breakStart.resumed) : [];
      const slopeWeek = sinceBreak.length >= 3 ? trendPerWeek(sinceBreak) : null;
      const broke = breakStart && best.to < breakStart.resumed;
      const course =
        slopeWeek == null
          ? ''
          : slopeWeek <= -1
            ? ` Depuis la reprise, l'écart se referme d'environ ${Math.round(-slopeWeek)} bpm par semaine.`
            : ` Depuis la reprise (${sinceBreak.map((p) => Math.round(p.hr)).join(' → ')} bpm), il ne se referme pas encore : c'est attendu la première semaine.`;
      findings.push({
        code: 'aerobic_gap',
        domain: 'fitness',
        tone: 'neutral',
        weight: 72,
        confidence: past.length >= 6 ? 'high' : 'medium',
        title: `Ton cœur bat ${Math.round(gap)} bpm plus haut qu'au meilleur de ta forme, à la même allure`,
        gist: `un cœur encore ${Math.round(gap)} bpm au-dessus de ta meilleure forme`,
        detail:
          `À ${kmh(ref)} km/h à plat : ${bpm(point.hr)} aujourd'hui${heatNote(point)}, ${bpm(best.hr)} entre le ${dm(best.from)} et le ${dm(best.to)}. ` +
          (broke
            ? `C'est ce qu'ont coûté les ${breakStart!.days} jours sans courir : la forme aérobie de course se perd en quelques semaines et revient à peu près au même rythme, à condition de courir facile et souvent.`
            : 'C\'est la distance qui te sépare de ta meilleure forme récente.') +
          course,
        evidence: [{ label: `FC à ${evidenceRef}`, value: bpm(point.hr), reference: `${bpm(best.hr)} au mieux` }],
      });
    } else if (best && point.hr <= best.hr - te && past.length >= 6) {
      findings.push({
        code: 'aerobic_best',
        domain: 'fitness',
        tone: 'positive',
        weight: 75,
        confidence: point.windows >= 8 ? 'high' : 'medium',
        title: `Meilleure économie cardiaque des six derniers mois`,
        gist: 'ta meilleure économie cardiaque des six derniers mois',
        detail:
          `À ${kmh(ref)} km/h à plat, ton cœur était à ${bpm(point.hr)}, sous ton meilleur niveau précédent (${bpm(best.hr)}, ` +
          `du ${dm(best.from)} au ${dm(best.to)}). C'est la forme aérobie qui monte.`,
        evidence: [{ label: `FC à ${evidenceRef}`, value: bpm(point.hr), reference: `${bpm(best.hr)} au mieux` }],
      });
    }
  } else if (isRun(run.activity) && groundSpeed && hrVerdict !== 'unusable') {
    limits.push('Pas assez de course régulière à plat ou en faux-plat (5 min au moins, hors échauffement et après tout effort dur) pour lire la FC à allure égale.');
  }

  // ── Endurance dans la sortie ────────────────────────────────────────────
  const drift = withinSessionDrift(markers, ref, slope);
  if (drift && markers && markers.movingS >= 3600 && hrVerdict !== 'unusable') {
    const hours = markers.movingS / 3600;
    const strong = drift.bpm >= 8;
    const held = drift.bpm <= 3;
    if (strong || held) {
      findings.push({
        code: held ? 'durability_held' : 'durability_drift',
        domain: 'durability',
        tone: held ? 'positive' : heat ? 'caution' : 'negative',
        weight: held ? 45 : 62,
        confidence: drift.windows >= 10 ? 'high' : 'medium',
        gist: held ? 'une endurance tenue' : `une dérive de ${Math.round(drift.bpm)} bpm en fin de sortie`,
        title: held
          ? `Endurance tenue sur ${sessionDuration(markers.movingS)} : le cœur n'a pas dérivé`
          : `+${Math.round(drift.bpm)} bpm à allure égale en fin de sortie`,
        detail: held
          ? `À allure égale, ton cœur était au même niveau dans le dernier tiers que dans le premier (${signed(drift.bpm)} bpm). ` +
            `C'est le signe que la durée est dans tes moyens aujourd'hui.`
          : `À allure égale, ton cœur battait ${Math.round(drift.bpm)} bpm de plus dans le dernier tiers que dans le premier. ` +
            `${heat ? 'La chaleur y contribue. ' : ''}Au-delà de 5 % de dérive sur ${decimal(hours, 1).replace(',0', '')} h, la durée ` +
            `dépasse ce que l'endurance du moment tient sans coût : la prochaine sortie longue garde cette durée plutôt que de l'allonger.`,
        evidence: [{ label: 'Dérive à allure égale', value: `${signed(drift.bpm)} bpm`, reference: '≤ 3 tenu · ≥ 8 marqué' }],
      });
    }
  }

  // ── Montées ──────────────────────────────────────────────────────────────
  const climb = climbReading(markers?.climbs ?? [], before, date, model);
  if (climb) findings.push(climb);

  // ── Records ──────────────────────────────────────────────────────────────
  if (groundSpeed && run.analysis && hrVerdict !== 'unusable') {
    const record = recordReading(run.analysis, before, date, model);
    if (record) findings.push(record);
  }

  // ── Intensité, par terrain ───────────────────────────────────────────────
  const intensity = markers?.intensity;
  const easyIntent = context.planned ? isEasyPlan(context.planned) : false;
  if (intensity && hrVerdict !== 'unusable') {
    const above = intensity.flatAboveVt1S + intensity.climbAboveVt1S + intensity.descentAboveVt1S;
    const flatShare = intensity.flatS > 0 ? intensity.flatAboveVt1S / intensity.flatS : 0;
    if (easyIntent && intensity.flatS >= 900 && flatShare >= 0.2 && intensity.flatAboveVt1S >= 600) {
      findings.push({
        code: 'easy_too_fast',
        domain: 'intensity',
        tone: 'negative',
        weight: 58,
        confidence: hrVerdict === 'good' ? 'high' : 'medium',
        title: `Sur le plat, ${Math.round(flatShare * 100)} % du temps au-dessus du seuil 1`,
        gist: 'trop vite sur le plat pour une séance facile',
        detail:
          `La séance devait se courir facile, sous ${bpm(model.vt1.hr)}. En montée, le dépasser est le terrain ; sur le plat ` +
          `(${sessionDuration(intensity.flatAboveVt1S)} au-dessus), c'est l'allure. Une séance facile courue en endurance active ` +
          `coûte de la fraîcheur sans rien construire de plus.` +
          (findings.some((f) => f.code === 'aerobic_gap')
            ? ' Ton allure habituelle te coûte aujourd\'hui plus de cœur qu\'avant l\'arrêt : c\'est le cœur qui fixe l\'allure, pas l\'inverse.'
            : ''),
        evidence: [{ label: 'Au-dessus de SV1 sur le plat', value: sessionDuration(intensity.flatAboveVt1S), reference: `${sessionDuration(intensity.flatS)} de plat` }],
      });
    } else if (above >= 900 && intensity.climbAboveVt1S >= 0.6 * above && flatShare < 0.2) {
      findings.push({
        code: 'intensity_from_terrain',
        domain: 'intensity',
        tone: 'neutral',
        weight: easyIntent ? 40 : 20,
        confidence: 'high',
        title: `L'intensité vient des montées, pas de l'allure`,
        gist: 'une intensité venue des montées',
        detail:
          `${Math.round((intensity.climbAboveVt1S / above) * 100)} % du temps passé au-dessus du seuil 1 l'a été en montée ; ` +
          `sur le plat, ${Math.round(flatShare * 100)} % seulement : l'allure facile y a été tenue.`,
        evidence: [{ label: 'Au-dessus de SV1', value: sessionDuration(above), reference: `${sessionDuration(intensity.climbAboveVt1S)} en montée` }],
      });
    }
  }

  // ── Le prévu ─────────────────────────────────────────────────────────────
  const compliance = run.analysis?.compliance;
  if (compliance && context.planned) {
    const done = compliance.outcome === 'fulfilled' && compliance.verdict === 'on_target';
    findings.push({
      code: done ? 'plan_done' : 'plan_differs',
      domain: 'plan',
      tone: done ? 'positive' : 'neutral',
      weight: done ? 35 : 42,
      confidence: 'high',
      gist: done ? 'la séance prévue, faite' : 'une autre séance que la prévue',
      title: done
        ? `« ${shortTitle(context.planned.title)} » : faite comme prévue`
        : `Prévu : « ${shortTitle(context.planned.title)} », ${sessionDuration(plannedRunS(context.planned))} de course`,
      detail: done
        ? compliance.detail
        : `Fait : ${sessionDuration(run.activity.movingTimeS)}, ${km(run.activity.distanceM)} km, ${Math.round(run.activity.totalElevationGainM)} m D+. ` +
          `Ce n'est pas un échec : ce qui compte est ce que cette sortie a coûté et apporté, lu ci-dessus, et les règles en tiennent compte pour la suite.`,
      evidence: [],
    });
  }

  // ── Effort perçu ─────────────────────────────────────────────────────────
  if (context.rpe != null && cardiac) {
    const hardFeel = context.rpe >= 7 && easyIntent;
    if (hardFeel && cardiac.deltaBpm >= te) {
      findings.push({
        code: 'feel_and_heart_agree',
        domain: 'fatigue',
        tone: 'negative',
        weight: 78,
        confidence: 'high',
        title: 'Effort ressenti dur, et cœur haut : les deux disent fatigue',
        gist: 'un effort ressenti dur et un cœur haut',
        detail:
          `Tu as noté ${context.rpe}/10 une séance facile, et ton cœur était ${Math.round(cardiac.deltaBpm)} bpm au-dessus de ` +
          `sa tendance à allure égale. Quand le ressenti et la mesure s'accordent, ce n'est plus du bruit.`,
        evidence: [{ label: 'Effort perçu', value: `${context.rpe}/10` }],
      });
    }
  }

  // ── Récupération ─────────────────────────────────────────────────────────
  const recovery = recoveryOf(run, {
    descentRatio: maxDescent > 0 ? descentM / maxDescent : descentBefore.length > 0 ? Infinity : null,
    spike: spike != null,
    model,
  });

  findings.sort((a, b) => b.weight - a.weight);
  const what = describeWhat(run, markers);
  const headline = headlineOf(findings, recovery);

  return {
    activityId: run.activity.id,
    date,
    what,
    headline,
    findings,
    implications: { recovery, cardiac, spike },
    limits,
    aerobicTrend: series.filter((p) => days(p.date, date) <= 120),
    referenceGapMs: ref,
    heat: heatCoef,
  };
}

// ── Lectures ───────────────────────────────────────────────────────────────

/** La dernière coupure de 14 jours ou plus sans course avant la sortie, s'il y en a une dans les 60 jours. */
function lastBreak(before: readonly DebriefRun[], date: string): { days: number; resumed: string } | null {
  const runDates = [...new Set(before.filter((h) => isRun(h.activity)).map((h) => dateOf(h.activity)))].sort();
  runDates.push(date);
  for (let i = runDates.length - 1; i > 0; i--) {
    const gap = days(runDates[i - 1]!, runDates[i]!);
    if (days(runDates[i]!, date) > 60) break;
    if (gap >= BREAK_DAYS) return { days: gap - 1, resumed: runDates[i]! };
  }
  return null;
}

/** La meilleure forme : la plus basse médiane de trois sorties consécutives. */
function bestForm(points: readonly AerobicPoint[]): { hr: number; from: string; to: string } | null {
  if (points.length < 3) return null;
  let best: { hr: number; from: string; to: string } | null = null;
  for (let i = 2; i < points.length; i++) {
    const trio = points.slice(i - 2, i + 1);
    const hr = median(trio.map((p) => p.hr));
    if (!best || hr < best.hr) best = { hr, from: trio[0]!.date, to: trio[2]!.date };
  }
  return best;
}

/** La pente de la FC à allure égale, bpm par semaine, par moindres carrés. */
function trendPerWeek(points: readonly AerobicPoint[]): number {
  const t0 = points[0]!.date;
  const xs = points.map((p) => days(t0, p.date) / 7);
  const ys = points.map((p) => p.hr);
  const mx = xs.reduce((s, x) => s + x, 0) / xs.length;
  const my = ys.reduce((s, y) => s + y, 0) / ys.length;
  let sxy = 0;
  let sxx = 0;
  for (let i = 0; i < xs.length; i++) {
    sxy += (xs[i]! - mx) * (ys[i]! - my);
    sxx += (xs[i]! - mx) ** 2;
  }
  return sxx > 0 ? sxy / sxx : 0;
}

/**
 * La dérive à allure égale : la FC à l'allure de référence dans le dernier
 * tiers, moins celle du premier — corrigée de l'allure, donc du terrain que les
 * fenêtres stables gardent.
 */
export function withinSessionDrift(
  markers: SessionMarkers | undefined,
  ref: number,
  slope: number,
): { bpm: number; windows: number } | null {
  if (!markers || markers.hr.verdict === 'unusable') return null;
  const w = markers.steady.filter((x) => Math.abs(x.gap - ref) <= WINDOW_SPAN_MS);
  const third = markers.movingS / 3;
  const early = w.filter((x) => x.t < third);
  const late = w.filter((x) => x.t >= 2 * third);
  if (early.length < 5 || late.length < 5) return null;
  const at = (xs: SteadyWindow[]) => median(xs.map((x) => x.hr - slope * (x.gap - ref)));
  return { bpm: Math.round((at(late) - at(early)) * 10) / 10, windows: early.length + late.length };
}

/** Les tranches de pente où les montées se comparent (Vernillo 2017) : la vitesse ascensionnelle en dépend. */
const CLIMB_BINS = [0.08, 0.12, 0.18, 0.25, Infinity] as const;
const binOf = (grade: number) => CLIMB_BINS.findIndex((top) => grade < top);

/**
 * Les montées, contre celles des quatre derniers mois de même pente et de même
 * allure — marchées ou courues : la vitesse ascensionnelle par battement
 * au-dessus du repos. Une montée de 5 min au moins, 50 m au moins, à 8 % au
 * moins, cardio lu à partir de sa deuxième minute.
 */
function climbReading(
  climbs: readonly ClimbSegment[],
  before: readonly DebriefRun[],
  date: string,
  model: PhysiologyModel,
): Finding | null {
  const valid = (c: ClimbSegment) =>
    c.durationS >= 300 && c.gainM >= 50 && c.grade >= 0.08 && c.hr != null && c.hr > model.hrRest + 20;
  const eff = (c: ClimbSegment) => c.vamMh / (c.hr! - model.hrRest);
  const key = (c: ClimbSegment) => `${c.hiked >= 0.5 ? 'hike' : 'run'}:${binOf(c.grade)}`;
  const mine = climbs.filter(valid);
  if (mine.length === 0) return null;
  const past = new Map<string, number[]>();
  for (const h of before) {
    if (days(dateOf(h.activity), date) > 120 || !h.analysis?.markers || h.analysis.markers.hr.verdict === 'unusable') continue;
    for (const c of h.analysis.markers.climbs.filter(valid)) {
      const list = past.get(key(c)) ?? [];
      list.push(eff(c));
      past.set(key(c), list);
    }
  }
  // Chaque montée du jour contre la médiane de sa tranche, si la tranche en a quatre.
  const ratios: { c: ClimbSegment; r: number; norm: number }[] = [];
  for (const c of mine) {
    const ref = past.get(key(c));
    if (!ref || ref.length < 4) continue;
    const norm = median(ref);
    ratios.push({ c, r: eff(c) / norm, norm });
  }
  if (ratios.length === 0) return null;
  const r = median(ratios.map((x) => x.r));
  const pct = Math.round((r - 1) * 100);
  // Une montée refaite varie de 3 à 5 % ; des montées seulement comparables, davantage.
  if (Math.abs(pct) < 8) return null;
  const best = ratios.reduce((a, b) => (b.c.vamMh > a.c.vamMh ? b : a)).c;
  const hiked = ratios.filter((x) => x.c.hiked >= 0.5).length >= ratios.length / 2;
  const how = hiked ? 'marchées' : 'courues';
  return {
    code: pct > 0 ? 'climb_better' : 'climb_worse',
    domain: 'climb',
    tone: pct > 0 ? 'positive' : 'caution',
    weight: pct > 0 ? 50 : 44,
    confidence: ratios.length >= 2 ? 'medium' : 'low',
    title: `Montées ${how} : ${pct > 0 ? '+' : '−'}${Math.abs(pct)} % de vitesse ascensionnelle à cœur égal`,
    gist: pct > 0 ? 'des montées plus rentables' : 'des montées moins rentables',
    detail:
      `Rapportées au cœur, tes ${ratios.length > 1 ? `${ratios.length} montées` : 'montées'} ${how} d'aujourd'hui ` +
      `(la plus rapide à ${best.vamMh} m/h sur ${best.gainM} m, ${Math.round(best.grade * 100)} %) ` +
      `${pct > 0 ? 'rendent plus' : 'rendent moins'} que celles de même pente de tes quatre derniers mois. ` +
      (pct > 0 ? 'Ce sont les jambes de grimpeur qui répondent.' : 'Une sortie seule ne fait pas une tendance : à revoir sur la prochaine.'),
    evidence: ratios.slice(0, 3).map((x) => ({
      label: `${x.c.gainM} m à ${Math.round(x.c.grade * 100)} %`,
      value: `${x.c.vamMh} m/h à ${bpm(x.c.hr!)}`,
      reference: `${decimal(x.norm, 1)} m/h par battement d'habitude`,
    })),
  };
}

/** Un record de la courbe vitesse-durée ou de la vitesse ascensionnelle, à l'effort prouvé. */
function recordReading(
  analysis: ActivityAnalysis,
  before: readonly DebriefRun[],
  date: string,
  model: PhysiologyModel,
): Finding | null {
  const recent = before.filter((h) => days(dateOf(h.activity), date) <= 90 && h.analysis);
  if (recent.length < 5) return null;
  const durations = ['180', '300', '600', '1200', '1800', '3600'];
  const beats: { label: string; now: number; prev: number }[] = [];
  for (const d of durations) {
    const now = analysis.meanMaximalSpeed[d];
    const hr = analysis.meanMaximalSpeedHr?.[d];
    if (now == null || hr == null || hr < model.vt2.hr - 5) continue;
    const prev = Math.max(0, ...recent.map((h) => h.analysis!.meanMaximalSpeed[d] ?? 0));
    if (prev > 0 && now > prev * 1.01) beats.push({ label: sessionDuration(Number(d)), now: now * 3.6, prev: prev * 3.6 });
  }
  for (const d of ['300', '600', '1200', '1800']) {
    const now = analysis.meanMaximalVam[d];
    if (now == null) continue;
    const prev = Math.max(0, ...recent.map((h) => h.analysis!.meanMaximalVam[d] ?? 0));
    if (prev > 0 && now > prev * 1.02) beats.push({ label: `${sessionDuration(Number(d))} en montée`, now, prev });
  }
  if (beats.length === 0) return null;
  const top = beats[0]!;
  const vertical = top.label.includes('montée');
  return {
    code: 'record',
    domain: 'performance',
    tone: 'positive',
    weight: 68,
    confidence: 'high',
    title: `Record des trois derniers mois sur ${beats.map((b) => b.label).join(', ')}`,
    gist: `un record sur ${top.label}`,
    detail:
      `${top.label} : ${vertical ? `${Math.round(top.now)} m/h` : `${decimal(top.now, 1)} km/h corrigés de la pente`}, contre ` +
      `${vertical ? `${Math.round(top.prev)} m/h` : `${decimal(top.prev, 1)} km/h`} au mieux jusqu'ici. Le modèle en tient compte : ` +
      `les allures et les prédictions qui en dépendent suivent.`,
    evidence: beats.map((b) => ({
      label: b.label,
      value: b.label.includes('montée') ? `${Math.round(b.now)} m/h` : `${decimal(b.now, 1)} km/h`,
      reference: b.label.includes('montée') ? `${Math.round(b.prev)} m/h` : `${decimal(b.prev, 1)} km/h`,
    })),
  };
}

/** Une séance prévue facile : sans bloc au-dessus de la zone 2. */
function isEasyPlan(p: NonNullable<DebriefContext['planned']>): boolean {
  if (['recovery', 'endurance'].includes(p.type)) return true;
  return p.blocks.length > 0 && p.blocks.every((b) => !b.zone || b.zone === 'Z1' || b.zone === 'Z2');
}

/**
 * Le temps de récupération avant une nouvelle séance dure, et avant une
 * descente rapide.
 *
 * Autonome : 24 h après une sortie facile, 36 h après 20 min entre les deux
 * seuils ou 75 min de course, 48 h après 10 min au-dessus du seuil 2 ou une
 * réserve anaérobie vidée (Stanley 2013). Glycogène : 24 h au-delà de 90 min
 * (Burke 2011). Excentrique : le muscle qui freine se répare en 48 à 72 h, et
 * davantage sans exposition récente — 72 h quand la descente dépasse la plus
 * grosse du mois, 48 h quand elle en fait plus de la moitié (Bontemps 2020).
 * Des fourchettes de littérature : provenance `default`, tant que les
 * réponses de l'athlète ne les ont pas recalées.
 */
export function recoveryOf(
  run: DebriefRun,
  opts: { descentRatio: number | null; spike: boolean; model: PhysiologyModel },
): DebriefImplications['recovery'] {
  const reasons: string[] = [];
  const a = run.activity;
  const minutes = a.movingTimeS / 60;
  const i = run.analysis?.markers?.intensity;
  const aboveVt1 = i ? i.flatAboveVt1S + i.climbAboveVt1S + i.descentAboveVt1S : 0;
  const hardS = i?.aboveVt2S ?? 0;
  const betweenS = Math.max(0, aboveVt1 - hardS);
  const wUsed = run.analysis?.wPrimeBalanceMinM != null && opts.model.dPrimeM > 0
    ? 1 - run.analysis.wPrimeBalanceMinM / opts.model.dPrimeM
    : 0;

  let quality = 24;
  if (hardS >= 600 || wUsed >= 0.85) {
    quality = 48;
    reasons.push(`${hardS >= 600 ? `${sessionDuration(hardS)} au-dessus du seuil 2` : 'réserve anaérobie vidée'} : 48 h avant une séance dure`);
  } else if (betweenS >= 1200 || minutes >= 75) {
    quality = 36;
    reasons.push(
      `${betweenS >= 1200 ? `${sessionDuration(betweenS)} entre les deux seuils` : `${sessionDuration(a.movingTimeS)} de course`} : 36 h avant une séance dure`,
    );
  }
  if (minutes >= 90) reasons.push('plus de 90 min : les réserves de glucides demandent 24 h, à condition de manger');
  if (opts.spike && quality < 48) {
    quality = 48;
    reasons.push('la sortie la plus longue du mois, de loin : le lendemain se court facile ou se repose, 48 h avant une séance dure');
  }

  const descentM = a.totalElevationLossM ?? 0;
  let eccentric = 0;
  if (descentM >= 150 && opts.descentRatio != null && opts.descentRatio > 1) {
    eccentric = 72;
    reasons.push(`${Math.round(descentM)} m de descente, plus que tout le mois : 72 h avant une descente rapide`);
  } else if (descentM >= 150 && opts.descentRatio != null && opts.descentRatio >= 0.5) {
    eccentric = 48;
    reasons.push(`${Math.round(descentM)} m de descente : 48 h avant une descente rapide`);
  } else if ((run.analysis?.load.mechanical ?? 0) >= 35) {
    eccentric = 48;
    reasons.push(`${Math.round(run.analysis!.load.mechanical)} points de charge excentrique : 48 h avant une descente rapide`);
  } else if (descentM >= 100) {
    eccentric = 24;
  }
  return { qualityHours: quality, eccentricHours: eccentric, reasons };
}

/** Ce qui a été fait, en une ligne : durée, terrain, intensité. */
function describeWhat(run: DebriefRun, markers: SessionMarkers | undefined): string {
  const a = run.activity;
  const minutes = a.movingTimeS / 60;
  const perKm = a.distanceM > 0 ? a.totalElevationGainM / (a.distanceM / 1000) : 0;
  if (!isRun(a)) return `${a.name}, ${sessionDuration(a.movingTimeS)}`;
  const kind = minutes >= 75 ? 'Sortie longue' : minutes >= 40 ? 'Sortie' : 'Sortie courte';
  const terrain = perKm >= 50 ? ' en montagne' : perKm >= 20 ? ' vallonnée' : perKm < 8 ? ' à plat' : '';
  const i = markers?.intensity;
  let effort = '';
  if (i) {
    const total = i.flatS + i.climbS + i.descentS;
    const hard = total > 0 ? i.aboveVt2S / total : 0;
    const flatAbove = i.flatS > 0 ? i.flatAboveVt1S / i.flatS : 0;
    const climbShare = i.climbAboveVt1S / Math.max(1, i.flatAboveVt1S + i.climbAboveVt1S + i.descentAboveVt1S);
    effort =
      hard >= 0.12 ? ', intense'
      : flatAbove >= 0.5 ? ', soutenue'
      : flatAbove >= 0.2 ? ', modérée'
      : climbShare >= 0.6 && i.climbAboveVt1S >= 600 ? ', facile sur le plat, appuyée en montée'
      : ', facile';
  }
  const dplus = a.totalElevationGainM >= 50 ? `, ${Math.round(a.totalElevationGainM)} m D+` : '';
  return `${kind}${terrain}${effort} — ${sessionDuration(a.movingTimeS)}, ${km(a.distanceM)} km${dplus}`;
}

/**
 * Le verdict : les trois constats qui pèsent le plus, en quelques mots chacun,
 * puis le délai avant une séance dure quand il dépasse une journée. Les
 * constats se lisent en entier dessous : le verdict les assemble sans les
 * répéter. Ce qui a été fait se lit à côté (`what`).
 */
function headlineOf(findings: readonly Finding[], recovery: DebriefImplications['recovery']): string {
  const top = findings.filter((f) => f.domain !== 'plan' && f.domain !== 'data').slice(0, 3).map((f) => f.gist);
  const wait = recovery.qualityHours >= 36 ? ` ${recovery.qualityHours} h avant une séance dure.` : '';
  if (top.length === 0) return `Rien qui sorte de ta tendance.${wait}`;
  const said = top.length === 1 ? top[0]! : `${top.slice(0, -1).join(', ')} et ${top.at(-1)}`;
  return `${said.charAt(0).toUpperCase()}${said.slice(1)}.${wait}`;
}

/** Le format d'un titre, sans ce qu'il mesure : « Sortie longue vallonnée » dans « Sortie longue vallonnée 1 h 05 + souplesse… ». */
const shortTitle = (title: string) =>
  title.replace(/\s+[·+—].*$/, '').replace(/\s+\d+(?:[.,]\d+)?\s*(?:min|h)(?:\s*\d+)?$/i, '').trim();

/** Le temps de course d'une séance prévue, sans la souplesse ni le renforcement qui s'y ajoutent. */
const plannedRunS = (p: NonNullable<DebriefContext['planned']>) => runDurationOf(p as PlannedSession) || p.plannedDurationS;
/** « (24 °C : 3 bpm retirés pour la chaleur) », quand la chaleur a pesé. */
const heatNote = (p: AerobicPoint) =>
  p.tempC != null && (p.heatBpm ?? 0) >= 1
    ? ` (par ${Math.round(p.tempC)} °C : ${Math.round(p.heatBpm!)} bpm retirés pour la chaleur)`
    : '';
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${decimal(Math.abs(v), 0)}`;
