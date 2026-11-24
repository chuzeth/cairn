/**
 * Plan Morzine 2027 — spécification séance par séance, du 30/11/2026 au 19/06/2027.
 *
 * Zones (FC, bpm) : R < 135 · Z1 135–148 · Z2 148–155 (≤ SV1) · Z3 155–163 ·
 * Z4a 163–168 · Z4b 168–172 (≈ SV2, vitesse critique) · Z5 ≥ 174 en fin de répétition.
 * Facile plafonné à 150 bpm tant que la reprise n'est pas consolidée.
 */

export type Block = Record<string, unknown>;
export interface Day { type: string; blocks: Block[]; why: string }
export type Week = { n: number; monday: string; phase: string; days: (Day | null)[] };

const min = (m: number) => Math.round(m * 60);
const gain = (vamMh: number, s: number) => Math.round((vamMh * s) / 3600);

// ── Blocs ───────────────────────────────────────────────────────────────────
const easy = (m: number, o: { dplus?: number; hr?: number; label?: string; notes?: string; trail?: boolean } = {}): Block => ({
  label: o.label ?? 'Footing', zone: 'Z2', durationS: min(m), hrRange: [0, o.hr ?? 150],
  ...(o.dplus ? { elevationGainM: o.dplus, elevationLossM: o.dplus } : {}),
  ...(o.trail ? { terrain: 'trail' } : {}),
  notes: o.notes ?? (o.dplus ? 'Le cœur sous ' + (o.hr ?? 150) + ', les côtes raides marchées.' : 'Le cœur sous ' + (o.hr ?? 150) + ', à plat.'),
});
const rec = (m: number): Block => ({ label: 'Récupération', zone: 'Z1', durationS: min(m), hrRange: [0, 135], notes: 'Très facile, à plat : le sang circule, rien de plus.' });
const wu = (m: number, notes = 'Progressif, le cœur sous 150.'): Block => ({ label: 'Échauffement', zone: 'Z2', durationS: min(m), hrRange: [0, 150], notes });
const cd = (m: number): Block => ({ label: 'Retour au calme', zone: 'Z1', durationS: min(m), hrRange: [0, 141] });
const strides = (n: number, s = 20, hill = false): Block => ({
  label: hill ? 'Lignes droites en côte' : 'Lignes droites', zone: 'Z4', durationS: s, repeat: n,
  effort: hill ? 'Vite et relâché sur 6 à 10 %, 8 sur 10, foulée haute — pas un sprint' : 'Vite et relâché, 90 % de ta vitesse, sans forcer',
  ...(hill ? { elevationGainM: 5 } : {}),
  recovery: { durationS: 75, zone: 'Z1', active: true, ...(hill ? { elevationLossM: 5 } : {}) },
  notes: hill ? "En fin de footing, sur la Sarra ou Fourvière. Redescente en marchant : c'est la récupération." : 'Sur du plat et du sec, en fin de footing.',
});
const sprints = (n: number): Block => ({
  label: 'Sprints en côte', zone: 'Z5', durationS: 10, repeat: n,
  effort: 'À fond sur 8 à 10 s, pente de 8 à 12 %, foulée puissante',
  elevationGainM: 3, recovery: { durationS: 150, zone: 'Z1', active: false, elevationLossM: 3 },
  notes: 'Récupération complète en marchant : chaque sprint doit être aussi rapide que le premier. Stop dès que ça ralentit. Le remplaçant du renforcement pour les tendons.',
});
const vo2 = (n: number, repS: number, notes = 'Côte de 6 à 12 % courue — montée de la Sarra, Fourvière, route du Mont Cindre.'): Block => ({
  label: 'Côte VO2max', zone: 'Z5', durationS: repS, repeat: n, elevationGainM: gain(1100, repS),
  effort: '9 sur 10 : le cœur finit chaque répétition au-dessus de 174',
  recovery: { durationS: repS, zone: 'Z1', active: true, betweenReps: true, elevationLossM: gain(1100, repS) },
  notes: notes + ' Sur les répétitions courtes, le cardio est en retard : fie-toi à l’effort. Si la 3e ne monte pas en zone 5, tu arrêtes.',
});
const thrUp = (n: number, repS: number, recS: number, hike = false): Block => ({
  label: hike ? 'Seuil en montée raide, marché' : 'Seuil en montée', zone: 'Z4', durationS: repS, repeat: n, hrRange: [168, 172],
  elevationGainM: gain(hike ? 940 : 920, repS), ...(hike ? { terrain: 'trail' } : {}),
  recovery: { durationS: Math.max(recS, Math.ceil(gain(hike ? 940 : 920, repS) / 1600 * 3600 / 30) * 30), zone: 'Z1', active: true, betweenReps: true, elevationLossM: gain(hike ? 940 : 920, repS) },
  notes: hike
    ? 'Pente de 18 à 25 %, marche rapide avec bâtons : 168–172. Redescente facile.'
    : 'Pente de 8 à 15 % courue, régulière : 168–172, au seuil, pas au-dessus. Redescente facile.',
});
const subThrFlat = (n: number, repS: number, recS: number): Block => ({
  label: 'Sous le seuil, à plat', zone: 'Z4', durationS: repS, repeat: n, hrRange: [163, 168],
  recovery: { durationS: recS, zone: 'Z1', active: true, betweenReps: true },
  notes: 'Sur les quais : maîtrisé, tu pourrais en faire une de plus. Au-dessus de 170, tu ralentis.',
});
const tempoFlat = (n: number, repS: number, recS: number): Block => ({
  label: 'Tempo à plat', zone: 'Z3', durationS: repS, repeat: n, hrRange: [155, 163],
  recovery: { durationS: recS, zone: 'Z1', active: true, betweenReps: true },
  notes: 'Sur les quais, régulier : le cœur entre 155 et 163, la respiration encore contrôlée.',
});
const ssClimb = (n: number, repS: number, recS: number): Block => ({
  label: 'Montée longue, allure de course', zone: 'Z3', durationS: repS, repeat: n, hrRange: [155, 163],
  elevationGainM: gain(760, repS), terrain: 'trail',
  recovery: { durationS: Math.max(recS, Math.ceil(gain(760, repS) / 1500 * 3600 / 30) * 30), zone: 'Z1', active: true, betweenReps: n > 1, elevationLossM: gain(760, repS) },
  notes: 'Monts d’Or, Pilat : allure tenable des heures, marche au-delà de 18 %, bâtons. Mange 60 g/h. Redescente tranquille.',
});
const me = (n: number, repS: number, recS: number): Block => ({
  label: 'Marche en pente raide', zone: 'Z2', durationS: repS, repeat: n, hrRange: [145, 160],
  elevationGainM: gain(800, repS), terrain: 'trail',
  recovery: { durationS: Math.max(recS, Math.ceil(gain(800, repS) / 1600 * 3600 / 30) * 30), zone: 'Z1', active: true, betweenReps: true, elevationLossM: gain(800, repS) },
  notes: 'Pente de 20 à 35 % ou escaliers (Gourguillon, montée de la Grande-Côte) : les cuisses brûlent, le souffle reste calme. Bâtons. Redescente tranquille.',
});
const downhill = (n: number, repS: number, grade: number): Block => ({
  label: 'Descentes rapides', zone: 'Z3', durationS: repS, repeat: n,
  effort: 'Vite mais maîtrisé : foulée courte et rapide, pieds sous le bassin, regard 3 à 5 m devant',
  elevationLossM: Math.round(3.3 * repS * grade), cadenceTargetSpm: 178,
  recovery: { durationS: Math.max(Math.round(repS * 1.8), Math.ceil(3.3 * repS * grade / 620 * 3600 / 30) * 30), zone: 'Z1', active: true, elevationGainM: Math.round(3.3 * repS * grade) },
  notes: `Pente de ${Math.round(grade * 100 - 2)} à ${Math.round(grade * 100 + 2)} %, chemin roulant. Remontée en marchant. Arrête dès que le contrôle se dégrade.`,
});
/**
 * Une sortie longue telle qu'elle se court : approche, montées (marchées au-delà
 * de 15 %) chacune suivie de sa descente, puis du plat. `climb` : D+ d'une montée.
 */
