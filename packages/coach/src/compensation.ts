import type {
  ExerciseKey, PhysiologyModel, PlanRevision, PlannedSession, SessionBlock, SessionDecision, SessionType, ZoneKey,
} from '@cairn/core';
import * as db from '@cairn/db';
import { buildZones, hrProvenanceOf } from '@cairn/physiology';
import { addDays, mondayOf } from './periodization.js';
import { withHistory } from './presentation.js';
import { sessionTitle, sessionTotals, type SessionTemplate } from './sessionLibrary.js';
import { currentModel } from './state.js';

/**
 * Le programme de compensation : quand la course est interdite.
 *
 * Le 03/10, Pierre se casse le coude en vélo : plâtre ou attelle rigide, rien
 * d'autre de touché, une salle de sport et les montées de Fourvière à portée.
 * Il veut du sport tous les jours et perdre le moins possible. Le programme
 * tient sur ce que la littérature dit d'un arrêt de course :
 *
 *  · la VO2max baisse de 4 à 14 % en deux à quatre semaines d'arrêt complet,
 *    mais se conserve quand l'intensité est gardée, même avec un volume réduit
 *    des deux tiers (Mujika & Padilla 2000 ; Hickson 1981, 1985) : un
 *    fractionné par semaine, sur stepper ou vélo ;
 *  · le renforcement lourd améliore l'économie de course et la vitesse en fin
 *    d'épreuve (Blagrove et al. 2018) : deux séances par semaine, jambes et
 *    appuis, que le plâtre n'empêche pas ;
 *  · entraîner le bras sain limite la fonte du bras immobilisé (Magnus et al.
 *    2013, fracture du poignet) ;
 *  · la marche en côte garde le moteur aérobie et les muscles des montées sans
 *    impact ; la sortie longue devient une marche dans les escaliers de
 *    Fourvière.
 *
 * Rien n'y demande d'appui sur le bras plâtré, ni de prise à deux mains, ni de
 * terrain où l'on tombe. Chaque exercice renvoie à sa fiche
 * (`@cairn/core/exercises`). Aucune séance ne part sur la montre : elle ne sait
 * pas exécuter un renforcement, et une marche se lance de son propre menu.
 */

/** La semaine du programme : remise en route, construction, charge, allégement. */
export type CompensationWeek = 1 | 2 | 3 | 4;

/** Ce que chaque semaine demande. */
interface Dose {
  /** Séries des exercices principaux. */
  sets: number;
  /** Répétitions gardées en réserve à la fin de chaque série. */
  reserve: number;
  /** Charge des exercices sur une jambe : sans, puis l'haltère dans la main libre. */
  loaded: boolean;
  /** Marche en côte sur tapis, min. */
  treadmillMin: number;
  /** Sortie longue dehors, min, et son dénivelé. */
  longMin: number;
  longVertM: number;
  /** Le fractionné de la semaine. */
  intervals: { reps: number; workS: number; restS: number; zone: ZoneKey };
  /** Gainage et chaise, s. */
  holdS: number;
}

const DOSE: Record<CompensationWeek, Dose> = {
  1: {
    sets: 3, reserve: 3, loaded: false, treadmillMin: 40, longMin: 90, longVertM: 350, holdS: 30,
    intervals: { reps: 4, workS: 300, restS: 120, zone: 'Z3' },
  },
  2: {
    sets: 4, reserve: 2, loaded: true, treadmillMin: 50, longMin: 120, longVertM: 550, holdS: 40,
    intervals: { reps: 5, workS: 300, restS: 120, zone: 'Z4' },
  },
  3: {
    sets: 4, reserve: 1, loaded: true, treadmillMin: 60, longMin: 150, longVertM: 750, holdS: 45,
    intervals: { reps: 6, workS: 180, restS: 120, zone: 'Z5' },
  },
  4: {
    sets: 3, reserve: 3, loaded: true, treadmillMin: 40, longMin: 90, longVertM: 350, holdS: 30,
    intervals: { reps: 3, workS: 300, restS: 120, zone: 'Z4' },
  },
};

/** Ce qui se dit de la réserve : « 2 répétitions en réserve ». */
const reserveText = (n: number) => `${n} répétition${n > 1 ? 's' : ''} en réserve`;

/** Un bloc piloté au cœur, sans allure : rien de tout cela ne se court. */
function heart(
  model: PhysiologyModel,
  label: string,
  zone: ZoneKey,
  durationS: number,
  extra: Partial<SessionBlock> = {},
): SessionBlock {
  const z = buildZones(model).find((x) => x.key === zone)!;
  return {
    label,
    zone,
    durationS,
    hrRange: [zone === 'Z1' ? 0 : Math.round(z.hrMin), Math.round(z.hrMax)],
    provenance: { hr: hrProvenanceOf(z) },
    ...extra,
  };
}

/**
 * Un exercice : `sets` séries de `reps`, un repos entre elles. Sa consigne est un
 * effort — une réserve de répétitions —, ni une FC ni une allure.
 */
function lift(
  exercise: ExerciseKey,
  label: string,
  sets: number,
  reps: number,
  restS: number,
  effort: string,
  notes: string,
  setS = 45,
): SessionBlock {
  return {
    label,
    zone: 'Z3',
    durationS: setS,
    repeat: sets,
    reps,
    exercise,
    effort,
    notes,
    recovery: { durationS: restS, zone: 'Z1', active: false, betweenReps: true },
  };
}

/** Un maintien : `sets` fois `holdS` secondes. */
function hold(exercise: ExerciseKey, label: string, sets: number, holdS: number, restS: number, notes: string): SessionBlock {
  return {
    label,
    zone: 'Z2',
    durationS: holdS,
    repeat: sets,
    exercise,
    effort: 'Tenir sans trembler',
    notes,
    recovery: { durationS: restS, zone: 'Z1', active: false, betweenReps: true },
  };
}

/** Les soins du bras et la respiration : chaque jour, quelle que soit la séance. */
function daily(): SessionBlock[] {
  return [
    {
      label: 'Soins du bras plâtré', kind: 'mobility', zone: 'Z1', durationS: 300, exercise: 'soins-bras',
      notes: 'Doigts, pouce, épaule : 3 à 4 fois dans la journée, pas seulement ici.',
    },
    {
      label: 'Respiration', kind: 'respiratory', zone: 'Z1', durationS: 600, exercise: 'respiration',
      notes:
        'Avec l\'appareil : 30 inspirations le matin, 30 le soir. Sans : 5 min à 4 s / 6 s puis 5 min à 4 s / 8 s, ' +
        'allongé.',
    },
  ];
}

function souplesse(durationS = 600): SessionBlock {
  return {
    label: 'Souplesse chaîne postérieure', kind: 'mobility', zone: 'Z1', durationS, exercise: 'souplesse',
    notes: 'Ischio-jambiers à la sangle, mollets au mur, avant de la hanche : 45 s, deux fois.',
  };
}

function template(
  model: PhysiologyModel,
  key: string,
  type: SessionType,
  format: string,
  intent: string,
  blocks: SessionBlock[],
): SessionTemplate {
  const loss = blocks.reduce((a, b) => a + (b.elevationLossM ?? 0) * (b.repeat ?? 1), 0);
  const totals = sessionTotals(model, blocks, loss);
  return {
    key,
    type,
    title: sessionTitle(format, type, blocks),
    intent,
    priority: 'key',
    phases: ['transition'],
    blocks,
    durationS: totals.durationS,
    elevationGainM: totals.elevationGainM,
    elevationLossM: loss,
    plannedDistanceM: 0,
    plannedLoad: totals.load,
    plannedMechanicalLoad: totals.mechanicalLoad,
  };
}

