const net   = require('net');
const https = require('https');

const SUPABASE_HOST  = 'ysdllglxzvgwoooeztlg.supabase.co';

// ── PORTS CONNUS DU COBIA 3 ───────────────────────────────────────────
const PORTS = [
  { nom: 'Papeete',        lat: -17.5340, lon: -149.5667 },
  { nom: 'Kaukura',        lat: -15.6500, lon: -146.8833 },
  { nom: 'Arutua',         lat: -15.2453, lon: -146.6197 },
  { nom: 'Apataki',        lat: -15.3167, lon: -146.4000 },
  { nom: 'Aratika',        lat: -15.5333, lon: -145.5333 },
  { nom: 'Fakarava',       lat: -16.0833, lon: -145.7167 },
  { nom: 'Tetamanu',       lat: -16.5000, lon: -145.5333 },
  { nom: 'Faaite',         lat: -16.6869, lon: -145.3328 },
];
const PORT_RADIUS_DEG = 0.15; // ~15 km — rayon de correspondance

function resolvePortName(lat, lon, nmeaName) {
  if (lat === null || lon === null) return nmeaName;
  let nearest = null, minDist = Infinity;
  PORTS.forEach(p => {
    const d = Math.sqrt((p.lat-lat)**2 + (p.lon-lon)**2);
    if (d < minDist) { minDist = d; nearest = p; }
  });
  if (nearest && minDist <= PORT_RADIUS_DEG) return nearest.nom;
  return nmeaName; // waypoint hors liste → on garde le nom NMEA
}
const SUPABASE_KEY   = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InlzZGxsZ2x4enZnd29vb2V6dGxnIiwicm9sZSI6InNlcnZpY2Vfcm9sZSIsImlhdCI6MTc3ODM1NTU0NywiZXhwIjoyMDkzOTMxNTQ3fQ.PFBJroGneBbW7LeiOPE4JJBytbAirlV10-xuapQYK6Y';
const TZ_HOST        = '127.0.0.1';
const TZ_PORT        = 5556;
const SEND_INTERVAL  = 10000;
const HTTPS_TIMEOUT  = 8000;  // abandon requête Supabase après 8 s
const DEBUG          = false; // passer à true pour voir les trames brutes

let lastPos     = null;
let lastRmb     = null;
let buffer      = '';
let client      = null;
let reconnTimer = null;

// ── VALIDATION CHECKSUM NMEA (XOR entre $ et *) ──────────────────────
function nmeaChecksum(line) {
  const star = line.indexOf('*');
  if (star === -1) return false; // trame sans checksum → rejetée
  const expected = parseInt(line.slice(star + 1, star + 3), 16);
  if (isNaN(expected)) return false;
  let xor = 0;
  for (let i = 1; i < star; i++) xor ^= line.charCodeAt(i);
  return xor === expected;
}

// ── CONVERSION NMEA → DEGRÉS DÉCIMAUX ────────────────────────────────
function nmea2deg(val, dir) {
  if (!val || val.length < 4) return null;
  const dotIdx = val.indexOf('.');
  if (dotIdx < 2) return null; // guard : pas de point ou position invalide
  const d = parseFloat(val.slice(0, dotIdx - 2));
  const m = parseFloat(val.slice(dotIdx - 2));
  if (isNaN(d) || isNaN(m)) return null;
  let deg = d + m / 60;
  if (dir === 'S' || dir === 'W') deg = -deg;
  return Math.round(deg * 1000000) / 1000000;
}

