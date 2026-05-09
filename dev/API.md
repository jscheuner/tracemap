# API REST — TraceMap

Toutes les routes sont préfixées par `/{secretPath}`. Les routes protégées nécessitent le header `x-session-token` ou le paramètre `?token=`.

## Auth

### POST `/login`
```json
{ "password": "..." }
→ { "success": true, "token": "hex64chars" }
```

---

## Positions

### GET `/api/positions`
Paramètres query :
- `trace_id` — filtre par tracé (ignore `hours`)
- `hours` — fenêtre temporelle (défaut 24). Les `gpx_waypoint` sont toujours inclus.
- `node_id` — filtre par appareil

### POST `/api/positions/ingest`
```json
{
  "points": [{ "latitude", "longitude", "altitude", "speed", "battery", "timestamp", "device_id", "device_name" }],
  "source": "phone_gps|gpx_import|gpx_waypoint",
  "trace_id": 1
}
→ { "success": true, "inserted": 42, "skipped": 5 }
```
Pour `source = "gpx_waypoint"` : déduplication par `(latitude, longitude)` — les points déjà existants aux mêmes coordonnées sont ignorés (`skipped`).

### PUT `/api/positions/:id`
Modifier nom/catégorie d'un waypoint :
```json
{ "node_name": "Nouveau nom", "node_id": "Nouveau dossier" }
```

### DELETE `/api/positions/:id`
Supprimer un point GPS individuel.

---

## Tracés

### GET `/api/traces`
Retourne tous les tracés avec `point_count`.

### POST `/api/traces`
```json
{ "name": "Rando lac" }
```

### PUT `/api/traces/:id`
```json
{ "name", "color", "description", "start_time", "end_time" }
```

### PUT `/api/traces/:id/end`
Ferme le tracé (set `end_time = now`).

### DELETE `/api/traces/:id`
Supprime le tracé et tous ses points.

---

## Paramètres

### GET `/api/settings`
```json
{ "autoRollover": "true" }
```

### PUT `/api/settings`
```json
{ "autoRollover": true }
```

---

## Photos

Les photos sont stockées dans `data/photos/{dossier}/{id_wpt}_{timestamp}.ext` (hors DB).

### POST `/api/photos/upload` (multipart `photo`)
- Si `position_id` fourni : sauvegarde directe, retourne `{ id, filepath, gps }`
- Sans `position_id` : sauvegarde en temp, extrait GPS EXIF, retourne candidats :
```json
{ "tempId": "abc123", "originalName": "img.jpg", "gps": { "lat": 46.1, "lon": 7.2 } | null,
  "candidates": [{ "id": 42, "node_name": "Bivouac Col", "node_id": "Bivouacs", "dist": 23 }] }
```
Query param optionnel : `?radius=50` (mètres, défaut 50)

### POST `/api/photos/confirm`
Lie un fichier temp à un waypoint :
```json
{ "tempId": "abc123", "position_id": 42, "original_name": "img.jpg" }
→ { "id": 7, "filepath": "Bivouacs/42_1746789012.jpg" }
```

### GET `/api/photos?position_id=42`
Liste les photos d'un waypoint.

### DELETE `/api/photos/:id`
Supprime la photo (fichier + DB).

### GET `/photos/{filepath}`
Sert le fichier photo (authentifié, token en header ou `?token=`).

---

## Divers

### GET `/api/last` — dernière position enregistrée
### GET `/api/stats` — statistiques globales (total points, nodes, dates)