/** Deux jours après la chute : remettre le corps en mouvement sans rien demander au bras. */
export function compensationRestart(model: PhysiologyModel): SessionTemplate {
  return template(model, 'compensation_restart', 'cross_training', 'Remise en route',
    'Deux jours après la chute : remettre le corps en mouvement, sans rien demander au bras.',
    [
      heart(model, 'Marche facile, à plat', 'Z1', 40 * 60, {
        exercise: 'marche',
        notes:
          'Bras en écharpe contre toi. Tu dois pouvoir parler sans effort. Si le coude lance ou gonfle, rentre et ' +
          'surélève-le.',
      }),
      souplesse(),
      ...daily(),
    ]);
}

/** Force A — jambes, à la salle : la force maximale, et le bras libre. */
export function compensationForceA(model: PhysiologyModel, week: CompensationWeek): SessionTemplate {
  const d = DOSE[week];
  const effort = `Lourd : ${reserveText(d.reserve)}`;
  return template(model, `compensation_force_a_${week}`, 'strength', 'Force A, jambes',
    'Entretenir la force des jambes, qui fait l\'économie de course et protège les tendons — et celle du bras ' +
      'plâtré, par son voisin.',
    [
      heart(model, 'Échauffement : vélo ou marche inclinée', 'Z2', 8 * 60, {
        exercise: 'intervalles',
        notes: 'Vélo couché sans les mains, ou tapis à 10 %. Monte doucement jusqu\'à respirer un peu plus fort.',
      }),
      {
        label: 'Activation', zone: 'Z1', durationS: 300, exercise: 'activation',
        notes: '10 ponts fessiers, 8 fentes arrière par jambe main libre au mur, 10 montées sur pointes.',
      },
      lift('presse', 'Presse à cuisses', d.sets, week === 3 ? 6 : 8, 120, effort,
        '3 s pour descendre jusqu\'à l\'angle droit, 1 s pour pousser. Seule la main libre touche la machine.'),
      lift('split-squat-bulgare', `Split squat bulgare, ${d.sets} séries par jambe`, d.sets * 2, week === 3 ? 6 : 8, 60, effort,
        d.loaded
          ? 'L\'haltère dans la main libre, à côté d\'un rack. Descente en 3 s. Les deux jambes en alternance.'
          : 'Sans charge cette semaine, la main libre sur un rack. Descente en 3 s. Les deux jambes en alternance.',
        40),
      lift('extension-hanche', 'Extension de hanche au banc à 45°', 3, 10, 90, 'Contrôlé',
        'Bras croisés sur la poitrine, le plâtré dessous. Remonte en serrant les fessiers, sans te cambrer.'),
      lift('leg-curl', 'Leg curl assis', 3, 10, 90, 'Freine 3 s au retour',
        'C\'est la descente lente qui prépare les ischios à freiner la foulée.'),
      lift('mollets-machine', 'Mollets à la machine', 4, 12, 60, 'Pause 1 s en bas',
        'Machine assise de préférence. 1 s pour monter, 3 s pour descendre, talons sous la marche.'),
      lift('bras-libre', 'Bras libre : développé, tirage, curl', 3, 10, 60, 'Moyen : 3 répétitions en réserve',
        'Une série de chaque, trois tours. Le bras sain entretient la force du bras plâtré.', 90),
      hold('anti-rotation', 'Anti-rotation à une main, 3 par côté', 6, d.holdS, 30,
        'Poulie ou élastique, main libre. Trois maintiens de chaque côté : tourne-toi pour changer.'),
      ...daily(),
    ]);
}

/** Force B — les appuis : un pied, une hanche, une cheville à la fois. */
export function compensationForceB(model: PhysiologyModel, week: CompensationWeek): SessionTemplate {
  const d = DOSE[week];
  const effort = `Appuyé : ${reserveText(d.reserve)}`;
  return template(model, `compensation_force_b_${week}`, 'strength', 'Force B, appuis',
    'Les appuis du trail : un pied, une hanche, une cheville à la fois — ce que la course ne travaille plus.',
    [
      heart(model, 'Échauffement : vélo, tapis ou escaliers', 'Z2', 8 * 60, {
        exercise: 'marche-tapis',
        notes: 'Monte doucement jusqu\'à respirer un peu plus fort. À la maison : les escaliers de l\'immeuble.',
      }),
      lift('step-up', `Montée sur banc, ${d.sets} séries par jambe`, d.sets * 2, 8, 45, effort,
        d.loaded
          ? 'Banc à hauteur de genou, l\'haltère dans la main libre. Redescends en 3 s.'
          : 'Banc à hauteur de genou, sans charge cette semaine. Redescends en 3 s.',
        40),
      lift('pont-une-jambe', 'Pont fessier sur une jambe, 3 séries par jambe', 6, 10, 45, effort,
        'Pousse dans le talon, tiens 1 s en haut. Trois séries de chaque côté.', 40),
      hold('chaise', 'Chaise contre le mur', 3, d.holdS + 15, 60,
        'Genoux à angle droit, dos à plat. Respire calmement.'),
      lift('mollets-excentriques', 'Mollets excentriques, 3 séries par jambe', 6, 12, 45, 'Descente en 3 s',
        'Main libre au mur. Une série jambe tendue, la suivante genou fléchi, de chaque côté.', 40),
      lift('releves-pointe', 'Relevés de pointe', 3, 15, 45, 'Jusqu\'à la brûlure',
        'Dos au mur, talons à 30 cm devant.', 30),
      lift('abduction', 'Abduction debout, 3 séries par jambe', 6, 15, 30, 'Lent',
        'Face au mur, la main libre dessus, mini-bande aux chevilles. Trois séries de chaque côté.', 40),
      lift('dead-bug', 'Dead bug, jambes seules', 3, 12, 45, 'Dos plaqué',
        'Une jambe puis l\'autre, 3 s pour descendre le talon.', 40),
      hold('gainage-lateral', 'Gainage latéral sur le coude libre', 3, d.holdS, 45,
        'Du côté du bras libre seulement ; plus facile genoux au sol.'),
      ...daily(),
    ]);
}

/** Marche en côte sur tapis : le moteur aérobie, sans impact ni bras. */
export function compensationTreadmill(model: PhysiologyModel, week: CompensationWeek, withMobility = false): SessionTemplate {
  const d = DOSE[week];
  const minutes = withMobility ? d.treadmillMin - 10 : d.treadmillMin;
  return template(model, `compensation_treadmill_${week}${withMobility ? '_m' : ''}`, 'cross_training',
    'Marche en côte sur tapis',
    'Garder le moteur aérobie et les muscles des montées, sans impact et sans les bras.',
    [
      heart(model, 'Échauffement à plat', 'Z1', 300, {
        exercise: 'marche-tapis', notes: '5 km/h, pente 0 %. Clé de sécurité attachée à ton vêtement.',
      }),
      heart(model, 'Marche en côte', 'Z2', (minutes - 10) * 60, {
        exercise: 'marche-tapis',
        notes:
          'Pente 10 à 15 %, 5 à 6 km/h, sans te tenir aux barres. Ajuste pour rester dans la plage. Toutes les ' +
          '10 min, une minute à inspirer sur 3 pas et expirer sur 3 pas.',
      }),
      heart(model, 'Retour au calme à plat', 'Z1', 300, { exercise: 'marche-tapis' }),
      ...(withMobility ? [souplesse()] : []),
      ...daily(),
    ]);
}

