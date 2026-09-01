import Anthropic from '@anthropic-ai/sdk';
import * as db from '@cairn/db';
import { COACH_SYSTEM_PROMPT, buildContextSnapshot } from './prompts.js';
import { TOOL_DEFINITIONS, executeTool } from './tools.js';
import { loadAthleteState } from './state.js';

/**
 * Agent conversationnel.
 *
 * Boucle d'outils écrite à la main plutôt que via le tool runner du SDK, pour
 * deux raisons : on veut diffuser au front les appels d'outils au fil de l'eau
 * (l'athlète voit sur quoi le coach s'appuie, ce qui rend l'analyse
 * vérifiable), et les mêmes définitions d'outils alimentent le serveur MCP —
 * les garder en JSON Schema brut évite toute divergence entre les deux surfaces.
 */

const MODEL = process.env.CAIRN_MODEL ?? 'claude-opus-5';
const MAX_ITERATIONS = 12;

export type AgentEvent =
  | { type: 'text'; text: string }
  | { type: 'thinking'; text: string }
  | { type: 'tool_start'; name: string; input: unknown }
  | { type: 'tool_end'; name: string; summary: string; ok: boolean }
  | { type: 'done'; content: string; toolCalls: { name: string; input: unknown; summary: string }[] }
  | { type: 'error'; message: string };

let client: Anthropic | null = null;
function anthropic(): Anthropic {
  if (!client) {
    if (!process.env.ANTHROPIC_API_KEY && !process.env.ANTHROPIC_AUTH_TOKEN) {
      throw new Error(
        "Aucune information d'authentification Anthropic. Renseigne ANTHROPIC_API_KEY dans .env, " +
          'ou connecte-toi avec `ant auth login`.',
      );
    }
    client = new Anthropic();
  }
  return client;
}

export interface ChatOptions {
  athleteId: string;
  message: string;
  /** Nombre de tours d'historique à recharger (défaut 20). */
  historyLimit?: number;
  /** Coupe la persistance — utile pour les analyses ponctuelles. */
  persist?: boolean;
}

/**
 * Répond à un message, en diffusant les événements au fur et à mesure.
 * L'historique est rechargé depuis la base : la conversation survit au
 * rechargement de la page et au redémarrage du serveur.
 */
export async function* chat(opts: ChatOptions): AsyncGenerator<AgentEvent> {
  const { athleteId, message } = opts;
  const persist = opts.persist !== false;

  let messages: Anthropic.MessageParam[];
  let snapshot: string;

  try {
    const state = await loadAthleteState(athleteId);
    snapshot = buildContextSnapshot(state);

    const history = await db.listChatMessages(athleteId, opts.historyLimit ?? 20);
    messages = history.map((m) => ({ role: m.role, content: m.content }));
    messages.push({ role: 'user', content: message });
  } catch (e) {
    yield { type: 'error', message: e instanceof Error ? e.message : String(e) };
    return;
  }

  if (persist) {
    await db.appendChatMessage({
      athleteId,
      role: 'user',
      content: message,
      createdAt: new Date().toISOString(),
    });
  }

  const toolCalls: { name: string; input: unknown; summary: string }[] = [];
  let finalText = '';

  try {
    for (let iteration = 0; iteration < MAX_ITERATIONS; iteration++) {
      const stream = anthropic().messages.stream({
        model: MODEL,
        max_tokens: 32000,
        thinking: { type: 'adaptive' },
        output_config: { effort: 'high' },
        // Le prompt système et l'instantané sont stables sur toute la
        // conversation : on les met en cache pour ne les payer qu'une fois.
        system: [
          { type: 'text', text: COACH_SYSTEM_PROMPT },
          { type: 'text', text: snapshot, cache_control: { type: 'ephemeral' } },
        ],
        tools: TOOL_DEFINITIONS as unknown as Anthropic.Tool[],
        messages,
      });

      for await (const event of stream) {
        if (event.type === 'content_block_delta') {
          if (event.delta.type === 'text_delta') {
            finalText += event.delta.text;
            yield { type: 'text', text: event.delta.text };
          } else if (event.delta.type === 'thinking_delta') {
            yield { type: 'thinking', text: event.delta.thinking };
          }
        }
      }

      const response = await stream.finalMessage();

      if (response.stop_reason === 'refusal') {
        yield {
          type: 'error',
          message: "La requête a été déclinée par le modèle. Reformule ou précise ta demande.",
        };
        return;
      }

      if (response.stop_reason === 'pause_turn') {
        messages.push({ role: 'assistant', content: response.content });
        continue;
      }

      const toolUses = response.content.filter(
        (b): b is Anthropic.ToolUseBlock => b.type === 'tool_use',
      );

      if (toolUses.length === 0) break;

      messages.push({ role: 'assistant', content: response.content });

      const results: Anthropic.ToolResultBlockParam[] = [];
      for (const use of toolUses) {
        yield { type: 'tool_start', name: use.name, input: use.input };
        try {
          const result = await executeTool(athleteId, use.name, use.input);
          toolCalls.push({ name: use.name, input: use.input, summary: result.summary });
          yield { type: 'tool_end', name: use.name, summary: result.summary, ok: true };
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: JSON.stringify(result.content),
          });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          toolCalls.push({ name: use.name, input: use.input, summary: `Échec : ${msg}` });
          yield { type: 'tool_end', name: use.name, summary: msg, ok: false };
          // On renvoie l'erreur au modèle plutôt que d'interrompre : il peut
          // corriger ses arguments ou changer de stratégie.
          results.push({
            type: 'tool_result',
            tool_use_id: use.id,
            content: `Erreur : ${msg}`,
            is_error: true,
          });
        }
      }

      messages.push({ role: 'user', content: results });
      // Le texte utile est celui du dernier tour : on repart d'une page blanche.
      finalText = '';
    }

    if (persist && finalText.trim()) {
      await db.appendChatMessage({
        athleteId,
        role: 'assistant',
        content: finalText,
        createdAt: new Date().toISOString(),
        toolCalls,
      });
    }

    yield { type: 'done', content: finalText, toolCalls };
  } catch (e) {
    yield { type: 'error', message: formatAnthropicError(e) };
  }
}

/** Variante non diffusée, pour les scripts et les tâches de fond. */
export async function chatOnce(opts: ChatOptions): Promise<{ content: string; toolCalls: unknown[] }> {
  let content = '';
  const calls: unknown[] = [];
  for await (const event of chat(opts)) {
    if (event.type === 'done') {
      content = event.content;
      calls.push(...event.toolCalls);
    } else if (event.type === 'error') {
      throw new Error(event.message);
    }
  }
  return { content, toolCalls: calls };
}

export function formatAnthropicError(e: unknown): string {
  if (e instanceof Anthropic.AuthenticationError) {
    return "Clé d'API Anthropic invalide ou absente. Vérifie ANTHROPIC_API_KEY dans .env.";
  }
  if (e instanceof Anthropic.RateLimitError) {
    return 'Quota Anthropic atteint. Réessaie dans quelques instants.';
  }
  if (e instanceof Anthropic.BadRequestError) {
    return `Requête refusée par l'API Anthropic : ${e.message}`;
  }
  if (e instanceof Anthropic.APIError) {
    return `Erreur API Anthropic ${e.status ?? ''} : ${e.message}`;
  }
  return e instanceof Error ? e.message : String(e);
}
