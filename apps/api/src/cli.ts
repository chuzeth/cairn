/**
 * Outil en ligne de commande — import, ré-analyse, souscription webhook.
 * Utile pour les opérations longues qu'on ne veut pas lancer depuis le navigateur.
 */
import { closeDb, findStaleAnalyses, getLatestModel } from '@cairn/db';
import { analyzeAndStore, rebuildPhysiologyModel } from '@cairn/coach';
import { env } from './env.js';
import { backfill, stravaClientFor } from './sync.js';

const [command, ...args] = process.argv.slice(2);
const A = env.athleteId;

async function main() {
  switch (command) {
    case 'sync': {
      const max = Number(args[0] ?? 40);
      console.log(`Import de ${max} activité(s) au maximum…`);
      const result = await backfill(A, { maxActivities: max, withInsights: false });
      console.log(result.message);
      if (result.errors.length) console.log('Erreurs :', result.errors);
      break;
    }
    case 'reanalyze': {
      const model = (await getLatestModel(A)) ?? (await rebuildPhysiologyModel(A));
      const stale = await findStaleAnalyses(A, Number(args[0] ?? 500));
      console.log(`${stale.length} activité(s) à ré-analyser…`);
      let done = 0;
      for (const id of stale) {
        await analyzeAndStore(A, id, model);
        if (++done % 25 === 0) console.log(`  ${done}/${stale.length}`);
      }
      await rebuildPhysiologyModel(A);
      console.log('Terminé.');
      break;
    }
    case 'webhook': {
      const client = stravaClientFor(A);
      const callback = `${env.publicBaseUrl}/webhook/strava`;
      const subs = await client.listSubscriptions();
      console.log('Souscriptions existantes :', subs);
      if (!subs.some((s) => s.callback_url === callback)) {
        for (const s of subs) await client.deleteSubscription(s.id);
        const created = await client.createSubscription(callback, env.webhookVerifyToken);
        console.log('Souscription créée :', created);
      } else {
        console.log('Souscription déjà en place.');
      }
      break;
    }
    case 'model': {
      const model = await rebuildPhysiologyModel(A);
      console.log(JSON.stringify(model, null, 2));
      break;
    }
    default:
      console.log(`Commandes disponibles :
  sync [n]        importe jusqu'à n activités Strava (défaut 40)
  reanalyze [n]   ré-analyse les activités dont l'analyse est périmée
  webhook         crée ou vérifie la souscription webhook Strava
  model           recalcule et affiche le modèle physiologique`);
  }
  closeDb();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
