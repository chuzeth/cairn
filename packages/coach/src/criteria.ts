import type { AthleteAnswer, PlannedSession } from '@cairn/core';
import { classifySpike, SPIKE_HAZARD } from '@cairn/physiology';
import { repriseRace } from './compensation.js';
import { allowedLevel, raceGate, runSignals, PAIN_HOLD } from './reprise.js';
import { describeSpike, planSpikes } from './spikes.js';
import type { AthleteState } from './state.js';

/**
 * Ce qui doit être vrai pour courir la SaintéSprint, et où chaque point en est.
 *
 * Un entraîneur rassure avec des preuves : « tu as passé telle séance, tenu tant
 * de semaines, fait la sortie longue ». Une phrase qui dit « c'est bon » sans
 * elles ne vaut rien — moins encore venant d'un modèle de langage, dont on sait
 * qu'il va dans le sens de qui lui parle. Chaque critère dit donc son état et
 * la donnée qui le fonde ; ce qui n'a pas été dit reste ouvert, jamais réputé
 * acquis. Le dernier point n'est pas un critère : c'est le prix du dossard, dit
 * en chiffres.
 */

export type CriterionStatus = 'met' | 'open' | 'failed' | 'info';

export interface Criterion {
  key: 'clearance' | 'ladder' | 'long' | 'pain' | 'spike';
  label: string;
  status: CriterionStatus;
  evidence: string;
}

export interface RaceCriteria {
  raceId: string;
  raceDate: string;
  raceTitle: string;
  /** Le jour où le dossard se décide. */
  gateDate: string;
  /** Vrai : le critère a déjà été appliqué, et ce qui est écrit le reflète. */
  decided: boolean;
  /** Ce qui est couru le 28 si le critère n'est pas tenu. */
  fallbackTitle: string;
  criteria: Criterion[];
}

const GATE_DAYS = 6;
const dayMs = 86_400_000;
const shift = (date: string, days: number) => new Date(Date.parse(`${date}T12:00:00Z`) + days * dayMs).toISOString().slice(0, 10);
const dm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;
const latest = (answers: readonly AthleteAnswer[], q: AthleteAnswer['question'], subject?: string) =>
  answers
    .filter((a) => a.question === q && (subject == null || a.subject === subject))
    .sort((a, b) => b.answeredAt.localeCompare(a.answeredAt))[0];

