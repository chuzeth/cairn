'use client';
import { useCallback, useEffect, useState } from 'react';
import { frDate, get, num, post, type StateResponse } from '@/lib/api';
import { Badge, Card, ErrorBox, Loading, Metric } from '@/components/ui';
import { DurationCurve } from '@/components/charts';

interface Curves {
  vitesse_graduee_par_duree_kmh: Record<string, number>;
  vam_par_duree_m_par_h: Record<string, number>;
  vitesse_critique: { retenue_kmh: number; ajustement_terrain_kmh: number | null; d_prime_m: number; qualite_ajustement: string; r2: number };
  note: string;
}

const PROVENANCE_LABEL: Record<string, string> = {
  lab: 'mesuré en laboratoire',
  field: 'estimé depuis le terrain',
  blended: 'laboratoire + terrain',
  default: 'valeur par défaut',
};
const PROVENANCE_TONE: Record<string, string | undefined> = {
  lab: 'good', field: 'metabolic', blended: undefined, default: 'watch',
};

const DIRECTIVE_LABELS: Record<string, string> = {
  session_duration: 'Durée de séance imposée',
  success_criterion: 'Critère de réussite',
  weekly_frequency: 'Fréquence hebdomadaire',
  cadence_target: 'Cible de cadence',
  interval_policy: 'Politique de fractionné',
};

const AMBITION_LABELS: Record<string, string> = {
  trail_long: 'trail long',
  trail_court: 'trail court',
  route: 'route',
  ultra: 'ultra',
};

/** Convertit « 5 min », « 1 h », « 30 s » en secondes, pour retracer les courbes. */
function parseDurationLabel(label: string): number {
  const m = /^([\d.]+)\s*(s|min|h)$/.exec(label.trim());
  if (!m) return NaN;
  const v = Number(m[1]);
  return m[2] === 'h' ? v * 3600 : m[2] === 'min' ? v * 60 : v;
}

