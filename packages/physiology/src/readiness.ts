import type {
  AbsenceKind, DailyCheckIn, PmcSeries, ReadinessScore, ReadinessSource,
} from '@cairn/core';
import { decimal } from '@cairn/core';
import { clamp, mean } from './units.js';

/**
 * Disponibilité à l'entraînement.
 *
 * Le TSB seul ment : il ignore le sommeil, le stress, les courbatures et l'état
 * du système nerveux autonome. Les modèles de charge sont des modèles de
 * *dose*, pas de *réponse*. Ce score combine les deux — objectif et subjectif —
 * et reste totalement explicable : chaque composante est visible, l'athlète
 * comprend pourquoi le coach lui propose de lever le pied.
 */

export interface ReadinessInput {
  date: string;
  pmc: PmcSeries;
  checkIns: DailyCheckIn[];
  /** Base de référence pour la HRV (moyenne des 30 derniers jours). */
  hrvBaseline?: number;
  /** Base de référence pour la FC de repos. */
  restingHrBaseline?: number;
  /** Ce que la journée tient. Absent : rien n'en est supposé. */
  day?: ReadinessDay;
}

/**
 * Ce que la journée tient, tel que l'appelant le sait.
 *
 * Le score se calcule sur la charge et le ressenti ; ce qu'il faut en faire
 * dépend de ce que le jour demande, et ce paquet n'a aucun moyen de le savoir.
 * Il l'a pourtant supposé : ses trois recommandations parlaient de « la séance
 * prévue » les jours où il n'y en avait aucune — le 12/09, en pleine coupure
 * déclarée, l'écran du matin titrait « Rien aujourd'hui » et conseillait juste
 * dessous de garder une séance qui n'existait pas.
 *
 * La situation arrive donc en entrée, comme une donnée. Elle n'est ni devinée
 * ici, ni allée chercher : ce paquet reste pur, et c'est ce qui le rend
 * testable exhaustivement.
 */
export interface ReadinessDay {
  /**
   * Ce que le plan tient pour ce jour : une séance à faire, une déjà faite, un
   * repos prescrit, ou rien du tout.
   */
  session: 'work' | 'done' | 'rest' | 'none';
  /** Nature de l'absence déclarée qui recouvre le jour, s'il y en a une. */
  absence?: AbsenceKind;
  /**
   * Jours consécutifs sans impact avant ce jour — zéro si l'athlète a couru
   * hier. Au-delà de `IMPACT_GAP_DAYS`, la séance du jour est une reprise.
   */
  daysWithoutImpact?: number;
}

/**
 * Seuil au-delà duquel une séance n'est plus une séance mais une reprise, en
 * jours consécutifs sans impact.
 *
 * Une semaine sans choc au sol ne coûte presque rien à la filière
 * cardiovasculaire, et laisse le score au plus haut : la charge aiguë s'efface,
 * la fraîcheur monte, le verdict passe au vert. Ce qu'elle coûte est ailleurs —
 * la tolérance du tendon et de l'os à l'impact — et rien dans ce score ne le
 * mesure. C'est exactement la configuration où un feu vert est le plus
 * trompeur, donc celle où la recommandation doit dire autre chose que lui.
 */
export const IMPACT_GAP_DAYS = 7;

const pointAt = <T extends { date: string }>(series: readonly T[], date: string): T | undefined =>
  series.find((p) => p.date === date) ?? series[series.length - 1];

/**
 * Poids nominaux des quatre composantes.
 *
 * Ils ne s'appliquent qu'à ce qui a une source. Une composante muette est
 * retirée du calcul et son poids se répartit sur les autres au prorata :
 * réserver un cinquième du score à un signal absent revient à diluer les
 * signaux présents d'autant.
 */
const WEIGHT = { tsbMetabolic: 0.26, tsbMechanical: 0.22, subjective: 0.32, autonomic: 0.2 } as const;
type Component = keyof typeof WEIGHT;
const COMPONENTS = Object.keys(WEIGHT) as Component[];

/**
 * Poids des six réponses dans la composante subjective — ils somment à 1.
 *
 * L'échelle de Hooper suit fatigue, sommeil, courbatures, stress et humeur.
 * La fatigue perçue y est l'item qui répond le plus vite à la charge : elle
 * pèse le plus lourd. La même règle qu'au-dessus s'applique en dessous — une
 * question sans réponse ne pèse pas.
 */
