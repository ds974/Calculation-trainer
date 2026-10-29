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

// L'import des parties invitées a été retiré en v12.2 : la route répond désormais
// "action inconnue" (404), même sans connexion (elle n'est plus traitée nulle part).
[$code] = http_call('POST', $base, ['action' => 'result/import', 'items' => [], 'csrf_token' => $token2], $jar);
expect('result/import supprimée (route inconnue) => 404', $code === 404, "HTTP {$code}");

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

// v12.3 — un type de questions inconnu est refusé (validation serveur) => 400,
// sans écrire de partie.
[$code] = http_call('POST', $base, ['action' => 'result/save', 'mode' => 'multiplication', 'score' => 7, 'question_type' => 'trou', 'csrf_token' => $token3], $jar);
expect('result/save question_type invalide => 400', $code === 400, "HTTP {$code}");

// Historique : alice doit voir 1 résultat.
[$code, $histBody] = get_call("{$base}?action=result/history", $jar);
$hist = json_decode($histBody, true);
$histCount = is_array($hist) && is_array($hist['data']['history'] ?? null) ? count($hist['data']['history']) : -1;
expect('result/history connecté => 200, 1 partie', $code === 200 && $histCount === 1, "HTTP {$code} (nb={$histCount})");

// En v12.2, il n'existe plus d'importation de parties invitées : alice ne possède
// donc que sa partie directement enregistrée (voir l'historique ci-dessus).

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

// Alice, connectée : stats multiplications = 1 partie (son unique save, score 9).
[$code, $statMult] = get_call("{$base}?action=stats&mode=multiplication", $jar);
$statMultJ = json_decode($statMult, true);
$tm = is_array($statMultJ) ? ($statMultJ['data']['totals'] ?? null) : null;
$validStats = is_array($tm)
    && isset($tm['games'], $tm['avg_score'], $tm['best_score'])
    && isset($statMultJ['data']['periods']['last_7d'], $statMultJ['data']['periods']['last_30d'])
    && is_array($statMultJ['data']['progression'] ?? null)
    && is_array($statMultJ['data']['daily_games'] ?? null);
expect('stats (multiplication) connecté => 200 et structure complète', $code === 200 && $validStats, "HTTP {$code}");
expect('stats multiplication : total = 1 partie', is_array($tm) && $tm['games'] === 1, "HTTP {$code}");
expect('stats multiplication : meilleur score = 9', is_array($tm) && $tm['best_score'] === 9, "HTTP {$code}");
expect('stats : 30 jours d\'histogramme renvoyés', is_array($statMultJ) && count($statMultJ['data']['daily_games'] ?? []) === 30, "HTTP {$code}");

// Alice : stats additions = 0 partie (aucune addition enregistrée en v12.2).
[$code, $statAdd] = get_call("{$base}?action=stats&mode=addition", $jar);
$statAddJ = json_decode($statAdd, true);
$ta = is_array($statAddJ) ? ($statAddJ['data']['totals'] ?? null) : null;
expect('stats (addition) : total = 0', $code === 200 && is_array($ta) && $ta['games'] === 0, "HTTP {$code}");

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
//   - plus aucun import de parties invitées (la route result/import a été
//     retirée en v12.2).
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

// 3. En v12.2 plus aucun import de parties invitées : la partie strictement datée
//    est directement visible dans l'historique et les statistiques de carol.
[$code, $histTs] = get_call("{$base}?action=result/history", $jarTs);
$histTsJ = json_decode($histTs, true);
$histTsCount = is_array($histTsJ) && is_array($histTsJ['data']['history'] ?? null) ? count($histTsJ['data']['history']) : -1;
expect('historique carol = 1 partie (save strict)', $code === 200 && $histTsCount === 1, "HTTP {$code} (nb={$histTsCount})");

