import { describe, expect, it } from 'vitest';
import {
  PIERRE, anchorRelativeDates, annexOf, directivesFor, relativeDatesIn, sessionDuration,
  type PlannedSession, type RaceGoal, type SessionBlock,
} from '@cairn/core';
import { FLAT_RUNNING_COST, buildZones, walkingGrade } from '@cairn/physiology';
import * as lib from '@cairn/coach';
import type { ClimbOccurrence, RecurringClimb, TerrainHint } from '@cairn/coach';
import { DECIDED_ON_2026_09_21, PIERRE_MODEL } from './fixtures/pierre.js';

/**
 * Ce qui se lit d'une séance : son titre, son « pourquoi », ses consignes, son
 * historique. Le 21/09, le plan stocké gardait des décisions du 18/09 avec leurs
 * textes — un « pourquoi » de 2 713 caractères, une consigne qui parlait du
 * « soir » où elle avait été écrite —, des blocs de 23 et 26 minutes, une
 * rando-course découpée en montée et descente, et des titres qui comptaient la
 * souplesse dans le footing.
 */

const RACE: RaceGoal = {
  id: 'grisemottes', athleteId: 'pierre', name: 'Trail des Grisemottes', date: '2026-10-18', priority: 'A',
  course: { distanceM: 32000, elevationGainM: 1200, elevationLossM: 1200, technicality: 3, expectedTempC: 12 },
};

describe('Aucune date relative dans un texte enregistré', () => {
  const at = '2026-09-18T17:46:03.751Z'; // 19 h 46 à Lyon

  it('ancre ce que le texte désignait le jour où il a été écrit', () => {
    expect(anchorRelativeDates('ta meilleure moyenne sur 20 min de ce soir', at)).toBe(
      'ta meilleure moyenne sur 20 min du 18/09 au soir',
    );
    expect(anchorRelativeDates("sur le modèle d'aujourd'hui — pas sur celui d'hier.", at)).toBe(
      'sur le modèle du 18/09 — pas sur celui du 17/09.',
    );
    expect(anchorRelativeDates('Hier, plus haut qu’hier ; à demain ; jusqu’à demain soir.', at)).toBe(
      'Le 17/09, plus haut que le 17/09 ; au 19/09 ; jusqu\'au 19/09 au soir.',
    );
    expect(anchorRelativeDates('la course fait 1 200 m D− dans 15 jours', at)).toBe(
      'la course fait 1 200 m D− 15 jours après le 18/09',
    );
    expect(anchorRelativeDates('la semaine prochaine, mardi prochain', at)).toBe('la semaine du 21/09, le mardi 22/09');
  });

  it('laisse ce qui renvoie à ce dont le texte parle, et non au jour où il est écrit', () => {
    const text = 'Disponibilité encore rouge ce matin-là : pas de test. Le lendemain, décrassage ; la veille, repos.';
    expect(anchorRelativeDates(text, at)).toBe(text);
    expect(relativeDatesIn(text)).toEqual([]);
    expect(relativeDatesIn('Ta séance de ce soir')).toEqual(['ce soir']);
  });
});

