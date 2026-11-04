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

echo "\n=== Test HTTP — préférence linguistique (v12.6-C1) ===\n";

// Session dédiée pour le test de langue (cookie jar indépendant).
$jarLang = sys_get_temp_dir() . "/calc_trainer_jar_lang_{$port}.txt";
$csrfLang = json_decode(get_call("{$base}?action=auth/csrf", $jarLang)[1], true);
$tokenLang = is_array($csrfLang) ? (string)($csrfLang['data']['token'] ?? '') : '';
expect('csrf langage (session dédiée)', $tokenLang !== '');

// Inscription AVEC langue : la langue doit être enregistrée et renvoyée.
[$code, $regLang] = http_call('POST', $base, [
    'action' => 'auth/register', 'login' => 'lingua',
    'password' => 'secretpass123', 'preferred_language' => 'es', 'csrf_token' => $tokenLang,
], $jarLang);
$regLangJ = json_decode($regLang, true);
expect('register avec preferred_language=es => 201', $code === 201, "HTTP {$code}");
expect('la langue es est renvoyée à l\'inscription',
    ($regLangJ['data']['user']['preferred_language'] ?? '') === 'es',
    (string)($regLangJ['data']['user']['preferred_language'] ?? ''));

// Inscription SANS langue : valeur par défaut 'fr'.
[$code, $regNoLang] = http_call('POST', $base, [
    'action' => 'auth/register', 'login' => 'lingua2',
    'password' => 'secretpass123', 'csrf_token' => $tokenLang,
], $jarLang);
$regNoLangJ = json_decode($regNoLang, true);
expect('register sans langue => 201', $code === 201, "HTTP {$code}");
expect('la langue par défaut est fr',
    ($regNoLangJ['data']['user']['preferred_language'] ?? '') === 'fr',
    (string)($regNoLangJ['data']['user']['preferred_language'] ?? ''));

// Inscription avec une langue NON autorisée => rejetée (400).
[$code] = http_call('POST', $base, [
    'action' => 'auth/register', 'login' => 'linguaBad', 'password' => 'secretpass123',
    'preferred_language' => 'en-US', 'csrf_token' => $tokenLang,
], $jarLang);
expect('register avec langue non autorisée (en-US) => 400', $code === 400, "HTTP {$code}");

// Connexion : la langue enregistrée est renvoyée.
[$code, $loginLang] = http_call('POST', $base, [
    'action' => 'auth/login', 'login' => 'lingua', 'password' => 'secretpass123', 'csrf_token' => $tokenLang,
], $jarLang);
$loginLangJ = json_decode($loginLang, true);
expect('login lingua => 200', $code === 200, "HTTP {$code}");
expect('la langue es est renvoyée au login',
    ($loginLangJ['data']['user']['preferred_language'] ?? '') === 'es',
    (string)($loginLangJ['data']['user']['preferred_language'] ?? ''));

// Profil : la langue enregistrée est renvoyée.
[$code, $profLang] = get_call("{$base}?action=profile", $jarLang);
$profLangJ = json_decode($profLang, true);
expect('profile lingua => 200', $code === 200, "HTTP {$code}");
expect('la langue es est renvoyée au profil',
    ($profLangJ['data']['user']['preferred_language'] ?? '') === 'es',
    (string)($profLangJ['data']['user']['preferred_language'] ?? ''));
$linguaId = (int)($profLangJ['data']['user']['id'] ?? 0);

// Modification de la préférence (connecté, CSRF) : fr->es->zh-Hans.
[$code, $updZh] = http_call('POST', $base, [
    'action' => 'profile/language', 'preferred_language' => 'zh-Hans', 'csrf_token' => $tokenLang,
], $jarLang);
$updZhJ = json_decode($updZh, true);
expect('profile/language vers zh-Hans => 200', $code === 200, "HTTP {$code}");
expect('zh-Hans enregistrée et renvoyée',
    ($updZhJ['data']['user']['preferred_language'] ?? '') === 'zh-Hans',
    (string)($updZhJ['data']['user']['preferred_language'] ?? ''));

// Persistance après reconnaissance : la langue doit rester zh-Hans.
[$code] = http_call('POST', $base, ['action' => 'auth/logout', 'csrf_token' => $tokenLang], $jarLang);
$csrfLang2 = json_decode(get_call("{$base}?action=auth/csrf", $jarLang)[1], true);
$tokenLang2 = is_array($csrfLang2) ? (string)($csrfLang2['data']['token'] ?? '') : '';
[$code, $relog] = http_call('POST', $base, [
    'action' => 'auth/login', 'login' => 'lingua', 'password' => 'secretpass123', 'csrf_token' => $tokenLang2,
], $jarLang);
expect('reconnexion lingua => 200', $code === 200, "HTTP {$code}");
$relogJ = json_decode($relog, true);
expect('la langue zh-Hans persiste après reconnexion',
    ($relogJ['data']['user']['preferred_language'] ?? '') === 'zh-Hans',
    (string)($relogJ['data']['user']['preferred_language'] ?? ''));

// Valeur invalide => 400.
[$code] = http_call('POST', $base, [
    'action' => 'profile/language', 'preferred_language' => 'de', 'csrf_token' => $tokenLang2,
], $jarLang);
expect('profile/language avec langue non autorisée => 400', $code === 400, "HTTP {$code}");

// Sans jeton CSRF => 403.
[$code] = http_call('POST', $base, ['action' => 'profile/language', 'preferred_language' => 'en'], $jarLang);
expect('profile/language sans CSRF => 403', $code === 403, "HTTP {$code}");

// Sans connexion => 401.
$jarAnon = sys_get_temp_dir() . "/calc_trainer_jar_anon_{$port}.txt";
$csrfAnon = json_decode(get_call("{$base}?action=auth/csrf", $jarAnon)[1], true);
$tokenAnon = is_array($csrfAnon) ? (string)($csrfAnon['data']['token'] ?? '') : '';
[$code] = http_call('POST', $base, [
    'action' => 'profile/language', 'preferred_language' => 'en', 'csrf_token' => $tokenAnon,
], $jarAnon);
expect('profile/language sans connexion => 401', $code === 401, "HTTP {$code}");

