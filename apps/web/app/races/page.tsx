'use client';
import { useCallback, useEffect, useState } from 'react';
import { clock, del, frDate, get, post, todayIso, type RaceRow } from '@/lib/api';
import { Badge, Card, ErrorBox, Loading, Metric } from '@/components/ui';

interface Prediction {
  course: string;
  temps_predit: string;
  intervalle_80pct: [string, string];
  distance_equivalente_plat_km: number;
  fraction_vitesse_critique: number;
  probabilite_objectif_pct: number | null;
  objectif_temps: string | null;
  facteurs: Record<string, number>;
  plan_allure: {
    troncon: string; denivele_pos_m: number; denivele_neg_m: number; pente_pct: number;
    allure_cible: string; vam_cible_mh: number | null; fc_cible: [number, number];
    duree: string; temps_cumule: string; cue: string;
  }[];
  ravitaillement: { carbGPerHour: number; fluidMlPerHour: number; sodiumMgPerHour: number; totalCarbG: number };
  facteurs_limitants: { facteur: string; gain_potentiel: string; explication: string }[];
}

const EMPTY_FORM = {
  name: '', date: '', priority: 'A' as 'A' | 'B' | 'C',
  distance_km: '', elevation_gain_m: '', elevation_loss_m: '',
  technicality: '3', expected_temp_c: '', target_placing: '', target_time_h: '', notes: '',
};

