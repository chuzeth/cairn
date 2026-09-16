import type {
  AbsenceKind, CourseProfile, PhysiologyModel, PlannedSession, RaceGoal, SessionBlock,
} from '@cairn/core';
import { directivesFor } from '@cairn/core';
import * as db from '@cairn/db';
import {
  ACWR_SPIKE, ECCENTRIC_MOVEMENTS, VERTICAL_CURVE_DURATIONS, describeZone, formatClock, formatDuration,
  formatPace, goalProbability, interpretAcwr, interpretDurability, msToKmh, predictRace, summarizeForCoach,
  targetRaceDayTsb, verticalCapacity, type LoadRatioExceedance,
} from '@cairn/physiology';
import { applyAdjustments, withdrawalsFor } from './adapt.js';
import { describeDirectives } from './directives.js';
import { mondayOf } from './periodization.js';
import { assumedCtl, buildTrainingPlan, describeRatioExceedances, summarizeWeek } from './planner.js';
import { PRESCRIPTION_MARGIN } from './plausibility.js';
import { parseSessionBlocks } from './sessionContent.js';
import {
  eccentricStrengthOf, elevationGainOf, renderSession, restateVert, sessionTotals, transformSession,
} from './sessionLibrary.js';
import {
  currentCriticalSpeed, currentModel, fitnessAtPlanStart, knownLoadsBefore, loadAthleteState,
  projectPlanRatios, rebuildPhysiologyModel,
} from './state.js';

/**
 * Outils du coach.
 *
 * Un seul jeu de définitions sert au chat de l'application **et** au serveur
 * MCP : Claude Desktop et Claude Code voient exactement les mêmes capacités que
 * le chatbot intégré, sans duplication de logique ni dérive entre les deux.
 *
 * Règle de conception : les outils ne renvoient jamais de prose interprétative,
 * uniquement des faits chiffrés et leur contexte. L'interprétation est le
 * travail du modèle, pas celui de la couche de données.
 */

export interface ToolDefinition {
  name: string;
  description: string;
  input_schema: {
    type: 'object';
    properties: Record<string, unknown>;
    required?: string[];
    additionalProperties?: boolean;
  };
}

const obj = (
  properties: Record<string, unknown>,
  required: string[] = [],
): ToolDefinition['input_schema'] => ({
  type: 'object',
  properties,
  required,
  additionalProperties: false,
});

const str = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'string', description, ...extra });
const num = (description: string, extra: Record<string, unknown> = {}) => ({ type: 'number', description, ...extra });
const bool = (description: string) => ({ type: 'boolean', description });

const ZONES = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];
const BLOCK_KINDS = ['mobility', 'respiratory'];
const MOVEMENTS = Object.keys(ECCENTRIC_MOVEMENTS);
const ABSENCE_KINDS: AbsenceKind[] = ['chosen', 'illness', 'injury', 'unavailable'];

const pair = (description: string) => ({
  type: 'array',
  items: { type: 'number' },
  minItems: 2,
  maxItems: 2,
  description,
});

/**
 * Un bloc de séance, tel que le coach peut l'écrire.
 *
 * Même structure que celle produite par le planificateur. Ce qui est omis est
 * déduit de la zone ; `paceRange` n'y figure pas parce qu'il se déduit de
 * `speedRangeMs` — un affichage qui pourrait contredire ses propres nombres
 * n'est pas une prescription.
 *
 * Le schéma expose tout ce que le bloc sait porter, `kind` et `circuit`
 * compris : un champ que le coach ne peut pas écrire est un champ qu'un
 * remplacement de blocs efface, et c'est ainsi qu'une séance a perdu le
 * marqueur par lequel se comptait une fréquence hebdomadaire prescrite au
 * dossier. `circuit`, lui, était accepté à la validation mais annoncé nulle
 * part : le coach ne pouvait l'écrire qu'en le devinant, et le commentaire
 * d'ici affirmait le contraire.
 */
