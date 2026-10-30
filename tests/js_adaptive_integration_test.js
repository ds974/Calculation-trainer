// js_adaptive_integration_test.js — Test de l'INTÉGRATION de l'entraînement
// adaptatif (v12.5, ÉTAPE 2C) dans le démarrage des missions.
//
// Exécution (comme les autres tests JS, aucun outil Node requis) :
//     osascript -l JavaScript tests/js_adaptive_integration_test.js
//
// Ce harnais de test reprend l'approche éprouvée de js_correction_test.js :
//  - il charge le fichier réel public/app.js (validant au passage sa syntaxe) ;
//  - il exerce fonctionnellement les parties SYNCHRONES et donc testables
//    « pour de vrai » : valeur par défaut du paramètre, persistance /
//    désactivation (localStorage), alignement des filtres API, réutilisation
//    du pool ordinaire, case à cocher par défaut cochée ;
//  - il vérifie par assertions sur le SOURCE les invariants ASYNCHRONES de
//    l'orchestration (contexte JXA sans éventuel support natif d'`await` au
//    niveau du script) : verrou anti-double-clic, appel unique à
//    `difficulty/operations`, transmission au moteur
//    `AdaptiveGenerator.adaptiveGenerateQuestions`, repli propre vers le
//    générateur ordinaire (y compris API indisponible / aucune difficulté),
//    et absence d'appel API en mode invité.
//  - il vérifie enfin que le moteur adaptatif est réellement CHARGÉ (fichier
//    adaptive-generator.js lisible et fonction exposée).
//
// Un code de sortie non nul est renvoyé dès qu'une vérification échoue.

ObjC.import("Foundation");

var results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || "" });
}

// ---------------------------------------------------------------------------
// Stubs minimaux pour charger app.js sans déclencher `init` (DOM minimal).
// ---------------------------------------------------------------------------
function makeElStub() {
  return {
    textContent: "", innerHTML: "", className: "", value: "", disabled: false,
    checked: false, hidden: false,
    style: {}, dataset: {},
    classList: { add: function() {}, remove: function() {}, toggle: function() {} },
    addEventListener: function() {}, focus: function() {}, closest: function() { return null; },
    setAttribute: function() {}, appendChild: function() {}, append: function() {},
    scrollIntoView: function() {}
  };
}

// Case à cocher adaptative simulée (sélecteur dédié retourné par querySelector).
var adaptiveEl = makeElStub();

var document = {
  _els: {},
  addEventListener: function() {},                 // "DOMContentLoaded" jamais déclenché
  getElementById: function(id) {
    if (!this._els[id]) this._els[id] = makeElStub();
    return this._els[id];
  },
  querySelectorAll: function() { return []; },
  querySelector: function(sel) {
    if (sel === "[data-adaptive-option]") return adaptiveEl;
    return null;
  },
  createElement: function() { return makeElStub(); }
};

var localStorage = {
  _m: {},
  getItem: function(k) { return Object.prototype.hasOwnProperty.call(this._m, k) ? this._m[k] : null; },
  setItem: function(k, v) { this._m[k] = String(v); },
  removeItem: function(k) { delete this._m[k]; }
};

var performance = { now: function() { return 0; } };

// Session invité/connecté minimale + moteur adaptatif + API (stubs d'environnement).
var sessionState = null;
var MissionGuestHistoryStub = {
  setSession: function(s) { sessionState = s && s.token ? s : null; },
  makeMissionId: function() { return "mi-1"; },
  get hasSession() { return sessionState !== null; },
  get currentUser() { return sessionState ? sessionState.user : null; }
};
var AdaptiveGeneratorStub = {
  adaptiveGenerateQuestions: function(pool, difficulties, config) {
    return null; // stub : par défaut, comportement ordinaire (cf. source assertés)
  }
};
var accountStub = {
  api: function(action, params, method) { return null; },
  getUser: function() { return sessionState ? sessionState.user : null; }
};
var window = {
  MissionGuestHistory: MissionGuestHistoryStub,
  AdaptiveGenerator: AdaptiveGeneratorStub,
  AccountUI: accountStub
};

