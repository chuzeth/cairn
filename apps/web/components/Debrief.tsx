'use client';
import Link from 'next/link';

/**
 * Le compte rendu d'une sortie (`debriefSession`, `@cairn/physiology`).
 *
 * Il vient avant les chiffres, et dans l'ordre où un entraîneur le dirait : ce
 * qui a été fait, ce que la sortie apprend — chaque constat lu contre
 * l'historique, avec ce qui le fonde et ce qu'on en sait —, ce que ça change
 * pour la suite, puis la comparaison au prévu. Ce qui n'a pas pu être lu est
 * dit, en bas : l'athlète a le droit de savoir ce que l'écran ne regarde pas.
 */

export interface DebriefFinding {
  code: string;
  domain: string;
  tone: 'positive' | 'negative' | 'neutral' | 'caution';
  weight: number;
  confidence: 'high' | 'medium' | 'low';
  title: string;
  detail: string;
  evidence: { label: string; value: string; reference?: string }[];
}

export interface DebriefView {
  activityId: string;
  date: string;
  what: string;
  headline: string;
  findings: DebriefFinding[];
  implications: {
    recovery: { qualityHours: number; eccentricHours: number; reasons: string[] };
    cardiac: { deltaBpm: number; typicalErrorBpm: number; streak: number } | null;
    spike: { ratio: number; referenceM: number; referenceDate: string } | null;
  };
  limits: string[];
  aerobicTrend: { activityId: string; date: string; hr: number; windows: number }[];
  referenceGapMs: number;
}

const CONFIDENCE: Record<DebriefFinding['confidence'], string> = {
  high: 'sûr',
  medium: 'probable',
  low: 'à confirmer',
};

const DAYS = ['dim.', 'lun.', 'mar.', 'mer.', 'jeu.', 'ven.', 'sam.'];

/** L'heure locale de la sortie, plus `hours` : « mar. 17/11, 13 h ». */
function after(startLocal: string, hours: number): string {
  // L'heure locale de Strava porte un « Z » qui n'en est pas un : elle se lit telle quelle.
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(startLocal);
  if (!m) return `${hours} h après`;
  const t = new Date(Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!) + hours * 3_600_000);
  return `${DAYS[t.getUTCDay()]} ${String(t.getUTCDate()).padStart(2, '0')}/${String(t.getUTCMonth() + 1).padStart(2, '0')}, ${t.getUTCHours()} h`;
}