const long = (m: number, dplus: number, o: { hr?: number; label?: string; notes?: string; climb?: number } = {}): Block[] => {
  const hr = o.hr ?? 152;
  const notes = o.notes ?? 'Le cœur sous ' + hr + ' dans les montées, marche au-delà de 15 %. Mange dès la 45e minute.';
  if (dplus < 400) return [{ label: o.label ?? 'Sortie longue vallonnée', zone: 'Z2', durationS: min(m), hrRange: [0, hr], elevationGainM: dplus, elevationLossM: dplus, terrain: 'trail', notes }];
  // Montées plus lentes en fin de journée : la durabilité, sa limite mesurée.
  const upEarly = m >= 240 ? 680 : 700;
  const upLate = m >= 300 ? 520 : m >= 240 ? 580 : 650;
  const down = 1200;
  const downLate = m >= 300 ? 1000 : 1100;
  // Le dénivelé tient dans 80 % du temps de la sortie ; au-delà, il cède.
  const budget = 0.8 * (m / 60);
  const perM = (1 / ((upEarly + upLate) / 2) + 2 / (down + downLate));
  const fitted = Math.min(dplus, Math.floor(budget / perM / 50) * 50);
  const per = o.climb ?? (fitted >= 1500 ? 450 : 250);
  const k = Math.max(1, Math.round(fitted / per));
  const g = Math.round(fitted / k);
  const kEarly = Math.ceil(k / 2);
  const kLate = k - kEarly;
  const sec = (x: number) => Math.ceil(x / 30) * 30;
  const upE = sec((g / upEarly) * 3600), upL = sec((g / upLate) * 3600), downS = sec((g / down) * 3600), downL = sec((g / downLate) * 3600);
  const used = kEarly * (upE + downS) + kLate * (upL + downL);
  const rest = Math.max(900, min(m) - used);
  const approach = Math.round(rest * 0.6);
  const climbNote = (n: number) => `${n} montée${n > 1 ? 's' : ''} de ${g} m, cœur sous ${hr}, marche au-delà de 15 %, bâtons si tu les as. Chaque descente en petits pas rapides, sans freiner fort.`;
  const climb = (label: string, n: number, upS: number, dS: number): Block => ({
    label, zone: 'Z2', durationS: upS, repeat: n, hrRange: [0, hr], elevationGainM: g, terrain: 'trail',
    recovery: { durationS: dS, zone: 'Z1', active: true, elevationLossM: g }, notes: climbNote(n),
  });
  return [
    { label: (o.label ?? 'Sortie longue') + ' — approche', zone: 'Z2', durationS: approach, hrRange: [0, hr], notes },
    climb('Montées', kEarly, upE, downS),
    ...(kLate > 0 ? [climb('Montées, en fin de sortie', kLate, upL, downL)] : []),
    { label: 'Retour', zone: 'Z2', durationS: rest - approach, hrRange: [0, hr] },
  ];
};
const z3Finish = (m: number, dplus = 0): Block => ({
  label: 'Fin à allure soutenue', zone: 'Z3', durationS: min(m), hrRange: [155, 163],
  ...(dplus ? { elevationGainM: dplus, elevationLossM: Math.round(dplus / 2) } : {}),
  notes: 'Sur des jambes qui ont des heures : régulier, 155–163. Si le cœur a déjà dérivé de plus de 8 % dans la partie facile, tu restes facile et tu le notes.',
});
const relaySim = (n: number, repS: number): Block => ({
  label: 'Boucle de relais', zone: 'Z4', durationS: repS, repeat: n, hrRange: [165, 172],
  elevationGainM: 90, elevationLossM: 90,
  recovery: { durationS: repS, zone: 'Z1', active: false, betweenReps: true },
  notes: 'Une boucle de 2 km et 90 m D+ (Sarra, Fourvière) : les trois premières un cran sous l’allure, puis régulier. Pendant la pause : marche, bois, mange, couvre-toi. Note chaque temps de boucle.',
});
const testUp = (m: number, hrCap?: number): Block => ({
  label: hrCap ? `Test en montée à ${hrCap} bpm` : 'Test en montée, à fond', zone: hrCap ? 'Z2' : 'Z4', durationS: min(m),
  ...(hrCap ? { hrRange: [hrCap - 3, hrCap + 2] } : { hrRange: [168, 182] }),
  elevationGainM: gain(hrCap ? 700 : 820, min(m)),
  recovery: { durationS: Math.ceil(gain(hrCap ? 700 : 820, min(m)) / 1500 * 3600 / 30) * 30, zone: 'Z1', active: true, elevationLossM: gain(hrCap ? 700 : 820, min(m)) },
  notes: hrCap
    ? `Une montée régulière connue (Mont Cindre, Mont Verdun) : ${m} min à ${hrCap} bpm exactement, note le dénivelé gagné. C'est ta vitesse ascensionnelle de référence.`
    : `Une montée régulière connue : ${m} min à fond, régulier. La FC des 20 dernières minutes recale ton seuil, le dénivelé recale les cibles des séances en côte. Redescente tranquille.`,
});

