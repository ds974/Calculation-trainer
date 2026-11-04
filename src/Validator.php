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
     * Valide le type de questions d'un résultat (v12.3).
     *
     * @return true si le type est valide (classic | hole | mixed).
     */
    public static function questionType(string $questionType): bool
    {
        return in_array($questionType, ['classic', 'hole', 'mixed'], true);
    }

    /**
     * Normalise une valeur d'activation de compte en booléen strict.
     * Accepte true/false (bool), 1/0 (int) et leurs formes numériques en chaîne.
     *
     * @return bool|null true/false si valide, null sinon.
     */
    public static function active(mixed $value): ?bool
    {
        if (is_bool($value)) {
            return $value;
        }
        if (is_int($value)) {
            return $value === 1 ? true : ($value === 0 ? false : null);
        }
        if (is_string($value)) {
            $v = strtolower(trim($value));
            if (in_array($v, ['1', 'true', 'on', 'yes'], true)) {
                return true;
            }
            if (in_array($v, ['0', 'false', 'off', 'no'], true)) {
                return false;
            }
        }
        return null;
    }

    /**
     * Valide un score (entier entre 0 et 10).
     */
    public static function score(mixed $score): bool
    {
        return is_int($score) && $score >= 0 && $score <= 10;
    }

    /** Borne supérieure raisonnable d'une durée de partie, en millisecondes (30 min). */
    public const MAX_DURATION_MS = 1_800_000;

    /** Bornes des tables de multiplication : 1 à 10. */
    public const MULT_TABLE_MIN = 1;
    public const MULT_TABLE_MAX = 10;
    public const MAX_MULT_TABLES = 10;

    /** Bornes d'une plage d'additions : 1 à 99. */
    public const ADD_RANGE_MIN = 1;
    public const ADD_RANGE_MAX = 99;

    /**
     * Valide la description des tables utilisées d'une partie (v12.8.1-B3).
     *
     * Deux formes acceptées, selon le mode de jeu :
     *  - multiplication : tableau d'entiers uniques entre 1 et 10 (par ex. [1,2,5]) ;
     *  - addition : objet {"min":int, "max":int} avec 1 <= min <= max <= 99.
     *
     * `null` est accepté uniquement comme « information non renseignée » (l'absence
     * est décidée par l'appelant). Toute autre valeur (chaîne arbitraire, booléen,
     * valeurs hors bornes, tableau mixte, doublons, tableau associatif) est rejetée.
     *
     * @param mixed  $value valeur brute transmise (jamais pré-castée).
     * @param string $mode  'multiplication' | 'addition'.
     * @return true si la valeur est une description de tables valide.
     */
    public static function tables(mixed $value, string $mode): bool
    {
        if ($value === null) {
            return true;
        }
        if ($mode === 'addition') {
            if (!is_array($value) || !array_key_exists('min', $value) || !array_key_exists('max', $value)) {
                return false;
            }
            $min = $value['min'];
            $max = $value['max'];
            return is_int($min) && is_int($max)
                && $min >= self::ADD_RANGE_MIN && $max <= self::ADD_RANGE_MAX
                && $min <= $max;
        }
        // multiplication : tableau d'entiers uniques dans [1,10].
        if (!is_array($value)) {
            return false;
        }
        $seen = [];
        foreach ($value as $n) {
            if (!is_int($n) || $n < self::MULT_TABLE_MIN || $n > self::MULT_TABLE_MAX) {
                return false;
            }
            $seen[$n] = true;
        }
        // Clés strictement séquentielles (0..n-1) : un tableau associatif est rejeté.
        return count($seen) <= self::MAX_MULT_TABLES
            && array_keys($value) === range(0, count($value) - 1);
    }

    /**
     * Normalise une description de tables validée en chaîne JSON canonique stable.
     *
     * - multiplication : tableau trié et dédupliqué d'entiers (ex. `[1,2,5]`).
     * - addition : objet {"min":..,"max":..} (ex. `{"min":1,"max":10}`).
     * - null (information absente) : renvoie null — jamais de JSON d'absence.
     *
     * À n'appeler qu'après validation (comportement indéfini sinon).
     *
     * @return string|null chaîne JSON canonique, ou null si information absente.
     */
    public static function normalizeTables(mixed $value, string $mode): ?string
    {
        if ($value === null) {
            return null;
        }
        if ($mode === 'addition') {
            return json_encode([
                'min' => (int)$value['min'],
                'max' => (int)$value['max'],
            ], JSON_THROW_ON_ERROR);
        }
        $numbers = [];
        foreach ($value as $n) {
            $numbers[(int)$n] = true;
        }
        $sorted = array_keys($numbers);
        sort($sorted, SORT_NUMERIC);
        return json_encode($sorted, JSON_THROW_ON_ERROR);
    }

    /**
     * Décode une chaîne JSON de tables stockée en base en structure PHP publique.
     *
     * @return array<int,int>|array{min:int,max:int}|null tableau de tables (multiplication),
     *                        objet plage (addition), ou null si information absente/corrompue.
     */
    public static function decodeTables(?string $json): array|null
    {
        if ($json === null || trim($json) === '') {
            return null;
        }
        $decoded = json_decode($json, true);
        return is_array($decoded) ? $decoded : null;
    }

    /**
     * Valide une durée de partie en millisecondes (v12.8-B2).
     *
     * Une durée valide est un ENTIER STRICTEMENT POSITIF ne dépassant pas
     * MAX_DURATION_MS. Les valeurs NULL, décimales, chaînes arbitraires,
     * booléens, négatives, nulles ou démesurées sont rejetées. NULL représente
     * une durée inconnue (anciennes parties) et se décide au niveau de l'appelant.
     *
     * @return true si durée valide.
     */
    public static function durationMs(mixed $value): bool
    {
        return is_int($value) && $value > 0 && $value <= self::MAX_DURATION_MS;
    }

    /** Les six catégories de niveau scolaire déclarables (v12.8-B3.1). */
    public const SCHOOL_LEVELS = [
        'preschool',
        'elementary_lower',
        'elementary_upper',
        'middle_school',
        'high_school',
        'higher_adult',
    ];

    /**
     * Valide une valeur de niveau scolaire (v12.8-B3.1).
     *
     * Une valeur est acceptée si :
     *  - elle vaut `null` (profil « Non renseigné » — l'absence de niveau s'exprime
     *    par NULL dans `users.school_level`, jamais par la chaîne 'unspecified') ; ou
     *  - c'est l'un des six identifiants stables (indépendants des traductions).
     *
     * Les intitulés traduits (CP, CE1...), les valeurs arbitraires, les booléens,
     * numériques, tableaux ou chaînes vides sont rejetés.
     *
     * @param mixed $value valeur brute transmise (réelle, jamais pré-castée en chaîne).
     * @return true si la valeur est un niveau valide (ou null pour « non renseigné »).
     */
    public static function schoolLevel(mixed $value): bool
    {
        if ($value === null) {
            return true;
        }
        if (!is_string($value)) {
            return false;
        }
        return in_array($value, self::SCHOOL_LEVELS, true);
    }

    /**
     * Renvoie la liste des six catégories de niveau scolaire déclarables.
     *
     * @return string[]
     */
    public static function allowedSchoolLevels(): array
    {
        return self::SCHOOL_LEVELS;
    }

    /**
     * Codes linguistiques canorisés acceptés par l'application (v12.6-C1).
     *
     * Une préférence linguistique ne peut être qu'une de ces valeurs exactes.
     * De simples codes régionaux tels que `en-US` ou `zh-CN` sont rigoureusement
     * refusés : c'est au client de normaliser les préférences du navigateur vers
     * ces codes canoniques avant transmission.
     *
     * @return true si le code est valide.
     */
    public static function language(string $language): bool
    {
        return in_array($language, ['fr', 'en', 'es', 'zh-Hans'], true);
    }

    /**
     * Renvoie la liste des codes linguistiques canorisés autorisés.
     *
     * @return string[]
     */
    public static function allowedLanguages(): array
    {
        return ['fr', 'en', 'es', 'zh-Hans'];
    }
}
