import type {
  ActivityStreams, EasySpeed, EasyZone, ParameterProvenance, PhysiologyModel, ZoneDefinition,
} from '@cairn/core';
import { cleanHeartRate } from './decoupling.js';
import { movingIndices } from './streams.js';
import { buildZones } from './zones.js';

/**
 * Ce que l'athlète court sous un plafond de FC.
 *
 * Une séance facile se prescrit par un plafond de FC — « sous 141 bpm, quitte
 * à marcher » —, et c'est sur lui qu'elle se juge. Sa charge prévue ne peut
 * donc pas se lire sur la bande de vitesse de sa zone : la Z1 commence à
 * 0 km/h, et son milieu est l'allure de la marche. Le 22/09, un décrassage
 * couru à 9,2 km/h et 133 bpm a coûté 41 points ; il en était prévu 8, et
 * l'app a conclu que ce n'était pas la séance prescrite.
 *
 * Ce module dit si une sortie a tenu un plafond, et à quelle vitesse l'athlète
 * court quand il le tient — lue dans ses sorties récentes, jamais supposée.
 */

/** Secondes de mouvement passées à chaque FC entière, bpm → s. */
export type HrHistogram = Record<string, number>;

/** Part minimale du temps en mouvement couverte par la FC pour juger un plafond. */
const MIN_HR_COVERAGE = 0.7;

/** Histogramme d'une série de FC échantillonnée à 1 Hz. */
export function hrHistogram(hr: readonly (number | null | undefined)[]): HrHistogram {
  const out: HrHistogram = {};
  for (const h of hr) {
    if (h == null || !Number.isFinite(h) || h <= 0) continue;
    const k = String(Math.round(h));
    out[k] = (out[k] ?? 0) + 1;
  }
  return out;
}

/**
 * La FC d'une sortie en mouvement, nettoyée comme l'analyse la nettoie.
 * `null` quand elle couvre trop peu de la sortie pour dire quoi que ce soit
 * d'un plafond : un capteur décroché n'est pas une FC basse.
 */
export function hrHistogramOf(streams: ActivityStreams, hrMax: number): HrHistogram | null {
  if (!streams.heartrate) return null;
  const hr = cleanHeartRate(streams.heartrate, hrMax);
  return movingHrHistogram(movingIndices(streams).map((i) => hr[i]));
}

/** L'histogramme de la FC des échantillons en mouvement, s'ils en portent assez. */
export function movingHrHistogram(hr: readonly (number | null | undefined)[]): HrHistogram | null {
  const hist = hrHistogram(hr);
  return hr.length > 0 && secondsOf(hist) >= MIN_HR_COVERAGE * hr.length ? hist : null;
}

const secondsOf = (hist: HrHistogram): number => Object.values(hist).reduce((a, s) => a + s, 0);

/**
 * Ce que « tenir un plafond » tolère.
 *
 * La FC suit l'effort avec une minute de retard, et une bosse la fait passer
 * au-dessus avant que l'athlète ait pu marcher : un plafond se dépasse un peu,
 * et brièvement, sans cesser d'être tenu. Le 22/09, 14 % du temps au-dessus de
 * 141 bpm et jamais au-delà de 151 — le décrassage a été couru comme prescrit.
 * Au-delà de dix battements, ce n'est plus un retard mais un effort : une
 * sortie qui y passe plus d'un vingtième de son temps court autre chose.
 */
export const HR_CEILING_TOLERANCE = { above: 0.25, farBpm: 10, farAbove: 0.05 } as const;

export interface CeilingCheck {
  ceiling: number;
  /** FC moyenne en mouvement, bpm. */
  meanHr: number;
  /** Part du temps au-dessus du plafond. */
  shareAbove: number;
  /** Part du temps au-delà du plafond de plus de `HR_CEILING_TOLERANCE.farBpm`. */
  shareFarAbove: number;
  respected: boolean;
}

/** Une sortie a-t-elle tenu ce plafond ? `null` sans FC à juger. */
export function checkHrCeiling(hist: HrHistogram, ceiling: number): CeilingCheck | null {
  const total = secondsOf(hist);
  if (total <= 0) return null;
  let above = 0;
  let far = 0;
  let sum = 0;
  for (const [bpm, s] of Object.entries(hist)) {
    const h = Number(bpm);
    sum += h * s;
    if (h > ceiling) above += s;
    if (h > ceiling + HR_CEILING_TOLERANCE.farBpm) far += s;
  }
  const shareAbove = above / total;
  const shareFarAbove = far / total;
  return {
    ceiling,
    meanHr: sum / total,
    shareAbove,
    shareFarAbove,
    respected: shareAbove <= HR_CEILING_TOLERANCE.above && shareFarAbove <= HR_CEILING_TOLERANCE.farAbove,
  };
}

