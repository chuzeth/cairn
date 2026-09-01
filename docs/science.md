# Fondements scientifiques

Ce document recense les modèles utilisés et les choix qui s'écartent des
implémentations courantes. Chaque écart est un choix délibéré, motivé par la
spécificité du trail.

## Coût de la locomotion

**Minetti A.E. et al. (2002)**, *Energy cost of walking and running at extreme
uphill and downhill slopes*, J Appl Physiol 93:1039-1046. Polynômes de degré 5 en
pente fractionnelle, valides sur [−0,45 ; +0,45], en J·kg⁻¹·m⁻¹ :

```
Course : Cr(i) = 155,4 i⁵ − 30,4 i⁴ − 43,3 i³ + 46,3 i² + 19,5 i + 3,6
Marche : Cw(i) = 280,5 i⁵ − 58,7 i⁴ − 76,8 i³ + 51,9 i² + 19,6 i + 2,5
```

### Écart assumé : le choix de foulée

La plupart des implémentations de *grade-adjusted pace* appliquent le polynôme de
**course** à toutes les pentes. En trail, c'est faux : au-delà de ~20 % personne
ne court, et la marche y coûte nettement moins cher.

Cairn détermine la foulée réellement employée à partir d'un seuil de transition
marche/course dépendant de la pente (`walkRunTransitionSpeed`) : ~2,1 m/s à plat,
décroissant en montée. À 25 % de pente, le seuil vaut ~1,55 m/s — soit environ
1 350 m D+/h, le rythme d'un très bon grimpeur.

Concrètement, une marche à 1,2 m/s sur 25 % équivaut à **11,4 km/h à plat** avec
le coût de marche, contre 12,9 km/h avec le coût de course : une surestimation de
13 % que le modèle naïf répète sur chaque montée de chaque séance.

## Vitesse critique

Modèle hyperbolique à deux paramètres, `d = CS · t + D′`, ajusté par régression
linéaire de la distance sur le temps pour des durées de 2 à 20 minutes. En dessous
de deux minutes, la contribution anaérobie casse la linéarité ; au-delà de vingt,
la fatigue lente tire CS vers le bas.

Le bilan de D′ suit la **forme différentielle de Froncioni-Skiba** : décharge
proportionnelle au dépassement de CS, recharge asymptotique d'autant plus rapide
que l'écart sous CS est grand.

Quand le terrain ne fournit pas encore d'efforts maximaux exploitables, un a priori
issu du laboratoire prend le relais (CS ≈ 1,02 × vitesse SV2), avec une fusion
pondérée par la qualité de l'ajustement.

## Charge d'entraînement

- **rTSS** — `(durée / 3600) × IF² × 100`, où `IF` est le rapport entre la vitesse
  graduée normalisée et la vitesse au seuil. Une heure exactement au seuil vaut
  100 points, par construction. La vitesse graduée normalisée est une moyenne
  d'ordre 4 sur fenêtre glissante de 30 s : la puissance quatrième pénalise les
  variations d'intensité, qui coûtent physiologiquement plus qu'un effort constant
  de même moyenne — exactement ce qui se passe sur un sentier.
- **TRIMP** — Banister, pondération exponentielle de la fraction de FC de réserve.
- **hrTSS** — filet de sécurité quand la vitesse GPS est inexploitable (forêt
  dense, canyon).

### Écart assumé : la charge mécanique excentrique

Aucune des métriques ci-dessus ne voit la descente. Le coût métabolique y est
faible — `Cr(−0,18) ≈ 1,8` contre 3,6 à plat — alors que c'est précisément la
descente qui détruit les fibres et dicte la récupération en trail.

Cairn calcule donc une seconde charge, à partir du travail négatif absorbé
(`m·g·Δh`), pondéré par deux facteurs :

- **la pente** : plus c'est raide, moins il y a d'appuis pour absorber la même
  énergie, donc plus la force par appui est élevée ;
- **la vitesse** : l'énergie d'impact croît avec la vitesse de descente.

Échelle calibrée pour que 1 000 m de D− à pente et vitesse modérées valent
≈ 40 points, du même ordre que le coût métabolique d'une sortie longue vallonnée.

## Chartes de forme

Modèle à réponse impulsionnelle de Banister, avec **deux jeux de constantes de
temps** :

