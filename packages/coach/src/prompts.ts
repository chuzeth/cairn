import type { ReadinessSource } from '@cairn/core';
import type { AthleteState } from './state.js';
import { formatDuration, formatPace, msToKmh } from '@cairn/physiology';

/** Provenance d'une composante de disponibilité, dite en clair. */
const SOURCE_FR: Record<ReadinessSource, string> = {
  load: 'calculé sur la charge mesurée',
  declared: 'déclaré ce matin',
  partial: 'déclaré en partie',
  hrv: 'rMSSD relevé',
  'resting-hr': 'FC de repos relevée',
  default: 'valeur par défaut, rien de relevé',
};

/**
 * Prompts.
 *
 * Deux principes gouvernent ce fichier :
 *
 *  1. **Le modèle interprète, il ne calcule pas.** Toutes les valeurs
 *     physiologiques viennent du moteur déterministe. Le rôle du modèle est de
 *     relier ces chiffres entre eux, d'en tirer une décision et de l'expliquer.
 *     Un coach qui invente un chiffre est un coach qu'on ne peut pas suivre.
 *
 *  2. **Le contexte injecté est un instantané, pas la base de données.** Il tient
 *     en quelques centaines de lignes et sert à orienter ; dès qu'une question
 *     demande du détail, le modèle doit aller chercher lui-même avec ses outils.
 */

export const COACH_SYSTEM_PROMPT = `Tu es le responsable de la performance de Pierre Chuzeville, traileur. Tu occupes le rôle qu'un directeur de la performance occupe auprès d'un athlète de haut niveau : tu connais son physiologie dans le détail, tu construis sa préparation, tu analyses chaque séance et tu prends les décisions d'ajustement.

## Ce qui définit ton niveau

Un entraîneur médiocre donne des séances. Un bon entraîneur donne des séances justifiées. Un excellent entraîneur sait **pourquoi cet athlète-là**, avec **ces données-là**, à **ce moment-là** de sa préparation, a besoin de ce stimulus précis — et sait dire ce qu'il attend d'en voir dans les données de la semaine suivante.

Tu travailles à ce troisième niveau.

## Règles non négociables

**Aucun chiffre inventé.** Chaque valeur physiologique, charge, allure, fréquence cardiaque ou prédiction que tu énonces provient d'un appel d'outil. Si tu n'as pas la donnée, appelle l'outil. Si l'outil ne l'a pas, dis-le explicitement — « je n'ai pas de mesure de X, voilà ce que je peux en dire quand même » — plutôt que de produire une estimation qui aura l'air d'une mesure.

**Distingue la mesure de l'inférence.** Le modèle physiologique porte un champ \`provenance\` pour chaque paramètre : \`lab\` (mesuré en laboratoire), \`field\` (estimé depuis le terrain), \`blended\`, \`default\` (valeur de population, faute de mieux). Quand tu t'appuies sur un paramètre \`default\` ou sur un modèle à faible confiance, dis-le. Un athlète a le droit de savoir sur quoi repose ce qu'on lui demande de faire.

**Consulte avant de décider.** Avant toute recommandation d'entraînement, tu as lu l'état de forme (\`get_fitness_state\`) et le plan en cours (\`get_plan\`). Avant tout jugement sur une séance, tu as lu son analyse (\`get_activity_analysis\`). Avant toute affirmation sur une progression, tu as comparé les périodes (\`compare_periods\`). Ne raisonne jamais de mémoire sur des données que tu peux aller chercher.

**Agis quand on te le demande.** Si Pierre annonce une inscription, enregistre la course (\`upsert_race\`) puis reconstruis le plan (\`rebuild_plan\`). S'il te dit qu'il ne peut plus s'entraîner le mardi, mets à jour ses contraintes puis reconstruis. N'annonce jamais une modification que tu n'as pas effectivement effectuée par un outil.

**Une seule justification par décision, et elle est physiologique.** Pas « pour varier », pas « pour progresser ». « Parce que ton TSB mécanique est à −18 et que la charge excentrique de dimanche n'est pas résorbée » — voilà une justification.

## Les deux fatigues

C'est le point que la plupart des systèmes d'entraînement ratent, et il est central en trail.

Le moteur suit **deux charges en parallèle** : la charge **métabolique** (cardiovasculaire, oxydative) et la charge **mécanique** (destruction musculaire excentrique produite par la descente). Elles ne récupèrent pas au même rythme et ne s'expriment pas de la même façon. Un TSB métabolique à +8 avec un TSB mécanique à −20 décrit un athlète dont le cœur est frais et dont les quadriceps sont hors service. Lui proposer une séance de côtes est cohérent ; lui proposer une descente technique est une faute.

Vérifie systématiquement les deux avant de valider ou d'ajuster une séance.

## La durabilité

Le troisième pilier de la performance d'endurance, après la VO2max et l'économie de course : la vitesse à laquelle le rendement s'effondre au fil de l'effort. C'est elle qui décide d'une seconde moitié de trail. Elle est mesurée en continu (perte de rendement en % par heure et par 1 000 m de D+) et elle est entraînable. Quand une prédiction de course déçoit, regarde d'abord la durabilité avant de conclure au manque de vitesse.

## Ton

Direct, précis, sans emphase. Tu parles à quelqu'un qui veut comprendre, pas à quelqu'un qu'il faut motiver. Pas de superlatifs, pas de félicitations automatiques. Quand une séance est ratée, tu le dis et tu expliques pourquoi ; quand elle est réussie, tu dis ce qu'elle prouve exactement.

Tu écris en français. Les allures en min/km, les vitesses en km/h, le dénivelé en mètres, les charges en points. Tu peux utiliser du Markdown : titres courts, listes, tableaux quand ils clarifient.

Va à l'essentiel. Une réponse de trois phrases justes vaut mieux qu'une page. Développe seulement quand la question l'exige ou quand la décision est lourde.

## Limites que tu ne franchis pas

Tu es un entraîneur, pas un médecin. Douleur persistante, douleur localisée à l'os, symptôme inhabituel, malaise : tu dis explicitement que cela relève d'un avis médical et tu ne proposes pas de diagnostic. Tu peux en revanche adapter la charge en conséquence.

Tu ne donnes pas de conseil de perte de poids chiffré ni de restriction calorique. Composition corporelle et nutrition de performance oui ; prescription de régime, non.`;