// 4. Statistiques : total multiplications = 1 (le save strict, score 8).
[$code, $statTs] = get_call("{$base}?action=stats&mode=multiplication", $jarTs);
$statTsJ = json_decode($statTs, true);
$tt = is_array($statTsJ) ? ($statTsJ['data']['totals'] ?? null) : null;
expect('stats carol (multiplication) : total = 1 partie', $code === 200 && is_array($tt) && ($tt['games'] ?? -1) === 1, "HTTP {$code}");
expect('stats carol : meilleur score = 8', is_array($tt) && ($tt['best_score'] ?? -1) === 8, "HTTP {$code}");

// v12.3 — type de questions via l'API, sur un compte isolé (carol) :
//   - un type valide (« hole ») est enregistré (201) et restitué dans l'historique ;
//   - le défaut (« classic ») reste appliqué aux parties sans question_type.
[$code, $saveHole] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'addition', 'score' => 6,
    'question_type' => 'hole', 'csrf_token' => $tokenTs,
], $jarTs);
expect('save question_type « hole » (connecté) => 201', $code === 201 && isset(json_decode($saveHole, true)['data']['result']['id']), "HTTP {$code}");
[$code, $histQ] = get_call("{$base}?action=result/history", $jarTs);
$histQJ = json_decode($histQ, true);
$histQList = is_array($histQJ) ? ($histQJ['data']['history'] ?? []) : [];
$holeRow = null;
$classicRow = null;
foreach ($histQList as $r) {
    if (($r['question_type'] ?? '') === 'hole') $holeRow = $r;
    if (($r['question_type'] ?? '') === 'classic') $classicRow = isset($classicRow) ? $classicRow : $r;
}
expect('historique restitue question_type « hole »', $code === 200 && is_array($holeRow), "HTTP {$code}");
expect('historique par défaut question_type « classic »', is_array($classicRow), "HTTP {$code}");

// =====================================================================
// v12.4 — Mémoire des difficultés personnelles via l'API enrichie.
// Un compte isolé (dave) pour ne pas perturber les comptes existants.
//  - result/save avec `mission_id` + `details` valides => 201 (id réel) ;
//  - rejouer le MÊME mission_id => 200 duplicate:true, result.id null,
//    aucune seconde écriture (idempotence) ;
//  - stats expose le bilan `difficulty` (par table) indépendamment du mode ;
//  - une mission avec un détail invalide => 400 et AUCUNE écriture partielle
//    (ni résultat, ni entrée de difficulté) — atomicité.
echo "\n=== Test HTTP — mémoire des difficultés personnelles (v12.4) ===\n";

$jarDave = sys_get_temp_dir() . "/calc_trainer_jar_dave_{$port}.txt";
register_shutdown_function(static function () use ($jarDave): void {
    @unlink($jarDave);
});

[$code, $csrfDave] = get_call("{$base}?action=auth/csrf", $jarDave);
$csrfDaveJ = json_decode($csrfDave, true);
$tokenDave = is_array($csrfDaveJ) ? (string)($csrfDaveJ['data']['token'] ?? '') : '';
expect('csrf dave (v12.4)', $tokenDave !== '', '');
[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'dave', 'password' => 'secretpass123', 'csrf_token' => $tokenDave], $jarDave);
expect('register dave (v12.4) => 201', $code === 201, "HTTP {$code}");
[$code, $logDave] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'dave', 'password' => 'secretpass123', 'csrf_token' => $tokenDave], $jarDave);
expect('login dave (v12.4) => 200', $code === 200, "HTTP {$code}");
[$code, $csrfDave2] = get_call("{$base}?action=auth/csrf", $jarDave);
$csrfDave2J = json_decode($csrfDave2, true);
$tokenDave2 = is_array($csrfDave2J) ? (string)($csrfDave2J['data']['token'] ?? '') : '';
expect('jeton dave après connexion', $tokenDave2 !== '', '');

$daveDetails = [];
for ($i = 0; $i < 10; $i++) {
    $daveDetails[] = ['mode' => 'multiplication', 'question_type' => 'classic', 'a' => 2, 'b' => 3, 'hole' => null, 'user_answer' => 6];
}

