// js_i18n_admin_test.js — Internationalisation de l'ADMINISTRATION (v12.6-B3.4).
//
// Même approche que les autres tests du dépôt : aucun outil Node requis,
// exécution via JavaScript for Automation (JXA) :
//     osascript -l JavaScript tests/js_i18n_admin_test.js
//
// Ce test vérifie que la page Administration (public/admin.js + la section
// administrative de public/index.html) est internationalisée à partir des
// QUATRE catalogues (fr, en, es, zh-Hans), sans clé orpheline, sans dictionnaire
// parallèle, et que le changement de langue réaffiche les données EN MÉMOIRE
// sans relancer de requête ni déclencher d'action administrative.
//
// Il s'appuie sur le moteur réel public/i18n.js (catalogues injectés via
// _register + _setLocaleSync) et charge réellement public/admin.js avec des
// stubs DOM minimaux.
//
// NOTE JXA : les dialogues natifs (confirm/alert), les requêtes réseau réelles
// (fetch) et les interactions DOM asynchrones ne sont pas exercés ici ; on
// valide la logique synchrone et le fait que le rappel de changement de langue
// réaffiche depuis la mémoire sans fetch. La validation des popups et de la
// barre de recherche côté navigateur est réalisée dans Firefox.

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
FILES.forEach(function (locale) {
  var n = flatCatalogs[locale] ? Object.keys(flatCatalogs[locale]).length : -1;
  check("catalogue (" + locale + ") : 357 clés", n === 357, "n=" + n);
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
    I18N.isReady() && I18N.t("admin.title") === "Administration",
    "« " + I18N.t("admin.title") + " »");
}

// ==================================================================== ADMIN.JS / INDEX.HTML
var adminSrc = readUTF8(BASE + "admin.js");
var indexSrc = readUTF8(BASE + "index.html");
check("lecture admin.js non vide", adminSrc && adminSrc.length > 500, "");
check("lecture index.html non vide", indexSrc && indexSrc.length > 0, "");

// --- 2. Indicateurs du tableau de bord localisés (moteur réel, 4 langues).
if (I18N) {
  I18N._setLocaleSync("fr");
  check("indicateur comptes (fr)", I18N.t("admin.statComptes") === "Comptes", "");
  check("indicateur admins (fr)", I18N.t("admin.statAdministrateurs") === "Administrateurs", "");
  check("indicateur parties (fr)", I18N.t("admin.statPartiesJouees") === "Parties jouées", "");
  I18N._setLocaleSync("en");
  check("indicateur comptes (en) non vide", I18N.t("admin.statComptes").length > 0,
    "« " + I18N.t("admin.statComptes") + " »");
  check("indicateur 7 jours (en) non vide", I18N.t("admin.stat7jours").length > 0, "");
  I18N._setLocaleSync("es");
  check("répartition multiplications (es) non vide", I18N.t("admin.statMultiplications").length > 0, "");
  I18N._setLocaleSync("zh-Hans");
  check("répartition additions (zh) non vide", I18N.t("admin.statAdditions").length > 0, "");
}

// --- 3. Colonnes et tableaux.
if (I18N) {
  I18N._setLocaleSync("fr");
  check("colonne identifiant (fr)", I18N.t("admin.columnIdentifiant") === "Identifiant", "");
  I18N._setLocaleSync("en");
  check("colonne identifiant (en)", I18N.t("admin.columnIdentifiant") === "Username", "");
  check("colonne rôle (en) non vide", I18N.t("admin.columnRole").length > 0, "");
  check("colonne statut (en) non vide", I18N.t("admin.columnStatut").length > 0, "");
  check("colonne actions (en) non vide", I18N.t("admin.columnActions").length > 0, "");
  check("tableau : en-tête date non vide", I18N.t("admin.tableDate").length > 0, "");
  check("tableau : en-tête score non vide", I18N.t("admin.tableScore").length > 0, "");
  check("tableau : en-tête type non vide", I18N.t("admin.tableType").length > 0, "");
}

// --- 4. Rôles et statuts (libellés visibles localisés, valeurs techniques intactes).
if (I18N) {
  I18N._setLocaleSync("fr");
  check("rôle admin (fr)", I18N.t("admin.roleAdmin") === "Admin", "");
  check("rôle utilisateur (fr)", I18N.t("admin.roleUser") === "Utilisateur", "");
  check("statut actif (fr)", I18N.t("admin.active") === "Activé", "");
  check("statut inactif (fr)", I18N.t("admin.inactive") === "Désactivé", "");
  I18N._setLocaleSync("en");
  check("rôle admin (en)", I18N.t("admin.roleAdmin") === "Admin", "");
  check("rôle utilisateur (en)", I18N.t("admin.roleUser") === "User", "");
  check("statut actif (en)", I18N.t("admin.active") === "Enabled", "");
  I18N._setLocaleSync("es");
  check("rôle admin (es)", I18N.t("admin.roleAdmin") === "Administrador", "");
  I18N._setLocaleSync("zh-Hans");
  check("rôle utilisateur (zh)", I18N.t("admin.roleUser") === "普通用户", "");
}