// Le rôle, le statut et les données du compte restent inchangés après le
// changement de langue (vérification sur le profil).
[$code, $profAfter] = get_call("{$base}?action=profile", $jarLang);
$profAfterJ = json_decode($profAfter, true);
expect('rôle inchangé après changement de langue',
    ($profAfterJ['data']['user']['role'] ?? '') === 'user',
    (string)($profAfterJ['data']['user']['role'] ?? ''));
expect('identifiant du compte inchangé (même id)',
    (int)($profAfterJ['data']['user']['id'] ?? 0) === $linguaId,
    (string)($profAfterJ['data']['user']['id'] ?? 0));

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

// ---------------------------------------------------------------------------
// v12.8-B2 — durée (duration_ms) et niveau scolaire HISTORIQUE dans result/save.
// Compte isolé « carol ». On vérifie les valeurs réellement stockées en SQLite
// (lecture directe), pas seulement les réponses HTTP.
// ---------------------------------------------------------------------------
$jarCarol = sys_get_temp_dir() . "/calc_trainer_jar_b2dur_{$port}.txt";
[$code] = get_call("{$base}?action=auth/csrf", $jarCarol);
[$code, $csrfBodyCarol] = get_call("{$base}?action=auth/csrf", $jarCarol);
$csrfCarol = json_decode($csrfBodyCarol, true);
$tokenCarol = is_array($csrfCarol) ? (string)($csrfCarol['data']['token'] ?? '') : '';
[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'b2dur', 'password' => 'secretpass123', 'csrf_token' => $tokenCarol], $jarCarol);
expect('register b2dur => 201', $code === 201, "HTTP {$code}");
[$code, $logCarol] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'b2dur', 'password' => 'secretpass123', 'csrf_token' => $tokenCarol], $jarCarol);
$logCarolJ = json_decode($logCarol, true);
expect('login b2dur => 200', $code === 200 && isset($logCarolJ['data']['user']), "HTTP {$code}");
[$code, $csrfBodyC2] = get_call("{$base}?action=auth/csrf", $jarCarol);
$csrfC2 = json_decode($csrfBodyC2, true);
$tokenC2 = is_array($csrfC2) ? (string)($csrfC2['data']['token'] ?? '') : '';

// 1. Durée valide => 201, et valeur stockée en base.
[$code] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'multiplication', 'score' => 9,
    'duration_ms' => 12340, 'csrf_token' => $tokenC2,
], $jarCarol);
expect('result/save avec durée valide => 201', $code === 201, "HTTP {$code}");

// 2. Client fournissant un school_level arbitraire : IGNORÉ (le niveau provient
//    du profil authentifié ; b2dur n'ayant pas de niveau, la partie est unspecified).
[$code] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'addition', 'score' => 6,
    'duration_ms' => 8000, 'school_level' => 'high_school', 'csrf_token' => $tokenC2,
], $jarCarol);
expect('result/save avec school_level client arbitraire => 201', $code === 201, "HTTP {$code}");

// 3. Durée absente (ancien client) => 201, NULL en base.
[$code] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'addition', 'score' => 5, 'csrf_token' => $tokenC2,
], $jarCarol);
expect('result/save sans durée (rétrocompat) => 201', $code === 201, "HTTP {$code}");

// 4. Durée JSON null => 201, NULL en base (compatibilité, distinct de "null").
[$code] = http_call('POST', $base, [
    'action' => 'result/save', 'mode' => 'addition', 'score' => 4,
    'duration_ms' => null, 'csrf_token' => $tokenC2,
], $jarCarol);
expect('result/save avec duration_ms null (JSON) => 201', $code === 201, "HTTP {$code}");

// 5. Durées invalides => 400 : 0, négative, décimale (chaîne "12.5"), chaîne "1500",
//    chaîne "null" (à ne PAS confondre avec JSON null), booléen, excessive.
$badDurations = [0, -1, 12.5, "1500", "null", true, "abc", 1800001];
$badDurRejected = 0;
foreach ($badDurations as $bd) {
    [$c] = http_call('POST', $base, [
        'action' => 'result/save', 'mode' => 'multiplication', 'score' => 7,
        'duration_ms' => $bd, 'csrf_token' => $tokenC2,
    ], $jarCarol);
    if ($c === 400) { $badDurRejected++; }
}
expect('result/save durées invalides (0/négatif/décimal/chaîne/null-string/bool/excessif) => 400',
    $badDurRejected === count($badDurations), "rejetés {$badDurRejected}/" . count($badDurations));

// 6. Vérifications SQLite des valeurs réellement stockées.
$b2Pdo = new PDO('sqlite:' . $storageOverride . '/calculation-trainer.sqlite', null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$b2Pdo->exec('PRAGMA busy_timeout = 5000');
$b2Pdo->exec('PRAGMA foreign_keys = ON');
$b2durId = (int)$b2Pdo->query("SELECT id FROM users WHERE login = 'b2dur'")->fetchColumn();
$rows = $b2Pdo->prepare(
    'SELECT mode, score, duration_ms, school_level FROM results WHERE user_id = :id ORDER BY id'
);
$rows->execute(['id' => $b2durId]);
$b2durRows = $rows->fetchAll(PDO::FETCH_ASSOC);
$b2Pdo = null;
expect('B2 : 4 parties stockées pour b2dur', count($b2durRows) === 4, "nb=" . count($b2durRows));
// Première partie (durée valide) : durée stockée, niveau unspecified (profil sans niveau).
expect('B2 : durée valide stockée dans SQLite',
    (int)$b2durRows[0]['duration_ms'] === 12340, (string)$b2durRows[0]['duration_ms']);
expect('B2 : school_level client IGNORÉ -> unspecified (niveau du profil)',
    $b2durRows[1]['school_level'] === 'unspecified', (string)$b2durRows[1]['school_level']);
// Deuxième partie : durée 8000 stockée.
expect('B2 : durée 8000 stockée pour la 2e partie',
    (int)$b2durRows[1]['duration_ms'] === 8000, (string)$b2durRows[1]['duration_ms']);
// Troisième et quatrième parties : durée absente / null => NULL en base.
expect('B2 : durée absente -> NULL en base',
    $b2durRows[2]['duration_ms'] === null, var_export($b2durRows[2]['duration_ms'], true));
expect('B2 : duration_ms null (JSON) -> NULL en base',
    $b2durRows[3]['duration_ms'] === null, var_export($b2durRows[3]['duration_ms'], true));

// 7. CSRF : result/save sans jeton => 403.
[$code] = http_call('POST', $base, ['action' => 'result/save', 'mode' => 'multiplication', 'score' => 5], $jarCarol);
expect('result/save sans CSRF => 403', $code === 403, "HTTP {$code}");

// ---------------------------------------------------------------------------
// v12.8-B3.1 — niveau scolaire dans le profil : inscription, profil, mise à jour,
// validation stricte, CSRF, isolation et non-rétroactivité.
// ---------------------------------------------------------------------------
$jarSL = sys_get_temp_dir() . "/calc_trainer_jar_sl_{$port}.txt";
$ctxSL = static function () use ($base, $jarSL): array {
    [$c, $b] = get_call("{$base}?action=auth/csrf", $jarSL);
    $j = json_decode($b, true);
    return [$c, is_array($j) ? (string)($j['data']['token'] ?? '') : ''];
};
[$code, $tokSL] = $ctxSL();
[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'niveau_user', 'password' => 'secretpass123', 'csrf_token' => $tokSL], $jarSL);
expect('B3.1 register sans niveau => 201', $code === 201, "HTTP {$code}");
[$code, $logSL] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'niveau_user', 'password' => 'secretpass123', 'csrf_token' => $tokSL], $jarSL);
expect('B3.1 login niveau_user => 200', $code === 200, "HTTP {$code}");