export default function RacesPage() {
  const [races, setRaces] = useState<RaceRow[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState(EMPTY_FORM);
  const [showForm, setShowForm] = useState(false);
  const [saving, setSaving] = useState(false);
  const [prediction, setPrediction] = useState<{ raceId: string; data: Prediction } | null>(null);
  const [predicting, setPredicting] = useState<string | null>(null);
  const [building, setBuilding] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    try { setRaces(await get<RaceRow[]>('/api/races')); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, []);
  useEffect(() => { void load(); }, [load]);

  const submit = async () => {
    setSaving(true);
    setNotice(null);
    try {
      const gain = Number(form.elevation_gain_m) || 0;
      await post('/api/races', {
        name: form.name,
        date: form.date,
        priority: form.priority,
        distance_km: Number(form.distance_km) || 0,
        elevation_gain_m: gain,
        elevation_loss_m: Number(form.elevation_loss_m) || gain,
        technicality: Number(form.technicality) || 3,
        expected_temp_c: form.expected_temp_c ? Number(form.expected_temp_c) : undefined,
        target_placing: form.target_placing ? Number(form.target_placing) : undefined,
        target_time_s: form.target_time_h ? Math.round(Number(form.target_time_h) * 3600) : undefined,
        notes: form.notes || undefined,
      });
      setForm(EMPTY_FORM);
      setShowForm(false);
      await load();
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const predict = async (raceId: string) => {
    setPredicting(raceId);
    setNotice(null);
    try {
      const data = await post<Prediction>('/api/predict', { race_id: raceId });
      setPrediction({ raceId, data });
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setPredicting(null);
    }
  };

  const buildPlan = async (raceId: string, name: string) => {
    setBuilding(raceId);
    setNotice(null);
    try {
      const result = await post<{ semaines: number; temps_predit: string }>('/api/plan/rebuild', {
        race_id: raceId,
        reason: `Plan construit depuis l'interface pour « ${name} ».`,
      });
      setNotice(`Plan reconstruit : ${result.semaines} semaines jusqu'à « ${name} ». Temps prédit ${result.temps_predit}.`);
    } catch (e) {
      setNotice(e instanceof Error ? e.message : String(e));
    } finally {
      setBuilding(null);
    }
  };

  if (error) return <ErrorBox error={error} onRetry={load} />;

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Objectifs</h1>
          <p className="page-sub">Chaque course enregistrée peut servir de cible à une préparation complète.</p>
        </div>
        <button className="btn" data-variant="primary" onClick={() => setShowForm((v) => !v)}>
          {showForm ? 'Annuler' : 'Ajouter une course'}
        </button>
      </div>

      {notice && <div className="banner" data-tone="info"><span>{notice}</span></div>}

      {showForm && (
        <Card title="Nouvelle course" style={{ marginBottom: 14 }}>
          <div className="grid grid-3">
            <div className="field"><label>Nom</label><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Trail des Grisemottes" /></div>
            <div className="field"><label>Date</label><input type="date" value={form.date} min={todayIso()} onChange={(e) => setForm({ ...form, date: e.target.value })} /></div>
            <div className="field">
              <label>Priorité</label>
              <select value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value as 'A' | 'B' | 'C' })}>
                <option value="A">A — objectif principal</option>
                <option value="B">B — objectif intermédiaire</option>
                <option value="C">C — course de préparation</option>
              </select>
            </div>
            <div className="field"><label>Distance (km)</label><input type="number" step="0.1" value={form.distance_km} onChange={(e) => setForm({ ...form, distance_km: e.target.value })} placeholder="32" /></div>
            <div className="field"><label>D+ (m)</label><input type="number" value={form.elevation_gain_m} onChange={(e) => setForm({ ...form, elevation_gain_m: e.target.value })} placeholder="1200" /></div>
            <div className="field"><label>D− (m)</label><input type="number" value={form.elevation_loss_m} onChange={(e) => setForm({ ...form, elevation_loss_m: e.target.value })} placeholder="égal au D+ si vide" /></div>
            <div className="field">
              <label>Technicité</label>
              <select value={form.technicality} onChange={(e) => setForm({ ...form, technicality: e.target.value })}>
                <option value="1">1 — piste roulante</option>
                <option value="2">2 — chemin large</option>
                <option value="3">3 — sentier classique</option>
                <option value="4">4 — technique</option>
                <option value="5">5 — alpin très technique</option>
              </select>
            </div>
            <div className="field"><label>Température attendue (°C)</label><input type="number" value={form.expected_temp_c} onChange={(e) => setForm({ ...form, expected_temp_c: e.target.value })} placeholder="14" /></div>
            <div className="field"><label>Classement visé</label><input type="number" value={form.target_placing} onChange={(e) => setForm({ ...form, target_placing: e.target.value })} placeholder="10" /></div>
            <div className="field"><label>Temps cible (heures)</label><input type="number" step="0.05" value={form.target_time_h} onChange={(e) => setForm({ ...form, target_time_h: e.target.value })} placeholder="3.0" /></div>
          </div>
          <div className="field"><label>Notes</label><input value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Profil, ravitaillements, contexte…" /></div>
          <button className="btn" data-variant="primary" onClick={submit} disabled={saving || !form.name || !form.date || !form.distance_km}>
            {saving ? <span className="spinner" /> : 'Enregistrer'}
          </button>
          <p className="tiny faint" style={{ marginTop: 10, marginBottom: 0 }}>
            Astuce : pour un objectif de classement, donne au coach les temps des éditions précédentes dans le chat —
            il les enregistre et convertit le rang visé en temps cible.
          </p>
        </Card>
      )}

      {!races ? (
        <Loading />
      ) : races.length === 0 ? (
        <Card><div className="empty">Aucun objectif enregistré. Ajoute une course pour lancer une préparation.</div></Card>
      ) : (
        <div className="stack">
          {races.map((r) => {
            const days = Math.round((new Date(r.date).getTime() - Date.now()) / 86_400_000);
            const active = prediction?.raceId === r.id;
            return (
              <Card key={r.id}>
                <div className="row-between wrap" style={{ marginBottom: 12 }}>
                  <div>
                    <div className="row" style={{ gap: 8 }}>
                      <h2 style={{ margin: 0, fontSize: 17, fontWeight: 620 }}>{r.name}</h2>
                      <Badge tone={r.priority === 'A' ? 'good' : undefined}>Objectif {r.priority}</Badge>
                    </div>
                    <div className="small muted" style={{ marginTop: 3 }}>
                      {frDate(r.date, { weekday: true, year: true })} · dans {days} jours ·
                      {' '}{(r.course.distanceM / 1000).toFixed(1)} km · {r.course.elevationGainM} m D+ ·
                      {' '}technicité {r.course.technicality}/5
                      {r.target?.placing ? ` · vise le top ${r.target.placing}` : ''}
                      {r.target?.timeS ? ` · cible ${clock(r.target.timeS)}` : ''}
                    </div>
                  </div>
                  <div className="row">
                    <button className="btn" onClick={() => void predict(r.id)} disabled={predicting === r.id}>
                      {predicting === r.id ? <span className="spinner" /> : 'Prédire'}
                    </button>
                    <button className="btn" data-variant="primary" onClick={() => void buildPlan(r.id, r.name)} disabled={building === r.id}>
                      {building === r.id ? <span className="spinner" /> : 'Construire le plan'}
                    </button>
                    <button className="btn" data-variant="danger" onClick={async () => { await del(`/api/races/${r.id}`); await load(); }}>
                      Supprimer
                    </button>
                  </div>
                </div>

                {active && prediction && (
                  <div style={{ paddingTop: 14, borderTop: '1px solid var(--border)' }}>
                    <div className="grid grid-4" style={{ marginBottom: 14 }}>
                      <Metric label="Temps prédit" value={prediction.data.temps_predit} note={`80 % : ${prediction.data.intervalle_80pct[0]} – ${prediction.data.intervalle_80pct[1]}`} />
                      <Metric label="Équivalent plat" value={prediction.data.distance_equivalente_plat_km.toFixed(1)} unit="km" note={`${Math.round(prediction.data.fraction_vitesse_critique * 100)} % de la vitesse critique`} />
                      <Metric
                        label="Probabilité de l'objectif"
                        value={prediction.data.probabilite_objectif_pct != null ? `${prediction.data.probabilite_objectif_pct} %` : '—'}
                        note={prediction.data.objectif_temps ? `cible ${prediction.data.objectif_temps}` : 'aucun temps cible défini'}
                        tone={prediction.data.probabilite_objectif_pct != null && prediction.data.probabilite_objectif_pct > 60 ? 'good' : 'watch'}
                      />
                      <Metric label="Glucides" value={prediction.data.ravitaillement.carbGPerHour} unit="g/h" note={`${prediction.data.ravitaillement.totalCarbG} g au total · ${prediction.data.ravitaillement.fluidMlPerHour} ml/h`} />
                    </div>

                    {prediction.data.facteurs_limitants.length > 0 && (
                      <div style={{ marginBottom: 14 }}>
                        <div className="metric-label" style={{ marginBottom: 8 }}>Ce qui te coûte du temps</div>
                        <div className="stack" style={{ gap: 8 }}>
                          {prediction.data.facteurs_limitants.map((l) => (
                            <div key={l.facteur} className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
                              <span className="mono" style={{ color: 'var(--good)', width: 62, flex: 'none', fontWeight: 600 }}>−{l.gain_potentiel}</span>
                              <div>
                                <div className="small" style={{ fontWeight: 550 }}>{l.facteur}</div>
                                <div className="tiny faint">{l.explication}</div>
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    <div className="metric-label" style={{ marginBottom: 8 }}>Plan d'allure</div>
                    <table>
                      <thead>
                        <tr><th>Tronçon</th><th className="right">D+ / D−</th><th className="right">Pente</th><th className="right">Allure</th><th className="right">VAM</th><th className="right">FC</th><th className="right">Cumul</th><th>Consigne</th></tr>
                      </thead>
                      <tbody>
                        {prediction.data.plan_allure.map((p, i) => (
                          <tr key={i}>
                            <td className="mono tiny">{p.troncon}</td>
                            <td className="right mono tiny">+{p.denivele_pos_m} / −{p.denivele_neg_m}</td>
                            <td className="right mono tiny">{p.pente_pct.toFixed(1)} %</td>
                            <td className="right mono">{p.allure_cible}</td>
                            <td className="right mono tiny">{p.vam_cible_mh ? `${p.vam_cible_mh} m/h` : '—'}</td>
                            <td className="right mono tiny">{p.fc_cible[0]}-{p.fc_cible[1]}</td>
                            <td className="right mono">{p.temps_cumule}</td>
                            <td className="tiny faint" style={{ maxWidth: 300 }}>{p.cue}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
    </>
  );
}
