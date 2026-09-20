'use client';
import type { ReactNode } from 'react';
import { frDate, frStamp } from '@/lib/api';
import type { DeclaredAbsence, Readiness, ReadinessComponent, ReadinessSource } from '@/lib/api';
import { useOutbox } from '@/lib/offline';

export function Card({
  title, hint, action, children, style,
}: { title?: string; hint?: string; action?: ReactNode; children: ReactNode; style?: React.CSSProperties }) {
  return (
    <section className="card" style={style}>
      {(title || action) && (
        <div className="card-head">
          <div>
            {title && <h2 className="card-title">{title}</h2>}
            {hint && <div className="card-hint">{hint}</div>}
          </div>
          {action}
        </div>
      )}
      {children}
    </section>
  );
}

export function Metric({
  label, value, unit, note, tone, delta, direction,
}: {
  label: string; value: ReactNode; unit?: string; note?: string;
  tone?: 'good' | 'watch' | 'warn' | 'metabolic' | 'mechanical';
  delta?: string; direction?: 'up' | 'down' | 'flat';
}) {
  const color =
    tone === 'good' ? 'var(--good)'
    : tone === 'watch' ? 'var(--watch)'
    : tone === 'warn' ? 'var(--warn)'
    : tone === 'metabolic' ? 'var(--metabolic)'
    : tone === 'mechanical' ? 'var(--mechanical)'
    : undefined;
  return (
    <div className="metric">
      <div className="metric-label">{label}</div>
      <div className="metric-value" style={{ color }}>
        {value}
        {unit && <span className="metric-unit">{unit}</span>}
        {delta && <span className="delta" data-dir={direction ?? 'flat'} style={{ marginLeft: 8 }}>{delta}</span>}
      </div>
      {note && <div className="metric-note">{note}</div>}
    </div>
  );
}

export function Badge({ children, tone }: { children: ReactNode; tone?: string }) {
  return <span className="badge" data-tone={tone}>{children}</span>;
}

export function Empty({ children }: { children: ReactNode }) {
  return <div className="empty">{children}</div>;
}

export function Loading({ label = 'Chargement…' }: { label?: string }) {
  return (
    <div className="empty">
      <div className="row" style={{ justifyContent: 'center' }}>
        <span className="spinner" /> <span>{label}</span>
      </div>
    </div>
  );
}

export function ErrorBox({ error, onRetry }: { error: string; onRetry?: () => void }) {
  return (
    <div className="banner" data-tone="warn">
      <div style={{ flex: 1 }}>
        <strong>Impossible de charger les données.</strong>
        <div className="small muted" style={{ marginTop: 4 }}>{error}</div>
        <div className="tiny faint" style={{ marginTop: 6 }}>
          Vérifie que l'API tourne : <code>npm run dev:api</code>
        </div>
      </div>
      {onRetry && <button className="btn" onClick={onRetry}>Réessayer</button>}
    </div>
  );
}

/** Barre de répartition du temps par zone. */
export function ZoneBar({ fractions }: { fractions: Record<string, number> }) {
  const keys = ['Z1', 'Z2', 'Z3', 'Z4', 'Z5'];
  const total = keys.reduce((a, k) => a + (fractions[k] ?? 0), 0) || 1;
  return (
    <div className="zone-bar">
      {keys.map((k) => {
        const w = ((fractions[k] ?? 0) / total) * 100;
        return w > 0 ? <div key={k} className={`zone-seg zone-${k}`} style={{ width: `${w}%` }} title={`${k} · ${w.toFixed(0)} %`} /> : null;
      })}
    </div>
  );
}

/** Barre à trois zones : sous SV1 / entre seuils / au-dessus de SV2. */
export function ThreeZoneBar({ z }: { z: { low: number; moderate: number; high: number } }) {
  const total = z.low + z.moderate + z.high || 1;
  const seg = (v: number, color: string, label: string) =>
    v > 0 ? <div style={{ width: `${(v / total) * 100}%`, background: color }} title={label} /> : null;
  return (
    <div className="zone-bar">
      {seg(z.low, 'var(--z2)', `Bas ${Math.round((z.low / total) * 100)} %`)}
      {seg(z.moderate, 'var(--z4)', `Modéré ${Math.round((z.moderate / total) * 100)} %`)}
      {seg(z.high, 'var(--z5)', `Haut ${Math.round((z.high / total) * 100)} %`)}
    </div>
  );
}

export function Legend({ items }: { items: { color: string; label: string }[] }) {
  return (
    <div className="legend">
      {items.map((i) => (
        <span className="legend-item" key={i.label}>
          <span className="legend-swatch" style={{ background: i.color }} />
          {i.label}
        </span>
      ))}
    </div>
  );
}

