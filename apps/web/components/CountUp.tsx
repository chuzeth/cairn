'use client';
import { useEffect, useRef, useState } from 'react';

/**
 * Un nombre qui arrive : de sa valeur d'avant à la nouvelle, en 700 ms, la fin
 * ralentie — ce qu'on lit d'abord sur un écran se pose, il ne surgit pas. À la
 * première lecture il part de zéro ; à la suivante (une réponse du matin, une
 * relève), de ce qu'il montrait. Sans mouvement demandé, il est là d'emblée.
 */
export function CountUp({ value, decimals = 0, ms = 700 }: { value: number; decimals?: number; ms?: number }) {
  const [shown, setShown] = useState(value);
  const from = useRef<number | null>(null);
  useEffect(() => {
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = from.current ?? 0;
    from.current = value;
    if (still || start === value) {
      setShown(value);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (now: number) => {
      const t = Math.min(1, (now - t0) / ms);
      const eased = 1 - Math.pow(1 - t, 3);
      setShown(start + (value - start) * eased);
      if (t < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, ms]);
  return <>{shown.toLocaleString('fr-FR', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}</>;
}
