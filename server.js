/**
 * TraceMap
 * Suivi multi-source de traces GPS (Meshtastic, téléphone, GPX)
 */

const express = require('express');
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const exifr = require('exifr');

const localConfig = require('./config.local.js');
const CONFIG = {
  mqtt: {
    broker: 'mqtt://mqtt.meshtastic.org',
    port: 1883,
    username: 'meshdev',
    password: 'large4cats',
    topic: 'msh/EU_868/2/e/#',
  },
  ...localConfig,
  dbPath: path.join(__dirname, 'data', 'positions.db'),
  keepDays: 36500,
};

const PHOTOS_DIR = path.join(__dirname, 'data', 'photos');
const PHOTOS_TMP = path.join(__dirname, 'data', 'photos', 'tmp');
fs.mkdirSync(PHOTOS_TMP, { recursive: true });

const uploadTmp = multer({
  dest: PHOTOS_TMP,
  limits: { fileSize: 50 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Fichier non image'));
  }
});

function haversineMeters(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180)*Math.cos(lat2*Math.PI/180)*Math.sin(dLon/2)**2;
  return R * 2 * Math.asin(Math.sqrt(a));
}

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true }));

const db = new Database(CONFIG.dbPath);
db.exec(`
  CREATE TABLE IF NOT EXISTS positions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    node_id TEXT NOT NULL,
    node_name TEXT,
    latitude REAL NOT NULL,
    longitude REAL NOT NULL,
    altitude REAL,
    speed REAL,
    battery INTEGER,
    timestamp INTEGER NOT NULL,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
  CREATE INDEX IF NOT EXISTS idx_timestamp ON positions(timestamp);
  CREATE INDEX IF NOT EXISTS idx_node ON positions(node_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_wpt_unique ON positions(latitude, longitude, source) WHERE source = 'gpx_waypoint';
`);
console.log('✅ Base de données SQLite initialisée');

db.exec(`
  CREATE TABLE IF NOT EXISTS traces (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    start_time INTEGER NOT NULL,
    end_time INTEGER,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );
`);
try { db.exec('ALTER TABLE positions ADD COLUMN trace_id INTEGER REFERENCES traces(id)'); } catch {}
try { db.exec("ALTER TABLE positions ADD COLUMN source TEXT DEFAULT 'meshtastic_mqtt'"); } catch {}
try { db.exec("ALTER TABLE traces ADD COLUMN color TEXT DEFAULT '#3b82f6'"); } catch {}
try { db.exec("ALTER TABLE traces ADD COLUMN description TEXT"); } catch {}
try { db.exec("ALTER TABLE positions ADD COLUMN description TEXT"); } catch {}

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);

db.exec(`CREATE TABLE IF NOT EXISTS photos (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  position_id INTEGER NOT NULL,
  filepath TEXT NOT NULL,
  original_name TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now')),
  imported_by INTEGER REFERENCES tokens(id)
);`);
// Migration : ajouter imported_by si absent
try { db.exec(`ALTER TABLE photos ADD COLUMN imported_by INTEGER REFERENCES tokens(id)`); } catch {}
// Photos existantes sans importateur → token id 2 (Natel Joel)
db.exec(`UPDATE photos SET imported_by = 2 WHERE imported_by IS NULL`);

db.exec(`CREATE TABLE IF NOT EXISTS tokens (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  token TEXT NOT NULL UNIQUE,
  label TEXT,
  created_at INTEGER DEFAULT (strftime('%s','now'))
);`);

db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run('autoRollover', 'true');
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run('photoMatchRadius', '50');
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run('wptCategories', '[]');

function getSetting(key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : null;
}
function setSetting(key, value) {
  db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)').run(key, String(value));
}

function getCurrentTrace() {
  return db.prepare('SELECT * FROM traces WHERE end_time IS NULL ORDER BY start_time DESC LIMIT 1').get();
}

function createTrace(name) {
  const now = Math.floor(Date.now() / 1000);
  const result = db.prepare('INSERT INTO traces (name, start_time) VALUES (?, ?)').run(name, now);
  return db.prepare('SELECT * FROM traces WHERE id = ?').get(result.lastInsertRowid);
}

function ensureActiveTrace() {
  let trace = getCurrentTrace();
  if (!trace) {
    const today = new Date().toLocaleDateString('fr-CH');
    trace = createTrace(`Tracé ${today}`);
    console.log(`📂 Nouveau tracé créé: ${trace.name}`);
  }
  return trace;
}

function scheduleMidnightRollover() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  setTimeout(() => {
    if (getSetting('autoRollover') === 'true') {
      const active = getCurrentTrace();
      if (active) {
        db.prepare('UPDATE traces SET end_time = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), active.id);
        console.log(`📂 Tracé terminé automatiquement: ${active.name}`);
      }
      const today = new Date().toLocaleDateString('fr-CH');
      createTrace(`Tracé ${today}`);
      console.log(`📂 Nouveau tracé automatique créé pour ${today}`);
    } else {
      console.log(`📂 Rollover automatique désactivé, pas de nouveau tracé créé`);
    }
    scheduleMidnightRollover();
  }, midnight - now);
}

ensureActiveTrace();
scheduleMidnightRollover();

// Génère le token Traccar dédié au premier démarrage
if (!getSetting('traccarToken')) {
  setSetting('traccarToken', crypto.randomBytes(16).toString('hex'));
}

// Si aucun token en DB → génère un token bootstrap affiché dans les logs
if (!db.prepare('SELECT id FROM tokens LIMIT 1').get()) {
  const bootstrapToken = crypto.randomBytes(32).toString('hex');
  db.prepare('INSERT INTO tokens (token, label) VALUES (?, ?)').run(bootstrapToken, 'Bootstrap');
  console.log('\n⚠️  Aucun token trouvé — token bootstrap généré :');
  console.log(`   ${bootstrapToken}`);
  console.log('   Accédez à /admin?token=<ci-dessus> pour créer vos tokens depuis les Paramètres.\n');
}

