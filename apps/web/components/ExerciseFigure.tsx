import type { ReactNode } from 'react';
import type { ExerciseKey } from '@cairn/core/exercises';
import { FIGURES } from '@/lib/exerciseFigures';
import {
  FURNITURE, add, angleAt, dist, doorHook, lerp, muscleShape, mul, parts, resolve, rot, sub, unit,
  type Panel, type Part, type Prop, type Pt, type Ref, type Skeleton,
} from '@/lib/figure';

/**
 * Le schéma d'un exercice : une ou deux vignettes, chacune la position qui
 * compte, celle d'où l'on part en pointillé, et ce que l'œil doit y lire.
 *
 * La grammaire, la même partout : le corps en blanc pierre, le côté opposé en
 * gris, le plâtre en ocre — il ne porte jamais rien —, les muscles qui
 * travaillent en rouge, l'élastique en vert, le mouvement en bleu, les angles
 * et les alignements en traits fins. Tout est calculé (`lib/figure`) : un
 * angle écrit est l'angle du dessin.
 */

export const hasFigure = (key: string): boolean => key in FIGURES;

/** Taille du texte, en unités du corps (100 = sa hauteur). */
const TEXT = 5.2;
const CHAR = 0.56;

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
const pathOf = (pts: readonly Pt[], closed = true) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p[0])} ${fmt(-p[1])}`).join(' ') + (closed ? ' Z' : '');

interface Box {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}

const grow = (b: Box, [x, y]: Pt) => {
  b.x0 = Math.min(b.x0, x);
  b.x1 = Math.max(b.x1, x);
  b.y0 = Math.min(b.y0, y);
  b.y1 = Math.max(b.y1, y);
};

/** Les lignes d'une consigne, et la place qu'elles prennent. */
const linesOf = (text: string) => text.split('\n');
function textBox(text: string, at: Pt, anchor: 'start' | 'middle' | 'end'): Box {
  const lines = linesOf(text);
  const w = Math.max(...lines.map((l) => l.length)) * TEXT * CHAR;
  const x0 = anchor === 'start' ? at[0] : anchor === 'end' ? at[0] - w : at[0] - w / 2;
  return { x0, x1: x0 + w, y0: at[1] - (lines.length - 1) * TEXT * 1.15 - TEXT * 0.35, y1: at[1] + TEXT * 0.85 };
}

/** Les meubles et les machines qui comptent dans le cadrage ; le sol et les murs suivent le cadre. */
function propPoints(prop: Prop): Pt[] {
  switch (prop.kind) {
    case 'chair': {
      const { seat, depth, back } = FURNITURE.chair;
      const b = prop.x - prop.face * depth;
      return [[prop.x, 0], [b, 0], [b, prop.back === false ? seat : back]];
    }
    case 'sofa': {
      const { depth, back } = FURNITURE.sofa;
      return [[prop.x, 0], [prop.x - prop.face * depth, back]];
    }
    case 'box':
      return [[prop.x, 0], [prop.x - prop.face * prop.depth, prop.h]];
    case 'stool':
      return [[prop.x, 0], [prop.x - prop.face * FURNITURE.stool.depth, FURNITURE.stool.seat]];
    case 'stairs': {
      const { rise, run } = FURNITURE.stair;
      return [[prop.x - 6, 0], [prop.x + prop.n * run + 6, prop.n * rise + (prop.rail ? 50 : 0)]];
    }
    case 'bench':
      return [[prop.from, 0], [prop.to, prop.h]];
    case 'shape':
      return prop.pts;
    case 'circle':
      return [add(prop.c, [-prop.r, -prop.r]), add(prop.c, [prop.r, prop.r])];
    case 'dumbbell':
      return [add(prop.at, [-5, -3]), add(prop.at, [5, 3])];
    case 'towel':
      return [[prop.x - prop.w / 2, 0], [prop.x + prop.w / 2, 1]];
    case 'mat':
      return [[prop.from, 0], [prop.to, 1]];
    case 'backdrop':
      return [[prop.from, 0], [prop.to, prop.top]];
    default:
      return [];
  }
}

function PropView({ prop, box }: { prop: Prop; box: Box }) {
  switch (prop.kind) {
    case 'floor': {
      const ticks: ReactNode[] = [];
      for (let x = box.x0 + 2; x <= box.x1; x += 3.5) {
        ticks.push(<line key={fmt(x)} x1={fmt(x)} y1="0" x2={fmt(x - 2.2)} y2="2.2" />);
      }
      return (
        <g className="fg-ground">
          <line x1={fmt(box.x0)} y1="0" x2={fmt(box.x1)} y2="0" className="fg-ground-line" />
          {ticks}
        </g>
      );
    }
    case 'wall': {
      const ticks: ReactNode[] = [];
      for (let y = 2; y < box.y1; y += 3.5) {
        ticks.push(<line key={y} x1={fmt(prop.x)} y1={fmt(-y)} x2={fmt(prop.x - prop.face * 2.2)} y2={fmt(-y - 2.2)} />);
      }
      return (
        <g className="fg-ground">
          <line x1={fmt(prop.x)} y1="0" x2={fmt(prop.x)} y2={fmt(-box.y1)} className="fg-ground-line" />
          {ticks}
        </g>
      );
    }
    case 'backdrop':
      return (
        <rect x={fmt(prop.from)} y={fmt(-prop.top)} width={fmt(prop.to - prop.from)} height={fmt(prop.top)} className="fg-backdrop" />
      );
    case 'chair': {
      const { seat, depth, back } = FURNITURE.chair;
      const f = prop.face;
      const b = prop.x - f * depth;
      return (
        <g className="fg-furniture">
          <path d={pathOf([[prop.x, seat], [b, seat], [b, seat - 2], [prop.x, seat - 2]])} className="fg-pad" />
          <line x1={fmt(prop.x - f * 1.5)} y1={fmt(-seat + 2)} x2={fmt(prop.x - f * 1.5)} y2="0" />
          <line x1={fmt(b + f * 1.5)} y1={fmt(-seat + 2)} x2={fmt(b + f * 1.5)} y2="0" />
          {prop.back !== false && <line x1={fmt(b + f * 1.5)} y1={fmt(-seat)} x2={fmt(b - f * 0.5)} y2={fmt(-back)} />}
        </g>
      );
    }
    case 'sofa': {
      const { seat, depth, back } = FURNITURE.sofa;
      const f = prop.face;
      const b = prop.x - f * depth;
      return (
        <g className="fg-furniture">
          <path d={pathOf([[prop.x, 3], [b, 3], [b, seat - 6], [prop.x, seat - 6]])} className="fg-pad" />
          <path d={pathOf([[prop.x, seat - 6], [b + f * 6, seat - 6], [b + f * 6, seat], [prop.x, seat]])} className="fg-pad" />
          <path d={pathOf([[b, seat - 6], [b + f * 6, seat - 6], [b + f * 6.5, back], [b, back]])} className="fg-pad" />
          <line x1={fmt(prop.x - f * 2)} y1="-3" x2={fmt(prop.x - f * 2)} y2="0" />
          <line x1={fmt(b + f * 2)} y1="-3" x2={fmt(b + f * 2)} y2="0" />
        </g>
      );
    }
    case 'stool': {
      const { seat, depth } = FURNITURE.stool;
      const f = prop.face;
      const b = prop.x - f * depth;
      return (
        <g className="fg-furniture">
          <path d={pathOf([[prop.x, seat], [b, seat], [b, seat - 3], [prop.x, seat - 3]])} className="fg-pad" />
          <path d={pathOf([[prop.x - f * 2, seat - 3], [prop.x - f * 0.5, 0], [prop.x - f * 2.6, 0], [prop.x - f * 4, seat - 3]])} className="fg-pad" />
          <path d={pathOf([[b + f * 2, seat - 3], [b + f * 0.5, 0], [b + f * 2.6, 0], [b + f * 4, seat - 3]])} className="fg-pad" />
        </g>
      );
    }
    case 'box': {
      const b = prop.x - prop.face * prop.depth;
      return <path d={pathOf([[prop.x, 0], [prop.x, prop.h], [b, prop.h], [b, 0]])} className="fg-furniture fg-pad" />;
    }
    case 'stairs': {
      const { rise, run } = FURNITURE.stair;
      const pts: Pt[] = [[prop.x - 6, 0], [prop.x, 0]];
      for (let i = 1; i <= prop.n; i++) pts.push([prop.x + (i - 1) * run, i * rise], [prop.x + i * run, i * rise]);
      pts.push([prop.x + prop.n * run + 6, prop.n * rise], [prop.x + prop.n * run + 6, 0]);
      // La rampe : à 90 cm au-dessus des nez de marche.
      const railY = (x: number) => 50 + rise + ((x - prop.x) / run) * rise;
      const x0 = prop.x - 3;
      const x1 = prop.x + prop.n * run + 3;
      return (
        <g className="fg-furniture">
          <path d={pathOf(pts)} className="fg-pad" />
          {prop.rail && (
            <>
              <line x1={fmt(x0)} y1={fmt(-railY(x0))} x2={fmt(x1)} y2={fmt(-railY(x1))} className="fg-rail" />
              <line x1={fmt(prop.x + 1)} y1={fmt(-rise)} x2={fmt(prop.x + 1)} y2={fmt(-railY(prop.x + 1))} />
              <line
                x1={fmt(x1 - 5)} y1={fmt(-prop.n * rise)} x2={fmt(x1 - 5)} y2={fmt(-railY(x1 - 5))}
              />
            </>
          )}
        </g>
      );
    }
    case 'jamb':
      return <rect x={fmt(prop.x - 1.2)} y={fmt(-box.y1)} width="2.4" height={fmt(box.y1)} className="fg-furniture fg-pad" />;
    case 'door': {
      const hook = doorHook(prop.x, prop.anchor);
      return (
        <g className="fg-furniture">
          <rect x={fmt(prop.x)} y={fmt(-box.y1)} width="2.2" height={fmt(box.y1)} className="fg-pad" />
          <rect x={fmt(prop.x + 2.4)} y={fmt(-prop.anchor - 1.8)} width="2.6" height="3.6" rx="1" className="fg-anchor-block" />
          <line x1={fmt(prop.x + 2.4)} y1={fmt(-prop.anchor)} x2={fmt(hook[0] + 1.2)} y2={fmt(-prop.anchor)} className="fg-strap" />
          <path d={`M${fmt(hook[0] + 1.2)} ${fmt(-prop.anchor - 1.2)} a 1.2 1.2 0 1 0 0 2.4`} className="fg-hook" />
        </g>
      );
    }
    case 'mat':
      return <rect x={fmt(prop.from)} y="-0.6" width={fmt(prop.to - prop.from)} height="0.6" rx="0.3" className="fg-mat" />;
    case 'towel':
      return <rect x={fmt(prop.x - prop.w / 2)} y="-0.9" width={fmt(prop.w)} height="0.9" rx="0.3" className="fg-towel" />;
    case 'bench':
      return (
        <g className="fg-furniture">
          <path d={pathOf([[prop.from, prop.h], [prop.to, prop.h], [prop.to, prop.h - 2.6], [prop.from, prop.h - 2.6]])} className="fg-pad" />
          <line x1={fmt(prop.from + 3)} y1={fmt(-prop.h + 2.6)} x2={fmt(prop.from + 3)} y2="0" />
          <line x1={fmt(prop.to - 3)} y1={fmt(-prop.h + 2.6)} x2={fmt(prop.to - 3)} y2="0" />
        </g>
      );
    case 'shape':
      return <path d={pathOf(prop.pts, prop.closed ?? false)} className={`fg-furniture fg-${prop.tone ?? 'metal'}`} />;
    case 'circle':
      return <circle cx={fmt(prop.c[0])} cy={fmt(-prop.c[1])} r={fmt(prop.r)} className={`fg-furniture fg-${prop.tone ?? 'metal'}`} />;
    case 'dumbbell': {
      const d = prop.deg ?? 0;
      const at = (v: Pt): Pt => add(prop.at, rot(v, d));
      const seg = (a: Pt, b: Pt, cls?: string) => (
        <line x1={fmt(a[0])} y1={fmt(-a[1])} x2={fmt(b[0])} y2={fmt(-b[1])} className={cls} />
      );
      return (
        <g className="fg-weight">
          {seg(at([-4.4, 0]), at([4.4, 0]))}
          {seg(at([-3.6, -2.6]), at([-3.6, 2.6]), 'fg-plate')}
          {seg(at([3.6, -2.6]), at([3.6, 2.6]), 'fg-plate')}
        </g>
      );
    }
  }
}

/** Les contours d'un corps, chacun bordé du fond pour se détacher de ses voisins. */
function BodyView({ list, muscles, uid }: { list: Part[]; muscles: Map<string, Pt[][]>; uid: string }) {
  return (
    <g>
      {list.map((p, i) => (
        <g key={`${p.name}-${i}`}>
          <path d={pathOf(p.pts)} className={`fg-part fg-${p.tone}`} />
          {(muscles.get(p.name) ?? []).map((m, j) => (
            <g key={j}>
              <clipPath id={`${uid}-c${i}-${j}`}>
                <path d={pathOf(p.pts)} />
              </clipPath>
              <path d={pathOf(m)} clipPath={`url(#${uid}-c${i}-${j})`} className="fg-muscle" />
            </g>
          ))}
        </g>
      ))}
    </g>
  );
}

