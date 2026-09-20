'use client';
import { useMemo, useState } from 'react';
import { frDate, num } from '@/lib/api';

/**
 * Graphiques.
 *
 * Tout est en SVG écrit à la main : aucune bibliothèque de charting. Ce n'est
 * pas de l'ascétisme — les rendus dont on a besoin ici (deux PMC superposés,
 * courbe puissance-durée en échelle logarithmique, profil altimétrique
 * synchronisé) sont plus simples à écrire directement qu'à contraindre dans une
 * API générique, et le résultat pèse zéro kilo-octet de dépendance.
 */

const PAD = { top: 12, right: 46, bottom: 22, left: 40 };

interface Series {
  key: string;
  points: { date: string; value: number }[];
  color: string;
  label: string;
  fill?: boolean;
  dashed?: boolean;
  width?: number;
}

export function TimeSeriesChart({
  series, height = 220, zeroLine = false, formatValue = (v: number) => num(v), yPadding = 0.1,
}: {
  series: Series[]; height?: number; zeroLine?: boolean;
  formatValue?: (v: number) => string; yPadding?: number;
}) {
  const [hover, setHover] = useState<number | null>(null);
  const width = 900;

  const model = useMemo(() => {
    const dates = [...new Set(series.flatMap((s) => s.points.map((p) => p.date)))].sort();
    if (dates.length === 0) return null;
    const index = new Map(dates.map((d, i) => [d, i]));
    const values = series.flatMap((s) => s.points.map((p) => p.value));
    let min = Math.min(...values);
    let max = Math.max(...values);
    if (zeroLine) { min = Math.min(min, 0); max = Math.max(max, 0); }
    const span = max - min || 1;
    min -= span * yPadding;
    max += span * yPadding;

    const x = (d: string) =>
      PAD.left + ((index.get(d) ?? 0) / Math.max(1, dates.length - 1)) * (width - PAD.left - PAD.right);
    const y = (v: number) =>
      PAD.top + (1 - (v - min) / (max - min)) * (height - PAD.top - PAD.bottom);

    return { dates, index, min, max, x, y };
  }, [series, height, zeroLine, yPadding]);

  if (!model) return <div className="empty">Pas encore de données à tracer.</div>;
  const { dates, x, y, min, max } = model;

  const path = (s: Series) =>
    s.points
      .slice()
      .sort((a, b) => a.date.localeCompare(b.date))
      .map((p, i) => `${i === 0 ? 'M' : 'L'}${x(p.date).toFixed(1)} ${y(p.value).toFixed(1)}`)
      .join(' ');

  const areaPath = (s: Series) => {
    const sorted = s.points.slice().sort((a, b) => a.date.localeCompare(b.date));
    if (sorted.length === 0) return '';
    const base = y(zeroLine ? 0 : min);
    return (
      `M${x(sorted[0]!.date).toFixed(1)} ${base.toFixed(1)} ` +
      sorted.map((p) => `L${x(p.date).toFixed(1)} ${y(p.value).toFixed(1)}`).join(' ') +
      ` L${x(sorted[sorted.length - 1]!.date).toFixed(1)} ${base.toFixed(1)} Z`
    );
  };

  const ticks = 4;
  const gridValues = Array.from({ length: ticks + 1 }, (_, i) => min + ((max - min) * i) / ticks);
  const labelEvery = Math.max(1, Math.floor(dates.length / 7));

  const hoverDate = hover != null ? dates[hover] : null;

  return (
    <div style={{ position: 'relative' }}>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', height: 'auto', display: 'block', overflow: 'visible' }}
        onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const rect = e.currentTarget.getBoundingClientRect();
          const px = ((e.clientX - rect.left) / rect.width) * width;
          const t = (px - PAD.left) / (width - PAD.left - PAD.right);
          setHover(Math.max(0, Math.min(dates.length - 1, Math.round(t * (dates.length - 1)))));
        }}
      >
        <defs>
          {series.filter((s) => s.fill).map((s) => (
            <linearGradient key={s.key} id={`grad-${s.key}`} x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={s.color} stopOpacity="0.28" />
              <stop offset="100%" stopColor={s.color} stopOpacity="0.01" />
            </linearGradient>
          ))}
        </defs>

        {gridValues.map((v, i) => (
          <g key={i}>
            <line x1={PAD.left} x2={width - PAD.right} y1={y(v)} y2={y(v)} stroke="var(--border)" strokeWidth="1" />
            <text x={PAD.left - 7} y={y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--text-faint)">
              {formatValue(v)}
            </text>
          </g>
        ))}
        {zeroLine && min < 0 && max > 0 && (
          <line x1={PAD.left} x2={width - PAD.right} y1={y(0)} y2={y(0)} stroke="var(--border-strong)" strokeWidth="1.5" />
        )}

        {series.filter((s) => s.fill).map((s) => (
          <path key={`a-${s.key}`} d={areaPath(s)} fill={`url(#grad-${s.key})`} />
        ))}
        {series.map((s) => (
          <path
            key={s.key} d={path(s)} fill="none" stroke={s.color}
            strokeWidth={s.width ?? 1.8} strokeLinejoin="round" strokeLinecap="round"
            strokeDasharray={s.dashed ? '4 3' : undefined}
          />
        ))}

        {dates.map((d, i) =>
          i % labelEvery === 0 ? (
            <text key={d} x={x(d)} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
              {d.slice(8, 10)}/{d.slice(5, 7)}
            </text>
          ) : null,
        )}

        {hoverDate && (
          <>
            <line x1={x(hoverDate)} x2={x(hoverDate)} y1={PAD.top} y2={height - PAD.bottom} stroke="var(--border-strong)" strokeWidth="1" />
            {series.map((s) => {
              const p = s.points.find((q) => q.date === hoverDate);
              return p ? <circle key={s.key} cx={x(hoverDate)} cy={y(p.value)} r="3.5" fill={s.color} stroke="var(--bg)" strokeWidth="1.5" /> : null;
            })}
          </>
        )}
      </svg>

      <div className="legend" style={{ marginTop: 6, justifyContent: 'space-between' }}>
        <div className="legend" style={{ margin: 0 }}>
          {series.map((s) => (
            <span className="legend-item" key={s.key}>
              <span className="legend-swatch" style={{ background: s.color, opacity: s.dashed ? 0.7 : 1 }} />
              {s.label}
            </span>
          ))}
        </div>
        {hoverDate && (
          <span className="tiny mono muted">
            {frDate(hoverDate, { long: true })} ·{' '}
            {series
              .map((s) => {
                const p = s.points.find((q) => q.date === hoverDate);
                return p ? `${s.label} ${formatValue(p.value)}` : null;
              })
              .filter(Boolean)
              .join('  ·  ')}
          </span>
        )}
      </div>
    </div>
  );
}