/**
 * Le fractionné de la semaine, sur stepper ou vélo : l'intensité, ce qui
 * conserve la VO2max quand le volume baisse.
 */
export function compensationIntervals(model: PhysiologyModel, week: CompensationWeek): SessionTemplate {
  const { reps, workS, restS, zone } = DOSE[week].intervals;
  const name = zone === 'Z5' ? 'en PMA' : zone === 'Z4' ? 'au seuil' : 'en tempo';
  const feel = zone === 'Z5' ? '9 sur 10, quelques mots' : zone === 'Z4' ? '7 sur 10, phrases courtes' : '6 sur 10';
  return template(model, `compensation_intervals_${week}`, 'cross_training', `Intervalles ${name}`,
    'L\'intensité est ce qui conserve la VO2max quand le volume baisse : un fractionné par semaine suffit.',
    [
      heart(model, 'Échauffement progressif', 'Z2', 600, {
        exercise: 'intervalles', notes: 'Stepper sans t\'y suspendre, ou vélo couché sans les mains.',
      }),
      {
        ...heart(model, `Répétitions ${name}`, zone, workS, {
          exercise: 'intervalles',
          notes:
            `Effort ${feel}. Sur le vélo, la FC monte 5 à 10 bpm moins haut qu'en courant : vise la sensation. ` +
            'Pas de rameur ni d\'elliptique : ils demandent les deux bras.',
        }),
        repeat: reps,
        recovery: { durationS: restS, zone: 'Z1', active: true, betweenReps: true },
      },
      heart(model, 'Retour au calme', 'Z1', 600, { exercise: 'intervalles' }),
      ...daily(),
    ]);
}

/** La sortie longue devenue marche : du temps debout et du dénivelé, à Fourvière. */
export function compensationLongHike(model: PhysiologyModel, week: CompensationWeek): SessionTemplate {
  const d = DOSE[week];
  return template(model, `compensation_long_${week}`, 'cross_training', 'Marche en côte dehors',
    'Remplacer la sortie longue : du temps debout, du dénivelé, le cœur en endurance — et monter fort en ' +
      'marchant, la moitié d\'un trail.',
    [
      heart(model, 'Montées et escaliers de Fourvière', 'Z2', d.longMin * 60, {
        exercise: 'marche-cote',
        elevationGainM: d.longVertM,
        elevationLossM: d.longVertM,
        notes:
          'Montée Saint-Barthélemy, Gourguillon, escaliers de Fourvière : revêtu et sec. Monte sans dépasser le ' +
          'haut de la plage ; redescends lentement, main libre sur la rampe. Pas de sentier technique.',
      }),
      ...daily(),
    ]);
}

/** Récupération active : marche facile, souplesse, et la semaine qui s'assimile. */
export function compensationRecovery(model: PhysiologyModel): SessionTemplate {
  return template(model, 'compensation_recovery', 'cross_training', 'Récupération active',
    'Laisser la semaine s\'assimiler, et entretenir la souplesse que le test dit courte.',
    [
      heart(model, 'Marche facile, à plat', 'Z1', 45 * 60, {
        exercise: 'marche', notes: 'Quais, parc de la Tête d\'Or : tu dois pouvoir parler tout du long.',
      }),
      souplesse(900),
      ...daily(),
    ]);
}

/**
 * Le jour `dayIndex` du programme (0 = son premier jour, un lundi) : sept
 * séances par semaine, deux de force espacées de 72 h, un fractionné, une
 * sortie longue le samedi, une récupération le dimanche. La première semaine
 * commence par une remise en route.
 */
export function compensationDay(model: PhysiologyModel, dayIndex: number): SessionTemplate {
  const week = Math.min(4, Math.floor(dayIndex / 7) + 1) as CompensationWeek;
  const dow = dayIndex % 7;
  if (week === 1) {
    return [
      () => compensationRestart(model),
      () => compensationForceA(model, 1),
      () => compensationTreadmill(model, 1),
      () => compensationIntervals(model, 1),
      () => compensationForceB(model, 1),
      () => compensationLongHike(model, 1),
      () => compensationRecovery(model),
    ][dow]!();
  }
  return [
    () => compensationForceA(model, week),
    () => compensationTreadmill(model, week),
    () => compensationIntervals(model, week),
    () => compensationForceB(model, week),
    () => compensationTreadmill(model, week, true),
    () => compensationLongHike(model, week),
    () => compensationRecovery(model),
  ][dow]!();
}

// ─────────────────────────────────────────────────────────────────────────────
// La semaine à la maison
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Le 05/10, Pierre : « cette semaine, je vais faire principalement de la
 * marche tranquille et des exercices chez moi tout seul, simplement avec un
 * élastique […] et un tapis au sol ». La semaine 1 se refait sans salle : deux
 * séances de force au poids du corps et à l'élastique, à 72 h d'écart, et de la
 * marche tranquille les autres jours. Sur une jambe, le poids du corps est une
 * vraie charge ; le tempo lent et la réserve de 3 répétitions font le reste.
 */

/** L'échauffement des deux séances maison. */
function homeWarmUp(model: PhysiologyModel): SessionBlock {
  return heart(model, 'Échauffement', 'Z1', 360, {
    exercise: 'echauffement-maison',
    notes: '1 min de marche sur place, 10 assis-debout, 10 ponts, 10 montées sur pointes, 5 fentes arrière par jambe.',
  });
}

/**
 * Ce qui se fait sans le kit d'élastiques, s'il n'est pas encore arrivé : le
 * 05/10, Pierre l'attend pour le lendemain, jour de la séance A.
 */
const WITHOUT_KIT = 'Sans le kit :';

/** Force A à la maison : les jambes lourdes, et le bras valide. */
export function compensationHomeA(model: PhysiologyModel, week: CompensationWeek): SessionTemplate {
  const d = DOSE[week];
  const effort = `Appuyé : ${reserveText(d.reserve)}`;
  return template(model, `compensation_home_a_${week}`, 'strength', 'Force A à la maison',
    'Entretenir la force des jambes sans salle : une jambe à la fois, ton poids pour charge, le tempo lent pour ' +
      'intensité — et le bras valide, qui entretient l\'autre.',
    [
      homeWarmUp(model),
      lift('split-squat-maison', `Fente bulgare, ${d.sets} séries par jambe`, d.sets * 2, 10, 45, effort,
        'Pied arrière sur le tabouret calé contre un mur (ou le canapé), main valide sur l\'encadrement. 3 s pour ' +
          'descendre, 1 s en bas, 1 s pour monter. Plus de 3 en réserve à la fin de la première série : ajoute 2 s ' +
          'tenues en bas.',
        50),
      lift('leg-curl-serviette', 'Flexion des jambes sur serviette', d.sets, 6, 90, 'Freine 4 s',
        'Talons sur la serviette, sur le parquet. Bassin haut pendant la glissade, posé pour ramener les talons.',
        40),
      lift('mollets-sol', `Mollets genou tendu, ${d.sets} séries par jambe`, d.sets * 2, 15, 30, 'Descente en 3 s',
        'Au sol, sur un pied, la main valide au mur : 1 s pour monter, 1 s en haut, 3 s pour redescendre.', 50),
      lift('pont-une-jambe', `Pont fessier sur une jambe, ${d.sets} séries par jambe`, d.sets * 2, 12, 30, effort,
        'Talon à 30 cm des fesses, 2 s serrées en haut.', 45),
      lift('tirage-elastique', 'Tirage à un bras, élastique', d.sets, 12, 45, 'Moyen : 3 répétitions en réserve',
        'Accroche à hauteur de poitrine, deux élastiques (5 et 7 kg) sur la poignée : 1 s pour tirer, 1 s tenue, ' +
          `2 s pour rendre. ${WITHOUT_KIT} passe-le.`,
        45),
      lift('bras-elastique', 'Bras valide : plier, tendre, serrer', 2, 15, 60, 'Moyen : 3 répétitions en réserve',
        'Deux tours : 15 flexions (accroche en bas de porte), 15 extensions (accroche en haut), 10 serrages de ' +
          `5 s. ${WITHOUT_KIT} une bouteille d'eau de 1,5 L pour plier et tendre.`,
        150),
      lift('anti-rotation', 'Gainage anti-rotation, 2 séries par côté', 4, 8, 30, 'Bras tendu 3 s',
        'Accroche à hauteur de poitrine, un élastique de 6 ou 7 kg, de profil à la porte ; tourne-toi pour ' +
          `l'autre côté. ${WITHOUT_KIT} 2 séries de 8 gainages sur le dos (fiche « dead bug »).`,
        40),
      ...daily(),
    ]);
}

