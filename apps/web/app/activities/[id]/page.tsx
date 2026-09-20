'use client';
import { useCallback, useEffect, useState } from 'react';
import { use } from 'react';
import Link from 'next/link';
import { clock, duration, frDate, get, markdown, num, pace } from '@/lib/api';
import { Badge, Card, ErrorBox, Legend, Loading, Metric, ZoneBar } from '@/components/ui';
import { ElevationProfile, GradeProfileChart, StreamChart } from '@/components/charts';

interface Detail {
  activity: {
    id: string; name: string; description?: string; sportType: string; startDateLocal: string;
    distanceM: number; movingTimeS: number; elapsedTimeS: number;
    totalElevationGainM: number; totalElevationLossM: number;
    averageSpeedMs: number; averageHr?: number; maxHr?: number;
    averageCadenceSpm?: number; averageTempC?: number; calories?: number; deviceName?: string;
  };
  analysis: {
    load: { metabolic: number; mechanical: number; trimp: number; intensityFactor: number; normalizedGradedSpeedMs: number; verticalWorkKj: number; eccentricWorkKj: number; primarySource: string };
    zones: { fraction: Record<string, number>; seconds: Record<string, number>; threeZone: { low: number; moderate: number; high: number }; polarizationIndex: number };
    decoupling: { pctDrift: number | null; efficiencyFactor: number | null; valid: boolean; reason?: string };
    intervals: { index: number; durationS: number; distanceM: number; avgSpeedMs: number; avgGradedSpeedMs: number; avgGrade: number; avgHr: number | null; avgCadence: number | null; zone: string }[];
    gradeProfile: { from: number; to: number; seconds: number; distanceM: number; avgSpeedMs: number; vamMh?: number }[];
    meanMaximalVam: Record<string, number>;
    wPrimeBalanceMinM: number | null;
    durabilitySignal: { efDeclinePctPerHour: number | null; efDeclinePctPer1000mVert: number | null; sampleQuality: string };
    energy: { kcal: number; carbTargetGPerHour: number; fluidTargetMlPerHour: number };
    environment: { avgTempC: number | null; heatStressFactor: number; avgAltitudeM: number | null; altitudeFactor: number };
    compliance?: { verdict: string; detail: string; loadDeviationPct: number; intensityDeviationPct: number | null };
    flags: { code: string; severity: string; message: string }[];
  } | null;
  insight: { title: string; body: string; actions: string[]; highlights: { label: string; value: string }[]; severity: string } | null;
  streams: { distance?: number[]; altitude?: number[]; heartrate?: (number | null)[]; velocity?: number[]; grade?: number[]; cadence?: (number | null)[] } | null;
}