/** Histogramme des charges hebdomadaires, avec les deux filières empilées. */
export function WeeklyBars({
  weeks, height = 150,
}: {
  weeks: { weekStart: string; load: number; mechanical: number; vertM: number }[];
  height?: number;
}) {
  if (weeks.length === 0) return <div className="empty">Pas encore de semaines complètes.</div>;
  const width = 900;
  const max = Math.max(...weeks.map((w) => w.load + w.mechanical), 1);
  const bw = (width - PAD.left - PAD.right) / weeks.length;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {[0, 0.5, 1].map((f) => (
          <line key={f} x1={PAD.left} x2={width - PAD.right}
            y1={PAD.top + (1 - f) * (height - PAD.top - PAD.bottom)}
            y2={PAD.top + (1 - f) * (height - PAD.top - PAD.bottom)}
            stroke="var(--border)" />
        ))}
        {weeks.map((w, i) => {
          const inner = height - PAD.top - PAD.bottom;
          const hMet = (w.load / max) * inner;
          const hMec = (w.mechanical / max) * inner;
          const x = PAD.left + i * bw + bw * 0.18;
          const bwidth = bw * 0.64;
          return (
            <g key={w.weekStart}>
              <title>{`${frDate(w.weekStart, { long: true })} — métabolique ${num(w.load)}, mécanique ${num(w.mechanical)}, ${num(w.vertM)} m D+`}</title>
              <rect x={x} y={PAD.top + inner - hMet - hMec} width={bwidth} height={hMec} fill="var(--mechanical)" opacity="0.75" rx="1.5" />
              <rect x={x} y={PAD.top + inner - hMet} width={bwidth} height={hMet} fill="var(--metabolic)" opacity="0.9" rx="1.5" />
              <text x={x + bwidth / 2} y={height - 6} textAnchor="middle" fontSize="9.5" fill="var(--text-faint)">
                {w.weekStart.slice(8, 10)}/{w.weekStart.slice(5, 7)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--metabolic)' }} />Charge métabolique</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--mechanical)' }} />Charge mécanique</span>
      </div>
    </div>
  );
}

/** Courbe puissance-durée en abscisse logarithmique. */
export function DurationCurve({
  points, height = 200, color = 'var(--metabolic)', unit = 'km/h', label = 'Vitesse corrigée de la pente',
}: {
  points: { durationS: number; value: number }[];
  height?: number; color?: string; unit?: string; label?: string;
}) {
  const data = points.filter((p) => p.durationS > 0 && p.value > 0).sort((a, b) => a.durationS - b.durationS);
  if (data.length < 2) return <div className="empty">Pas assez d'efforts maximaux pour tracer la courbe.</div>;

  const width = 900;
  const lx = (d: number) => Math.log(d);
  const minX = lx(data[0]!.durationS);
  const maxX = lx(data[data.length - 1]!.durationS);
  const minY = Math.min(...data.map((p) => p.value)) * 0.94;
  const maxY = Math.max(...data.map((p) => p.value)) * 1.04;

  const X = (d: number) => PAD.left + ((lx(d) - minX) / (maxX - minX || 1)) * (width - PAD.left - PAD.right);
  const Y = (v: number) => PAD.top + (1 - (v - minY) / (maxY - minY || 1)) * (height - PAD.top - PAD.bottom);

  const path = data.map((p, i) => `${i === 0 ? 'M' : 'L'}${X(p.durationS).toFixed(1)} ${Y(p.value).toFixed(1)}`).join(' ');
  const marks = [30, 60, 300, 600, 1800, 3600, 7200, 14400].filter(
    (m) => m >= data[0]!.durationS && m <= data[data.length - 1]!.durationS,
  );
  const fmt = (s: number) => (s >= 3600 ? `${s / 3600} h` : s >= 60 ? `${s / 60} min` : `${s} s`);

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        <defs>
          <linearGradient id="dc-grad" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0%" stopColor={color} stopOpacity="0.24" />
            <stop offset="100%" stopColor={color} stopOpacity="0.01" />
          </linearGradient>
        </defs>
        {[0, 0.25, 0.5, 0.75, 1].map((f) => {
          const v = minY + (maxY - minY) * f;
          return (
            <g key={f}>
              <line x1={PAD.left} x2={width - PAD.right} y1={Y(v)} y2={Y(v)} stroke="var(--border)" />
              <text x={PAD.left - 7} y={Y(v) + 3.5} textAnchor="end" fontSize="10" fill="var(--text-faint)">{num(v, 1)}</text>
            </g>
          );
        })}
        <path d={`${path} L${X(data[data.length - 1]!.durationS)} ${Y(minY)} L${X(data[0]!.durationS)} ${Y(minY)} Z`} fill="url(#dc-grad)" />
        <path d={path} fill="none" stroke={color} strokeWidth="2" strokeLinejoin="round" />
        {data.map((p) => (
          <circle key={p.durationS} cx={X(p.durationS)} cy={Y(p.value)} r="2.6" fill={color}>
            <title>{`${fmt(p.durationS)} — ${num(p.value, 2)} ${unit}`}</title>
          </circle>
        ))}
        {marks.map((m) => (
          <text key={m} x={X(m)} y={height - 6} textAnchor="middle" fontSize="10" fill="var(--text-faint)">{fmt(m)}</text>
        ))}
      </svg>
      <div className="legend"><span className="legend-item"><span className="legend-swatch" style={{ background: color }} />{label} ({unit})</span></div>
    </div>
  );
}