const SUBJECTIVE_WEIGHT = {
  fatigue: 0.25,
  sleepHours: 0.18,
  sleepQuality: 0.15,
  soreness: 0.18,
  stress: 0.12,
  motivation: 0.12,
} as const;
type Item = keyof typeof SUBJECTIVE_WEIGHT;
const ITEMS = Object.keys(SUBJECTIVE_WEIGHT) as Item[];

/** Valeur retenue quand *rien* n'est relevé : ni bonne, ni mauvaise, ni mesurée. */
const NEUTRAL = 60;

/**
 * Chaque réponse ramenée sur 0–100, dans le sens « plus haut, mieux ».
 *
 * C'est la seule échelle absolue du fichier, et elle ne sert qu'à défaut de
 * ligne de base personnelle.
 */
const NORMALIZE: Record<Item, (c: DailyCheckIn) => number | null> = {
  fatigue: (c) => (c.fatigue != null ? ((5 - c.fatigue) / 4) * 100 : null),
  sleepHours: (c) => (c.sleepHours != null ? clamp((c.sleepHours - 5) / 3, 0, 1) * 100 : null),
  sleepQuality: (c) => (c.sleepQuality != null ? ((c.sleepQuality - 1) / 4) * 100 : null),
  soreness: (c) => (c.soreness != null ? ((5 - c.soreness) / 4) * 100 : null),
  stress: (c) => (c.stress != null ? ((5 - c.stress) / 4) * 100 : null),
  motivation: (c) => (c.motivation != null ? ((c.motivation - 1) / 4) * 100 : null),
};

/**
 * Ligne de base du ressenti.
 *
 * Le rMSSD se lit contre sa propre moyenne ; une échelle 1–5 doit se lire
 * pareil. Six heures et demie de sommeil ne sont un déficit que pour qui dort
 * huit heures. Sous BASELINE_MIN déclarations d'une question, sa moyenne n'est
 * que du bruit et l'échelle absolue reste seule ; à BASELINE_FULL elle la
 * remplace entièrement ; entre les deux les deux lectures se mélangent, pour
 * qu'aucune journée ne fasse basculer le score d'un coup.
 */
const BASELINE_WINDOW = 30;
const BASELINE_MIN = 7;
const BASELINE_FULL = 28;
/** Un cran d'écart (25 points) sous sa propre norme vaut 50 → 20 : un signal, pas un frisson. */
const BASELINE_GAIN = 1.2;

