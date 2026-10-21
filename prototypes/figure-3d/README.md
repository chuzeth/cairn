# Schémas 3D — prototype

Hors de l'app livrée : rien ici n'est servi par Cairn, ni importé par lui.

Un mannequin MakeHuman, riggé, posé par les squelettes 2D de `apps/web/lib/figure.ts`
sans toucher aux poses, rendu par three.js 0.186.1, sur trois exercices :
`split-squat-bulgare`, `step-up`, `dead-bug`.

## Voir

```
node prototypes/figure-3d/serve.mjs
```

- `http://127.0.0.1:3210/board.html` : la planche, vecteur contre 3D, les mesures, l'avis.
- `http://127.0.0.1:3210/?ex=step-up&theme=dark&hud=1` : une vignette et son compteur
  (`t=0.5` la fige à mi-geste, `yaw=35` la tourne, `report=10` envoie la fluidité au
  serveur, qui l'ajoute à `measures-fluidity.jsonl`).

## Reconstruire

```
npm install                                  # dans ce dossier : three, esbuild, gltf-transform
npm run model -- <dossier des fichiers MakeHuman>
npm run build
../../node_modules/.bin/tsx check.mts        # les garanties, sur le maillage posé
node measure-weight.mjs
```

Les fichiers MakeHuman viennent de
`https://github.com/makehumancommunity/makehuman/tree/master/makehuman/data` :
`3dobjs/base.obj`, `rigs/default.mhskel`, `rigs/default_weights.mhw`, et les huit cibles
que nomme `build-model.mjs` (`targets/macrodetails/…`).

## Licence

Les ressources MakeHuman sont sous CC0 1.0 : `LICENSE.md` §C du dépôt (« These assets have
been released under CC0 1.0 Universal »), `LICENSE.ASSETS.md`, et l'en-tête de chaque
fichier (`"license": "CC0"`). three.js est sous MIT.

## Ce qu'il faut savoir

- Le bras de MakeHuman est court (13,6 unités pour 18,6 chez Winter) : il est étiré de 37 %
  pour que le coude tombe sur celui du dessin. Ses cibles de longueur le feraient sans étirer.
- Dans Safari iOS (simulateur, iOS 26.1), les ombres PCF de three 0.186 grisent tout le sol :
  le prototype passe en VSM.
- `check.mts` classe à part ce que le dessin 2D a déjà : en bas de la fente bulgare, le tibia
  arrière entre de 3,4 unités dans le bord du banc, dans le dessin comme en 3D.
- La caisse du step-up est décalée sous le pied d'appui (`src/props.ts`) : centrée, la jambe
  restée au sol la traversait.