const BLOCK_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['label', 'zone'],
  properties: {
    label: str('Intitulé du bloc, ex. « Contre-la-montre 20 min ».'),
    zone: str('Zone dominante du bloc.', { enum: ZONES }),
    kind: str(
      "Nature d'un bloc annexe, non couru, dont la fréquence hebdomadaire est prescrite au dossier. " +
        "À conserver sur un bloc qui le porte : c'est par lui que la fréquence se compte. " +
        "Un bloc annexe n'admet ni allure, ni FC, ni cadence, ni distance.",
      { enum: BLOCK_KINDS },
    ),
    durationS: num(
      'Durée du bloc, en secondes. Requis, sauf si distanceM est fourni, ou si dénivelé et vitesse ' +
        'ascensionnelle la déterminent déjà.',
    ),
    distanceM: num('Étendue du bloc en mètres, à la place d\'une durée.'),
    repeat: num('Nombre de répétitions du bloc (défaut 1).'),
    elevationGainM: num(
      "Dénivelé positif du bloc, en mètres — par répétition si le bloc en porte, hors récupération. " +
        "Le D+ de la séance en est la somme : il ne se saisit nulle part ailleurs, " +
        "et une séance qui monte doit le dire dans un bloc.",
    ),
    elevationLossM: num(
      "Dénivelé négatif du bloc, en mètres — par répétition, hors récupération. Il se déclare sur le segment " +
        "qui le descend : pas sur une montée à vitesse cible, qui monte pendant toute sa durée, mais sur le bloc " +
        "qui la redescend. Sans aucun D− déclaré, la séance est lue comme une boucle et sa descente située par " +
        "défaut. Chaque segment doit tenir dans sa durée d'après les courbes de l'athlète " +
        "(get_performance_curves → capacite_verticale), à l'instant où il commence — la borne perd ce que " +
        "la durabilité retire du temps de séance et du dénivelé déjà franchis — et avec " +
        `${Math.round(PRESCRIPTION_MARGIN * 100)} % de marge sous cette borne : un contenu qui ne tient pas est ` +
        "refusé, avec la borne.",
    ),
    circuit: {
      type: 'object',
      additionalProperties: false,
      required: ['rounds', 'exercises'],
      description:
        "Contenu excentrique du bloc, quand il y en a. C'est d'ici que sortent le texte affiché et la " +
        "charge mécanique : un circuit décrit en toutes lettres dans `notes` pèse zéro, et un tour y " +
        "pèse comme trois. Donne au bloc la durée que son contenu demande — côté plan, elle s'en déduit, " +
        "et un tour de cinq exercices ne tient pas en treize minutes.",
      properties: {
        rounds: num('Nombre de tours du circuit. C\'est par lui que l\'excentrique se réintroduit après une coupure.'),
        exercises: {
          type: 'array',
          minItems: 1,
          description: 'Exercices d\'un tour, dans l\'ordre.',
          items: {
            type: 'object',
            additionalProperties: false,
            required: ['movement', 'reps'],
            properties: {
              movement: str(
                'Mouvement, parmi ceux dont la charge excentrique se calcule. La liste est fermée : ' +
                  'un mouvement inventé n\'a ni course de freinage ni sévérité, donc aucune charge.',
                { enum: MOVEMENTS },
              ),
              reps: num('Répétitions par tour et par côté — pour `isometric`, secondes de maintien.'),
            },
          },
        },
      },
    },
    hrRange: pair(
      "Fourchette de FC cible [min, max]. Omise, celle de la zone s'applique. À renseigner dès que la prescription sort de la bande — un test maximal vise au-delà du plafond de Z4.",
    ),
    speedRangeMs: pair(
      "Fourchette de vitesse cible à plat [min, max], en m/s. Omise, celle de la zone s'applique. L'allure en min/km en est déduite et ne se saisit pas.",
    ),
    vamTargetMh: num(
      'Vitesse ascensionnelle cible, en m/h, pour un bloc en côte. Durée, dénivelé et vitesse ' +
        'ascensionnelle décrivent un même fait : écris-en deux, le troisième s\'en déduit. Les trois ' +
        'à la fois ne sont acceptés que s\'ils concordent.',
    ),
    cadenceTargetSpm: num('Cadence cible, en pas par minute.'),
    recovery: {
      type: 'object',
      additionalProperties: false,
      required: ['durationS', 'zone'],
      description: 'Récupération suivant chaque répétition.',
      properties: {
        durationS: num('Durée de la récupération, en secondes.'),
        zone: str('Zone de la récupération.', { enum: ZONES }),
        active: bool('Trottinée (défaut) ou à l\'arrêt.'),
        elevationGainM: num('Dénivelé positif franchi pendant la récupération — la remontée d\'une descente.'),
        elevationLossM: num('Dénivelé négatif franchi pendant la récupération — la descente d\'une côte.'),
      },
    },
    notes: str("Consigne d'exécution, affichée sous le bloc."),
  },
};

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    name: 'get_athlete_profile',
    description:
      "Profil physiologique complet : test d'effort de référence, modèle courant (vitesse critique, D', VMA, seuils, FCmax, durabilité, aisance en descente), provenance de chaque paramètre et niveau de confiance. À consulter avant toute recommandation d'entraînement.",
    input_schema: obj({}),
  },
  {
    name: 'get_fitness_state',
    description:
      "État de forme du jour : charge chronique (CTL), charge aiguë (ATL), fraîcheur (TSB) sur les filières métabolique ET mécanique, ratio charge aiguë/chronique de chacune avec son seuil de pic, monotonie, vitesse de progression, score de disponibilité et son détail. C'est l'état qui doit dicter toute décision d'ajustement.",
    input_schema: obj({}),
  },
  {
    name: 'get_training_zones',
    description:
      'Zones d\'entraînement courantes (FC et allures), avec le but physiologique de chacune et les formats de séance associés.',
    input_schema: obj({}),
  },
  {
    name: 'list_activities',
    description:
      "Liste les activités sur une période, avec leurs métriques clefs et leurs charges. Utiliser pour repérer des tendances, retrouver une séance précise ou vérifier ce qui a réellement été fait.",
    input_schema: obj({
      from: str('Date de début, format YYYY-MM-DD. Par défaut : il y a 30 jours.'),
      to: str('Date de fin, format YYYY-MM-DD. Par défaut : aujourd\'hui.'),
      sport_type: str('Filtre sur le type de sport, ex. « TrailRun », « Run ».'),
      min_duration_min: num('Ne retenir que les activités d\'au moins N minutes.'),
      min_elevation_m: num('Ne retenir que les activités d\'au moins N mètres de D+.'),
      limit: num('Nombre maximum de résultats (défaut 40).'),
    }),
  },
  {
    name: 'get_activity_analysis',
    description:
      "Analyse détaillée d'une activité : charges métabolique et mécanique, répartition par zone, dérive cardiaque, blocs d'effort détectés avec leur régularité, courbes vitesse-durée et VAM, profil par tranche de pente, signaux de durabilité, énergétique, environnement, conformité à la séance prescrite et alertes automatiques.",
    input_schema: obj({ activity_id: str("Identifiant de l'activité, ex. « strava-123456789 ».") }, ['activity_id']),
  },
  {
    name: 'get_performance_curves',
    description:
      "Courbes de performance : meilleure vitesse corrigée de la pente par durée, meilleure vitesse ascensionnelle par durée, ajustement de la vitesse critique et de D'. Sert à situer le niveau réel et à repérer les trous dans le profil.",
    input_schema: obj({}),
  },
  {
    name: 'get_plan',
    description:
      "Plan d'entraînement en cours : phases, charges hebdomadaires cibles, les absences déclarées qui recouvrent la fenêtre, et le détail des séances avec leur statut — prévue, faite, manquée, ou retirée par une absence annoncée.",
    input_schema: obj({
      from: str('Date de début, YYYY-MM-DD. Par défaut : aujourd\'hui.'),
      weeks: num('Nombre de semaines à retourner (défaut 3).'),
      detailed: bool('Si vrai, inclut le détail complet des blocs de chaque séance.'),
    }),
  },
  {
    name: 'list_races',
    description: 'Objectifs de course enregistrés, avec profil de parcours et ambition associée.',
    input_schema: obj({ include_past: bool('Inclure les courses passées.') }),
  },
  {
    name: 'upsert_race',
    description:
      "Crée ou met à jour un objectif de course. À utiliser dès que l'athlète mentionne une inscription, un changement de date, une ambition ou des informations de parcours. Les résultats des éditions précédentes permettent de convertir un objectif de classement en temps cible.",
    input_schema: obj(
      {
        id: str('Identifiant à mettre à jour. Omettre pour créer une nouvelle course.'),
        name: str('Nom de la course.'),
        date: str('Date de la course, YYYY-MM-DD.'),
        priority: str('Priorité : A (objectif principal), B (intermédiaire), C (course de préparation).', { enum: ['A', 'B', 'C'] }),
        distance_km: num('Distance en kilomètres.'),
        elevation_gain_m: num('Dénivelé positif en mètres.'),
        elevation_loss_m: num('Dénivelé négatif en mètres. Par défaut égal au D+.'),
        technicality: num('Technicité du terrain, 1 (roulant) à 5 (alpin très technique). Défaut 3.', { minimum: 1, maximum: 5 }),
        expected_temp_c: num('Température attendue en °C.'),
        max_altitude_m: num('Altitude maximale du parcours.'),
        night_hours: num('Nombre d\'heures de course de nuit.'),
        target_time_s: num('Temps cible en secondes.'),
        target_placing: num('Classement visé.'),
        field_size: num('Nombre de partants attendu.'),
        previous_editions: {
          type: 'array',
          description:
            "Résultats des éditions précédentes, indispensables pour convertir un objectif de classement en temps cible.",
          items: obj({ year: num('Année'), placing: num('Rang'), time_s: num('Temps en secondes') }, ['year', 'placing', 'time_s']),
        },
        notes: str('Notes libres sur la course.'),
      },
      ['name', 'date', 'distance_km', 'elevation_gain_m'],
    ),
  },
  {
    name: 'predict_race',
    description:
      "Prédit le temps sur une course : temps médian, intervalle de confiance, distance équivalente à plat, facteurs appliqués (terrain, chaleur, altitude, durabilité, fraîcheur), plan d'allure segment par segment avec cibles de FC et de vitesse ascensionnelle, stratégie de ravitaillement, et classement des facteurs limitants avec le temps que chacun coûte.",
    input_schema: obj({
      race_id: str("Identifiant d'une course enregistrée. Sinon, décrire le parcours ci-dessous."),
      distance_km: num('Distance en kilomètres.'),
      elevation_gain_m: num('Dénivelé positif en mètres.'),
      elevation_loss_m: num('Dénivelé négatif en mètres.'),
      technicality: num('Technicité 1-5. Défaut 3.'),
      expected_temp_c: num('Température attendue en °C.'),
      race_day_tsb: num("TSB attendu le jour de la course. Par défaut, la valeur cible d'affûtage."),
      target_time_s: num("Temps cible : renvoie alors la probabilité de l'atteindre."),
    }),
  },
  {
    name: 'rebuild_plan',
    description:
      "Reconstruit intégralement le plan d'entraînement jusqu'à une course cible, à partir de l'état de forme actuel. À utiliser lors d'un changement d'objectif, de date, d'ambition, ou après une interruption importante. Renvoie un résumé semaine par semaine, et les jours où le plan porte un ratio charge aiguë/chronique — métabolique ou mécanique — au-delà de son seuil.",
    input_schema: obj(
      {
        race_id: str("Identifiant de la course cible."),
        start_date: str('Date de départ du plan, YYYY-MM-DD. Par défaut : le lundi de cette semaine.'),
        reason: str('Motif de la reconstruction, consigné dans le journal de révision du plan.'),
      },
      ['race_id', 'reason'],
    ),
  },
  {
    name: 'modify_session',
    description:
      "Modifie une séance planifiée : déplacement, changement de statut, ajustement de charge, ou remplacement du contenu prescrit. C'est le contenu que l'athlète exécute — un titre changé sans ses blocs ne change rien à la séance qu'il fera. Toute modification est journalisée avec sa justification. La réponse porte les jours où le plan, modification comprise, dépasse le seuil de ratio charge aiguë/chronique d'une filière, et ceux d'avant la modification : un dépassement se lit au moment où la séance s'écrit.",
    input_schema: obj(
      {
        session_id: str('Identifiant de la séance.'),
        new_date: str('Nouvelle date, YYYY-MM-DD.'),
        status: str(
          "Nouveau statut. « completed » : la séance prescrite a eu lieu ; « replaced » : autre chose a été fait ce jour-là.",
          { enum: ['planned', 'completed', 'partial', 'missed', 'moved', 'cancelled', 'replaced'] },
        ),
        scale_load: num(
          "Facteur multiplicatif de la charge, de la durée et du dénivelé de ce qui se court, ex. 0.7 pour réduire de 30 %. " +
            "Ce que le dossier prescrit — tours d'un circuit, souplesse, respiration — garde son temps. Si un segment ne tient " +
            "plus dans les courbes de l'athlète, c'est le dénivelé qui cède, et la réponse le dit. Exclusif de blocks.",
        ),
        title: str('Nouveau titre.'),
        intent: str("Nouvelle intention physiologique — le « pourquoi » de la séance, affiché sous le titre."),
        blocks: {
          type: 'array',
          minItems: 1,
          description:
            "Remplace intégralement le contenu prescrit. Durée, charge métabolique, distance, dénivelé et charge mécanique de la séance sont recalculés depuis ces blocs, par la formule du planificateur — la charge mécanique sur le dénivelé négatif que les blocs déclarent, ou, faute d'aucun, sur une boucle qui descend ce qu'elle monte. Un contenu dont un segment dépasse les courbes de l'athlète est refusé. Exclusif de scale_load, qui multiplie le contenu existant au lieu de le remplacer.",
          items: BLOCK_SCHEMA,
        },
        rationale: str('Justification de la modification. Obligatoire.'),
      },
      ['session_id', 'rationale'],
    ),
  },
  {
    name: 'get_check_ins',
    description:
      'Relevés quotidiens déclarés : fatigue perçue, sommeil, courbatures, stress, motivation, FC de repos, HRV, masse corporelle. Ces données subjectives pèsent lourd dans le score de disponibilité.',
    input_schema: obj({ from: str('Date de début, YYYY-MM-DD. Par défaut : il y a 30 jours.') }),
  },
  {
    name: 'declare_absence',
    description:
      "Enregistre une absence que Pierre a annoncée : une période datée pendant laquelle il ne s'entraînera pas — coupure choisie, maladie, blessure, déplacement. Les séances que la période recouvre sont retirées du plan : ni à faire, ni manquées, et la règle « séance manquée » ne se déclenche pas dessus. " +
      "Procédure : tu interprètes la phrase, tu lui soumets les dates que tu en as comprises avec `preview` pour lui montrer les séances concernées, tu attends sa confirmation, puis tu enregistres. N'enregistre jamais une absence qu'il n'a pas confirmée. " +
      "`reason` reprend ses mots, pas ta reformulation. " +
      "Le plan n'est pas reconstruit : la charge qui suit la coupure est une décision d'entraînement, à prendre avec lui ensuite (`rebuild_plan`). La chute de CTL, elle, est réelle et reste mesurée — ne la raconte pas comme un abandon.",
    input_schema: obj(
      {
        start_date: str('Premier jour sans entraînement, YYYY-MM-DD, inclus.'),
        end_date: str('Dernier jour sans entraînement, YYYY-MM-DD, inclus. « Je coupe jusqu\'au 13 » se déclare avec le 13.'),
        kind: str(
          "Nature de l'absence : « chosen » coupure voulue (repos choisi, assimilation), « illness » maladie, « injury » blessure, « unavailable » empêchement extérieur (travail, voyage).",
          { enum: ['chosen', 'illness', 'injury', 'unavailable'] },
        ),
        reason: str("La raison telle que Pierre l'a formulée, mot pour mot."),
        from_check_in_date: str(
          "Date du point du jour d'où vient la phrase, YYYY-MM-DD. La note cesse alors d'être en attente dans l'application.",
        ),
        preview: bool(
          "Si vrai, ne rien enregistrer : renvoyer seulement les séances que la période recouvre, pour les lui soumettre avant confirmation.",
        ),
      },
      ['start_date', 'end_date', 'kind', 'reason'],
    ),
  },
  {
    name: 'update_availability',
    description:
      "Met à jour les contraintes de disponibilité : jours d'entraînement, jours de sortie longue, volume horaire hebdomadaire maximal, nombre de séances de qualité, dénivelé accessible. Ces contraintes décrivent une semaine type et ne portent aucune date : une interruption datée se déclare avec `declare_absence`. Le plan doit être reconstruit ensuite pour en tenir compte.",
    input_schema: obj({
      available_days: { type: 'array', items: { type: 'number' }, description: "Jours disponibles (0 = dimanche … 6 = samedi)." },
      long_run_days: { type: 'array', items: { type: 'number' }, description: 'Jours possibles pour la sortie longue.' },
      max_weekly_hours: num("Volume horaire hebdomadaire maximal."),
      max_quality_sessions: num('Nombre maximum de séances de qualité par semaine.'),
      accessible_vert_per_session: num('Dénivelé positif accessible par séance, en mètres.'),
      notes: str('Note à ajouter au contexte de l\'athlète.'),
    }),
  },
  {
    name: 'compare_periods',
    description:
      "Compare deux périodes d'entraînement : volume, charge, dénivelé, répartition d'intensité, dérive cardiaque moyenne. Sert à répondre objectivement à « est-ce que je progresse ? ».",
    input_schema: obj(
      {
        period_a_start: str('Début de la première période, YYYY-MM-DD.'),
        period_a_end: str('Fin de la première période, YYYY-MM-DD.'),
        period_b_start: str('Début de la seconde période, YYYY-MM-DD.'),
        period_b_end: str('Fin de la seconde période, YYYY-MM-DD.'),
      },
      ['period_a_start', 'period_a_end', 'period_b_start', 'period_b_end'],
    ),
  },
];

