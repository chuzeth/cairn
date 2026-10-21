'use client';
import { useState } from 'react';
import { nbsp, post, type GarminStatus } from '@/lib/api';

/**
 * La séance et la montre, du point de vue de celui qui va la faire.
 *
 * Le 21/10, Pierre : « quand est-ce qu'il va vouloir envoyer son exercice à la
 * montre ? ». Quand elle n'y est pas et qu'elle devrait y être — rien d'autre.
 * La liaison envoie d'elle-même, sept jours à l'avance, ce que la montre sait
 * guider (la course ; l'escalier, la marche, les montées en Cardio). Le bouton
 * ne sert qu'à ne pas attendre : une séance qui vient de changer, un envoi
 * refusé ou une liaison injoignable. Une séance sur le tapis ne part pas — le
 * téléphone la guide — et la ligne dit comment l'enregistrer pour qu'elle se
 * coche d'elle-même.
 */

type Shown = Pick<GarminStatus, 'state' | 'label' | 'detail' | 'tone'>;

const SENDABLE_AGAIN: ReadonlySet<GarminStatus['state']> = new Set(['pending', 'mismatch', 'unreachable']);

function sentence(status: Shown): { text: string; hint?: string; tone: GarminStatus['tone'] } {
  switch (status.state) {
    case 'verified':
      return status.label.includes('montre')
        ? { text: 'Sur ta montre', tone: 'good' }
        : {
            text: 'Prête sur Garmin Connect',
            hint: 'Ouvre l’app Garmin Connect près de ta montre : elle la prendra à la synchronisation.',
            tone: 'good',
          };
    case 'not_sent':
      return status.detail?.includes('Musculation')
        ? { text: 'Sur ta montre, lance « Musculation » : Cairn cochera la séance.', tone: 'mute' }
        : { text: status.label, hint: status.detail, tone: 'mute' };
    case 'pending':
      return { text: 'Pas encore sur ta montre', hint: status.detail, tone: 'mute' };
    case 'reauth':
      return { text: 'Garmin demande de te reconnecter', hint: 'Ça se fait sur le Mac : npm run garmin -- login.', tone: 'warn' };
    default:
      return { text: status.label, hint: status.detail, tone: status.tone };
  }
}

export function WatchLine({ sessionId, status }: { sessionId: string; status?: GarminStatus | null }) {
  const [shown, setShown] = useState<Shown | null>(status ?? null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (!shown) return null;

  const send = async () => {
    setSending(true);
    setError(null);
    try {
      const r = await post<{ bySession: Record<string, GarminStatus> }>('/api/garmin/envoyer');
      const next = r.bySession[sessionId];
      if (next) setShown(next);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const { text, hint, tone } = sentence(shown);
  return (
    <div className="watch" data-tone={tone}>
      <p className="watch-line">
        <span className="watch-dot" aria-hidden />
        <span>
          {nbsp(text)}
          {hint && <span className="watch-hint"> {nbsp(hint)}</span>}
        </span>
      </p>
      {SENDABLE_AGAIN.has(shown.state) && (
        <button type="button" className="btn watch-send" onClick={send} disabled={sending}>
          {sending ? <><span className="spinner" /> Envoi…</> : shown.state === 'pending' ? 'Envoyer à la montre' : 'Réessayer l’envoi'}
        </button>
      )}
      {error && <p className="watch-error">{error}</p>}
    </div>
  );
}
