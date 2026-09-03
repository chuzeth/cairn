'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import {
  frDate, get, markdown, post, todayIso,
  type CheckIn, type CheckInResult, type Readiness, type StateResponse,
} from '@/lib/api';
import { Badge, Card, ErrorBox, Loading, MISSING_LABEL, ReadinessBasis, unweighed } from '@/components/ui';
import { Gauge } from '@/components/charts';

/**
 * Le point du jour.
 *
 * Une réponse partielle est valide : un entraîneur ne cesse pas d'écouter parce
 * qu'on a sauté une question, et le score sait dire ce qu'il n'a pas. D'où le
 * format — cinq lignes de gros boutons, un envoi possible dès la première
 * réponse — plutôt qu'un formulaire à valider.
 */

interface Option { value: number; label: string }

/** Le sommeil se déclare par tranche : à sept heures du matin, on ne sait pas mieux. */
const SLEEP: Option[] = [
  { value: 5.0, label: '< 6 h' },
  { value: 6.5, label: '6–7 h' },
  { value: 7.5, label: '7–8 h' },
  { value: 8.5, label: '8–9 h' },
  { value: 9.5, label: '9 h +' },
];

/**
 * Une échelle 1–5, toujours rangée du pire au meilleur de gauche à droite.
 *
 * Certains champs comptent à l'envers — `soreness` vaut 5 quand ça fait mal.
 * Laisser cette inversion remonter jusqu'aux boutons, c'est demander à l'athlète
 * de changer de sens d'une rangée à l'autre : la faute de saisie qui suit est
 * indiscernable d'une vraie mauvaise journée, et elle empoisonne la ligne de
 * base. Le sens de lecture est donc constant, et c'est la valeur enregistrée
 * qui s'adapte. Les libellés remplacent les chiffres pour la même raison : « 4 »
 * ne veut rien dire sans le sens de l'échelle, « légères » se passe du sens.
 */
const scale = (labels: readonly [string, string, string, string, string], highIsWorst = false): Option[] =>
  labels.map((label, i) => ({ value: highIsWorst ? 5 - i : i + 1, label }));

const QUESTIONS = [
  { key: 'fatigue', title: 'Fatigue', options: scale(['vidé', 'lourd', 'moyen', 'en forme', 'frais'], true) },
  { key: 'sleepHours', title: 'Sommeil', options: SLEEP },
  { key: 'sleepQuality', title: 'Qualité du sommeil', options: scale(['haché', 'léger', 'correct', 'bon', 'profond']) },
  { key: 'soreness', title: 'Courbatures', options: scale(['sévères', 'fortes', 'nettes', 'légères', 'aucune'], true) },
  { key: 'stress', title: 'Stress', options: scale(['sous l’eau', 'tendu', 'moyen', 'calme', 'serein'], true) },
  { key: 'motivation', title: 'Motivation', options: scale(['à plat', 'mou', 'moyen', 'motivé', 'mordant']) },
] as const;

type AnswerKey = (typeof QUESTIONS)[number]['key'];
type Answers = Partial<Record<AnswerKey, number>>;

const EXTRAS = [
  { key: 'restingHr', label: 'FC de repos', unit: 'bpm' },
  { key: 'hrvRmssd', label: 'rMSSD', unit: 'ms' },
  { key: 'bodyMassKg', label: 'Masse', unit: 'kg' },
] as const;

type ExtraKey = (typeof EXTRAS)[number]['key'];
type Extras = Partial<Record<ExtraKey, string>>;

