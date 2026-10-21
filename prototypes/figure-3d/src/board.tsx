/**
 * La planche : pour chaque exercice, le schéma vectoriel en service (le vrai
 * composant de l'app, `ExerciseFigure`) et le mannequin 3D, côte à côte, au
 * même tempo et dans le même cadre — celui du schéma vectoriel. Le thème se
 * bascule en clair ou en sombre, pour les deux à la fois.
 */
import { createRoot } from 'react-dom/client';
import { ExerciseFigure } from '@/components/ExerciseFigure';
import { Viewer, type Theme } from './viewer';

const EXERCISES = [
  { key: 'split-squat-bulgare', tempo: '3 s pour descendre, 1 s pour remonter' },
  { key: 'step-up', tempo: '1 s pour monter, 3 s pour redescendre' },
  { key: 'dead-bug', tempo: '3 s pour descendre, 2 s pour revenir' },
] as const;

const stored = (() => { try { return localStorage.getItem('fig3d-theme'); } catch { return null; } })();
let theme: Theme = stored === 'dark' ? 'dark' : 'light';
document.documentElement.dataset.theme = theme;

const viewers: Viewer[] = [];
const glb = fetch('./mannequin.glb').then((r) => r.arrayBuffer());

for (const ex of EXERCISES) {
  const section = document.querySelector<HTMLElement>(`[data-ex="${ex.key}"]`)!;
  const vectorHost = section.querySelector<HTMLElement>('.b-vector')!;
  const canvas = section.querySelector<HTMLCanvasElement>('canvas')!;
  createRoot(vectorHost).render(<ExerciseFigure exercise={ex.key} label={ex.key} tempo={ex.tempo} />);

  // Le cadre 3D est celui du schéma vectoriel : on attend son SVG pour lire son viewBox.
  const wait = () => new Promise<SVGSVGElement>((done) => {
    const look = () => {
      const svg = vectorHost.querySelector<SVGSVGElement>('svg.xf');
      if (svg) done(svg); else requestAnimationFrame(look);
    };
    look();
  });
  void wait().then(async (svg) => {
    const [x, y, w, h] = svg.getAttribute('viewBox')!.split(' ').map(Number) as [number, number, number, number];
    const fit = () => { canvas.style.height = `${svg.getBoundingClientRect().height}px`; };
    fit();
    const viewer = new Viewer({ canvas, exercise: ex.key, theme, tempo: ex.tempo, frame: { x0: x, x1: x + w, y1: -y, y0: -y - h } });
    await viewer.load(await glb);
    // Le thème a pu changer pendant le chargement.
    viewer.setTheme(theme);
    viewers.push(viewer);
    addEventListener('resize', () => { fit(); viewer.resize(); });
    canvas.addEventListener('click', () => { viewer.paused = !viewer.paused; });
    // Comme le vecteur : il ne bouge que sous les yeux, et repart du début quand il y revient.
    new IntersectionObserver(([e]) => { if (e?.isIntersecting) viewer.start(); else viewer.stop(); }, { threshold: 0.2 }).observe(canvas);
  });
}

// Le même mannequin, tourné : ce que le profil cache.
for (const canvas of document.querySelectorAll<HTMLCanvasElement>('canvas[data-turned]')) {
  const key = canvas.dataset.turned as (typeof EXERCISES)[number]['key'];
  const ex = EXERCISES.find((e) => e.key === key)!;
  void (async () => {
    const viewer = new Viewer({ canvas, exercise: key, theme, tempo: ex.tempo, yaw: Number(canvas.dataset.yaw), elevation: Number(canvas.dataset.elev ?? 10) });
    await viewer.load(await glb);
    viewer.setTheme(theme);
    viewers.push(viewer);
    addEventListener('resize', () => viewer.resize());
    canvas.addEventListener('click', () => { viewer.paused = !viewer.paused; });
    new IntersectionObserver(([e]) => { if (e?.isIntersecting) viewer.start(); else viewer.stop(); }, { threshold: 0.2 }).observe(canvas);
  })();
}

for (const b of document.querySelectorAll<HTMLButtonElement>('[data-theme-to]')) {
  b.setAttribute('aria-pressed', String(b.dataset.themeTo === theme));
  b.addEventListener('click', () => {
    theme = b.dataset.themeTo as Theme;
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('fig3d-theme', theme); } catch { /* sans stockage, le thème vaut pour la visite */ }
    for (const v of viewers) v.setTheme(theme);
    for (const o of document.querySelectorAll<HTMLButtonElement>('[data-theme-to]')) o.setAttribute('aria-pressed', String(o === b));
  });
}