// ─────────────────────────────────────────────────────────────────────────────
// Exécution
// ─────────────────────────────────────────────────────────────────────────────

const dayMs = 86_400_000;
const iso = (d: Date) => d.toISOString().slice(0, 10);
const daysAgo = (n: number) => iso(new Date(Date.now() - n * dayMs));
const isDay = (v: string) => /^\d{4}-\d{2}-\d{2}$/.test(v);
const midnight = (date: string) => new Date(`${date}T00:00:00Z`).getTime();
const arg = <T>(input: Record<string, unknown>, key: string): T | undefined => input[key] as T | undefined;
/** Un TSB se lit signé : « 8,8 » et « −8,8 » ne décrivent pas le même athlète. */
const signedTsb = (v: number) => `${v >= 0 ? '+' : '−'}${Math.abs(v).toFixed(1)}`;

export interface ToolResult {
  content: unknown;
  /** Résumé d'une ligne, affiché dans l'interface pour la transparence. */
  summary: string;
}

export async function executeTool(
  athleteId: string,
  name: string,
  rawInput: unknown,
): Promise<ToolResult> {
  const input = (rawInput ?? {}) as Record<string, unknown>;

  switch (name) {
    case 'get_athlete_profile': {
      const state = await loadAthleteState(athleteId);
      const { model, profile } = state;
      const lab = profile.labTests[0];
      return {
        summary: `Profil physiologique (confiance ${Math.round(model.confidence * 100)} %)`,
        content: {
          athlete: { nom: profile.name, date_de_naissance: profile.birthDate, sexe: profile.sex },
          modele_courant: {
            date: model.asOf,
            masse_kg: model.bodyMassKg,
            vitesse_critique_kmh: round2(msToKmh(model.criticalSpeedMs)),
            d_prime_m: model.dPrimeM,
            vma_kmh: round2(msToKmh(model.vmaMs)),
            vo2max_ml_kg_min: model.vo2maxRel,
            sv1: { fc: model.vt1.hr, vitesse_kmh: round2(msToKmh(model.vt1.speedMs)) },
            sv2: { fc: model.vt2.hr, vitesse_kmh: round2(msToKmh(model.vt2.speedMs)) },
            fc_max: model.hrMax,
            fc_repos: model.hrRest,
            durabilite: {
              perte_pct_par_heure: model.durabilityPctPerHour,
              perte_pct_par_1000m_denivele: model.durabilityPctPer1000mVert,
              // Ce que la perte horaire contient déjà de dénivelé : seul le D+
              // au-delà de ce rythme ajoute la perte par 1 000 m.
              denivele_par_heure_des_seances_mesurees_m: model.durabilityVertRateMh ?? 0,
              lecture: interpretDurability(model.durabilityPctPerHour),
            },
            aisance_descente: model.descentSkill ?? 1,
            confiance: model.confidence,
            provenance: model.provenance,
          },
          test_laboratoire: lab
            ? {
                date: lab.date,
                laboratoire: lab.lab,
                protocole: lab.protocol,
                vma_kmh: round2(msToKmh(lab.vmaMs)),
                vo2max: lab.vo2maxRel,
                sv1: { fc: lab.vt1.hr, vitesse_kmh: round2(msToKmh(lab.vt1.speedMs)) },
                sv2: { fc: lab.vt2.hr, vitesse_kmh: round2(msToKmh(lab.vt2.speedMs)) },
                fc_max: lab.hrMax,
                cadence_moyenne: lab.cadenceMeanSpm,
                masse_kg: lab.bodyMassKg,
                masse_grasse_pct: lab.bodyFatPct,
                souplesse_flexion_cm: lab.sitAndReachCm,
                ventilation: {
                  capacite_vitale_l: lab.vitalCapacityL,
                  ve_max_l_min: lab.veMaxLMin,
                  frequence_resp_max: lab.respRateMax,
                  coefficient_utilisation_pulmonaire_pct: lab.pulmonaryUseCoefPct,
                },
                remarques: lab.practitionerNotes,
                interpretation: lab.interpretation,
              }
            : null,
          contraintes: profile.constraints,
          // L'ambition n'est pas une course : elle n'a pas de date, elle oriente
          // ce que le plan privilégie.
          ambition: profile.ambition
            ? {
                format: profile.ambition.format,
                depuis: profile.ambition.since,
                fondements: profile.ambition.origin.map((o) => ({
                  source: o.source,
                  date: o.date,
                  extrait: o.quote,
                })),
              }
            : null,
          // Ce que le planificateur lit du dossier, et d'où chaque consigne vient.
          directives: directivesFor(profile).map((d) => ({
            id: d.id,
            nature: d.kind,
            extrait: d.origin.quote,
            source: d.origin.source,
            date_document: d.origin.date,
            part_du_planificateur: d.derived ?? null,
          })),
        },
      };
    }

    case 'get_fitness_state': {
      const state = await loadAthleteState(athleteId);
      return {
        summary: `CTL ${Math.round(state.today.ctl)} · TSB ${state.today.tsb > 0 ? '+' : ''}${Math.round(state.today.tsb)} · disponibilité ${state.readiness.score}/100`,
        content: {
          date: state.today.date,
          metabolique: {
            ctl: state.today.ctl,
            atl: state.today.atl,
            tsb: state.today.tsb,
            lecture: state.today.tsbLabel,
          },
          mecanique: {
            tsb: state.today.mechanicalTsb,
            note: 'Fatigue musculaire liée à la descente. Un TSB mécanique très négatif interdit une séance de qualité même si le TSB métabolique est bon.',
          },
          acwr: {
            valeur: state.today.acwr,
            seuil: ACWR_SPIKE.metabolic,
            lecture: state.today.acwrLabel,
            risque: state.today.acwrRisk,
          },
          acwr_mecanique: {
            valeur: state.today.mechanicalAcwr,
            seuil: ACWR_SPIKE.mechanical,
            lecture: interpretAcwr(state.today.mechanicalAcwr, ACWR_SPIKE.mechanical).label,
            risque: interpretAcwr(state.today.mechanicalAcwr, ACWR_SPIKE.mechanical).risk,
            note:
              'Ratio de la filière mécanique : descente courue, et circuits de renforcement des séances faites. ' +
              'Il a son propre seuil, et la règle « mechanical_acwr_spike » le lit.',
          },
          progression_ctl_par_semaine: state.today.rampRate,
          monotonie: state.today.monotony,
          disponibilite: state.readiness,
          semaines_recentes: state.weeklyTotals.slice(-8).map((w) => ({
            semaine: w.weekStart,
            charge: w.load,
            charge_mecanique: w.mechanical,
            duree: formatDuration(w.durationS),
            denivele_m: w.vertM,
          })),
          courses_a_venir: state.upcomingRaces.map((r) => ({
            id: r.id,
            nom: r.name,
            date: r.date,
            priorite: r.priority,
            jours_restants: Math.round((new Date(r.date).getTime() - Date.now()) / dayMs),
          })),
        },
      };
    }

    case 'get_training_zones': {
      const state = await loadAthleteState(athleteId);
      return {
        summary: `${state.zones.length} zones, calibrées sur SV1 ${state.model.vt1.hr} bpm / SV2 ${state.model.vt2.hr} bpm`,
        content: {
          zones: state.zones.map((z) => ({
            zone: z.key,
            nom: z.label,
            objectif: z.purpose,
            fc: [Math.round(z.hrMin), Math.round(z.hrMax)],
            vitesse_kmh: [round2(msToKmh(z.speedMinMs)), round2(msToKmh(z.speedMaxMs))],
            allure_min_km: [formatPace(z.speedMaxMs), formatPace(z.speedMinMs)],
            resume: describeZone(z),
          })),
        },
      };
    }

    case 'list_activities': {
      const from = arg<string>(input, 'from') ?? daysAgo(30);
      const to = arg<string>(input, 'to') ?? iso(new Date());
      const limit = arg<number>(input, 'limit') ?? 40;
      let activities = await db.listActivities(athleteId, { from, to, limit: 300 });

      const sport = arg<string>(input, 'sport_type');
      if (sport) activities = activities.filter((a) => a.sportType === sport);
      const minDur = arg<number>(input, 'min_duration_min');
      if (minDur) activities = activities.filter((a) => a.movingTimeS >= minDur * 60);
      const minElev = arg<number>(input, 'min_elevation_m');
      if (minElev) activities = activities.filter((a) => a.totalElevationGainM >= minElev);

      activities = activities.slice(0, limit);
      const analyses = await db.getAnalyses(activities.map((a) => a.id));

      return {
        summary: `${activities.length} activité(s) entre ${from} et ${to}`,
        content: activities.map((a) => {
          const an = analyses.get(a.id);
          return {
            id: a.id,
            date: a.startDateLocal.slice(0, 16).replace('T', ' '),
            nom: a.name,
            type: a.sportType,
            distance_km: round2(a.distanceM / 1000),
            duree: formatDuration(a.movingTimeS),
            denivele_pos_m: Math.round(a.totalElevationGainM),
            denivele_neg_m: Math.round(a.totalElevationLossM),
            allure_moy: formatPace(a.averageSpeedMs),
            fc_moy: a.averageHr ? Math.round(a.averageHr) : null,
            fc_max: a.maxHr ? Math.round(a.maxHr) : null,
            cadence: a.averageCadenceSpm ? Math.round(a.averageCadenceSpm) : null,
            temperature_c: a.averageTempC ?? null,
            charge_metabolique: an?.load.metabolic ?? null,
            charge_mecanique: an?.load.mechanical ?? null,
            derive_cardiaque_pct: an?.decoupling.pctDrift ?? null,
            zones_3_pct: an
              ? {
                  bas: Math.round(an.zones.threeZone.low * 100),
                  modere: Math.round(an.zones.threeZone.moderate * 100),
                  haut: Math.round(an.zones.threeZone.high * 100),
                }
              : null,
            blocs_detectes: an?.intervals.length ?? 0,
          };
        }),
      };
    }

    case 'get_activity_analysis': {
      const activityId = arg<string>(input, 'activity_id');
      if (!activityId) throw new Error('activity_id requis.');
      const activity = await db.getActivity(activityId);
      if (!activity) throw new Error(`Activité introuvable : ${activityId}`);
      const analysis = await db.getAnalysis(activityId);
      if (!analysis) throw new Error(`Analyse indisponible pour ${activityId} — flux non téléchargés.`);
      const state = await loadAthleteState(athleteId);
      return {
        summary: `Analyse « ${activity.name} » — charge ${analysis.load.metabolic} / mécanique ${analysis.load.mechanical}`,
        content: summarizeForCoach(activity, analysis, state.model),
      };
    }

    case 'get_performance_curves': {
      const state = await loadAthleteState(athleteId);
      const cs = currentCriticalSpeed(state);
      return {
        summary: `Courbes de performance — CS ${round2(msToKmh(cs.modelled))} km/h`,
        content: {
          vitesse_graduee_par_duree_kmh: Object.fromEntries(
            Object.entries(state.speedCurve)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([k, v]) => [formatDuration(Number(k)), round2(msToKmh(v))]),
          ),
          vam_par_duree_m_par_h: Object.fromEntries(
            Object.entries(state.vamCurve)
              .sort(([a], [b]) => Number(a) - Number(b))
              .map(([k, v]) => [formatDuration(Number(k)), Math.round(v)]),
          ),
          capacite_verticale: verticalCapacityTable(state.model),
          vitesse_critique: {
            retenue_kmh: round2(msToKmh(cs.modelled)),
            ajustement_terrain_kmh: cs.fieldFit > 0 ? round2(msToKmh(cs.fieldFit)) : null,
            d_prime_m: cs.dPrime,
            qualite_ajustement: cs.quality,
            r2: cs.r2,
            // Le r² dit si la courbe est régulière ; celui-ci dit si elle a été
            // produite en effort maximal. Sans lui, une sortie en aisance
            // s'ajuste parfaitement et fait passer une allure de footing pour
            // une limite physiologique.
            preuve_effort_maximal: Math.round(cs.maximalEffortSupport * 100) / 100,
            duree_testee_s: cs.maximalEffortTestedS,
            duree_non_testable_s: cs.maximalEffortUntestableS,
          },
          note:
            "La courbe est l'enveloppe des 90 derniers jours, pondérée par la fraîcheur. Un trou sur une durée signifie qu'aucun effort maximal n'y a été produit récemment — pas nécessairement une faiblesse. `preuve_effort_maximal` est la part de l'ajustement portée par des efforts dont la FC a atteint le seuil 2 : c'est elle, et non le r², qui pondère le terrain face au laboratoire.",
        },
      };
    }

    case 'get_plan': {
      const from = arg<string>(input, 'from') ?? iso(new Date());
      const weeks = arg<number>(input, 'weeks') ?? 3;
      const detailed = arg<boolean>(input, 'detailed') ?? false;
      const to = iso(new Date(new Date(`${from}T00:00:00Z`).getTime() + weeks * 7 * dayMs));
      const plan = await db.getActivePlan(athleteId);
      const sessions = await db.listPlannedSessions(athleteId, from, to);
      const absences = await db.listAbsences(athleteId, { from, to });
      const profile = await db.getAthlete(athleteId);
      const dossier = profile ? directivesFor(profile) : [];

      return {
        summary: plan
          ? `Plan actif — ${sessions.length} séance(s) du ${from} au ${to}`
          : "Aucun plan actif : en créer un via rebuild_plan.",
        content: {
          // Une séance au statut `withdrawn` n'a pas été manquée : elle tombait
          // dans une absence annoncée. Sans ces lignes, le statut se lirait
          // comme un abandon.
          absences_declarees: absences.map((a) => ({
            id: a.id,
            du: a.startDate,
            au: a.endDate,
            nature: a.kind,
            motif: a.reason,
            source: a.source,
            declaree_le: a.declaredAt.slice(0, 10),
          })),
          plan_actif: plan
            ? {
                id: plan.plan.id,
                course_cible: plan.plan.goalRaceId,
                tsb_cible_veille: plan.plan.targetRaceDayTsb,
                // Mesuré sur le plan tel qu'il est sorti du planificateur ; les
                // séances retouchées depuis ne sont pas dans ce chiffre.
                tsb_projete_veille_a_la_construction: plan.plan.projectedRaceDayTsb ?? null,
                cible_manquee_parce_que: plan.plan.raceDayTsbShortfall ?? null,
                revisions: plan.plan.revisionLog.slice(-4),
                apercu_semaines: plan.weeks
                  .filter((w) => w.weekStart >= from.slice(0, 10) || w.sessions.some((s) => s.date >= from))
                  .slice(0, weeks + 2)
                  .map(summarizeWeek),
              }
            : null,
          seances: sessions.map((s) => ({
            id: s.id,
            date: s.date,
            type: s.type,
            titre: s.title,
            intention: s.intent,
            charge_prevue: s.plannedLoad,
            charge_mecanique_prevue: s.plannedMechanicalLoad,
            // Ce que la charge mécanique prescrite doit à un travail hors course.
            // Le réalisé affichera 0 dessus quoi qu'il arrive : les flux Strava
            // ne portent pas un circuit en salle. Le taire ferait lire un
            // manquement là où il n'y a qu'une cécité de la mesure.
            ...mechanicalBlindSpot(s),
            duree_prevue: formatDuration(s.plannedDurationS),
            denivele_prevu_m: s.plannedElevationGainM ?? 0,
            priorite: s.priority,
            statut: s.status,
            activite_rattachee: s.completedActivityId ?? null,
            justification_placement: s.rationale,
            criteres_de_reussite: s.successCriteria?.map((c) => ({
              grandeur: c.metric,
              borne: c.maxValue ?? null,
              extrait: c.origin.quote,
              date_document: c.origin.date,
            })) ?? null,
            // L'effet se lit sur le contenu actuel, jamais sur ce qu'une trace
            // en disait quand la séance a été construite.
            directives_appliquees: s.directives
              ? describeDirectives(s, dossier).map((d) => ({
                  directive: d.directiveId,
                  effet: d.effect,
                  extrait: d.origin.quote,
                  date_document: d.origin.date,
                }))
              : null,
            ...(detailed ? { detail: renderSession(s) } : {}),
          })),
        },
      };
    }

    case 'list_races': {
      const includePast = arg<boolean>(input, 'include_past') ?? false;
      const races = await db.listRaceGoals(athleteId, includePast ? undefined : iso(new Date()));
      return {
        summary: `${races.length} course(s) enregistrée(s)`,
        content: races.map((r) => ({
          id: r.id,
          nom: r.name,
          date: r.date,
          priorite: r.priority,
          jours_restants: Math.round((new Date(r.date).getTime() - Date.now()) / dayMs),
          parcours: {
            distance_km: round2(r.course.distanceM / 1000),
            denivele_pos_m: r.course.elevationGainM,
            denivele_neg_m: r.course.elevationLossM,
            technicite: r.course.technicality,
            altitude_max_m: r.course.maxAltitudeM ?? null,
            temperature_attendue_c: r.course.expectedTempC ?? null,
            heures_de_nuit: r.course.nightHours ?? null,
          },
          objectif: r.target ?? null,
          notes: r.notes ?? null,
        })),
      };
    }

    case 'upsert_race': {
      const distanceM = (arg<number>(input, 'distance_km') ?? 0) * 1000;
      const gain = arg<number>(input, 'elevation_gain_m') ?? 0;
      const course: CourseProfile = {
        distanceM,
        elevationGainM: gain,
        elevationLossM: arg<number>(input, 'elevation_loss_m') ?? gain,
        technicality: (arg<number>(input, 'technicality') ?? 3) as 1 | 2 | 3 | 4 | 5,
        maxAltitudeM: arg<number>(input, 'max_altitude_m'),
        expectedTempC: arg<number>(input, 'expected_temp_c'),
        nightHours: arg<number>(input, 'night_hours'),
      };
      const editions = arg<{ year: number; placing: number; time_s: number }[]>(input, 'previous_editions');
      const goal: RaceGoal = {
        id: arg<string>(input, 'id') ?? '',
        athleteId,
        name: arg<string>(input, 'name') ?? 'Course',
        date: arg<string>(input, 'date') ?? iso(new Date()),
        priority: (arg<string>(input, 'priority') ?? 'A') as 'A' | 'B' | 'C',
        course,
        target: {
          timeS: arg<number>(input, 'target_time_s'),
          placing: arg<number>(input, 'target_placing'),
          fieldSize: arg<number>(input, 'field_size'),
          previousEditions: editions?.map((e) => ({ year: e.year, placing: e.placing, timeS: e.time_s })),
        },
        notes: arg<string>(input, 'notes'),
      };
      const id = await db.upsertRaceGoal(goal);
      return {
        summary: `Course « ${goal.name} » enregistrée pour le ${goal.date}`,
        // L'identifiant final prime : une création en génère un nouveau.
        content: { ...goal, id },
      };
    }

    case 'predict_race': {
      const state = await loadAthleteState(athleteId);
      const raceId = arg<string>(input, 'race_id');
      let course: CourseProfile;
      let raceName = 'Parcours ad hoc';
      let goal: RaceGoal | null = null;

      if (raceId) {
        goal = await db.getRaceGoal(raceId);
        if (!goal) throw new Error(`Course introuvable : ${raceId}`);
        course = goal.course;
        raceName = goal.name;
      } else {
        const gain = arg<number>(input, 'elevation_gain_m') ?? 0;
        course = {
          distanceM: (arg<number>(input, 'distance_km') ?? 0) * 1000,
          elevationGainM: gain,
          elevationLossM: arg<number>(input, 'elevation_loss_m') ?? gain,
          technicality: (arg<number>(input, 'technicality') ?? 3) as 1 | 2 | 3 | 4 | 5,
          expectedTempC: arg<number>(input, 'expected_temp_c'),
        };
      }
      if (course.distanceM <= 0) throw new Error('Distance de parcours requise.');

      const roughDuration = (course.distanceM / state.model.criticalSpeedMs) * 1.25;
      const tsb = arg<number>(input, 'race_day_tsb') ?? targetRaceDayTsb(roughDuration).metabolic;

      const prediction = predictRace({ model: state.model, course, raceDayTsb: tsb });

      const targetTimeS =
        arg<number>(input, 'target_time_s') ?? goal?.target?.timeS ?? undefined;
      const probability = targetTimeS ? goalProbability(prediction, targetTimeS) : null;

      return {
        summary: `${raceName} — prédiction ${formatClock(prediction.predictedTimeS)}`,
        content: {
          course: raceName,
          parcours: {
            distance_km: round2(course.distanceM / 1000),
            denivele_pos_m: course.elevationGainM,
            denivele_neg_m: course.elevationLossM,
            technicite: course.technicality,
          },
          temps_predit: formatClock(prediction.predictedTimeS),
          temps_predit_s: prediction.predictedTimeS,
          intervalle_80pct: [formatClock(prediction.rangeS[0]), formatClock(prediction.rangeS[1])],
          distance_equivalente_plat_km: round2(prediction.flatEquivalentDistanceM / 1000),
          fraction_vitesse_critique: prediction.sustainableFractionOfCs,
          facteurs: prediction.factors,
          probabilite_objectif_pct: probability,
          objectif_temps: targetTimeS ? formatClock(targetTimeS) : null,
          plan_allure: prediction.pacing.map((p) => ({
            troncon: p.label,
            denivele_pos_m: p.elevationGainM,
            denivele_neg_m: p.elevationLossM,
            pente_pct: round2(p.avgGrade * 100),
            allure_cible: formatPace(p.targetSpeedMs),
            vam_cible_mh: p.targetVamMh ?? null,
            fc_cible: p.targetHrRange,
            duree: formatClock(p.estimatedDurationS),
            temps_cumule: formatClock(p.cumulativeTimeS),
            consigne: p.cue,
          })),
          ravitaillement: prediction.fueling,
          facteurs_limitants: prediction.limiters.map((l) => ({
            facteur: l.factor,
            gain_potentiel: formatClock(l.impactS),
            gain_potentiel_s: l.impactS,
            explication: l.explanation,
          })),
        },
      };
    }

    case 'rebuild_plan': {
      const raceId = arg<string>(input, 'race_id');
      const reason = arg<string>(input, 'reason') ?? 'Reconstruction demandée.';
      if (!raceId) throw new Error('race_id requis.');
      const race = await db.getRaceGoal(raceId);
      if (!race) throw new Error(`Course introuvable : ${raceId}`);

      const state = await loadAthleteState(athleteId);
      const prediction = predictRace({
        model: state.model,
        course: race.course,
        raceDayTsb: targetRaceDayTsb((race.course.distanceM / state.model.criticalSpeedMs) * 1.25).metabolic,
        skipLimiters: true,
      });
      const racePaceMs =
        prediction.predictedTimeS > 0 ? race.course.distanceM / prediction.predictedTimeS : undefined;

      // La charge de départ est celle du **premier jour du plan**, pas celle
      // d'aujourd'hui : entre les deux, la forme continue de vivre.
      const startDate = arg<string>(input, 'start_date');
      const planStart = mondayOf(startDate ?? iso(new Date()));
      const start = await fitnessAtPlanStart(state, planStart);

      const { plan, weeks, tsbCheck, ratioCheck } = buildTrainingPlan({
        athleteId,
        model: state.model,
        constraints: state.profile.constraints,
        race,
        currentCtl: start.ctl,
        currentAtl: start.atl,
        estimatedRaceDurationS: prediction.predictedTimeS,
        racePaceMs,
        startDate,
        // Le dossier au complet, pas seulement ses quatre nombres.
        directives: directivesFor(state.profile),
        ambition: state.profile.ambition,
        // La charge chronique des deux filières, pour que les ratios du plan
        // se lisent avant qu'il ne soit couru.
        loadHistory: await knownLoadsBefore(state, planStart),
      });

      // L'historique des décisions survit à la reconstruction : on reporte le
      // journal du plan précédent dans le nouveau.
      const previous = await db.getActivePlan(athleteId);
      plan.revisionLog = [
        ...(previous?.plan.revisionLog ?? []),
        ...plan.revisionLog,
        { at: new Date().toISOString(), trigger: 'chat_request' as const, summary: reason, changes: [] },
      ].slice(-40);

      await db.savePlan(plan, weeks);

      const assumed = assumedCtl(state.profile.constraints);
      const ctlIsAssumed = start.ctl < assumed * 0.45;

      return {
        summary:
          `Plan reconstruit : ${weeks.length} semaines jusqu'à « ${race.name} » — ` +
          `TSB projeté à la veille ${signedTsb(tsbCheck.projected)} pour une cible de ` +
          `${signedTsb(tsbCheck.target)}${tsbCheck.onTarget ? '' : ` (écart ${signedTsb(tsbCheck.gap)})`}` +
          (ratioCheck.exceedances.length
            ? ` — ⚠ ratio de charge au-delà de son seuil : ${describeRatioExceedances(ratioCheck.exceedances)}`
            : ''),
        content: {
          plan_id: plan.id,
          course: race.name,
          date_course: race.date,
          semaines: weeks.length,
          // La cible et sa vérification vont ensemble : une cible seule ne dit
          // pas si le plan l'atteint.
          tsb_cible_veille: tsbCheck.target,
          tsb_projete_veille: tsbCheck.projected,
          date_veille: tsbCheck.date,
          ecart_a_la_cible: tsbCheck.gap,
          cible_atteinte: tsbCheck.onTarget,
          profondeur_affutage: tsbCheck.taperScale,
          cible_manquee_parce_que: tsbCheck.shortfall,
          ratios_de_charge: {
            ...ratioContent(ratioCheck.exceedances),
            du: ratioCheck.from,
            au: ratioCheck.to,
            jours_de_charge_connus_avant_le_plan: ratioCheck.historyDays,
          },
          temps_predit: formatClock(prediction.predictedTimeS),
          charge_de_depart: Math.round(start.ctl),
          charge_de_depart_estimee: ctlIsAssumed,
          // Ce que la forme est devenue entre aujourd'hui et le départ du plan.
          charge_de_depart_reportee_depuis: {
            date_aujourdhui: state.today.date,
            ctl_aujourdhui: state.today.ctl,
            atl_aujourdhui: state.today.atl,
            premier_jour_du_plan: planStart,
            jours_intercalaires: start.gapDays,
            charge_prevue_dans_lintervalle: start.gapLoad,
            ctl_au_depart: Math.round(start.ctl * 10) / 10,
            atl_au_depart: Math.round(start.atl * 10) / 10,
          },
          directives_honorees: directivesFor(state.profile).map((d) => ({
            id: d.id,
            nature: d.kind,
            extrait: d.origin.quote,
            source: d.origin.source,
            date_document: d.origin.date,
            part_du_planificateur: d.derived ?? null,
          })),
          ambition: state.profile.ambition ?? null,
          apercu: weeks.map(summarizeWeek),
        },
      };
    }

    case 'modify_session': {
      const sessionId = arg<string>(input, 'session_id');
      const rationale = arg<string>(input, 'rationale');
      if (!sessionId) throw new Error('session_id requis.');
      if (!rationale) throw new Error('rationale requis : toute modification doit être justifiée.');

      const patch: Record<string, unknown> = { rationale };
      const newDate = arg<string>(input, 'new_date');
      if (newDate) patch.date = newDate;
      const status = arg<string>(input, 'status');
      if (status) patch.status = status;
      const title = arg<string>(input, 'title');
      if (title) patch.title = title;
      const intent = arg<string>(input, 'intent');
      if (intent) patch.intent = intent;

      const scale = arg<number>(input, 'scale_load');
      const rawBlocks = input.blocks;
      if (rawBlocks !== undefined && scale !== undefined) {
        throw new Error(
          'blocks et scale_load sont exclusifs : scale_load multiplie le contenu existant, blocks le remplace.',
        );
      }

      let target: PlannedSession | undefined;
      if (rawBlocks !== undefined || (scale && scale > 0)) {
        const from = daysAgo(60);
        const to = iso(new Date(Date.now() + 400 * dayMs));
        const all = await db.listPlannedSessions(athleteId, from, to);
        target = all.find((s) => s.id === sessionId);
        if (!target) throw new Error(`Séance ${sessionId} introuvable.`);
      }

      let blocks: SessionBlock[] | undefined;
      let amendments: string[] = [];
      if (rawBlocks !== undefined) {
        const model = await currentModel(athleteId);
        blocks = parseSessionBlocks(rawBlocks, model);
        const totals = sessionTotals(model, blocks);
        patch.blocks = blocks;
        patch.plannedDurationS = totals.durationS;
        patch.plannedLoad = Math.round(totals.load);
        patch.plannedDistanceM = Math.round(totals.distanceM);
        patch.plannedElevationGainM = Math.round(totals.elevationGainM);
        // La charge mécanique aussi : laissée en place, elle décrirait la séance
        // d'avant et fausserait le PMC mécanique, donc les règles de descente.
        patch.plannedMechanicalLoad = Math.round(totals.mechanicalLoad);
      }

      if (target && scale && scale > 0) {
        // Le chemin de toute transformation : le même que la calibration et que
        // les allègements. Il multipliait ici la durée de tous les blocs,
        // circuits compris, et laissait le dénivelé où il était.
        const t = transformSession(target, scale, await currentModel(athleteId));
        patch.blocks = t.blocks;
        patch.plannedLoad = t.plannedLoad;
        patch.plannedDurationS = t.plannedDurationS;
        patch.plannedMechanicalLoad = t.plannedMechanicalLoad;
        patch.plannedElevationGainM = t.plannedElevationGainM;
        if (t.plannedDistanceM !== undefined) patch.plannedDistanceM = t.plannedDistanceM;
        if (t.plannedElevationGainM !== elevationGainOf(target.blocks)) {
          patch.title = restateVert(title ?? target.title, t.plannedElevationGainM);
        }
        amendments = t.amendments;
        if (amendments.length) patch.rationale = [rationale, ...amendments].join(' ');
      }

      // Les ratios de charge que le plan produira, cette modification comprise,
      // lus avant qu'elle ne s'enregistre : un pic se voit quand la séance
      // s'écrit, pas le soir où sa charge est réalisée. Ils ne bloquent rien —
      // les règles de charge décident —, ils se montrent.
      const ratios = await projectPlanRatios(athleteId, iso(new Date()), {
        sessionId,
        patch: patch as Partial<PlannedSession>,
      });
      const ratioWarning = ratios?.after.length
        ? ` ⚠ Ratio de charge projeté au-delà de son seuil : ${describeRatioExceedances(ratios.after)}.`
        : '';

      await db.updateSession(sessionId, patch as never);
      const plan = await db.getActivePlan(athleteId);
      if (plan) {
        await db.appendPlanRevision(plan.plan.id, {
          at: new Date().toISOString(),
          trigger: 'chat_request',
          summary: rationale + ratioWarning,
          changes: [{ date: newDate ?? '', before: sessionId, after: JSON.stringify(patch), reason: rationale }],
        });
      }
      return {
        summary:
          (blocks
            ? `Séance ${sessionId} modifiée — contenu remplacé (${blocks.length} bloc(s))`
            : `Séance ${sessionId} modifiée${amendments.length ? ' — le dénivelé a dû céder' : ''}`) +
          (ratios?.after.length ? ` — ⚠ ${ratios.after.length} jour(s) au-delà d'un seuil de ratio de charge` : ''),
        content: {
          session_id: sessionId,
          modifications: patch,
          // Ce que la séance a dû céder pour rester exécutable : à relayer tel quel.
          ...(amendments.length ? { amendements: amendments } : {}),
          ...(ratios
            ? {
                ratios_de_charge: {
                  ...ratioContent(ratios.after),
                  du: ratios.from,
                  au: ratios.to,
                  depassements_avant_modification: ratioContent(ratios.before).depassements,
                },
              }
            : {}),
          // Ce que l'athlète lira : le contenu prescrit, pas le titre.
          ...(blocks && target
            ? { apercu: renderSession({ title: (title ?? target.title), intent: intent ?? target.intent, blocks }) }
            : {}),
        },
      };
    }

    case 'get_check_ins': {
      const from = arg<string>(input, 'from') ?? daysAgo(30);
      const checkIns = await db.listCheckIns(athleteId, from);
      return {
        summary: `${checkIns.length} relevé(s) depuis le ${from}`,
        content: checkIns,
      };
    }

    case 'declare_absence': {
      const startDate = arg<string>(input, 'start_date');
      const endDate = arg<string>(input, 'end_date');
      const reason = arg<string>(input, 'reason');
      const kind = arg<AbsenceKind>(input, 'kind');
      if (!startDate || !endDate) throw new Error('start_date et end_date requis.');
      if (!isDay(startDate) || !isDay(endDate)) throw new Error('Dates attendues au format YYYY-MM-DD.');
      if (endDate < startDate) throw new Error('end_date ne peut pas précéder start_date.');
      if (!reason?.trim()) {
        throw new Error("reason requis : une absence se retient avec les mots de l'athlète.");
      }
      if (!kind || !ABSENCE_KINDS.includes(kind)) {
        throw new Error(`kind attendu parmi ${ABSENCE_KINDS.join(', ')} — reçu « ${String(kind)} ».`);
      }

      const covered = await db.listPlannedSessions(athleteId, startDate, endDate);
      const days = Math.round((midnight(endDate) - midnight(startDate)) / dayMs) + 1;
      const describe = (s: PlannedSession) => ({
        id: s.id,
        date: s.date,
        titre: s.title,
        type: s.type,
        priorite: s.priority,
        charge: s.plannedLoad,
        statut: s.status,
      });

      if (arg<boolean>(input, 'preview')) {
        // La règle de retrait est la même que celle qui s'appliquera : ce qu'il
        // confirme est exactement ce qui sera fait.
        const would = withdrawalsFor(
          { id: 'preview', athleteId, startDate, endDate, kind, reason, source: 'athlete', declaredAt: '' },
          covered,
        );
        const ids = new Set(would.map((w) => w.sessionId));
        return {
          summary: `Aperçu — ${would.length} séance(s) seraient retirées du ${startDate} au ${endDate}`,
          content: {
            enregistre: false,
            periode: { du: startDate, au: endDate, jours: days },
            seances_retirees: covered.filter((s) => ids.has(s.id)).map(describe),
            seances_conservees: covered.filter((s) => !ids.has(s.id)).map(describe),
            a_faire: "Soumets ces dates et ces séances à Pierre. S'il confirme, rappelle cet outil sans preview.",
          },
        };
      }

      // Un appel rejoué — reprise après erreur, message répété — ne doit pas
      // créer un second fait pour la même période : la deuxième absence ne
      // retirerait rien et se lirait comme deux coupures.
      const existing = (await db.listAbsences(athleteId, { from: startDate, to: endDate })).find(
        (a) => a.startDate === startDate && a.endDate === endDate,
      );
      if (existing) {
        return {
          summary: `Absence déjà enregistrée du ${startDate} au ${endDate} (${existing.id}) — rien de nouveau`,
          content: {
            absence: { id: existing.id, du: existing.startDate, au: existing.endDate, motif: existing.reason },
            enregistre: false,
            rappel: "Cette période est déjà déclarée. Pour la corriger, il faudra la remplacer, pas l'empiler.",
          },
        };
      }

      const checkInDate = arg<string>(input, 'from_check_in_date');
      const absence = await db.createAbsence({
        athleteId,
        startDate,
        endDate,
        kind,
        reason: reason.trim(),
        // L'outil n'existe que pour retenir ce que l'athlète a annoncé.
        source: 'athlete',
        checkInDate,
      });

      const withdrawals = withdrawalsFor(absence, covered);
      await applyAdjustments(athleteId, withdrawals, 'declared_absence');

      if (checkInDate) {
        await db.markCheckInNoteHandled(
          athleteId,
          checkInDate,
          `Absence déclarée du ${startDate} au ${endDate} — ${withdrawals.length} séance(s) retirée(s).`,
        );
      }

      const withdrawnIds = new Set(withdrawals.map((w) => w.sessionId));
      return {
        summary: `Absence déclarée du ${startDate} au ${endDate} — ${withdrawals.length} séance(s) retirée(s)`,
        content: {
          absence: {
            id: absence.id,
            du: absence.startDate,
            au: absence.endDate,
            jours: days,
            nature: absence.kind,
            motif: absence.reason,
            source: absence.source,
          },
          seances_retirees: covered.filter((s) => withdrawnIds.has(s.id)).map(describe),
          seances_inchangees: covered.filter((s) => !withdrawnIds.has(s.id)).map(describe),
          note_traitee: checkInDate ?? null,
          rappel:
            'Ces séances ne sont ni à faire ni manquées. Le plan n\'a pas été reconstruit : ' +
            'ce qui suit la coupure se décide avec Pierre.',
        },
      };
    }

    case 'update_availability': {
      const profile = await db.getAthlete(athleteId);
      if (!profile) throw new Error('Athlète introuvable.');
      const c = { ...profile.constraints };
      const days = arg<number[]>(input, 'available_days');
      if (days) c.availableDays = days;
      const longDays = arg<number[]>(input, 'long_run_days');
      if (longDays) c.longRunDays = longDays;
      const hours = arg<number>(input, 'max_weekly_hours');
      if (hours) c.maxWeeklyHours = hours;
      const quality = arg<number>(input, 'max_quality_sessions');
      if (quality) c.maxQualitySessionsPerWeek = quality;
      const vert = arg<number>(input, 'accessible_vert_per_session');
      if (vert) c.accessibleVertPerSession = vert;
      const note = arg<string>(input, 'notes');
      if (note) c.notes = [...(c.notes ?? []), note];

      await db.updateConstraints(athleteId, c);
      return {
        summary: 'Contraintes mises à jour',
        content: { contraintes: c, rappel: 'Reconstruis le plan pour que ces contraintes soient prises en compte.' },
      };
    }

    case 'compare_periods': {
      const aStart = arg<string>(input, 'period_a_start')!;
      const aEnd = arg<string>(input, 'period_a_end')!;
      const bStart = arg<string>(input, 'period_b_start')!;
      const bEnd = arg<string>(input, 'period_b_end')!;
      const summarize = async (from: string, to: string) => {
        const acts = await db.listActivities(athleteId, { from, to, limit: 400 });
        const ans = await db.getAnalyses(acts.map((a) => a.id));
        const withAn = acts.map((a) => ({ a, an: ans.get(a.id) })).filter((x) => x.an);
        const drifts = withAn
          .map((x) => x.an!.decoupling.pctDrift)
          .filter((d): d is number => d != null);
        const totalSeconds = withAn.reduce((s, x) => s + x.a.movingTimeS, 0);
        const zoneSeconds = withAn.reduce(
          (acc, x) => {
            acc.low += x.an!.zones.threeZone.low * x.a.movingTimeS;
            acc.moderate += x.an!.zones.threeZone.moderate * x.a.movingTimeS;
            acc.high += x.an!.zones.threeZone.high * x.a.movingTimeS;
            return acc;
          },
          { low: 0, moderate: 0, high: 0 },
        );
        return {
          periode: `${from} → ${to}`,
          activites: acts.length,
          duree_totale: formatDuration(totalSeconds),
          distance_km: round2(acts.reduce((s, a) => s + a.distanceM, 0) / 1000),
          denivele_m: Math.round(acts.reduce((s, a) => s + a.totalElevationGainM, 0)),
          charge_metabolique: Math.round(withAn.reduce((s, x) => s + x.an!.load.metabolic, 0)),
          charge_mecanique: Math.round(withAn.reduce((s, x) => s + x.an!.load.mechanical, 0)),
          repartition_pct: totalSeconds
            ? {
                bas: Math.round((zoneSeconds.low / totalSeconds) * 100),
                modere: Math.round((zoneSeconds.moderate / totalSeconds) * 100),
                haut: Math.round((zoneSeconds.high / totalSeconds) * 100),
              }
            : null,
          derive_cardiaque_moyenne_pct: drifts.length
            ? round2(drifts.reduce((a, b) => a + b, 0) / drifts.length)
            : null,
        };
      };
      const [a, b] = await Promise.all([summarize(aStart, aEnd), summarize(bStart, bEnd)]);
      return {
        summary: `Comparaison ${aStart}→${aEnd} vs ${bStart}→${bEnd}`,
        content: { periode_a: a, periode_b: b },
      };
    }

    default:
      throw new Error(`Outil inconnu : ${name}`);
  }
}

