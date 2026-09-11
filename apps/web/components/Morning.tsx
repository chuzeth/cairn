'use client';
import { useState } from 'react';
import Link from 'next/link';
import {
  blockDuration, duration, frDate, markdown, nbsp, post, signed,
  type CheckInResult, type DeclaredAbsence, type PlanResponse, type SessionRow, type StateResponse,
} from '@/lib/api';
import { QUESTIONS } from '@/lib/checkin';
import { CRITERION_LABELS, TYPE_COLORS, TYPE_LABELS, circuitText, originLabel } from '@/lib/sessions';
import { ABSENCE_KIND_LABEL, Badge, MISSING_LABEL, ReadinessBasis, unweighed } from '@/components/ui';

/**
 * Le chemin du matin.
 *
 * Trois questions, dans cet ordre : qu'est-ce que je fais aujourd'hui, est-ce
 * que le système a une réserve là-dessus, et seulement ensuite les chiffres.
 * Un tableau de bord répond à la troisième en premier — c'est le bon ordre le
 * soir, devant un grand écran, quand on cherche à comprendre. À sept heures du
 * matin, il fait lire quatre courbes à quelqu'un qui veut savoir s'il enfile ses
 * chaussures.
 *
 * Rien ici ne décide : la disponibilité, sa recommandation et les réajustements
 * viennent des règles de `@cairn/coach`. Cet écran les dit, et dit d'où ils
 * viennent.
 */

const answeredStatus = (s: SessionRow) => s.status === 'completed' || s.status === 'replaced';

/** « Demain » n'est vrai qu'un jour sur deux : un repos intercalé le rend faux. */
const isTomorrow = (date: string, today: string) =>
  date === new Date(new Date(`${today}T12:00:00Z`).getTime() + 86_400_000).toISOString().slice(0, 10);

/**
 * Au réveil, « 38 min 46 s » est une précision dont personne ne fait rien. Sur
 * un bloc répété, la seconde est au contraire la consigne : « 8 × 90 s » ne se
 * dit pas « 8 × 2 min ».
 */
const blockTime = (b: SessionRow['blocks'][number]) =>
  b.repeat ? blockDuration(b.durationS) : duration(b.durationS);

/**
 * Le libellé d'un bloc porte parfois sa durée nominale — « Activation (10 min) ».
 * La durée réelle est à sa gauche, et elle peut différer : un palier de reprise
 * raccourcit le bloc sans réécrire son nom. Deux nombres pour la même chose, et
 * c'est le mauvais qu'on lit. On garde celui qui vient de la structure.
 */
const blockLabel = (label: string) => label.replace(/\s*\((?:\d+\s*(?:min|s|h))\)\s*$/, '');

/**
 * La première phrase de l'intention suffit à ouvrir la journée ; le paragraphe
 * entier se lit sous « Pourquoi cette séance », pour qui veut la lire.
 */
const firstSentence = (text: string) => /^.*?[.!?](?=\s|$)/.exec(text.trim())?.[0] ?? text;

