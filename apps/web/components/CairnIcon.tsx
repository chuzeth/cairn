/**
 * Trois pierres empilées, sur le fond de l'application. Glyphe provisoire, repris
 * lors de la passe de design : toutes les icônes générées (`app/icon.tsx`,
 * `app/apple-icon.tsx`) le lisent ici, le remplacer les remplace toutes.
 */
export function CairnIcon({ size }: { size: number }) {
  return (
    <div style={{ width: size, height: size, display: 'flex', background: '#08090d' }}>
      <svg width={size} height={size} viewBox="0 0 100 100">
        <ellipse cx="50" cy="68.5" rx="30" ry="11" fill="#e9ecf1" />
        <ellipse cx="48" cy="46" rx="21" ry="9" fill="#e9ecf1" />
        <ellipse cx="51" cy="27.5" rx="13" ry="7" fill="#e9ecf1" />
      </svg>
    </div>
  );
}