/** Force B à la maison : les appuis, et l'endurance des montées. */
export function compensationHomeB(model: PhysiologyModel, week: CompensationWeek): SessionTemplate {
  const d = DOSE[week];
  const effort = `Appuyé : ${reserveText(d.reserve)}`;
  return template(model, `compensation_home_b_${week}`, 'strength', 'Force B à la maison',
    'Les appuis du trail sans salle : la descente au ralenti, la hanche qui tient le bassin, la cheville et le ' +
      'pied — et, pour finir, des montées continues, l\'endurance des côtes.',
    [
      homeWarmUp(model),
      lift('montee-tabouret', `Montée sur le tabouret, ${d.sets} séries par jambe`, d.sets * 2, 6, 60,
        'Descente en 4 s',
        'Tabouret calé contre un mur, main valide au mur. Monte en 1 s, redescends en 4 s en freinant avec la ' +
          'jambe du haut.',
        50),
      lift('souleve-une-jambe', `Bascule sur une jambe, ${d.sets} séries par jambe`, d.sets * 2, 10, 30, effort,
        'Main valide sur l\'encadrement, à hauteur de hanche. Dos plat, 3 s pour descendre.', 45),
      hold('chaise', 'Chaise contre le mur', 3, d.holdS + 15, 60, 'Cuisses parallèles au sol, dos plaqué. Respire.'),
      lift('pas-chasses', 'Pas chassés à la mini-bande', 3, 12, 45, 'Jusqu\'à la brûlure',
        '12 pas dans chaque sens, face au mur, la main valide qui glisse dessus.', 40),
      lift('montee-genou', `Montée de genou sur le dos, ${d.sets} séries par jambe`, d.sets * 2, 10, 20,
        'Bas du dos collé', 'Mini-bande aux pieds : 1 s pour monter le genou, 2 s pour repartir.', 30),
      lift('mollets-sol', 'Mollets genou fléchi, 2 séries par jambe', 4, 15, 30, 'Descente en 3 s',
        'Au sol, sur un pied, le genou fléchi de 30° toute la série : c\'est le soléaire.', 55),
      lift('releves-pointe', 'Relevés de pointe', 2, 20, 30, 'Jusqu\'à la brûlure', 'Dos au mur, talons à 30 cm devant.', 40),
      hold('gainage-lateral', 'Gainage sur le côté', 2, d.holdS, 30,
        'Sur le coude du bras valide seulement ; genoux au sol si besoin.'),
      {
        ...heart(model, 'Montées continues sur le tabouret', 'Z2', 180, {
          exercise: 'montee-tabouret',
          notes:
            'Un pas toutes les 3 s, change de jambe toutes les 30 s, main au mur. C\'est l\'endurance des montées : ' +
            'reste dans la plage, et arrête si la jambe tremble.',
        }),
        repeat: 2,
        recovery: { durationS: 120, zone: 'Z1', active: true, betweenReps: true },
      },
      ...daily(),
    ]);
}

/** La marche tranquille des jours sans force. */
export function compensationEasyWalk(model: PhysiologyModel, minutes: number, withMobility = false): SessionTemplate {
  return template(model, `compensation_walk_${minutes}${withMobility ? '_m' : ''}`, 'cross_training', 'Marche tranquille',
    'Garder le cœur et les jambes en route sans rien demander au coude ; la semaine ne cherche pas l\'effort.',
    [
      heart(model, 'Marche tranquille, à plat', 'Z1', minutes * 60, {
        exercise: 'marche',
        notes: 'Quais, parc de la Tête d\'Or : sol sec et régulier, tu dois pouvoir parler tout du long.',
      }),
      ...(withMobility ? [souplesse()] : []),
      ...daily(),
    ]);
}

/** La sortie longue de la semaine à la maison : marchée, sans chercher la côte. */
export function compensationEasyLong(model: PhysiologyModel, minutes = 90, vertM = 150): SessionTemplate {
  return template(model, 'compensation_walk_long', 'cross_training', 'Longue marche tranquille',
    'La sortie longue de la semaine, à allure de conversation : du temps debout, un peu de dénivelé, rien qui ' +
      'essouffle.',
    [
      heart(model, 'Marche tranquille, quelques montées', 'Z1', minutes * 60, {
        exercise: 'marche-cote',
        elevationGainM: vertM,
        elevationLossM: vertM,
        notes:
          'Fourvière par la montée Saint-Barthélemy et le jardin du Rosaire : revêtu et sec. Reste sous la limite ' +
          'même en montée : ralentis plutôt que de forcer.',
      }),
      ...daily(),
    ]);
}

/** Le jour `dow` (0 = lundi) de la semaine 1 à la maison. */
export function compensationHomeDay(model: PhysiologyModel, dow: number): SessionTemplate {
  return [
    () => compensationRestart(model),
    () => compensationHomeA(model, 1),
    () => compensationEasyWalk(model, 50),
    () => compensationEasyWalk(model, 50, true),
    () => compensationHomeB(model, 1),
    () => compensationEasyLong(model),
    () => compensationRecovery(model),
  ][dow % 7]!();
}

// ─────────────────────────────────────────────────────────────────────────────
// Le bloc de force, du 09/10 au 01/11
// ─────────────────────────────────────────────────────────────────────────────

/*
 * Le 09/10, Pierre : « je vais commencer le renforcement musculaire de façon
 * quotidienne, bien énervée, pour revenir encore plus puissant, plus musclé,
 * et combler des lacunes ». Rien depuis le 02/10. Le matériel : rien, le step
 * à 20 ou 40 cm, le kit d'élastiques, les mini-bandes, l'anneau, le tapis.
 *
 * Tous les jours, mais pas dur tous les jours : trois séances de force lourdes
 * à 48 h l'une de l'autre (genoux, hanches, une jambe), et entre elles ce qui
 * ne les gêne pas — les tendons et le pied, le fractionné en côte, la longue
 * marche, la récupération. Le muscle se construit entre les séances.
 *
 *  · l'hypertrophie suit le nombre de séries dures (10 à 20 par muscle et par
 *    semaine), réparties sur deux ou trois séances, près de l'échec (Schoenfeld
 *    2016, 2017) : au poids du corps, sur une jambe, le tempo lent et la
 *    réserve de répétitions font la charge ;
 *  · ses lacunes mesurées : l'aisance en descente (0,68 d'un bon traileur), la
 *    durabilité sur les sorties longues, la souplesse (−1 cm) — d'où le
 *    freinage du quadriceps, l'endurance des montées sur le step, la souplesse ;
 *  · le tendon d'Achille, déchargé sans course : l'isométrie lourde quatre fois
 *    par semaine le raidit et rend la course plus économique (Arampatzis 2007,
 *    Albracht 2013) ;
 *  · la VO2max se garde par l'intensité (Hickson 1981, 1985) : un fractionné en
 *    côte par semaine, en marche. Pas sur le step : à 20 cm, il faudrait plus de
 *    80 montées par minute pour atteindre son seuil (équation de l'ACSM) ;
 *  · le bras plâtré s'entretient par le bras valide, poussé près du maximum
 *    (Magnus 2013), et par l'imagerie de contractions (Clark 2014).
 *
 * Trois semaines : construire (2 répétitions en réserve), charger (1), puis
 * alléger (3) pour que le travail se transforme et que les tests de fin
 * mesurent un athlète frais. Debout sur une jambe, jamais d'échec : avec un
 * plâtre, l'échec, c'est la chute.
 */