// 1. Profil : school_level absent => null.
[$code, $profSL] = get_call("{$base}?action=profile", $jarSL);
$profSLJ = json_decode($profSL, true);
$level0 = isset($profSLJ['data']['user']['school_level']) ? $profSLJ['data']['user']['school_level'] : '(absent)';
expect('B3.1 profil : school_level null (Non renseigné) par défaut', $profSLJ['data']['user']['school_level'] === null, var_export($level0, true));

// 2. Inscription avec niveau valide + profil le renvoit.
$jarSL2 = sys_get_temp_dir() . "/calc_trainer_jar_sl2_{$port}.txt";
[$c, $b2] = get_call("{$base}?action=auth/csrf", $jarSL2);
$tokSL2 = is_array(json_decode($b2, true)) ? (string)(json_decode($b2, true)['data']['token'] ?? '') : '';
[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'claire_niveau', 'password' => 'secretpass123', 'school_level' => 'middle_school', 'preferred_language' => 'en', 'csrf_token' => $tokSL2], $jarSL2);
expect('B3.1 register avec niveau middle_school => 201', $code === 201, "HTTP {$code}");
[$code, $logSL2] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'claire_niveau', 'password' => 'secretpass123', 'csrf_token' => $tokSL2], $jarSL2);
[$code, $profSL2] = get_call("{$base}?action=profile", $jarSL2);
$profSL2J = json_decode($profSL2, true);
expect('B3.1 profil renvoie middle_school', ($profSL2J['data']['user']['school_level'] ?? null) === 'middle_school', var_export($profSL2J['data']['user']['school_level'] ?? null, true));
expect('B3.1 preferred_language compat (en) préservée', ($profSL2J['data']['user']['preferred_language'] ?? '') === 'en', '');

// 3. Inscription avec niveau invalide => 400 (compte non créé).
$jarSLbad = sys_get_temp_dir() . "/calc_trainer_jar_slbad_{$port}.txt";
[$c, $b3] = get_call("{$base}?action=auth/csrf", $jarSLbad);
$tokSLbad = is_array(json_decode($b3, true)) ? (string)(json_decode($b3, true)['data']['token'] ?? '') : '';
[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'bad_niveau', 'password' => 'secretpass123', 'school_level' => 'CP', 'csrf_token' => $tokSLbad], $jarSLbad);
expect('B3.1 register niveau invalide "CP" => 400', $code === 400, "HTTP {$code}");

// 4. POST profile/school-level : chacune des six catégories acceptée.
$six = ['preschool', 'elementary_lower', 'elementary_upper', 'middle_school', 'high_school', 'higher_adult'];
$okCount = 0;
foreach ($six as $lvl) {
    [$code, $resSL] = http_call('POST', $base, ['action' => 'profile/school-level', 'school_level' => $lvl, 'csrf_token' => $tokSL], $jarSL);
    $resJ = json_decode($resSL, true);
    if ($code === 200 && ($resJ['data']['user']['school_level'] ?? null) === $lvl) { $okCount++; }
}
expect('B3.1 les six catégories modifiables via POST', $okCount === 6, "ok {$okCount}/6");

// 5. Retour à null (« Non renseigné »).
[$code, $resNull] = http_call('POST', $base, ['action' => 'profile/school-level', 'school_level' => null, 'csrf_token' => $tokSL], $jarSL);
$resNullJ = json_decode($resNull, true);
expect('B3.1 retour school_level null => 200',
    $code === 200 && array_key_exists('school_level', $resNullJ['data']['user'] ?? []) && $resNullJ['data']['user']['school_level'] === null,
    "HTTP {$code}");

// 6. Valeurs invalides refusées (unspecified, chaîne vide, arbitraire, types).
$badSL = ['unspecified', '', 'collège', 5, true, ['a'], 12.5, 'CE1'];
$badRej = 0;
foreach ($badSL as $bv) {
    [$c] = http_call('POST', $base, ['action' => 'profile/school-level', 'school_level' => $bv, 'csrf_token' => $tokSL], $jarSL);
    if ($c === 400) { $badRej++; }
}
expect('B3.1 valeurs scolaires invalides refusées (unspecified/vide/arbitraire/types)', $badRej === count($badSL), "rejetés {$badRej}/" . count($badSL));

// 7. School_level totalement absent de la requête => 400 (endpoint traite le niveau).
[$code] = http_call('POST', $base, ['action' => 'profile/school-level', 'csrf_token' => $tokSL], $jarSL);
expect('B3.1 school_level absent => 400', $code === 400, "HTTP {$code}");

