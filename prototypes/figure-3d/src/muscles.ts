/**
 * Les muscles qui travaillent, peints sur la peau du mannequin.
 *
 * Chaque muscle est une région du corps au repos, décrite comme un anatomiste
 * la décrirait : le quadriceps couvre l'avant et le dehors de la cuisse, du
 * pli de l'aine au-dessus de la rotule, le vaste interne descend plus bas en
 * dedans ; le grand fessier, l'arrière du bassin entre le pli fessier et la
 * crête iliaque ; le grand droit, l'avant du ventre du pubis au sternum, sur
 * une main de large. Les bords sont fondus sur 1 à 2 cm. Le résultat est un
 * attribut par sommet, de 0 à 1, que le matériau mélange vers la terracotta.
 */
import type { Muscle } from '../../../apps/web/lib/figure';
import type { Rig } from './rig';

const smooth = (a: number, b: number, x: number) => {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};
/** 1 dans [lo, hi], fondu sur `soft` de chaque côté. */
const band = (x: number, lo: number, hi: number, soft: number) => smooth(lo - soft, lo, x) * (1 - smooth(hi, hi + soft, x));

interface RestData {
  pos: Float32Array;
  normal: Float32Array;
  weightOf: (v: number, test: (bone: string) => boolean) => number;
  head: (bone: string) => [number, number, number];
}

/** Une région par muscle et par côté ; `R` est le côté de notre côté. */
function region(m: Muscle['muscle'], side: 'R' | 'L', d: RestData): ((v: number) => number) | null {
  const sz = side === 'R' ? 1 : -1;
  const hipJ = d.head(`upperleg01.${side}`);
  const knee = d.head(`lowerleg01.${side}`);
  const hipY = hipJ[1];
  switch (m) {
    case 'quads': {
      const ax: [number, number, number] = [knee[0] - hipJ[0], knee[1] - hipJ[1], knee[2] - hipJ[2]];
      const len2 = ax[0] ** 2 + ax[1] ** 2 + ax[2] ** 2;
      const thigh = new RegExp(`^(upperleg0[12]|lowerleg01)\\.${side}$`);
      const onThigh = (b: string) => thigh.test(b);
      return (v) => {
        const w = d.weightOf(v, onThigh);
        if (w < 0.05) return 0;
        const p = [d.pos[v * 3]! - hipJ[0], d.pos[v * 3 + 1]! - hipJ[1], d.pos[v * 3 + 2]! - hipJ[2]];
        const t = (p[0]! * ax[0] + p[1]! * ax[1] + p[2]! * ax[2]) / len2;
        const r = [p[0]! - ax[0] * t, p[1]! - ax[1] * t, p[2]! - ax[2] * t];
        // 0 devant, positif vers le dehors de la cuisse.
        const phi = Math.atan2(r[2]! * sz, r[0]!) * 180 / Math.PI;
        // Le droit fémoral seul en haut, étroit ; tout le quadriceps plus bas ; le vaste interne en goutte au-dessus du genou.
        const top = band(t, 0.1, 0.97, 0.06);
        // De profil, le vaste externe occupe la moitié avant du dehors de la cuisse ; derrière, la bandelette et les ischios restent nus.
        const medial = t < 0.3 ? -22 - (t - 0.1) * 165 : t > 0.62 ? -55 - Math.min(1, (t - 0.62) / 0.2) * 40 : -55;
        const lateral = t < 0.3 ? 28 + (t - 0.1) * 210 : 70;
        const ang = band(phi, medial, lateral, 14);
        // La rotule et son tendon ne sont pas du muscle.
        const patella = smooth(0.84, 0.92, t) * band(phi, -30, 30, 12);
        return smooth(0.3, 0.7, w) * top * ang * (1 - patella);
      };
    }
    case 'glutes': {
      const onPelvis = (b: string) => b === 'root' || b === `pelvis.${side}` || b === `upperleg01.${side}` || b === 'spine05';
      return (v) => {
        const x = d.pos[v * 3]!, y = d.pos[v * 3 + 1]!, z = d.pos[v * 3 + 2]! * sz;
        const nx = d.normal[v * 3]!;
        const w = d.weightOf(v, onPelvis);
        if (w < 0.2 || z < 0) return 0;
        // Le pli fessier remonte vers le dehors ; la crête iliaque borne le haut.
        const fold = hipY - 9.2 + z * 0.22;
        const backFacing = smooth(-0.05, -0.35, nx);
        const behind = smooth(hipJ[0] - 1, hipJ[0] - 4, x);
        return backFacing * behind * band(y, fold, hipY + 8.2, 1.4) * band(z, 0.9, 12.5, 1.6) * smooth(0.2, 0.5, w);
      };
    }
    case 'abs': {
      const onTrunk = (b: string) => /^(root|spine0[2-5]|pelvis)/.test(b);
      return (v) => {
        const y = d.pos[v * 3 + 1]!, z = d.pos[v * 3 + 2]!;
        const nx = d.normal[v * 3]!;
        const w = d.weightOf(v, onTrunk);
        if (w < 0.3) return 0;
        // Le grand droit : plus large en haut qu'en bas.
        const half = 4.2 + smooth(hipY + 4, hipY + 18, y) * 1.6;
        return smooth(0.1, 0.4, nx) * band(y, hipY + 1.5, hipY + 20.5, 1.6) * band(Math.abs(z), -1, half, 1.4);
      };
    }
    default:
      return null;
  }
}

/** Le masque des muscles d'un exercice, de 0 à 1 par sommet. */
export function muscleMask(rig: Rig, muscles: Muscle[]): Float32Array {
  const d = rig.restData();
  const n = d.pos.length / 3;
  const out = new Float32Array(n);
  const fns = muscles
    .map((m) => region(m.muscle, m.side === 'far' || m.side === 'left' ? 'L' : 'R', d))
    .filter((f): f is (v: number) => number => f !== null);
  for (let v = 0; v < n; v++) {
    let k = 0;
    for (const f of fns) k = Math.max(k, f(v));
    out[v] = k;
  }
  return out;
}

/** Le côté opposé, pour le teinter comme le dessin le grise : les membres gauches. */
export function farMask(rig: Rig): Float32Array {
  const d = rig.restData();
  const n = d.pos.length / 3;
  const out = new Float32Array(n);
  const limbL = (b: string) => /^(upperleg|lowerleg|foot|upperarm|lowerarm|wrist|metacarpal|finger).*\.L$/.test(b);
  for (let v = 0; v < n; v++) out[v] = smooth(0.15, 0.85, d.weightOf(v, limbL));
  return out;
}
