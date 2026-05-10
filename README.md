# TraceMap

Application web de suivi GPS multi-source avec visualisation cartographique. Conçue pour centraliser en temps réel les positions Meshtastic, téléphone et fichiers GPX sur une carte interactive, enrichie de waypoints, photos et descriptions.

---

## Sommaire

- [Fonctionnalités](#fonctionnalités)
- [Stack technique](#stack-technique)
- [Installation](#installation)
- [Configuration](#configuration)
- [Démarrage](#démarrage)
- [Sources GPS](#sources-gps)
- [Interface admin](#interface-admin)
- [Waypoints et dossiers](#waypoints-et-dossiers)
- [Photos](#photos)
- [Import GPX](#import-gpx)
- [Paramètres](#paramètres)
- [Structure des fichiers](#structure-des-fichiers)
- [Dépannage](#dépannage)

---

## Fonctionnalités

### Suivi GPS
- Réception des positions **Meshtastic** via MQTT (déchiffrement AES-256-CTR, parsing protobuf)
- Suivi téléphone via l'app **Traccar Client** (iOS/Android) — envoi automatique en arrière-plan, mise en cache offline et renvoi des points quand le réseau revient
- Import de fichiers **GPX** : tracés (`<trkpt>`) et waypoints (`<wpt>`) avec dossiers OsmAnd (`<type>`)
- Calque **GPX temporaire** (overlay non persisté) pour visualiser un fichier sans l'importer

### Tracés
- Création, renommage, couleur personnalisée, description riche (Quill.js)
- Rollover automatique à minuit (création d'un nouveau tracé chaque jour)
- Statistiques : distance haversine, dénivelé +/-, plage d'altitude
- Modification des dates de début/fin
- Suppression protégée par mot de passe

### Waypoints / POI
- Édition individuelle : nom, dossier/catégorie, altitude, date
- Description riche (Quill.js) : gras, italique, souligné, couleur, police, taille — rendu HTML dans le popup carte
- Photos par waypoint : ajout depuis le modal d'édition, carousel plein écran
- Suppression d'un dossier complet (avec confirmation mot de passe)
- Déduplication à l'import par coordonnées GPS

### Photos
- Import photo unique depuis le modal waypoint ou tracé
- **Import en masse** depuis le bouton toolbar "📷 Photo" : extraction GPS EXIF, correspondance automatique au waypoint le plus proche dans le rayon configuré, rapport détaillé (liées / hors rayon / sans GPS / erreurs)
- Import en masse dans un tracé : les photos avec GPS sont liées au point de tracé le plus proche, les autres au premier point
- Badge 📷 sur les icônes waypoints et points de tracé ayant des photos
- Carousel photo plein écran (navigation clavier, molette, boutons)

### Interface
- Sidebar avec onglets **Tracés** / **Points GPS** (dossiers collapsibles)
- Sélecteur de période en **date range picker** Flatpickr (calendrier, clic début → clic fin)
- Filter bar : chips par source (Meshtastic, Téléphone, GPX, POI), par dossier POI, par appareil GPS
- Rendu cartographique différencié : losanges colorés pour waypoints, points GPS avec badges photos, **points intermédiaires en mini-dot** (4×4 px) pour ne pas noyer les points importants
- Interface **responsive mobile** (sidebar overlay, toolbar en scroll horizontal, modals adaptés)
- Auto-refresh 30 s

---

## Stack technique

| Composant | Technologie |
|---|---|
| Serveur | Node.js + Express |
| Base de données | SQLite (better-sqlite3) |
| MQTT | mqtt.js |
| Protobuf Meshtastic | @meshtastic/protobufs |
| Photos EXIF | exifr |
| Upload fichiers | multer |
| Carte | Leaflet.js (CDN) |
| Éditeur texte riche | Quill.js (CDN) |
| Sélecteur de dates | Flatpickr (CDN) |
| Process manager | PM2 |
| Reverse proxy | Nginx |

---

## Installation

```bash
# Cloner le dépôt
git clone https://github.com/ton-user/tracemap.git /opt/www_node/tracemap
cd /opt/www_node/tracemap

# Installer les dépendances
npm install

# Créer la configuration locale
cp config.example.js config.local.js
# → éditer config.local.js avec vos valeurs
```

### Nginx

```nginx
server {
    listen 80;
    server_name tracemap.example.com;

    location / {
        proxy_pass http://localhost:3081;
        proxy_http_version 1.1;
        client_max_body_size 50M;   # nécessaire pour l'upload de photos
    }
}
```

```bash
sudo cp nginx.conf /etc/nginx/sites-available/tracemap
sudo ln -s /etc/nginx/sites-available/tracemap /etc/nginx/sites-enabled/
sudo nginx -t && sudo systemctl reload nginx

# SSL (recommandé)
sudo certbot --nginx -d tracemap.example.com
```

### PM2

```bash
npm install -g pm2
pm2 start server.js --name tracemap
pm2 save
pm2 startup
```

---

## Configuration

Toute la configuration sensible est dans `config.local.js` (gitignored) :

```javascript
module.exports = {
  channelKey: 'BASE64_KEY_ICI',     // Clé AES-256 du canal Meshtastic (base64)
  channelName: 'NomDuCanal',        // Nom du canal Meshtastic
  allowedNodes: ['!a1b2c3d4'],      // IDs des nœuds autorisés
  secretPath: 'mon-chemin-secret',  // Préfixe URL (ex: vacances2025abc)
  webPassword: 'motdepasse',        // Mot de passe interface admin
  port: 3081,
};
```

**secretPath** : toutes les routes sont préfixées par ce chemin. L'URL d'accès est donc `https://tracemap.example.com/{secretPath}`. C'est à la fois l'authentification d'accès à l'API et l'URL de connexion pour l'interface.

**channelKey** : récupérer dans l'app Meshtastic → Canaux → votre canal → icône clé → copier la clé base64.

**allowedNodes** : IDs des appareils Meshtastic autorisés à envoyer des positions (format `!xxxxxxxx`). Laisser vide `[]` pour accepter tous les nœuds.

---

## Démarrage

```bash
pm2 start tracemap
pm2 logs tracemap      # voir les logs en temps réel
pm2 restart tracemap   # après modification de server.js
```

L'interface admin est accessible à : `https://tracemap.example.com/{secretPath}`

---

## Sources GPS

### Meshtastic (MQTT)

Les appareils Meshtastic (LilyGo T-Deck, Heltec, etc.) envoient leurs positions via MQTT. Le serveur :
1. Se connecte au broker MQTT configuré
2. Déchiffre les paquets AES-256-CTR avec la clé du canal
3. Parse le protobuf (`Position`, `Telemetry`) pour extraire lat/lon/altitude/batterie
4. Enregistre en base avec `source = 'meshtastic'`

Configuration côté appareil :
- Canaux → votre canal → activer **Uplink enabled**
- Paramètres → Position → activer GPS → Smart Position ON
- Intervalle de position recommandé : 60 s

### Traccar Client (téléphone)

**Traccar Client** (app gratuite iOS/Android) est la solution recommandée pour le suivi téléphone. Avantages :
- Envoi automatique en arrière-plan (pas besoin d'ouvrir l'app)
- **Mise en cache offline** : les points sont stockés localement si pas de réseau et renvoyés automatiquement quand la connexion revient
- Idéal pour les roadtrips et zones de montagne avec connectivité intermittente

**Configuration de l'app Traccar Client :**

1. Dans l'app : "Server URL" → saisir l'URL affichée dans ⚙️ Paramètres de TraceMap
2. Format : `https://tracemap.example.com/{secretPath}/api/traccar`
3. Activer le suivi → l'app envoie les positions en continu

L'URL de configuration complète est affichée et copiable directement dans ⚙️ Paramètres de l'interface admin.

Les positions sont enregistrées avec `source = 'phone_gps'` et liées au tracé actif.

> **Note :** L'endpoint accepte aussi le format **Background Geolocation** (transistorsoft) dont le corps JSON est imbriqué (`location.coords.latitude`, `location.battery.level`, etc.).

### Import GPX

Deux types d'import depuis le bouton "↑ Import" de la toolbar :

**Tracé GPX** (balises `<trkpt>`) :
- Importe tous les points comme `source = 'gpx_import'`
- Les lie au tracé sélectionné ou en crée un nouveau
- Calcule automatiquement les statistiques (distance, dénivelé)

**Waypoints GPX** (balises `<wpt>`) :
- Importe comme `source = 'gpx_waypoint'`
- La catégorie OsmAnd (`<type>`) devient le dossier du waypoint
- Déduplication par coordonnées : les waypoints déjà présents aux mêmes coordonnées sont ignorés
- Rapport : `X importé(s), Y ignoré(s)`

**Calque temporaire** (Import temporaire) :
- Affiche le fichier GPX en overlay sur la carte (tracks pointillés + losanges POI)
- Non persisté en base, disparaît au rechargement

---

## Interface admin

### Toolbar

```
[ ⊕ Nouveau tracé ] [ Tracé actif ▾ ] [ ✏️ ] [ ✕ ]   |   [ 📅 Date début → Date fin ] [ ↺ ]   |   [ ⊕ Centrer ] [ Trajet ] [ ↑ Import ] [ Import temporaire ] [ 📷 Photo ] [ QR ] [ ⚙️ ]
```

- **Tracé actif** : le tracé sélectionné reçoit les nouveaux points GPS (téléphone, Meshtastic)
- **Date range** : Flatpickr en mode range — premier clic = date début, deuxième clic = date fin. Désactivé quand un tracé est sélectionné (le tracé a sa propre plage temporelle)
- **Trajet** : toggle d'affichage de la polyline
- **📷 Photo** : import en masse de photos à lier aux waypoints (voir section Photos)
- **QR** : QR code de l'URL d'accès à partager

### Sidebar — onglet Tracés

- Liste tous les tracés avec date, nombre de points, couleur
- Clic → sélectionne le tracé comme filtre carte
- **✏️** → ouvre le modal de détails : renommer, changer la couleur, modifier les dates, ajouter une description riche, gérer les photos du tracé
- **↓/↑ Date** : tri croissant/décroissant par `start_time`

### Sidebar — onglet Points GPS

- Vue groupée par dossier/catégorie (collapsible)
- Chaque waypoint : nom, date, bouton ✏️ pour éditer, 🗑️ pour supprimer
- Bouton 🗑️ sur un dossier → suppression de tous les waypoints du dossier (confirmation mot de passe)
- **↓/↑ Date** : tri des waypoints par `timestamp`

### Carte

- **Waypoints** : losanges colorés par dossier, badge 📷 si photos
- **Points GPS** :
  - Premier et dernier point → icône pleine taille (le dernier est agrandi)
  - Points avec photos → icône pleine avec badge 📷
  - **Points intermédiaires** → mini-dot 4×4 px de la couleur du tracé (discret, trace visible via la polyline)
- Popup sur chaque point : nom, date, coordonnées, altitude, batterie ; bouton **✏️ Modifier** (waypoints) et **📷 Photos** (si photos)
- Filter bar : filtrer par source, par dossier POI, par appareil GPS (node_id Meshtastic)

---

## Waypoints et dossiers

Les waypoints (`source = 'gpx_waypoint'`) sont **indépendants des tracés** :
- Ils ne sont pas supprimés quand un tracé est supprimé
- Ils apparaissent toujours sur la carte quelle que soit la fenêtre temporelle sélectionnée
- Ils ne font pas partie de la polyline de trajet

### Modal d'édition waypoint

- **Nom** : libellé affiché sur la carte et dans le popup
- **Dossier** : catégorie / groupe (liste des dossiers existants + "✏️ Autre dossier…")
- **Description** : éditeur Quill — gras, italique, souligné, couleur de texte, police, taille. Rendu HTML dans le popup carte.
- **Date** : horodatage du waypoint
- **Latitude / Longitude** : affichées en lecture seule
- **Altitude** : éditable
- **Photos** : miniatures des photos liées, bouton ＋ pour ajouter, ✕ pour supprimer

### Dossiers prédéfinis

Dans ⚙️ Paramètres → section "Dossiers prédéfinis" : ajouter/supprimer des dossiers disponibles dans la liste déroulante du modal waypoint.

---

## Photos

### Import en masse (toolbar "📷 Photo")

Sélectionner plusieurs photos → le serveur traite chaque fichier :
1. Extraction GPS EXIF (côté serveur, avec timeout 8 s)
2. Recherche du waypoint le plus proche
3. Si distance ≤ rayon configuré → liaison automatique
4. Rapport détaillé affiché :
   - ✅ **Liée** → nom du waypoint + distance en mètres
   - ⚠️ **Hors rayon** → nom du waypoint le plus proche + distance réelle
   - ⚠️ **Sans GPS** → EXIF absent ou illisible
   - ❌ **Erreur** → message d'erreur

Les photos non liées (hors rayon, sans GPS) ne sont pas sauvegardées sur le serveur.

> **Astuce Samsung** : les photos Google Photos ont souvent leur EXIF GPS supprimé. Utiliser Samsung **Galerie** ou l'app **Fichiers** pour partager les photos — l'EXIF GPS est préservé.

### Import depuis le modal waypoint

Bouton ＋ dans la section Photos → sélection multiple → toutes liées directement à ce waypoint.

### Import depuis le modal tracé

Bouton ＋ dans la section Photos → sélection multiple → chaque photo est liée au point de tracé GPS le plus proche (matching EXIF), ou au premier point si pas de GPS.

### Stockage

```
data/photos/
├── {dossier_waypoint}/    # photos de waypoints (dossier = node_id)
│   └── {uuid}.jpg
├── trace_{id}/            # photos de tracés
│   └── {uuid}.jpg
└── imports/               # photos importées via toolbar
    └── {uuid}.jpg
```

Les chemins sont enregistrés en base dans la table `photos`, les fichiers servis via `GET /photos/{filepath}` (authentifié).

### Rayon de correspondance

Configurable dans ⚙️ Paramètres → "Rayon de correspondance photo" (défaut : 50 m). Une photo dont le GPS est à plus de N mètres de tout waypoint n'est pas liée automatiquement.

---

## Import GPX

### Depuis OsmAnd

OsmAnd exporte les waypoints avec la balise `<type>` qui contient le nom du dossier/catégorie. TraceMap l'utilise directement comme `node_id` (dossier). Les catégories OsmAnd standard (Favoris, Restaurants, Hébergements, etc.) sont préservées.

### Déduplication waypoints

À l'import GPX waypoints, les points aux coordonnées déjà présentes en base sont silencieusement ignorés. Le message d'import indique `X importé(s), Y ignoré(s)`.

---

## Paramètres

Accessibles via ⚙️ dans la toolbar :

| Paramètre | Description |
|---|---|
| Rollover automatique | Crée automatiquement un nouveau tracé chaque jour à minuit |
| Rayon de correspondance photo | Distance max (en mètres) pour lier automatiquement une photo à un waypoint par GPS EXIF |
| Dossiers prédéfinis | Liste des catégories disponibles dans le modal d'édition waypoint |
| URL Traccar Client | URL à saisir dans l'app Traccar Client (bouton Copier) |

Les paramètres sont stockés en base SQLite (table `settings`) et persistent entre les redémarrages.

---

## Structure des fichiers

```
tracemap/
├── server.js              # Serveur Express + MQTT + SQLite
├── config.local.js        # Configuration locale (gitignored)
├── config.example.js      # Template de configuration
├── package.json
├── nginx.conf             # Config Nginx de référence
├── meshtastic-tracker.service  # Unité systemd (non utilisé avec PM2)
├── public/
│   └── admin.html         # Interface admin (carte + sidebar + modals)
├── data/
│   ├── positions.db       # Base SQLite
│   └── photos/            # Fichiers photos uploadés
└── dev/
    ├── ARCHITECTURE.md    # Architecture technique détaillée
    ├── API.md             # Documentation API REST
    ├── FEATURES.md        # Backlog et état des fonctionnalités
    └── CHANGELOG.md       # Historique des changements
```

### Base de données SQLite

**Table `positions`** — tous les points GPS et waypoints :
| Colonne | Description |
|---|---|
| `id` | Clé primaire |
| `latitude`, `longitude`, `altitude` | Coordonnées |
| `timestamp` | Unix timestamp |
| `source` | `meshtastic`, `phone_gps`, `gpx_import`, `gpx_waypoint` |
| `node_id` | ID appareil Meshtastic ou dossier waypoint |
| `node_name` | Nom affiché |
| `battery` | Niveau batterie (%) |
| `trace_id` | FK → `traces` (NULL pour les waypoints) |
| `description` | Description HTML riche (Quill) |

**Table `traces`** — tracés :
| Colonne | Description |
|---|---|
| `id` | Clé primaire |
| `name` | Nom du tracé |
| `color` | Couleur hex |
| `description` | Description HTML riche |
| `start_time`, `end_time` | Plage temporelle |
| `active` | Tracé actif (reçoit les nouveaux points) |

**Table `photos`** — photos liées aux positions :
| Colonne | Description |
|---|---|
| `id` | Clé primaire |
| `position_id` | FK → `positions` |
| `filepath` | Chemin relatif dans `data/photos/` |
| `original_name` | Nom de fichier original |
| `created_at` | Unix timestamp |

**Table `settings`** — paires clé/valeur de configuration.

---

## Dépannage

### PM2 — relancer après modification serveur

```bash
pm2 restart tracemap
pm2 logs tracemap --lines 50
```

### Aucune position Meshtastic reçue

1. Vérifier que l'uplink MQTT est activé sur le canal de l'appareil
2. Vérifier `channelKey` dans `config.local.js` (copier la clé exacte depuis l'app Meshtastic)
3. Vérifier que le node_id de l'appareil est dans `allowedNodes` (ou vider le tableau pour tout accepter)
4. Regarder les logs PM2 : `pm2 logs tracemap`

### Traccar Client ne se connecte pas

1. Vérifier que l'URL saisie dans Traccar Client correspond exactement à l'URL affichée dans ⚙️ Paramètres (inclut le `secretPath`)
2. Vérifier que Nginx accepte les requêtes POST sur cet endpoint
3. Vérifier les logs PM2 : le serveur logge chaque réception Traccar avec `[Traccar]`

### Photos EXIF non reconnues

- Les photos partagées depuis **Google Photos** ont leur EXIF GPS supprimé par Google. Utiliser à la place l'app **Galerie Samsung** ou l'app **Fichiers** du téléphone pour partager les originaux.
- Vérifier le rayon configuré dans ⚙️ (augmenter si les photos sont proches mais pas assez)

### Upload photos échoue (413 Request Entity Too Large)

Ajouter dans la config Nginx :
```nginx
client_max_body_size 50M;
```
Puis `sudo systemctl reload nginx`.

### Waypoints supprimés avec le tracé

Les waypoints (`source = 'gpx_waypoint'`) ont `trace_id = NULL` et sont exclus des suppressions de tracé. Si des waypoints disparaissent, vérifier qu'ils ont bien `trace_id IS NULL` en base.
