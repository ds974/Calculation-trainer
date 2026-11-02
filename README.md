# Mental Math Mission — Adaptive Arithmetic Training

*Mission Calcul Mental* (original French name) — an open-source, multilingual mental
arithmetic training application with adaptive practice, progress tracking and personalized
learning.

English | [Français](README.fr.md)

---

## Available languages

The application interface is fully translated into **four languages**:

- French
- English
- Spanish
- Simplified Chinese

The language can be changed at any time from a discreet menu at the top of the interface:

- **Visitors** can keep their language preference **locally** (in the browser).
- **Signed-in users** get their language preference **saved in their account**, so it is
  restored on every device/session.
- The pedagogical interfaces (missions, corrections, results), personal statistics, and the
  administration dashboard are fully translated.

> Language selection is the major evolution of **v12.6**. Whenever the language is changed,
> the majority of screens update immediately, without reloading the page. The four translation
> catalogs each contain 357 identical keys, so the coverage is consistent across languages.

---

## Overview

**Mental Math Mission** is a browser-based application designed to help children and learners
practice **mental calculations** — additions and multiplications — through short, timed
missions.

- **Pedagogical goal:** build lasting arithmetic fluency through regular, focused practice.
- **Who it helps:** learners who want to strengthen their tables and addition skills, parents
  and teachers looking for a simple daily practice tool, and anyone who enjoys a quick mental
  math challenge.
- **How it runs:** a single-page application served from a web browser. No app installation,
  no separate frontend build step.

The application does not claim any official scientific or institutional validation; it is a
teaching aid whose effectiveness rests on gradual, personalized practice and feedback.

---

## Key features

- **Addition and multiplication practice**, with independent settings for each operation.
- **Classic, missing-number and mixed questions** (e.g. `? × 6 = 18`), selectable per mission.
- **Configurable multiplication tables and addition ranges.**
- **Timed 10-question missions** with a circular timer.
- **Interactive rocket-building reward** at the end of each mission.
- **Adaptive practice** focused on each learner's difficult operations.
- **Personalized difficulty tracking** per operation and per user.
- **Scores, history and progress statistics**, including charts and per-table difficulty.
- **Optional user accounts** with secure sessions and isolated data.
- **Guest mode** for immediate play without an account.
- **Administrative dashboard** for managing accounts and monitoring activity.
- **Four interface languages** (French, English, Spanish, Simplified Chinese).
- **Responsive interface** adapting to narrow screens, including a touch keypad.

### About adaptive practice

When the option to train on personal difficulties is enabled, up to **40 %** of the questions in
a mission target operations already identified as difficult, while the remaining **60 %** come
from ordinary practice. Everything still respects the configured parameters (selected tables /
ranges, and the Classic, Missing-number or Mixed question types). If no compatible difficulties
exist, the mission simply returns to ordinary questions — a guest behaves exactly like a normal
learner.

---

## How it works

1. **Choose the type of arithmetic** — additions, multiplications, or both.
2. **Configure a mission** — select tables or ranges, the question type, and preferences.
3. **Solve ten timed questions** — gentle pacing with immediate feedback.
4. **Review results and corrections** — a debriefing reveals the right answer inside each
   equation and explains the reasoning.
5. **Track progress and practice difficult operations** — review graphs and statistics, then
   let adaptive practice target your weaker points.

---

## Installation and requirements

### Requirements

- **PHP 8.2 or newer** (8.3/8.4 recommended).
- PHP extensions: `pdo_sqlite`, `sqlite3`, **Argon2id** (`PASSWORD_ARGON2ID`), `session`,
  `json`, `date`. These are enabled by default in the standard PHP binary (macOS via
  Homebrew and on classic PHP hosts).
- PHP must be able to **write to `storage/`** (SQLite database location).
- A local web server or any compatible PHP deployment.

### Verify the requirements

```bash
php -v
php -m | grep -iE 'pdo_sqlite|sqlite3|sodium|session|json|date'
php -r 'var_dump(in_array(PASSWORD_ARGON2ID, password_algos(), true));'
# should print: bool(true)
```

### Initialize the database and the first administrator

```bash
php scripts/initialize.php
```

- Login: `admin` — Role: `admin`.
- The password is **entered interactively** (hidden) and must be **at least 10 characters**.
- The script **refuses** to recreate or overwrite an existing administrator.
- It creates the SQLite schema (tables `users`, `results`, plus difficulty and logging tables)
  and applies the migrations automatically. If the WAL mode cannot be enabled, the script says
  so explicitly while continuing.

