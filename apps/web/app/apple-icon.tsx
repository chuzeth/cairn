import { ImageResponse } from 'next/og';
import { CairnIcon } from '@/components/CairnIcon';

/** Icône de l'écran d'accueil iOS : un PNG opaque, dont iOS arrondit lui-même les coins. */
export const size = { width: 180, height: 180 };
export const contentType = 'image/png';

export default function AppleIcon() {
  return new ImageResponse(<CairnIcon size={size.width} />, size);
}
