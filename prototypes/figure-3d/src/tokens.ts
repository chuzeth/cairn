/**
 * Les couleurs des schémas, recopiées de `apps/web/app/globals.css` (la refonte
 * du 21/10) : le corps à l'encre, le côté opposé en grège, le plâtre en ocre,
 * les muscles en terracotta. Dans l'app, elles viendraient des variables CSS ;
 * le prototype les fige pour rester hors de l'app.
 */
export interface Tokens {
  bg: string;
  bgElev: string;
  bgElev2: string;
  border: string;
  borderStrong: string;
  text: string;
  textDim: string;
  textFaint: string;
  accent: string;
  near: string;
  far: string;
  muscle: string;
  cast: string;
  castInk: string;
  sling: string;
  mat: string;
}

export const LIGHT: Tokens = {
  bg: '#F7F3EC',
  bgElev: '#FBF8F3',
  bgElev2: '#EEE7DB',
  border: '#E2DACD',
  borderStrong: '#CFC5B5',
  text: '#1C1915',
  textDim: '#4A433B',
  textFaint: '#6B6359',
  accent: '#A8432A',
  near: '#3B3630',
  far: '#BDB3A4',
  muscle: '#B8452A',
  cast: '#E6D7B5',
  castInk: '#A4813F',
  sling: '#B9AE98',
  mat: '#E6DFD3',
};

export const DARK: Tokens = {
  bg: '#13110F',
  bgElev: '#1A1815',
  bgElev2: '#23201C',
  border: '#2E2A25',
  borderStrong: '#433D36',
  text: '#F1ECE3',
  textDim: '#CFC7BB',
  textFaint: '#A69D90',
  accent: '#E58A6A',
  near: '#E6DFD3',
  far: '#6B635A',
  muscle: '#E58A6A',
  cast: '#6B5D43',
  castInk: '#C9A962',
  sling: '#7A705F',
  mat: '#2C2823',
};
