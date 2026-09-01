'use client';
import type { ReactNode } from 'react';

export function Card({
  title, hint, action, children, style,
}: { title?: string; hint?: string; action?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <section className="card" style={style}>
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {hint && <div className="card-hint">{hint}</div>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Metric({
  label, value, unit, note, tone, delta, direction,
}: {
  label: string; value: ReactNode; unit?: string; note?: string;
  tone?: 'good' | 'watch' | 'warn' | 'metabolic' | 'mechanical';
  delta?: string; direction?: 'up' | 'down' | 'flat';
}) {
  const color =
    tone === 'good' ? 'var(--good)'
    : tone === 'watch' ? 'var(--watch)'
    : tone === 'warn' ? 'var(--warn)'
    : tone === 'metabolic' ? 'var(--metabolic)'
    : tone === 'mechanical' ? 'var(--mechanical)'
    : undefined;
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ color }}>
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
        {delta && <span className="delta" data-dir={direction ?? 'flat'} style={{ marginLeft: 8 }}>{delta}</span>}
      </div>
      {note && <div className="metric-note">{note}</div>}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className="badge" data-tone={tone}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="empty">
      <div className="row" style={{ justifyContent: 'center' }}>
        <span className="spinner" /> <span>{label}</span>
      </div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="banner" data-tone="warn">
      <div style={{ flex: 1 }}>
        <strong>Impossible de charger les données.</strong>
        <div className="small muted" style={{ marginTop: 4 }}>{error}</div>
        <div className="tiny faint" style={{ marginTop: 6 }}>
          Vérifie que l'API tourne : <code>npm run dev:api</code>
        </div>
      </div>
      {onRetry && <button className="btn" onClick={onRetry}>Réessayer</button>}
    </div>
  );
}

/** Barre de répartition du temps par zone. */
export function ZoneBar({ fractions }: { fractions: Record<string, number> }) {
  const keys = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];
  const total = keys.reduce((a, k) => a + (fractions[k] ?? 0), 0) || 1;
  return (
    <div className="zone-bar">
      {keys.map((k) => {
        const w = ((fractions[k] ?? 0) / total) * 100;
        return w > 0 ? <div key={k} className={`zone-seg zone-${k}`} style={{ width: `${w}%` }} title={`${k} · ${w.toFixed(0)} %`} /> : null;
      })}
    </div>
  );
}

/** Barre à trois zones : sous SV1 / entre seuils / au-dessus de SV2. */
export function ThreeZoneBar({ z }: { z: { low: number; moderate: number; high: number } }) {
  const total = z.low + z.moderate + z.high || 1;
  const seg = (v: number, color: string, label: string) =>
    v > 0 ? <div style={{ width: `${(v / total) * 100}%`, background: color }} title={label} /> : null;
  return (
    <div className="zone-bar">
      {seg(z.low, 'var(--z2)', `Bas ${Math.round((z.low / total) * 100)} %`)}
      {seg(z.moderate, 'var(--z4)', `Modéré ${Math.round((z.moderate / total) * 100)} %`)}
      {seg(z.high, 'var(--z5)', `Haut ${Math.round((z.high / total) * 100)} %`)}
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span className="legend-item" key={i.label}>
          <span className="legend-swatch" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}
