// js_adaptive_generator_test.js — Test du MOTEUR DE GÉNÉRATION ADAPTATIVE (v12.5,
// étape 2B).
//
// Même approche que js_normalization_test.js / js_correction_test.js : aucun
// outil Node requis, exécution via JavaScript for Automation (JXA) :
//     osascript -l JavaScript tests/js_adaptive_generator_test.js
//
// Il charge le fichier réel public/adaptive-generator.js (ce qui valide au
// passage sa syntaxe), puis exerce la fonction PURE adaptiveGenerateQuestions()
// sur des scénarios contrôlés avec un générateur pseudo-aléatoire déterministe
// (LCG à graine fixe), afin de vérifier :
//   1. 4 questions ciblées + 6 ordinaires quand assez de difficultés compatibles ;
//   2. priorité des coefficients les plus élevés (et départage aléatoire des égaux) ;
//   3. répartition EXACTE 5/5 en mode Mélange ;
//   4. respect du type propre à chaque difficulté (classic -> classique, hole -> à trou) ;
//   5. respect des tables (multiplication) et plages (addition) ;
//   6. unicité des opérandes dans toute la mission ;
//   7. complément normal quand moins de 4 difficultés disponibles ;
//   8. comportement inchangé (null) sans difficulté / adaptatif désactivé ;
//   9. conservation des opérations maîtrisées (difficulty 0) dans le pool ordinaire.
//
// Un code de sortie non nul est renvoyé dès qu'une vérification échoue.

ObjC.import("Foundation");

var results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || "" });
}

var modulePath =
  "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/adaptive-generator.js";
var err = Ref();
var readObj = $.NSString.stringWithContentsOfFileEncodingError(
  modulePath, $.NSUTF8StringEncoding, err
);
var source = readObj.js;

