import type { ExerciseKey } from '@cairn/core/exercises';

/**
 * L'ordre de la page Exercices : ce que le bloc de force travaille, partie par
 * partie, puis la marche, le quotidien, et la salle qui reprendra ensuite.
 * Chaque fiche n'y paraît qu'une fois — c'est son ancre que les séances visent
 * (« comment faire ») —, là où elle sert le plus.
 *
 * Le 09/10, le bloc devient quotidien : les séances ne portent plus chacune
 * leurs exercices (la flexion sur serviette sert le lundi et le vendredi), la
 * page se range donc par ce qu'elle entraîne.
 */
export const EXERCISE_GROUPS: { title: string; lead: string; keys: ExerciseKey[] }[] = [
  {
    title: 'Les tests',
    lead: 'Le 9 octobre et le 1er novembre : sept mesures, les mêmes, à la même heure.',
    keys: ['test-mollets', 'test-pont', 'test-chaise', 'test-gainage', 'test-equilibre', 'test-cheville', 'test-souplesse'],
  },
  {
    title: 'Cuisses et genoux',
    lead: 'Le quadriceps qui pousse en montée et freine en descente : l’échauffement, puis le step, le mur, le tapis.',
    keys: [
      'echauffement-maison', 'split-squat-maison', 'squat-une-jambe', 'descente-marche', 'reverse-nordic',
      'montee-tabouret', 'fente-arriere', 'chaise', 'chaise-une-jambe',
    ],
  },
  {
    title: 'Hanches et arrière des cuisses',
    lead: 'Les fessiers et les ischio-jambiers, le moteur des montées ; les adducteurs et le moyen fessier, qui tiennent le bassin.',
    keys: [
      'souleve-une-jambe', 'hip-thrust', 'leg-curl-serviette', 'pont-une-jambe', 'pas-chasses', 'copenhague',
      'adducteurs-coussin', 'montee-genou',
    ],
  },
  {
    title: 'Mollets, chevilles, pieds',
    lead: 'Le tendon d’Achille et le pied, qui encaissent chaque foulée : ce qu’un arrêt de course déconditionne en premier.',
    keys: [
      'mollets-charges', 'soleaire-assis', 'mollets-iso', 'mollets-excentriques', 'mollets-sol', 'releves-pointe',
      'cheville-mobilite', 'pied-court', 'equilibre',
    ],
  },
  {
    title: 'Le tronc',
    lead: 'Il ne se creuse pas, ne tourne pas, ne s’affaisse pas : le gainage, sans jamais s’appuyer sur le bras plâtré.',
    keys: ['dead-bug', 'gainage-lateral', 'anti-rotation', 'port-valise'],
  },
  {
    title: 'Le bras valide',
    lead: 'Le kit d’élastiques à la porte, l’anneau, une table : le bras qui travaille entretient celui qui est plâtré.',
    keys: ['tirage-elastique', 'pousse-elastique', 'bras-elastique'],
  },
  {
    title: 'Marcher et monter',
    lead: 'La longue marche du samedi, le fractionné dans les escaliers, la marche des jours calmes.',
    keys: ['marche-cote', 'marche', 'marche-tapis'],
  },
  {
    title: 'Chaque jour',
    lead: 'Le bras plâtré, la respiration, la souplesse : quelques minutes, tous les jours.',
    keys: ['soins-bras', 'imagerie', 'respiration', 'souplesse'],
  },
  {
    title: 'À la salle, plus tard',
    lead: 'Quand la salle reprendra : machines, un banc, l’haltère dans la main libre.',
    keys: [
      'activation', 'presse', 'split-squat-bulgare', 'extension-hanche', 'leg-curl', 'mollets-machine', 'bras-libre',
      'step-up', 'abduction', 'intervalles',
    ],
  },
];
