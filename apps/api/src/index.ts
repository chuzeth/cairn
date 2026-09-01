import { buildServer } from './server.js';
import { env, missingConfig } from './env.js';
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

  const shutdown = async () => {
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
