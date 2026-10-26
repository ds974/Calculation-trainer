<?php

declare(strict_types=1);

/**
 * UserRepository — Accès aux données de la table `users`.
 *
 * Toutes les requêtes utilisent des requêtes préparées PDO.
 * Le hachage des mots de passe est réalisé ici (Argon2id), jamais stocké en clair.
 */

final class UserRepository
{
    public function __construct(private PDO $pdo)
    {
    }

    /**
     * Recherche un utilisateur par login (insensible à la casse grâce à COLLATE NOCASE).
     *
     * @return array<string,mixed>|null
     */
    public function findByLogin(string $login): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM users WHERE login = :login LIMIT 1');
        $stmt->execute(['login' => $login]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    /**
     * Recherche un utilisateur par identifiant.
     *
     * @return array<string,mixed>|null
     */
    public function findById(int $id): ?array
    {
        $stmt = $this->pdo->prepare('SELECT * FROM users WHERE id = :id LIMIT 1');
        $stmt->execute(['id' => $id]);
        $row = $stmt->fetch();
        return $row === false ? null : $row;
    }

    /**
     * Crée un nouvel utilisateur.
     *
     * @param array<string,mixed> $data login, password (clair), role.
     *        L'e-mail n'est plus géré : la colonne `email` reste à NULL.
     * @return int l'identifiant du nouvel utilisateur.
     * @throws RuntimeException si le login est déjà pris.
     */
    public function create(array $data): int
    {
        // Unicité (insensible à la casse) : on vérifie d'abord.
        if ($this->findByLogin((string)$data['login']) !== null) {
            throw new RuntimeException(
                "Ce nom d'utilisateur est déjà utilisé."
            );
        }

        $hash = password_hash((string)$data['password'], PASSWORD_ARGON2ID);

        $stmt = $this->pdo->prepare(
            'INSERT INTO users (login, email, password_hash, role)
             VALUES (:login, NULL, :hash, :role)'
        );
        $stmt->execute([
            'login' => (string)$data['login'],
            'hash'  => $hash,
            'role'  => (string)($data['role'] ?? 'user'),
        ]);

        return (int)$this->pdo->lastInsertId();
    }

    /**
     * Vérifie un mot de passe en clair contre l'empreinte d'un utilisateur.
     */
    public function verifyPassword(array $user, string $plainPassword): bool
    {
        return password_verify($plainPassword, (string)$user['password_hash']);
    }

    /**
     * Met à jour le mot de passe d'un utilisateur (le mot de passe est haché).
     */
    public function updatePassword(int $userId, string $plainPassword): void
    {
        $hash = password_hash($plainPassword, PASSWORD_ARGON2ID);
        $stmt = $this->pdo->prepare('UPDATE users SET password_hash = :hash WHERE id = :id');
        $stmt->execute(['hash' => $hash, 'id' => $userId]);
    }

    /**
     * Met à jour le rôle d'un utilisateur (user ou admin).
     */
    public function updateRole(int $userId, string $role): void
    {
        $stmt = $this->pdo->prepare('UPDATE users SET role = :role WHERE id = :id');
        $stmt->execute(['role' => $role, 'id' => $userId]);
    }

    /**
     * Compte les utilisateurs (utile pour l'administration).
     */
    public function count(): int
    {
        return (int)$this->pdo->query('SELECT COUNT(*) AS c FROM users')->fetch()['c'];
    }

    /**
     * Compte les administrateurs (protection du dernier admin).
     */
    public function countAdmins(): int
    {
        $stmt = $this->pdo->prepare('SELECT COUNT(*) AS c FROM users WHERE role = :role');
        $stmt->execute(['role' => 'admin']);
        return (int)$stmt->fetch()['c'];
    }
}
