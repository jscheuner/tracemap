# Changelog — TraceMap

## [En cours]

### Ajouté
- Sidebar avec onglets Tracés / Points GPS (dossiers collapsibles, édition/suppression par waypoint)
- Toolbar reorganisée en 3 zones : gestion tracés / période+refresh / outils
- Filter bar : chips sources (Meshtastic, Téléphone, GPX tracé, POI/Waypoints) + dossiers POI + appareils GPS
- Import GPX différencié : tracés (`<trkpt>`) → `gpx_import`, waypoints (`<wpt>`) → `gpx_waypoint` avec catégorie OsmAnd
- Calque GPX temporaire (overlay non persisté) : tracks pointillés + losanges POI cliquables
- Rendu waypoints : losanges colorés par dossier, exclus de la polyline
- Route `PUT /api/positions/:id` et `DELETE /api/positions/:id`
- Extraction credentials dans `config.local.js` (gitignore)
- Dossier `dev/` : ARCHITECTURE.md, API.md, FEATURES.md, CHANGELOG.md
- Bouton "✏️ Modifier" dans la bulle popup des waypoints → ouvre directement le modal d'édition
- Modal édition waypoint : nom, dossier, date, lat/lon readonly, altitude

### Modifié
- Bouton info (ⓘ) fusionné dans le crayon (✏️) → ouvre modal détails
- `GET /api/positions` : inclut toujours les `gpx_waypoint` quelle que soit la fenêtre temporelle
- Process PM2 renommé `meshtastic-tracker` → `tracemap`

---

## [2026-05-09] — Init GitHub

### Ajouté
- Paramètre `autoRollover` (settings DB + UI toggle dans ⚙️)
- Modal paramètres avec toggle création automatique journalière
- Routes `GET/PUT /api/settings`

---

## [Antérieur] — Fonctionnalités de base

### Ajouté
- Réception MQTT Meshtastic avec déchiffrement AES-256-CTR
- Parsing protobuf manuel (position + télémétrie batterie)
- Base SQLite : tables `positions`, `traces`, `settings`
- Interface admin : carte Leaflet, sidebar tracés, info panel
- Import GPX (ancienne version, points trkpt uniquement)
- App GPS téléphone avec partage QR code
- Vue publique en lecture seule
- Statistiques tracé : distance haversine, dénivelé, altitude
