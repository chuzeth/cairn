import Link from 'next/link';
import { frDate, num, type ActivityRow } from '@/lib/api';
import { Badge } from '@/components/ui';

/**
 * Une séance quand la place manque pour un tableau : ce qui la reconnaît, puis
 * ce qu'elle a coûté.
 *
 * Quatre mesures, pas dix. L'allure, la FC moyenne, la dérive et la répartition
 * d'intensité demandent une colonne chacune et se lisent l'une contre l'autre —
 * elles sont sur la page de la séance, où il y a la place de les comparer.
 */
export function ActivityCard({ activity: a }: { activity: ActivityRow }) {
  return (
    <Link href={`/activities/${a.id}`} className="act-card">
      <div className="act-card-head">
        <span className="act-name">{a.name}</span>
        <span className="act-when">{frDate(a.startDateLocal)}</span>
        {a.flags > 0 && <Badge tone="watch">{num(a.flags)}</Badge>}
      </div>
      <div className="act-figures">
        <Figure value={num(a.distanceKm, 1)} label="km" />
        <Figure value={a.durationLabel} label="durée" />
        <Figure value={num(a.totalElevationGainM)} label="m D+" />
        {/* Des points de charge, dits comme tels : « 85 charge » ne disait pas ce que 85 compte. */}
        <Figure
          value={a.load ? num(a.load.metabolic) : '—'}
          label="points"
          color={a.load ? 'var(--metabolic)' : undefined}
        />
      </div>
    </Link>
  );
}

function Figure({ value, label, color }: { value: string; label: string; color?: string }) {
  return (
    <div className="act-figure">
      <span className="act-figure-value" style={{ color }}>{value}</span>
      <span className="act-figure-label">{label}</span>
    </div>
  );
}
