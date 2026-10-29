<?php

declare(strict_types=1);

/**
 * OperationDifficultyService — Mémoire des difficultés personnelles (v12.4).
 *
 * Responsabilités :
 *  - VALIDER et NORMALISER les détails individuels d'une mission reçus du
 *    navigateur (mode, type réel de chaque question, opérandes, nombre de
 *    réponses, positions du trou) ;
 *  - RECALCULER côté serveur la justesse (`correct`) de chaque réponse à partir
 *    des seules données métier reçues (opérandes, mode, type, hole, réponse de
 *    l'élève) : on ne fait JAMAIS confiance à un indicateur `correct` transmis
 *    par le client ;
 *  - appliquer le barème de difficulté (erreurs/expirations, réussites
 *    successives, retour progressif à zéro, identification des difficultés
 *    surmontées) ;
 *  - calculer le BILAN par table (« Mes points à travailler ») pour le bilan
 *    personnel, en préservant les totaux globaux sans double comptage.
 *
 * Barème validé (v12.4) :
 *  - chaque tentative incrémente `attempts` ;
 *  - une réponse incorrecte OU une expiration de temps : difficulté +1 (max 5),
 *    `errors` +1, série de réussites remise à zéro, date de dernière erreur ;
 *  - une réussite : `success_streak` +1 ; toutes les deux réussites consécutives
 *    (streak pair), difficulté −1 (min 0) ;
 *  - une difficulté qui passe d'une valeur positive à 0 est considérée comme
 *    surmontée (`last_resolved_at` posé uniquement à ce moment).
 *
 * Les opérations maîtrisées (difficulty = 0) restent en base.
 */

final class OperationDifficultyService
{
    /** Nombre maximal de questions par mission (cohérent avec constante JS). */
    public const QUESTION_COUNT = 10;

    /** Bornes des opérandes (couvre tables 1-10 et additions jusqu'à 99). */
    private const MIN_OPERAND = 1;
    private const MAX_OPERAND = 99;

    /** Plafond du coefficient de difficulté. */
    public const MAX_DIFFICULTY = 5;

    /** Seuils du bilan par table : difficulté pondérée minimale pour « à travailler ». */
    private const WORK_THRESHOLD = 2.0;

    /** Seuils du bilan : tentatives pondérées minimales pour écarter les conclusions hâtives. */
    private const MIN_ATTEMPTS = 3;

    /** États d'une table dans le bilan. */
    private const STATUS_WORK = 'to_work';
    private const STATUS_PROGRESS = 'in_progress';
    private const STATUS_MASTERED = 'mastered';
    private const STATUS_INSUFFICIENT = 'insufficient';

    public function __construct(
        private PDO $pdo,
        private OperationDifficultyRepository $difficulties
    ) {
    }