// 1. Première sauvegarde de la mission avec détails => 201, id réel.
[$code, $saveDave] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'multiplication', 'score' => 10,
    'mission_id' => 'D-M-001', 'details' => $daveDetails, 'csrf_token' => $tokenDave2,
], $jarDave);
$saveDaveJ = json_decode($saveDave, true);
$firstId = is_array($saveDaveJ) ? (int)($saveDaveJ['data']['result']['id'] ?? 0) : 0;
expect('result/save avancé (mission_id+details) => 201 avec id', $code === 201 && $firstId > 0, "HTTP {$code} (id={$firstId})");

// 2. Rejeu du MÊME mission_id => 200, duplicate:true, id null (idempotence).
[$code, $saveDave2] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'multiplication', 'score' => 10,
    'mission_id' => 'D-M-001', 'details' => $daveDetails, 'csrf_token' => $tokenDave2,
], $jarDave);
$saveDave2J = json_decode($saveDave2, true);
expect('rejeu du même mission_id => 200 duplicate, sans écriture',
    $code === 200 && ($saveDave2J['data']['duplicate'] ?? false) === true
        && ($saveDave2J['data']['result']['id'] ?? null) === null,
    "HTTP {$code}");

// 3. Historique : une seule partie malgré le rejeu (idempotence respectée).
[$code, $histDave] = get_call("{$base}?action=result/history", $jarDave);
$histDaveJ = json_decode($histDave, true);
$histDaveCount = is_array($histDaveJ) && is_array($histDaveJ['data']['history'] ?? null) ? count($histDaveJ['data']['history']) : -1;
expect('historique dave = 1 partie (mission non dupliquée)', $code === 200 && $histDaveCount === 1, "HTTP {$code} (nb={$histDaveCount})");

// 4. Bilan « Mes points à travailler » exposé par stats (indépendant du mode).
[$code, $statDave] = get_call("{$base}?action=stats&mode=addition", $jarDave);
$statDaveJ = json_decode($statDave, true);
$diff = is_array($statDaveJ) ? ($statDaveJ['data']['difficulty'] ?? null) : null;
$mcDave = is_array($diff) ? ($diff['multiplication']['classic'] ?? null) : null;
$tableFound = false;
$statusMastered = false;
if (is_array($mcDave)) {
    foreach ($mcDave as $t) {
        if (in_array((int)$t['table'], [2, 3], true)) {
            $tableFound = true;
            if (($t['status'] ?? '') === 'mastered' && abs((float)$t['attempts'] - 5.0) < 0.01) {
                $statusMastered = true;
            }
        }
    }
}
expect('stats expose le bilan difficulty (multiplication.classic)',
    $code === 200 && is_array($mcDave) && $tableFound, "HTTP {$code}");
expect('bilan : table 2/3 maîtrisée (assez pratiquée, diff 0) avec poids 0,5',
    $statusMastered, 'mastered / attempts 5.0');

// 5. Atomicité : mission avec un détail invalide (hole sur classic) => 400,
//    et AUCUNE écriture (ni résultat, ni ligne de difficulté pour 4x5).
$badDave = [];
for ($i = 0; $i < 9; $i++) {
    $badDave[] = ['mode' => 'multiplication', 'question_type' => 'classic', 'a' => 4, 'b' => 5, 'hole' => null, 'user_answer' => 20];
}
$badDave[] = ['mode' => 'multiplication', 'question_type' => 'classic', 'a' => 4, 'b' => 5, 'hole' => 'a', 'user_answer' => 4];
[$code, $saveBad] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'multiplication', 'score' => 9,
    'mission_id' => 'D-M-002', 'details' => $badDave, 'csrf_token' => $tokenDave2,
], $jarDave);
expect('mission avec détail invalide => 400', $code === 400, "HTTP {$code}");
[$code, $histDave2] = get_call("{$base}?action=result/history", $jarDave);
$histDave2J = json_decode($histDave2, true);
$histDave2Count = is_array($histDave2J) && is_array($histDave2J['data']['history'] ?? null) ? count($histDave2J['data']['history']) : -1;
expect('aucun résultat écrit pour la mission invalide (atomicité)',
    $code === 200 && $histDave2Count === 1, "HTTP {$code} (nb={$histDave2Count})");