export function raceCriteria(state: AthleteState, sessions: readonly PlannedSession[]): RaceCriteria | null {
  const today = state.today.date;
  const reprise = sessions.filter((s) => s.program?.name === 'reprise');
  const race = reprise.find((s) => s.program!.plannedKind === 'race' && s.status !== 'cancelled' && s.status !== 'withdrawn');
  if (!race || race.date < today) return null;
  const ceiling = Math.round(state.zones.find((z) => z.key === 'Z2')?.hrMax ?? 155);
  const runs = runSignals(reprise, state.recentActivities, state.answers, today);
  const done = runs.filter((r) => r.done);
  const gateDate = shift(race.date, -GATE_DAYS);
  const criteria: Criterion[] = [];

  // L'accord du médecin.
  const clearance = latest(state.answers, 'clearance', 'reprise');
  const firstRun = reprise
    .filter((s) => s.program!.plannedKind !== 'race' && s.program!.plannedKind !== 'cross')
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  const asksFrom = firstRun ? shift(firstRun.date, -3) : undefined;
  criteria.push({
    key: 'clearance',
    label: 'L\'accord du médecin pour recourir',
    status: clearance?.value.choice === 'yes' ? 'met' : clearance?.value.choice === 'no' ? 'failed' : 'open',
    evidence: clearance?.value.choice === 'yes'
      ? `oui, dit le ${dm(clearance.answeredAt.slice(0, 10))}`
      : clearance
        ? `${clearance.value.choice === 'no' ? 'non' : 'pas encore'}, dit le ${dm(clearance.answeredAt.slice(0, 10))}`
        : asksFrom && asksFrom > today
          ? `Cairn te le demandera à partir du ${dm(asksFrom)}, avant la course du ${dm(firstRun!.date)}`
          : 'pas encore dit',
  });

  // Les marches franchies : faites, et sans douleur au-dessus du seuil qui retient.
  const sore = (r: (typeof runs)[number]) => Math.max(r.painDuring ?? 0, r.painMorning ?? 0) > PAIN_HOLD;
  const cleared = done.filter((r) => !sore(r) && r.kind !== 'cross');
  const top = cleared.reduce((m, r) => Math.max(m, r.level), 0);
  const silent = done.filter((r) => r.painDuring == null && r.painMorning == null);
  const nextRun = reprise
    .filter((s) => s.date >= today && (s.status === 'planned' || s.status === 'moved') && s.program!.plannedKind !== 'race' && s.program!.plannedKind !== 'cross')
    .sort((a, b) => a.date.localeCompare(b.date))[0];
  criteria.push({
    key: 'ladder',
    label: 'Les cinq marches de course, une à une',
    status: top >= 5 ? 'met' : 'open',
    evidence:
      (top > 0 ? `marche ${top} franchie` : 'aucune marche franchie encore') +
      (nextRun ? ` ; la prochaine course, le ${dm(nextRun.date)}, est à la marche ${nextRun.program!.level}` : '') +
      (silent.length > 0 ? ` ; la douleur n'a pas été dite pour ${silent.map((r) => `le ${dm(r.date)}`).join(', ')}` : ''),
  });

  // Le critère du dossard : la sortie longue.
  const gate = raceGate(runs, state.answers, ceiling);
  const long = reprise.find((s) => s.program!.planned >= 5 && s.program!.plannedKind === 'long');
  criteria.push({
    key: 'long',
    label: 'La sortie longue de 1 h 15, sans douleur au-dessus de 2',
    status: gate.met ? 'met' : today > gateDate ? 'failed' : 'open',
    evidence: gate.met ? gate.reason : long ? `prévue le ${dm(long.date)}` : gate.reason,
  });

  // Aucun arrêt pour douleur en cours.
  const verdict = allowedLevel(runs, state.answers, ceiling);
  criteria.push({
    key: 'pain',
    label: 'Aucune douleur qui arrête la course',
    status: verdict.step === 'stop' ? 'failed' : done.length === 0 ? 'open' : 'met',
    evidence: verdict.step === 'stop'
      ? verdict.reason
      : done.length === 0
        ? 'rien à juger avant la première course'
        : done.some(sore)
          ? `une douleur au-dessus de 2 le ${done.filter(sore).map((r) => dm(r.date)).join(', ')}, retombée depuis`
          : 'aucune au-dessus de 2 sur les courses faites',
  });

  // Le prix du dossard, en chiffres : la course contre la plus longue sortie qui la précède.
  const spike = planSpikes(state.model, sessions, state.recentActivities, today).find((v) => v.id === race.id);
  const fallback = repriseRace(state.model, true);
  if (spike && spike.cls !== 'no_reference' && spike.referenceM) {
    const alt = classifySpike(fallback.plannedDistanceM ?? 0, { date: spike.referenceDate!, distanceM: spike.referenceM });
    criteria.push({
      key: 'spike',
      label: 'Ce que coûte le dossard',
      status: 'info',
      evidence:
        `${(spike.distanceM / 1000).toFixed(1).replace('.', ',')} km : ${describeSpike(spike)}. ` +
        (spike.cls === 'none'
          ? 'Sous +10 % : pas de pic.'
          : `Au-delà de ${spike.cls === 'large' ? '+100 %' : spike.cls === 'moderate' ? '+30 %' : '+10 %'}, le risque de blessure ` +
            `de surmenage est multiplié par ${SPIKE_HAZARD[spike.cls].toString().replace('.', ',')} (BJSM 2025, étude ` +
            `d'observation). La ${fallback.title.split(',')[0]} (${((fallback.plannedDistanceM ?? 0) / 1000).toFixed(0)} km) ` +
            `${alt.cls === 'none' || alt.cls === 'no_reference' ? "n'en serait pas un" : 'en serait un aussi'} : ` +
            `${alt.ratio != null ? `${alt.ratio >= 0 ? '+' : '−'}${Math.round(Math.abs(alt.ratio) * 100)} %` : '?'}.`),
    });
  }

  return {
    raceId: race.id,
    raceDate: race.date,
    raceTitle: race.title,
    gateDate,
    decided: today >= gateDate,
    fallbackTitle: fallback.title.split(' — ')[0]!,
    criteria,
  };
}
