import type {
  ExerciseKey, PhysiologyModel, PlanRevision, PlannedSession, SessionBlock, SessionDecision, SessionType,
  StrengthTestResult, ZoneKey,
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
 * et combler des lacunes ». Le soir, après ses tests : « concentre-toi sur le
 * renforcement plutôt que les marches longues […] spécifique trail, spécifique
 * mon profil et mes lacunes », pour des ambitions qu'il chiffre — le top 100 de
 * la Maxi-Race, quinze boucles au moins en backyard, le top 150 de la
 * SaintéLyon. Le matériel : rien, le step à 20 ou 40 cm, le kit d'élastiques,
 * les mini-bandes, l'anneau, le tapis, un sac à dos qu'on charge.
 *
 * Tous les jours, et dur, mais jamais les mêmes muscles lourds deux jours de
 * suite : cinq séances de force — les genoux et les descentes, la chaîne
 * arrière, une jambe et la puissance, les hanches et le tronc, l'endurance des
 * montées —, un fractionné en côte, une récupération.
 *
 *  · la force lourde et l'hypertrophie suivent les séries dures, près de
 *    l'échec, chargées (Schoenfeld 2016, 2017 ; Rønnestad & Mujika 2014) : sur
 *    une jambe, le sac à dos fait la charge que le poids du corps ne fait plus ;
 *  · le freinage du quadriceps prépare les descentes, où son aisance mesurée
 *    est à 0,68 d'un bon traileur — la marge la plus nette pour la Maxi-Race ;
 *  · l'endurance musculaire sous charge, des montées continues lestées, longues
 *    (Johnston & House 2019), vise la durabilité, moyenne : c'est elle qui fait
 *    tenir quinze boucles ou 5 000 m de dénivelé ;
 *  · ses mollets sont très endurants aux tests (91 et 117 montées) : ils ne
 *    progressent plus qu'en charge — lourde et lente, et isométrique, qui
 *    raidit le tendon d'Achille (Arampatzis 2007, Albracht 2013) ;
 *  · la VO2max se garde par l'intensité (Hickson 1981, 1985) : un fractionné
 *    en côte par semaine, en marche, dans les escaliers ;
 *  · un côté faible aux tests — plus de 10 % d'écart, 1,5 cm pour la cheville —
 *    fait une série de plus de ce côté jusqu'aux tests de fin (`weakSides`) ;
 *  · le bras plâtré s'entretient par le bras valide (Magnus 2013) et par
 *    l'imagerie de contractions (Clark 2014).
 *
 * Trois semaines : construire, charger, alléger ; debout sur une jambe, jamais
 * d'échec — avec un plâtre, l'échec, c'est la chute. Les marches longues
 * disparaissent : il le demande, et la force est ce que le plâtre laisse
 * gagner. Le fractionné reste : c'est lui qui garde la VO2max.
 */

/** La semaine du bloc : 0, les trois jours d'ouverture ; 1 construire ; 2 charger ; 3 alléger. */
export type BlockWeek = 0 | 1 | 2 | 3;

interface BlockDose {
  /** Séries des exercices principaux, par jambe pour ceux d'une jambe. */
  main: number;
  /** Séries des exercices secondaires. */
  second: number;
  /** Séries des exercices d'appoint. */
  acc: number;
  /** Répétitions des exercices principaux. */
  mainReps: number;
  /** Répétitions gardées en réserve à la fin de chaque série. */
  reserve: number;
  /** Le sac de la semaine, en clair ; vide : sans sac. */
  pack: string;
  /** Les exercices qui se durcissent : la version « plus dur » de la fiche. */
  harder: boolean;
  /** Isométrie des mollets, séries par jambe. */
  isoSets: number;
  /** Le fractionné en côte : des répétitions de 3 min. */
  climb: { reps: number; zone: ZoneKey };
  /** Montées continues lestées : des séries de `min`. */
  me: { sets: number; min: number };
  /** Chaise contre le mur, s. */
  wallS: number;
  /** Gainage sur le côté, s. */
  holdS: number;
}

const BLOCK_DOSE: Record<BlockWeek, BlockDose> = {
  0: {
    main: 3, second: 3, acc: 2, mainReps: 10, reserve: 3, pack: '', harder: false, isoSets: 3,
    climb: { reps: 4, zone: 'Z4' }, me: { sets: 2, min: 4 }, wallS: 60, holdS: 40,
  },
  1: {
    main: 4, second: 3, acc: 3, mainReps: 8, reserve: 2,
    pack: 'Le sac à dos de 6 à 8 kg — quatre à cinq bouteilles d\'eau de 1,5 L.', harder: false, isoSets: 4,
    climb: { reps: 5, zone: 'Z4' }, me: { sets: 3, min: 6 }, wallS: 75, holdS: 45,
  },
  2: {
    main: 5, second: 4, acc: 3, mainReps: 6, reserve: 1,
    pack: 'Le sac à dos de 10 à 12 kg — sept à huit bouteilles d\'eau de 1,5 L.', harder: true, isoSets: 5,
    climb: { reps: 6, zone: 'Z4' }, me: { sets: 3, min: 8 }, wallS: 90, holdS: 50,
  },
  3: {
    main: 2, second: 2, acc: 2, mainReps: 8, reserve: 3, pack: 'Le sac à dos de 8 kg.', harder: false, isoSets: 3,
    climb: { reps: 4, zone: 'Z4' }, me: { sets: 2, min: 6 }, wallS: 60, holdS: 40,
  },
};

/** Le bloc commence un vendredi : le 09/10, les tests. */
const BLOCK_DAYS = 24;

/** La semaine du jour `index` du bloc (0 = le 09/10). */
export const blockWeekOf = (index: number): BlockWeek =>
  (index < 3 ? 0 : Math.min(3, Math.floor((index - 3) / 7) + 1)) as BlockWeek;

/** Le côté qu'un test dit faible, et ce qu'il en a mesuré. */
export interface WeakSide {
  side: 'gauche' | 'droite';
  /** « au test, 91 montées contre 117 » : ce qui se lit dans la séance. */
  measured: string;
}

/** Les côtés faibles des tests : mollets, hanches (le pont), équilibre, cheville. */
export interface WeakSides {
  calves?: WeakSide;
  hips?: WeakSide;
  balance?: WeakSide;
  ankle?: WeakSide;
}

/**
 * La règle des côtés faibles, telle que la fiche des tests l'annonce : plus de
 * 10 % d'écart entre les deux jambes, une série de plus du côté faible jusqu'aux
 * tests de fin. Pour la cheville, 1,5 cm — l'écart que l'on sait mesurer de façon
 * fiable au test du genou au mur. Ce sont les derniers tests faits avant `until`
 * qui comptent.
 */
export function weakSides(results: readonly StrengthTestResult[], until: string): WeakSides {
  const last = (test: string) =>
    results
      .filter((r) => r.test === test && r.date <= until && r.left != null && r.right != null)
      .sort((a, b) => a.date.localeCompare(b.date))
      .at(-1);
  const out: WeakSides = {};
  // « 91 montées contre 117 » : l'unité une fois, sauf pour les secondes, qui se disent deux fois.
  const ratio = (test: string, unit: string, both = false): WeakSide | undefined => {
    const r = last(test);
    if (!r) return undefined;
    const [l, d] = [r.left!, r.right!];
    const high = Math.max(l, d);
    if (high <= 0 || (high - Math.min(l, d)) / high <= 0.1) return undefined;
    const side = l < d ? 'gauche' : 'droite';
    const [weak, strong] = side === 'gauche' ? [l, d] : [d, l];
    return { side, measured: `au test, ${weak} ${unit} contre ${strong}${both ? ` ${unit}` : ''}` };
  };
  const calves = ratio('test-mollets', 'montées');
  const hips = ratio('test-pont', 'ponts');
  const balance = ratio('test-equilibre', 's', true);
  if (calves) out.calves = calves;
  if (hips) out.hips = hips;
  if (balance) out.balance = balance;
  const ankle = last('test-cheville');
  if (ankle && Math.abs(ankle.left! - ankle.right!) >= 1.5) {
    const side = ankle.left! < ankle.right! ? 'gauche' : 'droite';
    const [weak, strong] = side === 'gauche' ? [ankle.left!, ankle.right!] : [ankle.right!, ankle.left!];
    out.ankle = { side, measured: `au test, ${weak} cm contre ${strong}` };
  }
  return out;
}

/** Les parties d'une séance, dans les mots de la séance. */
const PART = {
  warmUp: 'Échauffement',
  tests: 'Les tests',
  legs: 'Jambes',
  hips: 'Hanches',
  posterior: 'Chaîne arrière',
  adductors: 'Adducteurs',
  calves: 'Mollets',
  calvesFeet: 'Mollets et pieds',
  ankleBalance: 'Chevilles et équilibre',
  arm: 'Bras valide',
  core: 'Tronc',
  walk: 'Marche',
  intervals: 'Fractionné',
  coolDown: 'Retour au calme',
  climbs: 'Endurance des montées',
  mobility: 'Souplesse',
  cast: 'Bras plâtré et respiration',
} as const;

/** Ce qu'un exercice demande, dit pour être suivi en le faisant. */
interface Rx {
  label: string;
  /** Séries, par côté quand `sides` est dit. */
  sets: number;
  reps?: number;
  /** Un maintien, s par série. */
  holdS?: number;
  sides?: 'jambe' | 'côté';
  /** Repos après chaque série — après les deux côtés pour un exercice d'une jambe. */
  restS: number;
  tempo?: string;
  reserve?: number;
  pulse?: { workS: number; restS: number };
  effort?: string;
  /** Ce que la séance ajoute à la fiche : le sac, la hauteur du step, ce qui change cette semaine. */
  notes?: string;
  /** Durée d'une série, s, quand ni le maintien ni l'effort guidé ne la donnent. */
  setS?: number;
  /** Le côté faible des tests, et les séries qu'il prend en plus. */
  weak?: { side?: WeakSide; sets: number };
}

/** Un exercice du bloc, rangé dans sa partie. */
function ex(exercise: ExerciseKey, part: string, r: Rx): SessionBlock {
  const setS = r.holdS ?? (r.pulse && r.reps ? r.reps * (r.pulse.workS + r.pulse.restS) : r.setS ?? 45);
  const weak = r.sides === 'jambe' && r.weak?.side ? { ...r.weak.side, sets: r.weak.sets } : undefined;
  const notes = [
    weak ? `Jambe ${weak.side} : ${weak.sets > 1 ? `${weak.sets} séries` : 'une série'} de plus — ${weak.measured}.` : '',
    r.notes ?? '',
  ].filter(Boolean).join(' ');
  return {
    label: r.label,
    part,
    exercise,
    zone: r.holdS ? 'Z2' : 'Z3',
    durationS: setS,
    repeat: (r.sides ? r.sets * 2 : r.sets) + (weak?.sets ?? 0),
    ...(r.reps ? { reps: r.reps } : {}),
    ...(r.sides ? { sides: r.sides } : {}),
    ...(weak ? { extra: { side: weak.side, sets: weak.sets } } : {}),
    ...(r.tempo ? { tempo: r.tempo } : {}),
    ...(r.reserve != null ? { reserve: r.reserve } : {}),
    ...(r.pulse ? { pulse: r.pulse } : {}),
    effort: r.effort ?? (r.reserve != null ? reserveText(r.reserve) : r.holdS ? 'Tenir sans trembler' : 'Contrôlé'),
    ...(notes ? { notes } : {}),
    recovery: { durationS: r.restS, zone: 'Z1', active: false, betweenReps: true },
  };
}

/** Le sac de la semaine, devant ce que la séance ajoute. */
const withPack = (d: BlockDose, rest = '') => [d.pack, rest].filter(Boolean).join(' ') || undefined;

function blockWarmUp(model: PhysiologyModel): SessionBlock {
  // Ses consignes sont dans la fiche ; un échauffement à la maison ne se pilote pas au cœur.
  const { hrRange: _hr, provenance: _p, notes: _n, ...rest } = homeWarmUp(model);
  return { ...rest, part: PART.warmUp };
}

/**
 * Le bras plâtré et la respiration, chaque jour ; l'imagerie s'y ajoute du lundi
 * au vendredi — imaginer des contractions maximales, sans contracter : quatre
 * semaines de plâtre ont coûté deux fois moins de force du poignet à ceux qui
 * la pratiquaient (Clark 2014).
 */
function armCare(weekday: boolean): SessionBlock[] {
  return [
    ...daily().map((b) => ({ ...b, part: PART.cast })),
    ...(weekday
      ? [{
          label: 'Imagerie du bras plâtré', kind: 'mobility' as const, part: PART.cast, zone: 'Z1' as const,
          durationS: 130, repeat: 4, reps: 13, pulse: { workS: 5, restS: 5 }, exercise: 'imagerie',
          notes: 'Une série sur deux, imagine que tu tends le coude.',
          recovery: { durationS: 60, zone: 'Z1' as const, active: false, betweenReps: true },
        }]
      : []),
  ];
}

/** Le mollet sous le cadre de porte, isométrie lourde : le tendon d'Achille, deux fois par semaine. */
const calfIso = (d: BlockDose, w: WeakSides, part: string = PART.calves) =>
  ex('mollets-iso', part, {
    label: 'Mollet sous le cadre de porte', sets: d.isoSets, reps: 4, sides: 'jambe', pulse: { workS: 3, restS: 3 },
    restS: 20, effort: 'Pousse à fond', weak: { side: w.calves, sets: 1 },
  });

/** L'équilibre, yeux fermés : le côté faible des tests d'abord, deux fois de plus. */
const balance = (w: WeakSides, part: string) =>
  ex('equilibre', part, { label: 'Équilibre yeux fermés', sets: 1, holdS: 45, sides: 'jambe', restS: 15, weak: { side: w.balance, sets: 2 } });

/** La cheville qui plie le moins aux tests : une fois de plus de ce côté. */
const ankle = (w: WeakSides, part: string) =>
  ex('cheville-mobilite', part, {
    label: 'Cheville, genou au mur', sets: 1, reps: 15, sides: 'jambe', restS: 0, setS: 60, effort: 'Sans forcer',
    tempo: '2 s au mur, puis tu reviens', weak: { side: w.ankle, sets: 1 },
  });

/** Pousser et tirer avec le bras valide, l'un après l'autre. */
const pushPull = (d: BlockDose): SessionBlock[] => [
  ex('pousse-elastique', PART.arm, {
    label: 'Poussée à un bras', sets: d.acc, reps: 10, restS: 30, reserve: d.reserve, setS: 40,
    tempo: '1 s pour pousser, 1 s tenue, 2 s pour revenir', notes: 'Trois élastiques sur la poignée, si tu tiens 10 propres.',
  }),
  ex('tirage-elastique', PART.arm, {
    label: 'Tirage à un bras', sets: d.acc, reps: 10, restS: 30, reserve: d.reserve, setS: 40,
    tempo: '1 s pour tirer, 1 s tenue, 2 s pour rendre', notes: 'Trois élastiques sur la poignée, si tu tiens 10 propres.',
  }),
];

/** Les adducteurs : la Copenhague du côté où elle se fait, le coussin pour les deux. */
const adductors = (d: BlockDose): SessionBlock[] => [
  ex('copenhague', PART.adductors, {
    label: 'Copenhague, la jambe du côté du plâtre', sets: d.harder ? 3 : 2, reps: d.harder ? 10 : 8, restS: 45,
    tempo: '1 s pour monter, 2 s pour redescendre', setS: 30,
  }),
  ex('adducteurs-coussin', PART.adductors, {
    label: 'Serrage de coussin', sets: 1, reps: 6, pulse: { workS: 10, restS: 10 }, restS: 0, effort: 'Serre à fond',
  }),
];

const deadBug = (part: string, effort = 'Dos plaqué') =>
  ex('dead-bug', part, {
    label: 'Dead bug, jambes seules', sets: 2, reps: 10, restS: 30, effort, setS: 40,
    tempo: '3 s pour descendre le talon, en alternant les jambes',
  });

/** Les tests du premier et du dernier jour, un par étape. */
export function blockTests(model: PhysiologyModel, when: 'start' | 'end'): SessionTemplate {
  const start = when === 'start';
  const test = (exercise: ExerciseKey, label: string, r: Omit<Rx, 'label' | 'effort'> & { effort?: string }) =>
    ex(exercise, PART.tests, { label, effort: 'Jusqu\'à l\'échec', ...r });
  return template(model, `bloc_tests_${when}`, 'strength', start ? 'Tests de départ' : 'Tests de fin de bloc',
    start
      ? 'Savoir d\'où tu pars : sept mesures, chacune vise une de tes lacunes ou un pilier du trail long. Le ' +
          '1er novembre, les mêmes diront ce que tu as gagné.'
      : 'Les sept mesures du 9 octobre, dans le même ordre et à la même heure : ce que trois semaines de force ont ' +
          'changé, jambe par jambe.',
    [
      blockWarmUp(model),
      test('test-mollets', 'Mollets, sur un pied', { sets: 1, sides: 'jambe', setS: 75, restS: 120 }),
      test('test-pont', 'Pont sur une jambe, talon sur le step', { sets: 1, sides: 'jambe', setS: 75, restS: 120 }),
      test('test-chaise', 'Chaise contre le mur', { sets: 1, setS: 180, restS: 120 }),
      test('test-gainage', 'Gainage sur le côté', { sets: 1, setS: 90, restS: 120 }),
      test('test-equilibre', 'Équilibre yeux fermés', {
        sets: 3, sides: 'jambe', setS: 60, restS: 20, effort: '60 s au plus', notes: 'Trois essais par jambe : note le meilleur.',
      }),
      test('test-cheville', 'Cheville, genou au mur', { sets: 1, sides: 'jambe', setS: 90, restS: 30, effort: 'La mesure' }),
      test('test-souplesse', 'Souplesse, debout', { sets: 1, setS: 60, restS: 0, effort: 'La mesure' }),
      // Le vendredi des tests de départ est un jour de semaine, le dimanche des tests de fin non.
      ...armCare(start),
    ]);
}

/** Force A — les genoux et les descentes : le quadriceps qui freine, chargé. */
export function blockForceA(model: PhysiologyModel, week: BlockWeek, w: WeakSides): SessionTemplate {
  const d = BLOCK_DOSE[week];
  return template(model, `bloc_force_a_${week}`, 'strength', 'Force A : genoux et descentes',
    'Le quadriceps qui freine en s\'allongeant, chargé : ton aisance en descente, mesurée sur tes sorties, est à ' +
      '0,68 de celle d\'un bon traileur — ta marge la plus nette pour la Maxi-Race. Et le bras valide, qui ' +
      'entretient l\'autre.',
    [
      blockWarmUp(model),
      ex('split-squat-maison', PART.legs, {
        label: 'Fente bulgare lestée', sets: d.main, reps: d.mainReps, sides: 'jambe', restS: 90, reserve: d.reserve,
        setS: 55, tempo: '3 s pour descendre, 1 s en bas, 1 s pour monter',
        notes: d.pack ? withPack(d) : 'Sans sac aujourd\'hui : les tests d\'hier pèsent encore.',
      }),
      ex('descente-marche', PART.legs, {
        label: 'Descente lente du step', sets: d.second, reps: 6, sides: 'jambe', restS: 60, reserve: d.reserve,
        setS: 45, tempo: '5 s pour descendre, 1 s pour remonter',
        notes: withPack(d, 'Le step à 20 cm, la main valide au mur.'),
      }),
      ex('reverse-nordic', PART.legs, {
        label: 'Bascule arrière à genoux', sets: d.second, reps: d.harder ? 8 : 6, restS: 75, reserve: d.reserve,
        setS: 35, tempo: '3 s pour partir en arrière, 2 s pour revenir',
      }),
      ex('chaise-une-jambe', PART.legs, {
        label: 'Chaise sur une jambe', sets: d.acc, holdS: d.harder ? 40 : 30, sides: 'jambe', restS: 30,
      }),
      // Le lendemain des tests, les mollets sont vidés : l'isométrie attend lundi.
      ...(week === 0 ? [] : [calfIso(d, w)]),
      ...pushPull(d),
      deadBug(PART.core),
      ...armCare(true),
    ]);
}

/** Force B — la chaîne arrière : les fessiers et l'arrière des cuisses, le moteur des montées. */
export function blockForceB(model: PhysiologyModel, week: BlockWeek, w: WeakSides): SessionTemplate {
  const d = BLOCK_DOSE[week];
  return template(model, `bloc_force_b_${week}`, 'strength', 'Force B : chaîne arrière',
    'Les fessiers et l\'arrière des cuisses poussent dans chaque montée — 5 000 m à la Maxi-Race — et retiennent la ' +
      'jambe à chaque foulée. Chargés, sur une jambe, le côté faible des tests en premier.',
    [
      blockWarmUp(model),
      ex('souleve-une-jambe', PART.posterior, {
        label: 'Soulevé de terre sur une jambe, lesté', sets: d.main, reps: d.mainReps, sides: 'jambe', restS: 75,
        reserve: d.reserve, setS: 50, tempo: '3 s pour descendre, 1 s pour remonter',
        notes: withPack(d, 'La main valide sur l\'encadrement.'), weak: { side: w.hips, sets: 1 },
      }),
      ex('hip-thrust', PART.posterior, {
        label: 'Pont sur le canapé', sets: d.second, reps: 12, sides: 'jambe', restS: 45, reserve: d.reserve, setS: 45,
        tempo: '1 s pour monter, 2 s tenues, 2 s pour redescendre', weak: { side: w.hips, sets: 1 },
        notes: d.harder ? 'Cette semaine, le sac posé sur le bassin, tenu par la main valide.' : undefined,
      }),
      ex('leg-curl-serviette', PART.posterior, {
        label: 'Flexion des jambes sur serviette', sets: d.second, reps: d.harder ? 8 : 6, restS: 75,
        reserve: d.reserve, setS: 40, tempo: '4 s pour faire glisser les talons',
        notes: d.harder ? 'Cette semaine, sur une jambe à la dernière série.' : undefined,
      }),
      ...adductors(d),
      ex('bras-elastique', PART.arm, {
        label: 'Plier, tendre, serrer', sets: 2, reps: 12, restS: 60, reserve: d.reserve, setS: 180,
        tempo: '1 s pour plier ou tendre, 3 s pour revenir',
        notes: 'Un tour : 12 flexions (accroche en bas de porte), 12 extensions (accroche en haut), 10 serrages de 5 s.',
      }),
      ex('bras-elastique', PART.arm, {
        label: 'Le maximum, sous la table', sets: 2, reps: 3, pulse: { workS: 5, restS: 10 }, restS: 30,
        effort: 'De toutes tes forces',
        notes: 'Assis à une table, coude à angle droit : une série paume sous le plateau, pousse vers le haut ; une série paume dessus, pousse vers le bas.',
      }),
      ...armCare(true),
    ]);
}

/**
 * Le moteur et les mollets : le fractionné en côte, dans les escaliers — pas sur
 * le step, qui ne monte pas le cœur assez haut —, puis les mollets chargés, la
 * cheville et l'équilibre.
 */
export function blockMoteur(model: PhysiologyModel, week: BlockWeek, w: WeakSides): SessionTemplate {
  const d = BLOCK_DOSE[week];
  const { reps, zone } = d.climb;
  const vert = 55;
  return template(model, `bloc_moteur_${week}`, 'cross_training', 'Moteur et mollets',
    'L\'intensité garde ta VO2max quand le volume baisse : un fractionné par semaine suffit. Puis les mollets, très ' +
      'endurants à tes tests, qui ne progressent plus qu\'en charge.',
    [
      heart(model, 'Marche progressive', 'Z2', 15 * 60, {
        exercise: 'marche-cote', part: PART.warmUp, notes: 'Jusqu\'au pied des escaliers, en accélérant peu à peu.',
      }),
      {
        ...heart(model, 'Montées rapides au seuil', zone, 180, {
          exercise: 'marche-cote',
          part: PART.intervals,
          elevationGainM: vert,
          notes:
            'Effort 7 sur 10, phrases courtes : monte vite, en marche, une marche à la fois, la main valide près de ' +
            'la rampe. Escaliers de Fourvière ou montée de la Grande-Côte, secs ; s\'il pleut, ceux de ton immeuble. ' +
            'Entre deux, redescends lentement à la rampe : c\'est la récupération.',
        }),
        repeat: reps,
        recovery: { durationS: 180, zone: 'Z1', active: true, betweenReps: true, elevationLossM: vert },
      },
      heart(model, 'Marche facile', 'Z1', 10 * 60, {
        exercise: 'marche', part: PART.coolDown, elevationLossM: vert, notes: 'La dernière descente, lente, puis à plat.',
      }),
      ex('mollets-charges', PART.calvesFeet, {
        label: 'Mollet lesté, sur un pied', sets: d.second + 1, reps: d.harder ? 6 : 8, sides: 'jambe', restS: 60,
        reserve: d.reserve, setS: 60, tempo: '3 s pour monter, 1 s en haut, 3 s pour redescendre',
        notes: withPack(d, 'Le step à 20 cm contre un mur.'), weak: { side: w.calves, sets: 1 },
      }),
      ex('soleaire-assis', PART.calvesFeet, {
        label: 'Soléaire assis, sac sur les genoux', sets: d.second, reps: d.harder ? 10 : 12, restS: 45,
        reserve: d.reserve, setS: 45, tempo: '1 s pour monter, 1 s en haut, 3 s pour redescendre',
        notes: d.harder ? 'Le sac le plus lourd que tu as.' : withPack(d),
      }),
      ex('releves-pointe', PART.calvesFeet, {
        label: 'Relevés de pointe', sets: 2, reps: 20, restS: 30, setS: 40, effort: 'Jusqu\'à la brûlure',
        tempo: '1 s pour lever, 2 s pour redescendre',
      }),
      ankle(w, PART.ankleBalance),
      balance(w, PART.ankleBalance),
      ex('pied-court', PART.ankleBalance, {
        label: 'Pied court', sets: 1, reps: 10, sides: 'jambe', pulse: { workS: 5, restS: 3 }, restS: 0, effort: 'Lent',
        notes: 'Puis 10 gros orteils seuls et 10 fois les quatre autres.' + (d.harder ? ' Cette semaine, debout.' : ''),
      }),
      ...armCare(true),
    ]);
}

/** Force C — une jambe et la puissance : les relances, et la force sur un seul appui. */
export function blockForceC(model: PhysiologyModel, week: BlockWeek, w: WeakSides): SessionTemplate {
  const d = BLOCK_DOSE[week];
  return template(model, `bloc_force_c_${week}`, 'strength', 'Force C : une jambe, puissance',
    'La puissance des relances et la force sur un seul appui — celui de chaque foulée, en montée comme en descente : ' +
      'monter vite, descendre lentement, sur une jambe.',
    [
      blockWarmUp(model),
      ex('montee-tabouret', PART.legs, {
        label: 'Montée explosive sur le step', sets: d.main, reps: 5, sides: 'jambe', restS: 75, reserve: d.reserve,
        setS: 40, tempo: 'Monte le plus vite possible sans sauter, redescends en 3 s',
        notes: 'Le step à 40 cm calé contre un mur.' + (d.harder ? ' Cette semaine, le sac de 5 kg.' : ''),
      }),
      ex('squat-une-jambe', PART.legs, {
        label: 'Squat sur une jambe, jusqu\'au step', sets: d.second, reps: d.harder ? 8 : 6, sides: 'jambe',
        restS: 60, reserve: d.reserve, setS: 45, tempo: '4 s pour descendre, 1 s pour te relever',
        notes: d.harder ? 'Cette semaine, le sac sur le dos.' : undefined,
      }),
      ex('reverse-nordic', PART.legs, {
        label: 'Bascule arrière à genoux', sets: d.acc, reps: 8, restS: 75, reserve: d.reserve, setS: 35,
        tempo: '3 s pour partir en arrière, 2 s pour revenir',
      }),
      calfIso(d, w),
      balance(w, PART.ankleBalance),
      ...pushPull(d),
      ...armCare(true),
    ]);
}

/** Les hanches et le tronc : le bassin qui tient quand la fatigue arrive. */
export function blockHanches(model: PhysiologyModel, week: BlockWeek, w: WeakSides): SessionTemplate {
  const d = BLOCK_DOSE[week];
  return template(model, `bloc_hanches_${week}`, 'strength', 'Hanches et tronc',
    'Le moyen fessier, les adducteurs et le tronc tiennent le bassin quand la fatigue arrive — sur 100 km de backyard ' +
      'comme dans les dévers de la Maxi-Race. Une séance plus légère pour les grosses cuisses, avant l\'endurance de ' +
      'samedi.',
    [
      blockWarmUp(model),
      ex('pas-chasses', PART.hips, {
        label: 'Pas chassés à la mini-bande', sets: d.acc, reps: 15, sides: 'côté', restS: 30, setS: 35,
        effort: 'Jusqu\'à la brûlure', notes: 'La mini-bande la plus dure, aux chevilles ; la bande toujours tendue.',
      }),
      ex('montee-genou', PART.hips, {
        label: 'Montée de genou sur le dos', sets: d.acc, reps: 10, sides: 'jambe', restS: 20, setS: 30,
        effort: 'Bas du dos collé', tempo: '1 s pour monter le genou, 2 s pour repartir',
      }),
      ex('pont-une-jambe', PART.hips, {
        label: 'Pont sur une jambe, au sol', sets: 2, reps: 15, sides: 'jambe', restS: 30, setS: 45,
        tempo: '1 s pour monter, 2 s serrées en haut', effort: 'Jusqu\'à la brûlure', weak: { side: w.hips, sets: 1 },
      }),
      ...adductors(d),
      ex('port-valise', PART.core, {
        label: 'Port de valise, à une main', sets: 4, holdS: d.harder ? 60 : 40, restS: 45,
        notes: withPack(d, 'Le sac dans la main valide, sans pencher.'),
      }),
      ex('gainage-lateral', PART.core, { label: 'Gainage sur le côté', sets: 3, holdS: d.holdS, restS: 45 }),
      ex('anti-rotation', PART.core, {
        label: 'Anti-rotation', sets: 2, reps: 8, sides: 'côté', restS: 30, setS: 40, effort: 'Bras tendu 3 s',
        tempo: '2 s pour tendre, 3 s tenu, 2 s pour revenir', notes: 'Un élastique de 6 ou 7 kg.',
      }),
      deadBug(PART.core),
      { ...souplesse(600), part: PART.mobility },
      ...armCare(true),
    ]);
}

/** L'endurance des montées : longtemps, sous charge — la durabilité des trails longs. */
export function blockEndurance(model: PhysiologyModel, week: BlockWeek, w: WeakSides): SessionTemplate {
  const d = BLOCK_DOSE[week];
  return template(model, `bloc_endurance_${week}`, 'strength', 'Endurance des montées',
    'Ta durabilité, moyenne sur les sorties longues, est ton plus gros gisement : c\'est elle qui fait tenir quinze ' +
      'boucles ou 5 000 m de dénivelé. Des montées continues lestées, des fentes, la chaise : longtemps, sous charge.',
    [
      blockWarmUp(model),
      {
        ...heart(model, 'Montées continues lestées', 'Z2', d.me.min * 60, {
          exercise: 'montee-tabouret',
          part: PART.climbs,
          notes: withPack(d,
            'Le step à 40 cm : une montée toutes les 2 s, change de jambe toutes les 30 s, la main au mur. Arrête si ' +
              'la jambe tremble.'),
        }),
        repeat: d.me.sets,
        recovery: { durationS: 120, zone: 'Z1', active: true, betweenReps: true },
      },
      ex('fente-arriere', PART.climbs, {
        label: 'Fente arrière lestée', sets: d.second, reps: d.harder ? 15 : 12, sides: 'jambe', restS: 60, setS: 60,
        effort: 'Jusqu\'à la brûlure', tempo: '2 s pour descendre, 1 s pour revenir', notes: withPack(d),
      }),
      ex('chaise', PART.climbs, { label: 'Chaise contre le mur', sets: week === 3 ? 2 : 3, holdS: d.wallS, restS: 60 }),
      ex('pont-une-jambe', PART.climbs, {
        label: 'Pont sur une jambe, au sol', sets: 2, reps: 20, sides: 'jambe', restS: 30, setS: 50,
        tempo: '1 s pour monter, 1 s pour redescendre', effort: 'Jusqu\'à la brûlure', weak: { side: w.hips, sets: 1 },
      }),
      ...armCare(false),
    ]);
}

/** La récupération du dimanche : la semaine s'assimile, la souplesse se gagne. */
export function blockRecup(model: PhysiologyModel, w: WeakSides): SessionTemplate {
  return template(model, 'bloc_recup', 'cross_training', 'Récupération',
    'La semaine s\'assimile : c\'est maintenant que le muscle se construit. La cheville et l\'équilibre du côté ' +
      'faible, la souplesse, une marche facile.',
    [
      heart(model, 'Marche facile, à plat', 'Z1', 30 * 60, {
        exercise: 'marche', part: PART.walk, notes: 'Quais, parc de la Tête d\'Or : tu dois pouvoir parler tout du long.',
      }),
      { ...souplesse(900), part: PART.mobility },
      ankle(w, PART.ankleBalance),
      balance(w, PART.ankleBalance),
      ex('pied-court', PART.ankleBalance, {
        label: 'Pied court', sets: 1, reps: 10, sides: 'jambe', pulse: { workS: 5, restS: 3 }, restS: 0, effort: 'Lent',
      }),
      ...armCare(false),
    ]);
}

/**
 * Le jour `index` du bloc (0 = le vendredi 09/10) : les tests, puis la semaine
 * type — force A, force B, moteur et mollets, force C, hanches et tronc,
 * endurance des montées, récupération. Le samedi 10/10 ouvre par la force A,
 * le dernier dimanche refait les tests. `weak` : les côtés faibles des tests.
 */
export function blockDay(model: PhysiologyModel, index: number, weak: WeakSides = {}): SessionTemplate {
  if (index === 0) return blockTests(model, 'start');
  if (index === BLOCK_DAYS - 1) return blockTests(model, 'end');
  if (index === 1) return blockForceA(model, 0, weak);
  if (index === 2) return blockRecup(model, weak);
  const week = blockWeekOf(index);
  const dow = (index + 4) % 7;
  return [
    () => blockForceA(model, week, weak),
    () => blockForceB(model, week, weak),
    () => blockMoteur(model, week, weak),
    () => blockForceC(model, week, weak),
    () => blockHanches(model, week, weak),
    () => blockEndurance(model, week, weak),
    () => blockRecup(model, weak),
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
  // Le bloc de force règle ses séries sur le côté faible des derniers tests.
  const weak = opts.program === 'block' ? weakSides(await db.listStrengthTests(athleteId), opts.from) : {};
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
      program === 'block' ? blockDay(model, index, weak)
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