/** Dépassements de ratio de charge, tels que le coach les lit. */
function ratioContent(exceedances: readonly LoadRatioExceedance[]) {
  return {
    seuils: { metabolique: ACWR_SPIKE.metabolic, mecanique: ACWR_SPIKE.mechanical },
    depassements: exceedances.map((e) => ({
      date: e.date,
      filiere: e.channel === 'mechanical' ? 'mécanique' : 'métabolique',
      ratio: e.value,
      seuil: e.limit,
    })),
  };
}

/** Recalcule le modèle physiologique — exposé séparément (opération lourde). */
export async function refreshModel(athleteId: string) {
  const model = await rebuildPhysiologyModel(athleteId);
  return {
    summary: `Modèle recalculé (confiance ${Math.round(model.confidence * 100)} %)`,
    content: model,
  };
}

/**
 * Ce que la charge mécanique prescrite doit à un excentrique hors course.
 *
 * Renvoie un objet vide quand il n'y en a pas : une séance de descente n'a rien
 * à déclarer, son chiffre sera confronté au flux. Quand il y en a, la part est
 * nommée — même exigence de provenance que pour un paramètre physiologique.
 */
function mechanicalBlindSpot(s: PlannedSession): Record<string, unknown> {
  const ecc = eccentricStrengthOf(s.blocks);
  if (ecc <= 0) return {};
  return {
    charge_mecanique_hors_flux: ecc,
    charge_mecanique_hors_flux_note:
      `${ecc} des ${s.plannedMechanicalLoad} points viennent du renforcement excentrique, qui n'est dans aucun ` +
      `flux d'activité. Le réalisé mesuré affichera 0 sur cette part quoi qu'il arrive : c'est une cécité de la ` +
      `mesure, pas une séance non faite. Le reste est du dénivelé négatif couru, que le réalisé confirmera.`,
  };
}

