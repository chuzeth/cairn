import type {
  CourseProfile, LapFormat, LapLimiter, LapProjection, LapRacePrediction, PhysiologyModel,
} from '@cairn/core';
import { durabilityFactor, DURABILITY_FLOOR } from './durability.js';
import { environmentalFactor, nightFactor, technicalityFactor } from './environment.js';
import { FLAT_RUNNING_COST } from './grade.js';
import { fuelingTargets } from './load.js';
import { buildCourseSegments, fractionalUtilization, solveSegmentTimes } from './prediction.js';
import { clamp } from './units.js';

/**
 * Prédiction d'un format à boucle répétée — la « backyard ».
 *
 * `predictRace` répond à « combien de temps pour parcourir cette distance ».
 * Ici la distance n'est pas une donnée : une boucle est relancée à chaque
 * cloche, et la question utile est tout autre — à quelle allure il boucle,
 * comment cette allure dérive, à quelle boucle le temps de boucle atteint
 * l'intervalle, et combien de repos reste en chemin.
 *
 * Le moteur ne change pas pour autant. Le niveau d'allure vient de la même
 * composition que sur une course classique : vitesse critique, fraction
 * soutenable pour la durée, correction de durabilité, terrain, chaleur,
 * altitude, nuit, fraîcheur. Ce qui s'ajoute, c'est la **forme** de la
 * trajectoire — et elle vient de la durabilité mesurée de l'athlète, qui dit
 * précisément cela : à effort constant, de combien la vitesse s'érode par
 * heure.
 */

/** Durabilité de référence de la population entraînée, %/h — le point zéro de la correction. */
const REFERENCE_DURABILITY_PCT_PER_HOUR = 3.0;

/**
 * Horizon de projection : 24 h d'horloge.
 *
 * Ce n'est pas une opinion sur ce que l'athlète peut tenir, c'est la portée de
 * la courbe qui le calcule. `fractionalUtilization` est calibrée sur des repères
 * qui s'arrêtent vers dix heures ; à vingt-quatre, on l'extrapole déjà. Au-delà,
 * le moteur ne répondrait plus qu'à lui-même — il dit alors qu'il ne sait pas,
 * plutôt que d'annoncer une boucle de sortie qui ne mesure que la longueur de
 * l'horizon.
 */
const HORIZON_CLOCK_S = 24 * 3600;
const MAX_HORIZON_LAPS = 96;

const horizonLaps = (intervalS: number): number =>
  clamp(Math.ceil(HORIZON_CLOCK_S / Math.max(60, intervalS)), 2, MAX_HORIZON_LAPS);

export interface LapPredictionInput {
  model: PhysiologyModel;
  /** Parcours porteur d'un `lap`. Sans lui, la fonction refuse de répondre. */
  course: CourseProfile;
  /** Ambition, en boucles. */
  targetLaps: number;
  /** TSB métabolique attendu le jour de la course. */
  raceDayTsb?: number;
  /** Séances par forte chaleur sur les 14 derniers jours (acclimatation). */
  hotSessionsLast14Days?: number;
  /** Coupe facteurs limitants et sensibilités — les contrefactuels se rejouent ici. */
  skipCounterfactuals?: boolean;
}

/** Trajectoire brute : ce que le noyau produit avant mise en forme. */
interface LapTrajectory {
  lapTimes: number[];
  fractions: number[];
  runningToTarget: number;
  sustainableLaps: number;
  cutoffLap: number | null;
  horizonReason: LapRacePrediction['horizonReason'];
  levelFraction: number;
  durabilityAtTarget: number;
  env: { total: number; heat: number; altitude: number };
  freshness: number;
}

function lapVert(lap: LapFormat): { gain: number; loss: number } {
  const gain = lap.elevationGainM ?? 0;
  return { gain, loss: lap.elevationLossM ?? gain };
}

