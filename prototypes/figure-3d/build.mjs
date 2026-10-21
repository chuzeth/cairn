/**
 * La construction du prototype : les pages dans `www/`, three.js figé
 * (0.186.1) embarqué, rien chargé depuis un CDN. Le métafichier d'esbuild dit
 * ce que pèse chaque morceau.
 */
import fs from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';

const here = import.meta.dirname;
const www = path.join(here, 'www');
const web = path.join(here, '../../apps/web');
fs.mkdirSync(www, { recursive: true });
// Les morceaux d'une construction précédente : leurs noms changent avec leur contenu.
for (const f of fs.readdirSync(www)) if (/^chunk-.*\.js$/.test(f)) fs.rmSync(path.join(www, f));

const entries = { viewer: 'src/main.ts', board: 'src/board.tsx' };
const result = await esbuild.build({
  entryPoints: Object.fromEntries(Object.entries(entries).filter(([, f]) => fs.existsSync(path.join(here, f))).map(([k, f]) => [k, path.join(here, f)])),
  bundle: true,
  format: 'esm',
  splitting: true,
  minify: true,
  target: 'safari16',
  outdir: www,
  metafile: true,
  jsx: 'automatic',
  define: { 'process.env.NODE_ENV': '"production"' },
  alias: { '@': web },
  logLevel: 'warning',
});
for (const f of ['index.html', 'board.html', 'sw.js']) {
  if (fs.existsSync(path.join(here, 'src', f))) fs.copyFileSync(path.join(here, 'src', f), path.join(www, f));
}
// Les styles des schémas vectoriels, tels que l'app les sert.
fs.copyFileSync(path.join(web, 'app/globals.css'), path.join(www, 'globals.css'));

// Ce que pèse three.js dans la vignette 3D, minifié puis compressé.
const byInput = {};
for (const [out, meta] of Object.entries(result.metafile.outputs)) {
  for (const [input, info] of Object.entries(meta.inputs)) {
    const key = input.includes('node_modules/three/') ? 'three' : input.includes('apps/web/') ? 'cairn (figure, poses)' : input.includes('node_modules/react') || input.includes('scheduler') ? 'react' : 'prototype';
    byInput[key] ??= {};
    byInput[key][path.basename(out)] = (byInput[key][path.basename(out)] ?? 0) + info.bytesInOutput;
  }
}
const kb = (n) => `${(n / 1024).toFixed(1)} Ko`;
console.log('Octets dans la sortie minifiée, par origine :', Object.fromEntries(Object.entries(byInput).map(([k, v]) => [k, Object.fromEntries(Object.entries(v).map(([f, n]) => [f, kb(n)]))])));
for (const f of fs.readdirSync(www).filter((f) => /\.(js|glb)$/.test(f))) {
  const buf = fs.readFileSync(path.join(www, f));
  console.log(`${f.padEnd(28)} ${kb(buf.length).padStart(10)}   gzip ${kb(gzipSync(buf, { level: 9 }).length).padStart(10)}`);
}
