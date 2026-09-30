import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * Le binaire de Tailscale.app n'est la CLI que s'il le sait : lancé sans
 * terminal, comme par launchd, il se prend pour l'interface et échoue. Le faux
 * binaire reproduit ce que fait le vrai dans un environnement nu (constaté le
 * 30/09 sur Tailscale 1.102.4) ; le service l'appelle dans ce même environnement.
 */
export function fakeTailscaleApp(): string {
  const file = join(mkdtempSync(join(tmpdir(), 'cairn-tailscale-')), 'Tailscale');
  writeFileSync(file, `#!/bin/sh
if [ "$TAILSCALE_BE_CLI" != 1 ]; then
  echo "The Tailscale GUI failed to start: The operation couldn't be completed. (Tailscale.CLIError error 3.)" >&2
  exit 1
fi
echo '{"BackendState":"Running","Self":{"DNSName":"cairn.tail0000.ts.net."}}'
`);
  chmodSync(file, 0o755);
  return file;
}
