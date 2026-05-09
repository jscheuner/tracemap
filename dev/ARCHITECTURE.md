# Architecture — TraceMap

## Vue d'ensemble

Application Node.js de suivi GPS multi-source avec visualisation cartographique. Fonctionne en autonomie (serveur local + MQTT public Meshtastic).

## Stack technique

| Couche | Technologie |
|--------|-------------|
| Serveur | Node.js + Express |
| Base de données | SQLite (better-sqlite3) |
| Temps réel | MQTT (mqtt.meshtastic.org) |
| Carte | Leaflet.js |
| Frontend | HTML/CSS/JS vanilla (pas de framework) |
| Process manager | PM2 (`tracemap`) |
| Reverse proxy | Nginx |

## Structure des fichiers

```
tracemap/
├── server.js              # Serveur Express + MQTT + API REST
├── config.local.js        # Credentials locaux (gitignore)
├── config.example.js      # Template de config
├── package.json
├── public/
│   ├── index.html         # Vue publique (lecture seule)
│   ├── admin.html         # Interface admin complète
│   └── phone-tracker.html # App GPS téléphone
├── data/
│   └── positions.db       # Base SQLite (gitignore)
└── dev/                   # Documentation développement
```

## Base de données SQLite

### Table `positions`
| Colonne | Type | Description |
|---------|------|-------------|
| id | INTEGER PK | Auto-increment |
| node_id | TEXT | ID appareil (ex: `!a1cd437c`) ou catégorie POI |
| node_name | TEXT | Nom affiché |
| latitude / longitude | REAL | Coordonnées GPS |
| altitude | REAL | Altitude en mètres |
| speed | REAL | Vitesse km/h |
| battery | INTEGER | Batterie % |
| timestamp | INTEGER | Unix timestamp |
| trace_id | INTEGER | FK → traces.id |
| source | TEXT | `meshtastic_mqtt` / `phone_gps` / `gpx_import` / `gpx_waypoint` |

### Table `traces`
| Colonne | Type | Description |
|---------|------|-------------|
| id | INTEGER PK | Auto-increment |
| name | TEXT | Nom du tracé |
| start_time | INTEGER | Début (unix) |
| end_time | INTEGER | Fin (unix), NULL si actif |
| color | TEXT | Couleur hex (#3b82f6) |
| description | TEXT | Notes libres |

### Table `settings`
| Colonne | Type | Description |
|---------|------|-------------|
| key | TEXT PK | Clé du paramètre |
| value | TEXT | Valeur |

Paramètres actuels :
- `autoRollover` — `true`/`false` : création automatique de trace à minuit

## Sources de données

### 1. Meshtastic MQTT (`meshtastic_mqtt`)
- Connexion au broker public `mqtt.meshtastic.org`
- Canal `EU_868/2/e/#` filtré sur le nom de canal configuré
- Déchiffrement AES-256-CTR avec la clé du canal
- Parsing manuel des protobuf (position + télémétrie batterie)
- Nœuds filtrables par `allowedNodes`

### 2. Téléphone GPS (`phone_gps`)
- App web `phone-tracker.html` ouverte via QR code
- Envoie des positions via `POST /api/positions/ingest`
- Session valable 24h via token dans l'URL

### 3. Import GPX — tracé (`gpx_import`)
- Points `<trkpt>` d'un fichier GPX
- Importés en base dans le tracé actif
- Connectés par la polyline sur la carte

### 4. Import GPX — waypoints (`gpx_waypoint`)
- Points `<wpt>` d'un fichier GPX (ex: favoris OsmAnd)
- `node_id` = dossier/catégorie (balise `<type>`)
- `node_name` = nom du point
- Toujours inclus dans les requêtes (pas de filtre temporel)
- Affichés en losanges colorés, exclus de la polyline

## Flux de données

```
MQTT ──► parseMeshPacket ──► decryptPayload ──► parsePosition
                                                      │
                                                 ensureActiveTrace
                                                      │
                                              INSERT INTO positions
                                                      │
                                           ◄── GET /api/positions
                                                      │
                                                 updateMap()
                                             (Leaflet markers)
```

## Sécurité

- `secretPath` : préfixe URL opaque pour toutes les routes (sécurité par obscurité)
- `webPassword` : authentification admin avec session token 24h
- Suppression de tracé protégée par re-saisie du mot de passe
- Pas d'HTTPS géré en direct (délégué à Nginx/Certbot)
