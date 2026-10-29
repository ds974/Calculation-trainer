// js_difficulty_ui_test.js — Test de la v12.4 (amélioration d'interface « Mes
// points à travailler ») :
//   1. le classement des tables par difficulté décroissante (critère principal),
//      puis par statut (À travailler → En progrès → À pratiquer → Surmontée),
//      puis par numéro de table croissant, s'applique séparément aux
//      « Calculs classiques » et aux « Calculs à trou » ;
//   2. la présentation des tentatives pondérées est lisible/honnête (plus de
//      « 1.0 tentative(s) » ni « 2.5 tentative(s) »).
//
// Même approche que js_normalization_test.js / js_correction_test.js : aucun
// outil Node requis, exécution via JavaScript for Automation (JXA) :
//     osascript -l JavaScript tests/js_difficulty_ui_test.js
//
// Il charge le fichier réel public/stats.js (ce qui valide au passage sa
// syntaxe), en injectant un point d'accès aux aides pures DANS le scope
// d'évaluation — les déclarations `function`/`const` d'un IIFE ne sont pas
// exposées sur l'objet global. Aucune modification du fichier produit.

ObjC.import("Foundation");

var results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || "" });
}

// ---- Stubs minimaux (DOM calqués sur les autres tests JXA) : l'évaluation de
// stats.js en scope global référence `document` / `window` (addEventListener de
// "DOMContentLoaded", getElementById, querySelectorAll, createElement).
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

var statsPath = "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/stats.js";
var err = Ref();
var readObj = $.NSString.stringWithContentsOfFileEncodingError(
  statsPath, $.NSUTF8StringEncoding, err
);
var source = readObj.js;

