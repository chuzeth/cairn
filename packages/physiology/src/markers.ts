import type {
  ActivityStreams, ClimbSegment, HrQuality, PhysiologyModel, SessionMarkers, SteadyWindow, TerrainIntensity,
} from '@cairn/core';

export type { ClimbSegment, HrQuality, SessionMarkers, SteadyWindow, TerrainIntensity } from '@cairn/core';
import { cleanHeartRate } from './decoupling.js';
import { gaitForSpeed, gradeAdjustedSpeed } from './grade.js';
import { movingIndices } from './streams.js';
import { mean } from './units.js';

/**
 * Ce qu'une sortie dit d'elle-même, sous une forme qui se compare d'une sortie
 * à l'autre.
 *
 * L'analyse d'une séance décrit la séance : sa charge, ses zones, sa courbe. Ce
 * qu'un entraîneur en retire vient d'ailleurs — de la comparaison avec les
 * séances d'avant. Une FC de 152 bpm à 10,8 km/h ne veut rien dire seule ; à
 * 17 bpm au-dessus de la même vitesse fin septembre, elle dit ce que cinq
 * semaines sans course ont coûté. Ce module extrait de chaque sortie ce qui se
 * compare : la fiabilité du cardio, des fenêtres d'allure stable avec leur FC,
 * et les montées. La comparaison elle-même se fait dans `debrief.ts`, contre
 * l'historique.
 *
 * Les fenêtres sont gardées brutes plutôt que résumées en un chiffre : la
 * relation FC-vitesse se calcule sur tout l'historique à la fois (une pente
 * commune, une ordonnée par sortie), et un résumé figé au jour de la sortie ne
 * profiterait pas des sorties qui viennent ensuite.
 */

/** Version du format : un changement d'extraction invalide les marqueurs stockés. */
export const MARKERS_VERSION = 1;

/** Durée d'une fenêtre stable, s. */
export const STEADY_WINDOW_S = 120;
/** Ce qui est écarté au départ : le cœur et le capteur mettent plusieurs minutes à rejoindre l'allure. */
const WARMUP_S = 480;
/** Les fenêtres se chevauchent d'une minute : une montée ne coupe pas deux fenêtres à la fois. */
const STEADY_STEP_S = 60;
/** L'allure doit être tenue depuis une minute avant la fenêtre. */
const STEADY_LEAD_S = 60;
/** Retard du cardio optique sur l'allure, s. */
const HR_LAG_S = 20;
/** Une allure est stable quand elle varie de moins de 12 % sur la fenêtre et les deux minutes qui la précèdent. */
const STEADY_CV = 0.15;
/**
 * La pente d'une fenêtre stable : de −5 à +12 %. Au-delà en montée, la course
 * devient une ascension ; en descente, la correction de pente crédite trop la
 * vitesse (Minetti), et la FC ne suit plus l'allure.
 */
const STEADY_GRADE = { min: -0.05, max: 0.12 } as const;
/** Après un effort au-dessus du seuil 2, la FC reste haute plusieurs minutes : ces fenêtres sont écartées. */
const AFTER_HARD_S = 180;

/** Au-delà de ±4 %, le terrain monte ou descend. */
const TERRAIN_GRADE = 0.04;

const CLIMB_MIN_GRADE = 0.05;
const CLIMB_MIN_S = 150;
const CLIMB_MIN_GAIN_M = 40;
/** Un replat de moins de 20 s ne coupe pas une montée. */
const CLIMB_BREAK_S = 20;
/** La FC d'une montée se lit à partir de sa deuxième minute : avant, elle monte encore. */
const CLIMB_HR_SETTLE_S = 120;

/**
 * La FC se cale sur la cadence — le pas (pas/min) ou le balancement du bras (sa
 * moitié) : à 6 battements du pas ou 4 du bras, au-dessus de 140 pas/min,
 * pendant au moins 60 s, entrée par un saut de 15 bpm que l'allure n'explique
 * pas. Un capteur optique au poignet tire volontairement la FC vers le pas
 * quand ils se croisent (brevet Valencell US10542896) ; sans saut d'entrée, une
 * FC égale à la cadence peut être vraie, au seuil : elle est gardée.
 */
