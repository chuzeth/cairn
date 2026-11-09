'use client';
import { useEffect, useState } from 'react';
import { markdown, nbsp, type AskedQuestion } from '@/lib/api';
import { sendOrQueue } from '@/lib/offline';

/**
 * Ce que Cairn demande, en haut du matin : une question à la fois, répondable
 * d'un pouce.
 *
 * Elles ne viennent que quand une décision en dépend (`@cairn/coach`,
 * `questions.ts`) — l'accord du médecin avant la première course, la douleur
 * après chaque course et le lendemain matin, l'effort d'une course faite sans
 * montre. Chacune dit ce que sa réponse décide : une question dont on ne voit
 * pas l'usage est une question à laquelle on ne répond plus.
 */

const SITES: { site: string; label: string }[] = [
  { site: 'tibia', label: 'Tibia' },
  { site: 'achille', label: 'Achille' },
  { site: 'mollet', label: 'Mollet' },
  { site: 'pied', label: 'Pied' },
  { site: 'genou', label: 'Genou' },
  { site: 'hanche', label: 'Hanche' },
  { site: 'autre', label: 'Ailleurs' },
];

interface AnswerResult {
  adjustments: number;
  adjustmentSummary: string | null;
  questions: AskedQuestion[];
}

export function Questions({ questions, onReload }: { questions: AskedQuestion[]; onReload: () => Promise<void> | void }) {
  const [list, setList] = useState(questions);
  const [painFor, setPainFor] = useState<{ id: string; score: number } | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);
  const [queued, setQueued] = useState(false);
  // L'écran relu après une réponse apporte ses questions : elles remplacent la liste, le réajustement dit reste.
  const ids = questions.map((x) => x.id).join('|');
  useEffect(() => {
    if (!sending) setList(questions);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ids]);
  const q = list[0];
  if (!q && !summary) return null;

  const send = async (value: AskedQuestion['choices'][number]['value'] & { site?: string }) => {
    if (!q) return;
    setSending(true);
    setError(null);
    try {
      const sent = await sendOrQueue<AnswerResult>('/api/answers', { question: q.question, subject: q.subject, value });
      setPainFor(null);
      if (!sent) {
        // Faute de réseau, la réponse attend dans la file : la question suivante peut venir.
        setQueued(true);
        setList((l) => l.slice(1));
        return;
      }
      setList(sent.questions);
      if (sent.adjustments > 0 && sent.adjustmentSummary) {
        setSummary(sent.adjustmentSummary);
        await onReload();
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSending(false);
    }
  };

  const choose = (choice: AskedQuestion['choices'][number]) => {
    const score = choice.value.score;
    // Une douleur se situe : une au tendon d'Achille ne se lit pas comme une au genou.
    if (q?.asksSite && score != null && score > 0) return setPainFor({ id: q.id, score });
    void send(choice.value);
  };

  return (
    <section className="m-q" aria-live="polite">
      {q && (
        <>
          <p className="m-q-prompt">{nbsp(q.prompt)}</p>
          {painFor?.id === q.id ? (
            <>
              <p className="m-q-why">Où ?</p>
              <div className="m-q-choices">
                {SITES.map((s) => (
                  <button key={s.site} type="button" className="m-q-choice" disabled={sending}
                    onClick={() => send({ score: painFor.score, site: s.site })}>
                    {s.label}
                  </button>
                ))}
              </div>
            </>
          ) : (
            <div className="m-q-choices">
              {q.choices.map((c) => (
                <button key={c.label} type="button" className="m-q-choice" disabled={sending} onClick={() => choose(c)}>
                  {c.label}
                </button>
              ))}
            </div>
          )}
          <p className="m-q-why">{nbsp(q.why)}</p>
          {list.length > 1 && <p className="m-q-why">Encore {list.length - 1} question{list.length > 2 ? 's' : ''} ensuite.</p>}
        </>
      )}
      {queued && <p className="m-q-why" data-warn>En attente d&apos;envoi : ta réponse partira au retour du réseau.</p>}
      {error && <p className="m-q-why" data-warn>{error}</p>}
      {summary && (
        <div className="m-adjust">
          <strong>Ta réponse a réajusté la suite</strong>
          <div className="msg-content" dangerouslySetInnerHTML={{ __html: markdown(summary) }} />
        </div>
      )}
    </section>
  );
}
