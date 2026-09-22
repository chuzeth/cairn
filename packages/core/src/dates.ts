/**
 * Les dates relatives d'un texte, et la date qu'elles désignaient.
 *
 * Un texte enregistré se relit plus tard, et « ce soir » ne désigne alors plus
 * le soir qu'il désignait. La note du test maximal du 22/09 parlait de « ta
 * meilleure moyenne sur 20 min de ce soir » : écrite le 18/09, relue le matin
 * du test, elle parlait d'un soir que l'athlète n'avait pas couru.
 *
 * Seules les expressions qui renvoient au moment de l'écriture sont ancrées.
 * « Ce matin-là », « la veille », « le lendemain » renvoient à ce dont le texte
 * parle, et restent vraies quel que soit le jour où on les lit.
 */

/** Le jour, dans le fuseau de l'athlète, où un texte a été écrit. */
function localDay(at: string): Date {
  if (/^\d{4}-\d{2}-\d{2}$/.test(at)) return new Date(`${at}T00:00:00Z`);
  const day = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Europe/Paris', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(at));
  return new Date(`${day}T00:00:00Z`);
}

const shift = (d: Date, days: number) => new Date(d.getTime() + days * 86_400_000);
const dayMonth = (d: Date) =>
  `${String(d.getUTCDate()).padStart(2, '0')}/${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
/** Lundi de la semaine du jour donné. */
const mondayOf = (d: Date) => shift(d, -((d.getUTCDay() + 6) % 7));

const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'];

/** Ce qu'une expression désigne : un groupe nominal, et l'article qui l'ouvre. */
interface Anchored {
  article: 'le' | 'la' | null;
  phrase: string;
}

type Resolver = (day: Date, m: RegExpExecArray) => Anchored;

const moment = (p: string) => (p.toLowerCase() === 'après-midi' ? 'après-midi' : `au ${p.toLowerCase()}`);

/**
 * Les expressions reconnues, des plus longues aux plus courtes : « hier soir »
 * passe avant « hier », « après-demain » avant « demain ».
 */
const EXPRESSIONS: [string, Resolver][] = [
  ['avant-hier', (d) => ({ article: 'le', phrase: dayMonth(shift(d, -2)) })],
  ['après-demain', (d) => ({ article: 'le', phrase: dayMonth(shift(d, 2)) })],
  ['hier (soir|matin|après-midi)', (d, m) => ({ article: 'le', phrase: `${dayMonth(shift(d, -1))} ${moment(m[1]!)}` })],
  ['demain (soir|matin|après-midi)', (d, m) => ({ article: 'le', phrase: `${dayMonth(shift(d, 1))} ${moment(m[1]!)}` })],
  ['hier', (d) => ({ article: 'le', phrase: dayMonth(shift(d, -1)) })],
  ['demain', (d) => ({ article: 'le', phrase: dayMonth(shift(d, 1)) })],
  ["aujourd['’]hui", (d) => ({ article: 'le', phrase: dayMonth(d) })],
  ["tout à l['’]heure", (d) => ({ article: 'le', phrase: dayMonth(d) })],
  ['ce (soir|matin)', (d, m) => ({ article: 'le', phrase: `${dayMonth(d)} ${moment(m[1]!)}` })],
  ['cet après-midi', (d) => ({ article: 'le', phrase: `${dayMonth(d)} après-midi` })],
  ['cette nuit', (d) => ({ article: 'la', phrase: `nuit du ${dayMonth(d)}` })],
  ['ce week-end', (d) => ({ article: 'le', phrase: `week-end du ${dayMonth(shift(mondayOf(d), 5))}` })],
  ['la semaine (prochaine|dernière)', (d, m) => ({
    article: 'la',
    phrase: `semaine du ${dayMonth(shift(mondayOf(d), m[1]!.toLowerCase() === 'prochaine' ? 7 : -7))}`,
  })],
  ['cette semaine', (d) => ({ article: 'la', phrase: `semaine du ${dayMonth(mondayOf(d))}` })],
  [`(${WEEKDAYS.join('|')}) (prochain|dernier)`, (d, m) => {
    const name = m[1]!.toLowerCase();
    const step = m[2]!.toLowerCase() === 'prochain' ? 1 : -1;
    let day = shift(d, step);
    while (day.getUTCDay() !== WEEKDAYS.indexOf(name)) day = shift(day, step);
    return { article: 'le', phrase: `${name} ${dayMonth(day)}` };
  }],
  ['dans (\\d+) (jours?|semaines?)', (d, m) => ({ article: null, phrase: `${m[1]} ${m[2]} après le ${dayMonth(d)}` })],
  ['il y a (\\d+) (jours?|semaines?)', (d, m) => ({ article: null, phrase: `${m[1]} ${m[2]} avant le ${dayMonth(d)}` })],
];

/**
 * Ce qui précède l'expression et se contracte avec l'article qu'on lui donne :
 * « d'hier » devient « du 17/09 », « jusqu'à demain » « jusqu'au 19/09 »,
 * « qu'hier » « que le 17/09 ».
 */
const LEAD = "(?<lead>(?<![\\p{L}\\d])(?:jusqu['’]à\\s+|de\\s+|à\\s+|d['’]|qu['’]))?";
/** Jamais au milieu d'un mot — « lendemain » n'est pas « demain » —, ni devant « -là ». */
const BEFORE = '(?<![\\p{L}\\d-])';
const AFTER = '(?![\\p{L}\\d-]|\\s*-\\s*là)';

const PATTERNS = EXPRESSIONS.map(([source, resolve]) => ({
  find: new RegExp(`${LEAD}${BEFORE}(?<expr>${source})${AFTER}`, 'giu'),
  exact: new RegExp(`^(?:${source})$`, 'iu'),
  resolve,
}));

const capitalize = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);

function joined(lead: string | undefined, a: Anchored): string {
  const noun = a.article ? `${a.article} ${a.phrase}` : a.phrase;
  if (!lead) return noun;
  const l = lead.toLowerCase().replace(/\s+/g, ' ').trim().replace('’', "'");
  const out =
    l === "qu'"
      ? `que ${noun}`
      : l === "d'" || l === 'de'
        ? a.article === 'le' ? `du ${a.phrase}` : `de ${noun}`
        : l === 'à'
          ? a.article === 'le' ? `au ${a.phrase}` : `à ${noun}`
          : a.article === 'le' ? `jusqu'au ${a.phrase}` : `jusqu'à ${noun}`;
  return /^\p{Lu}/u.test(lead) ? capitalize(out) : out;
}

/**
 * Remplace chaque date relative par la date qu'elle désignait le jour où le
 * texte a été écrit (`at`, ISO) : « ce soir » écrit le 18/09 devient « le 18/09
 * au soir ». Le reste du texte est rendu tel quel.
 */
export function anchorRelativeDates(text: string, at: string): string {
  const day = localDay(at);
  let out = text;
  for (const { find, exact, resolve } of PATTERNS) {
    out = out.replace(find, (...args) => {
      const groups = args[args.length - 1] as { lead?: string; expr: string };
      const replaced = joined(groups.lead, resolve(day, exact.exec(groups.expr) as RegExpExecArray));
      // Une expression qui ouvrait la phrase la laisse ouverte : « Hier, … »
      // devient « Le 17/09, … ».
      return !groups.lead && /^\p{Lu}/u.test(groups.expr) ? capitalize(replaced) : replaced;
    });
  }
  return out;
}

/** Les dates relatives qu'un texte contient encore, telles qu'écrites. Vide : il se relit n'importe quel jour. */
export function relativeDatesIn(text: string): string[] {
  const found: string[] = [];
  for (const { find } of PATTERNS) {
    for (const m of text.matchAll(find)) found.push(m.groups?.expr ?? m[0]);
  }
  return found;
}

/** Le jour où un texte a été écrit, tel qu'on l'écrit dans un texte : « 18/09 ». */
export function writtenOn(at: string): string {
  return dayMonth(localDay(at));
}

/** Le jour où un instant tombe dans le fuseau de l'athlète, AAAA-MM-JJ. */
export function localDate(at: string): string {
  return localDay(at).toISOString().slice(0, 10);
}
