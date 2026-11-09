import { nbsp, type RaceCriteria } from '@/lib/api';

/**
 * Ce qui doit être vrai pour courir le dossard de la reprise, point par point,
 * avec la donnée qui fonde chacun (`@cairn/coach`, `criteria.ts`).
 *
 * Une réassurance sans preuve ne vaut rien : « tu es prêt » se lit ici, ou ne
 * se dit pas. Ce qui n'a pas été dit reste ouvert. Le dernier point n'est pas
 * un critère : c'est ce que coûte le dossard, en chiffres.
 */

const MARK = { met: 'Tenu', open: 'Ouvert', failed: 'Manqué', info: 'À savoir' } as const;
const dm = (date: string) => `${date.slice(8, 10)}/${date.slice(5, 7)}`;

export function Criteria({ criteria }: { criteria: RaceCriteria }) {
  const name = criteria.raceTitle.split(',')[0];
  return (
    <section className="m-crit" aria-label={`Critères de la ${name}`}>
      <div className="m-label">
        {criteria.decided ? `${name} · décidé le ${dm(criteria.gateDate)}` : `Vers la ${name} · décision le ${dm(criteria.gateDate)}`}
      </div>
      <ul className="m-crit-list">
        {criteria.criteria.map((c) => (
          <li key={c.key} className="m-crit-item" data-status={c.status}>
            <span className="m-crit-mark">{MARK[c.status]}</span>
            <span className="m-crit-body">
              <span className="m-crit-label">{nbsp(c.label)}</span>
              <span className="m-crit-evidence">{nbsp(c.evidence)}</span>
            </span>
          </li>
        ))}
      </ul>
      {!criteria.decided && (
        <p className="m-q-why">{nbsp(`Si la sortie longue ne tient pas son critère, le dossard passe à la ${criteria.fallbackTitle}.`)}</p>
      )}
    </section>
  );
}
