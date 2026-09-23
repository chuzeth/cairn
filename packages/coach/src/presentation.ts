import type {
  DecisionOrigin, LabTest, PhysiologyModel, PlannedSession, ReadinessScore, SessionBlock, SessionHistoryEntry,
} from '@cairn/core';
import { anchorRelativeDates, decimal, sessionDuration, signedDecimal, writtenOn } from '@cairn/core';
import {
  CS_FIT_MAX_S, CS_FIT_MIN_S, DURABILITY_MEASURABLE, READINESS_VERDICT, TAU_MECHANICAL, TAU_METABOLIC, VMA_EFFORT_S,
  vmaSources,
} from '@cairn/physiology';
import { firstDescentNote } from './eccentric.js';
import { locateVertical } from './plausibility.js';
import * as lib from './sessionLibrary.js';
import type { TerrainHint } from './terrain.js';

/**
 * La présentation d'une séance : ce qui se lit, par opposition à ce qui se fait.
 *
 * Une séance décidée — par le coach, par l'athlète, par les règles de charge —
 * l'est dans son contenu : date, type, durée, dénivelé, charge. Son commentaire
 * n'est pas la décision. Une reconstruction reprenait pourtant tout, textes
 * compris : le test maximal du 22/09 et la rando-course du 27/09 gardaient un
 * « pourquoi » de 2 713 et 2 136 caractères, et une consigne qui parlait du
 * « soir » où elle avait été écrite. Le contenu reste intact ; la présentation
 * suit les règles du jour, comme pour toute séance ; et ce qu'elle remplace
 * — raisonnement, consignes — passe dans l'historique de la séance, daté, à un
 * geste de distance.
 *
 * Module pur : ni base, ni réseau.
 */

// ─────────────────────────────────────────────────────────────────────────────
// Les mots de Pierre
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Pierre lit Cairn sans en connaître le vocabulaire. Ce qui s'adresse à lui
 * passe donc par ici, pour que les mêmes règles s'appliquent partout d'un coup :
 *
 *  · on lui parle à lui, à la deuxième personne — jamais « l'athlète » ;
 *  · d'abord ce que ça change pour lui — des secondes sur sa course, des minutes
 *    sur sa séance, un geste à faire —, puis le pourquoi en une phrase ;
 *  · aucun terme interne sans sa traduction : un chiffre du modèle s'écrit avec
 *    ce qu'il signifie ;
 *  · les nombres s'écrivent à la française.
 *
 * Le mécanisme complet n'est pas perdu pour autant : il tient dans un second
 * paragraphe, séparé par une ligne vide, que le journal du plan et le coach
 * lisent ; l'écran s'arrête au premier. Rien n'est retiré au modèle — c'est le
 * lieu de lecture qui change.
 */

/** Ce qu'un écart coûte sur une course : « 11 secondes », « 3 minutes ». */
export const raceTime = (seconds: number): string => {
  const s = Math.round(Math.abs(seconds));
  if (s < 120) return `${s} seconde${s > 1 ? 's' : ''}`;
  const min = Math.round(s / 60);
  return `${min} minute${min > 1 ? 's' : ''}`;
};

/** Ce que « fraîcheur » veut dire, dans un texte qui n'a pas d'écran pour le déplier : le journal, le coach. */
export const FRESHNESS_MEANS =
  'ta forme de fond moins la fatigue des derniers jours — plus le nombre est haut, plus tu pars reposé';

// ─────────────────────────────────────────────────────────────────────────────
// Le vocabulaire
// ─────────────────────────────────────────────────────────────────────────────

const COUNT = ['zéro', 'un', 'deux', 'trois', 'quatre', 'cinq', 'six', 'sept', 'huit', 'neuf', 'dix'];

/** « la dernière semaine », « les six dernières semaines », « les cinq derniers jours ». */
function lastSpan(days: number): string {
  if (days % 7 === 0) {
    const weeks = days / 7;
    return weeks === 1 ? 'la dernière semaine' : `les ${COUNT[weeks] ?? weeks} dernières semaines`;
  }
  return days === 1 ? 'le dernier jour' : `les ${COUNT[days] ?? days} derniers jours`;
}

/**
 * Les mots techniques qui restent à l'écran, et ce qu'ils veulent dire.
 *
 * Une table, une seule : l'écran la sert derrière un soulignement pointillé,
 * là où le mot porte un chiffre. Chaque définition tient en une phrase, écrite
 * pour qui n'a jamais lu de physiologie et exacte pour qui en a lu — ses
 * nombres sont ceux du moteur, lus dans ses constantes : une définition qui
 * les recopierait finirait par décrire un autre calcul que celui qui tourne.
 * Le point d'ancrage de toutes les charges : une heure à ton seuil vaut 100
 * points.
 */
