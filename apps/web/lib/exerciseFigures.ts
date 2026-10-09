import type { ExerciseKey } from '@cairn/core/exercises';
import {
  FURNITURE, SEG, ankleFromBall, ankleFromHeel, ankleFromToe, doorHook, type FigureSpec, type Pt, type SidePose,
} from './figure';

/**
 * Les positions de chaque exercice, posées par leurs appuis.
 *
 * Un pied se pose par son talon ou l'avant de son pied, une main par l'endroit
 * qu'elle tient : genoux et coudes se résolvent (`lib/figure`). Le décor a les
 * mesures d'un appartement — canapé de 42 cm, marche de 17, porte de 2 m.
 * Chaque appui déclaré dans `contacts` est vérifié par les tests, comme chaque
 * angle affiché.
 */

const A = SEG.ankle;
const RAD = Math.PI / 180;
const STAIR = FURNITURE.stair;
/** Le step de Pierre : 20 cm, ou 40 — la hauteur du tabouret. */
const STEP = { low: 20 / 1.8, high: FURNITURE.stool.seat, depth: 17 } as const;
/** Le haut d'un cadre de porte : 2,04 m. */
const LINTEL = 204 / 1.8;

/** Couché sur le dos : les épaules au sol en `sx`, le bassin à la hauteur `h`. La tête reste posée. */
function supine(sx: number, h: number): Pick<SidePose, 'hip' | 'lean' | 'nod'> {
  const shoulderY = 6.6;
  const lean = -Math.acos(Math.max(-1, Math.min(1, (shoulderY - h) / SEG.trunk))) / RAD;
  return { hip: [sx - SEG.trunk * Math.sin(lean * RAD), h], lean, nod: -90 - lean };
}

/** Allongé à plat sur le dos, les épaules en `sx`. */
const flat = (sx: number) => supine(sx, 7);

/** La rampe d'un escalier `stairs` posé en `x0` : sa hauteur au droit de `x`. */
const railY = (x0: number, x: number) => 50 + STAIR.rise + ((x - x0) / STAIR.run) * STAIR.rise;

/** Le bras libre posé au sol le long du corps, paume vers le bas : de l'épaule, il descend jusqu'au sol. */
const armOnFloor = (_sx: number): { upper: number; fore: number } => ({ upper: 78, fore: 88 });

