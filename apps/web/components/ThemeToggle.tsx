'use client';
import { useEffect, useState } from 'react';
import { applyTheme, readTheme, type Theme } from '@/lib/theme';

/**
 * La bascule clair / sombre : un soleil ou une lune, et l'interrupteur.
 *
 * Tant que le thème n'est pas lu (rendu serveur), l'interrupteur est dessiné
 * éteint et désactivé : il ne doit pas annoncer un état qu'il ne connaît pas.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const [theme, setTheme] = useState<Theme | null>(null);
  useEffect(() => { setTheme(readTheme()); }, []);
  const dark = theme === 'dark';

  return (
    <button
      type="button"
      className={className ? `theme-toggle ${className}` : 'theme-toggle'}
      aria-label={dark ? 'Passer en mode clair' : 'Passer en mode sombre'}
      aria-pressed={dark}
      disabled={theme === null}
      onClick={() => {
        const next: Theme = dark ? 'light' : 'dark';
        applyTheme(next);
        setTheme(next);
      }}
    >
      {dark ? (
        <svg width="15" height="15" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
          <path d="M13.5 9.6A6 6 0 0 1 6.4 2.5a6 6 0 1 0 7.1 7.1Z" />
        </svg>
      ) : (
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.2" aria-hidden>
          <circle cx="8" cy="8" r="3" />
          <path d="M8 1v2M8 13v2M1 8h2M13 8h2M3 3l1.4 1.4M11.6 11.6 13 13M3 13l1.4-1.4M11.6 4.4 13 3" />
        </svg>
      )}
      <span className="theme-track" data-on={dark}><span className="theme-knob" /></span>
    </button>
  );
}
