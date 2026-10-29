<?php

declare(strict_types=1);

/**
 * ResultService — Enregistrement des parties et historique.
 *
 * Orchestre la persistance des résultats d'une partie terminée :
 *  - enregistrement d'un résultat validé côté serveur (mode, score sur 10,
 *    date/heure UTC) pour l'utilisateur AUTHENTIFIÉ (l'identité vient de la
 *    session serveur, jamais d'un user_id transmis par le navigateur) ;
 *  - consultation de l'historique d'un utilisateur connecté.
 *
 * L'import des anciennes parties invitées (v12, `importGuest`) a été
 * volontairement retiré : il n'est plus possible de rattacher à un compte des
 * parties jouées en mode invité, même par un appel API direct.
 *
 * Contrainte de confiance : le score (`score`) provient du navigateur. Il n'y a
 * AUCUN moyen fiable de vérifier que le joueur n'a pas triché côté client.
 * Ces valeurs sont donc enregistrées "à confiance limitée" : elles alimentent
 * l'historique personnel et les statistiques, mais ne doivent jamais servir de
 * preuve formelle de progression (un utilisateur malveillant peut les altérer).
 */

final class ResultService
{
    public function __construct(
        private PDO $pdo,
        private ResultRepository $results,
        private ?OperationDifficultyService $difficulties = null
    ) {
    }

    /**
     * Enregistre le résultat d'une partie terminée pour l'utilisateur connecté.
     *
     * @param int    $userId identifiant de l'utilisateur authentifié.
     * @param string $mode   mode de jeu ('multiplication' | 'addition').
     * @param int    $score  score sur 10.
     * @param ?string $playedAt date/heure UTC de fin ; null => maintenant (UTC).
     * @param string $questionType type de questions (v12.3) : classic | hole | mixed.
     * @return int identifiant du résultat enregistré.
     * @throws InvalidArgumentException si mode, type de questions ou score invalide.
     */
    public function save(
        int $userId,
        string $mode,
        int $score,
        ?string $playedAt = null,
        string $questionType = 'classic'
    ): int {
        if (!Validator::mode($mode)) {
            throw new InvalidArgumentException('Mode de jeu invalide.');
        }
        if (!Validator::questionType($questionType)) {
            throw new InvalidArgumentException('Type de questions invalide.');
        }
        if (!Validator::score($score)) {
            throw new InvalidArgumentException('Le score doit être un entier entre 0 et 10.');
        }
        if ($playedAt !== null && !$this->isUtcTimestamp($playedAt)) {
            throw new InvalidArgumentException('Date de fin invalide (format UTC attendu).');
        }
        return $this->results->insert($userId, $mode, $score, $playedAt, null, $questionType);
    }

