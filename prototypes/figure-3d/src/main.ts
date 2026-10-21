/**
 * La page d'une vignette : `?ex=step-up&theme=dark&hud=1`. Le compteur (`hud`)
 * dit les images par seconde et le temps de calcul d'une image ; il sert aux
 * mesures sur le simulateur.
 */
import { Viewer, type Theme } from './viewer';

const TEMPOS: Record<string, string> = {
  'split-squat-bulgare': '3 s pour descendre, 1 s pour remonter',
  'step-up': '1 s pour monter, 3 s pour redescendre',
  'dead-bug': '3 s pour descendre, 2 s pour revenir',
};

const q = new URLSearchParams(location.search);
const exercise = (q.get('ex') ?? 'split-squat-bulgare') as keyof typeof TEMPOS;
const theme = (q.get('theme') ?? 'light') as Theme;
document.documentElement.dataset.theme = theme;

if ('serviceWorker' in navigator && q.get('sw') !== '0') navigator.serviceWorker.register('./sw.js').catch(() => {});

const canvas = document.querySelector<HTMLCanvasElement>('#c')!;
const hud = document.querySelector<HTMLElement>('#hud')!;
const t0 = performance.now();
const viewer = new Viewer({
  canvas,
  exercise: exercise as never,
  theme,
  tempo: TEMPOS[exercise],
  elevation: Number(q.get('elev') ?? 6),
  yaw: Number(q.get('yaw') ?? 0),
  shadow: (q.get('shadow') ?? undefined) as 'pcf' | 'vsm' | 'basic' | undefined,
});
const glb = await fetch('./mannequin.glb').then((r) => r.arrayBuffer());
await viewer.load(glb);
const ready = performance.now() - t0;
(window as unknown as { viewer: Viewer }).viewer = viewer;
if (q.get('t') !== null) { viewer.paused = true; viewer.still = Number(q.get('t')); }
viewer.start();
addEventListener('resize', () => viewer.resize());
canvas.addEventListener('click', () => { viewer.paused = !viewer.paused; });

if (q.get('hud') === '1') {
  hud.hidden = false;
  setInterval(() => {
    const iv = viewer.stats.intervals.slice(-120);
    const wk = viewer.stats.work.slice(-120);
    if (iv.length < 10) return;
    const avg = iv.reduce((a, b) => a + b, 0) / iv.length;
    const worst = [...iv].sort((a, b) => b - a)[Math.floor(iv.length * 0.05)]!;
    const work = wk.reduce((a, b) => a + b, 0) / wk.length;
    hud.textContent = `${(1000 / avg).toFixed(0)} i/s · p95 ${worst.toFixed(1)} ms · calcul ${work.toFixed(1)} ms · prêt en ${ready.toFixed(0)} ms`;
  }, 500);
}

/** Les mesures de fluidité, envoyées au serveur du prototype après `report` secondes d'animation. */
if (q.get('report')) {
  setTimeout(() => {
    const iv = viewer.stats.intervals.slice(-300);
    const wk = viewer.stats.work.slice(-300);
    const pct = (a: number[], p: number) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))]!;
    const mean = (a: number[]) => a.reduce((x, y) => x + y, 0) / a.length;
    void fetch('/__stats', {
      method: 'POST',
      body: JSON.stringify({
        page: 'viewer', exercise, theme, when: new Date().toISOString(), ua: navigator.userAgent,
        dpr: devicePixelRatio, css: [innerWidth, innerHeight], frames: iv.length,
        fps: +(1000 / mean(iv)).toFixed(1), intervalP95: +pct(iv, 0.95).toFixed(1), intervalMax: +Math.max(...iv).toFixed(1),
        workMean: +mean(wk).toFixed(2), workP95: +pct(wk, 0.95).toFixed(2), readyMs: Math.round(ready),
        dropped: iv.filter((x) => x > 25).length,
      }),
    });
  }, Number(q.get('report')) * 1000);
}
