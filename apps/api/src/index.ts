import { buildServer } from './server.js';
import { env, missingConfig } from './env.js';
import { startActivityPoller, stopActivityPoller } from './poller.js';
import { backfill } from './sync.js';
import { closeDb } from '@cairn/db';

async function main() {
  const app = await buildServer();

  const missing = missingConfig();
  if (missing.length) {
    app.log.warn(
      `Configuration incomplète : ${missing.join(', ')}. ` +
        `L'API démarre quand même, mais les fonctions concernées seront indisponibles. ` +
        `Renseigne le fichier .env à la racine du projet.`,
    );
  }

  await app.listen({ port: env.port, host: env.host });

  app.log.info(`Cairn API → http://localhost:${env.port}`);
  app.log.info(`Connexion Strava → http://localhost:${env.port}/auth/strava`);

  // La relève tourne tant que l'API tourne : c'est elle qui fait entrer les
  // séances, faute de webhook. Son état est lisible sur /health.
  const poller = await startActivityPoller({
    athleteId: env.athleteId,
    intervalMs: env.pollIntervalMs,
    run: backfill,
    log: (level, message) => app.log[level](message),
  });
  const status = poller.status();
  app.log.info(
    status.enabled
      ? `Relève Strava toutes les ${Math.round(status.intervalMs / 60_000)} min → prochaine à ${status.nextRunAt}`
      : `Relève Strava désactivée (CAIRN_POLL_INTERVAL_MIN=0) : les nouvelles séances n'entreront que sur /api/sync.`,
  );

  const shutdown = async () => {
    stopActivityPoller();
    await app.close();
    closeDb();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

main().catch((e) => {
  console.error('Démarrage impossible :', e);
  process.exit(1);
});