const LOCK = { stepBpm: 6, armBpm: 4, minCadence: 140, minRunS: 60, jumpBpm: 15, jumpWindowS: 15 } as const;

export function extractMarkers(
  streams: ActivityStreams,
  model: Pick<PhysiologyModel, 'hrMax' | 'hrRest' | 'vt1' | 'vt2'>,
  opts: { groundSpeed: boolean },
): SessionMarkers {
  const idx = movingIndices(streams);
  const n = idx.length;
  const rawHr = streams.heartrate ? idx.map((i) => streams.heartrate![i] ?? null) : [];
  const hr = streams.heartrate ? cleanHeartRate(rawHr, model.hrMax) : new Array<number | null>(n).fill(null);
  const speed = idx.map((i) => streams.velocity[i] ?? 0);
  const grade = idx.map((i) => streams.grade[i] ?? 0);
  const gap = idx.map((_, k) => gradeAdjustedSpeed(speed[k]!, grade[k]!));
  const cadence = idx.map((i) => streams.cadence?.[i] ?? null);
  const altitude = idx.map((i) => streams.altitude[i] ?? 0);

  const quality = hrQuality(hr, cadence, gap);
  const locked = quality.locked;
  const usableHr = quality.verdict !== 'unusable';

  const steady = opts.groundSpeed && usableHr ? steadyWindows(gap, hr, grade, speed, cadence, locked, model) : [];
  const climbs = climbSegments(altitude, grade, speed, usableHr ? hr : new Array(n).fill(null), locked);

  const intensity = usableHr ? terrainIntensity(hr, grade, locked, model) : null;

  const { locked: _drop, ...hrOut } = quality;
  return { version: MARKERS_VERSION, movingS: n, hr: hrOut, intensity, steady, climbs };
}

/** La fiabilité du cardio, et les secondes où il suit la cadence. */
export function hrQuality(
  hr: readonly (number | null)[],
  cadence: readonly (number | null)[],
  gap: readonly number[],
): HrQuality & { locked: boolean[] } {
  const n = hr.length;
  const locked = new Array<boolean>(n).fill(false);
  if (n === 0 || hr.every((h) => h == null)) {
    return { coverage: 0, cadenceLockS: 0, dropoutS: 0, spikes: 0, verdict: 'unusable', reasons: ['aucune fréquence cardiaque'], locked };
  }
  const covered = hr.filter((h) => h != null).length;
  const coverage = covered / n;

  // Trous de 10 s ou plus.
  let dropoutS = 0;
  let gapRun = 0;
  for (let k = 0; k <= n; k++) {
    if (k < n && hr[k] == null) gapRun++;
    else {
      if (gapRun >= 10) dropoutS += gapRun;
      gapRun = 0;
    }
  }

  // Sauts : 25 bpm en 5 s sans que l'allure change de 15 %.
  let spikes = 0;
  for (let k = 5; k < n; k++) {
    const a = hr[k - 5];
    const b = hr[k];
    if (a == null || b == null) continue;
    const g0 = gap[k - 5] ?? 0;
    const g1 = gap[k] ?? 0;
    if (Math.abs(b - a) >= 25 && Math.abs(g1 - g0) < 0.15 * Math.max(g0, 0.5)) {
      spikes++;
      k += 5;
    }
  }

  // Calage sur la cadence : des plages où FC ≈ cadence, entrées par un saut.
  let run = 0;
  for (let k = 0; k <= n; k++) {
    const h = k < n ? hr[k] : null;
    const c = k < n ? cadence[k] : null;
    const near =
      h != null && c != null && c >= LOCK.minCadence &&
      (Math.abs(h - c) <= LOCK.stepBpm || Math.abs(h - c / 2) <= LOCK.armBpm);
    if (near) {
      run++;
      continue;
    }
    if (run >= LOCK.minRunS) {
      const start = k - run;
      if (jumpedInto(hr, gap, start)) for (let j = start; j < k; j++) locked[j] = true;
    }
    run = 0;
  }
  const cadenceLockS = locked.filter(Boolean).length;

  const reasons: string[] = [];
  const lockShare = cadenceLockS / n;
  if (coverage < 0.8) reasons.push(`FC présente sur ${Math.round(coverage * 100)} % de la sortie`);
  if (lockShare >= 0.05) reasons.push(`FC calée sur la cadence pendant ${Math.max(1, Math.round(cadenceLockS / 60))} min`);
  if (spikes >= 5) reasons.push(`${spikes} sauts de FC que l'allure n'explique pas`);
  // Seuils : moins de 5 % calé, la FC vaut avec ses passages écartés ; au-delà
  // de 20 %, ou sous 60 % de couverture, elle ne fonde plus rien.
  const verdict: HrQuality['verdict'] =
    coverage < 0.6 || lockShare > 0.2 ? 'unusable'
    : coverage < 0.8 || lockShare >= 0.05 || spikes >= 5 ? 'doubtful'
    : 'good';
  return { coverage: round(coverage, 3), cadenceLockS, dropoutS, spikes, verdict, reasons, locked };
}

