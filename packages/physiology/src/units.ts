/** Conversions et formatage. Une seule source de vérité pour éviter les dérives. */

export const KMH_PER_MS = 3.6;
export const G = 9.80665;

export const kmhToMs = (kmh: number): number => kmh / KMH_PER_MS;
export const msToKmh = (ms: number): number => ms * KMH_PER_MS;

/** Allure en secondes par kilomètre. Renvoie Infinity à vitesse nulle. */
export const msToSecPerKm = (ms: number): number => (ms > 0 ? 1000 / ms : Infinity);
export const secPerKmToMs = (s: number): number => (s > 0 ? 1000 / s : 0);

/** Formate une vitesse en allure « m:ss/km ». */
export function formatPace(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return '—';
  const secPerKm = 1000 / ms;
  if (secPerKm > 3600) return '—';
  const m = Math.floor(secPerKm / 60);
  const s = Math.round(secPerKm % 60);
  return s === 60 ? `${m + 1}:00` : `${m}:${String(s).padStart(2, '0')}`;
}

/** Formate une durée en « 1h23'45" » / « 23'45" » / « 45" ». */
export function formatDuration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}'${String(sec).padStart(2, '0')}"`;
  if (m > 0) return `${m}'${String(sec).padStart(2, '0')}"`;
  return `${sec}"`;
}

/** Formate une durée courte « h:mm:ss ». */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.round(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0
    ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
    : `${m}:${String(sec).padStart(2, '0')}`;
}

export const clamp = (v: number, lo: number, hi: number): number => Math.min(hi, Math.max(lo, v));

/** Interpolation linéaire bornée. */
export const lerp = (a: number, b: number, t: number): number => a + (b - a) * clamp(t, 0, 1);

/** Moyenne robuste ignorant null/NaN. Renvoie null si aucun échantillon valide. */
export function mean(values: readonly (number | null | undefined)[]): number | null {
  let sum = 0;
  let n = 0;
  for (const v of values) {
    if (v == null || !Number.isFinite(v)) continue;
    sum += v;
    n++;
  }
  return n === 0 ? null : sum / n;
}

/** Écart-type d'échantillon (n−1). */
export function stdev(values: readonly number[]): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length < 2) return 0;
  const m = finite.reduce((a, b) => a + b, 0) / finite.length;
  const varr = finite.reduce((a, b) => a + (b - m) ** 2, 0) / (finite.length - 1);
  return Math.sqrt(varr);
}

/** Quantile par interpolation linéaire (q ∈ [0,1]) sur un tableau non trié. */
export function quantile(values: readonly number[], q: number): number {
  const s = values.filter((v) => Number.isFinite(v)).slice().sort((a, b) => a - b);
  if (s.length === 0) return NaN;
  const pos = clamp(q, 0, 1) * (s.length - 1);
  const lo = Math.floor(pos);
  const hi = Math.ceil(pos);
  const a = s[lo] as number;
  const b = s[hi] as number;
  return lo === hi ? a : a + (b - a) * (pos - lo);
}

/** Moyenne glissante centrée, fenêtre en échantillons (impaire recommandée). */
export function movingAverage(values: readonly number[], window: number): number[] {
  if (window <= 1) return values.slice();
  const half = Math.floor(window / 2);
  const out = new Array<number>(values.length);
  let sum = 0;
  let count = 0;
  // Fenêtre glissante O(n) avec bornes tronquées aux extrémités.
  const queue: number[] = [];
  for (let i = 0; i < values.length + half; i++) {
    if (i < values.length) {
      const v = values[i] as number;
      if (Number.isFinite(v)) { sum += v; count++; queue.push(v); } else { queue.push(NaN); }
    } else {
      queue.push(NaN);
    }
    if (queue.length > window) {
      const old = queue.shift() as number;
      if (Number.isFinite(old)) { sum -= old; count--; }
    }
    const target = i - half;
    if (target >= 0 && target < values.length) {
      out[target] = count > 0 ? sum / count : (values[target] as number);
    }
  }
  return out;
}

/** Moyenne d'ordre p (« norme de puissance ») — p=4 pour la vitesse normalisée. */
export function powerMean(values: readonly number[], p: number): number {
  const finite = values.filter((v) => Number.isFinite(v) && v >= 0);
  if (finite.length === 0) return 0;
  const s = finite.reduce((a, b) => a + b ** p, 0) / finite.length;
  return s ** (1 / p);
}
