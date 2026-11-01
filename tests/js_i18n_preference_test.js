// ============================================================================
// js_i18n_preference_test.js — v12.6-C2
// Synchronisation de la langue entre navigateur (localStorage) et compte
// utilisateur (SQLite, via l'API). Suite JXA ciblée sur i18n.js et account.js.
//
// Limites JXA : les micro-tâches promises ne sont pas drainées ici ; on
// vérifie donc les comportements SYNCHRONES observables (écritures localStorage
// décidées dès l'appel, formation/répartition de la requête profile/language,
// coalescence et dernier-choix-gagnant au niveau de l'État, propagation vers le
// moteur via spy). L'exécution réelle des await (réponse serveur, boucle de
// sérialisation) sera validée dans Firefox.
// ============================================================================

ObjC.import("Foundation");
function readUTF8(path) {
  var err = Ref();
  var s = $.NSString.stringWithContentsOfFileEncodingError(path, $.NSUTF8StringEncoding, err);
  return s ? s.js : null;
}
var BASE = "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/";
var TESTS_BASE = "/Users/didiers/Documents/Projets-IA/calculation-trainer/public/i18n/";

var results = [];
function check(name, ok, detail) { results.push({ name: name, ok: !!ok, detail: detail || "" }); }

function readCatalog(locale) {
  var raw = readUTF8(TESTS_BASE + locale + ".json");
  return JSON.parse(raw);
}
var catalogLocales = ["fr", "en", "es", "zh-Hans"];
var catalogs = {};
catalogLocales.forEach(function (l) { catalogs[l] = readCatalog(l); });

// ---------------------------------------------------------------- localStorage
var storeStore = {};
var lsSetCalls = [];
var lsGetCalls = [];
var localStorage = {
  getItem: function (k) { lsGetCalls.push(k); return Object.prototype.hasOwnProperty.call(storeStore, k) ? storeStore[k] : null; },
  setItem: function (k, v) { lsSetCalls.push([k, v]); storeStore[k] = String(v); },
  removeItem: function (k) { delete storeStore[k]; }
};
function resetLs() { storeStore = {}; lsSetCalls = []; lsGetCalls = []; }

var navigator = { languages: ["fr"] };
var document = {
  addEventListener: function () {},
  getElementById: function () { return null; },
  querySelector: function () { return null; },
  querySelectorAll: function () { return []; },
  createElement: function () { return null; }
};
var window = { I18N: null };

// ============================================================================
// 1) MOTEUR i18n.js
// ============================================================================
var engineSource = readUTF8(BASE + "i18n.js");
check("lecture de i18n.js", !!engineSource && engineSource.length > 0, engineSource ? "" : "vide");

var I18N = null;
try {
  globalThis.eval(engineSource);
  I18N = (typeof window !== "undefined" && window.I18N) || globalThis.I18N;
  check("chargement i18n.js sans erreur", !!I18N, I18N ? "" : "I18N introuvable");
} catch (e) {
  check("chargement i18n.js sans erreur", false, "ERREUR : " + e);
}

