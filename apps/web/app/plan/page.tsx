'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  PLAN_URL, blockDuration, duration, frDate, getStamped, nbsp, num, todayIso,
  type LoadRatioAlertRow, type PlanResponse, type SessionRow,
} from '@/lib/api';
import {
  circuitText, CRITERION_LABELS, originLabel, planName, provenanceText, recoveryText,
} from '@/lib/sessions';
import {
  AbsenceNotice, Badge, ErrorBox, GarminLine, GarminProblems, Loading, RatioAlerts, SessionHistory, Stale, WhereLine,
} from '@/components/ui';
import { Figures } from '@/components/Today';
import { Term } from '@/components/Term';
import { SessionMap } from '@/components/SessionMap';
import { Itinerary } from '@/components/Itinerary';
import { onForeground } from '@/lib/version';
import { followsPace } from '@cairn/core/blocks';
import { isWorkout } from '@/lib/workout';
import { held, weekStartOf } from '@/lib/today';

/** Le jour de la semaine : une lettre dans la grille, trois dans la liste. */
const DOW_SHORT = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const DOW_LONG = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];

/**
 * La semaine en barres : la charge prévue de chaque jour, à l'échelle de la
 * plus lourde. Faite à l'encre, aujourd'hui en terracotta, à venir en sable.
 * La forme de la semaine se lit avant ses lignes. Un jour où le plan dépasse
 * un seuil de ratio de charge porte un trait d'alerte : la phrase est dessous.
 */
function WeekBars({
  days, sessions, today, alerts,
}: { days: string[]; sessions: SessionRow[]; today: string; alerts: LoadRatioAlertRow[] }) {
  const loads = days.map((d) => sessions.filter((s) => s.date === d && held(s)).reduce((a, s) => a + s.plannedLoad, 0));
  const max = Math.max(1, ...loads);
  const state = (d: string) => {
    const daily = sessions.filter((s) => s.date === d && held(s));
    if (daily.some((s) => s.status === 'completed' || s.status === 'replaced')) return 'done';
    return d === today ? 'today' : d < today ? 'past' : 'planned';
  };
  const alerted = (d: string) => alerts.some((a) => a.date === d);
  const label = loads
    .map((l, i) => `${DOW_LONG[i]} ${l}${alerted(days[i]!) ? ' (ratio de charge au-delà du seuil)' : ''}`)
    .join(', ');
  return (
    <figure className="plan-bars" role="img" aria-label={`Charge prévue par jour : ${label} points`}>
      <div className="plan-bars-cols">
        {days.map((d, i) => (
          <div key={d} className="plan-bars-col">
            <span className="plan-bars-n" data-alert={alerted(d)}>{loads[i] ? num(loads[i]!) : alerted(d) ? '·' : ''}</span>
            <span
              className="plan-bars-bar"
              data-state={state(d)}
              data-alert={alerted(d)}
              style={{ height: `${Math.round((loads[i]! / max) * 100)}%` }}
            />
          </div>
        ))}
      </div>
      <div className="plan-bars-days" aria-hidden>
        {days.map((d, i) => <span key={d} data-today={d === today} data-alert={alerted(d)}>{DOW_SHORT[i]}</span>)}
      </div>
    </figure>
  );
}

