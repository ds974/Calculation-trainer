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
│   └── api/index.php           # Front controller (créé à l'étape des API)
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
