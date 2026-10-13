<?php

declare(strict_types=1);

/**
 * initialize.php — Initialisation de la base SQLite et création du 1er administrateur.
 *
 * Usage CLI :
 *   php scripts/initialize.php
 *
 * Comportement :
 *  - crée le schéma SQLite s'il est absent (via Database) ;
 *  - signale explicitement si WAL n'est PAS actif ;
 *  - crée le compte administrateur initial (login "admin", email "admin@fake.fr",
 *    rôle "admin") uniquement s'il n'existe pas déjà ;
 *  - le mot de passe est SAISI interactivement, en mode silencieux, et n'est
 *    JAMAIS stocké ni affiché en clair (haché Argon2id côté application).
 *
 * Le script REFUSE de recréer/écraser un administrateur déjà existant.
 */

require dirname(__DIR__) . '/src/bootstrap.php';

final class InitializerCLI
{
    public function run(): int
    {
        $root = CALC_TRAINER_ROOT;

        echo "\n=== Mission Calcul Mental — Initialisation (v12) ===\n\n";

        // 1. Prérequis PHP.
        if (PHP_VERSION_ID < 80200) {
            $this->fail("PHP 8.2 minimum requis (actuel : " . PHP_VERSION . ").");
        }
        if (!extension_loaded('pdo_sqlite') || !extension_loaded('sqlite3')) {
            $this->fail("Extensions manquantes : pdo_sqlite / sqlite3.");
        }
        if (!in_array(PASSWORD_ARGON2ID, password_algos(), true)) {
            $this->fail("L'algorithme Argon2id n'est pas disponible (password_algos).");
        }

        // 2. Base SQLite.
        echo "Création/ouverture de la base SQLite...\n";
        $db = new Database($root);
        echo "  Fichier : " . $db->path() . "\n";
        if ($db->isWalActive()) {
            echo "  Mode WAL : ACTIF ✓\n";
        } else {
            // Signalement explicite, sans masquer le problème.
            echo "  MODE WAL : INACTIF ⚠ (l'environnement ne le permet pas ; "
               . "le mode journal par défaut est utilisé).\n";
        }

        // 3. Premier administrateur.
        echo "\nCréation du premier administrateur (si absent)...\n";
        $repo = new UserRepository($db->pdo());
        $existing = $repo->findByLogin('admin');
        if ($existing !== null && strtolower((string)$existing['login']) === 'admin') {
            $this->failRefuse(
                "Un administrateur 'admin' existe déjà (id #" . $existing['id'] . "). "
                . "Refus de recréer/écraser un compte existant. Aucune modification effectuée."
            );
        }

        // 4. Saisie sécurisée du mot de passe.
        $password = $this->readSecret("Mot de passe initial de l'administrateur (min. 10 caractères) : ");
        if (strlen($password) < 10) {
            $this->fail("Le mot de passe doit comporter au moins 10 caractères. Aucun compte créé.");
        }

        $userId = $repo->create([
            'login'        => 'admin',
            'email'        => 'admin@fake.fr',
            'password'     => $password,
            'role'         => 'admin',
        ]);

        echo "\n✔ Administrateur initial créé (id #" . $userId . ").\n";
        echo "  Login  : admin\n";
        echo "  E-mail : admin@fake.fr\n";
        echo "  Rôle   : admin\n";
        echo "  Le mot de passe n'est pas stocké en clair (empreinte Argon2id en base).\n\n";
        echo "Initialisation terminée avec succès.\n";

        return 0;
    }

    /** Lit une saisie en masquant les caractères (système POSIX / macOS). */
    private function readSecret(string $prompt): string
    {
        echo $prompt;
        // On masque la saisie via stty -echo (POSIX / macOS). Fallback si indisponible.
        $sttyBin = trim((string)shell_exec('command -v stty 2>/dev/null'));
        $masked = ($sttyBin !== '');
        if ($masked) {
            shell_exec('stty -echo 2>/dev/null');
        }
        $line = fgets(STDIN);
        if ($line === false) {
            $line = '';
        }
        if ($masked) {
            shell_exec('stty echo 2>/dev/null');
            echo "\n";
        }
        return rtrim($line, "\r\n");
    }

    private function fail(string $message): never
    {
        fwrite(STDERR, "ERREUR : $message\n");
        exit(1);
    }

    private function failRefuse(string $message): never
    {
        fwrite(STDERR, "\n" . $message . "\n");
        exit(2);
    }
}

$cli = new InitializerCLI();
exit($cli->run());