/**
 * Au-delà, un état gardé cesse de se présenter comme l'état du jour.
 *
 * Trente-six heures, c'est une nuit de trop : une séance faite hier soir, un
 * relevé de ce matin, une adaptation de charge — rien de tout cela n'est dans
 * ce qu'on affiche. Un état périmé servi en silence est du même ordre qu'une
 * estimation saturée présentée comme une mesure.
 */
const STALE_HOURS = 36;

/** « 37 h », puis « 3 jours » — au-delà de deux jours, les heures ne se lisent plus. */
function since(hours: number): string {
  return hours < 48 ? `${hours} h` : `${Math.floor(hours / 24)} jours`;
}

/**
 * Ce que l'écran dit quand ce qu'il montre ne vient pas du réseau.
 *
 * Jamais un chiffre sans sa fraîcheur : tant que le Mac répond, cette ligne
 * n'existe pas ; dès qu'il ne répond plus, elle porte la date du relevé. Au-delà
 * de {@link STALE_HOURS}, elle dit en toutes lettres que ce n'est pas l'état du
 * jour, parce qu'une date seule finit par se lire comme un détail.
 */
export function Stale({ recordedAt }: { recordedAt: string }) {
  const hours = Math.max(0, Math.floor((Date.now() - new Date(recordedAt).getTime()) / 3_600_000));
  const expired = hours >= STALE_HOURS;
  return (
    <div className="stale" data-old={expired}>
      {expired ? (
        <>
          <strong>Sans contact depuis {since(hours)}.</strong> Ce que tu lis a été relevé le{' '}
          {frStamp(recordedAt)}. Ce n&apos;est pas ton état d&apos;aujourd&apos;hui : ni ta charge, ni
          ta disponibilité, ni ta séance n&apos;ont été recalculées depuis.
        </>
      ) : (
        <>Hors réseau · relevé du {frStamp(recordedAt)}</>
      )}
    </div>
  );
}

/**
 * Ce qui attend de partir.
 *
 * Tant que cette ligne est là, rien n'est enregistré — c'est toute la raison
 * pour laquelle elle est là. Un refus du serveur, lui, ne s'efface pas tout
 * seul : l'écriture est perdue, et se taire reviendrait à la déclarer partie.
 */
export function Waiting() {
  const { pending, refused } = useOutbox();
  if (refused) {
    return (
      <div className="stale" data-old="true">
        <strong>Ton envoi a été refusé.</strong> {refused} Rien n&apos;a été enregistré.
      </div>
    );
  }
  if (pending === 0) return null;
  return (
    <div className="stale">
      {pending === 1 ? 'Une réponse' : `${pending} réponses`} en attente d&apos;envoi
      {pending === 1 ? ' : elle partira' : ' : elles partiront'} au retour du réseau. Rien n&apos;est
      encore enregistré.
    </div>
  );
}

/** Nature d'une absence, en un mot. */
export const ABSENCE_KIND_LABEL: Record<DeclaredAbsence['kind'], string> = {
  chosen: 'Coupure',
  illness: 'Maladie',
  injury: 'Blessure',
  unavailable: 'Indisponibilité',
};

/**
 * Une absence déclarée, telle qu'elle doit se lire : sa période, les mots de
 * l'athlète, et ce qu'elle a retiré du plan.
 *
 * La chute de charge qui suit est réelle et le modèle a raison de la mesurer.
 * C'est cet encart qui l'empêche d'être lue comme un décrochage.
 */
export function AbsenceNotice({ absence, today }: { absence: DeclaredAbsence; today: string }) {
  const phase =
    absence.endDate < today ? 'terminée' : absence.startDate > today ? 'à venir' : 'en cours';
  const n = absence.withdrawnSessions;
  const plural = (n ?? 0) > 1 ? 's' : '';
  return (
    <div className="banner" data-tone="info" style={{ flexDirection: 'column', alignItems: 'stretch', gap: 9 }}>
      <div className="row-between">
        <strong>
          {ABSENCE_KIND_LABEL[absence.kind]} déclarée · {frDate(absence.startDate)} → {frDate(absence.endDate)}
        </strong>
        <Badge tone={phase === 'en cours' ? 'watch' : undefined}>{phase}</Badge>
      </div>
      <blockquote className="note-quote">{absence.reason}</blockquote>
      <p className="tiny faint" style={{ margin: 0 }}>
        {n == null
          ? ''
          : n > 0
            ? `${n} séance${plural} retirée${plural} du plan : ni à faire, ni manquée${plural}. `
            : 'Aucune séance du plan ne tombait sur cette période. '}
        {absence.source === 'athlete' ? 'Tu l’as annoncée toi-même. ' : ''}
        Ta charge chronique baisse sur cette période : c’est mesuré, et c’était prévu.
      </p>
    </div>
  );
}

