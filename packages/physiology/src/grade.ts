import { clamp, G, movingAverage } from './units.js';

/**
 * Coût énergétique de la locomotion en fonction de la pente.
 *
 * Modèle : Minetti A.E. et al. (2002), « Energy cost of walking and running at
 * extreme uphill and downhill slopes », J Appl Physiol 93:1039-1046.
 * Polynômes de degré 5 en pente fractionnelle i, valides pour i ∈ [−0,45 ; +0,45].
 * Unité : J·kg⁻¹·m⁻¹.
 *
 * Le raffinement décisif pour le trail : un coureur ne *court* pas en montée
 * raide, il marche — et la marche y est nettement moins coûteuse. Le moteur
 * choisit donc la foulée réellement employée (cf. `gaitForSpeed`) au lieu
 * d'appliquer aveuglément le polynôme de course, ce que fait la plupart des
 * implémentations de GAP et qui surestime massivement les montées.
 */

/** Coût de la course à pied, J·kg⁻¹·m⁻¹. */
export function runningCost(grade: number): number {
  const i = clamp(grade, -0.45, 0.45);
  return (
    155.4 * i ** 5 - 30.4 * i ** 4 - 43.3 * i ** 3 + 46.3 * i ** 2 + 19.5 * i + 3.6
  );
}

/** Coût de la marche, J·kg⁻¹·m⁻¹. */
export function walkingCost(grade: number): number {
  const i = clamp(grade, -0.45, 0.45);
  return (
    280.5 * i ** 5 - 58.7 * i ** 4 - 76.8 * i ** 3 + 51.9 * i ** 2 + 19.6 * i + 2.5
  );
}

/** Coût de la course à plat — dénominateur de toutes les corrections de pente. */
export const FLAT_RUNNING_COST = 3.6;

/**
 * Vitesse de transition marche / course, m/s.
 *
 * Ce n'est pas une limite physique mais un seuil comportemental : en dessous,
 * un coureur marche ; au-dessus, il court. Il vaut ~2,1 m/s (7,6 km/h) à plat
 * et décroît en montée — au-delà de 20 % de pente, plus personne ne court, et
 * une marche à 1,5 m/s y représente déjà un rythme de très bon grimpeur
 * (≈ 1 350 m D+/h). En descente, le seuil baisse plus doucement : on court
 * naturellement dès que le terrain le permet.
 */
export function walkRunTransitionSpeed(grade: number): number {
  const i = clamp(grade, -0.45, 0.45);
  return clamp(i >= 0 ? 2.1 - 2.2 * i : 2.1 + 1.4 * i, 1.0, 2.2);
}

export type Gait = 'walk' | 'run';

/** Foulée réellement employée, déduite de la vitesse et de la pente. */
export function gaitForSpeed(speedMs: number, grade: number): Gait {
  return speedMs <= walkRunTransitionSpeed(grade) ? 'walk' : 'run';
}

/** Coût métabolique effectif compte tenu de la foulée réellement employée. */
export function locomotionCost(speedMs: number, grade: number): number {
  return gaitForSpeed(speedMs, grade) === 'walk' ? walkingCost(grade) : runningCost(grade);
}

/**
 * Facteur d'ajustement de pente : rapport entre le coût réel et le coût à plat.
 * `gapSpeed = speed × gradeFactor`.
 */
export function gradeFactor(speedMs: number, grade: number): number {
  return locomotionCost(speedMs, grade) / FLAT_RUNNING_COST;
}

/**
 * Vitesse corrigée de la pente (GAP) : la vitesse de course à plat qui coûterait
 * la même puissance métabolique. C'est l'unité de compte du moteur : elle rend
 * comparables un 1000 m sur piste et une montée de col.
 */
export function gradeAdjustedSpeed(speedMs: number, grade: number): number {
  if (!Number.isFinite(speedMs) || speedMs <= 0) return 0;
  return speedMs * gradeFactor(speedMs, grade);
}

/** Puissance métabolique instantanée, W/kg. */
export function metabolicPower(speedMs: number, grade: number): number {
  if (!Number.isFinite(speedMs) || speedMs <= 0) return 0;
  return locomotionCost(speedMs, grade) * speedMs;
}

/**
 * Vitesse soutenable à une pente donnée pour une puissance métabolique cible.
 * Inverse de `metabolicPower` — utilisé pour construire les plans d'allure :
 * « à quelle vitesse dois-je monter ce col pour tenir 4,2 W/kg ? »
 */
export function speedForMetabolicPower(powerWkg: number, grade: number): number {
  if (powerWkg <= 0) return 0;

  // Le coût dépend de la foulée, qui dépend elle-même de la vitesse cherchée.
  // Plutôt qu'un point fixe — qui oscille au voisinage du seuil de transition —
  // on énumère les deux solutions candidates et on retient celle qui est
  // cohérente avec la foulée qu'elle implique. Exactement une l'est, sauf
  // lorsque la solution tombe pile sur le seuil : on le renvoie alors.
  const transition = walkRunTransitionSpeed(grade);
  const vRun = powerWkg / runningCost(grade);
  const vWalk = powerWkg / walkingCost(grade);

  if (vRun > transition) return vRun;
  if (vWalk <= transition) return vWalk;
  return transition;
}

