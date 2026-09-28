import { writtenOn } from '@cairn/core';
import * as db from '@cairn/db';
import { addDays } from './periodization.js';
import { remeasured } from './sessionLibrary.js';
import { currentModel } from './state.js';

/**
 * Le recompte : ce que pèsent les séances décidées avec le modèle du jour.
 *
 * Une décision fixe un contenu — date, type, durée, dénivelé —, pas une charge.
 * Le modèle bouge après chaque sortie : allures faciles, vitesse critique,
 * seuils. Une charge comptée le jour de la décision et laissée en place décrit
 * une séance que le modèle d'aujourd'hui ne compte plus ainsi, et les ratios du
 * plan la lisent telle quelle : les rando-courses du 27/09 et du 03/10, décidées
 * à 138 et 140 points, en valent 178, et le ratio métabolique du 27/09 passait
 * son seuil sans que le plan le voie.
 *
 * Il se fait à chaque relève et après chaque sortie importée, avant que les
 * règles ne jugent le plan : si une charge remesurée franchit un seuil, ce sont
 * elles qui décident. Il n'écrit que ce qui change, et le journal du plan le dit.
 */
export async function recountDecisions(
  athleteId: string,
  today: string,
): Promise<{ date: string; before: string; after: string; reason: string }[]> {
  const plan = await db.getActivePlan(athleteId);
  if (!plan) return [];
  const decided = (await db.listPlannedSessions(athleteId, today, addDays(today, 400))).filter(
    (s) => s.status === 'planned' && s.decision != null,
  );
  if (decided.length === 0) return [];

  const model = await currentModel(athleteId);
  const changes: { date: string; before: string; after: string; reason: string }[] = [];
  for (const s of decided) {
    const m = remeasured(s, model);
    if (
      m.plannedLoad === s.plannedLoad &&
      m.plannedMechanicalLoad === s.plannedMechanicalLoad &&
      m.plannedDistanceM === s.plannedDistanceM
    ) {
      continue;
    }
    const loads = (x: typeof s) => `charge ${x.plannedLoad}, charge mécanique ${x.plannedMechanicalLoad}`;
    changes.push({
      date: s.date,
      before: loads(s),
      after: loads(m),
      reason: `Même contenu — durée, dénivelé, blocs —, charge comptée avec le modèle du ${writtenOn(model.asOf)}.`,
    });
    await db.updateSession(s.id, {
      plannedLoad: m.plannedLoad,
      plannedMechanicalLoad: m.plannedMechanicalLoad,
      plannedDistanceM: m.plannedDistanceM ?? null,
    });
  }

  if (changes.length > 0) {
    await db.appendPlanRevision(plan.plan.id, {
      at: new Date().toISOString(),
      trigger: 'recount',
      summary: `${changes.length} séance(s) décidée(s) remesurée(s) avec le modèle du jour, sans reconstruction.`,
      changes,
    });
  }
  return changes;
}
