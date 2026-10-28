// js_correction_test.js — Test de non-régression du RETOUR PÉDAGOGIQUE v12.3 :
// affichage de la bonne réponse DANS l'équation lors d'une réponse incorrecte
// ou d'un temps écoulé, et pause de correction de 4 secondes.
//
// Même approche que js_normalization_test.js : aucun outil Node requis,
// exécution via JavaScript for Automation (JXA) :
//     osascript -l JavaScript tests/js_correction_test.js
//
// Il charge le fichier réel public/app.js (ce qui valide au passage sa syntaxe),
// puis vérifie fonctionnellement les aides PURES du moteur de jeu
// (questionCorrectionHTML / questionDisplay / questionAnswer / computeAnswer)
// et, par assertions sur le source, les invariants de timing, de verrouillage
// de la saisie et d'absence de double affichage.

ObjC.import("Foundation");

var results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || "" });
}

// ---- Stubs minimaux pour charger app.js sans déclencher `init` (DOM minimal).
// Les noms doivent être EXACTEMENT document / localStorage / window : app.js (et
// son évaluation en scope global) référence ces identifiants non-qualifiés.
function makeElStub() {
  return {
    textContent: "", innerHTML: "", className: "", value: "", disabled: false,
    style: {}, dataset: {},
    classList: { add: function() {}, remove: function() {}, toggle: function() {} },
    addEventListener: function() {}, focus: function() {}, closest: function() { return null; },
    setAttribute: function() {}, appendChild: function() {}, hidden: false
  };
}
var window = {};
var document = {
  addEventListener: function() {},                 // "DOMContentLoaded" jamais déclenché
  getElementById: function() { return makeElStub(); },
  querySelectorAll: function() { return []; },
  querySelector: function() { return null; },
  createElement: function() { return makeElStub(); }
};
var localStorage = {
  _m: {},
  getItem: function(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
  setItem: function(k, v) { this._m[k] = String(v); },
  removeItem: function(k) { delete this._m[k]; }
};

var appPath = "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/app.js";
var err = Ref();
var readObj = $.NSString.stringWithContentsOfFileEncodingError(
  appPath, $.NSUTF8StringEncoding, err
);
var source = readObj.js;

if (!source || source.length === 0) {
  check("lecture du fichier app.js", false, "contenu vide ? " + (err ? err : ""));
} else {
  // Injecte un point d'accès aux aides pures et à la constante de durée DANS le
  // scope d'évaluation (sans toucher au fichier produit) : les déclarations
  // « function »/« const » de app.js ne sont pas exposées sur l'objet global.
  source = source +
    "\n;globalThis.__ct = { correction: questionCorrectionHTML, display: questionDisplay," +
    " answer: questionAnswer, compute: computeAnswer, ms: QUESTION_CORRECTION_MS };";
  var moduleLoadError = null;
  try {
    globalThis.eval(source);
  } catch (e) {
    moduleLoadError = "ERREUR : " + e;
  }
  check("syntaxe JS valide (chargement de app.js sans erreur)", moduleLoadError === null, moduleLoadError || "");
  if (moduleLoadError === null) {
    var fu = {
      correction: globalThis.__ct && globalThis.__ct.correction,
      display:    globalThis.__ct && globalThis.__ct.display,
      answer:     globalThis.__ct && globalThis.__ct.answer,
      compute:    globalThis.__ct && globalThis.__ct.compute,
      ms:         globalThis.__ct && globalThis.__ct.ms
    };
    check(
      "les aides pures du moteur sont exposées",
      typeof fu.correction === "function" && typeof fu.display === "function" &&
        typeof fu.answer === "function" && typeof fu.compute === "function" &&
        fu.ms === 4000,
      "ms=" + fu.ms
    );

    if (fu.correction && fu.display && fu.answer) {
      var REVEAL = function (v) {
        return '<span class="answer-reveal" aria-label="réponse : ' + v + '">' + v + '</span>';
      };

      // --- 1. Correction Classique (multiplication) : 18 remplace le « ? » final ---
      var c1 = { a: 3, b: 6, mode: "mult" };
      check(
        "Classique (3 × 6 = ?) : la bonne réponse est révélée à la place du « ? »",
        fu.correction(c1) === "3 × 6 = " + REVEAL(18),
        fu.correction(c1)
      );
      check(
        "Classique : la question affichée contient bien un « ? » (avant correction)",
        fu.display(c1) === "3 × 6 = ?",
        fu.display(c1)
      );

      // --- 2. À trou sur le 1er opérande ---
      var hA = { a: 3, b: 6, mode: "mult", hole: "a" };
      check(
        "À trou (a) (? × 6 = 18) : le 1er opérande est révélé à la place du « ? »",
        fu.correction(hA) === REVEAL(3) + " × 6 = 18",
        fu.correction(hA)
      );

      // --- 3. À trou sur le 2e opérande ---
      var hB = { a: 7, b: 8, mode: "mult", hole: "b" };
      check(
        "À trou (b) (7 × ? = 56) : le 2e opérande est révélé à la place du « ? »",
        fu.correction(hB) === "7 × " + REVEAL(8) + " = 56",
        fu.correction(hB)
      );

      // --- 4. Mélange : une question « à trou » issue d'une mission mélangée ---
      var mixedQ = { a: 4, b: 5, mode: "mult", hole: "a" };
      check(
        "Mélange : une question à trou est corrigée comme telle (? × 5 = 20)",
        fu.correction(mixedQ) === REVEAL(4) + " × 5 = 20",
        fu.correction(mixedQ)
      );
      var mixedClassic = { a: 2, b: 9, mode: "mult" };
      check(
        "Mélange : une question classique reste corrigée en révélant le résultat",
        fu.correction(mixedClassic) === "2 × 9 = " + REVEAL(18),
        fu.correction(mixedClassic)
      );
      check(
        "Mélange : le source répartit trous aléatoires ET questions classiques",
        /questionType\s*===\s*["']mixed["']/.test(source) &&
          /hole\s*=\s*Math\.random\s*\(\)\s*<\s*0\.5/.test(source),
        ""
      );

      // --- 5. Addition (classique + à trou) ---
      var addClassic = { a: 12, b: 30, mode: "add" };
      check(
        "Addition classique (12 + 30 = ?) : 42 révélé à la place du « ? »",
        fu.correction(addClassic) === "12 + 30 = " + REVEAL(42),
        fu.correction(addClassic)
      );
      var addHole = { a: 9, b: 15, mode: "add", hole: "b" };
      check(
        "Addition à trou (9 + ? = 24) : 15 révélé à la place du « ? »",
        fu.correction(addHole) === "9 + " + REVEAL(15) + " = 24",
        fu.correction(addHole)
      );

      // --- 7. Absence de double affichage de la bonne réponse ---
      var doubleDispOk = true;
      var samples = [c1, hA, hB, mixedQ, addClassic, addHole];
      samples.forEach(function (q) {
        var html = fu.correction(q);
        // On retire le span « answer-reveal » : la bonne réponse ne doit plus
        // apparaître nulle part ailleurs dans l'équation.
        var stripped = html.replace(
          new RegExp('<span class="answer-reveal"[^>]*>[^<]*</span>', "g"), ""
        );
        if (stripped.indexOf(String(fu.answer(q))) !== -1) { doubleDispOk = false; }
      });
      check(
        "pas de double affichage : la bonne réponse n'apparaît pas en dehors du révélé",
        doubleDispOk,
        ""
      );
      var feedbackShort =
        /feedback\.textContent\s*=\s*timedOut\s*\?\s*["']Temps écoulé["']\s*:\s*["']Réponse incorrecte["']/.test(source);
      check(
        "le feedback de correction n'affiche qu'un message court (sans répéter la réponse)",
        feedbackShort && source.indexOf("→ ${expectedAnswer}") === -1,
        ""
      );

      // --- 6. Durée de correction : 4 secondes après erreur / temps écoulé ---
      var hasConst = /QUESTION_CORRECTION_MS\s*=\s*4000/.test(source);
      var usesOnError =
        /const\s+delay\s*=\s*isCorrect\s*\?\s*700\s*:\s*QUESTION_CORRECTION_MS/.test(source);
      check(
        "durée de correction fixée à 4000 ms (QUESTION_CORRECTION_MS)",
        hasConst && usesOnError && fu.ms === 4000,
        "ms=" + fu.ms
      );
      check(
        "transition inchangée (700 ms) après une bonne réponse",
        usesOnError,
        ""
      );

      // --- 8. Non-régression : notation et bonne réponse par question inchangées ---
      check("questionAnswer (classique) = résultat de l'opération", fu.answer(c1) === 18, "");
      check("questionAnswer (trou a) = 1er opérande", fu.answer(hA) === 3, "");
      check("questionAnswer (trou b) = 2e opérande", fu.answer(hB) === 8, "");
      check("computeAnswer addition = somme", fu.compute({ a: 12, b: 30, mode: "add" }) === 42, "");
      check("computeAnswer multiplication = produit", fu.compute({ a: 3, b: 6, mode: "mult" }) === 18, "");

      // --- 9. Verrouillage : aucune saisie pendant la correction ---
      var lockOk =
        /state\.questionLocked\s*=\s*true/.test(source) &&
        /answer\.disabled\s*=\s*true/.test(source) &&
        /clearQuestionTimers\(\)/.test(source) &&
        /if\s*\(\s*state\.questionLocked\s*\)\s*return/.test(source);
      check(
        "saisie verrouillée pendant la correction (questionLocked + input.disabled + timer stoppé)",
        lockOk,
        ""
      );
    }
  }
}

// ---- Bilan ----
var passed = 0, failed = 0;
results.forEach(function (r) { if (r.ok) { passed++; } else { failed++; } });
var lines = ["JS correction (v12.3) : " + passed + " réussis, " + failed + " échoués"];
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

