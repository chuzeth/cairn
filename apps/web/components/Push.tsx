'use client';
import { usePush } from '@/lib/push';

/**
 * L'invitation à activer les notifications, tant qu'elles ne le sont pas
 * (`lib/push.ts`). Une fois activées, elle disparaît : ce qui compte ensuite se
 * lit dans la ligne de synchronisation.
 */
export function PushInvite() {
  const { status, busy, error, enable } = usePush();
  if (status !== 'off' && status !== 'denied') return null;
  return (
    <section className="m-push">
      <p className="m-push-head">Tenir Cairn à jour sans l’ouvrir</p>
      {status === 'off' ? (
        <>
          <p className="m-push-why">
            Quand ton Mac a du neuf — la séance du jour, une sortie analysée, une séance réajustée, une question —, il
            prévient ton téléphone, qui se synchronise aussitôt, app fermée.
          </p>
          <button type="button" className="m-push-button" onClick={() => void enable()} disabled={busy}>
            {busy ? 'Activation…' : 'Activer les notifications'}
          </button>
        </>
      ) : (
        <p className="m-push-why">
          Les notifications sont refusées pour Cairn : rouvre-les dans Réglages → Notifications → Cairn, et l’app se
          synchronisera sans que tu l’ouvres.
        </p>
      )}
      {error && <p className="m-push-why" data-warn>{error}</p>}
    </section>
  );
}

/** L'état des notifications, en une ligne, au pied de la feuille « Plus ». */
export function PushLine() {
  const { status } = usePush();
  if (status === 'checking' || status === 'unsupported') return null;
  return (
    <div className="version">
      {status === 'on' ? 'notifications activées · synchronisation app fermée' : status === 'denied' ? 'notifications refusées dans les réglages' : 'notifications non activées'}
    </div>
  );
}
