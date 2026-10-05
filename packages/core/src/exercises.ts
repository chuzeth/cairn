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
  /** Les étapes, dans l'ordre où on les fait. */
  steps: string[];
  /** Ce qu'on doit sentir : le repère qui dit que c'est juste. */
  feel: string;
  /** Les erreurs qui reviennent. */
  mistakes: string[];
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
    equipment: 'Poulie, ou élastique accroché à hauteur de poitrine',
    why:
      'Le gainage qui sert en trail : empêcher le buste de tourner pendant qu\'une jambe pousse — sans aucun appui ' +
      'sur les bras.',
    steps: [
      'De profil à la poulie, pieds écartés, genoux légèrement fléchis.',
      'La main libre tient la poignée contre la poitrine.',
      'Tends le bras devant toi et tiens sans laisser le buste tourner.',
      'Pour l\'autre côté, tourne-toi : la poulie tire de l\'autre côté, toujours dans la main libre.',
    ],
    feel: 'Les abdominaux du côté opposé à la poulie.',
    mistakes: ['Laisser les hanches tourner.', 'Hausser l\'épaule.'],
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
    steps: [
      'Allongé sur le dos, genoux fléchis, pieds à plat.',
      'Tends une jambe dans le prolongement de la cuisse.',
      'Pousse dans le talon au sol et monte le bassin jusqu\'à aligner épaule, hanche et genou.',
      'Tiens 1 seconde en haut, redescends en 2 secondes.',
    ],
    feel: 'Le fessier de la jambe au sol, pas le bas du dos ni l\'arrière de la cuisse.',
    mistakes: ['Cambrer le dos en haut.', 'Laisser le bassin pencher d\'un côté.'],
    cast: 'Le bras plâtré posé sur ton ventre ou le long du corps, sans t\'y appuyer.',
  },
  chaise: {
    key: 'chaise',
    name: 'Chaise contre le mur',
    where: ['maison', 'salle'],
    equipment: 'Un mur',
    why: 'Un effort des quadriceps sans mouvement : il entretient la force et ménage les tendons.',
    steps: [
      'Dos contre le mur, pieds à 40 cm devant.',
      'Glisse jusqu\'à des genoux à angle droit — moins bas au début.',
      'Tiens le temps prescrit en respirant calmement.',
      'Remonte en t\'aidant de la main libre sur la cuisse.',
    ],
    feel: 'Les cuisses brûlent ; le dos reste à plat contre le mur.',
    mistakes: ['Bloquer sa respiration.', 'Laisser les genoux dépasser les pointes de pied.'],
    cast: 'Rien à tenir : le bras plâtré contre toi.',
  },
  'mollets-excentriques': {
    key: 'mollets-excentriques',
    name: 'Mollets excentriques sur une marche',
    where: ['maison', 'salle'],
    equipment: 'Une marche, un mur',
    why:
      'La descente lente sur une jambe renforce le tendon d\'Achille : c\'est le protocole qui soigne et prévient ' +
      'ses tendinopathies (Alfredson).',
    steps: [
      'L\'avant des pieds sur une marche, la main libre au mur.',
      'Monte sur les deux pointes.',
      'Passe sur une jambe et redescends en 3 secondes, talon sous la marche.',
      'Remonte sur les deux pieds. Une série jambe tendue, la suivante genou fléchi.',
    ],
    feel: 'Le mollet de la jambe qui descend, et un étirement franc en bas.',
    mistakes: ['Descendre vite.', 'Remonter sur une seule jambe : c\'est la descente qui compte.'],
    cast: 'La main libre au mur, toujours.',
  },
  'releves-pointe': {
    key: 'releves-pointe',
    name: 'Relevés de pointe',
    where: ['maison', 'salle'],
    equipment: 'Un mur',
    why: 'Le muscle devant le tibia freine chaque pose du pied en descente, et protège des douleurs au tibia.',
    steps: [
      'Dos et fesses contre le mur, talons à 30 cm devant.',
      'Lève les pointes de pied le plus haut possible, talons au sol.',
      'Redescends doucement.',
    ],
    feel: 'Le devant du tibia brûle vite : c\'est normal.',
    mistakes: ['Plier les genoux pour tricher.'],
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
    steps: [
      'Sur le côté du bras libre, coude sous l\'épaule, jambes tendues l\'une sur l\'autre.',
      'Monte le bassin jusqu\'à aligner tête, bassin et pieds.',
      'Tiens en respirant.',
    ],
    feel: 'Le côté du ventre et la hanche du dessous.',
    mistakes: ['Laisser le bassin tomber.', 'Avancer les fesses.'],
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
};
