import type { Activity, SportType } from '@cairn/core';
import { elevationChange, normalizeStreams, smoothAltitude, type RawStreams } from '@cairn/physiology';
import type { StravaStreamSet, StravaSummaryActivity } from './types.js';

/** Types de sport Strava reconnus, ramenés au vocabulaire du domaine. */
const SPORT_MAP: Record<string, SportType> = {
  Run: 'Run', TrailRun: 'TrailRun', VirtualRun: 'VirtualRun',
  Ride: 'Ride', VirtualRide: 'VirtualRide', GravelRide: 'Ride', MountainBikeRide: 'Ride',
  Hike: 'Hike', Walk: 'Walk',
  AlpineSki: 'AlpineSki', BackcountrySki: 'BackcountrySki', NordicSki: 'NordicSki',
  Snowshoe: 'Hike', Swim: 'Swim',
  WeightTraining: 'WeightTraining', Workout: 'Workout', Crossfit: 'WeightTraining',
  Elliptical: 'Elliptical', StairStepper: 'Elliptical',
};

export function mapSportType(sportType: string, type?: string): SportType {
  return SPORT_MAP[sportType] ?? SPORT_MAP[type ?? ''] ?? 'Other';
}

/** Le moteur ne s'applique qu'aux disciplines à locomotion terrestre. */
export function isRunLike(sport: SportType): boolean {
  return sport === 'Run' || sport === 'TrailRun' || sport === 'VirtualRun' || sport === 'Hike' || sport === 'Walk';
}

export function mapActivity(
  raw: StravaSummaryActivity,
  athleteId: string,
  elevationLossM?: number,
): Activity {
  return {
    id: `strava-${raw.id}`,
    stravaId: raw.id,
    athleteId,
    name: raw.name,
    description: raw.description ?? raw.private_note ?? undefined,
    sportType: mapSportType(raw.sport_type, raw.type),
    startDate: raw.start_date,
    startDateLocal: raw.start_date_local,
    timezone: raw.timezone,
    distanceM: raw.distance,
    movingTimeS: raw.moving_time,
    elapsedTimeS: raw.elapsed_time,
    totalElevationGainM: raw.total_elevation_gain,
    // Strava ne publie pas le D− : on le calcule depuis le profil altimétrique,
    // avec repli sur le D+ quand les flux ne sont pas disponibles.
    totalElevationLossM: elevationLossM ?? raw.total_elevation_gain,
    elevHighM: raw.elev_high ?? undefined,
    elevLowM: raw.elev_low ?? undefined,
    averageSpeedMs: raw.average_speed,
    maxSpeedMs: raw.max_speed,
    averageHr: raw.average_heartrate ?? undefined,
    maxHr: raw.max_heartrate ?? undefined,
    // Strava exprime la cadence de course en cycles/min : ×2 pour des pas/min.
    averageCadenceSpm: raw.average_cadence != null ? raw.average_cadence * 2 : undefined,
    averageWatts: raw.average_watts ?? undefined,
    averageTempC: raw.average_temp ?? undefined,
    calories: raw.calories ?? undefined,
    sufferScore: raw.suffer_score ?? undefined,
    gearId: raw.gear_id ?? undefined,
    deviceName: raw.device_name ?? undefined,
    trainer: raw.trainer ?? false,
    commute: raw.commute ?? false,
    manual: raw.manual ?? false,
  };
}

/** Convertit les flux Strava en entrée du normaliseur. */
export function toRawStreams(set: StravaStreamSet): RawStreams {
  const out: RawStreams = {};
  if (set.time) out.time = set.time.data;
  if (set.distance) out.distance = set.distance.data;
  if (set.altitude) out.altitude = set.altitude.data;
  if (set.velocity_smooth) out.velocity_smooth = set.velocity_smooth.data;
  if (set.heartrate) out.heartrate = set.heartrate.data;
  if (set.cadence) out.cadence = set.cadence.data;
  if (set.watts) out.watts = set.watts.data;
  if (set.temp) out.temp = set.temp.data;
  if (set.latlng) out.latlng = set.latlng.data;
  if (set.moving) out.moving = set.moving.data;
  if (set.grade_smooth) out.grade_smooth = set.grade_smooth.data;
  return out;
}

/**
 * Pipeline complet : flux Strava → flux normalisés + dénivelés recalculés.
 * Le D+ recalculé depuis un profil lissé diverge parfois de celui de Strava ;
 * on conserve la valeur Strava comme référence affichée et la valeur recalculée
 * pour les calculs, afin que les chiffres montrés restent comparables à l'app.
 */
export function ingestStreams(set: StravaStreamSet) {
  const raw = toRawStreams(set);
  const normalized = normalizeStreams(raw);
  const elevation = set.altitude
    ? elevationChange(smoothAltitude(set.altitude.data))
    : { gainM: 0, lossM: 0 };
  return { ...normalized, elevation };
}
