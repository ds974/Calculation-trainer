<?php

declare(strict_types=1);

/**
 * ResultService — Enregistrement des parties, historique et import invité.
 *
 * Orchestre la persistance des résultats d'une partie terminée :
 *  - enregistrement d'un résultat validé côté serveur (mode, score sur 10) ;
 *  - consultation de l'historique d'un utilisateur connecté ;
 *  - import des anciennes parties invitées (localStorage v12) vers le compte,
 *    de manière IDEMPOTENTE (les doublons sont refusés/rejetés) et atomique
 *    (transaction SQLite).
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
        private ResultRepository $results
    ) {
    }

    /**
     * Enregistre le résultat d'une partie terminée pour l'utilisateur connecté.
     *
     * @param int    $userId identifiant de l'utilisateur authentifié.
     * @param string $mode   mode de jeu ('multiplication' | 'addition').
     * @param int    $score  score sur 10.
     * @param ?string $playedAt date/heure UTC de fin ; null => maintenant (UTC).
     * @return int identifiant du résultat enregistré.
     * @throws InvalidArgumentException si mode ou score invalide.
     */
    public function save(int $userId, string $mode, int $score, ?string $playedAt = null): int
    {
        if (!Validator::mode($mode)) {
            throw new InvalidArgumentException('Mode de jeu invalide.');
        }
        if (!Validator::score($score)) {
            throw new InvalidArgumentException('Le score doit être un entier entre 0 et 10.');
        }
        if ($playedAt !== null && !$this->isUtcTimestamp($playedAt)) {
            throw new InvalidArgumentException('Date de fin invalide (format UTC attendu).');
        }
        return $this->results->insert($userId, $mode, $score, $playedAt);
    }

    /**
     * Historique de l'utilisateur connecté (du plus récent au plus ancien).
     *
     * @return array<int,array<string,mixed>> avec champs publics uniquement.
     */
    public function history(int $userId): array
    {
        return $this->results->findByUser($userId);
    }

    /**
     * Importe l'historique invité vers le compte de l'utilisateur connecté.
     *
     * La stratégie d'idempotence repose sur un identifiant stable propre à chaque
     * partie invitée (`guest_id`). Un même guest_id ne peut exister qu'une seule
     * fois par utilisateur : une colonne UNIQUE partielle en base garantit qu'un
     * envoi répété ne crée jamais de doublon. L'opération est exécutée dans une
     * TRANSACTION SQLite : soit toutes les parties sont importées, soit aucune.
     *
     * @param int              $userId identifiant de l'utilisateur authentifié.
     * @param array<int,mixed> $items  liste des parties invitées à importer.
     * @return array{imported:int,skipped:int} nb importées et sautées (doublons/invalides).
     * @throws InvalidArgumentException si la structure globale est invalide.
     * @throws RuntimeException si la transaction échoue.
     */
    public function importGuest(int $userId, array $items): array
    {
        if (!array_is_list($items)) {
            throw new InvalidArgumentException('La liste des parties invitées est invalide.');
        }
        if (count($items) === 0) {
            return ['imported' => 0, 'skipped' => 0];
        }
        if (count($items) > 500) {
            throw new InvalidArgumentException('Trop de parties à importer (500 maximum).');
        }

        $normalized = [];
        foreach ($items as $i => $item) {
            $norm = $this->normalizeGuestItem($item, $i);
            if ($norm !== null) {
                // Un même guest_id répété dans la même soumission : on garde le premier.
                $key = $norm['guest_id'];
                if (!array_key_exists($key, $normalized)) {
                    $normalized[$key] = $norm;
                }
            }
        }

        $imported = 0;
        $skipped = count($items) - count($normalized);

        if ($normalized === []) {
            // Toutes les lignes étaient invalides : on ne touche pas à la base.
            return ['imported' => 0, 'skipped' => $skipped];
        }

        try {
            $this->pdo->beginTransaction();
            foreach ($normalized as $norm) {
                // Idempotence : si ce guest_id existe déjà pour cet utilisateur, on saute.
                if ($this->results->guestIdExists($userId, $norm['guest_id'])) {
                    $skipped++;
                    continue;
                }
                $this->results->insert(
                    $userId,
                    $norm['mode'],
                    $norm['score'],
                    $norm['played_at'],
                    $norm['guest_id']
                );
                $imported++;
            }
            $this->pdo->commit();
        } catch (Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw new RuntimeException(
                'Échec de l\'import de l\'historique : aucune donnée n\'a été modifiée.'
            );
        }

        return ['imported' => $imported, 'skipped' => $skipped];
    }

    /** Valide une entrée invitée ; renvoie un tableau normalisé ou null si invalide. */
    private function normalizeGuestItem(mixed $item, int $index): ?array
    {
        if (!is_array($item)) {
            return null;
        }
        $guestId = (string)($item['guest_id'] ?? '');
        $mode = (string)($item['mode'] ?? '');
        $score = $item['score'] ?? null;
        $playedAt = (string)($item['played_at'] ?? '');

        // Identifiant stable requis et format limité (évite les clés arbitraires/très longues).
        if ($guestId === '' || strlen($guestId) > 120 || !preg_match('/^[A-Za-z0-9_\-]+$/', $guestId)) {
            return null;
        }
        if (!Validator::mode($mode)) {
            return null;
        }
        if (!is_int($score) && !(is_numeric($score) && (int)$score == $score)) {
            return null;
        }
        $score = (int)$score;
        if (!Validator::score($score)) {
            return null;
        }
        if ($playedAt === '' || !$this->isUtcTimestamp($playedAt)) {
            return null;
        }

        return [
            'guest_id'  => $guestId,
            'mode'      => $mode,
            'score'     => $score,
            'played_at' => $playedAt,
        ];
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
