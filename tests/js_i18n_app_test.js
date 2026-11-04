// js_i18n_app_test.js — Internationalisation de l'INTERFACE PRINCIPALE (v12.6-B3.1).
//
// Même approche que les autres tests du dépôt : aucun outil Node requis,
// exécution via JavaScript for Automation (JXA) :
//     osascript -l JavaScript tests/js_i18n_app_test.js
//
// Ce test vérifie que les vues portées par public/index.html et public/app.js
// sont bien internationalisées à partir des QUATRE catalogues (fr, en, es,
// zh-Hans), sans clé orpheline ni texte codé en dur dans les parcours visibles.
//
// Il s'appuie sur le moteur réel public/i18n.js (catalogues injectés via
// _register + _setLocaleSync) et charge réellement public/app.js avec des stubs
// DOM minimaux pour exercer les aides pures de l'interface.
//
// Couverture (§9 de la mission) :
//   1. correspondance des clés utilisées avec les catalogues ;
//   2. absence de références à des clés inexistantes ;
//   3. textes statiques et attributs localisés (data-i18n / -title / -placeholder /
//      -aria-label / -tooltip) ;
//   4. paramètres et modes de calcul ;
//   5. questions et corrections pédagogiques ;
//   6. résultats et encouragements ;
//   7. pluriels (config.tables / mission.rangeTooSmall / result.rewardPartial) ;
//   8. classements et tableau des scores ;
//   9. titres cohérents avec le mode sélectionné (mult vs add, toutes langues) ;
//  10. actualisation après changement de langue (moteur i18n, état de partie intact) ;
//  11. préservation des variables d'interpolation ;
//  12. absence de régression du calcul et de l'entraînement adaptatif (aides pures).
//
// NOTE JXA : la file de micro-tâches (Promise) n'est pas vidée par le runloop,
// donc les API asynchrones du moteur (fetch) ne sont pas exercées ici ; le noyau
// synchrone (t/pl/_setLocaleSync) et les événements DOM (simulés) suffisent pour
// valider la logique réelle de l'interface. Les fonctions asynchrones propres à
// l'entraînement adaptatif restent couvertes par js_adaptive_*_test.js.

ObjC.import("Foundation");

var BASE = "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/";
var results = [];
function check(name, ok, detail) {
  results.push({ name: name, ok: ok, detail: detail || "" });
}

function readUTF8(path) {
  var err = Ref();
  var s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, err);
  return s && s.js ? s.js : "";
}

function flatten(obj, prefix) {
  var out = {};
  Object.keys(obj).forEach(function (k) {
    var key = prefix ? prefix + "." + k : k;
    var v = obj[k];
    if (v && typeof v === "object" && !Array.isArray(v)) {
      var sub = flatten(v, key);
      Object.keys(sub).forEach(function (sk) { out[sk] = sub[sk]; });
    } else {
      out[key] = v;
    }
  });
  return out;
}

// ==================================================================== 1. & 2.
// Chargement des quatre catalogues (source de vérité des clés).
var FILES = ["fr", "en", "es", "zh-Hans"];
var catalogs = {}, flatCatalogs = {};
FILES.forEach(function (locale) {
  try {
    catalogs[locale] = JSON.parse(readUTF8(BASE + "i18n/" + locale + ".json"));
    flatCatalogs[locale] = flatten(catalogs[locale]);
  } catch (e) {
    check("chargement catalogue (" + locale + ")", false, "ERREUR : " + e);
  }
});
var missingCat = FILES.filter(function (l) { return !catalogs[l]; });
if (missingCat.length === 0) {
  check("les 4 catalogues sont chargés", true, "");
} else {
  check("les 4 catalogues sont chargés", false, "manquants : " + missingCat.join(","));
}

