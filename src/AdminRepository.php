<?php

declare(strict_types=1);

/**
 * AdminRepository — Accès aux données pour l'espace d'administration.
 *
 * Regroupe les requêtes de lecture/agrégation propres au rôle administrateur :
 *  - consultation des informations administratives d'un compte (dont son
 *    historique de parties, en lecture seule) ;
 *  - statistiques globales sur tous les comptes et toutes les parties.
 *
 * Toutes les requêtes sont préparées (PDO). Aucun hachage de mot de passe ni
 * colonne `email` n'est jamais exposé par ces méthodes.
 *
 * La gestion des comptes en écriture (rôle, activation, mot de passe) est assurée
 * par UserRepository + le mot de passe haché Argon2id.
 */

final class AdminRepository
{
    public function __construct(private PDO $pdo)
    {
    }

    /**
     * Historique (lecture seule) des parties d'un compte, du plus récent au plus ancien.
     *
     * @return array<int,array<string,mixed>> champs publics uniquement (aucune donnée sensible).
     */
    public function historyFor(int $userId, int $limit = 200): array
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

    /**
     * Nombre de parties jouées par un compte (tous modes confondus).
     */
    public function playedGamesFor(int $userId): int
    {
        $stmt = $this->pdo->prepare('SELECT COUNT(*) AS c FROM results WHERE user_id = :user_id');
        $stmt->execute(['user_id' => $userId]);
        return (int)$stmt->fetch()['c'];
    }

    /**
     * Statistiques globales agrégées sur tous les comptes et toutes les parties.
     *
     * @param string $since7dUtc  horodatage UTC de début de la fenêtre 7 jours.
     * @param string $since30dUtc horodatage UTC de début de la fenêtre 30 jours.
     * @return array<string,mixed> voir AdminService.
     */
    public function globalTotals(string $since7dUtc, string $since30dUtc): array
    {
        // Total des comptes et répartition des rôles.
        $stmt = $this->pdo->query(
            'SELECT
                COUNT(*) AS total_users,
                SUM(CASE WHEN role = \'admin\' THEN 1 ELSE 0 END) AS admins,
                SUM(CASE WHEN role = \'admin\' AND is_active = 1 THEN 1 ELSE 0 END) AS admins_active,
                SUM(CASE WHEN is_active = 1 THEN 1 ELSE 0 END) AS active_users
             FROM users'
        );
        $row = $stmt->fetch();

        // Total des parties et répartition par mode.
        $stmt = $this->pdo->query(
            'SELECT
                COUNT(*) AS total_games,
                SUM(CASE WHEN mode = \'multiplication\' THEN 1 ELSE 0 END) AS multi,
                SUM(CASE WHEN mode = \'addition\' THEN 1 ELSE 0 END) AS addi
             FROM results'
        );
        $games = $stmt->fetch();

        // Parties dans les fenêtres 7 et 30 derniers jours.
        $stmt = $this->pdo->prepare(
            'SELECT COUNT(*) AS c FROM results WHERE played_at >= :since7'
        );
        $stmt->execute(['since7' => $since7dUtc]);
        $games7 = (int)$stmt->fetchColumn();

        $stmt = $this->pdo->prepare(
            'SELECT COUNT(*) AS c FROM results WHERE played_at >= :since30'
        );
        $stmt->execute(['since30' => $since30dUtc]);
        $games30 = (int)$stmt->fetchColumn();

        return [
            'users' => [
                'total'  => (int)($row['total_users'] ?? 0),
                'admins' => (int)($row['admins'] ?? 0),
                'admins_active' => (int)($row['admins_active'] ?? 0),
                'active' => (int)($row['active_users'] ?? 0),
            ],
            'games' => [
                'total'            => (int)($games['total_games'] ?? 0),
                'multiplication'   => (int)($games['multi'] ?? 0),
                'addition'         => (int)($games['addi'] ?? 0),
                'last_7d'          => $games7,
                'last_30d'         => $games30,
            ],
        ];
    }

    /**
     * Répartition du nombre de parties par jour local (fuseau La Réunion, UTC+4)
     * sur les derniers jours, pour la tendance. Retourne une liste ordonnée.
     *
     * @return array<int,array{day:string,games:int}> chaque jour présent, même à 0.
     */
    public function dailyGameCount(string $sinceUtc, int $days, string $reunionTz): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT played_at FROM results WHERE played_at >= :since ORDER BY played_at ASC, id ASC'
        );
        $stmt->execute(['since' => $sinceUtc]);
        $rows = $stmt->fetchAll();

        $byDay = [];
        foreach ($rows as $row) {
            $local = (new DateTimeImmutable((string)$row['played_at'], new DateTimeZone('UTC')))
                ->setTimezone(new DateTimeZone($reunionTz))
                ->format('Y-m-d');
            $byDay[$local] = ($byDay[$local] ?? 0) + 1;
        }

        // Construit la série continue des N derniers jours (du plus ancien au plus récent).
        $reunionNow = (new DateTimeImmutable('now', new DateTimeZone('UTC')))
            ->setTimezone(new DateTimeZone($reunionTz));
        $today = DateTimeImmutable::createFromFormat(
            '!Y-m-d',
            $reunionNow->format('Y-m-d'),
            new DateTimeZone($reunionTz)
        );

        $out = [];
        for ($i = $days - 1; $i >= 0; $i--) {
            $day = $today->sub(new DateInterval('P' . $i . 'D'))->format('Y-m-d');
            $out[] = ['day' => $day, 'games' => $byDay[$day] ?? 0];
        }
        return $out;
    }
}