export const GLOSSARY = {
  points: {
    term: 'Points de charge',
    definition:
      "Ce qu'une séance coûte à ton cœur et à ton souffle : une heure à ton seuil vaut 100 points, et " +
      "l'intensité compte au carré — la même heure 10 % moins vite n'en vaut que 81.",
  },
  mecanique: {
    term: 'Charge mécanique',
    definition:
      "Ce que tes muscles encaissent à freiner chaque appui, en descente surtout : 1 000 m de descente à " +
      'pente et allure modérées valent environ 40 points, que le cœur, lui, sent à peine.',
  },
  forme: {
    term: 'Forme de fond',
    definition:
      `Tes points de charge par jour, en moyenne sur ${lastSpan(TAU_METABOLIC.chronic)} environ, les plus ` +
      "récents pesant davantage : ce que ton entraînement a construit, et qui ne bouge que lentement.",
  },
  fatigue: {
    term: 'Fatigue',
    definition:
      `La même moyenne sur ${lastSpan(TAU_METABOLIC.acute)} environ : elle grimpe dès qu'une séance est dure, ` +
      'et retombe en quelques jours de calme.',
  },
  fraicheur: {
    term: 'Fraîcheur',
    definition:
      "Ta forme de fond moins ta fatigue : négative quand tu t'entraînes plus que tu ne récupères, positive " +
      "quand tu es reposé — on la veut positive au départ d'une course ; celle des jambes fait le même calcul " +
      `avec la charge mécanique, sur ${lastSpan(TAU_MECHANICAL.chronic)} et ${lastSpan(TAU_MECHANICAL.acute)}.`,
  },
  disponibilite: {
    term: 'Disponibilité',
    definition:
      'Ta réserve du jour, sur 100 : ta fraîcheur, celle de tes jambes, ton ressenti et ta FC de repos ou ta ' +
      'variabilité cardiaque, chacun à son poids — ce que tu ne relèves pas ne pèse rien —, moins une pénalité ' +
      `quand ta charge s'emballe ; vert dès ${READINESS_VERDICT.green}, rouge sous ${READINESS_VERDICT.amber}.`,
  },
  vitesseCritique: {
    term: 'Vitesse critique',
    definition:
      'La vitesse la plus haute où ton effort se stabilise encore : en dessous, tu tiens longtemps ; au-dessus, ' +
      'chaque seconde puise dans une réserve de quelques centaines de mètres, vite épuisée — Cairn la calcule ' +
      `sur tes meilleurs efforts de ${CS_FIT_MIN_S / 60} à ${CS_FIT_MAX_S / 60} minutes.`,
  },
  vma: {
    term: 'VMA',
    definition:
      "Ta vitesse maximale aérobie, celle où ton cœur et tes poumons fournissent tout l'oxygène qu'ils " +
      'peuvent : tu la tiens de 4 à 8 minutes à fond.',
  },
  seuil: {
    term: 'Seuil',
    definition:
      "Deux repères de vitesse : sous le seuil 1, tu parles en courant et tiens des heures ; le seuil 2 est " +
      "l'allure que tu tiens environ une heure à fond, au-delà de laquelle le souffle s'emballe — c'est lui " +
      'qui fixe les points de charge.',
  },
} as const satisfies Record<string, { term: string; definition: string }>;

export type GlossaryKey = keyof typeof GLOSSARY;

// ─────────────────────────────────────────────────────────────────────────────
// Ce qui est sous la résolution du modèle
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un écart plus petit que l'incertitude de ce qui le mesure ne s'affiche pas.
 *
 * Huit secondes sur une course que la prédiction place à ±23 minutes ne sont
 * pas une information : les écrire, c'est prêter au modèle une précision qu'il
 * n'a pas, et demander à Pierre de s'inquiéter d'un bruit.
 */
export const resolvable = (gap: number, uncertainty: number): boolean =>
  Number.isFinite(gap) && Math.abs(gap) >= Math.abs(uncertainty);

/** Ce qu'un écart à la fraîcheur visée coûte, et ce que mesure la prédiction qui le chiffre. */
export interface RaceDayGapCost {
  /** Ce que l'écart coûte sur la course, s. Nul quand il partirait plus frais que visé. */
  costS: number;
  /** Le temps prédit à la fraîcheur visée, s. */
  predictedS: number;
  /** Demi-largeur de l'intervalle à 80 % de cette prédiction, s. */
  uncertaintyS: number;
}

/**
 * Ce que l'écran dit de l'écart à la fraîcheur visée : sa première phrase, et
 * rien quand l'écart est sous la résolution de la prédiction.
 *
 * Parti plus frais que visé, l'écart ne coûte pas de temps — c'est le fond qui
 * manque, et la phrase dit ce qui se décide : les heures de la semaine. Le
 * mécanisme, lui, ne s'affiche jamais ici : il est au journal du plan.
 */
