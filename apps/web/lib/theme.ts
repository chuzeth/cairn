/**
 * Le clair et le sombre.
 *
 * Le 21/10, Pierre : « un dark mode, avec un petit toggle, en haut à droite ».
 * Le choix se garde sur l'appareil — c'est une préférence de lecture, pas une
 * donnée d'entraînement — et s'applique avant le premier rendu : le script de
 * `THEME_SCRIPT` pose `data-theme` sur `<html>` dans le `<head>`, sans quoi
 * l'app s'ouvrirait en papier puis basculerait en nuit sous les yeux.
 *
 * Sans choix enregistré, c'est le clair : la direction validée l'a été sur le
 * papier, et un téléphone réglé en sombre ne doit pas changer l'app sans qu'on
 * l'ait demandé.
 */

export type Theme = 'light' | 'dark';

export const THEME_KEY = 'cairn:theme';

/** Le fond de chaque thème : la barre d'état et l'écran de lancement le reprennent. */
export const THEME_BG: Record<Theme, string> = { light: '#F7F3EC', dark: '#13110F' };

/** Lu dans le `<head>`, avant que rien ne se dessine. */
export const THEME_SCRIPT =
  `(function(){var t='light';try{var s=localStorage.getItem('${THEME_KEY}');if(s==='dark')t='dark'}catch(e){}` +
  `document.documentElement.dataset.theme=t;` +
  `var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute('content',t==='dark'?'${THEME_BG.dark}':'${THEME_BG.light}')})()`;

export function readTheme(): Theme {
  if (typeof document === 'undefined') return 'light';
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

export function applyTheme(theme: Theme): void {
  document.documentElement.dataset.theme = theme;
  document.querySelector('meta[name="theme-color"]')?.setAttribute('content', THEME_BG[theme]);
  try {
    localStorage.setItem(THEME_KEY, theme);
  } catch {
    // Navigation privée : le thème vaut pour la visite, pas au-delà.
  }
}
