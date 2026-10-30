<?php

declare(strict_types=1);

/**
 * difficulty_melange_repro.php — Reproduction AUTOMATISÉE du suivi des
 * difficultés en mode Mélange (v12.5).
 *
 * Utilise UNIQUEMENT une base SQLite temporaire (jamais la base réelle).
 *
 * Scénario principal (objet du diagnostic) :
 *   - deux difficultés INDÉPENDANTES pour 6 × 8 : classic = 2, hole = 2 ;
 *   - deux missions distinctes de type global 'mixed', chacune contenant UNE
 *     bonne réponse classique à 6 × 8 ;
 *   - attendu : classic 2 → 1 ; hole inchangé (2) ; contribution à la table 8
 *     classique 1 → 0,5.
 *
 * Et aussi les cas compagnons demandés : deux réussites à trou, une seule
 * réussite, une erreur (+1 et série remise à zéro), une expiration (comme une
 * erreur), deux missions accumulées, même mission renvoyée deux fois (aucune
 * double mise à jour), modes classiques et à trou seuls.
 */

error_reporting(E_ALL);
ini_set('display_errors', '1');

$root = dirname(__DIR__);
require $root . '/src/bootstrap.php';

$tmpRoot = sys_get_temp_dir() . '/calc_repro_melange_' . getmypid();
@mkdir($tmpRoot, 0775, true);

$db = new Database($tmpRoot);
$pdo = $db->pdo();
$users = new UserRepository($pdo);
$repo = new OperationDifficultyRepository($pdo);
$svc = new OperationDifficultyService($pdo, $repo);
$results = new ResultService($pdo, new ResultRepository($pdo), $svc);

$pass = 0;
$fail = 0;
$failures = [];
function check(string $name, bool $ok, string $detail = ''): void {
    global $pass, $fail, $failures;
    if ($ok) { $pass++; }
    else { $fail++; $failures[] = $name . ($detail !== '' ? ' — ' . $detail : ''); }
    echo ($ok ? "  \u{2713} " : "  \u{2717} ") . $name . ($detail !== '' ? ' — ' . $detail : '') . "\n";
}

function freshUser(UserRepository $users): int {
    return $users->create([
        'login' => 'repro_' . substr(uniqid(), -6),
        'password' => 'motdepasse10',
        'role' => 'user',
    ]);
}

// Amène une opération à la difficulté cible via N erreurs (barème : +1 par erreur).
function seedTo(OperationDifficultyService $svc, OperationDifficultyRepository $repo, int $uid,
                string $mode, string $qt, int $a, int $b, int $targetDiff): void {
    while (true) {
        $r = $repo->find($uid, $mode, $qt, $a, $b);
        $cur = $r ? (int)$r['difficulty'] : 0;
        if ($cur >= $targetDiff) break;
        $svc->applyBarème($uid, $mode, $qt, $a, $b, false);
    }
}

// Construit une liste de détails représentant UNE mission à UNE réponse.
function detailsFor(int $a, int $b, string $qt, bool $correct, ?string $hole = null, ?int $answer = null, bool $timeout = false): array {
    if ($qt === 'classic') {
        $hole = null;
        $answer = $answer ?? ($a * $b);
    } else {
        $hole = $hole ?? 'a';
        $answer = $answer ?? ($hole === 'a' ? $a : $b);
    }
    return [[
        'mode' => 'multiplication',
        'question_type' => $qt,
        'a' => $a,
        'b' => $b,
        'hole' => $hole,
        'user_answer' => $timeout ? null : $answer,
    ]];
}

