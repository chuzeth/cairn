/**
 * Les muscles qui travaillent, peints sur la peau du mannequin.
 *
 * Chaque muscle est une région du corps au repos, décrite comme un anatomiste
 * la décrirait, dans le repère de l'os qui le porte : la hauteur le long de
 * l'os (`t`, 0 à l'articulation du haut, 1 à celle du bas), et l'angle autour
 * de lui (`phi`, 0 devant, positif vers le dehors, ±180 derrière). Le
 * quadriceps couvre l'avant et le dehors de la cuisse, du pli de l'aine
 * au-dessus de la rotule ; les ischio-jambiers, son arrière ; le mollet, le
 * haut de l'arrière de la jambe, le soléaire plus bas et plus large ; le grand
 * fessier, l'arrière du bassin entre le pli fessier et la crête iliaque ; le
 * grand droit, l'avant du ventre du pubis au sternum. Les bords sont fondus sur
 * 1 à 2 cm. Le résultat est un attribut par sommet, de 0 à 1, que le matériau
 * mélange vers la terracotta.
 *
 * `side` suit le dessin : `near` (par défaut) est le côté droit, celui qu'on
 * voit ; les muscles du bras sont ceux du bras libre.
 */
import type { Muscle, SidePose } from '../figure';
import type { RestData, Side } from './rig';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** 1 dans [lo, hi], fondu sur `soft` de chaque côté. */
const band = (x: number, lo: number, hi: number, soft: number) => smooth(lo - soft, lo, x) * (1 - smooth(hi, hi + soft, x));
/** Un angle ramené dans [−180, 180]. */
const wrap = (a: number) => ((((a + 180) % 360) + 360) % 360) - 180;

type Region = (v: number) => number;

/**
 * Le repère d'un segment au repos : `t` le long de l'os de `a` à `b`, `phi`
 * autour de lui, 0 du côté `front`, positif vers `out`.
 */
function segment(d: RestData, a: string, b: string, front: [number, number, number], out: [number, number, number]) {
  const A = d.head(a);
  const B = d.head(b);
  const ax = [B[0] - A[0], B[1] - A[1], B[2] - A[2]] as const;
  const len2 = ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2;
  const proj = (u: readonly number[]) => {
    const k = (u[0]! * ax[0] + u[1]! * ax[1] + u[2]! * ax[2]) / len2;
    const r = [u[0]! - ax[0] * k, u[1]! - ax[1] * k, u[2]! - ax[2] * k];
    const l = Math.hypot(r[0]!, r[1]!, r[2]!) || 1;
    return r.map((x) => x / l) as [number, number, number];
  };
  const f = proj(front);
  const o = proj(out);
  return (v: number) => {
    const p = [d.pos[v * 3]! - A[0], d.pos[v * 3 + 1]! - A[1], d.pos[v * 3 + 2]! - A[2]];
    const t = (p[0]! * ax[0] + p[1]! * ax[1] + p[2]! * ax[2]) / len2;
    const r = [p[0]! - ax[0] * t, p[1]! - ax[1] * t, p[2]! - ax[2] * t];
    const phi = (Math.atan2(r[0]! * o[0] + r[1]! * o[1] + r[2]! * o[2], r[0]! * f[0] + r[1]! * f[1] + r[2]! * f[2]) * 180) / Math.PI;
    return { t, phi };
  };
}

