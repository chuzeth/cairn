# Connecter Strava

## 1. Créer l'application Strava

Va sur **https://www.strava.com/settings/api** et crée une application :

| Champ | Valeur |
|---|---|
| Application Name | Cairn |
| Category | Training |
| Website | `http://localhost:3000` |
| Authorization Callback Domain | `localhost` |

⚠️ Le champ *Authorization Callback Domain* attend un **domaine nu**, sans schéma
ni port : `localhost`, pas `http://localhost:4000`. C'est l'erreur la plus
fréquente à cette étape.

Récupère le **Client ID** et le **Client Secret**.

## 2. Renseigner `.env`

À la racine du projet :

```bash
STRAVA_CLIENT_ID=123456
STRAVA_CLIENT_SECRET=xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx
STRAVA_REDIRECT_URI=http://localhost:4000/auth/strava/callback
```

Puis relance l'API.

## 3. Autoriser l'accès

Ouvre **http://localhost:4000/auth/strava**. Strava demande l'autorisation, puis
redirige vers Cairn — l'import de l'historique démarre en arrière-plan.

Les portées demandées sont `read`, `activity:read_all` et `profile:read_all`.
`activity:read_all` est indispensable : sans elle, les sorties privées sont
invisibles. **Aucune portée d'écriture n'est demandée** — Cairn ne modifie jamais
ton compte Strava.

## 4. Importer l'historique

Le premier import récupère 60 activités. Pour aller plus loin :

```bash
npm run sync -w @cairn/api sync 200
```

Chaque activité coûte deux appels à l'API Strava (résumé détaillé + flux), et le
quota est de **100 requêtes par quart d'heure et 1 000 par jour**. Le client
s'arrête proprement avant de le saturer et enregistre sa progression : relance la
même commande un quart d'heure plus tard, elle repart exactement où elle s'était
interrompue, sans jamais retélécharger ce qui est déjà en base.

Compte environ 15 minutes pour 400 activités, en plusieurs passes.

## 5. Mise à jour automatique (webhooks)

Pour que chaque nouvelle séance déclenche l'analyse sans intervention, Strava doit
pouvoir appeler ton serveur — il lui faut donc une URL publique en HTTPS.

En local, avec [ngrok](https://ngrok.com) :

```bash
ngrok http 4000
```

Reporte l'URL fournie dans `.env` :

```bash
PUBLIC_BASE_URL=https://xxxx-xx-xx-xxx-xx.ngrok-free.app
STRAVA_WEBHOOK_VERIFY_TOKEN=un-jeton-que-tu-choisis
```

Relance l'API, puis crée la souscription :

```bash
npm run sync -w @cairn/api webhook
```

Strava valide en appelant `GET /webhook/strava` avec un défi que l'API renvoie
automatiquement. Vérifier l'état à tout moment :

```bash
curl localhost:4000/webhook/status
```

Sans webhook, tout fonctionne — il faut simplement lancer la synchronisation à la
main (bouton « Synchroniser Strava » sur le tableau de bord).

## Ce qui est exploité

Cairn ne se contente pas des résumés d'activité. Sont utilisés :

- **flux à 1 Hz** : temps, distance, altitude, vitesse, fréquence cardiaque,
  cadence, puissance, température, position, état de mouvement ;
- **détail d'activité** : description, tours, splits, meilleurs efforts, matériel,
  appareil d'enregistrement ;
- **matériel** : kilométrage des chaussures, pour l'alerte d'usure ;
- **température** : correction de la contrainte thermique sur la charge ;
- **altitude** : correction de la performance en altitude.

La cadence est convertie de cycles/min (convention Strava) en pas/min. Le dénivelé
négatif, que Strava ne publie pas, est recalculé depuis le profil altimétrique
lissé — sans lissage, le D+ est surestimé de 20 à 40 % et toutes les pentes
instantanées sont fausses.

## Dépannage

| Symptôme | Cause probable |
|---|---|
| `Échec de l'échange de jeton Strava (400)` | Client ID/Secret erronés, ou `redirect_uri` différent de celui déclaré. |
| `Ressource Strava introuvable` sur les flux | Activité manuelle ou sans GPS : normal, l'activité est stockée sans analyse fine. |
| Souscription webhook refusée | `PUBLIC_BASE_URL` n'est pas joignable publiquement en HTTPS. |
| `Quota Strava atteint` | Attends le prochain quart d'heure et relance la synchronisation. |
| Aucune activité privée importée | La portée `activity:read_all` n'a pas été accordée : révoque l'accès sur Strava et recommence. |