// 8. Sans authentification => 401.
$jarSLanon = sys_get_temp_dir() . "/calc_trainer_jar_slanon_{$port}.txt";
[$c, $bAn] = get_call("{$base}?action=auth/csrf", $jarSLanon);
$tokAn = is_array(json_decode($bAn, true)) ? (string)(json_decode($bAn, true)['data']['token'] ?? '') : '';
[$code] = http_call('POST', $base, ['action' => 'profile/school-level', 'school_level' => 'high_school', 'csrf_token' => $tokAn], $jarSLanon);
expect('B3.1 profile/school-level sans connexion => 401', $code === 401, "HTTP {$code}");

// 9. Sans CSRF => 403.
[$code] = http_call('POST', $base, ['action' => 'profile/school-level', 'school_level' => 'preschool'], $jarSL);
expect('B3.1 profile/school-level sans CSRF => 403', $code === 403, "HTTP {$code}");

// 10. Impossible de modifier un AUTRE compte via un user_id transmis par le client.
[$code, $resSL] = http_call('POST', $base, ['action' => 'profile/school-level', 'school_level' => 'high_school', 'user_id' => 999999, 'csrf_token' => $tokSL], $jarSL);
$resSLJ = json_decode($resSL, true);
// Le champ user_id doit être ignoré : le niveau du compte connecté change, pas celui d'un autre.
expect('B3.1 user_id client ignoré (modifie le compte de session)',
    $code === 200 && ($resSLJ['data']['user']['school_level'] ?? null) === 'high_school',
    "HTTP {$code} " . var_export($resSLJ['data']['user']['school_level'] ?? null, true));
[$code, $profSLcheck] = get_call("{$base}?action=profile", $jarSL2);
$profSLcheckJ = json_decode($profSLcheck, true);
expect('B3.1 le niveau d\'un autre compte est intact',
    ($profSLcheckJ['data']['user']['school_level'] ?? null) === 'middle_school',
    var_export($profSLcheckJ['data']['user']['school_level'] ?? null, true));

// 11. Non-rétroactivité : aucun résultat n'est écrit lors des changements de niveau
//     du profil, et le niveau d'une partie reste son niveau HISTORIQUE figé.
$b3pdo = new PDO('sqlite:' . $storageOverride . '/calculation-trainer.sqlite', null, null, [PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION]);
$b3pdo->exec('PRAGMA busy_timeout = 5000');
$slUid = (int)$b3pdo->query("SELECT id FROM users WHERE login = 'niveau_user'")->fetchColumn();
$countRes = (int)$b3pdo->query("SELECT COUNT(*) FROM results WHERE user_id = {$slUid}")->fetchColumn();
$b3pdo = null;
expect('B3.1 aucun résultat écrit par les changements de niveau (non-rétroactivité)', $countRes === 0, "nb={$countRes}");

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

echo "\n=== Test HTTP — opérations difficiles (v12.5) ===\n";

// Un compte isolé (eve) pour ne pas perturber les comptes existants.
//  - difficulty/operations sans connexion => 401 ;
//  - connecté : seules SES opérations difficiles (difficulty > 0), diff 0 exclue ;
//  - filtres par mode, type de question, plage d'additions et tables ;
//  - isolation : un autre compte (bob) ne voit rien.

$jarEve = sys_get_temp_dir() . "/calc_trainer_jar_eve_{$port}.txt";
register_shutdown_function(static function () use ($jarEve): void {
    @unlink($jarEve);
});
[$code, $csrfEve] = get_call("{$base}?action=auth/csrf", $jarEve);
$csrfEveJ = json_decode($csrfEve, true);
$tokenEve = is_array($csrfEveJ) ? (string)($csrfEveJ['data']['token'] ?? '') : '';
[$code] = http_call('POST', $base, ['action' => 'auth/register', 'login' => 'eve', 'password' => 'secretpass123', 'csrf_token' => $tokenEve], $jarEve);
[$code, $logEveBody] = http_call('POST', $base, ['action' => 'auth/login', 'login' => 'eve', 'password' => 'secretpass123', 'csrf_token' => $tokenEve], $jarEve);
$logEve = json_decode($logEveBody, true);
expect('register/login eve (v12.5)', $code === 200 && isset($logEve['data']['user']), "HTTP {$code}");
[$code, $csrfEve2] = get_call("{$base}?action=auth/csrf", $jarEve);
$csrfEve2J = json_decode($csrfEve2, true);
$tokenEve2 = is_array($csrfEve2J) ? (string)($csrfEve2J['data']['token'] ?? '') : '';

// Amorçage de données de difficulté via result/save (mission_id + détails).
// Chaque mission porte UNE opération répétée N fois en erreur pour atteindre la
// difficulté visée ; une mission en réussite crée une diff 0 (exclue).
$seed = function (string $mid, string $mode, string $qt, int $a, int $b, int $errors, int $ok = 0) use ($base, $jarEve, $tokenEve2): array {
    $correct = $qt === 'hole'
        ? $a // trou sur le 1er opérande : la bonne réponse est l'opérande manquant `a`.
        : ($mode === 'multiplication' ? $a * $b : $a + $b);
    $details = [];
    for ($i = 0; $i < $errors; $i++) {
        $details[] = ['mode' => $mode, 'question_type' => $qt, 'a' => $a, 'b' => $b,
            'hole' => $qt === 'hole' ? 'a' : null,
            'user_answer' => ($qt === 'hole' ? $a : ($mode === 'multiplication' ? $a * $b : $a + $b)) + 1];
    }
    for ($i = 0; $i < $ok; $i++) {
        $details[] = ['mode' => $mode, 'question_type' => $qt, 'a' => $a, 'b' => $b,
            'hole' => $qt === 'hole' ? 'a' : null, 'user_answer' => $correct];
    }
    $score = $ok; // 1 point par réussite (0-10), cohérent avec le score contractuel.
    return http_call('POST', $base, [
        'action' => 'result/save', 'mode' => $mode, 'score' => $score,
        'mission_id' => $mid, 'details' => $details, 'question_type' => $qt,
        'csrf_token' => $tokenEve2,
    ], $jarEve);
};