/**
 * Le noyau : trajectoire des temps de boucle.
 *
 * Deux décisions, et elles se séparent proprement.
 *
 * **Le niveau** — la vitesse moyenne sur l'ambition — est exactement celui que
 * `predictRace` donnerait pour le même temps couru : `fractionalUtilization`
 * fixe la fraction de vitesse critique soutenable, la correction de durabilité
 * situe l'athlète par rapport à la référence de population, l'environnement
 * fait le reste. Les deux moteurs disent donc la même chose de la même course.
 *
 * **La forme** — la dérive d'une boucle à l'autre — vient de la durabilité
 * mesurée, normalisée à moyenne 1 sur l'ambition. Normalisée, parce que sans
 * cela la perte horaire serait comptée deux fois : une première dans le niveau,
 * une seconde dans la pente. À moyenne 1, elle n'ajoute rien au total ; elle ne
 * fait que répartir — et c'est tout ce qu'on lui demande.
 *
 * La dérive porte sur la **vitesse équivalente à plat**, pas sur la puissance
 * métabolique. C'est la grandeur sur laquelle la durabilité est mesurée —
 * `extractDurabilityWindows` régresse une vitesse corrigée de la pente — et
 * c'est aussi la seule qui se dérive proprement : la conversion puissance →
 * vitesse traverse le seuil marche/course, où une plage entière de puissances
 * rend la même vitesse. Sur un format de dix heures à plat, cette plage est
 * exactement celle où l'athlète finit : la trajectoire s'y aplatirait, et la
 * fatigue cesserait d'y coûter quoi que ce soit.
 *
 * Le terrain, lui, se résout une fois par itération, à l'allure moyenne de
 * l'ambition : la boucle est la même à chaque tour, son surcoût aussi.
 */
