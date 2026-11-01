/* ==========================================================================
 * i18n.js — Moteur d'internationalisation (v12.6-B2)
 * --------------------------------------------------------------------------
 * Mission Calcul Mental
 *
 * Moteur JavaScript natif (aucun framework) qui charge les catalogues JSON
 * du dossier /i18n/ (fr, en, es, zh-Hans) et fournit :
 *   - I18N.init()                     : détection / mémorisation + application
 *   - I18N.t(key, vars)               : traduction simple + interpolation {var}
 *   - I18N.pl(baseKey, count, vars)   : pluriels (Intl.PluralRules, One/Other)
 *   - I18N.setLocale(locale)          : impose une langue (Async)
 *   - I18N.getLocale()                : langue courante
 *   - I18N.formatNumber(value)        : formatage via Intl.NumberFormat
 *   - I18N.formatDate(value, options) : formatage via Intl.DateTimeFormat
 *   - I18N.onLocaleChange(cb)         : abonnement au changement de langue
 *
 * Les quatre catalogues JSON sont LA SEULE source des textes traduits :
 * aucun dictionnaire n'est codé ici en dur.
 *
 * Architecture :
 *   - Le coeur (t/pl/formatNumber/formatDate/getLocale) est SYNCHRONE et lit
 *     un cache mémoire. Il fonctionne donc sans navigateur (tests JXA).
 *   - Les effets de bord (fetch, DOM, localStorage) sont isolés dans init() et
 *     setLocale() (async). La protection « désordre » garantit que seules les
 *     réponses du dernier chargement demandé sont appliquées.
 * ========================================================================== */