// 6×7 mult classic : 4 erreurs => diff 4.
[$code] = $seed('E-M-001', 'multiplication', 'classic', 6, 7, 4);
// 3×9 mult classic : 2 erreurs => diff 2.
[$code] = $seed('E-M-002', 'multiplication', 'classic', 3, 9, 2);
// 4×5 mult classic : 4 réussites => diff 0 (doit être EXCLUE).
[$code] = $seed('E-M-003', 'multiplication', 'classic', 4, 5, 0, 4);
// 2×2 mult hole : 3 erreurs => diff 3.
[$code] = $seed('E-M-004', 'multiplication', 'hole', 2, 2, 3);
// 5+6 addition classic : 1 erreur => diff 1.
[$code] = $seed('E-M-005', 'addition', 'classic', 5, 6, 1);
// 9+14 addition hole : 2 erreurs => diff 2.
[$code] = $seed('E-M-006', 'addition', 'hole', 9, 14, 2);
expect('amorçage des difficultés de eve (result/save)', $code === 201, "HTTP {$code}");

// Anonyme : 401 (authentification obligatoire).
$jarAnonEve = sys_get_temp_dir() . "/calc_trainer_jar_anon_eve_{$port}.txt";
register_shutdown_function(static function () use ($jarAnonEve): void { @unlink($jarAnonEve); });
[$code] = get_call("{$base}?action=difficulty/operations", $jarAnonEve);
expect('difficulty/operations sans connexion => 401', $code === 401, "HTTP {$code}");

// Connectée, sans filtre : SEULES ses opérations difficiles, diff 0 exclue.
[$code, $opsRaw] = get_call("{$base}?action=difficulty/operations", $jarEve);
$opsJ = json_decode($opsRaw, true);
$ops = is_array($opsJ) && is_array($opsJ['data']['operations'] ?? null) ? $opsJ['data']['operations'] : [];
$keyfn = fn(array $o): string => ($o['mode'] ?? '') . '|' . ($o['question_type'] ?? '')
    . '|' . (int)($o['a'] ?? 0) . '|' . (int)($o['b'] ?? 0);
$opsMap = [];
foreach ($ops as $o) { $opsMap[$keyfn($o)] = $o; }
expect('difficulty/operations connecté => 200 et liste', $code === 200 && is_array($opsJ['data']['operations'] ?? null), "HTTP {$code}");
expect('eve : 5 opérations difficiles (diff 0 exclue)', count($ops) === 5, 'nb=' . count($ops));
expect('opération maîtrisée 4×5 (diff 0) absente', !isset($opsMap['multiplication|classic|4|5']));
expect('6×7 présent avec difficulté 4', isset($opsMap['multiplication|classic|6|7'])
    && (int)$opsMap['multiplication|classic|6|7']['difficulty'] === 4);
$shapeOk = true;
foreach ($ops as $o) {
    foreach (['mode', 'question_type', 'a', 'b', 'difficulty'] as $f) {
        if (!array_key_exists($f, $o)) { $shapeOk = false; }
    }
}
expect('chaque opération expose mode/question_type/a/b/difficulty', $shapeOk);

// Bob (compte sans difficultés) ne voit rien (isolation).
[$code, $opsBob] = get_call("{$base}?action=difficulty/operations", $jarBob);
$opsBobJ = json_decode($opsBob, true);
$opsBobCount = is_array($opsBobJ) && is_array($opsBobJ['data']['operations'] ?? null) ? count($opsBobJ['data']['operations']) : -1;
expect('isolation bob : aucune opération', $code === 200 && $opsBobCount === 0, "HTTP {$code} (nb={$opsBobCount})");

// Filtrer par mode.
[$code, $opsMult] = get_call("{$base}?action=difficulty/operations&mode=multiplication", $jarEve);
$opsMultJ = json_decode($opsMult, true);
$opsMultArr = is_array($opsMultJ['data']['operations'] ?? null) ? $opsMultJ['data']['operations'] : [];
$multOnly = true;
foreach ($opsMultArr as $o) { if (($o['mode'] ?? '') !== 'multiplication') { $multOnly = false; } }
expect('filtre mode=multiplication : 3 opérations, toutes multiplications', count($opsMultArr) === 3 && $multOnly, 'nb=' . count($opsMultArr));

[$code, $opsAdd] = get_call("{$base}?action=difficulty/operations&mode=addition", $jarEve);
$opsAddJ = json_decode($opsAdd, true);
$opsAddArr = is_array($opsAddJ['data']['operations'] ?? null) ? $opsAddJ['data']['operations'] : [];
$addOnly = true;
foreach ($opsAddArr as $o) { if (($o['mode'] ?? '') !== 'addition') { $addOnly = false; } }
expect('filtre mode=addition : 2 opérations, toutes additions', count($opsAddArr) === 2 && $addOnly, 'nb=' . count($opsAddArr));

// Filtrer par type de question.
[$code, $opsClassic] = get_call("{$base}?action=difficulty/operations&question_type=classic", $jarEve);
$opsClassicJ = json_decode($opsClassic, true);
$opsClassicArr = is_array($opsClassicJ['data']['operations'] ?? null) ? $opsClassicJ['data']['operations'] : [];
$classicOnly = true;
foreach ($opsClassicArr as $o) { if (($o['question_type'] ?? '') !== 'classic') { $classicOnly = false; } }
expect('filtre question_type=classic : 3 opérations classiques', count($opsClassicArr) === 3 && $classicOnly, 'nb=' . count($opsClassicArr));

[$code, $opsHole] = get_call("{$base}?action=difficulty/operations&question_type=hole", $jarEve);
$opsHoleJ = json_decode($opsHole, true);
$opsHoleArr = is_array($opsHoleJ['data']['operations'] ?? null) ? $opsHoleJ['data']['operations'] : [];
$holeOnly = true;
foreach ($opsHoleArr as $o) { if (($o['question_type'] ?? '') !== 'hole') { $holeOnly = false; } }
expect('filtre question_type=hole : 2 opérations à trou', count($opsHoleArr) === 2 && $holeOnly, 'nb=' . count($opsHoleArr));

// Filtrer par plage d'additions (5-10) : 9+14 exclu (14 hors plage).
[$code, $opsRange] = get_call("{$base}?action=difficulty/operations&mode=addition&add_min=5&add_max=10", $jarEve);
$opsRangeJ = json_decode($opsRange, true);
$opsRangeArr = is_array($opsRangeJ['data']['operations'] ?? null) ? $opsRangeJ['data']['operations'] : [];
expect('plage additions 5-10 : seule 5+6 (9+14 exclu)', count($opsRangeArr) === 1
    && (int)($opsRangeArr[0]['a'] ?? 0) === 5 && (int)($opsRangeArr[0]['b'] ?? 0) === 6,
    'nb=' . count($opsRangeArr));