/** La semaine du bloc : 0, les trois jours d'ouverture ; 1 construire ; 2 charger ; 3 alléger. */
export type BlockWeek = 0 | 1 | 2 | 3;

interface BlockDose {
  /** Séries des exercices principaux, par jambe pour ceux d'une jambe. */
  sets: number;
  /** Répétitions gardées en réserve à la fin de chaque série. */
  reserve: number;
  /** Les exercices qui se durcissent : la version « plus dur » de la fiche. */
  harder: boolean;
  /** Gainage sur le côté, s. */
  holdS: number;
  /** Chaise sur deux jambes, s. */
  wallS: number;
  /** Isométrie des mollets, séries par jambe. */
  isoSets: number;
  /** Le fractionné en côte : des répétitions de 3 min. */
  climb: { reps: number; zone: ZoneKey };
  /** Longue marche, min, et son dénivelé. */
  longMin: number;
  longVertM: number;
  /** Montées continues sur le step : des séries de `enduranceMin`. */
  enduranceSets: number;
  enduranceMin: number;
}

const BLOCK_DOSE: Record<BlockWeek, BlockDose> = {
  0: {
    sets: 3, reserve: 3, harder: false, holdS: 30, wallS: 60, isoSets: 3, climb: { reps: 4, zone: 'Z3' },
    longMin: 90, longVertM: 300, enduranceSets: 2, enduranceMin: 4,
  },
  1: {
    sets: 3, reserve: 2, harder: false, holdS: 40, wallS: 75, isoSets: 4, climb: { reps: 5, zone: 'Z3' },
    longMin: 105, longVertM: 450, enduranceSets: 2, enduranceMin: 5,
  },
  2: {
    sets: 4, reserve: 1, harder: true, holdS: 50, wallS: 90, isoSets: 5, climb: { reps: 6, zone: 'Z4' },
    longMin: 135, longVertM: 650, enduranceSets: 3, enduranceMin: 5,
  },
  3: {
    sets: 2, reserve: 3, harder: false, holdS: 30, wallS: 60, isoSets: 3, climb: { reps: 4, zone: 'Z4' },
    longMin: 90, longVertM: 300, enduranceSets: 2, enduranceMin: 4,
  },
};

/** Le bloc commence un vendredi : le 09/10, les tests. */
const BLOCK_DAYS = 24;

/** La semaine du jour `index` du bloc (0 = le 09/10). */
export const blockWeekOf = (index: number): BlockWeek =>
  (index < 3 ? 0 : Math.min(3, Math.floor((index - 3) / 7) + 1)) as BlockWeek;

/**
 * L'imagerie du bras plâtré, cinq jours sur sept : imaginer des contractions
 * maximales, sans contracter. Quatre semaines de plâtre ont coûté deux fois
 * moins de force du poignet à ceux qui la pratiquaient (Clark 2014).
 */
function imagery(): SessionBlock {
  return {
    label: 'Imagerie du bras plâtré', kind: 'mobility', zone: 'Z1', durationS: 660, exercise: 'soins-bras',
    notes:
      'Allongé, les yeux fermés : imagine que tu plies le coude plâtré de toutes tes forces 5 s, sans contracter ' +
      'le bras, puis 5 s de repos. 13 fois, quatre séries, 1 min entre elles ; une série sur deux, imagine que tu ' +
      'le tends.',
  };
}

/** Les soins de chaque jour ; l'imagerie s'y ajoute du lundi au vendredi. */
const blockDaily = (weekday: boolean): SessionBlock[] => [...daily(), ...(weekday ? [imagery()] : [])];

/** Le mollet sous le cadre de porte : quatre fois par semaine, comme dans l'étude. */
function calfIso(d: BlockDose, sets = d.isoSets): SessionBlock {
  return lift('mollets-iso', `Mollet sous le cadre de porte, ${sets} séries par jambe`, sets * 2, 4, 20,
    'Pousse à fond 3 s, relâche 3 s',
    'Sur un pied, à mi-hauteur sur la pointe, la main valide qui pousse le haut du cadre. Les jambes en ' +
      'alternance : la pause de l\'une est la série de l\'autre.',
    25);
}

/** Les tests du premier et du dernier jour. */
export function blockTests(model: PhysiologyModel, when: 'start' | 'end'): SessionTemplate {
  const start = when === 'start';
  return template(model, `bloc_tests_${when}`, 'strength', start ? 'Tests de départ' : 'Tests de fin de bloc',
    start
      ? 'Savoir d\'où tu pars : sept mesures, chacune vise une de tes lacunes ou un pilier du trail long. Le ' +
          '1er novembre, les mêmes diront ce que tu as gagné. Ce soir, une marche tranquille si tu as envie de bouger.'
      : 'Les sept mesures du 9 octobre, dans le même ordre et à la même heure : ce que trois semaines de force ont ' +
          'changé, jambe par jambe.',
    [
      homeWarmUp(model),
      {
        label: 'Les sept tests', zone: 'Z3', durationS: 35 * 60, exercise: 'tests-maison',
        effort: 'Jusqu\'à l\'échec, sauf l\'équilibre',
        notes:
          'Dans l\'ordre de la fiche, 2 min entre chaque test. Note chaque résultat, jambe par jambe, dans le point ' +
          'du jour. Plus de 10 % d\'écart entre tes deux jambes sur un test : une série de plus du côté faible, ' +
          'jusqu\'au test de fin.',
      },
      // Le vendredi des tests de départ est un jour de semaine, le dimanche des tests de fin non.
      ...blockDaily(start),
    ]);
}