function isAuthenticated(req) {
  const token = req.headers['x-session-token'] || req.query.token;
  if (!token) return false;
  return !!db.prepare('SELECT id FROM tokens WHERE token = ?').get(token);
}

function getTokenId(req) {
  const token = req.headers['x-session-token'] || req.query.token;
  if (!token) return null;
  const row = db.prepare('SELECT id FROM tokens WHERE token = ?').get(token);
  return row ? row.id : null;
}

function buildNonce(packetId, fromNode) {
  const nonce = Buffer.alloc(16, 0);
  nonce.writeUInt32LE(packetId >>> 0, 0);
  nonce.writeUInt32LE(fromNode >>> 0, 8);
  return nonce;
}

function decryptPayload(encryptedData, packetId, fromNode, keyBase64) {
  try {
    const key = Buffer.from(keyBase64, 'base64');
    const nonce = buildNonce(packetId, fromNode);
    const decipher = crypto.createDecipheriv('aes-256-ctr', key, nonce);
    return Buffer.concat([decipher.update(encryptedData), decipher.final()]);
  } catch (e) { return null; }
}

function parseServiceEnvelope(buf) {
  let pos = 0;
  let meshPacketBuf = null;
  while (pos < buf.length) {
    const tag = buf[pos++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 2) {
      let len = 0, shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7F) << shift; shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const data = buf.slice(pos, pos + len); pos += len;
      if (fieldNumber === 1) meshPacketBuf = data;
    } else if (wireType === 0) {
      while (pos < buf.length) { const b = buf[pos++]; if ((b & 0x80) === 0) break; }
    } else if (wireType === 5) { pos += 4;
    } else if (wireType === 1) { pos += 8;
    } else { break; }
  }
  return meshPacketBuf;
}

// CORRECTION CLÉ: from et to sont en fixed32 (wireType=5) dans Meshtastic
function parseMeshPacket(buf) {
  let pos = 0;
  const result = { from: 0, to: 0, id: 0, encrypted: null };
  while (pos < buf.length) {
    const tag = buf[pos++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 5) {
      // fixed32 — lire 4 bytes little-endian
      if (pos + 4 > buf.length) break;
      const value = buf.readUInt32LE(pos); pos += 4;
      if (fieldNumber === 1) result.from = value >>> 0;
      if (fieldNumber === 2) result.to = value >>> 0;
      if (fieldNumber === 6) result.id = value >>> 0;
    } else if (wireType === 0) {
      let value = 0, shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        value |= (b & 0x7F) << shift; shift += 7;
        if ((b & 0x80) === 0) break;
      }
      if (fieldNumber === 6) result.id = value >>> 0;
    } else if (wireType === 2) {
      let len = 0, shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7F) << shift; shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const data = buf.slice(pos, pos + len); pos += len;
      if (fieldNumber === 5) result.encrypted = data;
    } else if (wireType === 1) { pos += 8;
    } else { break; }
  }
  return result;
}

function parseDataPayload(buf) {
  let pos = 0;
  const result = { portnum: 0, payload: null };
  while (pos < buf.length) {
    const tag = buf[pos++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 0) {
      let value = 0, shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        value |= (b & 0x7F) << shift; shift += 7;
        if ((b & 0x80) === 0) break;
      }
      if (fieldNumber === 1) result.portnum = value;
    } else if (wireType === 2) {
      let len = 0, shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7F) << shift; shift += 7;
        if ((b & 0x80) === 0) break;
      }
      const data = buf.slice(pos, pos + len); pos += len;
      if (fieldNumber === 2) result.payload = data;
    } else if (wireType === 5) { pos += 4;
    } else if (wireType === 1) { pos += 8;
    } else { break; }
  }
  return result;
}

function parsePosition(buf) {
  let pos = 0;
  const result = {};
  while (pos < buf.length) {
    const tag = buf[pos++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 5) {
      // fixed32 little-endian
      if (pos + 4 > buf.length) break;
      const value = buf.readUInt32LE(pos); pos += 4;
      if (fieldNumber === 1) result.latitude_i = value;
      if (fieldNumber === 2) result.longitude_i = value;
      if (fieldNumber === 6) result.time = value;
    } else if (wireType === 0) {
      let value = 0, shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        value |= (b & 0x7F) << shift; shift += 7;
        if ((b & 0x80) === 0) break;
      }
      if (fieldNumber === 3) result.altitude = value;
      if (fieldNumber === 4) result.time = value;
      if (fieldNumber === 9) result.ground_speed = value;
    } else if (wireType === 2) {
      let len = 0, shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7F) << shift; shift += 7;
        if ((b & 0x80) === 0) break;
      }
      pos += len;
    } else if (wireType === 5) { pos += 4;
    } else if (wireType === 1) { pos += 8;
    } else { break; }
  }
  return result;
}

function parseTelemetry(buf) {
  let pos = 0;
  let battery = null;
  while (pos < buf.length) {
    const tag = buf[pos++];
    const fieldNumber = tag >> 3;
    const wireType = tag & 0x07;
    if (wireType === 2) {
      let len = 0, shift = 0;
      while (pos < buf.length) {
        const b = buf[pos++];
        len |= (b & 0x7F) << shift; shift += 7;
        if ((b & 0x80) === 0) break;
      }
      if (fieldNumber === 1) {
        let p2 = 0;
        const sub = buf.slice(pos, pos + len);
        while (p2 < sub.length) {
          const t2 = sub[p2++];
          const f2 = t2 >> 3; const w2 = t2 & 0x07;
          if (w2 === 0) {
            let v = 0, s = 0;
            while (p2 < sub.length) { const b = sub[p2++]; v |= (b & 0x7F) << s; s += 7; if ((b & 0x80) === 0) break; }
            if (f2 === 1) battery = v;
          } else break;
        }
      }
      pos += len;
    } else if (wireType === 0) {
      while (pos < buf.length) { const b = buf[pos++]; if ((b & 0x80) === 0) break; }
    } else if (wireType === 5) { pos += 4;
    } else if (wireType === 1) { pos += 8;
    } else { break; }
  }
  return { battery };
}

