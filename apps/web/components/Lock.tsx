'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  GATE_WAIT_MS, HEARTBEAT_MS, assertionJSON, behindGate, lockedAtOpen, lockedAtReturn, requestOf,
  type AssertionLike, type GateState,
} from '@/lib/lock';
import { BUILD, updateAtUnlock } from '@/lib/version';
import { FaceGlyph, Topo } from '@/components/Topo';

/**
 * L'écran qui précède l'app : Face ID à chaque ouverture (`lib/lock.ts`).
 *
 * Le 14/10, Pierre : « une petite page de chargement et un petit Face ID ».
 * L'écran est celui d'ouverture — le papier, les courbes de niveau, le nom —,
 * Face ID se lance seul, et le bouton n'apparaît que s'il n'a pas abouti. Une
 * fois Face ID passé par la porte, l'app se met à jour avant de se montrer :
 * elle s'ouvre sur la dernière version, jamais sur celle d'il y a douze jours.
 *
 * À l'ouverture, rien de l'app ne se monte avant la réponse de la porte — ni
 * écran, ni lecture : ce qu'on ne voit pas encore ne doit pas non plus partir
 * sur le réseau. Au retour après une minute ailleurs, l'app reste montée, sous
 * l'écran. Pendant qu'elle passe en arrière-plan, l'écran d'ouverture la couvre :
 * la vignette du sélecteur d'apps ne montre pas la séance du jour.
 *
 * Le déverrouillage passe par la cérémonie de la porte, signature vérifiée sur
 * le Mac. Mac éteint, la porte ne répond pas : le téléphone demande Face ID sur
 * la même clé d'accès, et l'app s'ouvre sur sa dernière lecture. Chaque échec
 * est dit à la porte quand elle répond (`/connexion/journal`).
 */

type Phase = 'checking' | 'locked' | 'open';

/** Ce que la porte dit de la session ; `null` sans porte joignable. */
async function readGate(): Promise<GateState | null> {
  try {
    const res = await within(fetch('/connexion/etat', { cache: 'no-store' }), GATE_WAIT_MS);
    if (!res.ok) return null;
    const state = (await res.json()) as GateState;
    return typeof state?.session === 'boolean' ? state : null;
  } catch {
    return null;
  }
}

function within<T>(promise: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error('délai')), ms); }),
  ]).finally(() => clearTimeout(timer));
}