    /**
     * Valide et normalise une liste de détails individuels reçus du navigateur.
     *
     * @param mixed $details tableau (ou équivalent JSON) d'événements {mode,
     *        question_type, a, b, hole, user_answer}.
     * @return array<int,array{mode:string,question_type:string,a:int,b:int,correct:bool}>
     *         chaque événement normalisé, avec `correct` RECALCULÉ côté serveur.
     * @throws InvalidArgumentException si la structure est invalide.
     */
    public function validateDetails(mixed $details): array
    {
        if (!is_array($details)) {
            throw new InvalidArgumentException('Détails de mission invalides.');
        }
        if (count($details) < 1 || count($details) > self::QUESTION_COUNT) {
            throw new InvalidArgumentException(
                'Le détail de mission doit contenir entre 1 et ' . self::QUESTION_COUNT . ' réponses.'
            );
        }

        $normalized = [];
        foreach ($details as $index => $d) {
            if (!is_array($d)) {
                throw new InvalidArgumentException('Détail de question invalide.');
            }

            $mode = (string)($d['mode'] ?? '');
            if (!Validator::mode($mode)) {
                throw new InvalidArgumentException('Mode de jeu invalide dans le détail.');
            }

            // Classification INDIVIDUELLE de la question : classique ou à trou.
            // Le mode global « mixed » est résolu côté client en classic/hole par question.
            $qt = (string)($d['question_type'] ?? '');
            if (!in_array($qt, ['classic', 'hole'], true)) {
                throw new InvalidArgumentException('Type de question invalide dans le détail.');
            }

            $a = filter_var($d['a'] ?? null, FILTER_VALIDATE_INT);
            $b = filter_var($d['b'] ?? null, FILTER_VALIDATE_INT);
            if ($a === false || $b === false) {
                throw new InvalidArgumentException('Opérandes invalides dans le détail.');
            }
            if ($a < self::MIN_OPERAND || $a > self::MAX_OPERAND
                || $b < self::MIN_OPERAND || $b > self::MAX_OPERAND) {
                throw new InvalidArgumentException('Opérande hors bornes dans le détail.');
            }

            // Normalisation commutative : a <= b. Regroupe 6×7 et 7×6, ainsi que
            // les deux positions d'un trou vers la même paire normalisée.
            if ($a > $b) {
                [$a, $b] = [$b, $a];
            }

            $hole = $d['hole'] ?? null;
            if ($qt === 'classic') {
                if ($hole !== null && $hole !== '') {
                    throw new InvalidArgumentException('Hole transmis pour une question classique.');
                }
                $hole = null;
            } else {
                if ($hole !== 'a' && $hole !== 'b') {
                    throw new InvalidArgumentException('Position du trou invalide dans le détail.');
                }
            }

            // Recalcul de la justesse : on ignore tout champ `correct` du client.
            $correct = $this->recomputeCorrect($mode, $qt, $a, $b, $hole, $d['user_answer'] ?? null);

            $normalized[] = [
                'mode'          => $mode,
                'question_type' => $qt,
                'a'             => $a,
                'b'             => $b,
                'correct'       => $correct,
            ];
        }

        return $normalized;
    }


    /**
     * Recalcule si la réponse de l'élève est correcte, à partir des seules
     * données métier (aucune confiance accordée à un flag client).
     */
    private function recomputeCorrect(
        string $mode,
        string $questionType,
        int $a,
        int $b,
        ?string $hole,
        mixed $userAnswer
    ): bool {
        if ($userAnswer === null || $userAnswer === '') {
            // Réponse absente / expiration de temps => considérée incorrecte.
            return false;
        }
        // On n'accepte que des réponses numériques (le moteur de jeu restreint la saisie).
        if (!is_numeric($userAnswer)) {
            return false;
        }
        $given = (string)((int)$userAnswer);

        if ($questionType === 'hole') {
            // Le trou masque l'opérande a (hole='a') ou b (hole='b') ; la « bonne
            // réponse » est l'opérande manquant.
            $expected = $hole === 'a' ? $a : $b;
        } else {
            $expected = $mode === 'multiplication' ? $a * $b : $a + $b;
        }

        return $given === (string)$expected;
    }