// ==================================================================== MOTEUR
// Chargement du moteur réel i18n.js.
var I18N = null;
try {
  globalThis.eval(readUTF8(BASE + "i18n.js"));
  I18N = globalThis.I18N;
} catch (e) {
  // rien : signalé plus bas
}
check("moteur i18n exposé", !!(I18N && typeof I18N === "object"), "");
if (I18N && typeof I18N === "object") {
  FILES.forEach(function (locale) { I18N._register(locale, catalogs[locale]); });
  I18N._setLocaleSync("fr");
  // Le catalogue est utilisable : isReady() est vrai ET la traduction française
  // est réellement servie (cela valide l'injection dans le cache du moteur).
  check("catalogues injectés et opérationnels", I18N.isReady() && I18N.t("home.start") === "Lancer une mission",
    "« " + I18N.t("home.start") + " »");
}
var frFlat = flatCatalogs["fr"] || {};

// ==================================================================== SOURCES
// Lecture des sources de l'interface principale.
var indexSrc = readUTF8(BASE + "index.html");
var appSrc = readUTF8(BASE + "app.js");
check("lecture index.html non vide", indexSrc && indexSrc.length > 500, "");
check("lecture app.js non vide", appSrc && appSrc.length > 500, "");

// --- 1. & 2. Toutes les clés référencées par index.html et app.js existent.
var referenced = {};
var attrRe = /data-i18n(?:-[a-z-]+)?="([^"]+)"/g;
var m;
while ((m = attrRe.exec(indexSrc)) !== null) referenced[m[1]] = true;
var jsTRe = /\bi18nT\("([^"]+)"\)/g;
while ((m = jsTRe.exec(appSrc)) !== null) referenced[m[1]] = true;
var jsPlRe = /\bi18nPl\("([^"]+)"\)/g;
while ((m = jsPlRe.exec(appSrc)) !== null) referenced[m[1]] = true;

var knownKeys = Object.keys(frFlat);
// Sur un pluriel (clé de base xxx → xxxOne/xxxOther), on vérifie la forme étendue.
var missingRefs = Object.keys(referenced).filter(function (k) {
  if (k.indexOf(".") === -1) return true;
  if (k in frFlat) return false;
  return !(k + "One" in frFlat && k + "Other" in frFlat);
});
check("aucune clé référencée inexistante (index+app)",
  missingRefs.length === 0,
  "manquantes : " + (missingRefs.join(",") || "aucune"));

// Chaque clé référencée est présente dans les QUATRE catalogues.
var crossMissing = Object.keys(referenced).filter(function (k) {
  var target = k in frFlat ? k : (k + "One");
  return !FILES.every(function (l) { return target in flatCatalogs[l]; });
});
check("chaque clé existe dans les 4 langues", crossMissing.length === 0,
  crossMissing.join(",") || "");

// --- 3. Textes statiques et attributs localisés sur les écrans du périmètre.
var staticAttrChecks = [
  ["config.title", 'data-i18n="config.title"'],
  ["config.operationType", 'data-i18n="config.operationType"'],
  ["config.questionType", 'data-i18n="config.questionType"'],
  ["config.adaptive", 'data-i18n="config.adaptive"'],
  ["config.timePerQuestion", 'data-i18n="config.timePerQuestion"'],
  ["mission.title", 'data-i18n="mission.title"'],
  ["mission.construction", 'data-i18n="mission.construction"'],
  ["mission.yourAnswer", 'data-i18n="mission.yourAnswer"'],
  ["mission.keypadHint", 'data-i18n="mission.keypadHint"'],
  ["result.title", 'data-i18n="result.title"'],
  ["result.debrief", 'data-i18n="result.debrief"'],
  ["result.newGame", 'data-i18n="result.newGame"'],
  ["result.namePrompt", 'data-i18n="result.namePrompt"'],
  ["leaderboard.title", 'data-i18n="leaderboard.title"'],
  ["leaderboard.empty", 'data-i18n="leaderboard.empty"'],
  ["leaderboard.columnName", 'data-i18n="leaderboard.columnName"'],
  ["home.start", 'data-i18n="home.start"']
];
staticAttrChecks.forEach(function (c) {
  check("attribut localisé présent : " + c[0], indexSrc.indexOf(c[1]) !== -1, "");
});
// Attributs secondaires (title / placeholder / aria-label / tooltip).
check("placeholder localisé (result.namePlaceholder)",
  indexSrc.indexOf('data-i18n-placeholder="result.namePlaceholder"') !== -1, "");
