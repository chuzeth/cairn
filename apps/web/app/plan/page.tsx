'use client';
import { useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { blockDuration, duration, frDate, get, todayIso, type PlanResponse, type SessionRow } from '@/lib/api';
import { Badge, Card, ErrorBox, Loading } from '@/components/ui';

const TYPE_LABELS: Record<string, string> = {
  recovery: 'Récupération', endurance: 'Endurance', long_run: 'Sortie longue',
  long_trail: 'Rando-course', tempo: 'Tempo', threshold: 'Seuil', vo2max: 'PMA',
  hill_repeats: 'Côtes', downhill: 'Descente', fartlek: 'Fartlek',
  race_pace: 'Allure course', strength: 'Renforcement', mobility: 'Mobilité',
  cross_training: 'Cross-training', race: 'Course', rest: 'Repos',
};

const TYPE_COLORS: Record<string, string> = {
  recovery: 'var(--z1)', endurance: 'var(--z2)', long_run: 'var(--z2)', long_trail: 'var(--accent)',
  tempo: 'var(--z3)', threshold: 'var(--z4)', vo2max: 'var(--z5)', hill_repeats: 'var(--z4)',
  downhill: 'var(--mechanical)', race_pace: 'var(--z3)', strength: 'var(--text-faint)',
  race: 'var(--good)', rest: 'var(--border-strong)',
};

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
            TSB visé le jour de la course : {data.plan.targetRaceDayTsb > 0 ? '+' : ''}{data.plan.targetRaceDayTsb}
            {' · '}{data.sessions.length} séances sur {weeks.length} semaines
          </p>
        </div>
        <Link href="/coach" className="btn">Ajuster avec le coach</Link>
      </div>

      <div className="stack">
        {weeks.map(([weekStart, sessions]) => {
          const total = sessions.reduce((a, s) => a + s.plannedLoad, 0);
          const totalTime = sessions.reduce((a, s) => a + s.plannedDurationS, 0);
          const totalVert = sessions.reduce((a, s) => a + (s.plannedElevationGainM ?? 0), 0);
          const isCurrent = weekStart === weekStartOf(today);
          const days = Array.from({ length: 7 }, (_, i) =>
            new Date(new Date(`${weekStart}T00:00:00Z`).getTime() + i * 86_400_000).toISOString().slice(0, 10),
          );

          return (
            <Card
              key={weekStart}
              style={isCurrent ? { borderColor: 'color-mix(in srgb, var(--accent) 35%, transparent)' } : undefined}
              title={`Semaine du ${frDate(weekStart)}`}
              hint={`${Math.round(total)} points · ${duration(totalTime)} · ${Math.round(totalVert)} m D+`}
              action={isCurrent ? <Badge tone="good">en cours</Badge> : undefined}
            >
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(7, minmax(0,1fr))', gap: 8 }}>
                {days.map((date) => {
                  const daily = sessions.filter((s) => s.date === date);
                  const completed = data.completedByDate[date];
                  const isToday = date === today;
                  return (
                    <div
                      key={date}
                      style={{
                        background: isToday ? 'var(--bg-elev-2)' : 'var(--bg-inset)',
                        border: `1px solid ${isToday ? 'var(--accent)' : 'var(--border)'}`,
                        borderRadius: 8, padding: 9, minHeight: 108,
                        display: 'flex', flexDirection: 'column', gap: 6,
                      }}
                    >
                      <div className="tiny faint" style={{ fontWeight: 600 }}>
                        {['L', 'M', 'M', 'J', 'V', 'S', 'D'][days.indexOf(date)]} {date.slice(8, 10)}
                      </div>
                      {daily.length === 0 && <div className="tiny faint">—</div>}
                      {daily.map((s) => (
                        <button
                          key={s.id}
                          onClick={() => setOpen(open === s.id ? null : s.id)}
                          style={{
                            textAlign: 'left', border: 'none', cursor: 'pointer', padding: 0,
                            background: 'transparent', color: 'inherit', width: '100%',
                          }}
                        >
                          <div style={{
                            borderLeft: `2.5px solid ${TYPE_COLORS[s.type] ?? 'var(--border-strong)'}`,
                            paddingLeft: 6,
                            opacity: s.status === 'missed' ? 0.45 : 1,
                          }}>
                            <div className="tiny" style={{ fontWeight: 600, lineHeight: 1.25 }}>
                              {TYPE_LABELS[s.type] ?? s.type}
                            </div>
                            {s.type !== 'rest' && (
                              <div className="tiny faint mono">
                                {duration(s.plannedDurationS)} · {s.plannedLoad}
                              </div>
                            )}
                            {s.status === 'completed' && <span className="tiny" style={{ color: 'var(--good)' }}>✓ faite</span>}
                            {s.status === 'missed' && <span className="tiny" style={{ color: 'var(--warn)' }}>manquée</span>}
                          </div>
                        </button>
                      ))}
                      {completed && !daily.some((s) => s.status === 'completed') && (
                        <Link href={`/activities/${completed.id}`} className="tiny" style={{ color: 'var(--metabolic)' }}>
                          ↗ séance faite
                        </Link>
                      )}
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
                      <Badge tone="metabolic">{s.plannedLoad} pts</Badge>
                      {s.plannedMechanicalLoad > 10 && <Badge tone="mechanical">{s.plannedMechanicalLoad} méca</Badge>}
                    </div>
                  </div>
                  <p className="small muted" style={{ marginTop: 0 }}>{s.intent}</p>

                  <div className="stack" style={{ gap: 8, marginTop: 12 }}>
                    {s.blocks.map((b, i) => (
                      <div key={i} style={{ borderLeft: '2px solid var(--border-strong)', paddingLeft: 10 }}>
                        <div className="row wrap" style={{ gap: 8 }}>
                          <strong className="small">
                            {b.repeat ? `${b.repeat} × ` : ''}
                            {blockDuration(b.durationS)}
                            {b.distanceM ? ` ${b.distanceM} m` : ''}
                          </strong>
                          <span className="small muted">{b.label}</span>
                          <Badge>{b.zone}</Badge>
                          {b.hrRange && (
                            <span className="tiny mono faint">
                              {b.hrRange[0] > 0 ? `${b.hrRange[0]}-${b.hrRange[1]}` : `< ${b.hrRange[1]}`} bpm
                            </span>
                          )}
                          {b.paceRange && (
                            <span className="tiny mono faint">
                              {b.paceRange[1] === '—' ? `> ${b.paceRange[0]}` : `${b.paceRange[0]}-${b.paceRange[1]}`}/km
                            </span>
                          )}
                          {b.vamTargetMh && <span className="tiny mono faint">{b.vamTargetMh} m D+/h</span>}
                          {b.cadenceTargetSpm && <span className="tiny mono faint">{b.cadenceTargetSpm} ppm</span>}
                          {b.recovery && (
                            <span className="tiny faint">
                              récup {blockDuration(b.recovery.durationS)} {b.recovery.active ? 'active' : 'passive'}
                            </span>
                          )}
                        </div>
                        {b.notes && <div className="tiny muted" style={{ marginTop: 3 }}>{b.notes}</div>}
                      </div>
                    ))}
                  </div>

                  {s.rationale && (
                    <div className="tiny faint" style={{ marginTop: 12, paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                      <strong>Pourquoi ici :</strong> {s.rationale}
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
