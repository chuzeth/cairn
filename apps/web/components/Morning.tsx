'use client';
import { useState } from 'react';
import Link from 'next/link';
import {
  duration, frDate, longDate, markdown, nbsp, prime, shortRace, signed, spelledDuration,
  type CheckInResult, type DeclaredAbsence, type PlanResponse, type Readiness, type SessionRow,
  type StateResponse,
} from '@/lib/api';
import { QUESTIONS } from '@/lib/checkin';
import { sendOrQueue, useOutbox } from '@/lib/offline';
import { CRITERION_LABELS, circuitText, originLabel, sessionHeadline, slopeOf } from '@/lib/sessions';
import { metres, sessionProfile, type SessionProfile } from '@/lib/profile';
import { ABSENCE_KIND_LABEL, MISSING_LABEL, ReadinessBasis, Stale, unweighed, Waiting } from '@/components/ui';

/**
 * Le chemin du matin, direction « Profil ».
 *
 * La séance du jour est dessinée comme le profil d'un dossard : le temps en
 * abscisse, chaque montée une dent, l'échauffement et le retour au calme à plat.
 * On y répond à « qu'est-ce que je fais aujourd'hui » par une forme avant d'y
 * répondre par des mots, et la ligne de consigne juste dessous dit la même
 * séance en chiffres — jamais deux séances différentes, puisque les deux se
 * calculent sur les mêmes blocs (`lib/profile.ts`).
 *
 * Ce que l'écran ne montre plus, il ne l'a pas perdu. La décomposition de la
 * disponibilité — composantes, provenance, poids — et les quatre chiffres de
 * charge sont sous « sur quoi repose ce chiffre », à un pouce. Un score affiché
 * sans ce sur quoi il repose serait un bug ; affiché avec, mais après, c'est
 * l'ordre dans lequel on se pose les questions à sept heures du matin.
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
 * Le libellé d'un bloc porte parfois sa durée nominale — « Activation (10 min) ».
 * La durée réelle est à sa gauche, et elle peut différer : un palier de reprise
 * raccourcit le bloc sans réécrire son nom. Deux nombres pour la même chose, et
 * c'est le mauvais qu'on lit. On garde celui qui vient de la structure.
 */
const blockLabel = (label: string) => label.replace(/\s*\((?:\d+\s*(?:min|s|h))\)\s*$/, '');

/**
 * La première phrase de l'intention suffit à ouvrir la journée ; le paragraphe
 * entier se lit sous « pourquoi cette séance », pour qui veut la lire.
 */
const firstSentence = (text: string) => /^.*?[.!?](?=\s|$)/.exec(text.trim())?.[0] ?? text;

