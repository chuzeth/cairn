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
] as const;

export type ExerciseKey = (typeof EXERCISE_KEYS)[number];

export const isExerciseKey = (key: string): key is ExerciseKey => (EXERCISE_KEYS as readonly string[]).includes(key);

export interface ExerciseSheet {
  key: ExerciseKey;
  name: string;
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
}

export const EXERCISES: Record<ExerciseKey, ExerciseSheet> = {
  activation: {
    key: 'activation',
    name: 'Activation',
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
    name: 'Split squat bulgare',
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
    name: 'Extension de hanche au banc à 45°',
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
    name: 'Leg curl assis',
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
    name: 'Bras libre : développé, tirage, curl',
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
    name: 'Anti-rotation à une main',
    where: ['salle', 'maison'],
    equipment: 'Poulie, ou élastique long accroché à la porte à hauteur de poitrine',
    why:
      'Le gainage qui sert en trail : empêcher le buste de tourner pendant qu\'une jambe pousse — sans aucun appui ' +
      'sur les bras.',
    setup: [
      'À la maison : l\'ancrage dans la porte fermée, à hauteur de poitrine, côté charnières.',
      'De profil à la porte, à un grand pas : l\'élastique déjà tendu quand la main est contre la poitrine.',
    ],
    steps: [
      'De profil à la poulie, pieds écartés, genoux légèrement fléchis.',
      'La main libre tient la poignée contre la poitrine.',
      'Tends le bras devant toi et tiens sans laisser le buste tourner.',
      'Pour l\'autre côté, tourne-toi : la poulie tire de l\'autre côté, toujours dans la main libre.',
    ],
    breath: 'Souffle en tendant le bras, respire normalement pendant le maintien.',
    feel: 'Les abdominaux du côté opposé à la poulie.',
    mistakes: ['Laisser les hanches tourner.', 'Hausser l\'épaule.'],
    easier: 'Un pas plus près de la porte.',
    harder: 'Un pas plus loin, ou 5 secondes bras tendu.',
    cast: 'Le bras plâtré reste contre toi. Une seule main, mais les deux côtés : c\'est ton orientation qui change.',
  },
  'step-up': {
    key: 'step-up',
    name: 'Montée sur banc',
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
    harder: '15 secondes de plus ; puis une jambe tendue devant, 10 secondes chacune.',
    cast: 'Rien à tenir : le bras plâtré contre toi.',
  },
  'mollets-excentriques': {
    key: 'mollets-excentriques',
    name: 'Mollets excentriques sur une marche',
    where: ['maison', 'salle'],
    equipment: 'Une marche d\'escalier avec sa rampe, ou un step contre un mur',
    why:
      'La descente lente sur une jambe renforce le tendon d\'Achille et le mollet, qui encaissent chaque foulée : ' +
      'c\'est le protocole qui soigne et prévient ses tendinopathies (Alfredson). Trois semaines sans courir les ' +
      'déchargent ; c\'est lui qui les garde prêts.',
    setup: [
      'L\'avant des deux pieds sur la marche, talons dans le vide, la main libre sur la rampe.',
      'Genou tendu pour le mollet ; genou fléchi de 20 à 30° pour le soléaire, le muscle profond qui porte le plus en course.',
    ],
    steps: [
      'Monte sur les deux pointes, en 1 seconde.',
      'Passe sur une jambe : soulève l\'autre pied.',
      'Redescends en 3 secondes, jusqu\'au talon nettement sous la marche.',
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
    cast: 'La main libre sur la rampe, toujours : un faux pas sur une marche se rattrape avec elle.',
  },
  'releves-pointe': {
    key: 'releves-pointe',
    name: 'Relevés de pointe',
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
    name: 'Abduction debout, face au mur',
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
    name: 'Dead bug, jambes seules',
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
    name: 'Gainage latéral sur le coude libre',
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
    where: ['dehors'],
    equipment: 'De l\'eau, ton téléphone, ta montre au poignet libre',
    why:
      'La sortie longue du traileur qui ne court pas : du temps debout, du dénivelé, et l\'habitude de monter fort ' +
      'en marchant — la moitié d\'un trail.',
    steps: [
      'Des montées revêtues et des escaliers secs : montée Saint-Barthélemy, montée du Gourguillon, escaliers de Fourvière.',
      'Monte en marche active, sans dépasser la FC prescrite.',
      'Redescends lentement, la main libre sur la rampe des escaliers.',
    ],
    feel: 'Les montées essoufflent sans brûler ; les descentes se font sans à-coups.',
    mistakes: ['Courir les descentes.', 'Prendre un sentier glissant pour « faire trail ».'],
    cast:
      'Une chute sur le bras plâtré coûterait des semaines : pas de sentier technique, pas de marches mouillées, ' +
      'pas de descente rapide. L\'écharpe si la marche fait lancer le coude.',
  },
  'soins-bras': {
    key: 'soins-bras',
    name: 'Soins du bras plâtré',
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
    name: 'Fente bulgare, pied arrière sur le canapé',
    where: ['maison'],
    equipment: 'Un canapé ou une chaise (40 à 45 cm), un encadrement de porte',
    why:
      'Le meilleur exercice de jambes qui se fasse chez soi : sur une jambe, ton poids devient la charge. Il ' +
      'entretient les quadriceps et les fessiers qui te font monter, et qui freinent en descente.',
    setup: [
      'Dos au canapé, à une grande enjambée devant lui, l\'encadrement de porte à portée de la main libre.',
      'Pose le dessus du pied arrière, les lacets, sur le bord de l\'assise.',
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
    harder: '2 secondes tenues en bas, puis 4 pour descendre ; ensuite le gilet lesté.',
    cast:
      'La main libre sur l\'encadrement suffit à l\'équilibre. Le bras plâtré reste en écharpe : ne le lève pas ' +
      'pour compenser.',
  },
  'leg-curl-serviette': {
    key: 'leg-curl-serviette',
    name: 'Leg curl glissé, les talons sur une serviette',
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
    where: ['maison'],
    equipment: 'Un élastique long de 15 kg, un ancrage de porte',
    why:
      'Le dos et l\'arrière de l\'épaule du bras libre, pour la posture des longues montées. Et un bras entraîné ' +
      'entretient la force de l\'autre, immobilisé.',
    setup: [
      'L\'ancrage dans la porte fermée à clé, à hauteur de poitrine, côté charnières.',
      'Face à la porte, pieds décalés, genoux souples, à la distance où l\'élastique est déjà tendu bras tendu.',
    ],
    steps: [
      'Tire le coude vers l\'arrière, le long des côtes, en 1 seconde, en serrant l\'omoplate vers la colonne.',
      'Tiens 1 seconde, la main contre les côtes.',
      'Rends en 2 secondes, jusqu\'au bras tendu.',
    ],
    breath: 'Souffle en tirant.',
    feel: 'Entre l\'omoplate et la colonne, et l\'arrière de l\'épaule.',
    mistakes: ['Tourner le buste pour tirer plus fort.', 'Hausser l\'épaule vers l\'oreille.', 'Lâcher le retour.'],
    easier: 'Un pas plus près de la porte.',
    harder: 'Un pas plus loin, ou l\'élastique de 25 kg.',
    cast: 'Le bras plâtré reste en écharpe ; le buste ne tourne pas pour compenser, et c\'est aussi un gainage.',
  },
  'bras-elastique': {
    key: 'bras-elastique',
    name: 'Bras libre : curl, triceps, serrage',
    where: ['maison'],
    equipment: 'L\'élastique long, l\'ancrage de porte, une balle de tennis ou une serviette roulée',
    why:
      'Entraîner le bras libre entretient le bras plâtré par le système nerveux : après une fracture du poignet, ' +
      'ceux qui entraînaient la main saine avaient plus de force du côté fracturé à 12 semaines (Magnus 2013). ' +
      'Pour un coude, ce sont les fléchisseurs, les extenseurs et la poigne qui comptent.',
    setup: [
      'Curl : debout sur l\'élastique, le pied du côté du bras libre, la main dans la boucle.',
      'Triceps : l\'ancrage en haut de la porte, face à elle.',
      'Serrage : la balle ou la serviette roulée dans la main libre.',
    ],
    steps: [
      'Curl : le coude collé au flanc, monte la main vers l\'épaule en 1 seconde, redescends en 3.',
      'Triceps : le coude collé au flanc, plié à angle droit ; pousse la main vers la cuisse en 1 seconde, remonte en 3.',
      'Serrage : serre à fond 5 secondes, relâche 5 secondes, 10 fois.',
      'Enchaîne les trois, deux tours.',
    ],
    breath: 'Souffle à l\'effort, jamais en apnée.',
    feel: 'Le devant du bras pour le curl, l\'arrière pour le triceps, l\'avant-bras pour le serrage.',
    mistakes: ['Balancer le buste.', 'Décoller le coude du flanc.'],
    easier: 'Plus de mou dans l\'élastique.',
    harder: 'L\'élastique de 25 kg, ou 4 secondes pour rendre.',
    cast: 'L\'autre bras ne fait rien ; garde l\'écharpe si le coude lance.',
  },
  'descente-marche': {
    key: 'descente-marche',
    name: 'Descente lente d\'une marche',
    where: ['maison', 'dehors'],
    equipment: 'Une marche d\'escalier (17 à 20 cm) avec sa rampe',
    why:
      'La descente de trail au ralenti : le quadriceps qui freine en s\'allongeant. C\'est lui qui lâche en fin de ' +
      'course quand on ne l\'a pas préparé, et lui qui protège le genou.',
    setup: [
      'Face à la descente, sur la deuxième marche, la main libre sur la rampe.',
      'Le pied d\'appui entier sur la marche ; l\'autre jambe tendue dans le vide, devant.',
    ],
    steps: [
      'Plie le genou d\'appui en 4 secondes, les hanches en arrière comme pour t\'asseoir.',
      'Le talon libre effleure la marche du dessous, sans s\'y poser.',
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
    easier: 'La première marche, ou la moitié du chemin.',
    harder: '5 secondes pour descendre, puis une marche de plus.',
    cast:
      'La rampe du côté du bras libre : choisis l\'escalier, ou le sens, qui la met de ce côté. Les deux jambes ' +
      'travaillent sans que tu te retournes. Jamais sur une marche mouillée.',
  },
  'souleve-une-jambe': {
    key: 'souleve-une-jambe',
    name: 'Soulevé de terre sur une jambe',
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
    name: 'Montée de genou contre la mini-bande',
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
};
