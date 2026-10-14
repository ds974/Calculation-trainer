<?php

declare(strict_types=1);

/**
 * ResultRepository — Accès aux données de la table `results`.
 *
 * Toutes les requêtes utilisent des requêtes préparées PDO. La table `results`
 * est indexée par utilisateur ; on n'y accède jamais « en masse » : toutes les
 * lectures sont restreintes à un `user_id` donné par le service métier.
 */

final class ResultRepository
{
    public function __construct(private PDO $pdo)
    {
    }

    /**
     * Insère un résultat de partie pour un utilisateur.
     *
     * @param int    $userId   identifiant de l'utilisateur connecté.
     * @param string $mode     'multiplication' ou 'addition'.
     * @param int    $score    score sur 10.
     * @param ?string $playedAt date/heure UTC (format 'Y-m-d\TH:i:s\Z'), sinon SQLite 'now'.
     * @param ?string $guestId  identifiant d'origine (partie invitée), sinon null.
     * @return int identifiant de la ligne insérée.
     */
    public function insert(
        int $userId,
        string $mode,
        int $score,
        ?string $playedAt = null,
        ?string $guestId = null
    ): int {
        $stmt = $this->pdo->prepare(
            'INSERT INTO results (user_id, mode, score, played_at, guest_id)
             VALUES (:user_id, :mode, :score,
                     COALESCE(:played_at, strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\')),
                     :guest_id)'
        );
        $stmt->execute([
            'user_id'   => $userId,
            'mode'      => $mode,
            'score'     => $score,
            'played_at' => $playedAt,
            'guest_id'  => $guestId,
        ]);
        return (int)$this->pdo->lastInsertId();
    }

    /**
     * Indique si un résultat avec le guest_id donné existe déjà pour cet utilisateur.
     *
     * @return bool true si la combinaison (user_id, guest_id) est déjà présente.
     */
    public function guestIdExists(int $userId, string $guestId): bool
    {
        $stmt = $this->pdo->prepare(
            'SELECT 1 FROM results WHERE user_id = :user_id AND guest_id = :guest_id LIMIT 1'
        );
        $stmt->execute(['user_id' => $userId, 'guest_id' => $guestId]);
        return $stmt->fetch() !== false;
    }

    /**
     * Liste l'historique d'un utilisateur, du plus récent au plus ancien.
     *
     * @return array<int,array<string,mixed>> lignes avec champs publics uniquement.
     */
    public function findByUser(int $userId, int $limit = 200): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, mode, score, played_at
             FROM results
             WHERE user_id = :user_id
             ORDER BY played_at DESC, id DESC
             LIMIT :limit'
        );
        $stmt->bindValue('user_id', $userId, PDO::PARAM_INT);
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->fetchAll();
    }
}
