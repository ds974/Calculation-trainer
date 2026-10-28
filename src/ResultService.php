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
