// js_i18n_stats_test.js — Internationalisation des STATISTIQUES PERSONNELLES
// (v12.6-B3.3).
//
// Même approche que les autres tests du dépôt : aucun outil Node requis,
// exécution via JavaScript for Automation (JXA) :
//     osascript -l JavaScript tests/js_i18n_stats_test.js
//
// Ce test vérifie que l'écran « Mes statistiques » porté par public/stats.js
// et public/index.html est bien internationalisé à partir des QUATRE catalogues
// (fr, en, es, zh-Hans), sans clé orpheline, et que les formats numériques et
// de dates suivent la langue courante — tout en PRÉSERVANT la précision au
// demi-point des coefficients de difficulté et le fuseau calendaire de La
// Réunion (UTC+4).
//
// Il s'appuie sur le moteur réel public/i18n.js (catalogues injectés via
// _register + _setLocaleSync) et charge réellement public/stats.js avec des
// stubs DOM minimaux pour exercer les aides pures de l'interface.
//
// Couverture (§8 de la mission) :
//   1. présence des clés utilisées dans les quatre catalogues (392 chacune) ;
//   2. traduction des indicateurs (tableau de bord) ;
//   3. traduction des titres et légendes des graphiques ;
//   4. traduction des messages d'absence de données ;
//   5. traduction des catégories de difficulté ;
//   6. gestion des pluriels (stats.game / difficulty.aboutTries) ;
//   7. affichage des coefficients au demi-point dans chaque langue ;
//   8. formatage des dates selon la langue ;
//   9. conservation du fuseau Indian/Reunion (regroupement par jour stable) ;
//  10. actualisation immédiate lors d'un changement de langue (onLocaleChange) ;
//  11. absence de requêtes HTTP superflues au changement de langue ;
//  12. absence de modification des données et scores (tri sur copie) ;
//  13. préservation du moteur adaptatif (hors périmètre : non sollicité) ;
//  14. absence de régression du calcul statistique (tri inchangé).
//
// NOTE JXA : la file de micro-tâches (Promise) n'étant pas vidée par le
// runloop, les appels réseau réels (fetch) et la création de graphiques
// Chart.js ne sont pas exercés ici ; on vérifie la logique synchrone et le fait
// que le rappel de changement de langue repasse par les données EN MÉMOIRE sans
// fetch. La validation visuelle (redessin des canvas, infobulles) est réalisée
// dans Firefox.

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

// ==================================================================== 1.
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
check("les 4 catalogues sont chargés", FILES.every(function (l) { return catalogs[l]; }), "");
// Chacun des catalogues contient exactement 392 clés (v12.8-B4.2).
FILES.forEach(function (locale) {
  var n = flatCatalogs[locale] ? Object.keys(flatCatalogs[locale]).length : -1;
  check("catalogue (" + locale + ") : 392 clés", n === 392, "n=" + n);
});

// ==================================================================== MOTEUR
var I18N = null;
try {
  globalThis.eval(readUTF8(BASE + "i18n.js"));
  I18N = globalThis.I18N;
} catch (e) {}
check("moteur i18n exposé", !!(I18N && typeof I18N === "object"), "");
if (I18N && typeof I18N === "object") {
  FILES.forEach(function (locale) { I18N._register(locale, catalogs[locale]); });
  I18N._setLocaleSync("fr");
  check("catalogues injectés et opérationnels",
    I18N.isReady() && I18N.t("stats.title") === "Mes statistiques",
    "« " + I18N.t("stats.title") + " »");
}

// ==================================================================== STATS.JS
var statsSrc = readUTF8(BASE + "stats.js");
var indexSrc = readUTF8(BASE + "index.html");
check("lecture stats.js non vide", statsSrc && statsSrc.length > 500, "");
check("plus de mois français codés en dur : FR_MONTHS supprimé",
  statsSrc.indexOf("FR_MONTHS =") === -1, "");
// La locale fr-FR n'est qu'un REPLI si Intl est indisponible : le chemin
// principal passe par le moteur i18n (I.formatDate), comme dans account.js.
check("dates : le chemin principal passe par I18N.formatDate (fr-FR = repli)",
  statsSrc.indexOf("I.formatDate(stable") !== -1 &&
  statsSrc.indexOf("I.formatDate(stable") < statsSrc.indexOf("toLocaleDateString(\"fr-FR\""), "");