/** Jauge circulaire de disponibilité. */
/**
 * Jauge de disponibilité.
 *
 * `assumed` est la part du score (0–1) produite par des valeurs par défaut
 * faute de relevé. Elle se lit sur l'anneau lui-même : le trait plein est ce
 * qui est mesuré, le trait creux ce qui est supposé. Un cercle uniformément
 * plein affirmerait une mesure là où il n'y en a pas.
 */
export function Gauge({
  value, max = 100, label, tone, assumed = 0, size = 116,
}: { value: number; max?: number; label?: string; tone: 'green' | 'amber' | 'red'; assumed?: number; size?: number }) {
  const r = 46;
  const c = 2 * Math.PI * r;
  const frac = Math.max(0, Math.min(1, value / max));
  const share = Math.max(0, Math.min(1, assumed));
  const solid = c * frac * (1 - share);
  const hollow = c * frac * share;
  const color = tone === 'green' ? 'var(--good)' : tone === 'amber' ? 'var(--watch)' : 'var(--warn)';
  const pct = Math.round(share * 100);
  return (
    <svg viewBox="0 0 120 120" style={{ width: size, height: size, flex: 'none' }}>
      <circle cx="60" cy="60" r={r} fill="none" stroke="var(--bg-inset)" strokeWidth="9" />
      <circle
        cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="9" strokeLinecap="round"
        strokeDasharray={`${solid} ${c}`} transform="rotate(-90 60 60)"
        style={{ transition: 'stroke-dasharray 500ms ease' }}
      />
      {hollow > 0.5 && (
        <circle
          cx="60" cy="60" r={r} fill="none" stroke={color} strokeWidth="9" opacity="0.28"
          strokeDasharray={`${hollow} ${c}`} strokeDashoffset={-solid} transform="rotate(-90 60 60)"
          style={{ transition: 'stroke-dasharray 500ms ease' }}
        />
      )}
      <text x="60" y={pct > 0 ? 55 : 58} textAnchor="middle" fontSize="27" fontWeight="600" fill="var(--text)" style={{ fontVariantNumeric: 'tabular-nums' }}>
        {num(value)}
      </text>
      {label && <text x="60" y={pct > 0 ? 71 : 76} textAnchor="middle" fontSize="10" fill="var(--text-faint)">{label}</text>}
      {/* La légende reste dans la clairière centrale : plus large, elle passerait
          sous l'anneau et deviendrait illisible. */}
      {pct > 0 && (
        <text x="60" y="84" textAnchor="middle" fontSize="9" fill="var(--watch)" opacity="0.92">
          {num(pct)} % supposé
        </text>
      )}
    </svg>
  );
}

