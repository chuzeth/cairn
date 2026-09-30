import { spawnSync } from 'node:child_process';
import { expect, it } from 'vitest';
import { fakeTailscaleApp } from './fixtures/tailscale';

it('le service joint la CLI de Tailscale depuis launchd, sans terminal', () => {
  const module = new URL('../scripts/tailscale.mjs', import.meta.url).href;
  const script = `import { tailscaleCli } from ${JSON.stringify(module)};
const res = tailscaleCli(['status', '--json'], ${JSON.stringify(fakeTailscaleApp())});
process.stdout.write(JSON.stringify({ status: res.status, stdout: res.stdout, stderr: res.stderr }));`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    encoding: 'utf8', env: { PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
  });
  const res = JSON.parse(run.stdout) as { status: number; stdout: string; stderr: string };
  expect(res.stderr).toBe('');
  expect(res.status).toBe(0);
  expect(JSON.parse(res.stdout).BackendState).toBe('Running');
});
