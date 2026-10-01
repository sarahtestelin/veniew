// Mise à jour des concerts, lancée par GitHub Actions (cron ou bouton dans l'app).
// Lit config.json, interroge Spotify + Ticketmaster + Bandsintown + Google Events (SerpApi), écrit data.json
// et envoie une notification ntfy pour les nouveaux concerts de ta zone.
import fs from 'node:fs/promises';

const env = process.env;
const FORCE = env.FORCE === 'true';
const sleep = ms => new Promise(r => setTimeout(r, ms));
const norm = s => String(s || '').normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase()
  .replace(/&/g, 'and').replace(/[^a-z0-9]+/g, ' ').trim();

const CITIES = {
  lens: [50.4329, 2.8317], lille: [50.6292, 3.0573], arras: [50.2910, 2.7775], amiens: [49.8941, 2.2958],
  paris: [48.8566, 2.3522], bruxelles: [50.8503, 4.3517], anvers: [51.2194, 4.4025], liege: [50.6326, 5.5797]
};
const KEEP_CC = new Set(['FR', 'BE', 'NL', 'LU', 'DE', 'GB', 'CH', 'ES']);
const NAME_TO_CC = { france: 'FR', belgium: 'BE', belgique: 'BE', netherlands: 'NL', 'the netherlands': 'NL', holland: 'NL',
  luxembourg: 'LU', germany: 'DE', deutschland: 'DE', 'united kingdom': 'GB', uk: 'GB', england: 'GB', scotland: 'GB',
  wales: 'GB', switzerland: 'CH', spain: 'ES' };
const toCC = c => !c ? '' : /^[A-Z]{2}$/.test(c) ? c : (NAME_TO_CC[norm(c)] || '');

// ---------- Config ----------
const cfg = JSON.parse(await fs.readFile('config.json', 'utf8'));
let prev = null;
try { prev = JSON.parse(await fs.readFile('data.json', 'utf8')); } catch {}

const intervalMs = (cfg.intervalDays || 1) * 86400000 - 3 * 3600000; // 3 h de marge
if (!FORCE && prev && Date.now() - prev.at < intervalMs) {
  console.log(`Dernière mise à jour trop récente (intervalle : ${cfg.intervalDays} j). Rien à faire.`);
  process.exit(0);
}

for (const k of ['SPOTIFY_CLIENT_ID', 'SPOTIFY_CLIENT_SECRET', 'SPOTIFY_REFRESH_TOKEN']) {
  if (!env[k]) { console.error(`Secret manquant : ${k}`); process.exit(1); }
}
if (!env.TICKETMASTER_KEY && !env.BANDSINTOWN_APP_ID) {
  console.error('Il faut au moins TICKETMASTER_KEY ou BANDSINTOWN_APP_ID.'); process.exit(1);
}

// ---------- Spotify ----------
let token = null;
async function spToken() {
  const r = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(env.SPOTIFY_CLIENT_ID + ':' + env.SPOTIFY_CLIENT_SECRET).toString('base64')
    },
    body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: env.SPOTIFY_REFRESH_TOKEN })
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Spotify refuse le refresh token : ' + JSON.stringify(j));
  token = j.access_token;
}

let spErrors = 0;
async function sp(path) {
  const url = path.startsWith('http') ? path : 'https://api.spotify.com/v1' + path;
  for (let i = 0; i < 4; i++) {
    const r = await fetch(url, { headers: { Authorization: 'Bearer ' + token } });
    if (r.status === 429) {
      const s = Number(r.headers.get('retry-after')) || 5;
      if (s > 120) throw new Error('Quota Spotify atteint.');
      await sleep(s * 1000); continue;
    }
    if (r.status === 401) { await spToken(); continue; }
    if (!r.ok) { spErrors++; console.warn(`Spotify ${r.status} sur ${path}`); return null; }
    return r.json();
  }
  spErrors++;
  return null;
}