// Filtrer par tables autorisées (2,3) : seule 2×2 (les deux opérandes dans {2,3}).
[$code, $opsTables] = get_call("{$base}?action=difficulty/operations&mode=multiplication&tables=2,3", $jarEve);
$opsTablesJ = json_decode($opsTables, true);
$opsTablesArr = is_array($opsTablesJ['data']['operations'] ?? null) ? $opsTablesJ['data']['operations'] : [];
expect('tables 2,3 : seule 2×2 (6×7 et 3×9 exclus)', count($opsTablesArr) === 1
    && (int)($opsTablesArr[0]['a'] ?? 0) === 2 && (int)($opsTablesArr[0]['b'] ?? 0) === 2,
    'nb=' . count($opsTablesArr));

// Filtres invalides => 400 (validation stricte).
[$code] = get_call("{$base}?action=difficulty/operations&mode=division", $jarEve);
expect('mode invalide => 400', $code === 400, "HTTP {$code}");
[$code] = get_call("{$base}?action=difficulty/operations&question_type=trou", $jarEve);
expect('type de question invalide => 400', $code === 400, "HTTP {$code}");
[$code] = get_call("{$base}?action=difficulty/operations&tables=0,13", $jarEve);
expect('table hors limites => 400', $code === 400, "HTTP {$code}");
[$code] = get_call("{$base}?action=difficulty/operations&add_min=50&add_max=10", $jarEve);
expect('plage incohérente (min>max) => 400', $code === 400, "HTTP {$code}");

// Non-régression : les API existantes répondent toujours correctement.
[$code] = get_call("{$base}?action=health", $jar);
expect('non-régression : health répond toujours 200', $code === 200, "HTTP {$code}");
[$code, $histEve] = get_call("{$base}?action=result/history", $jarEve);
$histEveJ = json_decode($histEve, true);
$histEveCount = is_array($histEveJ['data']['history'] ?? null) ? count($histEveJ['data']['history']) : -1;
expect('non-régression : result/history de eve toujours fonctionnel', $code === 200 && $histEveCount === 6, "HTTP {$code} (nb={$histEveCount})");

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



// =====================================================================
// v12.8-B4.1 — classement partagé côté serveur (GET, public).
// Comptes isolés dédiés pour ne pas perturber les tests précédents.
// Les parties sont enregistrées via result/save (le serveur fige le niveau
// scolaire historique DEPUIS LE PROFIL) : on règle donc d'abord le niveau de
// chaque compte, puis on enregistre plusieurs parties avec durée et date.
echo "\n=== Test HTTP — classement partagé côté serveur (v12.8-B4.1) ===\n";

$mkLb = static function (string $login, string $password, int $port) use ($base): array {
    $jarU = sys_get_temp_dir() . "/calc_trainer_jar_lb_{$login}_{$port}.txt";
    register_shutdown_function(static function () use ($jarU): void { @unlink($jarU); });
    [$c, $b] = get_call("{$base}?action=auth/csrf", $jarU);
    $j = json_decode($b, true);
    $token = is_array($j) ? (string)($j['data']['token'] ?? '') : '';
    http_call('POST', $base, ['action' => 'auth/register', 'login' => $login, 'password' => $password, 'csrf_token' => $token], $jarU);
    http_call('POST', $base, ['action' => 'auth/login', 'login' => $login, 'password' => $password, 'csrf_token' => $token], $jarU);
    [$c, $b] = get_call("{$base}?action=auth/csrf", $jarU);
    $j = json_decode($b, true);
    $token2 = is_array($j) ? (string)($j['data']['token'] ?? '') : '';
    return [$jarU, $token2];
};
$lbSave = static function (string $base, string $jarU, string $token, string $mode, int $score, ?int $durationMs, string $playedAt, string $qt = 'classic', ?string $mid = null): int {
    $body = [
        'action' => 'result/save', 'mode' => $mode, 'score' => $score,
        'question_type' => $qt, 'csrf_token' => $token,
    ];
    if ($playedAt !== '') { $body['played_at'] = $playedAt; }
    if ($durationMs !== null) { $body['duration_ms'] = $durationMs; }
    if ($mid !== null) { $body['mission_id'] = $mid; }
    [$code, $b] = http_call('POST', $base, $body, $jarU);
    $j = json_decode($b, true);
    return $code === 201 ? (int)($j['data']['result']['id'] ?? 0) : 0;
};
$lbSetLevel = static function (string $base, string $jarU, string $token, ?string $level): bool {
    [$code] = http_call('POST', $base, ['action' => 'profile/school-level', 'school_level' => $level, 'csrf_token' => $token], $jarU);
    return $code === 200;
};

// Cookie jar anonyme (vierge) pour les consultations PUBLIQUES du classement :
// aucun compte ni session ne sont requis.
$jarLbAnon = sys_get_temp_dir() . "/calc_trainer_jar_lb_anon_{$port}.txt";
register_shutdown_function(static function () use ($jarLbAnon): void { @unlink($jarLbAnon); });

// ---- Comptes isolés ----
[$jarLbA, $tokLbA] = $mkLb('lb_alpha', 'lbpass12345', $port);
[$jarLbB, $tokLbB] = $mkLb('lb_beta', 'lbpass12345', $port);
[$jarLbC, $tokLbC] = $mkLb('lb_gamma', 'lbpass12345', $port);
[$jarLbD, $tokLbD] = $mkLb('lb_delta', 'lbpass12345', $port);
[$jarLbI, $tokLbI] = $mkLb('lb_inactive', 'lbpass12345', $port);

// Niveaux scolaires des comptes.
expect('lb_alpha -> elementary_upper', $lbSetLevel($base, $jarLbA, $tokLbA, 'elementary_upper'), '');
expect('lb_beta -> elementary_upper', $lbSetLevel($base, $jarLbB, $tokLbB, 'elementary_upper'), '');
expect('lb_gamma -> elementary_upper', $lbSetLevel($base, $jarLbC, $tokLbC, 'elementary_upper'), '');
expect('lb_delta -> high_school', $lbSetLevel($base, $jarLbD, $tokLbD, 'high_school'), '');
expect('lb_inactive -> elementary_upper', $lbSetLevel($base, $jarLbI, $tokLbI, 'elementary_upper'), '');

