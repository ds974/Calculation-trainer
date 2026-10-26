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
 *  - result/save           (POST) : enregistre une partie terminée (connecté).
 *  - result/history        (GET)  : historique des parties de l'utilisateur connecté.
 *  - result/import         (POST) : import des anciennes parties invitées (connecté).
 *
 * Sécurité : session HttpOnly/SameSite=Lax/Secure (si HTTPS), jeton CSRF
 * obligatoire pour toute opération POST, requêtes préparées, Argon2id,
 * messages génériques ne révélant pas l'existence d'un compte.
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
    $results = new ResultService($db->pdo(), $resultRepository);

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
            $user = $auth->register([
                'login'    => (string)($parsed['login'] ?? ''),
                'password' => (string)($parsed['password'] ?? ''),
                // Le champ 'email' d'un ancien client est volontairement ignoré.
            ]);
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

        case 'result/save':
            // Enregistre une partie terminée pour l'utilisateur connecté.
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            $playedAt = isset($parsed['played_at']) && is_string($parsed['played_at'])
                ? $parsed['played_at']
                : null;
            $resultId = $results->save(
                (int)$user['id'],
                (string)($parsed['mode'] ?? ''),
                (int)($parsed['score'] ?? -1),
                $playedAt
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

        case 'result/import':
            // Import volontaire, idempotent et transactionnel, des parties invitées.
            Security::verifyPost($method, (string)($parsed['csrf_token'] ?? ''));
            $user = $auth->currentUser();
            if ($user === null) {
                Response::error('Authentification requise.', 401);
            }
            $items = isset($parsed['items']) && is_array($parsed['items'])
                ? $parsed['items']
                : [];
            $outcome = $results->importGuest((int)$user['id'], $items);
            Response::success($outcome, 201);
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

