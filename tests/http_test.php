<?php

declare(strict_types=1);

/**
 * http_test.php — Test HTTP de bout en bout de l'API JSON.
 *
 * Contrairement à run.php (tests unitaires CLI), ce script exerce le flux
 * HTTP réel : serveur PHP intégré, cookies de session transportés par curl
 * (cookie jar), jetons CSRF, codes HTTP et corps JSON.
 *
 * La base SQLite utilisée est jetable (répertoire temporaire) : la base de
 * production n'est jamais touchée.
 */

error_reporting(E_ALL);
ini_set('display_errors', '1');

$root = dirname(__DIR__);
$storageOverride = sys_get_temp_dir() . '/calc_trainer_http_' . getmypid();

// ---- Choix d'un port libre ----
$socket = stream_socket_server('tcp://127.0.0.1:0', $errno, $errstr);
if (!$socket) {
    fwrite(STDERR, "Impossible d'ouvrir un port : {$errstr}\n");
    exit(1);
}
$name = stream_socket_get_name($socket, false);
fclose($socket);
$port = (int)substr(strrchr($name, ':'), 1);

// ---- Démarrage du serveur intégré ----
$serverLog = sys_get_temp_dir() . "/calc_trainer_srv_{$port}.log";
$proc = proc_open(
    [
        PHP_BINARY, '-S', "127.0.0.1:{$port}", '-t', "{$root}/public",
    ],
    [
        1 => ['file', $serverLog, 'w'],
        2 => ['file', $serverLog, 'w'],
    ],
    $pipes,
    null,
    [
        'CALC_TRAINER_STORAGE_OVERRIDE' => $storageOverride,
    ]
);
if (!is_resource($proc)) {
    fwrite(STDERR, "Échec du lancement du serveur PHP intégré.\n");
    exit(1);
}

$base = "http://127.0.0.1:{$port}/api/index.php";
$jar = sys_get_temp_dir() . "/calc_trainer_jar_{$port}.txt";

// Attend que le serveur réponde.
$ready = false;
for ($i = 0; $i < 40; $i++) {
    $probe = @file_get_contents("{$base}?action=health");
    if ($probe !== false) {
        $ready = true;
        break;
    }
    usleep(150000);
}

register_shutdown_function(static function () use ($proc, $serverLog, $storageOverride, $jar): void {
    if (is_resource($proc)) {
        proc_terminate($proc);
        proc_close($proc);
    }
    @unlink($serverLog);
    @unlink($jar);
    foreach (glob("{$storageOverride}/*.sqlite*") ?: [] as $f) {
        @unlink($f);
    }
    @rmdir($storageOverride);
});

if (!$ready) {
    fwrite(STDERR, "Le serveur PHP intégré n'a pas démarré correctement.\n");
    fwrite(STDERR, file_get_contents($serverLog) ?: "Pas de log serveur.\n");
    exit(1);
}

// ---- Utilitaires ----
function http_call(string $method, string $url, array $body, string $jar): array
{
    $payload = json_encode($body);
    $cmd = [
        'curl', '-s', '-o', '-', '-w', "\n%{http_code}", '-X', $method,
        '-H', 'Content-Type: application/json',
        '--data', $payload,
        '-b', $jar, '-c', $jar,
        $url,
    ];
    $out = shell_exec(implode(' ', array_map('escapeshellarg', $cmd)));
    if ($out === null) {
        return [0, ''];
    }
    $parts = explode("\n", trim($out));
    $code = (int)array_pop($parts);
    return [$code, implode("\n", $parts)];
}

function get_call(string $url, string $jar): array
{
    $cmd = ['curl', '-s', '-o', '-', '-w', "\n%{http_code}", '-b', $jar, '-c', $jar, $url];
    $out = shell_exec(implode(' ', array_map('escapeshellarg', $cmd)));
    if ($out === null) {
        return [0, ''];
    }
    $parts = explode("\n", trim($out));
    $code = (int)array_pop($parts);
    return [$code, implode("\n", $parts)];
}

function expect(string $label, bool $ok, string $detail = ''): void
{
    global $passed, $failed;
    $mark = $ok ? '  ✓' : '  ✗';
    echo "{$mark} {$label}" . ($detail !== '' ? " — {$detail}" : '') . "\n";
    if ($ok) {
        $passed++;
    } else {
        $failed++;
    }
}