const PORTNUM_TEXT = 1;
const PORTNUM_POSITION = 3;
const PORTNUM_TELEMETRY = 67;
const lastBattery = new Map();

const mqttClient = mqtt.connect(CONFIG.mqtt.broker, {
  port: CONFIG.mqtt.port,
  username: CONFIG.mqtt.username,
  password: CONFIG.mqtt.password,
  clientId: `mesh_tracker_${crypto.randomBytes(4).toString('hex')}`,
  reconnectPeriod: 5000,
});

mqttClient.on('connect', () => {
  console.log('✅ Connecté à mqtt.meshtastic.org');
  mqttClient.subscribe(CONFIG.mqtt.topic, (err) => {
    if (!err) console.log(`📡 Abonné au topic: ${CONFIG.mqtt.topic}`);
  });
});

mqttClient.on('message', (topic, payload) => {
  try {
    if (!topic.includes(CONFIG.channelName)) return;
    console.log('📨 Topic trouvé:', topic);

    const meshBuf = parseServiceEnvelope(payload);
    if (!meshBuf) { console.log('⚠️ Pas de MeshPacket'); return; }

    const packet = parseMeshPacket(meshBuf);
    console.log(`🔍 from:${packet.from.toString(16)} id:${packet.id} encrypted:${packet.encrypted ? packet.encrypted.length + 'bytes' : 'null'}`);

    if (!packet.encrypted || packet.encrypted.length === 0) {
      console.log('⚠️ Pas de payload chiffré'); return;
    }

    const nodeId = '!' + packet.from.toString(16).padStart(8, '0');
    if (CONFIG.allowedNodes.length > 0 && !CONFIG.allowedNodes.includes(nodeId)) {
      console.log(`⚠️ Nœud non autorisé: ${nodeId}`); return;
    }

    const decrypted = decryptPayload(packet.encrypted, packet.id, packet.from, CONFIG.channelKey);
    if (!decrypted) { console.log(`⚠️ Déchiffrement échoué pour ${nodeId}`); return; }

    const data = parseDataPayload(decrypted);
    console.log(`🔍 Portnum:${data.portnum}`);

    if (data.portnum === PORTNUM_POSITION && data.payload) {
      console.log(`🔍 Position payload hex: ${data.payload.slice(0,20).toString("hex")}`);
      const pos = parsePosition(data.payload);
      const lat = pos.latitude_i / 1e7;
      const lon = pos.longitude_i / 1e7;
      if (!lat || !lon || lat === 0 || lon === 0) return;
      if (lat < -90 || lat > 90 || lon < -180 || lon > 180) return;

      const position = {
        node_id: nodeId, node_name: nodeId,
        latitude: lat, longitude: lon,
        altitude: pos.altitude || null,
        speed: pos.ground_speed || null,
        battery: lastBattery.get(nodeId) || null,
        timestamp: pos.time || Math.floor(Date.now() / 1000),
      };

      const currentTrace = ensureActiveTrace();
      db.prepare(`INSERT INTO positions (node_id, node_name, latitude, longitude, altitude, speed, battery, timestamp, trace_id, source)
        VALUES (@node_id, @node_name, @latitude, @longitude, @altitude, @speed, @battery, @timestamp, @trace_id, @source)`)
        .run({ ...position, trace_id: currentTrace.id, source: 'meshtastic_mqtt' });

      console.log(`📍 Position reçue: ${nodeId} → ${lat.toFixed(5)}, ${lon.toFixed(5)} alt:${pos.altitude || '?'}m`);

      const cutoff = Math.floor(Date.now() / 1000) - CONFIG.keepDays * 86400;
      db.prepare('DELETE FROM positions WHERE timestamp < ?').run(cutoff);

    } else if (data.portnum === PORTNUM_TELEMETRY && data.payload) {
      const telem = parseTelemetry(data.payload);
      if (telem.battery !== null) {
        lastBattery.set(nodeId, telem.battery);
        console.log(`🔋 Batterie ${nodeId}: ${telem.battery}%`);
      }
    } else if (data.portnum === PORTNUM_TEXT) {
      console.log(`💬 Message texte de ${nodeId}`);
    }

  } catch (err) {
    console.log('❌ Erreur:', err.message);
  }
});

mqttClient.on('error', (err) => console.error('❌ MQTT:', err.message));
mqttClient.on('reconnect', () => console.log('🔄 Reconnexion MQTT...'));

app.post(`/login`, (req, res) => {
  // Vérification mot de passe uniquement pour les confirmations de suppression
  const { password } = req.body;
  if (password === CONFIG.webPassword) {
    res.json({ success: true });
  } else {
    res.status(401).json({ success: false, message: 'Mot de passe incorrect' });
  }
});


app.get(`/api/positions`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { hours, from, to, node_id, trace_id } = req.query;
  let query, params;
  if (trace_id) {
    query = 'SELECT * FROM positions WHERE trace_id = ?';
    params = [parseInt(trace_id)];
    if (node_id) { query += ' AND node_id = ?'; params.push(node_id); }
  } else if (from && to) {
    query = "SELECT * FROM positions WHERE (timestamp BETWEEN ? AND ? OR source IN ('gpx_waypoint','manual'))";
    params = [parseInt(from), parseInt(to)];
    if (node_id) { query += ' AND node_id = ?'; params.push(node_id); }
  } else {
    const since = Math.floor(Date.now() / 1000) - parseInt(hours || 168) * 3600;
    query = "SELECT * FROM positions WHERE (timestamp > ? OR source IN ('gpx_waypoint','manual'))";
    params = [since];
    if (node_id) { query += ' AND node_id = ?'; params.push(node_id); }
  }
  query += ' ORDER BY timestamp ASC';
  res.json(db.prepare(query).all(...params));
});