export function Morning({
  state, plan, stravaConnected, onReload, onFileNote, filing,
}: {
  state: StateResponse;
  plan: PlanResponse;
  stravaConnected: boolean;
  onReload: () => Promise<void> | void;
  onFileNote: (date: string) => void;
  filing: string | null;
}) {
  const today = state.today.date;
  const held = plan.sessions.filter(
    (s) => s.date === today && s.status !== 'withdrawn' && s.status !== 'cancelled',
  );
  // Une journée peut porter une séance et un repos ; c'est la séance qu'on ouvre.
  const session = held.find((s) => s.type !== 'rest') ?? held[0];
  const absence = state.absences.find((a) => a.startDate <= today && a.endDate >= today);
  const doneToday = plan.completedByDate[today];
  const next = plan.sessions.find(
    (s) => s.date > today && s.type !== 'rest' && s.status !== 'withdrawn' && s.status !== 'cancelled',
  );
  // Un repos n'a pas de blocs : il n'y a rien à détailler, la phrase suffit.
  const done = session != null && answeredStatus(session);
  const work = session && session.blocks.length > 0 && !done ? session : undefined;
  // Sans effort aujourd'hui, c'est le prochain qu'on ouvre — sauf le jour où la
  // séance est déjà faite, où il n'y a plus rien à préparer.
  const openNext = !work && !done ? next : undefined;

  return (
    <div className="morning">
      <header className="morning-head">
        <div className="morning-date">{frDate(today, { weekday: true })}</div>
        <Headline session={session} absence={absence} done={doneToday} />
      </header>

      <Availability state={state} onReload={onReload} />

      {work && <SessionCard session={work} />}

      {done && doneToday && (
        <Link href={`/activities/${doneToday.id}`} className="card morning-done">
          <span>{doneToday.name}</span>
          <span className="tiny faint">l&apos;analyse →</span>
        </Link>
      )}

      {!work && absence && <AbsenceCard absence={absence} />}

      {openNext && (
        <>
          <div className="morning-label">
            {absence ? 'Ta reprise' : 'Prochaine séance'} · {frDate(openNext.date, { weekday: true })}
          </div>
          <SessionCard session={openNext} />
        </>
      )}

      {state.pendingNotes.map((n) => (
        <section className="card morning-note" key={n.date}>
          <h2 className="card-title">Tu as écrit ça, et rien n&apos;en a été fait.</h2>
          <div className="tiny faint" style={{ margin: '2px 0 8px' }}>{frDate(n.date, { weekday: true })}</div>
          <blockquote className="note-quote">{n.notes}</blockquote>
          <div className="row wrap" style={{ gap: 8, marginTop: 10 }}>
            <Link href="/coach" className="btn" data-variant="primary">En parler au coach</Link>
            <button className="btn" onClick={() => onFileNote(n.date)} disabled={filing === n.date}>
              {filing === n.date ? <><span className="spinner" /> …</> : 'Classer sans suite'}
            </button>
          </div>
        </section>
      ))}

      <Figures state={state} />

      {next && !openNext && (
        <p className="morning-after">
          {isTomorrow(next.date, today) ? 'Demain' : 'Ensuite'}, {frDate(next.date, { weekday: true })}{' '}
          : {TYPE_LABELS[next.type] ?? next.type}
          {next.plannedDurationS > 0 && <> · {duration(next.plannedDurationS)}</>}.
        </p>
      )}

      {!stravaConnected && (
        <p className="morning-after">
          Strava n&apos;est pas connecté : ces chiffres ne bougeront plus tant qu&apos;il ne l&apos;est
          pas. La connexion se fait depuis l&apos;ordinateur.
        </p>
      )}
    </div>
  );
}

/** La réponse à « qu'est-ce que je fais aujourd'hui », en une phrase. */
function Headline({
  session, absence, done,
}: { session?: SessionRow; absence?: DeclaredAbsence; done?: { id: string; name: string } }) {
  if (session && answeredStatus(session)) {
    return (
      <>
        <h1 className="morning-title">C&apos;est fait.</h1>
        <p className="morning-lede">
          {session.status === 'replaced'
            ? 'Pas la séance prévue, mais elle est faite et elle compte.'
            : 'Séance du jour faite et rattachée au plan.'}
        </p>
      </>
    );
  }
  if (session && session.type === 'rest') {
    return (
      <>
        <h1 className="morning-title">Repos complet.</h1>
        <p className="morning-lede">{nbsp(firstSentence(session.intent))}</p>
      </>
    );
  }
  if (session) {
    return (
      <>
        <h1 className="morning-title">
          {TYPE_LABELS[session.type] ?? session.type}, {duration(session.plannedDurationS)}.
        </h1>
        <p className="morning-lede">{nbsp(firstSentence(session.intent))}</p>
      </>
    );
  }
  if (absence) {
    return (
      <>
        <h1 className="morning-title">Rien aujourd&apos;hui.</h1>
        <p className="morning-lede">
          {ABSENCE_KIND_LABEL[absence.kind]} déclarée jusqu&apos;au {frDate(absence.endDate, { weekday: true })}
          {absence.source === 'athlete' ? ', par toi.' : '.'}
        </p>
      </>
    );
  }
  if (done) {
    return (
      <>
        <h1 className="morning-title">C&apos;est fait.</h1>
        <p className="morning-lede">Rien n&apos;était prévu aujourd&apos;hui, et tu as couru quand même.</p>
      </>
    );
  }
  return (
    <>
      <h1 className="morning-title">Rien au programme.</h1>
      <p className="morning-lede">
        Aucune séance n&apos;est prévue aujourd&apos;hui. <Link href="/coach" className="morning-inline">Demande au coach</Link> si
        ça te surprend.
      </p>
    </>
  );
}