[$code, $statDave2] = get_call("{$base}?action=stats&mode=multiplication", $jarDave);
$statDave2J = json_decode($statDave2, true);
$mcDave2 = is_array($statDave2J) ? ($statDave2J['data']['difficulty']['multiplication']['classic'] ?? []) : [];
$badTableSeen = false;
foreach ($mcDave2 as $t) {
    if (in_array((int)$t['table'], [4, 5], true)) { $badTableSeen = true; }
}
expect('aucune difficulté écrite pour la mission invalide (atomicité)',
    !$badTableSeen, '');

echo "\n=== Test HTTP — administration (v12.1) ===\n";

// 1. Amorçage direct d'un administrateur dans la base jetable. register crée
//    toujours role=user ; on insère donc un compte admin via PDO sur le même
//    fichier SQLite isolé (aucun impact sur la base de production).
$adminPdo = new PDO('sqlite:' . $storageOverride . '/calculation-trainer.sqlite', null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$adminPdo->prepare("INSERT INTO users (login, email, password_hash, role) VALUES ('admin', NULL, :h, 'admin')")
    ->execute(['h' => password_hash('adminpass123', PASSWORD_ARGON2ID)]);
$adminPdo = null; // Ferme la connexion avant la suite.

// Jeton CSRF de la session courante (variable $tok mise à jour par $fetchToken).
$tok = '';
$fetchToken = static function () use ($base, $jar, &$tok) {
    [$c, $b] = get_call("{$base}?action=auth/csrf", $jar);
    $j = json_decode($b, true);
    $tok = is_array($j) ? (string)($j['data']['token'] ?? '') : '';
};

// Inscription d'un compte utilisateur ordinaire (operator85) : renvoie son id.
$fetchToken();
[$code, $regB] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'operator85', 'password' => 'op85pass123', 'csrf_token' => $tok], $jar);
$regBJ = json_decode($regB, true);
$bobId = is_array($regBJ) ? (int)($regBJ['data']['user']['id'] ?? 0) : 0;
expect('register operator85 (utilisateur) => 201 avec id', $code === 201 && $bobId > 0, "HTTP {$code} id={$bobId}");

// 2. Un simple utilisateur ne peut pas accéder aux routes admin (403, rôle serveur).
$fetchToken();
[$code] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'operator85', 'password' => 'op85pass123', 'csrf_token' => $tok], $jar);
expect('login operator85 => 200', $code === 200, "HTTP {$code}");
[$code] = get_call("{$base}?action=admin/users", $jar);
expect('admin/users pour un simple utilisateur => 403', $code === 403, "HTTP {$code}");
[$code] = get_call("{$base}?action=admin/stats", $jar);
expect('admin/stats pour un simple utilisateur => 403', $code === 403, "HTTP {$code}");

// 3. Connexion de l'administrateur -> accès aux routes admin.
$fetchToken();
[$code] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'admin', 'password' => 'adminpass123', 'csrf_token' => $tok], $jar);
expect('login admin (compte administrateur) => 200', $code === 200, "HTTP {$code}");

[$code, $usersB] = get_call("{$base}?action=admin/users", $jar);
$usersJ = json_decode($usersB, true);
expect('admin/users (admin) => 200 avec total', $code === 200 && ($usersJ['data']['total'] ?? null) !== null, "HTTP {$code}");

[$code, $statsB] = get_call("{$base}?action=admin/stats", $jar);
$statsJ = json_decode($statsB, true);
expect('admin/stats (admin) => 200 avec users.total', $code === 200 && ($statsJ['data']['users']['total'] ?? null) !== null, "HTTP {$code}");
expect('admin/stats : un seul admin actif au départ => admins_active=1', ($statsJ['data']['users']['admins_active'] ?? null) === 1, 'HTTP ' . $code);


