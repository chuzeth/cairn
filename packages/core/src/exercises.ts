/**
 * Les fiches d'exercices : comment faire, et comment le faire avec un plâtre.
 *
 * Le 03/10, Pierre se casse le coude en vélo : plâtre ou attelle rigide, plus de
 * course pour quelques semaines. Ses séances deviennent du renforcement, de la
 * marche en côte et du cardio sans bras ; chaque exercice d'une séance renvoie
 * à sa fiche (`SessionBlock.exercise`), et l'écran la montre avec son schéma.
 *
 * Une fiche dit en clair ce qu'on fait, ce qu'on doit sentir, ce qui se fait
 * mal, et ce que le bras plâtré change. Rien n'y demande d'appui sur ce bras,
 * ni de prise à deux mains : c'est la condition pour qu'une fiche existe ici.
 */

export const EXERCISE_KEYS = [
  'activation', 'presse', 'split-squat-bulgare', 'extension-hanche', 'leg-curl', 'mollets-machine',
  'bras-libre', 'anti-rotation', 'step-up', 'pont-une-jambe', 'chaise', 'mollets-excentriques',
  'releves-pointe', 'abduction', 'dead-bug', 'gainage-lateral', 'marche-tapis', 'intervalles',
  'marche-cote', 'soins-bras', 'respiration', 'souplesse',
  // La semaine du 05/10 à la maison : un élastique, une mini-bande, un tapis.
  'echauffement-maison', 'split-squat-maison', 'leg-curl-serviette', 'tirage-elastique', 'bras-elastique',
  'descente-marche', 'souleve-une-jambe', 'pas-chasses', 'montee-genou', 'marche',
  // Le matériel reçu le 06/10 : le kit d'élastiques, les mini-bandes, l'anneau, le tapis, un tabouret de 40 cm.
  'montee-tabouret', 'mollets-sol',
  // Le bloc de force du 09/10 au 01/11 : tous les jours, au poids du corps, à l'élastique, sur le step.
  'reverse-nordic', 'pousse-elastique', 'hip-thrust', 'copenhague', 'adducteurs-coussin',
  'mollets-iso', 'pied-court', 'equilibre', 'imagerie', 'chaise-une-jambe',
  // Les tests du premier et du dernier jour, un par étape de la séance.
  'test-mollets', 'test-pont', 'test-chaise', 'test-gainage', 'test-equilibre', 'test-cheville', 'test-souplesse',
] as const;

export type ExerciseKey = (typeof EXERCISE_KEYS)[number];

export const isExerciseKey = (key: string): key is ExerciseKey => (EXERCISE_KEYS as readonly string[]).includes(key);

export interface ExerciseSheet {
  key: ExerciseKey;
  name: string;
  /**
   * Le mouvement en une phrase, sans jargon : ce qu'on fait, vu de l'extérieur.
   * Le 05/10, Pierre : « une fente, en quoi ça consiste ? Tout ne doit pas être
   * pris pour acquis. »
   */
  what: string;
  /** Où il se fait. */
  where: ('salle' | 'maison' | 'dehors')[];
  /** Ce qu'il faut sous la main. */
  equipment: string;
  /** Pourquoi, pour un traileur qui ne peut pas courir. */
  why: string;
  /** L'installation, avant la première répétition. */
  setup?: string[];
  /** Les étapes, dans l'ordre où on les fait. */
  steps: string[];
  /** Quand inspirer, quand souffler. */
  breath?: string;
  /** Ce qu'on doit sentir : le repère qui dit que c'est juste. */
  feel: string;
  /** Les erreurs qui reviennent. */
  mistakes: string[];
  /** Trop dur, ou une gêne : la version qui garde le geste. */
  easier?: string;
  /** Plus de réserve que prévu deux séances de suite : la suite. */
  harder?: string;
  /** Ce que le bras plâtré change. */
  cast: string;
  /**
   * Ce qu'il faut avoir en tête en le faisant : deux à quatre consignes courtes.
   *
   * Le 09/10, Pierre : la fiche « comment faire », « il y a trop
   * d'informations ». La séance montre ces consignes sous le schéma, à suivre
   * pendant l'effort ; le reste de la fiche se déplie pour qui le demande.
   */
  cues: string[];
  /** Un test : ce qu'il mesure, et comment le noter. */
  measure?: TestMeasure;
}

/** Ce qu'un test mesure. */
export interface TestMeasure {
  unit: 'répétitions' | 'secondes' | 'cm';
  /** Une valeur par jambe, ou une seule. */
  perSide: boolean;
  /** Le plafond du test : 60 s pour l'équilibre. */
  max?: number;
  /** Ce qui aide à le faire : le chrono qui compte, ou le bip qui donne le rythme. */
  guide?: 'chrono' | 'métronome';
  /** Le rythme du métronome, s entre deux bips. */
  beatS?: number;
  /** D'où l'on part, quand une étude le dit. */
  reference?: string;
}

