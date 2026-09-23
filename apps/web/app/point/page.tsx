'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  frDate, getStamped, markdown, nbsp, num, todayIso,
  type CheckInResult, type Readiness, type StateResponse,
} from '@/lib/api';
import {
  answersOf, EXTRAS, extrasOf, QUESTIONS,
  type AnswerKey, type Answers, type Extras,
} from '@/lib/checkin';
import { sendOrQueue, useOutbox } from '@/lib/offline';
import { useUnsent } from '@/lib/version';
import { Badge, Card, ErrorBox, Loading, MISSING_LABEL, ReadinessBasis, Stale, unweighed } from '@/components/ui';
import { Gauge } from '@/components/charts';
import { Glossed } from '@/components/Term';

/**
 * Le point du jour.
 *
 * Une réponse partielle est valide : un entraîneur ne cesse pas d'écouter parce
 * qu'on a sauté une question, et le score sait dire ce qu'il n'a pas. D'où le
 * format — cinq lignes de gros boutons, un envoi possible dès la première
 * réponse — plutôt qu'un formulaire à valider.
 */

export default function CheckInPage() {
  const [answers, setAnswers] = useState<Answers>({});
  const [extras, setExtras] = useState<Extras>({});
  const [note, setNote] = useState('');
  const [showExtras, setShowExtras] = useState(false);
  /** Une réponse choisie depuis le dernier envoi : la page ne se recharge pas sous elle. */
  const [edited, setEdited] = useState(false);
  useUnsent(edited);

  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [before, setBefore] = useState<Readiness | null>(null);
  /** À quoi sert le point, tel que l'API le dit : c'est elle qui sait ce que les règles en font. */
  const [purpose, setPurpose] = useState<string | null>(null);
  const [result, setResult] = useState<CheckInResult | null>(null);
  /** Le point est en file : il n'est pas enregistré, et l'écran ne dit pas qu'il l'est. */
  const [queued, setQueued] = useState(false);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** Non nul : l'état lu sort du cache, et la disponibilité affichée date. */
  const [recordedAt, setRecordedAt] = useState<string | null>(null);
  /**
   * Le jour vient du serveur, jamais de l'horloge du téléphone : c'est lui qui
   * range les relevés. Un téléphone à l'étranger ouvrirait sinon un second point
   * du jour à côté de celui que l'écran du matin a déjà commencé.
   */
  const [today, setToday] = useState(todayIso());

  const load = useCallback(async () => {
    setError(null);
    try {
      const { data: s, recordedAt: at } = await getStamped<StateResponse>('/api/state');
      setToday(s.today.date);
      setBefore(s.readiness);
      setPurpose(s.checkInPurpose ?? null);
      setRecordedAt(at);
      // Un point déjà commencé se reprend, il ne se recommence pas.
      if (s.checkIn) {
        setAnswers(answersOf(s.checkIn));
        const x = extrasOf(s.checkIn);
        setExtras(x);
        if (Object.keys(x).length > 0) setShowExtras(true);
        if (s.checkIn.notes) setNote(s.checkIn.notes);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  // La note grandit avec ce qu'on écrit : une phrase tronquée décourage la suivante.
  useEffect(() => {
    const el = noteRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, [note]);

  const setAnswer = (key: AnswerKey, value: number) => {
    setEdited(true);
    setAnswers((a) => {
      const next: Answers = { ...a };
      if (next[key] === value) delete next[key];
      else next[key] = value;
      return next;
    });
  };

  const answered =
    Object.keys(answers).length > 0 ||
    EXTRAS.some((e) => (extras[e.key] ?? '').trim() !== '') ||
    note.trim() !== '';

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const body: Record<string, unknown> = { date: today, ...answers, notes: note.trim() };
      for (const e of EXTRAS) {
        const raw = (extras[e.key] ?? '').trim();
        if (raw !== '') body[e.key] = Number(raw.replace(',', '.'));
      }
      const sent = await sendOrQueue<CheckInResult>('/api/checkin', body);
      setEdited(false);
      // Mis en file : rien n'a été enregistré et aucun score n'a été recalculé.
      // Afficher « c'est noté » ici serait le seul vrai mensonge de l'écran.
      if (sent) setResult(sent);
      else setQueued(true);
      window.scrollTo({ top: 0, behavior: 'smooth' });
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  if (loading) return <Loading label="Chargement de ta disponibilité…" />;
  if (error && !before) return <ErrorBox error={error} onRetry={load} />;

  if (result) {
    return (
      <Result
        result={result}
        before={before}
        onEdit={() => { setBefore(result.readiness); setResult(null); }}
      />
    );
  }

  if (queued) return <Queued today={today} onEdit={() => setQueued(false)} />;

  return (
    <div className="checkin">
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-title">Point du jour</h1>
          <p className="page-sub">{frDate(today, { weekday: true, long: true })}</p>
        </div>
      </div>

      {/* La disponibilité affichée plus bas vient d'un état relevé, pas du Mac :
          la dire d'aujourd'hui ferait répondre l'athlète contre un chiffre faux. */}
      {recordedAt && <Stale recordedAt={recordedAt} />}

      {/* À quoi il sert, avant d'y répondre : une ligne, celle des règles. */}
      {purpose && (
        <p className="checkin-lede">
          <Glossed text={nbsp(purpose)} terms={['disponibilite']} />
        </p>
      )}

      {QUESTIONS.map((q) => (
        <div className="q" key={q.key} role="group" aria-label={q.title}>
          <div className="q-head">
            <span className="q-title">{q.title}</span>
            {answers[q.key] == null && <span className="q-aside">non renseigné</span>}
          </div>
          <div className="q-options">
            {q.options.map((o) => (
              <button
                type="button"
                key={o.value}
                className="q-option"
                aria-pressed={answers[q.key] === o.value}
                data-on={answers[q.key] === o.value}
                onClick={() => setAnswer(q.key, o.value)}
              >
                {o.label}
              </button>
            ))}
          </div>
        </div>
      ))}

      <div className="q">
        <div className="q-head">
          <span className="q-title">Autre chose ?</span>
          <span className="q-aside">non noté · lu par le coach</span>
        </div>
        <textarea
          ref={noteRef}
          rows={2}
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Le boulot me bouffe cette semaine. J'ai peur de cette course."
          style={{ fontSize: 16, overflow: 'hidden', resize: 'none' }}
        />
      </div>

      {showExtras ? (
        <div className="q">
          <div className="q-head">
            <span className="q-title">Mesures</span>
            <span className="q-aside">si tu les as</span>
          </div>
          <div className="q-extras">
            {EXTRAS.map((e) => (
              <label key={e.key} className="extra">
                <span className="extra-label">{e.label} <span className="faint">{e.unit}</span></span>
                <input
                  inputMode="decimal"
                  value={extras[e.key] ?? ''}
                  onChange={(ev) => setExtras((x) => ({ ...x, [e.key]: ev.target.value }))}
                  style={{ fontSize: 16 }}
                />
              </label>
            ))}
          </div>
        </div>
      ) : (
        <button type="button" className="btn checkin-more" data-variant="ghost" onClick={() => setShowExtras(true)}>
          + FC de repos, rMSSD, masse
        </button>
      )}

      {error && <div className="banner" data-tone="warn" style={{ marginTop: 14 }}>{error}</div>}

      <div className="checkin-send">
        <button className="btn" data-variant="primary" disabled={!answered || sending} onClick={send}>
          {sending ? <><span className="spinner" /> Enregistrement…</> : 'Enregistrer mon point'}
        </button>
        <p className="tiny faint">
          {answered
            ? 'Ce que tu laisses vide reste marqué non renseigné : rien n’est inventé à ta place.'
            : 'Une seule réponse suffit pour envoyer.'}
        </p>
      </div>
    </div>
  );
}

/**
 * Le point n'est pas parti.
 *
 * L'écran du résultat montre un score recalculé par le serveur ; sans serveur,
 * il n'y a pas de score, et rien n'a été enregistré. Servir « C'est noté » ici
 * serait le seul vrai mensonge de l'application : l'athlète cesserait de
 * revenir sur un point qui n'existe pas.
 */
function Queued({ today, onEdit }: { today: string; onEdit: () => void }) {
  // La file se vide toute seule au retour du réseau : l'écran suit, plutôt que
  // de laisser l'athlète devant une attente qui n'a plus lieu.
  const { pending } = useOutbox();
  const gone = pending === 0;
  return (
    <div className="checkin">
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-title">{gone ? 'C’est parti.' : 'En attente d’envoi.'}</h1>
          <p className="page-sub">{frDate(today, { weekday: true, long: true })}</p>
        </div>
      </div>

      <Card>
        <p className="small muted" style={{ margin: 0 }}>
          {gone ? (
            <>
              Ton point a quitté le téléphone et ta disponibilité a été recalculée avec.
              Rouvre le tableau de bord pour la lire.
            </>
          ) : (
            <>
              Ton point est gardé sur le téléphone. Il partira au retour du réseau, et c&apos;est à
              ce moment-là que ta disponibilité sera recalculée — pas avant. Pour l&apos;instant,
              rien n&apos;est enregistré et aucun score n&apos;a changé.
            </>
          )}
        </p>
      </Card>

      <div className="checkin-send">
        <Link href="/" className="btn" data-variant="primary">Retour au tableau de bord</Link>
        <button className="btn" onClick={onEdit}>Corriger</button>
      </div>
    </div>
  );
}

/** Ce qui a changé — c'est ce retour immédiat qui fait qu'on recommence demain. */
function Result({
  result, before, onEdit,
}: { result: CheckInResult; before: Readiness | null; onEdit: () => void }) {
  const r = result.readiness;
  const note = result.checkIn?.notes;
  // Ce que le point vient de changer n'est pas seulement le score : c'est le
  // poids que le ressenti a le droit de prendre dedans.
  const weightBefore = before ? Math.round(before.weights.subjective * 100) : null;
  const weightNow = Math.round(r.weights.subjective * 100);
  const stillBlind = unweighed(r);
  const verdictLabel = r.verdict === 'green' ? 'Feu vert' : r.verdict === 'amber' ? 'Vigilance' : 'Signal rouge';

  return (
    <div className="checkin">
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-title">C&apos;est noté.</h1>
          {/* Ce que les réponses ont changé, en une phrase : la disponibilité
              avant et après, et la séance — inchangée, ou allégée et de combien. */}
          <p className="page-sub checkin-effect">
            {result.effect ? <Glossed text={nbsp(result.effect)} terms={['disponibilite']} /> : 'Voici ce que ça change.'}
          </p>
        </div>
      </div>

      <Card>
        <div className="result-scores">
          {before && (
            <div className="result-was">
              <Gauge value={before.score} label="avant" tone={before.verdict} assumed={before.assumedShare} size={84} />
              <span className="result-arrow">→</span>
            </div>
          )}
          <Gauge value={r.score} label="sur 100" tone={r.verdict} assumed={r.assumedShare} size={120} />
          <div className="result-verdict">
            <Badge tone={r.verdict === 'green' ? 'good' : r.verdict === 'amber' ? 'watch' : 'warn'}>
              <span className="dot" />
              {verdictLabel}
            </Badge>
            <p className="small muted" style={{ margin: '8px 0 0' }}>{r.recommendation}</p>
          </div>
        </div>

        <ReadinessBasis readiness={r} before={before ?? undefined} />

        <p className="tiny" style={{ marginTop: 14, marginBottom: 0, color: stillBlind.length > 0 ? 'var(--watch)' : 'var(--good)' }}>
          {weightBefore != null && weightBefore !== weightNow
            ? `Ton ressenti pesait ${num(weightBefore)} % de ta disponibilité ; il en pèse ${num(weightNow)} %.`
            : `Ton ressenti pèse ${num(weightNow)} % de ta disponibilité.`}
          {stillBlind.length > 0 &&
            ` Il manque encore ${stillBlind.map((k) => MISSING_LABEL[k]).join(' et ')} : ce que personne n’a relevé ne pèse rien.`}
        </p>
      </Card>

      {note && (
        <Card style={{ marginTop: 14 }} title="Ta note">
          <blockquote className="note-quote">{note}</blockquote>
          <p className="tiny faint" style={{ margin: '10px 0 0' }}>
            Elle n&apos;entre dans aucun calcul. Le coach l&apos;a sous les yeux à ta prochaine question.
          </p>
        </Card>
      )}

      {result.adjustments > 0 && result.adjustmentSummary && (
        <Card
          style={{ marginTop: 14 }}
          title={`${num(result.adjustments)} séance${result.adjustments > 1 ? 's' : ''} réajustée${result.adjustments > 1 ? 's' : ''}`}
        >
          <div className="msg-content small" dangerouslySetInnerHTML={{ __html: markdown(result.adjustmentSummary) }} />
        </Card>
      )}

      <div className="checkin-send">
        <Link href="/" className="btn" data-variant="primary">Retour au tableau de bord</Link>
        <button className="btn" onClick={onEdit}>Compléter</button>
      </div>
    </div>
  );
}
