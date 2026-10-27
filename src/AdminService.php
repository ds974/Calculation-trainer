<?php

declare(strict_types=1);

/**
 * AdminService — Orchestration des opérations d'administration (v12.1).
 *
 * Contient toutes les règles de sécurité métier de l'espace administrateur :
 *  - un compte ne peut être modifié qu'à partir de son id, jamais d'un rôle
 *    ou d'une donnée transmise par le navigateur ;
 *  - protection du DERNIER administrateur ACTIF : on refuse de retirer le rôle
 *    `admin` ou de désactiver le dernier compte `admin` actif ;
 *  - un administrateur ne peut pas retirer le rôle admin / se désactiver
 *    soi-même lorsque cela ferait disparaître le dernier admin actif ;
 *  - la réinitialisation du mot de passe génère un mot de passe TEMPORAIRE
 *    haché Argon2id (jamais stocké en clair), renvoyé une seule fois ;
 *  - la désactivation est « douce » (soft) : elle ne supprime JAMAIS l'utilisateur
 *    ni son historique de parties ; le compte est simplement inactivable.
 *
 * Aucun hachage de mot de passe ni adresse e-mail n'est jamais exposé : toutes
 * les fiches passent par AuthService::publicUser() qui ne renvoie que des
 * champs publics.
 */

final class AdminService
{
    /** Longueur du mot de passe temporaire généré lors d'un reset. */
    private const TEMP_PASSWORD_LENGTH = 14;

    public function __construct(
        private PDO $pdo,
        private AuthService $auth,
        private UserRepository $users,
        private AdminRepository $admin
    ) {
    }

    /** Vérifie que l'appelant est authentifié administrateur. Levée côté route. */
    public function requireAdmin(?array $user): void
    {
        $this->auth->requireAdmin($user);
    }

    /**
     * Liste les comptes (fiches publiques), avec recherche optionnelle.
     *
     * @return array{total:int,users:array<int,array<string,mixed>>}
     */
    public function listUsers(string $search = '', int $limit = 100, int $offset = 0): array
    {
        $rows = $this->users->findAll($search, $limit, $offset);
        $total = $search === ''
            ? $this->users->count()
            : count($rows);

        return [
            'total' => $total,
            'users' => array_map(
                fn(array $row) => $this->publicFiche($row),
                $rows
            ),
        ];
    }

    /**
     * Détail administratif complet d'un compte (fiche publique + parties jouées).
     *
     * @return array<string,mixed>|null null si le compte n'existe pas.
     */
    public function userDetail(int $userId): ?array
    {
        $user = $this->users->findById($userId);
        if ($user === null) {
            return null;
        }
        $fiche = $this->publicFiche($user);
        $fiche['played_games'] = $this->admin->playedGamesFor($userId);
        $fiche['history'] = $this->admin->historyFor($userId);
        return $fiche;
    }

    /**
     * Attribution (true) ou retrait (false) du rôle administrateur.
     *
     * Règles :
     *  - le compte doit exister ;
     *  - refus si l'opération supprimerait le dernier administrateur actif.
     *
     * @return array<string,mixed> fiche publique mise à jour.
     * @throws InvalidArgumentException si le compte n'existe pas.
     * @throws RuntimeException si la règle du dernier admin est violée.
     */
    public function setRole(int $targetUserId, bool $makeAdmin, int $operatorUserId): array
    {
        $target = $this->users->findById($targetUserId);
        if ($target === null) {
            throw new InvalidArgumentException('Compte introuvable.', 404);
        }

        $currentlyAdmin = ($target['role'] ?? '') === 'admin';

        // Retrait du rôle : protéger le dernier administrateur ACTIF.
        if ($currentlyAdmin && !$makeAdmin) {
            // Nombre d'autres admins actifs hors du compte cible.
            $others = $this->users->countActiveAdminsExcept($targetUserId);
            if ($others === 0) {
                // Interdit aussi bien pour un opérateur tiers que pour soi-même.
                throw new RuntimeException(
                    'Impossible de retirer le rôle administrateur au dernier administrateur actif.',
                    403
                );
            }
        }

        $newRole = $makeAdmin ? 'admin' : 'user';
        $this->pdo->beginTransaction();
        try {
            $this->users->updateRole($targetUserId, $newRole);
            $this->pdo->commit();
        } catch (Throwable $e) {
            if ($this->pdo->inTransaction()) {
                $this->pdo->rollBack();
            }
            throw new RuntimeException('Échec de la mise à jour du rôle.', 500);
        }

        $updated = $this->users->findById($targetUserId);
        return $this->publicFiche(is_array($updated) ? $updated : $target);
    }

