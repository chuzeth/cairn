import { describe, expect, it } from 'vitest';
import { GLOSSARY } from '@cairn/coach';
import { interpretAcwr, interpretTsb } from '@cairn/physiology';
import { LOAD_WORDS, loadFigures, plainWord } from '../apps/web/lib/figures';
import { markdown, nbsp } from '../apps/web/lib/api';
import type { StateResponse } from '../apps/web/lib/api';

/**
 * Le tableau de bord gardait tout le jargon que l'écran du matin avait quitté :
 * CTL, ATL, TSB, « charge aiguë / chronique », « +1,2 pts/semaine ». Les deux
 * écrans lisent désormais la même table ; ce qui se vérifie ici, c'est qu'elle
 * parle comme `presentation.ts` à toutes les valeurs que le modèle peut rendre.
 */

const JARGON = /\b(CTL|ATL|TSB|ACWR|pts|aigu[eë]?|chronique|ratio)\b/i;

function today(tsb: number, acwr: number): StateResponse['today'] {
  const a = interpretAcwr(acwr);
  return {
    date: '2026-09-24', ctl: 35.4, atl: 32.1, tsb, mechanicalTsb: -3, acwr, rampRate: 1.2, monotony: 1.1,
    tsbLabel: interpretTsb(tsb).label, acwrLabel: a.label, acwrRisk: a.risk,
  };
}

describe('Les chiffres de charge se disent dans les mots de l’athlète', () => {
  it('nomme chaque chiffre sans sigle, et le fait suivre de ce qu’il dit', () => {
    for (const tsb of [25, 10, 0, -20, -40]) {
      for (const acwr of [0, 0.6, 1, 1.4, 2]) {
        for (const f of loadFigures(today(tsb, acwr))) {
          expect(plainWord(f), f.key).not.toMatch(JARGON);
          expect(f.note, `${f.key} à ${tsb} / ${acwr}`).not.toMatch(JARGON);
          expect(f.note.trim(), f.key).not.toBe('');
          expect(f.value, f.key).toMatch(/\d/);
        }
      }
    }
  });

  it('écrit la progression en points par semaine, en toutes lettres', () => {
    const [forme] = loadFigures(today(0, 1));
    expect(forme!.note).toBe('+1,2 point par semaine');
  });

  it('prend ses mots au vocabulaire, qui les définit d’un tap', () => {
    for (const w of Object.values(LOAD_WORDS)) {
      if ('term' in w) expect(w.word).toBe(GLOSSARY[w.term].term);
    }
  });
});

describe('Aucun mot seul sur sa ligne, aucune colonne sans son nom', () => {
  it('lie le dernier mot d’une phrase au précédent', () => {
    expect(nbsp('ou décale si les sensations ne viennent pas à l’échauffement.')).toMatch(/à l’échauffement\.$/);
    expect(nbsp('Vigilance')).toBe('Vigilance');
  });

  it('donne à chaque case d’un tableau du coach le titre de sa colonne', () => {
    const html = markdown('| Tronçon | Allure |\n|---|---|\n| km 0–5 | 6:43 |');
    expect(html).toContain('<td data-label="Tronçon">km 0–5</td>');
    expect(html).toContain('<td data-label="Allure">6:43</td>');
  });
});