export default function PhysiologyPage() {
  const [state, setState] = useState<StateResponse | null>(null);
  const [curves, setCurves] = useState<Curves | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [rebuilding, setRebuilding] = useState(false);

  const load = useCallback(async () => {
    try {
      const s = await get<StateResponse>('/api/state');
      setState(s);
      // Les courbes exigent un historique analysé : leur absence n'est pas une
      // erreur, simplement une donnée pas encore disponible.
      setCurves(await get<Curves>('/api/curves').catch(() => null));
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const rebuild = async () => {
    setRebuilding(true);
    try { await post('/api/model/rebuild'); await load(); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    finally { setRebuilding(false); }
  };

  if (error) return <ErrorBox error={error} onRetry={load} />;
  if (!state) return <Loading />;

  const m = state.model;
  const lab = state.labTest as Record<string, any> | null;
  const vamPoints = Object.entries(m.vamCurve ?? {})
    .map(([k, v]) => ({ durationS: Number(k), value: v }))
    .filter((p) => Number.isFinite(p.durationS) && p.value > 0);

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Physiologie</h1>
          <p className="page-sub">
            Modèle du {frDate(m.asOf, { long: true, year: true })} · confiance {num(m.confidence * 100)} % ·
            {' '}chaque paramètre indique s'il vient du laboratoire ou du terrain
            {/* L'âge de la dernière preuve d'effort maximal explique à lui seul
                l'essentiel de la confiance : sans effort au seuil récent, la
                vitesse critique repose sur une extrapolation de footings. */}
            {m.criticalSpeedEvidence && (
              <>
                <br />
                {m.criticalSpeedEvidence.lastProofAgeDays == null
                  ? "Aucun effort maximal identifié dans la courbe : la vitesse critique n'est pas mesurée."
                  : `Dernier effort maximal il y a ${num(m.criticalSpeedEvidence.lastProofAgeDays)} j — la vitesse critique s'appuie dessus à ${num(m.criticalSpeedEvidence.support * 100)} %.`}
              </>
            )}
          </p>
        </div>
        <button className="btn" onClick={rebuild} disabled={rebuilding}>
          {rebuilding ? <><span className="spinner" /> Recalcul…</> : 'Recalculer le modèle'}
        </button>
      </div>

      {/* L'ambition n'est pas une course : elle n'a pas de date et ne se coche
          pas. Elle décide de ce que le plan privilégie, donc elle se lit ici,
          au-dessus des chiffres qu'elle hiérarchise. */}
      {state.athlete.ambition && (
        <Card style={{ marginBottom: 14 }}>
          <div className="row wrap" style={{ gap: 8, alignItems: 'baseline' }}>
            <strong>Ambition — {AMBITION_LABELS[state.athlete.ambition.format] ?? state.athlete.ambition.format}</strong>
            <span className="tiny faint">au dossier depuis le {frDate(state.athlete.ambition.since, { long: true, year: true })}</span>
          </div>
          <div className="stack" style={{ gap: 4, marginTop: 6 }}>
            {state.athlete.ambition.origin.map((o, i) => (
              <div key={i} className="small muted">
                « {o.quote} »
                <span className="tiny faint">
                  {' — '}{o.source === 'lab_test' ? o.author ?? "test d'effort" : 'toi'}, {frDate(o.date, { long: true, year: true })}
                </span>
              </div>
            ))}
          </div>
          <p className="tiny faint" style={{ marginTop: 8, marginBottom: 0 }}>
            Sur ce format, c'est la durabilité qui décide — la perte de rendement par heure et par
            1 000 m de D+. Le plan privilégie donc les efforts assez longs pour la construire, et
            assez longs pour la mesurer.
          </p>
        </Card>
      )}

      <div className="grid grid-4" style={{ marginBottom: 14 }}>
        <Card>
          <Metric label="Vitesse critique" value={num(m.criticalSpeedKmh, 2)} unit="km/h" note={`${m.criticalPace}/km · D' ${num(m.dPrimeM)} m`} tone="metabolic" />
          <Badge tone={PROVENANCE_TONE[m.provenance.criticalSpeedMs ?? 'default']}>{PROVENANCE_LABEL[m.provenance.criticalSpeedMs ?? 'default']}</Badge>
        </Card>
        <Card>
          <Metric label="VMA" value={num(m.vmaKmh, 1)} unit="km/h" note={`VO2max ${num(m.vo2maxRel, 1)} ml/kg/min`} />
          <Badge tone={PROVENANCE_TONE[m.provenance.vmaMs ?? 'default']}>{PROVENANCE_LABEL[m.provenance.vmaMs ?? 'default']}</Badge>
        </Card>
        <Card>
          <Metric label="Seuil 2 (anaérobie)" value={num(m.vt2Kmh, 1)} unit="km/h" note={`${num(m.vt2.hr)} bpm`} tone="watch" />
          <Badge tone={PROVENANCE_TONE[m.provenance['vt2.hr'] ?? 'default']}>{PROVENANCE_LABEL[m.provenance['vt2.hr'] ?? 'default']}</Badge>
        </Card>
        <Card>
          <Metric label="Seuil 1 (aérobie)" value={num(m.vt1Kmh, 1)} unit="km/h" note={`${num(m.vt1.hr)} bpm`} />
          <Badge tone={PROVENANCE_TONE[m.provenance['vt1.hr'] ?? 'default']}>{PROVENANCE_LABEL[m.provenance['vt1.hr'] ?? 'default']}</Badge>
        </Card>
      </div>

      <div className="grid grid-2" style={{ marginBottom: 14 }}>
        <Card title="Zones d'entraînement" hint="Calibrées sur tes seuils actuels — elles évoluent avec toi.">
          {/* Le moteur tire le SV2 de la vitesse critique en la divisant par 1,02 :
              le bas de Z4 est donc toujours sous l'asymptote, c'est-à-dire à une
              intensité qui a un état stable. La grille reste celle du compte
              rendu ; ce que le plancher ne dit pas est dit ici, et les séances de
              seuil se calent sur la vitesse critique, pas sur lui. */}
          {state.zones.some((z) => z.key === 'Z4' && z.speedMinKmh < m.criticalSpeedKmh) && (
            <p className="tiny muted" style={{ marginTop: 0 }}>
              Le plancher de Z4 ({num(state.zones.find((z) => z.key === 'Z4')!.speedMinKmh, 1)} km/h)
              passe sous ta vitesse critique ({num(m.criticalSpeedKmh, 1)} km/h) : c’est la grille de ton
              compte rendu, qui la fixe au SV2. En dessous de la vitesse critique l’effort a un état stable —
              les séances de seuil se calent donc sur elle, pas sur ce plancher.
            </p>
          )}
          <table>
            <thead><tr><th>Zone</th><th>Objectif</th><th className="right">FC</th><th className="right">Allure</th></tr></thead>
            <tbody>
              {state.zones.map((z) => (
                <tr key={z.key}>
                  <td>
                    <div className="row" style={{ gap: 7 }}>
                      <span className="legend-swatch" style={{ background: `var(--${z.key.toLowerCase()})`, width: 10, height: 10 }} />
                      <strong className="small">{z.key}</strong>
                    </div>
                    <div className="tiny faint">{z.label}</div>
                  </td>
                  <td className="tiny muted" style={{ maxWidth: 260 }}>{z.purpose}</td>
                  <td className="right mono tiny">
                    {/* La première zone n'a pas de borne basse : on l'écrit comme telle
                        plutôt que d'afficher un zéro ou un tiret trompeur. */}
                    {z.hrMin > 0 ? `${num(z.hrMin)} – ${num(z.hrMax)}` : `< ${num(z.hrMax)}`}
                  </td>
                  <td className="right mono tiny">
                    {/* Et la dernière n'a pas de borne haute que quoi que ce soit de
                        mesuré fonde : elle valait 1,3 × VMA, soit 23,4 km/h pour une
                        VMA estimée à 18,0. Une zone ouverte se dit ouverte. */}
                    {z.paceMin == null
                      ? `< ${z.paceMax}`
                      : z.speedMinKmh > 0
                        ? `${z.paceMin} – ${z.paceMax}`
                        : `> ${z.paceMin}`}
                    <div className="tiny faint" style={{ marginTop: 2 }}>
                      {PROVENANCE_LABEL[z.speedProvenance] ?? z.speedProvenance}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>

        <Card title="Durabilité et descente" hint="Les deux qualités qui décident d'un trail, et que la VO2max ne dit pas.">
          <div className="grid grid-2" style={{ marginBottom: 14 }}>
            <div>
              <Metric label="Perte de rendement" value={num(m.durabilityPctPerHour, 1)} unit="%/h" tone={m.durabilityPctPerHour < 3 ? 'good' : 'watch'} />
              <Badge tone={PROVENANCE_TONE[m.provenance.durabilityPctPerHour ?? 'default']}>{PROVENANCE_LABEL[m.provenance.durabilityPctPerHour ?? 'default']}</Badge>
            </div>
            <div>
              <Metric label="Par 1 000 m D+" value={num(m.durabilityPctPer1000mVert, 1)} unit="%" />
              <Badge tone={PROVENANCE_TONE[m.provenance.durabilityPctPer1000mVert ?? 'default']}>{PROVENANCE_LABEL[m.provenance.durabilityPctPer1000mVert ?? 'default']}</Badge>
            </div>
          </div>
          <div className="grid grid-2">
            <Metric label="Aisance en descente" value={num(m.descentSkill ?? 1, 2)} note="1,00 = bon trailer de référence" tone={(m.descentSkill ?? 1) >= 1 ? 'good' : 'watch'} />
            <Metric label="FC max / repos" value={`${num(m.hrMax)} / ${num(m.hrRest)}`} unit="bpm" note={`réserve ${num(m.hrMax - m.hrRest)} bpm`} />
          </div>
          <p className="tiny faint" style={{ marginTop: 14, marginBottom: 0 }}>
            La durabilité mesure la vitesse à laquelle ton rendement s'effondre au fil de l'effort. C'est le
            troisième pilier de la performance d'endurance, après la VO2max et l'économie de course — et le plus
            entraînable des trois.
          </p>
        </Card>
      </div>

      {curves && Object.keys(curves.vitesse_graduee_par_duree_kmh).length > 2 && (
        <Card
          title="Courbe vitesse-durée"
          hint={`Vitesse critique retenue ${num(curves.vitesse_critique.retenue_kmh, 2)} km/h · D' ${num(curves.vitesse_critique.d_prime_m)} m · ajustement ${curves.vitesse_critique.qualite_ajustement}`}
          style={{ marginBottom: 14 }}
        >
          <DurationCurve
            points={Object.entries(curves.vitesse_graduee_par_duree_kmh)
              .map(([k, v]) => ({ durationS: parseDurationLabel(k), value: v }))
              .filter((p) => Number.isFinite(p.durationS))}
            color="var(--metabolic)"
            unit="km/h"
            label="Meilleure vitesse corrigée de la pente"
          />
          <p className="tiny faint" style={{ marginTop: 8, marginBottom: 0 }}>{curves.note}</p>
        </Card>
      )}

      {vamPoints.length > 2 && (
        <Card title="Courbe de grimpeur" hint="Meilleure vitesse ascensionnelle soutenue, par durée." style={{ marginBottom: 14 }}>
          <DurationCurve points={vamPoints} color="var(--mechanical)" unit="m D+/h" label="Vitesse ascensionnelle" />
        </Card>
      )}

      {lab && (
        <Card title="Test d'effort de référence" hint={`${lab.lab} · ${frDate(lab.date, { long: true, year: true })}`}>
          <div className="grid grid-4" style={{ marginBottom: 16 }}>
            <Metric label="VO2max" value={num(lab.vo2maxRel, 1)} unit="ml/kg/min" note={`${num(lab.vo2maxAbs, 2)} L/min`} />
            <Metric label="VMA" value={num(lab.vmaMs * 3.6, 1)} unit="km/h" />
            <Metric label="FC max" value={num(lab.hrMax)} unit="bpm" note={`QR max ${num(lab.rerMax, 2)}`} />
            <Metric label="Masse" value={num(lab.bodyMassKg, 1)} unit="kg" note={`${num(lab.bodyFatPct, 1)} % de masse grasse`} />
          </div>

          <div className="grid grid-2" style={{ marginBottom: 16 }}>
            <div>
              <div className="metric-label" style={{ marginBottom: 6 }}>Seuils mesurés</div>
              <table>
                <tbody>
                  <tr><td>Seuil ventilatoire 1</td><td className="right mono">{num(lab.vt1.speedMs * 3.6, 1)} km/h</td><td className="right mono">{num(lab.vt1.hr)} bpm</td></tr>
                  <tr><td>Seuil ventilatoire 2</td><td className="right mono">{num(lab.vt2.speedMs * 3.6, 1)} km/h</td><td className="right mono">{num(lab.vt2.hr)} bpm</td></tr>
                </tbody>
              </table>
            </div>
            <div>
              <div className="metric-label" style={{ marginBottom: 6 }}>Ventilation</div>
              <table>
                <tbody>
                  <tr><td>Capacité vitale</td><td className="right mono">{num(lab.vitalCapacityL, 1)} L</td></tr>
                  <tr><td>Débit ventilatoire max</td><td className="right mono">{num(lab.veMaxLMin, 1)} L/min</td></tr>
                  <tr><td>Fréquence respiratoire max</td><td className="right mono">{num(lab.respRateMax)} cycles/min</td></tr>
                  <tr><td>Coefficient d'utilisation pulmonaire</td><td className="right mono">{num(lab.pulmonaryUseCoefPct)} %</td></tr>
                </tbody>
              </table>
            </div>
          </div>

          {Array.isArray(lab.practitionerNotes) && (
            <div style={{ marginBottom: 14 }}>
              <div className="metric-label" style={{ marginBottom: 6 }}>Remarques du préparateur</div>
              <ul className="small muted" style={{ margin: 0, paddingLeft: 18 }}>
                {lab.practitionerNotes.map((n: string, i: number) => <li key={i}>{n}</li>)}
              </ul>
            </div>
          )}

          {lab.interpretation && (
            <div>
              <div className="metric-label" style={{ marginBottom: 6 }}>Interprétation</div>
              <p className="small muted" style={{ margin: 0 }}>{lab.interpretation}</p>
            </div>
          )}
        </Card>
      )}

      {/* Ce que le planificateur retient de cette prose. Sans cette liste,
          l'interprétation est un texte qu'on lit ; avec elle, c'est un texte
          qui agit — et l'athlète voit lequel de ses passages agit. */}
      {state.directives?.length > 0 && (
        <Card
          title="Ce que le plan honore du dossier"
          hint="Chaque consigne porte l'extrait qui la fonde."
          style={{ marginTop: 14 }}
        >
          <div className="stack" style={{ gap: 12 }}>
            {state.directives.map((d) => (
              <div key={d.id} style={{ borderLeft: '2px solid var(--border-strong)', paddingLeft: 10 }}>
                <div className="row wrap" style={{ gap: 8 }}>
                  <strong className="small">{DIRECTIVE_LABELS[d.kind] ?? d.kind}</strong>
                  <Badge>{d.origin.source === 'lab_test' ? "test d'effort" : 'notes du dossier'}</Badge>
                  <span className="tiny faint">{frDate(d.origin.date, { long: true, year: true })}</span>
                </div>
                <div className="small muted" style={{ marginTop: 3 }}>« {d.origin.quote} »</div>
                {d.derived && (
                  <div className="tiny faint" style={{ marginTop: 3 }}>
                    Part du planificateur : {d.derived}
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}
    </>
  );
}
