'use client';
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import type { StrengthTestResult } from '@cairn/core';
import { usesDoorKit } from '@cairn/core/exercises';
import { blockDuration, clock, frDate, nbsp, type LoadRatioAlertRow, type SessionRow } from '@/lib/api';
import { sendOrQueue } from '@/lib/offline';
import { planName } from '@/lib/sessions';
import { ExerciseFigure } from '@/components/ExerciseFigure';
import { WatchLine } from '@/components/Watch';
import { RatioAlerts } from '@/components/ui';
import {
  measureText, parseMeasure, partDuration, setLabel, stepRx, stepsOf, workoutOf, workoutSummary, type Part, type Step,
} from '@/lib/workout';

/**
 * La séance du jour, à suivre en la faisant.
 *
 * Le 09/10, Pierre : « je veux que, chaque jour, j'aie une séance ; que je
 * clique dessus et que j'aie l'explicatif avec le petit schéma de chaque
 * exercice, l'un après l'autre, que je peux suivre en faisant la séance […]
 * l'ordinateur posé devant moi ». Deux lectures de la même séance :
 *
 *   le déroulé   le sommaire en parties, puis chaque exercice : son schéma, ce
 *                qu'il y a à faire en gros, deux à quatre consignes. La fiche
 *                complète se déplie sous l'exercice, sans quitter la page.
 *   pas à pas    un exercice à la fois, en grand, les séries à cocher, le repos
 *                et les maintiens minutés, un bip quand ça repart. Espace pour
 *                avancer, les flèches pour changer d'exercice : les mains n'ont
 *                pas à quitter le tapis pour viser un bouton.
 *
 * Les séries cochées restent sur l'appareil (elles ne servent qu'à soi, le
 * temps de la séance) ; les résultats des tests partent au Mac, qui les
 * compare le dernier jour au premier.
 */

/** La zone d'un exercice, dite en mots : « Zone 1 · facile ». */
const ZONE_WORD: Record<string, string> = {
  Z1: 'Zone 1 · facile', Z2: 'Zone 2 · endurance', Z3: 'Zone 3 · tempo', Z4: 'Zone 4 · seuil', Z5: 'Zone 5 · maximal',
};

// ── Le son ───────────────────────────────────────────────────────────────────

let audio: AudioContext | null = null;

/** Un bip ; le navigateur n'en joue qu'après un premier geste, que « Commencer » fournit. */
function tone(freq: number, ms: number, delayS = 0): void {
  try {
    const Ctx = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctx) return;
    audio ??= new Ctx();
    if (audio.state === 'suspended') void audio.resume();
    const at = audio.currentTime + delayS;
    const osc = audio.createOscillator();
    const gain = audio.createGain();
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(0.0001, at);
    gain.gain.exponentialRampToValueAtTime(0.25, at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, at + ms / 1000);
    osc.connect(gain).connect(audio.destination);
    osc.start(at);
    osc.stop(at + ms / 1000 + 0.05);
  } catch {
    // Pas de son : l'écran dit la même chose.
  }
}

const BEEP = {
  /** Ça repart : fin du repos, début d'une poussée. */
  go: () => tone(880, 170),
  /** On relâche. */
  ease: () => tone(523, 170),
  /** C'est fini : fin d'un maintien, d'une série guidée. */
  done: () => { tone(880, 140); tone(1175, 220, 0.17); },
  /** Le métronome. */
  beat: () => tone(1320, 60),
};

// ── Ce que l'appareil garde de la séance ─────────────────────────────────────

interface Progress {
  /** Les séries faites, par bloc. */
  sets: Record<number, number>;
  /** L'étape où l'on en est. */
  at: number;
}

const progressKey = (id: string) => `cairn:seance:${id}`;

function readProgress(id: string): Progress {
  try {
    const raw = localStorage.getItem(progressKey(id));
    if (raw) {
      const p = JSON.parse(raw) as Partial<Progress>;
      return { sets: p.sets ?? {}, at: p.at ?? 0 };
    }
  } catch {
    // Navigation privée, stockage bloqué : la séance se suit quand même, sans mémoire.
  }
  return { sets: {}, at: 0 };
}

function writeProgress(id: string, p: Progress): void {
  try {
    localStorage.setItem(progressKey(id), JSON.stringify(p));
  } catch {
    // Rien à faire : ce n'est qu'un aide-mémoire.
  }
}

// ── Les résultats des tests ──────────────────────────────────────────────────

type Side = 'left' | 'right' | 'value';
type Entry = Partial<Record<Side, string>>;
type Saved = 'idle' | 'saving' | 'saved' | 'queued' | 'error';

const SIDE_LABEL: Record<Side, string> = { left: 'Gauche', right: 'Droite', value: 'Résultat' };
const UNIT_SHORT = { répétitions: 'rép.', secondes: 's', cm: 'cm' } as const;

/** Le chiffre affiché dans un champ : « 1,5 », pas « 1.5 ». */
const fieldText = (v: number | undefined) => (v == null ? '' : String(v).replace('.', ','));

