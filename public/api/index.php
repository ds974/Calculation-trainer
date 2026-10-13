<?php

declare(strict_types=1);

/**
 * api/index.php — Front controller unique de l'API JSON.
 *
 * Toutes les requêtes passent ici ; le routage est réalisé selon le champ
 * "action" reçu (POST/GET JSON). Les données sensibles ne sont jamais
 * renvoyées dans les réponses.
 *
 * À l'étape 1, seul l'endpoint de santé ("health") est disponible ; les routes
 * d'authentification, de résultats, de statistiques et d'administration seront
 * ajoutées aux étapes suivantes.
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

try {
    switch ($action) {
        case 'health':
            // Vérifie que la base est joignable (utilisé en contrôle de démarrage).
            $db = new Database(CALC_TRAINER_ROOT);
            $wal = $db->isWalActive();
            Response::success([
                'status'   => 'ok',
                'database' => true,
                'wal'      => $wal,
            ]);
            break; // jamais atteint (Response::success() termine le script)

        default:
            Response::error('Action inconnue.', 404);
    }
} catch (Throwable $e) {
    // On ne renvoie jamais le détail interne (pas d'exposition de données).
    Response::error('Erreur interne du serveur.', 500);
}