async function collectArtists() {
  const map = new Map();
  const add = (a, w) => {
    const k = norm(a?.name); if (!k) return;
    const e = map.get(k) || { name: a.name, score: 0 };
    e.score += w; map.set(k, e);
  };
  const src = cfg.src || {};

  if (src.top) {
    for (const range of ['short_term', 'medium_term', 'long_term']) {
      const j = await sp(`/me/top/artists?limit=50&time_range=${range}`);
      (j?.items || []).forEach((a, i) => add(a, 12 - i * 0.15));
    }
  }
  if (src.followed) {
    let url = '/me/following?type=artist&limit=50';
    while (url) { const j = await sp(url); (j?.artists?.items || []).forEach(a => add(a, 8)); url = j?.artists?.next || null; }
  }
  if (src.playlists) {
    const me = await sp('/me');
    let pls = [], url = '/me/playlists?limit=50';
    while (url) { const j = await sp(url); pls.push(...(j?.items || []).filter(Boolean)); url = j?.next || null; }
    // Spotify ne donne le contenu que des playlists que tu possèdes ou sur lesquelles tu collabores
    pls = pls.filter(p => p.collaborative || !me?.id || p.owner?.id === me.id);
    for (const p of pls) {
      let u = `/playlists/${p.id}/items?limit=50`, pages = 0;
      while (u && pages < 30) {
        const j = await sp(u);
        for (const it of (j?.items || [])) {
          const t = it?.item || it?.track;
          if (t && t.type === 'track') (t.artists || []).forEach(a => add(a, 1));
        }
        u = j?.next || null; pages++;
      }
    }
    console.log(`${pls.length} playlists lues.`);
  }
  if (src.liked) {
    let u = '/me/tracks?limit=50', pages = 0;
    while (u && pages < 40) {
      const j = await sp(u);
      for (const it of (j?.items || [])) ((it?.track || it?.item)?.artists || []).forEach(a => add(a, 1));
      u = j?.next || null; pages++;
    }
  }
  return [...map.values()].sort((a, b) => b.score - a.score);
}

// ---------- Concerts ----------
async function fromBandsintown(name) {
  if (!env.BANDSINTOWN_APP_ID) return [];
  const u = `https://rest.bandsintown.com/artists/${encodeURIComponent(name)}/events?app_id=${encodeURIComponent(env.BANDSINTOWN_APP_ID)}&date=upcoming`;
  try {
    const r = await fetch(u); if (!r.ok) return [];
    const j = await r.json(); if (!Array.isArray(j)) return [];
    return j.map(e => ({
      artist: name, date: e.datetime, noTime: false,
      venue: e.venue?.name || '', city: e.venue?.city || '', cc: toCC(e.venue?.country),
      lat: parseFloat(e.venue?.latitude) || null, lng: parseFloat(e.venue?.longitude) || null,
      links: [{ src: 'Bandsintown', url: e.offers?.[0]?.url || e.url }]
    }));
  } catch { return []; }
}

let tmNext = 0;
async function tmGate() { // Ticketmaster : 5 requêtes/seconde max
  const now = Date.now(), wait = Math.max(0, tmNext - now);
  tmNext = Math.max(now, tmNext) + 240;
  if (wait) await sleep(wait);
}
async function fromTicketmaster(name) {
  if (!env.TICKETMASTER_KEY) return [];
  const p = new URLSearchParams({ apikey: env.TICKETMASTER_KEY, keyword: name, classificationName: 'music', size: '200', sort: 'date,asc' });
  let j = null;
  for (let i = 0; i < 3; i++) {
    await tmGate();
    try {
      const r = await fetch('https://app.ticketmaster.com/discovery/v2/events.json?' + p);
      if (r.status === 429) { await sleep(1500); continue; }
      if (r.status === 401) throw new Error('Clé Ticketmaster refusée.');
      if (!r.ok) return [];
      j = await r.json(); break;
    } catch (e) { if (e.message.startsWith('Clé')) throw e; return []; }
  }
  const target = norm(name);
  return (j?._embedded?.events || [])
    .filter(e => (e._embedded?.attractions || []).some(a => norm(a.name) === target))
    .map(e => {
      const v = e._embedded?.venues?.[0] || {}, d = e.dates?.start || {};
      return {
        artist: name, date: d.localDate ? d.localDate + 'T' + (d.localTime || '00:00:00') : d.dateTime, noTime: !d.localTime,
        venue: v.name || '', city: v.city?.name || '', cc: v.country?.countryCode || '',
        lat: parseFloat(v.location?.latitude) || null, lng: parseFloat(v.location?.longitude) || null,
        links: [{ src: 'Ticketmaster', url: e.url }]
      };
    });
}

