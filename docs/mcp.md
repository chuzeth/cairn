# Serveur MCP

Cairn expose son coach comme serveur **Model Context Protocol**. Claude Desktop et
Claude Code accèdent alors aux mêmes outils et aux mêmes données que le chat
intégré : on peut commencer une conversation dans l'application et la poursuivre
depuis le terminal, les deux voient le même modèle physiologique et le même plan.

Les définitions d'outils viennent de `@cairn/coach` — une seule source, aucune
dérive possible entre les deux surfaces.

## Claude Desktop

Édite le fichier de configuration :

- **macOS** : `~/Library/Application Support/Claude/claude_desktop_config.json`
- **Windows** : `%APPDATA%\Claude\claude_desktop_config.json`

```json
{
  "mcpServers": {
    "cairn": {
      "command": "npx",
      "args": [
        "tsx",
        "/Users/pchuze/Documents/Trail Running/packages/mcp/src/index.ts"
      ],
      "env": {
        "DATABASE_URL": "file:/Users/pchuze/Documents/Trail Running/data/cairn.sqlite",
        "CAIRN_ATHLETE_ID": "pierre"
      }
    }
  }
}
```

Redémarre Claude Desktop. Le serveur apparaît dans le menu des outils.

## Claude Code

```bash
claude mcp add cairn -- npx tsx "/Users/pchuze/Documents/Trail Running/packages/mcp/src/index.ts"
```

Le chemin de base de données est résolu automatiquement depuis l'emplacement du
paquet : le serveur trouve la bonne base quel que soit le répertoire de lancement.

## Outils exposés

| Outil | Usage |
|---|---|
| `get_athlete_profile` | Modèle physiologique complet, test de laboratoire, provenance de chaque paramètre. |
| `get_fitness_state` | CTL, ATL, TSB métabolique **et** mécanique, ACWR, monotonie, disponibilité. |
| `get_training_zones` | Zones de FC et d'allure courantes, avec leur objectif physiologique. |
| `list_activities` | Historique filtrable par période, sport, durée, dénivelé. |
| `get_activity_analysis` | Analyse détaillée d'une séance : charges, zones, dérive, blocs, durabilité, alertes. |
| `get_performance_curves` | Courbe vitesse-durée, courbe VAM, ajustement de la vitesse critique. |
| `get_terrain` | Terrains de départ, montées récurrentes et leurs records, écart de dénivelé sorties/courses. |
| `get_plan` | Plan en cours, phases, séances et leur statut. |
| `list_races` / `upsert_race` | Objectifs de course, profil de parcours, ambition. |
| `predict_race` | Temps prédit, intervalle, plan d'allure, ravitaillement, facteurs limitants. |
| `rebuild_plan` | Reconstruction complète de la préparation. |
| `modify_session` | Déplacement, changement de statut, ajustement de charge d'une séance. |
| `get_check_ins` | Relevés quotidiens déclarés. |
| `update_availability` | Contraintes de disponibilité. |
| `compare_periods` | Comparaison objective de deux blocs d'entraînement. |
| `refresh_physiology_model` | Ré-estimation complète depuis l'historique. |

## Ressources exposées

| URI | Contenu |
|---|---|
| `cairn://coach/briefing` | Le cadre de raisonnement du responsable de la performance. |
| `cairn://athlete/snapshot` | Instantané du jour : modèle, forme, prochaines séances et courses. |
| `cairn://athlete/lab-test` | Compte rendu intégral du test d'effort. |

Charger `cairn://coach/briefing` au début d'une conversation donne au client MCP
le même cadre que le chat intégré — ancrage dans les données, distinction entre
mesure et inférence, double filière de fatigue.

## Vérifier que le serveur répond

```bash
npm run mcp
```

Le serveur écrit `[cairn-mcp] prêt — athlète « pierre », 16 outils exposés.` sur
**stderr** et attend le protocole JSON-RPC sur stdin. La sortie standard est
strictement réservée au protocole : toute trace y serait interprétée comme un
message et casserait la connexion.