/**
 * Les bornes que toute séance respecte, avec ce sur quoi chacune repose.
 *
 * Le coach doit les voir pour écrire un contenu exécutable : `modify_session`
 * refuse ce qui les dépasse, et une borne affichée sans sa provenance ferait
 * lire une extrapolation comme une mesure.
 */
function verticalCapacityTable(model: PhysiologyModel) {
  const row = (direction: 'climb' | 'descent') => {
    const capacity = verticalCapacity(model, direction);
    return Object.fromEntries(
      VERTICAL_CURVE_DURATIONS.map((d) => {
        const bound = capacity.at(d);
        return [formatDuration(d), { m_par_h: Math.round(bound.vamMh), provenance: bound.provenance }];
      }),
    );
  };
  return {
    montee: row('climb'),
    descente: row('descent'),
    note:
      "Bornes appliquées à chaque segment d'une séance — effort ou récupération : ce qu'il monte et ce qu'il " +
      "descend doit tenir dans sa durée. Elles viennent des courbes du modèle (un an de séances), pas de la " +
      "fenêtre récente de vam_par_duree_m_par_h. « default » : aucun point mesuré sur cette durée — la valeur " +
      "est extrapolée depuis le plus long point, ou vient du moteur quand la courbe est vide. Ce sont des " +
      "bornes fraîches : un segment se juge à l'instant où il commence, la borne perdant ce que la durabilité " +
      "retire du temps de séance écoulé et du D+ déjà monté — D+ et D− en descente, où cette perte est une " +
      `valeur par défaut —, et une prescription garde ${Math.round(PRESCRIPTION_MARGIN * 100)} % de marge sous elle.`,
  };
}

const round2 = (v: number) => Math.round(v * 100) / 100;
