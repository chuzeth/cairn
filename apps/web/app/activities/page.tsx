'use client';
import { useCallback, useEffect, useMemo, useState } from 'react';
import { useRouter } from 'next/navigation';
import { frDate, get, isoOffset, num, type ActivityRow } from '@/lib/api';
import { Badge, Card, ErrorBox, Loading, ThreeZoneBar } from '@/components/ui';
import { ActivityCard } from '@/components/ActivityCard';

const RANGES = [
  { label: '30 j', days: 30 }, { label: '90 j', days: 90 },
  { label: '6 mois', days: 180 }, { label: '1 an', days: 365 },
];

export default function ActivitiesPage() {
  const router = useRouter();
  const [rows, setRows] = useState<ActivityRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [days, setDays] = useState(90);
  const [query, setQuery] = useState('');

  const load = useCallback(async () => {
    setRows(null);
    try {
      setRows(await get<ActivityRow[]>(`/api/activities?from=${isoOffset(-days)}&limit=300`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, [days]);
  useEffect(() => { void load(); }, [load]);

  const filtered = useMemo(() => {
    if (!rows) return [];
    const q = query.trim().toLowerCase();
    return q ? rows.filter((r) => r.name.toLowerCase().includes(q) || r.sportType.toLowerCase().includes(q)) : rows;
  }, [rows, query]);

  const totals = useMemo(() => {
    return filtered.reduce(
      (a, r) => ({
        distance: a.distance + r.distanceKm,
        time: a.time + r.movingTimeS,
        vert: a.vert + r.totalElevationGainM,
        load: a.load + (r.load?.metabolic ?? 0),
        mech: a.mech + (r.load?.mechanical ?? 0),
      }),
      { distance: 0, time: 0, vert: 0, load: 0, mech: 0 },
    );
  }, [filtered]);

  if (error) return <ErrorBox error={error} onRetry={load} />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Séances</h1>
          <p className="page-sub">
            {num(filtered.length)} séances · {num(totals.distance)} km · {num(totals.vert)} m D+ ·
            {' '}{num(totals.load)} points de charge métabolique, {num(totals.mech)} de charge mécanique
          </p>
        </div>
        <div className="act-controls">
          <input
            placeholder="Rechercher…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            style={{ width: 190 }}
          />
          <div className="act-range">
            {RANGES.map((r) => (
              <button
                key={r.days}
                className="btn"
                data-variant={days === r.days ? undefined : 'ghost'}
                onClick={() => setDays(r.days)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Les deux formes sont là ; la carte choisit, sur sa propre largeur, celle
          qu'elle montre (`globals.css`, `.act-table`). */}
      <Card>
        {!rows ? (
          <Loading />
        ) : filtered.length === 0 ? (
          <div className="empty">Aucune séance sur cette période.</div>
        ) : (
          <>
            <div className="act-cards">
              {filtered.map((a) => <ActivityCard key={a.id} activity={a} />)}
            </div>
            <table className="act-table">
              <thead>
                <tr>
                  <th>Date</th>
                  <th>Séance</th>
                  <th className="right">Distance</th>
                  <th className="right">Durée</th>
                  <th className="right">D+</th>
                  <th className="right">Allure</th>
                  <th className="right">FC moy</th>
                  <th className="right">Charge</th>
                  <th>Intensité</th>
                  <th className="right">Dérive</th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => router.push(`/activities/${a.id}`)}>
                    <td className="mono tiny faint" style={{ whiteSpace: 'nowrap' }}>{frDate(a.startDateLocal)}</td>
                    <td className="act-name-cell">
                      <div className="row" style={{ gap: 7 }}>
                        <span style={{ fontWeight: 500 }}>{a.name}</span>
                        {a.flags > 0 && <Badge tone="watch">{num(a.flags)}</Badge>}
                        {a.intervalCount > 0 && <span className="tiny faint">{num(a.intervalCount)} blocs</span>}
                      </div>
                      <div className="tiny faint">{a.sportType}</div>
                    </td>
                    <td className="right mono">{num(a.distanceKm, 1)}</td>
                    <td className="right mono">{a.durationLabel}</td>
                    <td className="right mono">{num(a.totalElevationGainM)}</td>
                    <td className="right mono">{a.pace}</td>
                    <td className="right mono">{a.averageHr ? num(a.averageHr) : '—'}</td>
                    <td className="right mono">
                      {a.load ? (
                        <>
                          <span style={{ color: 'var(--metabolic)' }}>{num(a.load.metabolic)}</span>
                          {a.load.mechanical > 5 && <span style={{ color: 'var(--mechanical)' }}> / {num(a.load.mechanical)}</span>}
                        </>
                      ) : '—'}
                    </td>
                    <td style={{ width: 78 }}>{a.zones ? <ThreeZoneBar z={a.zones} /> : <span className="faint tiny">—</span>}</td>
                    <td className="right mono" style={{ color: a.decoupling != null && a.decoupling > 8 ? 'var(--warn)' : undefined }}>
                      {a.decoupling != null ? `${num(a.decoupling, 1)} %` : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </>
        )}
      </Card>
    </>
  );
}
