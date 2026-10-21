/**
 * Le poids : ce que la 3D ajoute au téléphone, comparé à ce que coûte le
 * schéma vectoriel aujourd'hui. Chaque morceau est construit seul, minifié,
 * puis compressé comme le servirait Next (gzip) — et en brotli pour mémoire.
 */
import fs from 'node:fs';
import path from 'node:path';
import { brotliCompressSync, gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const here = import.meta.dirname;
const web = path.join(here, '../../apps/web');
const kb = (n) => `${(n / 1024).toFixed(1)} Ko`;

async function size(name, contents, external = []) {
  const r = await esbuild.build({
    stdin: { contents, resolveDir: here, loader: 'tsx' },
    bundle: true, minify: true, format: 'esm', write: false, target: 'safari16',
    jsx: 'automatic', alias: { '@': web }, external, define: { 'process.env.NODE_ENV': '"production"' },
  });
  const buf = Buffer.from(r.outputFiles[0].contents);
  const row = { name, min: buf.length, gzip: gzipSync(buf, { level: 9 }).length, br: brotliCompressSync(buf).length };
  console.log(`${name.padEnd(46)} ${kb(row.min).padStart(10)}  gzip ${kb(row.gzip).padStart(9)}  brotli ${kb(row.br).padStart(9)}`);
  return row;
}

// Les seules classes de three que le prototype nomme : un `import *` gardé en entier compterait tout three.
const used = [...new Set(fs.readdirSync(path.join(here, 'src')).filter((f) => f.endsWith('.ts'))
  .flatMap((f) => [...fs.readFileSync(path.join(here, 'src', f), 'utf8').matchAll(/THREE\.([A-Z]\w+)/g)].map((m) => m[1])))].sort();
const three = await size('three.js 0.186.1 (ce que la vignette en tire)', `
  import { ${used.join(', ')} } from 'three';
  console.log(${used.join(', ')});
  import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
  import { MeshoptDecoder } from 'three/examples/jsm/libs/meshopt_decoder.module.js';
  import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
  import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
  console.log(GLTFLoader, MeshoptDecoder, RoomEnvironment, RoundedBoxGeometry);
`);
const proto = await size('code 3D du prototype (rig, muscles, scène)', `
  import { Viewer } from './src/viewer';
  console.log(Viewer);
`, ['three', 'three/*', '../../apps/web/lib/*']);
const vector = await size('schéma vectoriel en service (composant + poses)', `
  import { ExerciseFigure } from '@/components/ExerciseFigure';
  console.log(ExerciseFigure);
`, ['react', 'react/*', 'react-dom', '@cairn/*']);

const glb = (f) => {
  const buf = fs.readFileSync(path.join(here, 'www', f));
  return { min: buf.length, gzip: gzipSync(buf, { level: 9 }).length, br: brotliCompressSync(buf).length };
};
const model = glb('mannequin.glb');
const raw = glb('mannequin.raw.glb');
console.log(`${'mannequin, meshopt (EXT_meshopt_compression)'.padEnd(46)} ${kb(model.min).padStart(10)}  gzip ${kb(model.gzip).padStart(9)}  brotli ${kb(model.br).padStart(9)}`);
console.log(`${'mannequin, brut'.padEnd(46)} ${kb(raw.min).padStart(10)}  gzip ${kb(raw.gzip).padStart(9)}  brotli ${kb(raw.br).padStart(9)}`);
const added = three.gzip + proto.gzip + model.gzip;
console.log(`\nAjouté par la 3D, gzip : ${kb(added)} (three ${kb(three.gzip)} + code ${kb(proto.gzip)} + mannequin ${kb(model.gzip)}), soit ${(added / vector.gzip).toFixed(0)} fois le schéma vectoriel (${kb(vector.gzip)}).`);
fs.writeFileSync(path.join(here, 'measures-weight.json'), JSON.stringify({ three, proto, vector, model, raw, added }, null, 2));
