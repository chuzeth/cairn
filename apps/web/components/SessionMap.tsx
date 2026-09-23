'use client';
import { useEffect, useRef } from 'react';
import type { Map as LeafletMap } from 'leaflet';
import 'leaflet/dist/leaflet.css';
import type { TerrainPoint } from '@cairn/core';
import { directionsUrl, mapUrl } from '@cairn/core/terrain';
import type { SessionRow } from '@/lib/api';

/**
 * La carte d'une séance de terrain.
 *
 * Le tracé est celui que Pierre a couru — sa trace GPS, pas un itinéraire
 * recalculé —, posé sur le fond d'OpenStreetMap. La montée entière à l'ocre,
 * comme tout ce qui monte ; le tronçon des répétitions en blanc pierre, par-dessus.
 * Chaque point clé s'ouvre dans Plans par une épingle, et le départ par un
 * itinéraire à pied.
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

/** Les tracés d'une séance : la montée entière d'abord, les répétitions ensuite, par-dessus. */
function lines(blocks: readonly Block[]): { track: [number, number][]; reps: boolean }[] {
  return blocks
    .flatMap((b) => (b.where?.track && b.where.track.length >= 2 ? [{ track: b.where.track, reps: (b.repeat ?? 0) > 1 }] : []))
    .sort((a, b) => Number(a.reps) - Number(b.reps));
}

const token = (name: string, fallback: string) =>
  getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback;

export function SessionMap({ blocks }: { blocks: readonly Block[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const tracks = lines(blocks);
  const points = keyPoints(blocks);
  const start = points[0];
  // La carte se refait quand le tracé change, pas à chaque rendu de l'écran.
  const shape = JSON.stringify([tracks, points.map((p) => [p.role, p.at])]);

  useEffect(() => {
    const el = ref.current;
    if (!el || tracks.length === 0) return;
    let map: LeafletMap | null = null;
    let gone = false;
    void import('leaflet').then(({ default: L }) => {
      if (gone) return;
      // Sur le téléphone, un doigt fait défiler la page, pas la carte : elle
      // montre la montée entière, et se zoome à deux doigts.
      map = L.map(el, {
        zoomControl: false,
        scrollWheelZoom: false,
        dragging: !L.Browser.mobile,
        attributionControl: true,
        // Au quart de niveau : la montée remplit la carte au lieu d'y flotter.
        zoomSnap: 0.25,
      });
      map.attributionControl.setPrefix(false);
      L.tileLayer('https://tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a>',
      }).addTo(map);

      const ochre = token('--ochre', '#d6a15c');
      const stone = token('--text', '#ece8df');
      const slate = token('--bg', '#0e1316');
      const all: [number, number][] = [];
      for (const t of tracks) {
        L.polyline(t.track, { color: t.reps ? stone : ochre, weight: t.reps ? 4 : 6, opacity: t.reps ? 0.95 : 0.85 }).addTo(map);
        all.push(...t.track);
      }
      points.forEach((p, i) => {
        L.circleMarker(p.at, { radius: 6, weight: 2, color: slate, fillColor: i === 0 ? stone : ochre, fillOpacity: 1 })
          .bindTooltip(i === 0 ? `${ROLE[p.role]} · départ` : ROLE[p.role], {
            // Du côté où il y a de la place : une étiquette au bord droit sortirait de la carte.
            permanent: true, direction: 'auto', className: 'm-map-tip',
          })
          .addTo(map!);
        all.push(p.at);
      });
      map.fitBounds(L.latLngBounds(all), { padding: [36, 36], maxZoom: 17 });
    });
    return () => {
      gone = true;
      map?.remove();
    };
    // `shape` résume `tracks` et `points` : c'est lui qui dit quand la carte change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape]);

  if (tracks.length === 0) return null;
  return (
    <div className="m-map-wrap">
      <div ref={ref} className="m-map" role="img" aria-label={`Carte du tracé : ${points.map((p) => ROLE[p.role]).join(', ')}`} />
      <ol className="m-map-points">
        {points.map((p, i) => (
          <li key={p.role}>
            <a href={mapUrl(p)} className="m-inline" target="_blank" rel="noreferrer">{ROLE[p.role]}</a>
            {i === 0 && <span className="m-faint"> · départ</span>}
            {p.address && <> — {p.address}</>}
          </li>
        ))}
      </ol>
      {start && (
        <a className="m-map-go" href={directionsUrl(start)} target="_blank" rel="noreferrer">
          Itinéraire à pied jusqu&apos;au départ
        </a>
      )}
    </div>
  );
}
