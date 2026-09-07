import type {
  PhysiologyModel, SessionBlock, SessionSuccessCriterion, SessionType, ZoneKey,
} from '@cairn/core';
import { buildZones, formatPace, msToKmh, speedForMetabolicPower, vam } from '@cairn/physiology';

/**
 * Bibliothèque de séances.
 *
 * Chaque séance est une **fonction du modèle physiologique**, jamais un texte
 * figé. « 6 × 3 min » ne veut rien dire ; « 6 × 3 min à 16,9-17,4 km/h,
 * 171-175 bpm, récupération 90 s en trottinant » est une prescription. Quand la
 * vitesse critique de Pierre bouge de 2 %, toutes les allures de toutes les
 * séances suivent, sans intervention.
 *
 * Les formats retenus suivent les recommandations du test du 24/07/2025 :
 * fractionné court 1'-1' et 30"-30" en PMA, fractionné moyen 3-12 min en
 * résistance dure, rando-course en montagne, et un seul fractionné par semaine
 * en alternant court et moyen.
 */

export interface SessionTemplate {
  key: string;
  type: SessionType;
  title: string;
  intent: string;
  /** Durée totale approximative, s — sert au placement dans la semaine. */
  durationS: number;
  /** Dénivelé positif requis, m. */
  elevationGainM: number;
  priority: 'key' | 'support' | 'optional';
  /** Phases où la séance a du sens. */
  phases: string[];
  blocks: SessionBlock[];
  plannedLoad: number;
  plannedMechanicalLoad: number;
  plannedDistanceM?: number;
}

interface Ctx {
  model: PhysiologyModel;
  zones: ReturnType<typeof buildZones>;
}

const ctxOf = (model: PhysiologyModel): Ctx => ({ model, zones: buildZones(model) });

const zoneOf = (c: Ctx, key: ZoneKey) => c.zones.find((z) => z.key === key)!;

/** Fourchette d'allure lisible, à partir d'une fourchette de vitesse. */
const paceRange = (lo: number, hi: number): [string, string] => [formatPace(hi), formatPace(lo)];

function block(
  c: Ctx,
  label: string,
  zone: ZoneKey,
  durationS: number,
  opts: Partial<SessionBlock> & { speedLo?: number; speedHi?: number } = {},
): SessionBlock {
  const z = zoneOf(c, zone);
  const lo = opts.speedLo ?? z.speedMinMs;
  const hi = opts.speedHi ?? z.speedMaxMs;
  const b: SessionBlock = {
    label,
    zone,
    durationS,
    hrRange: [Math.round(z.hrMin), Math.round(z.hrMax)],
    speedRangeMs: [lo, hi],
    paceRange: paceRange(lo, hi),
  };
  if (opts.kind) b.kind = opts.kind;
  if (opts.repeat) b.repeat = opts.repeat;
  if (opts.recovery) b.recovery = opts.recovery;
  if (opts.notes) b.notes = opts.notes;
  if (opts.elevationGainM) b.elevationGainM = opts.elevationGainM;
  if (opts.vamTargetMh) b.vamTargetMh = opts.vamTargetMh;
  if (opts.cadenceTargetSpm) b.cadenceTargetSpm = opts.cadenceTargetSpm;
  if (opts.distanceM) b.distanceM = opts.distanceM;
  return b;
}

/**
 * Charge métabolique prévisionnelle d'une séance, par la même formule que le
 * réalisé (rTSS) : durée × IF², rapportée à une heure au seuil. Prévu et réalisé
 * sont ainsi directement comparables — condition sine qua non d'un PMC honnête.
 */