export function Morning({
  state, plan, stravaConnected, recordedAt, onReload, onFileNote, filing,
}: {
  state: StateResponse;
  plan: PlanResponse;
  stravaConnected: boolean;
  /** Non nul : l'écran se rend sur ce que le service worker avait gardé. */
  recordedAt: string | null;
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
  const done = session != null && answeredStatus(session);
  const work = session && session.blocks.length > 0 && !done ? session : undefined;
  // Sans effort aujourd'hui, c'est le prochain qu'on ouvre — sauf le jour où la
  // séance est déjà faite, où il n'y a plus rien à préparer.
  const openNext = !work && !done ? next : undefined;
  const race = state.upcomingRaces[0];

  return (
    <div className="morning">
      <div className="m-top">
        <span>{longDate(today)}</span>
        {race && <span className="m-goal">J−{race.daysUntil} · {shortRace(race.name)}</span>}
      </div>

      {/* La fraîcheur avant le contenu : ce qui suit ne se lit pas pareil selon
          qu'il vient du Mac ou de ce que le téléphone avait gardé. */}
      {recordedAt && <Stale recordedAt={recordedAt} />}
      <Waiting />

      <Headline session={session} absence={absence} done={doneToday} />

      {work && <Session session={work} />}

      {/* Ce qui a été prescrit ne se dessine que s'il a été fait : le jour où une
          autre séance l'a remplacée, ce tracé montrerait ce qui n'a pas eu lieu. */}
      {done && session && (
        <>
          {session.status === 'completed' && <Trace session={session} muted />}
          {doneToday && (
            <Link href={`/activities/${doneToday.id}`} className="m-link">
              {doneToday.name} · l&apos;analyse →
            </Link>
          )}
        </>
      )}

      {!work && absence && <Absence absence={absence} />}

      {openNext && (
        <section className="m-next">
          <div className="m-label">
            {absence ? 'Ta reprise' : 'Prochaine séance'} · {frDate(openNext.date, { weekday: true })}
          </div>
          <h2 className="m-title m-title-next">{sessionHeadline(openNext)}</h2>
          <p className="m-sub">{subline(openNext)}</p>
          <Trace session={openNext} />
        </section>
      )}

      <div className="m-rule" />

      <Availability state={state} onReload={onReload} />

      {state.pendingNotes.map((n) => (
        <section className="m-note" key={n.date}>
          <h2 className="m-note-head">Tu as écrit ça, et rien n&apos;en a été fait.</h2>
          <div className="m-note-date">{frDate(n.date, { weekday: true })}</div>
          <blockquote className="m-quote">{n.notes}</blockquote>
          <div className="m-actions">
            <Link href="/coach" className="m-action">En parler au coach</Link>
            <button type="button" className="m-action" onClick={() => onFileNote(n.date)} disabled={filing === n.date}>
              {filing === n.date ? '…' : 'Classer sans suite'}
            </button>
          </div>
        </section>
      ))}

      {next && !openNext && (
        <p className="m-after">
          {isTomorrow(next.date, today) ? 'Demain' : 'Ensuite'}, {frDate(next.date, { weekday: true })}
          {' : '}{sessionHeadline(next).toLocaleLowerCase('fr')}
          {next.plannedDurationS > 0 && <>, {prime(next.plannedDurationS)}</>}.
        </p>
      )}

      {!stravaConnected && (
        <p className="m-after">
          Strava n&apos;est pas connecté : ces chiffres ne bougeront plus tant qu&apos;il ne l&apos;est
          pas. La connexion se fait depuis l&apos;ordinateur.
        </p>
      )}
    </div>
  );
}

/** La réponse à « qu'est-ce que je fais aujourd'hui », en un titre et une ligne. */
function Headline({
  session, absence, done,
}: { session?: SessionRow; absence?: DeclaredAbsence; done?: { id: string; name: string } }) {
  const head = (title: string, sub: React.ReactNode) => (
    <header className="m-head">
      <h1 className="m-title">{title}</h1>
      <p className="m-sub">{sub}</p>
    </header>
  );

  if (session && answeredStatus(session)) {
    return head(
      "C'est fait.",
      session.status === 'replaced'
        ? 'Pas la séance prévue, mais elle est faite et elle compte.'
        : 'Séance du jour faite et rattachée au plan.',
    );
  }
  if (session && session.type === 'rest') return head('Repos complet', nbsp(firstSentence(session.intent)));
  if (session) return head(sessionHeadline(session), subline(session));
  if (absence) {
    return head(
      'Rien aujourd’hui',
      <>
        {ABSENCE_KIND_LABEL[absence.kind]} déclarée jusqu&apos;au {frDate(absence.endDate, { weekday: true })}
        {absence.source === 'athlete' ? ', par toi.' : '.'}
      </>,
    );
  }
  if (done) return head("C'est fait.", 'Rien n’était prévu aujourd’hui, et tu as couru quand même.');
  return head(
    'Rien au programme',
    <>
      Aucune séance n&apos;est prévue aujourd&apos;hui.{' '}
      <Link href="/coach" className="m-inline">Demande au coach</Link> si ça te surprend.
    </>,
  );
}

/**
 * La ligne de chiffres sous le titre : la pente quand il y en a une, la durée
 * toujours, le dénivelé quand le tracé ne le porte pas déjà dans sa légende.
 */
function subline(session: SessionRow): string {
  const p = sessionProfile(session);
  const parts = [slopeOf(session), `${spelledDuration(p.totalS || session.plannedDurationS)} au total`];
  if (!p.captionIsClimb && p.gainM > 0) parts.push(`${metres(p.gainM)} de dénivelé`);
  return nbsp(parts.filter(Boolean).join(', '));
}

/**
 * Le profil de la séance, et la consigne bloc par bloc sous le même tracé.
 *
 * Le bloc porte en clair ce qui le fait — sa durée, son nom, sa cible
 * cardiaque, sa récupération. Les cibles à tenir et les mots du coach se
 * déplient sous « les consignes », chacun sous son bloc : servis d'office, ils
 * poussent la disponibilité du jour sous la ligne de flottaison, et on lirait
 * comment exécuter la séance avant de savoir si le système a une réserve
 * dessus.
 */
function Session({ session }: { session: SessionRow }) {
  const [why, setWhy] = useState(false);
  const [said, setSaid] = useState(false);
  const profile = sessionProfile(session);
  const notes = session.blocks.map(blockNote);
  const hasSaid = session.blocks.some((b, i) => targets(b) || notes[i]);

  return (
    <section className="m-session">
      <Trace session={session} profile={profile} />

      <div className="m-blocks">
        {session.blocks.map((b, i) => (
          <div className="m-block" key={i}>
            <span className="m-block-time" data-climb={climbs(b)}>
              {b.repeat ? `${b.repeat} × ${prime(b.durationS)}` : prime(b.durationS) || '—'}
            </span>
            <span className="m-block-body">
              {blockLabel(b.label)}
              {hrText(b) && <span className="m-faint"> · {hrText(b)}</span>}
              {shape(b) && <span className="m-block-note">{nbsp(shape(b))}</span>}
              {said && (targets(b) || notes[i]) && (
                <span className="m-block-said">
                  {targets(b) && <span className="m-faint">{nbsp(targets(b))} </span>}
                  {notes[i] && nbsp(notes[i]!)}
                </span>
              )}
            </span>
          </div>
        ))}
      </div>

      <div className="m-session-foot">
        <span className="m-faint">
          {session.plannedLoad} pts
          {session.plannedMechanicalLoad > 0 && ` · ${session.plannedMechanicalLoad} méca`}
        </span>
        <span className="m-foot-more">
          {hasSaid && (
            <button type="button" className="m-more" aria-expanded={said} onClick={() => setSaid((s) => !s)}>
              {said ? 'masquer' : 'les consignes'}
            </button>
          )}
          {(session.intent || session.rationale || session.directives?.length || session.successCriteria?.length) && (
            <button type="button" className="m-more" aria-expanded={why} onClick={() => setWhy((w) => !w)}>
              {why ? 'masquer' : 'pourquoi cette séance'}
            </button>
          )}
        </span>
      </div>

      {why && (
        <div className="m-why">
          {session.intent && <p>{nbsp(session.intent)}</p>}
          {session.rationale && <p>{nbsp(session.rationale)}</p>}
          {/* Une consigne dont on ne peut pas remonter à la source est une
              consigne qu'on demande à l'athlète de croire. */}
          {session.directives?.map((d, i) => (
            <p key={i}>
              {d.effect}
              <span className="m-faint"> « {d.origin.quote} » — {originLabel(d.origin)}</span>
            </p>
          ))}
          {session.successCriteria?.map((c, i) => (
            <p key={i}>
              Réussie si {CRITERION_LABELS[c.metric] ?? c.metric}
              {c.maxValue != null && ` ≤ ${c.maxValue}`}.
              <span className="m-faint"> « {c.origin.quote} » — {originLabel(c.origin)}</span>
            </p>
          ))}
        </div>
      )}
    </section>
  );
}

const climbs = (b: SessionRow['blocks'][number]) => (b.elevationGainM ?? 0) > (b.elevationLossM ?? 0);

/** Le tracé, pour qui ne le voit pas : la séance bloc par bloc, dans l'ordre. */
const spoken = (session: SessionRow) =>
  session.blocks
    .map((b) => `${b.repeat ? `${b.repeat} fois ` : ''}${duration(b.durationS)} ${blockLabel(b.label)}`)
    .join(', ');

/** La cible cardiaque, dite comme on la lit sur la montre. */
function hrText(b: SessionRow['blocks'][number]): string {
  if (!b.hrRange) return '';
  return b.hrRange[0] > 0 ? `${b.hrRange[0]}–${b.hrRange[1]}` : `sous ${b.hrRange[1]}`;
}

/**
 * Ce que la durée du bloc ne dit pas et sans quoi il n'est pas exécutable : sa
 * récupération — sans elle, « 8 × 90″ » ne veut rien dire — et sa distance
 * quand elle en porte une. Deux nombres au plus : la hauteur de la liste reste
 * prévisible, et le bas de l'écran atteignable.
 */
function shape(b: SessionRow['blocks'][number]): string {
  const parts: string[] = [];
  if (b.recovery && b.recovery.durationS > 0) {
    parts.push(`récup ${prime(b.recovery.durationS)} ${b.recovery.active ? 'active' : 'passive'}`);
  }
  if (b.distanceM) parts.push(`${b.distanceM} m`);
  return parts.join(' · ');
}

/**
 * Les cibles à tenir : allure, vitesse ascensionnelle, cadence, circuit.
 *
 * Elles se lisent sur la montre pendant l'effort, pas au réveil — et la
 * cardiaque, qui est la cible première en endurance, reste elle sur la ligne du
 * bloc. Une rando-course répète la même plage d'allure sur ses quatre blocs :
 * servies d'office, ces quatre lignes coûtent exactement la question du matin.
 */
function targets(b: SessionRow['blocks'][number]): string {
  const parts: string[] = [];
  if (b.paceRange) {
    parts.push(b.paceRange[1] === '—' ? `plus lent que ${b.paceRange[0]}/km` : `${b.paceRange[0]}–${b.paceRange[1]}/km`);
  }
  if (b.vamTargetMh) parts.push(`${metres(b.vamTargetMh)} D+/h`);
  if (b.cadenceTargetSpm) parts.push(`${b.cadenceTargetSpm} ppm`);
  if (b.circuit) parts.push(circuitText(b.circuit));
  return parts.join(' · ');
}

/**
 * Ce que le coach dit du bloc, et qui ne tient pas en nombres.
 *
 * La première phrase est retirée quand elle ne fait que redire la cible
 * affichée juste au-dessus : « Cible 1047 m D+/h, 171-175 bpm » deux fois dans
 * le même bloc, c'est du bruit qui pousse le conseil plus bas.
 */
function blockNote(b: SessionRow['blocks'][number]): string {
  if (!b.notes) return '';
  return b.vamTargetMh || b.hrRange ? b.notes.replace(/^\s*Cible[^.]*\.\s*/i, '') : b.notes;
}

/**
 * Le tracé.
 *
 * Aucun axe vertical, aucune graduation : la hauteur n'a pas d'unité, et le
 * nombre est dans la légende. L'ocre ne marque que ce qui monte.
 */
function Trace({
  session, profile, muted,
}: { session: SessionRow; profile?: SessionProfile; muted?: boolean }) {
  const p = profile ?? sessionProfile(session);
  const W = 350;
  const TOP = 24;
  const BASE = 94;
  const GROUND = 100;
  if (p.segments.length === 0) return null;

  const x = (v: number) => v * W;
  const y = (v: number) => BASE - v * (BASE - TOP);

  // Le cadre suit le tracé. Une séance qui ne monte nulle part occuperait sinon
  // la même hauteur qu'une rando-course, avec soixante pixels de vide au-dessus
  // d'une ligne plate — et ce vide se lirait comme un graphique manquant.
  const viewTop = Math.max(0, y(p.height) - 8);

  // Un seul trait par registre : les segments qui se suivent et se ressemblent
  // ne valent pas un chemin chacun.
  const paths: { d: string; tone: string }[] = [];
  for (const s of p.segments) {
    const head = paths[paths.length - 1];
    const from = `${x(s.x0).toFixed(1)} ${y(s.y0).toFixed(1)}`;
    const to = `${x(s.x1).toFixed(1)} ${y(s.y1).toFixed(1)}`;
    if (head && head.tone === s.tone && head.d.endsWith(from)) head.d += `L${to}`;
    else paths.push({ d: `M${from}L${to}`, tone: s.tone });
  }

  const marks = p.marks.filter((m, i, all) => i === 0 || m.at - all[i - 1]!.at > 0.08);

  return (
    <svg
      className="m-trace"
      viewBox={`0 ${viewTop.toFixed(1)} ${W} ${(134 - viewTop).toFixed(1)}`}
      role="img"
      data-muted={muted}
      aria-label={`Profil de la séance : ${spoken(session)}. ${p.caption}.`}
    >
      <path d={`M0 ${GROUND}H${W}`} className="m-trace-ground" />
      {paths.map((s, i) => (
        <path key={i} d={s.d} className="m-trace-line" data-tone={s.tone} />
      ))}
      {marks.map((m, i) => (
        <text
          key={m.seconds}
          x={x(m.at)}
          y="115"
          className="m-trace-mark"
          textAnchor={i === 0 ? 'start' : m.at > 0.98 ? 'end' : 'middle'}
        >
          {prime(m.seconds) || '0′'}
        </text>
      ))}
      {/* La légende appartient à l'axe, pas au ciel du tracé : posée sous les
          repères de temps et alignée sur eux, elle se lit comme la ligne de
          chiffres qu'elle est, et non comme une note laissée au milieu. */}
      <text x="0" y="130" className="m-trace-caption" data-climb={p.captionIsClimb}>
        {p.caption}
      </text>
    </svg>
  );
}

/** L'absence en cours, dans les mots de l'athlète. */
function Absence({ absence }: { absence: DeclaredAbsence }) {
  const n = absence.withdrawnSessions;
  const plural = (n ?? 0) > 1 ? 's' : '';
  return (
    <section className="m-session">
      <blockquote className="m-quote">{absence.reason}</blockquote>
      <p className="m-after">
        {n == null ? '' : n > 0 ? `${n} séance${plural} retirée${plural} du plan : ni à faire, ni manquée${plural}. ` : ''}
        Ta charge chronique baisse sur cette période : c&apos;est mesuré, et c&apos;était prévu.
      </p>
    </section>
  );
}

const VERDICT: Record<Readiness['verdict'], { word: string; bars: number }> = {
  green: { word: 'Feu vert', bars: 3 },
  amber: { word: 'Vigilance', bars: 2 },
  red: { word: 'Signal rouge', bars: 1 },
};

/**
 * La recommandation commence déjà par son verdict — « Vigilance. Garde la
 * séance… ». On le met en valeur là où il est, au lieu de l'annoncer une
 * seconde fois : « Vigilance. Vigilance. » ferait douter du reste de la phrase.
 * Une absence déclarée ouvre autrement, et n'a alors rien à mettre en gras.
 */
function verdictLead(text: string, word: string): [string | null, string] {
  return text.startsWith(word) ? [word, text.slice(word.length)] : [null, text];
}

/**
 * La réserve du jour, portée par la forme autant que par le nombre.
 *
 * Trois barres : le verdict se lit sans lire le score, et le score se lit sans
 * traduire une couleur. Ce que le chiffre pèse et d'où il vient tient sous
 * « sur quoi repose ce chiffre » — hors du premier écran, pas hors de
 * l'application.
 *
 * Une seule question posée ici, la première : au réveil, ce qui compte est que
 * le ressenti cesse de peser zéro. Le reste du point se remplit sur /point, et
 * s'ajoute à cette réponse au lieu de l'écraser.
 */
function Availability({ state, onReload }: { state: StateResponse; onReload: () => Promise<void> | void }) {
  const [before] = useState(state.readiness);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [sending, setSending] = useState<number | null>(null);
  /** La réponse donnée, mise en file faute de réseau : retenue, pas enregistrée. */
  const [queued, setQueued] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [basis, setBasis] = useState(false);
  const { pending } = useOutbox();

  const readiness = result?.readiness ?? state.readiness;
  const question = QUESTIONS[0];
  const answer = result?.checkIn?.fatigue ?? queued ?? state.checkIn?.fatigue ?? null;
  const missing = unweighed(readiness).map((k) => MISSING_LABEL[k]);
  const delta = readiness.score - before.score;
  const verdict = VERDICT[readiness.verdict];
  const [lead, rest] = verdictLead(readiness.recommendation, verdict.word);
  const t = state.today;

  const answerFatigue = async (value: number) => {
    setSending(value);
    setError(null);
    try {
      const sent = await sendOrQueue<CheckInResult>('/api/checkin', { date: state.today.date, fatigue: value });
      // Rien n'est parti : la réponse est retenue, et le score reste celui
      // d'avant. Un score recalculé ici serait un score que personne n'a produit.
      if (!sent) return setQueued(value);
      setQueued(null);
      setResult(sent);
      // Un réajustement change la séance affichée plus haut : on la relit.
      await onReload();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(null);
    }
  };

  return (
    <section className="m-avail">
      <div className="m-avail-grid">
        <div className="m-gauge">
          <span className="m-score">{readiness.score}</span>
          <svg viewBox="0 0 44 5" className="m-bars" role="img"
            aria-label={`${verdict.word} : niveau ${verdict.bars} sur 3`}>
            {[0, 16, 32].map((x, i) => (
              <rect key={x} x={x} y="0" width="12" height="5" data-on={i < verdict.bars} />
            ))}
          </svg>
        </div>
        <div>
          <p className="m-verdict">
            {lead && <strong>{lead}</strong>}
            {nbsp(rest)}
          </p>
          {delta !== 0 && (
            <p className="m-after">
              {delta > 0 ? '+' : '−'}{Math.abs(delta)} depuis ta réponse.
            </p>
          )}
          <button type="button" className="m-more" aria-expanded={basis} onClick={() => setBasis((b) => !b)}>
            {basis ? 'masquer' : 'sur quoi repose ce chiffre'}
          </button>
        </div>
      </div>

      {basis && (
        <div className="m-basis">
          <ReadinessBasis readiness={readiness} before={result ? before : undefined} />
          {/* Ce qui ne pèse rien se dit là où se lisent les poids, et pas trois
              lignes avant la question du matin. */}
          {missing.length > 0 && (
            <p className="m-after">
              Ce score ne regarde pas {missing.join(' ni ')} : faute de relevé,{' '}
              {missing.length > 1 ? 'ils ne pèsent' : 'il ne pèse'} rien, plutôt que de peser une moyenne.
            </p>
          )}
          <div className="m-figures">
            {[
              { name: 'Charge chronique', value: String(Math.round(t.ctl)), note: `${signed(t.rampRate, 1)} pts/semaine` },
              { name: 'Fraîcheur métabolique', value: signed(t.tsb), note: t.tsbLabel },
              { name: 'Fraîcheur mécanique', value: signed(t.mechanicalTsb), note: 'fatigue musculaire de descente' },
              { name: 'Charge aiguë / chronique', value: t.acwr.toFixed(2), note: t.acwrLabel },
            ].map((f) => (
              <div className="m-figure" key={f.name}>
                <span>{f.name}</span>
                <span className="m-figure-value">{f.value}</span>
                <span className="m-faint">{f.note}</span>
              </div>
            ))}
          </div>
          <p className="m-after">Modèle physiologique du {frDate(state.model.asOf)}.</p>
          <Link href="/point" className="m-link">Le point du jour en entier →</Link>
        </div>
      )}

      <div className="m-ask">
        <span className="m-ask-head">{answer == null ? 'Comment tu te sens, là ?' : 'Ce matin, tu te sens'}</span>
        <div className="m-scale">
          <div className="m-scale-line" />
          {question.options.map((o) => (
            <button
              type="button"
              key={o.value}
              className="m-step"
              aria-pressed={answer === o.value}
              data-on={answer === o.value}
              disabled={sending != null}
              onClick={() => answerFatigue(o.value)}
            >
              <span className="m-tick" />
              {o.label}
            </button>
          ))}
        </div>
      </div>

      {/* Tant que la file n'est pas vide, et pas une seconde de plus : une
          attente annoncée après le départ ferait renvoyer une réponse déjà
          partie. */}
      {queued != null && pending > 0 && (
        <p className="m-after" data-warn>
          En attente d&apos;envoi : ta réponse partira au retour du réseau. Ta disponibilité ne
          bougera pas avant que le serveur l&apos;ait recalculée.
        </p>
      )}

      {error && <p className="m-after" data-warn>{error}</p>}

      {result && result.adjustments > 0 && result.adjustmentSummary && (
        <div className="m-adjust">
          <strong>
            {result.adjustments} séance{result.adjustments > 1 ? 's' : ''} réajustée
            {result.adjustments > 1 ? 's' : ''} par les règles de charge
          </strong>
          <div className="msg-content" dangerouslySetInnerHTML={{ __html: markdown(result.adjustmentSummary) }} />
        </div>
      )}

      {result && (
        <p className="m-after">
          Ton ressenti pèse {Math.round(readiness.weights.subjective * 100)} % de ta disponibilité
          {before.weights.subjective === 0 ? ", là où il n'en pesait rien." : '.'}
        </p>
      )}
    </section>
  );
}