export default function CheckInPage() {
  const [answers, setAnswers] = useState<Answers>({});
  const [extras, setExtras] = useState<Extras>({});
  const [note, setNote] = useState('');
  const [showExtras, setShowExtras] = useState(false);

  const noteRef = useRef<HTMLTextAreaElement>(null);
  const [before, setBefore] = useState<Readiness | null>(null);
  const [result, setResult] = useState<CheckInResult | null>(null);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const today = todayIso();

  const load = useCallback(async () => {
    setError(null);
    try {
      const s = await get<StateResponse>('/api/state');
      setBefore(s.readiness);
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

  const setAnswer = (key: AnswerKey, value: number) =>
    setAnswers((a) => {
      const next: Answers = { ...a };
      if (next[key] === value) delete next[key];
      else next[key] = value;
      return next;
    });

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
      setResult(await post<CheckInResult>('/api/checkin', body));
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

  return (
    <div className="checkin">
      <div className="page-head" style={{ marginBottom: 14 }}>
        <div>
          <h1 className="page-title">Point du jour</h1>
          <p className="page-sub">{frDate(today, { weekday: true })}</p>
        </div>
      </div>

      {before && unweighed(before).length > 0 && (
        <p className="checkin-lede">
          Sans ton point du jour, ta disponibilité ne regarde pas{' '}
          {unweighed(before).map((k) => MISSING_LABEL[k]).join(' ni ')} : faute de relevé,{' '}
          {unweighed(before).length > 1 ? 'ils ne pèsent' : 'il ne pèse'} rien, plutôt que de peser une
          moyenne. Tes réponses {unweighed(before).length > 1 ? 'leur rendent leur' : 'lui rend son'} poids.
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

/** Retrouve la tranche déclarée — on ne réinvente pas une précision qu'on n'avait pas. */
function answersOf(c: CheckIn): Answers {
  const a: Answers = {};
  const h = c.sleepHours;
  if (h != null) {
    a.sleepHours = SLEEP.reduce((best, o) => (Math.abs(o.value - h) < Math.abs(best.value - h) ? o : best)).value;
  }
  if (c.fatigue != null) a.fatigue = c.fatigue;
  if (c.sleepQuality != null) a.sleepQuality = c.sleepQuality;
  if (c.soreness != null) a.soreness = c.soreness;
  if (c.stress != null) a.stress = c.stress;
  if (c.motivation != null) a.motivation = c.motivation;
  return a;
}

function extrasOf(c: CheckIn): Extras {
  const x: Extras = {};
  if (c.restingHr != null) x.restingHr = String(c.restingHr);
  if (c.hrvRmssd != null) x.hrvRmssd = String(c.hrvRmssd);
  if (c.bodyMassKg != null) x.bodyMassKg = String(c.bodyMassKg);
  return x;
}

/** Ce qui a changé — c'est ce retour immédiat qui fait qu'on recommence demain. */
function Result({
  result, before, onEdit,
}: { result: CheckInResult; before: Readiness | null; onEdit: () => void }) {
  const r = result.readiness;
  const note = result.checkIn?.notes;
  const delta = before ? r.score - before.score : 0;
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
          <p className="page-sub">Voici ce que ça change.</p>
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
            {delta !== 0 && (
              <div className="delta" data-dir={delta > 0 ? 'up' : 'down'} style={{ fontSize: 19, marginTop: 6 }}>
                {delta > 0 ? '+' : ''}{delta} point{Math.abs(delta) > 1 ? 's' : ''}
              </div>
            )}
            <p className="small muted" style={{ margin: '8px 0 0' }}>{r.recommendation}</p>
          </div>
        </div>

        <ReadinessBasis readiness={r} before={before ?? undefined} />

        <p className="tiny" style={{ marginTop: 14, marginBottom: 0, color: stillBlind.length > 0 ? 'var(--watch)' : 'var(--good)' }}>
          {weightBefore != null && weightBefore !== weightNow
            ? `Ton ressenti pesait ${weightBefore} % de ta disponibilité ; il en pèse ${weightNow} %.`
            : `Ton ressenti pèse ${weightNow} % de ta disponibilité.`}
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
          title={`${result.adjustments} séance${result.adjustments > 1 ? 's' : ''} réajustée${result.adjustments > 1 ? 's' : ''}`}
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
