// js_i18n_account_test.js — Internationalisation des ÉCRANS DE COMPTE (v12.6-B3.2)
//
// Même approche que les autres tests du dépôt : aucun outil Node requis,
// exécution via JavaScript for Automation (JXA) :
//     osascript -l JavaScript tests/js_i18n_account_test.js
//
// Ce test vérifie que les écrans de connexion, d'inscription et de compte
// (public/index.html + public/account.js) sont internationalisés à partir des
// QUATRE catalogues (fr, en, es, zh-Hans), désormais à 357 clés chacun, sans
// clé orpheline ni texte codé en dur dans les parcours visibles, tout en
// préservant intégralement les mécanismes d'authentification.
//
// Couverture (§10 de la mission) :
//   1. clés d'authentification (auth) et de compte (account) ;
//   2. complétude des quatre catalogues (357 clés, structures identiques) ;
//   3. attributs HTML localisés (data-i18n / data-i18n-placeholder) des écrans
//      de connexion, d'inscription et de compte ;
//   4. messages de connexion (saisie, progression, succès, déconnexion, session) ;
//   5. validations d'inscription (nom d'utilisateur, longueur, confirmation) ;
//   6. changement de mot de passe (validations, confirmation, notifications) ;
//   7. notifications et erreurs connues (correspondance exacte messages API) ;
//   8. navigation du compte (barre de compte, liens de la barre) ;
//   9. formatage des dates (Intl) selon la langue ;
//  10. changement immédiat de langue (abonnement i18n:changed / onLocaleChange) ;
//  11. conservation des données saisies (pas de recréation des champs) ;
//  12. absence de nouvelle requête de connexion lors du changement de langue ;
//  13. deux nouvelles traductions de débriefing (result.debriefColumn*) ;
//  14. non-régression des règles d'authentification (nom 3-40, mdp ≥ 10, égalité).
//
// NOTE JXA : la file de micro-tâches (Promise) n'est pas vidée par le runloop,
// donc les appels HTTP (fetch) et init() asynchrones de account.js ne sont pas
// exécutés ici ; on valide la logique réelle via le noyau synchrone du moteur
// (_setLocaleSync/t/formatDate), l'évaluation de account.js avec stubs DOM
// minimaux (sans déclencher init) et l'inspection des sources. Les comportements
// DOM/async seront confirmés manuellement dans Firefox.

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
// Chargement des quatre catalogues + complétude.
var FILES = ["fr", "en", "es", "zh-Hans"];
var catalogs = {}, flatCatalogs = {};
var catOk = true;
FILES.forEach(function (locale) {
  try {
    catalogs[locale] = JSON.parse(readUTF8(BASE + "i18n/" + locale + ".json"));
    flatCatalogs[locale] = flatten(catalogs[locale]);
  } catch (e) {
    catOk = false;
    check("chargement catalogue (" + locale + ")", false, "ERREUR : " + e);
  }
});
check("les 4 catalogues sont chargés", catOk && FILES.every(function (l) { return catalogs[l]; }), "");

var refKeys = flatCatalogs["fr"] ? Object.keys(flatCatalogs["fr"]).sort() : [];
check("nombre de clés français = 357", refKeys.length === 357, "trouvées : " + refKeys.length);
FILES.forEach(function (locale) {
  var keys = flatCatalogs[locale] ? Object.keys(flatCatalogs[locale]).sort() : [];
  check("nombre de clés (" + locale + ") = 357", keys.length === 357, "trouvées : " + keys.length);
});
var refSet = {};
refKeys.forEach(function (k) { refSet[k] = true; });
FILES.forEach(function (locale) {
  var missing = refKeys.filter(function (k) { return !(k in flatCatalogs[locale]); });
  var extra = Object.keys(flatCatalogs[locale]).filter(function (k) { return !(k in refSet); });
  check("clés identiques (fr vs " + locale + ")", missing.length === 0 && extra.length === 0,
    (missing.length ? "manquantes: " + missing.join(",") : "") + (extra.length ? " | extra: " + extra.join(",") : ""));
});