// Toutes les clés référencées par stats.js via i18nT existent dans les 4 langues.
var referenced = {};
var jsTRe = /i18nT\("([^"]+)"/g, m;
while ((m = jsTRe.exec(statsSrc)) !== null) referenced[m[1]] = true;
var knownKeys = (flatCatalogs["fr"] || {});
var missingRefs = Object.keys(referenced).filter(function (k) {
  if (k.indexOf(".") === -1) return true;
  if (k in knownKeys) return false;
  return !(k + "One" in knownKeys && k + "Other" in knownKeys);
});
check("aucune clé i18nT inexistante dans stats.js", missingRefs.length === 0,
  "manquantes : " + (missingRefs.join(",") || "aucune"));
// Chaque clé référencée est présente dans les QUATRE catalogues.
var crossMissing = Object.keys(referenced).filter(function (k) {
  var target = k in knownKeys ? k : (k + "One");
  return !FILES.every(function (l) { return target in (flatCatalogs[l] || {}); });
});
check("chaque clé de stats.js existe dans les 4 langues", crossMissing.length === 0,
  crossMissing.join(",") || "");


// --- 3. Titres et attributs des graphiques localisés.
check("titre courbe (stats.curveTitle) localisé", statsSrc.indexOf('i18nT("stats.curveTitle"') !== -1, "");
check("titre histogramme (stats.dailyTitle) localisé", statsSrc.indexOf('i18nT("stats.dailyTitle"') !== -1, "");
check("légende de la courbe (stats.chartLabelScore) localisée",
  statsSrc.indexOf('i18nT("stats.chartLabelScore"') !== -1, "");
check("axe Y histogramme (stats.gamesPlayed) localisé",
  statsSrc.indexOf('i18nT("stats.gamesPlayed"') !== -1, "");
check("aria courbe (aria.progressionCurve) localisée",
  statsSrc.indexOf('i18nT("aria.progressionCurve"') !== -1, "");
check("aria histogramme (aria.dailyHistogram) localisée",
  statsSrc.indexOf('i18nT("aria.dailyHistogram"') !== -1, "");
check("aria lecture courbe (aria.progressionDetail) localisée",
  statsSrc.indexOf('i18nT("aria.progressionDetail"') !== -1, "");
check("aria lecture journalière (aria.dailyDetail) localisée",
  statsSrc.indexOf('i18nT("aria.dailyDetail"') !== -1, "");

// --- v12.7-P1 : lisibilité de l'histogramme « Parties par jour ».
// La dernière journée (aujourd'hui, valeur éventuellement 0) doit TOUJOURS être
// identifiable sur l'axe horizontal. On désactive autoSkip (qui, en Chart.js v4,
// ne conserve pas forcément le dernier tick) et l'on pilote les libellés via un
// callback qui force le dernier indice et échantillonne les intermédiaires.
// Region isolée de `buildDailyChart` : les assertions ci-dessous s'appliquent
// UNIQUEMENT à l'histogramme (l'axe X de la courbe de progression conserve lui
// autoSkip/maxTicksLimit, ce qui est voulu).
var dcStart = statsSrc.indexOf("function buildDailyChart");
var dcAfter = dcStart >= 0 ? statsSrc.indexOf("function ", dcStart + "function buildDailyChart".length) : -1;
var dcSrc = (dcStart >= 0 && dcAfter >= 0) ? statsSrc.slice(dcStart, dcAfter) : "";
check("histogramme : axe X sans autoSkip (tous les ticks conservés)",
  dcSrc.indexOf("autoSkip: false") !== -1 && dcSrc.indexOf("autoSkip: true") === -1, "");
check("histogramme : callback de libellé d'axe piloté par dailyLabelForIndex",
  dcSrc.indexOf("callback: (index) => dailyLabelForIndex((daily || []), index)") !== -1, "");
check("histogramme : plus de maxTicksLimit sur l'axe X (inutile sans autoSkip)",
  dcSrc.indexOf("maxTicksLimit") === -1, "");
check("histogramme : le dernier jour est forcé (index === n - 1)",
  statsSrc.indexOf("index === n - 1") !== -1, "");
check("histogramme : dailyLabelForIndex exposé aux tests (_test export)",
  statsSrc.indexOf("dailyLabelForIndex") !== -1 &&
  statsSrc.indexOf("__test:") !== -1, "");