describe('Une durée ronde est un multiple de cinq minutes', () => {
  const round = (s: number) => s % 300 === 0;
  const link = /gammes|lignes droites|pause entre/i;
  const library = [
    lib.recovery(PIERRE_MODEL, 43), lib.endurance(PIERRE_MODEL, 52, 60), lib.longRun(PIERRE_MODEL, 107, 300),
    lib.longTrail(PIERRE_MODEL, 181, 680), lib.tempo(PIERRE_MODEL, 25), lib.threshold(PIERRE_MODEL, 5, 5),
    lib.pyramid(PIERRE_MODEL, [4, 8, 12, 8, 4]), lib.vo2max(PIERRE_MODEL, '30-30', 1, 8),
    lib.vo2max(PIERRE_MODEL, '1-1', 2, 8), lib.hillRepeats(PIERRE_MODEL, 8, 90), lib.downhillSession(PIERRE_MODEL, 6, 3),
    lib.racePace(PIERRE_MODEL, 40), lib.strength(PIERRE_MODEL), lib.timeTrial(PIERRE_MODEL, 20),
  ];

  it('pose échauffement, corps, retour au calme et blocs annexes sur la maille, et la séance entière aussi', () => {
    for (const s of library) {
      expect(round(lib.totalDuration(s.blocks)), `${s.title}`).toBe(true);
      for (const b of s.blocks) {
        if (b.recovery || (b.repeat ?? 1) > 1 || link.test(b.label)) continue;
        expect(round(b.durationS ?? 0), `${s.title} — « ${b.label} » ${b.durationS} s`).toBe(true);
      }
    }
  });

  it('laisse aux répétitions la durée que le dossier prescrit', () => {
    const pma = lib.vo2max(PIERRE_MODEL, '30-30', 1, 8);
    expect(pma.blocks.find((b) => (b.repeat ?? 1) > 1)).toMatchObject({ durationS: 30, recovery: { durationS: 30 } });
    const pyramid = lib.pyramid(PIERRE_MODEL, [4, 8, 12, 8, 4]);
    expect(pyramid.blocks.filter((b) => b.zone === 'Z4').map((b) => b.durationS)).toEqual([240, 480, 720, 480, 240]);
    // Huit fois 30"-30" font huit minutes : ce sont les gammes qui rendent la séance ronde.
    const gammes = pma.blocks.find((b) => link.test(b.label))!;
    expect(gammes.durationS! % 300).not.toBe(0);
  });

  it('arrondit un circuit aux cinq minutes supérieures : ses tours sont ce qu\'on a prescrit', () => {
    const s = lib.strength(PIERRE_MODEL, 3);
    const circuit = s.blocks.find((b) => b.circuit)!;
    expect(circuit.durationS! % 300).toBe(0);
    expect(circuit.durationS).toBeGreaterThanOrEqual(27 * 60);
  });
});

describe('Le titre distingue ce qui se court de ce qui s\'ajoute', () => {
  const blocks: SessionBlock[] = [
    { label: 'Footing en endurance aérobie', zone: 'Z2', durationS: 15 * 60 },
    { label: 'Souplesse chaîne postérieure', zone: 'Z1', kind: 'mobility', durationS: 600 },
    { label: 'Travail respiratoire', zone: 'Z1', kind: 'respiratory', durationS: 600 },
  ];

  it('écrit quinze minutes de footing et vingt de souplesse et de respiration comme telles', () => {
    expect(lib.sessionTitle('Footing', 'endurance', blocks)).toBe('Footing 15 min + souplesse et respiration 20 min');
    expect(annexOf(blocks)).toEqual({ name: 'souplesse et respiration', durationS: 1200 });
  });

  it('range l\'activation et le circuit dans le renforcement', () => {
    const s = lib.strength(PIERRE_MODEL);
    expect(annexOf(s.blocks)?.name).toBe('renforcement et souplesse');
    expect(s.blocks.find((b) => b.label === 'Activation')).toMatchObject({ kind: 'activation' });
    expect(s.blocks.find((b) => b.label === 'Activation')?.hrRange).toBeUndefined();
  });

  it('garde la durée entière après le tiret quand rien ne s\'ajoute', () => {
    expect(lib.sessionTitle('Footing', 'endurance', blocks.slice(0, 1))).toBe('Footing — 15 min');
    expect(sessionDuration(3 * 3600)).toBe('3 h');
  });

  it('relit le format sur toutes les écritures qu\'un titre a connues', () => {
    expect(lib.formatOf('Endurance fondamentale + renforcement — 1 h 08')).toBe('Endurance fondamentale');
    expect(lib.formatOf('Footing 15 min + souplesse et respiration 20 min')).toBe('Footing');
    expect(lib.formatOf('Rando-course 3 h · 680 m D+')).toBe('Rando-course');
    expect(lib.formatOf('Descente technique 6 × 3 min — 1 h 15 · 462 m D−')).toBe('Descente technique 6 × 3 min');
  });

  it('fait suivre au format les minutes de son bloc continu', () => {
    const s = lib.racePace(PIERRE_MODEL, 40);
    const shorter = lib.transformSession({ ...s, plannedDurationS: s.durationS }, 0.8, PIERRE_MODEL);
    const main = shorter.blocks.find((b) => b.zone === 'Z3')!;
    const title = lib.retitleFromContent({ title: s.title, type: s.type, blocks: shorter.blocks });
    expect(title).toContain(`Allure spécifique ${main.durationS! / 60} min`);
  });
});