export const FIGURES: Partial<Record<ExerciseKey, FigureSpec>> = {
  // ───────────────────────── La semaine à la maison ─────────────────────────

  'echauffement-maison': {
    panels: [
      {
        label: 'Avant de te lever : assis au bord, le buste penché',
        props: [{ kind: 'floor' }, { kind: 'chair', x: -2, face: 1 }],
        pose: {
          view: 'side', hip: [-11, 31.6], lean: 36,
          near: { ankle: [8, A] }, far: { ankle: [6, A] },
          free: { upper: 62, fore: 80 },
        },
        guides: [{ from: 'near.toe', to: [19.2, 72] }],
        notes: [{ text: 'le nez au-dessus\ndes orteils', at: [19.2, 72], dx: 4, dy: 4 }],
        contacts: [{ ref: 'near.heel', y: 0 }, { part: 'trunk', y: FURNITURE.chair.seat, tol: 1.2 }],
      },
      {
        label: 'Debout en 1 seconde, sans les mains',
        ghostLabel: 'Assis, le buste penché',
        props: [{ kind: 'floor' }, { kind: 'chair', x: -2, face: 1 }],
        ghost: {
          view: 'side', hip: [-11, 31.6], lean: 36,
          near: { ankle: [8, A] }, far: { ankle: [6, A] },
          free: { upper: 62, fore: 80 },
        },
        pose: {
          view: 'side', hip: [6.5, 52.3], lean: 2,
          near: { ankle: [8, A] }, far: { ankle: [6, A] },
          free: { upper: 3, fore: 8 },
        },
        motions: [{ joint: 'hip', bend: -9, label: '1 s' }],
        notes: [{ text: 'pousse dans\nles talons', at: 'near.heel', dx: 14, dy: 7 }],
        muscles: [{ muscle: 'quads' }, { muscle: 'glutes' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }],
      },
    ],
  },

  'split-squat-maison': {
    panels: [
      {
        label: 'En bas : 3 s pour y descendre, 1 s tenue',
        ghostLabel: 'En haut',
        props: [{ kind: 'floor' }, { kind: 'stool', x: -40, face: 1 }, { kind: 'jamb', x: 27 }],
        ghost: {
          view: 'side', hip: [-8, 48.5], lean: 8,
          near: { ankle: [9.7, A] }, far: { ankle: [-46, 24.8], sole: 200 },
          free: { hand: [26, 67] },
        },
        pose: {
          view: 'side', hip: [-12, 31], lean: 16,
          near: { ankle: [9.7, A] }, far: { ankle: [-46, 24.8], sole: 200 },
          free: { hand: [26, 52] },
        },
        motions: [{ joint: 'hip', bend: 7, label: '3 s' }],
        angles: [{ at: 'near.knee', a: 'near.hip', b: 'near.ankle' }],
        guides: [{ from: 'near.ankle', to: [9.7, 38] }, { from: [-25.6, 7.4], to: [-25.6, 0.3] }],
        notes: [
          { text: 'tibia vertical', at: [9.7, 38], dx: 4, dy: 6 },
          { text: 'les lacets\nsur le step', at: [-50, 23], dx: -4, dy: 22 },
          { text: '≈ 15 cm', at: [-25.6, 3.2], dx: 2.5, dy: -0.4 },
        ],
        muscles: [{ muscle: 'quads' }, { muscle: 'glutes' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }, { part: 'far.foot', y: FURNITURE.stool.seat }],
        ghostContacts: [{ ref: 'near.heel', y: 0 }, { part: 'far.foot', y: FURNITURE.stool.seat }],
      },
    ],
  },

  'leg-curl-serviette': {
    panels: [
      {
        label: 'Talons loin, bassin haut : 4 s',
        ghostLabel: 'Le pont, genoux pliés',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -48, to: -2 }, { kind: 'towel', x: 47, w: 12 }],
        ghost: {
          view: 'side', ...supine(-30, 19),
          near: { ankle: [27.8, 4.8] }, far: { ankle: [26.8, 4.8] },
          free: armOnFloor(-30), cast: { elbow: [-17, 15], hand: [-9, 21.5], over: true },
        },
        pose: {
          view: 'side', ...supine(-30, 12),
          near: { ankle: [44.6, 5.6], sole: 75 }, far: { ankle: [43.6, 5.6], sole: 75 },
          free: armOnFloor(-30), cast: { elbow: [-16, 11], hand: [-8, 17], over: true },
        },
        motions: [{ from: [24, -3.4], to: [48, -3.4], bend: -1.5, label: '4 s' }],
        notes: [
          { text: 'bassin haut', at: 'hip', dx: 0, dy: 15 },
          { text: 'serviette\nsur parquet', at: [52, 0.9], dx: 6, dy: 9 },
        ],
        muscles: [{ muscle: 'hamstrings' }, { muscle: 'glutes' }],
        contacts: [{ ref: 'near.heel', y: 0.9 }, { part: 'trunk', y: 0, tol: 1 }],
        ghostContacts: [{ ref: 'near.heel', y: 0.9 }, { part: 'trunk', y: 0, tol: 1 }],
      },
    ],
  },

  'mollets-excentriques': {
    panels: [
      {
        label: 'Genou tendu : talon sous le step en 3 s',
        ghostLabel: 'Sur la pointe',
        props: [{ kind: 'floor' }, { kind: 'box', x: 22, h: STEP.low, depth: STEP.depth, face: 1 }, { kind: 'wall', x: 22, face: -1 }],
        ghost: {
          view: 'side', hip: [5.2, 67.6], lean: 2,
          near: { ankle: ankleFromBall([7.5, STEP.low], -35), sole: -35 },
          far: { thigh: -10, shank: -78, sole: -60 },
          free: { hand: [22, 88] },
        },
        pose: {
          view: 'side', hip: [0.6, 60.7], lean: 2,
          near: { ankle: ankleFromBall([7.5, STEP.low], 20), sole: 20 },
          far: { thigh: -10, shank: -78, sole: -60 },
          free: { hand: [22, 84] },
        },
        motions: [{ joint: 'near.heel', bend: -5, label: '3 s' }],
        notes: [{ text: 'talon sous\nle step', at: 'near.heel', dx: -10, dy: 7 }],
        muscles: [{ muscle: 'calves' }],
        contacts: [{ ref: 'near.ball', y: STEP.low }],
        ghostContacts: [{ ref: 'near.ball', y: STEP.low }],
      },
      {
        label: 'Genou fléchi : le soléaire, le même tempo',
        props: [{ kind: 'floor' }, { kind: 'box', x: 22, h: STEP.low, depth: STEP.depth, face: 1 }, { kind: 'wall', x: 22, face: -1 }],
        pose: {
          view: 'side', hip: [-3.1, 60.1], lean: 10,
          near: { ankle: ankleFromBall([7.5, STEP.low], 15), sole: 15 },
          far: { thigh: 4, shank: -58, sole: -55 },
          free: { hand: [22, 82] },
        },
        notes: [{ text: 'genou fléchi\nde 30°', at: 'near.knee', dx: -14, dy: 22 }],
        muscles: [{ muscle: 'soleus' }],
        contacts: [{ ref: 'near.ball', y: STEP.low }],
      },
    ],
  },

  'pont-une-jambe': {
    panels: [
      {
        label: 'En haut, la fesse serrée 2 s',
        ghostLabel: 'Bassin posé',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -48, to: 8 }],
        ghost: {
          view: 'side', ...flat(-28),
          near: { ankle: [30.6, A] }, far: { thigh: 128, shank: 128, sole: 55 },
          free: armOnFloor(-28), cast: { elbow: [-15, 10], hand: [-7, 14.5], over: true },
        },
        pose: {
          view: 'side', ...supine(-28, 17.6),
          near: { ankle: [30.6, A] }, far: { thigh: 112, shank: 112, sole: 70 },
          free: armOnFloor(-28), cast: { elbow: [-15, 13.5], hand: [-7, 19], over: true },
        },
        motions: [{ joint: 'hip', label: '1 s' }],
        angles: [{ at: 'near.knee', a: 'near.hip', b: 'near.ankle' }],
        guides: [{ from: 'shoulder', to: 'near.knee' }],
        notes: [{ text: 'épaule, hanche, genou :\nune ligne', at: [-14, 12.5], dx: -2, dy: 22 }],
        muscles: [{ muscle: 'glutes' }, { muscle: 'hamstrings' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }, { part: 'head', y: 0, tol: 1.5 }],
        ghostContacts: [{ ref: 'near.heel', y: 0 }, { part: 'trunk', y: 0, tol: 1 }],
      },
    ],
  },

  'tirage-elastique': {
    panels: [
      {
        label: 'Coude tiré le long des côtes, 1 s tenue',
        ghostLabel: 'Bras tendu, l’élastique déjà tendu',
        props: [{ kind: 'floor' }, { kind: 'door', x: 52, anchor: 72 }],
        hold: 'handle',
        ghost: {
          view: 'side', hip: [0, 51], lean: 8,
          near: { ankle: [10, A] }, far: { ankle: [-12, A] },
          free: { hand: [36, 73] },
        },
        pose: {
          view: 'side', hip: [0, 51], lean: 8,
          near: { ankle: [10, A] }, far: { ankle: [-12, A] },
          free: { hand: [7, 64] },
        },
        bands: [{ from: doorHook(52, 72), to: 'free.wrist', kind: 'long' }],
        ghostBands: [{ from: doorHook(52, 72), to: 'free.wrist', kind: 'long' }],
        motions: [{ joint: 'free.wrist', bend: 5, label: '1 s' }],
        notes: [
          { text: 'coude au ras\ndes côtes', at: 'free.elbow', dx: -10, dy: -7 },
          { text: 'omoplate vers\nla colonne', at: 'shoulder', dx: -12, dy: 9 },
        ],
        muscles: [{ muscle: 'back' }, { muscle: 'biceps' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'far.ball', y: 0 }],
      },
    ],
  },

  'bras-elastique': {
    panels: [
      {
        label: 'Plier : la main monte à l’épaule',
        ghostLabel: 'Bras tendu',
        props: [{ kind: 'floor' }, { kind: 'door', x: 30, anchor: 8 }],
        hold: 'handle',
        ghost: {
          view: 'side', hip: [0, 52.3], lean: 0,
          near: { ankle: [1.5, A] }, far: { ankle: [-1.5, A] },
          free: { upper: 3, fore: 20 },
        },
        pose: {
          view: 'side', hip: [0, 52.3], lean: 0,
          near: { ankle: [1.5, A] }, far: { ankle: [-1.5, A] },
          free: { upper: 3, fore: 150 },
        },
        bands: [{ from: doorHook(30, 8), to: 'free.wrist', kind: 'long' }],
        ghostBands: [{ from: doorHook(30, 8), to: 'free.wrist', kind: 'long' }],
        motions: [{ joint: 'free.wrist', bend: -8, label: '1 s' }],
        notes: [
          { text: 'coude collé\nau flanc', at: 'free.elbow', dx: -12, dy: -4 },
          { text: 'l’accroche\nen bas\nde la porte', at: doorHook(30, 8), dx: 8, dy: 18 },
        ],
        muscles: [{ muscle: 'biceps' }, { muscle: 'forearm' }],
        contacts: [{ ref: 'near.heel', y: 0 }],
      },
      {
        label: 'Tendre : le bras descend vers la cuisse',
        ghostLabel: 'Coude à angle droit',
        props: [{ kind: 'floor' }, { kind: 'door', x: 24, anchor: 108 }],
        hold: 'handle',
        ghost: {
          view: 'side', hip: [0, 52.3], lean: 5,
          near: { ankle: [2, A] }, far: { ankle: [-2, A] },
          free: { upper: 4, fore: 92 },
        },
        pose: {
          view: 'side', hip: [0, 52.3], lean: 5,
          near: { ankle: [2, A] }, far: { ankle: [-2, A] },
          free: { upper: 4, fore: 12 },
        },
        bands: [{ from: doorHook(24, 108), to: 'free.wrist', kind: 'long' }],
        ghostBands: [{ from: doorHook(24, 108), to: 'free.wrist', kind: 'long' }],
        motions: [{ joint: 'free.wrist', bend: 7, label: '1 s' }],
        notes: [
          { text: 'coude fixe', at: 'free.elbow', dx: -10, dy: 2 },
          { text: 'l’accroche en haut', at: doorHook(24, 108), dx: -3, dy: 6 },
        ],
        muscles: [{ muscle: 'triceps' }],
        contacts: [{ ref: 'near.heel', y: 0 }],
      },
    ],
  },

  'anti-rotation': {
    panels: [
      {
        label: 'De face : de profil à la porte, la poignée contre la poitrine',
        props: [
          { kind: 'floor' },
          { kind: 'shape', pts: [[-44, 0], [-44, 110]], tone: 'metal' },
          { kind: 'shape', pts: [[-44, 72], [-38, 72]], tone: 'line' },
        ],
        hold: 'handle',
        pose: {
          view: 'front', pelvis: [0, 50],
          left: { ankle: [-9, A] }, right: { ankle: [9, A] },
          free: { side: 'right', elbow: [11, 63], hand: [2, 71] },
        },
        bands: [{ from: [-38, 72], to: 'free.wrist', kind: 'long' }],
        notes: [
          { text: 'la porte, vue\nde la tranche', at: [-44, 100], dx: 4, dy: 4 },
          { text: 'genoux souples', at: 'right.knee', dx: 10, dy: 0 },
        ],
        contacts: [{ ref: 'left.ankle', y: A }],
      },
      {
        label: 'Vu de dessus : tends le bras 2 s, tiens 3 s, le buste ne tourne pas',
        ghostLabel: 'La poignée contre la poitrine',
        props: [
          { kind: 'shape', pts: [[-50, -14], [-50, 40]], tone: 'line' },
          { kind: 'circle', c: [-48.6, 9], r: 1.3, tone: 'line' },
        ],
        hold: 'handle',
        ghost: { view: 'top', at: [0, 0], free: { side: 'right', elbow: [11, 9], hand: [3, 9] } },
        pose: { view: 'top', at: [0, 0], free: { side: 'right', elbow: [7, 16], hand: [1, 31] } },
        bands: [{ from: [-48.6, 9], to: 'free.wrist', kind: 'long' }],
        ghostBands: [{ from: [-48.6, 9], to: 'free.wrist', kind: 'long' }],
        motions: [{ joint: 'free.wrist', bend: -4, label: '2 s' }],
        notes: [
          { text: 'les épaules\nrestent face\nà l’avant', at: [12, -2], dx: 9, dy: -6 },
        ],
      },
    ],
  },

  'descente-marche': {
    panels: [
      {
        label: 'En bas : 4 s, le talon effleure le sol',
        ghostLabel: 'Debout sur le step',
        props: [
          { kind: 'floor' },
          { kind: 'jamb', x: 4 },
          { kind: 'box', x: 4, h: STEP.low, depth: STEP.depth, face: 1 },
        ],
        ghost: {
          view: 'side', hip: [-8.5, 63.6], lean: 3,
          near: { ankle: [-8, STEP.low + A] }, far: { ankle: [8, 18], sole: 10 },
          free: { hand: [4, 76] },
        },
        pose: {
          view: 'side', hip: [-10, 49.5], lean: 25,
          near: { ankle: [-8, STEP.low + A] },
          far: { ankle: ankleFromHeel([7, 0], 15), sole: 15 },
          free: { hand: [5, 62] },
        },
        motions: [{ joint: 'hip', bend: -8, label: '4 s' }],
        angles: [{ at: 'near.knee', a: 'near.hip', b: 'near.ankle' }],
        notes: [
          { text: 'le talon effleure,\nil ne se pose pas', at: 'far.heel', dx: 10, dy: 14 },
          { text: 'step\nde 20 cm', at: [-13, 9], dx: -4, dy: 0 },
        ],
        muscles: [{ muscle: 'quads' }, { muscle: 'glutes' }],
        contacts: [{ ref: 'near.heel', y: STEP.low }, { ref: 'near.ball', y: STEP.low }, { ref: 'far.heel', y: 0 }],
        ghostContacts: [{ ref: 'near.heel', y: STEP.low }],
      },
    ],
  },

  'souleve-une-jambe': {
    panels: [
      {
        label: 'Le buste vers l’horizontale en 3 s',
        ghostLabel: 'Debout sur une jambe',
        props: [{ kind: 'floor' }, { kind: 'jamb', x: 5 }],
        ghost: {
          view: 'side', hip: [0, 52.2], lean: 0,
          near: { ankle: [1, A] }, far: { ankle: [-8, 8.5], sole: -30 },
          free: { hand: [5, 52] },
        },
        pose: {
          view: 'side', hip: [-4, 49], lean: 78, nod: 8,
          near: { ankle: [1, A] }, far: { thigh: -78, shank: -78, sole: -90 },
          free: { hand: [5, 50] },
        },
        motions: [{ joint: 'shoulder', bend: 9, label: '3 s' }],
        guides: [{ from: 'head', to: 'far.heel' }],
        notes: [
          { text: 'du crâne au talon :\nune seule ligne', at: [-30, 43], dx: -2, dy: 18 },
          { text: 'genou souple', at: 'near.knee', dx: 10, dy: -4 },
        ],
        muscles: [{ muscle: 'hamstrings' }, { muscle: 'glutes' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }],
        ghostContacts: [{ ref: 'near.heel', y: 0 }],
      },
    ],
  },

  chaise: {
    panels: [
      {
        label: 'Cuisses parallèles au sol, le dos plaqué',
        props: [{ kind: 'floor' }, { kind: 'wall', x: -8, face: 1 }],
        pose: {
          view: 'side', hip: [-1, 28.5], lean: 0,
          near: { ankle: [23.5, A] }, far: { ankle: [22, A] },
          free: { hand: [13, 33.5] },
        },
        angles: [{ at: 'near.knee', a: 'near.hip', b: 'near.ankle' }],
        guides: [{ from: 'near.ankle', to: 'near.knee' }],
        notes: [{ text: 'tiens en respirant,\nsans bloquer', at: 'head', dx: 10, dy: 3 }],
        muscles: [{ muscle: 'quads' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }],
      },
      {
        label: 'Sur une jambe : l’autre pied levé de 5 cm',
        props: [{ kind: 'floor' }, { kind: 'wall', x: -8, face: 1 }],
        pose: {
          view: 'side', hip: [-1, 28.5], lean: 0,
          near: { ankle: [23.5, A] }, far: { ankle: [23, A + 2.8] },
          free: { hand: [13, 33.5] },
        },
        notes: [{ text: '5 cm', at: 'far.heel', dx: -9, dy: -1 }],
        muscles: [{ muscle: 'quads' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }, { ref: 'far.heel', y: 2.8 }],
      },
    ],
  },

  'releves-pointe': {
    panels: [
      {
        label: 'Pointes levées, talons au sol, 1 s',
        ghostLabel: 'Pieds à plat',
        props: [{ kind: 'floor' }, { kind: 'wall', x: -8, face: 1 }],
        ghost: {
          view: 'side', hip: [-1, 51], lean: -2,
          near: { ankle: ankleFromHeel([9, 0], 0) }, far: { ankle: ankleFromHeel([8, 0], 0) },
          free: { upper: 2, fore: 3 },
        },
        pose: {
          view: 'side', hip: [-1, 51], lean: -2,
          near: { ankle: ankleFromHeel([9, 0], 28), sole: 28 }, far: { ankle: ankleFromHeel([8, 0], 28), sole: 28 },
          free: { upper: 2, fore: 3 },
        },
        motions: [{ joint: 'near.toe', bend: -4, label: '1 s' }],
        notes: [
          { text: 'talons au sol', at: 'near.heel', dx: 16, dy: 10 },
          { text: 'dos et fesses\ncontre le mur', at: 'shoulder', dx: 12, dy: 6 },
        ],
        muscles: [{ muscle: 'tibialis' }],
        contacts: [{ ref: 'near.heel', y: 0 }],
        ghostContacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }],
      },
    ],
  },

  'montee-tabouret': {
    panels: [
      {
        label: 'Monte en 1 s, en poussant dans le talon du haut',
        ghostLabel: 'Tout le pied sur le step de 40 cm',
        props: [{ kind: 'floor' }, { kind: 'stool', x: 18, face: 1 }, { kind: 'wall', x: 19, face: -1 }],
        ghost: {
          view: 'side', hip: [-8, 45], lean: 14,
          near: { ankle: [8, FURNITURE.stool.seat + A] }, far: { ankle: [-16, A] },
          free: { hand: [18, 70] },
        },
        pose: {
          view: 'side', hip: [7, 74.2], lean: 3,
          near: { ankle: [8, FURNITURE.stool.seat + A] }, far: { thigh: -6, shank: -40, sole: -30 },
          free: { hand: [18, 88] },
        },
        motions: [{ joint: 'hip', bend: -8, label: '1 s' }],
        notes: [{ text: 'la main au mur,\ntoujours', at: 'free.wrist', dx: -24, dy: 2 }],
        muscles: [{ muscle: 'quads' }, { muscle: 'glutes' }],
        contacts: [{ ref: 'near.heel', y: FURNITURE.stool.seat }, { ref: 'near.ball', y: FURNITURE.stool.seat }],
        ghostContacts: [{ ref: 'near.heel', y: FURNITURE.stool.seat }, { ref: 'far.heel', y: 0 }],
      },
      {
        label: 'Redescends en 4 s : la jambe du haut freine',
        ghostLabel: 'Debout sur le step',
        props: [{ kind: 'floor' }, { kind: 'stool', x: 18, face: 1 }, { kind: 'wall', x: 19, face: -1 }],
        ghost: {
          view: 'side', hip: [7, 74.2], lean: 3,
          near: { ankle: [8, FURNITURE.stool.seat + A] }, far: { thigh: -6, shank: -40, sole: -30 },
          free: { hand: [18, 88] },
        },
        pose: {
          view: 'side', hip: [-3, 56.5], lean: 20,
          near: { ankle: [8, FURNITURE.stool.seat + A] }, far: { ankle: ankleFromToe([-6, 0], -35), sole: -35 },
          free: { hand: [18, 80] },
        },
        motions: [{ joint: 'hip', bend: 8, label: '4 s' }],
        angles: [{ at: 'near.knee', a: 'near.hip', b: 'near.ankle' }],
        notes: [{ text: 'la pointe arrière\nse pose à peine', at: 'far.toe', dx: -4, dy: -6 }],
        muscles: [{ muscle: 'quads' }],
        contacts: [{ ref: 'near.heel', y: FURNITURE.stool.seat }, { ref: 'far.toe', y: 0 }],
      },
    ],
  },

  'mollets-sol': {
    panels: [
      {
        label: 'Genou tendu : en haut 1 s, puis 3 s pour redescendre',
        ghostLabel: 'Talon posé',
        props: [{ kind: 'floor' }, { kind: 'wall', x: 22, face: -1 }],
        ghost: {
          view: 'side', hip: [0.3, 52.5], lean: 0,
          near: { ankle: ankleFromBall([8, 0], 0) }, far: { thigh: 4, shank: -58, sole: -55 },
          free: { hand: [21, 70] },
        },
        pose: {
          view: 'side', hip: [3.3, 56], lean: 0,
          near: { ankle: ankleFromToe([11.4, 0], -28), sole: -28 }, far: { thigh: 4, shank: -58, sole: -55 },
          free: { hand: [21, 72] },
        },
        motions: [{ joint: 'near.heel', bend: -4, label: '1 s' }],
        notes: [{ text: 'tout en haut,\nle poids sous\nle gros orteil', at: 'near.ball', dx: -24, dy: 30 }],
        muscles: [{ muscle: 'calves' }],
        contacts: [{ ref: 'near.toe', y: 0 }],
        ghostContacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }],
      },
      {
        label: 'Genou fléchi : le soléaire, même tempo',
        props: [{ kind: 'floor' }, { kind: 'wall', x: 22, face: -1 }],
        pose: {
          view: 'side', hip: [-3.6, 54.5], lean: 8,
          near: { ankle: ankleFromToe([11.4, 0], -24), sole: -24 }, far: { thigh: 8, shank: -55, sole: -55 },
          free: { hand: [21, 68] },
        },
        notes: [{ text: 'genou fléchi\nde 30°, toute\nla série', at: 'near.knee', dx: 10, dy: 10 }],
        muscles: [{ muscle: 'soleus' }],
        contacts: [{ ref: 'near.toe', y: 0 }],
      },
    ],
  },

  'pas-chasses': {
    panels: [
      {
        label: 'Vu de dos : un pas de côté, la bande toujours tendue',
        ghostLabel: 'Pieds à la largeur des hanches',
        props: [{ kind: 'floor' }, { kind: 'backdrop', from: -42, to: 42, top: 96 }],
        ghost: {
          view: 'front', pelvis: [-1, 49], back: true,
          left: { ankle: [-7, A] }, right: { ankle: [5, A] },
          free: { side: 'right', elbow: [15, 64], hand: [11, 73] },
        },
        pose: {
          view: 'front', pelvis: [-5, 48.6], back: true,
          left: { ankle: [-19, A] }, right: { ankle: [5, A] },
          free: { side: 'right', elbow: [11, 64], hand: [7, 73] },
        },
        bands: [{ from: 'left.ankle', to: 'right.ankle', kind: 'mini' }],
        ghostBands: [{ from: 'left.ankle', to: 'right.ankle', kind: 'mini' }],
        motions: [{ joint: 'left.ankle', bend: 4, label: '30 cm' }],
        notes: [{ text: 'les épaules\nà niveau', at: 'neck', dx: -22, dy: 4 }],
        muscles: [{ muscle: 'gluteMed', side: 'left' }, { muscle: 'gluteMed', side: 'right' }],
        contacts: [{ ref: 'left.ankle', y: A }, { ref: 'right.ankle', y: A }],
      },
    ],
  },

  'montee-genou': {
    panels: [
      {
        label: 'Le genou vers la poitrine en 1 s',
        ghostLabel: 'Jambes tendues, talons à 20 cm',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -50, to: 20 }],
        ghost: {
          view: 'side', ...flat(-28),
          near: { thigh: 98, shank: 98, sole: 80 }, far: { thigh: 97, shank: 97, sole: 80 },
          free: armOnFloor(-28), cast: { elbow: [-15, 10], hand: [-7, 14.5], over: true },
        },
        pose: {
          view: 'side', ...flat(-28),
          near: { thigh: 186, shank: 96, sole: 5 }, far: { thigh: 97, shank: 97, sole: 80 },
          free: armOnFloor(-28), cast: { elbow: [-15, 10], hand: [-7, 14.5], over: true },
        },
        bands: [{ from: 'near.ball', to: 'far.ball', kind: 'mini' }],
        motions: [{ joint: 'near.knee', bend: 8, label: '1 s' }],
        notes: [{ text: 'le bas du dos\ncollé au sol', at: [-10, 2], dx: -14, dy: 20 }],
        muscles: [{ muscle: 'hipFlexors' }, { muscle: 'abs' }],
        contacts: [{ part: 'trunk', y: 0, tol: 1 }],
      },
    ],
  },

  marche: {
    panels: [
      {
        label: 'Des pas souples, le regard devant',
        props: [{ kind: 'floor' }],
        pose: {
          view: 'side', hip: [0, 50.6], lean: 4,
          near: { ankle: ankleFromHeel([14.5, 0], 18), sole: 18 },
          far: { ankle: ankleFromToe([-7.5, 0], -25), sole: -25 },
          free: { upper: -22, fore: -8 },
        },
        notes: [
          { text: 'tu peux parler', at: 'head', dx: 10, dy: 3 },
          { text: 'sol sec', at: 'near.toe', dx: 8, dy: 6 },
        ],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'far.toe', y: 0 }],
      },
    ],
  },

  // ───────────────────────── Le bloc de force, du 09/10 au 01/11 ─────────────

  'tests-maison': {
    panels: [
      {
        label: 'Mollets : tout en haut, une montée toutes les 2 s, les doigts au mur sans tirer, jusqu’à l’échec',
        ghostLabel: 'Talon posé',
        props: [{ kind: 'floor' }, { kind: 'wall', x: 22, face: -1 }],
        ghost: {
          view: 'side', hip: [0.3, 52.5], lean: 0,
          near: { ankle: ankleFromBall([8, 0], 0) }, far: { thigh: 4, shank: -58, sole: -55 },
          free: { hand: [21.5, 76] },
        },
        pose: {
          view: 'side', hip: [3.3, 56], lean: 0,
          near: { ankle: ankleFromToe([11.4, 0], -28), sole: -28 }, far: { thigh: 4, shank: -58, sole: -55 },
          free: { hand: [21.5, 78] },
        },
        motions: [{ joint: 'near.heel', bend: -4, label: '1 s' }],
        muscles: [{ muscle: 'calves' }, { muscle: 'soleus' }],
        contacts: [{ ref: 'near.toe', y: 0 }],
        ghostContacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }],
      },
      {
        label: 'Arrière des cuisses : le bassin monte, jusqu’à l’échec',
        ghostLabel: 'Les fesses effleurent le sol',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -50, to: 10 }, { kind: 'stool', x: 47, face: 1 }],
        ghost: {
          view: 'side', ...supine(-28, 7),
          near: { ankle: ankleFromHeel([40, STEP.high], 80), sole: 80 }, far: { thigh: 180, shank: 180, sole: 160 },
          free: { elbow: [-18, 12], hand: [-25, 13] }, cast: { elbow: [-15, 11], hand: [-22, 13.5], over: true },
        },
        pose: {
          view: 'side', ...supine(-28, 20),
          near: { ankle: ankleFromHeel([40, STEP.high], 80), sole: 80 }, far: { thigh: 180, shank: 180, sole: 160 },
          free: { elbow: [-18, 17.5], hand: [-25, 15.5] }, cast: { elbow: [-15, 17], hand: [-24, 14], over: true },
        },
        motions: [{ joint: 'hip', label: '1 s' }],
        notes: [
          { text: 'le talon sur\nle step de 40 cm', at: 'near.heel', dx: 5, dy: -12 },
          { text: 'l’autre jambe\nà la verticale', at: 'far.knee', dx: 6, dy: 4 },
          { text: 'les bras croisés', at: [-22, 15], dx: -6, dy: 18 },
        ],
        muscles: [{ muscle: 'hamstrings' }, { muscle: 'glutes' }],
        contacts: [{ ref: 'near.heel', y: STEP.high }, { part: 'head', y: 0, tol: 1.5 }],
        ghostContacts: [{ ref: 'near.heel', y: STEP.high }, { part: 'trunk', y: 0, tol: 1 }],
      },
    ],
  },

  'reverse-nordic': {
    panels: [
      {
        label: 'Penché de 30°, le corps droit : 3 s',
        ghostLabel: 'À genoux, droit',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -40, to: 8 }],
        ghost: {
          view: 'side', hip: [0, 28.2], lean: 0,
          near: { thigh: 0, shank: -87.5, sole: 196 }, far: { thigh: -1, shank: -88, sole: 196 },
          free: { elbow: [-3, 42.2], hand: [4, 45.2] },
        },
        pose: {
          view: 'side', hip: [-12.25, 24.92], lean: -30,
          near: { thigh: 30, shank: -87.5, sole: 196 }, far: { thigh: 29, shank: -88, sole: 196 },
          free: { elbow: [-21.85, 35.54], hand: [-16.42, 42.14] },
        },
        motions: [{ joint: 'head', bend: 6, label: '3 s' }],
        angles: [{ at: 'near.knee', a: [0, 60], b: 'head', r: 30, label: '30°' }],
        guides: [{ from: 'near.knee', to: 'head' }],
        notes: [
          { text: 'des genoux à la tête :\nune planche', at: 'shoulder', dx: -14, dy: 14 },
          { text: 'fesses serrées', at: 'hip', dx: -14, dy: -4 },
          { text: 'le tapis plié\nsous les genoux', at: [4, 0.6], dx: 6, dy: 12 },
        ],
        muscles: [{ muscle: 'quads' }],
        contacts: [{ part: 'near.shank', y: FURNITURE.mat }],
        ghostContacts: [{ part: 'near.shank', y: FURNITURE.mat }],
      },
    ],
  },

  'pousse-elastique': {
    panels: [
      {
        label: 'Bras tendu devant, 1 s tenue',
        ghostLabel: 'Dos à la porte, la poignée à côté de la poitrine',
        props: [{ kind: 'floor' }, { kind: 'door', x: -40, anchor: 72, face: 1 }],
        hold: 'handle',
        ghost: {
          view: 'side', hip: [0, 51.5], lean: 6,
          near: { ankle: [10, A] }, far: { ankle: [-12, A] },
          free: { hand: [8, 72] },
        },
        pose: {
          view: 'side', hip: [0, 51.5], lean: 6,
          near: { ankle: [10, A] }, far: { ankle: [-12, A] },
          free: { hand: [33, 76] },
        },
        bands: [{ from: doorHook(-40, 72, 1), to: 'free.wrist', kind: 'long', behind: true }],
        ghostBands: [{ from: doorHook(-40, 72, 1), to: 'free.wrist', kind: 'long' }],
        motions: [{ joint: 'free.wrist', bend: 5, label: '1 s' }],
        notes: [
          { text: 'le buste\nne tourne pas', at: 'shoulder', dx: -12, dy: 14 },
        ],
        muscles: [{ muscle: 'chest' }, { muscle: 'triceps' }, { muscle: 'shoulder' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'far.heel', y: 0 }],
      },
    ],
  },

  'hip-thrust': {
    panels: [
      {
        label: 'En haut : le buste à plat, le genou à angle droit, 2 s',
        ghostLabel: 'Les fesses près du sol',
        props: [{ kind: 'floor' }, { kind: 'sofa', x: -22, face: 1 }],
        ghost: {
          view: 'side', hip: [-3.07, 10], lean: -38.8, nod: 10,
          near: { ankle: [23.34, A] }, far: { thigh: 150, shank: 60, sole: 60 },
          free: { elbow: [-27, 25.5], hand: [-33, 25.2] }, cast: { elbow: [-11.6, 26.9], hand: [-4.3, 22.5], over: true },
        },
        pose: {
          view: 'side', hip: [0, 29.6], lean: -90, nod: 25,
          near: { ankle: [23.34, A] }, far: { thigh: 160, shank: 70, sole: 70 },
          free: { elbow: [-33, 25.5], hand: [-38, 25.2] }, cast: { elbow: [-16, 36.5], hand: [-6, 37.5], over: true },
        },
        motions: [{ joint: 'hip', bend: -6, label: '1 s' }],
        angles: [{ at: 'near.knee', a: 'near.hip', b: 'near.ankle' }],
        guides: [{ from: 'shoulder', to: 'near.knee' }],
        notes: [
          { text: 'les omoplates\nsur le bord', at: [-22, 23], dx: -2, dy: -12 },
          { text: 'menton rentré', at: 'head', dx: -4, dy: 12 },
        ],
        muscles: [{ muscle: 'glutes' }, { muscle: 'hamstrings' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }, { part: 'trunk', y: FURNITURE.sofa.seat, tol: 1.2 }],
        ghostContacts: [{ ref: 'near.heel', y: 0 }],
      },
    ],
  },

  copenhague: {
    panels: [
      {
        label: 'De face : le bassin monte, le genou du dessus sur le step',
        props: [
          { kind: 'floor' },
          { kind: 'mat', from: -40, to: 10 },
          { kind: 'box', x: 29, h: STEP.high, depth: 13, face: 1 },
        ],
        pose: {
          view: 'front', pelvis: [0, 25.5], turn: 78,
          left: { ankle: [40, 7.5] }, right: { ankle: [49.1, 20.2] },
          free: { side: 'left', elbow: [-28.5, 2.8], hand: [-24, 2.2] },
          cast: { elbow: [-7, 37], hand: [5, 33] },
        },
        guides: [{ from: 'head', to: 'right.knee' }],
        motions: [{ from: [2, 12], to: [2, 20.5], label: '1 s' }],
        notes: [
          { text: 'le coude\nsous l’épaule', at: 'free.elbow', dx: -9, dy: 8 },
          { text: 'le genou du dessus\nsur le step', at: 'right.knee', dx: 4, dy: 16 },
          { text: 'la jambe du dessous\ndécolle', at: 'left.ankle', dx: 6, dy: 4 },
        ],
        muscles: [{ muscle: 'adductors', side: 'right' }, { muscle: 'obliques', side: 'left' }],
        contacts: [{ ref: 'free.elbow', y: 2.8, tol: 0.2 }],
      },
    ],
  },

  'adducteurs-coussin': {
    panels: [
      {
        label: 'Serre le coussin 10 s, relâche 10 s',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -50, to: 34 }, { kind: 'circle', c: [12.6, 27.4], r: 6, tone: 'pad' }],
        pose: {
          view: 'side', ...flat(-28),
          near: { ankle: [24, A] }, far: { ankle: [23, A] },
          free: armOnFloor(-28), cast: { elbow: [-15, 10], hand: [-7, 14.5], over: true },
        },
        notes: [
          { text: 'un coussin ferme\nentre les genoux', at: [12.6, 33.4], dx: -4, dy: 8 },
          { text: 'le bas du dos posé', at: [-12, 2], dx: -6, dy: 18 },
        ],
        muscles: [{ muscle: 'adductors' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { part: 'trunk', y: 0, tol: 1 }],
      },
    ],
  },

  'mollets-iso': {
    panels: [
      {
        label: 'À mi-hauteur : pousse le cadre et le sol, rien ne bouge',
        props: [
          { kind: 'floor' },
          { kind: 'backdrop', from: 13, to: 27, top: LINTEL },
          { kind: 'shape', pts: [[13, LINTEL], [27, LINTEL], [27, LINTEL + 4.5], [13, LINTEL + 4.5]], closed: true, tone: 'pad' },
        ],
        pose: {
          view: 'side', hip: [2, 54.8], lean: 2,
          near: { ankle: ankleFromBall([5, 0], -20), sole: -20 }, far: { thigh: -5, shank: -88, sole: -85 },
          free: { hand: [20.2, LINTEL - SEG.hand] },
        },
        motions: [
          { from: [25, LINTEL - 14], to: [25, LINTEL - 4], bend: -0.5, label: '3 s' },
          { from: [13, 9], to: [13, 1.5] },
        ],
        notes: [
          { text: 'la main à plat\nsous le haut du cadre', at: 'free.tip', dx: 8, dy: -19 },
          { text: 'talon à\nmi-hauteur', at: 'near.heel', dx: -4, dy: 4 },
          { text: 'l’avant du pied\npousse le sol', at: [13, 4], dx: 6, dy: 6 },
        ],
        muscles: [{ muscle: 'calves' }, { muscle: 'soleus' }],
        contacts: [{ ref: 'near.ball', y: 0 }, { ref: 'free.tip', y: LINTEL, tol: 0.8 }],
      },
    ],
  },

  'pied-court': {
    panels: [
      {
        label: 'Assis, pieds nus : la voûte se creuse, les orteils restent longs',
        props: [{ kind: 'floor' }, { kind: 'chair', x: -2, face: 1 }],
        pose: {
          view: 'side', hip: [-11, 31.6], lean: 6,
          near: { ankle: [12, A] }, far: { ankle: [10, A] },
          free: { hand: [2, 33] },
        },
        motions: [{ from: [24, 5.2], to: [17, 5.2], bend: -1.5, label: '5 s' }],
        notes: [
          { text: 'l’avant du pied recule\nvers le talon, la voûte monte', at: 'near.ball', dx: 6, dy: 16 },
          { text: 'les orteils à plat', at: 'near.toe', dx: 7, dy: 3 },
        ],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'near.ball', y: 0 }, { part: 'trunk', y: FURNITURE.chair.seat, tol: 1.2 }],
      },
    ],
  },

  equilibre: {
    panels: [
      {
        label: 'Dans un angle de mur, yeux fermés, 30 s',
        props: [{ kind: 'floor' }, { kind: 'backdrop', from: -36, to: 30, top: 100 }, { kind: 'wall', x: -36, face: 1 }],
        pose: {
          view: 'front', pelvis: [0, 52.8],
          left: { ankle: [-5.5, A + 2.8] }, right: { ankle: [5.5, A] },
          free: { side: 'left', elbow: [-17, 61], hand: [-21, 69] },
        },
        notes: [
          { text: 'yeux fermés', at: 'head', dx: 9, dy: 4 },
          { text: 'main à\n20 cm\ndu mur', at: 'free.tip', dx: 0, dy: 18 },
          { text: 'genou souple', at: 'right.knee', dx: 10, dy: 0 },
        ],
        muscles: [{ muscle: 'gluteMed', side: 'right' }],
        contacts: [{ ref: 'right.ankle', y: A }],
      },
    ],
  },

  // ───────────────────────── La salle, et le reste du programme ─────────────

  activation: {
    panels: [
      {
        label: 'Fente arrière, la main libre au mur',
        ghostLabel: 'Debout',
        props: [{ kind: 'floor' }, { kind: 'wall', x: 31, face: -1 }],
        ghost: {
          view: 'side', hip: [2, 52.3], lean: 0,
          near: { ankle: [6, A] }, far: { ankle: [0, A] },
          free: { hand: [30, 70] },
        },
        pose: {
          view: 'side', hip: [-8, 34], lean: 15,
          near: { ankle: [6, A] }, far: { ankle: ankleFromToe([-24, 0], -60), sole: -60 },
          free: { hand: [30, 59] },
        },
        motions: [{ joint: 'hip', bend: 6, label: '2 s' }],
        muscles: [{ muscle: 'glutes' }, { muscle: 'quads' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { ref: 'far.toe', y: 0 }],
      },
    ],
  },

  presse: {
    panels: [
      {
        label: 'En bas : genoux à angle droit, 3 s',
        ghostLabel: 'Jambes presque tendues',
        props: [
          { kind: 'floor' },
          { kind: 'shape', pts: [[-1, 11], [-31, 36.5], [-34, 33], [-4, 7.5]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[-3, 11], [10, 12.5], [10, 9], [-3, 7.5]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[-12, 0], [-8, 8], [6, 9]], tone: 'metal' },
          { kind: 'shape', pts: [[14, 6], [66, 58]], tone: 'metal' },
          { kind: 'shape', pts: [[14, 6], [14, 0]], tone: 'metal' },
          { kind: 'shape', pts: [[24.8, 51.6], [38.2, 38.2]], tone: 'pad' },
        ],
        ghost: {
          view: 'side', hip: [0, 20], lean: -52,
          near: { ankle: [31.5, 52.5], sole: 135 }, far: { ankle: [30.5, 51.5], sole: 135 },
          free: { hand: [-1, 19] },
        },
        pose: {
          view: 'side', hip: [0, 20], lean: -52,
          near: { ankle: [24.5, 44.5], sole: 135 }, far: { ankle: [23.5, 43.5], sole: 135 },
          free: { hand: [-1, 19] },
        },
        motions: [{ joint: 'near.ankle', bend: -6, label: '3 s' }],
        angles: [{ at: 'near.knee', a: 'near.hip', b: 'near.ankle' }],
        muscles: [{ muscle: 'quads' }, { muscle: 'glutes' }],
      },
    ],
  },

  'split-squat-bulgare': {
    panels: [
      {
        label: 'En bas : 3 s pour y descendre',
        ghostLabel: 'En haut',
        props: [{ kind: 'floor' }, { kind: 'bench', from: -66, to: -40, h: 25 }],
        hold: 'dumbbell',
        ghost: {
          view: 'side', hip: [-8, 48.5], lean: 8,
          near: { ankle: [9.7, A] }, far: { ankle: [-44, 27.6], sole: 200 },
          free: { upper: 3, fore: 3 },
        },
        pose: {
          view: 'side', hip: [-12, 31], lean: 16,
          near: { ankle: [9.7, A] }, far: { ankle: [-44, 27.6], sole: 200 },
          free: { upper: 2, fore: 2 },
        },
        motions: [{ joint: 'hip', bend: 7, label: '3 s' }],
        angles: [{ at: 'near.knee', a: 'near.hip', b: 'near.ankle' }],
        muscles: [{ muscle: 'quads' }, { muscle: 'glutes' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { part: 'far.foot', y: 25 }],
      },
    ],
  },

  'extension-hanche': {
    panels: [
      {
        label: 'En haut : le corps aligné, pas au-delà',
        ghostLabel: 'En bas, le dos droit',
        props: [
          { kind: 'floor' },
          { kind: 'shape', pts: [[1.5, 41.5], [9, 49], [12.2, 45.8], [4.7, 38.3]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[7, 42], [7, 0]], tone: 'metal' },
          { kind: 'shape', pts: [[-44, 0], [-42, 6], [-36, 6]], tone: 'metal' },
          { kind: 'shape', pts: [[-42, 6], [7, 6]], tone: 'metal' },
          { kind: 'shape', pts: [[-41, 7.5], [-37.5, 4]], tone: 'pad' },
        ],
        ghost: {
          view: 'side', hip: [0, 45], lean: 140, nod: 5,
          near: { thigh: -45, shank: -45, sole: -45 }, far: { thigh: -45, shank: -45, sole: -45 },
          free: { elbow: [6, 52], hand: [12, 49] }, cast: { elbow: [8, 53], hand: [14, 51] },
        },
        pose: {
          view: 'side', hip: [0, 45], lean: 45,
          near: { thigh: -45, shank: -45, sole: -45 }, far: { thigh: -45, shank: -45, sole: -45 },
          free: { elbow: [14, 52], hand: [19, 57] }, cast: { elbow: [12, 54], hand: [18, 59] },
        },
        motions: [{ joint: 'head', bend: -12, label: '2 s' }],
        guides: [{ from: 'head', to: 'near.heel' }],
        muscles: [{ muscle: 'glutes' }, { muscle: 'hamstrings' }],
      },
    ],
  },

  'leg-curl': {
    panels: [
      {
        label: 'Talons ramenés sous le siège, 1 s',
        ghostLabel: 'Jambes tendues : 3 s pour y revenir',
        props: [
          { kind: 'floor' },
          { kind: 'shape', pts: [[-10, 33], [20, 33], [20, 30], [-10, 30]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[-14, 31], [-20, 66], [-16.5, 66.5], [-10.5, 31]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[16, 46.5], [30, 46.5], [30, 43.5], [16, 43.5]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[2, 30], [2, 0]], tone: 'metal' },
          { kind: 'circle', c: [24.5, 38], r: 1.6, tone: 'metal' },
          { kind: 'shape', pts: [[24.5, 38], [13.5, 15.5]], tone: 'metal' },
          { kind: 'circle', c: [13.2, 15.2], r: 2.6, tone: 'pad' },
        ],
        ghost: {
          view: 'side', hip: [0, 38], lean: -8,
          near: { thigh: 90, shank: 80, sole: 60 }, far: { thigh: 90, shank: 80, sole: 60 },
          free: { hand: [4, 38] },
        },
        pose: {
          view: 'side', hip: [0, 38], lean: -8,
          near: { thigh: 90, shank: -14, sole: -20 }, far: { thigh: 90, shank: -12, sole: -20 },
          free: { hand: [4, 38] },
        },
        motions: [{ joint: 'near.ankle', bend: -12, label: '1 s' }],
        muscles: [{ muscle: 'hamstrings' }],
      },
    ],
  },

  'mollets-machine': {
    panels: [
      {
        label: 'Talons hauts, 1 s ; 3 s pour redescendre',
        ghostLabel: 'Talons bas',
        props: [
          { kind: 'floor' },
          { kind: 'box', x: 40, h: 8.5, depth: 12, face: 1 },
          { kind: 'shape', pts: [[-10, 34.5], [16, 34.5], [16, 31.5], [-10, 31.5]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[2, 31.5], [2, 0]], tone: 'metal' },
          { kind: 'shape', pts: [[13, 48.5], [29, 48.5], [29, 45.5], [13, 45.5]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[29, 47], [36, 47], [36, 8.5]], tone: 'metal' },
        ],
        ghost: {
          view: 'side', hip: [0, 39.5], lean: -4,
          near: { ankle: ankleFromBall([30.1, 8.5], 15), sole: 15 }, far: { ankle: ankleFromBall([29.1, 8.5], 15), sole: 15 },
          free: { hand: [14, 46] },
        },
        pose: {
          view: 'side', hip: [0, 39.5], lean: -4,
          near: { ankle: ankleFromBall([30.1, 8.5], -25), sole: -25 }, far: { ankle: ankleFromBall([29.1, 8.5], -25), sole: -25 },
          free: { hand: [14, 48] },
        },
        motions: [{ joint: 'near.heel', bend: 4, label: '1 s' }],
        muscles: [{ muscle: 'soleus' }, { muscle: 'calves' }],
        contacts: [{ ref: 'near.ball', y: 8.5 }],
        ghostContacts: [{ ref: 'near.ball', y: 8.5 }],
      },
    ],
  },

  'bras-libre': {
    panels: [
      {
        label: 'Développé : l’haltère au-dessus de l’épaule',
        ghostLabel: 'L’haltère à l’épaule',
        props: [{ kind: 'floor' }, { kind: 'bench', from: -16, to: 10, h: 25.5 }],
        hold: 'dumbbell',
        ghost: {
          view: 'side', hip: [-2, 31.8], lean: 0,
          near: { ankle: [18, A] }, far: { ankle: [16, A] },
          free: { upper: 25, fore: 175 },
        },
        pose: {
          view: 'side', hip: [-2, 31.8], lean: 0,
          near: { ankle: [18, A] }, far: { ankle: [16, A] },
          free: { upper: 172, fore: 178 },
        },
        motions: [{ joint: 'free.wrist', bend: -6, label: '1 s' }],
        muscles: [{ muscle: 'shoulder' }, { muscle: 'triceps' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { part: 'trunk', y: 25.5, tol: 1.2 }],
      },
    ],
  },

  'step-up': {
    panels: [
      {
        label: 'Debout sur le banc ; 3 s pour redescendre',
        ghostLabel: 'Le pied entier posé',
        props: [{ kind: 'floor' }, { kind: 'box', x: 20, h: 25, depth: 26, face: 1 }],
        hold: 'dumbbell',
        ghost: {
          view: 'side', hip: [-12, 45], lean: 14,
          near: { ankle: [4, 25 + A] }, far: { ankle: [-20, A] },
          free: { upper: 2, fore: 2 },
        },
        pose: {
          view: 'side', hip: [3, 77.2], lean: 3,
          near: { ankle: [4, 25 + A] }, far: { ankle: [-6, 33], sole: -30 },
          free: { upper: 2, fore: 2 },
        },
        motions: [{ joint: 'hip', bend: -8, label: '1 s' }],
        muscles: [{ muscle: 'quads' }, { muscle: 'glutes' }],
        contacts: [{ ref: 'near.heel', y: 25 }, { ref: 'near.ball', y: 25 }],
        ghostContacts: [{ ref: 'near.heel', y: 25 }, { ref: 'far.ball', y: 0 }],
      },
    ],
  },

  abduction: {
    panels: [
      {
        label: 'Vu de dos : la jambe s’écarte de 30 cm, le buste reste droit',
        ghostLabel: 'Pieds joints',
        props: [{ kind: 'floor' }, { kind: 'backdrop', from: -40, to: 40, top: 96 }],
        ghost: {
          view: 'front', pelvis: [0, 52], back: true,
          left: { ankle: [-5, A] }, right: { ankle: [5, A] },
          free: { side: 'left', elbow: [-15, 66], hand: [-11, 75] },
        },
        pose: {
          view: 'front', pelvis: [0, 52], back: true,
          left: { ankle: [-5, A] }, right: { ankle: [19, 8] },
          free: { side: 'left', elbow: [-15, 66], hand: [-11, 75] },
        },
        bands: [{ from: 'left.ankle', to: 'right.ankle', kind: 'mini' }],
        ghostBands: [{ from: 'left.ankle', to: 'right.ankle', kind: 'mini' }],
        motions: [{ joint: 'right.ankle', bend: -3, label: '2 s' }],
        muscles: [{ muscle: 'gluteMed', side: 'right' }, { muscle: 'gluteMed', side: 'left' }],
        contacts: [{ ref: 'left.ankle', y: A }],
      },
    ],
  },

  'dead-bug': {
    panels: [
      {
        label: 'Un talon descend en 3 s, le dos reste collé',
        ghostLabel: 'Hanches et genoux à angle droit',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -50, to: 20 }],
        ghost: {
          view: 'side', ...flat(-28),
          near: { thigh: 180, shank: 90, sole: 0 }, far: { thigh: 178, shank: 88, sole: 0 },
          free: armOnFloor(-28), cast: { elbow: [-15, 10], hand: [-7, 14.5], over: true },
        },
        pose: {
          view: 'side', ...flat(-28),
          near: { thigh: 96, shank: 96, sole: 80 }, far: { thigh: 178, shank: 88, sole: 0 },
          free: armOnFloor(-28), cast: { elbow: [-15, 10], hand: [-7, 14.5], over: true },
        },
        motions: [{ joint: 'near.heel', bend: -10, label: '3 s' }],
        muscles: [{ muscle: 'abs' }],
        contacts: [{ part: 'trunk', y: 0, tol: 1 }],
      },
    ],
  },

  'gainage-lateral': {
    panels: [
      {
        label: 'De face : la tête, le bassin et les pieds alignés',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -40, to: 52 }],
        pose: {
          view: 'front', pelvis: [0, 22.8], turn: 70,
          left: { ankle: [42.7, 4.1] }, right: { ankle: [44.7, 9.7] },
          free: { side: 'left', elbow: [-28.8, 4], hand: [-24.5, 3.4] },
          cast: { elbow: [-5.4, 34.3], hand: [3.5, 29.5] },
        },
        guides: [{ from: 'head', to: 'left.ankle' }],
        motions: [{ from: [-6, 5.6], to: [-6, 14.6] }],
        notes: [
          { text: 'le coude\nsous l’épaule', at: 'free.elbow', dx: -9, dy: 6 },
          { text: 'bassin\nhaut', at: [-5, 10.6], dx: 3, dy: -0.5 },
        ],
        muscles: [{ muscle: 'obliques', side: 'left' }],
      },
    ],
  },

  'marche-tapis': {
    panels: [
      {
        label: 'En côte, sans te tenir aux barres',
        props: [
          { kind: 'shape', pts: [[-40, 3], [40, 14.3]], tone: 'metal' },
          { kind: 'shape', pts: [[-40, 0], [-40, 3], [40, 14.3], [42, 0], [-40, 0]], tone: 'pad', closed: true },
          { kind: 'shape', pts: [[38, 14], [44, 72]], tone: 'metal' },
          { kind: 'shape', pts: [[24, 58], [44, 62]], tone: 'metal' },
          { kind: 'floor' },
        ],
        pose: {
          view: 'side', hip: [0, 57.6], lean: 6,
          near: { ankle: ankleFromHeel([14, 3 + (54 / 80) * 11.3], 20), sole: 20 },
          far: { ankle: ankleFromBall([-14, 3 + (26 / 80) * 11.3], -25), sole: -25 },
          free: { upper: -18, fore: -4 },
        },
        notes: [
          { text: 'pente\n10 à 15 %', at: [-30, 4.2], dx: -3, dy: 14 },
          { text: 'tu peux parler', at: 'head', dx: 10, dy: 3 },
        ],
        muscles: [{ muscle: 'glutes' }, { muscle: 'calves' }],
      },
    ],
  },

  intervalles: {
    panels: [
      {
        label: 'Vélo couché, sans les mains',
        props: [
          { kind: 'floor' },
          { kind: 'shape', pts: [[-12, 24], [8, 24], [8, 20.5], [-12, 20.5]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[-12, 24], [-27, 50], [-23.5, 51.5], [-8.5, 24]], closed: true, tone: 'pad' },
          { kind: 'shape', pts: [[-4, 20.5], [-4, 0]], tone: 'metal' },
          { kind: 'shape', pts: [[-12, 0], [44, 0]], tone: 'metal' },
          { kind: 'shape', pts: [[-2, 14], [40, 20], [40, 0]], tone: 'metal' },
          { kind: 'circle', c: [40, 20], r: 8.5, tone: 'line' },
          { kind: 'shape', pts: [[31.5, 20], [48.5, 20]], tone: 'metal' },
        ],
        pose: {
          view: 'side', hip: [0, 30], lean: -25,
          near: { ankle: ankleFromBall([48.5, 20], 90), sole: 90 },
          far: { ankle: ankleFromBall([31.5, 20], 90), sole: 90 },
          free: { hand: [3, 30] },
        },
        motions: [{ from: [52, 27], to: [44, 9], bend: 7 }],
        notes: [{ text: 'des tours souples', at: [53, 15], dx: 4, dy: -10 }],
        muscles: [{ muscle: 'quads' }, { muscle: 'glutes' }],
      },
    ],
  },

  'marche-cote': {
    panels: [
      {
        label: 'Monter en marche active, la main sur la rampe',
        props: [{ kind: 'floor' }, { kind: 'stairs', x: -20, n: 6, rail: true }],
        pose: {
          view: 'side', hip: [24, 77], lean: 12,
          near: { ankle: [33, 4 * STAIR.rise + A] },
          far: { ankle: ankleFromBall([20, 3 * STAIR.rise], -20), sole: -20 },
          free: { hand: [37, railY(-20, 37) + 0.8] },
        },
        motions: [{ from: [48, 66], to: [66, 77], label: 'monte' }],
        notes: [{ text: 'sol sec,\nla rampe', at: 'free.wrist', dx: 9, dy: 8 }],
        muscles: [{ muscle: 'quads' }, { muscle: 'glutes' }, { muscle: 'calves', side: 'far' }],
        contacts: [{ ref: 'near.heel', y: 4 * STAIR.rise }, { ref: 'far.ball', y: 3 * STAIR.rise }],
      },
    ],
  },

  'soins-bras': {
    panels: [
      {
        label: 'Le bras plâtré monte devant toi, sans douleur',
        ghostLabel: 'Au repos, en écharpe',
        props: [{ kind: 'floor' }],
        ghost: {
          view: 'side', hip: [0, 52.3], lean: 0, freeSide: 'far',
          near: { ankle: [1.5, A] }, far: { ankle: [-1.5, A] },
          free: { upper: 2, fore: 4 },
        },
        pose: {
          view: 'side', hip: [0, 52.3], lean: 0, freeSide: 'far',
          near: { ankle: [1.5, A] }, far: { ankle: [-1.5, A] },
          free: { upper: 2, fore: 4 }, cast: { upper: 120, fore: 210 },
        },
        motions: [{ joint: 'cast.wrist', bend: -12, label: '10 fois' }],
        notes: [{ text: 'les doigts : poing,\npuis main grande ouverte', at: 'cast.tip', dx: 8, dy: 5 }],
        contacts: [{ ref: 'near.heel', y: 0 }],
      },
    ],
  },

  respiration: {
    panels: [
      {
        label: 'Allongé, une main sur le ventre',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -50, to: 34 }],
        pose: {
          view: 'side', ...flat(-28),
          near: { ankle: [27, A] }, far: { ankle: [25, A] },
          free: { elbow: [-17, 3.6], hand: [-7, 13.5] }, cast: { elbow: [-20, 9], hand: [-13, 15.5], over: true },
        },
        motions: [{ from: [-3, 16], to: [-3, 25], label: '4 s' }],
        notes: [{ text: 'le ventre monte\nà l’inspiration', at: [-3, 25], dx: 6, dy: 8 }],
        muscles: [{ muscle: 'diaphragm' }],
        contacts: [{ ref: 'near.heel', y: 0 }, { part: 'trunk', y: 0, tol: 1 }],
      },
    ],
  },

  souplesse: {
    panels: [
      {
        label: 'Ischio-jambiers : 45 s, sans à-coups',
        props: [{ kind: 'floor' }, { kind: 'mat', from: -50, to: 34 }],
        pose: {
          view: 'side', ...flat(-28),
          near: { thigh: 174, shank: 174, sole: 84 }, far: { ankle: ankleFromHeel([52.4, 1.4], 75), sole: 75 },
          free: { hand: [-4, 27] }, cast: { elbow: [-15, 10], hand: [-7, 14.5], over: true },
        },
        bands: [{ from: 'free.wrist', to: 'near.ball', kind: 'strap' }],
        notes: [{ text: 'genou tendu', at: 'near.knee', dx: 9, dy: 2 }],
        muscles: [{ muscle: 'hamstrings' }],
        contacts: [{ part: 'far.foot', y: 0 }, { part: 'trunk', y: 0, tol: 1 }],
      },
    ],
  },
};