    /**
     * Historique de l'utilisateur connecté (du plus récent au plus ancien).
     *
     * @return array<int,array<string,mixed>> avec champs publics uniquement.
     */
    /**
     * Enregistre une mission complète de façon ATOMIQUE et IDEMPOTENTE (v12.4).
     *
     * Dans une unique transaction SQLite sont écrits :
     *  - le résultat global (résultat du classement / statistiques) ;
     *  - le journal d'idempotence de la mission (mission_id) ;
     *  - la mémoire des difficultés individuelles (opérations agrégées).
     *
     * Un même `mission_id` (stable, conservé lors des tentatives de sauvegarde
     * répétées) ne produit qu'UNE seule écriture : une sauvegarde ultérieure du
     * même mission_id est détectée et renvoie une réponse de succès cohérente
     * sans seconde écriture.
     *
     * En cas d'erreur pendant la transaction (détail invalide, contrainte SQL),
     * AUCUNE écriture partielle ne subsiste : tout est annulé.
     *
     * @param int    $userId   utilisateur AUTHENTIFIÉ (jamais transmis par le client).
     * @param string $mode     'multiplication' | 'addition' | 'mixed'.
     * @param int    $score    score global sur 10.
     * @param string $missionId identificateur stable et unique de la mission.
     * @param array  $details  détails individuels (chaque élément est validé et
     *                         sa justesse RECALCULÉE serveur, cf. see apply).
     * @param ?string $playedAt date/heure UTC de fin ; null => maintenant (UTC).
     * @param string $questionType type global : classic | hole | mixed.
     * @return array{saved:bool, duplicate:bool, id:int|null}
     * @throws InvalidArgumentException en cas d'entrée invalide (transaction non ouverte).
     */
    public function saveWithMission(
        int $userId,
        string $mode,
        int $score,
        string $missionId,
        array $details,
        ?string $playedAt = null,
        string $questionType = 'classic'
    ): array {
        if (!Validator::mode($mode)) {
            throw new InvalidArgumentException('Mode de jeu invalide.');
        }
        if (!Validator::questionType($questionType)) {
            throw new InvalidArgumentException('Type de questions invalide.');
        }
        if (!Validator::score($score)) {
            throw new InvalidArgumentException('Le score doit être un entier entre 0 et 10.');
        }
        if ($playedAt !== null && !$this->isUtcTimestamp($playedAt)) {
            throw new InvalidArgumentException('Date de fin invalide (format UTC attendu).');
        }
        if (!is_string($missionId) || trim($missionId) === '' || strlen($missionId) > 100) {
            throw new InvalidArgumentException('Identifiant de mission invalide.');
        }
        if ($this->difficulties === null) {
            throw new LogicException('Le service de mémoire des difficultés n\'est pas injecté.');
        }

        // Validation des détails AVANT d'ouvrir la transaction : si invalides, on
        // lève immédiatement sans créer de transaction ni écrire quoi que ce soit.
        $events = $this->difficulties->validateDetails($details);

        $this->pdo->beginTransaction();
        try {
            // Journal d'idempotence : réserve le mission_id. Si une ligne identique
            // existe déjà (UNIQUE user_id+mission_id), INSERT OR IGNORE n'écrit rien.
            $stmt = $this->pdo->prepare(
                'INSERT OR IGNORE INTO mission_difficulty_log (user_id, mission_id)
                 VALUES (:user_id, :mission_id)'
            );
            $stmt->execute(['user_id' => $userId, 'mission_id' => trim($missionId)]);

            if ($stmt->rowCount() === 0) {
                // Doublon déjà enregistré : réponse de succès cohérente, aucune
                // seconde écriture (on annule ce début de transaction).
                $this->pdo->rollBack();
                return ['saved' => false, 'duplicate' => true, 'id' => null];
            }

            // Résultat global.
            $resultId = $this->results->insert(
                $userId,
                $mode,
                $score,
                $playedAt,
                null,
                $questionType
            );

            // Mémoire des difficultés (recalcul serveur appliqué pour chaque événement).
            $this->difficulties->applyEvents($userId, $events);

            $this->pdo->commit();
            return ['saved' => true, 'duplicate' => false, 'id' => $resultId];
        } catch (Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw $e;
        }
    }

    /**
     * Bilan « Mes points à travailler » (par table) de l'utilisateur connecté.
     *
     * @return array{multiplication:array, addition:array} voir tableSummary().
     * @throws LogicException si le service de difficultés n'est pas injecté.
     */
    public function difficultySummary(int $userId): array
    {
        if ($this->difficulties === null) {
            throw new LogicException('Le service de mémoire des difficultés n\'est pas injecté.');
        }
        return $this->difficulties->tableSummary($userId);
    }

    public function history(int $userId): array
    {
        return $this->results->findByUser($userId);
    }

    /** Vérifie qu'une chaîne est un horodatage UTC ISO8601 de forme stricte. */
    private function isUtcTimestamp(string $value): bool
    {
        if (!preg_match('/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/', $value)) {
            return false;
        }
        // Cohérence réelle de la date (rejette 2024-02-30, 25:61, etc.).
        $dt = DateTimeImmutable::createFromFormat('!Y-m-d\TH:i:s\Z', $value);
        return $dt !== false && $dt->format('Y-m-d\TH:i:s\Z') === $value;
    }
}
