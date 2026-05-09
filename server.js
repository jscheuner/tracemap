/**
 * TraceMap
 * Suivi multi-source de traces GPS (Meshtastic, téléphone, GPX)
 */

const express = require('express');
const mqtt = require('mqtt');
const Database = require('better-sqlite3');
const crypto = require('crypto');
const path = require('path');

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

const app = express();
app.use(express.json({ limit: '10mb' }));

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

db.exec(`CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);`);
db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)").run('autoRollover', 'true');

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

const sessions = new Map();
function createSession() {
  const token = crypto.randomBytes(32).toString('hex');
  sessions.set(token, { createdAt: Date.now() });
  setTimeout(() => sessions.delete(token), 24 * 60 * 60 * 1000);
  return token;
}
function isAuthenticated(req) {
  const token = req.headers['x-session-token'] || req.query.token;
  return token && sessions.has(token);
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

app.post(`/${CONFIG.secretPath}/login`, (req, res) => {
  const { password } = req.body;
  if (password === CONFIG.webPassword) {
    res.json({ success: true, token: createSession() });
  } else {
    res.status(401).json({ success: false, message: 'Mot de passe incorrect' });
  }
});


app.get(`/${CONFIG.secretPath}/api/positions`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { hours = 24, node_id, trace_id } = req.query;
  let query, params;
  if (trace_id) {
    query = 'SELECT * FROM positions WHERE trace_id = ?';
    params = [parseInt(trace_id)];
    if (node_id) { query += ' AND node_id = ?'; params.push(node_id); }
  } else {
    const since = Math.floor(Date.now() / 1000) - parseInt(hours) * 3600;
    query = "SELECT * FROM positions WHERE (timestamp > ? OR source = 'gpx_waypoint')";
    params = [since];
    if (node_id) { query += ' AND node_id = ?'; params.push(node_id); }
  }
  query += ' ORDER BY timestamp ASC';
  res.json(db.prepare(query).all(...params));
});

app.get(`/${CONFIG.secretPath}/api/last`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  res.json(db.prepare('SELECT * FROM positions ORDER BY timestamp DESC LIMIT 1').get() || null);
});

app.get(`/${CONFIG.secretPath}/api/stats`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  res.json(db.prepare(`SELECT COUNT(*) as total_points, MIN(timestamp) as first_seen,
    MAX(timestamp) as last_seen, COUNT(DISTINCT node_id) as nodes FROM positions`).get());
});

app.get(`/${CONFIG.secretPath}/api/traces`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  res.json(db.prepare(`
    SELECT t.*, COUNT(p.id) as point_count
    FROM traces t LEFT JOIN positions p ON p.trace_id = t.id
    GROUP BY t.id ORDER BY t.start_time DESC
  `).all());
});

app.put(`/${CONFIG.secretPath}/api/traces/:id`, (req, res) => {
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

app.post(`/${CONFIG.secretPath}/api/traces`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { name } = req.body;
  if (!name || !name.trim()) return res.status(400).json({ error: 'Nom requis' });
  const trace = createTrace(name.trim());
  res.json(trace);
});

app.delete(`/${CONFIG.secretPath}/api/traces/:id`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const id = req.params.id;
  db.prepare('DELETE FROM positions WHERE trace_id = ?').run(id);
  db.prepare('DELETE FROM traces WHERE id = ?').run(id);
  res.json({ success: true });
});

app.get(`/${CONFIG.secretPath}/api/settings`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const rows = db.prepare('SELECT * FROM settings').all();
  const s = {};
  rows.forEach(r => { s[r.key] = r.value; });
  res.json(s);
});

app.put(`/${CONFIG.secretPath}/api/settings`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { autoRollover } = req.body;
  if (autoRollover !== undefined) setSetting('autoRollover', autoRollover ? 'true' : 'false');
  res.json({ success: true });
});

app.put(`/${CONFIG.secretPath}/api/traces/:id/end`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  db.prepare('UPDATE traces SET end_time = ? WHERE id = ?').run(Math.floor(Date.now() / 1000), req.params.id);
  res.json({ success: true });
});

app.put(`/${CONFIG.secretPath}/api/positions/:id`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { node_name, node_id } = req.body;
  if (node_name !== undefined) db.prepare('UPDATE positions SET node_name = ? WHERE id = ?').run(node_name, req.params.id);
  if (node_id !== undefined) db.prepare('UPDATE positions SET node_id = ? WHERE id = ?').run(node_id, req.params.id);
  res.json(db.prepare('SELECT * FROM positions WHERE id = ?').get(req.params.id));
});

app.delete(`/${CONFIG.secretPath}/api/positions/:id`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  db.prepare('DELETE FROM positions WHERE id = ?').run(req.params.id);
  res.json({ success: true });
});

app.post(`/${CONFIG.secretPath}/api/positions/ingest`, (req, res) => {
  if (!isAuthenticated(req)) return res.status(401).json({ error: 'Non autorisé' });
  const { points, trace_id, source = 'phone_gps' } = req.body;
  if (!Array.isArray(points) || points.length === 0) return res.status(400).json({ error: 'points doit être un tableau non vide' });
  const traceId = trace_id ? parseInt(trace_id) : (getCurrentTrace()?.id || ensureActiveTrace().id);
  const insert = db.prepare(`
    INSERT INTO positions (node_id, node_name, latitude, longitude, altitude, speed, battery, timestamp, trace_id, source)
    VALUES (@node_id, @node_name, @latitude, @longitude, @altitude, @speed, @battery, @timestamp, @trace_id, @source)
  `);
  const insertMany = db.transaction((pts) => {
    let count = 0;
    for (const pt of pts) {
      if (pt.latitude == null || pt.longitude == null) continue;
      if (pt.latitude < -90 || pt.latitude > 90 || pt.longitude < -180 || pt.longitude > 180) continue;
      insert.run({
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
      count++;
    }
    return count;
  });
  res.json({ success: true, inserted: insertMany(points) });
});

app.get('/tracker-app.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'tracker-app.html'));
});

app.get('/phone-tracker.html', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'phone-tracker.html'));
});

app.get(`/${CONFIG.secretPath}`, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.get(`/${CONFIG.secretPath}/admin`, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.use((req, res) => res.status(404).send('Not found'));

app.listen(CONFIG.port, () => {
  console.log(`\n🚀 TraceMap démarré sur le port ${CONFIG.port}`);
  console.log(`🔗 URL: http://mesh.jscheunersarl.ch/${CONFIG.secretPath}`);
  console.log(`🔒 Mot de passe: ${CONFIG.webPassword}\n`);
});

