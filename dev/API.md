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
→ { "success": true, "inserted": 42 }
```

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

## Divers

### GET `/api/last` — dernière position enregistrée
### GET `/api/stats` — statistiques globales (total points, nodes, dates)