export function computeReadiness(input: ReadinessInput): ReadinessScore {
  const { date, pmc, checkIns } = input;
  const today = checkIns.find((c) => c.date === date);
  // Strictement avant aujourd'hui : une moyenne qui contient le jour qu'elle
  // sert à juger atténue l'écart qu'on cherche à voir.
  const history = checkIns
    .filter((c) => c.date < date)
    .sort((a, b) => a.date.localeCompare(b.date))
    .slice(-BASELINE_WINDOW);

  const metabolic = pointAt(pmc.metabolic, date);
  const mechanical = pointAt(pmc.mechanical, date);
  const acwr = pointAt(pmc.acwr, date);

  // ── Composante métabolique ────────────────────────────────────────────────
  // Un TSB très négatif pèse, mais un TSB très positif n'est pas un bonus
  // infini : on plafonne, un athlète trop frais n'est pas mieux préparé.
  const tsbM = metabolic?.tsb ?? 0;
  const tsbMetabolic = clamp(50 + tsbM * 1.4, 0, 100);

  // ── Composante mécanique ──────────────────────────────────────────────────
  // La fatigue musculaire pèse plus lourd sur la disponibilité réelle en trail :
  // on peut avoir le cœur frais et des quadriceps hors service.
  const tsbMech = mechanical?.tsb ?? 0;
  const tsbMechanical = clamp(50 + tsbMech * 2.0, 0, 100);

  // ── Composante subjective ─────────────────────────────────────────────────
  // Chaque réponse est lue contre la norme de l'athlète dès qu'il en a une, et
  // les questions restées vides ne pèsent pas : leur poids revient aux autres.
  let subjectiveSum = 0;
  let subjectiveWeight = 0;
  let answered = 0;
  let baselined = 0;
  for (const item of ITEMS) {
    const absolute = today ? NORMALIZE[item](today) : null;
    if (absolute == null) continue;
    answered++;

    const past = history.map(NORMALIZE[item]).filter((v): v is number => v != null);
    const trust = clamp((past.length - BASELINE_MIN) / (BASELINE_FULL - BASELINE_MIN), 0, 1);
    let value = absolute;
    if (trust > 0) {
      const norm = mean(past) ?? absolute;
      const relative = clamp(50 + (absolute - norm) * BASELINE_GAIN, 0, 100);
      value = absolute + (relative - absolute) * trust;
      baselined++;
    }

    subjectiveSum += value * SUBJECTIVE_WEIGHT[item];
    subjectiveWeight += SUBJECTIVE_WEIGHT[item];
  }
  const subjective = subjectiveWeight > 0 ? subjectiveSum / subjectiveWeight : NEUTRAL;

  // ── Composante autonome (HRV / FC de repos) ───────────────────────────────
  let autonomic = NEUTRAL;
  let autonomicSource: ReadinessSource = 'default';
  const hrvBase =
    input.hrvBaseline ??
    mean(checkIns.slice(-30).map((c) => c.hrvRmssd ?? null)) ??
    undefined;
  const rhrBase =
    input.restingHrBaseline ??
    mean(checkIns.slice(-30).map((c) => c.restingHr ?? null)) ??
    undefined;

  if (today?.hrvRmssd != null && hrvBase != null && hrvBase > 0) {
    // Un rMSSD de 10 % sous sa base est un signal fort de fatigue autonome.
    const ratio = today.hrvRmssd / hrvBase;
    autonomic = clamp(50 + (ratio - 1) * 320, 0, 100);
    autonomicSource = 'hrv';
  } else if (today?.restingHr != null && rhrBase != null && rhrBase > 0) {
    const delta = today.restingHr - rhrBase;
    autonomic = clamp(65 - delta * 7, 0, 100);
    autonomicSource = 'resting-hr';
  }

  // ── Pénalité de pic de charge ─────────────────────────────────────────────
  const acwrValue = acwr?.value ?? 0;
  const acwrPenalty =
    acwrValue > 1.5 ? -18 : acwrValue > 1.3 ? -8 : acwrValue > 0 && acwrValue < 0.7 ? -4 : 0;

  // ── Poids effectifs ───────────────────────────────────────────────────────
  // Ce que personne n'a mesuré ne vote pas. Faute de la moindre source, on garde
  // les poids nominaux sur des valeurs neutres — et on l'avoue par assumedShare.
  const value: Record<Component, number> = { tsbMetabolic, tsbMechanical, subjective, autonomic };
  const sourced: Record<Component, boolean> = {
    tsbMetabolic: metabolic != null,
    tsbMechanical: mechanical != null,
    subjective: answered > 0,
    autonomic: autonomicSource !== 'default',
  };
  const sourcedWeight = COMPONENTS.reduce((s, k) => s + (sourced[k] ? WEIGHT[k] : 0), 0);
  const weights = roundToPercent(
    COMPONENTS.reduce((acc, k) => {
      acc[k] = sourcedWeight > 0 ? (sourced[k] ? WEIGHT[k] / sourcedWeight : 0) : WEIGHT[k];
      return acc;
    }, {} as Record<Component, number>),
  );

  const score = clamp(
    COMPONENTS.reduce((s, k) => s + value[k] * weights[k], 0) + acwrPenalty,
    0,
    100,
  );

  // ── Provenance ────────────────────────────────────────────────────────────
  // Un score dont la moitié du poids sort d'une valeur par défaut ne dit pas la
  // même chose qu'un score mesuré. On expose de quoi le dire.
  const sources: ReadinessScore['sources'] = {
    tsbMetabolic: metabolic ? 'load' : 'default',
    tsbMechanical: mechanical ? 'load' : 'default',
    subjective:
      answered === 0 ? 'default'
      : answered < ITEMS.length ? 'partial'
      : baselined === answered ? 'baseline'
      : 'declared',
    autonomic: autonomicSource,
  };
  const assumedShare = sourcedWeight > 0 ? 0 : 1;

  const verdict: ReadinessScore['verdict'] = score >= 68 ? 'green' : score >= 45 ? 'amber' : 'red';

  return {
    date,
    score: Math.round(score),
    components: {
      tsbMetabolic: Math.round(tsbMetabolic),
      tsbMechanical: Math.round(tsbMechanical),
      subjective: Math.round(subjective),
      autonomic: Math.round(autonomic),
      acwrPenalty,
    },
    sources,
    weights,
    assumedShare,
    verdict,
    recommendation: recommend(
      verdict,
      {
        tsbM,
        tsbMech,
        acwr: acwrValue,
        fatigue: today?.fatigue,
        soreness: today?.soreness,
        sleep: today?.sleepHours,
      },
      input.day,
    ),
  };
}