app.get(`/api/last`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  res.json(db.prepare('SELECT * FROM positions ORDER BY timestamp DESC LIMIT 1').get() || null);
});

app.get(`/api/stats`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  res.json(db.prepare(`SELECT COUNT(*) as total_points, MIN(timestamp) as first_seen,
    MAX(timestamp) as last_seen, COUNT(DISTINCT node_id) as nodes FROM positions`).get());
});

app.get(`/api/traces`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  res.json(db.prepare(`
    SELECT t.*, COUNT(p.id) as point_count
    FROM traces t LEFT JOIN positions p ON p.trace_id = t.id
    GROUP BY t.id ORDER BY t.start_time DESC
  `).all());
});

app.put(`/api/traces/:id`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { name, color, description, start_time, end_time } = req.body;
  console.log(`📝 Mise à jour tracé ${req.params.id}:`, { name, color, description, start_time, end_time });
  if (name !== undefined) db.prepare('UPDATE traces SET name = ? WHERE id = ?').run(name.trim(), req.params.id);
  if (color !== undefined) db.prepare('UPDATE traces SET color = ? WHERE id = ?').run(color, req.params.id);
  if (description !== undefined) db.prepare('UPDATE traces SET description = ? WHERE id = ?').run(description || null, req.params.id);
  if (start_time !== undefined) db.prepare('UPDATE traces SET start_time = ? WHERE id = ?').run(start_time, req.params.id);
  if (end_time !== undefined) db.prepare('UPDATE traces SET end_time = ? WHERE id = ?').run(end_time, req.params.id);
  const updated = db.prepare('SELECT * FROM traces WHERE id = ?').get(req.params.id);
  console.log(`✅ Tracé ${req.params.id} mis à jour:`, updated);
  res.json(updated);
});

app.post(`/api/traces`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const trace = createTrace(name.trim());
  res.json(trace);
});

app.delete(`/api/traces/:id`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const id = req.params.id;
  db.prepare("DELETE FROM positions WHERE trace_id = ? AND source != 'gpx_waypoint'").run(id);
  db.prepare('DELETE FROM traces WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get(`/api/settings`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const rows = db.prepare('SELECT * FROM settings').all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  res.json(s);
});

app.put(`/api/settings`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { autoRollover, photoMatchRadius, wptCategories } = req.body;
  if (autoRollover !== undefined) setSetting('autoRollover', autoRollover ? 'true' : 'false');
  if (photoMatchRadius !== undefined) setSetting('photoMatchRadius', String(parseInt(photoMatchRadius) || 50));
  if (wptCategories !== undefined) setSetting('wptCategories', JSON.stringify(Array.isArray(wptCategories) ? wptCategories : []));
  res.json({ success: true });
});

app.put(`/api/traces/:id/end`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  db.prepare('UPDATE traces SET end_time = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), req.params.id);
  res.json({ success: true });
});

app.put(`/api/positions/:id`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { node_name, node_id, altitude, timestamp, description, latitude, longitude } = req.body;
  if (node_name !== undefined) db.prepare('UPDATE positions SET node_name = ? WHERE id = ?').run(node_name, req.params.id);
  if (node_id !== undefined) db.prepare('UPDATE positions SET node_id = ? WHERE id = ?').run(node_id, req.params.id);
  if (altitude !== undefined) db.prepare('UPDATE positions SET altitude = ? WHERE id = ?').run(altitude, req.params.id);
  if (timestamp !== undefined) db.prepare('UPDATE positions SET timestamp = ? WHERE id = ?').run(timestamp, req.params.id);
  if (description !== undefined) db.prepare('UPDATE positions SET description = ? WHERE id = ?').run(description || null, req.params.id);
  if (latitude !== undefined || longitude !== undefined) {
    const pos = db.prepare('SELECT source FROM positions WHERE id = ?').get(req.params.id);
    if (pos?.source === 'manual') {
      if (latitude  !== undefined) db.prepare('UPDATE positions SET latitude  = ? WHERE id = ?').run(parseFloat(latitude),  req.params.id);
      if (longitude !== undefined) db.prepare('UPDATE positions SET longitude = ? WHERE id = ?').run(parseFloat(longitude), req.params.id);
    }
  }
  res.json(db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id));
});

app.post(`/api/positions/manual`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { lat, lon, name, folder } = req.body;
  if (lat == null || lon == null) return res.status(400).json({ error: 'lat/lon requis' });
  const nodeId   = (folder || 'Manuel').trim();
  const nodeName = (name   || 'Point manuel').trim();
  const ts = Math.floor(Date.now() / 1000);
  const result = db.prepare(
    'INSERT INTO positions (node_id, node_name, latitude, longitude, timestamp, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(nodeId, nodeName, parseFloat(lat), parseFloat(lon), ts, 'manual');
  res.json(db.prepare('SELECT * FROM positions WHERE id = ?').get(result.lastInsertRowid));
});