if (I18N) {
  catalogLocales.forEach(function (l) { I18N._register(l, catalogs[l]); });

  // --- setLocale({persist:false}) ne doit PAS écrire dans localStorage -------
  I18N._setLocaleSync("fr");
  resetLs();
  I18N.setLocale("es", { persist: false });
  check("setLocale(es,{persist:false}) n'écrit pas localStorage",
    lsSetCalls.length === 0, "écritures=" + lsSetCalls.length);

  // --- setLocale() par défaut persiste dans localStorage --------------------
  resetLs();
  I18N.setLocale("en");
  check("setLocale(en) persiste dans localStorage",
    lsSetCalls.length === 1 && lsSetCalls[0][0] === "missionCalculMental.locale" && lsSetCalls[0][1] === "en",
    JSON.stringify(lsSetCalls[0]));

  // --- setLocale() sur la langue déjà courante : pas de sauvegarde redondante
  I18N._setLocaleSync("en");
  resetLs();
  I18N.setLocale("en");
  check("setLocale(sur la langue courante) n'écrit pas localStorage (aucune requête inutile)",
    lsSetCalls.length === 0, "écritures=" + lsSetCalls.length);

  // --- restoreGuestPreference : lit localStorage, n'écrit jamais --------------
  resetLs();
  storeStore["missionCalculMental.locale"] = "es";
  I18N._setLocaleSync("fr");
  I18N.restoreGuestPreference();
  check("restoreGuestPreference lit localStorage",
    lsGetCalls.indexOf("missionCalculMental.locale") !== -1, "");
  check("restoreGuestPreference n'écrit PAS localStorage (préférence invitée intacte)",
    lsSetCalls.length === 0, "écritures=" + lsSetCalls.length);

  // --- fallback navigation si aucune préférence manuelle (zh-CN → zh-Hans) ----
  resetLs();
  navigator.languages = ["zh-CN"];
  I18N._setLocaleSync("fr");
  I18N.restoreGuestPreference();
  check("restoreGuestPreference sans choix manuel : n'écrit pas localStorage",
    lsSetCalls.length === 0, "écritures=" + lsSetCalls.length);
  navigator.languages = ["fr"];

  // --- getLocale renvoie toujours un code canonique --------------------------
  check("getLocale renvoie un code valide", I18N.getLocale(), I18N.getLocale());
}


// ============================================================================
// 2) account.js — synchronisation langue du compte
// ============================================================================
var accountSource = readUTF8(BASE + "account.js");
check("lecture de account.js", !!accountSource && accountSource.length > 0, "");

var AccountUI = null;
try {
  globalThis.eval(accountSource);
  AccountUI = window.AccountUI; // account.js : window.AccountUI = AccountUI
  check("chargement account.js sans erreur", !!AccountUI, AccountUI ? "" : "AccountUI introuvable");
} catch (e) {
  check("chargement account.js sans erreur", false, "ERREUR : " + e);
}

// Spy du moteur pour observer les appels (sans dépendre des micro-tâches).
var spySetLocaleCalls = [];
var spyRestoreGuestCalls = [];
function makeI18nSpy() {
  return {
    getLocale: function () { return "fr"; },
    _normalizeLocale: function (l) { return I18N && I18N._normalizeLocale ? I18N._normalizeLocale(l) : l; },
    setLocale: function (locale, opts) {
      spySetLocaleCalls.push({ locale: locale, opts: opts });
      return Promise.resolve(locale);
    },
    restoreGuestPreference: function () {
      spyRestoreGuestCalls.push(1);
      return Promise.resolve("fr");
    },
    onLocaleChange: function () {}
  };
}
window.I18N = makeI18nSpy();

// Spy fetch pour la requête profile/language (appel SYNCHRONE, observable).
var fetchCalls = [];
globalThis.fetch = function (url, opts) {
  fetchCalls.push({ url: url, opts: opts || {} });
  var body = {};
  try { body = JSON.parse((opts && opts.body) || "{}"); } catch (e) {}
  var savedLang = body.preferred_language || "fr";
  return Promise.resolve({
    status: 200, ok: true,
    json: function () { return Promise.resolve({ ok: true, data: { user: { id: 1, role: "user", preferred_language: savedLang } } }); }
  });
};
function resetNetwork() { fetchCalls = []; }