export function raceDayNotice(
  shortfall: string | null | undefined,
  gap: { target: number; projected: number } & Pick<RaceDayGapCost, 'costS' | 'uncertaintyS'>,
): string | null {
  if (!shortfall) return null;
  if (gap.projected >= gap.target) return firstParagraph(shortfall);
  return resolvable(gap.costS, gap.uncertaintyS) ? firstParagraph(shortfall) : null;
}

/**
 * Ce que le journal du plan garde d'un écart d'affûtage : ce que l'écran en
 * dit, quand il en dit quelque chose, puis le mécanisme entier — profondeur
 * d'affûtage, plancher, semaines, points de fraîcheur.
 */
export function taperGapJournal(
  shortfall: string,
  gap: { target: number; projected: number } & Pick<RaceDayGapCost, 'costS' | 'uncertaintyS'>,
): string {
  const mechanism = shortfall.split('\n\n').slice(1).join(' ');
  return [raceDayNotice(shortfall, gap), mechanism].filter(Boolean).join(' ');
}

/**
 * Un texte en deux temps : ce que ça change, puis le mécanisme.
 *
 * La ligne vide n'est pas une mise en page, c'est la coupure : l'écran ne
 * montre que le premier, le journal du plan garde le second, et le coach lit
 * le tout.
 */
export const twoParts = (plain: string, mechanism: string): string => `${plain}\n\n${mechanism}`;

/** Ce qu'un texte en deux temps dit d'abord. */
export const firstParagraph = (text: string): string => text.split('\n\n')[0] ?? text;

export interface TaperGap {
  /** Le jour de la course, tel qu'il s'écrit : « 18/10 ». */
  raceDay: string;
  /** Fraîcheur visée à la veille de la course, et celle que le plan y amène. */
  target: number;
  projected: number;
  /** Ce que l'écart coûte sur la course, s, et le temps prédit, s. Nuls si personne ne l'a mesuré. */
  costS: number;
  predictedS: number;
  /** Demi-largeur de l'intervalle à 80 % de la prédiction, s. Absente : inconnue. */
  uncertaintyS?: number;
  /** L'affûtage bute sur l'une de ses bornes. */
  atFloor: boolean;
  atCeiling: boolean;
  /** Profondeur retenue, en multiple de la profondeur habituelle. */
  taperScale: number;
  weeks: number;
  taperWeeks: number;
  /** Forme de fond au départ du plan, en points. */
  startCtl: number;
  maxWeeklyHours: number;
}

/**
 * L'écart à la fraîcheur visée, dit à Pierre.
 *
 * Ce qu'il en retient tient en trois phrases : ce qu'il perdra le jour J en
 * secondes, pourquoi on ne va pas le chercher, et ce qu'il a à faire — rien,
 * le plus souvent. Le compte complet — profondeur d'affûtage, semaines, forme
 * de fond de départ, points de fraîcheur manquants — le suit, à un geste.
 *
 * Une cible manquée par le haut ne se dit pas en secondes : le jour J, plus de
 * fraîcheur ne coûte pas de temps, c'est le fond qui manque, et le temps qu'il
 * coûte n'est pas dans cet écart-là.
 */