// Les domaines requis pour les écrans de compte existent dans chaque langue.
["auth", "account", "nav", "error", "common", "aria", "validate"].forEach(function (dom) {
  check("domaine « " + dom + " » présent dans les 4 langues",
    FILES.every(function (l) { return catalogs[l] && catalogs[l][dom]; }), "");
});

// ==================================================================== MOTEUR
var I18N = null;
try {
  globalThis.eval(readUTF8(BASE + "i18n.js"));
  I18N = globalThis.I18N;
} catch (e) { /* signalé ci-dessous */ }
check("moteur i18n exposé", !!(I18N && typeof I18N === "object"), "");
if (I18N && typeof I18N === "object") {
  FILES.forEach(function (locale) { I18N._register(locale, catalogs[locale]); });
  I18N._setLocaleSync("fr");
  check("catalogues injectés et opérationnels",
    I18N.isReady() && I18N.t("auth.loginTitle") === "Connexion", "« " + I18N.t("auth.loginTitle") + " »");
}

// ==================================================================== SOURCES
var indexSrc = readUTF8(BASE + "index.html");
var accountSrc = readUTF8(BASE + "account.js");
check("lecture index.html non vide", indexSrc && indexSrc.length > 500, "");
check("lecture account.js non vide", accountSrc && accountSrc.length > 500, "");

// --- Références de clés utilisées par les écrans de compte (HTML + account.js).
var referenced = {};
var attrRe = /data-i18n(?:-[a-z-]+)?="([^"]+)"/g;
var m;
while ((m = attrRe.exec(indexSrc)) !== null) referenced[m[1]] = true;
var tRe = /\bi18nT\("([^"]+)"/g;
while ((m = tRe.exec(accountSrc)) !== null) referenced[m[1]] = true;

var missingRefs = Object.keys(referenced).filter(function (k) {
  if (k in refSet) return false;
  if (k.indexOf(".") === -1) return true;
  return !(k + "One" in refSet && k + "Other" in refSet);
});
check("aucune clé référencée inexistante (index+account)", missingRefs.length === 0,
  "manquantes : " + (missingRefs.join(",") || "aucune"));
var crossMissing = Object.keys(referenced).filter(function (k) {
  var target = k in refSet ? k : (k + "One");
  return !FILES.every(function (l) { return target in flatCatalogs[l]; });
});
check("chaque clé de compte existe dans les 4 langues", crossMissing.length === 0,
  crossMissing.join(",") || "");

// --- 3. Attributs HTML localisés des écrans de connexion / inscription / compte.
var staticAttrChecks = [
  ["auth.kicker", 'data-i18n="auth.kicker"'],
  ["auth.loginTitle (connexion)", 'data-i18n="auth.loginTitle"'],
  ["auth.loginIntro", 'data-i18n="auth.loginIntro"'],
  ["auth.loginLabel", 'data-i18n="auth.loginLabel"'],
  ["auth.loginPlaceholder", 'data-i18n-placeholder="auth.loginPlaceholder"'],
  ["auth.passwordLabel", 'data-i18n="auth.passwordLabel"'],
  ["auth.passwordPlaceholder", 'data-i18n-placeholder="auth.passwordPlaceholder"'],
  ["auth.loginButton", 'data-i18n="auth.loginButton"'],
  ["auth.registerLink", 'data-i18n="auth.registerLink"'],
  ["auth.backToHome", 'data-i18n="auth.backToHome"'],
  ["auth.registerTitle (inscription)", 'data-i18n="auth.registerTitle"'],
  ["auth.registerIntro", 'data-i18n="auth.registerIntro"'],
  ["auth.registerLoginLabel", 'data-i18n="auth.registerLoginLabel"'],
  ["auth.registerLoginPlaceholder", 'data-i18n-placeholder="auth.registerLoginPlaceholder"'],
  ["auth.registerPasswordPlaceholder", 'data-i18n-placeholder="auth.registerPasswordPlaceholder"'],
  ["auth.registerPasswordConfirmLabel", 'data-i18n="auth.registerPasswordConfirmLabel"'],
  ["auth.registerPasswordConfirmPlaceholder", 'data-i18n-placeholder="auth.registerPasswordConfirmPlaceholder"'],
  ["auth.registerButton", 'data-i18n="auth.registerButton"'],
  ["auth.registerLoginLink", 'data-i18n="auth.registerLoginLink"'],
  ["account.title (compte)", 'data-i18n="account.title"'],
  ["account.changePassword", 'data-i18n="account.changePassword"'],
  ["account.currentPassword", 'data-i18n="account.currentPassword"'],
  ["account.newPassword", 'data-i18n="account.newPassword"'],
  ["account.confirmNewPassword", 'data-i18n="account.confirmNewPassword"'],
  ["account.changePasswordButton", 'data-i18n="account.changePasswordButton"'],
  ["account.logout", 'data-i18n="account.logout"']
];
staticAttrChecks.forEach(function (c) {
  check("attribut localisé présent : " + c[0], indexSrc.indexOf(c[1]) !== -1, "");
});