    /**
     * Active (true) / désactive (false) un compte.
     *
     * Règles :
     *  - le compte doit exister ;
     *  - désactivation interdite si c'est le dernier administrateur actif ;
     *  - la désactivation préserve l'utilisateur et son historique (soft delete).
     *
     * @return array<string,mixed> fiche publique mise à jour.
     * @throws InvalidArgumentException si le compte n'existe pas.
     * @throws RuntimeException si la règle du dernier admin est violée.
     */
    public function setActive(int $targetUserId, bool $active): array
    {
        $target = $this->users->findById($targetUserId);
        if ($target === null) {
            throw new InvalidArgumentException('Compte introuvable.', 404);
        }

        $isAdmin = ($target['role'] ?? '') === 'admin';
        $isCurrentlyActive = isset($target['is_active']) ? (int)$target['is_active'] === 1 : true;

        // Désactivation d'un admin : interdite si c'est le dernier admin actif.
        if ($isAdmin && $isCurrentlyActive && !$active) {
            $others = $this->users->countActiveAdminsExcept($targetUserId);
            if ($others === 0) {
                throw new RuntimeException(
                    'Impossible de désactiver le dernier administrateur actif.',
                    403
                );
            }
        }

        $this->users->setActive($targetUserId, $active);

        $updated = $this->users->findById($targetUserId);
        return $this->publicFiche(is_array($updated) ? $updated : $target);
    }

    /**
     * Réinitialise le mot de passe d'un compte. Renvoie le mot de passe TEMPORAIRE
     * généré, haché Argon2id en base (jamais stocké en clair), affiché une seule
     * fois à l'administrateur demandeur.
     *
     * @return array{login:string,temporary_password:string}
     * @throws InvalidArgumentException si le compte n'existe pas.
     */
    public function resetPassword(int $targetUserId): array
    {
        $target = $this->users->findById($targetUserId);
        if ($target === null) {
            throw new InvalidArgumentException('Compte introuvable.', 404);
        }

        $temporary = $this->generateTemporaryPassword();
        $this->users->updatePassword($targetUserId, $temporary);

        return [
            'login'              => (string)$target['login'],
            'temporary_password' => $temporary,
        ];
    }


    /**
     * Statistiques globales pour le tableau de bord administrateur.
     *
     * @param DateTimeImmutable|null $now référence temporelle (UTC) pour les tests.
     */
    public function globalStats(?DateTimeImmutable $now = null): array
    {
        $now = $now ?? new DateTimeImmutable('now', new DateTimeZone('UTC'));
        if ($now->getTimezone()->getName() !== 'UTC') {
            $now = $now->setTimezone(new DateTimeZone('UTC'));
        }
        $fmt = 'Y-m-d\TH:i:s\Z';
        $since7  = $now->sub(new DateInterval('P7D'))->format($fmt);
        $since30 = $now->sub(new DateInterval('P30D'))->format($fmt);

        $totals = $this->admin->globalTotals($since7, $since30);
        // Répartition relative additions/multiplications (en %, par rapport au total).
        $games = $totals['games']['total'];
        $totals['games']['multiplication_pct'] = $games > 0 ? round($totals['games']['multiplication'] / $games * 100, 1) : 0.0;
        $totals['games']['addition_pct']       = $games > 0 ? round($totals['games']['addition'] / $games * 100, 1) : 0.0;

        $totals['activity'] = $this->admin->dailyGameCount(
            $since30,
            30,
            'Indian/Reunion'
        );

        $totals['generated_at_utc'] = $now->format($fmt);
        return $totals;
    }

    /**
     * Projette une ligne `users` en fiche publique (AUCUN mot de passe, AUCUN e-mail).
     * Réutilise l'extraction sûre d'AuthService::publicUser() pour la cohérence.
     */
    private function publicFiche(array $row): array
    {
        $fiche = $this->auth->publicUser($row);
        // Normalise is_active en booléen (certaines lectures SQL le donnent en int).
        if (isset($row['is_active'])) {
            $fiche['is_active'] = (int)$row['is_active'] === 1;
        }
        if (isset($row['last_login_at'])) {
            $fiche['last_login_at'] = (string)$row['last_login_at'];
        }
        return $fiche;
    }

    /**
     * Génère un mot de passe temporaire robuste (≥ 10 caractères) et dépourvu de
     * caractères ambigus (0/O, 1/l/I), tiré d'une source cryptographique.
     */
    private function generateTemporaryPassword(): string
    {
        $alpha = 'abcdefghjkmnpqrstuvwxyzABCDEFGHJKMNPQRSTUVWXYZ23456789';
        $max = strlen($alpha) - 1;
        $result = '';
        for ($i = 0; $i < self::TEMP_PASSWORD_LENGTH; $i++) {
            $result .= $alpha[random_int(0, $max)];
        }
        return $result;
    }
}

