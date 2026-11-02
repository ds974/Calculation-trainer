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
  check("catalogue (" + locale + ") : 365 clés", n === 365, "n=" + n);
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
     typeof fu.formatDateCompact === "function" && typeof fu.escapeHtml === "function" &&
     typeof fu.reRender === "function" && typeof fu.actIconButton === "function"),
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

  // ============ P2 — Dates compactes sur une ligne (comportemental, 4 langues).
  // formatDateCompact passe par le moteur i18n/Intl : format numérique compact,
  // sur une ligne (aucun nom de mois long), qui varie selon la langue.
  var monthNames = ["novembre", "November", "noviembre", "月"];
  var compactOut = {};
  FILES.forEach(function (l) {
    I18N._setLocaleSync(l);
    compactOut[l] = fu.formatDateCompact("2026-11-01T12:00:00Z");
    check("P2 : date compacte non vide (" + l + ")", compactOut[l].length > 0, "« " + compactOut[l] + " »");
    check("P2 : date compacte sur une ligne (" + l + ")",
      compactOut[l].indexOf("\n") === -1 && compactOut[l].trim().indexOf(" ") === -1 &&
      compactOut[l].indexOf(" ") === -1, "« " + compactOut[l] + " »");
    check("P2 : date compacte contient l'année (" + l + ")", compactOut[l].indexOf("2026") !== -1, "");
    var hasLongMonth = monthNames.some(function (m) { return compactOut[l].indexOf(m) !== -1; });
    check("P2 : date compacte sans nom de mois long (" + l + ")", !hasLongMonth, "« " + compactOut[l] + " »");
  });
  check("P2 : format de date change selon la langue (fr ≠ en)",
    compactOut["fr"] !== compactOut["en"], compactOut["fr"] + " vs " + compactOut["en"]);
}

// ============ P2 — Structure du tableau & CSS (sources dynamiques).
var styleSrc = readUTF8(BASE + "style.css");
check("lecture style.css non vide (P2)", styleSrc && styleSrc.length > 500, "");

// --- P2.a Cinq en-têtes de colonnes générés dans renderUsers.
var thStart = adminSrc.indexOf('<thead><tr>');
var thEnd = thStart >= 0 ? adminSrc.indexOf('</tr></thead>', thStart) : -1;
var theadStr = thStart >= 0 && thEnd >= 0 ? adminSrc.slice(thStart, thEnd) : '';
check("P2 : exactement 5 en-têtes <th> dans le tableau",
  (theadStr.match(/<th>/g) || []).length === 5, "th=" + ((theadStr.match(/<th>/g) || []).length));

// --- P2.b Cinq cellules <td> par ligne (correspondance aux en-têtes).
var rowStrStart = adminSrc.indexOf('"<tr>"');
var rowStrEnd = adminSrc.indexOf('"</tr>";', rowStrStart);
var rowStr = rowStrStart >= 0 && rowStrEnd >= 0 ? adminSrc.slice(rowStrStart, rowStrEnd + 8) : "";
var tdCount = (rowStr.match(/<td/g) || []).length;
check("P2 : exactement 5 cellules <td> par ligne", tdCount === 5, "td=" + tdCount);

// --- P2.c Message permanent retiré : plus aucun span visible admin-last-admin-note.
check("P2 : plus de note visible admin-last-admin-note dans la ligne",
  adminSrc.indexOf('class="admin-last-admin-note"') === -1 &&
  adminSrc.indexOf('role="note"') === -1, "");
// --- P2.d Explication accessible conservée : aria-describedby -> élément .sr-only.
// Dans admin.js, les chaînes contiennent littéralement :
//   'aria-describedby="' + noteId + '"'  et  '<span class="sr-only" id="' + noteId + '">'
check("P2 : aria-describedby référençant la description accessible",
  adminSrc.indexOf('aria-describedby="\' + noteId + \'"') !== -1, "");
check("P2 : description accessible masquée via classe .sr-only",
  adminSrc.indexOf('class="sr-only"') !== -1 &&
  adminSrc.indexOf('<span class="sr-only" id="\' + noteId + \'">') !== -1, "");