/** La plage commence-t-elle par un saut de FC que l'allure n'explique pas ? */
function jumpedInto(hr: readonly (number | null)[], gap: readonly number[], start: number): boolean {
  const from = Math.max(0, start - LOCK.jumpWindowS);
  const before = hr.slice(from, start).filter((h): h is number => h != null);
  const after = hr.slice(start, start + 5).filter((h): h is number => h != null);
  if (before.length < 5 || after.length < 3) return false;
  const jump = Math.abs((mean(after) as number) - (mean(before) as number));
  const g0 = mean(gap.slice(from, start)) ?? 0;
  const g1 = mean(gap.slice(start, start + 10)) ?? 0;
  return jump >= LOCK.jumpBpm && Math.abs(g1 - g0) < 0.1 * Math.max(g0, 0.5);
}

/**
 * Les fenêtres où la FC répond à une allure tenue : deux minutes de course
 * régulière, précédées d'une minute à la même allure, hors échauffement, à
 * trois minutes au moins de tout effort au-dessus du seuil 2, sous la pente
 * d'une côte.
 */
function steadyWindows(
  gap: readonly number[],
  hr: readonly (number | null)[],
  grade: readonly number[],
  speed: readonly number[],
  cadence: readonly (number | null)[],
  locked: readonly boolean[],
  model: Pick<PhysiologyModel, 'hrRest' | 'vt2'>,
): SteadyWindow[] {
  const L = STEADY_WINDOW_S;
  const out: SteadyWindow[] = [];
  const hardHr = model.vt2.hr + 3;
  // Secondes cumulées au-dessus du seuil 2, échantillon par échantillon.
  const hardSoFar = new Array<number>(hr.length + 1).fill(0);
  for (let j = 0; j < hr.length; j++) hardSoFar[j + 1] = hardSoFar[j]! + ((hr[j] ?? 0) > hardHr ? 1 : 0);
  for (let k = WARMUP_S; k + L + HR_LAG_S <= gap.length; k += STEADY_STEP_S) {
    const span = gap.slice(k - STEADY_LEAD_S, k + L);
    const m = mean(span) ?? 0;
    if (m < 2.0) continue;
    const sd = Math.sqrt(span.reduce((s, g) => s + (g - m) ** 2, 0) / span.length);
    if (sd / m > STEADY_CV) continue;
    const g = gap.slice(k, k + L);
    const mg = mean(g) ?? 0;
    const mgr = mean(grade.slice(k, k + L)) ?? 0;
    if (mgr < STEADY_GRADE.min || mgr > STEADY_GRADE.max) continue;
    // Une course : la marche ne se compare pas à la course, à vitesse corrigée égale.
    let walked = 0;
    for (let j = k; j < k + L; j++) if (gaitForSpeed(speed[j]!, grade[j]!) === 'walk') walked++;
    if (walked > L * 0.1) continue;
    const h: number[] = [];
    let lockedHere = false;
    for (let j = k + HR_LAG_S; j < k + L + HR_LAG_S; j++) {
      if (locked[j]) lockedHere = true;
      const v = hr[j];
      if (v != null) h.push(v);
    }
    if (lockedHere || h.length < L * 0.8) continue;
    const mh = mean(h) as number;
    if (mh > model.vt2.hr + 5 || mh < model.hrRest + 30) continue;
    const recent = hr.slice(Math.max(0, k - AFTER_HARD_S), k).filter((v): v is number => v != null);
    if (recent.some((v) => v > hardHr)) continue;
    const c = cadence.slice(k, k + L).filter((v): v is number => v != null && v > 100);
    out.push({
      t: k,
      gap: round(mg, 3),
      hr: round(mh, 1),
      grade: round(mgr, 3),
      cadence: c.length >= L * 0.5 ? round(mean(c) as number, 1) : null,
      hardBeforeS: hardSoFar[k]!,
    });
  }
  return out;
}