function project(input: LapPredictionInput): LapTrajectory {
  const { model, course } = input;
  const lap = course.lap!;
  const target = Math.max(1, Math.round(input.targetLaps));
  const { gain, loss } = lapVert(lap);

  const segments = buildCourseSegments(
    {
      ...course,
      distanceM: lap.lengthM,
      elevationGainM: gain,
      elevationLossM: loss,
    },
    Math.max(200, lap.lengthM / 12),
  );
  const avgAltitude =
    segments.reduce((a, s) => a + s.altitudeM * s.lengthM, 0) / Math.max(1, lap.lengthM);

  const freshness = clamp(1 + (input.raceDayTsb ?? 0) * 0.0008, 0.955, 1.028);
  const durabilityTerms = {
    pctPerHour: model.durabilityPctPerHour,
    pctPer1000mVert: model.durabilityPctPer1000mVert,
    vertRateMh: model.durabilityVertRateMh ?? 0,
  };

  // Décroissance absolue de la durabilité au milieu de la boucle n, à temps
  // couru `runningBefore`. C'est elle qui donne la pente de la trajectoire.
  const decayAt = (runningBefore: number, lapTime: number, lapsDone: number): number =>
    durabilityFactor(runningBefore + lapTime / 2, lapsDone * gain + gain / 2, durabilityTerms);

  const decayTrajectory = (times: readonly number[]): number[] => {
    const out: number[] = [];
    let running = 0;
    for (let n = 0; n < times.length; n++) {
      const t = times[n] as number;
      out.push(decayAt(running, t, n));
      running += t;
    }
    return out;
  };

  // Amorçage : une allure plausible, corrigée par itérations.
  const horizon = horizonLaps(lap.intervalS);
  let lapTimes = Array.from({ length: horizon }, () => lap.lengthM / (model.criticalSpeedMs * 0.7));
  let env = { total: 1, heat: 1, altitude: 1 };
  let levelFraction = 1;
  let durabilityAtTarget = 1;

  for (let iter = 0; iter < 20; iter++) {
    const runningToTarget = lapTimes.slice(0, target).reduce((a, t) => a + t, 0);
    const hours = runningToTarget / 3600;

    // Niveau : la composition de `predictRace`, sur le temps réellement couru.
    const f = fractionalUtilization(runningToTarget);
    const relative =
      ((REFERENCE_DURABILITY_PCT_PER_HOUR - model.durabilityPctPerHour) / 100) * hours * 0.45;
    const verticalLoss =
      gain > 0
        ? (model.durabilityPctPer1000mVert / 100) *
          (Math.max(0, gain * target - ((model.durabilityVertRateMh ?? 0) * runningToTarget) / 3600) /
            1000) *
          0.25
        : 0;
    const durabilityCorrection = clamp(1 + relative - verticalLoss, 0.72, 1.12);
    env = environmentalFactor({
      tempC: course.expectedTempC ?? null,
      altitudeM: avgAltitude,
      durationS: runningToTarget,
      vo2maxRel: model.vo2maxRel,
      hotSessionsLast14Days: input.hotSessionsLast14Days ?? 0,
    });
    // La nuit se rapporte au temps de course, cloche comprise : c'est l'horloge
    // qui fait la nuit, pas le temps passé à courir.
    const night = nightFactor(course.nightHours ?? 0, (target * lap.intervalS) / 3600);

    levelFraction = f * durabilityCorrection;
    const meanFlatSpeed = model.criticalSpeedMs * levelFraction * env.total * freshness * night;

    // Boucle de référence : le terrain, la technicité et le plafond de descente,
    // résolus à l'allure moyenne de l'ambition.
    const reference = solveSegmentTimes(segments, FLAT_RUNNING_COST * meanFlatSpeed, {
      technicality: course.technicality,
      descentSkill: model.descentSkill,
    }).elapsedS;

    // Forme : décroissance mesurée, normalisée à moyenne 1 sur l'ambition.
    const decays = decayTrajectory(lapTimes);
    const meanDecay = decays.slice(0, target).reduce((a, d) => a + d, 0) / target;
    durabilityAtTarget = decays[target - 1] as number;

    const next = decays.map((d) => reference / Math.max(0.2, meanDecay > 0 ? d / meanDecay : 1));

    const before = lapTimes.slice(0, target).reduce((a, t) => a + t, 0);
    const after = next.slice(0, target).reduce((a, t) => a + t, 0);
    // Sous-relaxation : la boucle niveau ↔ forme oscille sans elle.
    lapTimes = lapTimes.map((t, i) => t * 0.35 + (next[i] as number) * 0.65);
    if (Math.abs(after - before) / Math.max(1, before) < 0.002) break;
  }

  // Horizon. Une décroissance qui touche sa borne de sécurité cesse d'être une
  // mesure : on arrête la projection là plutôt que de prolonger une droite
  // devenue plate, et on dit pourquoi.
  const decays = decayTrajectory(lapTimes);
  let clampLap: number | null = null;
  for (let n = 0; n < horizon; n++) {
    if ((decays[n] as number) <= DURABILITY_FLOOR + 1e-9) {
      clampLap = n + 1;
      break;
    }
  }

  const limit = clampLap != null ? clampLap - 1 : horizon;
  let cutoffLap: number | null = null;
  for (let n = 0; n < limit; n++) {
    if ((lapTimes[n] as number) >= lap.intervalS) {
      cutoffLap = n + 1;
      break;
    }
  }

  const horizonReason: LapRacePrediction['horizonReason'] =
    cutoffLap != null ? 'cutoff' : clampLap != null ? 'durability-clamp' : 'horizon';

  return {
    lapTimes,
    fractions: lapTimes.map((t) => lap.lengthM / t / model.criticalSpeedMs),
    runningToTarget: lapTimes.slice(0, target).reduce((a, t) => a + t, 0),
    sustainableLaps: cutoffLap != null ? cutoffLap - 1 : limit,
    cutoffLap,
    horizonReason,
    levelFraction,
    durabilityAtTarget,
    env,
    freshness,
  };
}

/**
 * Prédit un format à boucle répétée.
 *
 * Lance une erreur sur un parcours sans `lap` : la question posée n'a alors pas
 * de sens, et répondre quand même produirait un plan d'allure faux de bout en
 * bout.
 */