// ── La vue ───────────────────────────────────────────────────────────────────

export function WorkoutView({
  session, tests, prev, next, back, ratio, autostart = false,
}: {
  session: SessionRow;
  /** Les résultats des tests, tous jours confondus. */
  tests: StrengthTestResult[];
  /** Les jours voisins qui portent une séance, pour passer de l'un à l'autre. */
  prev?: string;
  next?: string;
  /** D'où l'on vient : l'écran du matin, ou le plan. */
  back: { href: string; label: string };
  /** Les ratios de charge que le plan dépasse ce jour-là, et d'où vient leur référence. */
  ratio?: { alerts: LoadRatioAlertRow[]; source: string | null };
  /**
   * Ouverte depuis « Commencer la séance » : le pas à pas s'ouvre d'emblée, et sa
   * croix ramène d'où l'on vient. Le 22/10, Pierre : devoir recliquer sur
   * « Commencer » en arrivant était « un peu bizarre ».
   */
  autostart?: boolean;
}) {
  const router = useRouter();
  const parts = useMemo(() => workoutOf(session), [session]);
  const steps = useMemo(() => stepsOf(parts), [parts]);
  const [progress, setProgress] = useState<Progress>({ sets: {}, at: 0 });
  const [playing, setPlaying] = useState(false);
  const [entries, setEntries] = useState<Record<string, Entry>>({});
  const [saved, setSaved] = useState<Record<string, Saved>>({});
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => { setProgress(readProgress(session.id)); }, [session.id]);

  // Les résultats déjà notés ce jour-là remplissent les champs.
  useEffect(() => {
    const today: Record<string, Entry> = {};
    for (const r of tests.filter((t) => t.date === session.date)) {
      today[r.test] = { left: fieldText(r.left), right: fieldText(r.right), value: fieldText(r.value) };
    }
    setEntries(today);
  }, [tests, session.date]);

  const update = useCallback((next: Progress) => {
    setProgress(next);
    writeProgress(session.id, next);
  }, [session.id]);

  const setDone = useCallback((index: number, done: number) => {
    setProgress((p) => {
      const next = { ...p, sets: { ...p.sets, [index]: done } };
      writeProgress(session.id, next);
      return next;
    });
  }, [session.id]);

  const onEntry = useCallback((test: string, side: Side, text: string) => {
    setEntries((e) => ({ ...e, [test]: { ...e[test], [side]: text } }));
    setSaved((s) => ({ ...s, [test]: 'idle' }));
  }, []);

  const save = useCallback(async (test: string, entry: Entry) => {
    const body: Record<string, unknown> = { date: session.date, test };
    for (const side of ['left', 'right', 'value'] as const) {
      const text = entry[side];
      if (text === undefined) continue;
      body[side] = text.trim() === '' ? null : parseMeasure(text);
      if (body[side] === null && text.trim() !== '') {
        setSaveError(`« ${text} » n’est pas un nombre.`);
        setSaved((s) => ({ ...s, [test]: 'error' }));
        return;
      }
    }
    setSaved((s) => ({ ...s, [test]: 'saving' }));
    setSaveError(null);
    try {
      const res = await sendOrQueue<StrengthTestResult>('/api/tests', body);
      setSaved((s) => ({ ...s, [test]: res ? 'saved' : 'queued' }));
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaved((s) => ({ ...s, [test]: 'error' }));
    }
  }, [session.date]);

  const finished = (s: Step) => stepFinished(s, progress, entries);
  const done = steps.filter(finished).length;
  const started = Object.values(progress.sets).some((n) => n > 0);
  const resumeAt = Math.min(progress.at, steps.length - 1);

  const testProps = { tests, entries, saved, onEntry, save, date: session.date, error: saveError };

  /** Le pas à pas, à l'exercice dit, ou là où on s'était arrêté. */
  const start = useCallback((at?: number) => {
    // Le premier geste ouvre le son : sans lui, le navigateur tairait les bips.
    tone(1, 1);
    update({ ...progress, at: at ?? (started && done < steps.length ? resumeAt : 0) });
    setPlaying(true);
  }, [progress, started, done, steps.length, resumeAt, update]);

  const opened = useRef(false);
  useEffect(() => {
    if (!autostart || opened.current) return;
    opened.current = true;
    setProgress((p) => {
      const at = Object.values(p.sets).some((n) => n > 0) ? Math.min(p.at, steps.length - 1) : 0;
      return { ...p, at };
    });
    setPlaying(true);
  }, [autostart, steps.length]);

  const close = () => {
    // Venu de « Commencer la séance » : la croix ramène à l'écran d'où l'on vient.
    if (autostart && window.history.length > 1) router.back();
    else setPlaying(false);
  };

  // La montre coche la séance d'elle-même, si elle est enregistrée sous le bon sport.
  const onWatch = session.garmin != null && session.garmin.state !== 'not_sent';
  const endNote = onWatch
    ? `Lance « ${planName(session)} » sur ta montre, en Cardio : elle te guide, et Cairn coche la séance.`
    : 'Enregistre-la sur ta montre en Musculation : Cairn la cochera d’elle-même.';

  const label = started && done < steps.length ? `Reprendre — exercice ${resumeAt + 1}` : 'Commencer la séance';

  return (
    <div className="w">
      <nav className="w-crumbs">
        <Link href={back.href} transitionTypes={['nav-back']}>← {back.label}</Link>
        <span className="w-days">
          {prev && <Link href={`/seance?d=${prev}`} transitionTypes={['nav-back']} aria-label={`Séance du ${frDate(prev, { weekday: true, long: true })}`}>‹ {frDate(prev, { weekday: true })}</Link>}
          {next && <Link href={`/seance?d=${next}`} transitionTypes={['nav-forward']} aria-label={`Séance du ${frDate(next, { weekday: true, long: true })}`}>{frDate(next, { weekday: true })} ›</Link>}
        </span>
      </nav>

      <header className="w-head">
        <div className="w-date">{frDate(session.date, { weekday: true, long: true })}</div>
        <h1 className="w-title">{planName(session)}</h1>
        <p className="w-summary">{workoutSummary(parts, session.plannedDurationS, session.plannedElevationGainM ?? 0)}</p>
        {session.status === 'completed' && <p className="w-done">✓ Faite, et rattachée à la séance de ta montre.</p>}
        {ratio && session.status !== 'completed' && <RatioAlerts alerts={ratio.alerts} source={ratio.source} className="w-alerts" />}
        {session.status !== 'completed' && <WatchLine sessionId={session.id} status={session.garmin} />}
      </header>

      {/* Le sommaire est la séance : chaque exercice ouvre le pas à pas à cet endroit.
          Une seule façon de la faire, et toujours la même. */}
      <Sommaire parts={parts} finished={finished} onPick={(i) => start(i)} />

      {session.intent && (
        <details className="w-why">
          <summary>Pourquoi cette séance</summary>
          <p>{nbsp(session.intent)}</p>
        </details>
      )}

      <div className="w-cta">
        <button type="button" className="btn w-go" data-variant="primary" onClick={() => start()}>
          <span>{label}</span>
          <svg width="22" height="10" viewBox="0 0 22 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><path d="M0 5h21M16 0.5 21 5l-5 4.5" /></svg>
        </button>
        {done > 0 && <span className="w-start-note">{done} exercice{done > 1 ? 's' : ''} sur {steps.length} fait{done > 1 ? 's' : ''}</span>}
      </div>

      {playing && (
        <Player
          title={planName(session)}
          endNote={endNote}
          parts={parts}
          steps={steps}
          progress={progress}
          onProgress={update}
          onClose={close}
          {...testProps}
        />
      )}
    </div>
  );
}