/**
 * Arrondit des poids au pour cent en gardant leur somme à 1 (plus fort reste).
 *
 * Le score est calculé avec ces poids-là, pas avec les poids exacts : ce qui est
 * affiché est ce qui a servi, et quatre pourcentages affichés font bien 100.
 */
function roundToPercent(w: Record<Component, number>): Record<Component, number> {
  const parts = COMPONENTS.map((key) => {
    const exact = w[key] * 100;
    return { key, pct: Math.floor(exact), rest: exact - Math.floor(exact) };
  });
  let left =
    Math.round(COMPONENTS.reduce((s, k) => s + w[k] * 100, 0)) -
    parts.reduce((s, p) => s + p.pct, 0);
  for (const p of [...parts].sort((a, b) => b.rest - a.rest)) {
    if (left-- <= 0) break;
    p.pct++;
  }
  return parts.reduce((acc, p) => {
    acc[p.key] = p.pct / 100;
    return acc;
  }, {} as Record<Component, number>);
}

/**
 * Le conseil du jour : ce que le verdict dit du corps, appliqué à ce que la
 * journée demande.
 *
 * Les deux moitiés sont indépendantes et doivent le rester. Le verdict vient
 * du score — charge, ressenti, système autonome. La situation vient de
 * l'appelant. Un jour sans séance, un jour couvert par une absence déclarée et
 * un jour de reprise après onze jours sans impact n'appellent pas le même
 * conseil, même à score identique : c'est la phrase qui change, pas le score.
 *
 * Sans situation, on ne suppose aucune séance : le conseil porte alors sur la
 * charge du jour, quelle qu'elle soit. Une phrase vague est un moindre mal
 * qu'une phrase fausse.
 */