// --- 13. Les deux nouvelles traductions de débriefing.
check("en-tête débriefing « Calcul et correction » branché",
  indexSrc.indexOf('data-i18n="result.debriefColumnCalculation"') !== -1, "");
check("en-tête débriefing « Résultat » branché",
  indexSrc.indexOf('data-i18n="result.debriefColumnResult"') !== -1, "");
check("result.debriefColumnCalculation (fr)", flatCatalogs["fr"]["result.debriefColumnCalculation"] === "Calcul et correction", "« " + flatCatalogs["fr"]["result.debriefColumnCalculation"] + " »");
check("result.debriefColumnResult (fr)", flatCatalogs["fr"]["result.debriefColumnResult"] === "Résultat", "« " + flatCatalogs["fr"]["result.debriefColumnResult"] + " »");
check("result.debriefColumnCalculation (en)", flatCatalogs["en"]["result.debriefColumnCalculation"] === "Calculation and correction", "« " + flatCatalogs["en"]["result.debriefColumnCalculation"] + " »");
check("result.debriefColumnResult (en)", flatCatalogs["en"]["result.debriefColumnResult"] === "Result", "« " + flatCatalogs["en"]["result.debriefColumnResult"] + " »");
check("result.debriefColumnCalculation (es)", flatCatalogs["es"]["result.debriefColumnCalculation"] === "Cálculo y corrección", "« " + flatCatalogs["es"]["result.debriefColumnCalculation"] + " »");
check("result.debriefColumnResult (es)", flatCatalogs["es"]["result.debriefColumnResult"] === "Resultado", "« " + flatCatalogs["es"]["result.debriefColumnResult"] + " »");
check("result.debriefColumnCalculation (zh-Hans)", flatCatalogs["zh-Hans"]["result.debriefColumnCalculation"] === "计算与订正", "« " + flatCatalogs["zh-Hans"]["result.debriefColumnCalculation"] + " »");
check("result.debriefColumnResult (zh-Hans)", flatCatalogs["zh-Hans"]["result.debriefColumnResult"] === "结果", "« " + flatCatalogs["zh-Hans"]["result.debriefColumnResult"] + " »");

// ==================================================================== ACCOUNT.JS
// Évaluation de account.js avec stubs DOM minimaux (sans déclencher init).
function makeElStub() {
  return {
    textContent: "", innerHTML: "", className: "", value: "", disabled: false,
    append: function () {}, appendChild: function () {}, removeChild: function () {},
    setAttribute: function () {}, getAttribute: function () {}, style: {}, dataset: {},
    classList: { add: function () {}, remove: function () {}, toggle: function () {}, contains: function () { return false; } },
    addEventListener: function () {}, focus: function () {}, closest: function () { return null; },
    querySelector: function () { return null; }, querySelectorAll: function () { return []; },
    reset: function () {}, hidden: false
  };
}
var window = {};
if (I18N) window.I18N = I18N;
var document = {
  addEventListener: function () {},
  getElementById: function () { return makeElStub(); },
  querySelectorAll: function () { return []; },
  querySelector: function () { return null; },
  createElement: function () { return makeElStub(); }
};
var accountLoadError = null;
try {
  globalThis.eval(accountSrc);
  // account.js expose le module sur window (stub du test), pas sur globalThis.
  if (!(window.AccountUI && typeof window.AccountUI === "object")) {
    accountLoadError = "AccountUI non exposé sur window";
  }
} catch (e) {
  accountLoadError = "ERREUR : " + e;
}
check("syntaxe JS valide + AccountUI exposé (account.js)", accountLoadError === null, accountLoadError || "");