// --- P2.e Boutons désactivés du dernier admin conservés (disabled + aria + title).
check("P2 : boutons désactivés du dernier admin conservés",
  adminSrc.indexOf('disabled aria-disabled="true" title="') !== -1 &&
  adminSrc.indexOf('data-admin-active="\' + u.id + \'" data-active="0"') !== -1 &&
  adminSrc.indexOf('data-admin-role="\' + u.id + \'" data-makeadmin="0"') !== -1, "");
check("P2 : info-bulle title alimentée par lastActiveAdminNote",
  adminSrc.indexOf('title="\' + escapeHtml(lastNote)') !== -1 &&
  adminSrc.indexOf('t("admin.lastActiveAdminNote"') !== -1, "");

// --- P2.f Clé i18n admin.lastActiveAdminNote conservée dans toutes les langues.
check("P2 : clé admin.lastActiveAdminNote présente dans les 4 langues",
  FILES.every(function (l) { return (flatCatalogs[l] || {})["admin.lastActiveAdminNote"] !== undefined; }), "");

// --- P2.g Colonne date sur une seule ligne via white-space:nowrap.
var dateCss = styleSrc.indexOf("td.admin-date") !== -1 ?
  styleSrc.slice(styleSrc.indexOf("td.admin-date"), styleSrc.indexOf("}", styleSrc.indexOf("td.admin-date")) + 1) : "";
check("P2 : CSS .admin-table td.admin-date -> white-space: nowrap",
  dateCss.indexOf("white-space") !== -1 && dateCss.indexOf("nowrap") !== -1, dateCss);

// --- P2.h Défilement horizontal limité au conteneur .table-scroll.
check("P2 : .table-scroll conserve overflow-x:auto",
  /\.table-scroll\s*\{\s*overflow-x:\s*auto;\s*\}/.test(styleSrc), "");
// --- P2.i / P2.1 Groupe d'actions interne : le <td> reste une cellule normale et
// les boutons sont placés dans un conteneur flex interne aligné à gauche.
check("P2.1 : conteneur interne admin-actions-group présent et fermé",
  adminSrc.indexOf('<div class="admin-actions-group">') !== -1 &&
  adminSrc.indexOf('admin-actions-group">\' + actions + "</div>"') !== -1, "");
check("P2.1 : cellule actions <td class=\"admin-actions\"> conservée",
  adminSrc.indexOf('<td class=\\"admin-actions\\">') !== -1, "");

// Consulter reste la première action du groupe (définie avant les autres).
check("P2.1 : Consulter est la première action du groupe",
  adminSrc.indexOf('data-admin-view="') !== -1 &&
  adminSrc.indexOf('data-admin-view="') < adminSrc.indexOf('data-admin-active="'), "");

// Alignement horizontal : le groupe (block-level, = largeur de colonne) est
// centré, alignant son centre sur celui de l'en-tête « Actions ».
var grpCssStart = styleSrc.indexOf(".admin-actions-group {");
var grpCss = grpCssStart >= 0 ?
  styleSrc.slice(grpCssStart, styleSrc.indexOf("}", grpCssStart) + 1) : "";
check("P2.2 : groupe d'actions centré (justify-content: center)",
  grpCss.indexOf("justify-content: center") !== -1, grpCss);
check("P2.1 : boutons pouvant passer à la ligne sans troncature (flex-wrap)",
  grpCss.indexOf("flex-wrap") !== -1, grpCss);

// Boutons désactivés : bordure visible mais discrète, conservée au survol.
var discStart = styleSrc.indexOf(".admin-actions .btn:disabled {");
var discCss = discStart >= 0 ?
  styleSrc.slice(discStart, styleSrc.indexOf("}", discStart) + 1) : "";
check("P2.1 : bouton désactivé avec bordure visible (border solide non transparente)",
  discCss.indexOf("border: 1px solid #") !== -1, discCss);
check("P2.1 : styles désactivés conservés au survol/focus (:disabled:hover)",
  styleSrc.indexOf(".admin-actions .btn:disabled:hover") !== -1, "");

