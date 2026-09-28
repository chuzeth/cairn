'use client';
import { useEffect, useState } from 'react';
import type { RouteLeg, SessionRoute } from '@cairn/core';
import { toGpx } from '@cairn/core/gpx';
import { get, nbsp, num, prime, put, spelledDuration } from '@/lib/api';

/**
 * L'itinéraire de porte à porte d'une séance de terrain.
 *
 * De chez soi à chez soi, segment par segment : ce que chacun dure, parcourt,
 * monte et descend, et ses indications, une par ligne. Les segments d'un bloc
 * font la durée qu'il prescrit ; un détour nommé complète quand le chemin
 * naturel est plus court. Le trajet vient d'un moteur d'itinéraire sur
 * OpenStreetMap et des traces de Pierre, jamais d'un modèle de langage : la
 * source est dite en pied, avec de quoi signaler une erreur de carte.
 */

/** « +93 m », « −540 m », « +450 / −540 m », « à plat » : ce qu'un segment monte et descend. */
function relief(l: Pick<RouteLeg, 'gainM' | 'lossM'>): string {
  if (l.gainM > 0 && l.lossM > 0) return `+${num(l.gainM)} / −${num(l.lossM)} m`;
  if (l.gainM > 0) return `+${num(l.gainM)} m`;
  if (l.lossM > 0) return `−${num(l.lossM)} m`;
  return 'à plat';
}

/** L'ocre ne dit qu'une chose : ça monte — une montée, un motif qui monte, pas trois mètres de trottoir. */
const climbs = (l: RouteLeg) => (l.kind === 'climb' || l.kind === 'motif') && l.gainM > l.lossM / 2 && l.gainM > 0;

const distance = (m: number) =>
  m >= 1000 ? `${num(m / 1000, 1)} km` : `${num(Math.round(m / 10) * 10)} m`;

/**
 * La durée d'un segment, répétitions comprises : six descentes de 3 min et
 * cinq remontées de 10 font 68 min, et c'est ce que le bloc prescrit. Une
 * moyenne par répétition — « 6 × 11′20″ » — ne correspondrait à rien qu'on court.
 */
const legTime = (l: RouteLeg): string => prime(l.durationS) || '—';