export function predictLapRace(input: LapPredictionInput): LapRacePrediction {
  const { model, course } = input;
  if (!course.lap || course.lap.lengthM <= 0 || course.lap.intervalS <= 0) {
    throw new Error("Ce parcours ne décrit pas une boucle répétée : `lap` est requis.");
  }
  const lap = course.lap;
  const target = Math.max(1, Math.round(input.targetLaps));
  const traj = project(input);

  const laps: LapProjection[] = [];
  // Jusqu'à la cloche manquée, qui est une réponse — mais jamais au-delà de ce
  // que la projection vouche : une boucle calculée sur une décroissance arrivée
  // à sa borne n'est pas une prédiction, et l'afficher la ferait passer pour
  // telle.
  const shown =
    traj.cutoffLap != null ? Math.max(target, traj.cutoffLap) : traj.sustainableLaps;
  for (let n = 0; n < Math.min(shown, traj.lapTimes.length); n++) {
    const lapTimeS = traj.lapTimes[n] as number;
    const progress = (n + 1) / Math.max(1, target);
    // La FC monte à effort constant : c'est la dérive cardiaque, pas une
    // autorisation d'accélérer. Le plafond reste sous SV1 jusqu'aux dernières
    // boucles de l'ambition.
    const spread = model.vt2.hr - model.vt1.hr;
    const hrCeil = Math.round(model.vt1.hr + spread * clamp(-0.12 + progress * 0.14, -0.12, 0.06));
    laps.push({
      index: n + 1,
      bellS: n * lap.intervalS,
      lapTimeS: Math.round(lapTimeS),
      restS: Math.round(lap.intervalS - lapTimeS),
      speedMs: Math.round((lap.lengthM / lapTimeS) * 1000) / 1000,
      fractionOfCs: Math.round((traj.fractions[n] as number) * 1000) / 1000,
      targetHrRange: [hrCeil - 12, hrCeil],
      cue: lapCue(n + 1, target, lap.intervalS - lapTimeS, traj.cutoffLap),
    });
  }

  const totalRestS = laps
    .slice(0, target)
    .reduce((a, l) => a + Math.max(0, l.restS), 0);
  const raceClockS = target * lap.intervalS;
  const fuel = fuelingTargets(traj.runningToTarget, traj.levelFraction * 0.9, course.expectedTempC ?? null);

  // Dispersion : celle de `predictRace`, sur le temps couru, élargie par ce que
  // le parcours ne dit pas — un dénivelé inconnu est une incertitude réelle.
  const confidence = model.confidence;
  const unknownCount = course.unknowns?.length ?? 0;
  const sigma =
    (0.045 + (course.technicality - 1) * 0.008 + Math.min(0.03, traj.runningToTarget / 3600 / 400)) *
      (1 + (1 - confidence) * 0.9) +
    unknownCount * 0.02;
  const lapAtTarget = traj.lapTimes[target - 1] as number;
  const targetProbability =
    target > traj.sustainableLaps && traj.horizonReason !== 'cutoff'
      ? null
      : Math.round(normalCdf(Math.log(lap.intervalS / lapAtTarget) / sigma) * 1000) / 10;

  return {
    raceId: '',
    computedAt: new Date().toISOString(),
    lap,
    targetLaps: target,
    laps,
    sustainableLaps: traj.sustainableLaps,
    cutoffLap: traj.cutoffLap,
    horizonReason: traj.horizonReason,
    targetProbability,
    totalRestS,
    runningTimeS: Math.round(traj.runningToTarget),
    distanceM: lap.lengthM * target,
    factors: {
      terrain: Math.round(technicalityFactor(course.technicality, 0) * 1000) / 1000,
      heat: Math.round((1 / traj.env.heat) * 1000) / 1000,
      altitude: traj.env.altitude,
      durability: Math.round(traj.durabilityAtTarget * 1000) / 1000,
      freshness: Math.round(traj.freshness * 1000) / 1000,
    },
    fueling: {
      carbGPerHour: fuel.carbGPerHour,
      fluidMlPerHour: fuel.fluidMlPerHour,
      sodiumMgPerHour: fuel.sodiumMgPerHour,
      // Sur la durée de course, cloche comprise : le repos entre deux boucles
      // est exactement le moment où l'on mange. C'est l'avantage du format.
      totalCarbG: Math.round((fuel.carbGPerHour * raceClockS) / 3600),
    },
    limiters: input.skipCounterfactuals ? [] : computeLapLimiters(input, traj),
    unknowns: input.skipCounterfactuals ? [] : describeUnknowns(input, traj),
  };
}

