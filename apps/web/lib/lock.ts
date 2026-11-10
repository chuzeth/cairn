/**
 * Face ID une fois par appareil.
 *
 * Le 02/10, Pierre : « Face ID à chaque ouverture de l'app. » La porte fermait
 * la session après deux minutes sans requête, et l'app se verrouillait à chaque
 * ouverture — par la porte quand elle répondait, par le téléphone seul quand le
 * Mac dormait. Or le téléphone sert surtout quand le Mac dort : du 20/10 au
 * 10/11, pas une session ne s'est ouverte. Chaque ouverture, puis chaque
 * changement d'écran — hors réseau, un écran se recharge —, montrait la feuille
 * d'iOS : « se connecter à …ts.net avec la clé d'accès pierre ». Cette feuille
 * est celle du système ; un site ne la réécrit pas, il ne peut que ne pas la
 * demander.
 *
 * Le 10/11 : « Il faut simplement le faire une fois au début. » La session dure
 * tant que l'appareil sert (`apps/gate/src/store.ts`), et l'app ne demande Face
 * ID que lorsque la porte dit qu'il n'y a plus de session — à la première
 * ouverture d'un appareil, puis après quatre-vingt-dix jours sans l'ouvrir, ou
 * un `logout-all`. Mac éteint, rien n'est demandé : l'app s'ouvre sur ce qu'elle
 * a gardé, et le dit. Ce qui la protège alors est ce qui protège le téléphone.
 */

/** Ce que l'app attend la porte, à l'ouverture, pour savoir où en est sa session. */
export const GATE_WAIT_MS = 5_000;

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
 * Verrouillée seulement quand la porte a répondu qu'il n'y a pas de session.
 * Une porte muette (`state` nul) — le Mac dort — ne verrouille rien : elle ne
 * pourrait rien vérifier, et il n'y a rien de neuf à protéger.
 */
export function lockedAtOpen(gated: boolean, state: GateState | null): boolean {
  return gated && state != null && !state.session;
}

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