// Parties (multiplication, classic, elementary_upper pour A/B/C).
// lb_alpha : 8/10 en 30000, puis 10/10 en 65000, puis 10/10 en 48000
//            -> meilleur retenu = 10/48000.
$lbSave($base, $jarLbA, $tokLbA, 'multiplication', 8, 30000, '2026-01-01T09:00:00Z');
$lbSave($base, $jarLbA, $tokLbA, 'multiplication', 10, 65000, '2026-01-02T09:00:00Z');
$lbSave($base, $jarLbA, $tokLbA, 'multiplication', 10, 48000, '2026-01-03T09:00:00Z');
// lb_beta : 9/10 en 20000 -> derrière alpha (score prioritaire).
$lbSave($base, $jarLbB, $tokLbB, 'multiplication', 9, 20000, '2026-01-04T09:00:00Z');
// lb_gamma : 10/10 SANS durée -> après alpha mais avant beta.
$lbSave($base, $jarLbC, $tokLbC, 'multiplication', 10, null, '2026-01-05T09:00:00Z');
// lb_delta (high_school) : 9/10 en 12000.
$lbSave($base, $jarLbD, $tokLbD, 'multiplication', 9, 12000, '2026-01-08T09:00:00Z');
// lb_inactive : excellent 10/10 en 1000 -> DOIT être exclu du classement.
$lbSave($base, $jarLbI, $tokLbI, 'multiplication', 10, 1000, '2026-01-09T09:00:00Z');

// Désactivation RÉELLE du compte lb_inactive (soft delete) directement dans la
// base SQLite jetable, comme le fait le banc admin (aucun impact en production).
// Sans cette étape, is_active vaut encore 1 : le compte ne serait pas exclu.
$deactPdo = new PDO('sqlite:' . $storageOverride . '/calculation-trainer.sqlite', null, null, [
    PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
]);
$stmt = $deactPdo->prepare("UPDATE users SET is_active = 0 WHERE login = :l");
$stmt->execute(['l' => 'lb_inactive']);
$deactPdo = null;




// ---- 1. GET public sans authentification ----
[$code, $lbBody] = get_call("{$base}?action=leaderboard", $jarLbAnon);
$lbJ = json_decode($lbBody, true);
expect('leaderboard GET sans authentification => 200 (public, aucune session requise)', $code === 200, "HTTP {$code}");

// ---- 2. GET avec utilisateur connecté (même classement accessible) ----
[$code2, $lbBody2] = get_call("{$base}?action=leaderboard", $jarLbA);
expect('leaderboard GET avec utilisateur connecté => 200', $code2 === 200, "HTTP {$code2}");
expect('réponse identique en public et connecté', $lbBody === $lbBody2, '');

// ---- 3. Paramètres par défaut et ordre déterministe ----
$lj = is_array($lbJ) ? ($lbJ['data'] ?? []) : [];
$filters = $lj['filters'] ?? [];
$entries = is_array($lj['entries'] ?? null) ? $lj['entries'] : [];
expect('défauts : mode multiplication, niveau all, type classic',
    ($filters['mode'] ?? '') === 'multiplication' && ($filters['school_level'] ?? '') === 'all' && ($filters['question_type'] ?? '') === 'classic', '');
// Le classement 'all' regroupe tous niveaux et donc aussi des comptes créés par
// d'autres tests HTTP (alice, bob, carol, dave, eve, b2dur...). On vérifie donc
// UNIQUEMENT les propriétés parmi nos comptes isolés (lb_*) :
//   - leaderboard: all est non vide ;
//   - nos joueurs apparaissent chacun UNE SEULE FOIS ;
//   - le compte désactivé (lb_inactive) est ABSENT ;
//   - lb_alpha retient sa meilleure partie 10/48000.
expect('leaderboard : classement général non vide', count($entries) >= 5, 'nb=' . count($entries));
$nameByOrder = array_column($entries, 'display_name');
$seenLb = [];
foreach ($entries as $e) {
    $n = $e['display_name'] ?? '';
    if (strncmp($n, 'lb_', 3) === 0) { $seenLb[$n] = ($seenLb[$n] ?? 0) + 1; }
}
expect("chaque joueur lb_* n'apparaît qu'une seule fois en général",
    array_key_exists('lb_alpha', $seenLb) && $seenLb['lb_alpha'] === 1
    && array_key_exists('lb_beta', $seenLb) && $seenLb['lb_beta'] === 1
    && array_key_exists('lb_gamma', $seenLb) && $seenLb['lb_gamma'] === 1
    && array_key_exists('lb_delta', $seenLb) && $seenLb['lb_delta'] === 1,
    implode(',', array_keys($seenLb)));
expect("compte désactivé (lb_inactive) absent du classement général", !in_array('lb_inactive', $nameByOrder, true), '');
// Meilleur résultat par joueur : alpha retient 10/48000 (pas 8/30000 ni 10/65000).
$alphaRow = null;
foreach ($entries as $e) { if (($e['display_name'] ?? '') === 'lb_alpha') { $alphaRow = $e; } }
expect('meilleur résultat retenu (alpha 10/48000)',
    is_array($alphaRow) && $alphaRow['score'] === 10 && $alphaRow['duration_ms'] === 48000, json_encode($alphaRow));
// Score prioritaire sur durée : beta (9/10) derrière gamma (10/NULL).
$orderIdx = array_flip($nameByOrder);
expect('score prioritaire sur durée (beta derrière gamma 10/NULL)', $orderIdx['lb_gamma'] < $orderIdx['lb_beta'], '');
// Durée NULL après durée connue à score égal : gamma derrière alpha.
expect('durée NULL classée après durée connue (gamma derrière alpha)', $orderIdx['lb_alpha'] < $orderIdx['lb_gamma'], '');



// ---- 4. Filtres valides (niveau scolaire) ----
[$code, $lbEl] = get_call("{$base}?action=leaderboard&mode=multiplication&school_level=elementary_upper&question_type=classic&limit=20", $jarLbAnon);
$elJ = json_decode($lbEl, true);
$elEntries = is_array($elJ['data']['entries'] ?? null) ? $elJ['data']['entries'] : [];
// elementary_upper : alpha,beta,gamma (delta est high_school, inactive exclu).
expect('filtre school_level=elementary_upper => 3 entrées',
    $code === 200 && count($elEntries) === 3, 'HTTP ' . $code . ' nb=' . count($elEntries));
