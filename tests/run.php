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
        echo "\n=== Tests Mission Calcul Mental — Backend (étapes 1, 2 et 3) ===\n\n";

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
        $this->testEmailMigration();

        // Étape 3 : enregistrement des résultats, historique et import invité.
        $this->testResultSave();
        $this->testResultValidation();
        $this->testResultAuth();
        $this->testResultHistoryIsolation();
        $this->testGuestImport();
        $this->testGuestImportDuplicate();
        $this->testGuestImportMalformed();

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
                'password' => 'motdepasse10',
                'role' => 'user',
            ]);
            $this->check($id1 > 0, 'Création d\'un utilisateur (id #' . $id1 . ')');

            // Unicité insensible à la casse : "testuser" doit être refusé.
            try {
                $repo->create([
                    'login' => 'testuser', // casse différente
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
                'password' => 'adminmotdepasse123',
                'role' => 'admin',
            ]);
            $this->check($id > 0, 'Création du compte admin initial');

            // Refus de recréer un admin existant : l'unicité doit lever une exception.
            try {
                $repo->create([
                    'login' => 'admin',
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

            // Inscription valide, sans e-mail.
            $u = $auth->register([
                'login'    => 'alice',
                'password' => 'unMotDePasseSûr123',
            ]);
            $this->check(($u['login'] ?? '') === 'alice', 'Inscription valide sans e-mail (compte créé)');
            $this->check(($u['role'] ?? '') === 'user', 'Rôle par défaut = user');
            $this->check(!isset($u['password_hash']), 'Empreinte mot de passe non exposée');
            $this->check(!array_key_exists('email', $u), 'Réponse d\'inscription sans champ e-mail');

            // Un ancien client transmet encore un e-mail : il doit être IGNORÉ
            // (compte créé, mais aucun e-mail stocké).
            $legacy = $auth->register([
                'login'    => 'legacy_user',
                'password' => 'unMotDePasseSûr456',
                'email'    => 'legacy@example.com', // champ résiduel non géré
            ]);
            $this->check(($legacy['login'] ?? '') === 'legacy_user', 'Inscription avec e-mail transmis : compte créé');
            $this->check(!array_key_exists('email', $legacy), 'Aucun e-mail dans la réponse (champ ignoré)');
            $legacyRow = (new UserRepository($db->pdo()))->findByLogin('legacy_user');
            $this->check(
                $legacyRow !== null && $legacyRow['email'] === null,
                'Inscription avec e-mail transmis : e-mail non stocké (colonne NULL)'
            );

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

            // Un ancien client transmet un e-mail invalide : comme l'e-mail est
            // entièrement ignoré, l'inscription doit quand même réussir.
            $charlie = $auth->register([
                'login'    => 'charlie',
                'password' => 'unMotDePasseSûr789',
                'email'    => 'pas-un-email',
            ]);
            $this->check(($charlie['login'] ?? '') === 'charlie', 'E-mail invalide transmis ignoré : inscription réussie');
            $charlieRow = (new UserRepository($db->pdo()))->findByLogin('charlie');
            $this->check(
                $charlieRow !== null && $charlieRow['email'] === null,
                'E-mail invalide transmis : non stocké (colonne NULL)'
            );

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
            ]);
            $id = (int)$u['id'];

            // L'e-mail n'est plus modifiable : le service ne doit exposer aucune
            // méthode de modification d'e-mail (la route API correspondante a été retirée).
            $this->check(
                !method_exists(AuthService::class, 'updateEmail'),
                'Aucune méthode de modification d\'e-mail exposée par le service'
            );
            $afterReg = $repo->findById($id);
            $this->check(
                $afterReg !== null && $afterReg['email'] === null,
                'Inscription sans e-mail : colonne email à NULL'
            );

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

    // --- Étape 2 : migration de suppression des e-mails (non destructive) ---

    private function testEmailMigration(): void
    {
        echo "[Migration e-mails]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $results = new ResultService($pdo, new ResultRepository($pdo));

            // On simule une base pré-existante contenant un e-mail et un résultat.
            $id = $repo->create([
                'login'    => 'mig_user',
                'password' => 'motdepasse10',
                'role'     => 'user',
            ]);
            // Réinjecte un e-mail comme s'il datait d'avant la migration.
            $pdo->prepare('UPDATE users SET email = :email WHERE id = :id')
                ->execute(['email' => 'mig@example.fr', 'id' => $id]);
            $hashBefore = (string)$pdo->query("SELECT password_hash FROM users WHERE id = {$id}")->fetchColumn();
            $roleBefore = (string)$pdo->query("SELECT role FROM users WHERE id = {$id}")->fetchColumn();
            $results->save($id, 'multiplication', 8);

            // Première exécution de la migration.
            $pdo->exec('UPDATE users SET email = NULL WHERE email IS NOT NULL');

            $row = $pdo->query("SELECT * FROM users WHERE id = {$id}")->fetch();
            $this->check($row !== false, 'Utilisateur conservé après migration');
            $this->check($row['email'] === null, 'E-mail effacé après migration (colonne NULL)');
            $this->check((string)$row['role'] === $roleBefore, 'Rôle préservé après migration');
            $this->check((string)$row['password_hash'] === $hashBefore, 'Mot de passe haché préservé après migration');
            $this->check(
                (int)$pdo->query("SELECT COUNT(*) FROM results WHERE user_id = {$id}")->fetchColumn() === 1,
                'Résultats conservés après migration'
            );

            // Seconde exécution : la migration doit rester idempotente et sans erreur.
            $pdo->exec('UPDATE users SET email = NULL WHERE email IS NOT NULL');
            $row2 = $pdo->query("SELECT email FROM users WHERE id = {$id}")->fetch();
            $this->check($row2 !== false && $row2['email'] === null, 'Migration ré-exécutable sans erreur (idempotente)');
        } catch (Throwable $e) {
            $this->check(false, "Migration e-mails : {$e->getMessage()}");
        }
    }

    // --- Étape 3 : enregistrement d'un résultat valide ---

    private function testResultSave(): void
    {
        echo "[Enregistrement des résultats]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $results = new ResultService($pdo, new ResultRepository($pdo));

            $id = $repo->create([
                'login' => 'save_user',
                'password' => 'motdepasse10', 'role' => 'user',
            ]);

            $rid = $results->save($id, 'multiplication', 9);
            $this->check($rid > 0, 'Enregistrement d\'un résultat valide (multiplication, 9/10)');

            $rid2 = $results->save($id, 'addition', 7, '2026-01-15T10:20:30Z');
            $this->check($rid2 > 0, 'Enregistrement avec date de fin UTC explicite');

            $history = $results->history($id);
            $this->check(count($history) === 2, 'Historique contient 2 parties');
            $row = $history[0];
            $this->check(
                ($row['score'] ?? -1) === 9 && ($row['mode'] ?? '') === 'multiplication',
                'Historique ordonné (plus récent d\'abord) et champs corrects'
            );
            $this->check(!isset($row['user_id']), 'Historique sans données sensibles (user_id non exposé)');
        } catch (Throwable $e) {
            $this->check(false, "Enregistrement : {$e->getMessage()}");
        }
    }

    // --- Étape 3 : validation des modes et scores ---

    private function testResultValidation(): void
    {
        echo "[Validation des résultats]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $results = new ResultService($pdo, new ResultRepository($pdo));
            $id = $repo->create([
                'login' => 'val_user',
                'password' => 'motdepasse10', 'role' => 'user',
            ]);

            $rejected = 0;
            $attempts = [
                ['mode' => 'soustraction', 'score' => 8],
                ['mode' => 'multiplication', 'score' => 11],
                ['mode' => 'multiplication', 'score' => -1],
                ['mode' => 'multiplication', 'score' => 3, 'played_at' => 'pas-une-date'],
            ];
            foreach ($attempts as $a) {
                try {
                    $results->save($id, $a['mode'], $a['score'], $a['played_at'] ?? null);
                } catch (InvalidArgumentException) {
                    $rejected++;
                }
            }
            $this->check($rejected === count($attempts), 'Refus des modes et scores invalides');
            $this->check(count($results->history($id)) === 0, 'Aucun résultat invalide persistant');
        } catch (Throwable $e) {
            $this->check(false, "Validation : {$e->getMessage()}");
        }
    }

    // --- Étape 3 : refus d'accès sans authentification (niveau service) ---

    private function testResultAuth(): void
    {
        echo "[Autorisation des résultats]\n";
        try {
            if (session_status() !== PHP_SESSION_ACTIVE) {
                @session_start();
            }
            $_SESSION = [];

            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $results = new ResultService($pdo, new ResultRepository($pdo));
            $auth = new AuthService($pdo, $repo);

            // Sans session : currentUser() = null => l'API répondra 401.
            $this->check($auth->currentUser() === null, 'Enregistrement refusé sans authentification (pas de session)');
        } catch (Throwable $e) {
            $this->check(false, "Autorisation résultats : {$e->getMessage()}");
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

    // --- Étape 3 : isolation de l'historique entre utilisateurs ---

    private function testResultHistoryIsolation(): void
    {
        echo "[Historique et isolation]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $results = new ResultService($pdo, new ResultRepository($pdo));

            $a = $repo->create(['login' => 'hist_a', 'password' => 'motdepasse10', 'role' => 'user']);
            $b = $repo->create(['login' => 'hist_b', 'password' => 'motdepasse10', 'role' => 'user']);

            $results->save($a, 'multiplication', 10);
            $results->save($a, 'addition', 6);

            $this->check(count($results->history($a)) === 2, 'A consulte son propre historique (2 parties)');
            $this->check(count($results->history($b)) === 0, 'B ne consulte pas l\'historique de A');
        } catch (Throwable $e) {
            $this->check(false, "Historique/isolation : {$e->getMessage()}");
        }
    }

    // --- Étape 3 : import invité valide ---

    private function testGuestImport(): void
    {
        echo "[Import invité]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $results = new ResultService($pdo, new ResultRepository($pdo));
            $id = $repo->create(['login' => 'guest_imp', 'password' => 'motdepasse10', 'role' => 'user']);

            $items = [
                ['guest_id' => 'v12-aaa111', 'mode' => 'multiplication', 'score' => 8, 'played_at' => '2026-01-10T08:00:00Z'],
                ['guest_id' => 'v12-bbb222', 'mode' => 'addition', 'score' => 4, 'played_at' => '2026-01-11T09:30:00Z'],
                ['guest_id' => 'v12-ccc333', 'mode' => 'multiplication', 'score' => 10, 'played_at' => '2026-01-12T10:00:00Z'],
            ];
            $out = $results->importGuest($id, $items);
            $this->check($out['imported'] === 3 && $out['skipped'] === 0, 'Import invité valide (3 importées, 0 sautées)');
            $this->check(count($results->history($id)) === 3, 'Import : 3 parties ajoutées à l\'historique');
        } catch (Throwable $e) {
            $this->check(false, "Import invité : {$e->getMessage()}");
        }
    }

    // --- Étape 3 : idempotence de l'import (doublons) ---

    private function testGuestImportDuplicate(): void
    {
        echo "[Import invité — idempotence]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $results = new ResultService($pdo, new ResultRepository($pdo));
            $id = $repo->create(['login' => 'guest_dup', 'password' => 'motdepasse10', 'role' => 'user']);

            $items = [
                ['guest_id' => 'v12-ddd444', 'mode' => 'multiplication', 'score' => 9, 'played_at' => '2026-02-01T08:00:00Z'],
            ];
            $first = $results->importGuest($id, $items);
            $second = $results->importGuest($id, $items); // réessai : même guest_id

            $this->check($first['imported'] === 1, 'Premier envoi : 1 partie importée');
            $this->check($second['imported'] === 0 && $second['skipped'] === 1, 'Réessai : 0 importée, doublon refusé');
            $this->check(count($results->history($id)) === 1, 'Aucun doublon dans l\'historique après réessai');
        } catch (Throwable $e) {
            $this->check(false, "Import doublons : {$e->getMessage()}");
        }
    }

    // --- Étape 3 : rejet des données d'import malformées ---

    private function testGuestImportMalformed(): void
    {
        echo "[Import invité — données malformées]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $results = new ResultService($pdo, new ResultRepository($pdo));
            $id = $repo->create(['login' => 'guest_bad', 'password' => 'motdepasse10', 'role' => 'user']);

            // Structure globale invalide (liste associative non indexée).
            try {
                $results->importGuest($id, ['x' => 'y']);
                $this->check(false, 'Structure globale non-listée refusée');
            } catch (InvalidArgumentException) {
                $this->check(true, 'Structure globale non-listée refusée');
            }

            // Lignes individuellement malformées : ignorées, aucune écriture.
            $bad = [
                ['guest_id' => 'v12-bad1', 'mode' => 'inconnu', 'score' => 5, 'played_at' => '2026-03-01T08:00:00Z'],
                ['guest_id' => 'v12-bad2', 'mode' => 'multiplication', 'score' => 99, 'played_at' => '2026-03-01T08:00:00Z'],
                ['guest_id' => 'v12-bad3', 'mode' => 'multiplication', 'score' => 5, 'played_at' => '2026-03-0108:00'],
                ['guest_id' => 'v12-bad4<b>', 'mode' => 'multiplication', 'score' => 5, 'played_at' => '2026-03-01T08:00:00Z'],
            ];
            $out = $results->importGuest($id, $bad);
            $this->check($out['imported'] === 0 && $out['skipped'] === 4, 'Données malformées toutes sautées (0 importée)');
            $this->check(count($results->history($id)) === 0, 'Aucune donnée malformée persistée');
        } catch (Throwable $e) {
            $this->check(false, "Import malformé : {$e->getMessage()}");
        }
    }
}
$runner = new TestRunner();
exit($runner->run());