export default function ActivityDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [data, setData] = useState<Detail | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setData(await get<Detail>(`/api/activities/${id}`)); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [id]);
  useEffect(() => { void load(); }, [load]);

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!data) return <Loading />;

  const { activity: a, analysis, insight, streams } = data;

  return (
    <>
      <div className="page-head">
        <div>
          <Link href="/activities" className="tiny faint">← Toutes les séances</Link>
          <h1 className="page-title" style={{ marginTop: 4 }}>{a.name}</h1>
          <p className="page-sub">
            {frDate(a.startDateLocal, { weekday: true, year: true, long: true })} · {a.sportType}
            {a.deviceName ? ` · ${a.deviceName}` : ''}
          </p>
        </div>
      </div>

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Card><Metric label="Distance" value={num(a.distanceM / 1000, 2)} unit="km" /></Card>
        <Card><Metric label="Durée" value={clock(a.movingTimeS)} note={a.elapsedTimeS > a.movingTimeS + 60 ? `${clock(a.elapsedTimeS)} écoulées` : undefined} /></Card>
        <Card><Metric label="Dénivelé" value={num(a.totalElevationGainM)} unit="m D+" note={`${num(a.totalElevationLossM)} m D−`} /></Card>
        <Card><Metric label="Allure moyenne" value={pace(a.averageSpeedMs)} unit="/km" note={a.averageHr ? `${num(a.averageHr)} bpm moy · ${a.maxHr ? num(a.maxHr) : '—'} max` : undefined} /></Card>
      </div>

      {insight && (
        <Card
          title="Analyse du coach"
          action={<Badge tone={insight.severity === 'warn' ? 'warn' : insight.severity === 'watch' ? 'watch' : insight.severity === 'good' ? 'good' : undefined}>{insight.severity}</Badge>}
          style={{ marginBottom: 14 }}
        >
          <h3 style={{ margin: '0 0 8px', fontSize: 15, fontWeight: 620 }}>{insight.title}</h3>
          <div className="msg-content" dangerouslySetInnerHTML={{ __html: markdown(insight.body) }} />
          {insight.highlights.length > 0 && (
            <div className="row wrap" style={{ gap: 7, marginTop: 12 }}>
              {insight.highlights.map((h) => (
                <span key={h.label} className="badge">{h.label} <strong style={{ color: 'var(--text)' }}>{h.value}</strong></span>
              ))}
            </div>
          )}
          {insight.actions.length > 0 && (
            <div style={{ marginTop: 12, paddingTop: 12, borderTop: '1px solid var(--border)' }}>
              <div className="metric-label" style={{ marginBottom: 6 }}>À retenir</div>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                {insight.actions.map((x, i) => <li key={i}>{x}</li>)}
              </ul>
            </div>
          )}
        </Card>
      )}

      {!analysis ? (
        <Card><div className="empty">Analyse détaillée indisponible : les flux de cette activité n'ont pas été téléchargés.</div></Card>
      ) : (
        <>
          <div className="grid grid-4" style={{ marginBottom: 14 }}>
            <Card><Metric label="Charge métabolique" value={num(analysis.load.metabolic, 1)} tone="metabolic" note={`source : ${analysis.load.primarySource}`} /></Card>
            <Card><Metric label="Charge mécanique" value={num(analysis.load.mechanical, 1)} tone="mechanical" note={`${num(analysis.load.eccentricWorkKj)} kJ absorbés`} /></Card>
            <Card><Metric label="Intensité relative" value={num(analysis.load.intensityFactor, 2)} note={`vitesse graduée ${num(analysis.load.normalizedGradedSpeedMs * 3.6, 1)} km/h`} /></Card>
            <Card>
              <Metric
                label="Dérive cardiaque"
                value={analysis.decoupling.pctDrift != null ? `${num(analysis.decoupling.pctDrift, 1)} %` : '—'}
                tone={analysis.decoupling.pctDrift != null && analysis.decoupling.pctDrift > 8 ? 'warn' : analysis.decoupling.pctDrift != null ? 'good' : undefined}
                note={analysis.decoupling.valid ? 'rendement 1ʳᵉ vs 2ᵈᵉ moitié' : analysis.decoupling.reason}
              />
            </Card>
          </div>

          {analysis.flags.filter((f) => f.severity !== 'info').length > 0 && (
            <div className="stack" style={{ marginBottom: 14 }}>
              {analysis.flags.filter((f) => f.severity !== 'info').map((f, i) => (
                <div key={i} className="banner" data-tone={f.severity === 'warn' ? 'warn' : undefined} style={{ marginBottom: 0 }}>
                  <span>{f.message}</span>
                </div>
              ))}
            </div>
          )}

          {streams?.distance && streams.altitude && (
            <Card title="Profil du parcours" style={{ marginBottom: 14 }}>
              <ElevationProfile distance={streams.distance} altitude={streams.altitude} />
              {streams.heartrate && streams.velocity && (
                <div style={{ marginTop: 10 }}>
                  <StreamChart
                    distance={streams.distance}
                    series={[
                      { values: streams.heartrate, color: 'var(--z5)', label: 'Fréquence cardiaque', unit: 'bpm' },
                      { values: streams.velocity.map((v) => v * 3.6), color: 'var(--metabolic)', label: 'Vitesse', unit: 'km/h' },
                    ]}
                  />
                </div>
              )}
            </Card>
          )}

          <div className="grid grid-2" style={{ marginBottom: 14 }}>
            <Card title="Répartition d'intensité" hint={`Indice de polarisation ${num(analysis.zones.polarizationIndex, 2)}`}>
              <ZoneBar fractions={analysis.zones.fraction} />
              <Legend items={[
                { color: 'var(--z1)', label: 'Z1 récup' }, { color: 'var(--z2)', label: 'Z2 endurance' },
                { color: 'var(--z3)', label: 'Z3 tempo' }, { color: 'var(--z4)', label: 'Z4 seuil' },
                { color: 'var(--z5)', label: 'Z5 PMA' },
              ]} />
              <table style={{ marginTop: 12 }}>
                <tbody>
                  {(['Z1', 'Z2', 'Z3', 'Z4', 'Z5'] as const).map((z) => (
                    <tr key={z}>
                      <td style={{ width: 34 }}><span className="badge">{z}</span></td>
                      <td className="mono">{duration(analysis.zones.seconds[z] ?? 0)}</td>
                      <td className="right mono muted">{num((analysis.zones.fraction[z] ?? 0) * 100)} %</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>

            <Card title="Vitesse par tranche de pente" hint="La signature « trail » de la séance.">
              <GradeProfileChart buckets={analysis.gradeProfile} />
            </Card>
          </div>

          {analysis.intervals.length > 0 && (
            <Card title={`Blocs d'effort détectés (${num(analysis.intervals.length)})`} style={{ marginBottom: 14 }}>
              <table>
                <thead>
                  <tr><th>#</th><th className="right">Durée</th><th className="right">Distance</th><th className="right">Allure</th><th className="right">Allure corrigée</th><th className="right">Pente</th><th className="right">FC</th><th className="right">Cadence</th><th>Zone</th></tr>
                </thead>
                <tbody>
                  {analysis.intervals.map((iv) => (
                    <tr key={iv.index}>
                      <td className="mono faint">{num(iv.index)}</td>
                      <td className="right mono">{clock(iv.durationS)}</td>
                      <td className="right mono">{num(iv.distanceM)} m</td>
                      <td className="right mono">{pace(iv.avgSpeedMs)}</td>
                      <td className="right mono" style={{ color: 'var(--metabolic)' }}>{pace(iv.avgGradedSpeedMs)}</td>
                      <td className="right mono">{num(iv.avgGrade * 100, 1)} %</td>
                      <td className="right mono">{iv.avgHr != null ? num(iv.avgHr) : '—'}</td>
                      <td className="right mono">{iv.avgCadence != null ? num(iv.avgCadence) : '—'}</td>
                      <td><span className="badge">{iv.zone}</span></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </Card>
          )}

          <div className="grid grid-3">
            <Card title="Énergétique">
              <div className="stack" style={{ gap: 12 }}>
                <Metric label="Dépense" value={num(analysis.energy.kcal)} unit="kcal" />
                <div className="row-between small"><span className="faint">Travail vertical</span><span className="mono">{num(analysis.load.verticalWorkKj)} kJ</span></div>
                <div className="row-between small"><span className="faint">Absorbé en descente</span><span className="mono">{num(analysis.load.eccentricWorkKj)} kJ</span></div>
                <div className="row-between small"><span className="faint">Glucides recommandés</span><span className="mono">{num(analysis.energy.carbTargetGPerHour)} g/h</span></div>
                <div className="row-between small"><span className="faint">Hydratation</span><span className="mono">{num(analysis.energy.fluidTargetMlPerHour)} ml/h</span></div>
              </div>
            </Card>

            <Card title="Durabilité" hint={`Qualité de l'échantillon : ${analysis.durabilitySignal.sampleQuality}`}>
              <div className="stack" style={{ gap: 12 }}>
                <Metric
                  label="Perte de rendement"
                  value={analysis.durabilitySignal.efDeclinePctPerHour != null ? `${num(analysis.durabilitySignal.efDeclinePctPerHour, 1)} %` : '—'}
                  unit="/h"
                />
                <div className="row-between small">
                  <span className="faint">Par 1 000 m D+</span>
                  <span className="mono">{analysis.durabilitySignal.efDeclinePctPer1000mVert != null ? `${num(analysis.durabilitySignal.efDeclinePctPer1000mVert, 1)} %` : '—'}</span>
                </div>
                <div className="row-between small">
                  <span className="faint">Réserve anaérobie min.</span>
                  <span className="mono">{analysis.wPrimeBalanceMinM != null ? `${num(analysis.wPrimeBalanceMinM)} m` : '—'}</span>
                </div>
                <p className="tiny faint" style={{ margin: 0 }}>
                  Mesurée sur les fenêtres de 10 minutes en régime aérobie stable. Sur une séance courte ou
                  très fractionnée, elle n'est pas calculable.
                </p>
              </div>
            </Card>

            <Card title="Conditions">
              <div className="stack" style={{ gap: 12 }}>
                <Metric
                  label="Température"
                  value={analysis.environment.avgTempC != null ? `${num(analysis.environment.avgTempC)} °C` : '—'}
                  note={analysis.environment.heatStressFactor > 1.02 ? `coût majoré de ${num((analysis.environment.heatStressFactor - 1) * 100)} %` : 'conditions neutres'}
                />
                <div className="row-between small">
                  <span className="faint">Altitude moyenne</span>
                  <span className="mono">{analysis.environment.avgAltitudeM != null ? `${num(analysis.environment.avgAltitudeM)} m` : '—'}</span>
                </div>
                <div className="row-between small">
                  <span className="faint">Cadence moyenne</span>
                  <span className="mono">{a.averageCadenceSpm ? `${num(a.averageCadenceSpm)} ppm` : '—'}</span>
                </div>
                {analysis.compliance && (
                  <div style={{ paddingTop: 10, borderTop: '1px solid var(--border)' }}>
                    <div className="metric-label" style={{ marginBottom: 4 }}>Conformité au plan</div>
                    <Badge tone={analysis.compliance.verdict === 'on_target' ? 'good' : 'watch'}>{analysis.compliance.verdict}</Badge>
                    <p className="tiny muted" style={{ marginTop: 6, marginBottom: 0 }}>{analysis.compliance.detail}</p>
                  </div>
                )}
              </div>
            </Card>
          </div>
        </>
      )}
    </>
  );
}