/** Le temps au-dessus des seuils, sur le plat, en montée, en descente. */
function terrainIntensity(
  hr: readonly (number | null)[],
  grade: readonly number[],
  locked: readonly boolean[],
  model: Pick<PhysiologyModel, 'vt1' | 'vt2'>,
): TerrainIntensity {
  const out: TerrainIntensity = {
    flatAboveVt1S: 0, climbAboveVt1S: 0, descentAboveVt1S: 0, aboveVt2S: 0, flatS: 0, climbS: 0, descentS: 0,
  };
  for (let k = 0; k < hr.length; k++) {
    // Le cœur suit le terrain avec 20 s de retard.
    const h = hr[Math.min(hr.length - 1, k + HR_LAG_S)];
    if (h == null || locked[k]) continue;
    const g = grade[k] ?? 0;
    const above = h > model.vt1.hr;
    if (g > TERRAIN_GRADE) { out.climbS++; if (above) out.climbAboveVt1S++; }
    else if (g < -TERRAIN_GRADE) { out.descentS++; if (above) out.descentAboveVt1S++; }
    else { out.flatS++; if (above) out.flatAboveVt1S++; }
    if (h > model.vt2.hr) out.aboveVt2S++;
  }
  return out;
}

/** Les montées continues de plus de 40 m et de 2 min 30, replats de moins de 20 s compris. */
function climbSegments(
  altitude: readonly number[],
  grade: readonly number[],
  speed: readonly number[],
  hr: readonly (number | null)[],
  locked: readonly boolean[],
): ClimbSegment[] {
  const out: ClimbSegment[] = [];
  let start = -1;
  let flat = 0;
  for (let k = 0; k <= grade.length; k++) {
    const up = k < grade.length && grade[k]! > CLIMB_MIN_GRADE;
    if (up) {
      if (start < 0) start = k;
      flat = 0;
      continue;
    }
    if (start < 0) continue;
    flat++;
    if (flat <= CLIMB_BREAK_S && k < grade.length) continue;
    const end = k - flat + 1;
    const durationS = end - start;
    const gainM = (altitude[end - 1] ?? 0) - (altitude[start] ?? 0);
    if (durationS >= CLIMB_MIN_S && gainM >= CLIMB_MIN_GAIN_M) {
      const from = Math.min(start + CLIMB_HR_SETTLE_S, end - 30);
      const beats: number[] = [];
      for (let j = from; j < Math.min(end + 10, hr.length); j++) {
        const v = hr[j];
        if (v != null && !locked[j]) beats.push(v);
      }
      let walked = 0;
      for (let j = start; j < end; j++) if (gaitForSpeed(speed[j]!, grade[j]!) === 'walk') walked++;
      out.push({
        t: start,
        durationS,
        gainM: Math.round(gainM),
        vamMh: Math.round((gainM / durationS) * 3600),
        grade: round(mean(grade.slice(start, end)) ?? 0, 3),
        hr: beats.length >= 30 ? round(mean(beats) as number, 1) : null,
        hiked: round(walked / durationS, 2),
      });
    }
    start = -1;
    flat = 0;
  }
  return out;
}

const round = (v: number, digits: number) => Math.round(v * 10 ** digits) / 10 ** digits;