/** Une étape faite : ses séries cochées, ou, pour un test, ses mesures notées. */
function stepFinished(step: Step, progress: Progress, entries: Record<string, Entry>): boolean {
  if (!step.measure) return (progress.sets[step.index] ?? 0) >= step.sets;
  const entry = entries[step.sheet!.key] ?? {};
  const sides: Side[] = step.measure.perSide ? ['left', 'right'] : ['value'];
  return sides.every((s) => (entry[s] ?? '').trim() !== '');
}

/** La séance d'un coup d'œil : ses parties, ses exercices numérotés, ce que chacun demande. */
function Sommaire({
  parts, finished: isFinished, onPick,
}: { parts: Part[]; finished: (s: Step) => boolean; onPick: (index: number) => void }) {
  return (
    <nav className="w-toc" aria-label="Sommaire de la séance">
      {parts.map((part, pi) => (
        <div className="w-toc-part" key={`${part.name}-${pi}`}>
          <div className="w-toc-head">
            <span>{part.name}</span>
            <span className="w-toc-time">{partDuration(part)}</span>
          </div>
          <ol>
            {part.steps.map((s) => {
              const finished = isFinished(s);
              return (
                <li key={s.index} data-done={finished}>
                  <button type="button" onClick={() => onPick(s.n - 1)} aria-label={`${s.name}, ${stepRx(s)} : commencer ici`}>
                    <span className="w-toc-n">{finished ? '✓' : String(s.n).padStart(2, '0')}</span>
                    <span className="w-toc-name">{s.name}</span>
                    <span className="w-toc-rx">{stepRx(s)}</span>
                    <svg className="w-toc-go" width="7" height="12" viewBox="0 0 7 12" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><path d="M1 1l5 5-5 5" /></svg>
                  </button>
                </li>
              );
            })}
          </ol>
        </div>
      ))}
    </nav>
  );
}

interface TestProps {
  tests: StrengthTestResult[];
  entries: Record<string, Entry>;
  saved: Record<string, Saved>;
  onEntry: (test: string, side: Side, text: string) => void;
  save: (test: string, entry: Entry) => Promise<void>;
  date: string;
  /** Ce que le Mac a refusé, dit sous le test qui l'a provoqué. */
  error: string | null;
}