export const EXERCISES: Record<ExerciseKey, ExerciseSheet> = {
  activation: {
    key: 'activation',
    name: 'Réveil des muscles (activation)',
    what: 'Trois mouvements faciles avant de forcer : des ponts, des fentes arrière et des montées sur la pointe des pieds.',
    cues: [
      '10 ponts fessiers, 1 s serrée en haut.',
      '8 fentes arrière par jambe, la main libre au mur.',
      '10 montées sur la pointe des pieds, lentes.',
    ],
    where: ['salle', 'maison'],
    equipment: 'Rien',
    why: 'Réveiller les fessiers et les chevilles avant de charger : les premières séries se font avec des muscles prêts.',
    steps: [
      '10 ponts fessiers au sol, dos à plat, en serrant les fessiers en haut.',
      '8 fentes arrière par jambe, la main libre posée au mur.',
      '10 montées sur la pointe des pieds, lentes.',
    ],
    feel: 'Chaud dans les fessiers et les mollets, pas encore fatigué.',
    mistakes: ['Le faire vite, pour en finir : c\'est la qualité du mouvement qui réveille.'],
    cast: 'La main libre au mur pour les fentes ; le bras plâtré contre toi.',
  },
  presse: {
    key: 'presse',
    name: 'Presse à cuisses',
    what: 'Assis dans la machine, le dos calé, tu repousses avec les pieds une plateforme chargée, puis tu la laisses revenir lentement.',
    cues: [
      'Dos et bassin calés, pieds à plat au milieu du plateau.',
      'Descends en 3 s jusqu\'aux genoux à angle droit.',
      'Pousse dans les talons, sans verrouiller les genoux.',
      'Seule la main libre touche la machine.',
    ],
    where: ['salle'],
    equipment: 'Presse à cuisses, inclinée ou horizontale',
    why:
      'La force maximale des jambes, sans équilibre à gérer : c\'est elle qui rend chaque foulée moins coûteuse ' +
      'quand tu recourras.',
    steps: [
      'Assieds-toi dos et bassin calés, pieds à plat au milieu du plateau, écartés de la largeur des hanches.',
      'Déverrouille avec la main libre ; le bras plâtré reste contre ton ventre.',
      'Descends en 3 secondes, jusqu\'à des genoux à angle droit.',
      'Pousse en 1 seconde à travers les talons, sans verrouiller les genoux en haut.',
    ],
    feel: 'Les cuisses et les fessiers travaillent ; le bas du dos reste collé au dossier.',
    mistakes: [
      'Descendre jusqu\'à décoller le bassin du siège.',
      'Laisser les genoux rentrer vers l\'intérieur.',
      'Verrouiller les genoux en haut.',
    ],
    cast: 'Seule la main libre touche la machine, pour régler et déverrouiller. Le bras plâtré reste contre toi.',
  },
  'split-squat-bulgare': {
    key: 'split-squat-bulgare',
    name: 'Fente bulgare, pied arrière sur un banc',
    what: 'Une fente sur une seule jambe : le pied arrière posé sur un banc, tu descends le genou arrière vers le sol en pliant la jambe avant, puis tu remontes.',
    cues: [
      'Le dessus du pied arrière sur le banc, un support pour la main libre.',
      'Descends en 3 s, le genou arrière vers le sol.',
      'Remonte en poussant dans le talon avant.',
    ],
    where: ['salle', 'maison'],
    equipment: 'Un banc ou une chaise stable ; un haltère pour la main libre, à partir de la 2e semaine',
    why: 'Une jambe à la fois, comme en course : quadriceps, fessiers, et la stabilité du genou et de la hanche.',
    steps: [
      'Dos au banc, fais un grand pas devant ; pose le dessus du pied arrière sur le banc.',
      'Semaine 1 : sans charge, main libre sur un support stable. Ensuite : l\'haltère dans la main libre, le support à portée.',
      'Descends en 3 secondes, genou arrière vers le sol, buste légèrement penché en avant.',
      'Remonte en poussant sur le talon de la jambe avant.',
    ],
    feel: 'La cuisse et le fessier de la jambe avant ; la jambe arrière ne fait que poser.',
    mistakes: [
      'Le genou avant qui part vers l\'intérieur.',
      'Le pied avant trop près du banc : le talon décolle.',
      'Rebondir en bas.',
    ],
    cast:
      'Toujours à côté d\'un support pour la main libre. Si l\'équilibre part, lâche l\'haltère et rattrape-toi avec ' +
      'la main libre — jamais avec le bras plâtré.',
  },
  'extension-hanche': {
    key: 'extension-hanche',
    name: 'Redressement du buste au banc à 45°',
    what: 'Les hanches calées sur le coussin d\'un banc incliné, tu penches le buste vers le sol, puis tu te redresses jusqu\'à aligner tout le corps.',
    cues: [
      'Le coussin juste sous l\'os du bassin, les bras croisés.',
      'Bascule le buste vers le sol, le dos droit.',
      'Remonte en serrant les fessiers, jusqu\'au corps aligné, pas au-delà.',
    ],
    where: ['salle'],
    equipment: 'Banc à lombaires incliné à 45°',
    why:
      'Fessiers et ischio-jambiers ensemble : la chaîne postérieure, qui te propulse en montée et tient ton dos ' +
      'en descente.',
    steps: [
      'Règle le coussin juste sous l\'os du bassin, chevilles calées.',
      'Croise les bras sur la poitrine, le bras plâtré dessous.',
      'Bascule en avant depuis les hanches, dos droit, jusqu\'à sentir l\'arrière des cuisses s\'étirer.',
      'Remonte en serrant les fessiers jusqu\'à l\'alignement du corps, pas au-delà.',
    ],
    feel: 'L\'effort est dans les fessiers et l\'arrière des cuisses, pas dans le bas du dos.',
    mistakes: ['Arrondir le dos en descendant.', 'Se cambrer en haut.', 'Aller vite.'],
    cast: 'Monter sur le banc et en descendre demande un appui : prends-le avec la main libre.',
  },
  'leg-curl': {
    key: 'leg-curl',
    name: 'Flexion des jambes à la machine (leg curl)',
    what: 'Assis dans la machine, tu ramènes les talons sous le siège contre un rouleau, puis tu le laisses revenir lentement.',
    cues: [
      'Le genou aligné avec l\'axe de la machine.',
      'Ramène les talons en 1 s, freine le retour en 3 s.',
    ],
    where: ['salle'],
    equipment: 'Machine leg curl assise',
    why:
      'Les ischio-jambiers freinent la jambe à chaque foulée, et c\'est là qu\'ils se blessent : la descente lente ' +
      'les y prépare.',
    steps: [
      'Assieds-toi, genoux alignés avec l\'axe de la machine, le rouleau juste au-dessus des talons.',
      'Fléchis les genoux en 1 seconde.',
      'Freine le retour en 3 secondes.',
    ],
    feel: 'L\'arrière des cuisses, surtout pendant le retour.',
    mistakes: ['Décoller les fesses du siège.', 'Laisser retomber la charge.'],
    cast: 'Règle la machine avec la main libre, et ne tiens que la poignée de ce côté.',
  },
  'mollets-machine': {
    key: 'mollets-machine',
    name: 'Mollets à la machine',
    what: 'Assis, les genoux sous un coussin chargé, tu montes sur la pointe des pieds, puis tu redescends lentement.',
    cues: [
      'L\'avant du pied sur la marche, les talons dans le vide.',
      'Monte en 1 s, redescends en 3 s, 1 s étiré en bas.',
    ],
    where: ['salle'],
    equipment: 'Machine à mollets, assise de préférence',
    why:
      'Le mollet et le tendon d\'Achille encaissent plusieurs fois ton poids à chaque foulée : sans course, ils ' +
      'perdent vite cette tolérance, et c\'est elle qui manque à la reprise.',
    steps: [
      'L\'avant du pied sur la marche, talons dans le vide.',
      'Monte sur la pointe en 1 seconde.',
      'Redescends en 3 secondes, talons sous la marche.',
      'Tiens 1 seconde en bas, étiré.',
    ],
    feel: 'La brûlure dans le mollet, l\'étirement du tendon en bas.',
    mistakes: ['Rebondir en bas.', 'Ne monter qu\'à moitié.'],
    cast: 'La machine assise ne demande rien aux bras. Debout, la main libre sur la poignée.',
  },
  'bras-libre': {
    key: 'bras-libre',
    name: 'Bras valide à l\'haltère : pousser, tirer, plier',
    what: 'Trois mouvements pour le bras valide, un haltère en main : pousser au-dessus de la tête, tirer vers soi, plier le coude.',
    cues: [
      'Développé : de l\'épaule au-dessus de la tête, 2 s pour redescendre.',
      'Tirage : la poignée vers le flanc, l\'omoplate serrée.',
      'Curl : le coude au corps, 1 s pour monter, 2 s pour redescendre.',
    ],
    where: ['salle', 'maison'],
    equipment: 'Haltère, poulie ou élastique',
    why:
      'Entraîner le bras sain entretient la force du bras plâtré : le cerveau transfère une partie du travail. ' +
      'Après une fracture du poignet, ce travail a donné un bras blessé plus fort et plus mobile à 12 semaines ' +
      '(Magnus et al., 2013).',
    steps: [
      'Développé : assis dos calé, l\'haltère à hauteur d\'épaule, pousse au-dessus de la tête, redescends en 2 secondes.',
      'Tirage : poulie ou élastique à hauteur de poitrine, tire la poignée vers ton flanc en serrant l\'omoplate.',
      'Curl : coude au corps, monte l\'haltère en 1 seconde, redescends en 2 secondes.',
    ],
    feel: 'L\'épaule, le dos, le biceps du bras libre ; rien dans l\'autre bras.',
    mistakes: ['Se cambrer pendant le développé.', 'Tourner le buste pendant le tirage.'],
    cast: 'Uniquement le bras libre. Le bras plâtré ne porte rien et ne pousse rien.',
  },

  'anti-rotation': {
    key: 'anti-rotation',
    name: 'Gainage anti-rotation à l\'élastique',
    what: 'De profil à la porte, tu tends le bras devant toi en tenant l\'élastique : il tire ton buste vers la porte, et tu l\'empêches de tourner.',
    cues: [
      'De profil à la porte, la poignée contre la poitrine, l\'élastique déjà tendu.',
      'Tends le bras devant toi en 2 s, tiens 3 s, reviens en 2 s.',
      'Le buste ne tourne pas. Pour l\'autre côté, tourne-toi.',
    ],
    where: ['maison', 'salle'],
    equipment: 'Le kit d\'élastiques (un élastique de 6 ou 7 kg, une poignée, l\'accroche de porte) ; une poulie à la salle',
    why:
      'Le gainage qui sert en trail : empêcher le buste de tourner pendant qu\'une jambe pousse — sans aucun appui ' +
      'sur les bras. On l\'appelle aussi le « Pallof », du nom du kiné qui l\'a décrit.',
    setup: [
      'L\'accroche à hauteur de poitrine, dans la porte fermée, côté charnières.',
      'De profil à la porte, à un grand pas : l\'élastique est déjà tendu quand la poignée est contre ta poitrine.',
      'Pieds écartés de la largeur des épaules, genoux un peu fléchis.',
    ],
    steps: [
      'La main valide tient la poignée contre la poitrine.',
      'Tends le bras droit devant toi en 2 secondes : l\'élastique tire vers la porte, ton buste ne tourne pas.',
      'Tiens 3 secondes, puis ramène la poignée en 2 secondes.',
      'Pour l\'autre côté, tourne-toi : la porte est alors de l\'autre côté, et c\'est toujours la main valide qui tient.',
    ],
    breath: 'Souffle en tendant le bras, respire normalement pendant le maintien.',
    feel: 'Les abdominaux, surtout du côté opposé à la porte.',
    mistakes: ['Laisser les hanches tourner.', 'Hausser l\'épaule.'],
    easier: 'Un pas plus près de la porte.',
    harder: 'Un pas plus loin, ou 5 secondes bras tendu.',
    cast: 'Le bras plâtré reste contre toi. Une seule main, mais les deux côtés : c\'est ton orientation qui change.',
  },
  'step-up': {
    key: 'step-up',
    name: 'Montée sur un banc',
    what: 'Un pied sur un banc, tu montes dessus en poussant sur cette jambe, puis tu redescends en freinant.',
    cues: [
      'Tout le pied sur le banc.',
      'Monte en poussant dans le talon du haut : la jambe du bas ne pousse pas.',
      'Redescends en 3 s.',
    ],
    where: ['salle', 'maison'],
    equipment: 'Un banc, une box ou une marche solide à hauteur de genou',
    why:
      'Monter, et surtout redescendre lentement : la force des montées, et la tolérance des quadriceps aux ' +
      'descentes.',
    steps: [
      'Pose tout le pied sur le banc.',
      'Pousse sur le talon du haut jusqu\'à être debout, sans t\'aider de la jambe du bas.',
      'Redescends en 3 secondes, en contrôlant.',
    ],
    feel: 'La cuisse et le fessier de la jambe posée sur le banc.',
    mistakes: ['Pousser avec la jambe du bas.', 'Laisser le genou rentrer vers l\'intérieur.'],
    cast: 'Hauteur modérée, un support à portée de la main libre. Semaine 1 sans charge, ensuite l\'haltère dans la main libre.',
  },
  'pont-une-jambe': {
    key: 'pont-une-jambe',
    name: 'Pont fessier sur une jambe',
    what: 'Allongé sur le dos, un pied au sol et l\'autre jambe tendue en l\'air, tu soulèves le bassin en poussant dans le talon.',
    cues: [
      'Sur le dos, le talon d\'appui à 30 cm des fesses, l\'autre jambe tendue.',
      'Monte le bassin jusqu\'à aligner l\'épaule, la hanche et le genou.',
      '2 s serrées en haut, 2 s pour redescendre.',
    ],
    where: ['maison', 'salle'],
    equipment: 'Un tapis',
    why: 'Le fessier, moteur des montées et stabilisateur du bassin à chaque appui.',
    setup: [
      'Sur le dos sur le tapis, genoux fléchis, pieds à plat à la largeur des hanches.',
      'Le talon d\'appui à 30 cm des fesses : en haut, le genou fait un angle droit.',
    ],
    steps: [
      'Tends une jambe dans le prolongement de la cuisse.',
      'Pousse dans le talon au sol et monte le bassin jusqu\'à aligner épaule, hanche et genou.',
      'Tiens 2 secondes en haut en serrant la fesse, redescends en 2 secondes.',
      'Toutes les répétitions d\'une jambe, puis l\'autre.',
    ],
    breath: 'Souffle en montant.',
    feel: 'Le fessier de la jambe au sol, pas le bas du dos ni l\'arrière de la cuisse.',
    mistakes: [
      'Cambrer le dos en haut : le haut, c\'est l\'alignement, pas plus.',
      'Laisser le bassin pencher du côté de la jambe tendue.',
      'Pousser sur les orteils : c\'est le talon.',
    ],
    easier: 'Les deux pieds au sol.',
    harder: 'Les épaules sur le bord du canapé, le bassin descend plus bas ; puis 3 secondes tenues en haut.',
    cast: 'Le bras plâtré posé sur ton ventre ou le long du corps, sans t\'y appuyer.',
  },
  chaise: {
    key: 'chaise',
    name: 'Chaise contre le mur',
    what: 'Le dos contre un mur, tu descends comme pour t\'asseoir sur une chaise invisible, et tu tiens.',
    cues: [
      'Dos au mur, les pieds à 40 cm devant.',
      'Descends jusqu\'aux cuisses parallèles au sol, les genoux au-dessus des chevilles.',
      'Respire tout du long ; les mains ne poussent pas sur les cuisses.',
    ],
    where: ['maison', 'salle'],
    equipment: 'Un mur',
    why:
      'Un effort des quadriceps sans mouvement : tenu près de son maximum, il entretient la force et la raideur du ' +
      'tendon rotulien, qui encaisse les descentes, sans rien lui demander d\'autre.',
    setup: ['Dos contre le mur, pieds à la largeur des hanches, à 40 cm devant.'],
    steps: [
      'Glisse le dos le long du mur jusqu\'à des cuisses parallèles au sol, genoux à angle droit — moins bas au début.',
      'Les genoux restent au-dessus des chevilles.',
      'Tiens le temps prescrit.',
      'Remonte en glissant, la main libre sur la cuisse.',
    ],
    breath: 'Calme et régulière, du début à la fin : ne bloque jamais.',
    feel: 'Les cuisses brûlent ; le dos reste à plat contre le mur.',
    mistakes: ['Bloquer sa respiration.', 'Laisser les genoux dépasser les pointes de pied.', 'Pousser sur le mur avec les mains.'],
    easier: 'Moins bas, genoux à 120°.',
    harder: '15 secondes de plus ; puis sur une jambe, l\'autre pied levé de 5 cm, 20 à 30 secondes chacune.',
    cast: 'Rien à tenir : le bras plâtré contre toi.',
  },
  'mollets-excentriques': {
    key: 'mollets-excentriques',
    name: 'Mollets en descente lente, sur le step',
    what: 'Sur le bord du step, tu montes sur la pointe des deux pieds, puis tu redescends sur un seul, lentement, le talon sous le step.',
    cues: [
      'Sur le bord du step calé contre un mur, les talons dans le vide, la main valide au mur.',
      'Monte sur les deux pointes, puis passe sur une jambe.',
      'Redescends en 3 s sur cette jambe, jusqu\'au talon sous le step.',
    ],
    where: ['maison', 'salle'],
    equipment: 'Le step à 20 cm contre un mur, ou une marche d\'escalier avec sa rampe',
    why:
      'La descente lente sur une jambe renforce le tendon d\'Achille et le mollet, qui encaissent chaque foulée : ' +
      'c\'est le protocole qui soigne et prévient ses tendinopathies (Alfredson). Trois semaines sans courir les ' +
      'déchargent ; c\'est lui qui les garde prêts.',
    setup: [
      'Le step contre un mur. L\'avant des deux pieds sur le bord, talons dans le vide, la main valide au mur.',
      'Genou tendu pour le mollet ; genou fléchi de 20 à 30° pour le soléaire, le muscle profond qui porte le plus en course.',
    ],
    steps: [
      'Monte sur les deux pointes, en 1 seconde.',
      'Passe sur une jambe : soulève l\'autre pied.',
      'Redescends en 3 secondes, jusqu\'au talon nettement sous le step.',
      'Repose l\'autre pied et remonte sur les deux.',
    ],
    breath: 'Souffle en montant, inspire pendant la descente.',
    feel: 'Le mollet de la jambe qui descend, et un étirement franc en bas.',
    mistakes: [
      'Descendre vite : les 3 secondes sont l\'exercice.',
      'Remonter sur une seule jambe : c\'est la descente qui compte.',
      'Laisser la cheville partir vers l\'extérieur : le poids reste sous le gros orteil.',
    ],
    easier: 'Descente sur les deux pieds.',
    harder: '5 secondes de descente ; puis un sac à dos chargé.',
    cast: 'La main valide au mur, toujours : un faux pas sur un step se rattrape avec elle.',
  },
  'releves-pointe': {
    key: 'releves-pointe',
    name: 'Relevés de pointe',
    what: 'Dos au mur, talons au sol, tu lèves l\'avant des pieds le plus haut possible, puis tu les reposes.',
    cues: [
      'Dos et fesses au mur, les talons à 30 cm devant.',
      'Lève les pointes le plus haut possible en 1 s, les talons au sol.',
      'Redescends en 2 s.',
    ],
    where: ['maison', 'salle'],
    equipment: 'Un mur',
    why: 'Le muscle devant le tibia freine chaque pose du pied en descente, et protège des douleurs au tibia.',
    setup: ['Dos et fesses contre le mur, talons à 30 cm devant, jambes tendues.'],
    steps: [
      'Lève les pointes de pied le plus haut possible, talons au sol, en 1 seconde.',
      'Redescends en 2 secondes, sans poser tout le poids.',
    ],
    breath: 'Libre.',
    feel: 'Le devant du tibia brûle vite : c\'est normal.',
    mistakes: ['Plier les genoux pour tricher.', 'Décoller les fesses du mur.'],
    easier: 'Talons plus près du mur.',
    harder: 'Talons plus loin du mur ; puis un pied à la fois.',
    cast: 'Rien à tenir.',
  },
  abduction: {
    key: 'abduction',
    name: 'Jambe écartée sur le côté (abduction)',
    what: 'Debout face au mur, une mini-bande autour des chevilles, tu écartes une jambe sur le côté, puis tu la ramènes.',
    cues: [
      'Face au mur, la main libre dessus, la mini-bande aux chevilles.',
      'Écarte la jambe de 30 cm, la pointe vers l\'avant, le buste droit.',
      'Reviens lentement.',
    ],
    where: ['maison', 'salle'],
    equipment: 'Une mini-bande autour des chevilles',
    why:
      'Le moyen fessier tient le bassin à l\'horizontale à chaque appui : faible, il laisse le genou rentrer et la ' +
      'hanche s\'affaisser.',
    steps: [
      'Face au mur, la main libre posée dessus à hauteur de poitrine, la bande autour des chevilles.',
      'Debout sur une jambe, genou légèrement fléchi.',
      'Écarte l\'autre jambe de 30 cm sur le côté, pointe de pied vers l\'avant, sans pencher le buste.',
      'Reviens lentement. Toutes les répétitions d\'un côté, puis l\'autre.',
    ],
    feel: 'Le côté de la fesse — des deux côtés : celle qui bouge et celle qui tient.',
    mistakes: ['Pencher le buste pour monter plus haut.', 'Tourner le pied vers le haut.'],
    cast: 'Face au mur, la main libre suffit des deux côtés : rien ne pèse jamais sur le plâtre.',
  },
  'dead-bug': {
    key: 'dead-bug',
    name: 'Gainage sur le dos, jambes alternées (dead bug)',
    what: 'Allongé sur le dos, hanches et genoux pliés en l\'air, tu descends un talon vers le sol en gardant le bas du dos plaqué.',
    cues: [
      'Sur le dos, les hanches et les genoux à angle droit.',
      'Plaque le bas du dos au sol : il ne décolle jamais.',
      'Descends un talon vers le sol en 3 s, remonte, puis l\'autre.',
    ],
    where: ['maison', 'salle'],
    equipment: 'Un tapis',
    why: 'Le gainage profond, dos plaqué au sol, sans rien demander aux bras.',
    steps: [
      'Sur le dos, hanches et genoux à angle droit, jambes en l\'air.',
      'Plaque le bas du dos au sol : il ne doit jamais se décoller.',
      'Descends un talon jusqu\'à frôler le sol en 3 secondes, en tendant la jambe.',
      'Remonte, puis l\'autre jambe.',
    ],
    feel: 'Le bas du ventre se tend, le dos reste collé.',
    mistakes: ['Laisser le dos se creuser.', 'Bloquer sa respiration.'],
    cast: 'Le bras plâtré posé sur le ventre ou le long du corps.',
  },
  'gainage-lateral': {
    key: 'gainage-lateral',
    name: 'Gainage sur le côté, sur le coude valide',
    what: 'Allongé sur le côté, appuyé sur le coude du bras valide, tu soulèves le bassin pour que tout le corps fasse une ligne droite, et tu tiens.',
    cues: [
      'Sur le côté, le coude valide sous l\'épaule.',
      'Monte le bassin : la tête, le bassin et les pieds alignés.',
      'Genoux au sol si le bassin tombe.',
    ],
    where: ['maison', 'salle'],
    equipment: 'Un tapis',
    why: 'Les obliques et le moyen fessier : ce qui garde le bassin stable sur un sentier.',
    setup: [
      'Allongé sur le côté du bras libre, le coude juste sous l\'épaule, l\'avant-bras à plat devant toi.',
      'Jambes tendues l\'une sur l\'autre, le bras plâtré posé sur la hanche.',
    ],
    steps: [
      'Monte le bassin jusqu\'à aligner tête, bassin et pieds.',
      'Tiens le temps prescrit.',
      'Repose le bassin doucement.',
    ],
    breath: 'Lente et continue pendant tout le maintien.',
    feel: 'Le côté du ventre et la hanche du dessous.',
    mistakes: ['Laisser le bassin tomber.', 'Avancer les fesses.', 'Enfoncer l\'épaule dans le cou : pousse le sol.'],
    easier: 'Genoux pliés au sol : l\'appui est aux genoux, pas aux pieds.',
    harder: '10 secondes de plus ; puis la jambe du dessus soulevée.',
    cast:
      'Uniquement sur le coude libre, le bras plâtré posé sur la hanche. L\'autre côté attendra la fin du plâtre. ' +
      'Plus facile : genoux au sol.',
  },
  'marche-tapis': {
    key: 'marche-tapis',
    name: 'Marche en côte sur tapis',
    what: 'Marcher sur un tapis roulant incliné, comme dans une montée, sans se tenir.',
    cues: [
      'La clé de sécurité attachée à ton vêtement.',
      'Pente 10 à 15 %, sans te tenir aux barres.',
      'Ajuste la vitesse pour rester dans la plage de FC.',
    ],
    where: ['salle'],
    equipment: 'Un tapis de course inclinable',
    why:
      'Le meilleur substitut à la course pour un traileur sans bras : le cœur en endurance, les muscles des ' +
      'montées, aucun impact.',
    steps: [
      'Attache la clé de sécurité du tapis à ton vêtement.',
      '5 minutes à plat à 5 km/h, puis monte la pente à 10 %, jusqu\'à 15 % si ta FC reste dans la plage.',
      'Pas courts et rapides, buste droit, sans te tenir aux barres.',
      'Ajuste vitesse et pente pour rester dans la plage de FC prescrite.',
    ],
    feel: 'Tu peux dire une phrase entière ; mollets et fessiers travaillent.',
    mistakes: [
      'Se tenir aux barres : la pente ne sert plus à rien.',
      'Aller trop vite : au-delà de 6 km/h à 15 %, la foulée se désorganise.',
    ],
    cast:
      'La main libre à portée de la barre, sans s\'y suspendre. Au moindre vertige, arrête la bande avant de ' +
      'descendre.',
  },
  intervalles: {
    key: 'intervalles',
    name: 'Intervalles sur stepper ou vélo',
    what: 'Alterner des minutes rapides et des minutes faciles sur un vélo couché ou un escalier mécanique, sans les bras.',
    cues: [
      'Stepper sans t\'y suspendre, ou vélo couché sans les mains.',
      'Les répétitions dans la zone prescrite, la récupération en continuant doucement.',
    ],
    where: ['salle'],
    equipment: 'Stepper (escalier mécanique), vélo couché ou vélo droit',
    why:
      'Quand le volume baisse, c\'est l\'intensité qui conserve la VO2max : réduire le volume des deux tiers ne ' +
      'coûte rien tant que l\'intensité reste (Hickson, 1981 et 1985).',
    steps: [
      'Stepper : la main libre posée légèrement sur la rampe, sans t\'y suspendre. Vélo couché : sans les mains.',
      'Échauffe-toi 10 minutes en montant progressivement.',
      'Fais les répétitions dans la zone prescrite ; récupère en continuant doucement.',
      'Termine par 10 minutes faciles.',
    ],
    feel: 'Au seuil, 7 sur 10 : des phrases courtes. En PMA, 9 sur 10 : quelques mots.',
    mistakes: [
      'Le rameur et l\'elliptique : ils demandent les deux bras.',
      'Viser la FC de course sur le vélo : elle y monte 5 à 10 bpm moins haut pour le même effort.',
    ],
    cast: 'Aucun appui sur le bras plâtré. Sur un vélo droit, buste redressé, la main libre seule sur le guidon.',
  },
  'marche-cote': {
    key: 'marche-cote',
    name: 'Marche en côte dehors',
    what: 'Marcher en montée, sur un sol revêtu et sec, sans courir.',
    cues: [
      'Des montées revêtues et des escaliers secs : Fourvière, Saint-Barthélemy, la Grande-Côte.',
      'Monte en marche, jamais en courant, la main valide près de la rampe.',
      'Redescends lentement, la main sur la rampe.',
    ],
    where: ['dehors'],
    equipment: 'De l\'eau, ton téléphone, ta montre au poignet libre',
    why:
      'La sortie longue du traileur qui ne court pas : du temps debout, du dénivelé, et l\'habitude de monter fort ' +
      'en marchant — la moitié d\'un trail. En fractionné, c\'est aussi ce qui garde ta VO2max : un escalier monté ' +
      'vite fait grimper le cœur jusqu\'au seuil, ce qu\'aucun step ne fait — à 20 cm, il faudrait plus de 80 ' +
      'montées par minute.',
    steps: [
      'Des montées revêtues et des escaliers secs : montée Saint-Barthélemy, montée du Gourguillon, escaliers de Fourvière, montée de la Grande-Côte.',
      'Longue marche : monte en marche active, sans dépasser le haut de la plage de FC prescrite.',
      'Fractionné : monte vite, en marche, une marche à la fois, jusqu\'à la zone prescrite et pendant la durée de la répétition ; en zone 4, tu ne dis que quelques mots.',
      'Redescends lentement, la main libre sur la rampe : entre deux répétitions, c\'est la récupération.',
      'S\'il pleut, les escaliers de ton immeuble : les marches mouillées sont interdites.',
    ],
    feel: 'Les montées essoufflent sans brûler ; les descentes se font sans à-coups.',
    mistakes: ['Courir, même en montée : la marche rapide suffit à monter le cœur.', 'Courir les descentes.', 'Prendre un sentier glissant pour « faire trail ».'],
    cast:
      'Une chute sur le bras plâtré coûterait des semaines : pas de sentier technique, pas de marches mouillées, ' +
      'pas de descente rapide. L\'écharpe si la marche fait lancer le coude.',
  },
  'soins-bras': {
    key: 'soins-bras',
    name: 'Soins du bras plâtré',
    what: 'Bouger les doigts et l\'épaule du bras plâtré plusieurs fois par jour, pour qu\'ils ne s\'enraidissent pas et que la main ne gonfle pas.',
    cues: [
      'Doigts : poing fermé, main grande ouverte, 10 fois.',
      'Pouce : touche le bout de chaque doigt, 5 fois.',
      'Épaule : lève le bras plâtré devant toi, sans douleur, 10 fois.',
    ],
    where: ['maison', 'salle', 'dehors'],
    equipment: 'Rien',
    why:
      'Garder les doigts et l\'épaule mobiles évite la raideur et aide le gonflement à se résorber : ce sont les ' +
      'consignes des services de fracture, trois à quatre fois par jour.',
    steps: [
      'Doigts : ferme le poing, ouvre grand la main, écarte les doigts — 10 fois.',
      'Pouce : touche le bout de chaque doigt — 5 fois.',
      'Épaule : lève doucement le bras plâtré devant toi, aussi haut que possible sans douleur, puis redescends — 10 fois.',
      'Assis, le bras plâtré posé sur un coussin plus haut que le coude dès que tu peux.',
    ],
    feel: 'Une gêne qui passe dans les deux heures est normale ; une douleur qui monte ne l\'est pas.',
    mistakes: ['Laisser la main pendre toute la journée : elle gonfle.'],
    cast:
      'Doigts qui gonflent, bleuissent, s\'engourdissent, ou douleur qui augmente dans le plâtre : appelle ton ' +
      'chirurgien ou les urgences sans attendre.',
  },
  respiration: {
    key: 'respiration',
    name: 'Respiration',
    what: 'Respirer lentement avec le ventre, en comptant les secondes de chaque inspiration et de chaque expiration.',
    cues: [
      'Allongé, une main sur le ventre.',
      '5 min : inspire 4 s, expire 6 s. Puis 5 min : inspire 4 s, expire 8 s.',
      'Avec l\'appareil : 30 inspirations fortes, matin et soir.',
    ],
    where: ['maison', 'salle', 'dehors'],
    equipment: 'Un entraîneur inspiratoire (POWERbreathe Plus Sport) si tu l\'as ; sinon rien',
    why:
      'Ton test relève 60 respirations par minute au maximum et un volume courant à 48 % de ta capacité vitale : à ' +
      'l\'effort, tu respires vite et court. Avec l\'appareil, 30 inspirations deux fois par jour pendant quatre à ' +
      'six semaines renforcent les muscles inspiratoires ; c\'est le seul travail respiratoire dont l\'effet sur ' +
      'la performance est démontré.',
    steps: [
      'Avec l\'appareil, matin et soir : règle-le au niveau où les 30 inspirations sont difficiles mais faisables.',
      'Inspire fort et vite par la bouche, à fond ; expire lentement, sans forcer. 30 fois.',
      'Quand les 30 deviennent faciles, monte d\'un cran.',
      'Sans appareil : allongé, une main sur le ventre — 5 minutes à 4 s d\'inspiration et 6 s d\'expiration, puis 5 minutes à 4 s et 8 s.',
    ],
    feel: 'Le haut du ventre et les côtes travaillent ; la tête ne doit pas tourner.',
    mistakes: ['Inspirer mollement : c\'est la force de l\'inspiration qui entraîne.', 'Le faire juste après manger.'],
    cast: 'L\'appareil se tient d\'une main : la libre suffit.',
  },
  souplesse: {
    key: 'souplesse',
    name: 'Souplesse de la chaîne postérieure',
    what: 'Trois étirements doux : l\'arrière des cuisses, les mollets, l\'avant de la hanche.',
    cues: [
      'Arrière des cuisses : sur le dos, la sangle sous le pied, la jambe tendue, 45 s.',
      'Mollets : la main au mur, la jambe tendue derrière, le talon au sol, 45 s.',
      'Avant de la hanche : un genou au sol, avance le bassin, 45 s.',
      'Deux fois de chaque côté, sans à-coups.',
    ],
    where: ['maison', 'salle'],
    equipment: 'Une sangle (ou une ceinture), un mur, un coussin',
    why:
      'Ton test relève une flexion avant à −1 cm : la chaîne postérieure est courte, et elle ne s\'allonge qu\'avec ' +
      'la régularité.',
    steps: [
      'Ischio-jambiers : sur le dos, la sangle sous un pied tenue par la main libre, jambe tendue vers le haut — 45 s par jambe, deux fois.',
      'Mollets : main libre au mur, une jambe tendue derrière, talon au sol — 45 s par jambe, deux fois.',
      'Avant de la hanche : un genou sur un coussin, l\'autre pied devant, avance le bassin, la main libre sur une chaise — 45 s par côté.',
    ],
    feel: 'Un étirement net, jamais une douleur ; la respiration reste lente.',
    mistakes: ['Donner des à-coups.', 'Retenir son souffle.'],
    cast: 'Tout se fait avec la main libre ; le bras plâtré reste posé.',
  },

  'echauffement-maison': {
    key: 'echauffement-maison',
    name: 'Échauffement à la maison',
    what: 'Six minutes de mouvements faciles pour chauffer les jambes avant de forcer.',
    cues: [
      '1 min de marche sur place, genoux hauts.',
      '10 assis-debout sans les mains, puis 10 ponts fessiers.',
      '10 montées sur la pointe des pieds, puis 5 fentes arrière par jambe.',
    ],
    where: ['maison'],
    equipment: 'Une chaise sans roulettes, un mur, le tapis',
    why:
      'Monter la température des muscles et des tendons, et répéter à vide les gestes de la séance : les premières ' +
      'séries se font avec un corps prêt, et une gêne se repère avant qu\'elle compte.',
    setup: ['La chaise calée contre un mur, le bras plâtré en écharpe ou contre toi.'],
    steps: [
      '1 minute de marche sur place, genoux hauts, la main libre au mur.',
      '10 assis-debout de la chaise sans les mains : le nez passe au-dessus des orteils, tu pousses dans les talons.',
      '10 ponts fessiers sur le tapis, 2 secondes en haut.',
      '10 montées sur la pointe des pieds, lentes.',
      '5 fentes arrière par jambe, la main libre au mur.',
    ],
    breath: 'Calme, par le nez : l\'échauffement n\'essouffle pas.',
    feel: 'De la chaleur dans les cuisses, les fessiers et les mollets ; aucune fatigue.',
    mistakes: [
      'Le bâcler pour gagner du temps : ce sont ces 6 minutes qui protègent les 30 suivantes.',
      'Se laisser tomber sur la chaise : on s\'y pose.',
    ],
    easier: 'Les assis-debout la main libre sur la cuisse.',
    cast:
      'Rien ne s\'appuie sur le bras plâtré. Pour te relever du tapis, roule du côté du bras libre et pousse sur ' +
      'cette main.',
  },

  'split-squat-maison': {
    key: 'split-squat-maison',
    name: 'Fente bulgare, pied arrière sur le step',
    what: 'Une fente sur une seule jambe : le dessus du pied arrière posé sur le step, tu descends le genou arrière vers le sol en pliant la jambe avant, puis tu remontes.',
    cues: [
      'Le dessus du pied arrière sur le step, calé contre un mur.',
      'La main valide sur l\'encadrement de porte.',
      'Descends droit, le genou arrière vers le sol, le genou avant au-dessus du pied.',
    ],
    where: ['maison'],
    equipment: 'Le step à 40 cm (ou le tabouret) calé contre un mur, un encadrement de porte',
    why:
      'Le meilleur exercice de jambes qui se fasse chez soi : sur une jambe, ton poids devient la charge. Il ' +
      'entretient les quadriceps (le devant de la cuisse) et les fessiers, qui te font monter et qui freinent en ' +
      'descente.',
    setup: [
      'Vérifie le step : appuie fort sur chaque coin. S\'il bascule ou glisse, cale-le contre un mur, ou prends le canapé.',
      'Dos au step, à une grande enjambée devant lui, l\'encadrement de porte à portée de la main valide.',
      'Pose le dessus du pied arrière, les lacets, sur le step.',
      'Règle la distance : en bas, le tibia avant est vertical. Trop près, le genou avant file devant ; trop loin, la hanche arrière tire.',
    ],
    steps: [
      'Descends en 3 secondes, droit vers le sol, le genou arrière vers le sol.',
      'Arrête quand la cuisse avant est parallèle au sol, le genou arrière à une main du sol. Tiens 1 seconde.',
      'Remonte en 1 seconde en poussant dans le talon avant, jusqu\'à la jambe presque tendue.',
      'Toutes les répétitions d\'une jambe, puis l\'autre.',
    ],
    breath: 'Inspire en descendant, souffle en remontant ; ne bloque pas.',
    feel: 'La cuisse et la fesse de la jambe avant. Un étirement à l\'avant de la hanche arrière est normal.',
    mistakes: [
      'Pousser avec la jambe arrière : elle n\'est qu\'un appui.',
      'Laisser le genou avant rentrer : il suit le deuxième orteil.',
      'Tirer sur l\'encadrement : la main stabilise, elle ne soulève pas.',
    ],
    easier: 'Le pied arrière au sol (fente arrière), ou une descente moins profonde.',
    harder: '2 secondes tenues en bas, puis 4 pour descendre.',
    cast:
      'La main valide sur l\'encadrement suffit à l\'équilibre. Le bras plâtré reste en écharpe : ne le lève pas ' +
      'pour compenser.',
  },
  'leg-curl-serviette': {
    key: 'leg-curl-serviette',
    name: 'Flexion des jambes, talons sur une serviette (leg curl)',
    what: 'Allongé sur le dos, le bassin levé, tu fais glisser les talons loin de toi : l\'arrière des cuisses freine le mouvement.',
    cues: [
      'Sur le dos, les talons sur une serviette posée sur le parquet.',
      'Le bassin haut, fais glisser les talons loin de toi en 4 s.',
      'Pose les fesses, ramène les talons, remonte le bassin.',
    ],
    where: ['maison'],
    equipment: 'Une serviette, un sol lisse (parquet, carrelage), le tapis sous le dos',
    why:
      'Les ischio-jambiers freinent la jambe à chaque foulée et protègent le genou en descente. Le travail en ' +
      'freinage — le muscle qui s\'allonge sous tension — est ce qui les protège le mieux des déchirures.',
    setup: [
      'Sur le dos, les épaules sur le tapis, les talons sur la serviette posée à même le parquet.',
      'Le bras libre au sol le long du corps, paume vers le bas ; le bras plâtré posé sur le ventre.',
    ],
    steps: [
      'Monte le bassin : épaules, bassin et genoux alignés.',
      'Fais glisser les talons loin de toi en 4 secondes, sans laisser tomber le bassin.',
      'Jambes tendues, pose les fesses au sol.',
      'Ramène les talons sous les genoux, bassin posé, puis remonte-le pour la suivante.',
    ],
    breath: 'Souffle longuement pendant la glissade.',
    feel: 'L\'arrière des cuisses, de plus en plus à mesure que les jambes s\'allongent ; les fessiers tiennent le bassin.',
    mistakes: [
      'Laisser tomber le bassin au début de la glissade : c\'est lui qui fait le travail.',
      'Creuser le bas du dos.',
    ],
    easier: 'Glisser moins loin.',
    harder: 'Ramener aussi les talons bassin haut ; puis une seule jambe.',
    cast:
      'Le bras plâtré reste posé sur le ventre ; seul le bras libre touche le sol, sans pousser. Des courbatures à ' +
      'l\'arrière des cuisses sont fréquentes les deux premières fois : elles ne doivent pas changer ta marche.',
  },

  'tirage-elastique': {
    key: 'tirage-elastique',
    name: 'Tirage à un bras, élastique à la porte',
    what: 'Face à la porte, tu tires la poignée vers tes côtes, comme un coup de rame, puis tu rends lentement.',
    cues: [
      'Face à la porte, l\'accroche à hauteur de poitrine, deux élastiques sur la poignée.',
      'Tire le coude le long des côtes en 1 s, l\'omoplate serrée ; tiens 1 s.',
      'Rends en 2 s, le buste ne tourne pas.',
    ],
    where: ['maison'],
    equipment: 'Le kit d\'élastiques : deux élastiques, une poignée, l\'accroche de porte',
    why:
      'Le dos et l\'arrière de l\'épaule du bras valide, pour la posture des longues montées. Et un bras entraîné ' +
      'entretient la force de l\'autre, immobilisé.',
    setup: [
      'L\'accroche à hauteur de poitrine : ouvre la porte, passe le cylindre de l\'autre côté, côté charnières, referme. La porte doit s\'ouvrir de l\'autre côté : en tirant, tu la fermes.',
      'Accroche la boucle de deux élastiques (5 et 7 kg) au crochet de la sangle. Pour mettre la poignée à leurs autres boucles d\'une seule main : pose-les au sol, le pied juste derrière les boucles, et passe le crochet dedans.',
      'Face à la porte, un pied devant l\'autre, genoux souples, à la distance où l\'élastique est déjà tendu bras tendu.',
    ],
    steps: [
      'Tire le coude vers l\'arrière, le long des côtes, en 1 seconde, en serrant l\'omoplate vers la colonne.',
      'Tiens 1 seconde, la main contre les côtes.',
      'Rends en 2 secondes, jusqu\'au bras tendu.',
    ],
    breath: 'Souffle en tirant.',
    feel: 'Entre l\'omoplate et la colonne, et l\'arrière de l\'épaule.',
    mistakes: ['Tourner le buste pour tirer plus fort.', 'Hausser l\'épaule vers l\'oreille.', 'Lâcher le retour.'],
    easier: 'Un seul élastique, ou un pas plus près de la porte.',
    harder: 'Un pas plus loin, ou un troisième élastique sur la poignée.',
    cast: 'Le bras plâtré reste en écharpe ; le buste ne tourne pas pour compenser, et c\'est aussi un gainage.',
  },

  'bras-elastique': {
    key: 'bras-elastique',
    name: 'Bras valide à l\'élastique : plier, tendre, serrer',
    what: 'Trois mouvements pour le bras valide : plier le coude contre l\'élastique, tendre le bras vers le bas, serrer l\'anneau.',
    cues: [
      'Plier : l\'accroche en bas de la porte, le coude collé au flanc.',
      'Tendre : l\'accroche en haut, pousse la main vers la cuisse.',
      'Serrer : l\'anneau à fond 5 s, relâche 5 s. Puis le maximum sous la table.',
    ],
    where: ['maison'],
    equipment: 'Le kit d\'élastiques (un élastique, une poignée, l\'accroche de porte), l\'anneau de serrage',
    why:
      'Entraîner le bras valide entretient le bras plâtré par le système nerveux : après une fracture du poignet, ' +
      'ceux qui entraînaient la main saine avaient plus de force du côté fracturé à 12 semaines (Magnus 2013). ' +
      'Pour un coude, ce sont les muscles qui le plient, ceux qui le tendent, et la poigne qui comptent — poussés ' +
      'près du maximum : c\'est l\'intensité qui passe d\'un bras à l\'autre.',
    setup: [
      'Plier : l\'accroche tout en bas de la porte, un élastique de 5 ou 6 kg, face à la porte, à un pas.',
      'Tendre : l\'accroche tout en haut de la porte, un élastique de 4 ou 5 kg, face à la porte.',
      'Serrer : l\'anneau dans la main valide.',
    ],
    steps: [
      'Plier (le curl) : le coude collé au flanc, monte la main vers l\'épaule en 1 seconde, redescends en 3. C\'est le biceps, le devant du bras.',
      'Tendre (le triceps) : le coude collé au flanc, plié à angle droit ; pousse la main vers la cuisse en 1 seconde, remonte en 3. C\'est le triceps, l\'arrière du bras.',
      'Serrer : serre l\'anneau à fond 5 secondes, relâche 5 secondes, 10 fois.',
      'Enchaîne les trois, deux tours ; change l\'accroche de hauteur entre les deux premiers.',
      'Le maximum, sans élastique : assis à une table, la paume sous le plateau, coude à angle droit ; pousse vers le haut de toutes tes forces 5 secondes, 3 fois. Puis la paume sur le plateau, pousse vers le bas, 3 fois.',
    ],
    breath: 'Souffle à l\'effort, jamais en apnée.',
    feel: 'Le devant du bras quand tu plies, l\'arrière quand tu tends, l\'avant-bras quand tu serres.',
    mistakes: ['Balancer le buste.', 'Décoller le coude du flanc.'],
    easier: 'Un pas plus près de la porte.',
    harder: 'Un élastique plus dur, ou 4 secondes pour revenir.',
    cast: 'L\'autre bras ne fait rien ; garde l\'écharpe si le coude lance. Sous la table, la table ne doit pas bouger : pousse moins fort si elle se soulève.',
  },
  'descente-marche': {
    key: 'descente-marche',
    name: 'Descente lente du step',
    what: 'Debout sur le step, tu plies lentement la jambe d\'appui jusqu\'à ce que le talon de l\'autre pied effleure le sol devant.',
    cues: [
      'Debout sur le step, la main valide au mur ou à l\'encadrement.',
      'Plie la jambe d\'appui en 4 s : le talon libre effleure le sol devant.',
      'Le genou reste au-dessus du deuxième orteil.',
    ],
    where: ['maison', 'dehors'],
    equipment: 'Le step à 20 cm (ou une marche d\'escalier), un encadrement de porte ou un mur pour la main valide',
    why:
      'La descente de trail au ralenti : le quadriceps qui freine en s\'allongeant. C\'est lui qui lâche en fin de ' +
      'course quand on ne l\'a pas préparé, et lui qui protège le genou. Ton aisance en descente est ta marge de ' +
      'progression la plus nette.',
    setup: [
      'Le step à 20 cm devant un encadrement de porte ou à côté d\'un mur, pour la main valide.',
      'Debout sur le step, le pied d\'appui entier dessus ; l\'autre jambe tendue dans le vide, devant.',
    ],
    steps: [
      'Plie le genou d\'appui en 4 secondes, les hanches en arrière comme pour t\'asseoir.',
      'Le talon libre effleure le sol, sans s\'y poser.',
      'Remonte en 1 seconde en poussant dans le talon d\'appui.',
      'Toutes les répétitions d\'une jambe, puis l\'autre.',
    ],
    breath: 'Inspire en descendant, souffle en remontant.',
    feel: 'Le devant de la cuisse d\'appui et la fesse ; le genou, lui, ne fait pas mal.',
    mistakes: [
      'Laisser le genou rentrer vers l\'intérieur : il reste au-dessus du deuxième orteil.',
      'Se laisser tomber sur le talon libre : il touche, il ne porte pas.',
      'Pencher le bassin du côté de la jambe libre.',
    ],
    easier: 'La moitié du chemin seulement.',
    harder: '5 secondes pour descendre ; puis le step à 40 cm.',
    cast: 'La main valide sur l\'encadrement ou le mur, toujours. Arrête la série dès que la jambe tremble.',
  },
  'souleve-une-jambe': {
    key: 'souleve-une-jambe',
    name: 'Bascule sur une jambe (soulevé de terre)',
    what: 'Debout sur un pied, tu penches le buste en avant pendant que l\'autre jambe part en arrière, le dos droit, puis tu te redresses.',
    cues: [
      'Sur une jambe, la main valide sur l\'encadrement, le genou souple.',
      'Bascule le buste en 3 s, la jambe libre part en arrière : une seule ligne.',
      'Remonte en 1 s en serrant la fesse.',
    ],
    where: ['maison'],
    equipment: 'Un encadrement de porte',
    why:
      'Les ischio-jambiers et le fessier en allongement, et l\'équilibre sur un pied : la cheville, la hanche et le ' +
      'tronc qui tiennent ensemble, comme sur un sentier.',
    setup: [
      'Debout sur une jambe, à côté de l\'encadrement, la main libre posée dessus à hauteur de hanche.',
      'Le genou d\'appui légèrement fléchi, et il le reste.',
    ],
    steps: [
      'Bascule le buste en avant depuis la hanche pendant que la jambe libre part en arrière : tête, dos et talon sur une même ligne.',
      'Descends en 3 secondes, jusqu\'à ce que le buste approche l\'horizontale ou que l\'arrière de la cuisse tire.',
      'Remonte en 1 seconde en serrant la fesse d\'appui.',
    ],
    breath: 'Inspire en descendant, souffle en remontant.',
    feel: 'L\'arrière de la cuisse et la fesse de la jambe d\'appui ; la cheville travaille pour l\'équilibre.',
    mistakes: [
      'Arrondir le dos pour descendre plus bas.',
      'Ouvrir la hanche de la jambe libre vers le plafond : le bassin reste face au sol.',
      'Plier puis tendre le genou d\'appui : il garde la même flexion.',
    ],
    easier: 'La pointe du pied libre reste posée derrière, comme une béquille.',
    harder: '4 secondes pour descendre ; puis un doigt seulement sur l\'encadrement.',
    cast: 'La main libre ne lâche pas l\'encadrement ; le bras plâtré en écharpe. Pour l\'autre jambe, tu restes du même côté.',
  },
  'pas-chasses': {
    key: 'pas-chasses',
    name: 'Pas chassés à la mini-bande',
    what: 'Une mini-bande autour des chevilles, tu te déplaces de côté à petits pas, sans jamais laisser la bande se détendre.',
    cues: [
      'La mini-bande aux chevilles, face au mur, la main valide dessus.',
      'Des pas de 30 cm sur le côté, la bande toujours tendue.',
      '12 pas dans un sens, 12 dans l\'autre.',
    ],
    where: ['maison'],
    equipment: 'Une mini-bande, un mur dégagé sur 3 mètres',
    why:
      'Le moyen fessier tient le bassin à chaque appui : sur un sentier, c\'est lui qui empêche le genou de rentrer ' +
      'et la hanche de s\'affaisser quand la fatigue arrive.',
    setup: [
      'La mini-bande autour des chevilles (plus dur) ou juste au-dessus des genoux (plus facile).',
      'Face au mur, à 30 cm, la main libre posée dessus à hauteur de poitrine.',
      'Pieds à la largeur des hanches, genoux un peu fléchis, buste droit.',
    ],
    steps: [
      'Écarte un pied de 30 cm sur le côté, puis ramène l\'autre jusqu\'à la largeur des hanches : la bande ne se détend jamais.',
      '12 pas dans un sens, 12 dans l\'autre ; la main glisse sur le mur.',
    ],
    breath: 'Régulière ; tu pourrais parler.',
    feel: 'Le haut et le côté de la fesse, des deux côtés ; ça brûle vers le dixième pas.',
    mistakes: [
      'Se dandiner : les épaules restent à la même hauteur.',
      'Rapprocher les pieds au point de détendre la bande.',
      'Tourner les pointes vers l\'extérieur.',
    ],
    easier: 'La bande au-dessus des genoux, ou la plus souple des trois.',
    harder: 'La bande aux chevilles, la plus dure, les genoux plus fléchis.',
    cast: 'Face au mur, la main libre suffit dans les deux sens : rien ne pèse sur le plâtre.',
  },
  'montee-genou': {
    key: 'montee-genou',
    name: 'Montée de genou sur le dos, contre la mini-bande',
    what: 'Allongé sur le dos, les deux pieds reliés par une mini-bande, tu ramènes un genou vers la poitrine contre la bande.',
    cues: [
      'Sur le dos, la mini-bande autour des deux pieds.',
      'Le bas du dos plaqué, les jambes tendues à 20 cm du sol.',
      'Ramène un genou vers la poitrine en 1 s, repars en 2 s, alterne.',
    ],
    where: ['maison'],
    equipment: 'Une mini-bande, le tapis',
    why:
      'Les fléchisseurs de hanche tirent la jambe vers l\'avant à chaque pas de montée ; le tronc empêche le bas du ' +
      'dos de se creuser. Les deux à la fois, sans les bras.',
    setup: [
      'Sur le dos sur le tapis, la mini-bande autour des deux pieds, au milieu de la plante.',
      'Le bras libre au sol, le bras plâtré posé sur le ventre.',
    ],
    steps: [
      'Plaque le bas du dos au sol et lève les deux jambes tendues, talons à 20 cm du sol.',
      'Ramène un genou vers la poitrine en 1 seconde contre la bande ; l\'autre jambe reste tendue.',
      'Repars en 2 secondes, sans poser le pied ; alterne.',
    ],
    breath: 'Souffle quand le genou monte.',
    feel: 'Le pli de l\'aine de la jambe qui monte, et le bas du ventre.',
    mistakes: [
      'Laisser le bas du dos se décoller : monte la jambe tendue plus haut, c\'est plus facile.',
      'Aller vite : la bande reste tendue tout le temps.',
    ],
    easier: 'La jambe tendue plus haute, à 45°.',
    harder: 'La jambe tendue plus basse, ou une bande plus dure.',
    cast: 'Le bras plâtré reste posé ; ne le soulève pas pour t\'aider.',
  },
  marche: {
    key: 'marche',
    name: 'Marche tranquille',
    what: 'Marcher à allure de conversation.',
    cues: [
      'Allure de conversation : des phrases entières.',
      'Un sol sec et régulier, rien à la main.',
    ],
    where: ['dehors'],
    equipment: 'De bonnes chaussures, la montre au poignet libre',
    why:
      'Garder le cœur et les jambes en route sans rien demander au coude : la marche entretient l\'endurance de ' +
      'base, fait circuler le sang jusqu\'à la fracture, et compte dans ta charge.',
    setup: ['Lance la montre en Marche.', 'L\'écharpe si le coude lance ou gonfle en marchant.'],
    steps: [
      'Pars facile : tu dois pouvoir parler en phrases entières tout du long.',
      'Des pas souples, le regard devant, le bras libre qui balance.',
      'Du plat ou de petites montées, sur un sol sec et régulier.',
    ],
    breath: 'Libre, par le nez si tu peux.',
    feel: 'Une fatigue agréable, jamais d\'essoufflement.',
    mistakes: [
      'Accélérer pour que ça compte : cette semaine, c\'est la régularité qui compte.',
      'Les trottoirs mouillés, les feuilles, les pavés glissants.',
    ],
    cast: 'Une chute est le seul vrai risque : un sol sec, la main libre libre — pas de téléphone à la main.',
  },
  'montee-tabouret': {
    key: 'montee-tabouret',
    name: 'Montées sur le step : lentes, continues, rapides',
    what: 'Un pied sur le step, tu montes dessus en poussant sur cette jambe, puis tu redescends : lentement pour la force, vite pour la puissance, en continu pour l\'endurance.',
    cues: [
      'Le step calé contre un mur, la main valide au mur.',
      'Tout le pied sur le step : monte en poussant dans ce talon.',
      'Redescends en 4 s en freinant avec la jambe du haut.',
    ],
    where: ['maison'],
    equipment: 'Le step à 40 cm (ou le tabouret) calé contre un mur ; un sac à dos chargé pour plus dur ; le mur pour la main valide',
    why:
      'Monter, c\'est la force des côtes. Redescendre en 4 secondes, c\'est le quadriceps qui freine en s\'allongeant ' +
      '— ce qu\'il fait dans chaque descente de trail, et ce qui lâche en fin de course quand il n\'est pas préparé. ' +
      'En continu, en fin de séance, c\'est l\'endurance des montées.',
    setup: [
      'Vérifie le step : appuie fort sur chaque coin ; il ne doit ni basculer ni glisser. Calé contre un mur, c\'est mieux.',
      'Face au step, la main valide posée sur le mur ou l\'encadrement, à côté.',
    ],
    steps: [
      'Pose tout le pied sur le step.',
      'Lente (la force) : monte en 1 seconde en poussant dans ce talon, la jambe du bas ne pousse pas ; redescends en 4 secondes en freinant avec la jambe du haut. Toutes les répétitions d\'une jambe, puis l\'autre.',
      'Explosive (la puissance) : monte le plus vite possible, sans sauter, puis redescends en 4 secondes.',
      'Continue (l\'endurance des côtes) : à 40 cm, une montée toutes les 2 secondes — monter, redescendre —, change de jambe toutes les 30 secondes.',
      'Le fractionné ne se fait pas ici : même à 40 cm et vite, le step ne monte pas ton cœur jusqu\'au seuil. Il se fait dans les escaliers.',
    ],
    breath: 'Souffle en montant, inspire en descendant.',
    feel: 'La cuisse et la fesse de la jambe du haut ; en redescendant, le devant de la cuisse brûle.',
    mistakes: [
      'Pousser avec la jambe du bas : elle suit, c\'est tout.',
      'Se laisser tomber en redescendant : c\'est la descente lente qui compte.',
      'Laisser le genou rentrer vers l\'intérieur.',
    ],
    easier: 'Le step à 20 cm.',
    harder: '5 secondes pour redescendre ; puis un sac à dos chargé de 5 à 10 kg, si tu l\'enfiles sans forcer le coude.',
    cast:
      'La main valide toujours au mur : à 40 cm, une perte d\'équilibre se rattrape avec elle. Arrête la série dès ' +
      'que la jambe tremble.',
  },
  'mollets-sol': {
    key: 'mollets-sol',
    name: 'Montées sur la pointe d\'un pied',
    what: 'Debout sur un pied, tu montes sur la pointe, puis tu redescends lentement jusqu\'à reposer le talon.',
    cues: [
      'Sur un pied, face au mur, la main valide dessus.',
      'Monte tout en haut en 1 s, tiens 1 s.',
      'Redescends en 3 s jusqu\'au talon posé.',
    ],
    where: ['maison', 'salle', 'dehors'],
    equipment: 'Rien ; un mur pour la main valide',
    why:
      'Le mollet et le tendon d\'Achille encaissent chaque foulée, deux à trois fois ton poids : trois semaines ' +
      'sans courir les déchargent, et c\'est ce qui les garde prêts. Genou tendu, c\'est le mollet de surface ; ' +
      'genou fléchi, le soléaire, le muscle profond du mollet, celui qui porte le plus en course.',
    setup: [
      'Debout sur un pied, face au mur, la main valide posée dessus.',
      'L\'autre pied accroché derrière la cheville d\'appui.',
    ],
    steps: [
      'Monte sur la pointe le plus haut possible, en 1 seconde.',
      'Tiens 1 seconde en haut.',
      'Redescends en 3 secondes jusqu\'au talon posé.',
      'Genou tendu, ou fléchi d\'environ 30° quand la séance le dit : il le reste toute la série.',
    ],
    breath: 'Souffle en montant.',
    feel: 'Le mollet brûle vers la dixième répétition.',
    mistakes: [
      'Rebondir en bas.',
      'Monter à moitié : tout en haut, à chaque fois.',
      'Laisser la cheville partir vers l\'extérieur : le poids reste sous le gros orteil.',
    ],
    easier: 'Sur les deux pieds.',
    harder: 'Sur le bord de la première marche d\'un escalier, le talon qui descend sous la marche ; ou 5 secondes de descente.',
    cast: 'La main valide au mur : sur un pied, c\'est elle qui rattrape.',
  },
  'chaise-une-jambe': {
    key: 'chaise-une-jambe',
    name: 'Chaise sur une jambe',
    what: 'La chaise contre le mur, mais un pied levé de quelques centimètres : une seule cuisse tient tout le poids.',
    cues: [
      'Dos au mur, les cuisses parallèles au sol, comme pour la chaise.',
      'Lève un pied de 5 cm : la jambe d\'appui tient seule.',
      'Tiens le temps dit, puis l\'autre jambe.',
    ],
    where: ['maison'],
    equipment: 'Un mur',
    why:
      'La chaise sur deux jambes, en deux fois plus dur : la cuisse qui tient seule, comme celle qui freine à chaque ' +
      'appui d\'une descente.',
    setup: ['Dos contre le mur, les pieds à 40 cm devant, à la largeur des hanches.'],
    steps: [
      'Glisse jusqu\'aux cuisses parallèles au sol.',
      'Lève un pied de 5 cm, sans pencher le bassin.',
      'Tiens le temps prescrit, repose le pied, puis l\'autre jambe.',
    ],
    breath: 'Calme et régulière : ne bloque jamais.',
    feel: 'La cuisse d\'appui brûle ; le dos reste à plat contre le mur.',
    mistakes: ['Laisser le genou d\'appui rentrer vers l\'intérieur.', 'Pousser sur la cuisse avec la main.'],
    easier: 'Moins bas : genou à 120°.',
    harder: '10 secondes de plus.',
    cast: 'Rien à tenir : le bras plâtré contre toi.',
  },
  imagerie: {
    key: 'imagerie',
    name: 'Imagerie du bras plâtré',
    what: 'Allongé, les yeux fermés, tu imagines que tu plies le coude plâtré de toutes tes forces, sans contracter le bras.',
    cues: [
      'Allongé, les yeux fermés, le bras plâtré posé et mou.',
      'Imagine que tu plies le coude de toutes tes forces 5 s, sans contracter ; 5 s de repos.',
      'Une série sur deux, imagine que tu le tends.',
    ],
    where: ['maison'],
    equipment: 'Rien',
    why:
      'Le cerveau perd l\'habitude de commander un muscle immobilisé avant que le muscle ne fonde. Imaginer des ' +
      'contractions maximales, sans bouger, a réduit de moitié la perte de force d\'un poignet plâtré quatre ' +
      'semaines (Clark 2014).',
    steps: [
      'Allongé sur le dos, le bras plâtré posé sur le ventre, les yeux fermés.',
      'Imagine que tu plies le coude de toutes tes forces pendant 5 secondes : sens l\'effort dans ta tête, pas dans le bras.',
      'Relâche 5 secondes. 13 fois, puis 1 minute de pause.',
      'Quatre séries. Une sur deux, imagine que tu tends le coude.',
    ],
    breath: 'Calme ; ne bloque pas pendant l\'effort imaginé.',
    feel: 'Une concentration intense, et un bras qui reste mou.',
    mistakes: ['Contracter pour de vrai : si tu sens le muscle se tendre dans le plâtre, relâche.', 'Le faire en pensant à autre chose : c\'est l\'intensité de l\'effort imaginé qui compte.'],
    cast: 'Rien ne bouge dans le plâtre : seul le cerveau force.',
  },
  'test-mollets': {
    key: 'test-mollets',
    name: 'Test des mollets, sur un pied',
    what: 'Sur un pied, tu montes sur la pointe et tu redescends, au rythme d\'une montée toutes les 2 secondes, jusqu\'à ne plus pouvoir monter en entier.',
    cues: [
      'Sur un pied, les doigts posés au mur sans tirer.',
      'Une montée toutes les 2 s, au bip, tout en haut à chaque fois.',
      'Arrête quand tu ne montes plus en entier ou perds le rythme.',
    ],
    where: ['maison'],
    equipment: 'Un mur ; le métronome de la séance',
    why:
      'L\'endurance du mollet et du tendon d\'Achille, qui encaissent chaque foulée : c\'est le test de référence ' +
      '(Hébert-Losier 2017).',
    steps: [
      'Sur un pied, au sol, les doigts posés au mur à hauteur d\'épaule, sans tirer ; l\'autre pied levé.',
      'Monte tout en haut et redescends, une montée toutes les 2 secondes, au bip.',
      'Arrête quand tu ne montes plus en entier ou que tu perds le rythme : note le nombre.',
      'L\'autre jambe après 2 minutes.',
    ],
    feel: 'Le mollet brûle, puis lâche.',
    mistakes: ['Pousser sur le mur avec les doigts.', 'Monter à moitié pour faire durer : une montée incomplète ne compte pas.'],
    cast: 'Les doigts de la main valide au mur : ils rattrapent, ils ne tirent pas.',
    measure: { unit: 'répétitions', perSide: true, guide: 'métronome', beatS: 2, reference: 'Repère : environ 32 à ton âge (Hébert-Losier 2017).' },
  },
  'test-pont': {
    key: 'test-pont',
    name: 'Test du pont sur une jambe, talon sur le step',
    what: 'Sur le dos, un talon sur le step, l\'autre jambe vers le plafond : tu montes et redescends le bassin jusqu\'à ne plus pouvoir.',
    cues: [
      'Sur le dos, les bras croisés, un talon sur le step de 40 cm.',
      'L\'autre jambe tendue à la verticale.',
      'Monte le bassin, redescends effleurer le sol, sans pause, jusqu\'à ne plus pouvoir.',
    ],
    where: ['maison'],
    equipment: 'Le step à 40 cm (ou le tabouret), le tapis',
    why:
      'L\'endurance de l\'arrière des cuisses : faible, elle annonce les déchirures chez les sportifs qui courent ' +
      '(Freckleton 2014).',
    steps: [
      'Sur le dos, les bras croisés sur la poitrine, un talon sur le step, le genou un peu fléchi.',
      'L\'autre jambe tendue vers le plafond.',
      'Pousse dans le talon : le bassin monte ; redescends effleurer le sol, et repars.',
      'Jusqu\'à ne plus pouvoir monter : note le nombre. L\'autre jambe après 2 minutes.',
    ],
    feel: 'L\'arrière de la cuisse et la fesse brûlent.',
    mistakes: ['Pousser avec les bras.', 'Se reposer le bassin au sol entre deux répétitions.'],
    cast: 'Les bras croisés sur la poitrine, le plâtré dessous : il ne pousse pas.',
    measure: { unit: 'répétitions', perSide: true, reference: 'Sur un banc de 60 cm : moins de 20, faible ; plus de 30, bon (Freckleton 2014). Sur 40 cm, compare-toi à toi-même.' },
  },
  'test-chaise': {
    key: 'test-chaise',
    name: 'Test de la chaise contre le mur',
    what: 'Le dos au mur, les cuisses parallèles au sol, tu tiens le plus longtemps possible.',
    cues: [
      'Dos au mur, les cuisses parallèles au sol, les genoux au-dessus des chevilles.',
      'Lance le chrono ; tiens jusqu\'à ne plus pouvoir.',
      'Les mains ne touchent pas les cuisses.',
    ],
    where: ['maison'],
    equipment: 'Un mur, le chrono de la séance',
    why: 'L\'endurance des quadriceps qui tiennent : celle qui lâche en fin de descente.',
    steps: [
      'Dos au mur, glisse jusqu\'aux cuisses parallèles au sol.',
      'Lance le chrono.',
      'Arrête-le quand tu ne tiens plus la position : note le temps.',
    ],
    feel: 'Les cuisses brûlent, de plus en plus.',
    mistakes: ['Remonter un peu pour durer : la mesure ne vaut qu\'à la même hauteur.', 'Bloquer sa respiration.'],
    cast: 'Rien à tenir : le bras plâtré contre toi.',
    measure: { unit: 'secondes', perSide: false, guide: 'chrono' },
  },
  'test-gainage': {
    key: 'test-gainage',
    name: 'Test du gainage sur le côté',
    what: 'Sur le coude valide, le corps droit, tu tiens le plus longtemps possible.',
    cues: [
      'Sur le côté, le coude valide sous l\'épaule, le corps droit des pieds à la tête.',
      'Lance le chrono ; arrête quand le bassin tombe.',
    ],
    where: ['maison'],
    equipment: 'Le tapis, le chrono de la séance',
    why: 'L\'endurance du tronc qui tient le bassin quand la fatigue arrive.',
    steps: [
      'Allongé sur le côté du bras valide, le coude sous l\'épaule.',
      'Monte le bassin : la tête, le bassin et les pieds alignés. Lance le chrono.',
      'Arrête quand le bassin tombe : note le temps.',
    ],
    feel: 'Le côté du ventre et l\'épaule du dessous.',
    mistakes: ['Laisser le bassin partir en arrière pour durer.'],
    cast: 'Uniquement sur le coude valide. Le bras plâtré posé sur la hanche.',
    measure: { unit: 'secondes', perSide: false, guide: 'chrono' },
  },
  'test-equilibre': {
    key: 'test-equilibre',
    name: 'Test d\'équilibre, yeux fermés',
    what: 'Sur un pied, les yeux fermés, tu tiens le plus longtemps possible, une minute au plus.',
    cues: [
      'Dans un angle de mur, la main valide à 20 cm du mur.',
      'Sur un pied, ferme les yeux et lance le chrono.',
      'Arrête quand le pied bouge ou que l\'autre touche le sol : 60 s au plus.',
    ],
    where: ['maison'],
    equipment: 'Un angle de mur, le chrono de la séance',
    why: 'La cheville et la hanche qui corrigent sans les yeux : ce qu\'elles font dans un sentier, fatiguées.',
    steps: [
      'Dans un angle de mur, sur un pied, l\'autre pied levé de quelques centimètres.',
      'Ferme les yeux et lance le chrono.',
      'Arrête quand le pied d\'appui bouge, que l\'autre pied touche le sol ou que la main touche le mur : note le temps.',
      'Trois essais par jambe : note le meilleur.',
    ],
    feel: 'La cheville corrige sans arrêt.',
    mistakes: ['Le faire loin d\'un mur.'],
    cast: 'Toujours dans un angle de mur, du côté de la main valide.',
    measure: { unit: 'secondes', perSide: true, max: 60, guide: 'chrono' },
  },
  'test-cheville': {
    key: 'test-cheville',
    name: 'Test de la cheville, genou au mur',
    what: 'Face au mur, tu pousses le genou contre le mur, le talon au sol, et tu mesures jusqu\'où le pied peut reculer.',
    cues: [
      'Face au mur, un pied devant, le talon au sol.',
      'Pousse le genou contre le mur ; recule le pied tant que le genou touche encore.',
      'Mesure du gros orteil au mur.',
    ],
    where: ['maison'],
    equipment: 'Un mur, un mètre ruban',
    why:
      'La souplesse de la cheville : courte, elle reporte la charge sur le genou et le tendon d\'Achille dans ' +
      'les montées et les descentes.',
    steps: [
      'Face au mur, un pied devant, le gros orteil à 10 cm du mur ; l\'autre pied derrière.',
      'Avance le genou jusqu\'à toucher le mur, le talon collé au sol.',
      'Recule le pied d\'un centimètre à la fois, tant que le genou touche encore sans que le talon décolle.',
      'Mesure du gros orteil au mur : note la distance, puis l\'autre jambe.',
    ],
    feel: 'Un étirement au mollet et au tendon, jamais une douleur devant la cheville.',
    mistakes: ['Laisser le talon décoller.', 'Laisser le genou partir vers l\'intérieur.'],
    cast: 'La main valide au mur.',
    measure: { unit: 'cm', perSide: true, reference: 'Repère : 10 cm et plus.' },
  },
  'test-souplesse': {
    key: 'test-souplesse',
    name: 'Test de souplesse, debout',
    what: 'Debout, jambes tendues, tu te penches vers le sol et tu mesures la distance entre le bout des doigts et le sol.',
    cues: [
      'Debout, pieds joints, jambes tendues.',
      'Penche-toi lentement, les bras vers le sol, sans à-coup.',
      'Mesure du bout des doigts au sol : en négatif si tu ne touches pas.',
    ],
    where: ['maison'],
    equipment: 'Un mètre ruban',
    why: 'Ta chaîne postérieure, courte au test d\'effort (−1 cm) : la souplesse se mesure pour progresser.',
    steps: [
      'Debout, pieds joints, jambes tendues.',
      'Penche-toi lentement, le bras valide vers le sol ; tiens 2 secondes au plus bas.',
      'Mesure du bout des doigts au sol : −5 si les doigts restent à 5 cm au-dessus, +3 s\'ils descendent 3 cm plus bas.',
    ],
    feel: 'L\'arrière des cuisses et des mollets s\'étire.',
    mistakes: ['Plier les genoux.', 'Donner un à-coup pour gagner un centimètre.'],
    cast: 'Seul le bras valide descend ; le plâtré reste contre toi.',
    measure: { unit: 'cm', perSide: false, reference: 'Ton test d\'effort : −1 cm.' },
  },
  'reverse-nordic': {
    key: 'reverse-nordic',
    name: 'Bascule arrière à genoux',
    what: 'À genoux, le corps droit des genoux à la tête, tu te penches lentement en arrière, puis tu reviens : le devant des cuisses freine.',
    cues: [
      'À genoux sur le tapis plié, le dessus des pieds au sol.',
      'Le corps droit des genoux à la tête, les fesses serrées.',
      'Penche-toi en arrière en 3 s, reviens en 2 s. Jamais de main vers le sol.',
    ],
    where: ['maison'],
    equipment: 'Le tapis plié en deux sous les genoux',
    why:
      'Le quadriceps freine en s\'allongeant, la hanche ouverte — comme dans les longues descentes, où il lâche en ' +
      'premier. Peu d\'exercices le chargent à cette longueur sans haltère. Son nom anglais : « reverse Nordic ».',
    setup: [
      'À genoux sur le tapis plié, genoux écartés de la largeur des hanches, le dessus des pieds au sol.',
      'Le bras plâtré contre le ventre, la main valide sur la poitrine.',
      'Le corps droit des genoux à la tête : fesses serrées, le bassin ne casse pas.',
    ],
    steps: [
      'Penche-toi en arrière en 3 secondes, d\'un bloc, comme une planche qui bascule depuis les genoux.',
      'Va seulement jusqu\'où tu peux revenir sans casser au bassin : 20 à 30° au début.',
      'Reviens en 2 secondes en tirant avec le devant des cuisses.',
    ],
    breath: 'Inspire en partant en arrière, souffle en revenant.',
    feel: 'Le devant des cuisses brûle. Un étirement à l\'avant de la hanche est normal.',
    mistakes: [
      'Casser au bassin en s\'asseyant vers les talons : on perd l\'exercice.',
      'Partir trop loin les premières fois : les courbatures du lendemain sont fortes.',
    ],
    easier: 'Moins loin, plus lentement.',
    harder: 'Plus loin, puis 2 secondes tenues au point le plus bas.',
    cast:
      'Rien ne s\'appuie sur les mains. Si tu sens que tu ne reviendras pas, assieds-toi doucement sur les talons : ' +
      'jamais de main tendue vers le sol.',
  },
  'pousse-elastique': {
    key: 'pousse-elastique',
    name: 'Poussée à un bras, élastique dans le dos',
    what: 'Dos à la porte, tu pousses la poignée droit devant toi, comme un coup de poing lent, puis tu la ramènes.',
    cues: [
      'Dos à la porte, l\'accroche à hauteur de poitrine, deux élastiques.',
      'Pousse droit devant en 1 s, tiens 1 s, reviens en 2 s.',
      'Le buste ne tourne pas.',
    ],
    where: ['maison'],
    equipment: 'Le kit d\'élastiques : deux élastiques, une poignée, l\'accroche de porte',
    why:
      'La poitrine, l\'avant de l\'épaule et le triceps du bras valide : le pendant du tirage, pour une épaule ' +
      'équilibrée. Et le bras entraîné entretient l\'autre.',
    setup: [
      'L\'accroche à hauteur de poitrine ; dos à la porte, un pied devant l\'autre, à la distance où l\'élastique est déjà tendu coude plié.',
      'La poignée à côté de la poitrine, le coude un peu sous l\'épaule.',
    ],
    steps: [
      'Pousse droit devant en 1 seconde, jusqu\'au bras tendu sans le verrouiller.',
      'Tiens 1 seconde.',
      'Ramène en 2 secondes.',
    ],
    breath: 'Souffle en poussant.',
    feel: 'La poitrine et l\'arrière du bras.',
    mistakes: ['Tourner le buste pour pousser plus loin.', 'Hausser l\'épaule.'],
    easier: 'Un seul élastique, ou un pas en arrière.',
    harder: 'Un troisième élastique, ou un pas en avant.',
    cast: 'Le bras plâtré reste en écharpe ; le buste ne tourne pas, et c\'est aussi un gainage.',
  },
  'hip-thrust': {
    key: 'hip-thrust',
    name: 'Pont sur le canapé, sur une jambe (hip thrust)',
    what: 'Le haut du dos appuyé au bord du canapé, un pied au sol, tu montes le bassin jusqu\'à aligner les épaules, les hanches et le genou.',
    cues: [
      'Les omoplates sur le bord du canapé, un pied à plat au sol.',
      'Monte le bassin en 1 s : le buste à plat, le genou à angle droit.',
      'Tiens 2 s en serrant la fesse, redescends en 2 s sans poser.',
    ],
    where: ['maison'],
    equipment: 'Le canapé (ou un lit bas)',
    why:
      'Le fessier, moteur des montées, sur sa plus grande amplitude : plus de chemin qu\'un pont au sol, donc plus ' +
      'de travail sans charge.',
    setup: [
      'Assis au sol dos au canapé, les omoplates contre le bord de l\'assise.',
      'Un pied à plat devant toi, l\'autre jambe pliée en l\'air.',
      'Le bras valide posé sur l\'assise, le bras plâtré sur le ventre.',
    ],
    steps: [
      'Pousse dans le talon et monte le bassin en 1 seconde, jusqu\'au tronc à plat, le genou à angle droit.',
      'Tiens 2 secondes en serrant la fesse.',
      'Redescends en 2 secondes sans poser le bassin.',
    ],
    breath: 'Souffle en montant.',
    feel: 'La fesse de la jambe d\'appui, fort.',
    mistakes: [
      'Cambrer le bas du dos en haut : le menton vers la poitrine, les côtes rentrées.',
      'Pousser sur la pointe du pied.',
    ],
    easier: 'Les deux pieds au sol.',
    harder: '3 secondes tenues en haut, ou la série en continu sans poser le bassin.',
    cast: 'Le bras valide stabilise sur l\'assise ; le bras plâtré ne prend aucun appui.',
  },
  copenhague: {
    key: 'copenhague',
    name: 'Gainage des adducteurs (Copenhague)',
    what: 'Sur le côté, sur le coude valide, le genou du dessus posé sur le step : tu soulèves le bassin en serrant l\'intérieur de la cuisse.',
    cues: [
      'Sur le coude valide, le genou du dessus posé sur le step à 40 cm.',
      'Monte le bassin en 1 s : la tête, le bassin et le genou alignés.',
      'Redescends en 2 s.',
    ],
    where: ['maison'],
    equipment: 'Le step à 40 cm, le tapis',
    why:
      'Les adducteurs, l\'intérieur des cuisses, tiennent le bassin dans les dévers et les appuis de côté. Ce ' +
      'programme a réduit de 41 % les problèmes d\'aine chez des footballeurs (Harøy 2019).',
    setup: [
      'Allongé sur le côté du bras valide, le coude sous l\'épaule, l\'avant-bras au sol.',
      'Le genou de la jambe du dessus posé sur le step à 40 cm ; la jambe du dessous pliée au sol.',
      'Le bras plâtré posé sur la hanche.',
    ],
    steps: [
      'Monte le bassin en appuyant le genou du dessus sur le step, jusqu\'à aligner la tête, le bassin et le genou ; la jambe du dessous décolle.',
      'Redescends en 2 secondes.',
    ],
    breath: 'Souffle en montant.',
    feel: 'L\'intérieur de la cuisse du dessus, et le côté du ventre.',
    mistakes: ['Laisser le bassin partir en arrière.', 'Monter par à-coups.'],
    easier: 'La jambe du dessous reste au sol pour aider.',
    harder: 'La cheville, et non le genou, posée sur le step : le levier s\'allonge.',
    cast:
      'Uniquement sur le coude valide : seule la jambe du côté du plâtre travaille ici. L\'autre jambe fait le ' +
      'serrage de coussin.',
  },
  'adducteurs-coussin': {
    key: 'adducteurs-coussin',
    name: 'Serrage de coussin entre les genoux',
    what: 'Sur le dos, genoux pliés, un coussin entre les genoux : tu le serres le plus fort possible, puis tu relâches.',
    cues: [
      'Sur le dos, genoux pliés, un coussin ferme entre les genoux.',
      'Serre à fond 10 s, relâche 10 s.',
      'Respire pendant le serrage.',
    ],
    where: ['maison'],
    equipment: 'Un coussin ferme, le tapis',
    why: 'Les adducteurs des deux jambes à la fois, sans appui sur les bras : le complément de la Copenhague.',
    setup: ['Sur le dos, pieds à plat, un coussin plié entre les genoux.'],
    steps: ['Serre le coussin de toutes tes forces pendant 10 secondes.', 'Relâche 10 secondes.', 'Recommence.'],
    breath: 'Continue de respirer en serrant : souffle lentement.',
    feel: 'L\'intérieur des deux cuisses.',
    mistakes: ['Bloquer la respiration.', 'Décoller le bas du dos.'],
    easier: 'Serre à 70 %.',
    harder: 'En pont fessier, le bassin levé.',
    cast: 'Le bras plâtré posé sur le ventre.',
  },
  'mollets-iso': {
    key: 'mollets-iso',
    name: 'Mollet sous le cadre de porte (isométrie lourde)',
    what: 'Sur la pointe d\'un pied, la main valide à plat sous le haut d\'un cadre de porte : tu pousses le cadre vers le haut et le sol avec l\'avant du pied, aussi fort que tu peux, sans bouger.',
    cues: [
      'Sur un pied, à mi-hauteur sur la pointe, juste en retrait du cadre de porte.',
      'La main valide à plat sous le haut du cadre.',
      'Pousse le cadre et le sol à fond 3 s, relâche 3 s, sans bouger.',
    ],
    where: ['maison'],
    equipment: 'Un cadre de porte',
    why:
      'Une contraction proche du maximum, tenue 3 secondes, rend le tendon d\'Achille plus raide — et la course ' +
      'plus économique : environ 4 % d\'oxygène en moins chez des coureurs après 14 semaines (Albracht et ' +
      'Arampatzis 2013). Sans haltère, ta main contre le cadre est la charge.',
    setup: [
      'Debout sur un pied, juste en retrait du cadre de porte : la main valide atteint le haut du cadre devant toi, le coude plié.',
      'Monte à mi-hauteur sur la pointe : le talon à mi-chemin entre le sol et ton plus haut.',
    ],
    steps: [
      'Pousse le sol avec l\'avant du pied et le cadre avec la main : de plus en plus fort pendant 1 seconde, puis à fond pendant 3 secondes.',
      'Relâche 3 secondes, sans reposer le talon.',
      '4 poussées font une série ; 5 séries par jambe, 1 minute de pause.',
    ],
    breath: 'Souffle pendant la poussée ; ne bloque jamais.',
    feel: 'Le mollet se tend comme une corde ; rien ne bouge.',
    mistakes: [
      'Monter sur la pointe pendant la poussée : on reste à mi-hauteur.',
      'Bloquer la respiration : la tension monte, et le coude lance.',
    ],
    easier: 'Pousser à 70 %.',
    harder: 'L\'avant du pied sur le step à 20 cm, le talon plus bas que l\'avant du pied.',
    cast: 'Seule la main valide pousse ; si le coude plâtré lance pendant l\'effort, pousse moins fort.',
  },
  'pied-court': {
    key: 'pied-court',
    name: 'Pied court et orteils',
    what: 'Assis, le pied à plat : tu creuses la voûte du pied sans plier les orteils, puis tu lèves le gros orteil seul, puis les quatre autres.',
    cues: [
      'Assis, pieds nus à plat.',
      'Creuse la voûte : l\'avant du pied recule vers le talon, les orteils restent à plat. Tiens 5 s.',
      'Puis lève le gros orteil seul, puis les quatre autres.',
    ],
    where: ['maison'],
    equipment: 'Une chaise',
    why:
      'Les petits muscles du pied tiennent la voûte à chaque appui : un programme de renforcement du pied a réduit ' +
      'les blessures de course (Taddei 2020).',
    setup: ['Assis sur une chaise, pieds nus à plat sous les genoux.'],
    steps: [
      'Pied court : rapproche l\'avant du pied du talon en creusant la voûte ; les orteils restent longs et à plat. Tiens 5 secondes, 10 fois.',
      'Gros orteil seul : lève-le, les quatre autres restent au sol, 10 fois ; puis l\'inverse.',
      'Quand c\'est facile assis : debout, puis debout sur un pied.',
    ],
    breath: 'Libre.',
    feel: 'Sous la voûte, parfois une crampe légère au début : c\'est normal.',
    mistakes: ['Plier les orteils pour tricher.', 'Soulever le talon.'],
    easier: 'Regarde ton pied pendant que tu le fais.',
    harder: 'Debout, puis debout sur un pied.',
    cast: 'Rien à tenir.',
  },
  equilibre: {
    key: 'equilibre',
    name: 'Équilibre sur un pied, yeux fermés',
    what: 'Debout sur un pied dans un angle de mur, tu fermes les yeux et tu tiens.',
    cues: [
      'Dans un angle de mur, la main valide à 20 cm du mur.',
      'Sur un pied, le genou souple, ferme les yeux.',
      'Si tu perds l\'équilibre, la main touche le mur, puis reprends.',
    ],
    where: ['maison'],
    equipment: 'Un angle de mur ; le tapis plié pour plus difficile',
    why:
      'La cheville et la hanche corrigent sans les yeux : ce qu\'elles font dans un sentier technique, la nuit, ou ' +
      'fatiguées. Un plâtre change l\'équilibre : on le réapprend.',
    setup: [
      'Dans un angle de mur, le mur à 20 cm de ta main valide.',
      'Sur un pied, genou un peu fléchi, l\'autre pied levé de quelques centimètres.',
    ],
    steps: [
      'Ferme les yeux et tiens 30 secondes.',
      'Si tu perds l\'équilibre, la main valide touche le mur, puis tu reprends.',
      '3 fois par jambe.',
    ],
    breath: 'Calme et lente.',
    feel: 'La cheville et le pied corrigent sans arrêt.',
    mistakes: ['S\'appuyer au mur en continu.', 'Le faire loin d\'un mur : le plâtre interdit la chute.'],
    easier: 'Les yeux ouverts, le regard fixe.',
    harder: 'Sur le tapis plié en quatre ; puis en tournant lentement la tête.',
    cast: 'Toujours dans un angle de mur, du côté de la main valide. Jamais au milieu d\'une pièce.',
  },
};

