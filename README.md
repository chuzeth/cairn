# Cairn

Plateforme de coaching trail/running personnalisée, construite autour d'un modèle
physiologique individuel : le test d'effort du 24/07/2025 sert d'ancre, les données
Strava le corrigent en continu, et Claude s'en sert pour analyser, planifier et
répondre — sans jamais calculer lui-même les chiffres.

---

## Démarrage

```bash
npm run setup
```

Cette commande installe les dépendances, crée la base SQLite et importe le profil
depuis le test d'effort. Ensuite :

```bash
npm run service -- install
```

Cairn tourne alors comme une application installée : un LaunchAgent démarre l'API
et le site en mode production à l'ouverture de session et les relance s'ils
tombent. Les deux n'écoutent que sur la boucle locale — le site sur
**http://localhost:3000**, l'API sur **http://localhost:4000** — et Tailscale
Serve les expose en HTTPS au seul réseau privé : c'est l'adresse à ouvrir depuis
le téléphone, en 4G comme en wifi, et à ajouter à l'écran d'accueil
(`npm run service -- status` l'affiche). Sur secteur, le Mac ne se met pas en
veille tant que Cairn tourne ; sur batterie il dort, et la relève Strava rattrape
au réveil.

Le service n'exécute que du code vérifié, et ce code est un commit. Chaque commit
sur main le met à jour en arrière-plan (crochets git posés par `install` et
`update`) : le commit est extrait dans un instantané, qui passe `npm test` et
`npx tsc -b`, construit le site, et ne remplace ce qui tourne qu'une fois tout
passé ; l'instantané précédent reste en place tant que le nouveau n'a pas
démarré. Un refus se lit dans `npm run service -- status` et dans la feuille
« Plus » de l'app, qui dit aussi quelle version elle sert. Une modification non
commitée n'atteint jamais le service. Pour développer, `npm run dev` sert le site sur
http://localhost:3001 et l'API sur 4001, sans relève Strava : celle du service
suffit, et deux relèves sur la même base se marcheraient dessus.

Avant de lancer, copie `.env.example` vers `.env` et renseigne au minimum
`ANTHROPIC_API_KEY`. Pour Strava, suis [docs/strava.md](docs/strava.md).

---

## Ce que fait le système

### Un modèle physiologique qui vieillit et se corrige

Un test de laboratoire est une photographie ; un historique Strava est un film.
Cairn fusionne les deux : le test du 24/07/2025 fournit un a priori fort
(VMA 20 km/h, VO2max 64,6, SV1 13,2 km/h à 155 bpm, SV2 16,8 km/h à 171 bpm,
FCmax 187), dont le poids décroît avec une demi-vie de neuf mois, pendant que la
vitesse critique, les seuils et la durabilité se ré-estiment à chaque séance.

Chaque paramètre porte sa **provenance** — `lab`, `field`, `blended`, `default` —
affichée dans l'interface et transmise au coach. Un athlète a le droit de savoir
sur quoi repose ce qu'on lui demande de faire.

### Deux fatigues, pas une

C'est le choix de conception central. Le moteur calcule **deux charges en
parallèle** :

- la charge **métabolique** (cardiovasculaire, oxydative), celle que mesurent tous
  les outils du marché ;
- la charge **mécanique excentrique**, la destruction musculaire produite par la
  descente, invisible pour un TSS classique.

Elles ont leurs propres constantes de temps (42/7 jours contre 28/5) et leurs
propres courbes de forme. Un TSB métabolique à +8 avec un TSB mécanique à −20
décrit un athlète dont le cœur est frais et dont les quadriceps sont hors service.
Sur route la distinction est un luxe ; en trail elle explique pourquoi on arrive
« cuit » sur une course que le TSB annonçait parfaite.

### La durabilité comme troisième dimension

Après la VO2max et l'économie de course, ce qui sépare deux coureurs de même
plafond sur un 50 km, c'est la vitesse à laquelle ce plafond s'effondre. Cairn la
mesure en continu — perte de rendement en % par heure et par 1 000 m de D+ — sur
les fenêtres de dix minutes en régime aérobie stable, et l'injecte dans la
prédiction de course. Sans elle, un modèle de vitesse critique surestime
systématiquement les temps sur ultra.

### Une chaîne qui se déclenche à chaque séance

À chaque nouvelle activité Strava (webhook) :

```
flux bruts → normalisation 1 Hz → stockage compressé
           → ré-estimation du modèle physiologique
           → analyse quantitative (charges, zones, dérive, blocs, durabilité)
           → ajustement automatique du plan (règles déterministes)
           → analyse rédigée par Claude
```

Chaque étape est indépendante : si la rédaction échoue, les chiffres sont déjà en
base et restent consultables.

### Décisions déterministes, interprétation par le modèle

Les ajustements de charge — alléger, décaler, annuler — touchent au risque de
blessure. Ils sont produits par des règles explicites et auditables
([`packages/coach/src/adapt.ts`](packages/coach/src/adapt.ts)), pas par un modèle
de langage. Claude explique, propose, et agit via des outils ; il ne décide jamais
seul de la charge.

---

## Architecture

```
packages/
  core/         types du domaine · profil athlète · données du test d'effort
  physiology/   moteur scientifique — 100 % pur, sans effet de bord, testé
  db/           schéma Drizzle + SQLite (libsql), dépôt de données
  strava/       OAuth, client avec gestion du quota, webhooks, normalisation
  coach/        bibliothèque de séances, périodisation, planificateur,
                règles d'adaptation, outils Claude, agent conversationnel
  mcp/          serveur Model Context Protocol
apps/
  api/          Fastify — REST, webhooks, chat en streaming SSE
  web/          Next.js 16 — tableau de bord, plan, séances, coach
```

Le moteur physiologique ne dépend de rien : ni base, ni réseau, ni modèle de
langage. C'est ce qui le rend testable exhaustivement — et c'est là que se trouve
la valeur du système.

### Ce que contient le moteur

| Module | Rôle |
|---|---|
| `grade.ts` | Coût métabolique de Minetti (2002), **avec choix de foulée** : en montée raide on marche, et la marche y est moins coûteuse. La plupart des implémentations de GAP appliquent aveuglément le polynôme de course et surestiment massivement les montées. |
| `criticalSpeed.ts` | Vitesse critique et D′, ajustement à 2 paramètres, W′bal (forme différentielle de Froncioni-Skiba), fusion bayésienne avec l'a priori du laboratoire. |
| `load.ts` | rTSS sur vitesse corrigée de la pente, TRIMP, hrTSS, et **charge mécanique excentrique** pondérée par la pente et la vitesse de descente. |
| `pmc.ts` | Deux chartes de forme parallèles, ACWR (méthode EWMA), monotonie et contrainte de Foster, vitesse de progression. |
| `durability.ts` | Régression du rendement sur le temps et le dénivelé cumulés, agrégation robuste sur l'historique. |
| `prediction.ts` | Résolution de course **à puissance métabolique constante**, avec plafond de vitesse en descente, redistribution de la capacité inutilisée, plan d'allure et facteurs limitants chiffrés en temps perdu. |
| `intervals.ts` | Détection automatique des blocs d'effort par hystérésis, jugement de régularité d'une série. |
| `thresholds.ts` | Construction et vieillissement du modèle, provenance de chaque paramètre. |

---

## Le coach

### Dans l'application

Le chat consulte les données avant de répondre, et affiche chaque outil appelé —
le raisonnement est vérifiable, pas magique. Il agit : annonce-lui une course, il
l'enregistre et reconstruit ta préparation.

### Depuis Claude Desktop ou Claude Code

Le serveur MCP expose exactement les mêmes outils et les mêmes données. Voir
[docs/mcp.md](docs/mcp.md).

---

## Commandes

| Commande | Effet |
|---|---|
| `npm run service -- install` / `uninstall` | installe ou retire le service (LaunchAgent, Tailscale Serve) |
| `npm run service -- update` | met HEAD en service sans attendre de commit, ou retente un refus ; refuse un arbre non commité |
| `npm run service -- status` | état launchd, réponses des serveurs, adresse HTTPS, journaux |
| `npm run dev` | API + interface web en développement, sur 4001 et 3001 |
| `npm run dev:api` / `npm run dev:web` | l'un ou l'autre |
| `npm test` | suite de tests du moteur et du planificateur |
| `npm run typecheck` | vérification TypeScript de tout le dépôt |
| `npm run db:push` | applique le schéma |
| `npm run db:seed` | crée le profil depuis le test d'effort |
| `npm run mcp` | démarre le serveur MCP en stdio |
| `npm run sync -w @cairn/api sync 60` | importe 60 activités Strava |
| `npm run sync -w @cairn/api reanalyze` | ré-analyse l'historique avec le moteur courant |
| `npm run sync -w @cairn/api webhook` | crée la souscription webhook |

---

## Limites assumées

- **Mono-athlète.** Une instance, un coureur. Le schéma est multi-athlète mais
  l'API ne l'expose pas ; c'est un choix de simplicité, pas un oubli.
- **Pas de HRV automatique.** Strava ne l'expose pas. Le relevé quotidien accepte
  une saisie manuelle (Whoop, Oura, Garmin).
- **Le D− n'est pas publié par Strava** : il est recalculé depuis le profil
  altimétrique lissé, et vaut le D+ par défaut quand les flux manquent.
- **Prédiction de classement** : convertir un rang visé en temps cible exige les
  résultats des éditions précédentes. Sans eux, le système le dit au lieu
  d'inventer un chiffre.
- **Profil de course synthétique** quand aucun GPX n'est fourni : l'alternance
  montée / roulant / descente est reconstruite à partir du D+ et du D− annoncés.
  Fournir le vrai profil améliore nettement le plan d'allure.

## Avertissement

Cairn est un outil d'entraînement, pas un dispositif médical. Douleur persistante,
douleur osseuse localisée, symptôme inhabituel : consulte un médecin. Le système
est conçu pour adapter la charge en conséquence, pas pour poser un diagnostic.