function recommend(
  verdict: ReadinessScore['verdict'],
  ctx: {
    tsbM: number;
    tsbMech: number;
    acwr: number;
    fatigue?: number;
    soreness?: number;
    sleep?: number;
  },
  day?: ReadinessDay,
): string {
  const reasons: string[] = [];
  if (ctx.fatigue != null && ctx.fatigue >= 4) reasons.push('fatigue perçue élevée');
  if (ctx.tsbMech < -12) reasons.push('fatigue musculaire élevée (charge excentrique récente)');
  if (ctx.tsbM < -25) reasons.push('charge métabolique très supérieure à la récupération');
  if (ctx.acwr > 1.5) {
    reasons.push(`pic de charge marqué : ces 7 jours pèsent ${decimal(ctx.acwr, 2)} fois tes 4 dernières semaines`);
  }
  if (ctx.soreness != null && ctx.soreness >= 4) reasons.push('courbatures importantes déclarées');
  if (ctx.sleep != null && ctx.sleep < 6) reasons.push(`sommeil court (${ctx.sleep} h)`);

  const because = reasons.length ? ` — ${reasons.join(', ')}` : '';
  const say = (green: string, amber: string, red: string) =>
    verdict === 'green' ? green : verdict === 'amber' ? amber : red;

  // Une absence déclarée passe avant tout le reste : la journée ne demande
  // rien, et il n'y a donc rien à alléger ni à décaler.
  if (day?.absence) {
    // Maladie et blessure sont les deux cas où ce score se lit de travers : il
    // ne connaît que la charge et les réponses au point du jour. Le dire est la
    // même exigence que la provenance d'un paramètre — l'athlète a le droit de
    // savoir ce que le chiffre ne regarde pas.
    const blind =
      day.absence === 'illness' || day.absence === 'injury'
        ? ' Ce score ne lit ni ta guérison ni ta douleur : seulement la charge et ce que tu déclares.'
        : '';
    return say(
      `Rien à faire aujourd'hui : une absence déclarée couvre la journée. Le score est haut parce ` +
        `que tu ne t'entraînes pas — c'est la fraîcheur de l'arrêt, pas celle de la forme.${blind}`,
      `Rien à faire aujourd'hui : une absence déclarée couvre la journée${because}. La fraîcheur que ` +
        `tu lis vient de l'arrêt, pas de la forme : ta forme de fond baisse pendant ce temps, ` +
        `et c'était prévu.${blind}`,
      `Rien à faire aujourd'hui : une absence déclarée couvre la journée. Le score reste bas malgré ` +
        `l'arrêt${because} — c'est ce qu'il faut dire au coach avant de reprendre à la date prévue.${blind}`,
    );
  }

  switch (day?.session) {
    case 'done':
      return say(
        `Feu vert${because}, et la séance du jour est déjà faite. Ce score parle de demain, ` +
          `pas d'aujourd'hui : il n'y a rien à y ajouter.`,
        `Vigilance${because}. La séance du jour est faite : ce score se lit maintenant comme un ` +
          `état de récupération, pas comme une consigne.`,
        `Signal rouge${because}. La séance du jour est faite ; c'est la suivante qui se décide ` +
          `là-dessus — la récupération n'a pas suivi la charge.`,
      );

    case 'rest':
      return say(
        `Feu vert${because}, et repos prescrit aujourd'hui : c'est lui qui transforme la charge ` +
          `des jours passés en forme. Rien à y ajouter.`,
        `Vigilance${because}. Repos prescrit aujourd'hui : la journée tombe bien, il n'y a rien ` +
          `à alléger.`,
        `Signal rouge${because}. Repos prescrit aujourd'hui, et rien à y ajouter — pas même ` +
          `trente minutes faciles.`,
      );

    case 'none':
      return say(
        `Feu vert${because}, mais rien n'est prévu aujourd'hui : aucune séance n'attend cette ` +
          `réserve. Si tu sors quand même, reste en endurance.`,
        `Vigilance${because}. Rien n'est prévu aujourd'hui : une sortie facile ne coûte rien, ` +
          `une séance de qualité improvisée, si.`,
        `Signal rouge${because}. Rien n'est prévu aujourd'hui, et c'est aussi bien : n'ajoute rien.`,
      );

    case 'work': {
      const gap = day?.daysWithoutImpact ?? 0;
      if (gap >= IMPACT_GAP_DAYS) {
        const off = `${gap} jours sans impact`;
        return say(
          `Feu vert${because} — mais c'est la première séance après ${off}. Le score est haut ` +
            `parce que tu as coupé, pas parce que tu es prêt : fais-la telle qu'elle est écrite, ` +
            `sans rien y ajouter.`,
          `Vigilance${because}. Première séance après ${off} : tiens-la sans la rallonger. Ce qui ` +
            `se reprend aujourd'hui est le choc au sol, pas le volume.`,
          `Signal rouge${because}, le jour d'une reprise après ${off}. Décale-la de 24 h plutôt ` +
            `que de la forcer : une reprise ratée coûte la semaine qui suit.`,
        );
      }
      return say(
        `Feu vert : la séance prévue peut être exécutée telle quelle${because}.`,
        `Vigilance${because}. Garde la séance mais réduis le volume de 20-30 %, ou décale la ` +
          `qualité de 24 h si les sensations ne viennent pas à l'échauffement.`,
        `Signal rouge${because}. Remplace la séance par de la récupération active ou du repos ` +
          `complet. Une séance forcée dans cet état coûte plus qu'elle ne rapporte.`,
      );
    }

    // Personne n'a dit ce que la journée tient : on ne l'invente pas.
    default:
      return say(
        `Feu vert : rien ne s'oppose à la charge du jour${because}.`,
        `Vigilance${because}. Réduis de 20-30 % le volume que tu prévoyais, ou décale la qualité ` +
          `de 24 h si les sensations ne viennent pas à l'échauffement.`,
        `Signal rouge${because}. Récupération active ou repos complet : une charge forcée dans ` +
          `cet état coûte plus qu'elle ne rapporte.`,
      );
  }
}