/** Récupère les en-têtes HTTP d'une requête (listes clé => valeur). */
function http_headers(string $url): array
{
    $cmd = ['curl', '-s', '-D', '-', '-o', '/dev/null', $url];
    $out = shell_exec(implode(' ', array_map('escapeshellarg', $cmd)));
    $headers = [];
    foreach (explode("\n", (string)$out) as $line) {
        $line = rtrim($line, "\r");
        $pos = strpos($line, ':');
        if ($pos !== false) {
            $key = strtolower(trim(substr($line, 0, $pos)));
            $val = trim(substr($line, $pos + 1));
            $headers[$key] = $val;
        }
    }
    return $headers;
}

$passed = 0;
$failed = 0;

echo "\n=== Test HTTP — sessions, cookies et CSRF ===\n";

[$code] = get_call("{$base}?action=health", $jar);
expect('health répond 200', $code === 200);

// En-têtes HTTP de sécurité (CSP, nosniff, frame, referrer, cache).
$hdr = http_headers("{$base}?action=health");
expect('En-tête Content-Security-Policy présent', !empty($hdr['content-security-policy'] ?? ''));
expect('CSP restreint aux ressources locales (default-src \'self\')',
    str_contains($hdr['content-security-policy'] ?? '', "default-src 'self'"));
expect('En-tête X-Content-Type-Options: nosniff', ($hdr['x-content-type-options'] ?? '') === 'nosniff');
expect('En-tête X-Frame-Options: DENY', strtoupper($hdr['x-frame-options'] ?? '') === 'DENY');
expect('En-tête Referrer-Policy: no-referrer', ($hdr['referrer-policy'] ?? '') === 'no-referrer');
expect('En-tête Cache-Control: no-store', str_contains(strtolower($hdr['cache-control'] ?? ''), 'no-store'));

// Le cookie de session doit être HttpOnly et SameSite=Lax (via la réponse auth/csrf).
$hdrCookie = http_headers("{$base}?action=auth/csrf");
$cookie = strtolower($hdrCookie['set-cookie'] ?? '');
expect('Cookie de session HttpOnly', str_contains($cookie, 'httponly'));
expect('Cookie de session SameSite=Lax', str_contains($cookie, 'samesite=lax'));

[$code] = get_call("{$base}?action=profile", $jar);
expect('profile sans session => 401', $code === 401, "HTTP {$code}");

[$code, $csrfBody] = get_call("{$base}?action=auth/csrf", $jar);
$csrf = json_decode($csrfBody, true);
$token = is_array($csrf) ? (string)($csrf['data']['token'] ?? '') : '';
expect('auth/csrf renvoie un jeton', $code === 200 && $token !== '');

[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'alice', 'password' => 'secretpass123'], $jar);
expect('register sans jeton CSRF => 403', $code === 403, "HTTP {$code}");

[$code, $regBody] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'alice', 'password' => 'secretpass123', 'csrf_token' => $token], $jar);
$reg = json_decode($regBody, true);
expect('register avec jeton CSRF => 201', $code === 201 && isset($reg['data']['user']['login']), "HTTP {$code}");
expect('réponse register sans champ e-mail', !is_array($reg['data']['user'] ?? null) || !array_key_exists('email', $reg['data']['user']));

// Un ancien client transmet encore un e-mail : il est ignoré, pas d'erreur.
[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'legacy_http', 'password' => 'secretpass123', 'email' => 'legacy@ex.fr', 'csrf_token' => $token], $jar);
expect('register avec e-mail transmit (ancien client) => 201, ignoré', $code === 201, "HTTP {$code}");

[$code, $loginBody] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'alice', 'password' => 'secretpass123', 'csrf_token' => $token], $jar);
$login = json_decode($loginBody, true);
expect('login correct => 200', $code === 200 && isset($login['data']['user']['login']), "HTTP {$code}");
expect('réponse login sans champ e-mail', !is_array($login['data']['user'] ?? null) || !array_key_exists('email', $login['data']['user']));

[$code] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'alice', 'password' => 'mauvais-mdp', 'csrf_token' => $token], $jar);
expect('login mauvais mot de passe => 401', $code === 401, "HTTP {$code}");

[$code, $profBody] = get_call("{$base}?action=profile", $jar);
$prof = json_decode($profBody, true);
expect('profile authentifié => 200', $code === 200 && isset($prof['data']['user']), "HTTP {$code}");
expect('réponse profile sans champ e-mail', !is_array($prof['data']['user'] ?? null) || !array_key_exists('email', $prof['data']['user']));