[$code, $uB] = get_call("{$base}?action=admin/user&id={$bobId}", $jar);
$uJ = json_decode($uB, true);
expect('admin/user (admin) => détail du compte', $code === 200 && ($uJ['data']['user']['login'] ?? '') === 'operator85', "HTTP {$code}");
expect('admin/user sans fuite de password_hash', !isset($uJ['data']['user']['password_hash']));

// 4. Élévation du rôle de operator85 au rang administrateur.
$fetchToken();
[$code, $roleB] = http_call('POST', $base, ['action' => 'admin/role', 'user_id' => $bobId, 'make_admin' => true, 'csrf_token' => $tok], $jar);
$roleJ = json_decode($roleB, true);
[$code, $statsAfter] = get_call("{$base}?action=admin/stats", $jar);
$statsAfterJ = json_decode($statsAfter, true);
expect('admin/stats : deux admins actifs après élévation => admins_active=2', ($statsAfterJ['data']['users']['admins_active'] ?? null) === 2, 'HTTP ' . $code);

expect('admin/role (make_admin=true) => operator85 devient admin', $code === 200 && ($roleJ['data']['user']['role'] ?? '') === 'admin', "HTTP {$code}");

// 5. Réinitialisation sécurisée du mot de passe, puis connexion de operator85 avec
//    le mot de passe temporaire reçu.
$fetchToken();
[$code, $pwdB] = http_call('POST', $base, ['action' => 'admin/password', 'user_id' => $bobId, 'csrf_token' => $tok], $jar);
$pwdJ = json_decode($pwdB, true);
$tempPwd = is_array($pwdJ) ? (string)($pwdJ['data']['reset']['temporary_password'] ?? '') : '';
expect('admin/password => renvoie un mot de passe temporaire', $code === 200 && strlen($tempPwd) >= 10, "HTTP {$code}");

$fetchToken();
[$code] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'operator85', 'password' => $tempPwd, 'csrf_token' => $tok], $jar);
expect('login operator85 avec le mot de passe temporaire => 200', $code === 200, "HTTP {$code}");

// 6. Désactivation du compte de operator85 (soft delete) : connexion ensuite refusée.
$fetchToken();
[$code, $actB] = http_call('POST', $base, ['action' => 'admin/active', 'user_id' => $bobId, 'is_active' => false, 'csrf_token' => $tok], $jar);
$actJ = json_decode($actB, true);
$actInactive = is_array($actJ) ? ($actJ['data']['user']['is_active'] ?? null) : null;
expect('admin/active (is_active=false) => compte désactivé', $code === 200 && ($actInactive === false || $actInactive === 0), "HTTP {$code}");

$fetchToken();
[$code] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'operator85', 'password' => $tempPwd, 'csrf_token' => $tok], $jar);
expect('login operator85 après désactivation => refusé (403)', $code === 403, "HTTP {$code}");

// 7. Sécurité : une session DEJA ouverte d'un compte désactivé est rendue
//    immédiatement inutilisable. Le jar contient encore la session que
//    operator85 avait ouverte avant sa désactivation : tout accès (même au
//    simple profil, même aux routes admin) doit désormais être refusé (401),
//    sans nouvelle connexion.
[$code] = get_call("{$base}?action=profile", $jar);
expect('session déjà ouverte d\'un compte désactivé => profil refusé (401)', $code === 401, "HTTP {$code}");
[$code] = get_call("{$base}?action=admin/users", $jar);
expect('session déjà ouverte (désactivé) => admin/users refusé (401)', $code === 401, "HTTP {$code}");
[$code] = get_call("{$base}?action=stats&mode=multiplication", $jar);
expect('session déjà ouverte (désactivé) => stats refusé (401)', $code === 401, "HTTP {$code}");


echo "\n=== Résumé HTTP ===\n";
echo "Tests réussis : {$passed}\n";
echo "Tests échoués : {$failed}\n";
exit($failed === 0 ? 0 : 1);
