'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  duration, frDate, get, getStamped, nbsp, num, post, shortDate,
  type ActivityRow, type InsightRow, type PlanResponse, type PmcResponse, type StateResponse,
} from '@/lib/api';
import { LOAD_WORDS, loadFigures, plainWord, type LoadFigure } from '@/lib/figures';
import { useOutbox } from '@/lib/offline';
import { onForeground } from '@/lib/version';
import { useIsDesk } from '@/lib/viewport';
import {
  AbsenceNotice, Badge, Card, ErrorBox, Loading, LoadName, Metric, MISSING_LABEL,
  ReadinessBasis, Stale, ThreeZoneBar, unweighed, Waiting,
} from '@/components/ui';
import { Gauge, TimeSeriesChart, WeeklyBars } from '@/components/charts';
import { Morning } from '@/components/Morning';
import { ActivityCard } from '@/components/ActivityCard';
import { Term } from '@/components/Term';

interface Health {
  stravaConnected: boolean;
  missingConfig: string[];
  hasActivities: boolean;
  sync: { status?: string; message?: string } | null;
}

/** Ce qu'une analyse dit d'abord : ses deux premières phrases, jamais un mot coupé au 190ᵉ caractère. */
function opening(body: string): string {
  const plain = body.replace(/[*_#]/g, '').replace(/\s+/g, ' ').trim();
  const sentences = plain.match(/[^.!?]+[.!?]+(?=\s|$)/g) ?? [plain];
  return sentences.slice(0, 2).join(' ').trim();
}

export default function Dashboard() {
  const desk = useIsDesk();
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
  useEffect(() => { if (desk === true && !pmc) void loadDeskOnly(); }, [desk, pmc, loadDeskOnly]);

  const reload = useCallback(async () => {
    await load();
    if (desk === true) await loadDeskOnly();
  }, [load, loadDeskOnly, desk]);

  // Revenue au premier plan, l'app relit le Mac : ce qu'elle montre est le plan
  // de cet instant, pas celui de la dernière ouverture.
  useEffect(() => onForeground(() => void reload()), [reload]);

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
  if (desk === null || !state || !plan) return <Loading label="Chargement de ton état de forme…" />;

  // Sous l'ordinateur — téléphone, tablette —, le premier écran répond à la
  // question du matin ; le tableau de bord reste ce qu'il est, une console
  // d'analyse, sur l'écran qui a la place de la montrer.
  if (!desk) {
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
  // Les semaines que le graphique dessine vraiment : l'API ne rend que celles
  // des quarante-cinq derniers jours qui ont une séance, et c'est leur nombre
  // que le titre annonce — « dix », « huit » ne se vérifiaient pas.
  const weeks = state.weeklyTotals.slice(-10);
  // Les absences encore vivantes : en cours ou à venir.
  const absences = state.absences.filter((a) => a.endDate >= today.date);

  // Les quatre chiffres du jour, dans les mots de l'écran du matin : un seul
  // vocabulaire pour les mêmes nombres, et aucun sigle.
  const tone: Record<LoadFigure['key'], 'good' | 'watch' | 'warn' | 'metabolic' | undefined> = {
    ctl: 'metabolic',
    tsb: today.tsb > 5 ? 'good' : today.tsb > -15 ? undefined : today.tsb > -28 ? 'watch' : 'warn',
    mechanicalTsb: today.mechanicalTsb > 0 ? 'good' : today.mechanicalTsb > -18 ? undefined : 'warn',
    acwr: today.acwrRisk === 'high' ? 'warn' : today.acwrRisk === 'moderate' ? 'watch' : 'good',
  };

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
            {frDate(today.date, { weekday: true, year: true, long: true })} · modèle physiologique du{' '}
            {frDate(state.model.asOf, { long: true, year: true })}
            {' · '}confiance {num(state.model.confidence * 100)} %
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
              <div className="tiny faint" style={{ marginBottom: 4 }}>{frDate(n.date, { weekday: true, long: true })}</div>
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
        {loadFigures(today).map((f) => (
          <Card key={f.key}>
            <Metric label={<LoadName w={f} />} value={f.value} note={f.note} tone={tone[f.key]} />
          </Card>
        ))}
      </div>

      <div className="dash-row dash-main">
        <Card
          title="Charge et fraîcheur"
          hint="Six mois, en points de charge par jour. Le cœur et les jambes ne récupèrent pas au même rythme : leurs fraîcheurs se suivent à part."
        >
          <TimeSeriesChart
            height={230}
            zeroLine
            series={[
              { key: 'ctl', label: plainWord(LOAD_WORDS.ctl), legend: <LoadName w={LOAD_WORDS.ctl} />, color: 'var(--metabolic)', fill: true, points: pmc.metabolic.map((p) => ({ date: p.date, value: p.ctl })) },
              { key: 'atl', label: plainWord(LOAD_WORDS.atl), legend: <LoadName w={LOAD_WORDS.atl} />, color: 'var(--text-faint)', dashed: true, width: 1.3, points: pmc.metabolic.map((p) => ({ date: p.date, value: p.atl })) },
              { key: 'tsb', label: plainWord(LOAD_WORDS.tsb), legend: <LoadName w={LOAD_WORDS.tsb} />, color: 'var(--good)', width: 1.6, points: pmc.metabolic.map((p) => ({ date: p.date, value: p.tsb })) },
              { key: 'mech', label: plainWord(LOAD_WORDS.mechanicalTsb), legend: <LoadName w={LOAD_WORDS.mechanicalTsb} />, color: 'var(--mechanical)', width: 1.6, points: pmc.mechanical.map((p) => ({ date: p.date, value: p.tsb })) },
            ]}
          />
        </Card>

        <Card title={<><Term k="disponibilite">Disponibilité</Term> du jour</>}>
          <div className="readiness-head">
            <Gauge value={readiness.score} label="sur 100" tone={readiness.verdict} assumed={readiness.assumedShare} />
            <div className="readiness-verdict">
              <Badge tone={readiness.verdict === 'green' ? 'good' : readiness.verdict === 'amber' ? 'watch' : 'warn'}>
                <span className="dot" />
                {readiness.verdict === 'green' ? 'Feu vert' : readiness.verdict === 'amber' ? 'Vigilance' : 'Signal rouge'}
              </Badge>
              <p className="small muted" style={{ marginTop: 8, marginBottom: 0 }}>{nbsp(readiness.recommendation)}</p>
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

      <div className="dash-row dash-pair">
        <Card
          title="Volume hebdomadaire"
          hint={
            <>
              {weeks.length > 1 ? `Les ${num(weeks.length)} dernières semaines` : 'Cette semaine'} :{' '}
              <Term k="points">points de charge</Term> et <Term k="mecanique">charge mécanique</Term>, empilés.
            </>
          }
        >
          <WeeklyBars
            weeks={weeks}
            legend={{ metabolic: <Term k="points">Points de charge</Term>, mechanical: <Term k="mecanique">Charge mécanique</Term> }}
          />
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
                <Link key={s.id} href="/plan" className="dash-next">
                  <div style={{ minWidth: 0 }}>
                    <div className="row" style={{ gap: 7 }}>
                      <span className="tiny mono faint">{shortDate(s.date)}</span>
                      {s.priority === 'key' && <Badge tone="good">clef</Badge>}
                    </div>
                    <div style={{ fontWeight: 550, marginTop: 2, fontSize: 13.5 }}>{s.title}</div>
                  </div>
                  <div className="dash-next-figures">
                    <div className="mono small">{num(s.plannedLoad)} points</div>
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
                  <div className="metric-value" style={{ fontSize: 21 }}>J−{num(nextRace.daysUntil ?? 0)}</div>
                  <div className="tiny faint">{frDate(nextRace.date)}</div>
                </div>
              </div>
            </div>
          )}
        </Card>
      </div>

      <div className="dash-row dash-pair">
        <Card title="Analyses du coach" action={<Link href="/activities" className="btn" data-variant="ghost">Toutes les séances →</Link>}>
          {insights.length === 0 ? (
            <div className="empty">
              Aucune analyse rédigée : elles s&apos;écrivent à l&apos;import d&apos;une séance, quand une clé
              Anthropic est configurée.
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
                  <p className="small muted" style={{ margin: 0 }}>{opening(i.body)}</p>
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

        {/* Un tableau s'il tient dans la carte, les cartes du téléphone sinon :
            c'est la carte qui choisit, sur sa largeur (`.dash-acts`). */}
        <Card title="Dernières séances">
          {activities.length === 0 ? (
            <div className="empty">Aucune séance importée pour l'instant.</div>
          ) : (
            <>
              <div className="act-cards dash-acts-cards">
                {activities.map((a) => <ActivityCard key={a.id} activity={a} />)}
              </div>
              <table className="dash-acts">
                <thead>
                  <tr><th>Date</th><th>Séance</th><th className="right">Points</th><th>Intensité</th></tr>
                </thead>
                <tbody>
                  {activities.map((a) => (
                    <tr key={a.id} className="clickable" onClick={() => { window.location.href = `/activities/${a.id}`; }}>
                      <td className="mono tiny faint">{frDate(a.startDateLocal)}</td>
                      <td>
                        <div style={{ fontWeight: 500 }}>{a.name}</div>
                        <div className="tiny faint">
                          {num(a.distanceKm, 1)} km · {a.durationLabel} · {num(a.totalElevationGainM)} m D+
                          {a.load && a.load.mechanical >= 1 && <> · {num(a.load.mechanical)} de charge mécanique</>}
                        </div>
                      </td>
                      <td className="right mono" style={{ color: 'var(--metabolic)' }}>{a.load ? num(a.load.metabolic) : '—'}</td>
                      <td style={{ width: 84 }}>{a.zones ? <ThreeZoneBar z={a.zones} /> : <span className="faint tiny">—</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </Card>
      </div>
    </>
  );
}
