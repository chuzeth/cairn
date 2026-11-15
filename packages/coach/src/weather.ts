import type { Activity, ActivityStreams } from '@cairn/core';
import * as db from '@cairn/db';
import { USER_AGENT } from './geo.js';

/**
 * La température de l'air pendant une sortie.
 *
 * La chaleur fait monter le cœur à allure égale de plusieurs battements : une
 * FC haute un jour de 28 °C n'est pas une fatigue. Le thermomètre de la montre
 * ne la donne pas — au poignet, il lit la peau, jusqu'à 12 °C au-dessus de
 * l'air —, et la Venu 2 ne l'enregistre même pas dans ses flux. Elle vient
 * donc d'une archive météo : Open-Meteo, gratuit et sans clé, à l'heure.
 *
 * Ce qui part : un point arrondi au dixième de degré — une dizaine de
 * kilomètres, la ville, jamais une rue ni le domicile — et une date. La
 * réponse est gardée pour toujours, par sortie (`geo_cache`) : une sortie
 * passée ne change pas de météo.
 */

const KEY = (activityId: string) => `air-temp:v1:${activityId}`;
const DAY_MS = 86_400_000;

export interface AirTemperature {
  /** Température moyenne de l'air sur la sortie, °C ; `null` si l'archive n'en a pas. */
  tempC: number | null;
  /** Le point interrogé, arrondi au dixième de degré. */
  at: [number, number];
  source: 'open-meteo';
}

/** Le premier point du tracé, arrondi au dixième : la ville, pas la rue. */
export function coarseStart(streams: Pick<ActivityStreams, 'latlng'>): [number, number] | null {
  const p = streams.latlng?.find((x): x is [number, number] => x != null && Number.isFinite(x[0]) && Number.isFinite(x[1]));
  return p ? [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10] : null;
}

/** La moyenne des températures horaires couvertes par la sortie, de son départ à son arrivée (UTC). */
export function meanOver(
  hourly: { time: string[]; temperature_2m: (number | null)[] },
  startUtc: string,
  durationS: number,
): number | null {
  const from = Date.parse(startUtc);
  const to = from + Math.max(durationS, 1800) * 1000;
  const values: number[] = [];
  hourly.time.forEach((t, i) => {
    const at = Date.parse(`${t}:00Z`);
    const v = hourly.temperature_2m[i];
    // L'heure qui contient le départ compte, et chaque heure entamée ensuite.
    if (v != null && at + 3_600_000 > from && at <= to) values.push(v);
  });
  return values.length ? Math.round((values.reduce((s, v) => s + v, 0) / values.length) * 10) / 10 : null;
}

/** Ce que l'archive dit d'un jour en un point, en heures UTC. */
async function hourlyOn(at: [number, number], date: string, today: string): Promise<{ time: string[]; temperature_2m: (number | null)[] }> {
  // L'archive a quelques jours de retard ; la prévision garde les trois derniers mois.
  const recent = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${date}T00:00:00Z`) < 60 * DAY_MS;
  const base = recent ? 'https://api.open-meteo.com/v1/forecast' : 'https://archive-api.open-meteo.com/v1/archive';
  const url =
    `${base}?latitude=${at[0]}&longitude=${at[1]}&start_date=${date}&end_date=${date}` +
    `&hourly=temperature_2m&timezone=GMT`;
  const res = await fetch(url, { headers: { 'User-Agent': USER_AGENT }, signal: AbortSignal.timeout(15_000) });
  if (!res.ok) throw new Error(`Open-Meteo : ${res.status}`);
  const body = (await res.json()) as { hourly?: { time: string[]; temperature_2m: (number | null)[] } };
  if (!body.hourly) throw new Error('Open-Meteo : réponse sans relevé horaire');
  return body.hourly;
}

/**
 * La température de l'air d'une sortie : gardée si déjà connue, sinon demandée
 * à l'archive puis gardée. `null` sans tracé GPS, ou si l'archive ne répond
 * pas — la sortie se lit alors sans, et le compte rendu le dit.
 */
export async function airTemperatureOf(
  activity: Pick<Activity, 'id' | 'startDate' | 'movingTimeS' | 'elapsedTimeS'>,
  streams: Pick<ActivityStreams, 'latlng'> | null,
  today = new Date().toISOString().slice(0, 10),
): Promise<AirTemperature | null> {
  const kept = await db.getGeo<AirTemperature>(KEY(activity.id));
  if (kept) return kept.value;
  if (!streams) return null;
  const at = coarseStart(streams);
  if (!at) return null;
  const date = activity.startDate.slice(0, 10);
  try {
    const hourly = await hourlyOn(at, date, today);
    const value: AirTemperature = {
      tempC: meanOver(hourly, activity.startDate, activity.elapsedTimeS || activity.movingTimeS),
      at,
      source: 'open-meteo',
    };
    // Une sortie du jour peut tomber sur des heures pas encore relevées : on ne la garde qu'entière.
    if (value.tempC != null || date < today) await db.putGeo(KEY(activity.id), value);
    return value;
  } catch {
    return null;
  }
}

/** Les températures déjà connues, par sortie : ce que le compte rendu lit, sans rien demander. */
export async function knownAirTemperatures(activityIds: readonly string[]): Promise<Map<string, number>> {
  const out = new Map<string, number>();
  for (const id of activityIds) {
    const kept = await db.getGeo<AirTemperature>(KEY(id));
    if (kept?.value.tempC != null) out.set(id, kept.value.tempC);
  }
  return out;
}
