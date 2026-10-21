'use client';
import type { ReactNode } from 'react';
import { duration, frDate, num, spelledDuration, type SessionRow } from '@/lib/api';
import { PROVENANCE_SHORT } from '@/lib/sessions';
import {
  KIND_LABEL, countdownDays, flowOf, heartTarget, sessionKind, thresholdMinutes, weekShare, weekStartOf, type PartKind,
} from '@/lib/today';
import { isWorkout, stairsEstimated, workoutOf, type Part } from '@/lib/workout';
import { Term } from './Term';

/**
 * Les pièces de l'écran du jour, communes au téléphone et à l'ordinateur — la
 * refonte du 21/10.
 *
 * Chaque bloc de données commence par un filet d'encre et une étiquette en
 * petites capitales ; les nombres sont en Bodoni. Le téléphone et l'ordinateur
 * disent la même séance avec les mêmes mots.
 */

export interface Figure { label: ReactNode; value: ReactNode; note?: ReactNode }

/** Les chiffres d'une séance, côte à côte, séparés d'un filet. */
export function Figures({ items, className }: { items: Figure[]; className?: string }) {
  return (
    <dl className={className ? `t-figures ${className}` : 't-figures'} data-count={items.length}>
      {items.map((f, i) => (
        <div className="t-figure" key={i}>
          <dt className="t-label">{f.label}</dt>
          <dd className="t-value">{f.value}</dd>
          {f.note && <dd className="t-note">{f.note}</dd>}
        </div>
      ))}
    </dl>
  );
}

/**
 * Les chiffres d'une séance de renforcement : sa durée, son dénivelé, la cible
 * cardiaque qui tient le plus longtemps — avec sa provenance, comme tout
 * paramètre physiologique qu'on demande de tenir.
 */
export function sessionFigures(session: SessionRow, { notes = false }: { notes?: boolean } = {}): Figure[] {
  const items: Figure[] = [{ label: 'Durée', value: duration(session.plannedDurationS) }];
  const gain = Math.round(session.plannedElevationGainM ?? 0);
  if (gain > 0) {
    items.push({
      label: 'Dénivelé',
      value: `${num(gain)} m`,
      note: notes ? (stairsEstimated(session.blocks) ? 'environ, dans l’escalier' : 'en montée') : undefined,
    });
  }
  const heart = heartTarget(session.blocks);
  if (heart) {
    items.push({
      label: 'Cœur, bpm',
      value: heart.range[0] > 0 ? `${num(heart.range[0])}–${num(heart.range[1])}` : `< ${num(heart.range[1])}`,
      note: heart.provenance ? PROVENANCE_SHORT[heart.provenance] ?? heart.provenance : undefined,
    });
  }
  return items;
}

