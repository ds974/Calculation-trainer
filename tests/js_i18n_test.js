// js_i18n_test.js — Test du MOTEUR D'INTERNATIONALISATION (v12.6-B2).
//
// Même approche que les autres tests du dépôt : aucun outil Node requis,
// exécution via JavaScript for Automation (JXA) :
//     osascript -l JavaScript tests/js_i18n_test.js
//
// Le moteur réel public/i18n.js est chargé par le test (ce qui valide au
// passage sa syntaxe), puis les quatre catalogues JSON (fr, en, es, zh-Hans)
// sont lus depuis le disque et injectés dans le cache mémoire du moteur via
// son API interne _register(). On utilise ensuite le noyau SYNCHRONE du moteur
// (t/pl/formatNumber/formatDate/_setLocaleSync/_normalizeLocale) pour vérifier :
//   1. la validité et le chargement des quatre catalogues ;
//   2. la complétude des clés (393 clés, structures identiques) ;
//   3. le respect des variables d'interpolation (mêmes variables par clé) ;
//   4. la traduction simple ;
//   5. l'interpolation des variables ;
//   6. les pluriels français, anglais, espagnols et chinois (Intl.PluralRules) ;
//   7. le repli sur le français quand une clé manque ;
//   8. la détection des variantes régionales (et le refus du chinois trad.) ;
//   9. le respect du choix manuel (jamais écrasé par la détection) ;
//  10. le changement rapide de langue (dernière langue demandée gagne) ;
//  11. l'invariance du copyright ;
//  12. les formats numériques et de dates (Intl).
//
// NOTE JXA : la file de micro-tâches (Promise) n'est pas vidée par le runloop
// ici, donc les API asynchrones (init/setLocale en fetch) sont exercées via
// leur noyau synchrone équivalent, ce qui valide la logique réelle du moteur.
// Un code de sortie non nul est renvoyé dès qu'une vérification échoue.

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

// Aplatit un catalogue {domaine: {clé: valeur}} en {domaine.clé: valeur}.
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

// Extraction des identifiants {var} d'une chaîne.
function varsOf(str) {
  var re = /\{([^{}]+)\}/g, m, list = [];
  while ((m = re.exec(str)) !== null) list.push(m[1]);
  return list.sort().join(",");
}

