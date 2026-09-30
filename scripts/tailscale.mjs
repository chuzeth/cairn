/**
 * La commande `tailscale`, telle que le service l'appelle.
 *
 * Tailscale standalone n'installe pas de commande dans le PATH : la CLI est le
 * binaire de l'application, qui choisit d'être la CLI ou l'interface selon son
 * environnement. Depuis un terminal, il est la CLI ; lancé par launchd, sans
 * terminal, il se prend pour l'interface et échoue (« The Tailscale GUI failed
 * to start ») — ce que la surveillance journalisait « tailscale introuvable »,
 * toutes les cinq minutes, sans jamais rien relancer. `TAILSCALE_BE_CLI=1` le
 * tient en CLI d'où qu'il soit lancé ; les autres installations l'ignorent.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

export const TAILSCALE_PATHS = ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale', '/usr/local/bin/tailscale'];

export function tailscaleBinary() {
  return TAILSCALE_PATHS.find((p) => existsSync(p)) ?? 'tailscale';
}

export function tailscaleCli(args, binary = tailscaleBinary()) {
  return spawnSync(binary, args, {
    encoding: 'utf8', timeout: 30_000, env: { ...process.env, TAILSCALE_BE_CLI: '1' },
  });
}
