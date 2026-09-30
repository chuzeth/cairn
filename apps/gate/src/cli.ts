import { GateStore } from './store.js';

/**
 * Ce que `npm run service -- passkey | logout-all` exécute, sur la même base
 * que la porte. Le code s'affiche ici, dans le Terminal du Mac, et nulle part
 * ailleurs : c'est la preuve qu'un enregistrement vient de quelqu'un qui a le Mac
 * sous la main.
 */
const dbPath = process.env.CAIRN_AUTH_DB;
if (!dbPath) {
  console.error('CAIRN_AUTH_DB manquant.');
  process.exit(1);
}
const store = new GateStore(dbPath);
const now = Date.now();

switch (process.argv[2]) {
  case 'passkey': {
    const { code, expiresAt } = store.issueCode(now);
    const shown = `${code.slice(0, 4)}-${code.slice(4)}`;
    console.log(`\n    ${shown}\n`);
    console.log(`Code d'enregistrement, valable jusqu'à ${new Date(expiresAt).toLocaleTimeString('fr-FR')}, une seule fois.`);
    console.log('Sur le téléphone : ouvre Cairn, « Nouvel appareil », recopie le code, puis Face ID.');
    console.log(`Clés d'accès déjà enregistrées : ${store.passkeys().length}. Un code plus ancien ne vaut plus rien.`);
    break;
  }
  case 'logout-all': {
    const closed = store.closeAllSessions();
    console.log(`${closed} session${closed > 1 ? 's' : ''} fermée${closed > 1 ? 's' : ''} : chaque appareil redemandera Face ID. Les clés d'accès restent enregistrées.`);
    break;
  }
  default:
    console.error('usage : cli.ts passkey | logout-all');
    process.exit(1);
}
store.close();
