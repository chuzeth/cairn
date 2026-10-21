/**
 * Trois pierres empilées, à l'encre sur le papier de l'application (Altitude) —
 * les mêmes que celles de l'onglet « Aujourd'hui ». Toutes les icônes générées
 * (`app/icon.tsx`, `app/apple-icon.tsx`) le lisent ici : le remplacer les
 * remplace toutes.
 */
export function CairnIcon({ size }: { size: number }) {
  return (
    <div style={{ width: size, height: size, display: 'flex', background: '#F7F3EC' }}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        <ellipse cx="50" cy="68.5" rx="30" ry="11" fill="#1C1915" />
        <ellipse cx="48" cy="46" rx="21" ry="9" fill="#1C1915" />
        <ellipse cx="51" cy="27.5" rx="13" ry="7" fill="#1C1915" />
      </svg>
    </div>
  );
}