/** Une montée récurrente telle que le terrain la rend. */
function climb(over: Partial<RecurringClimb> & Pick<RecurringClimb, 'start' | 'gainM' | 'lengthM'>): RecurringClimb {
  const occurrence: ClimbOccurrence = {
    startIndex: 0, endIndex: 1, start: over.start, top: [45.763824, 4.822308], startAltitudeM: 172,
    lengthM: over.lengthM, gainM: over.gainM, grade: over.gainM / over.lengthM, durationS: 600, vamMh: 800, avgHr: 150,
    profile: [], provenance: 'field', activityId: 'strava-1', activityName: 'Trail dans l’après-midi', date: '2026-08-17',
  };
  return {
    grade: Math.round((over.gainM / over.lengthM) * 1000) / 1000, passages: 4, outings: 4,
    firstDate: '2026-06-13', lastDate: '2026-08-17', bestVamMh: 915, best: occurrence, latest: occurrence,
    medianVamMh: 869,
    trend: 'flat', activityNames: ['Trail dans l’après-midi'], occurrences: [occurrence], provenance: 'field',
    ...over,
  };
}

describe('Une séance de terrain se prescrit comme elle se court', () => {
  const zones = buildZones(PIERRE_MODEL);
  const walkAt = walkingGrade(FLAT_RUNNING_COST * (zones.find((z) => z.key === 'Z2')!.speedMaxMs as number));
  const pct = Math.round(walkAt * 100);

  it('une durée, un dénivelé, et une règle de marche tirée du seuil de bascule du modèle', () => {
    const s = lib.longTrail(PIERRE_MODEL, 180, 680);
    expect(s.title).toBe('Rando-course — 3 h · 680 m D+');
    const [terrain, cooldown] = s.blocks;
    expect(s.blocks).toHaveLength(2);
    expect(terrain).toMatchObject({ zone: 'Z2', durationS: 160 * 60, elevationGainM: 680, elevationLossM: 680 });
    expect(terrain!.vamTargetMh).toBeUndefined();
    expect(cooldown).toMatchObject({ zone: 'Z1', durationS: 20 * 60 });
    expect(terrain!.label).toBe(`Sur sentier, marche dès ${pct} % de pente`);
    expect(terrain!.notes).toContain(`sous ${pct} %`);
    // Le seuil est celui du modèle : au-dessus, à la puissance du haut de Z2, la foulée est la marche.
    expect(pct).toBeGreaterThan(3);
    expect(pct).toBeLessThan(20);
  });

  it('nomme la montée récurrente qui porte le dénivelé, et dit combien de passages le font', () => {
    const home: [number, number] = [45.763274, 4.835536];
    const terrain: TerrainHint = {
      home,
      climbs: [
        climb({ start: [45.764389, 4.82914], lengthM: 942, gainM: 121 }),
        // Trop courte : vingt passages, c'est une séance de côtes.
        climb({ start: [45.765468, 4.817018], lengthM: 190, gainM: 34 }),
      ],
    };
    const s = lib.longTrail(PIERRE_MODEL, 180, 680, terrain);
    expect(s.blocks[0]!.notes).toContain(
      "Les 680 m, c'est 6 passages de ta montée de 940 m, du pied au haut : 121 m par passage, 726 m en tout.",
    );
    // La montée, et ses deux bouts sur la carte.
    expect(s.blocks[0]!.where).toEqual({
      // Sans voie relevée, elle se dit par ses chiffres — jamais par sa position par rapport au domicile.
      climb: 'ta montée de 940 m à 13 % (121 m), courue lors de 4 sorties — la dernière le 17/08 (« Trail dans l’après-midi »)',
      from: { role: 'pied', at: [45.764389, 4.82914] },
      to: { role: 'haut', at: [45.763824, 4.822308] },
      lengthM: 942,
      grade: 0.128,
      provenance: 'field',
    });
  });

  it('ne nomme rien quand aucune montée ne tombe juste', () => {
    const terrain: TerrainHint = { climbs: [climb({ start: [45.765468, 4.817018], lengthM: 190, gainM: 34 })] };
    expect(lib.climbFor(terrain, 680, walkAt)).toBeNull();
    expect(lib.longTrail(PIERRE_MODEL, 180, 680, terrain).blocks[0]!.notes).not.toContain('passage');
  });
});