/** Provenance d'une composante de disponibilité, dite en trois mots. */
export const READINESS_SOURCE_LABEL: Record<ReadinessSource, string> = {
  load: 'charge mesurée',
  declared: 'déclaré',
  partial: 'partiel',
  baseline: 'vs ta norme',
  hrv: 'rMSSD',
  'resting-hr': 'FC repos',
  default: 'par défaut',
};

const BASIS_ROWS = [
  ['tsbMetabolic', 'Fraîcheur métabolique'],
  ['tsbMechanical', 'Fraîcheur mécanique'],
  ['subjective', 'Ressenti déclaré'],
  ['autonomic', 'Système autonome'],
] as const;

/** Ce que le score n'a pas les moyens de regarder, nommé pour être réclamé. */
export const MISSING_LABEL: Record<'subjective' | 'autonomic', string> = {
  subjective: 'ton ressenti',
  autonomic: 'ton système autonome',
};

/** Les composantes qui ne pèsent rien, faute de source. */
export function unweighed(readiness: Readiness): ('subjective' | 'autonomic')[] {
  return (['subjective', 'autonomic'] as const).filter((k) => (readiness.weights?.[k] ?? 0) === 0);
}

/**
 * Les quatre composantes de la disponibilité, chacune avec sa provenance et
 * le poids qu'elle a réellement pesé.
 *
 * Ce poids n'est pas décoratif : une composante sans source pèse 0 et son poids
 * nominal part aux autres, si bien que la même barre ne vaut pas la même chose
 * d'un jour à l'autre. L'afficher est la seule façon de lire le score.
 *
 * Les deux nombres d'une ligne se disent donc, au lieu de se deviner. « Charge
 * mesurée 54 % / 75 » demandait à l'athlète de trouver seul lequel des deux
 * était le poids et lequel la valeur — et l'info-bulle qui le disait n'existe
 * pas sous le pouce. C'est la carte qui porte l'honnêteté du score : elle ne
 * peut pas être la seule à se lire de travers.
 */
export function ReadinessBasis({ readiness, before }: { readiness: Readiness; before?: Readiness }) {
  return (
    <div className="basis">
      {BASIS_ROWS.map(([key, label]) => {
        const value = readiness.components[key] ?? 0;
        const source = readiness.sources[key];
        const weight = readiness.weights?.[key as ReadinessComponent] ?? 0;
        // Deux états à ne pas confondre. Sans source, la composante ne pèse rien
        // et sa barre reste vide : il n'y a rien à montrer. Une valeur par défaut
        // qui pèse malgré tout — le cas où plus rien n'est mesuré nulle part —
        // reste hachurée : elle occupe la place d'une mesure sans en être une.
        const idle = weight === 0;
        const assumed = !idle && source === 'default';
        // Un écart ne se calcule pas contre une composante qui ne pesait rien :
        // la comparaison ferait passer sa valeur de remplissage pour un état.
        const wasIdle = before ? (before.weights?.[key as ReadinessComponent] ?? 0) === 0 : true;
        const delta = before && !wasIdle ? value - (before.components[key] ?? 0) : 0;
        const changedSource = before && before.sources[key] !== source;
        return (
          <div className="basis-row" key={key}>
            <span className="basis-name">{label}</span>
            <span className="basis-src" data-assumed={assumed || idle}>
              {changedSource && <s className="faint">{READINESS_SOURCE_LABEL[before.sources[key]]}</s>}
              {READINESS_SOURCE_LABEL[source]}
              <span className="basis-weight">pèse {Math.round(weight * 100)} %</span>
            </span>
            <div className="basis-meter">
              <div
                className="basis-fill"
                data-assumed={assumed}
                style={{ width: idle ? 0 : `${Math.max(0, Math.min(100, value))}%` }}
              />
            </div>
            <span className="basis-num mono">
              {idle ? '—' : `${Math.round(value)}/100`}
              {!idle && delta !== 0 && (
                <span className="delta" data-dir={delta > 0 ? 'up' : 'down'} style={{ marginLeft: 5 }}>
                  {delta > 0 ? '+' : ''}{Math.round(delta)}
                </span>
              )}
            </span>
          </div>
        );
      })}
    </div>
  );
}
