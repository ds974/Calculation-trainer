# Mission Calcul Mental — Version 12 (comptes utilisateurs, statistiques, administration)

Application pédagogique de calcul mental (multiplications et additions), 10 questions
par mission, chronomètre et animation de fusée.

La **v12** ajoute une gestion de comptes utilisateurs, un historique des résultats,
des statistiques et une interface d'administration, reposant sur un backend **PHP 8.2+**
et une base **SQLite**, tout en conservant intégralement les fonctionnalités de la **v11**
(mode invité, classements locaux Top 20, paramètres, fusée, etc.).

---

## Architecture (étape 1 — backend PHP + SQLite)

```text
calculation-trainer/
├── public/                     # Racine documentaire (SEULE zone exposée par HTTP)
│   ├── index.html              # Application monopage (jeu v11, SPA)
│   ├── style.css               # Thème spatial, SVG & animations
│   ├── app.js                  # Logique du jeu (chargé après guest-history.js)
│   ├── guest-history.js        # Historique & import invité v12
│   ├── account.js              # Interface compte : connexion, inscription, profil, import
│   └── api/index.php           # Front controller des API (auth + résultats)
├── src/                        # NON accessible par HTTP
│   ├── bootstrap.php           # Constantes de chemins + autoload léger
│   ├── Database.php            # Connexion PDO SQLite (WAL, FK, busy_timeout)
│   ├── Response.php            # Réponses JSON structurées
│   └── UserRepository.php      # Accès table users (hachage Argon2id)
├── storage/                    # NON accessible par HTTP
│   └── calculation-trainer.sqlite
├── scripts/
│   └── initialize.php          # Init base + 1er admin (saisie sécurisée)
├── tests/
│   └── run.php                 # Tests CLI (base temporaire, sans dépendance)
├── .gitignore
└── README.md
```

> Le répertoire `public/` doit être la racine documentaire du serveur Web. Tout ce qui
> se trouve hors de `public/` (`src/`, `storage/`, `scripts/`, `tests/`, `.gitignore`)
> ne doit jamais être servi par HTTP.

---

## Prérequis

- **PHP 8.2 minimum** (recommandé : 8.3/8.4 stable).
- Extensions : `pdo_sqlite`, `sqlite3`, algorithme **Argon2id** (`PASSWORD_ARGON2ID`),
  `session`, `json`, `date`. Ces extensions sont incluses par défaut dans le binaire PHP
  standard (macOS via Homebrew et hébergeurs PHP classiques).
- PHP doit pouvoir écrire dans `storage/`.

### Vérifier les prérequis

```bash
php -v
php -m | grep -iE 'pdo_sqlite|sqlite3|sodium|session|json|date'
php -r 'var_dump(in_array(PASSWORD_ARGON2ID, password_algos(), true));'
# doit afficher : bool(true)
```

---

## Initialisation de la base et du premier administrateur

Crée le schéma SQLite (tables `users`, `results`, index) et le compte administrateur
initial si absent. Le mot de passe est **saisi interactivement** (masqué), jamais codé
en dur ni stocké en clair.

```bash
php scripts/initialize.php
```

- Login : `admin` · Rôle : `admin`.
- Le mot de passe saisi doit comporter **au moins 10 caractères**.
- Le script **refuse** de recréer ou d'écraser un administrateur déjà existant.
- Si le mode **WAL** ne peut pas être activé, le script le **signale explicitement**
  (sans masquer le problème) tout en continuant.

---

## Tests

```bash
php tests/run.php
```

Les tests s'exécutent sur une **base SQLite temporaire** (sous `/tmp`) et ne touchent
pas à la base de production. Ils vérifient : PRAGMA (FK, busy_timeout, WAL), création du
schéma, unicité des logins (insensible à la casse), hachage/vérification Argon2id, et
refus de recréer un administrateur existant. Un test n'est déclaré **réussi** que s'il a
été réellement exécuté sans erreur.

---

## Démarrage local (serveur de développement)

```bash
php -S localhost:8000 -t public
```

