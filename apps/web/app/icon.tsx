import { ImageResponse } from 'next/og';
import { CairnIcon } from '@/components/CairnIcon';

export const size = { width: 512, height: 512 };
export const contentType = 'image/png';

export default function Icon() {
  return new ImageResponse(<CairnIcon size={size.width} />, size);
}
