/**
 * La page de connexion : seule page que la porte sert sans session.
 *
 * Tout y est en ligne — style, script, dessin — sauf SimpleWebAuthn et les deux
 * polices de l'app, servis par la porte elle-même sous `/connexion/` : sans
 * session, rien de l'app n'est joignable, pas même une feuille de style. Depuis
 * le 21/10, elle a le style de l'app — Bodoni, papier chaud, angles droits — et
 * s'ouvre dans le thème qu'on y a choisi : la porte et l'app partagent l'origine,
 * donc le `localStorage` où il est gardé.
 *
 * Le 14/10, Pierre : « une petite page de chargement et un petit Face ID ».
 * La page est l'écran d'ouverture de l'app — le papier, les courbes de niveau,
 * le nom —, et Face ID se lance seul (iOS 17.4 et après n'exigent plus de
 * geste). Le bouton n'apparaît que si Face ID n'a pas abouti. L'enregistrement
 * d'un nouvel appareil, qui demande un code du Mac, ne se montre que sur demande.
 *
 * Au chargement, elle demande d'abord `/connexion/etat`. Le cookie de session
 * est `SameSite=Strict` : une navigation qui arrive d'ailleurs — un lien dans
 * Messages, le retour de Strava — ne le porte pas, et atterrit ici alors que la
 * session est valide. Cette requête-là part de la page, donc du même site : elle
 * porte le cookie, et la page repart aussitôt vers `suite`, sans Face ID.
 *
 * Chaque échec est dit à la porte (`/connexion/journal`) : le 14/10, douze jours
 * sans une connexion réussie n'avaient laissé aucune trace.
 */
