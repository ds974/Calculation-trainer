<?php

declare(strict_types=1);

/**
 * Validator — Validation centralisée et systématique des données côté serveur.
 *
 * Toutes les entrées utilisateur sont validées ici, indépendamment du contexte
 * (API ou CLI), afin de garantir des règles uniques et constantes.
 */

final class Validator
{
    public const MIN_PASSWORD_LENGTH = 10;

    /**
     * Valide un login.
     *
     * Règles : 3 à 40 caractères, lettres/chiffres/_- uniquement.
     *
     * @return string|null message d'erreur, ou null si valide.
     */
    public static function login(?string $login): ?string
    {
        $login = trim((string)$login);
        if ($login === '') {
            return 'Le nom d\'utilisateur est obligatoire.';
        }
        if (mb_strlen($login) < 3 || mb_strlen($login) > 40) {
            return 'Le nom d\'utilisateur doit contenir entre 3 et 40 caractères.';
        }
        if (!preg_match('/^[A-Za-z0-9_]+$/', $login)) {
            return 'Le nom d\'utilisateur ne peut contenir que des lettres, chiffres et tirets bas.';
        }
        return null;
    }

    /**
     * Valide un mot de passe (longueur minimale).
     *
     * @return string|null message d'erreur, ou null si valide.
     */
    public static function password(?string $password): ?string
    {
        $password = (string)$password;
        if (mb_strlen($password) < self::MIN_PASSWORD_LENGTH) {
            return 'Le mot de passe doit comporter au moins '
                . self::MIN_PASSWORD_LENGTH . ' caractères.';
        }
        return null;
    }

    /**
     * Valide un rôle utilisateur.
     *
     * @return true si le rôle est valide (user ou admin).
     */
    public static function role(string $role): bool
    {
        return in_array($role, ['user', 'admin'], true);
    }

    /**
     * Valide le mode de jeu d'un résultat.
     */
    public static function mode(string $mode): bool
    {
        return in_array($mode, ['multiplication', 'addition'], true);
    }

    /**
     * Valide un score (entier entre 0 et 10).
     */
    public static function score(mixed $score): bool
    {
        return is_int($score) && $score >= 0 && $score <= 10;
    }
}