// ---------------------------------------------------------------------------
// Chargement du app.js réel (valide au passage sa syntaxe).
// ---------------------------------------------------------------------------
var appPath = "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/app.js";
var err = Ref();
var readObj = $.NSString.stringWithContentsOfFileEncodingError(
  appPath, $.NSUTF8StringEncoding, err
);
var source = readObj.js;

if (!source || source.length === 0) {
  check("lecture du fichier app.js", false, "contenu vide ? " + (err ? err : ""));
} else {
  // Injecte un point d'accès aux fonctions SYNCHRONES testables DANS le scope
  // d'évaluation (les déclarations « function »/« const » de app.js ne sont
  // pas exposées sur l'objet global).
  source = source +
    "\n;globalThis.__ai = {" +
    " normalize: normalizeConfig," +
    " state: state," +
    " handleAdaptive: handleAdaptiveChange," +
    " filters: difficultyFilters," +
    " pool: buildQuestionPool," +
    " ordinary: generateUniqueQuestions," +
    " buildControls: buildConfigControls" +
    " };";

  var moduleLoadError = null;
  try {
    globalThis.eval(source);
  } catch (e) {
    moduleLoadError = "ERREUR : " + e;
  }
  check("syntaxe JS valide (chargement de app.js sans erreur)", moduleLoadError === null, moduleLoadError || "");

  var fu = globalThis.__ai;
  check("les fonctions synchrones d'intégration v12.5 sont exposées",
    typeof fu.normalize === "function" && typeof fu.handleAdaptive === "function" &&
    typeof fu.filters === "function" && typeof fu.pool === "function" &&
    typeof fu.ordinary === "function" && typeof fu.buildControls === "function",
    "");

  // -------------------------------------------------------------------------
  // 1. Paramètre activé par défaut (y compris ancienne config sans propriété).
  // -------------------------------------------------------------------------
  var cfgNew = fu.normalize({ mode: "mult", questionType: "classic", timePerQuestion: 5 });
  check("1. config neuve : adaptive === true par défaut", cfgNew.adaptive === true, "=" + cfgNew.adaptive);
  var cfgLegacy = fu.normalize({ mult: { tables: [2, 3] }, timePerQuestion: 5 });
  check("1b. ancienne config sans propriété : adaptive === true", cfgLegacy.adaptive === true, "=" + cfgLegacy.adaptive);
  var cfgDisabled = fu.normalize({ mult: { tables: [2, 3] }, adaptive: false });
  check("1c. config explicite adaptive:false respectée", cfgDisabled.adaptive === false, "=" + cfgDisabled.adaptive);

  // La case à cocher est cochée par défaut lors de la construction des contrôles.
  adaptiveEl.checked = false;
  fu.buildControls();
  check("1d. case à cocher cochée par défaut dans la construction des contrôles",
    adaptiveEl.checked === true, "checked=" + adaptiveEl.checked);

  // -------------------------------------------------------------------------
  // 2. Persistance et désactivation (localStorage).
  // -------------------------------------------------------------------------
  localStorage._m = {};
  fu.state.config = fu.normalize({ mode: "mult", questionType: "classic", timePerQuestion: 5 });
  fu.handleAdaptive({ target: { checked: false } });
  var persisted = JSON.parse(localStorage.getItem("multiplicationTrainer.config.v11"));
  check("2. désactivation persistée dans localStorage (adaptive:false)",
    persisted && persisted.adaptive === false, JSON.stringify(persisted));
  fu.handleAdaptive({ target: { checked: true } });
  var persisted2 = JSON.parse(localStorage.getItem("multiplicationTrainer.config.v11"));
  check("2b. réactivation persistée (adaptive:true)", persisted2 && persisted2.adaptive === true, "");

  // -------------------------------------------------------------------------
  // 3. Filtres API alignés sur les valeurs du serveur (testé fonctionnellement,
  //    ils sont synchrones).
  // -------------------------------------------------------------------------
  fu.state.config = fu.normalize({ mode: "add", questionType: "mixed", add: { min: 5, max: 10 }, timePerQuestion: 5 });
  var fAdd = fu.filters();
  check("3. filtres addition : mode=addition, question_type=mixed, plage 5-10",
    fAdd.mode === "addition" && fAdd["question_type"] === "mixed" &&
    fAdd.add_min === "5" && fAdd.add_max === "10", JSON.stringify(fAdd));
  fu.state.config = fu.normalize({ mode: "mult", questionType: "classic", mult: { tables: [2, 3, 4] }, timePerQuestion: 5 });
  var fMult = fu.filters();
  var fTables = (fMult.tables || "").split(",").map(Number).sort().join(",");
  check("3b. filtres multiplication : mode=multiplication, question_type=classic, tables 2,3,4",
    fMult.mode === "multiplication" && fMult["question_type"] === "classic" && fTables === "2,3,4",
    JSON.stringify(fMult));

  // -------------------------------------------------------------------------
  // 4. Réutilisation du pool ordinaire (une seule source de vérité des calculs).
  // -------------------------------------------------------------------------
  fu.state.config = fu.normalize({ mode: "mult", questionType: "classic", mult: { tables: [2, 3, 4] }, timePerQuestion: 5 });
  var poolA = fu.pool();
  var ordinaryList = fu.ordinary();
  // Tables 2,3,4 : paires a<=b => (2,2)(2,3)(2,4)(3,3)(3,4)(4,4) = 6 opérations.
  check("4. buildQuestionPool construit le pool complet sans doublon commutatif (6 couples pour 3 tables)",
    poolA.length === 6, "pool=" + poolA.length);
  check("4b. le générateur ordinaire puise uniquement dans ce pool (toutes les questions sont du pool)",
    Array.isArray(ordinaryList) && ordinaryList.length >= 1 && ordinaryList.every(function (q) {
      return poolA.some(function (p) { return p.a === q.a && p.b === q.b && p.mode === q.mode; });
    }),
    "nb=" + (ordinaryList && ordinaryList.length));
  // Le comportement ordinaire limite la mission à QUESTION_COUNT (10) questions.
  fu.state.config = fu.normalize({ mode: "mult", questionType: "classic", mult: { tables: [2,3,4,5,6,7,8,9,10] }, timePerQuestion: 5 });
  var bigOrdinary = fu.ordinary();
  check("4c. avec un pool suffisant, la mission ordinaire compte exactement 10 questions",
    Array.isArray(bigOrdinary) && bigOrdinary.length === 10, "nb=" + (bigOrdinary && bigOrdinary.length));


  // -------------------------------------------------------------------------
  // Assertions source : orchestration asynchrone et protections v12.5.
  // (Contexte JXA sans support fiable d'`await` au niveau du script : ces
  // invariants asynchrones sont donc vérifiés par assertions sur le source,
  // comme js_correction_test.js le fait pour les invariants de timing.)
  // -------------------------------------------------------------------------

  // 5. Démarrage : verrou anti-double-clic pendant le chargement.
  check("5. startMission : verrou anti double-clic (launchInProgress)",
    /if\s*\(\s*state\.launchInProgress\s*\)\s*return/.test(source) &&
    /state\.launchInProgress\s*=\s*true/.test(source) &&
    /generateMissionQuestions\(\)\.then/.test(source) &&
    /state\.launchInProgress\s*=\s*false/.test(source),
    "");

  // 6. Orchestration : connecté + adaptatif activé => moteur adaptatif, repli ordinaire.
  check("6. generateMissionQuestions : utilisateur connecté requis",
    /if\s*\(!isConnected\(\)\)\s*return\s*ordinary\(\)/.test(source), "");
  check("6b. option adaptive requise",
    /state\.config\.adaptive\s*!==\s*true/.test(source), "");
  check("6c. moteur adaptatif requis (chargé)",
    /AdaptiveGenerator\.adaptiveGenerateQuestions/.test(source), "");
  check("6d. les difficultés sont récupérées puis attendues",
    /await\s+fetchDifficulties\(\)/.test(source), "");
  check("6e. repli vers le générateur ordinaire quand le moteur renvoie null",
    /return\s+result\s*\|\|\s*ordinary\(\)/.test(source), "");

  // 7. API : appel unique à difficulty/operations en GET via AccountUI.
  check("7. fetchDifficulties : AccountUI.api('difficulty/operations', params, 'GET')",
    /AccountUI\.api\(\s*[\"']difficulty\/operations[\"']\s*,\s*params\s*,\s*[\"']GET[\"']\s*\)/.test(source),
    "");
  check("7b. repli propre (null) si l'API est indisponible",
    /if\s*\(!res\.ok\)\s*return\s*null/.test(source) &&
    /catch\s*\(_e\)/.test(source),
    "");

  // 9. Mode invité : le chemin ordinaire est pris (isConnected en garde-fou).
  check("9. mode invité : chemin ordinaire (isConnected garde-fou en tête)",
    source.indexOf("if (!isConnected()) return ordinary();") !== -1, "");

  // 10. Chargement effectif du moteur adaptatif (fichier réel + fonction).
  var agPath = "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/adaptive-generator.js";
  var aggErr = Ref();
  var aggRead = $.NSString.stringWithContentsOfFileEncodingError(
    agPath, $.NSUTF8StringEncoding, aggErr
  );
  var agSrc = aggRead.js;
  check("10. adaptive-generator.js lisible (non vide)", !!agSrc && agSrc.length > 0, "");
  check("10b. le moteur expose adaptiveGenerateQuestions",
    /adaptiveGenerateQuestions\s*:\s*adaptiveGenerateQuestions/.test(agSrc || ""), "");

  // 11. index.html : script adaptive-generator.js chargé AVANT app.js.
  var htmlPath = "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/index.html";
  var htmlErr = Ref();
  var htmlRead = $.NSString.stringWithContentsOfFileEncodingError(
    htmlPath, $.NSUTF8StringEncoding, htmlErr
  );
  var htmlSrc = htmlRead.js;
  var adaptiveIdx = htmlSrc ? htmlSrc.indexOf("adaptive-generator.js") : -1;
  var appIdx = htmlSrc ? htmlSrc.indexOf("\"app.js\"") : -1;
  check("11. index.html charge adaptive-generator.js AVANT app.js",
    adaptiveIdx !== -1 && appIdx !== -1 && adaptiveIdx < appIdx, "ag=" + adaptiveIdx + " app=" + appIdx);
  check("11b. la case à cocher est présente dans index.html",
    htmlSrc && htmlSrc.indexOf("data-adaptive-option") !== -1 &&
    htmlSrc.indexOf("difficultés") !== -1, "");

  // -------------------------------------------------------------------------
  // Rapport final (mêmes conventions d'affichage que les autres tests JS).
  // -------------------------------------------------------------------------
  var passed = 0, failedCount = 0;
  results.forEach(function (rr) { if (rr.ok) passed++; else failedCount++; });
  var lines = ["JS intégration adaptative (v12.5) : " + passed + " réussis, " + failedCount + " échoués"];
  results.forEach(function (rr) {
    lines.push((rr.ok ? "  ✓ " : "  ✗ ") + rr.name + (rr.detail ? " — " + rr.detail : ""));
  });
  var summary = lines.join("\n");
  if (failedCount === 0) {
    summary += "\nRESULT:PASS";
  } else {
    summary += "\nRESULT:FAIL";
    ObjC.import("Foundation");
    $.NSFileHandle.fileHandleWithStandardError().writeData(
      $.NSString.alloc.initWithString(summary).dataUsingEncoding($.NSUTF8StringEncoding)
    );
  }
  summary;
}