/** Profil altimétrique, avec surbrillance de la pente. */
export function ElevationProfile({
  distance, altitude, grade, height = 130,
}: { distance: number[]; altitude: number[]; grade?: number[]; height?: number }) {
  if (distance.length < 3) return null;
  const width = 900;
  const maxD = distance[distance.length - 1] ?? 1;
  const minA = Math.min(...altitude);
  const maxA = Math.max(...altitude);
  const spanA = maxA - minA || 1;

  const X = (d: number) => PAD.left + (d / maxD) * (width - PAD.left - PAD.right);
  const Y = (a: number) => PAD.top + (1 - (a - minA) / spanA) * (height - PAD.top - PAD.bottom);

  const step = Math.max(1, Math.floor(distance.length / 600));
  const pts: string[] = [];
  for (let i = 0; i < distance.length; i += step) {
    pts.push(`${i === 0 ? 'M' : 'L'}${X(distance[i] as number).toFixed(1)} ${Y(altitude[i] as number).toFixed(1)}`);
  }
  const area = `${pts.join(' ')} L${X(maxD)} ${height - PAD.bottom} L${PAD.left} ${height - PAD.bottom} Z`;

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
      <defs>
        <linearGradient id="elev-grad" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--accent)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--accent)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      <path d={area} fill="url(#elev-grad)" />
      <path d={pts.join(' ')} fill="none" stroke="var(--accent)" strokeWidth="1.6" />
      <text x={PAD.left - 7} y={Y(maxA) + 4} textAnchor="end" fontSize="10" fill="var(--text-faint)">{num(maxA)}</text>
      <text x={PAD.left - 7} y={Y(minA) + 4} textAnchor="end" fontSize="10" fill="var(--text-faint)">{num(minA)}</text>
      {[0.25, 0.5, 0.75, 1].map((f) => (
        <text key={f} x={X(maxD * f)} y={height - 5} textAnchor="middle" fontSize="10" fill="var(--text-faint)">
          {num(maxD * f / 1000, 1)} km
        </text>
      ))}
    </svg>
  );
}

