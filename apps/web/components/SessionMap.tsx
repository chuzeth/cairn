'use client';
import { useEffect, useRef } from 'react';
import type { Map as LeafletMap, PolylineOptions } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { SessionRoute, TerrainPoint } from '@cairn/core';
import { directionsUrl, mapUrl } from '@cairn/core/terrain';
import type { SessionRow } from '@/lib/api';

/**
 * La carte d'une séance de terrain.
 *
 * Avec un itinéraire, elle le trace entier, de chez Pierre à chez lui : l'accès,
 * les détours et le retour en blanc pierre — les détours en pointillé —, ce
 * qui monte et se répète à l'ocre. Sans itinéraire, le tracé des montées que
 * Pierre a couru, et un lien vers Plans pour s'y rendre à pied. Le tracé d'une
 * montée est sa trace GPS ; celui d'un trajet vient du moteur d'itinéraire.
 * Chaque point clé s'ouvre dans Plans par une épingle.
 *
 * Leaflet, et rien d'autre : quarante kilo-octets compressés, sans dépendance,
 * chargés seulement quand une séance a un tracé. Une carte vectorielle en pèse
 * cinq fois plus pour des tuiles dont on n'a pas l'usage.
 */

type Block = SessionRow['blocks'][number];

const ROLE: Record<TerrainPoint['role'], string> = { pied: 'Pied', haut: 'Haut', 'demi-tour': 'Demi-tour' };

/** Les points clés d'une séance, un par rôle, dans l'ordre où on les atteint : le premier est le départ. */
export function keyPoints(blocks: readonly Block[]): TerrainPoint[] {
  const out: TerrainPoint[] = [];
  for (const b of blocks) {
    if (!b.where) continue;
    for (const p of [b.where.from, b.where.to]) if (!out.some((q) => q.role === p.role)) out.push(p);
  }
  return out;
}

interface Line {
  track: [number, number][];
  tone: 'climb' | 'reps' | 'walk' | 'detour';
}

/** Les tracés : ceux de l'itinéraire, ou à défaut ceux des montées — ce qui monte par-dessus. */
function lines(blocks: readonly Block[], route?: SessionRoute | null): Line[] {
  const order = { walk: 0, detour: 1, climb: 2, reps: 3 };
  const out: Line[] = route
    ? route.legs.flatMap((l): Line[] =>
        l.track.length >= 2
          ? [{
              track: l.track,
              tone: l.kind === 'detour' ? 'detour' : l.kind === 'access' || l.kind === 'home' ? 'walk' : 'climb',
            }]
          : [],
      )
    : [];
  for (const b of blocks) {
    // Le tronçon des répétitions se dessine toujours par-dessus, en blanc pierre.
    if (b.where?.track && b.where.track.length >= 2 && (route ? (b.repeat ?? 0) > 1 : true)) {
      out.push({ track: b.where.track, tone: (b.repeat ?? 0) > 1 ? 'reps' : 'climb' });
    }
  }
  return out.sort((a, b) => order[a.tone] - order[b.tone]);
}

const token = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function SessionMap({ blocks, route }: { blocks: readonly Block[]; route?: SessionRoute | null }) {
  const ref = useRef<HTMLDivElement>(null);
  const tracks = lines(blocks, route);
  const points = keyPoints(blocks);
  const start = points[0];
  const home = route?.home.at;
  // La carte se refait quand le tracé change, pas à chaque rendu de l'écran.
  const shape = JSON.stringify([tracks, points.map((p) => [p.role, p.at]), home]);

  useEffect(() => {
    const el = ref.current;
    if (!el || tracks.length === 0) return;
    let map: LeafletMap | null = null;
    let gone = false;
    void import('leaflet').then(({ default: L }) => {
      if (gone) return;
      // Sur le téléphone, un doigt fait défiler la page, pas la carte : elle
      // montre la séance entière, et se zoome à deux doigts.
      map = L.map(el, {
        zoomControl: false,
        scrollWheelZoom: false,
        dragging: !L.Browser.mobile,
        attributionControl: true,
        // Au quart de niveau : le tracé remplit la carte au lieu d'y flotter.
        zoomSnap: 0.25,
      });
      map.attributionControl.setPrefix(false);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      const ochre = token('--ochre', '#d6a15c');
      const stone = token('--text', '#ece8df');
      const dim = token('--text-dim', '#98a09c');
      const slate = token('--bg', '#0e1316');
      const style: Record<Line['tone'], PolylineOptions> = {
        walk: { color: dim, weight: 3, opacity: 0.9 },
        detour: { color: dim, weight: 3, opacity: 0.9, dashArray: '5 7' },
        climb: { color: ochre, weight: 5, opacity: 0.85 },
        reps: { color: stone, weight: 4, opacity: 0.95 },
      };
      const all: [number, number][] = [];
      for (const t of tracks) {
        L.polyline(t.track, style[t.tone]).addTo(map);
        all.push(...t.track);
      }
      points.forEach((p, i) => {
        const first = i === 0 && !home;
        L.circleMarker(p.at, { radius: 6, weight: 2, color: slate, fillColor: first ? stone : ochre, fillOpacity: 1 })
          .bindTooltip(first ? `${ROLE[p.role]} · départ` : ROLE[p.role], {
            // Sur l'itinéraire entier, le haut et le pied tiennent dans quelques
            // pixels : l'un au-dessus, l'autre en dessous. Sinon, du côté où il y
            // a de la place — une étiquette au bord droit sortirait de la carte.
            permanent: true,
            direction: home ? (p.role === 'haut' ? 'top' : p.role === 'pied' ? 'bottom' : 'auto') : 'auto',
            className: 'm-map-tip',
          })
          .addTo(map!);
        all.push(p.at);
      });
      if (home) {
        L.circleMarker(home, { radius: 6, weight: 2, color: slate, fillColor: stone, fillOpacity: 1 })
          // Au-dessus : le pied, souvent à quelques centaines de mètres, a son étiquette en dessous.
          .bindTooltip('Chez toi', { permanent: true, direction: 'top', className: 'm-map-tip' })
          .addTo(map);
        all.push(home);
      }
      map.fitBounds(L.latLngBounds(all), { padding: [28, 28], maxZoom: 17 });
    });
    return () => {
      gone = true;
      map?.remove();
    };
    // `shape` résume `tracks`, `points` et le domicile : c'est lui qui dit quand la carte change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  if (tracks.length === 0) return null;
  return (
    <div className="m-map-wrap">
      <div
        ref={ref}
        className="m-map"
        data-route={route ? 'true' : undefined}
        role="img"
        aria-label={`Carte ${route ? 'de l’itinéraire' : 'du tracé'} : ${[...(route ? ['chez toi'] : []), ...points.map((p) => ROLE[p.role])].join(', ')}`}
      />
      <ol className="m-map-points">
        {points.map((p, i) => (
          <li key={p.role}>
            <a href={mapUrl(p)} className="m-inline" target="_blank" rel="noreferrer">{ROLE[p.role]}</a>
            {i === 0 && !route && <span className="m-faint"> · départ</span>}
            {p.address && <> — {p.address}</>}
          </li>
        ))}
      </ol>
      {start && !route && (
        <a className="m-map-go" href={directionsUrl(start)} target="_blank" rel="noreferrer">
          Itinéraire à pied jusqu&apos;au départ
        </a>
      )}
    </div>
  );
}