export default function PlanPage() {
  const [data, setData] = useState<PlanResponse | null>(null);
  /** Non nul : le plan sort de la réserve du téléphone, et date de ce moment-là. */
  const [recordedAt, setRecordedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);
  const [past, setPast] = useState<string | null>(null);
  /** La semaine regardée : celle en cours, tant qu'on n'en a pas choisi une autre. */
  const [picked, setPicked] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const read = await getStamped<PlanResponse>(PLAN_URL);
      setData(read.data);
      setRecordedAt(read.recordedAt);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  // Une relecture ratée au retour ne remplace pas le plan déjà lu par une erreur.
  useEffect(() => onForeground(() => void load()), [load]);

  if (error && !data) return <ErrorBox error={error} onRetry={load} />;
  if (!data) return <Loading />;

  if (!data.plan) {
    return (
      <div className="p">
        <header className="p-head">
          <div className="p-eyebrow"><span>Plan</span></div>
          <h1 className="p-title">Aucun plan actif</h1>
          <p className="p-sub">Un plan se construit à partir d&apos;un objectif de course.</p>
        </header>
        <div className="p-empty">
          <Link href="/races" className="btn" data-variant="primary">Définir un objectif</Link>
          <Link href="/coach" className="btn">Demander au coach</Link>
        </div>
      </div>
    );
  }

  // Regroupement calendaire, du lundi au dimanche, depuis la semaine en cours.
  const today = todayIso();
  const monday = weekStartOf(today);
  const byWeek = new Map<string, SessionRow[]>();
  for (const s of data.sessions.filter((x) => x.date >= monday)) {
    const w = weekStartOf(s.date);
    byWeek.set(w, [...(byWeek.get(w) ?? []), s]);
  }
  const weeks = [...byWeek.keys()].sort();
  const weekStart = picked && byWeek.has(picked) ? picked : weeks[0] ?? monday;
  const sessions = byWeek.get(weekStart) ?? [];
  const kept = sessions.filter(held);
  const total = kept.reduce((a, s) => a + s.plannedLoad, 0);
  const totalTime = kept.reduce((a, s) => a + s.plannedDurationS, 0);
  const totalVert = kept.reduce((a, s) => a + (s.plannedElevationGainM ?? 0), 0);
  const days = Array.from({ length: 7 }, (_, i) =>
    new Date(new Date(`${weekStart}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10),
  );
  const alerts = (data.loadRatios?.alerts ?? []).filter((a) => days.includes(a.date));
  const ahead = Math.round((Date.parse(`${weekStart}T00:00:00Z`) - Date.parse(`${monday}T00:00:00Z`)) / (7 * 86_400_000));

  return (
    <div className="p">
      {/* Hors réseau, le plan est celui de la dernière lecture : il le dit d'abord. */}
      {recordedAt && <Stale recordedAt={recordedAt} />}

      <header className="p-head">
        <div className="p-eyebrow">
          <span>Plan</span>
          <Link href="/coach" className="p-adjust">Ajuster avec le coach</Link>
        </div>
        <h1 className="p-title">{weekSpan(weekStart)}</h1>
        <p className="p-sub">{ahead === 0 ? 'Cette semaine' : ahead === 1 ? 'La semaine prochaine' : `Dans ${num(ahead)} semaines`}</p>
      </header>

      {/* Une semaine à la fois : on la choisit, on ne fait pas défiler la saison. */}
      <div className="p-weeks" role="tablist" aria-label="Semaines du plan">
        {weeks.map((w, i) => (
          <button
            key={w}
            type="button"
            role="tab"
            aria-selected={w === weekStart}
            className="p-week"
            onClick={() => { setPicked(w); setOpen(null); }}
          >
            {frDate(w)}
          </button>
        ))}
      </div>

      {/* Ce qui demande une action ou change le plan ; rien d'autre ne s'affiche en bandeau. */}
      {data.raceDay?.notice && <p className="p-notice">{data.raceDay.notice}</p>}
      {data.absences.filter((a) => a.endDate >= weekStart && a.startDate <= days[6]!).map((a) => (
        <AbsenceNotice key={a.id} absence={a} today={today} />
      ))}
      <GarminProblems overview={data.garmin} className="garmin-note" />

      <div className="p-body">
        <section className="p-overview" aria-label="La semaine en chiffres">
          <Figures
            items={[
              // Ce que vaut la charge se lit d'un toucher sur le mot : pas une ligne de plus sous le chiffre.
              { label: <Term k="points">Charge</Term>, value: num(total) },
              { label: 'Durée', value: duration(totalTime) },
              { label: 'Dénivelé', value: `${num(totalVert)} m` },
            ]}
          />
          <WeekBars days={days} sessions={sessions} today={today} alerts={alerts} />
          <RatioAlerts alerts={alerts} source={data.loadRatios?.source ?? null} withDay />
        </section>

        <ol className="p-days" aria-label="Les séances de la semaine">
          {days.map((date) => {
            const daily = sessions.filter((s) => s.date === date && s.type !== 'rest');
            const completed = data.completedByDate[date];
            const alerted = alerts.some((a) => a.date === date);
            if (daily.length === 0) {
              return (
                <li key={date} className="p-day" data-rest>
                  <DayDate date={date} today={today} alerted={alerted} />
                  <span className="p-day-body">
                    <span className="p-day-title">Repos</span>
                    {completed && (
                      <Link href={`/activities/${completed.id}`} className="p-day-meta p-day-link" transitionTypes={['nav-forward']}>
                        {completed.name} →
                      </Link>
                    )}
                  </span>
                </li>
              );
            }
            return daily.map((s, k) => {
              const off = s.status === 'withdrawn' || s.status === 'cancelled';
              const gain = Math.round(s.plannedElevationGainM ?? 0);
              const body = (
                <>
                  {k === 0 ? <DayDate date={date} today={today} alerted={alerted} /> : <span className="p-day-date" aria-hidden />}
                  <span className="p-day-body">
                    <span className="p-day-title">{planName(s)}</span>
                    <span className="p-day-meta">
                      {duration(s.plannedDurationS)}{gain > 0 ? ` · ${num(gain)} m D+` : ''}
                      {s.plannedDate ? ` · prévue le ${frDate(s.plannedDate)}` : ''}
                    </span>
                  </span>
                  <span className="p-day-mark" data-status={date === today && s.status === 'planned' ? 'today' : s.status}>
                    {STATUS_MARK[date === today && s.status === 'planned' ? 'today' : s.status] ?? ''}
                  </span>
                </>
              );
              // Une séance de renforcement s'ouvre en entier (`/seance`) ; une course se déplie ici.
              return isWorkout(s) && !off ? (
                <li key={s.id} className="p-day">
                  <Link href={`/seance?d=${s.date}`} className="p-day-row" transitionTypes={['nav-forward']}>{body}</Link>
                </li>
              ) : (
                <li key={s.id} className="p-day" data-off={off}>
                  <button type="button" className="p-day-row" aria-expanded={open === s.id} onClick={() => setOpen(open === s.id ? null : s.id)}>
                    {body}
                  </button>
                  {open === s.id && <RunDetail s={s} past={past} setPast={setPast} onReload={load} />}
                </li>
              );
            });
          })}
        </ol>
      </div>
    </div>
  );
}

/** « 19 au 25 octobre », « 26 octobre au 1er novembre ». */
function weekSpan(monday: string): string {
  const sunday = new Date(Date.parse(`${monday}T00:00:00Z`) + 6 * 86_400_000).toISOString().slice(0, 10);
  const [, m1] = monday.split('-');
  const [, m2] = sunday.split('-');
  // Le premier du mois s'écrit « 1er ».
  const first = (t: string) => t.replace(/^1(\s)/, '1er$1');
  const a = first(frDate(monday, { long: true }));
  const b = first(frDate(sunday, { long: true }));
  // « au », pas un tiret : en Bodoni, tous les tirets ne sont qu'un filet.
  return m1 === m2 ? `${a.replace(/\s\D+$/, '')}\u00a0au ${b}` : `${a} au ${b}`;
}

/** Ce qu'une séance est devenue, en un mot, à droite de sa ligne. Prévue : rien. */
const STATUS_MARK: Partial<Record<SessionRow['status'] | 'today', string>> = {
  today: 'Aujourd’hui',
  completed: 'Faite',
  replaced: 'Remplacée',
  partial: 'Partielle',
  missed: 'Manquée',
  withdrawn: 'Retirée',
  cancelled: 'Annulée',
};

function DayDate({ date, today, alerted }: { date: string; today: string; alerted: boolean }) {
  const dow = new Date(`${date}T00:00:00Z`).getUTCDay();
  return (
    <span className="p-day-date" data-today={date === today}>
      <span className="p-day-dow">{DOW_LONG[(dow + 6) % 7]}</span>
      <span className="p-day-num">
        {Number(date.slice(8, 10))}
        {alerted && <span className="p-day-alert" aria-label="ratio de charge au-delà du seuil" />}
      </span>
    </span>
  );
}

/** Une course dépliée sous sa ligne : ses blocs, sa carte, son pourquoi. */
function RunDetail({
  s, past, setPast, onReload,
}: { s: SessionRow; past: string | null; setPast: (id: string | null) => void; onReload: () => void }) {
  const load = onReload;
  return (
    <div className="p-detail">
      <div className="row-between" style={{ marginBottom: 8 }}>
        <strong>{s.title}</strong>
        <Badge tone={s.priority === 'key' ? 'good' : undefined}>{s.priority === 'key' ? 'séance clef' : s.priority === 'support' ? 'soutien' : 'facultative'}</Badge>
      </div>
      <div className="small faint" style={{ marginBottom: 8 }}>
        {num(s.plannedLoad)} <Term k="points">points de charge</Term>
        {s.plannedMechanicalLoad > 0 && (
          <> · {num(s.plannedMechanicalLoad)} de <Term k="mecanique">charge mécanique</Term></>
        )}
      </div>
      <p className="small muted" style={{ marginTop: 0 }}>{s.intent}</p>
      <GarminLine status={s.garmin} />

      {s.blocks.some((b) => b.circuit) && (
        <div className="tiny faint" style={{ marginTop: 6 }}>
          Une part de ces {num(s.plannedMechanicalLoad)} points de charge mécanique vient du renforcement excentrique :
          aucun flux d’activité ne le porte, le réalisé mesuré y affichera 0.
        </div>
      )}

      {s.successCriteria?.map((c, i) => (
        <div
          key={i}
          className="small"
          style={{
            marginTop: 8, padding: '8px 10px', borderRadius: 6,
            background: 'color-mix(in srgb, var(--good) 8%, transparent)',
            borderLeft: '2px solid var(--good)',
          }}
        >
          <strong>Réussite :</strong> {CRITERION_LABELS[c.metric] ?? c.metric}
          {c.maxValue != null && ` ≤ ${num(c.maxValue)}`}
          <div className="tiny faint" style={{ marginTop: 3 }}>« {c.origin.quote} » — {originLabel(c.origin)}</div>
        </div>
      ))}

      <div style={{ marginTop: 12 }}>
        <SessionMap blocks={s.blocks} route={s.route} />
      </div>
      {s.route && (
        <div style={{ marginTop: 12 }}>
          <Itinerary route={s.route} date={s.date} title={s.title} onHomeSaved={load} />
        </div>
      )}

      <div className="stack" style={{ gap: 8, marginTop: 12 }}>
        {s.blocks.map((b, i) => (
          <div key={i} style={{ borderLeft: '2px solid var(--border-strong)', paddingLeft: 10 }}>
            <div className="row wrap" style={{ gap: 8 }}>
              <strong className="small">
                {b.repeat ? `${num(b.repeat)} × ` : ''}
                {b.reps ? `${num(b.reps)}` : blockDuration(b.durationS)}
                {b.distanceM ? ` ${num(b.distanceM)} m` : ''}
              </strong>
              <span className="small muted">{b.label}</span>
              {b.exercise && (
                <Link href={`/exercices#${b.exercise}`} className="tiny">comment faire</Link>
              )}
              {/* Un bloc piloté à l'effort n'a pas de zone à tenir. */}
              {/* Une zone ne dit rien d'un bloc qui ne se court pas : souplesse, respiration. */}
              {!b.effort && !b.kind && <Badge>{b.zone}</Badge>}
              {b.hrRange && (
                <span className="tiny mono faint">
                  {b.hrRange[0] > 0 ? `${num(b.hrRange[0])}-${num(b.hrRange[1])}` : `< ${num(b.hrRange[1])}`} bpm
                </span>
              )}
              {/* Sur un sentier, la FC guide : pas d'allure à plat à suivre. */}
              {b.paceRange && followsPace(b) && (
                <span className="tiny mono faint">
                  {b.paceRange[1] === '—' ? `> ${b.paceRange[0]}` : `${b.paceRange[0]}-${b.paceRange[1]}`}/km
                </span>
              )}
              {b.vamTargetMh && <span className="tiny mono faint">{num(b.vamTargetMh)} m D+/h</span>}
              {b.cadenceTargetSpm && <span className="tiny mono faint">{num(b.cadenceTargetSpm)} ppm</span>}
              {/* Une cible qu'on demande de tenir est un paramètre
                  physiologique : elle porte sa provenance, comme la
                  vitesse critique sur l'écran de physiologie. */}
              {provenanceText(b.provenance) && (
                <span className="tiny faint">({provenanceText(b.provenance)})</span>
              )}
              {b.recovery && (
                <span className="tiny faint">
                  {recoveryText(b.recovery)}
                  {b.recovery.paceRange && followsPace(b) &&
                    ` · ${b.recovery.paceRange[1] === '—'
                      ? `> ${b.recovery.paceRange[0]}`
                      : `${b.recovery.paceRange[0]}-${b.recovery.paceRange[1]}`}/km`}
                </span>
              )}
            </div>
            {b.effort && <div className="small" style={{ marginTop: 3 }}>{b.effort}</div>}
            {b.where && (
              <div className="tiny" style={{ marginTop: 3 }}>
                <WhereLine block={b} />
              </div>
            )}
            {b.circuit && (
              <div className="tiny" style={{ marginTop: 3 }}>{circuitText(b.circuit)}</div>
            )}
            {b.notes && <div className="tiny muted" style={{ marginTop: 3 }}>{b.notes}</div>}
          </div>
        ))}
      </div>

      {s.rationale && (
        <div className="tiny faint" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <strong>
            {s.status === 'withdrawn' ? 'Pourquoi retirée :' : s.status === 'cancelled' ? 'Pourquoi annulée :' : 'Pourquoi ici :'}
          </strong>{' '}
          {s.rationale}
        </div>
      )}

      {/* Ce qui a façonné la séance — le raisonnement d'une décision,
          ce que la construction a cédé —, à un geste du « pourquoi ». */}
      {s.history && s.history.length > 0 && (
        <div style={{ marginTop: 10 }}>
          <button
            type="button"
            className="link-button tiny"
            aria-expanded={past === s.id}
            onClick={() => setPast(past === s.id ? null : s.id)}
          >
            {past === s.id ? 'Masquer l’historique' : `Historique (${s.history.length})`}
          </button>
          {past === s.id && (
            <div style={{ marginTop: 8 }}>
              <SessionHistory history={s.history} />
            </div>
          )}
        </div>
      )}

      {/* Une consigne dont on ne peut pas remonter à la source est une
          consigne qu'on demande à l'athlète de croire. */}
      {s.directives && s.directives.length > 0 && (
        <div className="tiny faint" style={{ marginTop: 10, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
          <strong>D'où vient cette forme :</strong>
          <div className="stack" style={{ gap: 6, marginTop: 5 }}>
            {s.directives.map((d, i) => (
              <div key={i}>
                {d.effect}
                <div style={{ opacity: 0.75 }}>« {d.origin.quote} » — {originLabel(d.origin)}</div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