const post = (path: string, body: unknown) =>
  fetch(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

/** Ce que l'app dit d'un échec à la porte ; muette si la porte ne répond pas. */
function report(evenement: string, error: unknown): void {
  const name = error instanceof Error || error instanceof DOMException ? error.name : 'Error';
  const text = error instanceof Error || error instanceof DOMException ? error.message : String(error);
  const standalone = window.matchMedia('(display-mode: standalone)').matches;
  void post('/connexion/journal', {
    evenement, detail: `${standalone ? 'app' : 'navigateur'} · ${BUILD ?? 'dev'} · ${name} : ${text}`,
  }).catch(() => undefined);
}

/** Face ID vérifié par le téléphone seul, sur la clé d'accès de ce site : Mac éteint, personne d'autre ne le peut. */
async function localFaceId(): Promise<'telephone'> {
  await navigator.credentials.get({
    publicKey: {
      challenge: crypto.getRandomValues(new Uint8Array(32)),
      rpId: location.hostname,
      userVerification: 'required',
      timeout: 60_000,
    },
  });
  return 'telephone';
}

/**
 * Face ID. Par la porte quand elle répond — la signature est vérifiée sur le
 * Mac, et la session s'ouvre ; sinon par le téléphone seul, sur la même clé.
 * Une porte qu'on sait muette à l'ouverture n'est pas attendue une seconde fois.
 */
async function faceId(gateSilent: boolean): Promise<'porte' | 'telephone'> {
  if (gateSilent) return localFaceId();
  let options: Response;
  try {
    options = await within(post('/connexion/options', {}), GATE_WAIT_MS);
  } catch {
    return localFaceId();
  }
  const body = (await options.json().catch(() => ({}))) as { error?: string; challenge?: string };
  if (!options.ok || !body.challenge) throw new Error(body.error ?? `Erreur ${options.status}`);
  const credential = await navigator.credentials.get({ publicKey: requestOf(body as { challenge: string }) });
  if (!credential) throw new Error('Face ID n’a rien rendu.');
  const verified = await post('/connexion/verifier', assertionJSON(credential as unknown as AssertionLike));
  if (!verified.ok) {
    const error = (await verified.json().catch(() => ({}))) as { error?: string };
    throw new Error(error.error ?? `Erreur ${verified.status}`);
  }
  return 'porte';
}

/** Un Face ID refusé ou annulé n'est pas une panne : il ne dit rien de plus que le bouton. */
const cancelled = (e: unknown): boolean => e instanceof DOMException && e.name === 'NotAllowedError';

/** Le temps que l'écran d'ouverture met à s'effacer, ms — celui de `.lock-leave`. */
const LEAVE_MS = 420;

export function Lock({ children }: { children: React.ReactNode }) {
  const [phase, setPhase] = useState<Phase>('checking');
  /** L'app n'est montée qu'une fois ouverte : à l'ouverture, rien ne part avant Face ID. */
  const [mounted, setMounted] = useState(false);
  const [veiled, setVeiled] = useState(false);
  const [busy, setBusy] = useState(false);
  /** Face ID n'a pas abouti : le bouton prend le relais. */
  const [failed, setFailed] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  /** L'écran s'efface : il reste dessiné le temps de son animation. */
  const [leaving, setLeaving] = useState(false);
  const [offline, setOfflineState] = useState(false);
  /** La porte n'a pas répondu à l'ouverture : Face ID passe par le téléphone sans l'attendre. */
  const offlineRef = useRef(false);
  const setOffline = useCallback((value: boolean) => {
    offlineRef.current = value;
    setOfflineState(value);
  }, []);
  const gated = useRef(false);
  const hiddenAt = useRef<number | null>(null);
  /** Une lecture a été refusée sous l'écran : la page se recharge une fois ouverte. */
  const missed = useRef(false);
  const autoTried = useRef(false);

  const open = useCallback(() => {
    setPhase('open');
    setMounted(true);
    setMessage(null);
    setStatus(null);
    setFailed(false);
    setLeaving(true);
    window.setTimeout(() => setLeaving(false), LEAVE_MS);
    if (missed.current) {
      missed.current = false;
      location.reload();
      return;
    }
    // Les écrans montés relisent le Mac : ce qu'ils montrent date d'avant l'écran.
    window.dispatchEvent(new Event('cairn:deverrouille'));
  }, []);

  const unlock = useCallback(async (auto = false) => {
    setBusy(true);
    setFailed(false);
    setMessage(null);
    setStatus('Face ID…');
    try {
      const how = await faceId(offlineRef.current);
      setOffline(how === 'telephone');
      if (how === 'porte') {
        // Face ID vient d'avoir lieu : la page rechargée s'ouvre sans le redemander.
        setStatus('Ouverture…');
        const reloading = await within(updateAtUnlock(() => setStatus('Mise à jour…')), 15_000).catch(() => false);
        if (reloading) return;
      }
      open();
    } catch (e) {
      setFailed(true);
      setStatus(null);
      if (!cancelled(e)) setMessage(e instanceof Error ? e.message : String(e));
      // Une tentative faite à l'ouverture, sans geste, peut être refusée par Safari.
      if (!offlineRef.current) report(auto ? 'Face ID automatique sans suite' : 'Face ID échoué', e);
    } finally {
      setBusy(false);
    }
  }, [open, setOffline]);

  // L'ouverture : la porte dit si Face ID vient d'avoir lieu, ou si l'app servait à l'instant.
  useEffect(() => {
    let alive = true;
    void readGate().then((state) => {
      if (!alive) return;
      // Derrière la porte : servie en HTTPS — même quand la porte ne répond
      // plus —, ou la porte a répondu. Sur le Mac seul, ni l'un ni l'autre.
      gated.current = behindGate(location) || state != null;
      if (!gated.current) {
        open();
        return;
      }
      // `requireSession` (lib/api.ts) passe par cet écran plutôt que par la page de connexion.
      document.documentElement.dataset.verrou = 'actif';
      if (lockedAtOpen(true, state)) {
        setOffline(state == null);
        setPhase('locked');
      } else {
        open();
      }
    });
    return () => { alive = false; };
  }, [open, setOffline]);

  // L'arrière-plan : l'écran d'ouverture couvre l'app, puis Face ID au retour après une minute ailleurs.
  useEffect(() => {
    const onVisibility = () => {
      if (!gated.current) return;
      if (document.hidden) {
        hiddenAt.current = Date.now();
        setVeiled(true);
        return;
      }
      const away = hiddenAt.current == null ? 0 : Date.now() - hiddenAt.current;
      hiddenAt.current = null;
      if (lockedAtReturn(away)) {
        autoTried.current = false;
        offlineRef.current = false;
        setPhase((p) => (p === 'open' ? 'locked' : p));
      }
      setVeiled(false);
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

  // Une lecture refusée faute de session : l'écran, pas la page de connexion. La
  // porte a répondu — elle n'est pas muette : Face ID passera par elle.
  useEffect(() => {
    const onRefused = () => {
      missed.current = true;
      autoTried.current = false;
      setOffline(false);
      setPhase('locked');
    };
    window.addEventListener('cairn:verrou', onRefused);
    return () => window.removeEventListener('cairn:verrou', onRefused);
  }, [setOffline]);

  // L'app ouverte le dit à la porte toutes les trente secondes : la session ne
  // se ferme pas pendant qu'on lit le plan sans rien toucher.
  useEffect(() => {
    if (phase !== 'open' || !gated.current) return;
    const id = setInterval(() => {
      if (document.hidden) return;
      void readGate().then((state) => {
        if (state && !state.session) setPhase('locked');
      });
    }, HEARTBEAT_MS);
    return () => clearInterval(id);
  }, [phase]);

  // Face ID se propose de lui-même à l'écran ; s'il n'aboutit pas, le bouton prend le relais.
  useEffect(() => {
    if (phase !== 'locked' || autoTried.current || document.hidden) return;
    autoTried.current = true;
    void unlock(true);
  }, [phase, unlock]);

  const shown = phase !== 'open' || leaving;
  return (
    <>
      {mounted && <div className="app-reveal" style={{ display: phase === 'open' ? 'contents' : 'none' }}>{children}</div>}
      {shown && (
        <div
          className={`lock${phase === 'open' ? ' lock-leave' : ''}`}
          role="dialog" aria-modal="true" aria-label="Cairn verrouillé"
          data-state={failed ? 'failed' : 'waiting'}
        >
          <Topo className="lock-topo" />
          <div className="lock-body">
            <h1 className="lock-title">Cairn</h1>
            <p className="lock-sub">Coaching trail</p>
            <div className="lock-face">
              {failed ? (
                <button type="button" className="lock-button" onClick={() => void unlock()} disabled={busy}>
                  <FaceGlyph className="lock-button-glyph" />
                  Déverrouiller
                </button>
              ) : (
                <FaceGlyph className="lock-glyph" />
              )}
              <span className="lock-status" role="status">{status ?? ''}</span>
            </div>
            <p className="lock-message" role="alert">{message ?? ''}</p>
            {offline && phase !== 'open' && (
              <p className="lock-offline">Le Mac dort : l’app s’ouvrira sur sa dernière lecture, datée.</p>
            )}
          </div>
        </div>
      )}
      {veiled && phase === 'open' && !leaving && (
        <div className="lock lock-veil" aria-hidden="true">
          <Topo className="lock-topo" />
          <div className="lock-body"><span className="lock-title">Cairn</span></div>
        </div>
      )}
    </>
  );
}