/**
 * Les mots du programme, dits simplement. La page Exercices les explique avant
 * les fiches : rien ne doit être pris pour acquis (Pierre, le 05/10).
 */
export const EXERCISE_WORDS: { word: string; plain: string }[] = [
  { word: 'Répétition', plain: 'Un mouvement complet, aller et retour.' },
  { word: 'Série', plain: 'Des répétitions enchaînées sans pause. « 3 séries de 10 » : 10 mouvements, une pause, 10, une pause, 10.' },
  { word: 'Récupération', plain: 'La pause entre deux séries, en secondes ou en minutes.' },
  { word: 'Répétitions en réserve', plain: 'Celles que tu pourrais encore faire, propres, quand tu t\'arrêtes. « 3 en réserve » : tu t\'arrêtes trois avant de ne plus pouvoir.' },
  { word: 'Tempo', plain: 'La durée de chaque phase du mouvement. « 3 s pour descendre » se compte dans ta tête.' },
  { word: 'Freinage (excentrique)', plain: 'Le muscle travaille en s\'allongeant, comme la cuisse qui retient ton corps dans une descente.' },
  { word: 'Maintien (isométrique)', plain: 'Le muscle travaille sans bouger, comme dans la chaise contre le mur.' },
  { word: 'Fente', plain: 'Un grand pas, puis on descend le genou arrière vers le sol, le buste droit. Dans la fente bulgare, le pied arrière est surélevé.' },
  { word: 'Gainage', plain: 'Tenir le tronc solide : il ne se creuse pas, ne tourne pas, ne s\'affaisse pas.' },
  { word: 'Quadriceps', plain: 'Le gros muscle du devant de la cuisse : il tend le genou et freine les descentes.' },
  { word: 'Ischio-jambiers', plain: 'Les muscles de l\'arrière de la cuisse : ils plient le genou et freinent la jambe à chaque foulée.' },
  { word: 'Fessiers', plain: 'Les muscles des fesses : ils te poussent en montée. Le moyen fessier, sur le côté de la hanche, tient le bassin à l\'horizontale.' },
  { word: 'Mollet, soléaire', plain: 'Le mollet est l\'arrière de la jambe ; le soléaire est son muscle profond, celui qui porte le plus en course.' },
  { word: 'Tibial antérieur', plain: 'Le muscle du devant du tibia : il relève le pied et le pose en douceur.' },
  { word: 'Fléchisseurs de hanche', plain: 'Les muscles du pli de l\'aine : ils tirent la cuisse vers l\'avant, à chaque pas de montée.' },
  { word: 'Tendon d\'Achille', plain: 'Le tendon à l\'arrière de la cheville, qui relie le mollet au talon.' },
  { word: 'Bras valide', plain: 'Celui qui n\'est pas dans le plâtre. Le bras plâtré ne porte jamais rien.' },
  { word: 'Accroche de porte', plain: 'La sangle du kit : son cylindre se coince derrière la porte fermée, et l\'élastique s\'accroche à son crochet.' },
  { word: 'Mini-bande', plain: 'Un petit élastique en boucle, qu\'on passe autour des chevilles ou des pieds.' },
  { word: 'Zone 1, zone 2', plain: 'Des plages de fréquence cardiaque. En zone 1, tu parles sans effort ; en zone 2, tu parles en phrases courtes.' },
  { word: 'FC, bpm', plain: 'La fréquence cardiaque, en battements par minute : ce que mesure ta montre.' },
  { word: 'VO2max', plain: 'Le plus d\'oxygène que ton corps peut utiliser : la taille de ton moteur.' },
  { word: 'Seuil', plain: 'L\'effort le plus intense que tu tiens longtemps sans t\'emballer, autour d\'une heure en course.' },
  { word: 'PMA', plain: 'La puissance maximale aérobie : l\'effort où tu atteins ta VO2max, tenable cinq à six minutes.' },
  { word: 'Zone 3, zone 4', plain: 'Plus haut : en zone 3, tu parles par bouts de phrase ; en zone 4, ton seuil, quelques mots seulement.' },
  { word: 'Échec', plain: 'Le moment où tu ne peux plus faire une répétition propre. Debout sur une jambe, avec le plâtre, on ne va jamais jusque-là.' },
  { word: 'Hypertrophie', plain: 'Le muscle qui grossit. Elle vient du nombre de séries dures, finies près de l\'échec, et des protéines qui suivent.' },
  { word: 'Semaine allégée', plain: 'Moins de séries, la même technique : c\'est pendant elle que le travail des semaines dures devient de la force.' },
  { word: 'Adducteurs', plain: 'Les muscles de l\'intérieur de la cuisse : ils ramènent la jambe vers l\'autre et tiennent le bassin dans les dévers.' },
  { word: 'Step', plain: 'La marche sur laquelle tu montes : 20 ou 40 cm. Le tabouret de 40 cm fait le même travail, calé contre un mur.' },
  { word: 'Imagerie', plain: 'Imaginer un mouvement de toutes ses forces, sans le faire : le cerveau s\'entraîne, et le muscle immobilisé perd moins.' },
];

