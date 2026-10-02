import { describe, expect, it } from 'vitest';
import {
  GRACE_MS, assertionJSON, fromB64u, lockedAtOpen, lockedAtReturn, requestOf, toB64u,
} from '../apps/web/lib/lock';

/**
 * Face ID à chaque ouverture de l'app (Pierre, le 02/10) : ce que l'app décide
 * à l'ouverture et au retour, et ce qu'elle échange avec la porte.
 */

describe('Quand l’app se verrouille', () => {
  it('ne se verrouille jamais sans porte : sur le Mac, le site se sert sans connexion', () => {
    expect(lockedAtOpen(false, null)).toBe(false);
    expect(lockedAtOpen(false, { session: false })).toBe(false);
  });

  it('se verrouille à chaque ouverture, réseau ou pas', () => {
    // Hors réseau, la porte ne répond pas : Face ID se vérifie sur le téléphone.
    expect(lockedAtOpen(true, null)).toBe(true);
    expect(lockedAtOpen(true, { session: false })).toBe(true);
    expect(lockedAtOpen(true, { session: true, verifiedAgoS: 3600, seenAgoS: 90 })).toBe(true);
  });

  it('ne redemande pas Face ID qui vient d’avoir lieu, ni après une minute ailleurs', () => {
    // La page de connexion vient de l'obtenir et renvoie vers l'app.
    expect(lockedAtOpen(true, { session: true, verifiedAgoS: 4, seenAgoS: 4 })).toBe(false);
    // iOS a refermé l'app il y a trente secondes, on la rouvre.
    expect(lockedAtOpen(true, { session: true, verifiedAgoS: 3600, seenAgoS: 30 })).toBe(false);
  });

  it('se verrouille au retour après une minute ailleurs, pas avant', () => {
    expect(lockedAtReturn(GRACE_MS - 1000)).toBe(false);
    expect(lockedAtReturn(GRACE_MS)).toBe(true);
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