describe('Une séance décidée garde son contenu, et se présente comme toute séance', () => {
  const context = { model: PIERRE_MODEL };
  const [test, rando] = DECIDED_ON_2026_09_21.map((s) => structuredClone(s));

  it('reprend date, type, durée, dénivelé et charge à l\'identique', () => {
    for (const s of [test!, rando!]) {
      const p = lib.presentDecided(s, context);
      for (const k of ['id', 'date', 'type', 'plannedDurationS', 'plannedElevationGainM', 'plannedLoad', 'plannedMechanicalLoad'] as const) {
        expect(p[k], `${s.date} ${k}`).toEqual(s[k]);
      }
      expect(lib.totalDuration(p.blocks)).toBe(s.plannedDurationS);
      expect(lib.elevationGainOf(p.blocks)).toBe(s.plannedElevationGainM);
    }
  });

  it('dit son « pourquoi » en une phrase, et range le raisonnement dans l\'historique', () => {
    const reasoning: PlannedSession = {
      ...test!,
      rationale: 'Ce qui la motive : la preuve d\'effort maximal vaut 0.\n\nPlacement : inchangé, le mardi laisse 48 h.',
    };
    const p = lib.presentDecided(reasoning, context);
    expect(lib.isOneSentence(p.rationale!)).toBe(true);
    expect(p.rationale).toBe(
      'Test maximal fixé par le coach le 18/09 : 20 min à fond sur le plat, la seule mesure qui ancre ta vitesse critique.',
    );
    expect(p.history).toEqual([{ at: test!.decision!.at, by: 'coach', text: reasoning.rationale }]);
    // Une seconde présentation trouve l'entrée : elle n'en ajoute pas.
    expect(lib.presentDecided(p, context).history).toEqual(p.history);
  });
});

describe('Le « pourquoi » tient en une phrase, pour toutes les séances', () => {
  const { weeks } = lib.buildTrainingPlan({
    athleteId: 'pierre', model: PIERRE_MODEL, constraints: PIERRE.constraints, race: RACE,
    currentCtl: 33.3, currentAtl: 18.3, estimatedRaceDurationS: 13162, racePaceMs: 32000 / 13162,
    startDate: '2026-09-14', directives: directivesFor(PIERRE), ambition: PIERRE.ambition,
  });
  const sessions = weeks.flatMap((w) => w.sessions);

  it('écrit une phrase concrète, et laisse à l\'historique ce que la construction a dû céder', () => {
    for (const s of sessions) {
      expect(lib.isOneSentence(s.rationale ?? ''), `${s.date} « ${s.rationale} »`).toBe(true);
      expect((s.rationale ?? '').length, `${s.date} « ${s.rationale} »`).toBeLessThanOrEqual(200);
      expect(s.rationale ?? '', s.date).not.toMatch(/ramené|divergent|marge de prescription/);
    }
    const built = sessions.flatMap((s) => s.history ?? []);
    for (const h of built) expect(h.by).toBe('planner');
  });

  it('n\'écrit aucune date relative', () => {
    for (const s of sessions) {
      for (const t of [s.title, s.intent, s.rationale ?? '', ...s.blocks.map((b) => b.notes ?? '')]) {
        expect(relativeDatesIn(t), `${s.date} « ${t.slice(0, 60)} »`).toEqual([]);
      }
    }
  });
});

