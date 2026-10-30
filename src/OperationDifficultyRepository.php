<?php

declare(strict_types=1);

/**
 * OperationDifficultyRepository — Accès à la table `operations_difficulty`.
 *
 * Responsabilités :
 *  - lecture d'une opération agrégée (identifiée par utilisateur + mode +
 *    type de question + opérandes normalisés) ;
 *  - insertion initiale (ligne vierge) et mise à jour d'un état calculé par le
 *    service métier (OperationDifficultyService) ;
 *  - récupération de TOUTES les opérations d'un utilisateur pour le calcul du
 *    bilan par table (lecture restreinte à un user_id, comme toute la base).
 *
 * Le barème (réussites successives, erreurs, retour à zéro) est calculé par le
 * service ; ce dépôt ne contient aucune règle métier, uniquement du stockage
 * sur des requêtes préparées PDO. La normalisation des opérandes (a <= b) est
 * garantie côté serveur par le service qui appelle ce dépôt.
 */

final class OperationDifficultyRepository
{
    public function __construct(private PDO $pdo)
    {
    }

    /**
     * Lit une opération agrégée (ou null si absente).
     *
     * @return array<string,mixed>|null champs {id, user_id, mode, question_type,
     *         operand_a, operand_b, attempts, errors, success_streak, difficulty,
     *         last_answered_at, last_error_at, last_resolved_at}.
     */
    public function find(
        int $userId,
        string $mode,
        string $questionType,
        int $a,
        int $b
    ): ?array {
        $stmt = $this->pdo->prepare(
            'SELECT * FROM operations_difficulty
             WHERE user_id = :user_id AND mode = :mode AND question_type = :qt
               AND operand_a = :a AND operand_b = :b'
        );
        $stmt->execute([
            'user_id' => $userId,
            'mode'    => $mode,
            'qt'      => $questionType,
            'a'       => $a,
            'b'       => $b,
        ]);
        $row = $stmt->fetch();
        return $row !== false ? $row : null;
    }

    /**
     * Crée une ligne vierge pour une opération (difficulty = 0).
     *
     * @return int identifiant de la ligne créée.
     */
    public function insert(
        int $userId,
        string $mode,
        string $questionType,
        int $a,
        int $b
    ): int {
        $stmt = $this->pdo->prepare(
            'INSERT INTO operations_difficulty
                (user_id, mode, question_type, operand_a, operand_b)
             VALUES (:user_id, :mode, :qt, :a, :b)'
        );
        $stmt->execute([
            'user_id' => $userId,
            'mode'    => $mode,
            'qt'      => $questionType,
            'a'       => $a,
            'b'       => $b,
        ]);
        return (int)$this->pdo->lastInsertId();
    }

    /**
     * Met à jour l'état agrégé d'une opération existante.
     *
     * @param array<string,mixed> $state contient attempts, errors, success_streak,
     *        difficulty, last_answered_at, last_error_at, last_resolved_at.
     */
    public function update(int $id, array $state): void
    {
        $stmt = $this->pdo->prepare(
            'UPDATE operations_difficulty SET
                attempts = :attempts,
                errors   = :errors,
                success_streak = :streak,
                difficulty     = :difficulty,
                last_answered_at = :last_answered_at,
                last_error_at    = :last_error_at,
                last_resolved_at = :last_resolved_at
             WHERE id = :id'
        );
        $stmt->execute([
            'attempts'        => (int)$state['attempts'],
            'errors'          => (int)$state['errors'],
            'streak'          => (int)$state['success_streak'],
            'difficulty'      => (int)$state['difficulty'],
            'last_answered_at' => array_key_exists('last_answered_at', $state)
                ? $state['last_answered_at'] : null,
            'last_error_at'   => array_key_exists('last_error_at', $state)
                ? $state['last_error_at'] : null,
            'last_resolved_at' => array_key_exists('last_resolved_at', $state)
                ? $state['last_resolved_at'] : null,
            'id'              => $id,
        ]);
    }

    /**
     * Toutes les opérations d'un utilisateur (pour le bilan par table).
     *
     * @return array<int,array<string,mixed>>
     */
    public function allForUser(int $userId): array
    {
        $stmt = $this->pdo->prepare(
            'SELECT * FROM operations_difficulty WHERE user_id = :user_id'
        );
        $stmt->execute(['user_id' => $userId]);
        return $stmt->fetchAll();
    }

    /**
     * Opérations NON maîtrisées (difficulty > 0) d'un utilisateur, filtrées
     * pour une mission d'entraînement (v12.5). L'identifiant utilisateur est
     * TOUJOURS imposé côté serveur : on ne renvoie jamais les données d'un
     * autre utilisateur, quels que soient les filtres passés.
     *
     * @param int         $userId   identifiant de l'utilisateur connecté.
     * @param string|null $mode     'multiplication' | 'addition' (null = tous).
     * @param array<int,string> $questionTypes liste de type de questions
     *        autorisés parmi 'classic' | 'hole' (vide = les deux).
     * @param int|null    $addMin   borne inférieure de la plage addition (null = toute).
     * @param int|null    $addMax   borne supérieure de la plage addition (null = toute).
     * @param array<int,int> $multTables tables autorisées pour la multiplication
     *        (vide = toutes). Chaque opérande doit appartenir à cette liste.
     *
     * @return array<int,array<string,mixed>> chaque ligne, avec au moins
     *         mode, question_type, operand_a, operand_b, difficulty.
     */
    public function difficultOperations(
        int $userId,
        ?string $mode = null,
        array $questionTypes = [],
        ?int $addMin = null,
        ?int $addMax = null,
        array $multTables = []
    ): array {
        $where = ['user_id = :user_id', 'difficulty > 0'];
        $params = ['user_id' => $userId];

        if ($mode !== null) {
            $where[] = 'mode = :mode';
            $params['mode'] = $mode;
        }

        if ($questionTypes !== []) {
            $holders = [];
            foreach ($questionTypes as $i => $qt) {
                $holders[] = ':qt' . $i;
                $params['qt' . $i] = $qt;
            }
            $where[] = 'question_type IN (' . implode(', ', $holders) . ')';
        }

        // La plage de nombres ne s'applique qu'aux additions : les deux opérandes
        // doivent appartenir à [addMin, addMax].
        if ($addMin !== null) {
            $where[] = 'operand_a >= :add_min AND operand_b >= :add_min';
            $params['add_min'] = $addMin;
        }
        if ($addMax !== null) {
            $where[] = 'operand_a <= :add_max AND operand_b <= :add_max';
            $params['add_max'] = $addMax;
        }

        // Les tables autorisées ne s'appliquent qu'aux multiplications : chaque
        // opérande doit figurer parmi les tables cochées (les opérandes sont déjà
        // normalisés a <= b, on teste néanmoins les deux bornes par sûreté).
        if ($multTables !== []) {
            $holders = [];
            foreach ($multTables as $i => $t) {
                $holders[] = ':tbl' . $i;
                $params['tbl' . $i] = $t;
            }
            $in = implode(', ', $holders);
            $where[] = "(operand_a IN ({$in}) AND operand_b IN ({$in}))";
        }

        $stmt = $this->pdo->prepare(
            'SELECT mode, question_type, operand_a, operand_b, difficulty
             FROM operations_difficulty
             WHERE ' . implode(' AND ', $where) . '
             ORDER BY difficulty DESC, id ASC'
        );
        $stmt->execute($params);
        return $stmt->fetchAll();
    }
}