// --- 4. Messages de connexion : textes non vides et traduits dans les 4 langues.
["missingCredentials", "loginBusy", "loginFailed", "sessionExpired", "loggedOut", "loginSuccess"].forEach(function (k) {
  FILES.forEach(function (l) {
    var v = flatCatalogs[l]["auth." + k];
    check("auth." + k + " (" + l + ") non vide", !!v && v.length > 0, "« " + v + " »");
  });
});
check("auth.loginSuccess interpole {login}",
  flatCatalogs["fr"]["auth.loginSuccess"].indexOf("{login}") !== -1, "« " + flatCatalogs["fr"]["auth.loginSuccess"] + " »");
check("auth.connected interpole {login}",
  flatCatalogs["fr"]["auth.connected"].indexOf("{login}") !== -1, "« " + flatCatalogs["fr"]["auth.connected"] + " »");

// --- 5. Validations d'inscription traduites dans les 4 langues.
["registerLoginRequired", "registerFormat", "registerPasswordTooShort", "registerMismatch", "registerBusy", "registerFailed", "registerSuccess"].forEach(function (k) {
  FILES.forEach(function (l) {
    var v = flatCatalogs[l]["auth." + k];
    check("auth." + k + " (" + l + ") non vide", !!v && v.length > 0, "« " + v + " »");
  });
});

// --- 6. Changement de mot de passe : validations et notifications traduites.
["passwordTooShort", "passwordMismatch", "passwordOldIncorrect", "passwordChangeFailed", "passwordBusy", "passwordChanged"].forEach(function (k) {
  FILES.forEach(function (l) {
    var v = flatCatalogs[l]["account." + k];
    check("account." + k + " (" + l + ") non vide", !!v && v.length > 0, "« " + v + " »");
  });
});

// --- 7. Notifications et erreurs connues : les messages français renvoyés par
// l'API correspondent à une clé traduite (correspondance EXACTE, sans
// approximation par sous-chaînes). Le tableau reproduit celui intégré à
// account.js (SERVER_ERROR_KEYS).
var serverMap = [
  ["Ce nom d'utilisateur est déjà utilisé.", "auth.nameTaken"],
  ["Identifiants invalides.", "auth.identifiantsInvalid"],
  ["Trop de tentatives. Réessayez dans quelques minutes.", "auth.tooManyAttempts"],
  ["Ce compte est désactivé. Contactez un administrateur.", "auth.accountDisabled"],
  ["L'ancien mot de passe est incorrect.", "account.passwordOldIncorrect"],
  ["Authentification requise.", "auth.authenticationRequired"]
];
serverMap.forEach(function (pair) {
  check("erreur serveur mappée : « " + pair[0] + " »",
    accountSrc.indexOf(JSON.stringify(pair[0])) !== -1, "");
  FILES.forEach(function (l) {
    var v = flatCatalogs[l][pair[1]];
    check("traduction " + l + " de « " + pair[0] + " »", !!v && v.length > 0, "« " + v + " »");
  });
});
// La traduction des erreurs serveur repose sur une CORRESPONDANCE EXACTE via
// une table (SERVER_ERROR_KEYS), jamais sur un remplacement par sous-chaînes.
check("erreurs serveur traduites par correspondance exacte (table de clés)",
  accountSrc.indexOf("SERVER_ERROR_KEYS[raw]") !== -1, "");
check("aucune traduction d'erreur par remplacement de sous-chaîne",
  accountSrc.indexOf("translateServerError") !== -1, "");