// ── PARSING TRAME NMEA ────────────────────────────────────────────────
function parseLine(line) {
  line = line.trim();
  if (!line || !line.startsWith('$')) return;
  if (!nmeaChecksum(line)) return; // trame corrompue → ignorée
  if (DEBUG) console.log('[RAW]', line);

  // On retire le checksum (*XX) avant de splitter
  const clean = line.slice(0, line.indexOf('*'));
  const parts  = clean.split(',');
  const type   = parts[0].slice(3);

  if (type === 'RMC' && parts[2] === 'A') {
    const lat = nmea2deg(parts[3], parts[4]);
    const lon = nmea2deg(parts[5], parts[6]);
    const sog = parseFloat(parts[7]) * 1.852;
    const cog = parseFloat(parts[8]);
    if (lat !== null && lon !== null) {
      lastPos = { lat, lon, sog: isNaN(sog)?0:sog, cog: isNaN(cog)?0:cog, ts: new Date().toISOString() };
      console.log(`[GPS] ${lat.toFixed(4)}, ${lon.toFixed(4)} | Cap: ${Math.round(lastPos.cog)} | ${lastPos.sog.toFixed(1)} km/h`);
    }
  }

  if (type === 'RMB' && parts[1] === 'A') {
    // RMB : standard NMEA parts[4]=origine, parts[5]=destination
    // TimeZero peut mettre le nom en parts[4] → on prend le premier non vide
    const destination = parts[5] || parts[4] || null;
    const dest_lat    = nmea2deg(parts[6], parts[7]);
    const dest_lon    = nmea2deg(parts[8], parts[9]);
    const distNM      = parseFloat(parts[10]);
    const velocity    = parseFloat(parts[12]);
    let eta = null;
    if (!isNaN(distNM) && !isNaN(velocity) && velocity > 0.5) {
      eta = new Date(Date.now() + (distNM / velocity) * 3600000).toISOString();
    }
    if (destination) {
      const resolvedName = resolvePortName(dest_lat, dest_lon, destination);
      lastRmb = { destination: resolvedName, dest_lat, dest_lon, dist_nm: isNaN(distNM)?null:distNM, velocity: isNaN(velocity)?null:velocity, eta };
      console.log(`[RMB] Dest: ${destination} | ${dest_lat?.toFixed(4)}, ${dest_lon?.toFixed(4)} | Dist: ${distNM?.toFixed(1)} NM | ETA: ${eta||'N/A'}`);
    }
  }
}

// ── CONNEXION TCP VERS TIMEZERO ───────────────────────────────────────
function connect() {
  if (client) { client.removeAllListeners(); client.destroy(); client = null; }
  if (reconnTimer) { clearTimeout(reconnTimer); reconnTimer = null; }

  client = new net.Socket();
  client.setKeepAlive(true, 10000);

  client.connect(TZ_PORT, TZ_HOST, () => {
    console.log(`[TCP] Connecte a TimeZero ${TZ_HOST}:${TZ_PORT}`);
    buffer = '';
  });

  client.on('data', (data) => {
    buffer += data.toString();
    const lines = buffer.split('\n');
    buffer = lines.pop();
    if (buffer.length > 1000) buffer = ''; // guard anti-dépassement
    lines.forEach(parseLine);
  });

  client.on('error', (err) => {
    console.log(`[TCP] Erreur: ${err.message}`);
  });

  client.on('close', () => {
    console.log('[TCP] Connexion fermee - reconnexion dans 5s...');
    client.removeAllListeners();
    client.destroy();
    client = null;
    reconnTimer = setTimeout(connect, 5000);
  });
}

// ── ENVOI VERS SUPABASE ───────────────────────────────────────────────
function postSupabase(path, payload, label) {
  const body = JSON.stringify(payload);
  const req = https.request({
    hostname: SUPABASE_HOST, path, method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      'Prefer': 'return=minimal'
    }
  }, (res) => {
    res.resume();
    if (res.statusCode >= 400) console.error(`[SEND] Erreur HTTP ${res.statusCode} (${label})`);
    else console.log(`[SEND] OK ${label}`);
  });
  req.setTimeout(HTTPS_TIMEOUT, () => { req.destroy(); console.error(`[SEND] Timeout (${label})`); });
  req.on('error', (e) => console.error(`[SEND] Erreur reseau: ${e.message}`));
  req.write(body);
  req.end();
}

function sendToSupabase() {
  if (!lastPos) { console.log('[SEND] En attente GPS...'); return; }

  // ── Table position ──
  postSupabase('/rest/v1/position', {
    lat: lastPos.lat, lon: lastPos.lon,
    sog: lastPos.sog, cog: lastPos.cog, ts: lastPos.ts,
    destination: lastRmb?.destination || null,
    dist_nm:     lastRmb?.dist_nm     || null,
    eta:         lastRmb?.eta         || null,
  }, `pos ${lastPos.lat.toFixed(4)}, ${lastPos.lon.toFixed(4)} | Dest: ${lastRmb?.destination||'-'}`);

  // ── Table waypoint (si waypoint actif avec coordonnées) ──
  if (lastRmb?.dest_lat !== null && lastRmb?.dest_lat !== undefined) {
    postSupabase('/rest/v1/waypoint', {
      nom:         lastRmb.destination,
      lat:         lastRmb.dest_lat,
      lon:         lastRmb.dest_lon,
      distance_nm: lastRmb.dist_nm,
      vitesse_kn:  lastRmb.velocity,
      eta:         lastRmb.eta,
    }, `waypoint ${lastRmb.destination} → ${lastRmb.dest_lat?.toFixed(4)}, ${lastRmb.dest_lon?.toFixed(4)}`);
  }
}

console.log('=== Cobia GPS Tracker v5 ===');
console.log(`Client TCP vers ${TZ_HOST}:${TZ_PORT}`);
connect();
setInterval(sendToSupabase, SEND_INTERVAL);
