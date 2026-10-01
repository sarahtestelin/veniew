// À lancer UNE fois sur ton PC pour récupérer le refresh token Spotify.
// Usage : node scripts/get-token.mjs TON_CLIENT_ID TON_CLIENT_SECRET
import http from 'node:http';
import { exec } from 'node:child_process';

const [, , id, secret] = process.argv;
if (!id || !secret) {
  console.log('Usage : node scripts/get-token.mjs CLIENT_ID CLIENT_SECRET');
  process.exit(1);
}

const REDIRECT = 'http://127.0.0.1:8888/callback';
const SCOPES = 'playlist-read-private playlist-read-collaborative user-follow-read user-top-read user-library-read';
const authUrl = 'https://accounts.spotify.com/authorize?' + new URLSearchParams({
  client_id: id, response_type: 'code', redirect_uri: REDIRECT, scope: SCOPES
});

http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://127.0.0.1:8888');
  if (u.pathname !== '/callback') { res.end(); return; }
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });

  const code = u.searchParams.get('code');
  if (!code) { res.end('Connexion refusée.'); process.exit(1); }

  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(id + ':' + secret).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT })
  });
  const j = await r.json();

  if (j.refresh_token) {
    res.end('C\'est bon, retourne dans le terminal.');
    console.log('\nCopie cette valeur dans le secret GitHub SPOTIFY_REFRESH_TOKEN :\n\n' + j.refresh_token + '\n');
  } else {
    res.end('Erreur : ' + JSON.stringify(j));
    console.error('Erreur :', j);
  }
  setTimeout(() => process.exit(0), 500);
}).listen(8888, '127.0.0.1', () => {
  console.log('Si le navigateur ne s\'ouvre pas, ouvre ce lien :\n' + authUrl + '\n');
  const cmd = process.platform === 'win32' ? `start "" "${authUrl}"`
    : process.platform === 'darwin' ? `open "${authUrl}"` : `xdg-open "${authUrl}"`;
  exec(cmd);
});