function lapCue(index: number, target: number, restS: number, cutoffLap: number | null): string {
  if (index === 1)
    return "Première boucle : la seule erreur possible ici est d'aller vite. Le repos gagné à la cloche 1 ne se garde pas, la fatigue qui le paie se garde jusqu'au bout.";
  if (restS < 0) return 'La boucle déborde : la cloche part sans toi. C\'est ici que la course se termine.';
  if (restS < 180)
    return 'Moins de trois minutes de repos : plus de marge pour manger ni pour un pépin. Boucle décisive.';
  if (restS < 480)
    return "Le repos se réduit : assieds-toi, mange sur la boucle plutôt qu'à la cloche.";
  if (cutoffLap != null && index >= cutoffLap - 3)
    return 'Zone où le temps de boucle rejoint la cloche. Toute minute prise au repos est prise à la boucle suivante.';
  if (index === target) return "Boucle d'ambition. Ce qui suit se décide ici, avec des jambes, pas avec un plan.";
  return 'Régime de croisière : même effort, même ravitaillement, boucle après boucle.';
}

/**
 * Facteurs limitants, **dans l'ordre où ils arrivent**.
 *
 * Même méthode que sur une course classique — on rejoue la projection avec un
 * paramètre amélioré et on mesure l'écart — mais la sortie change d'unité :
 * sur dix heures, ce qui compte n'est pas un gain en secondes mais la boucle
 * où le facteur commence à peser et le nombre de boucles qu'il coûte.
 */
function computeLapLimiters(input: LapPredictionInput, base: LapTrajectory): LapLimiter[] {
  const { model, course } = input;
  const target = Math.max(1, Math.round(input.targetLaps));
  const variants: { factor: string; alter: () => LapPredictionInput; explanation: string }[] = [
    {
      factor: 'Vitesse critique (+3 %)',
      alter: () => ({ ...input, model: { ...model, criticalSpeedMs: model.criticalSpeedMs * 1.03 } }),
      explanation: 'Gain obtenu en repoussant le seuil : fractionné au seuil et tempo prolongé.',
    },
    {
      factor: 'Durabilité (niveau élite)',
      alter: () => ({
        ...input,
        model: { ...model, durabilityPctPerHour: 1.5, durabilityPctPer1000mVert: 2.0 },
      }),
      explanation:
        "Le facteur propre au format : à effort constant, c'est la perte horaire qui allonge la boucle. Volume aérobie, sorties longues, et surtout des efforts de la durée du format.",
    },
    {
      factor: 'Fraîcheur optimale au départ',
      alter: () => ({ ...input, raceDayTsb: 15 }),
      explanation: "Gain obtenu par un affûtage bien conduit — le levier le moins coûteux.",
    },
  ];

  if ((course.expectedTempC ?? 0) > 15) {
    variants.push({
      factor: 'Chaleur',
      alter: () => ({ ...input, course: { ...course, expectedTempC: 12 } }),
      explanation:
        "Ce que coûte la température attendue, comparée à des conditions neutres. S'acclimater est la seule réponse qui se prépare.",
    });
  }
  if ((course.nightHours ?? 0) > 0) {
    variants.push({
      factor: 'Heures de nuit',
      alter: () => ({ ...input, course: { ...course, nightHours: 0 } }),
      explanation: 'Fatigue visuelle, prudence, rythme circadien. Se prépare en courant de nuit.',
    });
  }
  if ((course.lap?.elevationGainM ?? 0) > 0) {
    variants.push({
      factor: 'Dénivelé de la boucle',
      alter: () => ({
        ...input,
        course: { ...course, lap: { ...course.lap!, elevationGainM: 0, elevationLossM: 0 } },
      }),
      explanation:
        "Ce que le relief de la boucle coûte, répété à chaque tour. Il ne se change pas — il se prépare, en côte et en descente.",
    });
  }

  const out: LapLimiter[] = [];
  for (const v of variants) {
    const altered = project({ ...v.alter(), skipCounterfactuals: true });
    let fromLap = 0;
    for (let n = 0; n < base.lapTimes.length; n++) {
      if ((base.lapTimes[n] as number) - (altered.lapTimes[n] as number) > 60) {
        fromLap = n + 1;
        break;
      }
    }
    const costAtTargetS = Math.round(
      (base.lapTimes[target - 1] as number) - (altered.lapTimes[target - 1] as number),
    );
    // Un contrefactuel qui ne rencontre plus de cloche manquée ne dit plus
    // combien de boucles il fait gagner : il dit où s'arrête la projection.
    const lapsGained =
      altered.horizonReason === 'cutoff' ? altered.sustainableLaps - base.sustainableLaps : null;
    // Un facteur qui ne pèse ni une demi-minute sur la boucle visée ni une
    // boucle sur la projection n'est pas un facteur limitant : l'énumérer
    // noierait les deux qui décident.
    if (costAtTargetS <= 30 && (lapsGained ?? 1) <= 0) continue;
    out.push({
      factor: v.factor,
      fromLap: fromLap || target,
      costAtTargetS,
      lapsGained,
      explanation: v.explanation,
    });
  }
  // Dans l'ordre où ils arrivent ; à égalité, le plus cher d'abord.
  return out.sort((a, b) => a.fromLap - b.fromLap || b.costAtTargetS - a.costAtTargetS);
}