app.delete(`/api/positions/:id`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  db.prepare('DELETE FROM positions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post(`/api/positions/ingest`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { points, trace_id, source = 'phone_gps' } = req.body;
  if (!Array.isArray(points) || points.length === 0) return res.status(400).json({ error: 'points doit être un tableau non vide' });
  const isWaypoint = source === 'gpx_waypoint';
  const traceId = isWaypoint ? null : (trace_id ? parseInt(trace_id) : (getCurrentTrace()?.id || ensureActiveTrace().id));
  const insert = db.prepare(`
    INSERT ${isWaypoint ? 'OR IGNORE' : ''} INTO positions (node_id, node_name, latitude, longitude, altitude, speed, battery, timestamp, trace_id, source)
    VALUES (@node_id, @node_name, @latitude, @longitude, @altitude, @speed, @battery, @timestamp, @trace_id, @source)
  `);
  const insertMany = db.transaction((pts) => {
    let inserted = 0, skipped = 0;
    for (const pt of pts) {
      if (pt.latitude == null || pt.longitude == null) continue;
      if (pt.latitude < -90 || pt.latitude > 90 || pt.longitude < -180 || pt.longitude > 180) continue;
      const info = insert.run({
        node_id: pt.device_id || 'phone',
        node_name: pt.device_name || 'Téléphone',
        latitude: parseFloat(pt.latitude),
        longitude: parseFloat(pt.longitude),
        altitude: pt.altitude != null ? parseFloat(pt.altitude) : null,
        speed: pt.speed != null ? parseFloat(pt.speed) : null,
        battery: pt.battery != null ? parseInt(pt.battery) : null,
        timestamp: pt.timestamp ? parseInt(pt.timestamp) : Math.floor(Date.now() / 1000),
        trace_id: traceId,
        source,
      });
      if (info.changes > 0) inserted++; else skipped++;
    }
    return { inserted, skipped };
  });
  res.json({ success: true, ...insertMany(points) });
});

// ── Traccar Client ───────────────────────────────────────────
app.all(`/api/traccar`, (req, res) => {
  const traccarToken = getSetting('traccarToken');
  const p = { ...req.query, ...req.body };
  if (p.token !== traccarToken) return res.status(401).send('Unauthorized');
  // Supporte le format flat (query params) ET le format imbriqué (Background Geolocation / transistorsoft)
  let lat = p.lat, lon = p.lon, timestamp = p.timestamp;
  let altitude = p.altitude, speed = p.speed, accuracy = p.accuracy || p.hdop;
  let batt = p.batt;
  let deviceId = (p.id || p.device_id || 'traccar').toString().substring(0, 64);

  if (!lat && p.location && p.location.coords) {
    const c = p.location.coords;
    lat = c.latitude; lon = c.longitude;
    altitude = c.altitude; speed = c.speed; accuracy = c.accuracy;
    timestamp = p.location.timestamp;
    if (!batt && p.location.battery) batt = Math.round(p.location.battery.level * 100);
  }

  const latitude = parseFloat(lat);
  const longitude = parseFloat(lon);
  if (!lat || !lon || isNaN(latitude) || isNaN(longitude)) {
    console.log(`📱 Traccar REJET lat=${lat} lon=${lon} body=${JSON.stringify(p).substring(0, 200)}`);
    return res.status(400).send('Missing or invalid lat/lon');
  }

  let ts;
  if (timestamp) {
    const n = parseFloat(timestamp);
    ts = isNaN(n) ? Math.floor(new Date(timestamp).getTime() / 1000) : (n > 1e10 ? Math.floor(n / 1000) : Math.floor(n));
  } else {
    ts = Math.floor(Date.now() / 1000);
  }

  const traceId = getCurrentTrace()?.id || ensureActiveTrace().id;

  db.prepare(`INSERT INTO positions (node_id, node_name, latitude, longitude, altitude, speed, battery, timestamp, trace_id, source)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'phone_gps')`).run(
    deviceId, deviceId,
    latitude, longitude,
    altitude != null ? parseFloat(altitude) : null,
    speed != null ? parseFloat(speed) : null,
    batt != null ? parseInt(batt) : null,
    ts, traceId
  );
  console.log(`📱 Traccar [${deviceId}] lat=${latitude.toFixed(5)} lon=${longitude.toFixed(5)} alt=${altitude ?? '?'}m → tracé #${traceId}`);
  res.status(200).send('OK');
});

// ── Photos ───────────────────────────────────────────────────

app.get(`/photos/*`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).send('Non autorisé');
  const safePath = path.normalize(req.params[0]).replace(/^(\.\.(\/|\\|$))+/, '');
  res.sendFile(safePath, { root: PHOTOS_DIR });
});

app.post(`/api/photos/upload`, uploadTmp.single('photo'), async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const file = req.file;
  if (!file) return res.status(400).json({ error: 'Aucun fichier' });
  const position_id = req.body.position_id ? parseInt(req.body.position_id) : null;

  let gps = null;
  // Coordonnées envoyées par le client (mobile : navigateur stripe l'EXIF à l'upload)
  const clientLat = req.body.gps_lat ? parseFloat(req.body.gps_lat) : null;
  const clientLon = req.body.gps_lon ? parseFloat(req.body.gps_lon) : null;
  if (clientLat && clientLon && isFinite(clientLat) && isFinite(clientLon)) {
    gps = { lat: clientLat, lon: clientLon };
  } else {
    try {
      const timeout = new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000));
      const exif = await Promise.race([exifr.gps(file.path), timeout]);
      if (exif && typeof exif.latitude === 'number' && typeof exif.longitude === 'number' && isFinite(exif.latitude) && isFinite(exif.longitude)) {
        gps = { lat: exif.latitude, lon: exif.longitude };
      }
    } catch (e) {}
  }

  const ext = path.extname(file.originalname || '').toLowerCase() || '.jpg';

  const importerId = getTokenId(req);
  const savePhoto = (wpt) => {
    const folder = wpt.node_id.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const dir = path.join(PHOTOS_DIR, folder);
    fs.mkdirSync(dir, { recursive: true });
    const filename = `${wpt.id}_${Date.now()}${ext}`;
    const filepath = path.join(folder, filename);
    fs.renameSync(file.path, path.join(PHOTOS_DIR, filepath));
    return db.prepare('INSERT INTO photos (position_id, filepath, original_name, imported_by) VALUES (?, ?, ?, ?)').run(wpt.id, filepath, file.originalname || filename, importerId);
  };

  if (position_id) {
    const wpt = db.prepare('SELECT * FROM positions WHERE id = ?').get(position_id);
    if (!wpt) { fs.unlinkSync(file.path); return res.status(404).json({ error: 'Waypoint introuvable' }); }
    const result = savePhoto(wpt);
    return res.json({ id: result.lastInsertRowid, filepath: db.prepare('SELECT filepath FROM photos WHERE id = ?').get(result.lastInsertRowid).filepath, gps });
  }

  const radius = parseInt(getSetting('photoMatchRadius')) || 50;
  let candidates = [];
  if (gps) {
    candidates = db.prepare("SELECT * FROM positions WHERE source = 'gpx_waypoint'").all()
      .map(w => ({ id: w.id, node_name: w.node_name, node_id: w.node_id, dist: Math.round(haversineMeters(gps.lat, gps.lon, w.latitude, w.longitude)) }))
      .filter(w => w.dist <= radius)
      .sort((a, b) => a.dist - b.dist)
      .slice(0, 5);
  }
  res.json({ tempId: file.filename, originalName: file.originalname, gps, candidates });
});

