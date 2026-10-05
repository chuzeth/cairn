import type { ReactNode } from 'react';
import type { ExerciseKey } from '@cairn/core/exercises';

/**
 * Le schéma d'un exercice : une silhouette de profil, la position qui compte,
 * et une flèche pour le mouvement.
 *
 * Une seule grammaire pour toutes les fiches : le corps en trait clair, la
 * jambe et le bras du fond plus pâles, le bras plâtré en ocre, plié contre le
 * buste — il ne porte jamais rien, et on le voit d'un coup d'œil —, le matériel
 * en gris, le mouvement en flèche. Les points sont posés à la main, dans une
 * boîte de 200 × 140 : ce sont des schémas, pas des mesures.
 */

type P = readonly [number, number];

interface Leg {
  knee: P;
  ankle: P;
  toe: P;
}

interface Body {
  head: P;
  neck: P;
  hip: P;
  near: Leg;
  far?: Leg;
  /** Le bras libre : coude, main. */
  free: { elbow: P; hand: P };
  /** Le bras plâtré : coude, main — toujours contre le buste. */
  cast: { elbow: P; hand: P };
}

interface Pose {
  body: Body;
  /** Le matériel et le décor : sol, banc, mur, machine. */
  props?: ReactNode;
  /** Le mouvement ; `via` le courbe. */
  arrows?: { from: P; to: P; via?: P }[];
}

