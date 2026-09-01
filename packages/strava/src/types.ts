/** Sous-ensemble des réponses de l'API Strava effectivement exploité. */

export interface StravaTokenResponse {
  token_type: string;
  access_token: string;
  refresh_token: string;
  expires_at: number;
  expires_in: number;
  scope?: string;
  athlete?: StravaAthlete;
}

export interface StravaAthlete {
  id: number;
  username?: string;
  firstname?: string;
  lastname?: string;
  sex?: 'M' | 'F' | null;
  weight?: number | null;
  city?: string | null;
  country?: string | null;
  ftp?: number | null;
  measurement_preference?: string;
}

export interface StravaSummaryActivity {
  id: number;
  name: string;
  distance: number;
  moving_time: number;
  elapsed_time: number;
  total_elevation_gain: number;
  elev_high?: number | null;
  elev_low?: number | null;
  type: string;
  sport_type: string;
  workout_type?: number | null;
  start_date: string;
  start_date_local: string;
  timezone?: string;
  average_speed: number;
  max_speed?: number;
  average_cadence?: number | null;
  average_heartrate?: number | null;
  max_heartrate?: number | null;
  average_watts?: number | null;
  average_temp?: number | null;
  kilojoules?: number | null;
  calories?: number | null;
  suffer_score?: number | null;
  gear_id?: string | null;
  device_name?: string | null;
  trainer?: boolean;
  commute?: boolean;
  manual?: boolean;
  has_heartrate?: boolean;
  description?: string | null;
  private_note?: string | null;
  splits_metric?: StravaSplit[];
  laps?: StravaLap[];
  best_efforts?: StravaBestEffort[];
  segment_efforts?: unknown[];
}

export interface StravaSplit {
  distance: number;
  elapsed_time: number;
  moving_time: number;
  elevation_difference: number;
  split: number;
  average_speed: number;
  average_heartrate?: number;
  average_grade_adjusted_speed?: number;
}

export interface StravaLap {
  id: number;
  name: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  average_speed: number;
  max_speed?: number;
  average_heartrate?: number;
  max_heartrate?: number;
  average_cadence?: number;
  total_elevation_gain?: number;
  lap_index: number;
  split: number;
}

export interface StravaBestEffort {
  name: string;
  elapsed_time: number;
  moving_time: number;
  distance: number;
  start_index: number;
  end_index: number;
  pr_rank?: number | null;
}

export interface StravaStreamSet {
  time?: { data: number[] };
  distance?: { data: number[] };
  altitude?: { data: number[] };
  velocity_smooth?: { data: number[] };
  heartrate?: { data: number[] };
  cadence?: { data: number[] };
  watts?: { data: number[] };
  temp?: { data: number[] };
  latlng?: { data: [number, number][] };
  moving?: { data: boolean[] };
  grade_smooth?: { data: number[] };
}

export interface StravaGear {
  id: string;
  name: string;
  brand_name?: string;
  model_name?: string;
  distance: number;
  retired?: boolean;
}

export interface StravaWebhookEvent {
  object_type: 'activity' | 'athlete';
  object_id: number;
  aspect_type: 'create' | 'update' | 'delete';
  updates?: Record<string, string>;
  owner_id: number;
  subscription_id: number;
  event_time: number;
}

export interface StravaSubscription {
  id: number;
  callback_url: string;
  created_at: string;
  updated_at: string;
}
