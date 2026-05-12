# Changelog — TraceMap

## [En cours]

### Ajouté
- **Diaporama de photos** : vue plein écran de toutes les photos des points/tracés visibles selon les filtres actifs
  - Bouton `🎞️` dans la toolbar
  - Navigation molette + flèches clavier + boutons ‹ ›
  - Compteur overlay haut gauche, légende (nom waypoint, dossier, date) en overlay bas
  - Chargement progressif avec spinner — le compteur et la légende ne changent qu'après chargement de l'image (style streaming vidéo)
  - Préchargement des photos voisines (±2) en arrière-plan
  - Support plein écran (F11 + bouton ⛶)
  - Route `GET /api/photos/for-positions?ids=...` pour récupérer les photos en lot
- **Plein écran carousel waypoint** : bouton ⛶ + F11, image `object-fit:contain` pour respecter les proportions
- **Authentification par tokens persistants** : remplace la sécurité par URL secrète
  - URL admin simplifiée : `https://mesh.jscheunersarl.ch/admin` (plus de chemin secret)
  - Table `tokens` en DB : token 64 chars hex, label, date de création, sans expiration
  - `isAuthenticated()` vérifie uniquement les tokens DB (sessions mémoire supprimées)
  - Gestion des tokens dans ⚙️ Paramètres : créer (label + QR), révoquer
  - QR code par token → URL `https://.../admin?token=XXX` → sauvegarde automatique dans localStorage + nettoyage URL
  - Token Traccar dédié (`traccarToken` dans settings) généré au démarrage, indépendant des tokens admin
  - Traccar URL mise à jour avec le token dédié dans la section Paramètres
- **Regroupement des photos hors-rayon par proximité** : lors de l'import bulk `match_waypoints`, les photos `no_match` dans le rayon sont regroupées en un seul waypoint proposé. Affichage "📦 N photos groupées" côté client, création d'un waypoint + liaison automatique de toutes les photos du groupe.
- **Filtre date appliqué aux waypoints sur la carte** : `getFilteredPositions()` filtre désormais les waypoints GPX par timestamp quand une période est active (cohérence carte ↔ sidebar)
- **Lier les photos sans GPS à un waypoint existant** (`linkSelectedNoGpsPhotos`) : section dédiée dans le rapport d'import bulk, sélection du waypoint cible dans une liste déroulante, liaison par `POST /api/photos/create-waypoint` avec `position_id`
- **Traccar Client** : remplace le phone-tracker navigateur
  - Endpoint `GET /api/traccar?id=&lat=&lon=&timestamp=&altitude=&speed=&accuracy=&batt=`
  - Lie les positions au tracé actif, source `phone_gps`
  - URL de configuration affichée + bouton Copier dans ⚙️ Paramètres
  - Suppression de `phone-tracker.html`
- **Sélecteur de période** en date range picker (Flatpickr) : un calendrier, premier clic = date début, deuxième clic = date fin — remplace le select 6h/24h/…
  - Validation : date de fin toujours ≥ date de début
  - Désactivé automatiquement quand un tracé est sélectionné
  - Serveur : nouvelle query `?from=TIMESTAMP&to=TIMESTAMP`
- Champ **Description** riche sur les waypoints (Quill.js) : gras, italique, souligné, couleur de texte, police, taille
  - Stocké en HTML dans la colonne `description` de la table `positions`
  - Affiché (rendu HTML) dans la popup du waypoint sur la carte
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
- Date de création dans l'infobulle des waypoints
- Bouton suppression dossier waypoints complet (avec confirmation mot de passe)
- **Photos sur les waypoints** : upload, stockage fichier (`data/photos/{dossier}/`), table `photos` en DB
  - Section photos dans le modal d'édition (miniatures + ajouter + supprimer)
  - Import photo avec extraction GPS EXIF — liaison automatique si waypoint dans le rayon, sinon picker manuel
  - Bouton "📷 Photo" dans le toolbar
  - Paramètre `photoMatchRadius` (défaut 50 m) dans ⚙️ Paramètres
  - Timeout 8 s sur l'extraction EXIF pour éviter les blocages
- Bouton "📍 Utiliser ma position actuelle" dans le picker photo quand aucun GPS n'est trouvé (contournement Google Photos qui supprime l'EXIF) — pré-sélectionne le waypoint le plus proche et colorise selon la distance
- Packages : `exifr`, `multer`

### Corrigé
- **Spinner diagonal** dans le carousel waypoint et le diaporama : conflit `transform:translate` (centrage) + `animation:spin` (rotate). Résolu par un div externe pour le translate et un div interne pour la rotation.
- **QR modal masqué** derrière la modale Paramètres : z-index porté à 9200.
- **Token non retourné** par `GET /api/tokens` → `SELECT` étendu, `_tokenCache` populé dans `loadTokens()`.

### Modifié
- Liste déroulante "Dossier / Catégorie" dans le modal d'édition waypoint (catégories existantes + "✏️ Autre dossier…")
- Section "Dossiers prédéfinis" dans ⚙️ Settings : ajouter/supprimer des dossiers disponibles dans la liste
- Badge 📷 sur l'icône losange des waypoints ayant des photos
- Bouton "📷 Photos" dans le popup waypoint → carrousel plein écran (‹ ›, compteur, nom fichier)
- Route `GET /api/photos/summary` — liste des position_id avec photos
- Bouton "↓ Date / ↑ Date" dans le header sidebar — tri croissant/décroissant pour les tracés (par start_time) et les waypoints (par timestamp, dossiers et items)
- Interface responsive mobile (breakpoint 680px) : sidebar overlay avec backdrop, toolbar scroll horizontal, header compact, filter bar scroll, modals adaptés
- Bouton info (ⓘ) fusionné dans le crayon (✏️) → ouvre modal détails
- `GET /api/positions` : inclut toujours les `gpx_waypoint` quelle que soit la fenêtre temporelle
- Process PM2 renommé `meshtastic-tracker` → `tracemap`
- Import GPX waypoints : déduplication par coordonnées (index unique `latitude, longitude, source`) — les points existants sont ignorés, les nouveaux ajoutés. Message d'import indique `X importé(s), Y ignoré(s)`.

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
