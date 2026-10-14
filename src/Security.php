<?php

declare(strict_types=1);

/**
 * Security — Regroupe les règles de sécurité applicatives.
 *
 * Responsabilités :
 *  - configurer la session PHP (cookie HttpOnly, SameSite=Lax, Secure si HTTPS) ;
 *  - générer et vérifier les jetons CSRF ;
 *  - poser les en-têtes HTTP de sécurité sur les réponses.
 */

final class Security
{
    /** Nom du cookie de session. */
    private const SESSION_NAME = 'calc_trainer_sid';

    /** Clé du jeton CSRF dans $_SESSION. */
    private const CSRF_KEY = 'csrf_token';

    /**
     * Démarre une session sécurisée. À appeler avant toute sortie HTML/JSON.
     *
     * En contexte HTTP, les en-têtes ne sont pas encore envoyés : la session
     * démarre normalement. Si la sortie a déjà commencé (ex. contexte CLI de
     * tests), on ne tente pas un démarrage voué à l'échec ni générateur
     * d'avertissement.
     */
    public static function startSession(): void
    {
        if (session_status() === PHP_SESSION_ACTIVE) {
            return;
        }
        if (headers_sent()) {
            return;
        }

        $secure = !empty($_SERVER['HTTPS']) && $_SERVER['HTTPS'] !== 'off';
        session_name(self::SESSION_NAME);
        session_set_cookie_params([
            'lifetime' => 0,
            'path'     => '/',
            'domain'   => '',
            'secure'   => $secure,
            'httponly' => true,
            'samesite' => 'Lax',
        ]);
        session_start();
    }

    /**
     * Régénère l'identifiant de session (à appeler après une connexion réussie).
     * Ne régénère que si une session est effectivement active : régénérer un
     * identifiant sans session active est impossible et génèrerait un
     * avertissement (cas des tests CLI).
     */
    public static function regenerateSession(): void
    {
        if (session_status() !== PHP_SESSION_ACTIVE) {
            return;
        }
        session_regenerate_id(true);
    }

    /**
     * Invalide et détruit la session (déconnexion).
     */
    public static function destroySession(): void
    {
        $_SESSION = [];

        if (ini_get('session.use_cookies') && !headers_sent()) {
            $params = session_get_cookie_params();
            setcookie(
                self::SESSION_NAME,
                '',
                [
                    'expires'  => time() - 42000,
                    'path'     => $params['path'],
                    'domain'   => $params['domain'],
                    'secure'   => $params['secure'],
                    'httponly' => $params['httponly'],
                    'samesite' => 'Lax',
                ]
            );
        }

        if (session_status() === PHP_SESSION_ACTIVE) {
            session_destroy();
        }
    }

    /**
     * Génère (ou réutilise) le jeton CSRF de la session courante.
     */
    public static function csrfToken(): string
    {
        if (empty($_SESSION[self::CSRF_KEY])) {
            $_SESSION[self::CSRF_KEY] = bin2hex(random_bytes(32));
        }
        return (string)$_SESSION[self::CSRF_KEY];
    }

    /**
     * Vérifie que le jeton CSRF reçu correspond à celui de la session.
     * Les opérations de lecture seule sont exclues : à n'utiliser que pour
     * les opérations modifiant des données (POST).
     */
    public static function verifyCsrf(?string $token): bool
    {
        $expected = (string)($_SESSION[self::CSRF_KEY] ?? '');
        if ($expected === '' || $token === null || $token === '') {
            return false;
        }
        return hash_equals($expected, $token);
    }

    /**
     * Vérifie qu'une requête est bien en POST et porte un jeton CSRF valide.
     *
     * À appeler pour toute opération modifiant des données. En cas d'échec,
     * envoie directement la réponse d'erreur et termine le script.
     *
     * @param string $method    méthode HTTP de la requête courante.
     * @param string $csrfToken jeton CSRF reçu (corps JSON, champ csrf_token).
     */
    public static function verifyPost(string $method, string $csrfToken): void
    {
        if (strtoupper($method) !== 'POST') {
            Response::error('Méthode non autorisée.', 405);
        }
        if (!self::verifyCsrf($csrfToken)) {
            Response::error('Jeton de sécurité invalide.', 403);
        }
    }

    /**
     * Pose les en-têtes HTTP de sécurité sur la réponse courante.
     */
    public static function sendSecurityHeaders(): void
    {
        if (!headers_sent()) {
            header('X-Content-Type-Options: nosniff');
            header('X-Frame-Options: DENY');
            header('Referrer-Policy: no-referrer');
            header('Cache-Control: no-store');
        }
    }
}
