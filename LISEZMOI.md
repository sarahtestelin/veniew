# Mes concerts

GitHub cherche les concerts de tes artistes Spotify en arrière-plan, à la fréquence choisie dans l'app,
et t'envoie une notification quand un nouveau concert apparaît dans ta zone.

## 1. Clés à récupérer

- **Spotify** (Premium obligatoire) : developer.spotify.com/dashboard, *Create app*, coche *Web API*.
  Redirect URI : `http://127.0.0.1:8888/callback`. Note le *Client ID* et le *Client secret*.
- **Ticketmaster** : compte sur developer.ticketmaster.com, l'app par défaut donne une *Consumer Key*.
- **Bandsintown** (optionnel) : demande d'App ID sur artists.bandsintown.com.

## 2. Refresh token Spotify (une seule fois, sur ton PC)

```
node scripts/get-token.mjs TON_CLIENT_ID TON_CLIENT_SECRET
```
Le navigateur s'ouvre, tu acceptes, le terminal affiche le refresh token.

## 3. Dépôt GitHub

1. Crée un dépôt **public** `mes-concerts`.
2. Depuis ton PC : *Add file > Upload files*, glisse **tout le contenu** du dossier (y compris `.github` et `scripts`).
3. *Settings > Pages* : « Deploy from a branch », `main`, `/ (root)`.
4. *Settings > Secrets and variables > Actions > New repository secret*, ajoute :
   `SPOTIFY_CLIENT_ID`, `SPOTIFY_CLIENT_SECRET`, `SPOTIFY_REFRESH_TOKEN`, `TICKETMASTER_KEY`,
   `BANDSINTOWN_APP_ID` (si tu en as un), `NTFY_TOPIC` (un nom au hasard, ex. `concerts-sarah-7f3k9q`).

## 4. Jeton GitHub pour le menu admin

github.com/settings/personal-access-tokens, *Generate new token* (fine-grained) :
uniquement le dépôt `mes-concerts`, permissions **Contents** et **Actions** en *Read and write*.

## 5. Sur ton téléphone

1. Installe l'app **ntfy** et abonne-toi au même nom que `NTFY_TOPIC`.
2. Ouvre `https://TON-PSEUDO.github.io/mes-concerts/`, onglet Réglages, colle le jeton GitHub.
3. Ajoute l'app à l'écran d'accueil, puis *Lancer la première recherche*.

## Bon à savoir

- Le dépôt étant public, `data.json` et `config.json` (tes artistes, ta zone) sont visibles par qui connaît l'adresse.
- GitHub vérifie tous les jours vers 8h ; la recherche ne s'exécute que si ta fréquence est atteinte.
- Le bouton d'actualisation lance une recherche immédiate (3 à 10 min selon le nombre d'artistes).
