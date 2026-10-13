<?php

declare(strict_types=1);

/**
 * run.php — Mini-framework de tests CLI (aucune dépendance).
 *
 * Usage :
 *   php tests/run.php
 *
 * Chaque test lance des vérifications sur une base SQLite temporaire
 * (répertoire /tmp dédié) afin de ne pas toucher à la base de production.
 * Aucun test n'est déclaré réussi s'il n'a pas été réellement exécuté.
 */

require dirname(__DIR__) . '/src/bootstrap.php';

final class TestRunner
{
    private int $passed = 0;
    private int $failed = 0;
    private array $failures = [];
    private string $tmpRoot;

    public function __construct()
    {
        $this->tmpRoot = sys_get_temp_dir() . '/calc_trainer_tests_' . getmypid();
        if (!is_dir($this->tmpRoot)) {
            mkdir($this->tmpRoot, 0775, true);
        }
    }

    public function run(): int
    {
        echo "\n=== Tests Mission Calcul Mental — Backend (étape 1) ===\n\n";

        $this->testDatabasePragmas();
        $this->testSchemaAndUniqueness();
        $this->testPasswordHashing();
        $this->testInitialAdmin();

        echo "\n=== Résumé ===\n";
        echo "Tests réussis : {$this->passed}\n";
        echo "Tests échoués : {$this->failed}\n";
        foreach ($this->failures as $f) {
            echo "  ✗ {$f}\n";
        }
        echo "\n";

        // Nettoyage du répertoire temporaire.
        $this->cleanup();

        return $this->failed === 0 ? 0 : 1;
    }

    private function check(bool $cond, string $label): void
    {
        if ($cond) {
            $this->passed++;
            echo "  ✓ {$label}\n";
        } else {
            $this->failed++;
            $this->failures[] = $label;
            echo "  ✗ {$label}\n";
        }
    }

    // --- Tests : PRAGMA et connexion ---

    private function testDatabasePragmas(): void
    {
        echo "[PRAGMA et connexion]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();

            // foreign_keys activées ?
            $fk = (int)$pdo->query('PRAGMA foreign_keys')->fetchColumn();
            $this->check($fk === 1, 'PRAGMA foreign_keys est activé');

            // busy_timeout configuré à 5000 ms ?
            $bt = (int)$pdo->query('PRAGMA busy_timeout')->fetchColumn();
            $this->check($bt === 5000, 'PRAGMA busy_timeout = 5000');

            // WAL : on journalise l'état réel (peut être inactif selon le FS).
            echo "  ℹ Mode WAL actif : " . ($db->isWalActive() ? 'oui' : 'non') . "\n";

            $this->check(true, 'Connexion PDO SQLite établie');
        } catch (Throwable $e) {
            $this->check(false, "Connexion PDO SQLite : {$e->getMessage()}");
        }
    }

    // --- Tests : schéma et unicité des logins ---

    private function testSchemaAndUniqueness(): void
    {
        echo "[Schéma et unicité des logins]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);

            // Les tables existent.
            $tables = $pdo->query(
                "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('users','results')"
            )->fetchAll(PDO::FETCH_COLUMN);
            $this->check(count($tables) === 2, 'Tables users et results créées');

            // Création du premier utilisateur.
            $id1 = $repo->create([
                'login' => 'TestUser',
                'email' => 't@example.fr',
                'password' => 'motdepasse10',
                'role' => 'user',
            ]);
            $this->check($id1 > 0, 'Création d\'un utilisateur (id #' . $id1 . ')');

            // Unicité insensible à la casse : "testuser" doit être refusé.
            try {
                $repo->create([
                    'login' => 'testuser', // casse différente
                    'email' => '',
                    'password' => 'autremotdepasse10',
                    'role' => 'user',
                ]);
                $this->check(false, 'Unicité login insensible à la casse (doublon refusé)');
            } catch (RuntimeException) {
                $this->check(true, 'Unicité login insensible à la casse (doublon refusé)');
            }

            // findByLogin insensible à la casse via requête préparée.
            $stmt = $pdo->prepare('SELECT COUNT(*) FROM users WHERE login = :l');
            $stmt->execute(['l' => 'TESTUSER']);
            $this->check((int)$stmt->fetchColumn() === 1, 'findByLogin insensible à la casse');

        } catch (Throwable $e) {
            $this->check(false, "Schéma/unicité : {$e->getMessage()}");
        }
    }

    // --- Tests : hachage Argon2id ---

    private function testPasswordHashing(): void
    {
        echo "[Hachage et vérification Argon2id]\n";
        try {
            $db = new Database($this->tmpRoot);
            $repo = new UserRepository($db->pdo());
            $id = $repo->create([
                'login' => 'hashme',
                'email' => '',
                'password' => 'monsecret012345',
                'role' => 'user',
            ]);
            $user = $repo->findById($id);

            // L'empreinte doit être un hash Argon2id : commence par "$argon2id$".
            $hash = (string)$user['password_hash'];
            $this->check(str_starts_with($hash, '$argon2id$'), 'Empreinte au format Argon2id');

            // Le mot de passe en clair ne doit pas être stocké.
            $this->check($hash !== 'monsecret012345', 'Le mot de passe en clair n\'est pas stocké');

            // Vérification correcte / incorrecte.
            $this->check($repo->verifyPassword($user, 'monsecret012345'), 'password_verify (mot de passe correct)');
            $this->check(!$repo->verifyPassword($user, 'mauvais'), 'password_verify (mot de passe incorrect)');

        } catch (Throwable $e) {
            $this->check(false, "Hachage : {$e->getMessage()}");
        }
    }

    // --- Tests : premier administrateur ---

    private function testInitialAdmin(): void
    {
        echo "[Premier administrateur]\n";
        try {
            $db = new Database($this->tmpRoot);
            $repo = new UserRepository($db->pdo());

            $id = $repo->create([
                'login' => 'admin',
                'email' => 'admin@fake.fr',
                'password' => 'adminmotdepasse123',
                'role' => 'admin',
            ]);
            $this->check($id > 0, 'Création du compte admin initial');

            // Refus de recréer un admin existant : l'unicité doit lever une exception.
            try {
                $repo->create([
                    'login' => 'admin',
                    'email' => 'autre@fake.fr',
                    'password' => 'unautremotdepasse123',
                    'role' => 'admin',
                ]);
                $this->check(false, 'Refus de recréer un administrateur existant');
            } catch (RuntimeException) {
                $this->check(true, 'Refus de recréer un administrateur existant');
            }
        } catch (Throwable $e) {
            $this->check(false, "Admin : {$e->getMessage()}");
        }
    }

    private function cleanup(): void
    {
        $files = glob($this->tmpRoot . '/*');
        if (is_array($files)) {
            foreach ($files as $f) {
                @unlink($f);
            }
        }
        @rmdir($this->tmpRoot);
    }
}

$runner = new TestRunner();
exit($runner->run());
