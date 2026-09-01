'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import { API, get, markdown } from '@/lib/api';
import { Card } from '@/components/ui';

interface ToolCall { name: string; summary?: string; state: 'running' | 'done' | 'error' }
interface Message { role: 'user' | 'assistant'; content: string; tools?: ToolCall[]; streaming?: boolean }

const TOOL_LABELS: Record<string, string> = {
  get_athlete_profile: 'profil physiologique',
  get_fitness_state: 'état de forme',
  get_training_zones: 'zones d\'entraînement',
  list_activities: 'historique des séances',
  get_activity_analysis: 'analyse de séance',
  get_performance_curves: 'courbes de performance',
  get_plan: 'plan en cours',
  list_races: 'objectifs',
  upsert_race: 'enregistrement de la course',
  predict_race: 'prédiction de course',
  rebuild_plan: 'reconstruction du plan',
  modify_session: 'modification de séance',
  get_check_ins: 'relevés quotidiens',
  update_availability: 'mise à jour des contraintes',
  compare_periods: 'comparaison de périodes',
};

const SUGGESTIONS = [
  "Comment je vais, aujourd'hui ?",
  "Je suis inscrit au trail des Grisemottes, 32 km le 18/10, ambition top 10. Réajuste mes séances d'ici là.",
  'Analyse ma dernière séance en détail.',
  'Où en est ma durabilité par rapport au mois dernier ?',
  'Ma sortie longue de dimanche, je la fais où et comment ?',
];

