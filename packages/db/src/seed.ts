import { PIERRE } from '@cairn/core';
import { getAthlete, upsertAthlete, saveModel, getLatestModel } from './repo.js';
import { modelFromLabOnly } from '@cairn/physiology';
import { closeDb } from './client.js';

/**
 * Amorçage. Crée le profil de Pierre à partir de son test d'effort et pose un
 * modèle physiologique initial, pour que l'application soit exploitable avant
 * même la première synchronisation Strava.
 */
async function main() {
  const existing = await getAthlete(PIERRE.id);
  await upsertAthlete(PIERRE);
  console.log(existing ? `✓ Profil « ${PIERRE.name} » mis à jour.` : `✓ Profil « ${PIERRE.name} » créé.`);
  console.log(`  Test d'effort du ${PIERRE.labTests[0]?.date} importé.`);

  if (!(await getLatestModel(PIERRE.id))) {
    const lab = PIERRE.labTests[0];
    if (lab) {
      const model = modelFromLabOnly(lab, new Date().toISOString().slice(0, 10));
      await saveModel(PIERRE.id, model);
      console.log(
        `✓ Modèle physiologique initial : CS ${(model.criticalSpeedMs * 3.6).toFixed(2)} km/h, ` +
          `VMA ${(model.vmaMs * 3.6).toFixed(1)} km/h, confiance ${Math.round(model.confidence * 100)} %.`,
      );
      console.log('  La confiance montera avec la synchronisation Strava.');
    }
  }

  console.log('\nÉtape suivante : connecte Strava depuis http://localhost:3000 (ou /auth/strava sur l\'API).');
  closeDb();
}

main().catch((e) => {
  console.error('Échec de l\'amorçage :', e);
  process.exit(1);
});
