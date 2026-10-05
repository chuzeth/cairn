import { EXERCISES, EXERCISE_WORDS } from '@cairn/core/exercises';
import { ExerciseFigure } from '@/components/ExerciseFigure';
import { EXERCISE_GROUPS } from '@/lib/exerciseGroups';

/**
 * Les fiches d'exercices du programme de compensation (coude cassé, 03/10).
 *
 * Chaque exercice d'une séance y renvoie (« comment faire ») : le schéma, le
 * pourquoi, l'installation, le mouvement et son tempo, la respiration, ce qu'on
 * doit sentir, les erreurs, la version plus facile et la suivante, et ce que le
 * bras plâtré change. Une page statique : elle s'ouvre aussi sans réseau,
 * gardée par le service worker comme les écrans du menu.
 */

const WHERE: Record<string, string> = { salle: 'salle', maison: 'maison', dehors: 'dehors' };

export default function ExercisesPage() {
  return (
    <div className="xs">
      <header className="page-head">
        <div>
          <h1 className="page-title">Exercices</h1>
          <p className="page-sub">
            Quatre semaines sans course, une séance par jour. Rien ne s&apos;appuie sur le bras plâtré, rien ne se
            tient à deux mains.
          </p>
        </div>
      </header>

      <section className="xs-rules">
        <h2>Lire une fiche</h2>
        <ul>
          <li>
            <strong>Le schéma.</strong> En pointillé, la position d&apos;où tu pars (1) ; en plein, celle où tu
            arrives (2). La jambe et le bras du côté opposé sont en gris. En rouge, les muscles qui travaillent ; en
            ocre, le bras plâtré ; en vert, l&apos;élastique ; en bleu, le mouvement et son tempo. Les angles écrits
            sont ceux du dessin.
          </li>
          <li>
            <strong>« 3 répétitions en réserve ».</strong> Tu t&apos;arrêtes quand tu pourrais encore en faire trois,
            propres. Si la dernière série en laisse davantage deux séances de suite, passe à la version « plus
            dur ».
          </li>
          <li>
            <strong>Le tempo se compte.</strong> « 3 s pour descendre » : c&apos;est la descente lente qui fait le
            travail, pas le nombre.
          </li>
        </ul>
      </section>

      {/* Replié : il se consulte quand un mot arrête, sans repousser les fiches de deux écrans. */}
      <details className="xs-rules xs-lexicon">
        <summary>
          <h2>Les mots du programme</h2>
          <span>{EXERCISE_WORDS.length} mots expliqués simplement, de « série » à « PMA »</span>
        </summary>
        <dl className="xs-words">
          {EXERCISE_WORDS.map((w) => (
            <div key={w.word}>
              <dt>{w.word}</dt>
              <dd>{w.plain}</dd>
            </div>
          ))}
        </dl>
      </details>

      <section className="xs-rules">
        <h2>Les règles du plâtre</h2>
        <ol>
          <li>
            <strong>Douleur au coude, de 0 à 10.</strong> Jusqu&apos;à 3, continue. À 4 ou 5, arrête l&apos;exercice
            qui la provoque et passe à la marche. À 6 et plus, ou si le coude lance et gonfle, arrête la séance et
            surélève le bras.
          </li>
          <li>
            <strong>Aucune chute possible.</strong> Pas de sentier technique, pas de sol mouillé, toujours un
            support à portée de la main libre.
          </li>
          <li>
            <strong>La montre au poignet libre.</strong> Enregistre chaque séance en Musculation, Marche, Vélo
            d&apos;intérieur ou Escalier, et l&apos;app la coche d&apos;elle-même. Jamais en Course ni en
            Randonnée : ces deux-là nourrissent ton modèle de coureur, et une marche y passerait pour une
            course lente.
          </li>
          <li>
            <strong>Les signes qui n&apos;attendent pas.</strong> Doigts qui gonflent, bleuissent ou
            s&apos;engourdissent, douleur qui monte dans le plâtre : ton chirurgien ou les urgences, sans attendre.
          </li>
        </ol>
      </section>

      <section className="xs-rules">
        <h2>S&apos;adapter au jour le jour</h2>
        <ul>
          <li>Point du jour « vidé » ou « lourd », ou nuit de moins de six heures : remplace la force par la marche tranquille.</li>
          <li>Fortes courbatures le lendemain d&apos;une séance de force : la marche du jour se fait à plat.</li>
          <li>Une séance manquée ne se rattrape pas : la suivante se fait telle qu&apos;elle est écrite.</li>
          <li>
            Mange à ta faim, des protéines à chaque repas : l&apos;os qui se répare et les muscles qu&apos;on
            entretient en ont besoin. Ce n&apos;est pas le moment de maigrir.
          </li>
          <li>
            Au feu vert du chirurgien pour courir : trois sorties de 20 minutes en alternant 2 minutes de course et 1
            de marche, sur le plat ; puis 10 % de plus par semaine, et pas de descente technique avant d&apos;avoir
            retrouvé la force du bras.
          </li>
        </ul>
      </section>

      {EXERCISE_GROUPS.map((g) => (
        <section key={g.title} className="xs-group">
          <h2 className="xs-group-title">{g.title}</h2>
          <p className="xs-group-lead">{g.lead}</p>
          {g.keys.map((key) => {
            const x = EXERCISES[key];
            return (
              <article key={key} id={key} className="xs-card">
                <ExerciseFigure exercise={key} label={x.name} />
                <h3 className="xs-name">{x.name}</h3>
                <p className="xs-what">{x.what}</p>
                <p className="xs-meta">
                  {x.where.map((w) => WHERE[w]).join(' · ')} — {x.equipment}
                </p>
                <p className="xs-why">{x.why}</p>
                {x.setup && (
                  <>
                    <h4>Installation</h4>
                    <ul className="xs-steps">
                      {x.setup.map((s, i) => <li key={i}>{s}</li>)}
                    </ul>
                  </>
                )}
                <h4>Le mouvement</h4>
                <ol className="xs-steps">
                  {x.steps.map((s, i) => <li key={i}>{s}</li>)}
                </ol>
                {x.breath && (
                  <>
                    <h4>Respiration</h4>
                    <p>{x.breath}</p>
                  </>
                )}
                <h4>Ce que tu dois sentir</h4>
                <p>{x.feel}</p>
                <h4>Les erreurs</h4>
                <ul className="xs-mistakes">
                  {x.mistakes.map((m, i) => <li key={i}>{m}</li>)}
                </ul>
                {(x.easier || x.harder) && (
                  <div className="xs-variants">
                    {x.easier && <p><strong>Plus facile.</strong> {x.easier}</p>}
                    {x.harder && <p><strong>Plus dur.</strong> {x.harder}</p>}
                  </div>
                )}
                <p className="xs-cast"><strong>Avec le plâtre.</strong> {x.cast}</p>
              </article>
            );
          })}
        </section>
      ))}

      <section className="xs-sources">
        <h2>Sur quoi repose ce programme</h2>
        <ul>
          <li>Mujika &amp; Padilla, <em>Detraining</em>, Sports Medicine 2000 : ce qui se perd à l&apos;arrêt, et à quelle vitesse.</li>
          <li>Hickson et al., 1981 et 1985 : réduire le volume des deux tiers conserve la VO2max tant que l&apos;intensité reste.</li>
          <li>Blagrove et al., Sports Medicine 2018 : le renforcement améliore l&apos;économie de course des coureurs de fond.</li>
          <li>Magnus et al., Arch Phys Med Rehabil 2013 : entraîner le bras sain après une fracture rend le bras blessé plus fort à 12 semaines.</li>
          <li>Méta-analyse sur le POWERbreathe, 2021 : 30 inspirations deux fois par jour, quatre à six semaines.</li>
          <li>Services de fracture du NHS : mobiliser doigts et épaule pendant le plâtre, trois à quatre fois par jour.</li>
          <li>Alfredson, 1998 : le travail excentrique du mollet pour le tendon d&apos;Achille.</li>
          <li>Winter, <em>Biomechanics and Motor Control of Human Movement</em>, 2009 : les proportions du corps des schémas.</li>
        </ul>
      </section>
    </div>
  );
}