// La route de modification d'e-mail a été supprimée : elle répond "action inconnue".
[$code] = http_call('POST', $base, ['action' => 'profile/update', 'email' => 'nouveau@ex.fr', 'csrf_token' => $token], $jar);
expect('profile/update supprimée => 404 (action inconnue)', $code === 404, "HTTP {$code}");

$hashed = is_array($prof) ? (string)($prof['data']['user']['password_hash'] ?? '') : 'x';
expect('réponse profil sans empreinte mot de passe', $hashed === '');

[$code] = http_call('POST', $base, ['action' => 'auth/logout', 'csrf_token' => $token], $jar);
expect('logout => 200', $code === 200, "HTTP {$code}");

[$code] = get_call("{$base}?action=profile", $jar);
expect('profile après logout => 401', $code === 401, "HTTP {$code}");

[$code] = get_call("{$base}?action=inexistante", $jar);
expect('action inconnue => 404', $code === 404, "HTTP {$code}");

echo "\n=== Test HTTP — résultats et historique (étape 3) ===\n";

// Après le logout précédent, la session a été détruite : on récupère un
// NOUVEAU jeton CSRF. Cette nouvelle session n'est pas connectée.
[$code, $csrfBody2] = get_call("{$base}?action=auth/csrf", $jar);
$csrf2 = json_decode($csrfBody2, true);
$token2 = is_array($csrf2) ? (string)($csrf2['data']['token'] ?? '') : '';
expect('auth/csrf après logout (nouvelle session)', $token2 !== '', '');

// Enregistrement avec session valide (jeton OK) mais non connectée => 401.
[$code, $saveBody] = http_call('POST', $base, ['action' => 'result/save', 'mode' => 'multiplication', 'score' => 8, 'csrf_token' => $token2], $jar);
expect('result/save sans connexion => 401', $code === 401, "HTTP {$code}");

// Import sans connexion => 401.
[$code] = http_call('POST', $base, ['action' => 'result/import', 'items' => [], 'csrf_token' => $token2], $jar);
expect('result/import sans connexion => 401', $code === 401, "HTTP {$code}");

// Historique sans connexion => 401.
[$code] = get_call("{$base}?action=result/history", $jar);
expect('result/history sans connexion => 401', $code === 401, "HTTP {$code}");

// On se connecte avec la session alice (cookie déjà dans le jar).
[$code, $loginBody2] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'alice', 'password' => 'secretpass123', 'csrf_token' => $token2], $jar);
$login2 = json_decode($loginBody2, true);
expect('reconnexion alice => 200', $code === 200 && isset($login2['data']['user']), "HTTP {$code}");

// Après login, on récupère un jeton frais dans la session régénérée.
[$code, $csrfBody3] = get_call("{$base}?action=auth/csrf", $jar);
$csrf3 = json_decode($csrfBody3, true);
$token3 = is_array($csrf3) ? (string)($csrf3['data']['token'] ?? '') : '';
expect('auth/csrf après connexion (jeton frais)', $token3 !== '', '');

// Enregistrement d'un résultat valide (connecté) => 201.
[$code, $saveOk] = http_call('POST', $base, ['action' => 'result/save', 'mode' => 'multiplication', 'score' => 9, 'csrf_token' => $token3], $jar);
$saveOkJ = json_decode($saveOk, true);
expect('result/save connecté (valide) => 201', $code === 201 && isset($saveOkJ['data']['result']['id']) && $saveOkJ['data']['result']['id'] > 0, "HTTP {$code}");

// Mode invalide => 400.
[$code] = http_call('POST', $base, ['action' => 'result/save', 'mode' => 'soustraction', 'score' => 9, 'csrf_token' => $token3], $jar);
expect('result/save mode invalide => 400', $code === 400, "HTTP {$code}");

// Score invalide => 400.
[$code] = http_call('POST', $base, ['action' => 'result/save', 'mode' => 'addition', 'score' => 14, 'csrf_token' => $token3], $jar);
expect('result/save score invalide => 400', $code === 400, "HTTP {$code}");

// Historique : alice doit voir 1 résultat.
[$code, $histBody] = get_call("{$base}?action=result/history", $jar);
$hist = json_decode($histBody, true);
$histCount = is_array($hist) && is_array($hist['data']['history'] ?? null) ? count($hist['data']['history']) : -1;
expect('result/history connecté => 200, 1 partie', $code === 200 && $histCount === 1, "HTTP {$code} (nb={$histCount})");