expect('elementary_upper ordonné (alpha, gamma, beta)',
    array_column($elEntries, 'display_name') === ['lb_alpha', 'lb_gamma', 'lb_beta'],
    implode(',', array_column($elEntries, 'display_name')));
[$code, $lbHs] = get_call("{$base}?action=leaderboard&school_level=high_school", $jarLbAnon);
$hsJ = json_decode($lbHs, true);
$hsEntries = is_array($hsJ['data']['entries'] ?? null) ? $hsJ['data']['entries'] : [];
expect('filtre high_school => seul delta (9/10)', $code === 200 && count($hsEntries) === 1 && ($hsEntries[0]['display_name'] ?? '') === 'lb_delta', 'nb=' . count($hsEntries));

// ---- 5. Filtres invalides => 400 ----
[$code] = get_call("{$base}?action=leaderboard&mode=soustraction", $jarLbAnon);
expect('mode inconnu => 400', $code === 400, "HTTP {$code}");
[$code] = get_call("{$base}?action=leaderboard&school_level=universite", $jarLbAnon);
expect('niveau inconnu => 400', $code === 400, "HTTP {$code}");
[$code] = get_call("{$base}?action=leaderboard&question_type=quiz", $jarLbAnon);
expect('type inconnu => 400', $code === 400, "HTTP {$code}");
[$code] = get_call("{$base}?action=leaderboard&limit=0", $jarLbAnon);
expect('limite 0 => 400', $code === 400, "HTTP {$code}");
[$code] = get_call("{$base}?action=leaderboard&limit=abc", $jarLbAnon);
expect('limite non numérique => 400', $code === 400, "HTTP {$code}");

// ---- 6. Limite respectée ----
[$code, $lbLim] = get_call("{$base}?action=leaderboard&limit=2", $jarLbAnon);
$limJ = json_decode($lbLim, true);
$limEntries = is_array($limJ['data']['entries'] ?? null) ? $limJ['data']['entries'] : [];
expect('limit=2 : renvoie 2 entrées', $code === 200 && count($limEntries) === 2, 'HTTP ' . $code . ' nb=' . count($limEntries));

// ---- 7. Confidentialité : aucune donnée privée ----
$flat = json_encode($lj);
expect('aucun e-mail exposé', strpos($flat, '@') === false);
expect('aucun user_id exposé', strpos($flat, '"user_id"') === false && strpos($flat, '"id":') === false);
expect('aucun rôle/hash exposé', strpos($flat, 'password') === false && stripos($flat, 'admin') === false);
$first = is_array($entries) && count($entries) > 0 ? $entries[0] : null;
$firstKeys = is_array($first) ? array_keys($first) : [];
expect("entrées n'exposent que rank/display_name/score/duration_ms/played_at/tables",
    count(array_diff($firstKeys, ['rank', 'display_name', 'score', 'duration_ms', 'played_at', 'tables'])) === 0,
    implode(',', $firstKeys));

// ---- 8. Séparation classic / hole / mixed ----
// Les classements par type sont strictement séparés. On restreint ces requêtes
// à elementary_upper (mode multiplication, défaut) pour isoler nos comptes des
// parties des autres tests HTTP.
$lbSave($base, $jarLbA, $tokLbA, 'multiplication', 10, 5000, '2026-01-10T09:00:00Z', 'hole');
[$code, $lbHole] = get_call("{$base}?action=leaderboard&mode=multiplication&school_level=elementary_upper&question_type=hole", $jarLbAnon);
$holeJ = json_decode($lbHole, true);
$holeEntries = is_array($holeJ['data']['entries'] ?? null) ? $holeJ['data']['entries'] : [];
expect('question_type=hole : séparé de classic (seule la partie hole de alpha)',
    $code === 200 && count($holeEntries) === 1 && ($holeEntries[0]['display_name'] ?? '') === 'lb_alpha', 'nb=' . count($holeEntries));
[$code, $lbClassic] = get_call("{$base}?action=leaderboard&mode=multiplication&school_level=elementary_upper&question_type=classic", $jarLbAnon);
$classicJ = json_decode($lbClassic, true);
$classicEntries = is_array($classicJ['data']['entries'] ?? null) ? $classicJ['data']['entries'] : [];
expect('classic inchangé par la partie hole de alpha (3 entrées)',
    $code === 200 && count($classicEntries) === 3,
    'HTTP ' . $code . ' nb=' . count($classicEntries));
expect('classic elementary_upper ordonné (alpha, gamma, beta)',
    array_column($classicEntries, 'display_name') === ['lb_alpha', 'lb_gamma', 'lb_beta'],
    implode(',', array_column($classicEntries, 'display_name')));

// ---- 9. Compte désactivé exclu (des deux classements) ----
$classicNames = array_column((is_array($classicJ['data']['entries'] ?? null) ? $classicJ['data']['entries'] : []), 'display_name');
expect('compte désactivé (lb_inactive) absent du classement classic', !in_array('lb_inactive', $classicNames, true), '');
expect('compte désactivé (lb_inactive) absent du classement hole', !in_array('lb_inactive', array_column($holeEntries, 'display_name'), true), '');
// Et vérifie explicitement que lb_inactive (10/10/1000) n'apparaît nulle part malgré son score.
[$code, $lbCheck] = get_call("{$base}?action=leaderboard&mode=multiplication&school_level=elementary_upper&question_type=classic", $jarLbAnon);
$checkJ = json_decode($lbCheck, true);
$checkNames = array_column((is_array($checkJ['data']['entries'] ?? null) ? $checkJ['data']['entries'] : []), 'display_name');
expect('classement elementary_upper sans le compte désactivé', !in_array('lb_inactive', $checkNames, true), '');

// ---- 10. Non-régression HTTP ----
[$code] = get_call("{$base}?action=health", $jarLbAnon);
expect('non-régression HTTP : health toujours 200', $code === 200, "HTTP {$code}");


echo "\n=== Résumé HTTP ===\n";
echo "Tests réussis : {$passed}\n";
echo "Tests échoués : {$failed}\n";
exit($failed === 0 ? 0 : 1);
