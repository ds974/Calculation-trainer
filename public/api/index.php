<?php

declare(strict_types=1);

/**
 * api/index.php — Front controller unique de l'API JSON.
 *
 * Toutes les requêtes passent ici ; le routage est réalisé selon le champ
 * "action" reçu (JSON dans le corps pour POST, ou en GET). Les données
 * sensibles ne sont jamais renvoyées dans les réponses.
 *
 * Routes disponibles :
 *  - health                (GET)  : contrôle de démarrage de la base.
 *  - auth/register         (POST) : inscription d'un nouveau compte.
 *  - auth/login            (POST) : connexion (création de la session).
 *  - auth/logout           (POST) : déconnexion (destruction de la session).
 *  - profile               (GET)  : profil de l'utilisateur connecté.
 *  - profile/password      (POST) : modification du mot de passe.
 *  - profile/language      (POST) : modification de la préférence linguistique.
 *  - profile/school-level  (POST) : modification du niveau scolaire (v12.8-B3.1).
 *  - result/save           (POST) : enregistre une partie terminée (connecté).
 *  - result/history        (GET)  : historique des parties de l'utilisateur connecté.
 *  - leaderboard           (GET)  : classement partagé serveur (public, v12.8-B4.1).
 *  - stats                 (GET)  : statistiques personnelles d'un mode (connecté).
 *  - difficulty/operations (GET)  : opérations non maîtrisées de l'utilisateur
 *                                   connecté (v12.5, missions adaptatives).
 *
 *  Routes d'administration (réservées au rôle `admin`, vérifié côté serveur) :
 *  - admin/users           (GET)  : liste des comptes + recherche (option q).
 *  - admin/user            (GET)  : infos administratives d'un compte (id).
 *  - admin/stats           (GET)  : statistiques globales.
 *  - admin/role            (POST) : attribution/retrait du rôle administrateur.
 *  - admin/active          (POST) : activation/désactivation d'un compte.
 *  - admin/password        (POST) : réinitialisation sécurisée du mot de passe.
 *
 * Sécurité : session HttpOnly/SameSite=Lax/Secure (si HTTPS), jeton CSRF
 * obligatoire pour toute opération POST, requêtes préparées, Argon2id,
 * messages génériques ne révélant pas l'existence d'un compte. Les routes
 * admin/* exigent en outre le rôle `admin` SERVEUR (jamais un rôle client).
 *
 * Gestion des e-mails : entièrement supprimée. La colonne `email` de la table
 * `users` est conservée (nullable) pour éviter une restructuration, mais :
 *  - une migration idempotente force `email = NULL` pour toutes les lignes ;
 *  - le champ `email` éventuellement transmis par un ancien client est ignoré ;
 *  - aucune réponse API ne renvoie le champ `email`.
 */

require dirname(__DIR__, 2) . '/src/bootstrap.php';

// Réponse JSON par défaut ; on définit immédiatement le type de contenu via Response.
$method = $_SERVER['REQUEST_METHOD'] ?? 'GET';
$action = '';

$body = file_get_contents('php://input');
$parsed = json_decode($body ?: '', true);
if (is_array($parsed) && isset($parsed['action'])) {
    $action = (string)$parsed['action'];
} elseif (isset($_GET['action'])) {
    $action = (string)$_GET['action'];
}

// Session sécurisée + en-têtes HTTP de sécurité.
Security::startSession();
Security::sendSecurityHeaders();