function region(m: Muscle['muscle'], side: Side, d: RestData): Region | null {
  const sz = side === 'R' ? 1 : -1;
  const hipY = d.head(`upperleg01.${side}`)[1];
  const on = (re: RegExp) => (b: string) => re.test(b);
  const FRONT: [number, number, number] = [1, 0, 0];
  const OUT: [number, number, number] = [0, 0, sz];
  const thigh = () => segment(d, `upperleg01.${side}`, `lowerleg01.${side}`, FRONT, OUT);
  const shank = () => segment(d, `lowerleg01.${side}`, `foot.${side}`, FRONT, OUT);
  const onThigh = on(new RegExp(`^(upperleg0[12]|lowerleg01)\\.${side}$`));
  const onShank = on(new RegExp(`^(lowerleg0[12]|foot)\\.${side}$`));
  const onArm = on(new RegExp(`^(upperarm0[12]|shoulder01|lowerarm01)\\.${side}$`));
  const onForearm = on(new RegExp(`^(lowerarm0[12]|wrist)\\.${side}$`));
  const onTrunk = on(/^(root|spine0[1-5]|pelvis|clavicle|neck01)/);
  const x = (v: number) => d.pos[v * 3]!;
  const y = (v: number) => d.pos[v * 3 + 1]!;
  const z = (v: number) => d.pos[v * 3 + 2]!;
  const nx = (v: number) => d.normal[v * 3]!;
  switch (m) {
    case 'quads': {
      const seg = thigh();
      return (v) => {
        const w = d.weightOf(v, onThigh);
        if (w < 0.05) return 0;
        const { t, phi } = seg(v);
        // Le droit fémoral seul en haut, étroit ; le vaste externe sur la moitié avant du dehors ; le vaste interne en goutte au-dessus du genou.
        const medial = t < 0.3 ? -22 - (t - 0.1) * 165 : t > 0.62 ? -55 - Math.min(1, (t - 0.62) / 0.2) * 40 : -55;
        const lateral = t < 0.3 ? 28 + (t - 0.1) * 210 : 70;
        // La rotule et son tendon ne sont pas du muscle.
        const patella = smooth(0.84, 0.92, t) * band(phi, -30, 30, 12);
        return smooth(0.3, 0.7, w) * band(t, 0.1, 0.97, 0.06) * band(phi, medial, lateral, 14) * (1 - patella);
      };
    }
    case 'hamstrings': {
      const seg = thigh();
      return (v) => {
        const w = d.weightOf(v, onThigh);
        if (w < 0.05) return 0;
        const { t, phi } = seg(v);
        // Derrière la cuisse, du pli fessier au creux du genou : le biceps fémoral dehors, les semi-tendineux dedans.
        return smooth(0.3, 0.7, w) * band(t, 0.16, 0.9, 0.07) * band(wrap(phi - 180), -62, 72, 15);
      };
    }
    case 'hipFlexors': {
      const seg = thigh();
      return (v) => {
        const { t, phi } = seg(v);
        // Le pli de l'aine : le haut du droit fémoral et le psoas qui plonge sous lui.
        return band(t, -0.06, 0.26, 0.06) * band(phi, -45, 35, 14) * smooth(0.1, 0.4, d.weightOf(v, onThigh) + d.weightOf(v, on(/^pelvis/)));
      };
    }
    case 'adductors': {
      const seg = thigh();
      return (v) => {
        const { t, phi } = seg(v);
        return smooth(0.3, 0.7, d.weightOf(v, onThigh)) * band(t, 0.05, 0.62, 0.07) * band(phi, -150, -62, 15);
      };
    }
    case 'calves': {
      const seg = shank();
      return (v) => {
        const w = d.weightOf(v, onShank);
        if (w < 0.05) return 0;
        const { t, phi } = seg(v);
        // Les jumeaux : le haut de l'arrière de la jambe, le chef interne descend un peu plus bas.
        const low = 0.5 + (wrap(phi - 180) < 0 ? 0.06 : 0);
        return smooth(0.3, 0.7, w) * band(t, 0.04, low, 0.07) * band(wrap(phi - 180), -70, 70, 15);
      };
    }
    case 'soleus': {
      const seg = shank();
      return (v) => {
        const w = d.weightOf(v, onShank);
        if (w < 0.05) return 0;
        const { t, phi } = seg(v);
        // Sous les jumeaux, plus large : il déborde des deux côtés du bas du mollet.
        return smooth(0.3, 0.7, w) * band(t, 0.4, 0.84, 0.07) * band(wrap(phi - 180), -100, 100, 15);
      };
    }
    case 'tibialis': {
      const seg = shank();
      return (v) => {
        const { t, phi } = seg(v);
        // Le jambier antérieur : en dehors de la crête du tibia, des deux tiers du haut.
        return smooth(0.3, 0.7, d.weightOf(v, onShank)) * band(t, 0.08, 0.74, 0.07) * band(phi, 12, 78, 12);
      };
    }
    case 'glutes': {
      const hipJ = d.head(`upperleg01.${side}`);
      const onPelvis = on(new RegExp(`^(root|spine05|pelvis\\.${side}|upperleg01\\.${side})$`));
      return (v) => {
        const zz = z(v) * sz;
        const w = d.weightOf(v, onPelvis);
        if (w < 0.2 || zz < 0) return 0;
        // Le pli fessier remonte vers le dehors ; la crête iliaque borne le haut.
        const fold = hipY - 9.2 + zz * 0.22;
        return smooth(-0.05, -0.35, nx(v)) * smooth(hipJ[0] - 1, hipJ[0] - 4, x(v)) * band(y(v), fold, hipY + 8.2, 1.4) * band(zz, 0.9, 12.5, 1.6) * smooth(0.2, 0.5, w);
      };
    }
    case 'abs':
      return (v) => {
        const w = d.weightOf(v, onTrunk);
        if (w < 0.3) return 0;
        // Le grand droit : plus large en haut qu'en bas.
        const half = 4.2 + smooth(hipY + 4, hipY + 18, y(v)) * 1.6;
        return smooth(0.1, 0.4, nx(v)) * band(y(v), hipY + 1.5, hipY + 20.5, 1.6) * band(Math.abs(z(v)), -1, half, 1.4);
      };
    case 'obliques':
      return (v) => {
        const w = d.weightOf(v, onTrunk);
        if (w < 0.3) return 0;
        // Les flancs, de la crête iliaque aux côtes basses, du côté dit.
        return band(y(v), hipY + 3, hipY + 18, 1.6) * band(z(v) * sz, 5.4, 13, 1.6) * smooth(-0.5, -0.1, nx(v));
      };
    case 'back':
      return (v) => {
        const w = d.weightOf(v, onTrunk);
        if (w < 0.3) return 0;
        // Ce que tire un rameur : le grand dorsal et les rhomboïdes, entre les omoplates et sous elles.
        return smooth(-0.15, -0.45, nx(v)) * band(y(v), hipY + 11, hipY + 26.5, 1.8) * band(Math.abs(z(v)), -1, 10.5, 1.6);
      };
    case 'chest':
      return (v) => {
        const w = d.weightOf(v, onTrunk);
        if (w < 0.3) return 0;
        // Le grand pectoral, des deux côtés du sternum, sous la clavicule.
        return smooth(0.1, 0.4, nx(v)) * band(y(v), hipY + 18.5, hipY + 27, 1.4) * band(Math.abs(z(v)), 0.8, 10, 1.4);
      };
    case 'diaphragm':
      return (v) => {
        const w = d.weightOf(v, onTrunk);
        if (w < 0.3) return 0;
        // Il ne se voit pas : on montre où il pousse, le bas des côtes et le haut du ventre.
        return smooth(0.0, 0.35, nx(v)) * band(y(v), hipY + 12.5, hipY + 18.5, 1.6) * band(Math.abs(z(v)), -1, 8.5, 1.6);
      };
    case 'biceps':
    case 'triceps': {
      const seg = segment(d, `upperarm01.${side}`, `lowerarm01.${side}`, FRONT, OUT);
      const back = m === 'triceps';
      return (v) => {
        const w = d.weightOf(v, onArm);
        if (w < 0.05) return 0;
        const { t, phi } = seg(v);
        return smooth(0.3, 0.7, w) * band(t, back ? 0.1 : 0.16, back ? 0.88 : 0.84, 0.07) * band(back ? wrap(phi - 180) : phi, -58, 58, 15);
      };
    }
    case 'forearm': {
      const seg = segment(d, `lowerarm01.${side}`, `wrist.${side}`, FRONT, OUT);
      return (v) => smooth(0.3, 0.7, d.weightOf(v, onForearm)) * band(seg(v).t, 0.04, 0.62, 0.07);
    }
    case 'shoulder': {
      const S = d.head(`upperarm01.${side}`);
      return (v) => {
        const r = Math.hypot(x(v) - S[0], y(v) - S[1], z(v) - S[2]);
        // Le deltoïde : la coiffe de l'épaule, devant, dehors et derrière, jusqu'au tiers du bras.
        return (1 - smooth(5.2, 7, r)) * smooth(S[2] * sz - 2, S[2] * sz + 0.5, z(v) * sz) * smooth(S[1] - 8, S[1] - 5, y(v));
      };
    }
    default:
      return null;
  }
}