/**
 * Ce que la prédiction ne sait pas, chiffré.
 *
 * Un trou nommé sans son prix ne sert à rien : « le dénivelé est inconnu » ne
 * dit pas s'il faut aller le chercher. Chaque entrée porte donc ce que l'écart
 * coûterait, mesuré par le même contrefactuel que les facteurs limitants.
 */
function describeUnknowns(
  input: LapPredictionInput,
  base: LapTrajectory,
): LapRacePrediction['unknowns'] {
  const { course } = input;
  const target = Math.max(1, Math.round(input.targetLaps));
  const out: LapRacePrediction['unknowns'] = [];
  const unknowns = course.unknowns ?? [];

  if (unknowns.includes('elevation') || course.lap?.elevationGainM == null) {
    const probe = project({
      ...input,
      course: { ...course, lap: { ...course.lap!, elevationGainM: 100, elevationLossM: 100 } },
      skipCounterfactuals: true,
    });
    const delta = Math.round(
      (probe.lapTimes[target - 1] as number) - (base.lapTimes[target - 1] as number),
    );
    out.push({
      field: 'Dénivelé de la boucle',
      assumed: 'boucle plate — 0 m D+, faute de tracé identifié',
      sensitivity:
        `100 m D+ par boucle allongeraient la boucle ${target} de ${Math.round(delta)} s ` +
        `et ramèneraient la projection de ${base.sustainableLaps} à ${probe.sustainableLaps} boucles tenables. ` +
        `Tant que le tracé n'est pas relevé, tout ce qui suit vaut pour une boucle plate.`,
    });
  }

  if (unknowns.includes('technicality')) {
    const probe = project({
      ...input,
      course: { ...course, technicality: 4 },
      skipCounterfactuals: true,
    });
    const delta = Math.round(
      (probe.lapTimes[target - 1] as number) - (base.lapTimes[target - 1] as number),
    );
    out.push({
      field: 'Technicité du terrain',
      assumed: `technicité ${course.technicality} par défaut, l'épreuve n'étant pas identifiée`,
      sensitivity:
        `Une technicité de 4 allongerait la boucle ${target} de ${delta} s et ramènerait la ` +
        `projection de ${base.sustainableLaps} à ${probe.sustainableLaps} boucles tenables.`,
    });
  }

  // Une course qui dure dix heures traverse forcément une partie de la journée
  // où l'on ne voit plus. Ne rien dire ferait passer « zéro heure de nuit »
  // pour une donnée.
  const clockHours = (target * (course.lap?.intervalS ?? 3600)) / 3600;
  if (course.nightHours == null && clockHours >= 6) {
    const probe = project({
      ...input,
      course: { ...course, nightHours: 4 },
      skipCounterfactuals: true,
    });
    const delta = Math.round(
      (probe.lapTimes[target - 1] as number) - (base.lapTimes[target - 1] as number),
    );
    const cost = base.sustainableLaps - probe.sustainableLaps;
    out.push({
      field: 'Heures de nuit',
      assumed: "aucune, faute d'heure de départ connue",
      sensitivity:
        `Quatre heures de nuit sur ${Math.round(clockHours)} h allongeraient la boucle ${target} ` +
        `de ${delta} s et coûteraient ${cost === 1 ? 'une boucle tenable' : `${cost} boucles tenables`}.`,
    });
  }

  return out;
}

function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const d = 0.3989423 * Math.exp((-z * z) / 2);
  const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274))));
  return z > 0 ? 1 - p : p;
}
