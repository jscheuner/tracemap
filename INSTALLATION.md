# 📍 Guide d'installation — Meshtastic GPS Tracker

## Structure du projet
```
meshtastic-tracker/
├── server.js                    # Serveur Node.js principal
├── package.json                 # Dépendances
├── nginx.conf                   # Config Nginx (référence)
├── meshtastic-tracker.service   # Service systemd
├── public/
│   └── index.html               # Page carte OpenStreetMap
└── data/
    └── positions.db             # Base SQLite (créée automatiquement)
```

---

## Étape 1 — Configurer server.js

Ouvre `server.js` et modifie la section CONFIG :

```javascript
channelKey: 'REMPLACE_PAR_TA_CLE_BASE64=',
```
→ Trouve ta clé dans l'app Meshtastic → Canaux → Famille → icône clé

```javascript
allowedNodes: ['!LILYGO_ID', '!HELTEC_ID'],
```
→ Trouve les IDs dans l'app → Nœuds → ton appareil → ID (ex: !a1b2c3d4)

```javascript
secretPath: 'vacances2025xK9mP3qR7vjT2nBw',
```
→ Génère un token aléatoire : node -e "console.log(require('crypto').randomBytes(16).toString('hex'))"

```javascript
webPassword: 'MotDePasseFamille2025!',
```
→ Choisis un mot de passe pour ta famille

---

## Étape 2 — Déployer sur le serveur

```bash
# Copier les fichiers
scp -r meshtastic-tracker/ user@tonserveur:/var/www/

# Se connecter en SSH
ssh user@tonserveur

# Aller dans le dossier
cd /var/www/meshtastic-tracker

# Installer les dépendances
npm install

# Tester
node server.js
# → Tu devrais voir: 🚀 Serveur démarré sur le port 3000
```

---

## Étape 3 — Configurer Nginx

```bash
# Copier la config
sudo cp nginx.conf /etc/nginx/sites-available/mesh.jscheunersarl.ch

# Activer le site
sudo ln -s /etc/nginx/sites-available/mesh.jscheunersarl.ch /etc/nginx/sites-enabled/

# Tester la config
sudo nginx -t

# Recharger Nginx
sudo systemctl reload nginx
```

### DNS
Ajoute un enregistrement DNS :
```
mesh.jscheunersarl.ch  →  A  →  IP_DE_TON_SERVEUR
```

---

## Étape 4 — Démarrage automatique avec systemd

```bash
# Modifier le chemin dans le fichier service si nécessaire
sudo cp meshtastic-tracker.service /etc/systemd/system/

# Activer et démarrer
sudo systemctl daemon-reload
sudo systemctl enable meshtastic-tracker
sudo systemctl start meshtastic-tracker

# Vérifier le statut
sudo systemctl status meshtastic-tracker

# Voir les logs
sudo journalctl -u meshtastic-tracker -f
```

---

## Étape 5 — Configurer le LilyGo T-Deck

Dans l'app Meshtastic connectée au LilyGo :

1. **Canaux → Famille** → activer **"Uplink enabled"** ✅
2. **Paramètres → Position** → activer GPS → **"Smart position"** ON
3. **Interval de position** → toutes les 60 secondes (ou selon besoin)
4. S'assurer que MQTT est activé sur l'appareil

---

## Utilisation

### Partager avec la famille
Envoie simplement l'URL + mot de passe :

```
URL: http://mesh.jscheunersarl.ch/vacances2025xK9mP3qR7vjT2nBw
Mot de passe: MotDePasseFamille2025!
```

### Fonctionnalités de la carte
- 🔴 Point rouge = dernière position connue
- 🔵 Points bleus = historique du trajet  
- 〰️ Ligne bleue = trajet complet
- 🔄 Auto-refresh toutes les 30 secondes
- Filtre par période : 6h, 24h, 2j, 7j, 30j

---

## SSL (recommandé)

```bash
# Installer Certbot
sudo apt install certbot python3-certbot-nginx

# Obtenir un certificat
sudo certbot --nginx -d mesh.jscheunersarl.ch

# Renouvellement automatique (déjà configuré par certbot)
```

---

## Dépannage

### Aucune position reçue
1. Vérifier que le LilyGo a le GPS activé et un fix (icône GPS sur l'écran)
2. Vérifier que MQTT uplink est activé sur le canal Famille
3. Vérifier la clé du canal dans CONFIG.channelKey
4. Regarder les logs : `sudo journalctl -u meshtastic-tracker -f`

### Port 3000 déjà utilisé
Changer `port: 3000` dans server.js et mettre à jour nginx.conf

### Base de données corrompue
```bash
rm /var/www/meshtastic-tracker/data/positions.db
sudo systemctl restart meshtastic-tracker
```
