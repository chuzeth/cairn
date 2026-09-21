import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { decide, describeVersion, type VersionState } from '../apps/web/lib/version';
import { frStamp } from '../apps/web/lib/api';
import { lastDeploy, runningVersion } from '../apps/api/src/release';

const opening = {
  build: 'f4c1e4a', served: 'f4c1e4a', offline: false, reloadedFor: null, typing: false, touched: false,
};

describe('La page se compare au commit du Mac', () => {
  it('est à jour quand les deux commits sont les mêmes', () => {
    expect(decide(opening)).toBe('current');
  });

  it('se recharge sur un autre commit, avant tout geste', () => {
    expect(decide({ ...opening, served: 'a1b2c3d' })).toBe('reload');
  });

  it('ne se recharge jamais deux fois pour la même version', () => {
    // Rechargée pour a1b2c3d et toujours ancienne : recommencer ferait une boucle.
    expect(decide({ ...opening, served: 'a1b2c3d', reloadedFor: 'a1b2c3d' })).toBe('stuck');
    // Une version encore plus récente a droit à sa recharge.
    expect(decide({ ...opening, served: 'e5f6a7b', reloadedFor: 'a1b2c3d' })).toBe('reload');
  });

  it('attend la prochaine ouverture au milieu d’une saisie, ou après un geste', () => {
    expect(decide({ ...opening, served: 'a1b2c3d', typing: true })).toBe('typing');
    expect(decide({ ...opening, served: 'a1b2c3d', touched: true })).toBe('touched');
  });

  it('ne se compare à rien hors ligne, ni hors instantané, ni face à un Mac sans version', () => {
    expect(decide({ ...opening, served: 'a1b2c3d', offline: true })).toBe('offline');
    expect(decide({ ...opening, build: null, served: 'a1b2c3d' })).toBe('dev');
    expect(decide({ ...opening, served: null })).toBe('unversioned');
  });
});

describe('La ligne de version de la feuille « Plus »', () => {
  const at = new Date(2026, 8, 21, 11, 21).toISOString();
  const served = { commit: 'f4c1e4a', deployedAt: at };
  // L'heure se lit « 11 h 21 », insécables comprises : `frStamp` ne la coupe pas en fin de ligne.
  const lines = (v: VersionState) => describeVersion(v, 'f4c1e4a', frStamp).map((l) => l.text.replaceAll('\u00a0', ' '));

  it('dit « à jour », le commit et la date de mise en service', () => {
    expect(lines({ status: 'current', served, deploy: null })).toEqual(['à jour · f4c1e4a · 21 sept., 11 h 21']);
  });

  it('hors ligne, dit la version servie et sa date', () => {
    expect(lines({ status: 'offline', served, deploy: null })).toEqual(['hors ligne · f4c1e4a · 21 sept., 11 h 21']);
  });

  it('dit un commit refusé par le service, pas celui qui est en service', () => {
    const refused = { commit: 'a1b2c3d', state: 'refused' as const, step: 'npm test', at };
    expect(lines({ status: 'current', served, deploy: refused })).toEqual([
      'à jour · f4c1e4a · 21 sept., 11 h 21',
      'a1b2c3d refusé · npm test en échec · 21 sept., 11 h 21',
    ]);
    expect(lines({ status: 'current', served, deploy: { ...refused, commit: 'f4c1e4a', state: 'deployed' } })).toHaveLength(1);
  });
});

describe('Ce que /health rend de la version', () => {
  it('rend le commit et la date que le service a transmis, rien hors service', () => {
    expect(runningVersion({ CAIRN_COMMIT: 'f4c1e4a', CAIRN_DEPLOYED_AT: '2026-09-21T09:21:17.000Z' }))
      .toEqual({ commit: 'f4c1e4a', deployedAt: '2026-09-21T09:21:17.000Z' });
    expect(runningVersion({})).toBeNull();
  });

  it('lit la dernière tentative, et dit interrompue celle dont le processus est mort', () => {
    const file = join(mkdtempSync(join(tmpdir(), 'cairn-deploy-')), 'deploy.json');
    const write = (o: object) => writeFileSync(file, JSON.stringify({ commit: 'a1b2c3d4e5', short: 'a1b2c3d', at: '2026-09-21T09:40:00.000Z', ...o }));

    write({ state: 'refused', step: 'npx tsc -b' });
    expect(lastDeploy({ CAIRN_DEPLOY_FILE: file })).toMatchObject({ commit: 'a1b2c3d', state: 'refused', step: 'npx tsc -b' });

    write({ state: 'running', pid: process.pid });
    expect(lastDeploy({ CAIRN_DEPLOY_FILE: file })?.state).toBe('running');
    write({ state: 'running', pid: 2 ** 22 + 7 });
    expect(lastDeploy({ CAIRN_DEPLOY_FILE: file })?.state).toBe('interrupted');

    expect(lastDeploy({})).toBeNull();
  });
});
