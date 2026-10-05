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
        exercise: 'marche-cote',
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
        exercise: 'marche-cote', notes: 'Quais, parc de la Tête d\'Or : tu dois pouvoir parler tout du long.',
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
  opts: { from: string; days: number; reason: string; at?: string },
): Promise<{ updated: number; inserted: number; cancelled: number }> {
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

  for (let i = 0; i < opts.days; i++) {
    const date = addDays(opts.from, i);
    const week = Math.min(4, Math.floor(i / 7) + 1);
    const t = compensationDay(model, i);
    const why = `${opts.reason} Programme de compensation, semaine ${week} sur 4.`;
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
      `${opts.reason} Programme de compensation du ${opts.from.slice(8, 10)}/${opts.from.slice(5, 7)} au ` +
      `${to.slice(8, 10)}/${to.slice(5, 7)} : renforcement, marche en côte, fractionné sans impact, une séance par jour.`,
    changes,
  });
  return { updated, inserted, cancelled };
}