const ARM: ReadonlySet<Muscle['muscle']> = new Set(['biceps', 'triceps', 'forearm', 'shoulder']);

/** Le masque des muscles d'un exercice, de 0 à 1 par sommet. */
export function muscleMask(d: RestData, muscles: readonly Muscle[], pose: SidePose): Float32Array {
  const n = d.pos.length / 3;
  const out = new Float32Array(n);
  const freeSide: Side = pose.freeSide === 'far' ? 'L' : 'R';
  const fns = muscles
    .map((m) => region(m.muscle, ARM.has(m.muscle) ? freeSide : m.side === 'far' || m.side === 'left' ? 'L' : 'R', d))
    .filter((f): f is Region => f !== null);
  for (let v = 0; v < n; v++) {
    let k = 0;
    for (const f of fns) k = Math.max(k, f(v));
    out[v] = k;
  }
  return out;
}

/** Le côté opposé, pour le teinter comme le dessin le grise : les membres gauches. */
export function farMask(d: RestData): Float32Array {
  const n = d.pos.length / 3;
  const out = new Float32Array(n);
  const limbL = (b: string) => /^(upperleg|lowerleg|foot|upperarm|lowerarm|wrist|metacarpal|finger).*\.L$/.test(b);
  for (let v = 0; v < n; v++) out[v] = smooth(0.15, 0.85, d.weightOf(v, limbL));
  return out;
}