### Run locally (development server)

```bash
php -S localhost:8000 -t public
```

The document root is `public/`; the application is then available at
`http://localhost:8000/`.

> The `public/` directory must be the web server's document root. Everything outside it
> (`src/`, `storage/`, `scripts/`, `tests/`) must never be served over HTTP.
---

## User accounts and data

- **Guest mode:** play immediately without an account. Results are stored locally (browser
  storage) and can be imported into an account later.
- **Optional accounts:** register with a unique identifier (3–40 alphanumeric characters and
  underscores) and a password of **at least 10 characters**. No e-mail address is required.
- **Results and difficulty tracking:** when signed in, each mission's results and per-operation
  difficulties are saved to the account and used by adaptive practice and statistics.
- **Language preference:** saved per account and synchronized between the local and the
  account preference (endpoint `profile/language`).
- Passwords are hashed with Argon2id and never stored in plain text; sessions and CSRF
  protection follow good security practices (HTTP-only cookies, same-site policy, per-session
  tokens).

The application aims to follow good security practices, but it does **not** claim formal GDPR or
security certification.

---

## Technical architecture

- **Frontend:** native JavaScript single-page application (no framework), with an SVG/CSS
  space theme.
- **Backend:** PHP, with a JSON API as a front controller (`public/api/index.php`).
- **Database:** SQLite, via PDO with prepared statements.
- **Internationalization:** per-language JSON catalogs (`public/i18n/`) driven by a small
  `i18n.js` engine — the only source of translated text.

```
public/     document root (the only HTTP-exposed area)
  index.html, style.css, app.js, admin.js, account.js, stats.js, i18n.js, i18n/
  api/index.php
src/        backend (not exposed)
storage/    SQLite database (not exposed)
scripts/    CLI tools (e.g. initialize.php, not exposed)
tests/      test suites (not exposed)
```

---

## Testing

The tests run against a **temporary SQLite database** (under `/tmp`) and never touch the
production database.

### PHP (backend + HTTP)

```bash
php tests/run.php
php tests/http_test.php
php tests/difficulty_melange_repro.php
```

`php tests/run.php` covers the schema, authentication (Argon2id), login unicity, difficulty
migration and the "last active administrator" protection. `php tests/http_test.php` exercises
the full JSON HTTP flow (embedded server on a free port, sessions, CSRF, results, admin) and
the `profile/language` preference endpoint.

### JavaScript (frontend)

The frontend tests use **JavaScript for Automation (JXA)** — the built-in AppleScript/JavaScript
bridge on macOS **without Node.js**:

```bash
osascript -l JavaScript tests/js_i18n_test.js
osascript -l JavaScript tests/js_i18n_app_test.js
osascript -l JavaScript tests/js_i18n_account_test.js
osascript -l JavaScript tests/js_i18n_stats_test.js
osascript -l JavaScript tests/js_i18n_admin_test.js
osascript -l JavaScript tests/js_i18n_preference_test.js
osascript -l JavaScript tests/js_normalization_test.js
osascript -l JavaScript tests/js_correction_test.js
osascript -l JavaScript tests/js_difficulty_ui_test.js
osascript -l JavaScript tests/js_adaptive_generator_test.js
osascript -l JavaScript tests/js_adaptive_integration_test.js
```

> The JavaScript tests currently rely on JXA, which is macOS-only. They exercise the pure
> application logic (i18n engine, catalogs, corrections, difficulty ranking, adaptive
> generator, language preference handling); DOM rendering and real asynchronous/network
> behaviour are validated manually in a browser (e.g. Firefox).

---

## Project status and version

**v12.6.0** is the version prepared for publication on this branch. It adds the four-language
internationalization, per-account language preference synchronization, and the supporting
i18n engine, catalogs and tests — on top of the v12.5 adaptive training.

---

## License and attribution

Author: **Didier SEBASTIEN**

© Didier SEBASTIEN — 2026 · v12

Administration icons are based on Lucide, licensed under ISC, with MIT licensing for applicable Feather-derived icons. Some icons have been modified. See `public/assets/icons/LICENSE-LUCIDE.txt`.

This repository does **not** currently distribute an open-source license file. No license is
implied; please contact the author before reusing significant portions of the code.