// ── Séances ─────────────────────────────────────────────────────────────────
const D = (type: string, why: string, ...blocks: Block[]): Day => ({ type, blocks, why });
const off = null;

export const WEEKS: Week[] = [
  // ── Reprise (mollets d'abord) ──────────────────────────────────────────
  { n: 1, monday: '2026-11-30', phase: 'reprise', days: [
    off,
    D('endurance', 'Reprise, semaine 1 : du volume facile pour les mollets — +10 % par semaine au plus tant qu’ils ne sont pas à 1 sur 10.', easy(45), strides(4)),
    D('recovery', 'Reprise : récupération à plat.', rec(35)),
    D('endurance', 'Reprise : premières lignes droites en côte, si le mollet est à 2 sur 10 ou moins.', easy(45, { dplus: 120 }), strides(4, 15, true)),
    off,
    D('long_run', 'Reprise : la sortie longue revient doucement, montées marchées.', ...long(85, 200, { hr: 150 })),
    D('endurance', 'Reprise : footing à plat.', easy(40)),
  ] },
  { n: 2, monday: '2026-12-07', phase: 'reprise', days: [
    off,
    D('tempo', 'Reprise : premier rappel d’allure, à plat — rien qui charge les mollets.', wu(15), tempoFlat(3, 360, 120), cd(10)),
    D('recovery', 'Récupération.', rec(40)),
    D('endurance', 'Footing vallonné et lignes droites en côte.', easy(50, { dplus: 150 }), strides(6, 20, true)),
    off,
    D('long_run', 'Sortie longue : 1 h 40, montées raides marchées.', ...long(100, 350, { hr: 150 })),
    D('endurance', 'Footing à plat le lendemain.', easy(45)),
  ] },
  { n: 3, monday: '2026-12-14', phase: 'reprise', days: [
    off,
    D('tempo', 'Tempo à plat, deux blocs de 10 min.', wu(15), tempoFlat(2, 600, 180), cd(10)),
    D('recovery', 'Récupération.', rec(40)),
    D('endurance', 'Footing vallonné et lignes droites en côte.', easy(55, { dplus: 200 }), strides(6, 20, true)),
    off,
    D('long_trail', 'Premier vrai trail : 2 h, Monts d’Or ou Pilat selon la neige.', ...long(120, 500, { hr: 150 })),
    D('endurance', 'Footing facile.', easy(45, { dplus: 100 })),
  ] },
  { n: 4, monday: '2026-12-21', phase: 'décharge', days: [
    off,
    D('endurance', 'Décharge de Noël : footing et lignes droites.', easy(45), strides(5, 20, true)),
    off,
    D('endurance', 'Test de référence : la vitesse ascensionnelle à 150 bpm.', wu(15), testUp(20, 150), cd(15)),
    off,
    D('long_run', 'Sortie longue courte de décharge.', ...long(90, 300)),
    D('recovery', 'Récupération.', rec(40)),
  ] },
  // ── Base : VO2max en montée, le moins spécifique d'abord ─────────────────
  { n: 5, monday: '2026-12-28', phase: 'base', days: [
    off,
    D('vo2max', 'Base : VO2max en montée, 5 × 2 min — le plafond d’abord, le spécifique ensuite.', wu(20), vo2(5, 120), cd(15)),
    D('recovery', 'Récupération.', rec(45)),
    D('endurance', 'Footing vallonné et premiers sprints en côte.', easy(55, { dplus: 200 }), sprints(4)),
    off,
    D('long_trail', 'Sortie longue : 2 h 20.', ...long(140, 600)),
    D('endurance', 'Footing facile.', easy(60, { dplus: 150 })),
  ] },
  { n: 6, monday: '2027-01-04', phase: 'base', days: [
    off,
    D('vo2max', 'VO2max en montée, 6 × 3 min.', wu(20), vo2(6, 180), cd(15)),
    D('recovery', 'Récupération.', rec(45)),
    D('endurance', 'Test de dérive : 60 min à allure fixe sous SV1, à plat.', wu(10), easy(60, { label: 'Allure fixe, sous SV1', hr: 155, notes: 'À plat, sur les quais : choisis une allure qui te met à 148–150 et ne la change plus pendant 60 min. La dérive du cœur entre la première et la seconde demi-heure dit si ta base aérobie est revenue : sous 5 %, oui.' }), cd(5)),
    off,
    D('long_trail', 'Sortie longue : 2 h 30, 700 m D+.', ...long(150, 700)),
    D('endurance', 'Footing et premières descentes contrôlées.', easy(55, { dplus: 150 }), downhill(4, 30, 0.08)),
  ] },
  { n: 7, monday: '2027-01-11', phase: 'base', days: [
    off,
    D('vo2max', 'VO2max en montée, 5 × 3 min.', wu(20), vo2(5, 180), cd(15)),
    D('recovery', 'Récupération.', rec(45)),
    D('endurance', 'Footing vallonné et sprints en côte.', easy(60, { dplus: 200 }), sprints(6)),
    off,
    D('long_trail', 'Week-end montagne (Pilat, Bugey ou Jura selon la neige) : 3 h 30, 1 300 m D+.', ...long(210, 1300, { label: 'Journée en montagne', notes: 'Cœur sous 152 dans les longues montées, marche au-delà de 18 %, bâtons. 60 g de glucides par heure. Si la neige ferme les sentiers : Pilat ou Monts d’Or.' })),
    D('endurance', 'Lendemain de montagne : facile, sur des jambes fatiguées.', easy(80, { dplus: 250, hr: 148 })),
  ] },
  { n: 8, monday: '2027-01-18', phase: 'décharge', days: [
    off,
    D('vo2max', 'Décharge : VO2max réduit, 4 × 3 min.', wu(20), vo2(4, 180), cd(15)),
    D('recovery', 'Récupération.', rec(40)),
    D('threshold', 'Test : 30 min à fond en montée — recale le seuil et les cibles des côtes.', wu(20), testUp(30), cd(15)),
    off,
    D('long_run', 'Sortie longue de décharge.', ...long(120, 500)),
    off,
  ] },
  // ── Construction 1 : VO2max → seuil, descente, marche raide ──────────────
  { n: 9, monday: '2027-01-25', phase: 'construction', days: [
    off,
    D('vo2max', 'VO2max en montée, 5 × 4 min.', wu(20), vo2(5, 240), cd(15)),
    D('recovery', 'Récupération.', rec(50)),
    D('threshold', 'Premier seuil en montée : 3 × 8 min.', wu(20), thrUp(3, 480, 240), cd(15)),
    off,
    D('long_trail', 'Sortie longue Monts d’Or : 3 h.', ...long(180, 1000)),
    D('endurance', 'Footing et descentes contrôlées.', easy(60, { dplus: 200 }), downhill(6, 45, 0.08)),
  ] },
  { n: 10, monday: '2027-02-01', phase: 'construction', days: [
    off,
    D('vo2max', 'VO2max en montée, 6 × 4 min.', wu(20), vo2(6, 240), cd(15)),
    D('recovery', 'Récupération.', rec(50)),
    D('hill_repeats', 'Marche en pente raide, 3 × 10 min : l’endurance des jambes pour 5 700 m.', wu(15), me(3, 600, 300), cd(10)),
    D('recovery', 'Récupération.', rec(40)),
    D('long_trail', 'Sortie longue : 3 h 15.', ...long(195, 1100)),
    D('endurance', 'Lendemain : facile, descentes d’une minute.', easy(70, { dplus: 250 }), downhill(6, 60, 0.1)),
  ] },
  { n: 11, monday: '2027-02-08', phase: 'construction', days: [
    off,
    D('threshold', 'Seuil en montée, 3 × 12 min.', wu(20), thrUp(3, 720, 300), cd(15)),
    D('recovery', 'Récupération.', rec(50)),
    D('endurance', 'Footing vallonné et sprints en côte.', easy(60, { dplus: 200 }), sprints(8)),
    off,
    D('long_trail', 'Week-end montagne : 4 h 30, 1 700 m D+, une longue descente de 600 m.', ...long(270, 1700, { label: 'Journée en montagne', notes: 'Cœur sous 152 dans les montées, bâtons au-delà de 18 %, 60–70 g/h. Une descente continue de 600 m à allure de course, pas plus vite.' })),
    D('endurance', 'Lendemain de montagne : 2 h faciles.', easy(110, { dplus: 400, hr: 148, trail: true })),
  ] },
  { n: 12, monday: '2027-02-15', phase: 'décharge', days: [
    off,
    D('vo2max', 'Décharge : VO2max 5 × 3 min.', wu(20), vo2(5, 180), cd(15)),
    D('recovery', 'Récupération.', rec(45)),
    D('endurance', 'Footing et lignes droites en côte.', easy(55, { dplus: 150 }), strides(6, 20, true)),
    off,
    D('long_run', 'Test de durabilité : 3 h à allure fixe, le même tronçon de 2 km à plat à 0 h 30, 1 h 30 et 2 h 30.', ...long(180, 500, { hr: 150, label: 'Test de durabilité', notes: 'Même FC (148–150), même tronçon plat de 2 km à 0 h 30, 1 h 30 et 2 h 30 : la vitesse perdue par heure est ta durabilité. Objectif : passer de −4,4 %/h vers −2 %/h.' })),
    off,
  ] },
  // ── Construction 2 : le seuil, sur le plat et en montée ──────────────────
  { n: 13, monday: '2027-02-22', phase: 'construction', days: [
    off,
    D('threshold', 'Sous le seuil à plat : 6 × 6 min.', wu(15), subThrFlat(6, 360, 60), cd(15)),
    D('recovery', 'Récupération.', rec(50)),
    D('threshold', 'Seuil en montée : 3 × 12 min.', wu(20), thrUp(3, 720, 300), cd(15)),
    off,
    D('long_trail', 'Sortie longue : 3 h 30, la dernière demi-heure soutenue.', ...long(180, 1100), z3Finish(30, 150)),
    D('endurance', 'Dos-à-dos : 1 h 30 faciles et descentes rapides.', easy(80, { dplus: 300, trail: true }), downhill(8, 60, 0.1)),
  ] },
  { n: 14, monday: '2027-03-01', phase: 'construction', days: [
    off,
    D('threshold', 'Sous le seuil à plat : 3 × 12 min.', wu(15), subThrFlat(3, 720, 120), cd(15)),
    D('recovery', 'Récupération.', rec(50)),
    D('threshold', 'Seuil en montée : 2 × 20 min.', wu(20), thrUp(2, 1200, 360), cd(15)),
    D('recovery', 'Récupération.', rec(40)),
    D('long_trail', 'Sortie longue : 4 h, les 45 dernières minutes soutenues.', ...long(195, 1300), z3Finish(45, 250)),
    D('endurance', 'Dos-à-dos : 1 h 30, descentes de 1 min 30.', easy(80, { dplus: 300, trail: true }), downhill(8, 90, 0.1)),
  ] },
  { n: 15, monday: '2027-03-08', phase: 'construction', days: [
    off,
    D('vo2max', 'Rappel VO2max : 5 × 4 min.', wu(20), vo2(5, 240), cd(15)),
    D('recovery', 'Récupération.', rec(50)),
    D('hill_repeats', 'Marche en pente raide : 4 × 10 min, sac de 4 à 6 kg.', wu(15), me(4, 600, 300), cd(10)),
    off,
    D('long_trail', 'Week-end montagne : 5 h 30, 2 200 m D+, une descente continue de 900 m.', ...long(330, 2200, { label: 'Journée en montagne', notes: 'Cœur sous 152 dans les montées, bâtons, 70–80 g/h, matériel obligatoire de course. Une descente de 900 m à allure de course.' })),
    D('endurance', 'Lendemain de montagne : 2 h faciles.', easy(120, { dplus: 450, hr: 148, trail: true })),
  ] },
  { n: 16, monday: '2027-03-15', phase: 'décharge', days: [
    off,
    D('vo2max', 'Décharge : VO2max 4 × 4 min.', wu(20), vo2(4, 240), cd(15)),
    D('recovery', 'Récupération.', rec(45)),
    D('threshold', 'Test : 30 min à fond en montée.', wu(20), testUp(30), cd(15)),
    off,
    D('long_trail', 'Sortie longue de décharge : 2 h 30.', ...long(150, 700)),
    off,
  ] },
  // ── Spécifique 1 : la montagne à allure de course ────────────────────────
  { n: 17, monday: '2027-03-22', phase: 'spécifique', days: [
    D('recovery', 'Récupération.', rec(40)),
    D('tempo', 'Montées longues à allure de course : 2 × 30 min.', wu(15), ssClimb(2, 1800, 900), cd(10)),
    D('recovery', 'Récupération.', rec(50), strides(6, 20, true)),
    D('downhill', 'Descente : 10 × 1 min 30 rapides.', wu(20), downhill(10, 90, 0.12), cd(10)),
    off,
    D('long_trail', 'Sortie longue : 4 h, 1 600 m D+, entraînement digestif à 80 g/h.', ...long(240, 1600)),
    D('endurance', 'Dos-à-dos : 2 h faciles.', easy(120, { dplus: 450, trail: true })),
  ] },
  { n: 18, monday: '2027-03-29', phase: 'spécifique', days: [
    D('recovery', 'Lundi de Pâques : récupération.', rec(40)),
    D('threshold', 'Seuil à pente de course : 3 × 15 min.', wu(20), thrUp(3, 900, 360, true), cd(15)),
    D('endurance', 'Sortie de nuit, frontale : 1 h 30 sur des sentiers connus, 3 ou 4 descentes techniques.', easy(90, { dplus: 350, trail: true, notes: 'À la frontale, sur un sentier que tu connais : 3 ou 4 descentes techniques, petits pas, regard loin.' })),
    D('hill_repeats', 'Marche en pente raide : 2 × 20 min.', wu(15), me(2, 1200, 480), cd(10)),
    off,
    D('long_trail', 'Pilat : 4 h 30, 2 000 m D+.', ...long(270, 2000, { label: 'Journée au Pilat', notes: 'Crêt de la Perdrix par les chirats, descentes vers Pélussin : cœur sous 152, 80 g/h, bâtons.' })),
    D('endurance', 'Dos-à-dos : 2 h faciles.', easy(120, { dplus: 450, trail: true })),
  ] },
  { n: 19, monday: '2027-04-05', phase: 'spécifique', days: [
    D('recovery', 'Récupération.', rec(45)),
    D('tempo', 'Montée longue continue : 45 min à allure de course.', wu(15), ssClimb(1, 2700, 0), cd(15)),
    D('recovery', 'Récupération et lignes droites.', rec(50), strides(6, 20, true)),
    D('vo2max', 'Rappel VO2max : 5 × 4 min.', wu(20), vo2(5, 240), cd(15)),
    off,
    D('long_trail', 'Week-end montagne : 6 h, départ 4 h à la frontale.', ...long(360, 2500, { label: 'Journée en montagne de nuit', notes: 'Départ 4 h du matin à la frontale. Cœur sous 152, une montée de 40 min soutenue entre la 4e et la 5e heure, bâtons, 80–90 g/h, matériel complet.' })),
    D('endurance', 'Dos-à-dos : 2 h 30 sur des jambes fatiguées.', easy(150, { dplus: 600, trail: true, hr: 148 })),
  ] },
  { n: 20, monday: '2027-04-12', phase: 'décharge', days: [
    off,
    D('vo2max', 'Décharge : VO2max 5 × 4 min.', wu(20), vo2(5, 240), cd(15)),
    D('recovery', 'Récupération.', rec(45)),
    D('endurance', 'Footing vallonné et lignes droites en côte.', easy(60, { dplus: 200 }), strides(6, 20, true)),
    off,
    D('long_run', 'Test de durabilité n° 2 : 3 h à allure fixe.', ...long(180, 600, { hr: 150, label: 'Test de durabilité', notes: 'Même protocole qu’en février : même FC, même tronçon de 2 km à 0 h 30, 1 h 30 et 2 h 30.' })),
    off,
  ] },
  // ── Spécifique 2 : relais et montagne ─────────────────────────────────────
  { n: 21, monday: '2027-04-19', phase: 'spécifique', days: [
    D('recovery', 'Récupération.', rec(45)),
    D('race_pace', 'Simulation du relais : 6 boucles de 8 min, pause égale.', wu(20), relaySim(6, 480), cd(10)),
    D('recovery', 'Récupération.', rec(50), strides(6, 20, true)),
    D('tempo', 'Montées longues à allure de course : 2 × 30 min.', wu(15), ssClimb(2, 1800, 900), cd(10)),
    off,
    D('long_trail', 'Pilat : 5 h, 2 200 m D+, 80–90 g/h.', ...long(300, 2200, { label: 'Journée au Pilat' })),
    D('endurance', 'Dos-à-dos : 2 h.', easy(120, { dplus: 450, trail: true })),
  ] },
  { n: 22, monday: '2027-04-26', phase: 'spécifique', days: [
    D('recovery', 'Récupération.', rec(45)),
    D('race_pace', 'Simulation du relais : 8 boucles de 9 min, pause égale.', wu(20), relaySim(8, 540), cd(10)),
    D('recovery', 'Récupération.', rec(50), strides(6, 20, true)),
    D('downhill', 'Longues descentes : 2 × 600 m à allure de course.', wu(20), downhill(2, 600, 0.12), cd(15)),
    off,
    D('long_trail', 'Sortie longue : 4 h, les 45 dernières minutes à la frontale.', ...long(240, 1700)),
    D('long_trail', 'Dos-à-dos : 3 h sur des jambes fatiguées.', ...long(180, 900, { hr: 150 })),
  ] },
  { n: 23, monday: '2027-05-03', phase: 'pic', days: [
    D('recovery', 'Récupération avant le bloc de l’Ascension.', rec(45)),
    D('vo2max', 'Court rappel : 5 × 3 min.', wu(20), vo2(5, 180), cd(15)),
    D('endurance', 'Footing facile.', easy(60, { dplus: 150 })),
    D('long_trail', 'Ascension, jour 1 : 3 h 30 en montagne.', ...long(210, 1300, { label: 'Bloc de l’Ascension, jour 1' })),
    D('long_trail', 'Ascension, jour 2 : la répétition générale — 6 h 30, environ 40 km, à l’allure prévue pour le 100 km.', ...long(390, 2600, { label: 'Répétition générale', notes: 'À l’effort prévu le jour J, pas plus vite : cœur sous 152 dans les montées, bâtons, petit-déjeuner, produits et chaussures de course, 80–90 g/h. Note tout : allure, cœur, estomac.' })),
    D('long_trail', 'Ascension, jour 3 : 2 h faciles sur des jambes fatiguées.', ...long(120, 600, { hr: 148 })),
    off,
  ] },
  { n: 24, monday: '2027-05-10', phase: 'consolidation', days: [
    off,
    D('race_pace', 'Simulation du relais : 12 boucles de 9 min — la répétition du 22/05.', wu(20), relaySim(12, 540), cd(10)),
    D('recovery', 'Récupération.', rec(45)),
    D('endurance', 'Footing facile.', easy(60, { dplus: 150 })),
    off,
    D('long_trail', 'Sortie longue : 3 h 30 vallonnée.', ...long(210, 1100)),
    D('endurance', 'Footing facile.', easy(80, { dplus: 200 })),
  ] },
  { n: 25, monday: '2027-05-17', phase: 'relais', days: [
    off,
    D('race_pace', 'Semaine du relais : réveil, 4 × 3 min à l’allure de boucle.', wu(15), { label: 'Allure de boucle', zone: 'Z4', durationS: 180, repeat: 4, hrRange: [165, 172], recovery: { durationS: 180, zone: 'Z1', active: true, betweenReps: true }, notes: 'À l’allure prévue pour les boucles du samedi, pas plus vite.' }, cd(15)),
    D('recovery', 'Récupération.', rec(45)),
    D('endurance', 'Footing et lignes droites.', easy(40), strides(4)),
    off,
    null, // le relais, écrit par le plan
    D('recovery', 'Lendemain du relais : 30 min très faciles, ou rien.', rec(30)),
  ] },
  { n: 26, monday: '2027-05-24', phase: 'récupération', days: [
    off,
    D('recovery', 'Récupération du relais.', rec(40)),
    D('endurance', 'Footing facile.', easy(60, { dplus: 150 })),
    D('endurance', 'Test de descente : 10 min de descente contrôlée et 6 lignes droites — feu vert de la dernière longue si les cuisses sont indolores.', easy(30), downhill(1, 600, 0.08), strides(6, 20, true)),
    off,
    D('long_trail', 'Dernière longue en montagne : 4 h 30, 2 000 m D+.', ...long(270, 2000, { label: 'Dernière journée en montagne', notes: 'Seulement si le test de jeudi est passé. Allure de course, bâtons, produits du jour J.' })),
    D('endurance', 'Footing facile.', easy(80, { dplus: 200 })),
  ] },
  // ── Affûtage ──────────────────────────────────────────────────────────────
  { n: 27, monday: '2027-05-31', phase: 'affûtage', days: [
    off,
    D('threshold', 'Affûtage : 4 × 5 min au seuil en montée.', wu(20), thrUp(4, 300, 180), cd(15)),
    D('endurance', 'Footing facile.', easy(60, { dplus: 150 })),
    D('tempo', 'Affûtage : 1 h avec 20 min soutenues.', wu(20), { label: 'Allure soutenue', zone: 'Z3', durationS: 1200, hrRange: [155, 163], notes: 'Régulier, sur du vallonné.' }, cd(20)),
    off,
    D('long_trail', 'Affûtage : 3 h vallonnées, moins de 1 000 m de descente.', ...long(180, 900)),
    D('endurance', 'Footing facile.', easy(75, { dplus: 150 })),
  ] },
  { n: 28, monday: '2027-06-07', phase: 'affûtage', days: [
    off,
    D('vo2max', 'Affûtage : 5 × 3 min en montée.', wu(20), vo2(5, 180), cd(15)),
    D('endurance', 'Footing facile.', easy(50)),
    D('endurance', 'Footing et lignes droites.', easy(45), strides(6)),
    off,
    D('long_run', 'Affûtage : 2 h avec le matériel de course.', ...long(120, 500)),
    D('endurance', 'Footing facile.', easy(60)),
  ] },
  { n: 29, monday: '2027-06-14', phase: 'course', days: [
    off,
    D('threshold', 'Semaine de course : 4 × 2 min au seuil et 4 lignes droites.', wu(20), thrUp(4, 120, 120), strides(4), cd(10)),
    D('recovery', 'Footing très facile.', rec(40)),
    D('recovery', 'Veille de veille : 30 min et 3 lignes droites.', rec(30), strides(3)),
    off,
    null, // la course
    null,
  ] },
];
