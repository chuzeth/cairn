'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  duration, frDate, get, post, signed, shortDate,
  type ActivityRow, type InsightRow, type PmcResponse, type SessionRow, type StateResponse,
} from '@/lib/api';
import { Badge, Card, ErrorBox, Loading, Metric, ThreeZoneBar } from '@/components/ui';
import { Gauge, TimeSeriesChart, WeeklyBars } from '@/components/charts';

interface Health {
  stravaConnected: boolean;
  missingConfig: string[];
  hasActivities: boolean;
  sync: { status?: string; message?: string } | null;
}

export default function Dashboard() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [pmc, setPmc] = useState<PmcResponse | null>(null);
  const [insights, setInsights] = useState<InsightRow[]>([]);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);

  const load = useCallback(async () => {
    setError(null);
    try {
      const h = await get<Health>('/health');
      setHealth(h);
      const [s, p, i, a, pl] = await Promise.all([
        get<StateResponse>('/api/state'),
        get<PmcResponse>('/api/pmc?days=180'),
        get<InsightRow[]>('/api/insights?limit=6'),
        get<ActivityRow[]>('/api/activities?limit=6'),
        get<{ sessions: SessionRow[] }>('/api/plan?weeks=2'),
      ]);
      setState(s); setPmc(p); setInsights(i); setActivities(a); setSessions(pl.sessions);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  const runSync = async () => {
    setSyncing(true);
    try {
      await post('/api/sync', { maxActivities: 40 });
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  if (error && !state) return <ErrorBox error={error} onRetry={load} />;
  if (!state || !pmc) return <Loading label="Chargement de ton état de forme…" />;

  const today = state.today;
  const upcoming = sessions.filter((s) => s.date >= state.today.date && s.type !== 'rest').slice(0, 4);
  const nextRace = state.upcomingRaces[0];

  const tsbTone = today.tsb > 5 ? 'good' : today.tsb > -15 ? undefined : today.tsb > -28 ? 'watch' : 'warn';
  const mechTone = today.mechanicalTsb > 0 ? 'good' : today.mechanicalTsb > -18 ? undefined : 'warn';

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Tableau de bord</h1>
          <p className="page-sub">
            {frDate(today.date, { weekday: true, year: true })} · modèle physiologique du {frDate(state.model.asOf)}
            {' · '}confiance {Math.round(state.model.confidence * 100)} %
          </p>
        </div>
        <div className="row">
          <button className="btn" onClick={runSync} disabled={syncing || !health?.stravaConnected}>
            {syncing ? <><span className="spinner" /> Import…</> : 'Synchroniser Strava'}
          </button>
          <Link href="/coach" className="btn" data-variant="primary">Parler au coach</Link>
        </div>
      </div>

      {health && !health.stravaConnected && (
        <div className="banner">
          <div style={{ flex: 1 }}>
            <strong>Strava n'est pas encore connecté.</strong>
            <div className="small muted" style={{ marginTop: 4 }}>
              {health.missingConfig.length > 0 ? (
                <>
                  Renseigne d'abord{' '}
                  {health.missingConfig.map((k, i) => (
                    <span key={k}>
                      {i > 0 && ', '}
                      <code>{k}</code>
                    </span>
                  ))}{' '}
                  dans le fichier <code>.env</code> à la racine du projet, puis relance l'API.
                </>
              ) : (
                <>Tout est prêt côté configuration : autorise l'accès à ton compte pour lancer l'import de ton historique.</>
              )}
            </div>
          </div>
          {health.missingConfig.length === 0 && (
            <a className="btn" data-variant="primary" href={`${process.env.NEXT_PUBLIC_API_URL ?? 'http://localhost:4000'}/auth/strava`}>
              Connecter Strava
            </a>
          )}
        </div>
      )}

      {health?.stravaConnected && !health.hasActivities && (
        <div className="banner" data-tone="info">
          <div style={{ flex: 1 }}>
            <strong>Import en cours.</strong>
            <div className="small muted" style={{ marginTop: 4 }}>
              {health.sync?.message ?? "Ton historique est en cours de téléchargement. Les analyses apparaîtront au fur et à mesure."}
            </div>
          </div>
        </div>
      )}

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Card>
          <Metric
            label="Charge chronique"
            value={Math.round(today.ctl)}
            note={`${signed(today.rampRate, 1)} pts/semaine`}
            tone="metabolic"
          />
        </Card>
        <Card>
          <Metric
            label="Fraîcheur métabolique"
            value={signed(today.tsb)}
            note={today.tsbLabel}
            tone={tsbTone}
          />
        </Card>
        <Card>
          <Metric
            label="Fraîcheur mécanique"
            value={signed(today.mechanicalTsb)}
            note="Fatigue musculaire de descente"
            tone={mechTone}
          />
        </Card>
        <Card>
          <Metric
            label="Charge aiguë / chronique"
            value={today.acwr.toFixed(2)}
            note={today.acwrLabel}
            tone={today.acwrRisk === 'high' ? 'warn' : today.acwrRisk === 'moderate' ? 'watch' : 'good'}
          />
        </Card>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,2fr) minmax(0,1fr)', marginBottom: 14 }}>
        <Card
          title="Charge et fraîcheur"
          hint="Deux filières suivies en parallèle : le cœur et les muscles ne récupèrent pas au même rythme."
        >
          <TimeSeriesChart
            height={230}
            zeroLine
            series={[
              { key: 'ctl', label: 'CTL métabolique', color: 'var(--metabolic)', fill: true, points: pmc.metabolic.map((p) => ({ date: p.date, value: p.ctl })) },
              { key: 'atl', label: 'ATL', color: 'var(--text-faint)', dashed: true, width: 1.3, points: pmc.metabolic.map((p) => ({ date: p.date, value: p.atl })) },
              { key: 'tsb', label: 'TSB métabolique', color: 'var(--good)', width: 1.6, points: pmc.metabolic.map((p) => ({ date: p.date, value: p.tsb })) },
              { key: 'mech', label: 'TSB mécanique', color: 'var(--mechanical)', width: 1.6, points: pmc.mechanical.map((p) => ({ date: p.date, value: p.tsb })) },
            ]}
          />
        </Card>

        <Card title="Disponibilité du jour">
          <div className="row" style={{ gap: 16, alignItems: 'center' }}>
            <Gauge value={state.readiness.score} label="sur 100" tone={state.readiness.verdict} />
            <div style={{ minWidth: 0 }}>
              <Badge tone={state.readiness.verdict === 'green' ? 'good' : state.readiness.verdict === 'amber' ? 'watch' : 'warn'}>
                <span className="dot" />
                {state.readiness.verdict === 'green' ? 'Feu vert' : state.readiness.verdict === 'amber' ? 'Vigilance' : 'Signal rouge'}
              </Badge>
              <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>{state.readiness.recommendation}</p>
            </div>
          </div>
          <div style={{ marginTop: 14, display: 'grid', gap: 6 }}>
            {[
              ['Fraîcheur métabolique', state.readiness.components.tsbMetabolic],
              ['Fraîcheur mécanique', state.readiness.components.tsbMechanical],
              ['Ressenti déclaré', state.readiness.components.subjective],
              ['Système autonome', state.readiness.components.autonomic],
            ].map(([label, v]) => (
              <div key={label as string} className="row" style={{ gap: 8 }}>
                <span className="tiny faint" style={{ width: 130, flex: 'none' }}>{label}</span>
                <div style={{ flex: 1, height: 5, background: 'var(--bg-inset)', borderRadius: 3, overflow: 'hidden' }}>
                  <div style={{ width: `${v as number}%`, height: '100%', background: 'var(--accent)', opacity: 0.75 }} />
                </div>
                <span className="tiny mono muted" style={{ width: 26, textAlign: 'right' }}>{Math.round(v as number)}</span>
              </div>
            ))}
          </div>
          <Link href="/coach" className="btn" style={{ width: '100%', marginTop: 14 }} data-variant="ghost">
            Faire mon point du jour →
          </Link>
        </Card>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1fr) minmax(0,1fr)', marginBottom: 14 }}>
        <Card title="Volume hebdomadaire" hint="Charge métabolique et mécanique empilées, 8 dernières semaines.">
          <WeeklyBars weeks={state.weeklyTotals.slice(-10)} />
        </Card>

        <Card
          title="Prochaines séances"
          action={<Link href="/plan" className="btn" data-variant="ghost">Voir le plan →</Link>}
        >
          {upcoming.length === 0 ? (
            <div className="empty">
              Aucune séance planifiée.
              <div style={{ marginTop: 10 }}>
                <Link href="/races" className="btn" data-variant="primary">Définir un objectif</Link>
              </div>
            </div>
          ) : (
            <div className="stack" style={{ gap: 10 }}>
              {upcoming.map((s) => (
                <Link key={s.id} href="/plan" className="row-between" style={{ padding: '9px 11px', background: 'var(--bg-inset)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 7 }}>
                      <span className="tiny mono faint">{shortDate(s.date)}</span>
                      {s.priority === 'key' && <Badge tone="good">clef</Badge>}
                    </div>
                    <div style={{ fontWeight: 550, marginTop: 2, fontSize: 13.5 }}>{s.title}</div>
                  </div>
                  <div style={{ textAlign: 'right', flex: 'none' }}>
                    <div className="mono small">{s.plannedLoad} pts</div>
                    <div className="tiny faint">{duration(s.plannedDurationS)}</div>
                  </div>
                </Link>
              ))}
            </div>
          )}
          {nextRace && (
            <div style={{ marginTop: 14, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div className="row-between">
                <div>
                  <div className="tiny faint">Prochain objectif</div>
                  <div style={{ fontWeight: 600 }}>{nextRace.name}</div>
                </div>
                <div style={{ textAlign: 'right' }}>
                  <div className="metric-value" style={{ fontSize: 21 }}>J−{nextRace.daysUntil}</div>
                  <div className="tiny faint">{frDate(nextRace.date)}</div>
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="grid" style={{ gridTemplateColumns: 'minmax(0,1.15fr) minmax(0,1fr)' }}>
        <Card title="Analyses du coach" action={<Link href="/activities" className="btn" data-variant="ghost">Toutes les séances →</Link>}>
          {insights.length === 0 ? (
            <div className="empty">
              Les analyses apparaîtront après ta première séance synchronisée.
            </div>
          ) : (
            <div className="stack">
              {insights.slice(0, 4).map((i) => (
                <div key={i.id} style={{ paddingBottom: 12, borderBottom: '1px solid var(--border)' }}>
                  <div className="row-between" style={{ marginBottom: 5 }}>
                    <strong style={{ fontSize: 13.5 }}>{i.title}</strong>
                    <Badge tone={i.severity === 'warn' ? 'warn' : i.severity === 'watch' ? 'watch' : i.severity === 'good' ? 'good' : undefined}>
                      {frDate(i.createdAt)}
                    </Badge>
                  </div>
                  <p className="small muted" style={{ margin: 0 }}>
                    {i.body.replace(/[*_#]/g, '').slice(0, 190)}
                    {i.body.length > 190 ? '…' : ''}
                  </p>
                  {i.highlights.length > 0 && (
                    <div className="row wrap" style={{ gap: 6, marginTop: 8 }}>
                      {i.highlights.slice(0, 4).map((h) => (
                        <span key={h.label} className="badge">
                          {h.label} <strong style={{ color: 'var(--text)' }}>{h.value}</strong>
                        </span>
                      ))}
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>

        <Card title="Dernières séances">
          {activities.length === 0 ? (
            <div className="empty">Aucune séance importée pour l'instant.</div>
          ) : (
            <table>
              <thead>
                <tr><th>Date</th><th>Séance</th><th className="right">Charge</th><th>Intensité</th></tr>
              </thead>
              <tbody>
                {activities.map((a) => (
                  <tr key={a.id} className="clickable" onClick={() => { window.location.href = `/activities/${a.id}`; }}>
                    <td className="mono tiny faint">{shortDate(a.startDateLocal)}</td>
                    <td>
                      <div style={{ fontWeight: 500 }}>{a.name.length > 26 ? `${a.name.slice(0, 26)}…` : a.name}</div>
                      <div className="tiny faint">{a.distanceKm} km · {a.durationLabel} · {Math.round(a.totalElevationGainM)} m D+</div>
                    </td>
                    <td className="right mono">
                      {a.load ? (
                        <>
                          <div style={{ color: 'var(--metabolic)' }}>{Math.round(a.load.metabolic)}</div>
                          <div className="tiny" style={{ color: 'var(--mechanical)' }}>{Math.round(a.load.mechanical)}</div>
                        </>
                      ) : '—'}
                    </td>
                    <td style={{ width: 84 }}>{a.zones ? <ThreeZoneBar z={a.zones} /> : <span className="faint tiny">—</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </Card>
      </div>
    </>
  );
}