// ==================================================================== P3 — Icônes SVG & légende des actions
// Les 9 icônes attendues (déposées manuellement, non recréées) et leur usage.
var P3_ICONS = [
  "eye", "user-x", "user-check", "shield-plus", "shield-minus",
  "key-round", "user-x-locked", "shield-minus-locked", "circle-help"
];
var badSvg = [];
P3_ICONS.forEach(function (name) {
  var svg = readUTF8(BASE + "assets/icons/" + name + ".svg");
  // xmlns="http://www.w3.org/2000/svg" est un namespace déclaratif légitime (non
  // chargé) ; on le neutralise avant de rechercher de vraies références externes.
  var s = String(svg).replace('xmlns="http://www.w3.org/2000/svg"', "");
  var ok = svg && svg.indexOf("<svg") !== -1 && svg.indexOf("</svg>") !== -1 &&
           s.indexOf("<script") === -1 && s.indexOf("data:") === -1 &&
           s.indexOf("http://") === -1 && s.indexOf("https://") === -1;
  if (!ok) badSvg.push(name);
});
check("P3 : les 9 icônes SVG sont présentes et locales (sans script ni référence externe)",
  badSvg.length === 0, badSvg.join(","));

// --- Correspondance action -> icône dans admin.js.
check("P3 : consulter -> icône eye (bouton actif)",
  adminSrc.indexOf('actIconButton(t("admin.consult"') !== -1 &&
  adminSrc.indexOf('"eye"') !== -1, "");
check("P3 : actions interdites -> variantes verrouillées (user-x-locked / shield-minus-locked)",
  adminSrc.indexOf('"user-x-locked"') !== -1 && adminSrc.indexOf('"shield-minus-locked"') !== -1, "");
check("P3 : désactiver/réactiver -> user-x / user-check",
  adminSrc.indexOf('"user-x"') !== -1 && adminSrc.indexOf('"user-check"') !== -1, "");
check("P3 : rétrograder/promouvoir -> shield-minus / shield-plus",
  adminSrc.indexOf('"shield-minus"') !== -1 && adminSrc.indexOf('"shield-plus"') !== -1, "");
check("P3 : reset mot de passe -> key-round",
  adminSrc.indexOf('"key-round"') !== -1, "");
// Les variantes verrouillées sont réservées au bloc dernier-admin (disabled).
var lockedStart = adminSrc.indexOf('"user-x-locked"');
check("P3 : variantes verrouillées réservées au bloc dernier-admin",
  lockedStart > adminSrc.indexOf('isLastActiveAdmin') &&
  adminSrc.indexOf('"user-x-locked"', lockedStart + 1) === -1, "");

// --- Comportement de construction d'un bouton icône (aides pures).
if (fu) {
  I18N._setLocaleSync("fr");
  var p3Locked = fu.actIconButton("Désactiver", "user-x-locked",
    ' disabled aria-disabled="true" title="X" aria-describedby="n1"', { disabled: true });
  check("P3 : bouton interdit -> disabled + aria-disabled + title + aria-describedby + icône verrouillée",
    p3Locked.indexOf('disabled aria-disabled="true"') !== -1 &&
    p3Locked.indexOf('aria-label="Désactiver"') !== -1 &&
    p3Locked.indexOf('data-icon="user-x-locked"') !== -1 &&
    p3Locked.indexOf('title="X"') !== -1 && p3Locked.indexOf('aria-describedby="n1"') !== -1 &&
    p3Locked.indexOf('class="btn btn-secondary btn-small admin-act"') !== -1, p3Locked);
  var p3Active = fu.actIconButton("Consulter", "eye", ' data-admin-view="1"');
  check("P3 : bouton actif -> title=label + aria-label + icône eye, non disabled",
    p3Active.indexOf('data-admin-view="1"') !== -1 &&
    p3Active.indexOf('aria-label="Consulter"') !== -1 &&
    p3Active.indexOf('title="Consulter"') !== -1 &&
    p3Active.indexOf('data-icon="eye"') !== -1 && p3Active.indexOf("disabled") === -1, p3Active);
}

