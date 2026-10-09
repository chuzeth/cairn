'use client';
import { Suspense, useCallback, useEffect, useState } from 'react';
import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import type { StrengthTestResult } from '@cairn/core';
import { PLAN_URL, frDate, getStamped, todayIso, type PlanResponse, type SessionRow } from '@/lib/api';
import { onForeground } from '@/lib/version';
import { ErrorBox, Loading, Stale } from '@/components/ui';
import { WorkoutView } from '@/components/Workout';

/**
 * La séance d'un jour, à suivre en la faisant : `/seance?d=AAAA-MM-JJ`.
 *
 * Une seule adresse pour tous les jours : le service worker garde la page par
 * son chemin, si bien qu'une séance jamais ouverte s'ouvre quand même Mac
 * éteint, sur le plan gardé (`/api/plan`).
 */
export default function SeancePage() {
  return (
    <Suspense fallback={<Loading />}>
      <Seance />
    </Suspense>
  );
}

/** Ce qui se tient ce jour-là : ni retiré, ni annulé, ni repos. */
const held = (s: SessionRow) => s.status !== 'withdrawn' && s.status !== 'cancelled' && s.type !== 'rest' && s.blocks.length > 0;

function Seance() {
  const params = useSearchParams();
  const date = params.get('d') ?? todayIso();
  const [plan, setPlan] = useState<PlanResponse | null>(null);
  const [tests, setTests] = useState<StrengthTestResult[]>([]);
  const [recordedAt, setRecordedAt] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const read = await getStamped<PlanResponse>(PLAN_URL);
      setPlan(read.data);
      setRecordedAt(read.recordedAt);
      setError(null);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
    // Les tests ne manquent qu'aux jours de test : leur absence n'empêche pas la séance.
    try {
      setTests((await getStamped<StrengthTestResult[]>('/api/tests')).data);
    } catch {
      setTests([]);
    }
  }, []);
  useEffect(() => { void load(); }, [load]);
  useEffect(() => onForeground(() => void load()), [load]);

  if (error && !plan) return <ErrorBox error={error} onRetry={load} />;
  if (!plan) return <Loading />;

  const days = [...new Set(plan.sessions.filter(held).map((s) => s.date))].sort();
  const session = plan.sessions.find((s) => s.date === date && held(s));
  const prev = days.filter((d) => d < date).at(-1);
  const next = days.find((d) => d > date);
  const back = date === todayIso() ? { href: '/', label: 'Aujourd’hui' } : { href: '/plan', label: 'Le plan' };

  if (!session) {
    return (
      <div className="w">
        <nav className="w-crumbs"><Link href={back.href}>← {back.label}</Link></nav>
        <header className="w-head">
          <div className="w-date">{frDate(date, { weekday: true, long: true })}</div>
          <h1 className="w-title">Rien au programme</h1>
          <p className="w-summary">
            Aucune séance ce jour-là.{' '}
            {next && <Link href={`/seance?d=${next}`} className="m-inline">La suivante, {frDate(next, { weekday: true, long: true })} →</Link>}
          </p>
        </header>
      </div>
    );
  }

  return (
    <>
      {recordedAt && <Stale recordedAt={recordedAt} />}
      <WorkoutView session={session} tests={tests} prev={prev} next={next} back={back} />
    </>
  );
}
