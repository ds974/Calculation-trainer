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
     * @param string $questionType type de questions (v12.3) : classic | hole | mixed.
     * @return int identifiant de la ligne insérée.
     */
    public function insert(
        int $userId,
        string $mode,
        int $score,
        ?string $playedAt = null,
        ?string $guestId = null,
        string $questionType = 'classic'
    ): int {
        $stmt = $this->pdo->prepare(
            'INSERT INTO results (user_id, mode, score, played_at, guest_id, question_type)
             VALUES (:user_id, :mode, :score,
                     COALESCE(:played_at, strftime(\'%Y-%m-%dT%H:%M:%SZ\', \'now\')),
                     :guest_id, :question_type)'
        );
        $stmt->execute([
            'user_id'       => $userId,
            'mode'          => $mode,
            'score'         => $score,
            'played_at'     => $playedAt,
            'guest_id'      => $guestId,
            'question_type' => $questionType,
        ]);
        return (int)$this->pdo->lastInsertId();
    }

    /**
     * Liste l'historique d'un utilisateur, du plus récent au plus ancien.
     *
     * @return array<int,array<string,mixed>> lignes avec champs publics uniquement.
     */
    public function findByUser(int $userId, int $limit = 200): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT id, mode, score, played_at, question_type
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

    /**
     * Totaux globaux d'un mode pour un utilisateur (toutes les parties).
     *
     * @return array{total:int, avg_score:float|null, best_score:int|null}
     */
    public function totals(int $userId, string $mode): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT COUNT(*) AS total, AVG(score) AS avg_score, MAX(score) AS best_score
             FROM results
             WHERE user_id = :user_id AND mode = :mode'
        );
        $stmt->execute(['user_id' => $userId, 'mode' => $mode]);
        $row = $stmt->fetch();
        return [
            'total'      => (int)($row['total'] ?? 0),
            'avg_score'  => $row['avg_score'] !== null ? (float)$row['avg_score'] : null,
            'best_score' => $row['best_score'] !== null ? (int)$row['best_score'] : null,
        ];
    }

    /**
     * Nombre de parties d'un mode jouées depuis un horodatage UTC (inclus).
     */
    public function countSince(int $userId, string $mode, string $sinceUtc): int
    {
        $stmt = $this->pdo->prepare(
            'SELECT COUNT(*) FROM results
             WHERE user_id = :user_id AND mode = :mode AND played_at >= :since'
        );
        $stmt->execute(['user_id' => $userId, 'mode' => $mode, 'since' => $sinceUtc]);
        return (int)$stmt->fetchColumn();
    }

    /**
     * Score moyen d'un mode sur une fenêtre (depuis un horodatage UTC inclus).
     *
     * @return float|null null si aucune partie dans la fenêtre.
     */
    public function periodAverage(int $userId, string $mode, string $sinceUtc): ?float
    {
        $stmt = $this->pdo->prepare(
            'SELECT AVG(score) FROM results
             WHERE user_id = :user_id AND mode = :mode AND played_at >= :since'
        );
        $stmt->execute(['user_id' => $userId, 'mode' => $mode, 'since' => $sinceUtc]);
        $avg = $stmt->fetchColumn();
        return $avg !== null && $avg !== false ? (float)$avg : null;
    }

    /**
     * Les N parties les plus récentes d'un mode, du plus récent au plus ancien.
     *
     * @return array<int,array<string,mixed>> lignes {score, played_at}.
     */
    public function recentScores(int $userId, string $mode, int $limit): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT score, played_at FROM results
             WHERE user_id = :user_id AND mode = :mode
             ORDER BY played_at DESC, id DESC
             LIMIT :limit'
        );
        $stmt->bindValue('user_id', $userId, PDO::PARAM_INT);
        $stmt->bindValue('mode', $mode, PDO::PARAM_STR);
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->execute();
        return $stmt->fetchAll();
    }

    /**
     * Dates (UTC) des parties d'un mode depuis un horodatage UTC (inclus),
     * du plus récent au plus ancien. Utilisé pour l'histogramme journalier.
     *
     * @return array<int,array<string,string>> lignes {played_at}.
     */
    public function playedAtValues(int $userId, string $mode, string $sinceUtc): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT played_at FROM results
             WHERE user_id = :user_id AND mode = :mode AND played_at >= :since
             ORDER BY played_at DESC, id DESC'
        );
        $stmt->execute(['user_id' => $userId, 'mode' => $mode, 'since' => $sinceUtc]);
        return $stmt->fetchAll();
    }
}
