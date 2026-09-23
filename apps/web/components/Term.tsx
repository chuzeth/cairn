'use client';
import { Fragment, useEffect, type ReactNode } from 'react';
import { usePathname } from 'next/navigation';
import type { GlossaryKey } from '@/lib/api';
import { closeTerm, toggleTerm, useGlossary, useOpenTerm } from '@/lib/glossary';

/**
 * Un mot technique, et sa définition à un tap.
 *
 * Un soulignement pointillé, rien de plus : ni icône, ni point d'interrogation.
 * Le mot se lit comme les autres, et qui ne le connaît pas le touche. La
 * définition s'ouvre en bas de l'écran, au-dessus des onglets, toujours au même
 * endroit — sous le pouce, et jamais coupée par la carte qui porte le mot.
 */
export function Term({ k, children }: { k: GlossaryKey; children: ReactNode }) {
  const glossary = useGlossary();
  const open = useOpenTerm();
  if (!glossary?.[k]) return <>{children}</>;
  return (
    <button
      type="button"
      className="term"
      aria-expanded={open === k}
      aria-controls="term-sheet"
      onClick={() => toggleTerm(k)}
    >
      {children}
    </button>
  );
}

/**
 * Un texte venu de l'API, ses mots techniques soulignés à leur première
 * occurrence — ceux qu'on lui demande de souligner, et ceux-là seulement :
 * « fatigue » est un mot du modèle dans une phrase, et une réponse du point du
 * jour dans une autre.
 */
export function Glossed({ text, terms }: { text: string; terms: GlossaryKey[] }) {
  const glossary = useGlossary();
  if (!glossary) return <>{text}</>;
  const found = terms
    .map((k) => ({ k, at: wordAt(text, glossary[k]?.term ?? '') }))
    .filter((f): f is { k: GlossaryKey; at: [number, number] } => f.at != null)
    .sort((a, b) => a.at[0] - b.at[0]);
  const parts: ReactNode[] = [];
  let from = 0;
  for (const { k, at: [start, end] } of found) {
    if (start < from) continue;
    parts.push(text.slice(from, start), <Term key={k} k={k}>{text.slice(start, end)}</Term>);
    from = end;
  }
  parts.push(text.slice(from));
  return <>{parts.map((p, i) => <Fragment key={i}>{p}</Fragment>)}</>;
}

/** Le premier emplacement du mot, entier et sans égard à la casse. */
function wordAt(text: string, word: string): [number, number] | null {
  if (!word) return null;
  const hay = text.toLocaleLowerCase('fr');
  const needle = word.toLocaleLowerCase('fr');
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1)) {
    const before = hay[i - 1] ?? ' ';
    const after = hay[i + needle.length] ?? ' ';
    if (!/\p{L}/u.test(before) && !/\p{L}/u.test(after)) return [i, i + needle.length];
  }
  return null;
}

/**
 * La définition ouverte. Un tap ailleurs la referme — sur elle, sur la page,
 * sur un autre mot qui ouvre alors la sienne ; changer de page aussi.
 */
export function TermSheet() {
  const glossary = useGlossary();
  const open = useOpenTerm();
  const path = usePathname();

  useEffect(closeTerm, [path]);
  useEffect(() => {
    if (open == null) return;
    const outside = (e: PointerEvent) => {
      if (!(e.target instanceof Element) || !e.target.closest('.term, .term-sheet')) closeTerm();
    };
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') closeTerm(); };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape);
    return () => {
      document.removeEventListener('pointerdown', outside);
      document.removeEventListener('keydown', escape);
    };
  }, [open]);

  const entry = open != null ? glossary?.[open] : undefined;
  // Toujours présente, vide quand rien n'est ouvert : une région annoncée doit
  // exister avant ce qu'elle annonce.
  return (
    <div id="term-sheet" className="term-sheet" role="note" aria-live="polite" onClick={closeTerm}>
      {entry && (
        <p>
          <strong>{entry.term}</strong> — {entry.definition}
        </p>
      )}
    </div>
  );
}