if (!source || source.length === 0) {
  check("lecture du fichier stats.js", false, "contenu vide ? " + (err ? err : ""));
} else {
  // Injecte un point d'accès aux aides pures DU IIFE (sans toucher au fichier
  // produit) : les déclarations « function »/« const » de stats.js vivent dans
  // la fermeture de StatsUI et ne sont pas exposées sur l'objet global. On
  // insère donc le hook juste AVANT la « return { } ; » de l'IIFE (le bloc
  // « show, hide, » est un repère unique), sinon une injection après le return
  // serait du code mort inaccessible.
  var anchor = "  return {\n    show,\n    hide,";
  if (source.indexOf(anchor) === -1) {
    check("point d'injection (return de l'IIFE) trouvé", false, "repère absent");
  } else {
    source = source.replace(
      anchor,
      "  globalThis.__ct = { sorted: sortedDifficultyList, attempts: attemptsLabel," +
        " diff: formatDiff, order: DIFF_STATUS_ORDER };\n" + anchor
    );
  }
  var moduleLoadError = null;
  try {
    globalThis.eval(source);
  } catch (e) {
    moduleLoadError = "ERREUR : " + e;
  }
  check("syntaxe JS valide (chargement de stats.js sans erreur)", moduleLoadError === null, moduleLoadError || "");

  if (moduleLoadError === null) {
    var fu = {
      sorted:   globalThis.__ct && globalThis.__ct.sorted,
      attempts: globalThis.__ct && globalThis.__ct.attempts,
      diff:     globalThis.__ct && globalThis.__ct.diff,
      order:    globalThis.__ct && globalThis.__ct.order
    };
    check(
      "les aides pures du bilan sont exposées",
      typeof fu.sorted === "function" && typeof fu.attempts === "function" &&
        typeof fu.diff === "function",
      ""
    );

    if (fu.sorted && typeof fu.sorted === "function") {
      // Liste volontairement désordonnée représentative des 4 statuts.
      var classic = [
        { table: 9,  status: "mastered",     difficulty: 0.0, attempts: 12.0 },
        { table: 3,  status: "to_work",      difficulty: 3.0, attempts: 8.5 },
        { table: 2,  status: "in_progress",  difficulty: 2.0, attempts: 9.0 },
        { table: 7,  status: "mastered",     difficulty: 0.0, attempts: 6.5 },
        { table: 6,  status: "to_work",      difficulty: 4.5, attempts: 13.5 },
        { table: 1,  status: "in_progress",  difficulty: 2.5, attempts: 7.0 },
        { table: 8,  status: "insufficient", difficulty: 1.5, attempts: 1.5 },
        { table: 4,  status: "to_work",      difficulty: 3.0, attempts: 6.0 },
      ];
      // À difficulté décroissante : 6 (4.5), puis diff 3.0 au statut à travailler
      // (tables 3 et 4 → numéro croissant 3 puis 4), puis En progrès 1 (2.5) et
      // 2 (2.0), puis À pratiquer 8 (1.5), enfin Surmontée à diff 0 (7 puis 9).
      var expectedClassicOrder = "6,3,4,1,2,8,7,9";
      var gotClassic = fu.sorted(classic).map(function (t) { return t.table; }).join(",");
      check(
        "classique : difficulté décroissante, puis statut, puis numéro croissant",
        gotClassic === expectedClassicOrder,
        gotClassic
      );

      // Le tri ne modifie PAS la liste d'origine (copie).
      check(
        "le tri agit sur une copie : la liste source est inchangée",
        classic[0].table === 9 && classic.length === 8,
        ""
      );

      // « Calculs à trou » : même classement indépendant.
      var hole = [
        { table: 5, status: "to_work",     difficulty: 2.0, attempts: 6.0 },
        { table: 2, status: "mastered",    difficulty: 0.0, attempts: 8.0 },
        { table: 9, status: "in_progress", difficulty: 1.5, attempts: 9.5 },
        { table: 4, status: "to_work",     difficulty: 3.0, attempts: 7.0 },
      ];
      var gotHole = fu.sorted(hole).map(function (t) { return t.table; }).join(",");
      check(
        "à trou : classement appliqué séparément (difficulté 4 puis 5, progrès 9, surmontée 2)",
        gotHole === "4,5,9,2",
        gotHole
      );

      // RÉGRESSION v12.4 : le coefficient de difficulté est le critère PRINCIPAL.
      // La table 8 (difficulté 1, À pratiquer) doit passer DEVANT les tables 2 et 7
      // (difficulté 0.5, En progrès) — alors que l'ancien tri par statut classait
      // « À pratiquer » après « En progrès ».
      var regression = fu.sorted([
        { table: 2, status: "in_progress",  difficulty: 0.5, attempts: 5 },
        { table: 7, status: "in_progress",  difficulty: 0.5, attempts: 5 },
        { table: 8, status: "insufficient", difficulty: 1.0, attempts: 5 },
      ]);
      check(
        "régression : difficulté croissante d'abord → 8, 2, 7",
        regression[0].table === 8 && regression[1].table === 2 && regression[2].table === 7,
        regression.map(function (t) { return t.table; }).join(",")
      );

      // Égalités de difficulté départagées par statut (À travailler avant
      // En progrès avant À pratiquer avant Surmontée) puis par numéro croissant.
      var tieStatus = fu.sorted([
        { table: 4, status: "in_progress",  difficulty: 2.0, attempts: 5 },
        { table: 2, status: "insufficient", difficulty: 2.0, attempts: 5 },
        { table: 1, status: "to_work",      difficulty: 2.0, attempts: 5 },
        { table: 3, status: "mastered",     difficulty: 2.0, attempts: 5 },
      ]);
      check(
        "difficulté égale : départagé par statut (travail 1, progrès 4, pratique 2, surmontée 3)",
        tieStatus.map(function (t) { return t.table; }).join(",") === "1,4,2,3",
        tieStatus.map(function (t) { return t.table; }).join(",")
      );

      // Égalités de difficulté ET de statut : départagées par numéro croissant.
      var tieNumber = fu.sorted([
        { table: 5, status: "in_progress", difficulty: 2.0, attempts: 5 },
        { table: 3, status: "in_progress", difficulty: 2.0, attempts: 5 },
        { table: 8, status: "in_progress", difficulty: 2.0, attempts: 5 },
      ]);
      check(
        "difficulté et statut égaux : numéro croissant (3,5,8)",
        tieNumber.map(function (t) { return t.table; }).join(",") === "3,5,8",
        tieNumber.map(function (t) { return t.table; }).join(",")
      );

      // Le tri ne modifie PAS la liste source (copie) sur le scénario de régression.
      var regressionSource = [
        { table: 8, status: "insufficient", difficulty: 1.0, attempts: 5 },
        { table: 2, status: "in_progress",  difficulty: 0.5, attempts: 5 },
        { table: 7, status: "in_progress",  difficulty: 0.5, attempts: 5 },
      ];
      fu.sorted(regressionSource);
      check(
        "régression : le tri agit sur une copie (source inchangée)",
        regressionSource[0].table === 8 && regressionSource[1].table === 2 &&
          regressionSource.length === 3,
        ""
      );

      // Difficulté décroissante au sein du même statut, vérifiée explicitement.
      var sameStatus = fu.sorted([
        { table: 2, status: "in_progress", difficulty: 1.0, attempts: 5 },
        { table: 1, status: "in_progress", difficulty: 4.0, attempts: 5 },
        { table: 3, status: "in_progress", difficulty: 1.0, attempts: 5 },
      ]);
      check(
        "même statut : difficulté décroissante puis numéro croissant (1,2,3)",
        sameStatus[0].table === 1 && sameStatus[1].table === 2 && sameStatus[2].table === 3,
        sameStatus.map(function (t) { return t.table; }).join(",")
      );

      // Ordre aligné sur le backend (VALEURS RÉELLES vérifiées dans
      // src/OperationDifficultyService.php).
      check(
        "statuts : À travailler → En progrès → À pratiquer → Surmontée",
        fu.order.to_work < fu.order.in_progress &&
          fu.order.in_progress < fu.order.insufficient &&
          fu.order.insufficient < fu.order.mastered &&
          fu.order.to_work === 0 && fu.order.mastered === 3,
        ""
      );
    }


    if (fu.attempts && typeof fu.attempts === "function") {
      check("0 tentative → « pas encore pratiquée »", fu.attempts(0) === "pas encore pratiquée", fu.attempts(0));
      check("1.0 pondérée → « environ 1 tentative » (plus de « 1.0 tentative(s) »)", fu.attempts(1.0) === "environ 1 tentative", fu.attempts(1.0));
      check("2.5 pondérées → « environ 3 tentatives » (plus de « 2.5 tentative(s) »)", fu.attempts(2.5) === "environ 3 tentatives", fu.attempts(2.5));
      check("0.5 pondérée → « moins d'une tentative »", fu.attempts(0.5) === "moins d'une tentative", fu.attempts(0.5));
      check("6.0 pondérées → « environ 6 tentatives »", fu.attempts(6.0) === "environ 6 tentatives", fu.attempts(6.0));
      check("valeur non numérique → « pas encore pratiquée »", fu.attempts(null) === "pas encore pratiquée", String(fu.attempts(null)));
    }

    if (fu.diff && typeof fu.diff === "function") {
      // Le coefficient de difficulté reste affiché sans décimales inutiles.
      check("difficulté 3.0 → « 3 » (pas de décimale)", fu.diff(3.0) === "3", fu.diff(3.0));
      check("difficulté 4.5 → « 5 » (arrondi entier)", fu.diff(4.5) === "5", fu.diff(4.5));
      check("difficulté 0.5 → « ½ »", fu.diff(0.5) === "½", fu.diff(0.5));
    }
  }
}

// ---- Bilan ----
var passed = 0, failed = 0;
results.forEach(function (r) { if (r.ok) { passed++; } else { failed++; } });
var lines = ["JS difficultés UI (v12.4) : " + passed + " réussis, " + failed + " échoués"];
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