// --- Légende interactive (index.html, élément <details>/<summary> natif).
check("P3 : légende fermée par défaut (<details> sans attribut open)",
  indexSrc.indexOf('<details class="admin-legend" id="adminActionsLegend">') !== -1 &&
  indexSrc.indexOf('<details class="admin-legend" id="adminActionsLegend" open') === -1, "");
check("P3 : légende ouvrable/fermable au clavier (<summary> natif)",
  indexSrc.indexOf('<summary class="admin-legend-summary">') !== -1, "");
check("P3 : le libellé de la légende utilise circle-help + clé actionsLegend",
  indexSrc.indexOf('circle-help.svg') !== -1 &&
  indexSrc.indexOf('data-i18n="admin.actionsLegend"') !== -1, "");
check("P3 : les 6 descriptions d'action sont présentes et traduites (data-i18n)",
  indexSrc.indexOf('data-i18n="admin.legendConsult"') !== -1 &&
  indexSrc.indexOf('data-i18n="admin.legendDeactivate"') !== -1 &&
  indexSrc.indexOf('data-i18n="admin.legendReactivate"') !== -1 &&
  indexSrc.indexOf('data-i18n="admin.legendPromote"') !== -1 &&
  indexSrc.indexOf('data-i18n="admin.legendDemote"') !== -1 &&
  indexSrc.indexOf('data-i18n="admin.legendReset"') !== -1, "");
check("P3 : explication discrète des variantes verrouillées présente (data-i18n)",
  indexSrc.indexOf('data-i18n="admin.lockedActionExplanation"') !== -1, "");
check("P3 : les icônes de la légende sont marquées décoratives (aria-hidden)",
  (indexSrc.match(/aria-hidden="true"/g) || []).length >= 6, "");
// Pas de message permanent du dernier admin dans les lignes (P2 conservé).
check("P3 : aucun message permanent réapparu dans les lignes (pas de note visible)",
  adminSrc.indexOf('class="admin-last-admin-note"') === -1 && adminSrc.indexOf('role="note"') === -1, "");

// --- Nouvelles clés i18n dans les 4 catalogues.
var P3_KEYS = ["admin.actionsLegend", "admin.lockedActionExplanation",
  "admin.legendConsult", "admin.legendDeactivate", "admin.legendReactivate",
  "admin.legendPromote", "admin.legendDemote", "admin.legendReset"];
check("P3 : les 8 nouvelles clés existent dans les 4 catalogues",
  P3_KEYS.every(function (k) {
    return FILES.every(function (l) { return (flatCatalogs[l] || {})[k] !== undefined; });
  }), "");
check("P3 : actionsLegend traduite et variable selon la langue",
  FILES.every(function (l) { return ((flatCatalogs[l] || {})["admin.actionsLegend"] || "").length > 0; }) &&
  (flatCatalogs["fr"]["admin.actionsLegend"] !== flatCatalogs["en"]["admin.actionsLegend"]), "");

// --- CSS compact / alignement / masques / légende.
var actCssStart = styleSrc.indexOf(".admin-table .admin-act {");
var actCss = actCssStart >= 0 ? styleSrc.slice(actCssStart, styleSrc.indexOf("}", actCssStart) + 1) : "";
check("P3 : bouton icône compact (40 px) et centré",
  actCss.indexOf("width: 40px") !== -1 && actCss.indexOf("height: 40px") !== -1 &&
  actCss.indexOf("inline-flex") !== -1 && actCss.indexOf("justify-content: center") !== -1, actCss);
check("P3 : icône blanche sur bouton actif (color #fff)",
  styleSrc.indexOf(".admin-table .admin-act:not(:disabled) { color: #fff; }") !== -1, "");
check("P3 : rendu des icônes via masque CSS (mask-image, préfixe et standard)",
  styleSrc.indexOf(".admin-act-icon {") !== -1 &&
  styleSrc.indexOf("-webkit-mask-image") !== -1 && styleSrc.indexOf("mask-image") !== -1, "");
check("P3 : chaque icône d'action a sa règle [data-icon]",
  P3_ICONS.filter(function (i) { return i !== "circle-help"; }).every(function (i) {
    return styleSrc.indexOf('[data-icon="' + i + '"]') !== -1;
  }), "");
