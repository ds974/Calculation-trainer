<?php

declare(strict_types=1);

/**
 * AuthService — Authentification et gestion de session.
 *
 * Orchestre l'inscription, la connexion (avec limitation des tentatives),
 * la déconnexion, ainsi que les modifications de profil et de mot de passe.
 *
 * Sécurité :
 *  - hachage Argon2id via UserRepository ;
 *  - requêtes préparées PDO ;
 *  - régénération de l'identifiant de session après connexion ;
 *  - limitation des tentatives de connexion (anti brute-force) ;
 *  - messages d'erreur génériques ne révélant pas l'existence d'un compte.
 */

final class AuthService
{
    /** Nombre maximal de tentatives échouées avant verrouillage. */
    private const MAX_ATTEMPTS = 5;

    /** Fenêtre de verrouillage (en secondes). */
    private const LOCKOUT_SECONDS = 900; // 15 minutes

    /** Fenêtre de comptage des tentatives (en secondes). */
    private const ATTEMPTS_WINDOW = 900;

    public function __construct(
        private PDO $pdo,
        private UserRepository $users
    ) {
    }

    /**
     * Inscription d'un nouvel utilisateur.
     *
     * @param array<string,mixed> $data login, password (et optionnellement un
     *        champ `email` résiduel d'un ancien client, désormais IGNORÉ).
     * @return array<string,mixed> l'utilisateur public (sans empreinte).
     * @throws InvalidArgumentException si validation ou unicité échouée.
     */
    public function register(array $data): array
    {
        $login = (string)($data['login'] ?? '');
        $password = (string)($data['password'] ?? '');
        // L'e-mail n'est plus géré : même si un ancien client le transmet,
        // il est ignoré et jamais stocké (la colonne reste à NULL).

        // Validation côté serveur.
        $err = Validator::login($login)
            ?? Validator::password($password);
        if ($err !== null) {
            throw new InvalidArgumentException($err);
        }

        // Unicité (insensible à la casse).
        if ($this->users->findByLogin($login) !== null) {
            // Message volontairement neutre.
            throw new InvalidArgumentException('Ce nom d\'utilisateur est déjà utilisé.');
        }

        $id = $this->users->create([
            'login'    => $login,
            'password' => $password,
            'role'     => 'user',
        ]);

        return $this->publicUser($this->users->findById($id));
    }

    /**
     * Tente une connexion.
     *
     * @return array<string,mixed> l'utilisateur public en cas de succès.
     * @throws RuntimeException en cas d'échec (verrouillage ou identifiants invalides).
     */
    public function login(string $login, string $password): array
    {
        $ip = $this->clientIp();

        // 1. Vérifier le verrouillage avant même de consulter le mot de passe.
        if ($this->isLockedOut($login, $ip)) {
            throw new RuntimeException('Trop de tentatives. Réessayez dans quelques minutes.', 429);
        }

        $user = $this->users->findByLogin($login);

        // Deux cas traités de manière identique pour ne pas révéler l'existence du compte :
        // utilisateur inexistant OU mot de passe incorrect => échec générique.
        $known = $user !== null && $this->users->verifyPassword($user, $password);

        if (!$known) {
            $this->recordFailure($login, $ip);
            throw new RuntimeException('Identifiants invalides.', 401);
        }

        // Compte désactivé par un administrateur : refus de connexion.
        // Vérifiée APRÈS vérification du mot de passe, pour ne pas révéler à un
        // tiers (qui ne connaîtrait pas le mot de passe) l'existence/l'état d'un
        // compte : seul le détenteur légitime, identifié par son mot de passe,
        // peut voir ce message. L'historique du compte est conservé tel quel.
        if (isset($user['is_active']) && (int)$user['is_active'] !== 1) {
            $this->recordFailure($login, $ip);
            throw new RuntimeException('Ce compte est désactivé. Contactez un administrateur.', 403);
        }

        // Succès : on réinitialise le compteur et on régénère la session.
        $this->clearFailures($login, $ip);
        // Enregistre l'horodatage UTC du dernier accès (informations administratives).
        $this->users->recordLogin((int)$user['id']);

        Security::regenerateSession();
        $_SESSION['user_id'] = (int)$user['id'];
        $_SESSION['role'] = (string)$user['role'];

        return $this->publicUser($user);
    }

    /**
     * Déconnecte l'utilisateur courant.
     */
    public function logout(): void
    {
        Security::destroySession();
    }