// Import invité valide => 201, imported=2.
[$code, $impBody] = http_call('POST', $base, ['action' => 'result/import', 'items' => [
    ['guest_id' => 'v12-h1', 'mode' => 'multiplication', 'score' => 7, 'played_at' => '2026-01-01T08:00:00Z'],
    ['guest_id' => 'v12-h2', 'mode' => 'addition', 'score' => 5, 'played_at' => '2026-01-02T09:00:00Z'],
], 'csrf_token' => $token3], $jar);
$imp = json_decode($impBody, true);
expect('result/import valide => 201 imported=2', $code === 201 && isset($imp['data']['imported']) && $imp['data']['imported'] === 2, "HTTP {$code}");

// Réimport identique : idempotence, 0 importée, 2 sautées.
[$code, $impDup] = http_call('POST', $base, ['action' => 'result/import', 'items' => [
    ['guest_id' => 'v12-h1', 'mode' => 'multiplication', 'score' => 7, 'played_at' => '2026-01-01T08:00:00Z'],
    ['guest_id' => 'v12-h2', 'mode' => 'addition', 'score' => 5, 'played_at' => '2026-01-02T09:00:00Z'],
], 'csrf_token' => $token3], $jar);
$impDupJ = json_decode($impDup, true);
expect('result/import doublon => idempotent (imported=0, skipped=2)', $code === 201 && $impDupJ['data']['imported'] === 0 && $impDupJ['data']['skipped'] === 2, "HTTP {$code}");

// Historique à présent : 1 sauvegardé + 2 importés = 3.
[$code, $histBody2] = get_call("{$base}?action=result/history", $jar);
$hist2 = json_decode($histBody2, true);
$histCount2 = is_array($hist2) && is_array($hist2['data']['history'] ?? null) ? count($hist2['data']['history']) : -1;
expect('result/history total = 3 (1 save + 2 import), pas de doublon', $code === 200 && $histCount2 === 3, "HTTP {$code} (nb={$histCount2})");

// Import malformé => données invalides toutes rejetées, aucune écriture.
[$code, $impBad] = http_call('POST', $base, ['action' => 'result/import', 'items' => [
    ['guest_id' => 'v12-x1', 'mode' => 'inconnu', 'score' => 2, 'played_at' => '2026-03-01T08:00:00Z'],
    ['guest_id' => 'v12-x2', 'mode' => 'multiplication', 'score' => 99, 'played_at' => '2026-03-01T08:00:00Z'],
    ['guest_id' => 'v12-<x>', 'mode' => 'multiplication', 'score' => 2, 'played_at' => '2026-03-01T08:00:00Z'],
], 'csrf_token' => $token3], $jar);
$impBadJ = json_decode($impBad, true);
expect('result/import malformé => imported=0, skipped=3', $code === 201 && isset($impBadJ['data']['imported']) && $impBadJ['data']['imported'] === 0, "HTTP {$code}");

// Isolation : un second compte (bob) ne voit PAS l'historique d'alice.
$jarBob = sys_get_temp_dir() . "/calc_trainer_jar_bob_{$port}.txt";
[$code, $csrfBodyBob] = get_call("{$base}?action=auth/csrf", $jarBob);
$csrfBob = json_decode($csrfBodyBob, true);
$tokenBob = is_array($csrfBob) ? (string)($csrfBob['data']['token'] ?? '') : '';
[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'bob', 'password' => 'secretpass123', 'csrf_token' => $tokenBob], $jarBob);
expect('register bob => 201', $code === 201, "HTTP {$code}");
[$code, $logBob] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'bob', 'password' => 'secretpass123', 'csrf_token' => $tokenBob], $jarBob);
$logBobJ = json_decode($logBob, true);
expect('login bob => 200', $code === 200 && isset($logBobJ['data']['user']), "HTTP {$code}");
[$code, $histBob] = get_call("{$base}?action=result/history", $jarBob);
$histBobJ = json_decode($histBob, true);
$histBobCount = is_array($histBobJ) && is_array($histBobJ['data']['history'] ?? null) ? count($histBobJ['data']['history']) : -1;
expect('bob ne voit pas l\'historique d\'alice', $code === 200 && $histBobCount === 0, "HTTP {$code} (nb={$histBobCount})");

echo "\n=== Test HTTP — statistiques personnelles (étape 6) ===\n";

// Une toute nouvelle session (jar vide) sans connexion => 401.
$jarAnon = sys_get_temp_dir() . "/calc_trainer_jar_anon_{$port}.txt";
[$code] = get_call("{$base}?action=stats&mode=multiplication", $jarAnon);
expect('stats sans connexion => 401', $code === 401, "HTTP {$code}");
register_shutdown_function(static function () use ($jarAnon): void {
    @unlink($jarAnon);
});