try {
    // Initialisation commune : base + dépôts/services.
    $db = new Database(CALC_TRAINER_ROOT);
    $users = new UserRepository($db->pdo());
    $auth = new AuthService($db->pdo(), $users);
    $resultRepository = new ResultRepository($db->pdo());
    $difficultyRepository = new OperationDifficultyRepository($db->pdo());
    $difficulty = new OperationDifficultyService($db->pdo(), $difficultyRepository);
    $results = new ResultService($db->pdo(), $resultRepository, $difficulty);
    $stats = new StatsService($resultRepository);
    // v12.8-B4.1 — classement partagé côté serveur (lecture seule, public).
    $leaderboard = new LeaderboardService($db->pdo());
    $adminRepository = new AdminRepository($db->pdo());
    $admin = new AdminService($db->pdo(), $auth, $users, $adminRepository);

    // Migration idempotente (non destructive) : efface toute valeur d'e-mail
    // résiduelle en base. Conserve les identifiants, mots de passe hachés,
    // rôles et résultats. Exécutable à chaque requête sans effet de bord.
    $db->pdo()->exec('UPDATE users SET email = NULL WHERE email IS NOT NULL');

    switch ($action) {
        case 'health':
            Response::success([
                'status'   => 'ok',
                'database' => true,
                'wal'      => $db->isWalActive(),
            ]);
            break;

        case 'auth/csrf':
            // Renvoie le jeton CSRF de la session courante (lecture seule).
            // Le client devra le renvoyer pour toute opération POST.
            Response::success(['token' => Security::csrfToken()]);
            break;

        case 'auth/register':
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            // Les données d'inscription ; la langue préférée est OPTIONNELLE.
            // On ne l'ajoute au tableau que si le client la transmet réellement :
            // la clé absente laisse AuthService choisir la valeur par défaut 'fr'
            // (un null explicite serait interprété comme une valeur invalide).
            $reg = [
                'login'    => (string)($parsed['login'] ?? ''),
                'password' => (string)($parsed['password'] ?? ''),
            ];
            if (isset($parsed['preferred_language'])) {
                $reg['preferred_language'] = (string)$parsed['preferred_language'];
            }
            // Niveau scolaire OPTIONNEL à l'inscription (v12.8-B3.1). On ne l'ajoute
            // que s'il est réellement présent dans le corps (y compris un null
            // explicite => « Non renseigné »), afin de laisser AuthService gérer
            // l'absence et la validation. Le champ n'est jamais obligatoire.
            if (array_key_exists('school_level', $parsed)) {
                $reg['school_level'] = $parsed['school_level'];
            }
            $user = $auth->register($reg);
            Response::success(['user' => $user], 201);
            break;

        case 'auth/login':
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->login(
                (string)($parsed['login'] ?? ''),
                (string)($parsed['password'] ?? '')
            );
            Response::success(['user' => $user]);
            break;

        case 'auth/logout':
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $auth->logout();
            Response::success(['logged_out' => true]);
            break;

        case 'profile':
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            Response::success(['user' => $user]);
            break;

        case 'profile/password':
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            $auth->changePassword(
                (int)$user['id'],
                (string)($parsed['old_password'] ?? ''),
                (string)($parsed['new_password'] ?? '')
            );
            Response::success(['password_changed' => true]);
            break;

        case 'profile/language':
            // Modification de la préférence linguistique de l'utilisateur connecté
            // (v12.6-C1). Seul le compte de la session est modifiable ; la langue
            // est validée de manière stricte et n'affecte aucune autre donnée.
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            // La langue doit être fournie et valide (fr/en/es/zh-Hans). Une valeur
            // absente ou invalide est rejetée par AuthService::changeLanguage (400).
            $user = $auth->changeLanguage(
                (int)$user['id'],
                (string)($parsed['preferred_language'] ?? '')
            );
            Response::success(['user' => $user]);
            break;

        case 'profile/school-level':
            // Modification du niveau scolaire du compte connecté (v12.8-B3.1).
            // Seul le compte de la session est modifiable ; le niveau est validé
            // de manière stricte (six identifiants stables, ou null pour « Non
            // renseigné »). Un niveau fourni n'affecte aucune autre donnée et ne
            // modifie jamais le niveau HISTORIQUE des parties déjà enregistrées.
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            // `school_level` est EXIGÉ : sa présence est requise pour cet endpoint
            // dédié. Il peut être JSON `null` (« Non renseigné ») ou une chaîne parmi
            // les six identifiants. Une absence (clé non fournie) est refusée en 400.
            if (!array_key_exists('school_level', $parsed)) {
                Response::error('Le champ school_level est requis.', 400);
            }
            $newLevel = $parsed['school_level'];
            if ($newLevel !== null && !is_string($newLevel)) {
                Response::error(
                    'Niveau scolaire non reconnu. Valeurs acceptées : '
                    . implode(', ', Validator::allowedSchoolLevels()) . ', ou null.',
                    400
                );
            }
            $user = $auth->changeSchoolLevel((int)$user['id'], $newLevel);
            Response::success(['user' => $user]);
            break;

        case 'result/save':
            // Enregistre une partie terminée pour l'utilisateur connecté.
            // v12.4 : si le client fournit un `mission_id` stable et le détail
            // individuel des réponses (`details`), l'enregistrement est ATOMIQUE
            // (résultat + mémoire des difficultés) et IDEMPOTENT (un même
            // mission_id n'est écrit qu'une seule fois). Sans ces nouvelles
            // données, on retombe sur l'ancien comportement (`save`), préservant
            // la rétrocompatibilité avec les anciens clients.
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            $playedAt = isset($parsed['played_at']) && is_string($parsed['played_at'])
                ? $parsed['played_at']
                : null;

            // v12.8-B2 — durée de la partie en millisecondes (optionnelle).
            // - champ ABSENT ou JSON null  => durée inconnue (NULL) : rétrocompatibilité.
            // - entier strictement positif => enregistré tel quel.
            // - toute autre valeur (chaîne "null", décimale, booléen, 0, négatif,
            //   démesuré) est REJETÉE : on ne confond jamais la chaîne "null" avec
            //   la valeur JSON null.
            $durationMs = null;
            if (array_key_exists('duration_ms', $parsed) && $parsed['duration_ms'] !== null) {
                if (!is_int($parsed['duration_ms'])
                    || !Validator::durationMs($parsed['duration_ms'])) {
                    Response::error(
                        'Durée de partie invalide (entier strictement positif en millisecondes attendu).',
                        400
                    );
                }
                $durationMs = (int)$parsed['duration_ms'];
            }

            // v12.8-B2 — niveau scolaire HISTORIQUE figé à l'enregistrement.
            // Il est lu FRAÎCHEMENT depuis la base (jamais d'un champ client) pour
            // éviter de dépendre d'un objet de session périmé. Un profil sans niveau
            // (NULL) aboutit à 'unspecified' sur la ligne de résultat.
            $freshUser = $users->findById((int)$user['id']);
            $schoolLevel = ($freshUser !== null
                    && isset($freshUser['school_level'])
                    && $freshUser['school_level'] !== null)
                ? (string)$freshUser['school_level']
                : 'unspecified';

            $mode = (string)($parsed['mode'] ?? '');

            // v12.8.1-B3 — tables effectivement utilisées pendant la partie
            // (optionnelles, rétrocompatible : absence => non renseignées).
            //  - multiplication : tableau d'entiers [1,2,5]
            //  - addition : objet {"min":int,"max":int}
            // Toute forme ou valeur hors bornes est REJETÉE (HTTP 400). Le serveur
            // normalise ensuite en chaîne JSON canonique avant persistance.
            $tables = null;
            if (array_key_exists('tables', $parsed)) {
                if (!Validator::tables($parsed['tables'], $mode)) {
                    Response::error(
                        'Description des tables utilisées invalide (multiplication : tableau 1-10 ; addition : {min,max} 1-99).',
                        400
                    );
                }
                $tables = $parsed['tables'];
            }

            $hasMission = isset($parsed['mission_id']) && is_string($parsed['mission_id'])
                && trim($parsed['mission_id']) !== ''
                && isset($parsed['details']) && is_array($parsed['details']);

            if ($hasMission) {
                $outcome = $results->saveWithMission(
                    (int)$user['id'],
                    $mode,
                    (int)($parsed['score'] ?? -1),
                    (string)$parsed['mission_id'],
                    $parsed['details'],
                    $playedAt,
                    (string)($parsed['question_type'] ?? 'classic'),
                    $durationMs,
                    $schoolLevel,
                    $tables
                );
                if ($outcome['duplicate']) {
                    // Mission déjà enregistrée : réponse de succès cohérente au
                    // client, SANS seconde écriture (idempotence respectée).
                    Response::success([
                        'result'  => ['id' => null],
                        'duplicate' => true,
                    ], 200);
                }
                Response::success(['result' => ['id' => $outcome['id']]], 201);
            }

            $resultId = $results->save(
                (int)$user['id'],
                $mode,
                (int)($parsed['score'] ?? -1),
                $playedAt,
                (string)($parsed['question_type'] ?? 'classic'),
                $durationMs,
                $schoolLevel,
                $tables
            );
            Response::success(['result' => ['id' => $resultId]], 201);
            break;

        case 'result/history':
            // Historique des parties de l'utilisateur connecté.
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            Response::success(['history' => $results->history((int)$user['id'])]);
            break;

        case 'stats':
            // Statistiques personnelles d'un mode, calculées côté serveur à partir
            // de l'identité de session UNIQUEMENT (jamais un user_id client).
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            $mode = isset($_GET['mode']) && is_string($_GET['mode'])
                ? $_GET['mode']
                : (string)($parsed['mode'] ?? '');
            // v12.4 : on enrichit les statistiques avec le bilan « Mes points à
            // travailler » (mémoire des difficultés par table), indépendant du
            // mode sélectionné. Rétrocompatible : les champs existants sont
            // conservés, seule la clé `difficulty` est ajoutée.
            $statsData = $stats->stats((int)$user['id'], $mode);
            $statsData['difficulty'] = $results->difficultySummary((int)$user['id']);
            Response::success($statsData);
            break;

        case 'leaderboard':
            // v12.8-B4.1 — classement partagé côté serveur (lecture seule, PUBLIC :
            // aucun compte requis, aucune protection CSRF sur un GET). Seuls les
            // comptes actifs apparaissent ; les parties invitées et les comptes
            // désactivés sont exclus. Aucune donnée privée n'est renvoyée.
            // Les valeurs par défaut : mode=multiplication, niveau=all,
            // type=classic, limit=20.
            $lbMode = isset($_GET['mode']) && is_string($_GET['mode'])
                ? $_GET['mode']
                : (string)($parsed['mode'] ?? '');
            if ($lbMode === '') {
                $lbMode = 'multiplication';
            }
            $lbLevel = isset($_GET['school_level']) && is_string($_GET['school_level'])
                ? $_GET['school_level']
                : (string)($parsed['school_level'] ?? '');
            if ($lbLevel === '') {
                $lbLevel = 'all';
            }
            $lbType = isset($_GET['question_type']) && is_string($_GET['question_type'])
                ? $_GET['question_type']
                : (string)($parsed['question_type'] ?? '');
            if ($lbType === '') {
                $lbType = 'classic';
            }
            $lbLimit = 20;
            if ((isset($_GET['limit']) && $_GET['limit'] !== '')
                || (isset($parsed['limit']) && $parsed['limit'] !== '')) {
                $rawLimit = isset($_GET['limit']) ? $_GET['limit'] : $parsed['limit'];
                $intLimit = filter_var($rawLimit, FILTER_VALIDATE_INT);
                if ($intLimit === false) {
                    Response::error('Limite invalide.', 400);
                }
                $lbLimit = (int)$intLimit;
            }
            // Validation centralisée (mode, niveau, type, bornes de limite) ;
            // chaque échec renvoie HTTP 400. La requête est préparée côté service.
            // Contrat : `filters` (mode/niveau/type appliqués) + `entries` classées.
            $lbResult = $leaderboard->leaderboard($lbMode, $lbLevel, $lbType, $lbLimit);
            Response::success([
                'filters' => [
                    'mode'          => $lbMode,
                    'school_level'  => $lbLevel,
                    'question_type' => $lbType,
                ],
                'entries' => $lbResult['entries'],
            ]);
            break;

        case 'difficulty/operations':
            // v12.5 — Opérations NON maîtrisées (difficulty > 0) de l'utilisateur
            // connecté, destinées aux missions adaptatives. Authentification
            // obligatoire ; l'identifiant est TOUJOURS pris dans la session, et
            // les filtres sont strictement validés avant exécution (requêtes
            // préparées). Aucune donnée d'un autre utilisateur n'est accessible.
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            $userId = (int)$user['id'];

            // -- mode (facultatif) : multiplication | addition -------------------
            $mode = isset($_GET['mode']) && is_string($_GET['mode'])
                ? trim($_GET['mode'])
                : null;
            if ($mode !== null && $mode !== '' && !Validator::mode($mode)) {
                Response::error('Mode de jeu invalide.', 400);
            }
            if ($mode === '') {
                $mode = null;
            }

            // -- type de question (facultatif) : classic | hole | mixed ----------
            // 'mixed' signifie « les deux » (classic ET hole), cohérent avec le
            // libellé côté application pour les missions en mode Mélange.
            $qtRaw = isset($_GET['question_type']) && is_string($_GET['question_type'])
                ? trim($_GET['question_type'])
                : '';
            $questionTypes = [];
            if ($qtRaw !== '') {
                if (!in_array($qtRaw, ['classic', 'hole', 'mixed'], true)) {
                    Response::error('Type de question invalide.', 400);
                }
                $questionTypes = $qtRaw === 'mixed'
                    ? ['classic', 'hole']
                    : [$qtRaw];
            }

            // -- plage d'additions (facultatif) ---------------------------------
            $addMin = isset($_GET['add_min']) && is_string($_GET['add_min'])
                && $_GET['add_min'] !== ''
                ? filter_var($_GET['add_min'], FILTER_VALIDATE_INT)
                : null;
            $addMax = isset($_GET['add_max']) && is_string($_GET['add_max'])
                && $_GET['add_max'] !== ''
                ? filter_var($_GET['add_max'], FILTER_VALIDATE_INT)
                : null;
            if ($addMin === false || $addMax === false) {
                Response::error('Borne de plage invalide.', 400);
            }
            if ($addMin !== null && ($addMin < 1 || $addMin > 99)) {
                Response::error('Borne de plage hors limites (1-99).', 400);
            }
            if ($addMax !== null && ($addMax < 1 || $addMax > 99)) {
                Response::error('Borne de plage hors limites (1-99).', 400);
            }
            if ($addMin !== null && $addMax !== null && $addMin > $addMax) {
                Response::error('Borne minimale supérieure à la borne maximale.', 400);
            }
            // On n'applique la plage que pour les additions (ou en l'absence de
            // mode précis) ; pour une multiplication seule, une plage d'additions
            // est ignorée car sans objet.

            // -- tables autorisées (facultatif) ----------------------------------
            $tablesRaw = isset($_GET['tables']) && is_string($_GET['tables'])
                ? $_GET['tables']
                : '';
            $multTables = [];
            if ($tablesRaw !== '') {
                $seen = [];
                foreach (explode(',', $tablesRaw) as $part) {
                    $part = trim($part);
                    if ($part === '' || !filter_var($part, FILTER_VALIDATE_INT)
                        || (int)$part < 1 || (int)$part > 10) {
                        Response::error('Table autorisée invalide (1-10).', 400);
                    }
                    $seen[(int)$part] = true;
                }
                $multTables = array_map('intval', array_keys($seen));
            }

            $operations = $difficultyRepository->difficultOperations(
                $userId,
                $mode,
                $questionTypes,
                $addMin,
                $addMax,
                $multTables
            );

            // Normalisation des champs publics (même forme qu'en base, sans
            // colonnes parasites) et conversion des clés en minuscules homogènes.
            $normalized = [];
            foreach ($operations as $op) {
                $normalized[] = [
                    'mode'          => (string)$op['mode'],
                    'question_type' => (string)$op['question_type'],
                    'a'             => (int)$op['operand_a'],
                    'b'             => (int)$op['operand_b'],
                    'difficulty'    => (int)$op['difficulty'],
                ];
            }
            Response::success(['operations' => $normalized]);
            break;

        // NOTE v12.2 : la route `result/import` (import des anciennes parties
        // invitées) a été volontairement SUPPRIMÉE. Toute requête vers cette
        // action tombe désormais sur le cas `default` (404 « Action inconnue »),
        // de sorte qu'un ancien client ne peut plus importer de données vers un
        // compte. Les classements invités et la sauvegarde `result/save` restent
        // actifs ; l'import n'est plus utilisable, même par un appel API direct.

        // ---------------------------------------------------------------------
        // Routes d'administration (v12.1) : TOUTES vérifient le rôle côté serveur
        // via AdminService::requireAdmin($user). Aucune donnée sensible n'est
        // renvoyée (jamais password_hash ni e-mail).
        // ---------------------------------------------------------------------

        case 'admin/users':
            // Liste des comptes, avec recherche optionnelle (réservé admin).
            $user = $auth->currentUser();
            $admin->requireAdmin($user);
            $search = isset($_GET['q']) && is_string($_GET['q']) ? trim($_GET['q']) : '';
            $limit = max(1, min(200, (int)($_GET['limit'] ?? 100)));
            $offset = max(0, (int)($_GET['offset'] ?? 0));
            Response::success($admin->listUsers($search, $limit, $offset));
            break;

        case 'admin/user':
            // Consultation des informations administratives d'un compte (réservé admin).
            $user = $auth->currentUser();
            $admin->requireAdmin($user);
            $targetId = isset($_GET['id']) ? (int)$_GET['id'] : 0;
            $detail = $targetId > 0 ? $admin->userDetail($targetId) : null;
            if ($detail === null) {
                Response::error('Compte introuvable.', 404);
            }
            Response::success(['user' => $detail]);
            break;

        case 'admin/stats':
            // Statistiques globales (réservé admin).
            $user = $auth->currentUser();
            $admin->requireAdmin($user);
            Response::success($admin->globalStats());
            break;

        case 'admin/role':
            // Attribution / retrait du rôle administrateur (réservé admin).
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->currentUser();
            $admin->requireAdmin($user);
            $targetId = (int)($parsed['user_id'] ?? 0);
            $makeAdmin = filter_var($parsed['make_admin'] ?? null, FILTER_VALIDATE_BOOLEAN);
            if ($targetId <= 0) {
                Response::error('Identifiant de compte invalide.', 400);
            }
            $fiche = $admin->setRole($targetId, $makeAdmin, (int)$user['id']);
            Response::success(['user' => $fiche]);
            break;

        case 'admin/active':
            // Activation / désactivation d'un compte (réservé admin, soft delete).
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->currentUser();
            $admin->requireAdmin($user);
            $targetId = (int)($parsed['user_id'] ?? 0);
            $active = Validator::active($parsed['is_active'] ?? null);
            if ($targetId <= 0) {
                Response::error('Identifiant de compte invalide.', 400);
            }
            if ($active === null) {
                Response::error("Valeur d'activation invalide.", 400);
            }
            $fiche = $admin->setActive($targetId, $active);
            Response::success(['user' => $fiche]);
            break;

        case 'admin/password':
            // Réinitialisation sécurisée du mot de passe d'un compte (réservé admin).
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->currentUser();
            $admin->requireAdmin($user);
            $targetId = (int)($parsed['user_id'] ?? 0);
            if ($targetId <= 0) {
                Response::error('Identifiant de compte invalide.', 400);
            }
            $reset = $admin->resetPassword($targetId);
            Response::success(['reset' => $reset]);
            break;

        default:
            Response::error('Action inconnue.', 404);
    }
} catch (InvalidArgumentException $e) {
    // Erreur de validation (messages sûrs, non sensibles).
    Response::error($e->getMessage(), 400);
} catch (RuntimeException $e) {
    // Erreurs applicatives ; le code HTTP est porté par l'exception (401/403/404/429/400).
    $http = $e->getCode();
    if (!is_int($http) || $http < 400 || $http > 599) {
        $http = 500;
        $message = 'Erreur interne du serveur.';
    } else {
        $message = $e->getMessage();
    }
    Response::error($message, $http);
} catch (Throwable $e) {
    // On ne renvoie jamais le détail interne (pas d'exposition de données).
    Response::error('Erreur interne du serveur.', 500);
}

