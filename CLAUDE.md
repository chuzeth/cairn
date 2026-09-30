# Cairn

Coaching trail personnalisé, mono-utilisateur (`CAIRN_ATHLETE_ID=pierre`). Le test
d'effort du 24/07/2025 sert d'a priori ; les données Strava le corrigent en continu.

## Invariants

`packages/physiology` est pur : ni base, ni réseau, ni modèle de langage. C'est ce
qui le rend testable exhaustivement, et c'est là qu'est la valeur du système. Une
dépendance ajoutée à ce paquet est un défaut, pas un raccourci.

Les décisions de charge — alléger, décaler, annuler — touchent au risque de
blessure. Elles viennent de règles explicites dans `packages/coach/src/adapt.ts`,
jamais d'un modèle de langage. Claude explique et propose ; il ne décide pas.

Chaque paramètre physiologique porte sa provenance (`lab`, `field`, `blended`,
`default`). Un paramètre affiché sans provenance est un bug : l'athlète a le droit
de savoir sur quoi repose ce qu'on lui demande de faire.

Une estimation qui atteint sa borne de sécurité n'est pas une mesure. La traiter
comme telle propage une erreur silencieuse jusqu'à la prédiction de course.

`ANTHROPIC_API_KEY` est optionnelle et facturée à l'usage : le coach passe par le
serveur MCP, où le modèle est fourni par le client. Ne rends aucune fonction
dépendante de cette clé sans dire ce qui cesse de fonctionner sans elle.

## Commandes

```
npm test                              npx tsc -b
npm run dev                           npm run sync -w @cairn/api -- sync [n]
npm run service -- update             npm run service -- status
npm run service -- passkey            npm run service -- logout-all
```

Internet n'atteint Cairn que par Tailscale Funnel, et Funnel que la porte
(`apps/gate`, 3100) : session par clé d'accès exigée avant tout relais. Le site
(3000) reste sans connexion pour le Mac seul ; rien ne doit jamais l'exposer.

Le téléphone ouvre le service installé, qui tourne sur un instantané vérifié.
Commiter sur main, c'est déployer : un crochet git met le service à jour en
arrière-plan, et rien n'est remplacé si `npm test`, `npx tsc -b` ou la
construction échoue — le refus se lit dans `npm run service -- status` et dans
l'app. Un changement non commité ne l'atteint jamais.

## Méthode de travail

Livre exactement ce qui est demandé, au périmètre demandé. Tranche seul les
décisions de routine ; ne remonte que ce qui changerait matériellement le travail
selon l'interprétation retenue. Si la demande te paraît fausse, ou qu'une meilleure
approche existe, dis-le en une phrase et poursuis la tâche telle que demandée —
plutôt que de la rétrécir, l'élargir ou la transformer en silence.

Enchaîne les étapes qui ne demandent pas l'avis de Pierre. Ne rends la main que si
rien ne peut avancer sans lui, ou avant une action destructrice ou irréversible.
Ne t'arrête pas sur un compte rendu qui annonce l'étape suivante : fais-la. Si tu
ne peux pas finir, dis ce qui manque et pourquoi.

Pour un défaut, écris d'abord le test qui le reproduit, et montre qu'il échouait
avant le correctif. Un test qui passe des deux côtés ne prouve rien.

Écris peu. Le rapport de fin de tâche tient en quelques phrases : d'abord ce qui
attend une décision de Pierre, s'il y en a ; puis ce qui a changé, ce qui a été
mesuré, ce qui reste ouvert. Ni récapitulatif structuré, ni section
« prochaines étapes » non demandée. Les fichiers que tu écris suivent la même
règle : couvrir le fond, sans remplissage.

Termine par les sorties brutes de `npm test`, `npx tsc -b` et `git diff --stat`.
Elles sont lues par une autre session et remplacent le résumé au lieu de s'y ajouter.

Ne délègue à un sous-agent que des tâches larges et réellement parallélisables.
Jamais pour vérifier ton propre travail, jamais pour ce que tu peux finir en
quelques appels d'outils.
