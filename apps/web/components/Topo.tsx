/**
 * Les courbes de niveau de l'écran d'ouverture, et le pictogramme de Face ID.
 *
 * Les mêmes que la page de connexion de la porte (`apps/gate/src/page.ts`) :
 * qu'elle s'ouvre depuis la porte ou depuis le cache du téléphone, l'app
 * commence par le même écran.
 */
export function Topo({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true">
      <g>
        <path d="M-20 70 C 60 40, 120 92, 196 62 S 330 26, 420 54" />
        <path d="M-20 104 C 70 74, 132 124, 204 96 S 330 62, 420 88" />
        <path d="M-20 138 C 80 110, 142 156, 214 130 S 338 98, 420 122" />
        <path d="M-20 172 C 92 146, 152 188, 224 164 S 346 134, 420 156" />
        <path d="M-20 206 C 104 182, 164 220, 236 198 S 356 170, 420 190" />
        <path d="M-20 240 C 116 218, 176 252, 248 232 S 366 206, 420 224" />
        <path d="M146 150 C 170 132, 214 134, 226 150 S 196 176, 170 170 S 128 164, 146 150 Z" />
        <path d="M164 152 C 178 142, 204 144, 210 153 S 192 166, 178 163 S 154 160, 164 152 Z" />
      </g>
    </svg>
  );
}

export function FaceGlyph({ className }: { className?: string }) {
  return (
    <svg
      className={className} viewBox="0 0 48 48" fill="none" stroke="currentColor" strokeWidth="2.4"
      strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"
    >
      <path d="M6 16v-5a5 5 0 0 1 5-5h5M32 6h5a5 5 0 0 1 5 5v5M42 32v5a5 5 0 0 1-5 5h-5M16 42h-5a5 5 0 0 1-5-5v-5" />
      <path d="M17 18v4M31 18v4M24 18v9h-2M18 32c3.5 3 8.5 3 12 0" />
    </svg>
  );
}
