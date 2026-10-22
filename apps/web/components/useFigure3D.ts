'use client';
import { useEffect, useRef, useState } from 'react';
import { FigureStage, type FigureFrame, type FigureView } from '@/lib/figure3d/stage';

/**
 * Le mannequin 3D d'une vignette : créé quand elle approche de l'écran — pas
 * trente-six d'un coup en ouvrant `/exercices` —, dessiné à chaque instant du
 * geste, redessiné quand la vignette change de taille ou l'app de thème.
 *
 * `ready` passe à vrai à la première image réussie : jusque-là, la vignette
 * montre le dessin vectoriel entier. Sans WebGL, ou si le mannequin ne se
 * charge pas, elle le garde.
 */
export function useFigure3D(target: { exercise: string; index: number } | null, phase: number, frame: FigureFrame) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [view, setView] = useState<FigureView | null>(null);
  const [ready, setReady] = useState(false);
  const [failed, setFailed] = useState(false);
  const exercise = target?.exercise;
  const index = target?.index ?? 0;

  useEffect(() => {
    const el = canvasRef.current;
    if (!exercise || !el) return;
    let alive = true;
    let made: FigureView | null = null;
    const io = new IntersectionObserver(([e]) => {
      if (!e?.isIntersecting) return;
      io.disconnect();
      FigureStage.get()
        .then((stage) => {
          if (!alive) return;
          made = stage.view(exercise, index, el);
          setView(made);
        })
        .catch(() => { if (alive) setFailed(true); });
    }, { rootMargin: '300px' });
    io.observe(el);
    return () => {
      alive = false;
      io.disconnect();
      made?.dispose();
      setView(null);
      setReady(false);
    };
  }, [exercise, index]);

  // La dernière demande de dessin : les redessins de taille et de thème la reprennent.
  const latest = useRef({ phase, frame });
  latest.current = { phase, frame };
  const draw = useRef(() => {});
  draw.current = () => {
    if (!view || failed) return;
    try {
      if (view.draw(latest.current.phase, latest.current.frame)) setReady(true);
    } catch {
      setFailed(true);
    }
  };

  useEffect(() => { draw.current(); }, [view, phase, frame.x0, frame.x1, frame.y0, frame.y1]);

  useEffect(() => {
    const el = canvasRef.current;
    if (!view || !el) return;
    const redraw = () => draw.current();
    const size = new ResizeObserver(redraw);
    size.observe(el);
    const theme = new MutationObserver(redraw);
    theme.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] });
    return () => { size.disconnect(); theme.disconnect(); };
  }, [view]);

  return { canvasRef, ready: ready && !failed, active: Boolean(exercise) && !failed };
}