app.post(`/api/photos/confirm`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { tempId, position_id, original_name } = req.body;
  if (!tempId || !position_id) return res.status(400).json({ error: 'Paramètres manquants' });
  const wpt = db.prepare('SELECT * FROM positions WHERE id = ?').get(parseInt(position_id));
  if (!wpt) return res.status(404).json({ error: 'Waypoint introuvable' });
  const tmpPath = path.join(PHOTOS_TMP, tempId);
  if (!fs.existsSync(tmpPath)) return res.status(404).json({ error: 'Fichier temporaire introuvable' });
  const ext = path.extname(original_name || '').toLowerCase() || '.jpg';
  const folder = wpt.node_id.replace(/[^a-zA-Z0-9_\-]/g, '_');
  fs.mkdirSync(path.join(PHOTOS_DIR, folder), { recursive: true });
  const filename = `${wpt.id}_${Date.now()}${ext}`;
  const filepath = path.join(folder, filename);
  fs.renameSync(tmpPath, path.join(PHOTOS_DIR, filepath));
  const result = db.prepare('INSERT INTO photos (position_id, filepath, original_name, imported_by) VALUES (?, ?, ?, ?)').run(parseInt(position_id), filepath, original_name || filename, getTokenId(req));
  res.json({ id: result.lastInsertRowid, filepath });
});

app.get(`/api/photos/summary`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const rows = db.prepare('SELECT position_id, COUNT(*) as count FROM photos GROUP BY position_id').all();
  res.json(rows.map(r => ({ id: r.position_id, count: r.count })));
});

app.get(`/api/calendar-summary`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const fmt = "strftime('%Y-%m-%d', timestamp, 'unixepoch', 'localtime')";
  const wpt   = db.prepare(`SELECT DISTINCT ${fmt} as d FROM positions WHERE source = 'gpx_waypoint' AND timestamp > 0`).all().map(r => r.d);
  const gps   = db.prepare(`SELECT DISTINCT ${fmt} as d FROM positions WHERE source != 'gpx_waypoint' AND timestamp > 0`).all().map(r => r.d);
  const photo = db.prepare(`SELECT DISTINCT strftime('%Y-%m-%d', pos.timestamp, 'unixepoch', 'localtime') as d FROM photos ph JOIN positions pos ON pos.id = ph.position_id WHERE pos.timestamp > 0`).all().map(r => r.d);
  res.json({ wpt, gps, photo });
});

app.get(`/api/photos/for-positions`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const ids = (req.query.ids || '').split(',').map(Number).filter(n => n > 0);
  if (!ids.length) return res.json([]);
  const placeholders = ids.map(() => '?').join(',');
  const rows = db.prepare(`
    SELECT ph.id, ph.filepath, ph.original_name, ph.created_at,
           pos.node_name, pos.node_id, pos.timestamp, pos.id AS position_id,
           pos.latitude, pos.longitude,
           tok.label AS importer_label
    FROM photos ph
    JOIN positions pos ON pos.id = ph.position_id
    LEFT JOIN tokens tok ON tok.id = ph.imported_by
    WHERE ph.position_id IN (${placeholders})
    ORDER BY pos.timestamp ASC, ph.id ASC
  `).all(...ids);
  res.json(rows);
});

app.get(`/api/photos`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { position_id, trace_id } = req.query;
  if (trace_id) {
    res.json(db.prepare(`SELECT ph.*, pos.node_name, pos.latitude, pos.longitude, tok.label AS importer_label
      FROM photos ph JOIN positions pos ON pos.id = ph.position_id
      LEFT JOIN tokens tok ON tok.id = ph.imported_by
      WHERE pos.trace_id = ? ORDER BY ph.created_at`).all(parseInt(trace_id)));
  } else if (position_id) {
    res.json(db.prepare(`SELECT ph.*, tok.label AS importer_label
      FROM photos ph LEFT JOIN tokens tok ON tok.id = ph.imported_by
      WHERE ph.position_id = ? ORDER BY ph.created_at`).all(parseInt(position_id)));
  } else {
    return res.status(400).json({ error: 'position_id ou trace_id requis' });
  }
});

