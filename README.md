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

- Login : `admin` · E-mail : `admin@fake.fr` · Rôle : `admin`.
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

> **Étape suivante** : le frontend ne possède pas encore d'interface de connexion.
> Le module `guest-history.js` est prêt ; il restera à :
>  - créer l'interface de connexion/inscription (login) ;
>  - appeler `GuestHistoryV12.setSession(...)` après connexion/déconnexion ;
>  - ajouter le bouton « Importer mon historique invité » (avec confirmation) branché
>    sur `GuestHistoryV12.importToAccount(...)`.

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
