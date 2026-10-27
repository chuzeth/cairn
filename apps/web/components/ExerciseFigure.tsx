'use client';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { ExerciseKey } from '@cairn/core/exercises';
import { FIGURES } from '@/lib/exerciseFigures';
import {
  FURNITURE, TEXT, add, between, carryShape, doorHook, labelBox, linesOf, muscleShape, mul, parts, placeTexts, resolve,
  rot, stairsOf, sub, textBox, unit,
  type Box, type Panel, type Part, type Pose, type Prop, type Pt, type Ref, type Skeleton,
} from '@/lib/figure';
import { cycleOf, phaseAt, type Cycle } from '@/lib/motion';
import { FIGURES_3D } from '@/lib/figure3d/model';
import { useFigure3D } from './useFigure3D';

/**
 * Le schéma d'un exercice : une ou deux vignettes, chacune la position qui
 * compte, celle d'où l'on part en pointillé, et ce que l'œil doit y lire.
 *
 * La grammaire, la même partout : le corps en blanc pierre, le côté opposé en
 * gris, le plâtre en ocre — il ne porte jamais rien —, les muscles qui
 * travaillent en rouge, l'élastique en vert, le mouvement en bleu, les angles
 * et les alignements en traits fins. Tout est calculé (`lib/figure`) : un
 * angle écrit est l'angle du dessin.
 *
 * Depuis le 21/10, les schémas entièrement de profil (`FIGURES_3D`) montrent
 * un mannequin 3D (`lib/figure3d`) posé par les mêmes squelettes : le corps,
 * son décor et ce qu'il porte viennent de la 3D ; tout le reste — le pointillé
 * du départ, les élastiques, les angles, les flèches, les consignes — reste
 * ce calque vectoriel, posé dessus dans le même cadre.
 */

export const hasFigure = (key: string): boolean => key in FIGURES;

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();
const pathOf = (pts: readonly Pt[], closed = true) =>
  pts.map((p, i) => `${i === 0 ? 'M' : 'L'}${fmt(p[0])} ${fmt(-p[1])}`).join(' ') + (closed ? ' Z' : '');

