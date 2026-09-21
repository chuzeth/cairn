# /// script
# requires-python = ">=3.12"
# dependencies = ["garminconnect==0.3.16"]
# ///
"""Connexion de Cairn à Garmin Connect, lancée par `npm run garmin -- login`.

La connexion elle-même — formulaire, double authentification, défenses de
Garmin contre les robots — est celle de python-garminconnect, maintenue au
rythme où Garmin la change. Ce script ne fait que la demander : l'e-mail et le
mot de passe sont lus dans le terminal, le code MFA seulement si Garmin
l'exige, et seuls les jetons de session sont écrits, en 600, au chemin reçu en
argument. Le mot de passe ne quitte pas ce processus et n'est écrit nulle part.
"""

import getpass
import sys

from garminconnect import (
    Garmin,
    GarminConnectAuthenticationError,
    GarminConnectConnectionError,
    GarminConnectTooManyRequestsError,
)


def main() -> int:
    if len(sys.argv) != 2:
        print("usage : login.py <fichier de session>", file=sys.stderr)
        return 64
    path = sys.argv[1]

    email = input("E-mail du compte Garmin : ").strip()
    password = getpass.getpass("Mot de passe Garmin (la saisie ne s'affiche pas) : ")
    if not email or not password:
        print("E-mail et mot de passe sont nécessaires.", file=sys.stderr)
        return 2

    garmin = Garmin(
        email=email,
        password=password,
        prompt_mfa=lambda: input("Code de vérification envoyé par Garmin : ").strip(),
    )
    password = None
    try:
        garmin.login()
    except GarminConnectAuthenticationError:
        print("Garmin refuse ces identifiants, ou ce code de vérification.", file=sys.stderr)
        return 3
    except GarminConnectTooManyRequestsError:
        print("Garmin limite les tentatives de connexion depuis ce réseau : réessaie dans une heure.", file=sys.stderr)
        return 4
    except GarminConnectConnectionError as e:
        print(f"Connexion impossible : {e}", file=sys.stderr)
        return 5

    # Une connexion qui n'a obtenu qu'une session web ne se renouvelle pas hors
    # d'un navigateur : Cairn la perdrait au premier jour.
    if not garmin.client.di_token or not garmin.client.di_refresh_token:
        print("Garmin n'a délivré qu'une session web, que Cairn ne sait pas renouveler. Réessaie plus tard.", file=sys.stderr)
        return 6

    garmin.client.dump(path)
    return 0


if __name__ == "__main__":
    sys.exit(main())