/** La barre du déroulé : une partie par segment, à sa durée, de la couleur de sa nature. */
export function SessionFlow({ parts, wide = false }: { parts: Part[]; wide?: boolean }) {
  const { segments, groups, minutes } = flowOf(parts);
  if (segments.length === 0) return null;
  const steps = parts.reduce((a, p) => a + p.steps.length, 0);
  return (
    <section className="t-block t-flow" data-wide={wide} aria-label={`Déroulé de la séance, ${minutes} minutes`}>
      <div className="t-head">
        <span>Déroulé</span>
        {wide ? (
          <span className="t-keys">
            {(['warm', 'cardio', 'renfo', 'mobi'] as PartKind[])
              .filter((k) => groups.some((g) => g.kind === k))
              .map((k) => <span key={k} className="t-key"><i data-kind={k} />{KIND_LABEL[k]}</span>)}
          </span>
        ) : (
          <span>{minutes} min · {steps} étape{steps > 1 ? 's' : ''}</span>
        )}
      </div>
      {wide && (
        <div className="t-flow-row t-flow-names" aria-hidden>
          {segments.map((s, i) => (
            <span key={i} style={{ flexGrow: s.minutes }}>{s.minutes >= 4 ? s.name : ''}</span>
          ))}
        </div>
      )}
      <div className="t-flow-row t-flow-bar">
        {segments.map((s, i) => (
          <span key={i} data-kind={s.kind} style={{ flexGrow: s.minutes }} title={`${s.name} · ${s.minutes} min`} />
        ))}
      </div>
      {wide ? (
        <div className="t-flow-row t-flow-mins" aria-hidden>
          {segments.map((s, i) => (
            <span key={i} style={{ flexGrow: s.minutes }}>{s.minutes >= 4 ? `${s.minutes} min` : `${s.minutes}′`}</span>
          ))}
        </div>
      ) : (
        <ul className="t-legend">
          {groups.map((g) => (
            <li key={g.kind}>
              <i data-kind={g.kind} />
              <span>{g.label}</span>
              <span className="t-legend-min">{g.minutes} min</span>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

/**
 * La charge d'une séance, et ce qu'elle veut dire : cent points valent une
 * heure à son seuil. « 86 » seul ne disait rien.
 */
export function ChargeLine({ session, sessions }: { session: SessionRow; sessions: SessionRow[] }) {
  const share = weekShare(session, sessions);
  return (
    <section className="t-block t-charge" aria-label="Charge de la séance">
      <div className="t-head">
        <span><Term k="points">Charge</Term></span>
        {share != null && <span>{share} % de la semaine</span>}
      </div>
      <p className="t-charge-line">
        <span className="t-charge-value">{num(session.plannedLoad)}</span>
        <span>points, l&apos;effort de {spelledDuration(thresholdMinutes(session.plannedLoad) * 60)} à ton seuil</span>
      </p>
    </section>
  );
}

/** La nature dominante d'une séance, pour le calendrier. */
const kindOfSession = (s: SessionRow): PartKind => (isWorkout(s) ? sessionKind(workoutOf(s)) : 'cardio');

/**
 * Les jours qui mènent à la course : une case par jour, de la couleur de ce
 * qui s'y fait ; le passé estompé, aujourd'hui cerclé, la course à l'encre.
 * Le 21/10, Pierre ne comprenait pas la frise « Vers le
 * Beaujolais » : un calendrier, avec ses dates, se lit sans légende à deviner.
 */
export function Countdown({
  today, race, sessions,
}: {
  today: string;
  race: { name: string; date: string; daysUntil?: number };
  sessions: SessionRow[];
}) {
  // Depuis le lundi : le plan que l'écran a lu ne remonte pas plus loin, et un
  // jour sans séance lue n'est pas un jour de repos.
  const back = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${weekStartOf(today)}T00:00:00Z`)) / 86_400_000);
  const days = countdownDays(today, race.date, sessions, kindOfSession, back);
  const ahead = sessions.filter((s) => s.date > today && s.date < race.date && s.type !== 'rest' && s.status !== 'withdrawn' && s.status !== 'cancelled').length;
  const n = race.daysUntil ?? days.filter((d) => !d.past && !d.today).length;
  return (
    <section className="t-countdown" aria-label={`${n} jours avant ${race.name}`}>
      <div className="t-countdown-lead">
        <span className="t-label">Jusqu&apos;à la course</span>
        <p className="t-countdown-n"><span>{n}</span> jour{n > 1 ? 's' : ''}</p>
        <p className="t-countdown-text">
          {race.name}, {frDate(race.date, { weekday: true, long: true })}. {ahead} séance{ahead > 1 ? 's' : ''} d&apos;ici là.
        </p>
      </div>
      <div className="t-countdown-scroll">
        <div className="t-days" style={{ gridTemplateColumns: `repeat(${days.length}, minmax(22px, 1fr))` }}>
          {days.map((d) => (
            <span
              key={d.date}
              className="t-day"
              data-kind={d.kind}
              data-past={d.past}
              data-today={d.today}
              title={`${frDate(d.date, { weekday: true, long: true })}${d.kind === 'rest' ? ' · rien de prévu' : d.kind === 'race' ? ` · ${race.name}` : ` · ${KIND_LABEL[d.kind as PartKind].toLowerCase()}`}`}
            />
          ))}
          {days.map((d) => (
            <span key={`n-${d.date}`} className="t-day-n" data-today={d.today} data-monday={new Date(`${d.date}T00:00:00Z`).getUTCDay() === 1}>
              {Number(d.date.slice(8, 10))}
            </span>
          ))}
        </div>
        <div className="t-days-key">
          {(['warm', 'cardio', 'renfo', 'mobi'] as PartKind[])
            .filter((k) => days.some((d) => d.kind === k))
            .map((k) => <span key={k} className="t-key"><i data-kind={k} />{KIND_LABEL[k]}</span>)}
          <span className="t-key"><i data-kind="rest" />Rien de prévu</span>
          <span className="t-key"><i data-kind="race" />Course</span>
        </div>
      </div>
    </section>
  );
}
