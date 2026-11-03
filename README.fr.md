# Mission Calcul Mental — Entraînement adaptatif de calcul mental

*Mission Calcul Mental* — application libre et multilingue d'entraînement au calcul mental,
avec pratique adaptative, suivi des progrès et apprentissage personnalisé.

[English](README.md) | Français

---

## Langues disponibles

L'interface de l'application est entièrement traduite en **quatre langues** :

- Français
- Anglais
- Espagnol
- Chinois simplifié

La langue peut être changée à tout moment depuis un menu discret situé en haut de l'interface :

- **Les visiteurs** peuvent conserver leur préférence **localement** (dans le navigateur).
- **Les utilisateurs connectés** bénéficient d'une préférence **enregistrée dans leur compte**,
  rétablie à chaque session.
- Les interfaces pédagogiques (missions, corrections, résultats), les statistiques
  personnelles et le tableau d'administration sont entièrement traduits.

> Le choix de la langue est l'évolution majeure de la **v12.6**. À chaque changement de langue,
> la plupart des écrans se mettent à jour immédiatement, sans rechargement de page. Les quatre
> catalogues de traduction contiennent chacun 357 clés identiques, garantissant une couverture
> cohérente entre les langues.

---

## Présentation

**Mission Calcul Mental** est une application web destinée à aider les enfants et les apprenants
à pratiquer le **calcul mental** — additions et multiplications — au travers de missions courtes
et minutées.

- **Objectif pédagogique :** construire une aisance durable en calcul par une pratique
  régulière et ciblée.
- **Pour qui :** les apprenants qui souhaitent consolider leurs tables et leurs additions, les
  parents et enseignants à la recherche d'un outil d'entraînement quotidien simple, et toute
  personne aimant un défi de calcul rapide.
- **Fonctionnement :** une application monopage servie par un navigateur web. Aucune
  installation d'application, aucune étape de compilation du frontend.

L'application ne prétend à aucune validation scientifique ou institutionnelle officielle ; c'est
un outil pédagogique dont l'efficacité repose sur une pratique progressive et personnalisée,
avec un retour pédagogique.

---

## Fonctionnalités principales

- **Entraînement aux additions et multiplications**, avec des réglages indépendants pour chaque
  opération.
- **Calculs classiques, à trou et mélange** (ex. `? × 6 = 18`), au choix par mission.
- **Tables de multiplication et plages d'addition configurables.**
- **Missions minutées de 10 questions** avec chronomètre circulaire.
- **Construction interactive d'une fusée** à la fin de chaque mission.
- **Entraînement adaptatif** centré sur les difficultés propres à chaque apprenant.
- **Suivi personnalisé des difficultés**, par opération et par utilisateur.
- **Scores, historique et statistiques de progression**, avec graphiques et difficultés par
  table.
- **Comptes utilisateurs facultatifs**, avec sessions sécurisées et données isolées.
- **Mode invité** pour jouer immédiatement sans compte.
- **Tableau d'administration** pour gérer les comptes et suivre l'activité.
- **Quatre langues d'interface** (français, anglais, espagnol, chinois simplifié).
- **Niveau scolaire facultatif** (six catégories + « Non renseigné »), autodéclaré à l'inscription
  ou modifiable ensuite dans le profil. Le niveau est enregistré avec chaque résultat et ne modifie
  jamais les règles de calcul des scores.
- **Classements partagés** conservés sur le serveur (SQLite) et accessibles entre appareils, en
  plus des **scores locaux** existants conservés dans le navigateur pour les invités.
- **Filtres** des classements partagés : niveau scolaire, opération (addition / multiplication)
  et type de questions (classique / à trou / mélange), plus un classement général tous niveaux.
- **Meilleur résultat par utilisateur** dans chaque classement, avec départage déterministe par
  score, puis durée, puis date.
- **Durées des participants** enregistrées en millisecondes et utilisées pour départager les scores
  égaux.
- **Consultation publique** (sans connexion) des classements partagés.
- **Interface responsive** s'adaptant aux petits écrans, avec pavé numérique tactile.

### À propos de l'entraînement adaptatif

Lorsque l'option d'entraînement sur ses difficultés est activée, environ **40 % des questions**
d'une mission ciblent des opérations déjà identifiées comme difficiles, les **60 % restants**
provenant de l'entraînement ordinaire. Tout respecte les paramètres configurés (tables ou plages
choisies, et types Classique, À trou ou Mélange). En l'absence de difficultés compatibles, la
mission revient simplement à des questions ordinaires — un invité se comporte comme un apprenant
normal.

---

## Comment ça marche

1. **Choisissez le type de calcul** — additions, multiplications, ou les deux.
2. **Configurez une mission** — tableaux ou plages, type de questions et préférences.
3. **Résolvez dix questions minutées** — rythme progressif avec retour immédiat.
4. **Consultez les résultats et corrections** — le débriefing révèle la bonne réponse dans
   l'équation et explique le raisonnement.
5. **Suivez vos progrès et travaillez vos points faibles** — consultez les graphiques et
   statistiques, puis laissez l'entraînement adaptatif cibler vos difficultés.
---

## Comptes utilisateurs et données

- **Mode invité :** jouez immédiatement sans compte. Les résultats sont conservés localement
  (stockage du navigateur) et peuvent être importés dans un compte plus tard.
- **Comptes facultatifs :** inscrivez-vous avec un identifiant unique (3–40 caractères
  alphanumériques et `_`) et un mot de passe d'**au moins 10 caractères**. Aucune adresse
  e-mail n'est requise.