/** Flux superposé (FC, vitesse) sur l'axe des distances. */
export function StreamChart({
  distance, series, height = 160,
}: {
  distance: number[];
  series: { values: (number | null)[]; color: string; label: string; unit: string }[];
  height?: number;
}) {
  if (distance.length < 3 || series.length === 0) return null;
  const width = 900;
  const maxD = distance[distance.length - 1] ?? 1;
  const X = (d: number) => PAD.left + (d / maxD) * (width - PAD.left - PAD.right);
  const step = Math.max(1, Math.floor(distance.length / 700));

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {series.map((s, si) => {
          const finite = s.values.filter((v): v is number => v != null && Number.isFinite(v));
          if (finite.length < 2) return null;
          const min = Math.min(...finite) * 0.95;
          const max = Math.max(...finite) * 1.05;
          const Y = (v: number) => PAD.top + (1 - (v - min) / (max - min || 1)) * (height - PAD.top - PAD.bottom);
          const path: string[] = [];
          let pen = false;
          for (let i = 0; i < distance.length; i += step) {
            const v = s.values[i];
            if (v == null || !Number.isFinite(v)) { pen = false; continue; }
            path.push(`${pen ? 'L' : 'M'}${X(distance[i] as number).toFixed(1)} ${Y(v).toFixed(1)}`);
            pen = true;
          }
          return (
            <g key={s.label}>
              <path d={path.join(' ')} fill="none" stroke={s.color} strokeWidth="1.3" opacity="0.9" />
              <text x={si === 0 ? PAD.left - 7 : width - PAD.right + 7} y={PAD.top + 4}
                textAnchor={si === 0 ? 'end' : 'start'} fontSize="10" fill={s.color}>
                {num(max)}
              </text>
              <text x={si === 0 ? PAD.left - 7 : width - PAD.right + 7} y={height - PAD.bottom}
                textAnchor={si === 0 ? 'end' : 'start'} fontSize="10" fill={s.color}>
                {num(min)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        {series.map((s) => (
          <span className="legend-item" key={s.label}>
            <span className="legend-swatch" style={{ background: s.color }} />{s.label} ({s.unit})
          </span>
        ))}
      </div>
    </div>
  );
}

/** Profil de vitesse par tranche de pente — la signature « trail » d'une séance. */
export function GradeProfileChart({
  buckets, height = 170,
}: {
  buckets: { from: number; to: number; seconds: number; avgSpeedMs: number; vamMh?: number }[];
  height?: number;
}) {
  const active = buckets.filter((b) => b.seconds > 20);
  if (active.length === 0) return null;
  const width = 900;
  const maxTime = Math.max(...active.map((b) => b.seconds));
  const bw = (width - PAD.left - PAD.right) / active.length;
  const inner = height - PAD.top - PAD.bottom;

  return (
    <div>
      <svg viewBox={`0 0 ${width} ${height}`} style={{ width: '100%', height: 'auto', display: 'block' }}>
        {active.map((b, i) => {
          const h = (b.seconds / maxTime) * inner;
          const x = PAD.left + i * bw + bw * 0.15;
          const w = bw * 0.7;
          const mid = (b.from + b.to) / 2;
          const color = mid < -0.02 ? 'var(--metabolic)' : mid > 0.02 ? 'var(--mechanical)' : 'var(--text-faint)';
          return (
            <g key={i}>
              <title>
                {`${num(b.from * 100)}…${num(b.to * 100)} % — ${num(b.seconds / 60)} min à ${num(b.avgSpeedMs * 3.6, 1)} km/h${b.vamMh ? `, ${num(b.vamMh)} m D+/h` : ''}`}
              </title>
              <rect x={x} y={PAD.top + inner - h} width={w} height={h} fill={color} opacity="0.8" rx="2" />
              <text x={x + w / 2} y={height - 12} textAnchor="middle" fontSize="9" fill="var(--text-faint)">
                {num(mid * 100)} %
              </text>
              <text x={x + w / 2} y={height - 2} textAnchor="middle" fontSize="8.5" fill="var(--text-faint)">
                {num(b.avgSpeedMs * 3.6, 1)}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="legend">
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--metabolic)' }} />Descente</span>
        <span className="legend-item"><span className="legend-swatch" style={{ background: 'var(--mechanical)' }} />Montée</span>
        <span className="faint">Hauteur = temps passé · chiffre du bas = vitesse moyenne en km/h</span>
      </div>
    </div>
  );
}
