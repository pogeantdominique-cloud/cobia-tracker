# COBIA 3 — GPS Tracker · Fiche technique

## Vue d'ensemble
Application de suivi GPS en temps réel pour le cargo COBIA 3 (Polynésie française).
- **Script bord** : `index.js` — reçoit les trames NMEA de TimeZero et envoie à Supabase
- **Application web** : `cobia3-carte.html` — carte temps réel PWA installable sur téléphone
- **Page installation** : `install.html` — QR code + instructions iOS/Android
- **Déploiement** : GitHub Pages → `https://suivi.cobia.pf/cobia3-carte.html`
- **Dépôt GitHub** : `pogeantdominique-cloud/cobia-tracker`

---

## Architecture

```
TimeZero (PC bord) → TCP port 5556
    ↓ trames NMEA (RMC + RMB)
index.js (Node.js)
    ↓ HTTPS POST
Supabase (ysdllglxzvgwoooeztlg.supabase.co)
    ├── table: position  (lat, lon, sog, cog, ts, destination, dist_nm, eta)
    └── table: waypoint  (nom, lat, lon, distance_nm, vitesse_kn, eta)
    ↓ lecture toutes les 10-15s
cobia3-carte.html (GitHub Pages)
```

---

## Fichiers importants

### `index.js` (PC du bord uniquement — NE PAS publier sur GitHub)
- Connexion TCP vers TimeZero sur `127.0.0.1:5556`
- Parse les trames RMC (position) et RMB (waypoint destination)
- Envoie vers Supabase toutes les 10 secondes
- Utilise la **clé service_role** (secrète) — ne jamais mettre dans le HTML
- Écrit dans les tables `position` ET `waypoint`

### `cobia3-carte.html`
- Carte Leaflet avec fond satellite CartoDB/Esri
- Animations vent (ECMWF) et houle (best_match) via open-meteo
- Particules masquées automatiquement au zoom ≥ 13 (résolution météo insuffisante)
- Panel chartplotter : vitesse, cap, lat, lon, WPT, distance, ETA
- Ligne verte pointillée du bateau vers le waypoint actif
- PWA : installable sur iPhone (Safari) et Android (Chrome)
- Données météo rafraîchies toutes les heures

### `install.html`
- Page avec QR code pointant vers `suivi.cobia.pf/cobia3-carte.html`
- Instructions d'installation iOS et Android

---

## Supabase

- **URL** : `https://ysdllglxzvgwoooeztlg.supabase.co`
- **Clé publique (HTML)** : `sb_publishable_t3LNsavHm0kvP3Si-nK-0g_QvP2tFH-`
- **Clé secrète (index.js uniquement)** : dans `index.js` ligne `SUPABASE_KEY`
- **RLS** : SELECT public autorisé, INSERT uniquement via clé service_role

### Table `position`
| Colonne | Type | Description |
|---------|------|-------------|
| lat, lon | float8 | Position bateau |
| sog | float8 | Vitesse sol (km/h) |
| cog | float8 | Cap (degrés) |
| ts | timestamptz | Timestamp GPS |
| destination | text | Nom waypoint actif |
| dist_nm | float8 | Distance au waypoint (NM) |
| eta | timestamptz | Heure d'arrivée estimée |

### Table `waypoint`
| Colonne | Type | Description |
|---------|------|-------------|
| nom | text | Nom du waypoint |
| lat, lon | float8 | Coordonnées destination |
| distance_nm | float8 | Distance (NM) |
| vitesse_kn | float8 | Vitesse de fermeture (nœuds) |
| eta | timestamptz | ETA |

---

## Déploiement GitHub Pages

Le dépôt local est dans `C:\Users\DOMINIQUE\Downloads\cobia-tracker\`

```bash
# Après modification de cobia3-carte.html ou install.html :
cp cobia3-carte.html ../cobia-tracker/
cd ../cobia-tracker
git add .
git commit -m "Description du changement"
git push origin main
```

Le site se met à jour en ~1 minute sur `suivi.cobia.pf`.

---

## PC du bord (Cobia 3)

- **Utilisateur** : `Cobia 3`
- **Dossier** : `C:\Users\Cobia 3\gps-tracker\`
- **Lancement** : `node index.js` ou `pm2 restart all`
- **TimeZero** : émet les trames NMEA sur TCP `127.0.0.1:5556`

### Mise à jour de index.js sur le bord
1. Copier `index.js` depuis `C:\Users\DOMINIQUE\Downloads\gps-tracker-fixed\` sur clé USB
2. Coller dans `C:\Users\Cobia 3\gps-tracker\`
3. Redémarrer : `pm2 restart all` ou fermer/relancer `node index.js`

---

## Ce qu'il NE FAUT PAS modifier sans comprendre

- **Ne pas changer** la clé Supabase dans `cobia3-carte.html` — elle doit rester la clé publique
- **Ne pas publier** `index.js` sur GitHub (il contient la clé secrète)
- **Ne pas toucher** aux policies RLS Supabase sans reconfigurer `index.js`
- **Ne pas modifier** les noms de colonnes Supabase sans adapter les deux fichiers

---

## Modèles météo utilisés
- **Vent** : ECMWF IFS 0.25° (même modèle que Windy)
- **Houle animation** : best_match (open-meteo)
- **Houle panel** : best_match marine API
- Données rafraîchies toutes les heures, grille de 169 points autour du bateau