// Alice, connectée : stats multiplications = 2 parties (1 save score 9 + 1 import score 7).
[$code, $statMult] = get_call("{$base}?action=stats&mode=multiplication", $jar);
$statMultJ = json_decode($statMult, true);
$tm = is_array($statMultJ) ? ($statMultJ['data']['totals'] ?? null) : null;
$validStats = is_array($tm)
    && isset($tm['games'], $tm['avg_score'], $tm['best_score'])
    && isset($statMultJ['data']['periods']['last_7d'], $statMultJ['data']['periods']['last_30d'])
    && is_array($statMultJ['data']['progression'] ?? null)
    && is_array($statMultJ['data']['daily_games'] ?? null);
expect('stats (multiplication) connecté => 200 et structure complète', $code === 200 && $validStats, "HTTP {$code}");
expect('stats multiplication : total = 2 parties', is_array($tm) && $tm['games'] === 2, "HTTP {$code}");
expect('stats multiplication : meilleur score = 9 (import 7 inclus)', is_array($tm) && $tm['best_score'] === 9, "HTTP {$code}");
expect('stats : 30 jours d\'histogramme renvoyés', is_array($statMultJ) && count($statMultJ['data']['daily_games'] ?? []) === 30, "HTTP {$code}");

// Alice : stats additions = 1 partie (import score 5).
[$code, $statAdd] = get_call("{$base}?action=stats&mode=addition", $jar);
$statAddJ = json_decode($statAdd, true);
$ta = is_array($statAddJ) ? ($statAddJ['data']['totals'] ?? null) : null;
expect('stats (addition) : total = 1, meilleur = 5', $code === 200 && is_array($ta) && $ta['games'] === 1 && $ta['best_score'] === 5, "HTTP {$code}");

// Mode inconnu => 400 (validation serveur).
[$code] = get_call("{$base}?action=stats&mode=division", $jar);
expect('stats mode inconnu => 400', $code === 400, "HTTP {$code}");

// Isolation : bob, connecté mais sans résultats, voit un total à 0.
[$code, $statBob] = get_call("{$base}?action=stats&mode=multiplication", $jarBob);
$statBobJ = json_decode($statBob, true);
$tb = is_array($statBobJ) ? ($statBobJ['data']['totals'] ?? null) : null;
expect('stats bob (sans parties) => total 0, isolation respectée', $code === 200 && is_array($tb) && $tb['games'] === 0, "HTTP {$code}");

// Nettoyage du cookie jar de bob (déjà géré pour l'autre jar mais bob spécifique).
register_shutdown_function(static function () use ($jarBob): void {
    @unlink($jarBob);
});

// =====================================================================
// Non-régression — horodatage played_at et normalisation frontend.
// Un compte isolé (carol) pour ne pas perturber les comptes alice/bob.
// Le frontend envoie désormais des dates STRICTES (YYYY-MM-DDTHH:mm:ssZ,
// sans millisecondes) après normalisation ; on vérifie ici que :
//   - une date issue de new Date().toISOString() (avec .sssZ) envoyée
//     telle quelle est REFUSÉE par le serveur (400) ;
//   - sa version normalisée (sans millisecondes) est acceptée (201) puis
//     visible dans l'historique et les statistiques ;
//   - un import dont les played_at contiennent des millisecondes est
//     rejeté, puis accepté une fois normalisé (ce que fait les frontend) ;
//   - un nouvel import ne duplique pas les données.
echo "\n=== Test HTTP — horodatage played_at et normalisation frontend ===\n";

$jarTs = sys_get_temp_dir() . "/calc_trainer_jar_ts_{$port}.txt";
register_shutdown_function(static function () use ($jarTs): void {
    @unlink($jarTs);
});

[$code, $csrfTs] = get_call("{$base}?action=auth/csrf", $jarTs);
$csrfTsJ = json_decode($csrfTs, true);
$tokenTs = is_array($csrfTsJ) ? (string)($csrfTsJ['data']['token'] ?? '') : '';
[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'carol', 'password' => 'secretpass123', 'csrf_token' => $tokenTs], $jarTs);
expect('register carol => 201', $code === 201, "HTTP {$code}");
[$code, $loginTs] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'carol', 'password' => 'secretpass123', 'csrf_token' => $tokenTs], $jarTs);
$loginTsJ = json_decode($loginTs, true);
expect('login carol => 200', $code === 200 && isset($loginTsJ['data']['user']), "HTTP {$code}");

