import type { MetadataRoute } from 'next';
import { THEME_BG } from '@/lib/theme';

/**
 * Cairn s'installe sur l'écran d'accueil et s'ouvre sans l'interface du
 * navigateur : au réveil, c'est une application qu'on ouvre, pas un onglet.
 */
export default function manifest(): MetadataRoute.Manifest {
  return {
    name: 'Cairn',
    short_name: 'Cairn',
    description: 'Coaching trail personnalisé',
    lang: 'fr',
    start_url: '/',
    scope: '/',
    display: 'standalone',
    background_color: THEME_BG.light,
    theme_color: THEME_BG.light,
    icons: [{ src: '/icon', sizes: '512x512', type: 'image/png' }],
  };
}