export function loginPage(suite: string, nonce: string): string {
  const target = JSON.stringify(suite).replace(/</g, '\\u003c');
  return `<!doctype html><html lang="fr"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1,viewport-fit=cover">
<meta name="robots" content="noindex">
<meta name="theme-color" content="#F7F3EC">
<title>Cairn</title>
<script nonce="${nonce}">
(function () {
  var t = 'light';
  try { if (localStorage.getItem('cairn:theme') === 'dark') t = 'dark'; } catch (e) {}
  document.documentElement.dataset.theme = t;
  if (t === 'dark') document.querySelector('meta[name="theme-color"]').setAttribute('content', '#13110F');
})();
</script>
<style>
  @font-face { font-family:"Bodoni Moda"; font-style:normal; font-weight:400 900; font-display:swap;
               src:url("/connexion/polices/serif.woff2") format("woff2"); }
  @font-face { font-family:"Inter Tight"; font-style:normal; font-weight:100 900; font-display:swap;
               src:url("/connexion/polices/sans.woff2") format("woff2"); }
  :root { color-scheme:light; --paper:#F7F3EC; --ink:#1C1915; --ink2:#4A433B; --muted:#6B6359;
          --line:#E2DACD; --field:#FBF8F3; --accent:#A8432A; --topo:#E2DACD; }
  [data-theme="dark"] { color-scheme:dark; --paper:#13110F; --ink:#F1ECE3; --ink2:#CFC7BB; --muted:#A69D90;
          --line:#2E2A25; --field:#1A1815; --accent:#E58A6A; --topo:#2E2A25; }
  * { box-sizing:border-box; }
  html, body { margin:0; height:100%; background:var(--paper); color:var(--ink);
               font:15px/1.5 "Inter Tight", "Helvetica Neue", system-ui, sans-serif; -webkit-font-smoothing:antialiased; }
  body { display:flex; flex-direction:column; min-height:100%;
         padding:calc(env(safe-area-inset-top) + 24px) 24px calc(env(safe-area-inset-bottom) + 24px); overflow:hidden; }
  .topo { position:fixed; left:-10%; bottom:-6%; width:120%; height:62%; pointer-events:none; }
  .topo path { fill:none; stroke:var(--topo); stroke-width:1; }
  .topo g { animation:drift 26s ease-in-out infinite alternate; transform-origin:50% 50%; }
  @keyframes drift { from { transform:translate3d(-2%,0,0); } to { transform:translate3d(2%,-1.5%,0); } }
  main { position:relative; flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center;
         text-align:center; max-width:360px; width:100%; margin:0 auto; }
  h1 { font-family:"Bodoni Moda", "Bodoni 72", Didot, Georgia, serif; font-weight:500; font-size:52px; line-height:1;
       letter-spacing:.14em; text-transform:uppercase; margin:0; animation:rise .9s cubic-bezier(.2,.8,.2,1) both; }
  .sub { margin:10px 0 0; font-size:12px; letter-spacing:.14em; text-transform:uppercase; color:var(--muted);
         animation:rise .9s .12s cubic-bezier(.2,.8,.2,1) both; }
  @keyframes rise { from { opacity:0; transform:translateY(14px); } to { opacity:1; transform:none; } }
  .face { margin-top:56px; min-height:92px; width:100%; display:flex; flex-direction:column; align-items:center; gap:14px; }
  .glyph { width:40px; height:40px; color:var(--accent); }
  .waiting .glyph { animation:breathe 1.6s ease-in-out infinite; }
  @keyframes breathe { 50% { opacity:.35; transform:scale(.92); } }
  .status { font-size:14px; color:var(--muted); min-height:1.5em; }
  button.primary { display:none; align-items:center; justify-content:center; gap:10px; width:100%; height:54px;
                   border:0; border-radius:0; background:var(--ink); color:var(--paper); font:inherit; font-size:12px;
                   font-weight:500; letter-spacing:.16em; text-transform:uppercase; }
  button.primary svg { width:20px; height:20px; }
  .failed button.primary { display:flex; }
  .failed .glyph { display:none; }
  #message { min-height:1.5em; margin:14px 0 0; font-size:14px; color:var(--accent); }
  footer { position:relative; text-align:center; }
  .link { background:none; border:0; padding:12px 8px; font:inherit; font-size:11px; letter-spacing:.14em;
          text-transform:uppercase; color:var(--muted); }
  #device { display:none; max-width:360px; margin:8px auto 0; text-align:left; }
  #device.open { display:block; }
  #device p { margin:0 0 12px; font-size:14px; color:var(--ink2); }
  code { font:13px ui-monospace, Menlo, monospace; }
  input { width:100%; margin:0 0 10px; padding:13px 14px; border:1px solid var(--ink); border-radius:0;
          background:var(--field); color:var(--ink); font:20px/1.2 ui-monospace, Menlo, monospace;
          letter-spacing:.12em; text-transform:uppercase; }
  button.secondary { width:100%; height:54px; border:1px solid var(--ink); border-radius:0; background:transparent;
                     color:var(--ink); font:inherit; font-size:12px; font-weight:500; letter-spacing:.16em; text-transform:uppercase; }
  button:disabled { opacity:.5; }
  @media (prefers-reduced-motion: reduce) { * { animation:none !important; } }
</style></head><body>
<svg class="topo" viewBox="0 0 400 300" preserveAspectRatio="xMidYMid slice" aria-hidden="true"><g>
  <path d="M-20 70 C 60 40, 120 92, 196 62 S 330 26, 420 54"/>
  <path d="M-20 104 C 70 74, 132 124, 204 96 S 330 62, 420 88"/>
  <path d="M-20 138 C 80 110, 142 156, 214 130 S 338 98, 420 122"/>
  <path d="M-20 172 C 92 146, 152 188, 224 164 S 346 134, 420 156"/>
  <path d="M-20 206 C 104 182, 164 220, 236 198 S 356 170, 420 190"/>
  <path d="M-20 240 C 116 218, 176 252, 248 232 S 366 206, 420 224"/>
  <path d="M146 150 C 170 132, 214 134, 226 150 S 196 176, 170 170 S 128 164, 146 150 Z"/>
  <path d="M164 152 C 178 142, 204 144, 210 153 S 192 166, 178 163 S 154 160, 164 152 Z"/>
</g></svg>
<main>
  <h1>Cairn</h1>
  <p class="sub">Coaching trail</p>
  <div class="face waiting" id="face">
    <svg class="glyph" viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="M6 16v-5a5 5 0 0 1 5-5h5M32 6h5a5 5 0 0 1 5 5v5M42 32v5a5 5 0 0 1-5 5h-5M16 42h-5a5 5 0 0 1-5-5v-5"/>
      <path d="M17 18v4M31 18v4M24 18v9h-2M18 32c3.5 3 8.5 3 12 0"/>
    </svg>
    <button id="login" class="primary" type="button">
      <svg viewBox="0 0 48 48" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M6 16v-5a5 5 0 0 1 5-5h5M32 6h5a5 5 0 0 1 5 5v5M42 32v5a5 5 0 0 1-5 5h-5M16 42h-5a5 5 0 0 1-5-5v-5"/>
        <path d="M17 18v4M31 18v4M24 18v9h-2M18 32c3.5 3 8.5 3 12 0"/>
      </svg>
      Déverrouiller
    </button>
    <span class="status" id="status" role="status">Face ID…</span>
  </div>
  <p id="message" role="alert"></p>
</main>
<footer>
  <button class="link" id="new-device" type="button">Nouvel appareil</button>
  <div id="device">
    <p>Sur le Mac, dans le Terminal : <code>npm run service -- passkey</code>. Recopie ici le code affiché — il vaut dix minutes, une seule fois.</p>
    <input id="code" autocomplete="one-time-code" autocapitalize="characters" spellcheck="false" placeholder="XXXX-XXXX" maxlength="12">
    <button id="register" class="secondary" type="button">Enregistrer une clé d'accès</button>
  </div>
</footer>
<script src="/connexion/webauthn.js"></script>
<script nonce="${nonce}">
const suite = ${target};
const face = document.getElementById('face');
const status = document.getElementById('status');
const message = document.getElementById('message');
const say = (text) => { message.textContent = text; };
const go = () => location.replace(suite);
const standalone = window.matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;

/** Ce que la page dit à la porte d'un échec : le journal du Mac le garde. */
function report(evenement, detail) {
  fetch('/connexion/journal', {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, keepalive: true,
    body: JSON.stringify({ evenement, detail: (standalone ? 'app · ' : 'navigateur · ') + detail }),
  }).catch(() => {});
}

async function call(path, body) {
  const res = await fetch(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body ?? {}),
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || 'Erreur ' + res.status);
  return data;
}

const { startAuthentication, startRegistration } = SimpleWebAuthnBrowser;
let busy = false;

/** Face ID : seul à l'ouverture, au bouton ensuite. */
async function login(auto) {
  if (busy) return;
  busy = true;
  face.className = 'face waiting';
  status.textContent = 'Face ID…';
  say('');
  try {
    const optionsJSON = await call('/connexion/options');
    await call('/connexion/verifier', await startAuthentication({ optionsJSON }));
    status.textContent = 'Ouverture…';
    go();
  } catch (e) {
    const name = (e && (e.cause && e.cause.name || e.name)) || 'Error';
    report(auto ? 'Face ID automatique sans suite' : 'Face ID échoué', name + ' : ' + ((e && e.message) || String(e)));
    face.className = 'face failed';
    status.textContent = '';
    if (name !== 'NotAllowedError') say((e && e.message) || String(e));
  } finally {
    busy = false;
  }
}

document.getElementById('login').addEventListener('click', () => login(false));

document.getElementById('new-device').addEventListener('click', () => {
  document.getElementById('device').classList.toggle('open');
});

document.getElementById('register').addEventListener('click', async (event) => {
  const button = event.currentTarget;
  button.disabled = true;
  say('');
  try {
    const code = document.getElementById('code').value;
    const optionsJSON = await call('/connexion/enregistrement/options', { code });
    await call('/connexion/enregistrement/verifier', await startRegistration({ optionsJSON }));
    go();
  } catch (e) {
    report('enregistrement échoué', ((e && e.name) || 'Error') + ' : ' + ((e && e.message) || String(e)));
    say(e && e.name === 'NotAllowedError' ? 'Annulé.' : (e && e.message) || String(e));
  } finally {
    button.disabled = false;
  }
});

fetch('/connexion/etat', { cache: 'no-store' })
  .then((res) => res.json())
  .then((etat) => { if (etat.session) go(); else login(true); })
  .catch(() => login(true));
</script>
</body></html>`;
}