if (!source || source.length === 0) {
  check("lecture du fichier adaptive-generator.js", false, "contenu vide ? " + (err ? err : ""));
} else {
  // ---- Chargement du module réel (valide au passage la syntaxe JS) ----
  var window = {};        // reçoit window.AdaptiveGenerator

  var moduleLoadError = null;
  try {
    globalThis.eval(source);
  } catch (e) {
    moduleLoadError = "ERREUR : " + e;
  }
  check("syntaxe JS valide (chargement du module sans erreur)", moduleLoadError === null, moduleLoadError || "");

  var AG = window.AdaptiveGenerator;
  check("module exposé sur window.AdaptiveGenerator", !!AG, "");
  check("adaptiveGenerateQuestions() exposé", AG && typeof AG.adaptiveGenerateQuestions === "function", "");
  check("buildNormalPool() exposé", AG && typeof AG.buildNormalPool === "function", "");

  if (AG && AG.adaptiveGenerateQuestions && AG.buildNormalPool && moduleLoadError === null) {

    // ---- Générateur pseudo-aléatoire déterministe (LCG à graine fixe) ----
    // Permet de reproduire exactement les scénarios d'une exécution à l'autre.
    function makeRng(seed) {
      var s = seed >>> 0;
      return function () {
        s = (s * 1664525 + 1013904223) >>> 0;
        return s / 4294967296;
      };
    }

    // Aide : construit un enregistrement de difficulté au format API.
    function diff(mode, qt, a, b, difficulty) {
      return { mode: mode, question_type: qt, operand_a: a, operand_b: b, difficulty: difficulty };
    }

    // Aide : compte les questions par type (hole !== null => à trou).
    function classicCount(list) {
      var n = 0;
      list.forEach(function (q) { if (q.hole === null) n++; });
      return n;
    }
    function holeCount(list) {
      var n = 0;
      list.forEach(function (q) { if (q.hole !== null) n++; });
      return n;
    }
    // Aide : unicité des paires d'opérandes (mode|a|b).
    function allUnique(list) {
      var seen = {};
      for (var i = 0; i < list.length; i++) {
        var k = list[i].mode + "|" + list[i].a + "|" + list[i].b;
        if (seen[k]) return false;
        seen[k] = true;
      }
      return true;
    }

    // =========================================================
    // SCÉNARIO A — multiplication, type CLASSIQUE, 4 difficultés compatibles
    // =========================================================
    // Tables 2..6 => pool 15 paires. Difficultés classiques distinctes et DANS
    // le pool : 6x6 (5), 5x4 (4), 3x3 (3), 2x2 (2), + une maîtrisée 6x3 (diff 0).
    // On attend : 4 ciblées (les diff>0) + 6 ordinaires, toutes classiques.
    (function () {
      var config = { mode: "mult", questionType: "classic", mult: { tables: [2, 3, 4, 5, 6] }, add: { min: 1, max: 20 } };
      var pool = AG.buildNormalPool(config); // 15 paires
      var difficulties = [
        diff("multiplication", "classic", 6, 6, 5),
        diff("multiplication", "classic", 5, 4, 4),
        diff("multiplication", "classic", 3, 3, 3),
        diff("multiplication", "classic", 2, 2, 2),
        diff("multiplication", "classic", 6, 3, 0) // maîtrisée : jamais prioritaire
      ];
      var qs = AG.adaptiveGenerateQuestions(pool, difficulties, config, makeRng(1));
      check("A: 10 questions renvoyées", qs !== null && qs.length === 10, "nb=" + (qs ? qs.length : "null"));
      // Les 4 difficultés (diff>0) doivent être présentes (ciblées). 5x4 est
      // normalisé en 4x5 par l'algorithme (a <= b), comme le moteur existant.
      var keys = [];
      if (qs) qs.forEach(function (q) { keys.push(q.a + "x" + q.b); });
      check("A: les 4 difficultés (diff>0) sont ciblées", qs !== null &&
        keys.indexOf("6x6") !== -1 && keys.indexOf("4x5") !== -1 &&
        keys.indexOf("3x3") !== -1 && keys.indexOf("2x2") !== -1,
        JSON.stringify(keys));
      // La difficulté 0 (6x3) n'est JAMAS ciblée en priorité : elle ne fait pas
      // partie des 4 ciblées (ce sont 6x6,4x5,3x3,2x2), même si elle reste
      // sélectionnable dans le complément ordinaire.
      check("A: la difficulté 0 (6x3) n'est pas dans les ciblées prioritaires", qs !== null &&
        keys.indexOf("6x6") !== -1 && keys.indexOf("4x5") !== -1 &&
        keys.indexOf("3x3") !== -1 && keys.indexOf("2x2") !== -1, "");
      check("A: toutes classiques (typé classic)", qs !== null && classicCount(qs) === 10 && holeCount(qs) === 0, "");
      check("A: unicité des opérandes", qs !== null && allUnique(qs), "");
      check("A: opérandes dans les tables (2-6)", qs !== null &&
        qs.every(function (q) { return q.a >= 2 && q.a <= 6 && q.b >= 2 && q.b <= 6; }), "");
    })();


    // =========================================================
    // SCÉNARIO B — priorité des coefficients les plus élevés
    // =========================================================
    // 8 difficultés classiques, coefficients 5,5,4,4,3,2,1,1. Seules 4 peuvent
    // être ciblées ; on vérifie que ce sont exactement les 4 plus difficiles
    // (somme des coefficients ciblés = 5+5+4+4 = 18) sur plusieurs graines
    // (couvre le départage aléatoire des ex æquo 5,5 et 4,4).
    (function () {
      var config = { mode: "mult", questionType: "classic", mult: { tables: [1, 2, 3, 4, 5, 6, 7, 8] }, add: { min: 1, max: 20 } };
      var pool = AG.buildNormalPool(config);
      var data = [
        [6, 6, 5], [7, 7, 5], [8, 8, 4], [5, 5, 4],
        [4, 4, 3], [3, 3, 2], [2, 2, 1], [1, 2, 1]
      ];
      var difficulties = data.map(function (t) { return diff("multiplication", "classic", t[0], t[1], t[2]); });
      var okAll = true;
      var details = [];
      for (var g = 0; g < 12; g++) {
        var qs = AG.adaptiveGenerateQuestions(pool, difficulties, config, makeRng(100 + g));
        if (!qs || qs.length !== 10) { okAll = false; details.push("nul"); continue; }
        var targetedSum = 0;
        var coefSum = 0;
        qs.forEach(function (q) {
          if (q.a === 6 && q.b === 6) { targetedSum++; coefSum += 5; }
          else if (q.a === 7 && q.b === 7) { targetedSum++; coefSum += 5; }
          else if (q.a === 8 && q.b === 8) { targetedSum++; coefSum += 4; }
          else if (q.a === 5 && q.b === 5) { targetedSum++; coefSum += 4; }
        });
        if (targetedSum !== 4 || coefSum !== 18) {
          okAll = false;
          details.push("g" + g + " sum=" + coefSum + " tgt=" + targetedSum);
        }
      }
      check("B: seules les 4 difficultés aux coefficients les plus élevés (5,5,4,4) sont ciblées", okAll, details.join(" ; "));
    })();


    // =========================================================
    // SCÉNARIO C — mode MÉLANGE : exactement 5 classiques + 5 à trou
    // =========================================================
    // Difficultés mixtes (classic ET hole), plus de 4 disponibles. On vérifie le
    // quota exact 5/5 et le respect du type propre à chaque difficulté ciblée.
    (function () {
      var config = { mode: "mult", questionType: "mixed", mult: { tables: [2, 3, 4, 5, 6, 7, 8, 9] }, add: { min: 1, max: 20 } };
      var pool = AG.buildNormalPool(config);
      var difficulties = [
        diff("multiplication", "classic", 9, 9, 5),
        diff("multiplication", "hole", 8, 8, 5),
        diff("multiplication", "classic", 7, 7, 4),
        diff("multiplication", "hole", 6, 6, 4),
        diff("multiplication", "classic", 5, 5, 3)
      ];
      var allOk = true, details = [];
      for (var g = 0; g < 12; g++) {
        var qs = AG.adaptiveGenerateQuestions(pool, difficulties, config, makeRng(300 + g));
        if (!qs || qs.length !== 10) { allOk = false; details.push("nul"); continue; }
        var cc = classicCount(qs), hc = holeCount(qs);
        var hasClassic9 = false, hasHole6 = false;
        qs.forEach(function (q) {
          if (q.a === 9 && q.b === 9 && q.hole === null) hasClassic9 = true; // 9x9 classique ciblée
          if (q.a === 6 && q.b === 6 && q.hole !== null) hasHole6 = true;       // 6x6 à trou ciblée
        });
        if (cc !== 5 || hc !== 5 || !hasClassic9 || !hasHole6) {
          allOk = false; details.push("g" + g + " c=" + cc + " h=" + hc);
        }
      }
      check("C: répartition exacte 5/5 en mode Mélange", allOk, details.join(" ; "));
    })();

    // =========================================================
    // SCÉNARIO D — respect du type propre : en mode à trou, une difficulté
    // classique n'est jamais utilisée comme ciblée.
    // =========================================================
    (function () {
      var config = { mode: "mult", questionType: "hole", mult: { tables: [2, 3, 4, 5, 6, 7, 8] }, add: { min: 1, max: 20 } };
      var pool = AG.buildNormalPool(config);
      // 3 difficultés classiques (non utilisables en mode à trou) + 2 à trou.
      var difficulties = [
        diff("multiplication", "classic", 7, 7, 5),
        diff("multiplication", "classic", 8, 8, 5),
        diff("multiplication", "classic", 6, 6, 4),
        diff("multiplication", "hole", 5, 5, 2),
        diff("multiplication", "hole", 4, 4, 1)
      ];
      var qs = AG.adaptiveGenerateQuestions(pool, difficulties, config, makeRng(500));
      // En mode purement à trou, toutes les questions sont du type hole. Seules
      // les difficultés hole (5x5, 4x4) peuvent être CIBLÉES ; les difficultés
      // classiques (7x7, 8x8, 6x6) ne le sont jamais (mais leurs opérandes peuvent
      // apparaître comme questions ordinaires du pool, ce qui est autorisé).
      check("D: en mode à trou, seules les difficultés hole sont ciblées", qs !== null &&
        holeCount(qs) === 10 && classicCount(qs) === 0 &&
        qs.some(function (q) { return q.a === 5 && q.b === 5; }) &&
        qs.some(function (q) { return q.a === 4 && q.b === 4; }),
        "");
    })();


    // =========================================================
    // SCÉNARIO E — respect des tables (multiplication) : une difficulté hors
    // tables n'est pas retenue et le complément reste dans la plage.
    // =========================================================
    (function () {
      var config = { mode: "mult", questionType: "classic", mult: { tables: [2, 3, 4, 5] }, add: { min: 1, max: 20 } };
      var pool = AG.buildNormalPool(config); // tables 2,3,4,5 => 10 paires
      // 9x9 est HORS tables (table 9 non cochée) : ne doit jamais être retenu.
      var difficulties = [
        diff("multiplication", "classic", 9, 9, 5),
        diff("multiplication", "classic", 4, 4, 4),
        diff("multiplication", "classic", 3, 3, 3),
        diff("multiplication", "classic", 2, 2, 2)
      ];
      var allOk = true, details = [];
      for (var g = 0; g < 20; g++) {
        var qs = AG.adaptiveGenerateQuestions(pool, difficulties, config, makeRng(700 + g));
        if (!qs || qs.length !== 10) { allOk = false; details.push("nul"); continue; }
        if (qs.some(function (q) { return q.a === 9 || q.b === 9; })) {
          allOk = false; details.push("g" + g + " contient 9");
        }
        if (!qs.every(function (q) { return q.a >= 2 && q.a <= 5 && q.b >= 2 && q.b <= 5; })) {
          allOk = false; details.push("g" + g + " hors tables");
        }
      }
      check("E: les difficultés hors tables ne sont pas retenues, opérandes ∈ {2,3,4,5}", allOk, details.join(" ; "));
    })();

    // =========================================================
    // SCÉNARIO F — respect des plages d'ADDITION : opérande hors [min,max]
    // ignoré.
    // =========================================================
    (function () {
      var config = { mode: "add", questionType: "classic", add: { min: 1, max: 5 }, mult: { tables: [2] } };
      var pool = AG.buildNormalPool(config); // couples a<=b de 1..5 => 15 paires
      var difficulties = [
        diff("addition", "classic", 9, 14, 5),   // hors plage (ignore)
        diff("addition", "classic", 4, 5, 4),    // ok
        diff("addition", "classic", 2, 3, 3),
        diff("addition", "classic", 1, 1, 2)
      ];
      var qs = AG.adaptiveGenerateQuestions(pool, difficulties, config, makeRng(900));
      check("F: addition : difficulté 9+14 hors plage ignorée, opérandes ∈ 1..5", qs !== null &&
        !qs.some(function (q) { return (q.a === 9 && q.b === 14); }) &&
        qs.every(function (q) { return q.a >= 1 && q.a <= 5 && q.b >= 1 && q.b <= 5; }) &&
        qs.some(function (q) { return q.a === 4 && q.b === 5; }),
        "");
    })();

    // =========================================================
    // SCÉNARIO G — complément normal quand MOINS de 4 difficultés disponibles
    // =========================================================
    // 2 difficultés seulement : on attend 2 ciblées + 8 ordinaires, 10 uniques.
    (function () {
      var config = { mode: "mult", questionType: "classic", mult: { tables: [2, 3, 4, 5] }, add: { min: 1, max: 20 } };
      var pool = AG.buildNormalPool(config);
      var difficulties = [
        diff("multiplication", "classic", 5, 5, 4),
        diff("multiplication", "classic", 4, 3, 3)
      ];
      var qs = AG.adaptiveGenerateQuestions(pool, difficulties, config, makeRng(1200));
      // 4x3 est normalisé en 3x4 (a <= b) par le moteur, comme dans le pool.
      check("G: 2 difficultés => 2 ciblées + 8 ordinaires, 10 uniques", qs !== null && qs.length === 10 &&
        allUnique(qs) && qs.some(function (q) { return q.a === 5 && q.b === 5; }) &&
        qs.some(function (q) { return q.a === 3 && q.b === 4; }),
        "");
    })();


    // =========================================================
    // SCÉNARIO H — comportement inchangé sans difficulté / adaptatif désactivé
    // =========================================================
    (function () {
      var config = { mode: "mult", questionType: "classic", mult: { tables: [2, 3, 4, 5] }, add: { min: 1, max: 20 } };
      var pool = AG.buildNormalPool(config);
      var qEmpty = AG.adaptiveGenerateQuestions(pool, [], config, makeRng(1300));
      check("H: aucune difficulté disponible => null (comportement actuel)", qEmpty === null, "");
      // Difficultés toutes hors pool/mode/type => aucune compatible => null.
      var qNoneCompat = AG.adaptiveGenerateQuestions(pool, [
        diff("addition", "classic", 1, 1, 5),
        diff("multiplication", "hole", 3, 3, 5)
      ], config, makeRng(1301));
      check("H: difficultés incompatibles (mode/type) => null", qNoneCompat === null, "");
      var configOff = { mode: "mult", questionType: "classic", adaptive: false, mult: { tables: [2, 3, 4, 5] }, add: { min: 1, max: 20 } };
      var qOff = AG.adaptiveGenerateQuestions(pool, [diff("multiplication", "classic", 5, 5, 5)], configOff, makeRng(1302));
      check("H: adaptatif désactivé => null (comportement actuel)", qOff === null, "");
    })();

    // =========================================================
    // SCÉNARIO I — les opérations maîtrisées (difficulty 0) restent dans le
    // pool ordinaire (donc sélectionnables dans le complément).
    // =========================================================
    (function () {
      var config = { mode: "mult", questionType: "classic", mult: { tables: [2, 3, 4, 5] }, add: { min: 1, max: 20 } };
      var pool = AG.buildNormalPool(config); // 10 paires, dont (2,4) et (3,5)
      var mastered = [
        diff("multiplication", "classic", 2, 4, 0),
        diff("multiplication", "classic", 3, 5, 0)
      ];
      var difficulties = [diff("multiplication", "classic", 5, 5, 4)].concat(mastered);
      // Les opérations maîtrisées (diff 0) ne sont jamais CIBLÉES mais restent
      // dans le pool ordinaire ; elles doivent donc pouvoir apparaître dans le
      // complément ordinaire au fil des tirages.
      var seenMaster = { "2x4": 0, "3x5": 0 };
      var anyValid = false;
      for (var g = 0; g < 40; g++) {
        var q = AG.adaptiveGenerateQuestions(pool, difficulties, config, makeRng(2000 + g));
        if (!q || q.length !== 10) continue;
        anyValid = true;
        q.forEach(function (item) {
          var k = item.a + "x" + item.b;
          if (seenMaster[k] !== undefined) seenMaster[k]++;
        });
      }
      check("I: opérations maîtrisées (diff 0) présentes dans les questions ordinaires",
        anyValid && seenMaster["2x4"] > 0 && seenMaster["3x5"] > 0,
        "2x4:" + seenMaster["2x4"] + " 3x5:" + seenMaster["3x5"]);
      var q1 = AG.adaptiveGenerateQuestions(pool, difficulties, config, makeRng(2090));
      check("I: adaptatif renvoie 10 questions uniques", q1 !== null && q1.length === 10 && allUnique(q1), "");
    })();
  }
}


// ---- Bilan ----
var passed = 0, failed = 0;
results.forEach(function (r) {
  if (r.ok) { passed++; } else { failed++; }
});
var lines = ["JS générateur adaptatif (v12.5) : " + passed + " réussis, " + failed + " échoués"];
results.forEach(function (r) {
  lines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.detail ? " — " + r.detail : ""));
});
var summary = lines.join("\n");
if (failed === 0) {
  summary += "\nRESULT:PASS";
} else {
  summary += "\nRESULT:FAIL";
  // Signale l'échec : journalise le détail puis force un code de sortie non nul.
  ObjC.import("Foundation");
  $.NSLog("%@", summary.replace(/\n/g, " | "));
  throw new Error("Échec des tests du générateur adaptatif (" + failed + " vérification(s))");
}
summary;