function estimateLoad(model: PhysiologyModel, blocks: SessionBlock[]): number {
  let tss = 0;
  for (const b of blocks) {
    // Un bloc annexe — souplesse, respiration — n'est pas couru : lui prêter la
    // vitesse de sa zone lui ferait produire une charge qui n'existe pas.
    if (b.kind) continue;
    const reps = b.repeat ?? 1;
    const dur = b.durationS ?? 0;
    const mid = b.speedRangeMs ? (b.speedRangeMs[0] + b.speedRangeMs[1]) / 2 : model.vt1.speedMs * 0.8;
    const intensity = mid / model.vt2.speedMs;
    tss += reps * (dur / 3600) * intensity ** 2 * 100;
    if (b.recovery) {
      const rIntensity = b.recovery.active ? 0.55 : 0.2;
      tss += reps * (b.recovery.durationS / 3600) * rIntensity ** 2 * 100;
    }
  }
  return Math.round(tss);
}

/** Charge mécanique prévisionnelle : dominée par le dénivelé négatif. */
function estimateMechanical(elevationLossM: number, distanceM: number): number {
  // Calibration identique à `mechanicalLoad` : ~40 pts pour 1 000 m de D−.
  return Math.round((elevationLossM * 9.80665 * 1.25) / 300 + distanceM / 2500);
}

function totalDuration(blocks: SessionBlock[]): number {
  return blocks.reduce((a, b) => {
    const reps = b.repeat ?? 1;
    return a + reps * ((b.durationS ?? 0) + (b.recovery?.durationS ?? 0));
  }, 0);
}

/** Distance estimée depuis la vitesse moyenne pondérée des blocs. */
function totalDistance(blocks: SessionBlock[]): number {
  return blocks.reduce((a, b) => {
    if (b.kind) return a;
    const reps = b.repeat ?? 1;
    const mid = b.speedRangeMs ? (b.speedRangeMs[0] + b.speedRangeMs[1]) / 2 : 2.8;
    const rec = b.recovery ? b.recovery.durationS * (b.recovery.active ? 2.4 : 0.5) : 0;
    return a + reps * ((b.durationS ?? 0) * mid + rec);
  }, 0);
}

/**
 * Totaux d'une séance, déduits de ses blocs.
 *
 * Une séance dont les blocs sont remplacés doit voir *tous* ses totaux suivre —
 * durée, charge, distance, dénivelé et charge mécanique. Des totaux figés en
 * face d'un contenu neuf, c'est la même contradiction, un cran plus haut : une
 * sortie longue ramenée à 350 m D+ qui continue d'afficher la charge mécanique
 * des 700 m d'avant fausse le PMC mécanique, donc la règle qui protège les
 * quadriceps.
 *
 * Les blocs ne portent pas le dénivelé négatif : à défaut de `elevationLossM`,
 * on suppose un parcours en boucle, ce que descend l'athlète étant ce qu'il a
 * monté. La bibliothèque, elle, connaît le terrain des séances qu'elle écrit et
 * passe sa propre valeur — une séance de descente ne monte pas ce qu'elle
 * descend.
 */
export function sessionTotals(
  model: PhysiologyModel,
  blocks: SessionBlock[],
  elevationLossM?: number,
): {
  durationS: number;
  distanceM: number;
  elevationGainM: number;
  load: number;
  mechanicalLoad: number;
} {
  const distanceM = totalDistance(blocks);
  const elevationGainM = blocks.reduce((a, b) => a + (b.repeat ?? 1) * (b.elevationGainM ?? 0), 0);
  return {
    durationS: totalDuration(blocks),
    distanceM,
    elevationGainM,
    load: estimateLoad(model, blocks),
    mechanicalLoad: estimateMechanical(elevationLossM ?? elevationGainM, distanceM),
  };
}

