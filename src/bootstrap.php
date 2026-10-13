<?php

declare(strict_types=1);

/**
 * bootstrap — Constantes de chemins et autoload léger du projet.
 *
 * Chargé par l'API (public/api/index.php) et par les scripts CLI.
 * Ne contient aucun secret ; définit uniquement la racine et le chargement.
 */

if (!defined('CALC_TRAINER_ROOT')) {
    define('CALC_TRAINER_ROOT', dirname(__DIR__));
}

const CALC_TRAINER_SRC = CALC_TRAINER_ROOT . '/src';
const CALC_TRAINER_STORAGE = CALC_TRAINER_ROOT . '/storage';

/**
 * Autoload très simple (aucune dépendance) : mappe une classe au fichier
 * src/<NomDeClasse>.php.
 */
spl_autoload_register(static function (string $class): void {
    // Restreint l'autoload aux classes de notre application (sans namespace).
    if (str_contains($class, '\\')) {
        return;
    }
    $file = CALC_TRAINER_SRC . '/' . $class . '.php';
    if (is_file($file)) {
        require $file;
    }
});
