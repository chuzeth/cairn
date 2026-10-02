/**
 * Face ID à chaque ouverture de l'app.
 *
 * Le 02/10, Pierre : « Face ID à chaque ouverture de l'app. » La porte ouvrait
 * une session de 90 jours : Face ID une fois, au premier jour, puis plus
 * jamais. Elle la ferme maintenant après deux minutes sans requête
 * (`apps/gate/src/store.ts`) ; l'app, elle, se verrouille à chaque ouverture et
 * au retour après une minute ailleurs, et se déverrouille par la même cérémonie
 * que la page de connexion de la porte. Une minute ailleurs ne compte pas :
 * passer voir Garmin Connect et revenir ne redemande rien.
 *
 * Mac éteint, la porte ne répond pas et ne peut rien vérifier : c'est le
 * téléphone qui demande Face ID, sur la même clé d'accès, et l'app s'ouvre sur
 * sa dernière lecture. Sans porte du tout — sur le Mac, `http://localhost` —,
 * rien ne se verrouille.
 */

/** Au-delà d'une minute ailleurs, revenir redemande Face ID. */
export const GRACE_MS = 60_000;
/** L'app ouverte le dit à la porte : sa session reste ouverte tant qu'elle sert. */
export const HEARTBEAT_MS = 30_000;
/** Ce que l'app attend la porte avant de se tenir pour hors réseau. */
export const GATE_WAIT_MS = 3_000;

/** Ce que la porte dit de la session (`GET /connexion/etat`). */
export interface GateState {
  session: boolean;
  /** Depuis quand Face ID a eu lieu, s. */
  verifiedAgoS?: number;
  /** Depuis quand la session a servi, s — lu avant que la requête ne la repousse. */
  seenAgoS?: number;
}

/** L'app passe-t-elle par la porte ? Funnel et le tailnet servent en HTTPS ; le Mac seul, en HTTP. */
export const behindGate = (location: Pick<Location, 'protocol'>): boolean => location.protocol === 'https:';

/**
 * À l'ouverture : verrouillée, sauf si Face ID vient d'avoir lieu — la page de
 * connexion renvoie vers l'app — ou si l'app servait il y a moins d'une minute.
 * Hors réseau (`state` nul), toujours.
 */
export function lockedAtOpen(gated: boolean, state: GateState | null): boolean {
  if (!gated) return false;
  if (!state?.session) return true;
  const recent = Math.min(state.verifiedAgoS ?? Infinity, state.seenAgoS ?? Infinity);
  return recent * 1000 >= GRACE_MS;
}

/** Au retour au premier plan : verrouillée après une minute ailleurs. */
export const lockedAtReturn = (hiddenForMs: number): boolean => hiddenForMs >= GRACE_MS;

// ── WebAuthn, sans bibliothèque ─────────────────────────────────────────────
//
// La porte parle le JSON de SimpleWebAuthn (base64url) ; le navigateur, des
// octets. La page de connexion charge SimpleWebAuthn depuis la porte — que
// l'app ne joint plus quand le Mac est éteint. Ces quelques lignes suffisent.

export function toB64u(buffer: ArrayBuffer): string {
  let binary = '';
  for (const b of new Uint8Array(buffer)) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function fromB64u(text: string): ArrayBuffer {
  const base64 = text.replace(/-/g, '+').replace(/_/g, '/').padEnd(Math.ceil(text.length / 4) * 4, '=');
  const binary = atob(base64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out.buffer;
}

/** Les options de la porte, telles que le téléphone les attend. Face ID exigé, quoi qu'elles disent. */
export function requestOf(options: {
  challenge: string;
  rpId?: string;
  timeout?: number;
  userVerification?: string;
  allowCredentials?: { id: string; type?: string; transports?: string[] }[];
}): PublicKeyCredentialRequestOptions {
  return {
    challenge: fromB64u(options.challenge),
    ...(options.rpId ? { rpId: options.rpId } : {}),
    ...(options.timeout ? { timeout: options.timeout } : {}),
    userVerification: 'required',
    ...(options.allowCredentials
      ? {
          allowCredentials: options.allowCredentials.map((c) => ({
            id: fromB64u(c.id),
            type: 'public-key' as const,
            ...(c.transports ? { transports: c.transports as AuthenticatorTransport[] } : {}),
          })),
        }
      : {}),
  };
}

/** Ce que le navigateur rend d'une assertion, réduit à ce que la porte lit. */
export interface AssertionLike {
  id: string;
  rawId: ArrayBuffer;
  type: string;
  authenticatorAttachment?: string | null;
  response: {
    clientDataJSON: ArrayBuffer;
    authenticatorData: ArrayBuffer;
    signature: ArrayBuffer;
    userHandle?: ArrayBuffer | null;
  };
  getClientExtensionResults: () => object;
}

/** L'assertion du téléphone, dans la forme que la porte vérifie (`/connexion/verifier`). */
export function assertionJSON(credential: AssertionLike) {
  const r = credential.response;
  return {
    id: credential.id,
    rawId: toB64u(credential.rawId),
    type: credential.type,
    ...(credential.authenticatorAttachment ? { authenticatorAttachment: credential.authenticatorAttachment } : {}),
    clientExtensionResults: credential.getClientExtensionResults(),
    response: {
      clientDataJSON: toB64u(r.clientDataJSON),
      authenticatorData: toB64u(r.authenticatorData),
      signature: toB64u(r.signature),
      ...(r.userHandle ? { userHandle: toB64u(r.userHandle) } : {}),
    },
  };
}
