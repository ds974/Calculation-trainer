<?php

declare(strict_types=1);

/**
 * StatsService — Statistiques personnelles d'un utilisateur connecté.
 *
 * Calcule, UNIQUEMENT depuis l'identité issue de la session (user_id fourni par
 * le contrôleur), les agrégats par mode de jeu ('multiplication' | 'addition') :
 *  - totaux globaux : nombre de parties, score moyen sur 10, meilleur score ;
 *  - moyennes sur fenêtres glissantes de 7 et 30 jours (UTC) ;
 *  - courbe d'évolution des scores sur les 30 dernières parties ;
 *  - histogramme du nombre de parties par jour sur les 30 derniers jours,
 *    regroupé selon le fuseau Indian/Reunion (UTC+4).
 *
 * Conventions temporelles :
 *  - les dates sont TOUJOURS stockées en UTC en base (format ISO8601 avec Z) ;
 *  - les fenêtres de 7 et 30 jours sont "glissantes" : calculées depuis
 *    l'instant courant UTC (`now - P7D` / `now - P30D`), indépendamment du
 *    fuseau du serveur ;
 *  - le regroupement journalier de l'histogramme se fait selon le jour LOCAL
 *    de la Réunion (chaque played_at UTC est converti en date Reunion) ;
 *  - chaque journée des 30 derniers jours est présente dans le résultat, avec
 *    `games = 0` si aucune partie n'y a été jouée (tracé continu et correct).
 *
 * Aucun champ supplémentaire n'est nécessaire en base : on réutilise `results`
 * (score, mode, played_at, user_id). Le résultat importé depuis le mode invité
 * réside dans la même table => il est naturellement pris en compte.
 */

final class StatsService
{
    /** Fuseau de regroupement journalier (La Réunion, UTC+4). */
    private const REUNION_TZ = 'Indian/Reunion';

    /** Nombre de parties retenues pour la courbe d'évolution. */
    private const CURVE_LIMIT = 30;

    /** Nombre de jours de l'histogramme et des fenêtres de moyenne. */
    private const DAILY_DAYS = 30;

    public function __construct(
        private ResultRepository $results
    ) {
    }

    /**
     * Statistiques personnelles d'un mode pour l'utilisateur connecté.
     *
     * @param int                 $userId identifiant authentifié (jamais issu du client).
     * @param string              $mode   'multiplication' ou 'addition'.
     * @param DateTimeImmutable|null $now  référence temporelle (UTC) pour tests ; sinon "maintenant".
     * @return array<string,mixed> structure décrite dans la doc de la classe.
     * @throws InvalidArgumentException si le mode est invalide.
     */
    public function stats(int $userId, string $mode, ?DateTimeImmutable $now = null): array
    {
        if (!Validator::mode($mode)) {
            throw new InvalidArgumentException('Mode de jeu invalide.');
        }

        $now = $now ?? new DateTimeImmutable('now', new DateTimeZone('UTC'));
        if ($now->getTimezone()->getName() !== 'UTC') {
            $now = $now->setTimezone(new DateTimeZone('UTC'));
        }

        $fmt = 'Y-m-d\TH:i:s\Z';
        $d7  = $now->sub(new DateInterval('P7D'));
        $d30 = $now->sub(new DateInterval('P30D'));

        // --- Totaux globaux (toutes les parties de ce mode) ---
        $totals = $this->results->totals($userId, $mode);

        // --- Fenêtres glissantes ---
        $games7  = $this->results->countSince($userId, $mode, $d7->format($fmt));
        $games30 = $this->results->countSince($userId, $mode, $d30->format($fmt));
        $avg7    = $this->roundAvg($this->results->periodAverage($userId, $mode, $d7->format($fmt)));
        $avg30   = $this->roundAvg($this->results->periodAverage($userId, $mode, $d30->format($fmt)));

        // --- Courbe : 30 dernières parties (par récence), rendues chronologiques ---
        $progression = [];
        $rows = $this->results->recentScores($userId, $mode, self::CURVE_LIMIT);
        foreach (array_reverse($rows) as $i => $row) {
            $progression[] = [
                'rank'      => $i + 1,
                'score'     => (int)$row['score'],
                'played_at' => (string)$row['played_at'],
            ];
        }

        // --- Histogramme journalier (fuseau Indian/Reunion) sur 30 jours ---
        $daily = $this->buildDailyHistogram(
            $this->results->playedAtValues($userId, $mode, $d30->format($fmt)),
            $now
        );

        return [
            'mode'             => $mode,
            'generated_at_utc' => $now->format($fmt),
            'totals' => [
                'games'      => $totals['total'],
                'avg_score'  => $this->roundAvg($totals['avg_score']),
                'best_score' => $totals['best_score'],
            ],
            'periods' => [
                'last_7d'  => ['games' => $games7,  'avg_score' => $avg7],
                'last_30d' => ['games' => $games30, 'avg_score' => $avg30],
            ],
            'progression' => $progression,
            'daily_games' => $daily,
        ];
    }

    /**
     * Construit la liste des 30 derniers jours (dates locales Reunion), chaque
     * jour étant présent même sans partie (games = 0).
     *
     * @param array<int,array<string,string>> $playedAt lignes {played_at} (UTC).
     * @param DateTimeImmutable $now référence temporelle UTC.
     * @return array<int,array{day:string,games:int}>
     */
    private function buildDailyHistogram(array $playedAt, DateTimeImmutable $now): array
    {
        $byDay = [];
        foreach ($playedAt as $row) {
            $local = (new DateTimeImmutable((string)$row['played_at'], new DateTimeZone('UTC')))
                ->setTimezone(new DateTimeZone(self::REUNION_TZ))
                ->format('Y-m-d');
            $byDay[$local] = ($byDay[$local] ?? 0) + 1;
        }

        // Jour "d'aujourd'hui" en date locale Reunion.
        $reunionNow = $now->setTimezone(new DateTimeZone(self::REUNION_TZ));
        $today = DateTimeImmutable::createFromFormat(
            '!Y-m-d',
            $reunionNow->format('Y-m-d'),
            new DateTimeZone(self::REUNION_TZ)
        );

        $daily = [];
        for ($i = self::DAILY_DAYS - 1; $i >= 0; $i--) {
            $day = $today->sub(new DateInterval('P' . $i . 'D'))->format('Y-m-d');
            $daily[] = ['day' => $day, 'games' => $byDay[$day] ?? 0];
        }
        return $daily;
    }

    /** Arrondit une moyenne à 1 décimale (ou renvoie null). */
    private function roundAvg(?float $value): ?float
    {
        if ($value === null) {
            return null;
        }
        return round($value, 1);
    }
}