/**
 * La position de départ : une silhouette sombre bordée d'un pointillé. Les
 * bords se tracent d'abord, les fonds ensuite : il ne reste que le contour.
 */
function GhostView({ list }: { list: Part[] }) {
  return (
    <g className="fg-ghost">
      {list.map((p, i) => <path key={`e${i}`} d={pathOf(p.pts)} className="fg-ghost-edge" />)}
      {list.map((p, i) => <path key={`f${i}`} d={pathOf(p.pts)} className="fg-ghost-fill" />)}
    </g>
  );
}

function arcPoints(at: Pt, a: Pt, b: Pt, r: number): Pt[] {
  const ua = unit(sub(a, at));
  const ub = unit(sub(b, at));
  const t0 = Math.atan2(ua[1], ua[0]);
  let d = Math.atan2(ub[1], ub[0]) - t0;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return Array.from({ length: 13 }, (_, i) => {
    const t = t0 + (d * i) / 12;
    return add(at, [r * Math.cos(t), r * Math.sin(t)]);
  });
}

function PanelView({ panel, uid, name }: { panel: Panel; uid: string; name: string }) {
  const { skeleton: k, parts: list } = parts(panel.pose);
  const ghost = panel.ghost ? parts(panel.ghost) : null;
  const at = (ref: Ref, s: Skeleton = k) => resolve(ref, s);

  const muscles = new Map<string, Pt[][]>();
  for (const m of panel.muscles ?? []) {
    const shape = muscleShape(m, k, list);
    if (shape) muscles.set(shape.clip, [...(muscles.get(shape.clip) ?? []), shape.pts]);
  }

  // Le cadre : le corps dans ses deux positions, le mobilier, les annotations.
  const box: Box = { x0: Infinity, x1: -Infinity, y0: 0, y1: -Infinity };
  for (const p of [...list, ...(ghost?.parts ?? [])]) for (const q of p.pts) grow(box, q);
  for (const prop of panel.props) for (const q of propPoints(prop)) grow(box, q);
  const growText = (text: string, pos: Pt, anchor: 'start' | 'middle' | 'end') => {
    const tb = textBox(text, pos, anchor);
    grow(box, [tb.x0, tb.y0]);
    grow(box, [tb.x1, tb.y1]);
  };

  const notes = (panel.notes ?? []).map((n) => {
    const target = at(n.at);
    const pos = add(target, [n.dx, n.dy]);
    const anchor: 'start' | 'middle' | 'end' = n.dx > 1 ? 'start' : n.dx < -1 ? 'end' : 'middle';
    growText(n.text, pos, anchor);
    return { text: n.text, target, pos, anchor };
  });
  const angles = (panel.angles ?? []).map((a) => {
    const c = at(a.at);
    const pa = at(a.a);
    const pb = at(a.b);
    const r = a.r ?? 6;
    const bis = unit(add(unit(sub(pa, c)), unit(sub(pb, c))));
    const label = a.label ?? `${Math.round(angleAt(pa, c, pb))}°`;
    const pos = add(c, mul(bis, r + 4.4));
    growText(label, pos, 'middle');
    return { pts: arcPoints(c, pa, pb, r), pos, label };
  });
  const motions = (panel.motions ?? []).map((m) => {
    const from = m.joint && ghost ? resolve(m.joint, ghost.skeleton) : at(m.from!);
    const to = m.joint ? resolve(m.joint, k) : at(m.to!);
    const mid = lerp(from, to, 0.5);
    const n = rot(unit(sub(to, from)), 90);
    const ctrl = add(mid, mul(n, m.bend ?? 0));
    const apex = lerp(mid, ctrl, 0.5);
    const top = add(apex, mul(n, (m.bend ?? 0) >= 0 ? 4.2 : -4.2));
    grow(box, apex);
    if (m.label) growText(m.label, top, 'middle');
    // Les extrémités s'écartent des points : la pointe ne les recouvre pas.
    const end = add(to, mul(unit(sub(ctrl, to)), Math.min(2, dist(to, ctrl) * 0.3)));
    const start = add(from, mul(unit(sub(ctrl, from)), Math.min(1.4, dist(from, ctrl) * 0.2)));
    return { start, ctrl, end, label: m.label, top, joint: m.joint, n, bend: m.bend ?? 0 };
  });
  // Les numéros 1 et 2 marquent un déplacement qui se voit ; sur quelques centimètres, ils masqueraient le geste.
  const first = ghost ? motions.find((m) => m.joint && dist(m.start, m.end) > 12) : undefined;
  const steps = first
    ? [first.start, first.end].map((q, i) => {
        const away = mul(first.n, first.bend >= 0 ? -4.2 : 4.2);
        return { at: add(q, away), n: String(i + 1) };
      })
    : [];
  for (const st of steps) {
    grow(box, add(st.at, [-3, -3]));
    grow(box, add(st.at, [3, 3]));
  }
  const bands = (panel.bands ?? []).map((b) => ({ a: at(b.from), b: at(b.to), kind: b.kind }));
  const ghostBands = ghost
    ? (panel.ghostBands ?? []).map((b) => ({ a: at(b.from, ghost.skeleton), b: at(b.to, ghost.skeleton), kind: b.kind }))
    : [];
  const guides = (panel.guides ?? []).map((g) => ({ a: at(g.from), b: at(g.to) }));
  for (const s of [...bands, ...ghostBands, ...guides]) {
    grow(box, s.a);
    grow(box, s.b);
  }
  // L'haltère et la poignée se voient par le bout : un disque, un anneau, dans la main valide.
  const weight = (s: Skeleton) => add(resolve('free.wrist', s), mul(unit(sub(resolve('free.tip', s), resolve('free.wrist', s))), 3));
  const ring = panel.hold === 'handle' ? 2 : 3.2;
  const held = panel.hold ? { pose: weight(k), ghost: ghost ? weight(ghost.skeleton) : null } : null;
  if (held) for (const q of [held.pose, held.ghost]) if (q) { grow(box, add(q, [-3.4, -3.4])); grow(box, add(q, [3.4, 3.4])); }

  const pad = 3.5;
  const floor = panel.props.some((p) => p.kind === 'floor');
  box.x0 -= pad;
  box.x1 += pad;
  box.y1 += pad;
  box.y0 = Math.min(box.y0, 0) - (floor ? 3 : pad);
  const vb = `${fmt(box.x0)} ${fmt(-box.y1)} ${fmt(box.x1 - box.x0)} ${fmt(box.y1 - box.y0)}`;
  const marker = `${uid}-arrow`;
  const line = (a: Pt, b: Pt, cls: string, key: string) => (
    <line key={key} x1={fmt(a[0])} y1={fmt(-a[1])} x2={fmt(b[0])} y2={fmt(-b[1])} className={cls} />
  );

  return (
    <figure className="xf-panel">
      <svg viewBox={vb} className="xf" role="img" aria-label={`${name} : ${panel.label}`}>
        <defs>
          <marker id={marker} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
            <path d="M0 0 L10 5 L0 10 z" className="fg-arrow-head" />
          </marker>
        </defs>
        {panel.props.filter((p) => p.kind !== 'floor').map((p, i) => <PropView key={i} prop={p} box={box} />)}
        {floor && <PropView prop={{ kind: 'floor' }} box={box} />}
        {held?.ghost && <circle cx={fmt(held.ghost[0])} cy={fmt(-held.ghost[1])} r={ring} className="fg-weight-ghost" />}
        {ghost && <GhostView list={ghost.parts} />}
        {ghostBands.map((b, i) => line(b.a, b.b, `fg-band fg-band-${b.kind} fg-band-ghost`, `gb${i}`))}
        <BodyView list={list} muscles={muscles} uid={uid} />
        {held && (
          <g className={panel.hold === 'handle' ? 'fg-handle' : 'fg-disc'}>
            <circle cx={fmt(held.pose[0])} cy={fmt(-held.pose[1])} r={ring} />
            <circle cx={fmt(held.pose[0])} cy={fmt(-held.pose[1])} r="1.1" />
          </g>
        )}
        {bands.map((b, i) => line(b.a, b.b, `fg-band fg-band-${b.kind}`, `b${i}`))}
        {guides.map((g, i) => line(g.a, g.b, 'fg-guide', `g${i}`))}
        {angles.map((a, i) => (
          <g key={`a${i}`} className="fg-angle">
            <path d={pathOf(a.pts, false)} />
            <text x={fmt(a.pos[0])} y={fmt(-a.pos[1] + TEXT * 0.35)} textAnchor="middle">{a.label}</text>
          </g>
        ))}
        {motions.map((m, i) => (
          <g key={`m${i}`} className="fg-motion">
            <path
              d={`M${fmt(m.start[0])} ${fmt(-m.start[1])} Q${fmt(m.ctrl[0])} ${fmt(-m.ctrl[1])} ${fmt(m.end[0])} ${fmt(-m.end[1])}`}
              markerEnd={`url(#${marker})`}
            />
            {m.label && <text x={fmt(m.top[0])} y={fmt(-m.top[1] + TEXT * 0.35)} textAnchor="middle">{m.label}</text>}
          </g>
        ))}
        {steps.map((st) => (
          <g key={`s${st.n}`} className="fg-step">
            <circle cx={fmt(st.at[0])} cy={fmt(-st.at[1])} r="2.7" />
            <text x={fmt(st.at[0])} y={fmt(-st.at[1] + 1.25)} textAnchor="middle">{st.n}</text>
          </g>
        ))}
        {notes.map((n, i) => {
          const lead = add(n.target, mul(unit(sub(n.pos, n.target)), 1.3));
          const end: Pt = [n.pos[0] + (n.anchor === 'start' ? -0.8 : n.anchor === 'end' ? 0.8 : 0), n.pos[1] + TEXT * 0.3];
          return (
            <g key={`n${i}`} className="fg-note">
              {line(lead, end, '', 'l')}
              <text x={fmt(n.pos[0])} y={fmt(-n.pos[1])} textAnchor={n.anchor}>
                {linesOf(n.text).map((l, j) => (
                  <tspan key={j} x={fmt(n.pos[0])} dy={j === 0 ? 0 : fmt(TEXT * 1.15)}>{l}</tspan>
                ))}
              </text>
            </g>
          );
        })}
      </svg>
      <figcaption className="xf-caption">
        {panel.ghostLabel && <span className="xf-key xf-key-ghost">1. {panel.ghostLabel}</span>}
        <span className="xf-key xf-key-solid">{panel.ghostLabel ? `2. ${panel.label}` : panel.label}</span>
      </figcaption>
    </figure>
  );
}

export function ExerciseFigure({ exercise, label }: { exercise: ExerciseKey; label: string }) {
  const spec = FIGURES[exercise];
  if (!spec) return null;
  return (
    <div className="xf-panels" data-count={spec.panels.length}>
      {spec.panels.map((p, i) => <PanelView key={i} panel={p} uid={`${exercise}-${i}`} name={label} />)}
    </div>
  );
}