// ---------------------------------------------------------------------------
// SCÉNARIO PRINCIPAL : deux réussites classiques en missions mixed.
// ---------------------------------------------------------------------------
echo "\n=== Scénario principal : 2 réussites CLASSIQUES (mixed) ===\n";
$uid1 = freshUser($users);
seedTo($svc, $repo, $uid1, 'multiplication', 'classic', 6, 8, 2);
seedTo($svc, $repo, $uid1, 'multiplication', 'hole', 6, 8, 2);
$c0 = (int)$repo->find($uid1, 'multiplication', 'classic', 6, 8)['difficulty'];
$h0 = (int)$repo->find($uid1, 'multiplication', 'hole', 6, 8)['difficulty'];
check('point de départ : classic 6×8 = 2', $c0 === 2, "got=$c0");
check('point de départ : hole 6×8 = 2', $h0 === 2, "got=$h0");

// Deux missions distinctes, type global 'mixed', chacune 1 réussite classique 6×8.
$detailsC = detailsFor(6, 8, 'classic', true);
$results->saveWithMission($uid1, 'multiplication', 1, 'REPRO-C-1', $detailsC, '2026-03-01T08:00:00Z', 'mixed');
$results->saveWithMission($uid1, 'multiplication', 1, 'REPRO-C-2', $detailsC, '2026-03-02T08:00:00Z', 'mixed');

$c = (int)$repo->find($uid1, 'multiplication', 'classic', 6, 8)['difficulty'];
$h = (int)$repo->find($uid1, 'multiplication', 'hole', 6, 8)['difficulty'];
check('2 réussites classiques => classic 2 → 1', $c === 1, "got=$c");
check('à trou inchangé (hole reste 2)', $h === 2, "got=$h");

// Bilan pondéré : contribution de 6×8 à la table 8 classique.
$summary = $svc->tableSummary($uid1);
$t8c = null;
foreach ($summary['multiplication']['classic'] as $row) {
    if ((int)$row['table'] === 8) { $t8c = $row; break; }
}
check('contribution à la table 8 classique = 0,5 (difficulty 1 × 0,5)',
    $t8c !== null && abs((float)$t8c['difficulty'] - 0.5) < 0.001,
    $t8c ? 'difficulty=' . (float)$t8c['difficulty'] : 'table 8 absente');

// ---------------------------------------------------------------------------
echo "\n=== Deux réussites À TROU (mixed) ===\n";
$uid2 = freshUser($users);
seedTo($svc, $repo, $uid2, 'multiplication', 'classic', 6, 8, 2);
seedTo($svc, $repo, $uid2, 'multiplication', 'hole', 6, 8, 2);
$detailsH = detailsFor(6, 8, 'hole', true, 'a', 6);
$results->saveWithMission($uid2, 'multiplication', 1, 'REPRO-H-1', $detailsH, '2026-03-03T08:00:00Z', 'mixed');
$detailsH2 = detailsFor(6, 8, 'hole', true, 'b', 8);
$results->saveWithMission($uid2, 'multiplication', 1, 'REPRO-H-2', $detailsH2, '2026-03-04T08:00:00Z', 'mixed');
$hc2 = (int)$repo->find($uid2, 'multiplication', 'hole', 6, 8)['difficulty'];
$cc2 = (int)$repo->find($uid2, 'multiplication', 'classic', 6, 8)['difficulty'];
check('2 réussites à trou (positions a ET b regroupées) => hole 2 → 1', $hc2 === 1, "got=$hc2");
check('classique inchangé (reste 2)', $cc2 === 2, "got=$cc2");
$streak2 = (int)$repo->find($uid2, 'multiplication', 'hole', 6, 8)['success_streak'];
check('les deux positions du trou alimentent une seule série de 2', $streak2 === 2, "streak=$streak2");

// ---------------------------------------------------------------------------
echo "\n=== Une seule réussite : pas encore de diminution ===\n";
$uid3 = freshUser($users);
seedTo($svc, $repo, $uid3, 'multiplication', 'classic', 6, 8, 2);
$results->saveWithMission($uid3, 'multiplication', 1, 'REPRO-S-1', detailsFor(6, 8, 'classic', true), '2026-03-05T08:00:00Z', 'mixed');
$s1 = (int)$repo->find($uid3, 'multiplication', 'classic', 6, 8)['difficulty'];
check('1 réussite => classic reste 2 (barème : −1 après 2 réussites consécutives)', $s1 === 2, "got=$s1");