/** Ce qu'une sortie passée dit de l'allure facile. */
export interface EasyRun {
  ageDays: number;
  /** Temps en mouvement, s. */
  durationS: number;
  /** Vitesse graduée normalisée de la sortie, m/s — celle de sa charge réalisée. */
  normalizedGradedSpeedMs: number;
  /** Vitesse au sol en mouvement, m/s. */
  groundSpeedMs: number;
  hr: HrHistogram;
}

/**
 * Fenêtre des sorties qui disent l'allure facile, jours. Assez longue pour
 * compter quelques décrassages — l'athlète en court peu —, assez courte pour
 * suivre sa forme.
 */
export const EASY_SPEED_WINDOW_DAYS = 90;

/** En deçà, une sortie seule ne fait pas une allure : la valeur reste par défaut. */
export const EASY_SPEED_MIN_RUNS = 2;

const EASY_ZONES: readonly EasyZone[] = ['Z1', 'Z2'];

/**
 * L'allure facile de l'athlète, zone par zone, lue dans ses sorties récentes.
 *
 * Une sortie se range dans la zone la plus facile dont elle a tenu le plafond :
 * un décrassage couru à 133 bpm tient aussi le plafond de la Z2, mais il ne dit
 * rien de ce que l'athlète court entre 141 et 155. L'allure d'une zone est la
 * moyenne de ses sorties pondérée par leur durée — en vitesse graduée
 * normalisée pour la charge, au sol pour la distance.
 *
 * Seule une allure mesurée — deux sorties au moins — est rendue. Faute de quoi
 * la zone n'en a pas, et `easySpeedOf` retombe sur la valeur par défaut, lue
 * sur les zones du modèle au moment où on la demande : stockée, elle survivrait
 * aux seuils qui l'ont produite.
 */
export function measureEasySpeeds(
  zones: readonly ZoneDefinition[],
  runs: readonly EasyRun[],
): { speeds: Partial<Record<EasyZone, EasySpeed>>; provenance: Record<EasyZone, ParameterProvenance> } {
  const ceilingOf = (key: EasyZone) => Math.round(zones.find((z) => z.key === key)!.hrMax);
  const recent = runs.filter((r) => r.ageDays <= EASY_SPEED_WINDOW_DAYS && r.durationS > 0);
  const holds = (r: EasyRun, key: EasyZone) => checkHrCeiling(r.hr, ceilingOf(key))?.respected === true;

  const speeds: Partial<Record<EasyZone, EasySpeed>> = {};
  const provenance = { Z1: 'default', Z2: 'default' } as Record<EasyZone, ParameterProvenance>;
  EASY_ZONES.forEach((key, i) => {
    const easier = EASY_ZONES.slice(0, i);
    const held = recent.filter((r) => holds(r, key) && !easier.some((e) => holds(r, e)));
    const seconds = held.reduce((a, r) => a + r.durationS, 0);
    if (held.length < EASY_SPEED_MIN_RUNS || seconds <= 0) return;
    const weighted = (f: (r: EasyRun) => number) => held.reduce((a, r) => a + f(r) * r.durationS, 0) / seconds;
    speeds[key] = {
      hrCeiling: ceilingOf(key),
      speedMs: round3(weighted((r) => r.normalizedGradedSpeedMs)),
      groundSpeedMs: round3(weighted((r) => r.groundSpeedMs)),
      runs: held.length,
    };
    provenance[key] = 'field';
  });
  return { speeds, provenance };
}

function zoneDefault(zones: readonly ZoneDefinition[], key: EasyZone): EasySpeed {
  const z = zones.find((x) => x.key === key)!;
  const v = round3(z.speedMaxMs as number);
  return { hrCeiling: Math.round(z.hrMax), speedMs: v, groundSpeedMs: v, runs: 0 };
}

/**
 * L'allure facile d'une zone, avec sa provenance : mesurée quand le modèle la
 * porte, sinon la vitesse du plafond de la zone — celle que les seuils
 * associent à cette FC —, déclarée par défaut. Un modèle construit avant qu'on
 * la mesure n'en porte aucune.
 */
export function easySpeedOf(
  model: PhysiologyModel,
  zone: EasyZone,
): EasySpeed & { provenance: ParameterProvenance } {
  const measured = model.easySpeeds?.[zone];
  if (measured) return { ...measured, provenance: model.provenance?.[`easySpeeds.${zone}`] ?? 'field' };
  return { ...zoneDefault(buildZones(model), zone), provenance: 'default' };
}

/** Les zones qui se prescrivent par un plafond de FC. */
export const isEasyZone = (zone: string): zone is EasyZone => zone === 'Z1' || zone === 'Z2';

const round3 = (v: number) => Math.round(v * 1000) / 1000;