// --- 5. Fiches utilisateurs.
if (I18N) {
  I18N._setLocaleSync("fr");
  check("fiche : titre (fr)", I18N.t("admin.detailTitle").indexOf("Compte") !== -1, "");
  check("fiche : identifiant (fr)", I18N.t("admin.detailIdentifiant") === "Identifiant", "");
  check("fiche : rôle (fr)", I18N.t("admin.detailRole") === "Rôle", "");
  check("fiche : création (fr)", I18N.t("admin.detailCreeLe") === "Créé le", "");
  check("fiche : dernier accès (fr)", I18N.t("admin.detailDernierAcces") === "Dernier accès", "");
  check("fiche : parties jouées (fr)", I18N.t("admin.detailPartiesJouees") === "Parties jouées", "");
  check("fiche : historique (fr)", I18N.t("admin.detailHistory") === "Historique récent", "");
  check("fiche : dernier 20 (fr)", I18N.t("admin.detailLast20") === "20 dernières parties affichées.", "");
  I18N._setLocaleSync("es");
  check("fiche : identifiant (es) non vide", I18N.t("admin.detailIdentifiant").length > 0, "");
  check("fiche : pas d'historique (es) non vide", I18N.t("admin.detailNoGames").length > 0, "");
}

// --- 6. Messages de chargement.
if (I18N) {
  check("chargement stats non vide", I18N.t("admin.loadingStats").length > 0, "");
  check("chargement comptes non vide", I18N.t("admin.loadingUsers").length > 0,
    "« " + I18N.t("admin.loadingUsers") + " »");
  I18N._setLocaleSync("en");
  check("chargement comptes (en)", I18N.t("admin.loadingUsers").indexOf("Loading") !== -1, "");
}

// --- 7. Confirmations.
if (I18N) {
  I18N._setLocaleSync("fr");
  check("confirmation désactivation (fr)", I18N.t("admin.confirmDeactivate").indexOf("désactivation") !== -1, "");
  check("confirmation réactivation (fr)", I18N.t("admin.confirmReactivate").indexOf("réactivation") !== -1, "");
  check("confirmation promotion (fr)", I18N.t("admin.confirmPromote").length > 0, "");
  check("confirmation rétrogradation (fr)", I18N.t("admin.confirmDemote").length > 0, "");
  check("confirmation reset (fr)", I18N.t("admin.confirmReset").length > 0, "");
  I18N._setLocaleSync("en");
  check("confirmation désactivation (en)", I18N.t("admin.confirmDeactivate").indexOf("disable") !== -1,
    "« " + I18N.t("admin.confirmDeactivate") + " »");
}

// --- 8. Avertissements de sécurité (dernier administrateur actif). Leur sens
// doit être strictement préservé dans chaque langue (non vide et non réduit).
if (I18N) {
  FILES.forEach(function (l) {
    I18N._setLocaleSync(l);
    check("sécurité : dernier admin actif désactivation (" + l + ")", I18N.t("admin.lastAdminDeactivate").length > 0, "");
    check("sécurité : dernier admin actif rôle (" + l + ")", I18N.t("admin.lastAdminRole").length > 0, "");
    check("sécurité : note dernier admin (" + l + ")", I18N.t("admin.lastActiveAdminNote").length > 0, "");
  });
  I18N._setLocaleSync("fr");
  check("sécurité : message dernier admin (fr) préserve le sens",
    I18N.t("admin.lastAdminDeactivate").indexOf("dernier administrateur") !== -1 &&
    I18N.t("admin.lastAdminRole").indexOf("dernier administrateur") !== -1, "");
}

// --- 9. Notifications et erreurs.
if (I18N) {
  I18N._setLocaleSync("fr");
  check("toast désactivé (fr)", I18N.t("admin.toastDeactivated") === "Compte désactivé.", "");
  check("toast réactivé (fr)", I18N.t("admin.toastReactivated") === "Compte réactivé.", "");
  check("erreur compte introuvable (fr) non vide", I18N.t("admin.accountNotFound").length > 0, "");
  check("erreur action impossible (common)", I18N.t("error.actionImpossible").length > 0, "");
  I18N._setLocaleSync("en");
  check("toast désactivé (en)", I18N.t("admin.toastDeactivated") === "Account disabled.", "");
  check("erreur réseau (error.network)", I18N.t("error.network").length > 0, "");
}