// ---------------------------------------------------------------------------
echo "\n=== Erreur : +1 et série remise à zéro ===\n";
$uid4 = freshUser($users);
seedTo($svc, $repo, $uid4, 'multiplication', 'classic', 6, 8, 2);
// une réussite puis une erreur => la série est remise à 0, pas de -1.
$results->saveWithMission($uid4, 'multiplication', 0, 'REPRO-E-1', detailsFor(6, 8, 'classic', true), '2026-03-06T08:00:00Z', 'mixed');
$results->saveWithMission($uid4, 'multiplication', 0, 'REPRO-E-2', detailsFor(6, 8, 'classic', false, null, 99), '2026-03-07T08:00:00Z', 'mixed');
$e = (int)$repo->find($uid4, 'multiplication', 'classic', 6, 8)['difficulty'];
$estrek = (int)$repo->find($uid4, 'multiplication', 'classic', 6, 8)['success_streak'];
check('réussite puis erreur : pas de -1 de la réussite ; l’erreur ajoute +1 (2 → 3)', $e === 3, "got=$e");
check('une erreur remet la série de réussites à zéro', $estrek === 0, "streak=$estrek");
seedTo($svc, $repo, $uid4, 'multiplication', 'classic', 6, 8, 4);
$e2 = (int)$repo->find($uid4, 'multiplication', 'classic', 6, 8)['difficulty'];
check('deux erreurs successives => difficulté 2 → 4 (+1 chacune)', $e2 === 4, "got=$e2");

// ---------------------------------------------------------------------------
echo "\n=== Expiration (réponse absente) traitée comme une erreur ===\n";
$uid5 = freshUser($users);
seedTo($svc, $repo, $uid5, 'multiplication', 'classic', 6, 8, 2);
$results->saveWithMission($uid5, 'multiplication', 0, 'REPRO-T-1',
    detailsFor(6, 8, 'classic', true, null, null, true), '2026-03-08T08:00:00Z', 'mixed');
$t = (int)$repo->find($uid5, 'multiplication', 'classic', 6, 8)['difficulty'];
$tstreak = (int)$repo->find($uid5, 'multiplication', 'classic', 6, 8)['success_streak'];
check('expiration traitée comme une erreur : +1 (diff 2 → 3)', $t === 3, "got=$t");
check('expiration remet la série de réussites à zéro', $tstreak === 0, "streak=$tstreak");


// ---------------------------------------------------------------------------
echo "\n=== Deux missions distinctes : les réussites se cumulent ===\n";
$uid6 = freshUser($users);
seedTo($svc, $repo, $uid6, 'multiplication', 'classic', 6, 8, 2);
$baseAccAttempts = (int)$repo->find($uid6, 'multiplication', 'classic', 6, 8)['attempts'];
// Deux missions distinctes, chacune avec UNE réussite classique 6×8.
$results->saveWithMission($uid6, 'multiplication', 1, 'REPRO-ACC-1', detailsFor(6, 8, 'classic', true), '2026-03-09T08:00:00Z', 'classic');
$results->saveWithMission($uid6, 'multiplication', 1, 'REPRO-ACC-2', detailsFor(6, 8, 'classic', true), '2026-03-10T08:00:00Z', 'classic');
$acc = (int)$repo->find($uid6, 'multiplication', 'classic', 6, 8)['difficulty'];
$accAttempts = (int)$repo->find($uid6, 'multiplication', 'classic', 6, 8)['attempts'];
check('2 missions distinctes (1 réussite chacune) => classic 2 → 1 (cumul)', $acc === 1, "got=$acc");
check('les 2 missions ajoutent chacune 1 tentative (attempts = base + 2)', $accAttempts === $baseAccAttempts + 2, "attempts=$accAttempts base=$baseAccAttempts");

