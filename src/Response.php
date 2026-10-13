<?php

declare(strict_types=1);

/**
 * Response — Réponses JSON structurées + codes HTTP.
 *
 * Garantit un format uniforme pour toutes les API :
 *   { "ok": true/false, "data": ...., "error": "message" }
 * N'expose jamais de données sensibles (pas d'empreintes, pas de stack).
 */

final class Response
{
    /**
     * Envoie une réponse JSON de succès.
     *
     * @param mixed $data Données à retourner (objet/tableau).
     */
    public static function success(mixed $data = null, int $status = 200): never
    {
        self::send(['ok' => true, 'data' => $data], $status);
    }

    /**
     * Envoie une réponse JSON d'erreur.
     *
     * @param string $message Message compréhensible, dénué de données sensibles.
     */
    public static function error(string $message, int $status = 400): never
    {
        self::send(['ok' => false, 'error' => $message], $status);
    }

    private static function send(array $payload, int $status): never
    {
        http_response_code($status);
        header('Content-Type: application/json; charset=utf-8');
        // En-têtes de sécurité de base pour les réponses d'API.
        header('X-Content-Type-Options: nosniff');
        header('Cache-Control: no-store');
        echo json_encode($payload, JSON_UNESCAPED_UNICODE | JSON_UNESCAPED_SLASHES);
        exit;
    }
}
