# Fonctionnalités — TraceMap

## ✅ Implémenté

### Suivi GPS
- [x] Réception positions Meshtastic via MQTT (déchiffrement AES-256-CTR)
- [x] Suivi téléphone via app web (QR code, session 24h)
- [x] Import GPX tracés (`<trkpt>`) en base de données
- [x] Import GPX waypoints (`<wpt>`) avec dossiers OsmAnd (`<type>`)
- [x] Calque GPX temporaire (overlay, non persisté) avec tracks + POI

### Tracés
- [x] Création/suppression/renommage de tracés
- [x] Couleur par tracé
- [x] Description libre
- [x] Modification des dates début/fin
- [x] Statistiques : distance, dénivelé +/-, plage altitude
- [x] Rollover automatique à minuit (désactivable dans paramètres)
- [x] Protection par mot de passe pour la suppression

### Waypoints / POI
- [x] Edition et suppression de waypoints individuels
- [x] Suppression d'un dossier complet (avec confirmation mot de passe)
- [x] Photos sur les waypoints : ajout depuis le modal d'édition
- [x] Import photo avec extraction GPS EXIF — liaison automatique si match dans le rayon configuré, sinon picker manuel
- [x] Rayon de correspondance photo configurable dans ⚙️ (défaut 50 m)

### Interface admin
- [x] Sidebar avec onglets Tracés / Points GPS
- [x] Vue Points GPS groupée par dossier/catégorie, avec collapse
- [x] Toolbar en 3 zones (gestion tracés / période / outils)
- [x] Filter bar : chips par source + dossiers POI + appareils GPS
- [x] Rendu distinct losanges colorés pour waypoints (hors polyline)
- [x] Auto-refresh (30s)
- [x] Toggle trajet (polyline)
- [x] Centrage carte sur dernière position

### Système
- [x] Credentials extraits dans `config.local.js` (gitignore)
- [x] Base SQLite persistante avec `keepDays = 36500`
- [x] Sessions admin avec expiration 24h
- [x] PM2 process `tracemap`

## 🔲 Backlog / Idées

### Court terme
- [ ] Export GPX d'un tracé sélectionné
- [ ] Recherche dans la liste des waypoints
- [ ] Tri des tracés (par date, par nom)
- [ ] Indicateur temps réel "en ligne" par appareil Meshtastic

### Moyen terme
- [ ] Vue publique en lecture seule (partage de lien)
- [ ] Notifications push quand un appareil envoie une position
- [ ] Graphique altitude/temps sur un tracé sélectionné
- [ ] Fusion de plusieurs tracés en un seul

### Long terme
- [ ] Multi-utilisateur avec rôles (admin / lecteur)
- [ ] Support WebSocket pour mise à jour carte en temps réel
- [ ] Import depuis API OsmAnd (sync automatique)