/** La séance, bloc par bloc, avec ses cibles — de quoi la faire sans rien ouvrir d'autre. */
function SessionCard({ session }: { session: SessionRow }) {
  const [why, setWhy] = useState(false);
  const color = TYPE_COLORS[session.type] ?? 'var(--border-strong)';
  return (
    <section className="card session-card" style={{ borderLeft: `3px solid ${color}` }}>
      <div className="session-blocks">
        {session.blocks.map((b, i) => (
          <div className="block" key={i}>
            <div className="block-time mono">
              {b.repeat ? <span className="block-repeat">{b.repeat} ×</span> : null}
              {blockTime(b)}
            </div>
            <div className="block-body">
              <div className="block-label">
                {blockLabel(b.label)}
                {b.distanceM ? <span className="faint"> · {b.distanceM} m</span> : null}
              </div>
              <div className="block-targets tiny mono">
                <span className="block-zone" data-zone={b.zone}>{b.zone}</span>
                {b.hrRange && (
                  <span>{b.hrRange[0] > 0 ? `${b.hrRange[0]}–${b.hrRange[1]}` : `< ${b.hrRange[1]}`} bpm</span>
                )}
                {b.paceRange && (
                  <span>{b.paceRange[1] === '—' ? `> ${b.paceRange[0]}` : `${b.paceRange[0]}–${b.paceRange[1]}`}/km</span>
                )}
                {b.vamTargetMh ? <span>{b.vamTargetMh} m D+/h</span> : null}
                {b.cadenceTargetSpm ? <span>{b.cadenceTargetSpm} ppm</span> : null}
                {b.recovery && (
                  <span className="faint">
                    récup {blockDuration(b.recovery.durationS)} {b.recovery.active ? 'active' : 'passive'}
                  </span>
                )}
              </div>
              {b.circuit && <div className="block-note">{nbsp(circuitText(b.circuit))}</div>}
              {b.notes && <div className="block-note">{nbsp(b.notes)}</div>}
            </div>
          </div>
        ))}
      </div>

      {session.successCriteria?.map((c, i) => (
        <p className="session-success" key={i}>
          <strong>Réussie si</strong> {CRITERION_LABELS[c.metric] ?? c.metric}
          {c.maxValue != null && ` ≤ ${c.maxValue}`}.
        </p>
      ))}

      <div className="session-foot">
        <span className="tiny mono faint">
          {session.plannedLoad} pts
          {session.plannedMechanicalLoad > 0 && ` · ${session.plannedMechanicalLoad} méca`}
          {session.plannedElevationGainM ? ` · ${Math.round(session.plannedElevationGainM)} m D+` : ''}
        </span>
        {(session.intent || session.rationale || session.directives?.length) && (
          <button type="button" className="disclose" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
            {why ? 'Masquer' : 'Pourquoi cette séance'}
          </button>
        )}
      </div>

      {why && (
        <div className="session-why tiny">
          {session.intent && <p>{nbsp(session.intent)}</p>}
          {session.rationale && <p>{nbsp(session.rationale)}</p>}
          {/* Une consigne dont on ne peut pas remonter à la source est une
              consigne qu'on demande à l'athlète de croire. */}
          {session.directives?.map((d, i) => (
            <p key={i}>
              {d.effect}
              <span className="faint"> « {d.origin.quote} » — {originLabel(d.origin)}</span>
            </p>
          ))}
          {session.successCriteria?.map((c, i) => (
            <p key={i} className="faint">« {c.origin.quote} » — {originLabel(c.origin)}</p>
          ))}
        </div>
      )}
    </section>
  );
}

/** L'absence en cours, dans les mots de l'athlète. */
function AbsenceCard({ absence }: { absence: DeclaredAbsence }) {
  const n = absence.withdrawnSessions;
  const plural = (n ?? 0) > 1 ? 's' : '';
  return (
    <section className="card">
      <blockquote className="note-quote">{absence.reason}</blockquote>
      <p className="tiny faint" style={{ margin: '10px 0 0' }}>
        {n == null ? '' : n > 0 ? `${n} séance${plural} retirée${plural} du plan : ni à faire, ni manquée${plural}. ` : ''}
        Ta charge chronique baisse sur cette période : c&apos;est mesuré, et c&apos;était prévu.
      </p>
    </section>
  );
}

/**
 * La réserve du jour — et le geste qui la met à jour.
 *
 * Une seule question posée ici, la première : au réveil, ce qui compte est que
 * le ressenti cesse de peser zéro. Le reste du point se remplit sur /point, et
 * s'ajoute à cette réponse au lieu de l'écraser.
 */