export function Debrief({ debrief, startLocal }: { debrief: DebriefView; startLocal: string }) {
  const learned = debrief.findings.filter((f) => f.domain !== 'plan' && f.domain !== 'data');
  const plan = debrief.findings.find((f) => f.domain === 'plan');
  const data = debrief.findings.filter((f) => f.domain === 'data');
  const { recovery } = debrief.implications;
  const trend = debrief.aerobicTrend;
  const kmh = (debrief.referenceGapMs * 3.6).toFixed(1).replace('.', ',').replace(',0', '');

  return (
    <section className="db" aria-label="Ce que la sortie apprend">
      <p className="db-what">{debrief.what}</p>
      <h2 className="db-headline">{debrief.headline}</h2>

      {learned.length > 0 && (
        <div className="db-block">
          <h3 className="db-label">Ce que la sortie apprend</h3>
          <ol className="db-findings">
            {learned.map((f) => (
              <li key={f.code} className="db-finding" data-tone={f.tone}>
                <div className="db-finding-head">
                  <span className="db-dot" aria-hidden="true" />
                  <span className="db-finding-title">{f.title}</span>
                </div>
                <p className="db-finding-detail">{f.detail}</p>
                <div className="db-finding-foot">
                  {f.evidence.map((e) => (
                    <span key={e.label} className="db-evidence">
                      {e.label} <strong>{e.value}</strong>{e.reference ? <span className="db-ref"> · {e.reference}</span> : null}
                    </span>
                  ))}
                  <span className="db-confidence" data-level={f.confidence}>{CONFIDENCE[f.confidence]}</span>
                </div>
              </li>
            ))}
          </ol>
        </div>
      )}

      <div className="db-block">
        <h3 className="db-label">Ce que ça change</h3>
        <ul className="db-next">
          <li>
            Prochaine séance dure : pas avant <strong>{after(startLocal, recovery.qualityHours)}</strong>
            <span className="db-faint"> ({recovery.qualityHours} h)</span>
          </li>
          {recovery.eccentricHours > 0 && (
            <li>
              Prochaine descente rapide ou séance excentrique : pas avant{' '}
              <strong>{after(startLocal, recovery.eccentricHours)}</strong>
              <span className="db-faint"> ({recovery.eccentricHours} h)</span>
            </li>
          )}
        </ul>
        {recovery.reasons.length > 0 && (
          <p className="db-why">{recovery.reasons.map((r) => r.charAt(0).toUpperCase() + r.slice(1)).join('. ')}.</p>
        )}
        <p className="db-why">
          Les règles du plan lisent ces délais : une séance de qualité qui tombe avant se court au bas de ses fourchettes,
          un circuit excentrique est retiré. <Link href="/plan" className="db-link">Le plan →</Link>
        </p>
      </div>

      {trend.length >= 3 && (
        <div className="db-block">
          <h3 className="db-label">Ton cœur à {kmh} km/h, à plat</h3>
          <AerobicTrend points={trend} current={debrief.activityId} />
          <p className="db-why">
            La FC qu&apos;aurait coûté {kmh} km/h à plat, sortie par sortie, lue sur les passages de course régulière.
            Plus bas, c&apos;est plus en forme.
          </p>
        </div>
      )}

      {plan && (
        <div className="db-block">
          <h3 className="db-label">Le prévu</h3>
          <p className="db-plan-title">{plan.title}</p>
          <p className="db-finding-detail">{plan.detail}</p>
        </div>
      )}

      {(data.length > 0 || debrief.limits.length > 0) && (
        <div className="db-limits">
          {data.map((f) => <p key={f.code}><strong>{f.title}.</strong> {f.detail}</p>)}
          {debrief.limits.map((l) => <p key={l}>{l}</p>)}
        </div>
      )}
    </section>
  );
}

/** La FC à allure égale, sortie par sortie : un point par sortie, la dernière en couleur. */
function AerobicTrend({ points, current }: { points: DebriefView['aerobicTrend']; current: string }) {
  const W = 320;
  const H = 120;
  const pad = { l: 30, r: 8, t: 10, b: 20 };
  const t0 = Date.parse(`${points[0]!.date}T12:00:00Z`);
  const t1 = Date.parse(`${points.at(-1)!.date}T12:00:00Z`);
  const span = Math.max(1, t1 - t0);
  const hrs = points.map((p) => p.hr);
  const lo = Math.floor((Math.min(...hrs) - 3) / 5) * 5;
  const hi = Math.ceil((Math.max(...hrs) + 3) / 5) * 5;
  const x = (d: string) => pad.l + ((Date.parse(`${d}T12:00:00Z`) - t0) / span) * (W - pad.l - pad.r);
  const y = (hr: number) => pad.t + ((hi - hr) / Math.max(1, hi - lo)) * (H - pad.t - pad.b);
  const ticks = [lo, Math.round((lo + hi) / 2 / 5) * 5, hi];
  const month = (d: string) => `${d.slice(8, 10)}/${d.slice(5, 7)}`;
  return (
    <svg className="db-trend" viewBox={`0 0 ${W} ${H}`} role="img" aria-label="FC à allure égale, sortie par sortie">
      {ticks.map((t) => (
        <g key={t}>
          <line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} className="db-trend-grid" />
          <text x={pad.l - 6} y={y(t) + 3.5} className="db-trend-tick" textAnchor="end">{t}</text>
        </g>
      ))}
      {points.map((p) => (
        <circle
          key={p.activityId}
          cx={x(p.date)}
          cy={y(p.hr)}
          r={p.activityId === current ? 4.5 : 3}
          className={p.activityId === current ? 'db-trend-now' : 'db-trend-dot'}
        />
      ))}
      <text x={pad.l} y={H - 5} className="db-trend-tick">{month(points[0]!.date)}</text>
      <text x={W - pad.r} y={H - 5} className="db-trend-tick" textAnchor="end">{month(points.at(-1)!.date)}</text>
    </svg>
  );
}