// 1. Date brute équivalente à new Date().toISOString() (avec millisecondes) => REFUSÉE.
[$code] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'multiplication', 'score' => 8,
    'played_at' => '2026-10-27T10:00:00.123Z', 'csrf_token' => $tokenTs,
], $jarTs);
expect('save avec played_at=...123Z (new Date().toISOString() brut) => 400', $code === 400, "HTTP {$code}");

// 2. Version normalisée (strict, sans millisecondes) => acceptée.
[$code, $saveNorm] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'multiplication', 'score' => 8,
    'played_at' => '2026-10-27T10:00:00Z', 'csrf_token' => $tokenTs,
], $jarTs);
$saveNormJ = json_decode($saveNorm, true);
expect('save normalisé (...Z) => 201', $code === 201 && isset($saveNormJ['data']['result']['id']), "HTTP {$code}");

// 3. Un invité dont l'historique localStorage contient des played_at à
//    millisecondes est rejeté s'il est envoyé brut…
[$code, $impMs] = http_call('POST', $base, ['action' => 'result/import', 'items' => [
    ['guest_id' => 'v12-ts1', 'mode' => 'multiplication', 'score' => 6, 'played_at' => '2026-10-20T09:00:00.456Z'],
], 'csrf_token' => $tokenTs], $jarTs);
$impMsJ = json_decode($impMs, true);
expect('import avec played_at à millisecondes (brut) => 0 importée', $code === 201 && ($impMsJ['data']['imported'] ?? -1) === 0, "HTTP {$code}");

// 4. …et accepté une fois sa played_at normalisée (comme le fait le frontend).
[$code, $impNorm] = http_call('POST', $base, ['action' => 'result/import', 'items' => [
    ['guest_id' => 'v12-ts1', 'mode' => 'multiplication', 'score' => 6, 'played_at' => '2026-10-20T09:00:00Z'],
], 'csrf_token' => $tokenTs], $jarTs);
$impNormJ = json_decode($impNorm, true);
expect('import normalisé (...Z) => 1 importée', $code === 201 && ($impNormJ['data']['imported'] ?? -1) === 1, "HTTP {$code}");

// 5. Historique : 1 save + 1 import = 2 parties visibles.
[$code, $histTs] = get_call("{$base}?action=result/history", $jarTs);
$histTsJ = json_decode($histTs, true);
$histTsCount = is_array($histTsJ) && is_array($histTsJ['data']['history'] ?? null) ? count($histTsJ['data']['history']) : -1;
expect('historique carol = 2 parties (save + import normalisés)', $code === 200 && $histTsCount === 2, "HTTP {$code} (nb={$histTsCount})");

// 6. Statistiques : total multiplications = 2 (save 8 + import 6).
[$code, $statTs] = get_call("{$base}?action=stats&mode=multiplication", $jarTs);
$statTsJ = json_decode($statTs, true);
$tt = is_array($statTsJ) ? ($statTsJ['data']['totals'] ?? null) : null;
expect('stats carol (multiplication) : total = 2 parties', $code === 200 && is_array($tt) && ($tt['games'] ?? -1) === 2, "HTTP {$code}");
expect('stats carol : meilleur score = 8', is_array($tt) && ($tt['best_score'] ?? -1) === 8, "HTTP {$code}");

// 7. Réimport identique => idempotent, aucun doublon (historique toujours 2).
[$code, $impDupTs] = http_call('POST', $base, ['action' => 'result/import', 'items' => [
    ['guest_id' => 'v12-ts1', 'mode' => 'multiplication', 'score' => 6, 'played_at' => '2026-10-20T09:00:00Z'],
], 'csrf_token' => $tokenTs], $jarTs);
$impDupTsJ = json_decode($impDupTs, true);
[$code, $histTs2] = get_call("{$base}?action=result/history", $jarTs);
$histTs2J = json_decode($histTs2, true);
$histTs2Count = is_array($histTs2J) && is_array($histTs2J['data']['history'] ?? null) ? count($histTs2J['data']['history']) : -1;
expect('réimport => 0 importée (idempotent) et historique inchangé (2)', $code === 200 && ($impDupTsJ['data']['imported'] ?? -1) === 0 && $histTs2Count === 2, "HTTP {$code}");

echo "\n=== Résumé HTTP ===\n";
echo "Tests réussis : {$passed}\n";
echo "Tests échoués : {$failed}\n";
exit($failed === 0 ? 0 : 1);
