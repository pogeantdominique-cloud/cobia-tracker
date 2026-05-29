const net   = require('net');
const https = require('https');

const SUPABASE_HOST  = 'ysdllglxzvgwoooeztlg.supabase.co';
const SUPABASE_KEY   = 'sb_publishable_t3LNsavHm0kvP3Si-nK-0g_QvP2tFH-';
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
      lastRmb = { destination, dest_lat, dest_lon, dist_nm: isNaN(distNM)?null:distNM, eta };
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
function sendToSupabase() {
  if (!lastPos) { console.log('[SEND] En attente GPS...'); return; }
  const payload = {
    lat: lastPos.lat, lon: lastPos.lon,
    sog: lastPos.sog, cog: lastPos.cog, ts: lastPos.ts,
    destination: lastRmb?.destination || null,
    dest_lat:    lastRmb?.dest_lat    || null,
    dest_lon:    lastRmb?.dest_lon    || null,
    dist_nm:     lastRmb?.dist_nm     || null,
    eta:         lastRmb?.eta         || null,
  };
  const body = JSON.stringify(payload);
  const req = https.request({
    hostname: SUPABASE_HOST, path: '/rest/v1/position', method: 'POST',
    headers: {
      'apikey': SUPABASE_KEY, 'Authorization': 'Bearer ' + SUPABASE_KEY,
      'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body),
      'Prefer': 'return=minimal'
    }
  }, (res) => {
    res.resume();
    if (res.statusCode >= 400) console.error(`[SEND] Erreur HTTP ${res.statusCode}`);
    else console.log(`[SEND] OK ${payload.lat.toFixed(4)}, ${payload.lon.toFixed(4)} | Dest: ${payload.destination||'-'}`);
  });
  // Timeout : évite l'accumulation de connexions pendantes si Supabase est lent
  req.setTimeout(HTTPS_TIMEOUT, () => { req.destroy(); console.error('[SEND] Timeout - requete annulee'); });
  req.on('error', (e) => console.error(`[SEND] Erreur reseau: ${e.message}`));
  req.write(body);
  req.end();
}

console.log('=== Cobia GPS Tracker v5 ===');
console.log(`Client TCP vers ${TZ_HOST}:${TZ_PORT}`);
connect();
setInterval(sendToSupabase, SEND_INTERVAL);