function Availability({ state, onReload }: { state: StateResponse; onReload: () => Promise<void> | void }) {
  const [before] = useState(state.readiness);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const readiness = result?.readiness ?? state.readiness;
  const question = QUESTIONS[0];
  const answer = result?.checkIn?.fatigue ?? state.checkIn?.fatigue ?? null;
  const missing = unweighed(readiness).map((k) => MISSING_LABEL[k]);
  const delta = readiness.score - before.score;
  const verdict = readiness.verdict === 'green' ? 'Feu vert' : readiness.verdict === 'amber' ? 'Vigilance' : 'Signal rouge';
  const tone = readiness.verdict === 'green' ? 'good' : readiness.verdict === 'amber' ? 'watch' : 'warn';

  const answerFatigue = async (value: number) => {
    setSending(value);
    setError(null);
    try {
      setResult(await post<CheckInResult>('/api/checkin', { date: state.today.date, fatigue: value }));
      // Un réajustement change la séance affichée plus haut : on la relit.
      await onReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(null);
    }
  };

  return (
    <section className="card availability">
      <div className="card-head" style={{ marginBottom: 10 }}>
        <h2 className="card-title">Ta disponibilité</h2>
        <Badge tone={tone}><span className="dot" />{verdict}</Badge>
      </div>

      <div className="avail-score">
        <span className="avail-value" style={{ color: `var(--${tone === 'good' ? 'good' : tone === 'watch' ? 'watch' : 'warn'})` }}>
          {readiness.score}
        </span>
        <span className="tiny faint">sur 100</span>
        {delta !== 0 && (
          <span className="delta" data-dir={delta > 0 ? 'up' : 'down'}>
            {delta > 0 ? '+' : '−'}{Math.abs(delta)} depuis ta réponse
          </span>
        )}
      </div>

      <p className="avail-reco">{nbsp(readiness.recommendation)}</p>

      <ReadinessBasis readiness={readiness} before={result ? before : undefined} />

      {missing.length > 0 && (
        <p className="tiny" style={{ color: 'var(--watch)', margin: '12px 0 0' }}>
          Ce score ne regarde pas {missing.join(' ni ')} : faute de relevé,{' '}
          {missing.length > 1 ? 'ils ne pèsent' : 'il ne pèse'} rien, plutôt que de peser une moyenne.
        </p>
      )}

      <div className="avail-ask">
        <div className="q-head">
          <span className="q-title">{answer == null ? 'Comment tu te sens, là ?' : 'Ce matin, tu te sens'}</span>
          {sending != null && <span className="q-aside"><span className="spinner" /></span>}
        </div>
        <div className="q-options">
          {question.options.map((o) => (
            <button
              type="button"
              key={o.value}
              className="q-option"
              aria-pressed={answer === o.value}
              data-on={answer === o.value}
              disabled={sending != null}
              onClick={() => answerFatigue(o.value)}
            >
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {error && <p className="tiny" style={{ color: 'var(--warn)', margin: '10px 0 0' }}>{error}</p>}

      {result && (
        <div className="avail-after">
          <p className="tiny" style={{ margin: 0 }}>
            Ton ressenti pèse {Math.round(readiness.weights.subjective * 100)} % de ta disponibilité
            {before.weights.subjective === 0 ? ", là où il n'en pesait rien." : '.'}
          </p>
          {result.adjustments > 0 && result.adjustmentSummary && (
            <div className="avail-adjust">
              <strong className="small">
                {result.adjustments} séance{result.adjustments > 1 ? 's' : ''} réajustée
                {result.adjustments > 1 ? 's' : ''} par les règles de charge
              </strong>
              <div
                className="msg-content tiny"
                dangerouslySetInnerHTML={{ __html: markdown(result.adjustmentSummary) }}
              />
            </div>
          )}
        </div>
      )}

      <Link href="/point" className="avail-more">
        {answer == null ? 'Le point du jour en entier' : 'Compléter le point du jour'} →
      </Link>
    </section>
  );
}

/** Les chiffres — en dernier, parce qu'à sept heures ils ne décident de rien. */
function Figures({ state }: { state: StateResponse }) {
  const t = state.today;
  const race = state.upcomingRaces[0];
  const rows: { name: string; value: string; note: string; color?: string }[] = [
    { name: 'Charge chronique', value: String(Math.round(t.ctl)), note: `${signed(t.rampRate, 1)} pts/semaine`, color: 'var(--metabolic)' },
    { name: 'Fraîcheur métabolique', value: signed(t.tsb), note: t.tsbLabel },
    { name: 'Fraîcheur mécanique', value: signed(t.mechanicalTsb), note: 'Fatigue musculaire de descente', color: 'var(--mechanical)' },
    { name: 'Charge aiguë / chronique', value: t.acwr.toFixed(2), note: t.acwrLabel },
  ];
  return (
    <section className="card">
      <div className="card-head" style={{ marginBottom: 12 }}>
        <h2 className="card-title">Les chiffres</h2>
        <span className="card-hint">modèle du {frDate(state.model.asOf)}</span>
      </div>
      <div className="figures">
        {rows.map((r) => (
          <div className="figure" key={r.name}>
            <span className="figure-name">{r.name}</span>
            <span className="figure-value mono" style={{ color: r.color }}>{r.value}</span>
            <span className="figure-note tiny faint">{r.note}</span>
          </div>
        ))}
      </div>
      {race && (
        <div className="figure-race">
          <div>
            <div className="tiny faint">Prochain objectif</div>
            <div style={{ fontWeight: 600 }}>{race.name}</div>
          </div>
          <div style={{ textAlign: 'right' }}>
            <div className="figure-value mono">J−{race.daysUntil}</div>
            <div className="tiny faint">{frDate(race.date)}</div>
          </div>
        </div>
      )}
    </section>
  );
}