/** Ce qu'il y a à faire, en gros : le chiffre qu'on lit de loin. */
function Main({ step, big = false }: { step: Step; big?: boolean }) {
  return (
    <div className={big ? 'w-main w-main-big' : 'w-main'}>
      {step.main}
      {step.mainNote && <span className="w-main-note">{step.mainNote}</span>}
    </div>
  );
}

/**
 * Le geste en une phrase — ce que fait le personnage du schéma —, ses deux à
 * quatre repères (l'installation, le point de forme, le piège), le détail
 * nommé (tempo, repos, effort, cœur), puis ce que la séance du jour y ajoute.
 * Chacun dit une chose, une fois. Le 12/10, Pierre voulait voir « très
 * facilement ce que fait le mec » ; le 14/10, il trouvait le texte et les
 * puces « un peu répétitifs ».
 */
function Details({ step }: { step: Step }) {
  return (
    <>
      {step.sheet && (
        <p className="w-what">
          <span className="w-what-label">Le geste</span>
          {nbsp(step.sheet.what)}
        </p>
      )}
      {step.sheet && step.sheet.cues.length > 0 && (
        <div className="w-cues-box">
          <span className="w-what-label">Les repères</span>
          <ol className="w-cues">
            {step.sheet.cues.map((c, i) => (
              <li key={i}>
                <span className="w-cue-n">{String(i + 1).padStart(2, '0')}</span>
                <span>{nbsp(c)}</span>
              </li>
            ))}
          </ol>
        </div>
      )}
      {step.details.length > 0 && (
        <dl className="w-details">
          {step.details.map((d, i) => (
            <div key={i}>
              <dt>{d.label}</dt>
              <dd>{nbsp(d.text)}</dd>
            </div>
          ))}
        </dl>
      )}
      {step.block.notes && <p className="w-today">{nbsp(step.block.notes)}</p>}
      {step.sheet && usesDoorKit(step.sheet) && (
        <Link href="/exercices#kit-porte" className="w-kit">Installer l’accroche de porte →</Link>
      )}
      {step.sheet && <Sheet x={step.sheet} />}
    </>
  );
}

/** La fiche entière de l'exercice, dépliée à la demande : rien ne s'y perd, rien ne s'y impose. */
function Sheet({ x }: { x: NonNullable<Step['sheet']> }) {
  return (
    <details className="w-more">
      <summary>Tout sur l’exercice</summary>
      <p className="w-more-why">{nbsp(x.why)}</p>
      {x.setup && (
        <>
          <h4>Installation</h4>
          <ul>{x.setup.map((s, i) => <li key={i}>{nbsp(s)}</li>)}</ul>
        </>
      )}
      <h4>Le mouvement</h4>
      <ol>{x.steps.map((s, i) => <li key={i}>{nbsp(s)}</li>)}</ol>
      <h4>Ce que tu dois sentir</h4>
      <p>{nbsp(x.feel)}</p>
      <h4>Les erreurs</h4>
      <ul>{x.mistakes.map((m, i) => <li key={i}>{nbsp(m)}</li>)}</ul>
      {x.easier && <p><strong>Plus facile.</strong> {nbsp(x.easier)}</p>}
      {x.harder && <p><strong>Plus dur.</strong> {nbsp(x.harder)}</p>}
      <p className="w-cast"><strong>Le bras blessé.</strong> {nbsp(x.cast)}</p>
    </details>
  );
}

/** Les séries à cocher : une pastille par série, la suivante d'un toucher. */
function SetDots({ step, done, onDone, big = false }: { step: Step; done: number; onDone: (n: number) => void; big?: boolean }) {
  if (step.sets <= 1 && !step.block.reps && !step.timer) {
    return (
      <button type="button" className="w-check" data-done={done >= 1} onClick={() => onDone(done >= 1 ? 0 : 1)}>
        {done >= 1 ? '✓ Fait' : 'Marquer comme fait'}
      </button>
    );
  }
  return (
    <div className={big ? 'w-dots w-dots-big' : 'w-dots'} role="group" aria-label="Séries">
      {Array.from({ length: step.sets }, (_, i) => (
        <button
          key={i}
          type="button"
          className="w-dot"
          data-done={i < done}
          aria-label={`${setLabel(step, i)}${i < done ? ', faite' : ''}`}
          // Toucher la dernière faite la décoche : une erreur se rattrape d'un geste.
          onClick={() => onDone(i < done ? i : i + 1)}
        >
          {i < done ? '✓' : i >= step.base && step.block.extra ? step.block.extra.side[0]!.toUpperCase() : i + 1}
        </button>
      ))}
      <span className="w-dots-note">
        {done >= step.sets
          ? 'Fait'
          : step.block.extra && done >= step.base
            ? `la série en plus : jambe ${step.block.extra.side} seule`
            : step.block.sides === 'jambe'
              ? `une série = gauche, puis droite${step.block.extra ? ` ; ${step.block.extra.side[0]!.toUpperCase()} : jambe ${step.block.extra.side} seule` : ''}`
              : `${done} sur ${step.sets}`}
      </span>
    </div>
  );
}