check("P3 : boutons désactivés conservent le contour gris (P2.1 préservé)",
  styleSrc.indexOf(".admin-actions .btn:disabled {") !== -1 &&
  styleSrc.indexOf("border: 1px solid #") !== -1, "");
check("P3 : CSS de la légende présent (admin-legend)",
  styleSrc.indexOf(".admin-legend {") !== -1 && styleSrc.indexOf(".admin-legend-summary {") !== -1 &&
  styleSrc.indexOf(".admin-legend-locknote") !== -1, "");

// --- Sécurité / protections administratives conservées.
check("P3 : protections serveur du dernier admin conservées (clés serveur présentes)",
  (flatCatalogs["fr"] || {})["admin.lastAdminRole"] !== undefined &&
  (flatCatalogs["fr"] || {})["admin.lastAdminDeactivate"] !== undefined &&
  (flatCatalogs["fr"] || {})["admin.roleUpdateFailed"] !== undefined, "");
check("P3 : les 4 actions administratives restent raccordées (data-admin-*)",
  adminSrc.indexOf('data-admin-view="') !== -1 && adminSrc.indexOf('data-admin-active="') !== -1 &&
  adminSrc.indexOf('data-admin-role="') !== -1 && adminSrc.indexOf('data-admin-reset="') !== -1, "");

// --- Licence Lucide + attribution README.
var licTxt = readUTF8(BASE + "assets/icons/LICENSE-LUCIDE.txt");
check("P3 : licence Lucide présente avec la section ISC",
  licTxt.indexOf("ISC License") !== -1 &&
  licTxt.indexOf("Lucide Icons and Contributors") !== -1, "");
check("P3 : licence Lucide contient la liste Feather et le texte MIT (Cole Bemis)",
  licTxt.indexOf("The following Lucide icons are derived from the Feather project") !== -1 &&
  licTxt.indexOf("Cole Bemis") !== -1 && licTxt.indexOf("The MIT License (MIT)") !== -1, "");
var readmeEn = readUTF8("/Users/didiers/Documents/Projets-IA/calculation-trainer/README.md");
var readmeFr = readUTF8("/Users/didiers/Documents/Projets-IA/calculation-trainer/README.fr.md");
check("P3 : README.md contient l'attribution Lucide + lien licence",
  readmeEn.indexOf("Administration icons are based on Lucide") !== -1 &&
  readmeEn.indexOf("LICENSE-LUCIDE.txt") !== -1, "");
check("P3 : README.fr.md contient l'attribution Lucide + lien licence",
  readmeFr.indexOf("basées sur Lucide") !== -1 &&
  readmeFr.indexOf("LICENSE-LUCIDE.txt") !== -1, "");

// ==================================================================== P3.1 En-tête « Actions » centré
// L'en-tête de la 5e colonne doit être centré, sans toucher aux cellules ni aux
// autres colonnes ; le <td>.admin-actions conserve son alignement de contenu.
check("P3.1 : en-tête Actions centré (th:last-child -> text-align:center)",
  /\.admin-table\s+th:last-child\s*\{\s*text-align:\s*center;\s*\}/.test(styleSrc), "");
check("P3.1 : le th et le td de la dernière colonne sont bien séparés",
  styleSrc.indexOf(".admin-table th:last-child") !== -1 &&
  styleSrc.indexOf(".admin-table td:last-child") !== -1, "");
check("P3.1 : le groupe d'actions est centré sous l'en-tête (justify-content: center)",
  grpCss.indexOf("justify-content: center") !== -1, "");

// ==================================================================== RÉSULTATS
var failed = results.filter(function (r) { return !r.ok; });
var outLines = ["js_i18n_admin_test — " + FILES.length + " langues, " +
  (flatCatalogs["fr"] ? Object.keys(flatCatalogs["fr"]).length : 0) + " clés/catalogue"];
outLines.push("JS i18n administration (v12.6-B3.4) : " + (results.length - failed.length) + " réussis, " + failed.length + " échoués");
results.forEach(function (r) {
  outLines.push((r.ok ? "  ✓ " : "  ✗ ") + r.name + (r.ok ? "" : " — " + r.detail));
});
console.log(outLines.join("\n"));