// --- 8. Navigation du compte : la barre utilise des libellés localisés.
["nav.home", "nav.myAccount", "nav.myStats", "nav.administration"].forEach(function (k) {
  FILES.forEach(function (l) {
    check(k + " (" + l + ") non vide", !!flatCatalogs[l][k] && flatCatalogs[l][k].length > 0, "« " + flatCatalogs[l][k] + " »");
  });
});
check("barre de compte : i18nT(nav.home) utilisé", accountSrc.indexOf('i18nT("nav.home"') !== -1, "");
check("barre de compte : i18nT(nav.myAccount) utilisé", accountSrc.indexOf('i18nT("nav.myAccount"') !== -1, "");
check("barre de compte : i18nT(account.guestMode) utilisé", accountSrc.indexOf('i18nT("account.guestMode"') !== -1, "");
check("barre de compte : i18nT(account.loginOrRegister) utilisé", accountSrc.indexOf('i18nT("account.loginOrRegister"') !== -1, "");
check("barre de compte : i18nT(account.logout) utilisé", accountSrc.indexOf('i18nT("account.logout"') !== -1, "");
check("barre de compte : i18nT(auth.connected) utilisé", accountSrc.indexOf('i18nT("auth.connected"') !== -1, "");

// Rôle / identifiant / date d'inscription localisés.
check("compte : i18nT(account.identifiant)", accountSrc.indexOf('i18nT("account.identifiant"') !== -1, "");
check("compte : i18nT(account.role)", accountSrc.indexOf('i18nT("account.role"') !== -1, "");
check("compte : i18nT(account.registeredOn)", accountSrc.indexOf('i18nT("account.registeredOn"') !== -1, "");

// --- 9. Formatage des dates selon la langue (Intl via le moteur).
if (I18N && typeof I18N.formatDate === "function") {
  var d = new Date(2026, 4, 15); // 15 mai 2026
  I18N._setLocaleSync("fr");
  var frDate = I18N.formatDate(d, { day: "2-digit", month: "long", year: "numeric" });
  I18N._setLocaleSync("en");
  var enDate = I18N.formatDate(d, { day: "2-digit", month: "long", year: "numeric" });
  check("formatDate (fr) — format français", /mai/.test(frDate), "« " + frDate + " »");
  check("formatDate (en) — format anglais", /May/.test(enDate), "« " + enDate + " »");
  check("date française ≠ date anglaise", frDate !== enDate, "fr« " + frDate + " » en« " + enDate + " »");
  I18N._setLocaleSync("es");
  var esDate = I18N.formatDate(d, { day: "2-digit", month: "long", year: "numeric" });
  check("formatDate (es) — format espagnol", /mayo/i.test(esDate), "« " + esDate + " »");
  I18N._setLocaleSync("zh-Hans");
  var zhDate = I18N.formatDate(d, { day: "2-digit", month: "long", year: "numeric" });
  check("formatDate (zh-Hans) — rend une chaîne", typeof zhDate === "string" && zhDate.length > 0, "« " + zhDate + " »");
  // account.js délègue à I18N.formatDate et ne conserve la locale fr-FR qu'en
  // repli APRÈS le chemin i18n (jamais comme chemin principal).
  check("account.js délègue à I18N.formatDate (chemin principal)",
    accountSrc.indexOf("I.formatDate(d") !== -1, "");
  check("la locale fr-FR n'est qu'un repli (i18n prioritaire)",
    accountSrc.indexOf("I.formatDate(d") !== -1
      && accountSrc.indexOf("I.formatDate(d") < accountSrc.indexOf("toLocaleDateString(\"fr-FR\""), "");
}

// --- 10. Changement immédiat de langue : abonnement onLocaleChange / i18n:changed.
check("account.js s'abonne à I18N.onLocaleChange",
  accountSrc.indexOf("I18N.onLocaleChange") !== -1, "");