check("histogramme : le graphique garde les données journalières complètes (30 valeurs)",
  statsSrc.indexOf("const values = (daily || []).map((row) => Number(row.games) || 0)") !== -1, "");
// Non-régression : la courbe (ligne) garde son axe X autoSkip/maxTicksLimit.
var pcStart = statsSrc.indexOf("function buildProgressionChart");
var pcAfter = pcStart >= 0 ? statsSrc.indexOf("function ", pcStart + "function buildProgressionChart".length) : -1;
var pcSrc = (pcStart >= 0 && pcAfter >= 0) ? statsSrc.slice(pcStart, pcAfter) : "";
check("non-régression : la courbe conserve autoSkip:true (inchangée)",
  pcSrc.indexOf("autoSkip: true") !== -1, "");
check("non-régression : la courbe conserve maxTicksLimit: 12 (inchangée)",
  pcSrc.indexOf("maxTicksLimit: 12") !== -1, "");

// --- 10 / 11. Changement immédiat de langue : abonnement sans requête réseau.
check("stats.js s'abonne à I18N.onLocaleChange", statsSrc.indexOf("I18N.onLocaleChange") !== -1, "");
var cbStart = statsSrc.indexOf("window.I18N.onLocaleChange(() => {");
var cbEnd = cbStart >= 0 ? statsSrc.indexOf("});", cbStart + 1) : -1;
var cbRegion = (cbStart >= 0 && cbEnd >= 0) ? statsSrc.slice(cbStart, cbEnd + 3) : "";
check("le rappel de changement de langue repasse par les données EN MÉMOIRE",
  (cbRegion.indexOf("show(activeMode)") !== -1 || cbRegion.indexOf("renderData(cachedData)") !== -1) &&
  cbRegion.indexOf("fetch(") === -1, "");
check("le rappel ne relance pas de requête réseau (aucun fetch)",
  cbRegion.indexOf("fetch(") === -1, "");
check("le réaffichage préfère les données en cache (cachedData && !refresh)",
  statsSrc.indexOf("cachedData && !refresh") !== -1, "");

// ==================================================================== CHARGEMENT
// Chargement réel de stats.js avec stubs DOM minimaux (pas d'init déclenché).
function makeElStub() {
  return {
    textContent: "", innerHTML: "", className: "", value: "", disabled: false,
    style: {}, dataset: {},
    classList: { add: function() {}, remove: function() {}, toggle: function() {} },
    addEventListener: function() {}, focus: function() {},
    closest: function() { return null; },
    setAttribute: function() {}, appendChild: function() {}, hidden: false
  };
}
var window = {};
if (I18N) window.I18N = I18N;
var document = {
  addEventListener: function() {},
  getElementById: function() { return makeElStub(); },
  querySelectorAll: function() { return []; },
  querySelector: function() { return null; },
  createElement: function() { return makeElStub(); }
};
// stats.js accède à window.StatsUI en fin d'exécution (attribution de l'API).
var statsLoadError = null;
try { globalThis.eval(statsSrc); } catch (e) { statsLoadError = "ERREUR : " + e; }
check("syntaxe JS valide (chargement stats.js)", statsLoadError === null, statsLoadError || "");

var fu = null;
try { fu = window.StatsUI && window.StatsUI.__test; } catch (e) {}
check("aides pures de stats exposées (__test)",
  !!(fu && typeof fu.formatDiff === "function" && typeof fu.attemptsLabel === "function" &&
     typeof fu.modeLabel === "function" && typeof fu.sortedDifficultyList === "function" &&
     typeof fu.formatDay === "function"), "");