if (AccountUI && AccountUI.__test) {
  var T = AccountUI.__test;

  // --- saveLanguagePreference : formation de la requête profile/language -----
  resetNetwork(); T.resetState(); T.setUser({ id: 1, role: "user", preferred_language: "fr" });
  T.saveLanguagePreference("es");
  check("saveLanguagePreference('es') émet POST profile/language avec preferred_language=es",
    fetchCalls.length === 1 && JSON.parse(fetchCalls[0].opts.body).action === "profile/language" &&
      JSON.parse(fetchCalls[0].opts.body).preferred_language === "es",
    fetchCalls.length === 1 ? fetchCalls[0].opts.body : "0 appels");

  // --- coalescence : un 2e choix pendant une écriture en vol n'ajoute pas de req
  resetNetwork(); T.resetState(); T.setUser({ id: 1, role: "user", preferred_language: "fr" });
  T.saveLanguagePreference("es");       // 1er appel : démarre la requête es
  T.saveLanguagePreference("zh-Hans");  // pendant l'écriture en vol
  var st1 = T.getState();
  check("deux changements rapides => une seule requête lancée",
    fetchCalls.length === 1, "requêtes=" + fetchCalls.length);
  check("dernier choix gardé en attente (pendingLang=zh-Hans)",
    st1.pendingLang === "zh-Hans", "pendingLang=" + st1.pendingLang);
  check("dernier choix gagnant (lastSelectedLang=zh-Hans)",
    st1.lastSelectedLang === "zh-Hans", "lastSelectedLang=" + st1.lastSelectedLang);

  // --- applyAccountLanguage : applique via setLocale AVEC persist:false -------
  spySetLocaleCalls = [];
  T.setUser({ id: 1, role: "user", preferred_language: "fr" });
  T.applyAccountLanguage("es");
  check("applyAccountLanguage('es') appelle I18N.setLocale('es',{persist:false})",
    spySetLocaleCalls.length === 1 && spySetLocaleCalls[0].locale === "es" && spySetLocaleCalls[0].opts.persist === false,
    JSON.stringify(spySetLocaleCalls[0]));

  // --- restoreGuestLocale : appelle restoreGuestPreference après déconnexion ---
  spyRestoreGuestCalls = [];
  T.restoreGuestLocale();
  check("restoreGuestLocale() appelle I18N.restoreGuestPreference() (retour à la langue invitée)",
    spyRestoreGuestCalls.length === 1, "appels=" + spyRestoreGuestCalls.length);
}


// ============================================================================
// 3) Raccords (wiring) vérifiés au niveau du code source
// ============================================================================
if (accountSource) {
  // Inscription : la langue courante de l'interface est transmise.
  check("inscription : préférence issue de I18N.getLocale() transmise à auth/register",
    /window\.I18N\.getLocale/.test(accountSource) && /preferred_language:\s*registerLocale/.test(accountSource), "");

  // Connexion : la langue du compte est réappliquée (login + restauration de session).
  check("connexion/restauration : applyAccountLanguage(user.preferred_language) réappliqué",
    (accountSource.match(/await\s+applyAccountLanguage\(user\.preferred_language\)/g) || []).length >= 2,
    "occurrences=" + (accountSource.match(/applyAccountLanguage/g) || []).length);

  // Sélecteur pendant session : sauvegarde via profile/language, par le sélecteur uniquement.
  check("changement de langue connecté => sauvegarde profile/language (sélecteur uniquement)",
    /profile\/language/.test(accountSource) && /!applyingAccountLang/.test(accountSource) &&
      /saveLanguagePreference\(locale\)/.test(accountSource), "");

  // Déconnexion : abandon des écritures en vol + retour à la langue invitée.
  check("déconnexion : abandon des mises à jour en vol et restoreGuestLocale()",
    /lastSelectedLang = null/.test(accountSource) && /savingLang = false/.test(accountSource) &&
      /await restoreGuestLocale\(\)/.test(accountSource), "");

  // Expiration de session : restauration de la langue invitée.
  check("expiration de session : restauration de la langue invitée (restoreGuestLocale)",
    (accountSource.match(/await restoreGuestLocale\(\)/g) || []).length >= 2, "");

  // La langue du compte est appliquée SANS écraser localStorage (persist:false).
  check("la langue du compte est appliquée SANS écraser localStorage (persist:false)",
    /persist:\s*false/.test(accountSource), "");
}

// ============================================================================
// Bilan
// ============================================================================
var passed = 0, failed = 0;
results.forEach(function (r) { if (r.ok) passed++; else failed++; });
var lines = ["JS préférence de langue (v12.6-C2) : " + passed + " réussis, " + failed + " échoués"];
results.forEach(function (r) {
  lines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.detail ? " — " + r.detail : ""));
});
lines.forEach(function (l) { console.log(l); });
console.log("RESULT:" + (failed === 0 ? "PASS" : "FAIL"));

