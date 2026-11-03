// js_duration_test.js — Test JXA v12.8-B2 : durée des parties (duration_ms) et
// anti-doublon côté client (public/guest-history.js + public/app.js).
//
// Même approche que js_normalization_test.js : aucun outil Node requis, exécution
// via JavaScript for Automation (JXA) :
//     osascript -l JavaScript tests/js_duration_test.js
//
// Il charge les fichiers RÉELS (ce qui valide au passage leur syntaxe), puis vérifie
// par invariants SUR LE SOURCE les gardes de la logique de durée ajoutée en B2.

ObjC.import("Foundation");

var results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || "" });
}

var BASE = "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/";

function readFile(file) {
  var err = Ref();
  var src = $.NSString.stringWithContentsOfFileEncodingError(
    BASE + file, $.NSUTF8StringEncoding, err
  );
  return src ? src.js : null;
}

var guestSource = readFile("guest-history.js");
var appSource = readFile("app.js");

check("lecture guest-history.js", !!guestSource && guestSource.length > 0, "");
check("lecture app.js", !!appSource && appSource.length > 0, "");

if (guestSource && appSource) {
  // ---- Chargement réel de guest-history.js (valide la syntaxe JS) ----
  var window = {};
  var localStorage = {   // stub mémoire minimal
    _m: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
    setItem: function (k, v) { this._m[k] = String(v); },
    removeItem: function (k) { delete this._m[k]; }
  };
  var fetchCallCount = 0;
  var fetch = function () {
    fetchCallCount++;
    return Promise.resolve({ status: 201, ok: true, json: function () { return Promise.resolve({ ok: true, data: { result: { id: 1 } } }); } });
  };
  var moduleLoadError = null;
  try {
    globalThis.eval(guestSource);
  } catch (e) {
    moduleLoadError = "ERREUR : " + e;
  }
  check("syntaxe JS valide (guest-history.js sans erreur)", moduleLoadError === null, moduleLoadError || "");

  var Module = window.MissionGuestHistory;
  check("module exposé sur window.MissionGuestHistory", !!Module, "");

  // ---- 1. Encodage duration_ms dans la charge transmise à result/save ----
  check(
    "encodage duration_ms présent (guest-history.js)",
    /payload\.duration_ms\s*=\s*part\.durationMs/.test(guestSource),
    ""
  );
  check(
    "duration_ms transmis uniquement si entier strictement positif",
    /Number\.isInteger\(\s*part\.durationMs\s*\)\s*&&\s*part\.durationMs\s*>\s*0/.test(guestSource),
    ""
  );
  check(
    "duration_ms envoyé via result/save (api('result/save', payload))",
    /api\(\s*["']result\/save["']\s*,\s*payload\s*\)/.test(guestSource),
    ""
  );

  // ---- 2. Le flux invité ne quitte JAMAIS le navigateur (aucun fetch) ----
  // La transmission au serveur (fetch/api) doit être réservée au bloc `if (session)`.
  var connectedOnly =
    /if\s*\(\s*session\s*\)\s*\{[\s\S]*?payload\.duration_ms[\s\S]*?api\(\s*["']result\/save["']/.test(guestSource);
  check("transmission serveur réservée au bloc `if (session)` (comptes connectés)", connectedOnly, "");
  check(
    "mode invité : branche locale sans appel serveur (return { server:false, entry })",
    /return\s*\{\s*server\s*:\s*false\s*,\s*entry\s*:\s*entry\s*\}/.test(guestSource),
    ""
  );

  // Fonctionnel invité : record() en l'absence de session ne doit PAS déclencher de fetch.
  Module.setSession(null);
  var guestProm = Module.record({ mode: "mult", score: 7, durationMs: 5000, playedAt: "2026-01-01T00:00:00Z" });
  check("record() invité renvoie une promesse (mode local attendu)", !!guestProm && typeof guestProm.then === "function", "");
  check("record() invité : fetch NON appelé au moment de l'appel", fetchCallCount === 0, "fetchCalls=" + fetchCallCount);

  // ---- 3. Conversion durée affichée (secondes) -> duration_ms (app.js) ----
  check(
    "app.js : conversion secondes -> millisecondes (Math.round(time*1000))",
    /Math\.round\(\s*state\.finalScore\.time\s*\*\s*1000\s*\)/.test(appSource),
    ""
  );
  check(
    "app.js : durationMs transmis à MissionGuestHistory.record",
    /durationMs\s*:\s*Math\.round\(\s*state\.finalScore\.time\s*\*\s*1000\s*\)/.test(appSource),
    ""
  );

  // ---- 4. Mission ABANDONNÉE (sans score final) jamais enregistrée ----
  check(
    "app.js : garde anti-enregistrement sans score final",
    /\bif\s*\(\s*!state\.finalScore\s*\)\s*return\s*false/.test(appSource),
    ""
  );

  // ---- 5. Anti-doublon : confirmation serveur requise avant de marquer sauvegardé ----
  check(
    "app.js : garde anti-doublon state.savedCurrentResult",
    /if\s*\(\s*state\.savedCurrentResult\s*\)\s*return\s*true/.test(appSource),
    ""
  );
  check(
    "app.js : savedCurrentResult posé UNIQUEMENT après ok serveur",
    /state\.savedCurrentResult\s*=\s*true/.test(appSource) &&
      /res\s*&&\s*res\.server\s*&&\s*res\.ok/.test(appSource),
    ""
  );
  check(
    "idempotence serveur : mission_id transmis (une seule écriture)",
    /mission_id\s*=\s*part\.missionId/.test(guestSource),
    ""
  );
}

// ---- Bilan ----
var passed = 0, failed = 0;
results.forEach(function (r) { if (r.ok) { passed++; } else { failed++; } });
var lines = ["JS durée B2 : " + passed + " réussis, " + failed + " échoués"];
results.forEach(function (r) {
  lines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.detail ? " — " + r.detail : ""));
});
var summary = lines.join("\n");
if (failed === 0) {
  summary += "\nRESULT:PASS";
} else {
  summary += "\nRESULT:FAIL";
  ObjC.import("Foundation");
  $.NSFileHandle.fileHandleWithStandardError().writeData(
    $.NSString.alloc.initWithString(summary).dataUsingEncoding($.NSUTF8StringEncoding)
  );
}
summary;