/** Le résultat d'un test : un champ par jambe, ou un seul, et ce qu'en disait le premier jour. */
function TestEntry({ step, tests, entries, saved, onEntry, save, date, error }: { step: Step } & TestProps) {
  const m = step.measure!;
  const test = step.sheet!.key;
  const entry = entries[test] ?? {};
  const sides: Side[] = m.perSide ? ['left', 'right'] : ['value'];
  const before = tests.filter((t) => t.test === test && t.date < date).at(-1);
  const state = saved[test] ?? 'idle';
  return (
    <div className="w-test">
      <div className="w-test-fields">
        {sides.map((side) => (
          <label key={side} className="w-test-field">
            <span>{SIDE_LABEL[side]}</span>
            <input
              inputMode="decimal"
              autoComplete="off"
              value={entry[side] ?? ''}
              placeholder="—"
              onChange={(e) => onEntry(test, side, e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') void save(test, entry); }}
            />
            <em>{UNIT_SHORT[m.unit]}</em>
          </label>
        ))}
        <button type="button" className="btn" onClick={() => void save(test, entry)} disabled={state === 'saving'}>
          {state === 'saving' ? '…' : 'Enregistrer'}
        </button>
      </div>
      <p className="w-test-note">
        {state === 'saved' && 'Enregistré. '}
        {state === 'error' && <span className="w-test-error">Pas enregistré : {error} </span>}
        {state === 'queued' && 'En attente d’envoi : le Mac ne répond pas, ce sera envoyé dès qu’il répondra. '}
        {before && (
          <>
            Le {frDate(before.date, { long: true })} :{' '}
            {m.perSide
              ? `gauche ${measureText(before.left, m.unit)}, droite ${measureText(before.right, m.unit)}`
              : measureText(before.value, m.unit)}
            .{' '}
          </>
        )}
        {m.reference && nbsp(m.reference)}
      </p>
    </div>
  );
}

// ── Pas à pas ────────────────────────────────────────────────────────────────

/** Ce qui tourne pendant l'étape : un repos, un maintien, un effort guidé, ou le chrono d'un test. */
type Run =
  | { kind: 'rest'; endsAt: number; total: number }
  | { kind: 'hold'; endsAt: number; total: number; side: 0 | 1 }
  | { kind: 'pulse'; phase: 'work' | 'ease'; rep: number; endsAt: number; side: 0 | 1 }
  | { kind: 'watch'; startedAt: number };

/** Une moitié de série faite, pour un exercice d'une jambe minuté : on attend l'autre jambe. */
interface Half { index: number; side: 1 }

function Player({
  title, endNote, parts, steps, progress, onProgress, onClose, ...tests
}: {
  title: string;
  endNote: string;
  parts: Part[];
  steps: Step[];
  progress: Progress;
  onProgress: (p: Progress) => void;
  onClose: () => void;
} & TestProps) {
  const [at, setAt] = useState(Math.min(progress.at, steps.length - 1));
  const [finished, setFinished] = useState(false);
  const [run, setRun] = useState<Run | null>(null);
  const [half, setHalf] = useState<Half | null>(null);
  const [now, setNow] = useState(() => Date.now());
  /** La liste des exercices, ouverte depuis le compteur : sauter où l'on veut, sans quitter la séance. */
  const [listing, setListing] = useState(false);
  const step = steps[at]!;
  const done = progress.sets[step.index] ?? 0;
  const dialog = useRef<HTMLDivElement>(null);
  useEffect(() => {
    dialog.current?.focus();
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => { document.body.style.overflow = overflow; };
  }, []);
  const part = parts.find((p) => p.steps.includes(step))!;
  const progressRef = useRef(progress);
  progressRef.current = progress;

  const go = useCallback((i: number) => {
    const target = Math.max(0, Math.min(steps.length - 1, i));
    setRun(null);
    setHalf(null);
    setAt(target);
    onProgress({ ...progressRef.current, at: target });
  }, [steps.length, onProgress]);

  const tick = useCallback((index: number, sets: number, restS: number) => {
    const before = progressRef.current.sets[index] ?? 0;
    const after = Math.min(sets, before + 1);
    onProgress({ ...progressRef.current, sets: { ...progressRef.current.sets, [index]: after } });
    // Le repos ne suit que les séries qui en annoncent une autre.
    if (after < sets && restS > 0) setRun({ kind: 'rest', endsAt: Date.now() + restS * 1000, total: restS });
    else setRun(null);
  }, [onProgress]);

  // L'horloge de l'écran : un quart de seconde suffit à un compte à rebours lisible.
  useEffect(() => {
    if (!run) return;
    const id = window.setInterval(() => setNow(Date.now()), 200);
    return () => window.clearInterval(id);
  }, [run]);

  // Le métronome du test des mollets : un bip toutes les `beatS` secondes.
  const beatS = step.timer?.kind === 'stopwatch' ? step.timer.beatS : undefined;
  useEffect(() => {
    if (run?.kind !== 'watch' || !beatS) return;
    BEEP.beat();
    const id = window.setInterval(() => BEEP.beat(), beatS * 1000);
    return () => window.clearInterval(id);
  }, [run, beatS]);

  // Les fins de phase : le repos qui finit, le maintien qui sonne, la poussée qui relâche.
  useEffect(() => {
    if (!run || run.kind === 'watch' || now < run.endsAt) return;
    if (run.kind === 'rest') {
      BEEP.go();
      setRun(null);
      return;
    }
    const weakOnly = Boolean(step.block.extra) && (progressRef.current.sets[step.index] ?? 0) >= step.base;
    if (run.kind === 'hold') {
      BEEP.done();
      if (step.block.sides && run.side === 0 && !weakOnly) {
        setHalf({ index: step.index, side: 1 });
        setRun(null);
      } else {
        setHalf(null);
        tick(step.index, step.sets, step.restS);
      }
      return;
    }
    const t = step.timer;
    if (t?.kind !== 'pulse') return setRun(null);
    // Pas de relâche après la dernière poussée : la série est finie.
    if (run.phase === 'work' && t.restS > 0 && run.rep < t.reps) {
      BEEP.ease();
      setRun({ ...run, phase: 'ease', endsAt: run.endsAt + t.restS * 1000 });
    } else if (run.rep < t.reps) {
      BEEP.go();
      setRun({ ...run, phase: 'work', rep: run.rep + 1, endsAt: run.endsAt + t.workS * 1000 });
    } else {
      BEEP.done();
      if (step.block.sides && run.side === 0 && !weakOnly) {
        setHalf({ index: step.index, side: 1 });
        setRun(null);
      } else {
        setHalf(null);
        tick(step.index, step.sets, step.restS);
      }
    }
  }, [now, run, step, tick]);

  // L'écran reste allumé pendant la séance.
  useEffect(() => {
    let lock: { release: () => Promise<void> } | null = null;
    const ask = async () => {
      try {
        const wl = (navigator as unknown as { wakeLock?: { request: (t: 'screen') => Promise<{ release: () => Promise<void> }> } }).wakeLock;
        if (wl && document.visibilityState === 'visible') lock = await wl.request('screen');
      } catch {
        // Refusé ou absent : l'écran s'éteindra comme d'habitude.
      }
    };
    void ask();
    const again = () => { if (document.visibilityState === 'visible') void ask(); };
    document.addEventListener('visibilitychange', again);
    return () => {
      document.removeEventListener('visibilitychange', again);
      void lock?.release().catch(() => {});
    };
  }, []);

  /** La seule action à faire maintenant, celle que la barre d'espace déclenche. */
  const primary = useMemo((): { label: string; act: () => void } => {
    const side = half?.index === step.index ? 1 : 0;
    const onlyWeak = step.block.extra && done >= step.base ? step.block.extra.side : null;
    const sideWord = onlyWeak
      ? ` — jambe ${onlyWeak} seule`
      : step.block.sides === 'jambe' ? (side === 0 ? ' — jambe gauche' : ' — jambe droite') : step.block.sides === 'côté' ? (side === 0 ? ' — premier côté' : ' — second côté') : '';
    if (run?.kind === 'rest') return { label: 'Passer le repos', act: () => setRun(null) };
    if (run?.kind === 'hold' || run?.kind === 'pulse') return { label: 'Arrêter', act: () => setRun(null) };
    if (run?.kind === 'watch') {
      return {
        label: 'Arrêter le chrono',
        act: () => {
          // Le chrono note ce qu'il a mesuré ; le champ reste à corriger à la main.
          const m = step.measure!;
          const elapsed = (Date.now() - run.startedAt) / 1000;
          const value = beatS ? Math.floor(elapsed / beatS) + 1 : Math.min(m.max ?? Infinity, Math.round(elapsed));
          const entry = tests.entries[step.sheet!.key] ?? {};
          const target: Side = m.perSide ? (entry.left ? 'right' : 'left') : 'value';
          tests.onEntry(step.sheet!.key, target, String(value));
          setRun(null);
        },
      };
    }
    if (step.measure) {
      // Les deux jambes notées : le bouton enregistre et passe au test suivant.
      const entry = tests.entries[step.sheet!.key] ?? {};
      const sides: Side[] = step.measure.perSide ? ['left', 'right'] : ['value'];
      if (sides.every((s) => (entry[s] ?? '').trim() !== '')) {
        const last = at + 1 >= steps.length;
        return {
          label: last ? 'Enregistrer et terminer' : 'Enregistrer, puis la suite →',
          act: () => {
            void tests.save(step.sheet!.key, entry);
            if (last) setFinished(true);
            else go(at + 1);
          },
        };
      }
      if (step.timer?.kind === 'stopwatch') {
        return {
          label: beatS ? `▶ Métronome — un bip toutes les ${beatS} s` : '▶ Lancer le chrono',
          act: () => setRun({ kind: 'watch', startedAt: Date.now() }),
        };
      }
      return { label: 'Exercice suivant →', act: () => (at + 1 < steps.length ? go(at + 1) : setFinished(true)) };
    }
    if (done >= step.sets) {
      return { label: at + 1 < steps.length ? 'Exercice suivant →' : 'Terminer la séance', act: () => (at + 1 < steps.length ? go(at + 1) : setFinished(true)) };
    }
    const t = step.timer;
    if (t?.kind === 'hold') {
      return {
        label: `▶ ${blockDuration(t.seconds)}${sideWord}`,
        act: () => { BEEP.go(); setRun({ kind: 'hold', endsAt: Date.now() + t.seconds * 1000, total: t.seconds, side: side as 0 | 1 }); },
      };
    }
    if (t?.kind === 'pulse') {
      return {
        label: `▶ Série ${done + 1}${sideWord}`,
        act: () => { BEEP.go(); setRun({ kind: 'pulse', phase: 'work', rep: 1, endsAt: Date.now() + t.workS * 1000, side: side as 0 | 1 }); },
      };
    }
    return {
      label: onlyWeak
        ? `Série en plus faite (jambe ${onlyWeak})`
        : step.sets > 1 ? `Série ${done + 1} faite${step.block.sides === 'jambe' ? ' (gauche et droite)' : ''}` : 'C’est fait',
      act: () => tick(step.index, step.sets, step.restS),
    };
  }, [run, half, step, done, at, steps.length, go, tick, beatS, tests]);

  // Le clavier : espace pour l'action du moment, les flèches pour changer d'exercice.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA')) return;
      if (e.key === ' ' || e.key === 'Enter') {
        e.preventDefault();
        if (finished) onClose();
        else primary.act();
      } else if (e.key === 'ArrowRight') {
        e.preventDefault();
        if (at + 1 < steps.length) go(at + 1);
        else setFinished(true);
      } else if (e.key === 'ArrowLeft') {
        e.preventDefault();
        if (finished) setFinished(false);
        else go(at - 1);
      } else if (e.key === 'Escape') {
        // La liste ouverte se ferme d'abord ; la séance ensuite.
        if (listing) setListing(false);
        else onClose();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [primary, at, steps.length, go, onClose, finished, listing]);

  const remaining = run && run.kind !== 'watch' ? Math.max(0, Math.ceil((run.endsAt - now) / 1000)) : 0;
  const totalSets = steps.reduce((a, s) => a + Math.min(s.sets, progress.sets[s.index] ?? 0), 0);

  return (
    <div className="w-player" role="dialog" aria-modal="true" aria-label={`${title}, pas à pas`} ref={dialog} tabIndex={-1}>
      <header className="w-p-top">
        {/* Un segment par exercice : ce qui est fait à l'encre, celui du moment en terracotta. */}
        <div className="w-p-segs" style={{ gridTemplateColumns: `repeat(${steps.length}, minmax(0, 1fr))` }} aria-hidden>
          {steps.map((s, i) => (
            <span
              key={s.index}
              data-state={finished || stepFinished(s, progress, tests.entries) ? 'done' : i === at ? 'now' : 'todo'}
            />
          ))}
        </div>
        <div className="w-p-row">
          {/* La liste ouverte, la croix la referme : fermer la séance n'est pas ce qu'on cherche alors. */}
          <button
            type="button"
            className="w-p-close"
            onClick={listing ? () => setListing(false) : onClose}
            aria-label={listing ? 'Fermer la liste des exercices' : 'Fermer le pas à pas'}
          >
            <svg width="14" height="14" viewBox="0 0 14 14" stroke="currentColor" strokeWidth="1.2" aria-hidden><path d="M1 1l12 12M13 1 1 13" /></svg>
          </button>
          <div className="w-p-where">
            <span className="w-p-title">{title}</span>
          </div>
          <button
            type="button"
            className="w-p-count"
            aria-expanded={listing}
            aria-label={finished ? 'Séance finie, la liste des exercices' : `Exercice ${at + 1} sur ${steps.length} : la liste des exercices`}
            onClick={() => setListing((l) => !l)}
          >
            {finished ? 'Fini' : `${at + 1}/${steps.length}`}
          </button>
        </div>
      </header>

      {listing && (
        <div className="w-p-list" role="dialog" aria-label="Les exercices de la séance">
          {parts.map((p, pi) => (
            <section key={`${p.name}-${pi}`}>
              <h3>{p.name}</h3>
              <ol>
                {p.steps.map((s) => {
                  const i = steps.indexOf(s);
                  return (
                    <li key={s.index}>
                      <button
                        type="button"
                        data-now={!finished && i === at}
                        data-done={stepFinished(s, progress, tests.entries)}
                        onClick={() => { setFinished(false); go(i); setListing(false); }}
                      >
                        <span className="w-toc-n">{stepFinished(s, progress, tests.entries) ? '✓' : String(s.n).padStart(2, '0')}</span>
                        <span className="w-toc-name">{s.name}</span>
                        <span className="w-toc-rx">{stepRx(s)}</span>
                      </button>
                    </li>
                  );
                })}
              </ol>
            </section>
          ))}
        </div>
      )}

      {finished ? (
        <div className="w-p-end">
          <h2>Séance terminée.</h2>
          <p>
            {steps.filter((s) => stepFinished(s, progress, tests.entries)).length} exercices sur {steps.length}
            {totalSets > 0 && <>, {totalSets} série{totalSets > 1 ? 's' : ''} cochée{totalSets > 1 ? 's' : ''}</>}.
          </p>
          <p>{endNote}</p>
          <div className="w-p-end-actions">
            <button type="button" className="btn" onClick={() => setFinished(false)}>← Revenir au dernier exercice</button>
            <button type="button" className="btn" data-variant="primary" onClick={onClose}>Fermer</button>
          </div>
        </div>
      ) : (
        <main className="w-p-main" key={at}>
          {step.sheet && (
            <div className="w-p-fig">
              <ExerciseFigure exercise={step.sheet.key} label={step.sheet.name} tempo={step.block.tempo} />
            </div>
          )}
          <div className="w-p-info">
            <div className="w-p-kicker">
              <span>{part.name} · {part.steps.indexOf(step) + 1} sur {part.steps.length}</span>
              {/* La zone d'un exercice de force est un niveau d'effort, pas un cœur à tenir :
                  elle ne se dit que pour ce qui se pilote au cœur, et pour le facile. */}
              {(step.block.hrRange || (step.block.zone === 'Z1' && !step.block.reps && !step.block.kind)) && (
                <span>{ZONE_WORD[step.block.zone] ?? step.block.zone}</span>
              )}
            </div>
            <div className="w-p-headline">
              <h2 className="w-p-name">{step.name}</h2>
              <Main step={step} big />
            </div>
            <Details step={step} />

            <div className="w-p-action">
              {run && run.kind !== 'watch' && (
                <Clock
                  label={
                    run.kind === 'rest'
                      ? 'Repos'
                      : run.kind === 'hold'
                        ? step.block.extra && done >= step.base
                          ? `Jambe ${step.block.extra.side}`
                          : step.block.sides === 'jambe' ? (run.side === 0 ? 'Jambe gauche' : 'Jambe droite') : 'Tiens'
                        : run.phase === 'work' ? `Pousse · ${run.rep} sur ${step.timer?.kind === 'pulse' ? step.timer.reps : ''}` : 'Relâche'
                  }
                  value={clock(remaining)}
                  tone={run.kind === 'rest' ? 'rest' : run.kind === 'pulse' && run.phase === 'ease' ? 'rest' : 'work'}
                />
              )}
              {run?.kind === 'watch' && (
                <Clock
                  label={beatS ? 'Bips' : 'Chrono'}
                  value={beatS ? String(Math.floor((now - run.startedAt) / 1000 / beatS) + 1) : clock((now - run.startedAt) / 1000)}
                  tone="work"
                />
              )}
              {half?.index === step.index && !run && (
                <p className="w-p-switch">Change de {step.block.sides === 'jambe' ? 'jambe' : 'côté'}, puis lance.</p>
              )}
              {step.measure ? (
                <TestEntry step={step} {...tests} />
              ) : (
                // Une étape d'une traite se coche du bouton principal : une pastille de plus ferait doublon.
                step.sets > 1 && (
                  <SetDots step={step} done={done} onDone={(n) => onProgress({ ...progress, sets: { ...progress.sets, [step.index]: n } })} big />
                )
              )}
            </div>
          </div>
        </main>
      )}

      {/* L'action du moment entre les deux flèches, toujours au même endroit,
          sous le pouce — jamais par-dessus la consigne qu'on est en train de lire. */}
      {!finished && (
        <footer className="w-p-nav">
          <button type="button" className="btn w-p-arrow" onClick={() => go(at - 1)} disabled={at === 0} aria-label="Exercice précédent">
            <svg width="20" height="10" viewBox="0 0 22 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><path d="M22 5H1M6 0.5 1 5l5 4.5" /></svg>
          </button>
          <button type="button" className="btn w-p-primary" data-variant="primary" onClick={primary.act}>
            {primary.label}
          </button>
          <button
            type="button"
            className="btn w-p-arrow"
            onClick={() => (at + 1 < steps.length ? go(at + 1) : setFinished(true))}
            aria-label={at + 1 < steps.length ? 'Exercice suivant' : 'Finir la séance'}
          >
            <svg width="20" height="10" viewBox="0 0 22 10" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden><path d="M0 5h21M16 0.5 21 5l-5 4.5" /></svg>
          </button>
          <span className="w-p-keys">Espace : l’action du moment · ← → : changer d’exercice · Échap : fermer</span>
        </footer>
      )}
    </div>
  );
}

function Clock({ label, value, tone }: { label: ReactNode; value: string; tone: 'work' | 'rest' }) {
  return (
    <div className="w-clock" data-tone={tone} aria-live="polite">
      <span className="w-clock-label">{label}</span>
      <span className="w-clock-value">{value}</span>
    </div>
  );
}