(function (global) {
  "use strict";

  // Langues prises en charge (ordre de présentation du sélecteur).
  var SUPPORTED = ["fr", "en", "es", "zh-Hans"];

  // Clé localStorage de la préférence manuelle.
  var STORAGE_KEY = "missionCalculMental.locale";

  // Langue de repli.
  var FALLBACK = "fr";

  // Chemins des catalogues relatifs à la page.
  var CATALOG_PATH = "i18n/";

  // ------------------------------------------------------------------ État
  var catalogCache = {};    // locale -> données JSON
  var currentLocale = null; // langue réellement active (catalogues chargés)
  var desiredLocale = null; // dernière langue demandée
  var loadToken = 0;        // compteur anti-désordre (chargements asynchrones)
  var listeners = [];       // callbacks i18n:changed

  // ------------------------------------------------------------------ Utils

  function hasOwn(obj, key) {
    return Object.prototype.hasOwnProperty.call(obj, key);
  }

  /** Résout une clé « domaine.cle » (ou imbriquée) dans un catalogue. */
  function resolveKey(catalog, key) {
    if (!catalog || !key) return undefined;
    var parts = String(key).split(".");
    var node = catalog;
    for (var i = 0; i < parts.length; i++) {
      if (node == null || typeof node !== "object" || !hasOwn(node, parts[i])) {
        return undefined;
      }
      node = node[parts[i]];
    }
    return node;
  }

  /**
   * Normalise un code de langue fourni par l'utilisateur vers l'un des codes
   * pris en charge, ou undefined s'il est introuvable.
   */
  function normalizeLocale(locale) {
    if (!locale) return undefined;
    var l = String(locale).toLowerCase();
    if (SUPPORTED.indexOf(l) !== -1) return l;
    // Variantes régionales reconnues.
    if (l === "zh-hans" || l === "zh-cn" || l === "zh-sg") return "zh-Hans";
    // IMPORTANT : zh-TW, zh-HK, zh-MO et zh-Hant ne sont PAS convertis en
    // chinois simplifié -> on les ignore.
    if (l === "fr" || l.indexOf("fr-") === 0) return "fr";
    if (l === "en" || l.indexOf("en-") === 0) return "en";
    if (l === "es" || l.indexOf("es-") === 0) return "es";
    return undefined;
  }

  /**
   * Détecte la langue à partir de navigator.languages, dans l'ordre de
   * préférence du navigateur, sans toucher au chinois traditionnel.
   */
  function detectFromNavigator() {
    if (typeof navigator === "undefined" || !navigator.languages) return undefined;
    for (var i = 0; i < navigator.languages.length; i++) {
      var norm = normalizeLocale(navigator.languages[i]);
      if (norm) return norm;
    }
    return undefined;
  }

  // ------------------------------------------------ Accès synchrone au cache

  /** Internal : enregistre un catalogue dans le cache (tests / préchargement). */
  function _register(locale, data) {
    var norm = normalizeLocale(locale);
    if (!norm) return;
    catalogCache[norm] = data || {};
  }

  /** Internal : définit la langue courante de façon SYNCHRONE (cache déjà prêt). */
  function _setLocaleSync(locale) {
    var norm = normalizeLocale(locale);
    if (!norm || !hasOwn(catalogCache, norm)) return false;
    currentLocale = norm;
    return true;
  }

  /**
   * Internal : récupère la traduction d'une clé (repli sur le français).
   * Renvoie la clé elle-même si aucun catalogue ne la contient.
   */
  function _translate(locale, key) {
    if (!key) return "";
    var v = resolveKey(catalogCache[locale], key);
    if (v === undefined && locale !== FALLBACK) {
      v = resolveKey(catalogCache[FALLBACK], key);
    }
    if (v === undefined || typeof v !== "string") {
      return key; // clé introuvable -> on expose la clé (jamais une erreur)
    }
    return v;
  }

  /** Interpole les {variables} dans une chaîne. */
  function interpolate(template, vars) {
    if (!vars) return template;
    return String(template).replace(/\{([^{}]+)\}/g, function (m, name) {
      return Object.prototype.hasOwnProperty.call(vars, name)
        ? String(vars[name])
        : m;
    });
  }

  /**
   * Résout la variante plurielle d'une clé de base (« stats.game ») en
   * « stats.gameOne » / « stats.gameOther » selon Intl.PluralRules.
   */
  function _pluralKey(baseKey, count) {
    var norm = currentLocale || FALLBACK;
    var category = "other";
    if (typeof Intl !== "undefined" && typeof Intl.PluralRules === "function") {
      try {
        category = new Intl.PluralRules(norm).select(count);
      } catch (e) {
        category = count === 1 ? "one" : "other";
      }
    } else {
      category = count === 1 ? "one" : "other";
    }
    var variant = category === "one" ? "One" : "Other";
    var key = baseKey + variant;

    // Si la variante choisie par Intl est absente, on tente l'autre.
    // Cas notable : le chinois n'a pas de catégorie « one » dans Intl, mais le
    // catalogue fournit quand même un variant « One » pour count === 1.
    if (resolveKey(catalogCache[norm], key) === undefined) {
      var alt = variant === "One" ? "Other" : "One";
      if (resolveKey(catalogCache[norm], baseKey + alt) !== undefined) {
        key = baseKey + alt;
        variant = alt;
      } else if (count === 1 && resolveKey(catalogCache[norm], baseKey + "One") !== undefined) {
        key = baseKey + "One";
        variant = "One";
      }
    }
    return key;
  }

  // -------------------------------------------------------------- Effets de bord

  /** Applique la langue courante au DOM (html lang, title, data-i18n…). */
  function applyToDom() {
    if (typeof document === "undefined") return;

    // Attribut <html lang>.
    var html = document.documentElement;
    if (html) html.setAttribute("lang", currentLocale);

    // Titre du document (clé documentaire traduite).
    var docTitle = _translate(currentLocale, "doc.title");
    if (docTitle && docTitle !== "doc.title") document.title = docTitle;

    // Éléments statiques marqués [data-i18n] (textContent uniquement).
    if (document.querySelectorAll) {
      document.querySelectorAll("[data-i18n]").forEach(function (el) {
        var key = el.getAttribute("data-i18n");
        if (key) el.textContent = _translate(currentLocale, key);
      });
      // Attributs traduisibles, sans injecter de HTML.
      [
        ["data-i18n-placeholder", "placeholder"],
        ["data-i18n-title", "title"],
        ["data-i18n-aria-label", "aria-label"],
        ["data-i18n-tooltip", "data-tooltip"]
      ].forEach(function (pair) {
        document.querySelectorAll("[" + pair[0] + "]").forEach(function (el) {
          var key = el.getAttribute(pair[0]);
          if (key) el.setAttribute(pair[1], _translate(currentLocale, key));
        });
      });
    }

    // Synchronise le libellé du sélecteur (uniquement s'il existe).
    if (global.I18N && global.I18N._syncSelectorDisplay) {
      global.I18N._syncSelectorDisplay();
    }
  }

  function dispatchChange() {
    if (typeof document !== "undefined") {
      try {
        document.dispatchEvent(new CustomEvent("i18n:changed", {
          detail: { locale: currentLocale }
        }));
      } catch (e) { /* CustomEvent indisponible (environnements sans DOM) */ }
    }
    for (var i = 0; i < listeners.length; i++) {
      try { listeners[i](currentLocale); } catch (e) {}
    }
  }

  /**
   * Garantit qu'un catalogue est présent dans le cache (fetch si nécessaire).
   * Renvoie toujours une promesse résolue (catalogue ou {} en cas d'échec).
   */
  function ensureCatalog(locale) {
    if (hasOwn(catalogCache, locale)) {
      return Promise.resolve(catalogCache[locale]);
    }
    if (typeof fetch !== "function") {
      // Pas de fetch (tests JXA) -> catalogue inconnu.
      return Promise.resolve({});
    }
    var url = CATALOG_PATH + locale + ".json";
    return fetch(url)
      .then(function (res) {
        if (!res.ok) throw new Error("HTTP " + res.status);
        return res.json();
      })
      .then(function (data) {
        catalogCache[locale] = data;
        return data;
      })
      .catch(function () {
        catalogCache[locale] = {}; // évite de re-télécharger en boucle
        return {};
      });
  }


  // ===================================================================== API

  /**
   * Initialise le moteur : résout la langue (préférence manuelle localement
   * puis détection navigateur, sinon français), charge le catalogue, applique
   * au DOM et met en place le sélecteur de langue.
   */
  function init() {
    // 1) Préférence manuelle mémorisée (jamais écrasée par la détection).
    var chosen = FALLBACK;
    var saved = null;
    try {
      if (typeof localStorage !== "undefined") saved = localStorage.getItem(STORAGE_KEY);
    } catch (e) { /* localStorage indisponible */ }
    var savedNorm = normalizeLocale(saved);
    if (savedNorm) {
      chosen = savedNorm;
    } else {
      var detected = detectFromNavigator();
      chosen = detected || FALLBACK;
    }
    desiredLocale = chosen;

    var token = ++loadToken;
    return ensureCatalog(chosen).then(function () {
      if (token !== loadToken) return; // un chargement plus récent est en cours
      currentLocale = chosen;
      wireSelector();
      applyToDom();
      dispatchChange();
      return chosen;
    });
  }

  /** Traduction simple + interpolation de {variables}. Repli sur le français. */
  function t(key, vars) {
    var locale = currentLocale || FALLBACK;
    return interpolate(_translate(locale, key), vars);
  }

  /**
   * Pluriel : « stats.game » + count -> stats.gameOne / stats.gameOther.
   * Les {variables} sont interpolées après sélection de la variante.
   */
  function pl(baseKey, count, vars) {
    var locale = currentLocale || FALLBACK;
    var key = _pluralKey(baseKey, typeof count === "number" ? count : 1);
    var merged = Object.assign({}, vars || {});
    merged.count = count;
    return interpolate(_translate(locale, key), merged);
  }

  /**
   * Impose une langue (Async).
   *
   * Par défaut, enregistre la préférence dans localStorage (choix manuel de
   * l'invité, via le sélecteur). Passer `{ persist: false }` permet d'appliquer
   * une langue issue du COMPTE (`preferred_language`) SANS modifier la
   * préférence locale invitée. L'événement i18n:changed est toujours déclenché
   * en fin d'application.
   */
  function setLocale(locale, options) {
    var persist = !options || options.persist !== false;
    var norm = normalizeLocale(locale) || FALLBACK;
    if (norm === currentLocale && hasOwn(catalogCache, norm)) {
      return Promise.resolve(currentLocale);
    }
    desiredLocale = norm;
    var token = ++loadToken;
    try {
      if (persist && typeof localStorage !== "undefined") localStorage.setItem(STORAGE_KEY, norm);
    } catch (e) { /* ignore */ }
    return ensureCatalog(norm).then(function () {
      if (token !== loadToken) return currentLocale; // une demande plus récente gagne
      currentLocale = norm;
      applyToDom();
      dispatchChange();
      return currentLocale;
    });
  }

  /**
   * Restaure la langue INVITÉE (choix manuel du navigateur, ou détection à
   * défaut) sans jamais écrire dans localStorage et sans modifier la
   * préférence du compte. À utiliser lors d'une déconnexion ou d'une
   * expiration de session. Renvoie une promesse résolue avec le code appliqué.
   */
  function restoreGuestPreference() {
    var guest = FALLBACK;
    var saved = null;
    try {
      if (typeof localStorage !== "undefined") saved = localStorage.getItem(STORAGE_KEY);
    } catch (e) { /* localStorage indisponible */ }
    var savedNorm = normalizeLocale(saved);
    guest = savedNorm || detectFromNavigator() || FALLBACK;
    return setLocale(guest, { persist: false });
  }

  /** Langue courante (code, ex. « fr », « zh-Hans »). */
  function getLocale() {
    return currentLocale || FALLBACK;
  }

  /** Vrai si un catalogue est réellement chargé pour la langue courante. */
  function isReady() {
    return !!currentLocale && hasOwn(catalogCache, currentLocale);
  }

  /** Formate un nombre selon la langue courante. */
  function formatNumber(value) {
    try {
      return new Intl.NumberFormat(getLocale()).format(value);
    } catch (e) {
      return String(value);
    }
  }

  /** Formate une date (Date ou nombre) selon la langue courante. */
  function formatDate(value, options) {
    try {
      return new Intl.DateTimeFormat(getLocale(), options || {}).format(
        value instanceof Date ? value : new Date(value)
      );
    } catch (e) {
      return String(value);
    }
  }

  /** Abonnement au changement de langue ; renvoie une fonction de désabonnement. */
  function onLocaleChange(cb) {
    if (typeof cb === "function") listeners.push(cb);
    return function () {
      listeners = listeners.filter(function (f) { return f !== cb; });
    };
  }

  // ======================================================= Sélecteur de langue

  // Données du sélecteur : libellé affiché (menu fermé) + libellé déplié.
  // Les noms de langues sont présentés dans leur forme native (autonymes) et
  // sont donc identiques quelle que soit la langue de l'interface.
  var LANGUI = {
    fr:       { short: "FR", label: "Français" },
    en:       { short: "EN", label: "English" },
    es:       { short: "ES", label: "Español" },
    "zh-Hans": { short: "ZH", label: "简体中文" }
  };

  var selector = null;     // conteneur racine
  var selectorBtn = null;  // bouton déclencheur
  var selectorList = null; // liste dépliée (listbox)
  var selectorOpen = false;

  function supportedLabel(locale) {
    return LANGUI[locale] || LANGUI[FALLBACK];
  }

  /** Met à jour le libellé du bouton (« FR ▾ », « ZH ▾ »…). */
  function _syncSelectorDisplay() {
    if (!selectorBtn) return;
    var li = supportedLabel(currentLocale || FALLBACK);
    selectorBtn.firstChild.textContent = li.short;
  }

  function setSelectorOpen(open) {
    selectorOpen = !!open;
    if (!selector) return;
    selector.classList.toggle("is-open", selectorOpen);
    if (selectorBtn) selectorBtn.setAttribute("aria-expanded", String(selectorOpen));
    if (selectorOpen && selectorList) {
      // Focus sur l'option active.
      var active = selectorList.querySelector('[aria-selected="true"]') ||
                   selectorList.querySelector('[role="option"]');
      if (active && typeof active.focus === "function") active.focus();
    }
  }

  function selectLocale(locale, needFocus) {
    setLocale(locale).then(function () {
      setSelectorOpen(false);
      if (needFocus && selectorBtn && typeof selectorBtn.focus === "function") {
        selectorBtn.focus();
      }
    });
  }

  function handleOptionKey(event, locale) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      selectLocale(locale, true);
      return;
    }
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      var items = Array.prototype.slice.call(selectorList.querySelectorAll('[role="option"]'));
      var idx = items.indexOf(event.target);
      var next = event.key === "ArrowDown" ? idx + 1 : idx - 1;
      if (next < 0) next = items.length - 1;
      if (next >= items.length) next = 0;
      items[next].focus();
    }
  }


  /** Souligne visuellement la langue active dans la liste. */
  function refreshSelectorState(locale) {
    if (typeof document === "undefined" || !selectorList) return;
    Array.prototype.slice.call(selectorList.querySelectorAll('[role="option"]')).forEach(function (item) {
      var itemLocale = item.id.replace(/^langOption-/, "").toLowerCase();
      var active = itemLocale === locale || itemLocale === String(locale).toLowerCase();
      item.setAttribute("aria-selected", active ? "true" : "false");
      item.classList.toggle("is-active", active);
    });
  }

  /** Construit et insère le sélecteur dans #accountNavBar (haut à droite). */
  function wireSelector() {
    if (typeof document === "undefined") return;
    if (selector) return; // déjà en place
    var nav = document.getElementById("accountNavBar");
    if (!nav) return;

    selector = document.createElement("div");
    selector.className = "lang-selector";
    selector.id = "languageSelector";

    var hidden = document.createElement("span");
    hidden.className = "sr-only";
    hidden.textContent = _translate(currentLocale || FALLBACK, "nav.accountBar");

    selectorBtn = document.createElement("button");
    selectorBtn.type = "button";
    selectorBtn.className = "lang-selector__trigger";
    selectorBtn.setAttribute("aria-haspopup", "listbox");
    selectorBtn.setAttribute("aria-expanded", "false");
    selectorBtn.setAttribute("aria-controls", "languageSelectorList");
    selectorBtn.dataset.tooltip = _translate(currentLocale || FALLBACK, "nav.accountBar");
    selectorBtn.appendChild(document.createTextNode(supportedLabel(getLocale()).short));
    var caret = document.createElement("span");
    caret.className = "lang-selector__caret";
    caret.setAttribute("aria-hidden", "true");
    caret.textContent = "▾";
    selectorBtn.appendChild(caret);

    selectorList = document.createElement("ul");
    selectorList.className = "lang-selector__list";
    selectorList.id = "languageSelectorList";
    selectorList.setAttribute("role", "listbox");
    selectorList.setAttribute("aria-label", "Langue");

    SUPPORTED.forEach(function (locale) {
      var item = document.createElement("li");
      item.setAttribute("role", "option");
      item.id = "langOption-" + locale.replace(/[^a-zA-Z]/g, "");
      item.tabIndex = -1;
      item.textContent = LANGUI[locale].label;
      item.addEventListener("click", function () {
        selectLocale(locale, true);
      });
      item.addEventListener("keydown", function (event) {
        handleOptionKey(event, locale);
      });
      selectorList.appendChild(item);
    });

    selector.appendChild(hidden);
    selector.appendChild(selectorBtn);
    selector.appendChild(selectorList);
    nav.appendChild(selector);

    // Synchronise l'état visuel (option active) au changement de langue.
    onLocaleChange(refreshSelectorState);
    refreshSelectorState(getLocale());

    // Ouverture / fermeture.
    selectorBtn.addEventListener("click", function (event) {
      event.stopPropagation();
      setSelectorOpen(!selectorOpen);
    });
    selectorBtn.addEventListener("keydown", function (event) {
      if (event.key === "ArrowDown" || event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        setSelectorOpen(true);
      }
    });

    // Fermer au clic extérieur.
    document.addEventListener("click", function (event) {
      if (selectorOpen && selector && !selector.contains(event.target)) {
        setSelectorOpen(false);
      }
    });
    // Fermer avec Échap.
    document.addEventListener("keydown", function (event) {
      if (event.key === "Escape" && selectorOpen) {
        setSelectorOpen(false);
        if (selectorBtn && typeof selectorBtn.focus === "function") selectorBtn.focus();
      }
    });
  }




  // ------------------------------------------------------------------ Export

  global.I18N = {
    init: init,
    t: t,
    pl: pl,
    setLocale: setLocale,
    getLocale: getLocale,
    restoreGuestPreference: restoreGuestPreference,
    formatNumber: formatNumber,
    formatDate: formatDate,
    onLocaleChange: onLocaleChange,
    isReady: isReady,
    // Internes (tests JXA, préchargement) — non destinés à l'usage applicatif.
    _register: _register,
    _setLocaleSync: _setLocaleSync,
    _syncSelectorDisplay: _syncSelectorDisplay,
    _SUPPORTED: SUPPORTED.slice(),
    _STORAGE_KEY: STORAGE_KEY,
    _normalizeLocale: normalizeLocale
  };

  // Auto-initialisation au chargement de la page (DOMContentLoaded).
  if (typeof document !== "undefined" && typeof window !== "undefined") {
    var readyState = document.readyState;
    if (readyState === "loading") {
      document.addEventListener("DOMContentLoaded", function () { init(); });
    } else {
      init();
    }
  }
})(typeof self !== "undefined" ? self : (typeof window !== "undefined" ? window : globalThis));
