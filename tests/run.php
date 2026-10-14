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
        echo "\n=== Tests Mission Calcul Mental — Backend (étapes 1 et 2) ===\n\n";

        $this->testDatabasePragmas();
        $this->testSchemaAndUniqueness();
        $this->testPasswordHashing();
        $this->testInitialAdmin();

        // Étape 2 : authentification et gestion des comptes.
        $this->testRegister();
        $this->testLogin();
        $this->testProfileUpdates();
        $this->testAuthorization();
        $this->testCsrf();
        $this->testUnauthenticatedAccess();

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

    // --- Étape 2 : inscription ---

    private function testRegister(): void
    {
        echo "[Inscription]\n";
        try {
            // Session CLI propre pour les tests.
            if (session_status() !== PHP_SESSION_ACTIVE) {
                @session_start();
            }
            $_SESSION = [];

            $db = new Database($this->tmpRoot);
            $auth = new AuthService($db->pdo(), new UserRepository($db->pdo()));

            // Inscription valide.
            $u = $auth->register([
                'login'    => 'alice',
                'password' => 'unMotDePasseSûr123',
                'email'    => 'alice@example.com',
            ]);
            $this->check(($u['login'] ?? '') === 'alice', 'Inscription valide (compte créé)');
            $this->check(($u['role'] ?? '') === 'user', 'Rôle par défaut = user');
            $this->check(!isset($u['password_hash']), 'Empreinte mot de passe non exposée');

            // Identifiant déjà utilisé.
            try {
                $auth->register([
                    'login'    => 'Alice', // casse différente : doit être refusé
                    'password' => 'unAutreMdpSûr456',
                ]);
                $this->check(false, 'Refus des identifiants déjà utilisés');
            } catch (InvalidArgumentException) {
                $this->check(true, 'Refus des identifiants déjà utilisés');
            }

            // Mot de passe trop court.
            try {
                $auth->register(['login' => 'bob', 'password' => 'court']);
                $this->check(false, 'Refus des mots de passe trop courts');
            } catch (InvalidArgumentException) {
                $this->check(true, 'Refus des mots de passe trop courts');
            }

            // E-mail invalide.
            try {
                $auth->register([
                    'login' => 'charlie',
                    'password' => 'unMotDePasseSûr789',
                    'email' => 'pas-un-email',
                ]);
                $this->check(false, 'Refus d\'une adresse e-mail invalide');
            } catch (InvalidArgumentException) {
                $this->check(true, 'Refus d\'une adresse e-mail invalide');
            }

            // Login trop court.
            try {
                $auth->register(['login' => 'ab', 'password' => 'unMotDePasseSûr123']);
                $this->check(false, 'Refus d\'un login trop court');
            } catch (InvalidArgumentException) {
                $this->check(true, 'Refus d\'un login trop court');
            }
        } catch (Throwable $e) {
            $this->check(false, "Inscription : {$e->getMessage()}");
        }
    }

    // --- Étape 2 : connexion / déconnexion ---

    private function testLogin(): void
    {
        echo "[Connexion]\n";
        try {
            if (session_status() !== PHP_SESSION_ACTIVE) {
                @session_start();
            }
            $_SESSION = [];

            $db = new Database($this->tmpRoot);
            $repo = new UserRepository($db->pdo());
            $auth = new AuthService($db->pdo(), $repo);

            // Préparation.
            $auth->register([
                'login' => 'dave',
                'password' => 'unMotDePasseSûr123',
                'email' => '',
            ]);

            // Connexion avec le bon mot de passe.
            $connected = $auth->login('dave', 'unMotDePasseSûr123');
            $this->check(($connected['login'] ?? '') === 'dave', 'Connexion avec mot de passe correct');
            $this->check((int)($_SESSION['user_id'] ?? 0) > 0, 'Session créée après connexion');
            $this->check($auth->currentUser() !== null, 'Utilisateur courant accessible après connexion');

            // Déconnexion.
            $auth->logout();
            $this->check($auth->currentUser() === null, 'Déconnexion : session détruite');

            // Mot de passe incorrect.
            $before = $this->failureCount($db->pdo(), 'dave');
            $failMsg = '';
            try {
                $auth->login('dave', 'mauvaisMotDePasse');
                $this->check(false, 'Refus d\'une connexion avec mot de passe incorrect');
            } catch (RuntimeException $e) {
                $failMsg = $e->getMessage();
                $this->check(true, 'Refus d\'une connexion avec mot de passe incorrect');
            }
            $after = $this->failureCount($db->pdo(), 'dave');
            $this->check($after > $before, 'Tentative échouée enregistrée');

            // Login inexistant : message générique identique (ne révèle pas l\'existence).
            try {
                $auth->login('utilisateurInexistant', 'nimporteQuelMdp');
                $this->check(false, 'Message générique pour un compte inexistant');
            } catch (RuntimeException $e) {
                $this->check(
                    $e->getMessage() === $failMsg,
                    'Message identique (login inexistant / mauvais mot de passe)'
                );
            }
        } catch (Throwable $e) {
            $this->check(false, "Connexion : {$e->getMessage()}");
        }
    }

    private function failureCount(PDO $pdo, string $login): int
    {
        $stmt = $pdo->prepare(
            'SELECT COUNT(*) FROM login_attempts WHERE login = :login AND success = 0'
        );
        $stmt->execute(['login' => $login]);
        return (int)$stmt->fetchColumn();
    }

            

    // --- Étape 2 : modification profil et mot de passe ---

    private function testProfileUpdates(): void
    {
        echo "[Profil et mot de passe]\n";
        try {
            if (session_status() !== PHP_SESSION_ACTIVE) {
                @session_start();
            }
            $_SESSION = [];

            $db = new Database($this->tmpRoot);
            $repo = new UserRepository($db->pdo());
            $auth = new AuthService($db->pdo(), $repo);

            $u = $auth->register([
                'login' => 'erin',
                'password' => 'unMotDePasseSûr123',
                'email' => '',
            ]);
            $id = (int)$u['id'];

            // Modification de l'adresse e-mail.
            $auth->updateEmail($id, 'erin@example.org');
            $afterEmail = $repo->findById($id);
            $this->check(
                ($afterEmail['email'] ?? '') === 'erin@example.org',
                'Modification de l\'adresse e-mail'
            );

            // E-mail vide => réinitialisé à NULL.
            $auth->updateEmail($id, '');
            $afterEmpty = $repo->findById($id);
            $this->check((string)($afterEmpty['email'] ?? '') === '', 'E-mail peut être effacé');

            // E-mail invalide refusé.
            try {
                $auth->updateEmail($id, 'invalide');
                $this->check(false, 'Refus d\'un e-mail invalide lors d\'une modification');
            } catch (InvalidArgumentException) {
                $this->check(true, 'Refus d\'un e-mail invalide lors d\'une modification');
            }

            // Changement de mot de passe : ancien incorrect refusé.
            try {
                $auth->changePassword($id, 'mauvaisAncien', 'unNouveauMdp456');
                $this->check(false, 'Refus du changement sans l\'ancien mot de passe');
            } catch (RuntimeException) {
                $this->check(true, 'Refus du changement sans l\'ancien mot de passe');
            }

            // Changement valide.
            $auth->changePassword($id, 'unMotDePasseSûr123', 'unNouveauMdp456');
            $this->check(
                $repo->verifyPassword($repo->findById($id), 'unNouveauMdp456'),
                'Nouveau mot de passe actif après changement'
            );

            // Nouveau mot de passe trop court refusé.
            try {
                $auth->changePassword($id, 'unNouveauMdp456', 'court');
                $this->check(false, 'Refus d\'un nouveau mot de passe trop court');
            } catch (InvalidArgumentException) {
                $this->check(true, 'Refus d\'un nouveau mot de passe trop court');
            }
        } catch (Throwable $e) {
            $this->check(false, "Profil : {$e->getMessage()}");
        }
    }

    // --- Étape 2 : vérification des autorisations ---

    private function testAuthorization(): void
    {
        echo "[Autorisations]\n";
        try {
            $db = new Database($this->tmpRoot);
            $auth = new AuthService($db->pdo(), new UserRepository($db->pdo()));

            // Non authentifié => 401.
            $caught = null;
            try {
                $auth->requireAdmin(null);
            } catch (RuntimeException $e) {
                $caught = $e;
            }
            $this->check($caught !== null && $caught->getCode() === 401, 'Accès admin sans session => 401');

            // Utilisateur simple => 403.
            $caught = null;
            try {
                $auth->requireAdmin(['role' => 'user']);
            } catch (RuntimeException $e) {
                $caught = $e;
            }
            $this->check($caught !== null && $caught->getCode() === 403, 'Utilisateur simple => 403');

            // Administrateur => autorisé (aucune exception).
            $caught = null;
            try {
                $auth->requireAdmin(['role' => 'admin']);
            } catch (RuntimeException $e) {
                $caught = $e;
            }
            $this->check($caught === null, 'Administrateur autorisé');
        } catch (Throwable $e) {
            $this->check(false, "Autorisations : {$e->getMessage()}");
        }
    }

    // --- Étape 2 : protection CSRF ---

    private function testCsrf(): void
    {
        echo "[Protection CSRF]\n";
        try {
            if (session_status() !== PHP_SESSION_ACTIVE) {
                @session_start();
            }
            $_SESSION = [];

            $token = Security::csrfToken();
            $this->check($token !== '', 'Jeton CSRF généré');
            $this->check(Security::verifyCsrf($token), 'Jeton CSRF valide accepté');
            $this->check(!Security::verifyCsrf('trop-long-jeton-incorrect'), 'Jeton CSRF invalide refusé');
            $this->check(!Security::verifyCsrf(''), 'Jeton CSRF vide refusé');
        } catch (Throwable $e) {
            $this->check(false, "CSRF : {$e->getMessage()}");
        }
    }

    // --- Étape 2 : refus des accès non authentifiés (currentUser) ---

    private function testUnauthenticatedAccess(): void
    {
        echo "[Accès non authentifié]\n";
        try {
            if (session_status() !== PHP_SESSION_ACTIVE) {
                @session_start();
            }
            $_SESSION = [];

            $db = new Database($this->tmpRoot);
            $auth = new AuthService($db->pdo(), new UserRepository($db->pdo()));

            $this->check($auth->currentUser() === null, 'currentUser() renvoie null sans session');
        } catch (Throwable $e) {
            $this->check(false, "Accès non authentifié : {$e->getMessage()}");
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