    /**
     * Applique le barème à UN événement (une réponse) sur une opération, dans la
     * transaction SQLite courante (appelé par ResultService).
     *
     * @param int    $userId        utilisateur authentifié.
     * @param string $mode          'multiplication' | 'addition'.
     * @param string $questionType  'classic' | 'hole'.
     * @param int    $a,$b          opérandes DÉJÀ normalisés (a <= b).
     * @param bool   $correct       justesse recalculée côté serveur.
     * @param ?string $nowUtc       référence temporelle (UTC) pour les tests.
     */
    public function applyBarème(
        int $userId,
        string $mode,
        string $questionType,
        int $a,
        int $b,
        bool $correct,
        ?string $nowUtc = null
    ): void {
        if (!Validator::mode($mode)) {
            throw new InvalidArgumentException('Mode de jeu invalide.');
        }
        if (!in_array($questionType, ['classic', 'hole'], true)) {
            throw new InvalidArgumentException('Type de question invalide.');
        }
        if ($a < self::MIN_OPERAND || $a > self::MAX_OPERAND
            || $b < self::MIN_OPERAND || $b > self::MAX_OPERAND) {
            throw new InvalidArgumentException('Opérande hors bornes.');
        }
        if ($a > $b) {
            [$a, $b] = [$b, $a];
        }

        $now = $nowUtc ?? $this->nowUtc();

        $row = $this->difficulties->find($userId, $mode, $questionType, $a, $b);
        if ($row === null) {
            $this->difficulties->insert($userId, $mode, $questionType, $a, $b);
            $row = $this->difficulties->find($userId, $mode, $questionType, $a, $b);
        }

        $oldDifficulty = (int)($row['difficulty'] ?? 0);
        $attempts  = (int)($row['attempts'] ?? 0) + 1;
        $errors    = (int)($row['errors'] ?? 0);
        $streak    = (int)($row['success_streak'] ?? 0);
        $difficulty = $oldDifficulty;
        $lastAnsweredAt = $now;
        $lastErrorAt = ($row['last_error_at'] ?? null) !== null ? (string)$row['last_error_at'] : null;
        $lastResolvedAt = ($row['last_resolved_at'] ?? null) !== null ? (string)$row['last_resolved_at'] : null;

        if ($correct) {
            // Réussite : progression de la série. Toutes les deux réussites
            // consécutives (streak pair), on abaisse la difficulté d'un cran.
            $streak++;
            if ($streak % 2 === 0) {
                $difficulty = max(0, $difficulty - 1);
            }
            if ($oldDifficulty > 0 && $difficulty === 0) {
                // Difficulté positive revenue à zéro : difficulté surmontée.
                $lastResolvedAt = $now;
            }
        } else {
            // Erreur OU expiration de temps : +1 (max 5), série remise à zéro.
            $difficulty = min(self::MAX_DIFFICULTY, $difficulty + 1);
            $streak = 0;
            $errors++;
            $lastErrorAt = $now;
        }

        $this->difficulties->update((int)$row['id'], [
            'attempts'         => $attempts,
            'errors'           => $errors,
            'success_streak'   => $streak,
            'difficulty'       => $difficulty,
            'last_answered_at' => $lastAnsweredAt,
            'last_error_at'    => $lastErrorAt,
            'last_resolved_at' => $lastResolvedAt,
        ]);
    }

    /**
     * Applique une liste d'événements normalisés à l'utilisateur (transaction
     * supposée déjà ouverte par ResultService).
     *
     * @param int   $userId
     * @param array $events liste retournée par validateDetails() (a,b déjà normalisés).
     */
    public function applyEvents(int $userId, array $events, ?string $nowUtc = null): void
    {
        foreach ($events as $e) {
            $this->applyBarème(
                $userId,
                $e['mode'],
                $e['question_type'],
                $e['a'],
                $e['b'],
                $e['correct'],
                $nowUtc
            );
        }
    }


    // ------------------------------------------------------------- Bilan par table

