// Copier ce fichier en config.local.js et remplir les valeurs
module.exports = {
  channelKey: 'BASE64_KEY_ICI',        // Clé AES-256 du canal Meshtastic (base64)
  channelName: 'NomDuCanal',           // Nom du canal Meshtastic
  allowedNodes: ['!xxxxxxxx'],         // IDs des nœuds autorisés (ex: !a1cd437c)
  secretPath: 'mon-chemin-secret',     // Préfixe URL d'accès (ex: vacances2025abc)
  webPassword: 'motdepasse',           // Mot de passe interface admin
  port: 3081,                          // Port HTTP du serveur
};