// Import en masse : position_id (wpt) ou trace_id (trace avec matching GPS)
app.post(`/api/photos/bulk`, uploadTmp.array('photos', 100), async (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const importerId = getTokenId(req);
  const files = req.files || [];
  const { position_id, trace_id } = req.body;
  const results = { linked: [], no_gps: [], errors: [] };
  const timeout = ms => new Promise((_, r) => setTimeout(() => r(new Error('timeout')), ms));

  if (position_id) {
    // Waypoint bulk : toutes les photos liées directement
    const pid = parseInt(position_id);
    const wpt = db.prepare('SELECT * FROM positions WHERE id = ?').get(pid);
    if (!wpt) return res.status(404).json({ error: 'Waypoint introuvable' });
    const folder = wpt.node_id || 'default';
    for (const file of files) {
      try {
        const dest = path.join(PHOTOS_DIR, folder, file.filename);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.renameSync(file.path, dest);
        const filepath = `${folder}/${file.filename}`;
        db.prepare('INSERT INTO photos (position_id, filepath, original_name, created_at, imported_by) VALUES (?, ?, ?, ?, ?)')
          .run(pid, filepath, file.originalname, Math.floor(Date.now() / 1000), importerId);
        results.linked.push({ file: file.originalname, position_id: pid });
      } catch(e) {
        try { fs.unlinkSync(file.path); } catch {}
        results.errors.push({ file: file.originalname, error: e.message });
      }
    }
  } else if (trace_id) {
    // Trace bulk : matching GPS → point le plus proche, sinon premier point
    const tid = parseInt(trace_id);
    const tracePos = db.prepare("SELECT * FROM positions WHERE trace_id = ? AND source != 'gpx_waypoint' ORDER BY timestamp ASC").all(tid);
    if (!tracePos.length) return res.status(400).json({ error: 'Aucun point GPS dans ce tracé' });
    const firstPos = tracePos[0];
    const folder = `trace_${tid}`;
    fs.mkdirSync(path.join(PHOTOS_DIR, folder), { recursive: true });

    for (const file of files) {
      try {
        let targetPos = null, dist = null;
        try {
          const gps = await Promise.race([exifr.gps(file.path), timeout(8000)]);
          if (gps && typeof gps.latitude === 'number' && isFinite(gps.latitude)) {
            let best = firstPos, bestDist = Infinity;
            for (const p of tracePos) {
              const d = haversineMeters(gps.latitude, gps.longitude, p.latitude, p.longitude);
              if (d < bestDist) { bestDist = d; best = p; }
            }
            targetPos = best; dist = Math.round(bestDist);
          }
        } catch {}
        const dest = path.join(PHOTOS_DIR, folder, file.filename);
        fs.renameSync(file.path, dest);
        const filepath = `${folder}/${file.filename}`;
        const pid = targetPos ? targetPos.id : firstPos.id;
        db.prepare('INSERT INTO photos (position_id, filepath, original_name, created_at, imported_by) VALUES (?, ?, ?, ?, ?)')
          .run(pid, filepath, file.originalname, Math.floor(Date.now() / 1000), importerId);
        if (targetPos) results.linked.push({ file: file.originalname, position_id: pid, dist });
        else results.no_gps.push({ file: file.originalname, position_id: firstPos.id });
      } catch(e) {
        try { fs.unlinkSync(file.path); } catch {}
        results.errors.push({ file: file.originalname, error: e.message });
      }
    }
  } else if (req.body.match_waypoints) {
    // Import global : matching GPS → waypoint le plus proche dans le rayon
    const allWpts = db.prepare("SELECT * FROM positions WHERE source = 'gpx_waypoint'").all();
    const radius = parseInt(getSetting('photoMatchRadius')) || 50;
    const folder = 'imports';
    fs.mkdirSync(path.join(PHOTOS_DIR, folder), { recursive: true });

    const pendingFolder = path.join(PHOTOS_DIR, 'imports', 'pending');
    fs.mkdirSync(pendingFolder, { recursive: true });

    const noMatchItems = [];

    for (const file of files) {
      try {
        let gps = null, exifDate = null;
        try {
          const exifData = await Promise.race([exifr.parse(file.path, { gps: true, tiff: true, exif: true }), timeout(8000)]);
          if (exifData) {
            if (typeof exifData.latitude === 'number' && isFinite(exifData.latitude))
              gps = { latitude: exifData.latitude, longitude: exifData.longitude };
            if (exifData.DateTimeOriginal)
              exifDate = Math.floor(new Date(exifData.DateTimeOriginal).getTime() / 1000);
          }
        } catch {}

        if (gps) {
          let best = null, bestDist = Infinity;
          for (const w of allWpts) {
            const d = haversineMeters(gps.latitude, gps.longitude, w.latitude, w.longitude);
            if (d < bestDist) { bestDist = d; best = w; }
          }
          if (best && bestDist <= radius) {
            const dest = path.join(PHOTOS_DIR, folder, file.filename);
            fs.renameSync(file.path, dest);
            const filepath = `${folder}/${file.filename}`;
            db.prepare('INSERT INTO photos (position_id, filepath, original_name, created_at, imported_by) VALUES (?, ?, ?, ?, ?)')
              .run(best.id, filepath, file.originalname, Math.floor(Date.now() / 1000), importerId);
            results.linked.push({ file: file.originalname, waypoint_name: best.node_name || best.node_id, dist: Math.round(bestDist) });
          } else {
            const pendingPath = path.join(pendingFolder, file.filename);
            fs.renameSync(file.path, pendingPath);
            noMatchItems.push({
              file: file.originalname,
              tempFilename: file.filename,
              lat: gps.latitude,
              lon: gps.longitude,
              exif_date: exifDate,
              nearest_name: best ? (best.node_name || best.node_id) : null,
              nearest_dist: best ? Math.round(bestDist) : null
            });
          }
        } else {
          const pendingPath = path.join(pendingFolder, file.filename);
          try { fs.renameSync(file.path, pendingPath); } catch { try { fs.unlinkSync(file.path); } catch {} }
          results.no_gps.push({ file: file.originalname, tempFilename: file.filename });
        }
      } catch(e) {
        try { fs.unlinkSync(file.path); } catch {}
        results.errors.push({ file: file.originalname, error: e.message });
      }
    }

    // Regrouper les no_match par proximité (rayon identique au matching)
    const assigned = new Set();
    results.no_match = [];
    for (let i = 0; i < noMatchItems.length; i++) {
      if (assigned.has(i)) continue;
      const base = noMatchItems[i];
      const cluster = {
        photos: [{ file: base.file, tempFilename: base.tempFilename, exif_date: base.exif_date }],
        lat: base.lat, lon: base.lon,
        nearest_name: base.nearest_name, nearest_dist: base.nearest_dist
      };
      assigned.add(i);
      for (let j = i + 1; j < noMatchItems.length; j++) {
        if (assigned.has(j)) continue;
        if (haversineMeters(base.lat, base.lon, noMatchItems[j].lat, noMatchItems[j].lon) <= radius) {
          cluster.photos.push({ file: noMatchItems[j].file, tempFilename: noMatchItems[j].tempFilename, exif_date: noMatchItems[j].exif_date });
          assigned.add(j);
        }
      }
      results.no_match.push(cluster);
    }
  } else {
    return res.status(400).json({ error: 'position_id, trace_id ou match_waypoints requis' });
  }
  res.json(results);
});

