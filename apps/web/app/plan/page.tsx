'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import {
  blockDuration, duration, frDate, get, num, todayIso,
  type PlanResponse, type SessionRow,
} from '@/lib/api';
import {
  circuitText, CRITERION_LABELS, originLabel, provenanceText, TYPE_COLORS, TYPE_LABELS,
} from '@/lib/sessions';
import { AbsenceNotice, Badge, Card, ErrorBox, Loading } from '@/components/ui';

/**
 * Un TSB se lit signé : « 9 » et « −9 » ne décrivent pas le même athlète. La
 * décimale ne s'écrit que si elle existe — la cible est un entier, ce que le
 * plan en fait ne l'est pas.
 */
const signed = (v: number) => `${v > 0 ? '+' : ''}${num(v, Number.isInteger(v) ? 0 : 1)}`;

/** Le jour de la semaine : une lettre dans la grille, trois dans la liste. */
const DOW_SHORT = ['L', 'M', 'M', 'J', 'V', 'S', 'D'];
const DOW_LONG = ['lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.', 'dim.'];

function weekStartOf(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  const dow = d.getUTCDay();
  return new Date(d.getTime() + (dow === 0 ? -6 : 1 - dow) * 86_400_000).toISOString().slice(0, 10);
}

export default function PlanPage() {
  const [data, setData] = useState<PlanResponse | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setData(await get<PlanResponse>(`/api/plan?from=${weekStartOf(todayIso())}&weeks=8`));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!data) return <Loading />;

  if (!data.plan) {
    return (
      <>
        <div className="page-head"><h1 className="page-title">Plan</h1></div>
        <Card>
          <div className="empty">
            <p>Aucun plan actif.</p>
            <p className="small">
              Un plan se construit à partir d'un objectif de course : il définit les phases,
              la progression de charge, le dénivelé hebdomadaire et l'affûtage.
            </p>
            <div className="row" style={{ justifyContent: 'center', marginTop: 14 }}>
              <Link href="/races" className="btn" data-variant="primary">Définir un objectif</Link>
              <Link href="/coach" className="btn">Demander au coach</Link>
            </div>
          </div>
        </Card>
      </>
    );
  }

  // Regroupement calendaire, du lundi au dimanche.
  const byWeek = new Map<string, SessionRow[]>();
  for (const s of data.sessions) {
    const w = weekStartOf(s.date);
    byWeek.set(w, [...(byWeek.get(w) ?? []), s]);
  }
  const weeks = [...byWeek.entries()].sort(([a], [b]) => a.localeCompare(b));
  const today = todayIso();

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Plan d'entraînement</h1>
          <p className="page-sub">
            TSB visé le jour de la course : {signed(data.plan.targetRaceDayTsb)}
            {/* La cible seule est une intention. Ce que le plan en fait se mesure. */}
            {data.plan.projectedRaceDayTsb != null && (
              <> · le plan y amène {signed(data.plan.projectedRaceDayTsb)}</>
            )}
            {' · '}{num(data.sessions.length)} séances sur {num(weeks.length)} semaines
          </p>
        </div>
        <Link href="/coach" className="btn">Ajuster avec le coach</Link>
      </div>

      {data.plan.raceDayTsbShortfall && (
        <div className="banner" data-tone="warn" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 9 }}>
          <strong>
            La cible d’affûtage n’est pas atteinte
            {data.plan.projectedRaceDayTsb != null && (
              <> : {signed(data.plan.projectedRaceDayTsb)} au lieu de {signed(data.plan.targetRaceDayTsb)}</>
            )}
          </strong>
          <p className="tiny faint" style={{ margin: 0 }}>{data.plan.raceDayTsbShortfall}</p>
        </div>
      )}

      {data.absences.map((a) => (
        <AbsenceNotice key={a.id} absence={a} today={today} />
      ))}

      <div className="stack">
        {weeks.map(([weekStart, sessions]) => {
          // Une séance retirée ne pèse plus rien : la compter dans le total de la
          // semaine ferait lire une charge que personne n'attend plus.
          const held = sessions.filter((s) => s.status !== 'withdrawn');
          const total = held.reduce((a, s) => a + s.plannedLoad, 0);
          const totalTime = held.reduce((a, s) => a + s.plannedDurationS, 0);
          const totalVert = held.reduce((a, s) => a + (s.plannedElevationGainM ?? 0), 0);
          const isCurrent = weekStart === weekStartOf(today);
          const days = Array.from({ length: 7 }, (_, i) =>
            new Date(new Date(`${weekStart}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10),
          );

          return (
            <Card
              key={weekStart}
              style={isCurrent ? { borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' } : undefined}
              title={`Semaine du ${frDate(weekStart, { long: true })}`}
              hint={`${num(total)} points · ${duration(totalTime)} · ${num(totalVert)} m D+`}
              action={isCurrent ? <Badge tone="good">en cours</Badge> : undefined}
            >
              <div className="plan-week">
                {days.map((date, i) => {
                  const daily = sessions.filter((s) => s.date === date);
                  const completed = data.completedByDate[date];
                  return (
                    <div key={date} className="plan-day" data-today={date === today}>
                      <div className="plan-date">
                        <span className="plan-dow-short">{DOW_SHORT[i]}</span>
                        <span className="plan-dow-long">{DOW_LONG[i]}</span> {date.slice(8, 10)}
                      </div>
                      <div className="plan-slots">
                        {daily.length === 0 && <div className="plan-figures">—</div>}
                        {daily.map((s) => (
                          <button
                            key={s.id}
                            className="plan-slot"
                            onClick={() => setOpen(open === s.id ? null : s.id)}
                          >
                            <div
                              className="plan-session"
                              data-faded={s.status === 'missed' || s.status === 'withdrawn'}
                              style={{ borderLeftColor: TYPE_COLORS[s.type] ?? 'var(--border-strong)' }}
                            >
                              <div className="plan-name">{TYPE_LABELS[s.type] ?? s.type}</div>
                              {s.type !== 'rest' && (
                                <div className="plan-figures">
                                  {duration(s.plannedDurationS)} · {num(s.plannedLoad)}
                                </div>
                              )}
                              {s.status === 'completed' && <span className="plan-status" data-tone="done">✓ faite</span>}
                              {s.status === 'replaced' && <span className="plan-status" data-tone="off">remplacée</span>}
                              {s.status === 'missed' && <span className="plan-status" data-tone="off">manquée</span>}
                              {/* Retirée, pas manquée : elle tombait dans une absence qu'il avait
                                  annoncée. Le ton neutre est le fond de l'affaire. */}
                              {s.status === 'withdrawn' && <span className="plan-status" data-tone="mute">retirée</span>}
                            </div>
                          </button>
                        ))}
                        {completed && !daily.some((s) => s.completedActivityId === completed.id) && (
                          <Link href={`/activities/${completed.id}`} className="plan-done-link">
                            ↗ séance faite
                          </Link>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>

              {sessions.filter((s) => s.id === open).map((s) => (
                <div key={s.id} style={{ marginTop: 14, padding: 14, background: 'var(--bg-inset)', borderRadius: 8, border: '1px solid var(--border)' }}>
                  <div className="row-between" style={{ marginBottom: 8 }}>
                    <strong>{s.title}</strong>
                    <div className="row" style={{ gap: 6 }}>
                      <Badge tone={s.priority === 'key' ? 'good' : undefined}>{s.priority === 'key' ? 'séance clef' : s.priority === 'support' ? 'soutien' : 'facultative'}</Badge>
                      <Badge tone="metabolic">{num(s.plannedLoad)} pts</Badge>
                      {s.plannedMechanicalLoad > 0 && <Badge tone="mechanical">{num(s.plannedMechanicalLoad)} méca</Badge>}
                    </div>
                  </div>
                  <p className="small muted" style={{ marginTop: 0 }}>{s.intent}</p>

                  {s.blocks.some((b) => b.circuit) && (
                    <div className="tiny faint" style={{ marginTop: 6 }}>
                      Une part de ces {num(s.plannedMechanicalLoad)} points méca vient du renforcement excentrique :
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

                  <div className="stack" style={{ gap: 8, marginTop: 12 }}>
                    {s.blocks.map((b, i) => (
                      <div key={i} style={{ borderLeft: '2px solid var(--border-strong)', paddingLeft: 10 }}>
                        <div className="row wrap" style={{ gap: 8 }}>
                          <strong className="small">
                            {b.repeat ? `${num(b.repeat)} × ` : ''}
                            {blockDuration(b.durationS)}
                            {b.distanceM ? ` ${num(b.distanceM)} m` : ''}
                          </strong>
                          <span className="small muted">{b.label}</span>
                          <Badge>{b.zone}</Badge>
                          {b.hrRange && (
                            <span className="tiny mono faint">
                              {b.hrRange[0] > 0 ? `${num(b.hrRange[0])}-${num(b.hrRange[1])}` : `< ${num(b.hrRange[1])}`} bpm
                            </span>
                          )}
                          {b.paceRange && (
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
                              récup {blockDuration(b.recovery.durationS)} {b.recovery.active ? 'active' : 'passive'}
                              {b.recovery.paceRange &&
                                ` · ${b.recovery.paceRange[1] === '—'
                                  ? `> ${b.recovery.paceRange[0]}`
                                  : `${b.recovery.paceRange[0]}-${b.recovery.paceRange[1]}`}/km`}
                            </span>
                          )}
                        </div>
                        {b.circuit && (
                          <div className="tiny" style={{ marginTop: 3 }}>{circuitText(b.circuit)}</div>
                        )}
                        {b.notes && <div className="tiny muted" style={{ marginTop: 3 }}>{b.notes}</div>}
                      </div>
                    ))}
                  </div>

                  {s.rationale && (
                    <div className="tiny faint" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                      <strong>{s.status === 'withdrawn' ? 'Pourquoi retirée :' : 'Pourquoi ici :'}</strong>{' '}
                      {s.rationale}
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
              ))}
            </Card>
          );
        })}
      </div>

      {data.plan.revisionLog?.length > 0 && (
        <Card title="Journal des révisions" hint="Toute modification du plan est tracée." style={{ marginTop: 14 }}>
          <div className="stack" style={{ gap: 8 }}>
            {data.plan.revisionLog.slice(-6).reverse().map((r, i) => (
              <div key={i} className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
                <span className="tiny mono faint" style={{ width: 88, flex: 'none' }}>{frDate(r.at)}</span>
                <span className="small muted">{r.summary}</span>
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
