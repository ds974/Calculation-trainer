// js_normalization_test.js — Test de non-régression ciblant la normalisation
// des dates ISO UTC côté client (public/guest-history.js).
//
// Ce test ne dépend d'AUCUN outil Node : il s'exécute via JavaScript for
// Automation (JXA) :
//     osascript -l JavaScript tests/js_normalization_test.js
//
// Il charge le fichier réel public/guest-history.js (ce qui valide au passage
// sa syntaxe), puis vérifie que la fonction commune toUtcSecondsIso() respecte
// le contrat backend strict YYYY-MM-DDTHH:mm:ssZ (sans millisecondes), et que
// record() / importToAccount() l'utilisent bien. Un code de sortie non nul est
// renvoyé dès qu'une vérification échoue.

ObjC.import("Foundation");

var STRICT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

var results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || "" });
}

var guestHistoryPath =
  "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/guest-history.js";
var err = Ref();
var readObj = $.NSString.stringWithContentsOfFileEncodingError(
  guestHistoryPath, $.NSUTF8StringEncoding, err
);
var source = readObj.js;

if (!source || source.length === 0) {
  check("lecture du fichier guest-history.js", false, "contenu vide ? " + (err ? err : ""));
} else {
  // ---- Chargement du module réel (valide au passage la syntaxe JS) ----
  var window = {};        // reçoit window.MissionGuestHistory
  var localStorage = {    // stub mémoire minimal (utilisé par les fonctions)
    _m: {},
    getItem: function (k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
    setItem: function (k, v) { this._m[k] = String(v); },
    removeItem: function (k) { delete this._m[k]; }
  };
  var moduleLoadError = null;
  try {
    globalThis.eval(source);
  } catch (e) {
    moduleLoadError = "ERREUR : " + e;
  }
  check("syntaxe JS valide (chargement du module sans erreur)", moduleLoadError === null, moduleLoadError || "");

  var Module = window.MissionGuestHistory;
  check("module exposé sur window.MissionGuestHistory", !!Module, "");

  if (Module && moduleLoadError === null) {
    var fn = Module.toUtcSecondsIso;
    check("toUtcSecondsIso() exposé par le module", typeof fn === "function", "");

    // --- 1. Un horodatage issu de new Date().toISOString() (avec millisecondes) ---
    var rawMs = new Date("2026-01-01T08:00:00.123Z").toISOString();
    var normMs = fn(rawMs);
    check(
      "new Date().toISOString() (avec .123Z) normalisé sans millisecondes",
      normMs === "2026-01-01T08:00:00Z",
      rawMs + " -> " + normMs
    );

    // --- 2. Un horodatage déjà strict reste inchangé ---
    var strictIn = "2026-01-05T12:00:00Z";
    check(
      "horodatage déjà strict conservé tel quel",
      fn(strictIn) === strictIn,
      fn(strictIn)
    );

    // --- 3. Absence de valeur => repli sur "maintenant" au format strict ---
    var fallbackNow = fn();
    check(
      "passe vide => repli sur maintenant au format strict (sans ms)",
      STRICT_RE.test(fallbackNow) && fallbackNow.indexOf(".") === -1,
      fallbackNow
    );

    // --- 4. Valeur invalide => repli sûr au format strict ---
    var fallbackBad = fn("pas-une-date");
    check(
      "passe invalide => repli sûr au format strict (sans ms)",
      STRICT_RE.test(fallbackBad) && fallbackBad.indexOf(".") === -1,
      fallbackBad
    );

    // --- 5. La sortie rejette toujours les millisecondes (contrat backend) ---
    var case5ok = true;
    ["2026-01-01T08:00:00.123Z", "2026-01-01T08:00:00Z", "2026-02-28T23:59:59.999Z"]
      .forEach(function (v) {
        var out = fn(v);
        if (!STRICT_RE.test(out) || /\.\d{3}Z$/.test(out)) { case5ok = false; }
      });
    check("la sortie respecte toujours ^YYYY-MM-DDTHH:mm:ssZ$ (sans fraction)", case5ok, "");

    // --- Les pivots du correctif utilisent bien la fonction commune ---
    check(
      "record() utilise toUtcSecondsIso pour played_at",
      /playedAt\s*=\s*toUtcSecondsIso/.test(source),
      ""
    );
    check(
      "importToAccount() utilise toUtcSecondsIso pour played_at",
      /played_at\s*:\s*toUtcSecondsIso/.test(source),
      ""
    );
  }
}

// ---- Bilan ----
var passed = 0, failed = 0;
results.forEach(function (r) {
  if (r.ok) { passed++; } else { failed++; }
});
var lines = ["JS non-régression : " + passed + " réussis, " + failed + " échoués"];
results.forEach(function (r) {
  lines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.detail ? " — " + r.detail : ""));
});
var summary = lines.join("\n");
if (failed === 0) {
  summary += "\nRESULT:PASS";
} else {
  summary += "\nRESULT:FAIL";
  // force un code de sortie non nul côté osascript
  ObjC.import("Foundation");
  $.NSFileHandle.fileHandleWithStandardError().writeData(
    $.NSString.alloc.initWithString(summary).dataUsingEncoding($.NSUTF8StringEncoding)
  );
}
summary;