// ---------------------------------------------------------------------------
echo "\n=== Idempotence : même mission renvoyée deux fois ===\n";
$uid7 = freshUser($users);
seedTo($svc, $repo, $uid7, 'multiplication', 'classic', 6, 8, 2);
$out1 = $results->saveWithMission($uid7, 'multiplication', 1, 'REPRO-DUP', detailsFor(6, 8, 'classic', true), '2026-03-11T08:00:00Z', 'mixed');
$attAfterFirst = (int)$repo->find($uid7, 'multiplication', 'classic', 6, 8)['attempts'];
$out2 = $results->saveWithMission($uid7, 'multiplication', 1, 'REPRO-DUP', detailsFor(6, 8, 'classic', true), '2026-03-11T08:00:00Z', 'mixed');
$attAfterDup = (int)$repo->find($uid7, 'multiplication', 'classic', 6, 8)['attempts'];
$dup = (int)$repo->find($uid7, 'multiplication', 'classic', 6, 8)['difficulty'];
check('1er envoi enregistré (saved)', $out1['saved'] === true && $out1['duplicate'] === false, '');
check('même mission_id renvoyé => doublon détecté, aucune écriture', $out2['duplicate'] === true, '');
check('pas de double mise à jour (attempts inchangé après le doublon)', $attAfterDup === $attAfterFirst, "afterFirst=$attAfterFirst afterDup=$attAfterDup");
check('série non doublée (1 seule réussite => classic reste 2)', $dup === 2, "got=$dup");

// ---------------------------------------------------------------------------
echo "\n=== Modes seuls : classic et hole (comportement inchangé) ===\n";
// Mode classique seul : 2 réussites => 2 → 1.
$uid8 = freshUser($users);
seedTo($svc, $repo, $uid8, 'multiplication', 'classic', 6, 8, 2);
$results->saveWithMission($uid8, 'multiplication', 1, 'REPRO-OC-1', detailsFor(6, 8, 'classic', true), '2026-03-12T08:00:00Z', 'classic');
$results->saveWithMission($uid8, 'multiplication', 1, 'REPRO-OC-2', detailsFor(6, 8, 'classic', true), '2026-03-13T08:00:00Z', 'classic');
$oc = (int)$repo->find($uid8, 'multiplication', 'classic', 6, 8)['difficulty'];
check('mode classic seul : 2 réussites => classic 2 → 1', $oc === 1, "got=$oc");

// Mode à trou seul : 2 réussites => hole 2 → 1.
$uid9 = freshUser($users);
seedTo($svc, $repo, $uid9, 'multiplication', 'hole', 6, 8, 2);
$results->saveWithMission($uid9, 'multiplication', 1, 'REPRO-OH-1', detailsFor(6, 8, 'hole', true, 'a', 6), '2026-03-14T08:00:00Z', 'hole');
$results->saveWithMission($uid9, 'multiplication', 1, 'REPRO-OH-2', detailsFor(6, 8, 'hole', true, 'b', 8), '2026-03-15T08:00:00Z', 'hole');
$oh = (int)$repo->find($uid9, 'multiplication', 'hole', 6, 8)['difficulty'];
check('mode hole seul : 2 réussites => hole 2 → 1', $oh === 1, "got=$oh");

// ---------------------------------------------------------------------------
// Nettoyage de la base temporaire.
$db = null;
@array_map('unlink', glob($tmpRoot . '/*'));
@rmdir($tmpRoot);

// ---------------------------------------------------------------------------
echo "\n=== Résumé ===\n";
echo "Vérifications réussies : {$pass}\n";
echo "Vérifications échouées : {$fail}\n";
if ($fail > 0) {
    echo "Échecs :\n";
    foreach ($failures as $f) { echo "  - {$f}\n"; }
    exit(1);
}
echo "REPRO:PASS\n";