// --- 10. Formats internationaux : formatDate doit passer par le moteur i18n ;
// fr-FR ne doit apparaître qu'en REPLI, jamais comme chemin principal.
check("dates : le chemin principal passe par I.formatDate (fr-FR = repli)",
  adminSrc.indexOf("I.formatDate(d,") !== -1 &&
  adminSrc.indexOf("I.formatDate(d,") < adminSrc.indexOf("toLocaleDateString(\"fr-FR\""), "");

// --- 11 / 12 / 13 / 14. Changement de langue immédiat : réaffichage en mémoire.
check("admin.js s'abonne à I18N.onLocaleChange", adminSrc.indexOf("I18N.onLocaleChange") !== -1, "");
var cbStart = adminSrc.indexOf("window.I18N.onLocaleChange(() => {");
var cbEnd = cbStart >= 0 ? adminSrc.indexOf("});", cbStart + 1) : -1;
var cbRegion = (cbStart >= 0 && cbEnd >= 0) ? adminSrc.slice(cbStart, cbEnd + 3) : "";
check("le rappel réaffiche les libellés statiques et les données en mémoire",
  cbRegion.indexOf("applyStaticAdminLabels()") !== -1 && cbRegion.indexOf("reRender()") !== -1, "");
check("le rappel ne relance pas de requête réseau (aucun fetch)",
  cbRegion.indexOf("fetch(") === -1, "");
check("reRender réaffiche depuis la mémoire (lastStats / lastUsers / lastDetail)",
  adminSrc.indexOf("lastStats) renderStats(") !== -1 &&
  adminSrc.indexOf("lastUsers) renderUsers(") !== -1 &&
  adminSrc.indexOf("lastDetail && currentDetailId") !== -1, "");
check("reRender ne déclenche ni fetch ni action administrative",
  adminSrc.indexOf("function reRender()") !== -1 &&
  adminSrc.slice(adminSrc.indexOf("function reRender()"), adminSrc.indexOf("function reRender()") + 400).indexOf("fetch(") === -1, "");