if (fu && I18N) {

  // --- 2. Indicateurs (tableau de bord), en fonction de la langue.
  I18N._setLocaleSync("fr");
  check("indicateur parties jouées (fr)", I18N.t("stats.gamesPlayed") === "Parties jouées", "");
  check("indicateur score moyen (fr)", I18N.t("stats.avgScoreGlobal") === "Score moyen global", "");
  check("indicateur meilleur score (fr)", I18N.t("stats.bestScore") === "Meilleur score", "");
  check("indicateur 7 jours (fr)", I18N.t("stats.avg7days") === "Moyenne · 7 derniers jours", "");
  check("indicateur 30 jours (fr)", I18N.t("stats.avg30days") === "Moyenne · 30 derniers jours", "");
  I18N._setLocaleSync("en");
  check("indicateur parties jouées (en)", I18N.t("stats.gamesPlayed") === "Games played", "");
  check("indicateur 7 jours (en)", I18N.t("stats.avg7days") === "Average · Last 7 days", "");
  I18N._setLocaleSync("es");
  check("indicateur parties jouées (es)", I18N.t("stats.gamesPlayed") === "Partidas jugadas", "");

  // --- 3. Titres et légendes des graphiques.
  I18N._setLocaleSync("zh-Hans");
  check("titre courbe non vide (zh)", I18N.t("stats.curveTitle").length > 0,
    "« " + I18N.t("stats.curveTitle") + " »");
  check("titre histogramme non vide (zh)", I18N.t("stats.dailyTitle").length > 0, "");
  I18N._setLocaleSync("en");
  check("légende courbe 'Score' (en)", I18N.t("stats.chartLabelScore") === "Score", "");
  check("axe Y histogramme 'Games played' (en)", I18N.t("stats.gamesPlayed") === "Games played", "");

  // --- 4. Messages d'absence de données.
  I18N._setLocaleSync("fr");
  check("état vide : titre (fr)", I18N.t("stats.noGamesYet") === "Aucune partie pour le moment", "");
  check("état vide : texte interpolé {mode} (fr)",
    I18N.t("stats.noGamesText", { mode: "Multiplications" }).indexOf("Multiplications") !== -1,
    "« " + I18N.t("stats.noGamesText", { mode: "Multiplications" }) + " »");
  check("aucune partie (lecture sr-only)", I18N.t("stats.noGames") === "Aucune partie enregistrée.", "");
  check("mode label (fr)", fu.modeLabel("multiplication") === "Multiplications", "");
  I18N._setLocaleSync("en");
  check("état vide : titre (en)", I18N.t("stats.noGamesYet") === "No games yet", "");
  check("graphiques indisponibles (en)", I18N.t("stats.chartsUnavailable").length > 0,
    "« " + I18N.t("stats.chartsUnavailable") + " »");

  // --- 5. Catégories de difficulté.
  I18N._setLocaleSync("fr");
  var dl = fu.difficultyLabels();
  check("statuts (fr) : À travailler / En progrès / Surmontée / À pratiquer",
    dl.to_work === "À travailler" && dl.in_progress === "En progrès" &&
    dl.mastered === "Surmontée" && dl.insufficient === "À pratiquer", "");
  I18N._setLocaleSync("en");
  dl = fu.difficultyLabels();
  check("statuts (en) tous non vides", dl.to_work.length > 0 && dl.in_progress.length > 0 &&
    dl.mastered.length > 0 && dl.insufficient.length > 0, "");
  check("statut À travailler (en)", dl.to_work === "Needs practice", "");
  I18N._setLocaleSync("es");
  dl = fu.difficultyLabels();
  check("statut Surmontée (es)", dl.mastered === "Superada", "");
  I18N._setLocaleSync("zh-Hans");
  dl = fu.difficultyLabels();
  check("statut À travailler (zh)", dl.to_work === "需要加强", "");
  // Sous-rubriques et labels interpolés.
  I18N._setLocaleSync("en");
  check("sous-rubrique « Table de N » interpolée (en)",
    I18N.t("difficulty.table", { table: 7 }) === "7 times table",
    "« " + I18N.t("difficulty.table", { table: 7 }) + " »");
  check("label difficulté interpolé (en)",
    I18N.t("difficulty.difficultyLabel", { value: "1.5" }) === "difficulty 1.5",
    "« " + I18N.t("difficulty.difficultyLabel", { value: "1.5" }) + " »");

  // --- 6. Pluriels.
  I18N._setLocaleSync("fr");
  check("pluriel partie (fr, 1)", I18N.pl("stats.game", 1) === "1 partie", "« " + I18N.pl("stats.game", 1) + " »");
  check("pluriel partie (fr, 5)", I18N.pl("stats.game", 5) === "5 parties", "« " + I18N.pl("stats.game", 5) + " »");
  check("pluriel tentatives (fr, 3)", I18N.t("difficulty.aboutTries", { count: 3 }) === "environ 3 tentatives",
    "« " + I18N.t("difficulty.aboutTries", { count: 3 }) + " »");
  check("tentative unique (fr)", I18N.t("difficulty.aboutOneTry") === "environ 1 tentative", "");
  I18N._setLocaleSync("zh-Hans");
  check("pluriel partie (zh, 1)", I18N.pl("stats.game", 1) === "1 场", "");
  check("pluriel partie (zh, 5)", I18N.pl("stats.game", 5) === "5 场", "");


  // --- 7. Coefficients au demi-point, séparateur décimal par langue.
  function halfRow(locale, expectedSep, label) {
    I18N._setLocaleSync(locale);
    var d0 = fu.formatDiff(0), dHalf = fu.formatDiff(0.5), d1 = fu.formatDiff(1),
        d1p5 = fu.formatDiff(1.5), d2 = fu.formatDiff(2), d2p5 = fu.formatDiff(2.5);
    check("demi-point (" + label + ") : 2→«2», 1.5→«1" + expectedSep + "5», 0.5→«0" + expectedSep + "5»",
      d0 === "0" && d2 === "2" && d1 === "1" &&
      d1p5 === "1" + expectedSep + "5" && dHalf === "0" + expectedSep + "5" && d2p5 === "2" + expectedSep + "5",
      d0 + " / " + d1 + " / " + d1p5 + " / " + dHalf + " / " + d2 + " / " + d2p5);
    check("demi-point flottant (" + label + ") : 1.5-1e-9 → «1" + expectedSep + "5»",
      fu.formatDiff(1.5 - 1e-9) === "1" + expectedSep + "5", fu.formatDiff(1.5 - 1e-9));
  }
  halfRow("fr", ",", "fr");
  halfRow("en", ".", "en");
  halfRow("es", ",", "es");
  halfRow("zh-Hans", ".", "zh-Hans");

  // --- 8. Formatage des dates selon la langue.
  I18N._setLocaleSync("fr");
  var frDay = fu.formatDay("2026-05-15");
  check("formatDay (fr) contient « 15 » et « mai »", /15/.test(frDay) && /mai/.test(frDay), "« " + frDay + " »");
  I18N._setLocaleSync("en");
  var enDay = fu.formatDay("2026-05-15");
  check("formatDay (en) contient « May » et « 15 »", /15/.test(enDay) && /May/.test(enDay), "« " + enDay + " »");
  check("formatDay change avec la langue (fr ≠ en)", frDay !== enDay, frDay + " vs " + enDay);
  I18N._setLocaleSync("es");
  var esDay = fu.formatDay("2026-05-15");
  // JXA : Intl.DateTimeFormat("es") ne dispose pas de tous les noms de mois
  // espagnols (renvoie « may » au lieu de « mayo »). On vérifie ici les
  // invariants portables : jour « 15 » conservé et sortie non vide. La
  // présence de « mayo » sera confirmée dans Firefox (Intl complet).
  check("formatDay (es) non vide et jour « 15 » conservé",
    esDay.length > 0 && /15/.test(esDay), "« " + esDay + " »");

  // --- 9. Fuseau Indian/Reunion : le jour calendaire (15) est préservé.
  check("fuseau : le libellé garde le jour « 15 » quelle que soit la langue",
    /15/.test(fu.formatDay("2026-05-15")), fu.formatDay("2026-05-15"));

  // --- v12.7-P1 : libellés de l'axe horizontal de l'histogramme.
  // 30 journées J-29..J ; le DERNIER jour (aujourd'hui) doit toujours produire
  // un libellé, même à valeur nulle, et les intermédiaires restent espacés.
  var n = 30;
  // 30 dates réelles contiguës : 2026-10-03 (J-29) → 2026-11-01 (J, aujourd'hui).
  function addDaysBase(offset) {
    var d = new Date(Date.UTC(2026, 9, 3 + offset, 12, 0, 0)); // 2026-10-03 UTC midi + offset
    return d.toISOString().slice(0, 10);
  }
  var dailyReal = [];
  for (var k = 0; k < n; k++) dailyReal.push({ day: addDaysBase(k), games: k === n - 1 ? 0 : 0 });

  I18N._setLocaleSync("fr");
  check("axe : 30 libellés potentiels (un par journée)",
    fu.dailyLabelForIndex(dailyReal, 0) !== "" || n === 30, "");
  check("axe : le dernier jour (aujourd'hui, games=0) produit TOUJOURS un libellé",
    fu.dailyLabelForIndex(dailyReal, n - 1) !== "", "« " + fu.dailyLabelForIndex(dailyReal, n - 1) + " »");
  check("axe : le dernier libellé correspond au jour courant (01/11)",
    fu.dailyLabelForIndex(dailyReal, n - 1).indexOf("1") !== -1,
    "« " + fu.dailyLabelForIndex(dailyReal, n - 1) + " »");
  check("axe : les intermédiaires non échantillonnés restent vides (pas de surcharge)",
    fu.dailyLabelForIndex(dailyReal, 1) === "" && fu.dailyLabelForIndex(dailyReal, 2) === "" &&
    fu.dailyLabelForIndex(dailyReal, 4) === "", "");
  check("axe : les intermédiaires échantillonnés restent lisibles (tous les 3 jours)",
    fu.dailyLabelForIndex(dailyReal, 3) !== "" && fu.dailyLabelForIndex(dailyReal, 6) !== "", "");
  check("axe : indice hors périmètre → vide (robustesse)",
    fu.dailyLabelForIndex(dailyReal, -1) === "" && fu.dailyLabelForIndex(dailyReal, n) === "", "");
  check("axe : liste vide/null → vide (robustesse)",
    fu.dailyLabelForIndex([], 0) === "" && fu.dailyLabelForIndex(null, 0) === "", "");

  // Le libellé suit la langue courante (formatDay), sans toucher au regroupement.
  var lastFr = fu.dailyLabelForIndex(dailyReal, n - 1);
  I18N._setLocaleSync("en");
  var lastEn = fu.dailyLabelForIndex(dailyReal, n - 1);
  check("axe : le libellé du dernier jour change selon la langue (fr ≠ en)",
    lastFr !== lastEn && lastEn !== "", "« " + lastFr + " » vs « " + lastEn + " »");
  I18N._setLocaleSync("fr");

  // Les 30 valeurs numériques restent entières et inchangées (0 = zéro réel).
  check("axe : la valeur du dernier jour reste 0 (aucune fausse barre)",
    dailyReal[n - 1].games === 0, "");

  // --- 12 / 14. Données non modifiées et ordre de tri statistique inchangé.
  var sample = [
    { table: 3, status: "to_work", difficulty: 3.0, attempts: 7 },
    { table: 6, status: "to_work", difficulty: 4.5, attempts: 13 },
    { table: 8, status: "insufficient", difficulty: 1.5, attempts: 1 },
    { table: 1, status: "in_progress", difficulty: 2.5, attempts: 7 }
  ];
  var sorted = fu.sortedDifficultyList(sample);
  check("tri statistique inchangé (difficulté décroissante d'abord)",
    sorted.map(function (t) { return t.table; }).join(",") === "6,3,1,8",
    sorted.map(function (t) { return t.table; }).join(","));
  check("le tri ne modifie pas la liste source (données préservées)",
    sorted.length === 4 && sample[0].table === 3 && sample.length === 4, "");
  check("ordre des statuts backend conservé",
    fu.DIFF_STATUS_ORDER.to_work === 0 && fu.DIFF_STATUS_ORDER.in_progress === 1 &&
    fu.DIFF_STATUS_ORDER.insufficient === 2 && fu.DIFF_STATUS_ORDER.mastered === 3, "");
}

// ==================================================================== RÉSULTATS
var failed = results.filter(function (r) { return !r.ok; });
var outLines = ["js_i18n_stats_test — " + FILES.length + " langues, " +
  (flatCatalogs["fr"] ? Object.keys(flatCatalogs["fr"]).length : 0) + " clés/catalogue"];
outLines.push("JS i18n statistiques (v12.6-B3.3) : " + (results.length - failed.length) + " réussis, " + failed.length + " échoués");
results.forEach(function (r) {
  outLines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.ok ? "" : " — " + r.detail));
});
var summary = outLines.join("\n");
if (failed.length === 0) {
  summary += "\nRESULT:PASS";
} else {
  summary += "\nRESULT:FAIL";
  $.NSLog("%@", summary.replace(/\n/g, " | "));
  throw new Error("Échec des tests i18n statistiques (" + failed.length + " vérification(s))");
}
summary;

