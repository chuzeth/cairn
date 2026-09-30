/**
 * La page de connexion : seule page que la porte sert sans session.
 *
 * Tout y est en ligne — style et script — sauf SimpleWebAuthn, servi par la
 * porte elle-même sous `/connexion/webauthn.js` : sans session, rien de l'app
 * n'est joignable, pas même une feuille de style.
 *
 * Au chargement, elle demande d'abord `/connexion/etat`. Le cookie de session
 * est `SameSite=Strict` : une navigation qui arrive d'ailleurs — un lien dans
 * Messages, le retour de Strava — ne le porte pas, et atterrit ici alors que la
 * session est valide. Cette requête-là part de la page, donc du même site : elle
 * porte le cookie, et la page repart aussitôt vers `suite`, sans Face ID.
 */
export function loginPage(suite: string, nonce: string): string {
  const target = JSON.stringify(suite).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<title>Cairn — connexion</title>
<style>
  :root { color-scheme: dark; }
  body { margin:0; padding:calc(env(safe-area-inset-top) + 48px) 20px 48px;
         background:#0e1316; color:#ece8df;
         font:16px/1.5 -apple-system, system-ui, sans-serif; }
  main { max-width:420px; margin:0 auto; }
  h1 { font-size:28px; line-height:1.1; margin:0 0 12px; font-weight:640; }
  h2 { font-size:17px; margin:40px 0 8px; font-weight:600; }
  p { margin:0 0 20px; color:#98a09c; font-size:15px; }
  button { display:block; width:100%; padding:14px; border:0; border-radius:12px;
           background:#ece8df; color:#0e1316; font:inherit; font-weight:600; }
  button.secondary { background:#1b2327; color:#ece8df; }
  button:disabled { opacity:.5; }
  input { box-sizing:border-box; width:100%; margin:0 0 12px; padding:13px 14px;
          border:1px solid #343d40; border-radius:12px; background:#0e1316; color:#ece8df;
          font:20px/1.2 ui-monospace, Menlo, monospace; letter-spacing:.12em; text-transform:uppercase; }
  code { color:#ece8df; }
  #message { min-height:1.5em; margin-top:20px; color:#e0a47a; }
</style></head><body><main>
<h1>Cairn</h1>
<p>Cet appareil n'a pas de session ouverte.</p>
<button id="login">Se connecter avec Face ID</button>
<h2>Nouvel appareil</h2>
<p>Sur le Mac, dans le Terminal : <code>npm run service -- passkey</code>. Recopie ici le code
affiché — il vaut dix minutes, une seule fois.</p>
<input id="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" maxlength="12">
<button id="register" class="secondary">Enregistrer une clé d'accès</button>
<p id="message" role="status"></p>
</main>
<script src="/connexion/webauthn.js"></script>
<script nonce="${nonce}">
const suite = ${target};
const message = document.getElementById('message');
const say = (text) => { message.textContent = text; };
const go = () => location.replace(suite);

fetch('/connexion/etat', { cache: 'no-store' })
  .then((res) => res.json()).then((etat) => { if (etat.session) go(); }).catch(() => {});

async function call(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
  return data;
}

async function ceremony(button, run) {
  const buttons = document.querySelectorAll('button');
  buttons.forEach((b) => { b.disabled = true; });
  say('');
  try {
    await run();
    go();
  } catch (e) {
    say(e && e.name === 'NotAllowedError' ? 'Annulé.' : (e && e.message) || String(e));
  } finally {
    buttons.forEach((b) => { b.disabled = false; });
  }
}

const { startAuthentication, startRegistration } = SimpleWebAuthnBrowser;

document.getElementById('login').addEventListener('click', (event) => ceremony(event.target, async () => {
  const optionsJSON = await call('/connexion/options');
  await call('/connexion/verifier', await startAuthentication({ optionsJSON }));
}));

document.getElementById('register').addEventListener('click', (event) => ceremony(event.target, async () => {
  const code = document.getElementById('code').value;
  const optionsJSON = await call('/connexion/enregistrement/options', { code });
  await call('/connexion/enregistrement/verifier', await startRegistration({ optionsJSON }));
}));
</script>
</body></html>`;
}