/** Force 1 — les genoux et le freinage : le quadriceps qui freine les descentes. */
export function blockForce1(model: PhysiologyModel, week: BlockWeek): SessionTemplate {
  const d = BLOCK_DOSE[week];
  const effort = `Appuyé : ${reserveText(d.reserve)}`;
  return template(model, `bloc_force_1_${week}`, 'strength', 'Force 1 · genoux et freinage',
    'Le quadriceps qui freine en s\'allongeant, comme dans chaque descente : ton aisance en descente, mesurée sur ' +
      'tes sorties, est à 0,68 de celle d\'un bon traileur — ta marge la plus nette. Et le bras valide, qui ' +
      'entretient l\'autre.',
    [
      homeWarmUp(model),
      lift('split-squat-maison', `Fente bulgare, ${d.sets} séries par jambe`, d.sets * 2, 10, 45, effort,
        'Le pied arrière sur le step à 40 cm calé contre un mur, la main valide sur l\'encadrement. 3 s pour ' +
          'descendre, 1 s en bas, 1 s pour monter.' +
          (d.harder ? ' Cette semaine, 2 s tenues en bas — ou un sac à dos chargé de 5 kg, si tu l\'enfiles sans forcer le coude.' : ''),
        50),
      lift('descente-marche', `Descente lente du step, ${d.sets} séries par jambe`, d.sets * 2, 8, 30, 'Descente en 4 s',
        d.harder
          ? 'Le step à 40 cm cette semaine, la main valide au mur. Le talon libre effleure le sol, il ne s\'y pose pas.'
          : 'Le step à 20 cm, la main valide au mur. Le talon libre effleure le sol, il ne s\'y pose pas.',
        45),
      lift('reverse-nordic', 'Bascule arrière à genoux', d.sets, d.harder ? 8 : 6, 60, effort,
        'Le corps droit des genoux à la tête, 3 s pour partir en arrière, 2 s pour revenir. Pas plus loin que ' +
          'l\'endroit d\'où tu reviens sans casser au bassin.',
        35),
      lift('leg-curl-serviette', 'Flexion des jambes sur serviette', d.sets, d.harder ? 8 : 6, 75, 'Freine 4 s',
        'Bassin haut pendant la glissade, posé pour ramener les talons.' +
          (d.harder ? ' Cette semaine, ramène aussi les talons bassin haut.' : ''),
        40),
      hold('chaise', 'Chaise contre le mur', week === 3 ? 1 : 2, d.wallS, 60,
        'Cuisses parallèles au sol. Ou la moitié de ton temps au test, si c\'est plus long.'),
      calfIso(d),
      lift('pousse-elastique', 'Poussée à un bras, élastique', d.sets, 12, 30, effort,
        'Dos à la porte, accroche à hauteur de poitrine, deux élastiques (5 et 7 kg) : 1 s pour pousser, 1 s ' +
          'tenue, 2 s pour revenir. En alternance avec le tirage.',
        40),
      lift('tirage-elastique', 'Tirage à un bras, élastique', d.sets, 12, 30, effort,
        'Face à la porte, la même accroche : 1 s pour tirer, 1 s tenue, 2 s pour rendre.', 40),
      lift('dead-bug', 'Dead bug, jambes seules', 2, 10, 30, 'Dos plaqué',
        'Une jambe puis l\'autre, 3 s pour descendre le talon.', 40),
      ...blockDaily(true),
    ]);
}

/** Tendons, pieds, gainage : ce qu'un arrêt de course déconditionne en premier, et une marche. */
export function blockTendons(model: PhysiologyModel, week: BlockWeek): SessionTemplate {
  const d = BLOCK_DOSE[week];
  const ecc = Math.max(1, d.sets - 1);
  return template(model, `bloc_tendons_${week}`, 'cross_training', 'Tendons, pieds, gainage',
    'Le tendon d\'Achille, le pied et la cheville encaissent chaque foulée : sans course, ce sont eux qui perdent ' +
      'le plus vite. L\'isométrie lourde les raidit, la descente lente les renforce, l\'équilibre les réveille.',
    [
      heart(model, 'Marche tranquille', 'Z1', 40 * 60, {
        exercise: 'marche',
        notes: 'D\'abord la marche : elle chauffe les mollets avant l\'isométrie. Sol sec et régulier.',
      }),
      calfIso(d, week === 3 ? 3 : 5),
      lift('mollets-excentriques', `Mollets en descente lente : ${ecc} séries genou tendu, ${ecc} genou fléchi, par jambe`,
        ecc * 4, 12, 30, 'Descente en 3 s',
        'Le step à 20 cm contre un mur, la main valide au mur. Monte sur les deux pointes, redescends sur une.' +
          (d.harder ? ' Cette semaine, 5 s pour redescendre.' : ''),
        45),
      lift('releves-pointe', 'Relevés de pointe', 2, 20, 30, 'Jusqu\'à la brûlure', 'Dos au mur, talons à 30 cm devant.', 40),
      lift('pied-court', 'Pied court et orteils', 1, 10, 0, 'Lent, sans plier les orteils',
        '10 pieds courts de 5 s par pied, puis 10 gros orteils seuls et 10 fois les quatre autres.' +
          (d.harder ? ' Cette semaine, debout.' : ''),
        240),
      hold('equilibre', 'Équilibre yeux fermés, 3 fois par jambe', 6, 30, 15,
        'Dans un angle de mur, la main valide à 20 cm du mur.'),
      hold('gainage-lateral', 'Gainage sur le côté, coude valide', 3, d.holdS, 45, 'Genoux au sol si le bassin tombe.'),
      lift('anti-rotation', 'Anti-rotation, 2 séries par côté', 4, 8, 30, 'Bras tendu 3 s',
        'De profil à la porte, un élastique de 6 ou 7 kg ; tourne-toi pour l\'autre côté.', 40),
      ...blockDaily(true),
    ]);
}

/** Force 2 — les hanches et la chaîne arrière : le moteur des montées, ce qui tient le bassin. */
export function blockForce2(model: PhysiologyModel, week: BlockWeek): SessionTemplate {
  const d = BLOCK_DOSE[week];
  const effort = `Appuyé : ${reserveText(d.reserve)}`;
  return template(model, `bloc_force_2_${week}`, 'strength', 'Force 2 · hanches et chaîne arrière',
    'Les fessiers et l\'arrière des cuisses te poussent en montée ; les adducteurs et le moyen fessier tiennent le ' +
      'bassin quand la fatigue arrive — ta durabilité sur les sorties longues se joue là.',
    [
      homeWarmUp(model),
      lift('souleve-une-jambe', `Bascule sur une jambe, ${d.sets} séries par jambe`, d.sets * 2, 10, 30, effort,
        'Main valide sur l\'encadrement. Dos plat, 3 s pour descendre.' +
          (d.harder ? ' Cette semaine, 4 s, et un sac à dos chargé de 5 kg si tu l\'enfiles sans forcer le coude.' : ''),
        45),
      lift('hip-thrust', `Pont sur le canapé, ${d.sets} séries par jambe`, d.sets * 2, 12, 30, effort,
        'Les omoplates sur le bord de l\'assise, un pied au sol : 1 s pour monter, 2 s tenues, 2 s pour redescendre ' +
          'sans poser le bassin.',
        45),
      lift('pas-chasses', 'Pas chassés à la mini-bande', 3, 12, 30, 'Jusqu\'à la brûlure',
        '12 pas dans chaque sens, face au mur, la main valide qui glisse dessus.', 40),
      lift('copenhague', 'Copenhague, la jambe du côté du plâtre', d.harder ? 3 : 2, d.harder ? 8 : 6, 45, 'Contrôlé',
        'Sur le coude valide, le genou du dessus sur le step à 40 cm : 1 s pour monter, 2 s pour redescendre.', 30),
      lift('adducteurs-coussin', 'Serrage de coussin', 1, 6, 0, 'À fond 10 s, relâche 10 s',
        'Les deux jambes à la fois : c\'est l\'adducteur que la Copenhague ne fait pas.', 120),
      lift('montee-genou', `Montée de genou sur le dos, ${d.sets} séries par jambe`, d.sets * 2, 10, 20,
        'Bas du dos collé', 'Mini-bande aux pieds : 1 s pour monter le genou, 2 s pour repartir.', 30),
      calfIso(d),
      lift('bras-elastique', 'Bras valide : plier, tendre, serrer — puis le maximum', 2, 12, 60, effort,
        'Deux tours : 12 flexions (accroche en bas de porte), 12 extensions (accroche en haut), 10 serrages de 5 s. ' +
          'Puis, sous la table, 3 poussées de 5 s à fond vers le haut, 3 vers le bas.',
        180),
      ...blockDaily(true),
    ]);
}