    /**
     * Calcule le bilan « Mes points à travailler » pour un utilisateur connecté.
     *
     * Agrège les opérations PAR TABLE (opérande) selon le mode et le type de
     * question, en attribuant la moitié du poids de chaque opération à chacun de
     * ses deux opérandes (et le poids entier quand les opérandes sont identiques),
     * de sorte que les totaux globaux soient préservés (pas de double comptage).
     *
     * @return array{multiplication:array, addition:array} chaque mode contient
     *         'classic' et 'hole', chacun une liste de tables classées.
     */
    public function tableSummary(int $userId): array
    {
        $rows = $this->difficulties->allForUser($userId);

        $rubriques = [
            'multiplication' => ['classic' => [], 'hole' => []],
            'addition'       => ['classic' => [], 'hole' => []],
        ];

        foreach ($rows as $row) {
            $mode = (string)$row['mode'];
            $qt   = (string)$row['question_type'];
            if (!isset($rubriques[$mode][$qt])) {
                continue;
            }
            $a = (int)$row['operand_a'];
            $b = (int)$row['operand_b'];
            $difficulty = (int)$row['difficulty'];
            $attempts   = (int)$row['attempts'];
            $errors     = (int)$row['errors'];
            $resolved   = ($row['last_resolved_at'] ?? null) !== null;

            $weights = [];
            if ($a === $b) {
                $weights[$a] = 1.0;
            } else {
                $weights[$a] = 0.5;
                $weights[$b] = 0.5;
            }

            foreach ($weights as $table => $w) {
                $rubriques[$mode][$qt] = $this->accumulateTable(
                    $rubriques[$mode][$qt],
                    $table,
                    $w * $difficulty,
                    $w * $attempts,
                    $w * $errors,
                    $w * ($resolved ? 1 : 0)
                );
            }
        }

        $result = ['multiplication' => [], 'addition' => []];
        foreach ($rubriques as $mode => $rub) {
            foreach ($rub as $qt => $tables) {
                $classified = [];
                foreach ($tables as $table => $agg) {
                    $classified[] = $this->classifyTable($table, $agg);
                }
                usort($classified, function ($x, $y) {
                    $order = [
                        self::STATUS_WORK => 0,
                        self::STATUS_PROGRESS => 1,
                        self::STATUS_INSUFFICIENT => 2,
                        self::STATUS_MASTERED => 3,
                    ];
                    $ox = $order[$x['status']] ?? 9;
                    $oy = $order[$y['status']] ?? 9;
                    if ($ox !== $oy) {
                        return $ox <=> $oy;
                    }
                    return ($y['difficulty'] ?? 0) <=> ($x['difficulty'] ?? 0);
                });
                $result[$mode][$qt] = $classified;
            }
        }

        return $result;
    }


    /** Accumule le poids d'une opération sur une table (clé = opérande). */
    private function accumulateTable(array $acc, int $table, float $d, float $att, float $err, float $res): array
    {
        $cur = $acc[$table] ?? [
            'difficulty' => 0.0,
            'attempts'   => 0.0,
            'errors'     => 0.0,
            'resolved'   => 0.0,
        ];
        $cur['difficulty'] += $d;
        $cur['attempts']   += $att;
        $cur['errors']     += $err;
        $cur['resolved']   += $res;
        $acc[$table] = $cur;
        return $acc;
    }

    /**
     * Classe une table selon la difficulté pondérée et le nombre de tentatives.
     * Règle anti-conclusion hâtive : une table avec moins de MIN_ATTEMPTS
     * tentatives pondérées est toujours « insuffisamment pratiquée » et n'est
     * JAMAIS présentée comme maîtrisée.
     */
    private function classifyTable(int $table, array $agg): array
    {
        $difficulty = (float)$agg['difficulty'];
        $attempts   = (float)$agg['attempts'];

        if ($attempts < self::MIN_ATTEMPTS) {
            $status = self::STATUS_INSUFFICIENT;
        } elseif ($difficulty >= self::WORK_THRESHOLD) {
            $status = self::STATUS_WORK;
        } elseif ($difficulty > 0) {
            $status = self::STATUS_PROGRESS;
        } else {
            $status = self::STATUS_MASTERED;
        }

        return [
            'table'      => $table,
            'difficulty' => round($difficulty, 1),
            'attempts'   => round($attempts, 1),
            'errors'     => round((float)$agg['errors'], 1),
            'resolved'   => (int)round((float)$agg['resolved']),
            'status'     => $status,
        ];
    }


    /** Horodatage UTC courant au format strict backend. */
    private function nowUtc(): string
    {
        return gmdate('Y-m-d\TH:i:s\Z');
    }
}

