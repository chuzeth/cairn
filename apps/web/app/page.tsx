'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  duration, frDate, get, getStamped, post, signed, shortDate,
  type ActivityRow, type InsightRow, type PlanResponse, type PmcResponse, type StateResponse,
} from '@/lib/api';
import { useOutbox } from '@/lib/offline';
import { useIsPhone } from '@/lib/viewport';
import {
  AbsenceNotice, Badge, Card, ErrorBox, Loading, Metric, MISSING_LABEL,
  ReadinessBasis, Stale, ThreeZoneBar, unweighed, Waiting,
} from '@/components/ui';
import { Gauge, TimeSeriesChart, WeeklyBars } from '@/components/charts';
import { Morning } from '@/components/Morning';

interface Health {
  stravaConnected: boolean;
  missingConfig: string[];
  hasActivities: boolean;
  sync: { status?: string; message?: string } | null;
}

export default function Dashboard() {
  const phone = useIsPhone();
  const [state, setState] = useState<StateResponse | null>(null);
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [pmc, setPmc] = useState<PmcResponse | null>(null);
  const [insights, setInsights] = useState<InsightRow[]>([]);
  const [activities, setActivities] = useState<ActivityRow[]>([]);
  const [health, setHealth] = useState<Health | null>(null);
  /** Non nul : ce qui est à l'écran sort du cache, et date de ce moment-là. */
  const [recordedAt, setRecordedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [syncing, setSyncing] = useState(false);
  const [filing, setFiling] = useState<string | null>(null);

  /** Ce sans quoi aucun des deux écrans ne peut rien dire. */
  const load = useCallback(async () => {
    setError(null);
    try {
      const [h, s, pl] = await Promise.all([
        get<Health>('/health'),
        getStamped<StateResponse>('/api/state'),
        get<PlanResponse>('/api/plan?weeks=2'),
      ]);
      setHealth(h); setState(s.data); setPlan(pl); setRecordedAt(s.recordedAt);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  /**
   * Ce que seul le tableau de bord affiche. Cent quatre-vingts jours de PMC
   * n'ont rien à faire sur le réseau d'un téléphone à sept heures du matin,
   * pour finir dans un graphique que cet écran ne montre pas.
   */
  const loadDeskOnly = useCallback(async () => {
    try {
      const [p, i, a] = await Promise.all([
        get<PmcResponse>('/api/pmc?days=180'),
        get<InsightRow[]>('/api/insights?limit=6'),
        get<ActivityRow[]>('/api/activities?limit=6'),
      ]);
      setPmc(p); setInsights(i); setActivities(a);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  useEffect(() => { void load(); }, [load]);
  useEffect(() => { if (phone === false && !pmc) void loadDeskOnly(); }, [phone, pmc, loadDeskOnly]);

  const reload = useCallback(async () => {
    await load();
    if (phone === false) await loadDeskOnly();
  }, [load, loadDeskOnly, phone]);

  // Une réponse partie en différé a été calculée par le serveur, pas ici :
  // l'écran ne connaît le score qu'elle produit qu'en relisant l'état.
  const { pending } = useOutbox();
  const wasPending = useRef(pending);
  useEffect(() => {
    if (wasPending.current > 0 && pending === 0) void reload();
    wasPending.current = pending;
  }, [pending, reload]);

  const runSync = async () => {
    setSyncing(true);
    try {
      await post('/api/sync', { maxActivities: 40 });
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSyncing(false);
    }
  };

  // Classer une note, c'est en avoir fait quelque chose — même quand ce quelque
  // chose est « rien à en tirer ». Sans ce geste, la seule façon de faire taire
  // le bandeau serait d'effacer ce qu'on a écrit.
  const fileNote = async (date: string) => {
    setFiling(date);
    try {
      await post(`/api/checkins/${date}/note/handled`, {});
      await reload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setFiling(null);
    }
  };

  if (error && !state) return <ErrorBox error={error} onRetry={load} />;
  if (phone === null || !state || !plan) return <Loading label="Chargement de ton état de forme…" />;

  // Au téléphone, le premier écran répond à la question du matin ; le tableau
  // de bord reste ce qu'il est, une console d'analyse, sur l'écran qui va avec.
  if (phone) {
    return (
      <Morning
        state={state}
        plan={plan}
        stravaConnected={health?.stravaConnected ?? true}
        recordedAt={recordedAt}
        onReload={reload}
        onFileNote={(d) => { void fileNote(d); }}
        filing={filing}
      />
    );
  }

  // L'état peut venir de la réserve du service worker ; les cent quatre-vingts
  // jours de PMC, non. Sans eux, le tableau de bord n'a rien à montrer et le
  // dit — un chargement sans fin masquerait une API arrêtée.
  if (!pmc) return error ? <ErrorBox error={error} onRetry={reload} /> : <Loading label="Chargement de ton état de forme…" />;

  const today = state.today;
  // Une séance retirée par une absence déclarée n'est pas à venir : elle n'est
  // plus au programme. L'annoncer ici demanderait de faire ce qu'on a accepté
  // qu'il ne fasse pas.
  const upcoming = plan.sessions
    .filter((s) => s.date >= state.today.date && s.type !== 'rest' && s.status !== 'withdrawn' && s.status !== 'cancelled')
    .slice(0, 4);
  const nextRace = state.upcomingRaces[0];
  // Les absences encore vivantes : en cours ou à venir.
  const absences = state.absences.filter((a) => a.endDate >= today.date);

  const tsbTone = today.tsb > 5 ? 'good' : today.tsb > -15 ? undefined : today.tsb > -28 ? 'watch' : 'warn';
  const mechTone = today.mechanicalTsb > 0 ? 'good' : today.mechanicalTsb > -18 ? undefined : 'warn';

  // Ce que le score ne regarde pas, nommé. Il n'invente plus rien — ce qui n'a
  // pas de source ne pèse rien — mais un score étroit ne dit pas ce que dit un
  // score complet, et l'athlète a le droit de savoir lequel des deux il lit.
  const readiness = state.readiness;
  const missing = unweighed(readiness).map((k) => MISSING_LABEL[k]);

  return (
    <>
      {recordedAt && <Stale recordedAt={recordedAt} />}
      <Waiting />

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

      {state.pendingNotes.length > 0 && (
        <div className="banner" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 4 }}>
          <strong>Ce que tu as écrit, et dont rien n&apos;a encore été fait.</strong>
          {state.pendingNotes.map((n) => (
            <div key={n.date} style={{ marginTop: 8 }}>
              <div className="tiny faint" style={{ marginBottom: 4 }}>{frDate(n.date, { weekday: true })}</div>
              <blockquote className="note-quote">{n.notes}</blockquote>
              <div className="row wrap" style={{ gap: 8, marginTop: 8 }}>
                <Link href="/coach" className="btn" data-variant="primary">En parler au coach</Link>
                <button className="btn" onClick={() => fileNote(n.date)} disabled={filing === n.date}>
                  {filing === n.date ? <><span className="spinner" /> …</> : 'Classer sans suite'}
                </button>
              </div>
            </div>
          ))}
          <p className="tiny faint" style={{ margin: '10px 0 0' }}>
            Une note n&apos;entre dans aucun calcul et n&apos;a donc que cette place-là. Elle reste ici
            tant qu&apos;il n&apos;en sort rien — une absence déclarée, une décision, ou un classement.
          </p>
        </div>
      )}

      {absences.map((a) => (
        <AbsenceNotice key={a.id} absence={a} today={today.date} />
      ))}

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
            <a className="btn" data-variant="primary" href="/auth/strava">
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
            <Gauge value={readiness.score} label="sur 100" tone={readiness.verdict} assumed={readiness.assumedShare} />
            <div style={{ minWidth: 0 }}>
              <Badge tone={readiness.verdict === 'green' ? 'good' : readiness.verdict === 'amber' ? 'watch' : 'warn'}>
                <span className="dot" />
                {readiness.verdict === 'green' ? 'Feu vert' : readiness.verdict === 'amber' ? 'Vigilance' : 'Signal rouge'}
              </Badge>
              <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>{readiness.recommendation}</p>
            </div>
          </div>

          <ReadinessBasis readiness={readiness} />

          {missing.length > 0 && (
            <p className="tiny" style={{ color: 'var(--watch)', margin: '12px 0 0' }}>
              Ce score ne regarde pas {missing.join(' ni ')} : faute de relevé,{' '}
              {missing.length > 1 ? 'ils ne pèsent' : 'il ne pèse'} rien, plutôt que de peser une
              moyenne. Le point du jour {missing.length > 1 ? 'leur rend leur' : 'lui rend son'} poids.
            </p>
          )}

          {/* La note en attente est déjà en haut de page ; ici ne reste que celle
              dont quelque chose a été fait, avec ce qui en a été fait. */}
          {state.checkIn?.notes && state.checkIn.noteHandledAt && (
            <blockquote className="note-quote" style={{ marginTop: 12, fontSize: 13 }}>
              {state.checkIn.notes}
              {state.checkIn.noteHandledAs && (
                <div className="tiny faint" style={{ marginTop: 6 }}>→ {state.checkIn.noteHandledAs}</div>
              )}
            </blockquote>
          )}

          <Link
            href="/point"
            className="btn"
            style={{ width: '100%', marginTop: 14 }}
            data-variant={missing.length > 0 ? 'primary' : 'ghost'}
          >
            {state.checkIn ? 'Compléter mon point du jour →' : 'Faire mon point du jour →'}
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