function finalize(
  c: Ctx,
  base: Omit<SessionTemplate, 'durationS' | 'plannedLoad' | 'plannedMechanicalLoad'>,
  elevationLossM = 0,
): SessionTemplate {
  const { durationS, distanceM, load, mechanicalLoad } = sessionTotals(
    c.model,
    base.blocks,
    elevationLossM,
  );
  return {
    ...base,
    durationS,
    plannedDistanceM: Math.round(distanceM),
    plannedLoad: load,
    plannedMechanicalLoad: mechanicalLoad,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// Séances
// ─────────────────────────────────────────────────────────────────────────────

export function recovery(model: PhysiologyModel, durationMin = 40): SessionTemplate {
  const c = ctxOf(model);
  return finalize(c, {
    key: 'recovery',
    type: 'recovery',
    title: `Décrassage ${durationMin} min`,
    intent:
      "Accélérer la clairance métabolique sans ajouter la moindre contrainte. Le seul indicateur qui compte : la FC doit rester basse même si l'allure paraît ridicule.",
    elevationGainM: 0,
    priority: 'optional',
    phases: ['base', 'build', 'specific', 'peak', 'taper', 'recovery', 'transition'],
    blocks: [
      block(c, 'Footing très souple', 'Z1', durationMin * 60, {
        notes: 'Terrain plat et roulant. Si la FC dépasse la borne haute, marche — ce n\'est pas négociable.',
        cadenceTargetSpm: 172,
      }),
    ],
  });
}

export function endurance(model: PhysiologyModel, durationMin = 60, vertM = 0): SessionTemplate {
  const c = ctxOf(model);
  const z2 = zoneOf(c, 'Z2');
  return finalize(c, {
    key: 'endurance',
    type: 'endurance',
    title: `Endurance fondamentale ${durationMin} min${vertM ? ` · ${vertM} m D+` : ''}`,
    intent:
      'Développer la densité capillaire et la capacité oxydative : c\'est la zone qui construit le moteur des trails longs. Aisance respiratoire permanente, aucune dérive cardiaque.',
    elevationGainM: vertM,
    priority: 'support',
    phases: ['base', 'build', 'specific', 'peak', 'taper', 'transition'],
    blocks: [
      block(c, 'Footing en endurance aérobie', 'Z2', durationMin * 60, {
        elevationGainM: vertM,
        cadenceTargetSpm: 172,
        notes: `Cible ${Math.round(z2.hrMin)}-${Math.round(z2.hrMax)} bpm. Tu dois pouvoir tenir une conversation par phrases complètes.`,
      }),
    ],
  }, vertM);
}

export function longRun(model: PhysiologyModel, durationMin = 105, vertM = 300): SessionTemplate {
  const c = ctxOf(model);
  return finalize(c, {
    key: 'long_run',
    type: 'long_run',
    title: `Sortie longue ${Math.round(durationMin / 60 * 10) / 10} h · ${vertM} m D+`,
    intent:
      'Étendre la durabilité : maintenir un rendement stable sur la durée. C\'est ici que se gagne la seconde moitié des courses.',
    elevationGainM: vertM,
    priority: 'key',
    phases: ['base', 'build', 'specific', 'peak'],
    blocks: [
      block(c, 'Corps de sortie en endurance', 'Z2', (durationMin - 20) * 60, {
        elevationGainM: vertM,
        cadenceTargetSpm: 172,
        notes:
          'Surveille la dérive cardiaque : à allure constante, la FC ne doit pas monter de plus de 5 % entre la première et la seconde moitié.',
      }),
      block(c, 'Progression finale', 'Z3', 20 * 60, {
        notes: 'Vingt dernières minutes montées d\'un cran, sans jamais forcer la respiration. Habitue le corps à produire sur fatigue.',
      }),
    ],
  }, vertM);
}

/** Rando-course : le format spécifique recommandé par le laboratoire pour les trails longs. */
export function longTrail(model: PhysiologyModel, durationMin = 210, vertM = 1200): SessionTemplate {
  const c = ctxOf(model);
  const z2 = zoneOf(c, 'Z2');
  // Vitesse ascensionnelle cible : celle que permet la puissance métabolique de Z2 haute.
  const climbPower = 3.6 * z2.speedMaxMs * 0.94;
  const climbSpeed = speedForMetabolicPower(climbPower, 0.15);
  const targetVam = Math.round(vam(climbSpeed, 0.15));
  return finalize(c, {
    key: 'long_trail',
    type: 'long_trail',
    title: `Rando-course ${Math.round(durationMin / 60 * 10) / 10} h · ${vertM} m D+`,
    intent:
      "Spécificité trail pure : alterner marche et course selon la pente, tenir plusieurs heures sans dérive, et habituer les quadriceps à la descente. C'est la séance qui différencie un coureur de route d'un traileur.",
    elevationGainM: vertM,
    priority: 'key',
    phases: ['base', 'build', 'specific'],
    blocks: [
      block(c, 'Approche en endurance', 'Z2', 25 * 60, { cadenceTargetSpm: 172 }),
      block(c, 'Montées — marche active ou course selon la pente', 'Z2', Math.round((durationMin - 45) * 60 * 0.45), {
        elevationGainM: vertM,
        vamTargetMh: targetVam,
        notes:
          `Cible ${targetVam} m D+/h. Au-delà de 15 % de pente, marche : mains sur les cuisses, buste droit, petits pas. Courir là serait 25 % plus coûteux pour la même vitesse.`,
      }),
      block(c, 'Descentes — travail technique', 'Z2', Math.round((durationMin - 45) * 60 * 0.35), {
        notes:
          'Cadence haute, appuis courts et légers, regard 4-5 m devant, épaules relâchées. Cherche la fluidité, pas la vitesse pure : c\'est ici que se construit la tolérance excentrique.',
        cadenceTargetSpm: 180,
      }),
      block(c, 'Retour roulant', 'Z2', Math.round((durationMin - 45) * 60 * 0.2), {}),
      block(c, 'Retour au calme', 'Z1', 20 * 60, {}),
    ],
  }, vertM);
}

export function tempo(model: PhysiologyModel, blockMin = 25): SessionTemplate {
  const c = ctxOf(model);
  const z3 = zoneOf(c, 'Z3');
  return finalize(c, {
    key: 'tempo',
    type: 'tempo',
    title: `Tempo ${blockMin} min en résistance douce`,
    intent:
      'Travailler la zone transitionnelle entre les deux seuils — l\'allure réelle des trails courts et moyens. Développe la capacité à recycler le lactate plutôt qu\'à l\'éviter.',
    elevationGainM: 100,
    priority: 'support',
    phases: ['base', 'build', 'specific', 'peak'],
    blocks: [
      block(c, 'Échauffement progressif', 'Z2', 20 * 60, {}),
      block(c, `Tempo continu`, 'Z3', blockMin * 60, {
        speedLo: z3.speedMinMs * 1.02,
        speedHi: z3.speedMaxMs * 0.97,
        notes: 'Effort « confortablement dur ». Respiration ample et rythmée, mais tu ne peux plus parler qu\'en phrases courtes.',
        cadenceTargetSpm: 176,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  });
}

/** Fractionné moyen 3-12 min : le format « résistance dure » du compte rendu. */
export function threshold(model: PhysiologyModel, reps = 5, repMin = 5): SessionTemplate {
  const c = ctxOf(model);
  const z4 = zoneOf(c, 'Z4');
  // Cible resserrée juste au-dessus du seuil 2 : le stimulus utile est étroit.
  const lo = model.vt2.speedMs * 1.005;
  const hi = model.vt2.speedMs * 1.04;
  return finalize(c, {
    key: 'threshold',
    type: 'threshold',
    title: `${reps} × ${repMin} min au seuil`,
    intent:
      "Repousser le seuil anaérobie : élever la vitesse maximale soutenable, donc l'allure tenable sur 1 à 3 h. Le levier n°1 sur les formats trail courts et moyens.",
    elevationGainM: 80,
    priority: 'key',
    // Le « fractionné moyen 3-12 min » du compte rendu : rien ne le réserve à
    // la phase de développement, et l'alternance court/moyen en a besoin dès la
    // construction foncière.
    phases: ['base', 'build', 'specific', 'peak'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, {}),
      block(c, 'Gammes (montées de genou, talons-fesses, foulées bondissantes)', 'Z2', 5 * 60, {
        notes: 'Trois passages de 20 s de chaque éducatif, récupération en marchant.',
      }),
      block(c, `Répétitions au seuil`, 'Z4', repMin * 60, {
        repeat: reps,
        speedLo: lo,
        speedHi: hi,
        recovery: { durationS: Math.round(repMin * 60 * 0.35), zone: 'Z1', active: true },
        cadenceTargetSpm: 178,
        notes:
          `${msToKmh(lo).toFixed(1)}-${msToKmh(hi).toFixed(1)} km/h, ${Math.round(z4.hrMin)}-${Math.round(z4.hrMax)} bpm. ` +
          `La première répétition doit sembler trop facile : si elle est difficile, tu es parti trop vite.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  });
}

/** Fractionné court en PMA : 30"-30" ou 1'-1', un seul par semaine. */
export function vo2max(model: PhysiologyModel, format: '30-30' | '1-1' | '15-15' = '30-30', sets = 2, repsPerSet = 10): SessionTemplate {
  const c = ctxOf(model);
  const spec = {
    '30-30': { work: 30, rest: 30, pct: 1.1, label: '30"-30"' },
    '1-1': { work: 60, rest: 60, pct: 1.05, label: "1'-1'" },
    '15-15': { work: 15, rest: 15, pct: 1.2, label: '15"-15"' },
  }[format];
  const target = model.vmaMs * spec.pct;
  return finalize(c, {
    key: `vo2max_${format}`,
    type: 'vo2max',
    title: `PMA — ${sets} × ${repsPerSet} × ${spec.label}`,
    intent:
      `Solliciter VO2max au plus près du plafond. À ${Math.round(spec.pct * 100)} % de VMA, le temps passé à haute fraction de VO2max est maximal — c'est le stimulus, pas la vitesse elle-même.`,
    elevationGainM: 40,
    priority: 'key',
    phases: ['build', 'specific', 'peak'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, {}),
      block(c, 'Gammes + 3 lignes droites progressives', 'Z3', 8 * 60, {}),
      block(c, `Série ${spec.label}`, 'Z5', spec.work, {
        repeat: sets * repsPerSet,
        speedLo: target * 0.97,
        speedHi: target * 1.03,
        recovery: { durationS: spec.rest, zone: 'Z1', active: format !== '15-15' },
        cadenceTargetSpm: 182,
        notes:
          `${msToKmh(target).toFixed(1)} km/h (${Math.round(spec.pct * 100)} % VMA). ` +
          `Récupération ${format === '15-15' ? 'passive' : 'active en trottinant'}. ` +
          `Pause de 4 min entre les ${sets} séries. La FC n'a pas le temps de monter : ne la regarde pas, tiens l'allure.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  });
}

/** Côtes : le fractionné court en montée recommandé par le laboratoire. */
export function hillRepeats(model: PhysiologyModel, reps = 8, repS = 90, grade = 0.10): SessionTemplate {
  const c = ctxOf(model);
  const z4 = zoneOf(c, 'Z4');
  const power = 3.6 * model.vmaMs * 0.96;
  const speed = speedForMetabolicPower(power, grade);
  const targetVam = Math.round(vam(speed, grade));
  const gainPerRep = Math.round((speed * repS * grade) / Math.sqrt(1 + grade * grade));
  return finalize(c, {
    key: 'hill_repeats',
    type: 'hill_repeats',
    title: `Côtes — ${reps} × ${repS} s à ${Math.round(grade * 100)} %`,
    intent:
      'Puissance spécifique en montée avec une contrainte articulaire réduite : la pente permet une intensité cardiaque élevée pour des forces d\'impact bien plus faibles qu\'à plat.',
    elevationGainM: gainPerRep * reps,
    priority: 'key',
    phases: ['base', 'build', 'specific'],
    blocks: [
      block(c, 'Échauffement jusqu\'au pied de la côte', 'Z2', 20 * 60, {}),
      block(c, `Répétitions en montée`, 'Z4', repS, {
        repeat: reps,
        speedLo: speed * 0.95,
        speedHi: speed * 1.05,
        vamTargetMh: targetVam,
        recovery: { durationS: repS, zone: 'Z1', active: true },
        cadenceTargetSpm: 180,
        notes:
          `Cible ${targetVam} m D+/h, ${Math.round(z4.hrMin)}-${Math.round(z4.hrMax)} bpm en fin de répétition. ` +
          `Buste légèrement penché, foulée courte et fréquente, bras actifs. Descente en récupération, très souple.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  });
}

/**
 * Descente : la séance que presque personne ne fait, et qui rapporte le plus en
 * trail. Elle prépare spécifiquement à l'agression excentrique de la course.
 */
export function downhillSession(model: PhysiologyModel, reps = 6, repS = 150): SessionTemplate {
  const c = ctxOf(model);
  const lossPerRep = 90;
  return finalize(c, {
    key: 'downhill',
    type: 'downhill',
    title: `Descente technique — ${reps} × ${Math.round(repS / 60 * 10) / 10} min`,
    intent:
      "Conditionner les quadriceps à la contrainte excentrique et automatiser le pilotage en descente. Effet de séance répétée : trois semaines de ce travail réduisent nettement les dégâts musculaires du jour J.",
    elevationGainM: lossPerRep * reps,
    priority: 'support',
    phases: ['build', 'specific'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, {}),
      block(c, 'Descentes contrôlées', 'Z3', repS, {
        repeat: reps,
        recovery: { durationS: Math.round(repS * 1.4), zone: 'Z2', active: true },
        cadenceTargetSpm: 182,
        notes:
          'Cadence très haute, appuis courts sous le centre de gravité, jamais de freinage talon. ' +
          'Regard porté loin. Remontée en récupération. Arrête la séance dès que le contrôle se dégrade : ' +
          'au-delà, tu accumules des dégâts sans bénéfice technique.',
      }),
      block(c, 'Retour au calme', 'Z1', 10 * 60, {}),
    ],
  }, lossPerRep * reps);
}

/** Allure course : simulation spécifique sur profil proche de l'objectif. */
export function racePace(model: PhysiologyModel, blockMin = 40, targetSpeedMs?: number, vertM = 250): SessionTemplate {
  const c = ctxOf(model);
  const speed = targetSpeedMs ?? model.vt2.speedMs * 0.9;
  return finalize(c, {
    key: 'race_pace',
    type: 'race_pace',
    title: `Allure spécifique — ${blockMin} min`,
    intent:
      "Ancrer l'allure de course dans les sensations et vérifier que le couple allure/FC tient sur terrain réel. Séance de répétition générale, pas de développement.",
    elevationGainM: vertM,
    priority: 'key',
    phases: ['specific', 'peak', 'taper'],
    blocks: [
      block(c, 'Échauffement', 'Z2', 20 * 60, {}),
      block(c, 'Bloc à allure course, sur profil vallonné', 'Z3', blockMin * 60, {
        speedLo: speed * 0.97,
        speedHi: speed * 1.03,
        elevationGainM: vertM,
        notes:
          `Cible ${msToKmh(speed).toFixed(1)} km/h à plat, corrigée de la pente. ` +
          `Teste aussi ta stratégie de ravitaillement : mange et bois exactement comme le jour J.`,
      }),
      block(c, 'Retour au calme', 'Z1', 12 * 60, {}),
    ],
  }, vertM);
}

export function strength(model: PhysiologyModel, durationMin = 40): SessionTemplate {
  const c = ctxOf(model);
  return finalize(c, {
    key: 'strength',
    type: 'strength',
    title: `Renforcement spécifique ${durationMin} min`,
    intent:
      "Renforcer la chaîne postérieure et la tolérance excentrique, et corriger le déficit de souplesse relevé au test (flexion avant à −1 cm). Prévention et économie de course.",
    elevationGainM: 0,
    priority: 'support',
    phases: ['base', 'build', 'specific', 'transition', 'recovery'],
    blocks: [
      block(c, 'Activation (10 min)', 'Z1', 10 * 60, {
        notes: 'Mobilité hanches/chevilles, fentes marchées, ponts fessiers.',
      }),
      block(c, 'Circuit force (20 min)', 'Z2', 20 * 60, {
        notes:
          '3 tours : squats bulgares 8/jambe · descentes lentes de marche 10/jambe (excentrique quadriceps) · ' +
          'soulevés de terre unilatéraux 8/jambe · mollets excentriques 12/jambe · gainage ventral et latéral 45 s.',
      }),
      block(c, 'Souplesse chaîne postérieure (10 min)', 'Z1', 10 * 60, {
        kind: 'mobility',
        notes:
          'Ischio-jambiers, mollets, chaîne postérieure du rachis. Maintiens de 45 s, deux passages. ' +
          'C\'est le point faible identifié au test : à faire deux fois par semaine, sans exception.',
      }),
    ],
  });
}

export function restDay(): SessionTemplate {
  return {
    key: 'rest',
    type: 'rest',
    title: 'Repos complet',
    intent: "L'adaptation se produit au repos, pas à l'entraînement. Ce jour fait partie du plan.",
    durationS: 0,
    elevationGainM: 0,
    priority: 'support',
    phases: ['base', 'build', 'specific', 'peak', 'taper', 'race', 'recovery', 'transition'],
    blocks: [],
    plannedLoad: 0,
    plannedMechanicalLoad: 0,
  };
}

/**
 * Rend une séance lisible en texte, pour le chat et l'export.
 *
 * Le critère de réussite y figure quand il y en a un : une séance dont on ne
 * sait pas ce qui la réussit n'est qu'une durée à passer dehors.
 */
export function renderSession(
  s:
    | SessionTemplate
    | {
        title: string;
        intent: string;
        blocks: SessionBlock[];
        successCriteria?: SessionSuccessCriterion[];
      },
): string {
  const lines = [`**${s.title}**`, `_${s.intent}_`, ''];
  const criteria = 'successCriteria' in s ? s.successCriteria : undefined;
  if (criteria?.length) {
    for (const c of criteria) {
      lines.push(`Réussite : ${CRITERION_LABEL[c.metric]}${c.maxValue != null ? ` ≤ ${c.maxValue}` : ''}`);
      lines.push(`  ↳ « ${c.origin.quote} » — ${c.origin.source === 'lab_test' ? 'test d\'effort' : 'dossier'} du ${c.origin.date}`);
    }
    lines.push('');
  }
  for (const b of s.blocks) {
    const reps = b.repeat ? `${b.repeat} × ` : '';
    const dur = b.durationS ? formatBlockDuration(b.durationS) : b.distanceM ? `${b.distanceM} m` : '';
    const hr = b.hrRange ? ` · ${b.hrRange[0]}-${b.hrRange[1]} bpm` : '';
    const pace = b.paceRange ? ` · ${b.paceRange[0]}-${b.paceRange[1]}/km` : '';
    const vamText = b.vamTargetMh ? ` · ${b.vamTargetMh} m D+/h` : '';
    const rec = b.recovery ? ` — récup ${formatBlockDuration(b.recovery.durationS)} ${b.recovery.active ? 'active' : 'passive'}` : '';
    lines.push(`• ${reps}${dur} — ${b.label} (${b.zone})${hr}${pace}${vamText}${rec}`);
    if (b.notes) lines.push(`  ↳ ${b.notes}`);
  }
  return lines.join('\n');
}

const CRITERION_LABEL: Record<SessionSuccessCriterion['metric'], string> = {
  hr_drift: 'pas de dérive cardiaque (Pa:HR) sur la séance',
};

function formatBlockDuration(s: number): string {
  if (s >= 3600) return `${Math.round((s / 3600) * 10) / 10} h`;
  if (s >= 60) return `${Math.round(s / 60)} min`;
  return `${s} s`;
}