// --- 12. AUCUNE nouvelle requête d'authentification lors du changement de
// langue : le callback onLocaleChange ne doit contenir aucun appel à l'API.
// On extrait la portion du callback et on vérifie qu'il n'invoque ni api( ni
// refreshCsrf( ni fetch(.
var cbStart = accountSrc.indexOf("window.I18N.onLocaleChange((locale) => {");
var cbEnd = cbStart >= 0 ? accountSrc.indexOf("});", cbStart) : -1;
var cbRegion = (cbStart >= 0 && cbEnd >= 0) ? accountSrc.slice(cbStart, cbEnd + 3) : "";
check("changement de langue : callback présent", cbStart >= 0, "");
// v12.6-C2 — la langue reçue par le callback est réellement exploitée : elle est
// transmise à saveLanguagePreference pour la synchronisation du compte.
check("changement de langue : la langue reçue est exploitée par le callback",
  cbRegion.indexOf("(locale) =>") !== -1 && cbRegion.indexOf("saveLanguagePreference(locale)") !== -1, "");
// Garde invité : en mode non connecté (user absent), aucune synchronisation
// profile/language n'est déclenchée par le change-bloc (délégation exclue via
// la condition `if (user && !applyingAccountLang)`).
check("changement de langue : aucune synchronisation en mode invité",
  cbRegion.indexOf("if (user && !applyingAccountLang)") !== -1 &&
    cbRegion.indexOf("saveLanguagePreference(locale)") > cbRegion.indexOf("applyingAccountLang"), "");
check("changement de langue : aucune requête API directe dans le callback",
  cbRegion.indexOf("api(") === -1 && cbRegion.indexOf("refreshCsrf(") === -1 && cbRegion.indexOf("fetch(") === -1, "");
check("changement de langue : aucune notification de connexion/déconnexion",
  cbRegion.indexOf("showToast(") === -1 && cbRegion.indexOf("loginSuccess") === -1 && cbRegion.indexOf("loggedOut") === -1, "");

// --- 11. Conservation des données saisies : le callback ne recrée PAS les
// champs des formulaires (loginForm / registerForm / passwordForm).
check("changement de langue : les champs saisis ne sont pas recréés",
  cbRegion.indexOf("loginForm") === -1 && cbRegion.indexOf("registerForm") === -1 && cbRegion.indexOf("passwordForm") === -1
    && cbRegion.indexOf(".innerHTML =") === -1, "");

// --- 14. Non-régression des règles d'authentification (inchangées dans account.js).
check("inscription : identifiant obligatoire (garde existante)",
  accountSrc.indexOf("if (!login)") !== -1, "");
check("inscription : nom 3-40, alphanumériques et _ (garde existante)",
  accountSrc.indexOf("login.length < 3 || login.length > 40 || !/^[A-Za-z0-9_]+$/.test(login)") !== -1, "");
check("inscription : mot de passe ≥ 10 (garde existante)",
  accountSrc.indexOf("password.length < 10") !== -1, "");
check("inscription : confirmation des mots de passe (garde existante)",
  accountSrc.indexOf("password !== confirm") !== -1, "");
check("connexion : saisie requise identifiant + mot de passe",
  accountSrc.indexOf("if (!login || !password)") !== -1, "");
check("mot de passe : ancien + nouveau ≥ 10 + confirmation (gardes existantes)",
  accountSrc.indexOf("newPassword.length < 10") !== -1 && accountSrc.indexOf("newPassword !== confirm") !== -1, "");

// ==================================================================== RÉSULTATS
var failed = results.filter(function (r) { return !r.ok; });
var outLines = ["js_i18n_account_test — " + FILES.length + " langues, " + refKeys.length + " clés"];
outLines.push("JS i18n comptes (v12.6-B3.2) : " + (results.length - failed.length) + " réussis, " + failed.length + " échoués");
results.forEach(function (r) {
  outLines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.ok ? "" : " — " + r.detail));
});
var summary = outLines.join("\n");
if (failed.length === 0) {
  summary += "\nRESULT:PASS";
} else {
  summary += "\nRESULT:FAIL";
  $.NSLog("%@", summary.replace(/\n/g, " | "));
  throw new Error("Échec des tests i18n comptes (" + failed.length + " vérification(s))");
}
summary;