app.post(`/api/photos/create-waypoint`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const importerId = getTokenId(req);
  const { tempFilename, lat, lon, exif_date, name, folder, original_name, position_id } = req.body;
  if (!tempFilename) return res.status(400).json({ error: 'tempFilename manquant' });

  const srcPath = path.join(PHOTOS_DIR, 'imports', 'pending', tempFilename);

  if (position_id) {
    // Lier à un waypoint existant
    const wpt = db.prepare('SELECT * FROM positions WHERE id = ?').get(parseInt(position_id));
    if (!wpt) return res.status(404).json({ error: 'Waypoint introuvable' });
    const destFolder = path.join(PHOTOS_DIR, wpt.node_id || 'imports');
    fs.mkdirSync(destFolder, { recursive: true });
    const destPath = path.join(destFolder, tempFilename);
    try { fs.renameSync(srcPath, destPath); } catch {}
    const filepath = `${wpt.node_id || 'imports'}/${tempFilename}`;
    db.prepare('INSERT INTO photos (position_id, filepath, original_name, created_at, imported_by) VALUES (?, ?, ?, ?, ?)')
      .run(wpt.id, filepath, original_name || tempFilename, Math.floor(Date.now() / 1000), importerId);
    return res.json({ id: wpt.id, node_name: wpt.node_name, node_id: wpt.node_id });
  }

  // Créer un nouveau waypoint
  if (lat == null || lon == null) return res.status(400).json({ error: 'lat/lon manquants' });
  const nodeId = (folder || 'Imports').trim();
  const nodeName = (name || original_name || 'Photo').trim();
  const ts = exif_date || Math.floor(Date.now() / 1000);

  const pos = db.prepare(
    'INSERT INTO positions (node_id, node_name, latitude, longitude, timestamp, source) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(nodeId, nodeName, parseFloat(lat), parseFloat(lon), ts, 'gpx_waypoint');

  const destFolder = path.join(PHOTOS_DIR, nodeId);
  fs.mkdirSync(destFolder, { recursive: true });
  const destPath = path.join(destFolder, tempFilename);
  try { fs.renameSync(srcPath, destPath); } catch {}

  const filepath = `${nodeId}/${tempFilename}`;
  db.prepare('INSERT INTO photos (position_id, filepath, original_name, created_at, imported_by) VALUES (?, ?, ?, ?, ?)')
    .run(pos.lastInsertRowid, filepath, original_name || nodeName, Math.floor(Date.now() / 1000), importerId);

  res.json({ id: pos.lastInsertRowid, node_name: nodeName, node_id: nodeId });
});

app.delete(`/api/photos/all`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { position_id, trace_id } = req.query;
  let photos = [];
  if (position_id) {
    photos = db.prepare('SELECT * FROM photos WHERE position_id = ?').all(parseInt(position_id));
  } else if (trace_id) {
    photos = db.prepare(`SELECT ph.* FROM photos ph
      JOIN positions p ON p.id = ph.position_id
      WHERE p.trace_id = ?`).all(parseInt(trace_id));
  } else {
    return res.status(400).json({ error: 'position_id ou trace_id requis' });
  }
  for (const photo of photos) {
    const fullPath = path.join(PHOTOS_DIR, photo.filepath);
    if (fs.existsSync(fullPath)) try { fs.unlinkSync(fullPath); } catch {}
    db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  }
  res.json({ deleted: photos.length });
});

app.delete(`/api/photos/:id`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const photo = db.prepare('SELECT * FROM photos WHERE id = ?').get(parseInt(req.params.id));
  if (!photo) return res.status(404).json({ error: 'Photo introuvable' });
  const fullPath = path.join(PHOTOS_DIR, photo.filepath);
  if (fs.existsSync(fullPath)) fs.unlinkSync(fullPath);
  db.prepare('DELETE FROM photos WHERE id = ?').run(photo.id);
  res.json({ success: true });
});



// ── Gestion des tokens persistants ───────────────────────────
app.get('/api/tokens', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const rows = db.prepare('SELECT id, token, label, created_at FROM tokens ORDER BY created_at DESC').all();
  res.json(rows);
});

app.post('/api/tokens', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { label } = req.body;
  const token = crypto.randomBytes(32).toString('hex');
  const result = db.prepare('INSERT INTO tokens (token, label) VALUES (?, ?)').run(token, (label || 'Token').trim());
  res.json({ id: result.lastInsertRowid, token, label: (label || 'Token').trim() });
});

app.delete('/api/tokens/:id', (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  db.prepare('DELETE FROM tokens WHERE id = ?').run(parseInt(req.params.id));
  res.json({ ok: true });
});

// ── Pages ─────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get('/admin', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use((req, res) => res.status(404).send('Not found'));

app.listen(CONFIG.port, () => {
  console.log(`\n🚀 TraceMap démarré sur le port ${CONFIG.port}`);
  console.log(`🔗 URL admin: http://mesh.jscheunersarl.ch/admin`);
  console.log(`🔒 Mot de passe: ${CONFIG.webPassword}\n`);
});