// ---------- France : Google Events via SerpApi (une fois par semaine) ----------
const MONTHS = { jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11 };
const CITY_COORDS = { paris: [48.8566, 2.3522], lille: [50.6292, 3.0573], lens: [50.4329, 2.8317], arras: [50.2910, 2.7775],
  amiens: [49.8941, 2.2958], roubaix: [50.6942, 3.1746], tourcoing: [50.7239, 3.1612], 'villeneuve d ascq': [50.6233, 3.1450],
  lyon: [45.7640, 4.8357], marseille: [43.2965, 5.3698], nantes: [47.2184, -1.5536], bordeaux: [44.8378, -0.5792],
  toulouse: [43.6047, 1.4442], strasbourg: [48.5734, 7.7521], rouen: [49.4431, 1.0993], reims: [49.2583, 4.0317],
  nanterre: [48.8924, 2.2071], 'boulogne billancourt': [48.8397, 2.2399], 'saint denis': [48.9362, 2.3574],
  bruxelles: [50.8503, 4.3517], brussels: [50.8503, 4.3517], anvers: [51.2194, 4.4025], antwerpen: [51.2194, 4.4025],
  liege: [50.6326, 5.5797], gand: [51.0543, 3.7174], gent: [51.0543, 3.7174] };

function parseGoogleDate(ev) {
  // start_date ressemble à "Mar 12" (hl=en) ; l'année n'est pas donnée, on la déduit
  const m = /^([A-Za-z]{3})\w*\s+(\d{1,2})/.exec(ev.date?.start_date || '');
  if (!m || MONTHS[m[1].toLowerCase()] == null) return null;
  const now = new Date(), month = MONTHS[m[1].toLowerCase()], day = +m[2];
  let year = now.getFullYear();
  const yearInText = /\b(20\d\d)\b/.exec(ev.date?.when || '');
  if (yearInText) year = +yearInText[1];
  else if (new Date(year, month, day) < new Date(now.getFullYear(), now.getMonth(), now.getDate())) year++;
  // heure : "8 PM", "8:30 PM" ou "20:00"
  let time = null;
  const t12 = /(\d{1,2})(?::(\d{2}))?\s*(AM|PM)/i.exec(ev.date?.when || '');
  const t24 = /\b(\d{1,2}):(\d{2})\b/.exec(ev.date?.when || '');
  if (t12) { let h = +t12[1] % 12; if (/pm/i.test(t12[3])) h += 12; time = `${String(h).padStart(2, '0')}:${t12[2] || '00'}`; }
  else if (t24) time = `${t24[1].padStart(2, '0')}:${t24[2]}`;
  const date = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}T${time || '00:00'}:00`;
  return { date, noTime: !time };
}

let serpUsed = 0;
// Recherche Google classique : les concerts apparaissent dans "events_results"
// (le moteur "google_events" de SerpApi a été arrêté)
async function fromGoogle(name) {
  const p = new URLSearchParams({ engine: 'google', q: `${name} concert`, gl: 'fr', hl: 'en', api_key: env.SERPAPI_KEY });
  serpUsed++;
  const r = await fetch('https://serpapi.com/search.json?' + p);
  const j = await r.json().catch(() => ({}));
  if (j.error) {
    if (/run out|limit|plan/i.test(j.error)) throw new Error('Quota SerpApi épuisé pour ce mois.');
    if (/hasn't returned|no results/i.test(j.error)) return [];
    throw new Error('SerpApi : ' + j.error);
  }
  const target = norm(name);
  return (j.events_results || [])
    .filter(e => norm(e.title).includes(target) || norm(e.description).includes(target))
    .map(e => {
      const d = parseGoogleDate(e); if (!d) return null;
      const addr = Array.isArray(e.address) ? e.address : (e.address ? [e.address] : []);
      const full = addr.join(', ');
      const last = (addr[addr.length - 1] || '').split(',').map(x => x.trim());
      const country = last.length > 1 ? last[last.length - 1] : '';
      const city = last.length > 1 ? last[0] : (last[0] || '');
      const coords = CITY_COORDS[norm(city)];
      const cc = toCC(country) || (/belgi/i.test(full) ? 'BE' : 'FR'); // recherche faite depuis la France
      const tix = (e.ticket_info || []).find(t => t.link && t.link_type === 'tickets') || (e.ticket_info || []).find(t => t.link);
      return {
        artist: name, date: d.date, noTime: d.noTime,
        venue: e.venue?.name || (addr[0] || '').split(',')[0], city, cc,
        lat: coords ? coords[0] : null, lng: coords ? coords[1] : null,
        links: [{ src: tix?.source || 'Google', url: tix?.link || e.link }]
      };
    })
    .filter(Boolean);
}

async function googleEvents(pickList) {
  const every = 7 * 86400000 - 3 * 3600000;
  if (!env.SERPAPI_KEY) return { events: [], at: null, note: 'Pas de clé SerpApi : France via Google désactivée.' };
  if (prev?.serp?.at && Date.now() - prev.serp.at < every) {
    return { events: prev.serp.events || [], at: prev.serp.at, note: `Google : résultats de la semaine réutilisés (${(prev.serp.events || []).length} concerts).` };
  }
  const list = pickList.slice(0, cfg.serpArtists ?? 40);
  const out = [];
  try {
    for (const a of list) out.push(...await fromGoogle(a.name));
  } catch (e) {
    console.warn(e.message);
    return { events: prev?.serp?.events || [], at: prev?.serp?.at || null, note: `⚠️ ${e.message} Résultats précédents conservés.` };
  }
  return { events: out, at: Date.now(), note: `Google : ${serpUsed} recherches SerpApi, ${out.length} concerts trouvés.` };
}

function mergeEvents(list) {
  const by = new Map();
  for (const e of list) {
    if (!e.date || !KEEP_CC.has(e.cc)) continue;
    const key = norm(e.artist) + '|' + e.date.slice(0, 10) + '|' + norm(e.city);
    const p = by.get(key);
    if (!p) { by.set(key, { ...e, key }); continue; }
    for (const l of e.links) if (l.url && !p.links.some(x => x.src === l.src)) p.links.push(l);
    if (p.noTime && !e.noTime) { p.date = e.date; p.noTime = false; }
    if (!p.lat && e.lat) { p.lat = e.lat; p.lng = e.lng; }
  }
  const today = new Date().toISOString().slice(0, 10);
  return [...by.values()].filter(e => e.date.slice(0, 10) >= today).sort((a, b) => a.date.localeCompare(b.date));
}

// ---------- Zone ----------
function home() {
  if (cfg.home === 'gps') return cfg.gps;
  const c = CITIES[cfg.home]; return c ? { lat: c[0], lng: c[1] } : null;
}
function km(a, b) {
  const R = 6371, r = x => x * Math.PI / 180;
  const h = Math.sin(r(b.lat - a.lat) / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(r(b.lng - a.lng) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function inZone(e) {
  if (!(cfg.countries || []).includes(e.cc)) return false;
  if ((cfg.hidden || []).includes(norm(e.artist))) return false;
  const h = home();
  if (cfg.radius > 0 && h && e.lat && e.lng && km(h, e) > cfg.radius) return false;
  return true;
}

// ---------- Notification ntfy ----------
async function notify(events) {
  if (!env.NTFY_TOPIC || !cfg.notify || !events.length) return;
  const f = new Intl.DateTimeFormat('fr-FR', { day: 'numeric', month: 'short' });
  const lines = events.slice(0, 10).map(e => `${e.artist}, ${e.city} le ${f.format(new Date(e.date))}`);
  if (events.length > 10) lines.push(`et ${events.length - 10} autres`);
  const title = events.length > 1 ? `${events.length} nouveaux concerts` : 'Nouveau concert';
  await fetch(`https://ntfy.sh/${encodeURIComponent(env.NTFY_TOPIC)}`, {
    method: 'POST',
    headers: { 'Title': encodeURIComponent(title), 'X-Title-Encoding': 'uri', 'Tags': 'ticket', ...(env.APP_URL ? { 'Click': env.APP_URL } : {}) },
    body: lines.join('\n')
  }).catch(e => console.warn('ntfy :', e.message));
}