/**
 * Le moteur : un fractionné en côte, en marche. Les montées rapides se font
 * dans les escaliers, pas sur le step, qui ne monte pas le cœur assez haut.
 */
export function blockMoteur(model: PhysiologyModel, week: BlockWeek): SessionTemplate {
  const d = BLOCK_DOSE[week];
  const { reps, zone } = d.climb;
  const vert = zone === 'Z4' ? 55 : 45;
  const name = zone === 'Z4' ? 'au seuil' : 'en zone 3';
  return template(model, `bloc_moteur_${week}`, 'cross_training', `Fractionné en côte ${name}, en marche`,
    'L\'intensité garde la VO2max quand le volume baisse : un fractionné par semaine suffit. En marche rapide ' +
      'dans les escaliers, c\'est aussi la marche en côte des trails longs.',
    [
      heart(model, 'Échauffement : marche progressive', 'Z2', 15 * 60, {
        exercise: 'marche-cote', notes: 'Jusqu\'au pied des escaliers, en accélérant peu à peu.',
      }),
      {
        ...heart(model, `Montées rapides ${name}`, zone, 180, {
          exercise: 'marche-cote',
          elevationGainM: vert,
          notes:
            `${zone === 'Z4' ? 'Effort 7 sur 10, phrases courtes' : 'Effort 6 sur 10'} : monte vite, en marche, une ` +
            'marche à la fois, la main valide près de la rampe. Escaliers de Fourvière ou montée de la Grande-Côte, ' +
            'secs ; s\'il pleut, ceux de ton immeuble. Entre deux, redescends lentement à la rampe : c\'est la ' +
            'récupération.',
        }),
        repeat: reps,
        recovery: { durationS: 180, zone: 'Z1', active: true, betweenReps: true, elevationLossM: vert },
      },
      heart(model, 'Retour au calme', 'Z1', 10 * 60, {
        exercise: 'marche', elevationLossM: vert, notes: 'La dernière descente, lente, puis à plat.',
      }),
      souplesse(600),
      lift('dead-bug', 'Dead bug, jambes seules', 2, 10, 30, 'Dos plaqué', 'À la maison, en rentrant.', 40),
      hold('gainage-lateral', 'Gainage sur le côté, coude valide', 2, d.holdS, 45, 'Genoux au sol si le bassin tombe.'),
      ...blockDaily(true),
    ]);
}

/** Force 3 — une jambe et les montées : la puissance, l'appui, l'endurance des côtes. */
export function blockForce3(model: PhysiologyModel, week: BlockWeek): SessionTemplate {
  const d = BLOCK_DOSE[week];
  const effort = `Appuyé : ${reserveText(d.reserve)}`;
  return template(model, `bloc_force_3_${week}`, 'strength', 'Force 3 · une jambe et montées',
    'La puissance des montées, la force qui tient sur un pied, et pour finir des montées continues : l\'endurance ' +
      'des côtes, ce qui manque après trois heures.',
    [
      homeWarmUp(model),
      lift('montee-tabouret', `Montée explosive sur le step à 40 cm, ${d.sets} séries par jambe`, d.sets * 2, 6, 45,
        'Monte vite, redescends en 4 s',
        'Le step calé contre un mur, la main valide au mur. Monte le plus vite possible sans sauter, redescends en ' +
          '4 s en freinant avec la jambe du haut.' +
          (d.harder ? ' Cette semaine, un sac à dos chargé de 5 kg si tu l\'enfiles sans forcer le coude.' : ''),
        40),
      hold('chaise', `Chaise sur une jambe, ${d.sets} séries par jambe`, d.sets * 2, d.harder ? 30 : 20, 30,
        'Contre le mur, l\'autre pied levé de 5 cm. Les jambes en alternance.'),
      lift('reverse-nordic', 'Bascule arrière à genoux', 2, d.harder ? 8 : 6, 60, effort,
        'Le corps droit des genoux à la tête, 3 s pour partir, 2 s pour revenir.', 35),
      lift('leg-curl-serviette', 'Flexion des jambes sur serviette', d.sets, d.harder ? 8 : 6, 75, 'Freine 4 s',
        'Bassin haut pendant la glissade.' + (d.harder ? ' Cette semaine, une jambe sur deux séries.' : ''), 40),
      lift('copenhague', 'Copenhague, la jambe du côté du plâtre', d.harder ? 3 : 2, d.harder ? 8 : 6, 45, 'Contrôlé',
        'Sur le coude valide, le genou du dessus sur le step à 40 cm.', 30),
      lift('adducteurs-coussin', 'Serrage de coussin', 1, 6, 0, 'À fond 10 s, relâche 10 s', 'Les deux jambes à la fois.', 120),
      calfIso(d),
      lift('pousse-elastique', 'Poussée à un bras, élastique', d.sets, 12, 30, effort,
        'En alternance avec le tirage.', 40),
      lift('tirage-elastique', 'Tirage à un bras, élastique', d.sets, 12, 30, effort, 'Face à la porte.', 40),
      {
        ...heart(model, 'Montées continues sur le step à 40 cm', 'Z2', d.enduranceMin * 60, {
          exercise: 'montee-tabouret',
          notes:
            'Une montée toutes les 2 s, change de jambe toutes les 30 s, la main au mur. Sous la plage : un sac à dos ' +
            'chargé. Arrête si la jambe tremble.',
        }),
        repeat: d.enduranceSets,
        recovery: { durationS: 120, zone: 'Z1', active: true, betweenReps: true },
      },
      ...blockDaily(true),
    ]);
}

/** La longue marche du samedi : du temps debout, du dénivelé — la sortie longue sans courir. */
export function blockLongue(model: PhysiologyModel, week: BlockWeek): SessionTemplate {
  const d = BLOCK_DOSE[week];
  return template(model, `bloc_longue_${week}`, 'cross_training', 'Longue marche en côte',
    'La sortie longue devient marche : du temps debout, des montées, le cœur en endurance. C\'est le moteur des ' +
      'trails longs, et la moitié de leur temps se marche.',
    [
      heart(model, 'Longue marche en côte', 'Z2', d.longMin * 60, {
        exercise: 'marche-cote',
        elevationGainM: d.longVertM,
        elevationLossM: d.longVertM,
        notes:
          'Fourvière par la montée Saint-Barthélemy, les escaliers, la Sarra : revêtu et sec. Monte fort sans ' +
          'dépasser le haut de la plage ; redescends lentement, la main sur la rampe.',
      }),
      lift('pied-court', 'Pied court et orteils', 1, 10, 0, 'Lent', 'En rentrant, assis : 10 pieds courts de 5 s par pied.', 180),
      hold('equilibre', 'Équilibre yeux fermés, 3 fois par jambe', 6, 30, 15, 'Dans un angle de mur.'),
      ...blockDaily(false),
    ]);
}

/** La récupération du dimanche : la semaine s'assimile, la souplesse se gagne. */
export function blockRecup(model: PhysiologyModel): SessionTemplate {
  return template(model, 'bloc_recup', 'cross_training', 'Récupération',
    'La semaine s\'assimile : c\'est maintenant que le muscle se construit. Ta souplesse, courte au test d\'effort, ' +
      'ne gagne qu\'avec la régularité.',
    [
      heart(model, 'Marche facile, à plat', 'Z1', 45 * 60, {
        exercise: 'marche', notes: 'Quais, parc de la Tête d\'Or : tu dois pouvoir parler tout du long.',
      }),
      souplesse(900),
      lift('dead-bug', 'Dead bug, jambes seules', 2, 10, 30, 'Facile', 'Le gainage léger du jour.', 40),
      ...blockDaily(false),
    ]);
}