check("aria-labels localisés (aria.settings, aria.scores)",
  indexSrc.indexOf('data-i18n-aria-label="aria.settings"') !== -1 &&
  indexSrc.indexOf('data-i18n-aria-label="aria.scores"') !== -1, "");
check("tooltips localisés (tooltip.settings, tooltip.classicDesc)",
  indexSrc.indexOf('data-i18n-tooltip="tooltip.settings"') !== -1 &&
  indexSrc.indexOf('data-i18n-tooltip="tooltip.classicDesc"') !== -1, "");


// ==================================================================== APP.JS
// Chargement réel d'app.js avec stubs DOM minimaux (aucun déclenchement d'init).
function makeElStub() {
  return {
    textContent: "", innerHTML: "", className: "", value: "", disabled: false,
    style: {}, dataset: {},
    classList: { add: function() {}, remove: function() {}, toggle: function() {} },
    addEventListener: function() {}, focus: function() {},
    closest: function() { return { hidden: false }; },
    setAttribute: function() {}, appendChild: function() {}, hidden: false
  };
}
var homeTitleEl = { textContent: "" };
var homeSubtitleEl = { textContent: "" };
var window = {};
// Le moteur i18n est attribué au global (globalThis.I18N) ; app.js le lit via
// window.I18N. On relie le stub window au moteur pour exercer les vrais textes.
if (I18N) window.I18N = I18N;
var document = {
  addEventListener: function() {},
  getElementById: function(id) {
    if (id === "homeTitle") return homeTitleEl;
    if (id === "homeSubtitle") return homeSubtitleEl;
    return makeElStub();
  },
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

// Raccroche les aides pures (et l'état) de l'interface dans le scope d'évaluation.
appSrc = appSrc +
  "\n;globalThis.__ct = { correction: questionCorrectionHTML, display: questionDisplay," +
  " answer: questionAnswer, compute: computeAnswer, modeLabel: modeLabel," +
  " questionTypeLabel: questionTypeLabel, encouragement: encouragementFor," +
  " validate: validateQuestionPool, MODES: MODES, QUESTION_COUNT: QUESTION_COUNT," +
  " state: state, updateHomeTitle: updateHomeTitle," +
  " lbState: leaderboardState, lbApiMode: leaderboardApiMode, lbApiParams: leaderboardApiParams," +
  " lbDefaultLevel: defaultLeaderboardLevel, lbUserLevel: currentUserSchoolLevel," +
  " lbFormatDuration: formatSharedDuration, lbResetDefaults: resetLeaderboardDefaultFilters," +
  " switchLeaderboardView: switchLeaderboardView }";
var appLoadError = null;
try { globalThis.eval(appSrc); } catch (e) { appLoadError = "ERREUR : " + e; }
check("syntaxe JS valide (chargement app.js)", appLoadError === null, appLoadError || "");
var fu = appLoadError === null ? globalThis.__ct : null;

if (fu && fu.correction && I18N) {

  // --- 4. Paramètres et modes de calcul.
  I18N._setLocaleSync("fr");
  check("mode multiplication (fr)", fu.modeLabel("mult") === "Multiplications", fu.modeLabel("mult"));
  check("mode addition (fr)", fu.modeLabel("add") === "Additions", fu.modeLabel("add"));
  I18N._setLocaleSync("en");
  check("mode multiplication (en)", fu.modeLabel("mult") === "Multiplications", fu.modeLabel("mult"));
  check("mode addition (en)", fu.modeLabel("add") === "Additions", fu.modeLabel("add"));
  I18N._setLocaleSync("es");
  check("mode addition (es, libellé intact)", fu.MODES.add.label === "Additions", "");
  I18N._setLocaleSync("zh-Hans");
  check("libellé mode non vide (zh)", typeof fu.modeLabel("add") === "string" && fu.modeLabel("add").length > 0,
    "« " + fu.modeLabel("add") + " »");
  // Types de question.
  I18N._setLocaleSync("fr");
  check("type question classique (fr)", fu.questionTypeLabel("classic") === "Classique", "");
  check("type question à trou (fr)", fu.questionTypeLabel("hole") === "À trou", "");
  check("type question mélange (fr)", fu.questionTypeLabel("mixed") === "Mélange", "");


  // --- 9. Titre cohérent avec le mode, en fonction de LA langue.
  // Le titre d'accueil est dynamique (updateHomeTitle) : on vérifie que la clé
  // choisie dépend du mode ET que sa traduction change avec la langue.
  I18N._setLocaleSync("en");
  var enMult = I18N.t("home.subtitleMultiplication");
  var enAdd = I18N.t("home.subtitleAddition");
  check("sous-titre EN dépend du mode", enMult !== enAdd, "mult:« " + enMult + " » add:« " + enAdd + " »");
  check("sous-titre EN multiplications non vide", !!enMult && enMult.length > 0, "« " + enMult + " »");
  I18N._setLocaleSync("es");
  var esAdd = I18N.t("home.subtitleAddition");
  check("sous-titre ES additions cohérent (contient 'sumas')", esAdd.indexOf("sumas") !== -1, "« " + esAdd + " »");
  // Langue et mode sont deux dimensions indépendantes : tant qu'on reste en ZH,
  // les textes restent en chinois quel que soit le mode.
  I18N._setLocaleSync("zh-Hans");
  var zhMult = I18N.t("home.subtitleMultiplication");
  var zhAdd = I18N.t("home.subtitleAddition");
  check("mode ADD en ZH reste en chinois (dimension mode indépendante)",
    zhAdd.length > 0 && zhAdd.indexOf("加法") !== -1, "« " + zhAdd + " »");
  check("mode MULT en ZH reste en chinois (dimension mode indépendante)",
    zhMult.length > 0, "« " + zhMult + " »");

  // --- 9b. B2 (v12.8.1) : titre général d'accueil FIXE et multilingue.
  // Le nom général de l'application ne dépend PLUS de l'opération choisie ;
  // il ne dépend que de la langue active. On vérifie les QUATRE titres exacts,
  // que le titre visible et le titre d'onglet (doc.title) les utilisent, que
  // le mode (add/mult) et les changements de préférences ne le réécrivent pas.
  var fixedTitles = {
    "fr": "Coach Calcul",
    "en": "Calculation Trainer",
    "es": "Entrenador de Cálculo",
    "zh-Hans": "计算训练"
  };
  FILES.forEach(function (l) {
    check("titre général HOME (home.title) en « " + l + " » exact",
      flatCatalogs[l]["home.title"] === fixedTitles[l],
      "« " + flatCatalogs[l]["home.title"] + " »");
    check("titre d'onglet (doc.title) en « " + l + " » exact = home.title",
      flatCatalogs[l]["doc.title"] === fixedTitles[l],
      "« " + flatCatalogs[l]["doc.title"] + " »");
  });
  // Comportement : updateHomeTitle rend le MÊME titre en mult et en add.
  var savedMode = fu.state.config.mode;
  var subtitleMultHome, titleMultHome;
  fu.state.config.mode = "mult";
  fu.updateHomeTitle();
  titleMultHome = homeTitleEl.textContent;
  subtitleMultHome = homeSubtitleEl.textContent;
  var titleAddHome;
  fu.state.config.mode = "add";
  fu.updateHomeTitle();
  titleAddHome = homeTitleEl.textContent;
  check("accueil : le titre est IDENTIQUE en multiplications et additions",
    titleMultHome === titleAddHome && titleMultHome.length > 0,
    "« " + titleMultHome + " » vs « " + titleAddHome + " »");
  check("accueil : la description (sous-titre) reste DYNAMIQUE selon le mode",
    subtitleMultHome !== homeSubtitleEl.textContent && homeSubtitleEl.textContent.length > 0,
    "mult:« " + subtitleMultHome + " » add:« " + homeSubtitleEl.textContent + " »");
  // Changement de préférences (mode) → le titre n'est pas réécrit différemment.
  check("accueil : un changement de préférences (mode) ne change pas le titre général",
    homeTitleEl.textContent === titleMultHome, "« " + homeTitleEl.textContent + " »");
  // Retour à l'accueil / ré-affichage → le titre reste le nom général.
  I18N._setLocaleSync("fr");
  fu.state.config.mode = "mult";
  fu.updateHomeTitle();
  check("accueil : retour/ré-affichage conserve le titre général fixe",
    homeTitleEl.textContent === fixedTitles["fr"],
    "« " + homeTitleEl.textContent + " »");
  // Changement de langue → le titre est actualisé immédiatement (sans reload).
  fu.updateHomeTitle(); // s'assure que le titre courant est bien celui de la langue
  FILES.forEach(function (l) {
    I18N._setLocaleSync(l);
    fu.updateHomeTitle();
    check("accueil : changement de langue en « " + l + " » actualise le titre",
      homeTitleEl.textContent === fixedTitles[l],
      "« " + homeTitleEl.textContent + " »");
  });
  I18N._setLocaleSync("fr");
  fu.state.config.mode = savedMode;
  // Les sous-titres de mission (spécifiques au mode) restent DYNAMIQUES : ils
  // diffèrent entre add et mult dans chaque langue (clés distinctes conservées).
  FILES.forEach(function (l) {
    check("mission : sous-titres add/mult distincts et conservés (« " + l + " »)",
      flatCatalogs[l]["home.subtitleAddition"] !== flatCatalogs[l]["home.subtitleMultiplication"]
        && flatCatalogs[l]["home.subtitleAddition"].length > 0
        && flatCatalogs[l]["home.subtitleMultiplication"].length > 0,
      "add:« " + flatCatalogs[l]["home.subtitleAddition"] + " » mult:« " + flatCatalogs[l]["home.subtitleMultiplication"] + " »");
  });
  // Le titre général n'est plus construit à partir du libellé du mode (ni dans
  // le moteur i18n, ni dans le repli) : le repli utilise un nom fixe français.
  check("accueil : le repli sans i18n n'utilise PLUS le libellé du mode pour le titre",
    appSrc.indexOf('title.textContent = "Coach Calcul"') !== -1 &&
    appSrc.indexOf("`Mission ${modeLabel()`") === -1, "");
  // L'historique interne ne réécrit pas le titre avec une ancienne valeur au
  // retour sur l'accueil : updateHomeTitle s'appuie sur home.title (clé unique,
  // indépendante du mode) pour le <h1> de l'accueil.
  check("accueil : updateHomeTitle utilise une clé UNIQUE home.title pour le titre",
    appSrc.indexOf('title.textContent = I.t("home.title")') !== -1, "");

  // --- 5. Questions et corrections pédagogiques (toutes langues).
  function reveal(locale, v) {
    var label = I18N.t("feedback.answerReveal", null);
    return '<span class="answer-reveal" aria-label="' + label.replace("{value}", String(v)) + '">' + v + "</span>";
  }
  function expectCorrection(locale) {
    I18N._setLocaleSync(locale);
    var c = fu.correction({ a: 3, b: 6, mode: "mult" });
    check("correction multiplications (" + locale + ") : 18 révélé",
      c === "3 × 6 = " + reveal(locale, 18), c);
    var h = fu.correction({ a: 9, b: 15, mode: "add", hole: "b" });
    check("correction addition à trou (" + locale + ") : 15 révélé",
      h === "9 + " + reveal(locale, 15) + " = 24", h);
    check("affichage question (" + locale + ") : « ? » conservé",
      fu.display({ a: 3, b: 6, mode: "mult" }) === "3 × 6 = ?", "");
    check("computeAnswer (" + locale + ") : 3×6=18 et 12+30=42",
      fu.compute({ a: 3, b: 6, mode: "mult" }) === 18 && fu.compute({ a: 12, b: 30, mode: "add" }) === 42, "");
  }
  ["fr", "en", "es", "zh-Hans"].forEach(expectCorrection);

  // --- 6. Résultats et encouragements (toutes langues).
  function expectEncouragement(locale) {
    I18N._setLocaleSync(locale);
    check("encouragement parfait (" + locale + ")", fu.encouragement(10).length > 0, "« " + fu.encouragement(10) + " »");
    check("encouragement continuer (" + locale + ")", fu.encouragement(2).length > 0, "« " + fu.encouragement(2) + " »");
    check("encouragement parfait != continuer (" + locale + ")",
      fu.encouragement(10) !== fu.encouragement(2), "");
  }
  ["fr", "en", "es", "zh-Hans"].forEach(expectEncouragement);
  // scoreLine : les variables {message}/{score}/{total}/{time} sont interpolées.
  I18N._setLocaleSync("fr");
  var sl = I18N.t("result.scoreLine", { message: "Bravo", score: 9, total: 10, time: 8.0 });
  check("scoreLine interpolé (fr), variables préservées",
    sl.indexOf("Bravo") === 0 && sl.indexOf("9/10") !== -1 && sl.indexOf("8") !== -1,
    "« " + sl + " »");


  // --- 7. Pluriels.
  check("config.tableTitle {table} interpolé", I18N.t("config.tableTitle", { table: 3 }) === "Table de 3",
    "« " + I18N.t("config.tableTitle", { table: 3 }) + " »");
  // mission.rangeTooSmall : pluriel One/Other selon la taille de plage.
  var oneMsg = I18N.pl("mission.rangeTooSmall", 1, { min: 1, max: 1 });
  var otherMsg = I18N.pl("mission.rangeTooSmall", 5, { min: 1, max: 5 });
  check("rangeTooSmall pluriel : One (1) ≠ Other (5)",
    oneMsg.indexOf("un calcul") !== -1 && otherMsg.indexOf("5 calculs") !== -1,
    "one:« " + oneMsg + " » other:« " + otherMsg + " »");
  // result.rewardPartial : One/Other selon les pièces restantes.
  var rOne = I18N.pl("result.rewardPartial", 1, { score: 9, total: 10, remaining: 1 });
  var rOther = I18N.pl("result.rewardPartial", 4, { score: 6, total: 10, remaining: 4 });
  check("rewardPartial pluriel : reste 1 pièce ≠ reste 4 pièces",
    rOne.indexOf("1 pièce") !== -1 && rOther.indexOf("4 pièces") !== -1,
    "one:« " + rOne + " » other:« " + rOther + " »");

  // --- 8. Classements et tableau des scores.
  check("leaderboard.headline {mode} (fr)",
    I18N.t("leaderboard.headline", { mode: "Multiplications" }) === "Top 20 — Multiplications",
    "« " + I18N.t("leaderboard.headline", { mode: "Multiplications" }) + " »");
  I18N._setLocaleSync("en");
  check("leaderboard colonnes (en)", I18N.t("leaderboard.columnName") === "First name" &&
    I18N.t("leaderboard.columnScore") === "Score", "");
  I18N._setLocaleSync("es");
  check("leaderboard Oui/Non (es)",
    I18N.t("leaderboard.yes") === "Sí" && I18N.t("leaderboard.no") === "No",
    "« " + I18N.t("leaderboard.yes") + " »/« " + I18N.t("leaderboard.no") + " »");
  I18N._setLocaleSync("fr");
  check("leaderboard holeMode {mode} (fr)",
    I18N.t("leaderboard.holeMode", { mode: "À trou" }).indexOf("À trou") !== -1,
    "« " + I18N.t("leaderboard.holeMode", { mode: "À trou" }) + " »");

  // --- 10. Actualisation après changement de langue (sans relancer la partie).
  I18N._setLocaleSync("es");
  var esSubAdd = I18N.t("home.subtitleAddition");
  I18N._setLocaleSync("fr");
  var frSubAdd = I18N.t("home.subtitleAddition");
  check("changement de langue : sous-titre MAJ sans toucher à la partie",
    esSubAdd.length > 0 && frSubAdd.length > 0 && esSubAdd !== frSubAdd,
    "es:« " + esSubAdd + " » fr:« " + frSubAdd + " »");
  // L'avertissement de plage est régénéré dans la langue courante, et son calcul
  // de dimensionnement (pool) n'est pas modifié par la langue.
  fu.state.config.mode = "add";
  fu.state.config.add = { min: 1, max: 2 }; // plage < 10 calculs distincts
  I18N._setLocaleSync("fr");
  var frWarn = fu.validate();
  check("avertissement plage addition (fr)", typeof frWarn === "string" && frWarn.length > 0, "« " + frWarn + " »");
  I18N._setLocaleSync("zh-Hans");
  var zhWarn = fu.validate();
  check("avertissement plage addition (zh) actualisé",
    typeof zhWarn === "string" && zhWarn.length > 0 && zhWarn !== frWarn, "« " + zhWarn + " »");
  fu.state.config.mode = "mult";
  check("calcul inchangé après changement de langue", fu.compute({ a: 4, b: 7, mode: "mult" }) === 28, "");

  // --- 11. Préservation des variables (mêmes variables par clé, 4 langues).
  var vcheck = true;
  ["mission.questionProgress", "mission.rocketCount", "leaderboard.headline",
   "leaderboard.holeMode", "config.tableTitle", "result.scoreLine", "result.rewardPartial",
   "mission.rangeTooSmall"].forEach(function (k) {
    var frVars = varsOf(frFlat[k]);
    FILES.forEach(function (l) {
      if (varsOf(flatCatalogs[l][k]) !== frVars) vcheck = false;
    });
  });
  check("variables d'interpolation identiques sur les clés d'interface", vcheck, "");

  // --- 12. Aucune régression du calcul / de l'entraînement adaptatif (aides pures).
  check("compteur de questions = 10", fu.QUESTION_COUNT === 10, String(fu.QUESTION_COUNT));
  check("computeAnswer multiplication", fu.compute({ a: 9, b: 9, mode: "mult" }) === 81, "");
  check("computeAnswer addition", fu.compute({ a: 1, b: 1, mode: "add" }) === 2, "");
  check("correction ne modifie pas le résultat attendu (révèle seulement 30)",
    fu.correction({ a: 5, b: 6, mode: "mult" }).indexOf("30") !== -1, "");
  check("le moteur i18n reste opérationnel", typeof I18N.t === "function", "");

  // --- 13. B4.2 — Interface des classements partagés. ---
  // Filtre par défaut selon le compte courant (invité / sans niveau / déclaré).
  window.MissionGuestHistory = null;
  check("invité -> niveau par défaut 'unspecified'", fu.lbDefaultLevel() === "unspecified", fu.lbDefaultLevel());
  window.MissionGuestHistory = { hasSession: true, currentUser: { login: "alice", role: "user", school_level: null } };
  check("compte sans niveau -> 'unspecified'", fu.lbDefaultLevel() === "unspecified", fu.lbDefaultLevel());
  window.MissionGuestHistory = { hasSession: true, currentUser: { login: "bob", role: "user", school_level: "elementary_upper" } };
  check("compte avec niveau -> niveau déclaré", fu.lbDefaultLevel() === "elementary_upper", fu.lbDefaultLevel());
  // Bascule partagée par défaut + conservation du niveau du compte au reset.
  fu.lbState.schoolLevel = "all"; fu.lbState.view = "local";
  fu.lbResetDefaults();
  check("ouverture : vue partagée par défaut", fu.lbState.view === "shared", fu.lbState.view);
  check("reset : niveau du compte conservé", fu.lbState.schoolLevel === "elementary_upper", fu.lbState.schoolLevel);
  check("reset : type de questions classique par défaut", fu.lbState.questionType === "classic", fu.lbState.questionType);
  // Conversion mode interne -> API et paramètres d'appel.
  check("mode mult -> API 'multiplication'", fu.lbApiMode("mult") === "multiplication", fu.lbApiMode("mult"));
  check("mode add -> API 'addition'", fu.lbApiMode("add") === "addition", fu.lbApiMode("add"));
  fu.lbState.mode = "add"; fu.lbState.schoolLevel = "all"; fu.lbState.questionType = "mixed";
  var lbp = fu.lbApiParams();
  check("params API : mode addition", lbp.mode === "addition", String(lbp.mode));
  check("params API : school_level all", lbp.school_level === "all", String(lbp.school_level));
  check("params API : question_type mixed", lbp.question_type === "mixed", String(lbp.question_type));
  check("params API : limit 20", lbp.limit === 20, String(lbp.limit));
  fu.lbState.mode = "mult"; fu.lbState.schoolLevel = "unspecified"; fu.lbState.questionType = "classic";
  // Format de durée (conversion ms -> secondes, et durée inconnue).
  check("durée 38000 ms -> 38.0 s", fu.lbFormatDuration(38000) === "38.0 s", fu.lbFormatDuration(38000));
  check("durée 45000 ms -> 45.0 s", fu.lbFormatDuration(45000) === "45.0 s", fu.lbFormatDuration(45000));
  check("durée null -> tiret", fu.lbFormatDuration(null) === "—", fu.lbFormatDuration(null));
  // Consultation des scores locaux sans appel serveur (B4.2, vue locale).
  var apiCalls = 0;
  window.AccountUI = { api: function () { apiCalls++; return Promise.resolve({ ok: false, data: null }); } };
  fu.switchLeaderboardView("local");
  check("scores locaux : aucun appel serveur", apiCalls === 0 && fu.lbState.view === "local", "calls=" + apiCalls);
  fu.switchLeaderboardView("shared");
  check("bascule partagé : vue partagée + appel serveur", apiCalls === 1 && fu.lbState.view === "shared", "calls=" + apiCalls);
  // Affichage sécurisé : display_name inséré via textContent, jamais innerHTML.
  check("XSS : display_name rendu via textContent",
    /name\.textContent\s*=\s*String\(\(entry\s*&&\s*entry\.display_name\)/.test(appSrc), "");
  // Anti-réponses obsolètes : le chargement compare l'identifiant de requête.
  check("anti-réponses obsolètes : garde requestId présente",
    /requestId\s*!==\s*leaderboardState\.requestId/.test(appSrc) &&
    /\+\+leaderboardState\.requestId/.test(appSrc), "");
  // Actualisation à chaque nouvelle ouverture (showLeaderboard réinitialise).
  check("réinitialisation à chaque ouverture présent dans showLeaderboard",
    /function showLeaderboard\(\)[\s\S]{0,400}resetLeaderboardDefaultFilters\(\)/.test(appSrc), "");
  // Clés B4.2 présentes et cohérentes dans les quatre catalogues.
  ["shared", "local", "viewSwitch", "levelFilter", "typeFilter", "levelAll",
   "sharedLoading", "sharedEmpty", "sharedError", "columnRank", "columnPlayer"].forEach(function (k) {
    var pres = true;
    FILES.forEach(function (l) {
      if (typeof flatCatalogs[l]["leaderboard." + k] !== "string") pres = false;
    });
    check("clé B4.2 leaderboard." + k + " présente dans les 4 langues", pres, "");
  });
}
function varsOf(str) {
  var re = /\{([^{}]+)\}/g, mm, list = [];
  while ((mm = re.exec(str)) !== null) list.push(mm[1]);
  return list.sort().join(",");
}


// ---- Bilan ----
var passed = 0, failed = 0;
results.forEach(function (r) { if (r.ok) { passed++; } else { failed++; } });
var lines = ["JS i18n interface principale (v12.6-B3.1) : " + passed + " réussis, " + failed + " échoués"];
results.forEach(function (r) {
  lines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.detail ? " — " + r.detail : ""));
});
var summary = lines.join("\n");
if (failed === 0) {
  summary += "\nRESULT:PASS";
} else {
  summary += "\nRESULT:FAIL";
  $.NSLog("%@", summary.replace(/\n/g, " | "));
  throw new Error("Échec des tests i18n interface principale (" + failed + " vérification(s))");
}
summary;

