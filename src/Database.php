<?php

declare(strict_types=1);

/**
 * Database — Connexion PDO SQLite centralisée.
 *
 * Responsabilités :
 *  - ouvrir une connexion PDO unique vers la base SQLite (hors HTTP) ;
 *  - appliquer les PRAGMA (clés étrangères, WAL, busy_timeout, synchro) ;
 *  - créer le schéma initial (utilisateurs, résultats) si absent ;
 *  - signaler explicitement toute impossibilité d'activer le mode WAL.
 */

final class Database
{
    /** Chemin absolu vers le fichier SQLite. */
    private string $path;

    /** Connexion PDO ouverte. */
    private PDO $pdo;

    /** Le mode WAL est-il effectivement actif ? */
    private bool $walActive = false;

    /**
     * Construit la connexion à la base.
     *
     * @param string $projectRoot Racine absolue du projet (pour dériver storage/).
     */
    public function __construct(string $projectRoot)
    {
        // Permet aux tests/tools d'isoler une base jetable via une variable
        // d'environnement (absente en production). Aucun impact en usage normal.
        $override = getenv('CALC_TRAINER_STORAGE_OVERRIDE');
        if (is_string($override) && $override !== '') {
            $storageDir = $override;
        } else {
            $storageDir = $projectRoot . DIRECTORY_SEPARATOR . 'storage';
        }

        if (!is_dir($storageDir)) {
            // Le dossier de stockage doit exister ; sinon on crée pour faciliter l'init.
            if (!@mkdir($storageDir, 0775, true) && !is_dir($storageDir)) {
                throw new RuntimeException(
                    "Impossible de créer le répertoire de stockage : {$storageDir}"
                );
            }
        }

        $this->path = rtrim($storageDir, DIRECTORY_SEPARATOR)
            . DIRECTORY_SEPARATOR . 'calculation-trainer.sqlite';
        $this->connect();
    }

    private function connect(): void
    {
        $dsn = 'sqlite:' . $this->path;
        try {
            $this->pdo = new PDO($dsn, null, null, [
                PDO::ATTR_ERRMODE            => PDO::ERRMODE_EXCEPTION,
                PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
                PDO::ATTR_EMULATE_PREPARES   => false,
            ]);
        } catch (PDOException $e) {
            throw new RuntimeException(
                "Échec de la connexion à la base SQLite : " . $e->getMessage()
            );
        }

        $this->applyPragmas();
        $this->createSchemaIfNeeded();
    }

    private function applyPragmas(): void
    {
        $pdo = $this->pdo;

        // Clés étrangères SQLite : obligatoires pour l'intégrité des données.
        $pdo->exec('PRAGMA foreign_keys = ON');

        // Gestion des accès concurrents.
        $pdo->exec('PRAGMA busy_timeout = 5000');

        // Tenter d'activer le mode WAL.
        $row = $pdo->query('PRAGMA journal_mode')->fetch();
        $current = is_array($row) ? strtolower((string)($row['journal_mode'] ?? '')) : '';
        if ($current !== 'wal') {
            $result = $pdo->query('PRAGMA journal_mode = WAL')->fetch();
            $after = is_array($result) ? strtolower((string)($result['journal_mode'] ?? '')) : '';
            $this->walActive = ($after === 'wal');
        } else {
            $this->walActive = true;
        }

        // En WAL, synchronous=NORMAL offre un bon compromis cohérence/perf.
        if ($this->walActive) {
            $pdo->exec('PRAGMA synchronous = NORMAL');
        }
    }

    /**
     * Indique si le mode WAL est effectivement actif.
     * À appeler par les scripts/administrateur pour signaler un souci.
     */
    public function isWalActive(): bool
    {
        return $this->walActive;
    }

    private function createSchemaIfNeeded(): void
    {
        $pdo = $this->pdo;

        // Utilisation de guillemets doubles PHP pour éviter d'échapper les apostrophes SQL.
        $pdo->exec("CREATE TABLE IF NOT EXISTS users (
                id            INTEGER PRIMARY KEY AUTOINCREMENT,
                login         TEXT NOT NULL UNIQUE COLLATE NOCASE,
                email         TEXT,
                password_hash TEXT NOT NULL,
                role          TEXT NOT NULL DEFAULT 'user'
                              CHECK (role IN ('user', 'admin')),
                created_at    TEXT NOT NULL
                              DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now'))
            )");

        $pdo->exec("CREATE TABLE IF NOT EXISTS results (
                id         INTEGER PRIMARY KEY AUTOINCREMENT,
                user_id    INTEGER NOT NULL,
                played_at  TEXT NOT NULL
                           DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                mode       TEXT NOT NULL
                           CHECK (mode IN ('multiplication', 'addition')),
                score      INTEGER NOT NULL CHECK (score BETWEEN 0 AND 10),
                guest_id   TEXT,
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )");

        
        // Migration idempotente : ajoute la colonne guest_id aux bases créées avant v12 étape 3.
        // Permet de garantir l'unicité (et donc l'idempotence) des imports invités.
        $resultsCols = $pdo->query("PRAGMA table_info(results)")->fetchAll(PDO::FETCH_COLUMN, 1);
        if (is_array($resultsCols) && !in_array('guest_id', $resultsCols, true)) {
            $pdo->exec('ALTER TABLE results ADD COLUMN guest_id TEXT');
        }

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_results_user ON results(user_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_results_mode ON results(mode)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_results_played ON results(played_at)');

        // Index unique partiel : un même guest_id (partie invitée) ne peut être
        // importé qu'une seule fois par utilisateur => idempotence de l'import.
        $pdo->exec(
            'CREATE UNIQUE INDEX IF NOT EXISTS idx_results_guest
             ON results(user_id, guest_id) WHERE guest_id IS NOT NULL'
        );

        // Table de limitation des tentatives de connexion (anti brute-force).
        $pdo->exec("CREATE TABLE IF NOT EXISTS login_attempts (
                id             INTEGER PRIMARY KEY AUTOINCREMENT,
                login          TEXT,
                ip_address     TEXT,
                attempted_at   TEXT NOT NULL
                               DEFAULT (strftime('%Y-%m-%dT%H:%M:%SZ', 'now')),
                success        INTEGER NOT NULL DEFAULT 0
            )");
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_login_attempts_login ON login_attempts(login)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_login_attempts_ip ON login_attempts(ip_address)');
    }

    /** Retourne la connexion PDO unique. */
    public function pdo(): PDO
    {
        return $this->pdo;
    }

    /** Chemin du fichier SQLite. */
    public function path(): string
    {
        return $this->path;
    }
}