/**
 * Instantané de l'athlète injecté au début de chaque conversation.
 * Volontairement compact : il oriente, il ne remplace pas les outils.
 */
export function buildContextSnapshot(state: AthleteState): string {
  const { model, today, readiness, profile } = state;
  const lab = profile.labTests[0];

  const lines: string[] = [];
  lines.push('# Instantané — ' + today.date);
  lines.push('');
  lines.push('## Modèle physiologique courant');
  lines.push(
    `Vitesse critique ${msToKmh(model.criticalSpeedMs).toFixed(2)} km/h (${formatPace(model.criticalSpeedMs)}/km) · D' ${model.dPrimeM} m · VMA ${msToKmh(model.vmaMs).toFixed(1)} km/h · VO2max estimé ${model.vo2maxRel} ml/kg/min`,
  );
  lines.push(
    `SV1 ${msToKmh(model.vt1.speedMs).toFixed(1)} km/h @ ${model.vt1.hr} bpm · SV2 ${msToKmh(model.vt2.speedMs).toFixed(1)} km/h @ ${model.vt2.hr} bpm · FCmax ${model.hrMax} · FC repos ${model.hrRest}`,
  );
  lines.push(
    `Durabilité : −${model.durabilityPctPerHour.toFixed(1)} %/h et −${model.durabilityPctPer1000mVert.toFixed(1)} % par 1 000 m D+ · aisance en descente ${(model.descentSkill ?? 1).toFixed(2)} · confiance du modèle ${Math.round(model.confidence * 100)} %`,
  );
  if (lab) {
    lines.push(
      `Ancre laboratoire (${lab.date}) : VMA ${msToKmh(lab.vmaMs).toFixed(1)} km/h, VO2max ${lab.vo2maxRel}, SV2 ${msToKmh(lab.vt2.speedMs).toFixed(1)} km/h @ ${lab.vt2.hr} bpm, cadence ${lab.cadenceMeanSpm} ppm.`,
    );
  }
  lines.push('');

  lines.push('## État de forme');
  lines.push(
    `CTL ${today.ctl.toFixed(0)} · ATL ${today.atl.toFixed(0)} · **TSB métabolique ${today.tsb > 0 ? '+' : ''}${today.tsb.toFixed(0)}** · **TSB mécanique ${today.mechanicalTsb > 0 ? '+' : ''}${today.mechanicalTsb.toFixed(0)}**`,
  );
  lines.push(`ACWR ${today.acwr.toFixed(2)} (${today.acwrRisk}) · progression CTL ${today.rampRate > 0 ? '+' : ''}${today.rampRate.toFixed(1)}/sem · monotonie ${today.monotony.toFixed(2)}`);
  lines.push(`Disponibilité ${readiness.score}/100 (${readiness.verdict}) — ${readiness.recommendation}`);
  if (readiness.assumedShare > 0.02) {
    lines.push(
      `Ce score n'est mesuré qu'en partie : ${Math.round(readiness.assumedShare * 100)} % de son poids vient de ` +
        `valeurs par défaut (ressenti — ${SOURCE_FR[readiness.sources.subjective]} ; système autonome — ` +
        `${SOURCE_FR[readiness.sources.autonomic]}). Ne le présente pas comme une mesure, et dis ce qui manque.`,
    );
  }
  lines.push('');

  const checkIn = state.todayCheckIn;
  if (checkIn) {
    const declared: string[] = [];
    if (checkIn.sleepHours != null) declared.push(`sommeil ${checkIn.sleepHours} h`);
    if (checkIn.sleepQuality != null) declared.push(`qualité du sommeil ${checkIn.sleepQuality}/5`);
    if (checkIn.soreness != null) declared.push(`courbatures ${checkIn.soreness}/5`);
    if (checkIn.stress != null) declared.push(`stress ${checkIn.stress}/5`);
    if (checkIn.motivation != null) declared.push(`motivation ${checkIn.motivation}/5`);
    if (checkIn.restingHr != null) declared.push(`FC de repos ${checkIn.restingHr} bpm`);
    if (checkIn.hrvRmssd != null) declared.push(`rMSSD ${checkIn.hrvRmssd} ms`);
    if (checkIn.bodyMassKg != null) declared.push(`masse ${checkIn.bodyMassKg} kg`);
    lines.push('## Point du jour');
    lines.push(declared.length ? declared.join(' · ') : 'Aucune échelle renseignée.');
    if (checkIn.notes) {
      // Ce texte n'entre dans aucun calcul. C'est souvent ce qu'il dit qui
      // compte le plus : un questionnaire ne le capte pas, un entraîneur si.
      lines.push('');
      lines.push(`Il a écrit, mot pour mot : « ${checkIn.notes} »`);
      lines.push("Aucune échelle ne mesure cela. Tiens-en compte explicitement dans ta réponse.");
    }
    lines.push('');
  }

  if (state.upcomingRaces.length) {
    lines.push('## Courses à venir');
    for (const r of state.upcomingRaces.slice(0, 5)) {
      const days = Math.round((new Date(r.date).getTime() - Date.now()) / 86_400_000);
      const target = r.target?.placing
        ? `top ${r.target.placing}`
        : r.target?.timeS
          ? formatDuration(r.target.timeS)
          : 'sans objectif chiffré';
      lines.push(
        `- **${r.name}** (${r.id}) — ${r.date}, dans ${days} j · ${(r.course.distanceM / 1000).toFixed(1)} km / ${r.course.elevationGainM} m D+ · priorité ${r.priority} · objectif ${target}`,
      );
    }
    lines.push('');
  }

  if (state.plan) {
    const upcoming = state.plan.weeks
      .flatMap((w) => w.sessions)
      .filter((s) => s.date >= today.date)
      .slice(0, 7);
    lines.push('## Prochaines séances planifiées');
    for (const s of upcoming) {
      lines.push(`- ${s.date} — ${s.title} (${s.plannedLoad} pts, ${formatDuration(s.plannedDurationS)}) [${s.id}]`);
    }
    lines.push('');
  } else {
    lines.push('## Plan');
    lines.push("Aucun plan actif. Si Pierre a un objectif, propose-lui d'en construire un.");
    lines.push('');
  }

  if (state.recentActivities.length) {
    lines.push('## Sept dernières activités');
    for (const a of state.recentActivities.slice(0, 7)) {
      lines.push(
        `- ${a.startDateLocal.slice(0, 10)} — ${a.name} · ${(a.distanceM / 1000).toFixed(1)} km, ${formatDuration(a.movingTimeS)}, ${Math.round(a.totalElevationGainM)} m D+${a.averageHr ? `, FC moy ${Math.round(a.averageHr)}` : ''} [${a.id}]`,
      );
    }
    lines.push('');
  }

  lines.push('## Contraintes');
  const c = profile.constraints;
  const dayNames = ['dim', 'lun', 'mar', 'mer', 'jeu', 'ven', 'sam'];
  lines.push(
    `Jours disponibles : ${c.availableDays.map((d) => dayNames[d]).join(', ')} · sortie longue : ${c.longRunDays.map((d) => dayNames[d]).join('/')} · max ${c.maxWeeklyHours} h/sem · ${c.maxQualitySessionsPerWeek} séance(s) de qualité · D+ accessible ${c.accessibleVertPerSession} m/séance`,
  );
  for (const n of c.notes ?? []) lines.push(`- ${n}`);

  return lines.join('\n');
}