La racine documentaire est `public/` ; l'application est ensuite accessible sur
`http://localhost:8000/`.

---

## Sécurité — durcissement appliqué et prérequis d'environnement

### Protections applicatives (présentes et vérifiées par les tests)

- **Session sécurisée** : cookie `HttpOnly`, `SameSite=Lax`, `Secure` si HTTPS, nom dédié,
  régénération de l'identifiant après connexion (`session_regenerate_id`).
- **CSRF** : jeton unique par session, obligatoire pour toute opération POST.
- **Authentification** : Argon2id, messages génériques, comptes isolés (chaque utilisateur
  n'accède qu'à ses propres données), limitation des tentatives de connexion (anti brute-force).
- **Injections SQL** : 100 % requêtes préparées PDO (aucune concaténation).
- **XSS** : aucune donnée utilisateur injectée en HTML sans échappement ; en-tête
  `Content-Security-Policy: default-src 'self'` (script/style/connect auto-hébergés uniquement).
- **En-têtes de sécurité** : `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`,
  `Referrer-Policy: no-referrer`, `Cache-Control: no-store`, `Permissions-Policy`.
- **Exposition** : `src/`, `storage/`, `scripts/` et `tests/` sont hors racine documentaire.

### Prérequis de configuration (php.ini / MAMP) — à appliquer côté environnement

Certaines directives du moteur de session PHP sont figées au démarrage du module et ne
peuvent pas être modifiées par le code applicatif (un `ini_set()` est un no-op). Elles
doivent être verrouillées dans le `php.ini` utilisé (MAMP) :

```ini
; Anti-fixation de session : refuse les identifiants de session non initialisés.
session.use_strict_mode = 1
; L'identifiant de session ne transite jamais par l'URL.
session.use_only_cookies = 1
; Garde le handler natif : ne JAMAIS basculer session.serialize_handler.
session.serialize_handler = php
; Désactive le suivi de progression des téléversements dans les sessions
; (réduit la surface CVE-2026-109618 / CVE-2026-109619).
session.upload_progress.enabled = 0
```

> Les en-têtes de sécurité (dont la CSP), posés par `src/Security.php` sur les réponses
> API, ne couvrent **pas** la page statique `index.html` servie par Apache. Pour durcir
> aussi la SPA, un `public/.htaccess` est fourni (utile si `AllowOverride` est activé) ;
> sinon, ajoutez les mêmes en-têtes au niveau du vhost. En mode développement
> (`php -S localhost:8000 -t public`), seules les réponses API portent ces en-têtes.

### Vulnérabilités du moteur PHP (nécessitent une mise à jour de PHP)

Les CVEs **CVE-2026-109618**, **CVE-2026-109619** et **CVE-2026-115560** concernent le
moteur PHP lui-même (PHP < 8.5.12). Elles ne peuvent pas être entièrement corrigées par du
code applicatif. Le code actuel **n'aggrave pas** la situation : il ne reconfigure jamais
`session.serialize_handler`, n'appelle aucun `unserialize()` sur des données non fiables et
ne gère pas de téléversements. **La mise à jour du serveur PHP vers 8.5.12 (ou ultérieur)
reste une exigence distincte avant toute exposition publique**, dans l'esprit de l'étape 5.

---

## Étape 3 — Résultats, historique et mode invité

### Enregistrement des parties (utilisateurs connectés)

