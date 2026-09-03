'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';

const LINKS = [
  { href: '/', label: 'Tableau de bord', icon: 'grid' },
  { href: '/point', label: 'Point du jour', icon: 'sun' },
  { href: '/coach', label: 'Coach', icon: 'chat' },
  { href: '/plan', label: 'Plan', icon: 'calendar' },
  { href: '/activities', label: 'Séances', icon: 'activity' },
  { href: '/races', label: 'Objectifs', icon: 'flag' },
  { href: '/physiology', label: 'Physiologie', icon: 'pulse' },
];

function Icon({ name }: { name: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const paths: Record<string, React.ReactNode> = {
    grid: <><rect x="3" y="3" width="7" height="7" rx="1.5" {...common} /><rect x="14" y="3" width="7" height="7" rx="1.5" {...common} /><rect x="3" y="14" width="7" height="7" rx="1.5" {...common} /><rect x="14" y="14" width="7" height="7" rx="1.5" {...common} /></>,
    sun: <><circle cx="12" cy="12" r="4" {...common} /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" {...common} /></>,
    chat: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" {...common} />,
    calendar: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" {...common} /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" {...common} /></>,
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" {...common} />,
    flag: <><path d="M4 21V4M4 4h11l-1.6 3.5L15 11H4" {...common} /></>,
    pulse: <><circle cx="12" cy="12" r="9" {...common} /><path d="M7.5 12h2l1.5-3.5 2 7 1.5-3.5h2" {...common} /></>,
  };
  return <svg viewBox="0 0 24 24" className="nav-icon">{paths[name]}</svg>;
}

export function Nav() {
  const pathname = usePathname();
  return (
    <nav className="sidebar">
      <Link href="/" className="brand">
        <svg viewBox="0 0 32 32" className="brand-mark" aria-hidden>
          {/* Un cairn : les pierres empilées qui balisent un sentier. */}
          <ellipse cx="16" cy="27" rx="9" ry="2.6" fill="#1c212c" />
          <path d="M8.5 24.5h15l-2-3.6h-11z" fill="#4b5768" />
          <path d="M10.5 20.5h11l-1.8-3.6h-7.4z" fill="#66748a" />
          <path d="M12.2 16.5h7.6l-1.5-3.4h-4.6z" fill="#8b9bb0" />
          <path d="M14 12.8h4l-2-4.4z" fill="#7dd3a0" />
        </svg>
        <span>
          <div className="brand-name">Cairn</div>
          <div className="brand-sub">Performance trail</div>
        </span>
      </Link>

      {LINKS.map((l) => (
        <Link
          key={l.href}
          href={l.href}
          className="nav-link"
          data-active={l.href === '/' ? pathname === '/' : pathname.startsWith(l.href)}
        >
          <Icon name={l.icon} />
          {l.label}
        </Link>
      ))}

      <div className="sidebar-foot">
        <div>Pierre Chuzeville</div>
        <div style={{ marginTop: 3 }}>Test d'effort du 24/07/2025</div>
      </div>
    </nav>
  );
}