// ---------- Résumé visible sur la page de l'exécution ----------
async function summary(lines) {
  console.log(lines.join('\n'));
  if (env.GITHUB_STEP_SUMMARY) await fs.appendFile(env.GITHUB_STEP_SUMMARY, lines.map(l => `- ${l}`).join('\n') + '\n');
}

// ---------- Exécution ----------
await spToken();
const artists = await collectArtists();
if (!artists.length) { await summary(['❌ Aucun artiste trouvé sur Spotify. Liste précédente conservée.']); process.exit(1); }

// Protection : si Spotify a renvoyé beaucoup moins d'artistes que la dernière fois, on n'écrase rien
if (prev?.artists?.length && artists.length < prev.artists.length * 0.5) {
  await summary([`⚠️ Seulement ${artists.length} artistes (contre ${prev.artists.length} la dernière fois, ${spErrors} erreurs Spotify).`,
    'Liste précédente conservée. Réessaie plus tard.']);
  process.exit(1);
}

const hidden = new Set(cfg.hidden || []);
const pick = artists.filter(a => !hidden.has(norm(a.name))).slice(0, cfg.maxArtists || 150);

const raw = [];
let i = 0;
await Promise.all(Array.from({ length: 4 }, async () => {
  while (i < pick.length) {
    const a = pick[i++];
    const [x, y] = await Promise.all([fromBandsintown(a.name), fromTicketmaster(a.name)]);
    raw.push(...x, ...y);
  }
}));

