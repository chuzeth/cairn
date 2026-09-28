import { num, signed } from './api';
import type { GlossaryKey, StateResponse } from './api';

/**
 * Les chiffres de charge, nommés par ce qu'ils veulent dire.
 *
 * Une table, lue par l'écran du matin et par le tableau de bord : deux noms
 * pour la même chose, et c'est deux chiffres qu'on croit lire. Aucun sigle —
 * CTL, ATL, TSB, ratio aigu/chronique restent au coach et à l'écran de
 * physiologie. Le mot qui porte le chiffre est celui du vocabulaire de
 * `presentation.ts`, et se définit d'un tap ; ce qui le suit le précise.
 */
export interface LoadWord {
  /** Le mot du vocabulaire, s'il en est un. */
  term?: GlossaryKey;
  /** Ce qui s'écrit : le mot, puis ce qui le précise. */
  word: string;
  after?: string;
}

export const LOAD_WORDS = {
  ctl: { term: 'forme', word: 'Forme de fond' },
  atl: { term: 'fatigue', word: 'Fatigue' },
  tsb: { term: 'fraicheur', word: 'Fraîcheur' },
  mechanicalTsb: { term: 'fraicheur', word: 'Fraîcheur', after: ' des jambes' },
  acwr: { word: 'Ces 7 jours, contre tes 4 dernières semaines' },
} as const satisfies Record<string, LoadWord>;

/** Le nom entier, en texte : pour une légende de survol, une info-bulle. */
export const plainWord = (w: LoadWord): string => `${w.word}${w.after ?? ''}`;

export interface LoadFigure extends LoadWord {
  /** La fatigue ne s'affiche pas seule : elle n'a de sens que retranchée de la forme, dans la fraîcheur. */
  key: Exclude<keyof typeof LOAD_WORDS, 'atl'>;
  value: string;
  /** Ce que le chiffre dit, en une ligne : un chiffre sans elle ne veut rien dire. */
  note: string;
}

/** Les quatre chiffres du jour, chacun avec sa phrase. */
export function loadFigures(t: StateResponse['today']): LoadFigure[] {
  const perWeek = `${signed(t.rampRate, 1)} point${Math.abs(t.rampRate) >= 2 ? 's' : ''} par semaine`;
  return [
    { key: 'ctl', ...LOAD_WORDS.ctl, value: num(t.ctl), note: perWeek },
    { key: 'tsb', ...LOAD_WORDS.tsb, value: signed(t.tsb), note: t.tsbLabel },
    { key: 'mechanicalTsb', ...LOAD_WORDS.mechanicalTsb, value: signed(t.mechanicalTsb), note: 'ce que la descente a abîmé' },
    { key: 'acwr', ...LOAD_WORDS.acwr, value: num(t.acwr, 2), note: t.acwrLabel },
  ];
}
