<?php

declare(strict_types=1);

/**
 * LeaderboardService — Classement partagé côté serveur (v12.8-B4.1).
 *
 * Construit le classement des meilleures parties à partir des résultats
 * enregistrés dans SQLite (`results`). Seuls les comptes ACTIFS apparaissent ;
 * les comptes désactivés et les parties invitées ne sont jamais exposés.
 *
 * Règles métier (documentées, déterministes) :
 *  1. Un utilisateur n'apparaît qu'UNE SEULE FOIS par classement, avec SA
 *     meilleure partie selon les critères (par joueur) :
 *        - score décroissant ;
 *        - durée connue avant durée inconnue (une partie SANS durée passe
 *          APRÈS une partie chronométrée à score égal) ;
 *        - durée croissante (la plus courte gagne à score égal) ;
 *        - date de réalisation croissante (départage déterministe) ;
 *        - identifiant de résultat croissant (dernier recours, strictement
 *          déterministe).
 *  2. Le classement final applique le MÊME ordre sur les meilleures parties
 *     retenues.
 *  3. Les anciennes parties avec `duration_ms = NULL` restent éligibles et sont
 *     classées après les parties chronométrées à score égal ; aucun score
 *     existant n'est modifié.
 *
 * Filtres pris en charge :
 *  - mode           : 'multiplication' | 'addition'      (défaut 'multiplication') ;
 *  - school_level   : l'un des six niveaux, 'unspecified',
 *                     ou 'all' = tous niveaux confondus  (défaut 'all') ;
 *  - question_type  : 'classic' | 'hole' | 'mixed'        (défaut 'classic') ;
 *  - limit          : entier de 1 à 100                  (défaut 20).
 *
 * Confidentialité : la requête ne joint `users` que pour récupérer le login
 * public (champ déjà exposé par l'API) et le statut d'activation. Aucun
 * e-mail, identifiant interne, rôle, hash, donnée de session ou niveau de
 * profil courant n'est renvoyé.
 *
 * Implémentation SQL : sélection du meilleur résultat par utilisateur via
 * ROW_NUMBER() OVER (PARTITION BY user_id ...) (SQLite >= 3.25 ; le moteur
 * embarqué est plus récent). Les rangs sont attribués en PHP sur la liste
 * triée, pour un ordre total déterministe et vérifiable. Toutes les requêtes
 * sont préparées ; aucun paramètre HTTP ne sert à construire du SQL.
 */

final class LeaderboardService
{
    /** Nombre maximal de lignes retournées. */
    private const MAX_LIMIT = 100;

    /** Valeur de filtre « tous les niveaux confondus » (jamais stockée en base). */
    private const ALL_LEVELS = 'all';

    /** Les six niveaux scolaires + 'unspecified' (identifiants stables en base). */
    private const FILTER_LEVELS = [
        'preschool', 'elementary_lower', 'elementary_upper',
        'middle_school', 'high_school', 'higher_adult', 'unspecified',
    ];

    public function __construct(private PDO $pdo)
    {
    }

    /**
     * Retourne le classement partagé pour les filtres donnés.
     *
     * @param string $mode         'multiplication' | 'addition'.
     * @param string $schoolLevel  niveau filtré, ou 'all'.
     * @param string $questionType 'classic' | 'hole' | 'mixed'.
     * @param int    $limit        nombre maximal de lignes (1..100).
     * @return array{title:string,
     *              mode:string,
     *              school_level:string,
     *              question_type:string,
     *              entries:array<int,array{rank:int,display_name:string,score:int,duration_ms:?int,played_at:string}>}
     * @throws InvalidArgumentException si un filtre est invalide.
     */
    public function leaderboard(
        string $mode = 'multiplication',
        string $schoolLevel = self::ALL_LEVELS,
        string $questionType = 'classic',
        int $limit = 20
    ): array {
        if (!Validator::mode($mode)) {
            throw new InvalidArgumentException('Mode inconnu.');
        }
        if ($schoolLevel !== self::ALL_LEVELS && !in_array($schoolLevel, self::FILTER_LEVELS, true)) {
            throw new InvalidArgumentException('Niveau scolaire inconnu.');
        }
        if (!Validator::questionType($questionType)) {
            throw new InvalidArgumentException('Type de questions inconnu.');
        }
        if ($limit < 1 || $limit > self::MAX_LIMIT) {
            throw new InvalidArgumentException('Limite invalide.');
        }

        $sql = 'SELECT best.score, best.duration_ms, best.played_at, best.display_name
                FROM (
                    SELECT
                        r.id,
                        r.score,
                        r.duration_ms,
                        r.played_at,
                        u.login AS display_name,
                        ROW_NUMBER() OVER (
                            PARTITION BY r.user_id
                            ORDER BY r.score DESC,
                                     (r.duration_ms IS NULL) ASC,
                                     r.duration_ms ASC,
                                     r.played_at ASC,
                                     r.id ASC
                        ) AS rn
                    FROM results r
                    JOIN users u ON u.id = r.user_id
                    WHERE u.is_active = 1';
        $params = [];

        $sql .= ' AND r.mode = :mode';
        $params['mode'] = $mode;

        if ($schoolLevel !== self::ALL_LEVELS) {
            $sql .= ' AND r.school_level = :school_level';
            $params['school_level'] = $schoolLevel;
        }

        $sql .= ' AND r.question_type = :question_type';
        $params['question_type'] = $questionType;

        $sql .= '
                ) best
                WHERE best.rn = 1
                ORDER BY best.score DESC,
                         (best.duration_ms IS NULL) ASC,
                         best.duration_ms ASC,
                         best.played_at ASC,
                         best.id ASC
                LIMIT :limit';

        $stmt = $this->pdo->prepare($sql);
        foreach ($params as $key => $value) {
            $stmt->bindValue($key, $value, PDO::PARAM_STR);
        }
        $stmt->bindValue('limit', $limit, PDO::PARAM_INT);
        $stmt->execute();

        $entries = [];
        $rank = 0;
        foreach ($stmt->fetchAll(PDO::FETCH_ASSOC) as $row) {
            $rank++;
            $entries[] = [
                'rank'         => $rank,
                'display_name' => (string)$row['display_name'],
                'score'        => (int)$row['score'],
                'duration_ms'  => $row['duration_ms'] !== null ? (int)$row['duration_ms'] : null,
                'played_at'    => (string)$row['played_at'],
            ];
        }

        return [
            'title'         => 'classement_partage',
            'mode'          => $mode,
            'school_level'  => $schoolLevel,
            'question_type' => $questionType,
            'entries'       => $entries,
        ];
    }
}