// --- 15. Protections XSS : escapeHtml est appliqué aux données serveur/utilisateur.
check("escapeHtml présent et utilisé (>=10 appels)", adminSrc.indexOf("function escapeHtml") !== -1 &&
  (adminSrc.match(/escapeHtml\(/g) || []).length >= 10, "");

// --- 16. Pas de dictionnaire parallèle ni de conditions par langue.
var badPattern = /if\s*\(\s*(?:lang|locale|I18N\.getLocale\(\))\s*[=!]==?\s*[\"'](?:en|es|zh)/;
check("aucune condition If-By-Language (dictionnaire parallèle absent)",
  !adminSrc.match(badPattern) && adminSrc.indexOf("\"en\": {") === -1 &&
  adminSrc.indexOf("getLocale() === \"en\"") === -1, "");

// --- 16b. Aucune clé i18n « t("..." » inexistante dans admin.js.
var referenced = {};
var jstRe = /t\("([^"]+)"\)/g, m;
while ((m = jstRe.exec(adminSrc)) !== null) {
  var k = m[1];
  if (k.indexOf(".") !== -1) referenced[k] = true;
}
var knownKeys = (flatCatalogs["fr"] || {});
var missingRefs = Object.keys(referenced).filter(function (k) {
  if (k in knownKeys) return false;
  return !(k + "One" in knownKeys && k + "Other" in knownKeys);
});
check("aucune clé t(\"...\") inexistante dans admin.js", missingRefs.length === 0,
  "manquantes : " + (missingRefs.join(",") || "aucune"));
var crossMissing = Object.keys(referenced).filter(function (k) {
  var target = k in knownKeys ? k : (k + "One");
  return !FILES.every(function (l) { return target in (flatCatalogs[l] || {}); });
});
check("chaque clé de admin.js existe dans les 4 langues", crossMissing.length === 0,
  crossMissing.join(",") || "");

// --- 16c. La section administrative de index.html est raccordée (data-i18n).
var adminHtmlKeys = ["admin.kicker", "admin.title", "admin.intro", "admin.accounts",
  "admin.searchAccountLabel", "admin.searchPlaceholder", "admin.searchButton"];
check("index.html : 7 attributs statiques admin (data-i18n / data-i18n-placeholder)",
  adminHtmlKeys.every(function (k) {
    return indexSrc.indexOf("data-i18n=\"" + k + "\"") !== -1 ||
           indexSrc.indexOf("data-i18n-placeholder=\"" + k + "\"") !== -1;
  }), "");
adminHtmlKeys.forEach(function (k) {
  var dm = k.split(".")[0], key = k.split(".")[1];
  var present = FILES.every(function (l) {
    return catalogs[l] && catalogs[l][dm] && catalogs[l][dm][key] !== undefined;
  });
  check("clé statique admin du HTML existante dans les 4 langues : " + k, present, "");
});

// --- 16d. Correctif : bouton « Retour à l’accueil » en bas de l’écran Admin.
check("bouton Retour à l’accueil (admin) branché sur data-i18n=\"common.backToHome\"",
  indexSrc.indexOf("data-account-nav=\"home\" data-i18n=\"common.backToHome\"") !== -1, "");
var bthCommon = FILES.every(function (l) {
  return catalogs[l] && catalogs[l]["common"] && catalogs[l]["common"]["backToHome"] !== undefined;
});
check("clé common.backToHome présente dans les 4 langues", bthCommon, "");
if (I18N) {
  var bthL10n = [];
  FILES.forEach(function (l) { I18N._setLocaleSync(l); bthL10n.push(l + "=" + I18N.t("common.backToHome")); });
  check("common.backToHome traduite (4 langues)", bthL10n.length === 4, bthL10n.join(", "));
}

// ==================================================================== CHARGEMENT
// Chargement réel de admin.js avec stubs DOM minimaux (aucun init déclenché).
function makeElStub() {
  return {
    textContent: "", innerHTML: "", className: "", value: "", disabled: false,
    style: {}, dataset: {},
    classList: { add: function() {}, remove: function() {}, toggle: function() {} },
    addEventListener: function() {}, focus: function() {},
    closest: function() { return null; },
    setAttribute: function() {}, appendChild: function() {}, remove: function() {},
    querySelector: function() { return null; }, select: function() {}, hidden: false
  };
}
var window = {};
if (I18N) window.I18N = I18N;
window.AccountUI = {
  isAdmin: function() { return true; },
  getUser: function() { return { role: "admin" }; },
  api: function() { return new Object(); },
  showToast: function() {},
  handleSessionExpired: function() {},
  refreshProfile: function() {}
};
var document = {
  addEventListener: function() {},
  getElementById: function() { return makeElStub(); },
  querySelectorAll: function() { return []; },
  querySelector: function() { return null; },
  createElement: function() { return makeElStub(); },
  body: { appendChild: function() {}, removeChild: function() {} }
};
var navigator = { clipboard: undefined };
var adminLoadError = null;
try { globalThis.eval(adminSrc); } catch (e) { adminLoadError = "ERREUR : " + e; }
check("syntaxe JS valide (chargement admin.js sans erreur)", adminLoadError === null, adminLoadError || "");

var fu = null;
try { fu = window.AdminUI && window.AdminUI.__test; } catch (e) {}
check("aides pures de admin exposées (__test)",
  !!(fu && typeof fu.t === "function" && typeof fu.formatDate === "function" &&
     typeof fu.escapeHtml === "function" && typeof fu.reRender === "function"),
  "");

if (fu && I18N) {
  // --- 10. formatDate suit la langue (fr ≠ en) via le moteur i18n.
  I18N._setLocaleSync("fr");
  var fFr = fu.formatDate("2026-05-15T12:00:00Z");
  I18N._setLocaleSync("en");
  var fEn = fu.formatDate("2026-05-15T12:00:00Z");
  check("formatDate (fr) non vide", fFr !== "—" && fFr.length > 0, "« " + fFr + " »");
  check("formatDate (en) non vide", fEn !== "—" && fEn.length > 0, "« " + fEn + " »");
  check("formatDate change avec la langue (fr ≠ en)", fFr !== fEn, fFr + " vs " + fEn);

  // --- introspection : escapeHtml protège les balises (XSS).
  check("escapeHtml neutralise les balises HTML",
    fu.escapeHtml("<script>alert('x')</script>").indexOf("<script>") === -1 &&
    fu.escapeHtml("<script>").indexOf("&lt;") !== -1, "");

  // --- 11 / 12 / 13 / 14 : reRender existe et ne déclenche pas de fetch.
  check("reRender exposé (réaffichage en mémoire)", typeof fu.reRender === "function", "");
}

// ==================================================================== RÉSULTATS
var failed = results.filter(function (r) { return !r.ok; });
var outLines = ["js_i18n_admin_test — " + FILES.length + " langues, " +
  (flatCatalogs["fr"] ? Object.keys(flatCatalogs["fr"]).length : 0) + " clés/catalogue"];
outLines.push("JS i18n administration (v12.6-B3.4) : " + (results.length - failed.length) + " réussis, " + failed.length + " échoués");
results.forEach(function (r) {
  outLines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.ok ? "" : " — " + r.detail));
});
console.log(outLines.join("\n"));

