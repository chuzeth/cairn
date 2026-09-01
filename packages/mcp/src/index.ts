#!/usr/bin/env node
/**
 * Serveur MCP de Cairn.
 *
 * Expose le coach comme un serveur Model Context Protocol : Claude Desktop et
 * Claude Code accèdent alors exactement aux mêmes outils que le chat intégré,
 * avec les mêmes données. On peut ouvrir une conversation dans l'application,
 * la poursuivre depuis le terminal, et les deux voient le même modèle
 * physiologique et le même plan.
 *
 * Les outils viennent de `@cairn/coach` : une seule définition, aucune dérive
 * possible entre les deux surfaces.
 *
 * Transport stdio — le mode attendu par la configuration locale de Claude.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import {
  CallToolRequestSchema,
  ListResourcesRequestSchema,
  ListToolsRequestSchema,
  ReadResourceRequestSchema,
} from '@modelcontextprotocol/sdk/types.js';
import * as db from '@cairn/db';
import {
  COACH_SYSTEM_PROMPT, TOOL_DEFINITIONS, buildContextSnapshot,
  executeTool, loadAthleteState, refreshModel,
} from '@cairn/coach';

const ATHLETE_ID = process.env.CAIRN_ATHLETE_ID ?? 'pierre';

const server = new Server(
  { name: 'cairn', version: '1.0.0' },
  { capabilities: { tools: {}, resources: {} } },
);

// ─── Outils ──────────────────────────────────────────────────────────────────

/** Outils du coach, plus un outil propre au MCP pour forcer la ré-estimation. */
const ALL_TOOLS = [
  ...TOOL_DEFINITIONS,
  {
    name: 'refresh_physiology_model',
    description:
      "Recalcule le modèle physiologique depuis l'ensemble de l'historique : vitesse critique, D', seuils, durabilité, aisance en descente. Opération lourde (quelques secondes) — à utiliser après un import d'activités ou quand les valeurs semblent périmées.",
    input_schema: { type: 'object' as const, properties: {}, additionalProperties: false },
  },
];

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: ALL_TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.input_schema,
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: args } = request.params;
  try {
    const result =
      name === 'refresh_physiology_model'
        ? await refreshModel(ATHLETE_ID)
        : await executeTool(ATHLETE_ID, name, args ?? {});

    return {
      content: [
        { type: 'text' as const, text: result.summary },
        { type: 'text' as const, text: JSON.stringify(result.content, null, 2) },
      ],
    };
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e);
    return {
      isError: true,
      content: [{ type: 'text' as const, text: `Échec de l'outil « ${name} » : ${message}` }],
    };
  }
});

// ─── Ressources ──────────────────────────────────────────────────────────────
//
// Trois ressources en lecture directe : le brief d'entraîneur (qui donne au
// client MCP le même cadre que le chat intégré), l'instantané de l'athlète, et
// le compte rendu de laboratoire intégral.

server.setRequestHandler(ListResourcesRequestSchema, async () => ({
  resources: [
    {
      uri: 'cairn://coach/briefing',
      name: "Cadre d'intervention du coach",
      description:
        "Les principes de raisonnement du responsable de la performance : ancrage dans les données, distinction mesure/inférence, double filière de fatigue, durabilité.",
      mimeType: 'text/markdown',
    },
    {
      uri: 'cairn://athlete/snapshot',
      name: "Instantané de l'athlète",
      description:
        "État du jour : modèle physiologique, charge chronique, fraîcheur métabolique et mécanique, disponibilité, prochaines séances et courses.",
      mimeType: 'text/markdown',
    },
    {
      uri: 'cairn://athlete/lab-test',
      name: "Test d'effort de référence",
      description: "Compte rendu complet du test d'effort en laboratoire, valeurs et interprétation du praticien.",
      mimeType: 'application/json',
    },
  ],
}));

server.setRequestHandler(ReadResourceRequestSchema, async (request) => {
  const { uri } = request.params;

  if (uri === 'cairn://coach/briefing') {
    return { contents: [{ uri, mimeType: 'text/markdown', text: COACH_SYSTEM_PROMPT }] };
  }

  if (uri === 'cairn://athlete/snapshot') {
    const state = await loadAthleteState(ATHLETE_ID);
    return { contents: [{ uri, mimeType: 'text/markdown', text: buildContextSnapshot(state) }] };
  }

  if (uri === 'cairn://athlete/lab-test') {
    const profile = await db.getAthlete(ATHLETE_ID);
    return {
      contents: [
        {
          uri,
          mimeType: 'application/json',
          text: JSON.stringify(profile?.labTests[0] ?? null, null, 2),
        },
      ],
    };
  }

  throw new Error(`Ressource inconnue : ${uri}`);
});

// ─── Démarrage ───────────────────────────────────────────────────────────────

async function main() {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  // stdout est réservé au protocole : toute trace part sur stderr.
  console.error(`[cairn-mcp] prêt — athlète « ${ATHLETE_ID} », ${ALL_TOOLS.length} outils exposés.`);
}

main().catch((e) => {
  console.error('[cairn-mcp] démarrage impossible :', e);
  process.exit(1);
});