- Table `results` étendue : colonne `guest_id` (nullable) + index UNIQUE partiel
  `(user_id, guest_id)` afin de garantir l'**idempotence** de l'import invité
  (un même `guest_id` ne peut exister qu'une fois par utilisateur). Migration
  automatique et idempotente à la connexion de la base.
- `src/ResultRepository.php` : accès PDO préparé à la table `results`.
- `src/ResultService.php` : logique métier — `save()`, `history()`, `importGuest()`.
  Validation côté serveur (mode, score sur 10, horodatage UTC), transaction SQLite
  pour l'import, refus des données malformées sans écriture partielle.
- Nouvelles routes API (toutes soumises à session + CSRF pour les POST) :
  - `result/save`    (POST) : enregistre une partie terminée (mode, score, played_at).
  - `result/history` (GET)  : historique de l'utilisateur connecté.
  - `result/import`  (POST) : import volontaire et idempotent de l'historique invité.
- **Limite de confiance** : le score est transmis par le navigateur ; il ne peut pas
  être vérifié côté serveur (pas de preuve anti-triche). Ces valeurs alimentent
  l'historique personnel, mais ne doivent jamais constituer une preuve formelle.

### Statistiques personnelles (étape 6 — backend)

- `src/StatsService.php` : calcul des agrégats par mode (`multiplication` | `addition`),
  **uniquement** depuis l'identité de session (`user_id` jamais fourni par le client) :
  - totaux globaux (nombre de parties, score moyen sur 10, meilleur score) ;
  - moyennes sur fenêtres glissantes de **7** et **30 jours** (UTC, indépendantes du fuseau serveur) ;
  - courbe des **30 dernières parties** (par récence, rendue chronologique) ;
  - histogramme des parties par jour sur les **30 derniers jours**, regroupé selon
    le **fuseau Indian/Reunion (UTC+4)** — chaque journée est présente (`games = 0`
    si aucune partie), pour un tracé continu.
- `src/ResultRepository.php` : nouvelles méthodes d'agrégation préparées
  (`totals`, `countSince`, `periodAverage`, `recentScores`, `playedAtValues`).
  Aucune modification du schéma SQLite. Les parties **importées** depuis le mode
  invité résident dans la même table `results` : elles sont donc comptées.
- Nouvelle route API (`GET`, session requise) :
  - `stats?mode=<multiplication|addition>` : renvoie `{ mode, generated_at_utc,
    totals, periods, progression, daily_games }` ; mode inconnu => `400`.

### Interface des statistiques (étape 6B — frontend)

L'écran « Mes statistiques » (`#statsScreen`) est accessible uniquement depuis
l'espace du compte connecté (bouton « Mes statistiques » sur « Mon compte »).
Il consomme **exclusivement** la route `GET stats?mode=...` — aucune donnée
n'est inventée ni transmise par le navigateur (l'utilisateur est identifié par
la session).

- `public/stats.js` expose `window.StatsUI` (`show`, `hide`, `setSessionHandler`) :
  - Sélecteur **Additions / Multiplications** ;
  - cartes : nombre de parties, score moyen global, meilleur score, moyenne des
    **7** et **30 derniers jours** (périodes **glissantes**) ;
  - courbe d'évolution des **30 dernières parties** (axe des scores borné à 10) ;
  - histogramme du nombre de parties **par jour calendaire de La Réunion (UTC+4)**
    sur 30 jours (valeurs entières) ;
  - état **vide** dédié (« aucune partie »), erreurs réseau / serveur avec bouton
    « Réessayer », et gestion des **sessions expirées** : un `401` est relayé à
    `account.js` via `setSessionHandler` (retour automatique à la connexion) ;
  - destruction des instances Chart.js (`chart.destroy()`) à chaque changement de
    mode, rechargement et départ de l'écran (`StatsUI.hide()`, appelé par la
    navigation d'`account.js`).
- `public/account.js` : branche l'écran statistiques dans sa navigation
  (`data-account-nav="stats"`), appelle `StatsUI.show()/hide()` et enregistre le
  gestionnaire de session expirée. Aucune modification des mécanismes
  d'authentification.
- `public/vendor/chart.js/` : **Chart.js v4.6.1** en **build UMD local**,
  distribué sous **licence MIT** (voir `LICENSE.md` et `README.md` dans ce
  dossier pour version, provenance et compatibilité CSP). Chargé en same-origin
  avant `stats.js` ; compatible `style-src 'self'` (aucun `<style>` inline ni
  attribut `style=""` injecté — rendu sur `<canvas>`).