    /**
     * Renvoie l'utilisateur connecté, ou null si aucune session valide.
     *
     * @return array<string,mixed>|null
     */
    public function currentUser(): ?array
    {
        $userId = (int)($_SESSION['user_id'] ?? 0);
        if ($userId <= 0) {
            return null;
        }
        $user = $this->users->findById($userId);
        if ($user === null) {
            // Compte absent de la base : aucune session ne doit rester valable.
            return null;
        }
        // Un compte désactivé voit sa session IMMÉDIATEMENT rendue inutilisable :
        // on recharge l'état depuis la base à chaque requête, donc dès qu'un
        // administrateur désactive le compte, toute session déjà ouverte cesse
        // de fonctionner (cette requête comme les suivantes renvoient 401).
        if (isset($user['is_active']) && (int)$user['is_active'] !== 1) {
            return null;
        }
        return $this->publicUser($user);
    }

    /**
     * Modifie le mot de passe, après vérification de l'ancien.
     *
     * @throws RuntimeException si l'ancien mot de passe est incorrect.
     * @throws InvalidArgumentException si le nouveau mot de passe est invalide.
     */
    public function changePassword(int $userId, string $oldPassword, string $newPassword): void
    {
        $user = $this->users->findById($userId);
        if ($user === null) {
            throw new RuntimeException('Utilisateur introuvable.', 404);
        }
        if (!$this->users->verifyPassword($user, $oldPassword)) {
            throw new RuntimeException('L\'ancien mot de passe est incorrect.', 400);
        }
        $err = Validator::password($newPassword);
        if ($err !== null) {
            throw new InvalidArgumentException($err);
        }
        $this->users->updatePassword($userId, $newPassword);
    }

    /**
     * Vérifie que l'utilisateur possède le rôle administrateur.
     *
     * @throws RuntimeException code 401 si non authentifié, 403 si non admin.
     */
    public function requireAdmin(?array $user): void
    {
        if ($user === null) {
            throw new RuntimeException('Authentification requise.', 401);
        }
        if (($user['role'] ?? '') !== 'admin') {
            throw new RuntimeException('Accès réservé aux administrateurs.', 403);
        }
    }

    /**
     * Sélectionne l'utilisateur final de manière sécurisée (lecture seule).
     * Sert de point d'accès pour l'étape 3 (statistiques).
     *
     * @return array<string,mixed>|null
     */
    public function publicUser(array $row): array
    {
        return [
            'id'            => (int)$row['id'],
            'login'         => (string)$row['login'],
            'role'          => (string)$row['role'],
            'created_at'    => (string)$row['created_at'],
            'is_active'     => isset($row['is_active']) ? (int)$row['is_active'] === 1 : true,
            'last_login_at' => isset($row['last_login_at']) ? (string)$row['last_login_at'] : null,
        ];
    }

    // --- Limitation des tentatives de connexion ---

    private function isLockedOut(string $login, string $ip): bool
    {
        $failures = $this->countFailures($login, $ip);
        return $failures >= self::MAX_ATTEMPTS;
    }

    private function countFailures(string $login, string $ip): int
    {
        $since = gmdate('Y-m-d\TH:i:s\Z', time() - self::ATTEMPTS_WINDOW);
        $sql = 'SELECT COUNT(*) FROM login_attempts
                WHERE success = 0 AND attempted_at >= :since
                  AND (login = :login OR ip_address = :ip)';
        $stmt = $this->pdo->prepare($sql);
        $stmt->execute(['since' => $since, 'login' => $login, 'ip' => $ip]);
        return (int)$stmt->fetchColumn();
    }

    private function recordFailure(string $login, string $ip): void
    {
        $stmt = $this->pdo->prepare(
            'INSERT INTO login_attempts (login, ip_address, success) VALUES (?, ?, 0)'
        );
        $stmt->execute([$login, $ip]);
    }

    private function clearFailures(string $login, string $ip): void
    {
        $stmt = $this->pdo->prepare(
            'DELETE FROM login_attempts
             WHERE success = 0 AND (login = ? OR ip_address = ?)'
        );
        $stmt->execute([$login, $ip]);
    }

    /**
     * Adresse IP du client, avec échappement des champs X-Forwarded-For.
     */
    private function clientIp(): string
    {
        if (!empty($_SERVER['REMOTE_ADDR'])) {
            $ip = $_SERVER['REMOTE_ADDR'];
        } elseif (!empty($_SERVER['HTTP_X_FORWARDED_FOR'])) {
            $ip = trim(explode(',', (string)$_SERVER['HTTP_X_FORWARDED_FOR'])[0]);
        } else {
            $ip = 'cli';
        }
        return mb_substr($ip, 0, 45);
    }
}

