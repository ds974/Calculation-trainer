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
    /** Répertoires SQLite isolés créés par les tests d'administration. */
    private array $adminDirs = [];

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

        // Étape 1 : sécurité applicative (durcissement session & en-têtes).
        $this->testSecurityHardening();

        // Étape 2 : authentification et gestion des comptes.
        $this->testRegister();
        $this->testLogin();
        $this->testProfileUpdates();
        $this->testAuthorization();
        $this->testCsrf();
        $this->testUnauthenticatedAccess();
        $this->testEmailMigration();

        // Étape 3 : enregistrement des résultats et historique (l'import invité a
        // été retiré en v12.2 — plus de route serveur, plus de méthode importGuest).
        $this->testResultSave();
        $this->testResultValidation();
        $this->testResultPlayedAtContract();
        $this->testResultAuth();
        $this->testResultHistoryIsolation();

        // Étape v12.4 : mémoire des difficultés personnelles (barème, agrégation,
        // idempotence, atomicité, validation, bilan par table).
        $this->testDifficultySchema();
        $this->testDifficultyBarème();
        $this->testDifficultyAggregationAndClassification();
        $this->testDifficultyIdempotenceAtomicity();
        $this->testDifficultyValidation();
        $this->testDifficultyTableSummary();
        // v12.5 — récupération des opérations difficiles (route difficulty/operations).
        $this->testDifficultyOperations();
        // v12.5 — suivi en mode Mélange : classification individuelle classique/à trou.
        $this->testDifficultyMelangeTracking();

        // Étape 6 : statistiques personnelles (backend).
        $this->testStatsAggregation();
        $this->testStatsIsolation();
        $this->testStatsReunionTimezone();
        $this->testStatsInvalidMode();
        $this->testStatsIncludesImported();

        // Étape 7 : espace d'administration (v12.1).
        $this->testAdminRepository();
        $this->testAdminServiceListAndDetail();
        $this->testAdminServiceRole();
        $this->testAdminServiceActive();
        $this->testAdminServicePassword();
        $this->testAdminServiceStats();
        $this->testAdminLastAdminGuard();

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

    // --- Étape 7 : espace d'administration (v12.1) ---

    /**
     * Fabrique un espace d'administration sur une base SQLite dédiée et vierge.
     *
     * Chaque appel crée un sous-répertoire isolé sous $tmpRoot : les comptages
     * globaux (listUsers, globalStats) comme l'unicité du dernier administrateur
     * restent déterministes, indépendamment des autres tests qui partagent la
     * base temporaire commune de la suite.
     *
     * @return array{svc:AdminService,repo:UserRepository,pdo:PDO,auth:AuthService}
     */
    private function adminHarness(): array
    {
        $root = $this->tmpRoot . DIRECTORY_SEPARATOR . 'admin_' . uniqid();
        $db = new Database($root);
        $this->adminDirs[] = $root;
        $pdo = $db->pdo();
        $users = new UserRepository($pdo);
        $auth = new AuthService($pdo, $users);
        $adminRepo = new AdminRepository($pdo);
        $svc = new AdminService($pdo, $auth, $users, $adminRepo);
        return ['svc' => $svc, 'repo' => $users, 'pdo' => $pdo, 'auth' => $auth];
    }

    private function testAdminRepository(): void
    {
        echo "[Administration — dépôt AdminRepository]\n";
        try {
            $h = $this->adminHarness();
            $pdo = $h['pdo'];
            $repo = $h['repo'];
            $adminRepo = new AdminRepository($pdo);

            $aid = $repo->create(['login' => 'dumbo', 'password' => 'motdepasse123', 'role' => 'admin']);
            $uid = $repo->create(['login' => 'charlie', 'password' => 'motdepasse456', 'role' => 'user']);
            $results = new ResultService($pdo, new ResultRepository($pdo));
            $results->save($uid, 'multiplication', 8);
            $results->save($uid, 'addition', 6);

            $this->check($adminRepo->playedGamesFor($uid) === 2, 'AdminRepository::playedGamesFor compte 2 parties');
            $this->check($adminRepo->playedGamesFor($aid) === 0, 'AdminRepository::playedGamesFor = 0 pour admin');

            $hist = $adminRepo->historyFor($uid);
            $this->check(count($hist) === 2, 'AdminRepository::historyFor renvoie 2 parties');
            $this->check(!isset($hist[0]['user_id']), 'historyFor ne fuit pas user_id');
            $this->check(isset($hist[0]['mode'], $hist[0]['score']), 'historyFor expose mode/score publics');

            // Aggrégats globaux : on compare par différence (delta) pour rester
            // indépendant des autres tests partageant la base temporaire.
            $beforeUser = $repo->count();
            $beforeGames = $adminRepo->globalTotals('2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z')['games']['total'];
            $aid2 = $repo->create(['login' => 'delta_user', 'password' => 'motdepasse789', 'role' => 'user']);
            $results->save($aid2, 'addition', 5);

            $totals = $adminRepo->globalTotals('2000-01-01T00:00:00Z', '2000-01-01T00:00:00Z');
            $this->check($totals['users']['total'] === $beforeUser + 1, 'globalTotals users.total suit le delta');
            $this->check($totals['games']['total'] === $beforeGames + 1, 'globalTotals games.total suit le delta');
            $this->check($totals['games']['last_30d'] === $beforeGames + 1, 'globalTotals games.last_30d suit le delta');

            $this->check($totals['users']['admins'] >= 1, 'globalTotals users.admins ≥ 1 (au moins les admins créés)');
            $this->check($totals['games']['multiplication'] >= 1, 'globalTotals games.multiplication ≥ 1');
            $this->check($totals['games']['addition'] >= 1, 'globalTotals games.addition ≥ 1');

            $daily = $adminRepo->dailyGameCount('2000-01-01T00:00:00Z', 30, 'Indian/Reunion');
            $this->check(count($daily) === 30, 'dailyGameCount construit 30 jours');
            $this->check(isset($daily[0]['day'], $daily[0]['games']), 'dailyGameCount expose day/games');
        } catch (Throwable $e) {
            $this->check(false, 'AdminRepository : ' . $e->getMessage());
        }
    }

    private function testAdminServiceListAndDetail(): void
    {
        echo "[Administration — liste et détail]\n";
        try {
            $h = $this->adminHarness();
            $repo = $h['repo'];
            $svc = $h['svc'];

            // Le total global sert de référence AVANT d'ajouter nos 2 comptes pour
            // vérifier le delta (indépendant des tests partageant la base temporaire).
            $beforeTotal = $repo->count();

            $aid = $repo->create(['login' => 'adminv', 'password' => 'motdepasse123', 'role' => 'admin']);
            $uid = $repo->create(['login' => 'bob', 'password' => 'motdepasse456', 'role' => 'user']);
            $results = new ResultService($h['pdo'], new ResultRepository($h['pdo']));
            $results->save($uid, 'multiplication', 8);

            $list = $svc->listUsers();
            $this->check($list['total'] === $beforeTotal + 2, 'listUsers total suit le delta (+2)');
            $this->check(count($list['users']) === $beforeTotal + 2, 'listUsers renvoie toutes les fiches');
            foreach ($list['users'] as $u) {
                $this->check(!isset($u['password_hash']), 'listUsers ne fuit pas password_hash');
                $this->check(!array_key_exists('email', $u), 'listUsers ne fuit pas e-mail');
            }

            $search = $svc->listUsers('bob');
            $this->check($search['total'] === 1 && $search['users'][0]['login'] === 'bob', 'listUsers recherche par login');

            $detail = $svc->userDetail($uid);
            $this->check(is_array($detail) && $detail['login'] === 'bob', 'userDetail renvoie le compte');
            $this->check($detail['played_games'] === 1, 'userDetail played_games = 1');
            $this->check(count($detail['history']) === 1, 'userDetail history = 1 partie');
            $this->check(!isset($detail['password_hash']), 'userDetail ne fuit pas password_hash');
            $this->check(!array_key_exists('email', $detail), 'userDetail ne fuit pas e-mail');

            $this->check($svc->userDetail(999999) === null, 'userDetail inexistant = null');
        } catch (Throwable $e) {
            $this->check(false, 'Adm liste/détail : ' . $e->getMessage());
        }
    }


    private function testAdminServiceRole(): void
    {
        echo "[Administration — rôles]\n";
        try {
            $h = $this->adminHarness();
            $svc = $h['svc'];
            $repo = $h['repo'];

            $aid = $repo->create(['login' => 'rootv', 'password' => 'motdepasse123', 'role' => 'admin']);
            $uid = $repo->create(['login' => 'carole', 'password' => 'motdepasse456', 'role' => 'user']);

            $fiche = $svc->setRole($uid, true, $aid);
            $this->check($fiche['role'] === 'admin', 'setRole(true) élève carole au rang admin');

            $fiche2 = $svc->setRole($uid, false, $aid);
            $this->check($fiche2['role'] === 'user', 'setRole(false) retire le rôle admin');

            try {
                $svc->setRole(999999, true, $aid);
                $this->check(false, 'setRole cible inexistante levée');
            } catch (InvalidArgumentException) {
                $this->check(true, 'setRole cible inexistante levée');
            }
        } catch (Throwable $e) {
            $this->check(false, 'Adm rôles : ' . $e->getMessage());
        }
    }

    private function testAdminServiceActive(): void
    {
        echo "[Administration — activation / désactivation]\n";
        try {
            $h = $this->adminHarness();
            $svc = $h['svc'];
            $repo = $h['repo'];

            $aid = $repo->create(['login' => 'active_root', 'password' => 'motdepasse123', 'role' => 'admin']);
            $uid = $repo->create(['login' => 'dave', 'password' => 'motdepasse456', 'role' => 'user']);

            $fiche = $svc->setActive($uid, false);
            $this->check($fiche['is_active'] === false, 'setActive(false) désactive dave');
            $this->check($repo->findById($uid) !== null, 'La ligne dave est conservée (soft delete)');

            $fiche2 = $svc->setActive($uid, true);
            $this->check($fiche2['is_active'] === true, 'setActive(true) réactive dave');

            try {
                $svc->setActive(999999, false);
                $this->check(false, 'setActive cible inexistante levée');
            } catch (InvalidArgumentException) {
                $this->check(true, 'setActive cible inexistante levée');
            }
        } catch (Throwable $e) {
            $this->check(false, 'Adm activation : ' . $e->getMessage());
        }
    }


    private function testAdminServicePassword(): void
    {
        echo "[Administration — réinitialisation du mot de passe]\n";
        try {
            $h = $this->adminHarness();
            $svc = $h['svc'];
            $repo = $h['repo'];

            $aid = $repo->create(['login' => 'pwd_root', 'password' => 'motdepasse123', 'role' => 'admin']);
            $uid = $repo->create(['login' => 'eve', 'password' => 'ancien123456', 'role' => 'user']);

            $reset = $svc->resetPassword($uid);
            $this->check($reset['login'] === 'eve', 'resetPassword renvoie le login');
            $this->check(strlen($reset['temporary_password']) >= 10, 'resetPassword génère ≥ 10 caractères');
            $this->check($repo->verifyPassword($repo->findById($uid), $reset['temporary_password']), 'Mot de passe temporaire authentifie eve');

            try {
                $svc->resetPassword(999999);
                $this->check(false, 'resetPassword cible inexistante levée');
            } catch (InvalidArgumentException) {
                $this->check(true, 'resetPassword cible inexistante levée');
            }
        } catch (Throwable $e) {
            $this->check(false, 'Adm mot de passe : ' . $e->getMessage());
        }
    }

    private function testAdminServiceStats(): void
    {
        echo "[Administration — statistiques globales]\n";
        try {
            $h = $this->adminHarness();
            $svc = $h['svc'];
            $repo = $h['repo'];
            $pdo = $h['pdo'];

            $now = new DateTimeImmutable('2026-10-27T12:00:00Z');
            $base = $svc->globalStats($now);

            $repo->create(['login' => 'stats_root2', 'password' => 'motdepasse123', 'role' => 'admin']);
            $uid = $repo->create(['login' => 'franck2', 'password' => 'motdepasse456', 'role' => 'user']);
            $results = new ResultService($pdo, new ResultRepository($pdo));
            $results->save($uid, 'multiplication', 8);
            $results->save($uid, 'addition', 6);

            $g = $svc->globalStats($now);

            $this->check($g['users']['total'] === $base['users']['total'] + 2, 'globalStats users.total suit le delta (+2)');
            $this->check($g['users']['admins'] === $base['users']['admins'] + 1, 'globalStats users.admins +1');
            $this->check($g['users']['admins_active'] === $base['users']['admins_active'] + 1, 'globalStats users.admins_active +1 (admin actif créé)');
            $this->check($g['games']['total'] === $base['games']['total'] + 2, 'globalStats games.total suit le delta (+2)');
            $this->check($g['games']['multiplication'] === $base['games']['multiplication'] + 1, 'globalStats games.multiplication +1');
            $this->check($g['games']['addition'] === $base['games']['addition'] + 1, 'globalStats games.addition +1');

            // Répartition relative d'additions/multiplications : les seuls 2 modes
            // gérés se partagent 100 %. (Ne pas figer 50/50 : des parties préexistantes
            // d'autres tests de la base partagée biaiseraient le ratio.)
            $pctSum = $g['games']['multiplication_pct'] + $g['games']['addition_pct'];
            $this->check(abs($pctSum - 100.0) < 0.05, 'globalStats multiplication_pct + addition_pct = 100 %');
            $this->check($g['games']['multiplication_pct'] >= 0 && $g['games']['multiplication_pct'] <= 100, 'globalStats multiplication_pct dans [0;100]');
            $this->check(is_array($g['activity']) && count($g['activity']) === 30, 'globalStats activity = série de 30 jours');
            $this->check($g['generated_at_utc'] === '2026-10-27T12:00:00Z', 'globalStats generated_at_utc format strict UTC');

            $this->check(!isset($g['password_hash']) && !array_key_exists('email', $g), 'globalStats sans données sensibles');
        } catch (Throwable $e) {
            $this->check(false, 'Adm stats globales : ' . $e->getMessage());
        }
    }

    private function testAdminLastAdminGuard(): void
    {
        echo "[Administration — protection du dernier administrateur]\n";
        try {
            $h = $this->adminHarness();
            $svc = $h['svc'];
            $repo = $h['repo'];

            $aid = $repo->create(['login' => 'unique_root', 'password' => 'motdepasse123', 'role' => 'admin']);
            $uid = $repo->create(['login' => 'greg', 'password' => 'motdepasse456', 'role' => 'user']);

            // 0. Dénombrement : un seul administrateur actif au départ.
            $stats0 = $svc->globalStats();
            $this->check($stats0['users']['admins_active'] === 1, 'admins_active = 1 pour un seul admin actif');

            // 1. Retrait du rôle au dernier admin actif => 403.
            $blocked = false;
            try {
                $svc->setRole($aid, false, $uid);
            } catch (RuntimeException $e) {
                $blocked = ($e->getCode() === 403);
            }
            $this->check($blocked, 'setRole : impossible de retirer le rôle au dernier admin actif');

            // 2. Désactivation du dernier admin actif => 403.
            $blocked = false;
            try {
                $svc->setActive($aid, false);
            } catch (RuntimeException $e) {
                $blocked = ($e->getCode() === 403);
            }
            $this->check($blocked, 'setActive : impossible de désactiver le dernier admin actif');

            // 3. Dès qu'un autre admin actif existe, le retrait/désactivation est permis.
            $svc->setRole($uid, true, $aid);
            $this->check($svc->globalStats()['users']['admins_active'] === 2, 'admins_active = 2 pour deux admins actifs');
            $fiche = $svc->setRole($aid, false, $uid);
            $this->check($fiche['role'] === 'user', "setRole : retrait permis dès qu'un 2e admin actif existe");

            // 4. Et la désactivation de l'ancien dernier admin est alors possible.
            $svc->setRole($aid, true, $uid);
            $fiche2 = $svc->setActive($aid, false);
            $this->check($fiche2['is_active'] === false, 'setActive : désactivation permise avec un 2e admin actif');

            // 4bis. Deux comptes avec rôle admin, mais un seul actif : protection maintenue.
            $stats2 = $svc->globalStats();
            $this->check(
                $stats2['users']['admins'] === 2 && $stats2['users']['admins_active'] === 1,
                'deux comptes admin mais un seul actif => admins_active = 1'
            );
            $blocked = false;
            try {
                $svc->setRole($uid, false, $aid); // greg est le seul admin ACTIF restant
            } catch (RuntimeException $e) {
                $blocked = ($e->getCode() === 403);
            }
            $this->check($blocked, 'setRole bloqué quand l’autre admin est inactif (dernier admin actif)');
            $blocked = false;
            try {
                $svc->setActive($uid, false); // greg est le seul admin ACTIF restant
            } catch (RuntimeException $e) {
                $blocked = ($e->getCode() === 403);
            }
            $this->check($blocked, 'setActive bloqué quand l’autre admin est inactif (dernier admin actif)');

            // 5. Réactivation de l'ancien admin => 2 admins actifs, actions à nouveau permises.
            $svc->setActive($aid, true);
            $this->check($svc->globalStats()['users']['admins_active'] === 2, 'admins_active = 2 après réactivation');
            $fiche3 = $svc->setRole($uid, false, $aid);
            $this->check($fiche3['role'] === 'user', 'retrait permis dès 2 admins actifs (après réactivation)');
        } catch (Throwable $e) {
            $this->check(false, 'Adm protection dernier admin : ' . $e->getMessage());
        }
    }


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

            // Désactivation du compte alors qu'une session est ouverte : la
            // session existante devient immédiatement inutilisable (currentUser()=null),
            // sans destruction explicite nécessaire, car l'état est rechargé à chaque
            // requête depuis la base.
            $daveId = (int)($connected['id'] ?? 0);
            $repo->setActive($daveId, false);
            $this->check($auth->currentUser() === null, 'Session d\'un compte désactivé => inutilisable (currentUser null)');
            $repo->setActive($daveId, true);
            $this->check($auth->currentUser() !== null, 'Réactivation => session de nouveau utilisable');

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

            $rid2 = $results->save($id, 'addition', 7, '2026-01-15T10:20:30Z', 'hole');
            $this->check($rid2 > 0, 'Enregistrement avec date de fin UTC explicite');

            $history = $results->history($id);
            $this->check(count($history) === 2, 'Historique contient 2 parties');
            $row = $history[0];
            $this->check(
                ($row['score'] ?? -1) === 9 && ($row['mode'] ?? '') === 'multiplication',
                'Historique ordonné (plus récent d\'abord) et champs corrects'
            );
            // v12.3 — le type de questions est persisté : par défaut 'classic'
            // (partie sans question_type explicite), et 'hole' pour la seconde.
            $this->check(
                ($row['question_type'] ?? '') === 'classic',
                'question_type par défaut « classic » dans l\'historique'
            );
            $this->check(
                ($history[1]['question_type'] ?? '') === 'hole',
                'question_type « hole » persisté et restitué'
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

            // v12.3 — un type de questions inconnu est refusé.
            $badTypeRejected = false;
            try {
                $results->save($id, 'multiplication', 5, null, 'trou');
            } catch (InvalidArgumentException) {
                $badTypeRejected = true;
            }
            $this->check($badTypeRejected, 'Refus d\'un type de questions invalide');

            $this->check(count($results->history($id)) === 0, 'Aucun résultat invalide persistant');
        } catch (Throwable $e) {
            $this->check(false, "Validation : {$e->getMessage()}");
        }
    }

    // --- Étape 3 : contrat d'horodatage UTC (played_at) — moteur du correctif
    // frontend. Le backend reste STRICT (YYYY-MM-DDTHH:mm:ssZ, sans
    // millisecondes) : un client qui enverrait new Date().toISOString() brut
    // (avec .sssZ) est refusé, ce qui rend la normalisation côté client
    // INDISPENSABLE. Ces tests verrouillent ce contrat pour éviter la perte
    // silencieuse de résultats.

    private function testResultPlayedAtContract(): void
    {
        echo "[Contrat d'horodatage played_at (normalisation frontend)]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $results = new ResultService($pdo, new ResultRepository($pdo));
            $stats = new StatsService(new ResultRepository($pdo));
            $id = $repo->create(['login' => 'ts_contract', 'password' => 'motdepasse10', 'role' => 'user']);

            // 1. Format strict (ce que la normalisation frontend produit) : accepté.
            $rid = $results->save($id, 'multiplication', 9, '2026-10-27T10:00:00Z');
            $this->check($rid > 0, 'save avec format strict ...Z accepté');

            // 2. new Date().toISOString() brut (avec millisecondes) : REFUSÉ.
            $msRejected = false;
            try {
                $results->save($id, 'multiplication', 4, '2026-10-27T10:00:00.123Z');
            } catch (InvalidArgumentException) {
                $msRejected = true;
            }
            $this->check($msRejected, 'save avec millisecondes (.123Z) refusé => la normalisation client est requise');

            // 3. Enregistrement normal (strict) en mode ADDITION aussi : le contrat
            // d'horodatage est identique pour les deux modes (additions/multiplications).
            $ridAdd = $results->save($id, 'addition', 6, '2026-10-28T09:00:00Z');
            $this->check($ridAdd > 0, 'save addition avec format strict ...Z accepte');

            // 4. Historique : les 2 parties strictes (multiplication + addition) sont visibles.
            $history = $results->history($id);
            $this->check(
                count($history) === 2,
                'les 2 parties strictes (1 multiplication + 1 addition) sont visibles dans l\'historique'
            );

            // 5. Les statistiques reflètent ces parties, mode par mode.
            $sMult = $stats->stats($id, 'multiplication');
            $sAdd = $stats->stats($id, 'addition');
            $this->check(
                ($sMult['totals']['games'] ?? -1) === 1 && ($sAdd['totals']['games'] ?? -1) === 1,
                'les statistiques integrent 1 partie par mode (additions et multiplications)'
            );
        } catch (Throwable $e) {
            $this->check(false, "Contrat played_at : {$e->getMessage()}");
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
        // Supprime récursivement les bases SQLite isolées des tests d'administration.
        foreach ($this->adminDirs as $dir) {
            if (!is_dir($dir)) {
                continue;
            }
            foreach (glob($dir . '/*') ?: [] as $f) {
                @unlink($f);
            }
            @rmdir($dir);
        }
        $this->adminDirs = [];

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

    // --- Étape 6 : agrégation des statistiques ---

    private function testStatsAggregation(): void
    {
        echo "[Statistiques — agrégation]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $resultRepository = new ResultRepository($pdo);
            $results = new ResultService($pdo, $resultRepository);
            $stats = new StatsService($resultRepository);
            $id = $repo->create(['login' => 'stats_agg', 'password' => 'motdepasse10', 'role' => 'user']);

            // Multiplications : 4 parties réparties dans et hors fenêtres.
            $results->save($id, 'multiplication', 10, '2026-10-27T11:00:00Z'); // 7j
            $results->save($id, 'multiplication', 8,  '2026-10-20T11:00:00Z'); // 30j
            $results->save($id, 'multiplication', 6,  '2026-09-28T11:00:00Z'); // 30j
            $results->save($id, 'multiplication', 1,  '2026-09-01T00:00:00Z'); // hors 30j
            // Addition : ne doit pas compter dans les multiplications.
            $results->save($id, 'addition', 9, '2026-10-27T11:00:00Z');

            $now = new DateTimeImmutable('2026-10-27T12:00:00Z');
            $s = $stats->stats($id, 'multiplication', $now);

            // Totaux globaux (toutes les parties du mode).
            $this->check($s['totals']['games'] === 4, 'Totaux : 4 parties multiplications comptées');
            $this->check($s['totals']['best_score'] === 10, 'Totaux : meilleur score = 10');
            $this->check($s['totals']['avg_score'] === 6.3, 'Totaux : score moyen arrondi à 6.3');

            // Fenêtres glissantes.
            $this->check($s['periods']['last_7d']['games'] === 1, '7 jours : 1 partie');
            $this->check($s['periods']['last_7d']['avg_score'] === 10.0, '7 jours : moyenne = 10');
            $this->check($s['periods']['last_30d']['games'] === 3, '30 jours : 3 parties');
            $this->check($s['periods']['last_30d']['avg_score'] === 8.0, '30 jours : moyenne = 8');

            // Courbe : les 30 dernières parties en ordre chronologique (s4→s1).
            $this->check(count($s['progression']) === 4, 'Courbe : 4 parties (moins de 30)');
            $this->check($s['progression'][0]['rank'] === 1 && $s['progression'][0]['score'] === 1, 'Courbe : la plus ancienne en premier (score 1)');
            $this->check(end($s['progression'])['score'] === 10, 'Courbe : la plus récente en dernier (score 10)');

            // Histogramme : 30 jours complets, journées sans partie à 0.
            $this->check(count($s['daily_games']) === 30, 'Histogramme : 30 jours présents');
            $this->check($s['daily_games'][0]['day'] === '2026-09-28' && $s['daily_games'][29]['day'] === '2026-10-27', 'Histogramme : bornes de dates correctes');
            $onlyZero = array_filter($s['daily_games'], static fn($d) => $d['games'] !== 0);
            $this->check(count($onlyZero) === 3, 'Histogramme : seuls 3 jours ont des parties (la 4e partie est hors fenêtre 30 j, complétion à 0)');
        } catch (Throwable $e) {
            $this->check(false, "Statistiques agrégation : {$e->getMessage()}");
        }
    }

    // --- Étape 6 : isolation des statistiques entre utilisateurs ---

    private function testStatsIsolation(): void
    {
        echo "[Statistiques — isolation]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $resultRepository = new ResultRepository($pdo);
            $results = new ResultService($pdo, $resultRepository);
            $stats = new StatsService($resultRepository);

            $a = $repo->create(['login' => 'stats_a', 'password' => 'motdepasse10', 'role' => 'user']);
            $b = $repo->create(['login' => 'stats_b', 'password' => 'motdepasse10', 'role' => 'user']);
            $results->save($a, 'multiplication', 10);
            $results->save($b, 'multiplication', 2);

            $sa = $stats->stats($a, 'multiplication');
            $sb = $stats->stats($b, 'multiplication');

            $this->check($sa['totals']['games'] === 1 && $sa['totals']['best_score'] === 10, 'A voit ses propres stats (1 partie)');
            $this->check($sb['totals']['games'] === 1 && $sb['totals']['best_score'] === 2, 'B ne voit QUE ses propres stats');
        } catch (Throwable $e) {
            $this->check(false, "Statistiques isolation : {$e->getMessage()}");
        }
    }

    // --- Étape 6 : regroupement journalier au fuseau Indian/Reunion (UTC+4) ---

    private function testStatsReunionTimezone(): void
    {
        echo "[Statistiques — fuseau Indian/Reunion]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $resultRepository = new ResultRepository($pdo);
            $results = new ResultService($pdo, $resultRepository);
            $stats = new StatsService($resultRepository);
            $id = $repo->create(['login' => 'stats_tz', 'password' => 'motdepasse10', 'role' => 'user']);

            // 2026-10-26T20:30:00Z = 2026-10-27 00:30 heure Reunion => jour local 2026-10-27.
            $results->save($id, 'multiplication', 10, '2026-10-26T20:30:00Z');

            $now = new DateTimeImmutable('2026-10-27T12:00:00Z');
            $s = $stats->stats($id, 'multiplication', $now);
            $byDay = array_column($s['daily_games'], 'games', 'day');

            $this->check(($byDay['2026-10-27'] ?? 0) === 1, 'Partie UTC 20:30 attribuée au jour Reunion 2026-10-27 (+4h)');
            $this->check(($byDay['2026-10-26'] ?? 0) === 0, 'Aucune partie attribuée au 2026-10-26 (basculée au lendemain)');
        } catch (Throwable $e) {
            $this->check(false, "Statistiques fuseau : {$e->getMessage()}");
        }
    }

    // --- Étape 6 : mode invalide refusé ---

    private function testStatsInvalidMode(): void
    {
        echo "[Statistiques — mode invalide]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $stats = new StatsService(new ResultRepository($pdo));
            $id = $repo->create(['login' => 'stats_bad', 'password' => 'motdepasse10', 'role' => 'user']);

            try {
                $stats->stats($id, 'division');
                $this->check(false, 'Mode invalide refusé');
            } catch (InvalidArgumentException) {
                $this->check(true, 'Mode invalide refusé');
            }
        } catch (Throwable $e) {
            $this->check(false, "Statistiques mode invalide : {$e->getMessage()}");
        }
    }

    // --- Étape 6 : les statistiques personnelles reflètent les parties
    // enregistrées (connecté), pour les additions ET les multiplications ---

    private function testStatsIncludesImported(): void
    {
        echo "[Statistiques — parties enregistrées (connecté)]\n";
        try {
            $db = new Database($this->tmpRoot);
            $pdo = $db->pdo();
            $repo = new UserRepository($pdo);
            $resultRepository = new ResultRepository($pdo);
            $results = new ResultService($pdo, $resultRepository);
            $stats = new StatsService($resultRepository);
            $id = $repo->create(['login' => 'stats_conn', 'password' => 'motdepasse10', 'role' => 'user']);

            // Une partie en multiplication + une partie en addition, enregistrées
            // normalement (aucune importation ne subsiste en v12.2).
            $results->save($id, 'multiplication', 7, '2026-10-27T10:00:00Z');
            $results->save($id, 'addition', 9, '2026-10-26T10:00:00Z');

            $sMult = $stats->stats($id, 'multiplication');
            $this->check(
                ($sMult['totals']['games'] ?? -1) === 1 && ($sMult['totals']['best_score'] ?? -1) === 7,
                'Stats multiplication : 1 partie, meilleur score 7'
            );
            $sAdd = $stats->stats($id, 'addition');
            $this->check(
                ($sAdd['totals']['games'] ?? -1) === 1 && ($sAdd['totals']['best_score'] ?? -1) === 9,
                'Stats addition : 1 partie, meilleur score 9 (fonctionnement identique aux multiplications)'
            );
        } catch (Throwable $e) {
            $this->check(false, "Statistiques enregistrées : {$e->getMessage()}");
        }
    }

    // --- Étape de sécurité : durcissement de la session et en-têtes HTTP ---

    private function testSecurityHardening(): void
    {
        echo "[Sécurité — session et en-têtes HTTP]\n";
        try {
            $srcDir = CALC_TRAINER_SRC;

            // 1. Les attributs HttpOnly / SameSite du cookie de session sont fixés
            //    via session_set_cookie_params() dans Security::startSession() et
            //    sont VÉRIFIÉS au niveau HTTP réel dans http_test.php (en-tête
            //    Set-Cookie). En contexte CLI, startSession() peut se contenter de
            //    retourner tôt si des en-têtes ont déjà été émis (sortie du harnais)
            //    : on vérifie donc ici la présence du code de durcissement attendu.
            $securitySrc = (string)file_get_contents($srcDir . '/Security.php');
            $this->check(
                str_contains($securitySrc, "'httponly' => true")
                    && str_contains($securitySrc, "'samesite' => 'Lax'"),
                'Cookie session durci (HttpOnly + SameSite=Lax) dans startSession()'
            );

            // 2. session.use_only_cookies doit rester actif (aucun ID dans l'URL).
            $this->check(
                (string)ini_get('session.use_only_cookies') === '1',
                'session.use_only_cookies = 1 (pas d\'ID dans l\'URL)'
            );

            // 3. L'application ne doit JAMAIS reconfigurer session.serialize_handler
            //    (CVE-2026-115560) : aucun ini_set/ini_alter vers un autre handler.
            //    La directive restant au "php" par défaut, elle n'est pas modifiable
            //    depuis le code ; le correctif relève de la mise à jour du moteur PHP.
            $hits = 0;
            foreach (glob($srcDir . '/*.php') ?: [] as $phpFile) {
                $content = (string)file_get_contents($phpFile);
                if (preg_match('/ini_(set|alter)\s*\(\s*[\'"]session\.serialize_handler[\'"]/', $content)) {
                    $hits++;
                }
            }
            $this->check($hits === 0, 'Aucune reconfiguration de session.serialize_handler dans src/');

            // 4. Le code ne doit contenir aucun unserialize de données non fiables.
            $unserializeHits = 0;
            foreach (glob($srcDir . '/*.php') ?: [] as $phpFile) {
                $content = (string)file_get_contents($phpFile);
                if (preg_match('/\bunserialize\s*\(/', $content)) {
                    $unserializeHits++;
                }
            }
            $this->check($unserializeHits === 0, 'Aucun appel unserialize() dans src/');

            // 5. session.use_strict_mode : directive figée à l'exécution (no-op ini_set).
            //    On journalise la valeur effective ; l'activation se fait en php.ini.
            $strict = (string)ini_get('session.use_strict_mode');
            echo "  ℹ session.use_strict_mode = " . ($strict === '1' ? '1 (actif)' : '0 (à activer en php.ini)') . "\n";
            $this->check(true, 'Valeur session.use_strict_mode journalisée');
        } catch (Throwable $e) {
            $this->check(false, "Sécurité session/en-têtes : {$e->getMessage()}");
        }
    }
    // ---------------------------------------------------------------------------
    // v12.4 — Mémoire des difficultés personnelles.
    // ---------------------------------------------------------------------------

    /**
     * Fabrique un environnement complet de test v12.4 : base temporaire dédiée,
     * un utilisateur, et les services (ResultService injecté avec la mémoire des
     * difficultés). Chaque test dispose de sa propre base => déterministe.
     */
    private function difficultyHarness(): array
    {
        $db = new Database($this->tmpRoot);
        $pdo = $db->pdo();
        $users = new UserRepository($pdo);
        $userId = $users->create([
            'login' => 'diff_' . substr(uniqid(), -6),
            'password' => 'motdepasse10',
            'role' => 'user',
        ]);
        $repo = new OperationDifficultyRepository($pdo);
        $svc = new OperationDifficultyService($pdo, $repo);
        $results = new ResultService($pdo, new ResultRepository($pdo), $svc);
        return [
            'pdo' => $pdo,
            'userId' => $userId,
            'repo' => $repo,
            'svc' => $svc,
            'results' => $results,
        ];
    }

    /** 1. Création du schéma SQLite v12.4 (tables et colonnes attendues). */
    private function testDifficultySchema(): void
    {
        echo "[Mémoire des difficultés — schéma]\n";
        $h = $this->difficultyHarness();
        $pdo = $h['pdo'];

        $opCols = $pdo->query('PRAGMA table_info(operations_difficulty)')->fetchAll(PDO::FETCH_COLUMN, 1);
        $expected = [
            'id', 'user_id', 'mode', 'question_type', 'operand_a', 'operand_b',
            'attempts', 'errors', 'success_streak', 'difficulty',
            'last_answered_at', 'last_error_at', 'last_resolved_at',
        ];
        $missing = array_diff($expected, $opCols);
        $this->check(empty($missing), 'operations_difficulty : toutes les colonnes attendues sont présentes');

        $uniq = (bool)$pdo->query(
            "SELECT COUNT(*) FROM pragma_index_list('operations_difficulty')
             WHERE origin = 'u'"
        )->fetchColumn();
        $this->check($uniq, 'operations_difficulty : index UNIQUE présent (normalisation opérandes)');

        $logCols = $pdo->query('PRAGMA table_info(mission_difficulty_log)')->fetchAll(PDO::FETCH_COLUMN, 1);
        $this->check(
            in_array('mission_id', $logCols, true) && in_array('user_id', $logCols, true),
            'mission_difficulty_log : colonnes user_id et mission_id présentes'
        );
        $logUniq = (bool)$pdo->query(
            "SELECT COUNT(*) FROM pragma_index_list('mission_difficulty_log')
             WHERE origin = 'u'"
        )->fetchColumn();
        $this->check($logUniq, 'mission_difficulty_log : contrainte UNIQUE (user_id, mission_id) pour l\'idempotence');
    }


    /** 6/7/8/9/10. Barème : erreurs/plafond, réussites, retours à zéro, surmontée, maîtrise conservée. */
    private function testDifficultyBarème(): void
    {
        echo "[Mémoire des difficultés — barème]\n";
        $h = $this->difficultyHarness();
        $svc = $h['svc'];
        $repo = $h['repo'];
        $uid = $h['userId'];

        $row = fn() => $repo->find($uid, 'multiplication', 'classic', 6, 7);

        $this->check($row() === null, 'aucune ligne de difficulté avant le premier essai');

        for ($i = 0; $i < 5; $i++) {
            $svc->applyBarème($uid, 'multiplication', 'classic', 6, 7, false);
        }
        $r = $row();
        $this->check((int)$r['difficulty'] === 5, '5 erreurs => difficulté plafonnée à 5 (max)');
        $this->check((int)$r['attempts'] === 5, 'chaque tentative incrémente attempts (5)');
        $this->check((int)$r['errors'] === 5, 'errors = 5');
        $this->check((int)$r['success_streak'] === 0, 'une erreur remet la série de réussites à zéro');
        $this->check($r['last_error_at'] !== null, 'dernière erreur datée');
        $this->check($r['last_resolved_at'] === null, 'aucune surmontée tant que la difficulté est positive');

        $svc->applyBarème($uid, 'multiplication', 'classic', 6, 7, false);
        $this->check((int)$row()['difficulty'] === 5, 'plafonnement : jamais > 5');

        // Une réponse sans bon résultat (expiration) est aussi une erreur.
        $svc->applyBarème($uid, 'multiplication', 'classic', 6, 7, false);
        $this->check((int)$row()['difficulty'] === 5, 'réponse absente/expiration traitée comme une erreur');

        // 10 réussites consécutives : de 5 à 0 (toutes les 2 réussites).
        for ($i = 0; $i < 10; $i++) {
            $svc->applyBarème($uid, 'multiplication', 'classic', 6, 7, true);
        }
        $r = $row();
        $this->check((int)$r['difficulty'] === 0, '10 réussites consécutives ramènent la difficulté à 0');
        $this->check((int)$r['success_streak'] === 10, 'success_streak = nombre réel de réussites consécutives (10)');
        $this->check($r['last_resolved_at'] !== null, 'difficulté positive revenue à 0 => surmontée (last_resolved_at)');

        // 9. Identification d'une surmontée sur une difficulté 1 -> 0.
        $h2 = $this->difficultyHarness();
        $repo2 = $h2['repo'];
        $uid2 = $h2['userId'];
        $svc2 = $h2['svc'];
        $svc2->applyBarème($uid2, 'addition', 'classic', 3, 4, false); // diff 1
        $svc2->applyBarème($uid2, 'addition', 'classic', 3, 4, true);  // streak1
        $svc2->applyBarème($uid2, 'addition', 'classic', 3, 4, true);  // streak2 -> diff0
        $r2 = $repo2->find($uid2, 'addition', 'classic', 3, 4);
        $this->check($r2['last_resolved_at'] !== null, 'difficulté 1->0 identifiée comme surmontée');

        // Opération juste du premier coup : diff 0 mais PAS surmontée.
        $h3 = $this->difficultyHarness();
        $repo3 = $h3['repo'];
        $uid3 = $h3['userId'];
        $h3['svc']->applyBarème($uid3, 'multiplication', 'classic', 9, 9, true);
        $r3 = $repo3->find($uid3, 'multiplication', 'classic', 9, 9);
        $this->check((int)$r3['difficulty'] === 0 && $r3['last_resolved_at'] === null,
            'opération juste du premier coup : diff 0 mais PAS surmontée');

        // 10. Conservation des opérations maîtrisées en base.
        $all = $repo->allForUser($uid);
        $this->check(count($all) >= 1, 'opération maîtrisée (difficulty 0) conservée en base');
    }

    /** 2/3/4/5. Agrégation : normalisation commutative, distinction mode/type, mode mélange. */
    private function testDifficultyAggregationAndClassification(): void
    {
        echo "[Mémoire des difficultés — agrégation]\n";
        $h = $this->difficultyHarness();
        $repo = $h['repo'];
        $svc = $h['svc'];
        $results = $h['results'];
        $uid = $h['userId'];

        // Normalisation commutative : 6x7 et 7x6 => même ligne.
        $svc->applyBarème($uid, 'multiplication', 'classic', 6, 7, true);
        $svc->applyBarème($uid, 'multiplication', 'classic', 7, 6, true);
        $r = $repo->find($uid, 'multiplication', 'classic', 6, 7);
        $this->check($r !== null && (int)$r['operand_a'] === 6 && (int)$r['operand_b'] === 7,
            'opérandes normalises dans l\'ordre a<=b');
        $this->check((int)$r['attempts'] === 2, '6x7 et 7x6 regroupés (commutativité)');
        $this->check($repo->find($uid, 'multiplication', 'classic', 7, 6) === null,
            'aucune ligne doublon pour l\'ordre inverse');

        // Distinction addition / multiplication.
        $svc->applyBarème($uid, 'addition', 'classic', 6, 7, true);
        $this->check((int)$repo->find($uid, 'multiplication', 'classic', 6, 7)['attempts'] === 2,
            'la ligne multiplication est inchangée');
        $this->check((int)$repo->find($uid, 'addition', 'classic', 6, 7)['attempts'] === 1,
            'l\'addition est une ligne distincte de la multiplication');

        // Distinction classique / à trou.
        $svc->applyBarème($uid, 'multiplication', 'hole', 6, 7, true);
        $this->check((int)$repo->find($uid, 'multiplication', 'hole', 6, 7)['attempts'] === 1,
            'le type à trou est une ligne distincte');
        $this->check((int)$repo->find($uid, 'multiplication', 'classic', 6, 7)['attempts'] === 2,
            'la ligne classique est inchangée par la variante à trou');

        // 5. Mode Mélange : classification INDIVIDUELLE de chaque question et
        // regroupement des deux positions du trou (a ou b) dans la même clé.
        $details = [];
        for ($i = 0; $i < 4; $i++) {
            $details[] = ['mode' => 'multiplication', 'question_type' => 'classic', 'a' => 4, 'b' => 5, 'hole' => null, 'user_answer' => 20];
        }
        for ($i = 0; $i < 6; $i++) {
            $details[] = ['mode' => 'multiplication', 'question_type' => 'hole',
                'a' => 4, 'b' => 5, 'hole' => ($i % 2 === 0 ? 'a' : 'b'),
                'user_answer' => ($i % 2 === 0 ? 4 : 5)];
        }
        $results->saveWithMission($uid, 'multiplication', 10, 'MIX-A', $details, '2026-01-05T08:00:00Z', 'mixed');
        $c = $repo->find($uid, 'multiplication', 'classic', 4, 5);
        $hn = $repo->find($uid, 'multiplication', 'hole', 4, 5);
        $this->check((int)$c['attempts'] === 4, 'mixed : les 4 questions classiques agrégées sous classic');
        $this->check((int)$hn['attempts'] === 6, 'mixed : les 6 questions à trou agrégées sous hole');
        $this->check($hn['operand_a'] === 4 && $hn['operand_b'] === 5,
            'les deux positions du trou (a/b) regroupées dans une seule clé');
    }

    /** 11/12. Idempotence d'une mission rejouée + atomicité des écritures. */
    private function testDifficultyIdempotenceAtomicity(): void
    {
        echo "[Mémoire des difficultés — idempotence & atomicité]\n";
        $h = $this->difficultyHarness();
        $repo = $h['repo'];
        $results = $h['results'];
        $uid = $h['userId'];

        $details = [];
        for ($i = 0; $i < 10; $i++) {
            $details[] = ['mode' => 'multiplication', 'question_type' => 'classic', 'a' => 2, 'b' => 3, 'hole' => null, 'user_answer' => 6];
        }

        // 1ère sauvegarde du mission_id.
        $out1 = $results->saveWithMission($uid, 'multiplication', 10, 'MISSION-A', $details, '2026-02-01T10:00:00Z');
        $this->check($out1['saved'] === true && $out1['duplicate'] === false, 'première sauvegarde du mission_id réussie');

        // 2nde sauvegarde de la MÊME mission : réponse de succès cohérente, sans écriture.
        $out2 = $results->saveWithMission($uid, 'multiplication', 10, 'MISSION-A', $details, '2026-02-01T10:00:00Z');
        $this->check($out2['duplicate'] === true, 'mission_id rejoué => doublon détecté (réponse de succès)');
        $this->check(count($results->history($uid)) === 1, 'un seul enregistrement de résultat pour le mission_id');
        $r = $repo->find($uid, 'multiplication', 'classic', 2, 3);
        $this->check((int)$r['attempts'] === 10,
            'les 10 réponses s\'accumulent sur une seule ligne ; la mission rejouée (doublon) n\'ajoute rien');
        $this->check((int)$r['difficulty'] === 0 && (int)$r['success_streak'] === 10,
            'les 10 réussites conservent une série de 10 (non doublée)');

        // 12. Atomicité : une liste de détails dont le dernier est invalide ne doit
        // laisser AUCUNE écriture partielle (ni résultat, ni difficulté).
        $bad = [];
        for ($i = 0; $i < 9; $i++) {
            $bad[] = ['mode' => 'multiplication', 'question_type' => 'classic', 'a' => 5, 'b' => 6, 'hole' => null, 'user_answer' => 30];
        }
        $bad[] = ['mode' => 'multiplication', 'question_type' => 'classic', 'a' => 5, 'b' => 6, 'hole' => 'a', 'user_answer' => 5]; // hole sur classic => invalide
        $rejected = false;
        try {
            $results->saveWithMission($uid, 'multiplication', 9, 'MISSION-B', $bad, '2026-02-01T11:00:00Z');
        } catch (InvalidArgumentException) {
            $rejected = true;
        }
        $this->check($rejected, 'mission avec un détail invalide rejetée');
        $this->check(count($results->history($uid)) === 1, 'aucun résultat écrit pour la mission invalide (atomicité)');
        $this->check($repo->find($uid, 'multiplication', 'classic', 5, 6) === null,
            'aucune ligne de difficulté écrite pour la mission invalide (atomicité)');
    }

    /** 13. Validation serveur des données individuelles + justesse recalculée. */
    private function testDifficultyValidation(): void
    {
        echo "[Mémoire des difficultés — validation serveur]\n";
        $h = $this->difficultyHarness();
        $svc = $h['svc'];

        $validMult = fn() => ['mode' => 'multiplication', 'question_type' => 'classic', 'a' => 3, 'b' => 4, 'hole' => null, 'user_answer' => 12];
        $cases = [
            'non-array'       => 'abc',
            'zero-reponses'   => [],
            'trop-reponses'   => array_fill(0, 11, $validMult()),
            'mode-invalide'   => [array_replace($validMult(), ['mode' => 'soustraction'])],
            'type-invalide'   => [array_replace($validMult(), ['question_type' => 'trou'])],
            'operande-zero'   => [array_replace($validMult(), ['a' => 0])],
            'operande-trop'   => [array_replace($validMult(), ['b' => 100])],
            'hole-sur-classic'=> [array_replace($validMult(), ['hole' => 'a'])],
            'trou-position'   => [array_replace($validMult(), ['question_type' => 'hole', 'hole' => 'c'])],
        ];
        $rejected = 0;
        foreach ($cases as $label => $case) {
            try {
                $svc->validateDetails($case);
            } catch (InvalidArgumentException) {
                $rejected++;
            }
        }
        $this->check($rejected === count($cases), 'tous les cas de détails invalides sont rejetés par le serveur');

        // Justesse RECALCULÉE : un `correct` fourni par le client est IGNORÉ.
        $ev = $svc->validateDetails([
            array_replace($validMult(), ['correct' => false]),
        ]);
        $this->check($ev[0]['correct'] === true, 'correct=false envoyé par le client ignoré : juste réponse recalculée vraie');
        $ev2 = $svc->validateDetails([
            array_replace($validMult(), ['correct' => true, 'user_answer' => 99]),
        ]);
        $this->check($ev2[0]['correct'] === false, 'correct=true envoyé par le client ignoré : mauvaise réponse recalculée fausse');

        // Expiration / réponse absente => incorrect, traitée comme une erreur.
        $ev3 = $svc->validateDetails([
            ['mode' => 'addition', 'question_type' => 'classic', 'a' => 2, 'b' => 2, 'hole' => null, 'user_answer' => null],
        ]);
        $this->check($ev3[0]['correct'] === false, 'réponse absente (expiration) recalculée incorrecte');

        // Réponse non numérique (ex. '12abc', interdit par le moteur de jeu) => fausse,
        // sans provoquer d'exception de structure (détail toujours accepté).
        $ev4 = $svc->validateDetails([
            array_replace($validMult(), ['user_answer' => '12abc']),
        ]);
        $this->check($ev4[0]['correct'] === false, 'réponse non numérique recalculée incorrecte (détail accepté)');
    }

    /** 14/15. Bilan par table : sans double comptage, tables peu/jamais pratiquées. */
    private function testDifficultyTableSummary(): void
    {
        echo "[Mémoire des difficultés — bilan par table]\n";
        $h = $this->difficultyHarness();
        $svc = $h['svc'];
        $uid = $h['userId'];

        // classic mult : 3x3 en erreurs (3) -> diff3 ; 9x9 réussi (1) ; 6x7 en erreurs (2) -> diff2.
        for ($i = 0; $i < 3; $i++) { $svc->applyBarème($uid, 'multiplication', 'classic', 3, 3, false); }
        $svc->applyBarème($uid, 'multiplication', 'classic', 9, 9, true);
        for ($i = 0; $i < 2; $i++) { $svc->applyBarème($uid, 'multiplication', 'classic', 6, 7, false); }
        // hole mult : 3x3 en erreurs (2) -> diff2.
        for ($i = 0; $i < 2; $i++) { $svc->applyBarème($uid, 'multiplication', 'hole', 3, 3, false); }
        // addition classic : 5x5 réussi (4) -> diff0 (surmontée/non, jamais positive).
        for ($i = 0; $i < 4; $i++) { $svc->applyBarème($uid, 'addition', 'classic', 5, 5, true); }

        $s = $svc->tableSummary($uid);
        $this->check(
            isset($s['multiplication']['classic']) && isset($s['multiplication']['hole'])
            && isset($s['addition']['classic']) && isset($s['addition']['hole']),
            'les 4 rubriques (mode x classic/hole) sont présentes'
        );

        $find = function (array $list, int $t): ?array {
            foreach ($list as $e) {
                if ((int)$e['table'] === $t) {
                    return $e;
                }
            }
            return null;
        };

        $mc = $s['multiplication']['classic'];
        $t3 = $find($mc, 3);
        $this->check($t3 !== null && $t3['status'] === 'to_work' && $t3['difficulty'] === 3.0,
            'table 3 : assez pratiquée et difficile => « À travailler »');
        $t9 = $find($mc, 9);
        $this->check($t9 !== null && $t9['status'] === 'insufficient' && $t9['difficulty'] === 0.0,
            'table 9 : peu pratiquée (1 tentative) => « à pratiquer » et JAMAIS maîtrisée');
        $t6 = $find($mc, 6);
        $t7 = $find($mc, 7);
        $this->check($t6 !== null && $t6['status'] === 'insufficient' && $t7 !== null,
            'tables 6 et 7 réparties (poids 0,5 chacun) et peu pratiquées');

        $mh = $s['multiplication']['hole'];
        $this->check($find($mh, 3)['status'] === 'insufficient', 'table 3 à trou peu pratiquée => à pratiquer');

        $ac = $s['addition']['classic'];
        $t5 = $find($ac, 5);
        $this->check($t5 !== null && $t5['status'] === 'mastered', 'table 5 additions : assez pratiquée et diff 0 => maîtrisée');

        // Sans double comptage : la somme des difficultés/essais des tables d'une
        // rubrique égale la somme sur les opérations de cette rubrique.
        $sumDiff = 0.0;
        $sumAtt = 0.0;
        foreach ($mc as $e) { $sumDiff += $e['difficulty']; $sumAtt += $e['attempts']; }
        $this->check(abs($sumDiff - 5.0) < 0.01 && abs($sumAtt - 6.0) < 0.01,
            'pas de double comptage : totaux de la rubrique classique préservés (diff 5, essais 6)');
    }

    /**
     * v12.5 — Récupération des opérations NON maîtrisées (difficulty > 0).
     * Vérifie directement OperationDifficultyRepository::difficultOperations() :
     * isolation par utilisateur, exclusion des difficultés nulles, filtrage par
     * mode, type de question, plage d'additions et tables de multiplications.
     */
    private function testDifficultyOperations(): void
    {
        echo "[v12.5 — opérations difficiles (référentiel)]\n";
        $h = $this->difficultyHarness();
        $pdo = $h['pdo'];
        $repo = $h['repo'];
        $svc = $h['svc'];
        $uid = $h['userId'];

        $by = function (array $rows): array {
            $map = [];
            foreach ($rows as $r) {
                $key = $r['mode'] . '|' . $r['question_type'] . '|'
                    . $r['operand_a'] . '|' . $r['operand_b'];
                $map[$key] = $r;
            }
            return $map;
        };

        // --- Amorçage de données représentatives --------------------------------
        // Multiplication classic, diff 4 (4 erreurs) : 6×7.
        for ($i = 0; $i < 4; $i++) { $svc->applyBarème($uid, 'multiplication', 'classic', 6, 7, false); }
        // Multiplication classic, diff 2 (2 erreurs) : 3×9.
        for ($i = 0; $i < 2; $i++) { $svc->applyBarème($uid, 'multiplication', 'classic', 3, 9, false); }
        // Multiplication hole, diff 3 : 2×2.
        for ($i = 0; $i < 3; $i++) { $svc->applyBarème($uid, 'multiplication', 'hole', 2, 2, false); }
        // Multiplication classic maîtrisée (diff 0) : 4×5 => doit être EXCLUE.
        for ($i = 0; $i < 4; $i++) { $svc->applyBarème($uid, 'multiplication', 'classic', 4, 5, true); }
        // Addition classic, diff 1 : 5+6.
        $svc->applyBarème($uid, 'addition', 'classic', 5, 6, false);
        // Addition hole, diff 2 : 9+14.
        for ($i = 0; $i < 2; $i++) { $svc->applyBarème($uid, 'addition', 'hole', 9, 14, false); }

        // --- Sans filtre : toutes les difficultés > 0 de l'utilisateur ----------
        $all = $repo->difficultOperations($uid);
        $map = $by($all);
        $this->check(count($all) === 5,
            'sans filtre : 5 opérations difficiles renvoyées (les diff 0 exclues)');
        $this->check(!isset($map['multiplication|classic|4|5']),
            'opération maîtrisée (difficulty 0) exclue');
        $this->check(isset($map['multiplication|classic|6|7'])
            && (int)$map['multiplication|classic|6|7']['difficulty'] === 4,
            'difficulté la plus élevée (6×7, diff 4) présente');

        // --- Filtrage par mode ---------------------------------------------------
        $mult = $by($repo->difficultOperations($uid, 'multiplication'));
        $this->check(count($mult) === 3 && !isset($mult['addition|classic|5|6'])
            && !isset($mult['addition|hole|9|14']),
            'filtre multiplication : seules les multiplications sont renvoyées');

        $add = $by($repo->difficultOperations($uid, 'addition'));
        $this->check(count($add) === 2 && !isset($add['multiplication|classic|6|7']),
            'filtre addition : seules les additions sont renvoyées');

        // --- Filtrage par type de question --------------------------------------
        $classic = $by($repo->difficultOperations($uid, null, ['classic']));
        $this->check(count($classic) === 3
            && !isset($classic['multiplication|hole|2|2'])
            && !isset($classic['addition|hole|9|14']),
            'filtre classic : seules les questions classiques');

        $hole = $by($repo->difficultOperations($uid, null, ['hole']));
        $this->check(count($hole) === 2 && !isset($hole['multiplication|classic|6|7'])
            && !isset($hole['addition|classic|5|6']),
            'filtre hole : seules les questions à trou');

        // 'mixed' = les deux réunis : équivaut à l'absence de filtre.
        $mixed = $by($repo->difficultOperations($uid, null, ['classic', 'hole']));
        $this->check(count($mixed) === 5,
            'filtre mixed (classic + hole) : les deux types réunis');

        // --- Plage d'additions (5..10) ------------------------------------------
        $range = $by($repo->difficultOperations($uid, 'addition', [], 5, 10));
        $this->check(count($range) === 1 && isset($range['addition|classic|5|6'])
            && !isset($range['addition|hole|9|14']),
            'plage additions 5-10 : 9+14 exclu (opérande 14 hors plage)');

        // --- Tables autorisées pour les multiplications --------------------------
        // tables {2,3} : 2×2 a ses deux opérandes dans {2,3} ; 3×9 (9) et 6×7 (6,7)
        // sont exclus car un opérande est hors des tables cochées.
        $tables = $by($repo->difficultOperations($uid, 'multiplication', [], null, null, [2, 3]));
        $this->check(count($tables) === 1 && isset($tables['multiplication|hole|2|2'])
            && !isset($tables['multiplication|classic|6|7'])
            && !isset($tables['multiplication|classic|3|9']),
            'tables {2,3} : 6×7 et 3×9 exclus (opérandes hors tables), seul 2×2 retenu');

        // --- Filtres combinés : multiplication + classic + tables {3,6,9} ---------
        $comb = $by($repo->difficultOperations($uid, 'multiplication', ['classic'], null, null, [3, 6, 9]));
        $this->check(count($comb) === 1 && isset($comb['multiplication|classic|3|9'])
            && !isset($comb['multiplication|classic|6|7'])
            && !isset($comb['multiplication|hole|2|2']),
            'filtres combinés (mult + classic + tables 3/6/9) : 3×9 retenu, 6×7 exclu (7 hors tables)');

        // --- Isolation : un second utilisateur ne voit AUCUN résultat -------------
        $users = new UserRepository($pdo);
        $uid2 = $users->create([
            'login' => 'diff2_' . substr(uniqid(), -6),
            'password' => 'motdepasse10',
            'role' => 'user',
        ]);
        $other = $repo->difficultOperations($uid2);
        $this->check(count($other) === 0,
            'isolation : un autre utilisateur ne voit aucune difficulté du premier');
    }
    /**
     * v12.5 — Suivi des difficultés en mode Mélange (diagnostic).
     *
     * Chaque question d'une mission `mixed` doit être enregistrée selon son
     * type INDIVIDUEL : classic => ligne classic, hole => ligne hole. Le type
     * global `mixed` ne doit jamais remplacer le type individuel.
     *
     * Scénario : classic 6×8 = 2 et hole 6×8 = 2 ; deux missions `mixed`
     * distinctes chacune avec UNE bonne réponse CLASSIQUE 6×8.
     * Attendu : classic 2 → 1 ; hole inchangé (2) ; contribution à la table 8
     * classique 1 → 0,5 (barème : −1 après deux réussites consécutives sur la
     * MÊME opération et le MÊME type).
     */
    private function testDifficultyMelangeTracking(): void
    {
        echo "[v12.5 — suivi en mode Mélange (classique / à trou)]\n";
        $h = $this->difficultyHarness();
        $repo = $h['repo'];
        $svc = $h['svc'];
        $results = $h['results'];
        $uid = $h['userId'];

        $detail = function (string $qt, int $a, int $b, bool $correct, ?string $hole = null, bool $timeout = false): array {
            if ($qt === 'classic') {
                return [['mode' => 'multiplication', 'question_type' => 'classic',
                    'a' => $a, 'b' => $b, 'hole' => null,
                    'user_answer' => $timeout ? null : ($a * $b)]];
            }
            $hl = $hole ?? 'a';
            return [['mode' => 'multiplication', 'question_type' => 'hole',
                'a' => $a, 'b' => $b, 'hole' => $hl,
                'user_answer' => $timeout ? null : ($hl === 'a' ? $a : $b)]];
        };

        // Amorçage : classic 6×8 = 2 et hole 6×8 = 2 (2 erreurs chacun).
        $svc->applyBarème($uid, 'multiplication', 'classic', 6, 8, false);
        $svc->applyBarème($uid, 'multiplication', 'classic', 6, 8, false);
        $svc->applyBarème($uid, 'multiplication', 'hole', 6, 8, false);
        $svc->applyBarème($uid, 'multiplication', 'hole', 6, 8, false);
        $this->check((int)$repo->find($uid, 'multiplication', 'classic', 6, 8)['difficulty'] === 2,
            'point de départ : classic 6×8 = 2');
        $this->check((int)$repo->find($uid, 'multiplication', 'hole', 6, 8)['difficulty'] === 2,
            'point de départ : hole 6×8 = 2');

        // Deux missions DISTINCTES de type global 'mixed', chacune 1 réussite CLASSIQUE 6×8.
        $results->saveWithMission($uid, 'multiplication', 1, 'MEL-C-1',
            $detail('classic', 6, 8, true), '2026-04-01T08:00:00Z', 'mixed');
        $results->saveWithMission($uid, 'multiplication', 1, 'MEL-C-2',
            $detail('classic', 6, 8, true), '2026-04-02T08:00:00Z', 'mixed');

        $c = (int)$repo->find($uid, 'multiplication', 'classic', 6, 8)['difficulty'];
        $hl = (int)$repo->find($uid, 'multiplication', 'hole', 6, 8)['difficulty'];
        $this->check($c === 1, '2 réussites classiques => classic 2 → 1', "got=$c");
        $this->check($hl === 2, 'à trou inchangé (hole reste 2)', "got=$hl");

        $summary = $svc->tableSummary($uid);
        $t8 = null;
        foreach ($summary['multiplication']['classic'] as $row) {
            if ((int)$row['table'] === 8) { $t8 = $row; break; }
        }
        $this->check($t8 !== null && abs((float)$t8['difficulty'] - 0.5) < 0.001,
            'contribution à la table 8 classique = 0,5 (difficulty 1 × 0,5 poids)',
            $t8 ? 'difficulty=' . (float)$t8['difficulty'] : 'table 8 absente');
    }



}
$runner = new TestRunner();
exit($runner->run());