/**
 * Le bloc de force du 09/10 au 01/11, jour par jour.
 *
 * Le 09/10, Pierre : « je vais commencer le renforcement musculaire de façon
 * quotidienne, bien énervée, pour revenir encore plus puissant, plus musclé, et
 * combler des lacunes ». Tous les jours, mais jamais les mêmes muscles lourds
 * deux jours de suite : trois séances de force à 48 h l'une de l'autre, et
 * entre elles les tendons, le fractionné, la longue marche, la récupération.
 * Les séances du plan (`blockDay`, `@cairn/coach`) commencent par ces titres.
 */
export const FORCE_BLOCK_DAYS: { day: string; title: string; focus: string; why: string }[] = [
  {
    day: 'Lundi',
    title: 'Force 1 : genoux et freinage',
    focus: 'Fente bulgare, descente lente du step, bascule arrière à genoux, flexion sur serviette, chaise, mollet sous le cadre ; pousser et tirer avec le bras valide.',
    why: 'Les quadriceps qui freinent dans les descentes : ton aisance en descente, mesurée sur tes sorties, est à 0,68 de celle d\'un bon traileur — ta marge la plus nette.',
  },
  {
    day: 'Mardi',
    title: 'Tendons, pieds, gainage',
    focus: '40 min de marche, puis le mollet sous le cadre, les mollets en descente lente, les relevés de pointe, le pied court, l\'équilibre, le gainage.',
    why: 'Le tendon d\'Achille, le pied et la cheville encaissent chaque foulée : sans course, ce sont eux qui perdent le plus vite.',
  },
  {
    day: 'Mercredi',
    title: 'Force 2 : hanches et fessiers',
    focus: 'Bascule sur une jambe, pont sur le canapé, pas chassés, Copenhague, coussin, montée de genou, mollet sous le cadre ; le bras valide au maximum.',
    why: 'Les fessiers et l\'arrière des cuisses te poussent en montée ; les adducteurs et le moyen fessier tiennent le bassin quand la fatigue arrive.',
  },
  {
    day: 'Jeudi',
    title: 'Fractionné en côte',
    focus: 'Des montées rapides en marche dans les escaliers de Fourvière : 3 min, en zone 3 puis au seuil ; souplesse et gainage en rentrant.',
    why: 'L\'intensité garde la VO2max quand le volume baisse (Hickson). Pas sur le step : il ne monte pas le cœur jusqu\'au seuil.',
  },
  {
    day: 'Vendredi',
    title: 'Force 3 : une jambe, montées',
    focus: 'Montée explosive sur le step à 40 cm, chaise sur une jambe, bascule arrière, flexion sur serviette, Copenhague, mollet sous le cadre ; pousser et tirer ; montées continues.',
    why: 'La puissance, la force qui tient sur un pied, et l\'endurance des côtes : ce qui manque après trois heures de trail.',
  },
  {
    day: 'Samedi',
    title: 'Longue marche en côte',
    focus: 'Fourvière, la montée Saint-Barthélemy, la Sarra, les escaliers secs : de 1 h 30 à 2 h 15, jusqu\'à 650 m de dénivelé ; pied court et équilibre au retour.',
    why: 'La sortie longue devient marche : du temps debout, des montées, le moteur des trails longs.',
  },
  {
    day: 'Dimanche',
    title: 'Récupération',
    focus: 'Marche facile, souplesse longue, gainage léger.',
    why: 'La semaine s\'assimile : le muscle se construit entre les séances. Ta souplesse, courte au test d\'effort, ne gagne qu\'avec la régularité.',
  },
];

/** Les trois semaines du bloc, après les trois jours d'ouverture. */
export const FORCE_BLOCK_WEEKS: { dates: string; name: string; what: string }[] = [
  {
    dates: '9 au 11 octobre',
    name: 'Ouvrir',
    what: 'Les tests le vendredi, une longue marche le samedi, la récupération le dimanche.',
  },
  {
    dates: '12 au 18 octobre',
    name: 'Construire',
    what: '3 séries par jambe, 2 répétitions en réserve : apprendre les gestes, encaisser les courbatures.',
  },
  {
    dates: '19 au 25 octobre',
    name: 'Charger',
    what: 'Une série de plus, 1 répétition en réserve, les versions plus dures : la semaine qui fait progresser.',
  },
  {
    dates: '26 octobre au 1er novembre',
    name: 'Alléger',
    what: '2 séries, 3 en réserve, l\'intensité gardée : le travail devient de la force. Les tests le dimanche 1er novembre.',
  },
];