- Accessibilité : alternative textuelle (`sr-only`) pour chaque graphique, libellés
  `aria-label` sur les `canvas`, sélecteur en `fieldset`/boutons `aria-pressed`.
- Responsive : grille de cartes et hauteurs de graphiques adaptées aux petits écrans.

### Mode invité et historique local

- `public/guest-history.js` : module autonome, exposé en `window.MissionGuestHistory`.
  - Espace `localStorage` DÉDIÉ v12 : `missionCalculMental.history.v12`
    (trace d'imports réussis : `missionCalculMental.history.v12.imported`).
  - Les clés v10/v11 existantes ne sont **ni lues, ni modifiées, ni supprimées**.
  - En invité : chaque partie terminée est enregistrée localement (avec un
    `guest_id` stable pour un import idempotent ultérieur).
  - En connecté (`setSession()` non null) : la partie est envoyée au serveur,
    jamais stockée localement (pas de mélange invité / compte).
- Intégration dans `public/app.js` : `finalizeMission()` appelle `GuestHistoryV12.record()`
  à la fin de chaque partie terminée.

### Import invité

- `GuestHistoryV12.importToAccount(confirmFn)` : import volontaire, avec
  **confirmation explicite**, envoi au serveur, et conservation d'une trace locale
  des éléments importés (pas de réimport). Aucune donnée locale n'est supprimée en
  cas d'échec. Le serveur refuse les doublons (colonne unique `guest_id`).
- La trace d'imports est **scopée par compte** (`missionCalculMental.history.v12.imported.<id>`),
  ce qui permet d'utiliser plusieurs comptes sur un même navigateur sans jamais
  ré-importer, ni mélanger les états.

### Interface de comptes (étape 4)

`public/account.js` (chargé après `guest-history.js` et `app.js`) expose
`window.AccountUI` :

- **Session côté serveur** : aucune logique d'authentification parallèle ; on
  réutilise les routes PHP existantes (`auth/csrf`, `auth/login`, `auth/register`,
  `auth/logout`, `profile`, `profile/password`, `result/import`).
- **Cookies sécurisés** gérés par PHP (`SameSite=Lax` + `HttpOnly`). Aucun mot de
  passe ni cookie de session n'est stocké dans `localStorage` ; seul l'utilisateur
  public et le jeton CSRF sont gardés **en mémoire** (jamais réhydratés au rechargement).
- Au chargement / à l'actualisation, on récupère le jeton CSRF puis le profil, et on
  branche `GuestHistoryV12.setSession({ token, user })` (ou `null`) selon l'état.
- **Connexion, inscription, profil (mot de passe)** avec messages d'erreur
  explicites (contraintes : identifiant 3-40 alphanumériques/`_`, mot de passe ≥ 10).
  Les comptes reposent uniquement sur un **identifiant unique** et un **mot de passe
  de 10 caractères minimum** ; aucune adresse e-mail n'est gérée.
- **Import volontaire** des parties invitées depuis « Mon compte », avec
  **confirmation explicite** (`confirm()`), affichage du nombre importé / déjà
  présent (`doublon`), et conservation des données locales en cas d'échec.
- L'accès au compte est **désactivé pendant une partie en cours** (un message
  l'indique) et la session expirée est détectée proprement (401 → retour à la
  connexion sans perte de données).

---

## Sécurité applicative (principes appliqués côté PHP)

- Mots de passe hachés avec `password_hash(..., PASSWORD_ARGON2ID)` ; `password_verify`
  pour la vérification. Jamais stockés en clair.
- Requêtes SQL **préparées** (PDO) — aucune concaténation directe.
- Sessions PHP avec cookies `HttpOnly`, `SameSite=Lax`, `Secure` en HTTPS ;
  `session_regenerate_id()` après connexion ; destruction de session à la déconnexion.
- Protection **CSRF** sur toute opération modifiant des données.
- Limitation des tentatives de connexion.
- Contrôle des autorisations **côté serveur** (rôle `admin`) pour toute opération
  d'administration.
- Secrets jamais inclus dans le code source ni dans les réponses JSON.
