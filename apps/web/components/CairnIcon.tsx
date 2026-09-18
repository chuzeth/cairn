/**
 * Trois pierres empilées, en blanc pierre sur l'ardoise de l'application — les
 * mêmes que celles de l'onglet « Aujourd'hui ». Toutes les icônes générées
 * (`app/icon.tsx`, `app/apple-icon.tsx`) le lisent ici : le remplacer les
 * remplace toutes.
 */
export function CairnIcon({ size }: { size: number }) {
  return (
    <div style={{ width: size, height: size, display: 'flex', background: '#0e1316' }}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        <ellipse cx="50" cy="68.5" rx="30" ry="11" fill="#ece8df" />
        <ellipse cx="48" cy="46" rx="21" ry="9" fill="#ece8df" />
        <ellipse cx="51" cy="27.5" rx="13" ry="7" fill="#ece8df" />
      </svg>
    </div>
  );
}