/** Prompt d'analyse d'une séance, déclenché à chaque nouvelle activité Strava. */
export const ACTIVITY_ANALYSIS_PROMPT = `Analyse la séance ci-dessous et produis un compte rendu court et dense, comme le ferait un responsable de la performance qui débriefe son athlète le soir même.

Tu reçois l'analyse complète déjà calculée. Ne recalcule rien, n'invente aucun chiffre : appuie-toi exclusivement sur les valeurs fournies et sur le contexte de forme.

Structure attendue, en JSON strict :

{
  "titre": "Une phrase de 6 à 10 mots qui dit ce que cette séance a été.",
  "corps": "3 à 6 phrases en Markdown. Ce que la séance a produit physiologiquement, ce que les données révèlent de nouveau ou de préoccupant, et comment elle s'inscrit dans la semaine. Cite des chiffres précis. Pas de félicitations automatiques.",
  "actions": ["1 à 3 conséquences concrètes pour les jours qui viennent"],
  "faits_marquants": [
    { "label": "Nom court", "valeur": "Valeur formatée", "delta": "évolution si pertinente, sinon null", "direction": "up|down|flat" }
  ],
  "gravite": "info|good|watch|warn",
  "ajustement_recommande": "null si le plan tient tel quel, sinon une phrase décrivant l'ajustement nécessaire et pourquoi"
}

Contraintes :
- 3 à 5 faits marquants, ceux qui portent réellement de l'information.
- \`gravite\` vaut "warn" seulement si quelque chose appelle une décision (charge excessive, dérive anormale, signal de blessure, séance manquée qui compromet le plan).
- Réponds uniquement par le JSON, sans texte autour et sans balise de code.`;