/** Télécharge l'itinéraire en GPX, construit dans le téléphone : rien ne part vers le Mac ni ailleurs. */
function downloadGpx(route: SessionRoute, date: string, title: string) {
  const blob = new Blob([toGpx(route, `${title} — ${date}`)], { type: 'application/gpx+xml' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `cairn-${date}.gpx`;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function Itinerary({
  route, date, title, onHomeSaved,
}: {
  route: SessionRoute;
  date: string;
  title: string;
  onHomeSaved?: () => void;
}) {
  const [editing, setEditing] = useState(false);
  return (
    <section className="route" aria-label="Itinéraire de porte à porte">
      <p className="route-head">
        De chez toi, {route.home.address}, à chez toi : {spelledDuration(route.durationS)}, {distance(route.distanceM)},{' '}
        {relief(route)}.
      </p>
      <ol className="route-legs">
        {route.legs.map((l, i) => (
          <li className="route-leg" key={i} data-kind={l.kind}>
            <div className="route-leg-head">
              <span className="route-leg-time" data-climb={climbs(l)}>{legTime(l)}</span>
              <span className="route-leg-label">
                {nbsp(l.label)}
                <span className="m-faint">
                  {l.repeat && l.repeat > 1 ? <> · {l.repeat}&nbsp;fois</> : null}
                  {l.distanceM > 0 && <> · {distance(l.distanceM)}</>} · {relief(l)}
                  {l.unmeasuredM ? <> · relief non mesuré sur {distance(l.unmeasuredM)}</> : null}
                </span>
              </span>
            </div>
            <ol className="route-steps">
              {l.steps.map((s, j) => (
                <li key={j}>
                  <span>{nbsp(s.text)}</span>
                  {s.distanceM > 0 && <span className="route-step-m">{distance(s.distanceM)}</span>}
                </li>
              ))}
            </ol>
          </li>
        ))}
      </ol>
      {route.notes.map((n, i) => (
        <p className="route-note" key={i}>{nbsp(n)}</p>
      ))}
      <div className="route-actions">
        <button type="button" className="m-map-go" onClick={() => downloadGpx(route, date, title)}>
          Exporter la trace en GPX
        </button>
        <button type="button" className="m-more" aria-expanded={editing} onClick={() => setEditing((e) => !e)}>
          {editing ? 'fermer' : 'changer le départ'}
        </button>
      </div>
      {editing && <HomeForm current={route.home.address} onSaved={() => { setEditing(false); onHomeSaved?.(); }} />}
      <p className="route-source">
        Trajet : OSRM, serveur de FOSSGIS, et tes traces ; noms et fond de carte : © contributeurs{' '}
        <a href="https://www.openstreetmap.org/copyright" target="_blank" rel="noreferrer">OpenStreetMap</a>.{' '}
        <a href="https://www.openstreetmap.org/fixthemap" target="_blank" rel="noreferrer">Signaler une erreur de carte</a>.
      </p>
    </section>
  );
}

/**
 * Le domicile, d'où partent les itinéraires.
 *
 * L'adresse se dit comme on la dit ; la position vient du téléphone — « je suis
 * chez moi » — ou se tape. Rien n'est géocodé : l'adresse ne part vers aucun
 * service, et la position ne quitte Cairn que vers le moteur d'itinéraire.
 */
export function HomeForm({ current, onSaved }: { current?: string | null; onSaved?: () => void }) {
  const [address, setAddress] = useState(current ?? '');
  const [lat, setLat] = useState('');
  const [lng, setLng] = useState('');
  const [state, setState] = useState<{ busy?: boolean; error?: string; done?: boolean }>({});

  // Le domicile enregistré, pour n'en changer qu'une partie : il vient de Cairn,
  // pas d'un service.
  useEffect(() => {
    let gone = false;
    get<{ home: { at: [number, number]; address: string } | null }>('/api/home')
      .then(({ home }) => {
        if (gone || !home) return;
        setAddress((a) => a || home.address);
        setLat((v) => v || home.at[0].toFixed(6).replace('.', ','));
        setLng((v) => v || home.at[1].toFixed(6).replace('.', ','));
      })
      .catch(() => undefined);
    return () => {
      gone = true;
    };
  }, []);

  const locate = () => {
    if (!navigator.geolocation) {
      setState({ error: 'Ce navigateur ne donne pas sa position : tape-la.' });
      return;
    }
    setState({ busy: true });
    navigator.geolocation.getCurrentPosition(
      (p) => {
        setLat(p.coords.latitude.toFixed(6));
        setLng(p.coords.longitude.toFixed(6));
        setState({});
      },
      () => setState({ error: 'Position refusée ou introuvable : tape-la, ou réessaie dehors.' }),
      { enableHighAccuracy: true, timeout: 15_000 },
    );
  };

  const save = async () => {
    setState({ busy: true });
    try {
      await put('/api/home', { address, lat: Number(lat.replace(',', '.')), lng: Number(lng.replace(',', '.')) });
      setState({ done: true });
      onSaved?.();
    } catch (e) {
      setState({ error: e instanceof Error ? e.message : String(e) });
    }
  };

  return (
    <form
      className="home-form"
      onSubmit={(e) => {
        e.preventDefault();
        void save();
      }}
    >
      <label>
        <span className="m-label">Ton adresse, comme tu la dis</span>
        <input value={address} onChange={(e) => setAddress(e.target.value)} maxLength={120} autoComplete="off" />
      </label>
      <div className="home-form-at">
        <label>
          <span className="m-label">Latitude</span>
          <input value={lat} onChange={(e) => setLat(e.target.value)} inputMode="decimal" placeholder="en degrés" />
        </label>
        <label>
          <span className="m-label">Longitude</span>
          <input value={lng} onChange={(e) => setLng(e.target.value)} inputMode="decimal" placeholder="en degrés" />
        </label>
      </div>
      <div className="route-actions">
        <button type="button" className="m-map-go" onClick={locate} disabled={state.busy}>
          Je suis chez moi : prendre ma position
        </button>
        <button type="submit" className="m-map-go" disabled={state.busy || !address.trim() || !lat || !lng}>
          Enregistrer
        </button>
      </div>
      {state.error && <p className="route-note" data-warn>{state.error}</p>}
      {state.done && (
        <p className="route-note">
          Enregistré. Les itinéraires se refont en arrière-plan : ils apparaissent à la prochaine ouverture.
        </p>
      )}
      <p className="route-source">
        L&apos;adresse n&apos;est envoyée nulle part ; la position ne part que vers le moteur d&apos;itinéraire.
      </p>
    </form>
  );
}