- **Résultats et suivi des difficultés :** une fois connecté, les résultats et les difficultés
  de chaque mission sont enregistrés sur le compte et utilisés par l'entraînement adaptatif et
  les statistiques.
- **Préférence linguistique :** enregistrée par compte et synchronisée entre la préférence
  locale et la préférence du compte (endpoint `profile/language`).
- Les mots de passe sont hachés avec **Argon2id** et jamais stockés en clair ; les sessions et
  la protection **CSRF** suivent de bonnes pratiques de sécurité (cookies HTTP-only, politique
  same-site, jeton par session).

L'application vise de bonnes pratiques de sécurité, mais ne prétend à aucune conformité RGPD ni
certification officielle.

---

## Architecture technique

- **Frontend :** application monopage en JavaScript natif (sans framework), thème spatial en
  SVG/CSS.
- **Backend :** PHP, avec une API JSON en front controller (`public/api/index.php`).
- **Base de données :** SQLite, via PDO et requêtes préparées.
- **Internationalisation :** catalogues JSON par langue (`public/i18n/`) pilotés par un moteur
  `i18n.js` — seule source des textes traduits.

```
public/     racine documentaire (seule zone exposée par HTTP)
  index.html, style.css, app.js, admin.js, account.js, stats.js, i18n.js, i18n/
  api/index.php
src/        backend (non exposé)
storage/    base SQLite (non exposée)
scripts/    outils CLI (ex. initialize.php, non exposé)
tests/      suites de tests (non exposées)
```

---

## Tests

Les tests s'exécutent sur une **base SQLite temporaire** (sous `/tmp`) et ne touchent jamais à
la base de production.

### PHP (backend + HTTP)

```bash
php tests/run.php
php tests/http_test.php
php tests/difficulty_melange_repro.php
```

`php tests/run.php` couvre le schéma, l'authentification (Argon2id), l'unicité des identifiants,
la migration des difficultés et la protection du « dernier administrateur actif ».
`php tests/http_test.php` exerce le flux JSON HTTP complet (serveur intégré sur un port libre,
sessions, CSRF, résultats, administration) et l'endpoint de préférence `profile/language`.

### JavaScript (frontend)

Les tests frontend utilisent **JavaScript for Automation (JXA)**, le pont AppleScript/JavaScript
intégré à macOS, **sans Node.js** :

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

> Les tests JavaScript reposent actuellement sur JXA, réservé à macOS. Ils exercent la logique
> applicative pure (moteur i18n, catalogues, corrections, classement des difficultés,
> générateur adaptatif, gestion des préférences de langue) ; le rendu DOM et les comportements
> réels asynchrones/réseau sont validés manuellement dans un navigateur (par ex. Firefox).

---

## Niveaux scolaires et classements partagés

La version **v12.8.0** ajoute les niveaux scolaires et les classements partagés à l'application :

- **Facultatif et autodéclaré.** Le niveau scolaire est choisi par l'utilisateur (à l'inscription
  ou dans le profil) parmi six catégories — *Maternelle et avant*, *Début élémentaire*, *Fin
  élémentaire*, *Collège*, *Lycée*, *Supérieur et adultes* — plus **Non renseigné**. C'est une
  simple préférence personnelle ; il ne modifie ni les règles de difficulté ni le calcul des scores.
- **Niveau historique.** Chaque mission est enregistrée sur le serveur avec le niveau associé au
  compte au moment où elle a été jouée. Les anciennes missions sans niveau sont classées en
  **Non renseigné** et ne sont jamais déplacées rétroactivement.
- **Les invités ne publient pas.** Les résultats des visiteurs restent stockés localement dans le
  navigateur et n'apparaissent jamais dans le classement partagé.
- **Classements partagés.** Seuls les résultats des comptes enregistrés y figurent, avec le
  meilleur résultat par utilisateur dans chaque classement. Les titulaires de compte retrouvent
  leurs données sur tous leurs appareils.
- **Identités publiques.** Le classement partagé affiche l'identifiant public de chaque titulaire
  de compte. Il n'expose jamais d'e-mails, d'identifiants internes, de rôles ni d'autres données
  privées.

## Statut du projet et version

**v12.8.0** est la version préparée pour publication sur cette branche. Elle apporte les niveaux
scolaires facultatifs avec traductions en quatre langues, une API de consultation et de
modification du niveau du profil, la capture du niveau et de la durée pour chaque résultat, des
classements partagés côté serveur (un meilleur résultat par utilisateur, filtrables par niveau,
opération et type de questions, plus un classement général), une interface de consultation
conservée aux côtés des scores locaux existants, ainsi qu'une correction des paramètres GET
générés par l'API qui corrige aussi le filtrage de difficulté de l'entraînement adaptatif — le
tout avec des migrations SQLite entièrement compatibles avec les données existantes.

---

## Licence et mention d'auteur

Auteur : **Didier SEBASTIEN**

© Didier SEBASTIEN — 2026 · v12

« Les icônes d'administration sont basées sur Lucide (licence ISC, et MIT pour certaines icônes issues de Feather). Certaines ont été modifiées. Voir `public/assets/icons/LICENSE-LUCIDE.txt`. »

Ce dépôt ne distribue actuellement **aucun fichier de licence** open source. Aucune licence
n'est implicite ; merci de contacter l'auteur avant de réutiliser d'importantes parties du code.

