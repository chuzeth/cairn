'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { frDate } from '@/lib/api';

/**
 * Deux navigations pour un seul site.
 *
 * Sur un écran large, la barre latérale : sept destinations visibles en
 * permanence, elle ne coûte rien. Sur un téléphone, elle coûterait le haut du
 * premier écran — l'endroit exact où doit se trouver la réponse à « qu'est-ce
 * que je fais aujourd'hui ». Au téléphone, la navigation passe donc sous le
 * pouce : trois destinations du matin, et le reste dans une feuille.
 */

interface NavLink { href: string; label: string; short?: string; icon: string }

const LINKS: NavLink[] = [
  { href: '/', label: 'Tableau de bord', short: "Aujourd'hui", icon: 'stones' },
  { href: '/point', label: 'Point du jour', short: 'Point', icon: 'sun' },
  { href: '/coach', label: 'Coach', short: 'Coach', icon: 'chat' },
  { href: '/plan', label: 'Plan', icon: 'calendar' },
  { href: '/activities', label: 'Séances', icon: 'activity' },
  { href: '/races', label: 'Objectifs', icon: 'flag' },
  { href: '/physiology', label: 'Physiologie', icon: 'pulse' },
];

/** Le test d'effort qui sert d'a priori — écrit comme on le dit, pas en chiffres. */
const LAB_TEST_DATE = frDate('2025-07-24', { long: true, year: true });

/** Ce qu'on ouvre au réveil ; le reste se consulte, il ne se surveille pas. */
const TABS = LINKS.filter((l) => l.short);
const SHEET = LINKS.filter((l) => !l.short);

const isActive = (href: string, pathname: string) =>
  href === '/' ? pathname === '/' : pathname.startsWith(href);

function Icon({ name }: { name: string }) {
  const common = { fill: 'none', stroke: 'currentColor', strokeWidth: 1.7, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const };
  const paths: Record<string, React.ReactNode> = {
    // Les trois pierres du cairn : ce qui balise le sentier marque le jour même.
    stones: <><ellipse cx="12" cy="17.7" rx="7.6" ry="2.8" {...common} /><ellipse cx="11.3" cy="11.9" rx="5.4" ry="2.4" {...common} /><ellipse cx="12.3" cy="6.9" rx="3.3" ry="1.9" {...common} /></>,
    sun: <><circle cx="12" cy="12" r="4" {...common} /><path d="M12 2.5v2M12 19.5v2M2.5 12h2M19.5 12h2M5.2 5.2l1.4 1.4M17.4 17.4l1.4 1.4M18.8 5.2l-1.4 1.4M6.6 17.4l-1.4 1.4" {...common} /></>,
    chat: <path d="M21 11.5a8.4 8.4 0 0 1-9 8.4 8.9 8.9 0 0 1-4-.9L3 21l1.9-4.6A8.4 8.4 0 0 1 12 3.1a8.4 8.4 0 0 1 9 8.4Z" {...common} />,
    calendar: <><rect x="3" y="4.5" width="18" height="16.5" rx="2" {...common} /><path d="M3 9.5h18M8 2.5v4M16 2.5v4" {...common} /></>,
    activity: <path d="M3 12h4l3-8 4 16 3-8h4" {...common} />,
    flag: <><path d="M4 21V4M4 4h11l-1.6 3.5L15 11H4" {...common} /></>,
    pulse: <><circle cx="12" cy="12" r="9" {...common} /><path d="M7.5 12h2l1.5-3.5 2 7 1.5-3.5h2" {...common} /></>,
    more: <><circle cx="5" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="19" cy="12" r="1.6" fill="currentColor" stroke="none" /></>,
  };
  return <svg viewBox="0 0 24 24" className="nav-icon">{paths[name]}</svg>;
}

export function Nav() {
  const pathname = usePathname();
  const [sheet, setSheet] = useState(false);

  // Une feuille qui survit à la navigation recouvrirait la page qu'on vient
  // d'ouvrir.
  useEffect(() => { setSheet(false); }, [pathname]);

  const sheetActive = SHEET.some((l) => isActive(l.href, pathname));

  return (
    <>
      <nav className="sidebar">
        <Link href="/" className="brand">
          <svg viewBox="0 0 32 32" className="brand-mark" aria-hidden>
            {/* Un cairn : les pierres empilées qui balisent un sentier. */}
            <ellipse cx="16" cy="27" rx="9" ry="2.6" fill="var(--border)" />
            <path d="M8.5 24.5h15l-2-3.6h-11z" fill="var(--text-faint)" />
            <path d="M10.5 20.5h11l-1.8-3.6h-7.4z" fill="var(--text-dim)" />
            <path d="M12.2 16.5h7.6l-1.5-3.4h-4.6z" fill="var(--text)" />
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
            data-active={isActive(l.href, pathname)}
          >
            <Icon name={l.icon} />
            {l.label}
          </Link>
        ))}

        <div className="sidebar-foot">
          <div>Pierre Chuzeville</div>
          <div style={{ marginTop: 3 }}>Test d'effort du {LAB_TEST_DATE}</div>
        </div>
      </nav>

      {sheet && (
        <div className="sheet-veil" onClick={() => setSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Le reste du site">
            <div className="sheet-grip" />
            {SHEET.map((l) => (
              <Link key={l.href} href={l.href} className="sheet-link" data-active={isActive(l.href, pathname)}>
                <Icon name={l.icon} />
                {l.label}
              </Link>
            ))}
            <div className="sheet-foot">Pierre Chuzeville · test d'effort du {LAB_TEST_DATE}</div>
          </div>
        </div>
      )}

      <nav className="tabbar">
        {TABS.map((l) => (
          <Link key={l.href} href={l.href} className="tab" data-active={isActive(l.href, pathname)}>
            <Icon name={l.icon} />
            {l.short}
          </Link>
        ))}
        <button type="button" className="tab" data-active={sheet || sheetActive} onClick={() => setSheet((s) => !s)}>
          <Icon name="more" />
          Plus
        </button>
      </nav>
    </>
  );
}