export default function CoachPage() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    void (async () => {
      try {
        const history = await get<{ role: 'user' | 'assistant'; content: string }[]>('/api/chat/history?limit=40');
        setMessages(history.map((m) => ({ role: m.role, content: m.content })));
      } catch {
        // Historique indisponible : on démarre une conversation vierge.
      } finally {
        setLoaded(true);
      }
    })();
  }, []);

  const scrollToBottom = useCallback(() => {
    requestAnimationFrame(() => {
      scrollRef.current?.scrollTo({ top: scrollRef.current.scrollHeight, behavior: 'smooth' });
    });
  }, []);

  useEffect(scrollToBottom, [messages, scrollToBottom]);

  const send = async (text: string) => {
    const message = text.trim();
    if (!message || busy) return;

    setInput('');
    setBusy(true);
    setMessages((m) => [...m, { role: 'user', content: message }, { role: 'assistant', content: '', tools: [], streaming: true }]);

    const patchLast = (fn: (m: Message) => Message) =>
      setMessages((prev) => {
        const next = prev.slice();
        const i = next.length - 1;
        if (i >= 0 && next[i]) next[i] = fn(next[i] as Message);
        return next;
      });

    try {
      const res = await fetch(`${API}/api/chat`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ message }),
      });
      if (!res.ok || !res.body) throw new Error(`L'API a répondu ${res.status}`);

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      // Lecture du flux Server-Sent Events, trame par trame.
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        let sep: number;
        while ((sep = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, sep);
          buffer = buffer.slice(sep + 2);
          const line = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!line) continue;

          let event: Record<string, unknown>;
          try { event = JSON.parse(line.slice(6)); } catch { continue; }

          switch (event.type) {
            case 'text':
              patchLast((m) => ({ ...m, content: m.content + (event.text as string) }));
              break;
            case 'tool_start':
              patchLast((m) => ({ ...m, tools: [...(m.tools ?? []), { name: event.name as string, state: 'running' }] }));
              break;
            case 'tool_end':
              patchLast((m) => {
                const tools = (m.tools ?? []).slice();
                for (let i = tools.length - 1; i >= 0; i--) {
                  if (tools[i]!.name === event.name && tools[i]!.state === 'running') {
                    tools[i] = { name: event.name as string, summary: event.summary as string, state: event.ok ? 'done' : 'error' };
                    break;
                  }
                }
                return { ...m, tools };
              });
              break;
            case 'done':
              patchLast((m) => ({ ...m, content: (event.content as string) || m.content, streaming: false }));
              break;
            case 'error':
              patchLast((m) => ({
                ...m,
                content: `${m.content}\n\n**Erreur :** ${event.message as string}`,
                streaming: false,
              }));
              break;
          }
          scrollToBottom();
        }
      }
      patchLast((m) => ({ ...m, streaming: false }));
    } catch (e) {
      patchLast((m) => ({
        ...m,
        content: `**Impossible de joindre le coach.** ${e instanceof Error ? e.message : String(e)}\n\nVérifie que l'API tourne et que \`ANTHROPIC_API_KEY\` est renseignée dans \`.env\`.`,
        streaming: false,
      }));
    } finally {
      setBusy(false);
      textareaRef.current?.focus();
    }
  };

  return (
    <>
      <div className="page-head">
        <div>
          <h1 className="page-title">Coach</h1>
          <p className="page-sub">
            Il consulte tes données avant de répondre — chaque outil appelé est affiché.
          </p>
        </div>
      </div>

      <Card style={{ padding: 20 }}>
        <div className="chat">
          <div className="chat-scroll" ref={scrollRef}>
            {loaded && messages.length === 0 && (
              <div style={{ maxWidth: 620, margin: '32px auto', textAlign: 'center' }}>
                <div style={{ fontSize: 15, fontWeight: 600, marginBottom: 8 }}>
                  Ton responsable de la performance.
                </div>
                <p className="small muted">
                  Il connaît ton test d'effort du 24 juillet 2025, ton historique Strava, ta charge des
                  quatre derniers mois et ton plan en cours. Il peut analyser, prédire, replanifier — et il agit :
                  quand tu lui annonces une course, il l'enregistre et reconstruit ta préparation.
                </p>
              </div>
            )}

            {messages.map((m, i) => (
              <div className="msg" data-role={m.role} key={i}>
                <div className="msg-avatar">{m.role === 'user' ? 'PC' : 'C'}</div>
                <div className="msg-body">
                  {m.tools && m.tools.length > 0 && (
                    <div className="tool-trace">
                      {m.tools.map((t, ti) => (
                        <span className="tool-chip" data-state={t.state} key={ti} title={t.summary}>
                          {t.state === 'running' ? <span className="spinner" style={{ width: 9, height: 9, borderWidth: 1.5 }} /> : <span className="dot" />}
                          {TOOL_LABELS[t.name] ?? t.name}
                          {t.state === 'done' && t.summary && <span className="faint"> · {t.summary}</span>}
                        </span>
                      ))}
                    </div>
                  )}
                  {m.content ? (
                    <div className="msg-content" dangerouslySetInnerHTML={{ __html: markdown(m.content) }} />
                  ) : m.streaming ? (
                    <div className="small faint pulse">Le coach consulte tes données…</div>
                  ) : null}
                </div>
              </div>
            ))}
          </div>

          {messages.length === 0 && loaded && (
            <div className="suggestions" style={{ marginTop: 16 }}>
              {SUGGESTIONS.map((s) => (
                <button className="suggestion" key={s} onClick={() => void send(s)}>{s}</button>
              ))}
            </div>
          )}

          <div className="chat-input">
            <textarea
              ref={textareaRef}
              value={input}
              placeholder="Pose ta question, ou annonce une course…"
              rows={1}
              onChange={(e) => {
                setInput(e.target.value);
                e.target.style.height = 'auto';
                e.target.style.height = `${Math.min(200, e.target.scrollHeight)}px`;
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  void send(input);
                }
              }}
              disabled={busy}
            />
            <button className="btn" data-variant="primary" onClick={() => void send(input)} disabled={busy || !input.trim()}>
              {busy ? <span className="spinner" /> : 'Envoyer'}
            </button>
          </div>
        </div>
      </Card>
    </>
  );
}