/**
 * Le jour `index` du bloc (0 = le vendredi 09/10) : les tests, puis la semaine
 * type — force 1, tendons, force 2, moteur, force 3, longue marche,
 * récupération. Le dernier dimanche refait les tests.
 */
export function blockDay(model: PhysiologyModel, index: number): SessionTemplate {
  if (index === 0) return blockTests(model, 'start');
  if (index === BLOCK_DAYS - 1) return blockTests(model, 'end');
  const week = blockWeekOf(index);
  const dow = (index + 4) % 7;
  return [
    () => blockForce1(model, week),
    () => blockTendons(model, week),
    () => blockForce2(model, week),
    () => blockMoteur(model, week),
    () => blockForce3(model, week),
    () => blockLongue(model, week),
    () => blockRecup(model),
  ][dow]!();
}

// ─────────────────────────────────────────────────────────────────────────────
// Le programme posé dans le plan
// ─────────────────────────────────────────────────────────────────────────────

/** Ce qui reste à faire d'une séance : sa place se reprend. */
const REPLACEABLE: ReadonlySet<PlannedSession['status']> = new Set(['planned', 'missed', 'moved']);

/**
 * Pose le programme dans le plan actif, du `from` (un lundi) sur `days` jours.
 *
 * Chaque jour reçoit sa séance : la séance prévue ce jour-là devient celle du
 * programme — son identifiant et son histoire demeurent, Garmin retire de la
 * montre ce qui ne s'y exécute plus —, et un jour sans séance en reçoit une
 * neuve. Une course de la période est annulée. Chaque séance porte la décision
 * du coach : une reconstruction du plan la garde telle quelle.
 */
export async function layCompensation(
  athleteId: string,
  opts: {
    from: string;
    days: number;
    reason: string;
    at?: string;
    /** Le jour du programme qui tombe en `from` (0 = le premier lundi) : pour reprendre en cours de semaine. */
    offset?: number;
    /**
     * Le programme : la salle (`compensationDay`), la semaine 1 à la maison
     * (`compensationHomeDay`), ou le bloc de force du 09/10 (`blockDay`).
     */
    program?: 'gym' | 'home' | 'block';
    /** Ce que la révision du plan en dit, quand ce n'est pas tout le programme. */
    summary?: string;
  },
): Promise<{ updated: number; inserted: number; cancelled: number; kept: number }> {
  const active = await db.getActivePlan(athleteId);
  if (!active) throw new Error('Aucun plan actif : le programme n\'a nulle part où se poser.');
  const model = await currentModel(athleteId);
  const at = opts.at ?? new Date().toISOString();
  const to = addDays(opts.from, opts.days - 1);
  const existing = await db.listPlannedSessions(athleteId, opts.from, to);
  const changes: PlanRevision['changes'] = [];
  let updated = 0;
  let inserted = 0;
  let cancelled = 0;
  let kept = 0;

  for (let i = 0; i < opts.days; i++) {
    const date = addDays(opts.from, i);
    const index = (opts.offset ?? 0) + i;
    const program = opts.program ?? 'gym';
    const week = Math.min(4, Math.floor(index / 7) + 1);
    if (program === 'home' && week !== 1) throw new Error('À la maison, seule la semaine 1 est écrite.');
    if (program === 'block' && index >= BLOCK_DAYS) throw new Error('Le bloc de force s\'arrête au 01/11.');
    const t =
      program === 'block' ? blockDay(model, index)
        : program === 'home' ? compensationHomeDay(model, index)
          : compensationDay(model, index);
    const why =
      program === 'block'
        ? `${opts.reason} Bloc de force, ${blockWeekOf(index) === 0 ? 'ouverture' : `semaine ${blockWeekOf(index)} sur 3`}.`
        : program === 'home'
          ? `${opts.reason} Programme de compensation, semaine 1 sur 4, à la maison.`
          : `${opts.reason} Programme de compensation, semaine ${week} sur 4.`;
    // Une séance faite ce jour-là reste ce qu'elle a été : rien ne la remplace, rien ne s'y ajoute.
    if (existing.some((s) => s.date === date && s.status === 'completed')) {
      kept++;
      continue;
    }
    const decision: SessionDecision = { at, by: 'coach', summary: why };
    const content = {
      type: t.type,
      title: t.title,
      intent: t.intent,
      blocks: t.blocks,
      plannedLoad: t.plannedLoad,
      plannedMechanicalLoad: t.plannedMechanicalLoad,
      plannedDurationS: t.durationS,
      plannedElevationGainM: t.elevationGainM,
      plannedDistanceM: null,
      priority: t.priority,
      status: 'planned' as const,
      completedActivityId: null,
      plannedDate: null,
      absenceId: null,
      directives: null,
      successCriteria: null,
      lightenings: null,
      rationale: why,
      decision,
    };

    const day = existing.filter((s) => s.date === date);
    for (const race of day.filter((s) => s.type === 'race' && s.status !== 'cancelled')) {
      await db.updateSession(race.id, {
        status: 'cancelled',
        history: withHistory(race.history, { at, by: 'coach', text: `Course annulée. ${opts.reason}` }),
      });
      changes.push({ date, before: race.title, after: 'annulée', reason: opts.reason });
      cancelled++;
    }
    const open = day.filter((s) => s.type !== 'race' && REPLACEABLE.has(s.status));
    const [target, ...others] = open;
    if (target) {
      await db.updateSession(target.id, {
        ...content,
        history: withHistory(target.history, { at, by: 'coach', text: `${target.title} remplacée. ${why}` }),
      });
      changes.push({ date, before: target.title, after: t.title, reason: why });
      updated++;
    } else {
      const session: PlannedSession = {
        id: `ses_${Math.random().toString(36).slice(2, 9)}${Date.now().toString(36).slice(-4)}`,
        athleteId,
        date,
        type: t.type,
        title: t.title,
        intent: t.intent,
        blocks: t.blocks,
        plannedLoad: t.plannedLoad,
        plannedMechanicalLoad: t.plannedMechanicalLoad,
        plannedDurationS: t.durationS,
        plannedElevationGainM: t.elevationGainM,
        priority: t.priority,
        status: 'planned',
        rationale: why,
        decision,
        history: withHistory(undefined, { at, by: 'coach', text: why }),
      };
      await db.insertSession(active.plan.id, session, { weekStart: mondayOf(date), phase: 'transition' });
      changes.push({ date, before: '—', after: t.title, reason: why });
      inserted++;
    }
    for (const extra of others) {
      await db.updateSession(extra.id, {
        status: 'cancelled',
        history: withHistory(extra.history, { at, by: 'coach', text: `Retirée : le programme tient la journée. ${opts.reason}` }),
      });
      cancelled++;
    }
  }

  await db.appendPlanRevision(active.plan.id, {
    at,
    trigger: 'chat_request',
    origin: 'coach',
    summary:
      opts.summary ??
      `${opts.reason} Programme de compensation du ${opts.from.slice(8, 10)}/${opts.from.slice(5, 7)} au ` +
        `${to.slice(8, 10)}/${to.slice(5, 7)} : renforcement, marche en côte, fractionné sans impact, une séance par jour.`,
    changes,
  });
  return { updated, inserted, cancelled, kept };
}