/**
 * Pente à partir de laquelle, à une puissance métabolique donnée, la foulée
 * employée est la marche — le seuil de bascule marche/course, lu en pente
 * plutôt qu'en vitesse.
 *
 * C'est la règle qu'un coureur applique sur un sentier : il ne regarde pas sa
 * vitesse, il regarde la pente. À la puissance de sa zone d'endurance, courir
 * au-delà de cette pente l'obligerait à ralentir sous la vitesse où la marche
 * devient la foulée naturelle — il y dépense plus pour aller moins vite.
 *
 * Rendue en fraction (0.09 = 9 %), à 0,1 % près ; 0 si la marche l'emporte déjà
 * à plat, 0,45 si la course tient jusqu'au bout du domaine du modèle.
 */
export function walkingGrade(powerWkg: number): number {
  if (!(powerWkg > 0)) return 0;
  const walks = (grade: number) => gaitForSpeed(speedForMetabolicPower(powerWkg, grade), grade) === 'walk';
  if (walks(0)) return 0;
  if (!walks(0.45)) return 0.45;
  let lo = 0;
  let hi = 0.45;
  while (hi - lo > 0.0005) {
    const mid = (lo + hi) / 2;
    if (walks(mid)) hi = mid;
    else lo = mid;
  }
  return Math.round(hi * 1000) / 1000;
}

/**
 * Vitesse ascensionnelle (VAM), en mètres de dénivelé positif par heure.
 * Métrique reine de la montée : indépendante de la distance et donc du tracé.
 */
export function vam(speedMs: number, grade: number): number {
  if (grade <= 0) return 0;
  // Vitesse le long de la pente → composante verticale. Pour de faibles pentes,
  // sin(atan(i)) ≈ i, mais on garde la trigonométrie exacte pour les pentes raides.
  const vertical = speedMs * Math.sin(Math.atan(grade));
  return vertical * 3600;
}

/**
 * Lissage d'altitude. Les altimètres barométriques dérivent et le GPS ajoute un
 * bruit métrique ; sans lissage, le D+ est surestimé de 20-40 % et toutes les
 * pentes instantanées sont fausses.
 */
export function smoothAltitude(altitude: readonly number[], windowS = 15): number[] {
  if (altitude.length < 3) return altitude.slice();
  // Deux passes : médiane courte (supprime les pics aberrants) puis moyenne.
  const median = medianFilter(altitude, 5);
  return movingAverage(median, Math.max(3, windowS | 1));
}

function medianFilter(values: readonly number[], window: number): number[] {
  const half = Math.floor(window / 2);
  const out = new Array<number>(values.length);
  const buf: number[] = [];
  for (let i = 0; i < values.length; i++) {
    buf.length = 0;
    for (let j = i - half; j <= i + half; j++) {
      const v = values[clamp(j, 0, values.length - 1)];
      if (v != null && Number.isFinite(v)) buf.push(v);
    }
    buf.sort((a, b) => a - b);
    out[i] = buf.length ? (buf[buf.length >> 1] as number) : (values[i] as number);
  }
  return out;
}

/**
 * Pente instantanée à partir des flux distance/altitude, calculée sur une
 * fenêtre glissante en *distance* (et non en temps) : c'est la seule façon
 * d'obtenir une pente stable quand la vitesse varie fortement.
 */
export function computeGrade(
  distance: readonly number[],
  altitude: readonly number[],
  windowM = 30,
): number[] {
  const n = Math.min(distance.length, altitude.length);
  const smooth = smoothAltitude(altitude);
  const out = new Array<number>(n).fill(0);
  let lo = 0;
  let hi = 0;
  for (let i = 0; i < n; i++) {
    const d = distance[i] as number;
    while (lo < i && (d - (distance[lo] as number)) > windowM / 2) lo++;
    hi = Math.max(hi, i);
    while (hi < n - 1 && ((distance[hi] as number) - d) < windowM / 2) hi++;
    const dd = (distance[hi] as number) - (distance[lo] as number);
    const dz = (smooth[hi] as number) - (smooth[lo] as number);
    out[i] = dd > 1 ? clamp(dz / dd, -0.6, 0.6) : 0;
  }
  return out;
}

/**
 * Dénivelé positif et négatif à partir d'un profil altimétrique lissé, avec un
 * seuil de bruit : seules les variations dépassant `thresholdM` sont comptées.
 */
export function elevationChange(
  altitude: readonly number[],
  thresholdM = 1.0,
): { gainM: number; lossM: number } {
  const smooth = smoothAltitude(altitude);
  let gain = 0;
  let loss = 0;
  let anchor = smooth[0] ?? 0;
  for (let i = 1; i < smooth.length; i++) {
    const z = smooth[i] as number;
    const delta = z - anchor;
    if (delta >= thresholdM) { gain += delta; anchor = z; }
    else if (delta <= -thresholdM) { loss += -delta; anchor = z; }
  }
  return { gainM: gain, lossM: loss };
}

/**
 * Travail mécanique vertical, en joules par kilogramme de masse corporelle.
 * Le travail négatif (descente) est celui qui détruit les fibres : il est
 * comptabilisé séparément car la fatigue qu'il crée n'est pas cardiovasculaire.
 */
export function verticalWork(gainM: number, lossM: number): { positiveJPerKg: number; negativeJPerKg: number } {
  return { positiveJPerKg: gainM * G, negativeJPerKg: lossM * G };
}