const grow = (b: Box, [x, y]: Pt) => {
  b.x0 = Math.min(b.x0, x);
  b.x1 = Math.max(b.x1, x);
  b.y0 = Math.min(b.y0, y);
  b.y1 = Math.max(b.y1, y);
};

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
      // La rampe : à 90 cm au-dessus des nez de marche.
      const { steps, rail, posts } = stairsOf(prop);
      return (
        <g className="fg-furniture">
          <path d={pathOf(steps)} className="fg-pad" />
          {prop.rail && (
            <>
              <line x1={fmt(rail[0][0])} y1={fmt(-rail[0][1])} x2={fmt(rail[1][0])} y2={fmt(-rail[1][1])} className="fg-rail" />
              {posts.map(([a, b], i) => <line key={i} x1={fmt(a[0])} y1={fmt(-a[1])} x2={fmt(b[0])} y2={fmt(-b[1])} />)}
            </>
          )}
        </g>
      );
    }
    case 'jamb':
      return <rect x={fmt(prop.x - 1.2)} y={fmt(-box.y1)} width="2.4" height={fmt(box.y1)} className="fg-furniture fg-pad" />;
    case 'door': {
      // Le cylindre de l'autre côté de la porte, la sangle qui passe dessous, le crochet de notre côté.
      const face = prop.face ?? -1;
      const hook = doorHook(prop.x, prop.anchor, face);
      const block = face === -1 ? prop.x + 2.4 : prop.x - 2.8;
      const toward = face === -1 ? 1.2 : -1.2;
      return (
        <g className="fg-furniture">
          <rect x={fmt(prop.x)} y={fmt(-box.y1)} width="2.2" height={fmt(box.y1)} className="fg-pad" />
          <rect x={fmt(block)} y={fmt(-prop.anchor - 1.8)} width="2.6" height="3.6" rx="1" className="fg-anchor-block" />
          <line x1={fmt(face === -1 ? block : block + 2.6)} y1={fmt(-prop.anchor)} x2={fmt(hook[0] + toward)} y2={fmt(-prop.anchor)} className="fg-strap" />
          <path
            d={`M${fmt(hook[0] + toward)} ${fmt(-prop.anchor - 1.2)} a 1.2 1.2 0 1 ${face === -1 ? 0 : 1} 0 2.4`}
            className="fg-hook"
          />
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

/**
 * Les contours d'un corps, chacun bordé du fond pour se détacher de ses voisins,
 * puis modelé : l'ombre au dos du membre, la lumière devant, comme sous une
 * lampe de studio. Les muscles qui travaillent sont fondus dans la forme, pas
 * posés dessus. Une ombre portée dit où le corps touche le sol.
 */
function BodyView({ list, muscles, uid }: { list: Part[]; muscles: Map<string, Pt[][]>; uid: string }) {
  // Ce qui touche le sol, à un trait près : l'ombre portée s'étend sous ces points.
  const grounded = list.filter((p) => p.tone !== 'sling').flatMap((p) => p.pts).filter((q) => q[1] < 0.9);
  const xs = grounded.map((q) => q[0]);
  const shadow = xs.length > 0 ? { cx: (Math.min(...xs) + Math.max(...xs)) / 2, rx: (Math.max(...xs) - Math.min(...xs)) / 2 + 4 } : null;
  return (
    <g>
      <defs>
        <filter id={`${uid}-soft`} x="-20%" y="-20%" width="140%" height="140%">
          <feGaussianBlur stdDeviation="0.7" />
        </filter>
        <filter id={`${uid}-blur`} x="-50%" y="-200%" width="200%" height="500%">
          <feGaussianBlur stdDeviation="1.1" />
        </filter>
        {list.map((p, i) => p.shade && (
          <linearGradient
            key={i}
            id={`${uid}-s${i}`}
            gradientUnits="userSpaceOnUse"
            x1={fmt(p.shade[0][0])} y1={fmt(-p.shade[0][1])} x2={fmt(p.shade[1][0])} y2={fmt(-p.shade[1][1])}
          >
            <stop offset="0" className="fg-shade-dark" />
            <stop offset="0.5" className="fg-shade-mid" />
            <stop offset="1" className="fg-shade-light" />
          </linearGradient>
        ))}
      </defs>
      {shadow && (
        <ellipse cx={fmt(shadow.cx)} cy="0.4" rx={fmt(shadow.rx)} ry="1.3" className="fg-contact" filter={`url(#${uid}-blur)`} />
      )}
      {chainsOf(list).map((chain) => (
        <g key={chain[0]!.i}>
          {/* Le contour de la chaîne entière d'abord, puis ses fonds : la cuisse, le tibia et
              le pied font une jambe, sans couture au genou ni à la cheville. */}
          {chain.map(({ p, i }) => <path key={`e${i}`} d={pathOf(p.pts)} className={`fg-part fg-${p.tone}`} />)}
          {chain.map(({ p, i }) => <path key={`f${i}`} d={pathOf(p.pts)} className={`fg-fill fg-${p.tone}`} />)}
          {chain.map(({ p, i }) => p.shade && (p.tone === 'near' || p.tone === 'far') && (
            <path key={`s${i}`} d={pathOf(p.pts)} fill={`url(#${uid}-s${i})`} className="fg-shade" />
          ))}
          {chain.map(({ p, i }) => (muscles.get(p.name) ?? []).map((m, j) => (
            <g key={`m${i}-${j}`}>
              <clipPath id={`${uid}-c${i}-${j}`}>
                <path d={pathOf(p.pts)} />
              </clipPath>
              <g clipPath={`url(#${uid}-c${i}-${j})`}>
                <path d={pathOf(m)} className="fg-muscle" filter={`url(#${uid}-soft)`} />
              </g>
            </g>
          )))}
        </g>
      ))}
    </g>
  );
}

/** La chaîne d'une partie : une jambe, un bras, le corps (buste, cou, tête). */
const chainKey = (name: string): string => (['trunk', 'neck', 'head'].includes(name) ? 'body' : name.split('.')[0]!);

/** Les parties regroupées par chaîne, dans l'ordre du dessin : une chaîne se dessine d'un seul tenant. */
function chainsOf(list: Part[]): { p: Part; i: number }[][] {
  const out: { p: Part; i: number }[][] = [];
  list.forEach((p, i) => {
    const last = out[out.length - 1];
    if (last && chainKey(last[0]!.p.name) === chainKey(p.name) && p.tone !== 'sling') last.push({ p, i });
    else out.push([{ p, i }]);
  });
  return out;
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

/** Ce qui passe derrière le corps (un élastique dans le dos) : masqué par la silhouette de l'instant. */
function BehindBody({ body, uid, box, children }: { body: Part[]; uid: string; box: Box; children: ReactNode }) {
  return (
    <>
      <mask id={`${uid}-bm`} maskUnits="userSpaceOnUse" x={fmt(box.x0)} y={fmt(-box.y1)} width={fmt(box.x1 - box.x0)} height={fmt(box.y1 - box.y0)}>
        <rect x={fmt(box.x0)} y={fmt(-box.y1)} width={fmt(box.x1 - box.x0)} height={fmt(box.y1 - box.y0)} fill="#fff" />
        {body.map((p, i) => <path key={i} d={pathOf(p.pts)} fill="#000" />)}
      </mask>
      <g mask={`url(#${uid}-bm)`}>{children}</g>
    </>
  );
}

/** Le corps dans toutes les positions du mouvement : le cadre ne bouge pas pendant qu'il se plie. */
function bodyExtent(panel: Panel): Pt[] {
  const pts: Pt[] = [];
  const add = (pose: Pose) => { for (const p of parts(pose).parts) pts.push(...p.pts); };
  add(panel.pose);
  if (panel.ghost) {
    add(panel.ghost);
    for (const s of [0.2, 0.4, 0.6, 0.8]) add(between(panel.ghost, panel.pose, s));
  }
  return pts;
}

function PanelView({ panel, uid, name, frame, phase = 1, three = null, moving = false, notesShown = 1, compact = false, control }: {
  panel: Panel;
  uid: string;
  name: string;
  /** L'instant du geste que montre `frame`, de 0 (départ) à 1 (position dessinée) : celui que dessine la 3D. */
  phase?: number;
  /** Le schéma en 3D : son exercice et le rang de la vignette. */
  three?: { exercise: string; index: number } | null;
  /**
   * Étroit — un téléphone : sans les consignes écrites autour du corps, qui le
   * réduisaient à 40 % de la vignette. Elles sont dites juste dessous, dans les
   * repères ; ici, c'est le geste qu'on regarde, en grand.
   */
  compact?: boolean;
  /** La position de l'instant, quand le schéma bouge ; sans elle, la position dessinée. */
  frame?: Pose;
  /** En mouvement : le corps suit le geste, les angles et les flèches se taisent. */
  moving?: boolean;
  /** Les consignes écrites, de 0 à 1 : elles parlent de la position dessinée, et n'apparaissent qu'avec elle. */
  notesShown?: number;
  control?: ReactNode;
}) {
  // Le corps à l'instant ; les annotations, elles, décrivent la position dessinée.
  const { skeleton: k, parts: list } = parts(frame ?? panel.pose);
  const end = frame ? parts(panel.pose).skeleton : k;
  const ghost = panel.ghost ? parts(panel.ghost) : null;
  const at = (ref: Ref, s: Skeleton = end) => resolve(ref, s);
  const extent = useMemo(() => bodyExtent(panel), [panel]);

  const muscles = new Map<string, Pt[][]>();
  for (const m of panel.muscles ?? []) {
    const shape = muscleShape(m, k, list);
    if (shape) muscles.set(shape.clip, [...(muscles.get(shape.clip) ?? []), shape.pts]);
  }

  // Le cadre : le corps dans toutes ses positions, le mobilier, les annotations.
  const box: Box = { x0: Infinity, x1: -Infinity, y0: 0, y1: -Infinity };
  for (const q of extent) grow(box, q);
  for (const prop of panel.props) for (const q of propPoints(prop)) grow(box, q);
  const growBox = (tb: Box) => {
    grow(box, [tb.x0, tb.y0]);
    grow(box, [tb.x1, tb.y1]);
  };

  // Les textes se posent sur la position dessinée : une fois par vignette, pas à chaque image du geste.
  const { notes, angles, motions, steps } = useMemo(() => placeTexts(panel, { compact }), [panel, compact]);
  for (const n of notes) growBox(textBox(n.text, n.pos, n.anchor));
  for (const a of angles) growBox(labelBox(a.label, a.pos));
  for (const m of motions) {
    grow(box, m.apex);
    if (m.label) growBox(labelBox(m.label, m.top));
  }
  for (const st of steps) {
    grow(box, add(st.at, [-3, -3]));
    grow(box, add(st.at, [3, 3]));
  }
  // L'élastique suit le corps : il se tend et se détend avec le geste.
  const bands = (panel.bands ?? []).map((b) => ({ a: resolve(b.from, k), b: resolve(b.to, k), kind: b.kind, behind: b.behind === true }));
  const ghostBands = ghost
    ? (panel.ghostBands ?? []).map((b) => ({ a: at(b.from, ghost.skeleton), b: at(b.to, ghost.skeleton), kind: b.kind }))
    : [];
  const guides = (panel.guides ?? []).map((g) => ({ a: at(g.from), b: at(g.to) }));
  for (const s2 of [...(panel.bands ?? []).map((b) => ({ a: at(b.from), b: at(b.to) })), ...ghostBands, ...guides]) {
    grow(box, s2.a);
    grow(box, s2.b);
  }
  // L'haltère et la poignée se voient par le bout : un disque, un anneau, dans la main valide.
  const weight = (s: Skeleton) => add(resolve('free.wrist', s), mul(unit(sub(resolve('free.tip', s), resolve('free.wrist', s))), 3));
  const ring = panel.hold === 'handle' ? 2 : 3.2;
  const held = panel.hold ? { pose: weight(k), ghost: ghost ? weight(ghost.skeleton) : null } : null;
  if (panel.hold) for (const q of [weight(end), held?.ghost]) if (q) { grow(box, add(q, [-3.4, -3.4])); grow(box, add(q, [3.4, 3.4])); }
  // Le sac chargé : derrière le buste, ou devant le corps, sur les genoux ou à la main.
  const carried = panel.carry ? carryShape(panel.carry, k) : null;
  const carriedEnd = panel.carry ? carryShape(panel.carry, end) : null;
  if (carriedEnd) for (const q of carriedEnd.pts) grow(box, q);

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
  // En 3D, le corps, le décor, le sac et ce que tient la main sont dans la toile : le SVG n'en garde que le calque.
  const three3d = useFigure3D(three, phase, { x0: box.x0, x1: box.x1, y0: box.y0, y1: box.y1 });
  const overlay = three3d.ready;
  const behind = bands.filter((b) => b.behind).map((b, i) => line(b.a, b.b, `fg-band fg-band-${b.kind}`, `bb${i}`));

  return (
    <figure className="xf-panel" data-moving={moving || undefined} data-3d={overlay || undefined}>
      {control}
      <div className="xf-stage">
        {three3d.active && <canvas ref={three3d.canvasRef} className="xf-3d" aria-hidden="true" />}
        <svg viewBox={vb} className="xf" role="img" aria-label={`${name} : ${panel.label}`}>
          <defs>
            <marker id={marker} viewBox="0 0 10 10" refX="6" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse">
              <path d="M0 0 L10 5 L0 10 z" className="fg-arrow-head" />
            </marker>
          </defs>
          {!overlay && panel.props.filter((p) => p.kind !== 'floor').map((p, i) => <PropView key={i} prop={p} box={box} />)}
          {!overlay && floor && <PropView prop={{ kind: 'floor' }} box={box} />}
          {held?.ghost && <circle cx={fmt(held.ghost[0])} cy={fmt(-held.ghost[1])} r={ring} className="fg-weight-ghost" />}
          {ghost && !overlay && <GhostView list={ghost.parts} />}
          {!moving && ghostBands.map((b, i) => line(b.a, b.b, `fg-band fg-band-${b.kind} fg-band-ghost`, `gb${i}`))}
          {overlay ? <BehindBody body={list} uid={uid} box={box}>{behind}</BehindBody> : behind}
          {!overlay && carried && !carried.front && <path d={pathOf(carried.pts)} className="fg-carry" />}
          {!overlay && <BodyView list={list} muscles={muscles} uid={uid} />}
          {!overlay && carried?.front && <path d={pathOf(carried.pts)} className="fg-carry" />}
          {!overlay && held && (
            <g className={panel.hold === 'handle' ? 'fg-handle' : 'fg-disc'}>
              <circle cx={fmt(held.pose[0])} cy={fmt(-held.pose[1])} r={ring} />
              <circle cx={fmt(held.pose[0])} cy={fmt(-held.pose[1])} r="1.1" />
            </g>
          )}
          {bands.filter((b) => !b.behind).map((b, i) => line(b.a, b.b, `fg-band fg-band-${b.kind}`, `b${i}`))}
          {!moving && guides.map((g, i) => line(g.a, g.b, 'fg-guide', `g${i}`))}
          {!moving && angles.map((a, i) => (
            <g key={`a${i}`} className="fg-angle">
              <path d={pathOf(a.pts, false)} />
              <text x={fmt(a.pos[0])} y={fmt(-a.pos[1] + TEXT * 0.35)} textAnchor="middle">{a.label}</text>
            </g>
          ))}
          {!moving && motions.map((m, i) => (
            <g key={`m${i}`} className="fg-motion">
              <path
                d={`M${fmt(m.start[0])} ${fmt(-m.start[1])} Q${fmt(m.ctrl[0])} ${fmt(-m.ctrl[1])} ${fmt(m.end[0])} ${fmt(-m.end[1])}`}
                markerEnd={`url(#${marker})`}
              />
              {m.label && <text x={fmt(m.top[0])} y={fmt(-m.top[1] + TEXT * 0.35)} textAnchor="middle">{m.label}</text>}
            </g>
          ))}
          {!moving && steps.map((st) => (
            <g key={`s${st.n}`} className="fg-step">
              <circle cx={fmt(st.at[0])} cy={fmt(-st.at[1])} r="2.7" />
              <text x={fmt(st.at[0])} y={fmt(-st.at[1] + 1.25)} textAnchor="middle">{st.n}</text>
            </g>
          ))}
          {notes.map((n, i) => (
            <g key={`n${i}`} className="fg-note" style={notesShown < 1 ? { opacity: notesShown } : undefined}>
              {line(n.lead, n.tail, '', 'l')}
              <text x={fmt(n.pos[0])} y={fmt(-n.pos[1])} textAnchor={n.anchor}>
                {linesOf(n.text).map((l, j) => (
                  <tspan key={j} x={fmt(n.pos[0])} dy={j === 0 ? 0 : fmt(TEXT * 1.15)}>{l}</tspan>
                ))}
              </text>
            </g>
          ))}
        </svg>
      </div>
      <figcaption className="xf-caption">
        {panel.ghostLabel && <span className="xf-key xf-key-ghost">1. {panel.ghostLabel}</span>}
        <span className="xf-key xf-key-solid">{panel.ghostLabel ? `2. ${panel.label}` : panel.label}</span>
      </figcaption>
    </figure>
  );
}

/** Le mouvement est-il permis ? Sans, le schéma reste la position dessinée, annotée. */
function useStill(): boolean {
  const [still, setStill] = useState(false);
  useEffect(() => {
    const q = window.matchMedia('(prefers-reduced-motion: reduce)');
    setStill(q.matches);
    const change = () => setStill(q.matches);
    q.addEventListener('change', change);
    return () => q.removeEventListener('change', change);
  }, []);
  return still;
}

/**
 * Une vignette qui bouge : de la position de départ à la position dessinée, au
 * tempo de la séance (`lib/motion`), en boucle. Elle ne bouge que sous les
 * yeux — hors de l'écran ou app en arrière-plan, elle s'arrête. Un toucher la
 * fige sur la position dessinée, avec ses angles et ses flèches ; un second la
 * relance.
 */
function MovingPanel({ panel, uid, name, cycle, compact, three }: {
  panel: Panel; uid: string; name: string; cycle: Cycle; compact: boolean; three: { exercise: string; index: number } | null;
}) {
  const still = useStill();
  const [paused, setPaused] = useState(false);
  const [t, setT] = useState(0);
  const [seen, setSeen] = useState(false);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setSeen(e?.isIntersecting ?? false), { threshold: 0.2 });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  const running = seen && !paused && !still;
  useEffect(() => {
    if (!running) return;
    let raf = 0;
    let last = 0;
    const t0 = performance.now();
    const tick = (now: number) => {
      // Trente images par seconde : un geste lent n'en demande pas plus, la batterie si.
      if (now - last >= 32) {
        last = now;
        if (!document.hidden) setT(phaseAt(cycle, now - t0));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [running, cycle]);

  // Immobile — hors de l'écran, figé, sans mouvement permis : la position dessinée, annotée.
  const frame = running && panel.ghost ? between(panel.ghost, panel.pose, t) : undefined;
  // Les consignes arrivent avec la position qu'elles décrivent, et repartent avec elle.
  const notesShown = running ? Math.max(0, Math.min(1, (t - 0.8) / 0.2)) : 1;
  const control = still ? null : (
    <button
      type="button"
      className="xf-play"
      onClick={() => setPaused((p) => !p)}
      aria-label={paused ? 'Montrer le mouvement' : 'Arrêter le mouvement sur la position dessinée'}
    >
      {paused ? '▶' : '❚❚'}
    </button>
  );
  return (
    <div ref={ref} className="xf-moving">
      <PanelView
        panel={panel} uid={uid} name={name} frame={frame} phase={frame ? t : 1} three={three}
        moving={running} notesShown={notesShown} compact={compact} control={control}
      />
    </div>
  );
}

/** La largeur d'une vignette, px : en deçà, elle passe en `compact`. */
const COMPACT_PX = 460;

export function ExerciseFigure({ exercise, label, tempo }: { exercise: ExerciseKey; label: string; tempo?: string }) {
  const spec = FIGURES[exercise];
  const cycle = useMemo(() => cycleOf(tempo), [tempo]);
  const ref = useRef<HTMLDivElement | null>(null);
  const [compact, setCompact] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      const first = el.firstElementChild;
      const w = first instanceof HTMLElement ? first.clientWidth : el.clientWidth;
      setCompact(w > 0 && w < COMPACT_PX);
    };
    measure();
    const watch = new ResizeObserver(measure);
    watch.observe(el);
    return () => watch.disconnect();
  }, []);
  if (!spec) return null;
  return (
    <div ref={ref} className="xf-panels" data-count={spec.panels.length}>
      {spec.panels.map((p, i) => {
        const three = FIGURES_3D.has(exercise) ? { exercise, index: i } : null;
        return p.ghost
          ? <MovingPanel key={i} panel={p} uid={`${exercise}-${i}`} name={label} cycle={cycle} compact={compact} three={three} />
          : <PanelView key={i} panel={p} uid={`${exercise}-${i}`} name={label} compact={compact} three={three} />;
      })}
    </div>
  );
}
