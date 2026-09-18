import type { MetadataRoute } from 'next';

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
    background_color: '#0e1316',
    theme_color: '#0e1316',
    icons: [{ src: '/icon', sizes: '512x512', type: 'image/png' }],
  };
}
