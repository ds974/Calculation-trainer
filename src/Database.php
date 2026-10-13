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
        $storageDir = $projectRoot . DIRECTORY_SEPARATOR . 'storage';
        if (!is_dir($storageDir)) {
            // Le dossier storage/ doit exister ; sinon on crée pour faciliter l'init.
            if (!@mkdir($storageDir, 0775, true) && !is_dir($storageDir)) {
                throw new RuntimeException(
                    "Impossible de créer le répertoire de stockage : {$storageDir}"
                );
            }
        }

        $this->path = $storageDir . DIRECTORY_SEPARATOR . 'calculation-trainer.sqlite';
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
                FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
            )");

        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_results_user ON results(user_id)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_results_mode ON results(mode)');
        $pdo->exec('CREATE INDEX IF NOT EXISTS idx_results_played ON results(played_at)');
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
