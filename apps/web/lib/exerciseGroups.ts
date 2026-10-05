import type { ExerciseKey } from '@cairn/core/exercises';

/**
 * L'ordre de la page Exercices : les séances de la semaine d'abord, dans
 * l'ordre où elles se font, puis la marche, le quotidien, et la salle qui
 * reprend ensuite. Chaque fiche n'y paraît qu'une fois — c'est son ancre que
 * les séances visent (« comment faire ») — dans la première séance qui la fait.
 */
export const EXERCISE_GROUPS: { title: string; lead: string; keys: ExerciseKey[] }[] = [
  {
    title: 'Force A, à la maison',
    lead: 'Les jambes et le bras libre : un élastique à la porte, une marche, le canapé, une serviette.',
    keys: [
      'echauffement-maison', 'split-squat-maison', 'leg-curl-serviette', 'mollets-excentriques', 'pont-une-jambe',
      'tirage-elastique', 'bras-elastique', 'anti-rotation',
    ],
  },
  {
    title: 'Force B, à la maison',
    lead: 'Les appuis : une marche et sa rampe, une mini-bande, un mur, un encadrement de porte.',
    keys: ['descente-marche', 'souleve-une-jambe', 'chaise', 'pas-chasses', 'montee-genou', 'releves-pointe', 'gainage-lateral'],
  },
  {
    title: 'Marcher',
    lead: 'Les jours sans force, et la sortie longue devenue marche.',
    keys: ['marche', 'marche-cote', 'marche-tapis'],
  },
  {
    title: 'Chaque jour',
    lead: 'Le bras plâtré, la respiration, la souplesse : quelques minutes, tous les jours.',
    keys: ['soins-bras', 'respiration', 'souplesse'],
  },
  {
    title: 'Force A, à la salle',
    lead: 'Quand la salle reprend : machines, et l’haltère dans la main libre.',
    keys: ['activation', 'presse', 'split-squat-bulgare', 'extension-hanche', 'leg-curl', 'mollets-machine', 'bras-libre'],
  },
  {
    title: 'Force B, à la salle',
    lead: 'Les appuis de la maison, avec un banc et un haltère.',
    keys: ['step-up', 'abduction', 'dead-bug'],
  },
  {
    title: 'Cardio sans impact',
    lead: 'Le fractionné de la semaine, sans courir et sans les bras.',
    keys: ['intervalles'],
  },
];