const google = await googleEvents(pick);
raw.push(...google.events);

const events = mergeEvents(raw);

// Protection : zéro concert alors qu'il y en avait avant = problème de source, on n'écrase rien
if (!events.length && prev?.events?.length) {
  await summary([`⚠️ Aucun concert trouvé (${prev.events.length} la dernière fois). Vérifie la clé Ticketmaster.`,
    'Liste précédente conservée.']);
  process.exit(1);
}

const prevKeys = prev ? new Set(prev.events.map(e => e.key)) : null;
events.forEach(e => { e.isNew = !!prevKeys && !prevKeys.has(e.key); });

await fs.writeFile('data.json', JSON.stringify({
  at: Date.now(),
  artists: artists.slice(0, 400).map(a => ({ name: a.name, score: Math.round(a.score) })),
  events,
  serp: { at: google.at, events: google.events }
}, null, 1));

const fresh = events.filter(e => e.isNew && inZone(e));
await summary([
  `🎧 ${artists.length} artistes trouvés sur Spotify, ${pick.length} surveillés (${spErrors} erreurs Spotify)`,
  `🎟️ ${events.length} concerts en Europe, ${events.filter(inZone).length} dans ta zone`,
  `✨ ${fresh.length} nouveaux concerts dans ta zone`,
  `🇫🇷 ${google.note}`
]);
await notify(fresh);
