import { describe, expect, it } from 'vitest';
import { assertionJSON, fromB64u, lockedAtOpen, requestOf, toB64u } from '../apps/web/lib/lock';

/**
 * Face ID une fois par appareil (Pierre, le 10/11) : ce que l'app décide quand
 * la porte a répondu — ou n'a pas répondu —, et ce qu'elle échange avec elle.
 *
 * Le 02/10, c'était Face ID à chaque ouverture. Le téléphone sert quand le Mac
 * dort : la porte ne répondait pas, l'app demandait Face ID au téléphone seul,
 * par la feuille d'iOS qui nomme l'adresse du Mac — et le redemandait à chaque
 * changement d'écran, chaque écran se rechargeant faute de réseau.
 */

describe('Quand l’app se verrouille', () => {
  it('ne se verrouille jamais sans porte : sur le Mac, le site se sert sans connexion', () => {
    expect(lockedAtOpen(false, null)).toBe(false);
    expect(lockedAtOpen(false, { session: false })).toBe(false);
  });

  it('ne demande rien quand le Mac dort : la porte muette ne verrouille pas', () => {
    expect(lockedAtOpen(true, null)).toBe(false);
  });

  it('ne redemande pas Face ID à une session ouverte, quel que soit son âge', () => {
    expect(lockedAtOpen(true, { session: true, verifiedAgoS: 4, seenAgoS: 4 })).toBe(false);
    // Le lendemain matin, puis trois semaines plus tard.
    expect(lockedAtOpen(true, { session: true, verifiedAgoS: 14 * 3600, seenAgoS: 14 * 3600 })).toBe(false);
    expect(lockedAtOpen(true, { session: true, verifiedAgoS: 21 * 86_400, seenAgoS: 21 * 86_400 })).toBe(false);
  });

  it('demande Face ID quand la porte dit qu’il n’y a plus de session, et seulement là', () => {
    expect(lockedAtOpen(true, { session: false })).toBe(true);
  });
});

describe('Ce que l’app échange avec la porte', () => {
  const bytes = (...b: number[]) => new Uint8Array(b).buffer;

  it('écrit et relit le base64url de WebAuthn, octet pour octet', () => {
    const raw = bytes(0, 251, 255, 62, 63, 1, 2);
    expect(toB64u(raw)).toBe('APv_Pj8BAg');
    expect(new Uint8Array(fromB64u('APv_Pj8BAg'))).toEqual(new Uint8Array(raw));
  });

  it('demande au téléphone une vérification de l’utilisateur — Face ID, pas un simple toucher', () => {
    const request = requestOf({
      challenge: 'APv_Pj8BAg', rpId: 'cairn.example', timeout: 60_000, userVerification: 'preferred',
      allowCredentials: [{ id: 'AQID', type: 'public-key', transports: ['internal'] }],
    });
    expect(new Uint8Array(request.challenge as ArrayBuffer)).toEqual(new Uint8Array(bytes(0, 251, 255, 62, 63, 1, 2)));
    expect(request.userVerification).toBe('required');
    expect(request.rpId).toBe('cairn.example');
    expect(new Uint8Array(request.allowCredentials![0]!.id as ArrayBuffer)).toEqual(new Uint8Array(bytes(1, 2, 3)));
  });

  it('rend l’assertion du téléphone dans la forme que la porte vérifie', () => {
    const json = assertionJSON({
      id: 'AQID', rawId: bytes(1, 2, 3), type: 'public-key', authenticatorAttachment: 'platform',
      response: {
        clientDataJSON: bytes(4), authenticatorData: bytes(5), signature: bytes(6), userHandle: bytes(7),
      },
      getClientExtensionResults: () => ({}),
    });
    expect(json).toEqual({
      id: 'AQID', rawId: 'AQID', type: 'public-key', authenticatorAttachment: 'platform', clientExtensionResults: {},
      response: { clientDataJSON: 'BA', authenticatorData: 'BQ', signature: 'Bg', userHandle: 'Bw' },
    });
  });
});