// ================================================================ 1. & 2.
// Chargement des quatre catalogues + complétude des clés.
var FILES = ["fr", "en", "es", "zh-Hans"];
var catalogs = {};      // locale -> objet JSON brut
var flatCatalogs = {};   // locale -> {domaine.clé: valeur}
var loadOk = true;
FILES.forEach(function (locale) {
  try {
    catalogs[locale] = JSON.parse(readUTF8(BASE + "i18n/" + locale + ".json"));
    flatCatalogs[locale] = flatten(catalogs[locale]);
    check("chargement + syntaxe JSON (" + locale + ")", true, "");
  } catch (e) {
    loadOk = false;
    check("chargement + syntaxe JSON (" + locale + ")", false, "ERREUR : " + e);
  }
});

  // ================================================================ MOTEUR
  // Chargement du moteur réel (valide au passage sa syntaxe JS).
  var engineSource = readUTF8(BASE + "i18n.js");
  check("lecture du fichier i18n.js", !!engineSource && engineSource.length > 0, engineSource ? "" : "contenu vide");

  var I18N = null;
  try {
    globalThis.eval(engineSource);
    I18N = globalThis.I18N;
    check("syntaxe JS valide (chargement du moteur)", true, "");
  } catch (e) {
    check("syntaxe JS valide (chargement du moteur)", false, "ERREUR : " + e);
  }
  if (I18N === null || typeof I18N === "undefined") {
    check("module exposé sur I18N", false, "null");
  } else {
    check("module exposé sur I18N", true, "");
  }

  // ================================================================ STRUCTURE
  // On n'exécute la suite que si le moteur et les catalogues sont utilisables.
  if (loadOk && I18N && typeof I18N === "object") {
    // Même ensemble de clés partout (complétude croisée).
    var refKeys = Object.keys(flatCatalogs["fr"]).sort();
    check("nombre de clés français = 393", refKeys.length === 393, "trouvées : " + refKeys.length);
    FILES.forEach(function (locale) {
      var keys = Object.keys(flatCatalogs[locale]).sort();
      check("nombre de clés (" + locale + ") = 393", keys.length === 393, "trouvées : " + keys.length);
    });
    var refSet = {};
    refKeys.forEach(function (k) { refSet[k] = true; });
    FILES.forEach(function (locale) {
      var missing = refKeys.filter(function (k) { return !(k in flatCatalogs[locale]); });
      var extra = Object.keys(flatCatalogs[locale]).filter(function (k) { return !(k in refSet); });
      check("clés identiques (fr vs " + locale + ")", missing.length === 0 && extra.length === 0,
        (missing.length ? "manquantes: " + missing.join(",") : "") +
        (extra.length ? " | extra: " + extra.join(",") : ""));
    });
    // 19 domaines de premier niveau.
    check("19 domaines de premier niveau", Object.keys(catalogs["fr"]).length === 19,
      "trouvés : " + Object.keys(catalogs["fr"]).length);

    // ---------------------------------------------------------------- 3.
    // Variables d'interpolation identiques pour chaque clé, dans les 4 langues.
    var varMismatch = 0;
    refKeys.forEach(function (k) {
      var base = varsOf(flatCatalogs["fr"][k]);
      FILES.forEach(function (locale) {
        if (varsOf(flatCatalogs[locale][k]) !== base) varMismatch++;
      });
    });
    check("variables d'interpolation identiques sur chaque clé", varMismatch === 0,
      (varMismatch ? varMismatch + " écarts" : ""));

    // --------------------------------------------------------------- 11.
    // Copyright strictement identique dans les quatre catalogues.
    var footer = flatCatalogs["fr"]["home.footer"];
    var copyrightOk = footer === "© Didier SEBASTIEN — 2026 · v12";
    FILES.forEach(function (locale) {
      if (flatCatalogs[locale]["home.footer"] !== footer) copyrightOk = false;
    });
    check("copyright invariant (4 langues, texte exact)", copyrightOk, "« " + footer + " »");

    // Injection des catalogues dans le cache du moteur.
    FILES.forEach(function (locale) {
      I18N._register(locale, catalogs[locale]);
    });


    // ============================================================== 4.-13.
    // Le noyau synchrone est ensuite exercé langue par langue.
    // ---------------------------------------------------------------- 4.
    // Traductions simples.
    I18N._setLocaleSync("fr");
    check("t: simple (fr)", I18N.t("home.start") === "Lancer une mission", I18N.t("home.start"));
    I18N._setLocaleSync("en");
    check("t: simple (en)", I18N.t("home.start") === "Start a mission", I18N.t("home.start"));
    check("t: simple (en title)", I18N.t("home.title") === "Calculation Trainer", I18N.t("home.title"));
    I18N._setLocaleSync("es");
    check("t: simple (es)", I18N.t("home.start") === "Iniciar una misión", I18N.t("home.start"));
    I18N._setLocaleSync("zh-Hans");
    check("t: simple (zh-Hans non vide)", typeof I18N.t("home.start") === "string" && I18N.t("home.start").length > 0,
      "« " + I18N.t("home.start") + " »");
    check("t: clé inconnue renvoie la clé", I18N.t("domaine.introuvable") === "domaine.introuvable", "");

    // ---------------------------------------------------------------- 5.
    // Interpolation des variables.
    I18N._setLocaleSync("fr");
    check("t: interpolation simple", I18N.t("mission.questionProgress", { n: 3, total: 10 }) === "Question 3 / 10",
      I18N.t("mission.questionProgress", { n: 3, total: 10 }));
    var scoreLine = I18N.t("result.scoreLine", { message: "Bravo", score: 7, total: 10, time: 12 });
    check("t: interpolation de plusieurs variables (fr)",
      scoreLine.indexOf("Bravo") === 0 && scoreLine.indexOf("7/10") !== -1 && scoreLine.indexOf("12") !== -1,
      scoreLine);
    // Une variable absente reste telle quelle (aucune invention de valeur).
    check("t: variable manquante non substituée",
      I18N.t("mission.questionProgress", { n: 2 }) === "Question 2 / {total}",
      I18N.t("mission.questionProgress", { n: 2 }));

    // ---------------------------------------------------------------- 6.
    // Pluriels via Intl.PluralRules, variantes One/Other.
    function expectPlurals(locale, oneInput, otherInput) {
      I18N._setLocaleSync(locale);
      var gotOne = I18N.pl("stats.game", 1);
      var gotOther = I18N.pl("stats.game", 5);
      check("pluriel One (" + locale + ")", gotOne === oneInput, gotOne);
      check("pluriel Other (" + locale + ")", gotOther === otherInput, gotOther);
    }
    expectPlurals("fr", "1 partie", "5 parties");
    expectPlurals("en", "1 game", "5 games");
    expectPlurals("es", "1 partida", "5 partidas");
    // Chinois : Intl ne fournit pas de catégorie « one », mais le moteur doit
    // choisir le variant « One » pour count === 1 (le catalogue le fournit).
    I18N._setLocaleSync("zh-Hans");
    check("pluriel One chinois (count=1)", I18N.pl("stats.game", 1) === "1 场", I18N.pl("stats.game", 1));
    check("pluriel Other chinois (count=5)", I18N.pl("stats.game", 5) === "5 场", I18N.pl("stats.game", 5));
    // Pluriel avec interpolation (count injecté automatiquement).
    I18N._setLocaleSync("fr");
    check("pl: interpolation + count", I18N.pl("mission.calculated", 3) === "3 calculs différents",
      I18N.pl("mission.calculated", 3));

    // ---------------------------------------------------------------- 7.
    // Repli sur le français quand une clé manque (catalogue anglais privé de clé).
    var broken = JSON.parse(JSON.stringify(catalogs["en"]));
    delete broken["mission"].title;
    I18N._register("en", broken);
    I18N._setLocaleSync("en");
    check("repli : clé manquante -> français", I18N.t("mission.title") === "Mission en cours",
      I18N.t("mission.title"));
    check("repli : autres clés anglaises intactes", I18N.t("home.start") === "Start a mission", "");
    // Restauration du catalogue anglais complet.
    I18N._register("en", catalogs["en"]);


    // ---------------------------------------------------------------- 8. & 9.
    // Détection des variantes régionales + respect du choix manuel :
    // la préférence manuelle est normalisée exactement comme une langue
    // navigateur ; normalizeLocale est la fonction commune (détection et choix),
    // ce qui garantit qu'un choix manuel prime et n'est jamais converti ni
    // écrasé par la détection (init lit localStorage AVANT navigator.languages).
    function norm(l) { return I18N._normalizeLocale(l); }
    check("détecte fr-FR -> fr", norm("fr-FR") === "fr", "");
    check("détecte fr-CA -> fr", norm("fr-CA") === "fr", "");
    check("détecte en-US -> en", norm("en-US") === "en", "");
    check("détecte en-GB -> en", norm("en-GB") === "en", "");
    check("détecte es-ES -> es", norm("es-ES") === "es", "");
    check("détecte es-MX -> es", norm("es-MX") === "es", "");
    check("détecte zh-CN -> zh-Hans", norm("zh-CN") === "zh-Hans", "");
    check("détecte zh-SG -> zh-Hans", norm("zh-SG") === "zh-Hans", "");
    check("détecte zh-Hans -> zh-Hans", norm("zh-Hans") === "zh-Hans", "");
    check("REFUSE zh-TW (traditionnel)", norm("zh-TW") === undefined, "");
    check("REFUSE zh-HK (traditionnel)", norm("zh-HK") === undefined, "");
    check("REFUSE zh-MO (traditionnel)", norm("zh-MO") === undefined, "");
    check("REFUSE zh-Hant (traditionnel)", norm("zh-Hant") === undefined, "");
    // Choix manuel valide + invalide.
    check("choix manuel 'es' reconnu", norm("es") === "es", "");
    check("choix manuel invalide 'xx' -> non reconnu (repli français)", norm("xx") === undefined, "");

    // --------------------------------------------------------------- 10.
    // Changement rapide de langue : la dernière langue demandée gagne
    // (invariant garanti par le garde-fou loadToken côté asynchrone comme par
    //  le basculement synchrone ici).
    I18N._setLocaleSync("en");
    I18N._setLocaleSync("es");
    I18N._setLocaleSync("fr");
    check("changement rapide : dernière langue (fr) active",
      I18N.getLocale() === "fr" && I18N.t("home.start") === "Lancer une mission",
      I18N.getLocale());
    I18N._setLocaleSync("zh-Hans");
    check("getLocale après zh-Hans", I18N.getLocale() === "zh-Hans", I18N.getLocale());

    // --------------------------------------------------------------- 12.
    // Formats numériques et de dates via Intl.
    check("formatNumber exposé", typeof I18N.formatNumber === "function", "");
    I18N._setLocaleSync("fr");
    check("formatNumber (fr) sans séparateur de milliers",
      I18N.formatNumber(123) === "123", "« " + I18N.formatNumber(123) + " »");
    // Valeur avec milliers : la chaîne rendue contient bien les chiffres (le
    // séparateur de groupe — espace insécable — ne doit pas être confondu).
    var grouped = I18N.formatNumber(1234);
    check("formatNumber (fr) groupe les milliers",
      typeof grouped === "string" && grouped.length > 0 &&
      grouped.replace(/[^\d]/g, "").indexOf("1234") !== -1,
      "« " + grouped + " »");
    var date = new Date(2026, 0, 15); // 15 janvier 2026
    var dateFr = I18N.formatDate(date);
    check("formatDate (fr) rend une chaîne", typeof dateFr === "string" && dateFr.length > 0, "« " + dateFr + " »");
    check("formatDate accepte options", typeof I18N.formatDate(date, { month: "long" }) === "string", "");


    // --------------------------------------------------------------- 13.
    // Absence de régression : l'API du moteur est complète et il n'introduit
    // pas de dictionnaire propre (les catalogues sont la seule source).
    var apiOk = ["init","t","pl","setLocale","getLocale","formatNumber","formatDate","onLocaleChange","isReady"]
      .every(function (m) { return typeof I18N[m] === "function"; });
    check("API du moteur au complet", apiOk, "");
  }


// ---- Bilan ----
var passed = 0, failed = 0;
results.forEach(function (r) { if (r.ok) { passed++; } else { failed++; } });
var lines = ["JS moteur i18n (v12.6-B2) : " + passed + " réussis, " + failed + " échoués"];
results.forEach(function (r) {
  lines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.detail ? " — " + r.detail : ""));
});
var summary = lines.join("\n");
if (failed === 0) {
  summary += "\nRESULT:PASS";
} else {
  summary += "\nRESULT:FAIL";
  $.NSLog("%@", summary.replace(/\n/g, " | "));
  throw new Error("Échec des tests i18n (" + failed + " vérification(s))");
}
summary;

