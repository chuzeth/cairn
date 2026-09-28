import type { SessionRoute } from './types.js';

/**
 * L'itinéraire d'une séance en GPX, pour une montre ou une application de carte.
 *
 * Il se construit dans le téléphone, à partir de l'itinéraire que l'écran a
 * déjà : le fichier existe même quand le Mac dort, et il ne part vers personne
 * — c'est l'athlète qui l'ouvre où il veut.
 */

/**
 * Le tracé dans l'ordre où on le court. Un détour est un aller-retour : son
 * retour y est. Un motif répété n'y passe qu'une fois — la montre suivrait
 * sinon cinq fois le même chemin comme cinq chemins.
 */
export function routeTrack(route: Pick<SessionRoute, 'legs'>): [number, number][] {
  const out: [number, number][] = [];
  const add = (pts: readonly (readonly [number, number])[]) => {
    for (const p of pts) {
      const last = out[out.length - 1];
      if (!last || last[0] !== p[0] || last[1] !== p[1]) out.push([p[0], p[1]]);
    }
  };
  for (const l of route.legs) {
    if (l.track.length < 2) continue;
    add(l.track);
    if (l.kind === 'detour') add([...l.track].reverse());
  }
  return out;
}

const esc = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

const pt = (tag: string, p: readonly [number, number], inner = '') =>
  `<${tag} lat="${p[0].toFixed(6)}" lon="${p[1].toFixed(6)}"${inner ? `>${inner}</${tag}>` : '/>'}`;

/**
 * Le fichier GPX 1.1 : un point de passage au départ, au début de chaque
 * montée et du motif, et la trace entière. Chaque segment de l'itinéraire se
 * relit dans la description, avec ses répétitions.
 */
export function toGpx(route: SessionRoute, name: string): string {
  const track = routeTrack(route);
  const waypoints = [
    { at: route.home.at, name: 'Départ et arrivée' },
    ...route.legs
      .filter((l) => (l.kind === 'motif' || l.kind === 'climb') && l.track.length > 0)
      .map((l) => ({ at: l.track[0]!, name: l.repeat ? `${l.label} (${l.repeat} fois)` : l.label })),
  ];
  const desc = route.legs
    .map((l) => `${l.label}${l.repeat ? ` × ${l.repeat}` : ''} : ${Math.round(l.durationS / 60)} min, ${l.distanceM} m`)
    .join(' ; ');
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<gpx version="1.1" creator="Cairn" xmlns="http://www.topografix.com/GPX/1/1">',
    `  <metadata><name>${esc(name)}</name><desc>${esc(desc)}</desc></metadata>`,
    ...waypoints.map((w) => `  ${pt('wpt', w.at, `<name>${esc(w.name)}</name>`)}`),
    `  <trk><name>${esc(name)}</name><trkseg>`,
    ...track.map((p) => `    ${pt('trkpt', p)}`),
    '  </trkseg></trk>',
    '</gpx>',
    '',
  ].join('\n');
}
