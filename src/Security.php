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

        // Les attributs du cookie de session sont fixés de façon fiable et
        // VÉRIFIÉE via session_set_cookie_params() (HttpOnly, SameSite=Lax,
        // Secure si HTTPS) : ils sont appliqués à l'envoi du Set-Cookie réel.
        //
        // Les directives moteur suivantes sont volontairement LAISSÉES à la
        // configuration de l'environnement (php.ini / MAMP), car le moteur de
        // session de PHP les fige au démarrage du module : un ini_set() à
        // l'exécution est un no-op (retour false) et serait trompeur :
        //   - session.use_strict_mode = 1  (recommander en php.ini, anti fixation)
        //   - session.serialize_handler = php  (ne PAS changer ; CVE-2026-115560
        //     relève d'une mise à jour du moteur PHP, l'application ne reconfigure
        //     jamais ce handler et n'appelle aucun unserialize sur données non fiables)
        //   - session.upload_progress.enabled = Off (recommandé ; CVE-2026-109618/109619)

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
            // Politique de sécurité de contenu : l'application n'utilise que des
            // scripts et styles externes auto-hébergés, sans blocs inline ni eval().
            // default-src 'self' bloque donc le chargement de toute ressource
            // distante et l'exécution de code inline => forte atténuation des XSS.
            header("Content-Security-Policy: default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; base-uri 'self'; form-action 'self'; frame-ancestors 'none'; object-src 'none'");
            header('Permissions-Policy: camera=(), microphone=(), geolocation=()');
        }
    }
}
