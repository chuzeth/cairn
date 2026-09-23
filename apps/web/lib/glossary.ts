'use client';
import { useEffect, useSyncExternalStore } from 'react';
import { get, type Glossary, type GlossaryKey } from './api';

/**
 * Le vocabulaire de Cairn, tel que l'API le sert.
 *
 * La table vit dans `presentation.ts`, une seule fois : l'écran la demande au
 * premier mot souligné, la garde le temps de la session, et le service worker
 * la garde au-delà — un terme se définit aussi hors réseau. Tant qu'elle n'est
 * pas arrivée, les mots restent de simples mots : un soulignement qui
 * n'ouvrirait rien serait une promesse fausse.
 */

let glossary: Glossary | null = null;
let loading = false;
/** Le terme dont la définition est ouverte. Un seul à la fois. */
let open: GlossaryKey | null = null;

const listeners = new Set<() => void>();
const emit = () => listeners.forEach((l) => l());
const subscribe = (l: () => void) => {
  listeners.add(l);
  return () => { listeners.delete(l); };
};

function load() {
  if (glossary || loading) return;
  loading = true;
  get<Glossary>('/api/glossary')
    .then((g) => { glossary = g; emit(); })
    .catch(() => {})
    .finally(() => { loading = false; });
}

export function useGlossary(): Glossary | null {
  const g = useSyncExternalStore(subscribe, () => glossary, () => null);
  useEffect(load, []);
  return g;
}

export const useOpenTerm = (): GlossaryKey | null => useSyncExternalStore(subscribe, () => open, () => null);

export function toggleTerm(key: GlossaryKey) {
  open = open === key ? null : key;
  emit();
}

export function closeTerm() {
  if (open == null) return;
  open = null;
  emit();
}