describe('Ce que Pierre lit lui parle de sa course, pas du modèle', () => {
  const gap = {
    raceDay: '18/10', target: 12, projected: 10.8, costS: 11, predictedS: 12_840,
    atFloor: true, atCeiling: false, taperScale: 0.6, weeks: 4, taperWeeks: 2,
    startCtl: 36, maxWeeklyHours: 8,
  };
  const [plain, mechanism] = lib.taperGapText(gap).split('\n\n') as [string, string];

  it('dit d\'abord ce que ça change : onze secondes, et rien à faire', () => {
    expect(plain).toBe(
      "Tu seras un peu moins frais que l'idéal le 18/10 : 11 secondes sur 3 h 34. " +
        'Alléger davantage te ferait perdre plus de forme que tu ne gagnerais de fraîcheur. Rien à faire.',
    );
  });

  it('n\'emploie aucun terme interne, et écrit ses nombres à la française', () => {
    for (const text of [plain, mechanism]) {
      expect(text).not.toMatch(/TSB|CTL|ratio|profondeur nominale|l['’]athlète|charge chronique/i);
      expect(text).not.toMatch(/\d+\.\d/);
    }
    // Le mécanisme complet reste lisible, à un geste : il dit le plancher, les
    // semaines, la forme de fond de départ et le point qui manque.
    expect(mechanism).toContain('son plancher');
    expect(mechanism).toContain('forme de fond de 36 points');
    expect(mechanism).toContain('il manque 1,2 point de fraîcheur');
  });

  it('ne compte pas en secondes un départ trop frais : c\'est le fond qui manque', () => {
    const over = lib.taperGapText({ ...gap, target: 8, projected: 12, atFloor: false, atCeiling: true });
    expect(over.split('\n\n')[0]).toContain('plus reposé que l\'idéal');
    expect(over).not.toMatch(/secondes/);
  });
});

describe('Un écart plus petit que l\'incertitude de ce qui le mesure ne s\'affiche pas', () => {
  // Le plan du 22/09 au soir : +11,2 contre +12 visés, 8 secondes sur 3 h 34
  // d'une prédiction qui a elle-même ±23 minutes d'incertitude.
  const gap = {
    raceDay: '18/10', target: 12, projected: 11.2, costS: 8, predictedS: 12_840, uncertaintyS: 1_380,
    atFloor: true, atCeiling: false, taperScale: 0.6, weeks: 4, taperWeeks: 2, startCtl: 37, maxWeeklyHours: 8,
  };
  const shortfall = lib.taperGapText(gap);

  it('ne montre pas l\'encart : huit secondes sous ±23 minutes ne sont pas une information', () => {
    expect(lib.raceDayNotice(shortfall, gap)).toBeNull();
    // Le coach, qui lit le texte en entier, sait pourquoi l'écran se tait.
    expect(lib.firstParagraph(shortfall)).toContain(
      '8 secondes sur 3 h 34, sous la précision de la prédiction (±23 minutes).',
    );
  });

  it('montre ce que l\'écart change quand la prédiction sait le mesurer, et rien de son mécanisme', () => {
    const wide = { ...gap, projected: 2, costS: 1_500 };
    const notice = lib.raceDayNotice(lib.taperGapText(wide), wide)!;
    expect(notice).toMatch(/^Tu seras un peu moins frais que l'idéal le 18\/10 : 25 minutes sur 3 h 34\./);
    expect(notice).not.toMatch(/profondeur|plancher|semaines dont/);
  });

  it('dit toujours un départ trop frais : il ne se chiffre pas en temps, il se décide', () => {
    const over = { ...gap, target: 8, projected: 12, costS: 0, uncertaintyS: 0, atFloor: false, atCeiling: true };
    expect(lib.raceDayNotice(lib.taperGapText(over), over)).toContain('plus reposé que l\'idéal');
  });

  it('garde au journal le mécanisme — profondeur, plancher —, sans les secondes', () => {
    const journal = lib.taperGapJournal(shortfall, gap);
    expect(journal).toContain("L'affûtage est à 60 % de sa profondeur habituelle, son plancher");
    expect(journal).not.toMatch(/secondes|\n/);
  });
});

describe('Le vocabulaire : une table, une phrase par mot', () => {
  const entries = Object.entries(lib.GLOSSARY);

  it('définit exactement les mots qui restent à l\'écran', () => {
    expect(entries.map(([, e]) => e.term)).toEqual([
      'Points de charge', 'Charge mécanique', 'Forme de fond', 'Fatigue', 'Fraîcheur', 'Disponibilité',
      'Vitesse critique', 'VMA', 'Seuil',
    ]);
  });

  it('tient chaque définition en une phrase, sans le jargon qu\'elle remplace', () => {
    for (const [key, e] of entries) {
      expect(lib.isOneSentence(e.definition), key).toBe(true);
      expect(e.definition, key).not.toMatch(/\b(TSB|CTL|ATL|ACWR|rTSS|TSS|EWMA|D′|D')\b/);
      expect(e.definition, key).not.toMatch(/\d+\.\d/);
    }
  });

  it('ancre toutes les charges sur une heure au seuil, et lit ses nombres dans le moteur', () => {
    expect(lib.GLOSSARY.points.definition).toContain('une heure à ton seuil vaut 100 points');
    expect(lib.GLOSSARY.seuil.definition).toContain('seuil 2');
    expect(lib.GLOSSARY.forme.definition).toContain('les six dernières semaines');
    expect(lib.GLOSSARY.fatigue.definition).toContain('la dernière semaine');
    expect(lib.GLOSSARY.fraicheur.definition).toContain('les quatre dernières semaines et les cinq derniers jours');
    expect(lib.GLOSSARY.disponibilite.definition).toContain('vert dès 68, rouge sous 45');
    expect(lib.GLOSSARY.vitesseCritique.definition).toContain('de 2 à 20 minutes');
  });
});

describe('Le point du jour dit à quoi il sert, puis ce qu\'il a changé', () => {
  const today = '2026-09-23';
  const session = { type: 'endurance', status: 'planned', date: today, durationS: 4_200, load: 62 };

  it('dit avant l\'envoi ce que les réponses peuvent changer', () => {
    expect(lib.CHECK_IN_PURPOSE).toContain('disponibilité du jour');
    expect(lib.CHECK_IN_PURPOSE).toContain('sous 45');
    expect(lib.isOneSentence(lib.CHECK_IN_PURPOSE)).toBe(true);
  });

  it('dit la disponibilité avant et après, et une séance inchangée', () => {
    expect(lib.checkInEffect({
      before: { score: 50, verdict: 'amber' }, after: { score: 58, verdict: 'amber' }, today,
      session: { before: session, after: session },
    })).toBe('Ta disponibilité passe de 50 à 58 ; ta séance du jour ne change pas.');
  });

  it('dit de combien la séance est allégée, et le verdict atteint', () => {
    expect(lib.checkInEffect({
      before: { score: 50, verdict: 'amber' }, after: { score: 38, verdict: 'red' }, today,
      session: { before: session, after: { ...session, durationS: 1_800, load: 21 } },
    })).toBe('Ta disponibilité passe de 50 à 38, au rouge : ta séance du jour est allégée, 30 min au lieu de 1 h 10.');
  });

  it('dit un lendemain de test devenu repos, une disponibilité immobile, un jour sans séance', () => {
    expect(lib.checkInEffect({
      before: { score: 47, verdict: 'amber' }, after: { score: 41, verdict: 'red' }, today,
      session: { before: { ...session, type: 'recovery' }, after: { ...session, type: 'rest', durationS: 0, load: 0 } },
    })).toBe('Ta disponibilité passe de 47 à 41, au rouge : ta séance du jour devient un repos complet.');
    expect(lib.checkInEffect({
      before: { score: 50, verdict: 'amber' }, after: { score: 50, verdict: 'amber' }, today,
      session: { before: { ...session, date: '2026-09-24' }, after: { ...session, date: '2026-09-24' } },
    })).toBe('Ta disponibilité reste à 50 ; ta séance de demain ne change pas.');
    expect(lib.checkInEffect({
      before: { score: 70, verdict: 'green' }, after: { score: 72, verdict: 'green' }, today, session: null,
    })).toBe("Ta disponibilité passe de 70 à 72 ; aucune séance n'est prévue d'ici demain.");
  });
});

describe('Un paramètre qui s\'écarte de son test de laboratoire dit pourquoi', () => {
  const lab = PIERRE.labTests[0]!;
  // Le modèle du 22/09/2026, tel qu'enregistré, avec la preuve que le modèle
  // retient désormais : les vingt minutes à fond du 21/09.
  const model = {
    ...PIERRE_MODEL,
    asOf: '2026-09-22', criticalSpeedMs: 3.897, dPrimeM: 201, vmaMs: 4.918, vo2maxRel: 57.2,
    vt1: { hr: 155, speedMs: 3.002 }, vt2: { hr: 171, speedMs: 3.82 }, hrMax: 191, hrRest: 56,
    criticalSpeedEvidence: {
      support: 0.769, lastProofAgeDays: 1, weightLab: 0.116,
      proof: { durationS: 1200, speedMs: 3.958, ageDays: 1 },
    },
    provenance: { ...PIERRE_MODEL.provenance, hrRest: 'default' as const },
  };

  it('dit la VMA du labo, ce que le terrain en dit, et le poids qui reste au labo', () => {
    expect(lib.labGaps(model, lab).vma).toBe(
      "Ton labo disait 20 km/h, mesuré par paliers d'une minute ; le terrain la place à 16,5 km/h, " +
        "d'après ta vitesse critique. Le labo ne pèse plus que 34 % : il a 14 mois. " +
        'Ta VO2max suit dans la même proportion.',
    );
  });

  it('met le seuil 2 du labo face à l\'effort maximal qui le dément', () => {
    expect(lib.labGaps(model, lab).vt2).toBe(
      'Ton labo le plaçait à 16,8 km/h, au-dessus des 14,2 km/h que tu as tenus vingt minutes à fond le ' +
        "21/09 : ton seuil 2 se place juste sous ta vitesse critique. Le labo n'y pèse plus que 12 %.",
    );
    // Un modèle construit avant qu'on retienne la preuve la nomme par sa date.
    const older = { ...model, criticalSpeedEvidence: { ...model.criticalSpeedEvidence, proof: undefined } };
    expect(lib.labGaps(older, lab).vt2).toContain(
      "le terrain place ta vitesse critique à 14 km/h, d'après ton effort maximal du 21/09",
    );
  });

  it('dit d\'où viennent le seuil 1 et les deux fréquences cardiaques', () => {
    const gaps = lib.labGaps(model, lab);
    expect(gaps.vt1).toContain('il suit ton seuil 2 dans le même rapport qu\'au labo');
    expect(gaps.hrMax).toBe('Ton labo mesurait 187 bpm ; tes sorties montent plus haut, jusqu\'à 191 hors pics isolés.');
    expect(gaps.hrRest).toContain('debout et sous masque');
    expect(gaps.hrRest).toContain('56 est une estimation');
  });

  it('se tait sur un paramètre qui ne s\'écarte pas de son test, à la résolution du test près', () => {
    const fresh = { ...model, asOf: lab.date, vmaMs: lab.vmaMs + 0.1, vt2: { ...lab.vt2 }, vt1: { ...lab.vt1 }, hrMax: lab.hrMax };
    const gaps = lib.labGaps(fresh, lab);
    // 0,36 km/h d'écart, sous le palier de 0,8 km/h du protocole.
    expect(gaps.vma).toBeUndefined();
    expect(gaps.vt2).toBeUndefined();
    expect(gaps.vt1).toBeUndefined();
    expect(gaps.hrMax).toBeUndefined();
  });
});