const path = (...pts: P[]) => pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${x} ${y}`).join(' ');

const floor = (y = 128) => <line x1="10" y1={y} x2="190" y2={y} className="xf-prop" />;
const bench = (x1: number, x2: number, top: number, ground = 128) => (
  <g className="xf-prop">
    <line x1={x1} y1={top} x2={x2} y2={top} className="xf-prop-strong" />
    <line x1={x1 + 4} y1={top} x2={x1 + 4} y2={ground} />
    <line x1={x2 - 4} y1={top} x2={x2 - 4} y2={ground} />
  </g>
);
const wall = (x: number) => <line x1={x} y1="8" x2={x} y2="128" className="xf-prop-strong" />;
const dumbbell = ([x, y]: P) => (
  <g className="xf-prop-strong">
    <line x1={x - 5} y1={y} x2={x + 5} y2={y} />
    <rect x={x - 8} y={y - 4} width="3" height="8" rx="1" />
    <rect x={x + 5} y={y - 4} width="3" height="8" rx="1" />
  </g>
);

/** Le bras plâtré au repos, en écharpe : coude au flanc, avant-bras devant la poitrine. */
const sling = (neck: P, hip: P, facing: 1 | -1 = 1): Body['cast'] => {
  const elbow: P = [neck[0] + (hip[0] - neck[0]) * 0.5 - 2 * facing, neck[1] + (hip[1] - neck[1]) * 0.5];
  return { elbow, hand: [elbow[0] + 13 * facing, elbow[1] - 9] };
};

const standing = (x: number, extra: Partial<Body> = {}): Body => {
  const neck: P = [x, 34];
  const hip: P = [x, 74];
  return {
    head: [x, 22], neck, hip,
    near: { knee: [x + 2, 100], ankle: [x + 2, 125], toe: [x + 12, 127] },
    far: { knee: [x - 2, 100], ankle: [x - 2, 125], toe: [x + 8, 127] },
    free: { elbow: [x + 3, 55], hand: [x + 4, 75] },
    cast: sling(neck, hip),
    ...extra,
  };
};

const POSES: Partial<Record<ExerciseKey, Pose>> = {
  presse: {
    body: {
      head: [44, 56], neck: [54, 66], hip: [82, 94],
      near: { knee: [106, 70], ankle: [130, 90], toe: [134, 80] },
      far: { knee: [104, 72], ankle: [128, 92], toe: [132, 82] },
      free: { elbow: [72, 92], hand: [88, 102] },
      cast: { elbow: [66, 80], hand: [78, 72] },
    },
    props: (
      <g className="xf-prop">
        <line x1="34" y1="50" x2="84" y2="102" className="xf-prop-strong" />
        <line x1="84" y1="102" x2="104" y2="104" className="xf-prop-strong" />
        <line x1="124" y1="66" x2="144" y2="100" className="xf-prop-strong" />
        <line x1="60" y1="106" x2="60" y2="128" />
        {floor()}
      </g>
    ),
    arrows: [{ from: [146, 84], to: [160, 76] }],
  },
  'split-squat-bulgare': {
    body: {
      head: [104, 30], neck: [101, 42], hip: [92, 82],
      near: { knee: [120, 100], ankle: [118, 125], toe: [129, 127] },
      far: { knee: [78, 114], ankle: [60, 98], toe: [52, 97] },
      free: { elbow: [98, 62], hand: [98, 80] },
      cast: sling([101, 42], [92, 82]),
    },
    props: (
      <>
        {bench(30, 70, 100)}
        {dumbbell([98, 84])}
        {floor()}
      </>
    ),
    arrows: [{ from: [140, 74], to: [140, 96] }],
  },
  'extension-hanche': {
    // Le haut du mouvement : le corps aligné sur le banc, de la tête aux talons.
    body: {
      head: [58, 30], neck: [68, 40], hip: [106, 80],
      near: { knee: [126, 100], ankle: [146, 120], toe: [152, 112] },
      free: { elbow: [86, 62], hand: [96, 54] },
      cast: { elbow: [80, 56], hand: [92, 48] },
    },
    props: (
      <g className="xf-prop">
        <line x1="98" y1="88" x2="116" y2="70" className="xf-prop-strong" />
        <line x1="144" y1="126" x2="158" y2="112" className="xf-prop-strong" />
        <line x1="108" y1="82" x2="108" y2="128" />
        <line x1="108" y1="128" x2="156" y2="128" />
      </g>
    ),
    arrows: [{ from: [58, 106], via: [26, 80], to: [40, 42] }],
  },
  'leg-curl': {
    body: {
      head: [86, 36], neck: [88, 48], hip: [90, 88],
      near: { knee: [118, 86], ankle: [112, 114], toe: [120, 118] },
      free: { elbow: [96, 70], hand: [102, 88] },
      cast: sling([88, 48], [90, 88]),
    },
    props: (
      <g className="xf-prop">
        <line x1="76" y1="94" x2="118" y2="94" className="xf-prop-strong" />
        <line x1="78" y1="44" x2="80" y2="94" className="xf-prop-strong" />
        <circle cx="108" cy="118" r="5" className="xf-prop-strong" />
        <line x1="96" y1="94" x2="96" y2="128" />
        {floor()}
      </g>
    ),
    arrows: [{ from: [146, 92], to: [128, 118] }],
  },
  'mollets-machine': {
    body: {
      head: [86, 36], neck: [88, 48], hip: [90, 88],
      near: { knee: [118, 86], ankle: [120, 110], toe: [131, 116] },
      free: { elbow: [100, 70], hand: [112, 80] },
      cast: sling([88, 48], [90, 88]),
    },
    props: (
      <g className="xf-prop">
        <line x1="76" y1="94" x2="104" y2="94" className="xf-prop-strong" />
        <rect x="108" y="78" width="22" height="6" rx="2" className="xf-prop-strong" />
        <rect x="124" y="116" width="22" height="12" className="xf-prop-strong" />
        <line x1="90" y1="94" x2="90" y2="128" />
        {floor()}
      </g>
    ),
    arrows: [{ from: [112, 124], to: [112, 108] }],
  },
  'bras-libre': {
    body: {
      head: [96, 40], neck: [96, 52], hip: [96, 92],
      near: { knee: [122, 92], ankle: [122, 124], toe: [132, 126] },
      free: { elbow: [110, 40], hand: [108, 18] },
      cast: sling([96, 52], [96, 92]),
    },
    props: (
      <>
        {bench(74, 112, 96)}
        {dumbbell([108, 16])}
        {floor()}
      </>
    ),
    arrows: [{ from: [126, 34], to: [126, 12] }],
  },
  'anti-rotation': {
    // De face, la poulie sur le côté : la poignée contre la poitrine, la poulie
    // tire le buste vers elle, et il ne doit pas tourner.
    body: {
      head: [110, 22], neck: [110, 34], hip: [110, 74],
      near: { knee: [117, 100], ankle: [121, 125], toe: [126, 127] },
      far: { knee: [103, 100], ankle: [99, 125], toe: [94, 127] },
      free: { elbow: [123, 46], hand: [112, 50] },
      cast: { elbow: [99, 56], hand: [111, 58] },
    },
    props: (
      <g className="xf-prop">
        <line x1="24" y1="16" x2="24" y2="128" className="xf-prop-strong" />
        <circle cx="24" cy="50" r="4" className="xf-prop-strong" />
        <line x1="28" y1="50" x2="110" y2="50" strokeDasharray="4 3" />
        {floor()}
      </g>
    ),
    arrows: [{ from: [80, 40], to: [50, 40] }],
  },
  'step-up': {
    body: {
      head: [118, 16], neck: [118, 28], hip: [118, 66],
      near: { knee: [122, 82], ankle: [122, 98], toe: [132, 100] },
      far: { knee: [110, 90], ankle: [100, 112], toe: [97, 104] },
      free: { elbow: [121, 46], hand: [122, 64] },
      cast: sling([118, 28], [118, 66]),
    },
    props: (
      <>
        <rect x="104" y="100" width="44" height="28" className="xf-prop xf-prop-strong" />
        {dumbbell([122, 68])}
        {floor()}
      </>
    ),
    arrows: [{ from: [160, 96], to: [160, 72] }],
  },
  'pont-une-jambe': {
    body: {
      head: [38, 116], neck: [50, 118], hip: [98, 94],
      near: { knee: [124, 90], ankle: [128, 120], toe: [138, 124] },
      far: { knee: [128, 80], ankle: [154, 68], toe: [160, 62] },
      free: { elbow: [66, 124], hand: [84, 126] },
      cast: { elbow: [70, 106], hand: [82, 100] },
    },
    props: floor(),
    arrows: [{ from: [98, 122], to: [98, 104] }],
  },
  chaise: {
    body: {
      head: [66, 38], neck: [66, 50], hip: [66, 92],
      near: { knee: [96, 92], ankle: [96, 124], toe: [106, 126] },
      free: { elbow: [78, 76], hand: [90, 88] },
      cast: sling([66, 50], [66, 92]),
    },
    props: (
      <>
        {wall(58)}
        {floor()}
      </>
    ),
  },
  'mollets-excentriques': {
    body: standing(108, {
      near: { knee: [110, 100], ankle: [112, 112], toe: [122, 104] },
      far: { knee: [106, 100], ankle: [96, 111], toe: [102, 117] },
      free: { elbow: [124, 48], hand: [146, 46] },
    }),
    props: (
      <>
        <rect x="114" y="104" width="30" height="24" className="xf-prop xf-prop-strong" />
        {wall(150)}
        {floor()}
      </>
    ),
    arrows: [{ from: [86, 98], to: [86, 118] }],
  },
  'releves-pointe': {
    body: {
      head: [66, 22], neck: [66, 34], hip: [70, 76],
      near: { knee: [82, 100], ankle: [94, 124], toe: [103, 114] },
      free: { elbow: [74, 56], hand: [80, 74] },
      cast: sling([66, 34], [70, 76]),
    },
    props: (
      <>
        {wall(58)}
        {floor()}
      </>
    ),
    arrows: [{ from: [114, 124], to: [114, 106] }],
  },
  abduction: {
    // De dos, face au mur : seule cette vue montre la jambe qui s'écarte.
    body: {
      head: [100, 22], neck: [100, 34], hip: [100, 74],
      near: { knee: [110, 99], ankle: [120, 122], toe: [124, 126] },
      far: { knee: [96, 100], ankle: [95, 124], toe: [92, 127] },
      free: { elbow: [86, 46], hand: [80, 38] },
      cast: { elbow: [113, 54], hand: [104, 47] },
    },
    props: (
      <>
        <rect x="16" y="8" width="168" height="106" className="xf-wall" />
        <line x1="96" y1="118" x2="119" y2="117" strokeDasharray="3 3" className="xf-band" />
        {floor()}
      </>
    ),
    arrows: [{ from: [126, 110], to: [146, 104] }],
  },
  'dead-bug': {
    body: {
      head: [36, 116], neck: [48, 118], hip: [96, 118],
      near: { knee: [98, 92], ankle: [124, 92], toe: [130, 86] },
      far: { knee: [122, 108], ankle: [150, 116], toe: [156, 110] },
      free: { elbow: [62, 108], hand: [74, 104] },
      cast: { elbow: [70, 112], hand: [84, 108] },
    },
    props: floor(124),
    arrows: [{ from: [150, 98], to: [160, 112] }],
  },
  'gainage-lateral': {
    body: {
      head: [50, 85], neck: [60, 92], hip: [106, 108],
      near: { knee: [130, 116], ankle: [154, 124], toe: [158, 127] },
      free: { elbow: [60, 124], hand: [80, 124] },
      cast: { elbow: [82, 93], hand: [100, 102] },
    },
    props: floor(),
    arrows: [{ from: [100, 127], to: [100, 113] }],
  },
  'marche-tapis': {
    body: {
      head: [107, 18], neck: [104, 30], hip: [100, 68],
      near: { knee: [112, 90], ankle: [116, 110], toe: [126, 108] },
      far: { knee: [92, 94], ankle: [84, 112], toe: [92, 117] },
      free: { elbow: [96, 48], hand: [94, 66] },
      cast: sling([104, 30], [100, 68]),
    },
    props: (
      <g className="xf-prop">
        <line x1="40" y1="126" x2="164" y2="106" className="xf-prop-strong" />
        <line x1="40" y1="131" x2="164" y2="111" />
        <line x1="150" y1="108" x2="156" y2="48" className="xf-prop-strong" />
        <line x1="148" y1="48" x2="166" y2="48" className="xf-prop-strong" />
      </g>
    ),
  },
  intervalles: {
    body: {
      head: [76, 52], neck: [82, 62], hip: [96, 96],
      near: { knee: [118, 80], ankle: [140, 92], toe: [144, 84] },
      far: { knee: [120, 92], ankle: [142, 104], toe: [146, 96] },
      free: { elbow: [92, 80], hand: [102, 92] },
      cast: sling([82, 62], [96, 96]),
    },
    props: (
      <g className="xf-prop">
        <line x1="70" y1="50" x2="88" y2="104" className="xf-prop-strong" />
        <line x1="88" y1="104" x2="110" y2="104" className="xf-prop-strong" />
        <circle cx="144" cy="94" r="10" />
        <line x1="100" y1="104" x2="100" y2="128" />
        <line x1="144" y1="104" x2="144" y2="128" />
        {floor()}
      </g>
    ),
    arrows: [{ from: [156, 84], via: [166, 100], to: [150, 109] }],
  },
  'marche-cote': {
    body: {
      head: [104, 20], neck: [102, 32], hip: [98, 68],
      near: { knee: [110, 82], ankle: [110, 97], toe: [119, 99] },
      far: { knee: [90, 92], ankle: [80, 109], toe: [89, 111] },
      free: { elbow: [114, 50], hand: [124, 44] },
      cast: sling([102, 32], [98, 68]),
    },
    props: (
      <g className="xf-prop">
        <path d={path([30, 128], [30, 124], [60, 124], [60, 112], [90, 112], [90, 100], [120, 100], [120, 88], [150, 88], [150, 76], [180, 76])} className="xf-prop-strong" fill="none" />
        <line x1="40" y1="74" x2="176" y2="26" />
      </g>
    ),
    arrows: [{ from: [140, 70], to: [164, 58] }],
  },
  'soins-bras': {
    body: standing(96, { cast: { elbow: [112, 30], hand: [126, 18] } }),
    props: floor(),
    arrows: [{ from: [140, 52], to: [140, 24] }],
  },
  respiration: {
    body: {
      head: [40, 108], neck: [52, 112], hip: [100, 116],
      near: { knee: [120, 96], ankle: [138, 118], toe: [148, 118] },
      free: { elbow: [72, 104], hand: [82, 108] },
      cast: { elbow: [66, 112], hand: [76, 116] },
    },
    props: (
      <>
        <path d="M72 100 Q 84 84 96 100" className="xf-band" fill="none" />
        {floor(122)}
      </>
    ),
    arrows: [{ from: [84, 92], to: [84, 78] }],
  },
  souplesse: {
    body: {
      head: [36, 116], neck: [48, 118], hip: [96, 118],
      near: { knee: [98, 90], ankle: [100, 62], toe: [108, 58] },
      far: { knee: [122, 118], ankle: [148, 118], toe: [152, 112] },
      free: { elbow: [66, 104], hand: [84, 92] },
      cast: { elbow: [66, 114], hand: [80, 110] },
    },
    props: (
      <>
        <path d={path([84, 92], [102, 58])} className="xf-band" />
        {floor(124)}
      </>
    ),
  },
  activation: {
    body: {
      head: [100, 30], neck: [100, 42], hip: [98, 82],
      near: { knee: [122, 100], ankle: [120, 125], toe: [131, 127] },
      far: { knee: [84, 120], ankle: [64, 124], toe: [60, 120] },
      free: { elbow: [118, 46], hand: [140, 44] },
      cast: sling([100, 42], [98, 82]),
    },
    props: (
      <>
        {wall(146)}
        {floor()}
      </>
    ),
    arrows: [{ from: [92, 96], to: [92, 112] }],
  },
};

export const hasFigure = (key: string): boolean => key in POSES;

export function ExerciseFigure({ exercise, label }: { exercise: ExerciseKey; label: string }) {
  const pose = POSES[exercise];
  if (!pose) return null;
  const { body: b } = pose;
  const leg = (l: Leg) => path(b.hip, l.knee, l.ankle, l.toe);
  return (
    <svg viewBox="0 0 200 140" className="xf" role="img" aria-label={`Schéma : ${label}`}>
      <defs>
        <marker id={`xf-head-${exercise}`} viewBox="0 0 10 10" refX="7" refY="5" markerWidth="5" markerHeight="5" orient="auto-start-reverse">
          <path d="M0 0 L10 5 L0 10 z" className="xf-arrow-head" />
        </marker>
      </defs>
      {pose.props}
      {b.far && <path d={leg(b.far)} className="xf-far" />}
      <path d={path(b.neck, b.cast.elbow, b.cast.hand)} className="xf-cast" />
      <path d={path(b.neck, b.hip)} className="xf-body" />
      <path d={leg(b.near)} className="xf-body" />
      <path d={path(b.neck, b.free.elbow, b.free.hand)} className="xf-body" />
      <circle cx={b.head[0]} cy={b.head[1]} r="8" className="xf-head" />
      {pose.arrows?.map((a, i) => (
        <path
          key={i} className="xf-arrow" markerEnd={`url(#xf-head-${exercise})`}
          d={a.via ? `M${a.from[0]} ${a.from[1]} Q${a.via[0]} ${a.via[1]} ${a.to[0]} ${a.to[1]}` : path(a.from, a.to)}
        />
      ))}
    </svg>
  );
}
