'use client';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { useEffect, useState } from 'react';
import { LAB_TEST_DATE } from '@/lib/athlete';
import { ThemeToggle } from './ThemeToggle';
import { Version } from './Version';

/**
 * Deux navigations pour un seul site.
 *
 * Sur un écran large, une barre en haut : le nom, toutes les destinations en
 * petites capitales, la bascule clair / sombre. Sur un téléphone, la navigation
 * passe sous le pouce : quatre destinations du matin, et le reste dans une
 * feuille. Du texte, pas d'icônes — le 21/10, la refonte inspirée de Zara :
 * l'onglet actif est souligné, les autres s'effacent.
 */

interface NavLink { href: string; label: string; short?: string }

const LINKS: NavLink[] = [
  { href: '/', label: "Aujourd'hui", short: "Aujourd'hui" },
  { href: '/plan', label: 'Plan', short: 'Plan' },
  { href: '/point', label: 'Point', short: 'Point' },
  { href: '/coach', label: 'Coach', short: 'Coach' },
  { href: '/activities', label: 'Séances' },
  { href: '/exercices', label: 'Exercices' },
  { href: '/races', label: 'Objectifs' },
  { href: '/physiology', label: 'Physiologie' },
];

/** Ce qu'on ouvre au réveil ; le reste se consulte, il ne se surveille pas. */
const TABS = LINKS.filter((l) => l.short);
const SHEET = LINKS.filter((l) => !l.short);

const isActive = (href: string, pathname: string) =>
  href === '/' ? pathname === '/' : pathname.startsWith(href);

export function Nav() {
  const pathname = usePathname();
  const [sheet, setSheet] = useState(false);

  // Une feuille qui survit à la navigation recouvrirait la page qu'on vient
  // d'ouvrir.
  useEffect(() => { setSheet(false); }, [pathname]);

  const sheetActive = SHEET.some((l) => isActive(l.href, pathname));

  return (
    <>
      <nav className="sidebar" aria-label="Navigation principale">
        <Link href="/" className="brand" aria-label="Cairn, aujourd'hui">CAIRN</Link>
        <div className="nav-links">
          {LINKS.map((l) => (
            <Link
              key={l.href}
              href={l.href}
              className="nav-link"
              data-active={isActive(l.href, pathname)}
              aria-current={isActive(l.href, pathname) ? 'page' : undefined}
            >
              {l.label}
            </Link>
          ))}
        </div>
        <ThemeToggle />
      </nav>

      {sheet && (
        <div className="sheet-veil" onClick={() => setSheet(false)}>
          <div className="sheet" onClick={(e) => e.stopPropagation()} role="dialog" aria-label="Le reste du site">
            <div className="sheet-grip" />
            {SHEET.map((l) => (
              <Link key={l.href} href={l.href} className="sheet-link" data-active={isActive(l.href, pathname)}>
                {l.label}
              </Link>
            ))}
            <div className="sheet-foot">
              Pierre Chuzeville · test d&apos;effort du {LAB_TEST_DATE}
              <Version />
            </div>
          </div>
        </div>
      )}

      <nav className="tabbar" aria-label="Navigation principale">
        {TABS.map((l) => (
          <Link
            key={l.href}
            href={l.href}
            className="tab"
            data-active={isActive(l.href, pathname)}
            aria-current={isActive(l.href, pathname) ? 'page' : undefined}
          >
            <span>{l.short}</span>
          </Link>
        ))}
        <button type="button" className="tab" data-active={sheet || sheetActive} aria-expanded={sheet} onClick={() => setSheet((s) => !s)}>
          <span>Plus</span>
        </button>
      </nav>
    </>
  );
}