| Filière | Chronique | Aiguë | Justification |
|---|---|---|---|
| Métabolique | 42 j | 7 j | Usage historique, bien établi. |
| Mécanique | 28 j | 5 j | Les dégâts musculaires culminent à 24-48 h et se résorbent en 5 à 10 jours ; la protection acquise (effet de séance répétée) se construit sur quelques semaines et se perd plus vite que la caisse. |

**ACWR** par la méthode EWMA (Williams et al., 2017), plus fidèle que la moyenne
glissante. Fenêtre de confort 0,8-1,3 ; au-delà de 1,5, le risque de blessure
augmente nettement. **Monotonie et contrainte de Foster** en complément : un
entraînement trop uniforme est un facteur de risque documenté indépendamment du
volume.

## Durabilité

Troisième dimension de la performance d'endurance, après la VO2max et l'économie
de course (Maunder, Jones, Muniz-Pumares). Mesurée par régression du facteur
d'efficience — vitesse graduée par battement — sur le temps écoulé et le dénivelé
cumulé, sur des fenêtres glissantes de dix minutes en régime aérobie stable. Les
fenêtres contenant des arrêts ou du travail supra-seuil sont écartées.

L'agrégation sur l'historique utilise une médiane pondérée par la fraîcheur, la
durée couverte et la qualité de l'échantillon, avec rejet des valeurs aberrantes
— une séance par 34 °C ne dit rien de la durabilité intrinsèque.

## Prédiction de course

**Principe : sur terrain varié, l'allure optimale n'est pas une vitesse constante,
c'est une puissance métabolique constante.** Le solveur résout la course en
puissance, puis convertit segment par segment en vitesse.

La fraction de vitesse critique soutenable décroît avec la durée selon
`f = 1 − 0,0548·L − 0,0081·L²`, avec `L = ln(T/1200 s)` — calibrée sur les repères
classiques : 100 % à 20 min, ~93 % à 1 h, ~88 % à 2 h, ~84 % à 4 h, ~77 % à 6 h,
~72 % à 10 h.

### Écart assumé : le plafond de descente

Un modèle qui convertit naïvement la puissance disponible en vitesse fait dévaler
un −12 % à 25 km/h. En descente, le facteur limitant n'est pas l'aérobie mais la
tolérance aux forces d'impact, la technique de pied et la lisibilité du terrain.

Cairn impose donc un plafond `descentSpeedCeiling(pente, technicité, aisance)` —
et redistribue vers les montées la moitié de la capacité métabolique ainsi
libérée, ce que fait naturellement un coureur qui gère bien. Sans redistribution,
le modèle serait doublement conservateur.

L'aisance en descente est **apprise** depuis les vitesses réellement tenues par
tranche de pente : c'est une compétence, pas une qualité physiologique, et souvent
le gisement de temps le plus rentable.

### Écart assumé : la technicité comme surcoût

La technicité du terrain est modélisée comme un **surcoût de transport**, non
comme une perte de vitesse. C'est la formulation correcte : un pierrier ne fait
pas produire moins de watts, il fait coûter plus cher chaque mètre. L'exprimer en
perte de vitesse conduit à la double-compter dès qu'on raisonne en puissance.

## Environnement

- **Chaleur** : pénalité croissante avec la température **et** la durée —
  l'accumulation de chaleur est un phénomène intégratif. Ordre de grandeur
  cohérent avec la littérature marathon : ~2-3 % de perte à 25 °C sur 2-3 h,
  ~6-8 % à 32 °C. Atténuée par un crédit d'acclimatation.
- **Altitude** : chez le sujet entraîné, la dégradation de VO2max commence bas
  (~580 m) et progresse d'environ 6,8 % par 1 000 m — les athlètes à VO2max élevée
  sont *davantage* pénalisés, la limitation étant déjà pulmonaire au niveau de la
  mer. L'impact sur la vitesse soutenable vaut ~62 % de l'impact sur la VO2max, à
  intensité sous-maximale.

## Zones d'entraînement

Les coefficients sont calibrés pour **reproduire exactement** la prescription du
Centre de Médecine du Sport (Z1/Z2 à 0,91 × FC_SV1 et 0,82 × v_SV1 ; Z4 à
1,023 × FC_SV2). L'athlète retrouve dans l'application les chiffres de son compte
rendu — 141 / 155 / 171 / 175 / 187 bpm — et le moteur les fait évoluer avec lui.

L'**indice de polarisation** suit Treff et al. (2019) : `log₁₀(Z_bas/Z_modéré ×
Z_haut × 100)`. Au-delà de 2,00 la distribution est réellement polarisée ;
en dessous, elle est pyramidale ou seuillée.
