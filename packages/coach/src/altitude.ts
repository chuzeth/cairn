import { climbAndDrop, haversineM, type LightTrace } from './terrain.js';

/**
 * L'altitude d'un point, lue sur les traces de l'athlète.
 *
 * Le moteur d'itinéraire ne dit rien du relief. Les traces de l'athlète, si :
 * là où il est passé, son altimètre a mesuré l'altitude. D'une sortie à l'autre,
 * un altimètre barométrique se décale de quelques mètres — jusqu'à dix entre
 * deux passages au même carrefour —, si bien qu'on ne lit jamais une trace
 * seule : en chaque point, l'altitude est la médiane des sorties qui y sont
 * passées, chacune par son point le plus proche. Rien ne part vers un service
 * d'altitude, et le domicile ne quitte pas la base.
 *
 * Pur : des traces entrent, des altitudes sortent.
 */

/** Une sortie passe par un point quand elle en approche à 20 m. */
const REACH_M = 20;
/** Maille de l'index, degrés : un peu plus que la portée, en latitude comme en longitude à Lyon. */
const CELL_DEG = 0.0003;
/** Pas du profil d'un tracé, m. */
const PROFILE_STEP_M = 20;
/** Un trou plus court se comble entre ses bords ; plus long, son relief n'est pas connu, m. */
const GAP_M = 150;

export interface AltitudeIndex {
  /** L'altitude en un point, ou `null` quand aucune sortie n'y est passée. */
  at(p: readonly [number, number]): number | null;
}

/** L'index des altitudes de ces traces. */
export function altitudeIndex(traces: readonly LightTrace[]): AltitudeIndex {
  const cells = new Map<string, { a: number; z: number; at: [number, number] }[]>();
  const key = (lat: number, lng: number) => `${Math.floor(lat / CELL_DEG)}:${Math.floor(lng / CELL_DEG)}`;
  traces.forEach((t, a) => {
    for (let k = 0; k < t.at.length; k++) {
      const p = t.at[k]!;
      const c = key(p[0], p[1]);
      let list = cells.get(c);
      if (!list) cells.set(c, (list = []));
      list.push({ a, z: t.z[k]!, at: p });
    }
  });
  return {
    at(p) {
      const i = Math.floor(p[0] / CELL_DEG);
      const j = Math.floor(p[1] / CELL_DEG);
      const nearest = new Map<number, { d: number; z: number }>();
      for (let di = -1; di <= 1; di++) {
        for (let dj = -1; dj <= 1; dj++) {
          for (const s of cells.get(`${i + di}:${j + dj}`) ?? []) {
            const d = haversineM(p, s.at);
            if (d > REACH_M) continue;
            const seen = nearest.get(s.a);
            if (!seen || d < seen.d) nearest.set(s.a, { d, z: s.z });
          }
        }
      }
      if (nearest.size === 0) return null;
      const zs = [...nearest.values()].map((v) => v.z).sort((x, y) => x - y);
      const mid = zs.length >> 1;
      return zs.length % 2 ? zs[mid]! : (zs[mid - 1]! + zs[mid]!) / 2;
    },
  };
}

/** Un point d'un tracé rééchantillonné : distance depuis le départ, position, altitude. */
export interface ProfileSample {
  d: number;
  at: [number, number];
  z: number | null;
}

/** Un tracé rééchantillonné tous les `step` mètres, bouts compris. */
export function resample(track: readonly (readonly [number, number])[], step = PROFILE_STEP_M): { d: number; at: [number, number] }[] {
  if (track.length === 0) return [];
  const out: { d: number; at: [number, number] }[] = [{ d: 0, at: [track[0]![0], track[0]![1]] }];
  let acc = 0;
  let next = step;
  for (let k = 1; k < track.length; k++) {
    const a = track[k - 1]!;
    const b = track[k]!;
    const len = haversineM(a, b);
    while (len > 0 && acc + len >= next) {
      const f = (next - acc) / len;
      out.push({ d: next, at: [a[0] + f * (b[0] - a[0]), a[1] + f * (b[1] - a[1])] });
      next += step;
    }
    acc += len;
  }
  const last = track[track.length - 1]!;
  if (acc - out[out.length - 1]!.d > 1) out.push({ d: acc, at: [last[0], last[1]] });
  return out;
}

/**
 * Le profil d'un tracé : son altitude tous les 20 m, un trou de moins de 150 m
 * comblé entre ses bords. Ce qui reste sans altitude est rendu comme tel.
 */
export function profileAlong(track: readonly (readonly [number, number])[], index: AltitudeIndex): ProfileSample[] {
  const pts: ProfileSample[] = resample(track).map((p) => ({ ...p, z: index.at(p.at) }));
  let k = 0;
  while (k < pts.length) {
    if (pts[k]!.z != null) {
      k++;
      continue;
    }
    let e = k;
    while (e < pts.length && pts[e]!.z == null) e++;
    const before = pts[k - 1];
    const after = pts[e];
    if (before?.z != null && after?.z != null && after.d - before.d <= GAP_M) {
      for (let m = k; m < e; m++) {
        const f = (pts[m]!.d - before.d) / (after.d - before.d);
        pts[m]!.z = before.z + f * (after.z - before.z);
      }
    }
    k = e;
  }
  return pts;
}

/**
 * Un profil lissé sur 100 m. D'un point au suivant, ce ne sont pas les mêmes
 * sorties qui répondent, ni les mêmes décalages d'altimètre : sans lissage, un
 * quai plat monte de 19 m en 2 km.
 */
export function smoothed(profile: readonly ProfileSample[]): (number | null)[] {
  return profile.map((p, k) => {
    if (p.z == null) return null;
    const near = profile.slice(Math.max(0, k - 2), k + 3).flatMap((q) => (q.z == null ? [] : [q.z]));
    return near.reduce((s, v) => s + v, 0) / near.length;
  });
}

/** Sous ce seuil, une variation d'altitude lissée est du bruit, m. */
const RELIEF_THRESHOLD_M = 3;

/** Ce qu'un profil monte et descend, et la longueur dont l'altitude n'est pas connue. */
export function reliefOf(profile: readonly ProfileSample[]): { gainM: number; lossM: number; unmeasuredM: number } {
  let unmeasuredM = 0;
  for (let k = 1; k < profile.length; k++) {
    if (profile[k]!.z == null || profile[k - 1]!.z == null) unmeasuredM += profile[k]!.d - profile[k - 1]!.d;
  }
  const z = smoothed(profile).flatMap((v) => (v == null ? [] : [v]));
  return { ...climbAndDrop(z, RELIEF_THRESHOLD_M), unmeasuredM: Math.round(unmeasuredM) };
}