export function taperGapText(g: TaperGap): string {
  const depth = `L'affûtage est à ${Math.round(g.taperScale * 100)} % de sa profondeur habituelle`;
  const frame =
    `${g.weeks} semaine${g.weeks > 1 ? 's' : ''} dont ${g.taperWeeks} d'affûtage, ` +
    `en partant d'une forme de fond de ${Math.round(g.startCtl)} points`;
  const scale =
    `${signedDecimal(g.projected)} contre ${signedDecimal(g.target)} visés — la fraîcheur, c'est ${FRESHNESS_MEANS}.`;

  if (g.projected < g.target) {
    // Sous la résolution de la prédiction, l'écran ne dit rien de l'écart ;
    // le coach, qui lit ce texte en entier, sait pourquoi.
    const blur = g.uncertaintyS && !resolvable(g.costS, g.uncertaintyS)
      ? `, sous la précision de la prédiction (±${raceTime(g.uncertaintyS)})`
      : '';
    const cost = g.costS > 0 && g.predictedS > 0
      ? ` : ${raceTime(g.costS)} sur ${sessionDuration(g.predictedS)}${blur}`
      : '';
    const why = g.atFloor
      ? 'Alléger davantage te ferait perdre plus de forme que tu ne gagnerais de fraîcheur.'
      : "D'ici là, il n'y a pas assez de semaines pour aller chercher le reste.";
    const floor = g.atFloor
      ? ", son plancher : en dessous, ta forme de fond se perdrait plus vite que la fatigue ne s'évacue, " +
        'et la fraîcheur gagnée coûterait la forme.'
      : '.';
    const missing = Math.abs(g.target - g.projected);
    return twoParts(
      `Tu seras un peu moins frais que l'idéal le ${g.raceDay}${cost}. ${why} Rien à faire.`,
      `${depth}${floor} ${frame} : il manque ${decimal(missing)} point${missing >= 2 ? 's' : ''} de ` +
        `fraîcheur, ${scale}`,
    );
  }
  return twoParts(
    `Le ${g.raceDay}, tu partiras plus reposé que l'idéal, mais moins entraîné : tes ` +
      `${g.maxWeeklyHours} h par semaine ne laissent pas la place de construire plus de fond d'ici là. ` +
      `Rien à faire, sinon courir davantage chaque semaine — et ça se décide, ça ne se rattrape pas.`,
    `${depth}${g.atCeiling ? ", son plafond — au-delà, la fin de préparation ne serait plus un affûtage" : ''}. ` +
      `${frame}, ${g.maxWeeklyHours} h par semaine au plus : cette charge ne construit pas le fond qu'une ` +
      `fraîcheur de ${signedDecimal(g.target)} suppose. ${scale}`,
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Le point du jour
// ─────────────────────────────────────────────────────────────────────────────

/**
 * À quoi sert le point du jour, dit avant l'envoi.
 *
 * Il ne décide rien lui-même : il entre dans la disponibilité, et c'est la
 * règle du rouge (`adapt.ts`) qui allège, quand la séance qui vient est assez
 * lourde pour qu'il y ait quelque chose à alléger — d'où « peuvent ».
 */
export const CHECK_IN_PURPOSE =
  'Tes réponses entrent dans ta disponibilité du jour : si elles la font passer au rouge, sous ' +
  `${READINESS_VERDICT.amber}, les règles de charge peuvent alléger ta prochaine séance.`;

/** Ce qu'une séance est, avant et après un point du jour. */
export interface SessionState {
  type: string;
  status: string;
  date: string;
  durationS: number;
  load: number;
}

export interface CheckInEffect {
  before: Pick<ReadinessScore, 'score' | 'verdict'>;
  after: Pick<ReadinessScore, 'score' | 'verdict'>;
  /** Le jour du point. */
  today: string;
  /**
   * La prochaine séance que les règles pouvaient toucher — aujourd'hui ou
   * demain —, telle qu'elle était et telle qu'elle est. `null` : aucune.
   */
  session: { before: SessionState; after: SessionState | null } | null;
}

const VERDICT_REACHED: Record<ReadinessScore['verdict'], string> = {
  green: 'au vert',
  amber: 'en vigilance',
  red: 'au rouge',
};

/**
 * Ce que les réponses ont changé, en une phrase : la disponibilité avant et
 * après, et la séance — inchangée, ou allégée, et de combien.
 */
export function checkInEffect(e: CheckInEffect): string {
  const reached = e.after.verdict !== e.before.verdict ? `, ${VERDICT_REACHED[e.after.verdict]}` : '';
  const score = e.after.score === e.before.score
    ? `Ta disponibilité reste à ${e.after.score}${reached}`
    : `Ta disponibilité passe de ${e.before.score} à ${e.after.score}${reached}`;
  if (!e.session) return `${score} ; aucune séance n'est prévue d'ici demain.`;

  const { before, after } = e.session;
  const which = `ta séance ${before.date === e.today ? 'du jour' : 'de demain'}`;
  const changed = sessionChange(before, after);
  return changed ? `${score} : ${which} ${changed}.` : `${score} ; ${which} ne change pas.`;
}

/** Ce qu'une séance est devenue, dit de ce qu'on en voit ; vide si rien n'a changé. */
function sessionChange(before: SessionState, after: SessionState | null): string {
  if (!after || after.status === 'cancelled' || after.status === 'withdrawn') return 'est annulée';
  if (after.type === 'rest' && before.type !== 'rest') return 'devient un repos complet';
  if (after.date !== before.date) return `passe au ${writtenOn(after.date)}`;
  if (after.durationS < before.durationS) {
    return `est allégée, ${sessionDuration(after.durationS)} au lieu de ${sessionDuration(before.durationS)}`;
  }
  if (after.type !== before.type) return 'devient un décrassage';
  if (after.load < before.load) return `est allégée, ${after.load} points de charge au lieu de ${before.load}`;
  return '';
}

// ─────────────────────────────────────────────────────────────────────────────
// Ce qui écarte un paramètre de son test de laboratoire
// ─────────────────────────────────────────────────────────────────────────────

export type LabGapKey = 'vma' | 'vt2' | 'vt1' | 'hrMax' | 'hrRest';

/**
 * En dessous de ces écarts, un paramètre ne s'écarte pas de son test : c'est
 * la résolution de la mesure de laboratoire. Une vitesse s'y lit au palier
 * près — le protocole dit de combien il monte, sinon un demi-km/h —, une FC au
 * battement près, à deux battements du capteur.
 */
const LAB_HR_RESOLUTION_BPM = 2;
const labSpeedResolutionKmh = (lab: LabTest): number => {
  const step = /incr[ée]ment\w*\s+(\d+(?:[.,]\d+)?)\s*km\/h/i.exec(lab.protocol)?.[1];
  return step ? Number(step.replace(',', '.')) : 0.5;
};

/** Une vitesse au dixième, sans le « ,0 » d'un entier : « 20 km/h », « 16,8 km/h ». */
const kmh = (ms: number) => {
  const v = Math.round(ms * 36) / 10;
  return Number.isInteger(v) ? String(v) : decimal(v, 1);
};

const MINUTES_IN_WORDS: Record<number, string> = {
  2: 'deux', 3: 'trois', 4: 'quatre', 5: 'cinq', 6: 'six', 7: 'sept', 8: 'huit', 10: 'dix', 12: 'douze',
  15: 'quinze', 20: 'vingt', 30: 'trente',
};

/** « vingt minutes », « 5 min 30 ». */
function effortSpan(seconds: number): string {
  const min = seconds / 60;
  if (Number.isInteger(min)) return MINUTES_IN_WORDS[min] ? `${MINUTES_IN_WORDS[min]} minutes` : `${min} minutes`;
  return `${Math.floor(min)} min ${String(Math.round(seconds % 60)).padStart(2, '0')}`;
}

/** L'âge d'un test, dit comme on le dit : « 14 mois ». */
function labAge(labDate: string, asOf: string): string {
  const days = (Date.parse(asOf) - Date.parse(labDate)) / 86_400_000;
  if (days < 45) return `${Math.round(days)} jours`;
  return `${Math.round(days / 30.44)} mois`;
}

/** « paliers d'une minute », quand le protocole le dit. */
function stages(lab: LabTest): string {
  const n = /paliers?\s+d['’]\s*(\d+)\s*min/i.exec(lab.protocol)?.[1];
  if (!n) return '';
  return Number(n) === 1 ? ", mesuré par paliers d'une minute" : `, mesuré par paliers de ${COUNT[Number(n)] ?? n} minutes`;
}

/** « ne pèse plus que 34 % », « n'y pèse plus que 12 % », « pèse encore 60 % ». */
const labShare = (w: number, there = false) =>
  w < 0.5
    ? `${there ? "n'y" : 'ne'} pèse plus que ${Math.round(w * 100)} %`
    : `${there ? 'y ' : ''}pèse encore ${Math.round(w * 100)} %`;

/**
 * Pourquoi un paramètre n'est plus celui du test de laboratoire, en une ligne
 * par paramètre, sur ce que le modèle a lui-même retenu : le poids qui reste
 * au laboratoire, l'effort de terrain qui l'a remplacé, la règle qui le dérive.
 * Un paramètre qui ne s'écarte pas de son test — à la résolution du test
 * près — n'a rien à dire.
 */
export function labGaps(model: PhysiologyModel, lab: LabTest): Partial<Record<LabGapKey, string>> {
  const out: Partial<Record<LabGapKey, string>> = {};
  const speedStep = labSpeedResolutionKmh(lab);
  const apart = (a: number, b: number) => resolvable(a - b, speedStep / 3.6);
  const age = labAge(lab.date, model.asOf);

  const vma = vmaSources(model, lab);
  if (vma.fieldMs != null && apart(model.vmaMs, lab.vmaMs)) {
    const from = vma.basis === 'effort'
      ? `ton meilleur effort de ${effortSpan(VMA_EFFORT_S)}`
      : 'ta vitesse critique';
    const vo2 = Math.abs(model.vo2maxRel - lab.vo2maxRel) >= 1 ? ' Ta VO2max suit dans la même proportion.' : '';
    out.vma =
      `Ton labo disait ${kmh(lab.vmaMs)} km/h${stages(lab)} ; le terrain la place à ${kmh(vma.fieldMs)} km/h, ` +
      `d'après ${from}. Le labo ${labShare(vma.labWeight)} : il a ${age}.${vo2}`;
  }

  if (apart(model.vt2.speedMs, lab.vt2.speedMs)) {
    const ev = model.criticalSpeedEvidence;
    const share = ev ? ` Le labo ${labShare(ev.weightLab, true)}.` : '';
    const proof = ev?.proof;
    const on = (ageDays: number) => writtenOn(new Date(Date.parse(model.asOf) - ageDays * 86_400_000).toISOString());
    if (proof) {
      const side = lab.vt2.speedMs > proof.speedMs ? 'au-dessus des' : 'sous les';
      out.vt2 =
        `Ton labo le plaçait à ${kmh(lab.vt2.speedMs)} km/h, ${side} ${kmh(proof.speedMs)} km/h que tu as tenus ` +
        `${effortSpan(proof.durationS)} à fond le ${on(proof.ageDays)} : ton seuil 2 se place juste sous ta ` +
        `vitesse critique.${share}`;
    } else {
      const basis = ev?.lastProofAgeDays != null
        ? `, d'après ton effort maximal du ${on(ev.lastProofAgeDays)}`
        : ', sans effort maximal récent pour l\'ancrer';
      out.vt2 =
        `Ton labo le plaçait à ${kmh(lab.vt2.speedMs)} km/h ; le terrain place ta vitesse critique à ` +
        `${kmh(model.criticalSpeedMs)} km/h${basis}, et ton seuil 2 juste en dessous.${share}`;
    }
  }

  if (apart(model.vt1.speedMs, lab.vt1.speedMs)) {
    out.vt1 =
      `Ton labo le plaçait à ${kmh(lab.vt1.speedMs)} km/h ; faute de mesure de terrain, il suit ton seuil 2 ` +
      "dans le même rapport qu'au labo.";
  }

  if (model.hrMax - lab.hrMax >= LAB_HR_RESOLUTION_BPM) {
    out.hrMax = `Ton labo mesurait ${lab.hrMax} bpm ; tes sorties montent plus haut, jusqu'à ${model.hrMax} hors pics isolés.`;
  }

  if (lab.hrRestLab != null && Math.abs(model.hrRest - lab.hrRestLab) >= LAB_HR_RESOLUTION_BPM) {
    const measured = model.provenance.hrRest === 'field';
    out.hrRest =
      `Ton labo l'a relevée à ${lab.hrRestLab} bpm, debout et sous masque, juste avant l'effort : écartée. ` +
      (measured
        ? `${model.hrRest} vient de tes mesures au réveil.`
        : `${model.hrRest} est une estimation d'après ta VO2max ; trois mesures au réveil, au point du jour, la remplacent.`);
  }
  return out;
}

export interface PresentationContext {
  model: PhysiologyModel;
  /** Le terrain de l'athlète : c'est par lui qu'une rando-course nomme sa montée. */
  terrain?: TerrainHint;
}

/**
 * La première phrase d'un texte.
 *
 * Une phrase finit sur un point suivi d'une majuscule, d'un guillemet ou de la
 * fin du texte : « 1,5 » ou « km/h. » au milieu d'une phrase ne la coupent pas.
 */
export function firstSentence(text: string): string {
  const t = text.trim();
  return /^.*?[.!?…](?=\s+[\p{Lu}«"(—]|\s*$)/su.exec(t)?.[0] ?? t;
}

/** Vrai quand un texte tient en une phrase. */
export const isOneSentence = (text: string): boolean => firstSentence(text) === text.trim();

/**
 * Ajoute une entrée à l'historique d'une séance, dates relatives ancrées sur le
 * jour où elle a été écrite. Une entrée vide n'en est pas une.
 */
export function withHistory(
  history: readonly SessionHistoryEntry[] | undefined,
  entry: SessionHistoryEntry,
): SessionHistoryEntry[] {
  const text = anchorRelativeDates(entry.text.trim(), entry.at);
  const notes = entry.notes?.map((n) => anchorRelativeDates(n, entry.at)).filter(Boolean);
  if (!text && !notes?.length) return [...(history ?? [])];
  return [...(history ?? []), { at: entry.at, by: entry.by, text, ...(notes?.length ? { notes } : {}) }];
}

const BY: Record<DecisionOrigin, string> = {
  coach: 'par le coach',
  athlete: 'par toi',
  rules: 'par les règles de charge',
  developer: "par un appel direct à l'API",
};

/** La décision, dite en tête de phrase : « fixée par le coach le 18/09 ». */
const decided = (s: PlannedSession) =>
  s.decision ? `${BY[s.decision.by]} le ${writtenOn(s.decision.at)}` : '';

const measuresDurability = (s: Pick<PlannedSession, 'blocks' | 'plannedDurationS'>) =>
  s.plannedDurationS >= DURABILITY_MEASURABLE.minDurationS &&
  lib.elevationGainOf(s.blocks) >= DURABILITY_MEASURABLE.minVertM;

/**
 * Le « pourquoi » d'une séance décidée, en une phrase concrète.
 *
 * Il dit qui l'a fixée, quand, et ce qu'elle fait — pas le raisonnement qui y a
 * mené : celui-là est dans l'historique. Une décision des règles de charge se
 * dit par sa première phrase, qui nomme le signal qui l'a déclenchée.
 */
export function decidedWhy(s: PlannedSession, model: PhysiologyModel): string {
  const by = decided(s);
  if (s.decision?.by === 'rules') {
    const signal = anchorRelativeDates(firstSentence(s.decision.summary), s.decision.at);
    return `Ajustée ${by} — ${signal}`.replace(/\s*[.…]?$/, '.');
  }
  if (lib.isMaximalTest(s, model)) {
    const effort = s.blocks.find((b) => b.zone === 'Z5' || (b.hrRange?.[0] ?? 0) >= model.vt2.hr);
    const min = Math.round((effort?.durationS ?? 0) / 60);
    return `Test maximal fixé ${by} : ${min} min à fond sur le plat, la seule mesure qui ancre ta vitesse critique.`;
  }
  if (s.type === 'long_trail') {
    const what = `${sessionDuration(s.plannedDurationS)} et ${lib.elevationGainOf(s.blocks)} m D+`;
    return measuresDurability(s)
      ? `Rando-course fixée ${by} à ${what} : de quoi mesurer ta durabilité et préparer tes quadriceps à la descente.`
      : `Rando-course fixée ${by} à ${what}, en terrain de course.`;
  }
  const vert = lib.titleVertical(s.type, s.blocks);
  const mention = vert.m > 50 ? `, ${vert.m} m D${vert.sign}` : '';
  return `Séance fixée ${by} : ${sessionDuration(s.plannedDurationS)}${mention}.`;
}

/** Ce qu'une présentation a remplacé, en toutes lettres : titre, intention, consignes. */
function replaced(before: PlannedSession, after: Pick<PlannedSession, 'title' | 'intent' | 'blocks'>): string[] {
  const out: string[] = [];
  if (before.intent && before.intent !== after.intent) out.push(`Intention : ${before.intent}`);
  const kept = new Set(after.blocks.map((b) => b.notes).filter(Boolean));
  for (const b of before.blocks) {
    if (b.notes && !kept.has(b.notes)) out.push(`${b.label} : ${b.notes}`);
  }
  return out;
}

/**
 * La forme que les règles du jour donnent à un contenu décidé, quand elles en
 * ont une et qu'elle ne le change pas.
 *
 * Une rando-course se présente comme elle se court — une durée, un dénivelé,
 * une règle de marche : « 3 h, 680 m D+ » présentée ainsi reste « 3 h, 680 m
 * D+ ». Un test maximal garde ses blocs et ses cibles, et prend les mots des
 * tests. Ailleurs, les blocs restent ceux qui ont été décidés.
 */
function formFor(
  s: PlannedSession,
  ctx: PresentationContext,
): Pick<PlannedSession, 'title' | 'intent' | 'blocks'> | null {
  const { model } = ctx;
  if (s.type === 'long_trail') return trailForm(s, ctx);
  if (lib.isMaximalTest(s, model)) {
    const blocks = lib.timeTrialPresentation(s.blocks, model);
    const effort = blocks.find((b) => b.label.startsWith('Contre-la-montre'));
    const min = Math.round((effort?.durationS ?? 0) / 60);
    const t = lib.timeTrial(model, min);
    return { title: lib.sessionTitle(`Test maximal ${min} min`, s.type, blocks), intent: t.intent, blocks };
  }
  return null;
}

/**
 * Une rando-course telle qu'elle se court — une durée, un dénivelé, une règle
 * de marche, et la montée qui porte ce dénivelé quand le terrain en connaît une
 * —, pourvu que cette forme ne change pas son contenu.
 */
function trailForm(
  s: PlannedSession,
  ctx: PresentationContext,
): Pick<PlannedSession, 'title' | 'intent' | 'blocks'> | null {
  if (s.blocks.length === 0) return null;
  // Un contenu dont les blocs ne portent pas le dénivelé décidé n'est pas une
  // rando-course qu'on puisse présenter autrement sans la changer.
  const gain = lib.elevationGainOf(s.blocks);
  if (gain !== Math.round(s.plannedElevationGainM ?? gain)) return null;
  const t = lib.longTrail(ctx.model, s.plannedDurationS / 60, gain, ctx.terrain);
  const intact =
    t.durationS === s.plannedDurationS &&
    t.elevationGainM === gain &&
    t.elevationLossM === lib.elevationLossOf(locateVertical(s.blocks, s.type));
  return intact ? { title: t.title, intent: t.intent, blocks: t.blocks } : null;
}

/**
 * Re-présente une séance décidée : contenu intact, présentation du jour.
 *
 * Le contenu, c'est la date, le type, la durée, le dénivelé et la charge, tels
 * qu'ils ont été décidés : ils sont repris à l'identique, et les blocs qu'on
 * présente les portent — même durée, même dénivelé. La présentation, c'est le
 * titre, l'intention, la phrase de « pourquoi » et les consignes : elles sont
 * celles que les règles écrivent aujourd'hui.
 *
 * Ce qu'elle remplace n'est pas effacé. Le raisonnement de la décision et les
 * consignes qui l'accompagnaient rejoignent l'historique, une fois, datés du
 * jour de la décision et leurs dates relatives ancrées sur lui : une seconde
 * reconstruction trouve l'entrée et n'en ajoute pas.
 */
export function presentDecided(s: PlannedSession, ctx: PresentationContext): PlannedSession {
  if (!s.decision) return s;
  const { at, by } = s.decision;
  const form = formFor(s, ctx);

  // Ailleurs que dans une forme connue, les blocs décidés restent, sur la
  // maille ronde quand elle ne change pas leur durée, et leurs consignes se
  // relisent n'importe quel jour.
  const own = (): SessionBlock[] => {
    const snapped = lib.snapToHumanGrid(s.blocks);
    const blocks = lib.totalDuration(snapped) === lib.totalDuration(s.blocks) ? snapped : s.blocks.map((b) => ({ ...b }));
    return blocks.map((b) => (b.notes ? { ...b, notes: anchorRelativeDates(b.notes, at) } : b));
  };
  const blocks = form?.blocks ?? own();
  // Une séance allégée par les règles le reste : c'est ce que sa décision a fait.
  const lightened = / · allégée$/.test(s.title) ? ' · allégée' : '';
  const title = `${form?.title ?? lib.retitleFromContent({ title: s.title, type: s.type, blocks })}${lightened}`;
  const intent = form?.intent ?? anchorRelativeDates(s.intent, at);

  const recorded = (s.history ?? []).some((h) => h.at === at);
  const history = recorded
    ? s.history
    : withHistory(s.history, {
        at,
        by,
        text: s.rationale?.trim() || s.decision.summary,
        notes: replaced(s, { title, intent, blocks }),
      });

  // Le résumé de la décision est un texte enregistré comme un autre : il se
  // relit n'importe quel jour.
  const decision = { ...s.decision, summary: anchorRelativeDates(s.decision.summary, at) };
  const presented: PlannedSession = {
    ...s, title, intent, blocks, decision, ...(history?.length ? { history } : {}),
  };
  return { ...presented, rationale: decidedWhy(presented, ctx.model) };
}

/**
 * Le « pourquoi » d'une séance qui n'a qu'une raison d'être là et, à part, ce
 * que sa construction a dû céder.
 *
 * Le planificateur accolait l'un à l'autre : « Séance clef le jeudi… » suivi de
 * trois phrases sur le dénivelé qu'il avait fallu rendre, 614 caractères sous
 * « pourquoi ». La raison reste ; le reste va à l'historique, daté.
 */
export function withConstruction(
  s: PlannedSession,
  reason: string | undefined,
  construction: readonly string[],
  at: string,
): PlannedSession {
  const text = construction.filter(Boolean).join(' ');
  const history = text ? withHistory(s.history, { at, by: 'planner', text }) : s.history;
  return {
    ...s,
    ...(reason ? { rationale: reason } : {}),
    ...(history?.length ? { history } : {}),
  };
}

export interface TerrainContext extends PresentationContext {
  /** Ce qui est avant ne se réécrit pas. */
  today: string;
  /** Séances de descente faites avant `today` : sans aucune, la première à venir le dit. */
  descentsDone: number;
}

/**
 * Pose sur le terrain de l'athlète les séances de terrain à venir, sans rien
 * reconstruire.
 *
 * Une descente que personne n'a décidée est posée sur sa montée (`layDescent`) :
 * tronçon, remontée à pied, consigne d'effort, et la durée qui suit. La première
 * descente à venir dit ce que ses courbatures toucheront. Une rando-course prend
 * la forme des règles du jour, qui nomment sa montée : décidée, par
 * `presentDecided` ; sinon par la même forme, quand elle ne change rien à son
 * contenu. Une séance décidée d'un autre type, passée ou réalisée est rendue
 * telle quelle — la même instance.
 *
 * C'est le chemin du planificateur comme de la relève : une séance se pose de
 * la même façon, qu'elle vienne d'être écrite ou qu'elle attende son jour.
 */
export function onTerrain(sessions: readonly PlannedSession[], ctx: TerrainContext): PlannedSession[] {
  const upcoming = (s: PlannedSession) => s.date >= ctx.today && s.status === 'planned';
  // La première descente à venir, faute d'aucune de faite : celle qui dit quoi
  // ménager. Une descente prévue compte dès qu'elle précède — celle d'après
  // n'est plus une première.
  const first = ctx.descentsDone > 0
    ? undefined
    : [...sessions]
        .filter((s) => upcoming(s) && s.type === 'downhill')
        .sort((a, b) => a.date.localeCompare(b.date))[0];

  return sessions.map((s) => {
    if (!upcoming(s)) return s;
    if (s.type === 'downhill') {
      // Une descente décidée l'est dans son contenu, durées comprises.
      if (s.decision) return s;
      const exposure = s === first ? firstDescentNote(s.date, sessions) : undefined;
      const laid = lib.layDescent(s, ctx.model, ctx.terrain, exposure);
      return laid ? { ...s, ...laid } : s;
    }
    if (s.type === 'long_trail') {
      if (s.decision) return presentDecided(s, ctx);
      const form = trailForm(s, ctx);
      return form ? { ...s, ...form } : s;
    }
    return s;
  });
}
