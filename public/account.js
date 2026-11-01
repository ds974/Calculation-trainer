"use strict";

/**
 * account.js — Interface de gestion des comptes (Mission Calcul Mental v12, étape 4).
 *
 * Responsabilités :
 *  - Conserver la session via les cookies sécurisés PHP (aucune donnée de session
 *    ni mot de passe stockés dans localStorage : on ne garde en mémoire que
 *    l'utilisateur public et le jeton CSRF, jamais réhydratés après rechargement).
 *  - Récupérer l'état de connexion au chargement / à l'actualisation de la page.
 *  - Récupérer et transmettre les jetons CSRF pour toute opération POST.
 *  - Brancher le module d'historique invité (GuestHistoryV12) via setSession().
 *  - Afficher connexion, inscription, profil et statistiques personnelles.
 *  - Désactiver l'accès au compte pendant une partie en cours.
 *
 * L'API PHP existante (auth/*, profile/*, result/save, stats) est réutilisée
 * telle quelle ; ce module n'ajoute aucune logique d'authentification parallèle.
 * L'import des anciennes parties invitées a été retiré (v12.2).
 */

const AccountUI = (() => {
  const API_BASE = "api/index.php";

  // État conservé UNIQUEMENT EN MÉMOIRE (aucune donnée sensible en localStorage).
  let user = null; // utilisateur public { id, login, role, created_at, preferred_language }
  let csrfToken = null;
  let accountReady = false;

  // v12.6-C2 — Synchronisation langue compte / langue invitée.
  // `lastSelectedLang` : dernière langue réellement demandée par l'utilisateur
  //   (dernier choix gagnant, y compris pour les réponses HTTP désordonnées).
  // `pendingLang` : langue en attente de sauvegarde (coalescence des frappes).
  // `savingLang` : une requête profile/language est-elle en cours ?
  // `applyingAccountLang` : vrai pendant l'application d'une langue provenant du
  //   compte (pour ne pas la renvoyer au serveur comme un « choix utilisateur »).
  let lastSelectedLang = null;
  let pendingLang = null;
  let savingLang = false;
  let applyingAccountLang = false;

  // ------------------------------------------------------------------ Utilitaires

  /** Appel HTTP JSON vers l'API. Renvoie {ok, status, data, error}. */
  async function api(action, payload, method = "POST") {
    try {
      let url = API_BASE;
      const opts = { method, credentials: "same-origin", headers: {} };
      if (method === "GET") {
        url = API_BASE + "?action=" + encodeURIComponent(action);
      } else {
        opts.headers["Content-Type"] = "application/json";
        opts.body = JSON.stringify(
          Object.assign({ action, csrf_token: csrfToken || "" }, payload || {})
        );
      }
      const res = await fetch(url, opts);
      const body = await res.json().catch(() => ({}));
      return {
        ok: res.status >= 200 && res.status < 300 && body.ok === true,
        status: res.status,
        data: body.data || null,
        error: body.error || (res.status === 401 ? "Authentification requise." : ""),
      };
    } catch (_e) {
      return { ok: false, status: 0, data: null, error: "réseau" };
    }
  }

  /** Synchronise l'état du module invité avec notre session mémoire. */
  function syncGuestSession() {
    if (typeof window.MissionGuestHistory !== "undefined" && window.MissionGuestHistory.setSession) {
      if (user && csrfToken) {
        window.MissionGuestHistory.setSession({ token: csrfToken, user: user });
      } else {
        window.MissionGuestHistory.setSession(null);
      }
    }
  }

  /** Une partie est-elle en cours ? (l'écran de jeu est actif) */
  function isGameInProgress() {
    const game = document.getElementById("gameScreen");
    return !!game && game.classList.contains("active");
  }

  function clearFeedback(id) {
    const el = document.getElementById(id);
    if (el) {
      el.textContent = "";
      el.className = "form-message";
    }
  }

  function setFeedback(id, message, kind) {
    const el = document.getElementById(id);
    if (!el) return;
    el.textContent = message;
    el.className = "form-message" +
      (kind === "error" ? " is-error" :
        kind === "success" ? " is-success" : "");
  }

  function showToast(message) {
    const toast = document.getElementById("accountToast");
    if (!toast) return;
    toast.textContent = message;
    toast.hidden = false;
    clearTimeout(showToast._timer);
    showToast._timer = setTimeout(() => {
      toast.hidden = true;
    }, 3200);
  }

  function setBusy(button, busy, busyText) {
    if (!button) return;
    if (busy) {
      button.dataset.original = button.textContent;
      button.textContent = busyText;
      button.disabled = true;
    } else {
      if (button.dataset.original) button.textContent = button.dataset.original;
      button.disabled = false;
    }
  }

  // ------------------------------------------------------------------ i18n

  /** Vrai si le moteur i18n est prêt (catalogues chargés). Repli français sinon. */
  function i18nReady() {
    const I = window.I18N;
    return !!(I && I.isReady && I.isReady());
  }

  /** Traduction + interpolation ; repli français / texte brut si indisponible. */
  function i18nT(key, vars, fallback) {
    const I = window.I18N;
    if (I && typeof I.t === "function") return I.t(key, vars);
    return fallback;
  }

  /**
   * Traduit un MESSAGE D'ERREUR renvoyé par l'API serveur. Les messages PHP
   * (français, sans identifiant machine) sont reconnus par correspondance
   * EXACTE et traduits via les clés du catalogue ; tout message inconnu est
   * conservé tel quel (aucune approximation par sous-chaînes).
   */
  const SERVER_ERROR_KEYS = {
    "Ce nom d'utilisateur est déjà utilisé.": "auth.nameTaken",
    "Identifiants invalides.": "auth.identifiantsInvalid",
    "Trop de tentatives. Réessayez dans quelques minutes.": "auth.tooManyAttempts",
    "Ce compte est désactivé. Contactez un administrateur.": "auth.accountDisabled",
    "L'ancien mot de passe est incorrect.": "account.passwordOldIncorrect",
    "Authentification requise.": "auth.authenticationRequired"
  };

  /** Traduit une erreur serveur connue, sinon renvoie le message d'origine. */
  function translateServerError(raw) {
    if (!raw) return raw;
    const key = SERVER_ERROR_KEYS[raw];
    if (key) return i18nT(key, null, raw);
    return raw;
  }

  // ---------------------------------------------------------------- Navigation

  function showScreen(screenId) {
    document.querySelectorAll(".screen").forEach((screen) => {
      screen.classList.toggle("active", screen.id === screenId);
    });
    window.scrollTo({ top: 0 });
    if (typeof updateAccountPanelVisibility === "function") {
      updateAccountPanelVisibility();
    }
  }

  /** Navigation de compte ; refuse (avec message) pendant une partie. */
  function navigate(screenId) {
    if (isGameInProgress()) {
      showToast(i18nT("account.gameInProgress", null, "Terminez la mission en cours avant d’accéder à votre compte."));
      return;
    }
    if (screenId === "accountScreen") {
      renderAccountScreen();
    }

    // Statistiques personnelles (étape 6B) — module dédié (stats.js).
    if (screenId === "statsScreen") {
      if (typeof StatsUI !== "undefined" && StatsUI.show) StatsUI.show();
    } else if (typeof StatsUI !== "undefined" && StatsUI.hide) {
      // En quittant l'écran statistiques, on détruit les graphiques et on
      // annule toute requête en vol.
      StatsUI.hide();
    }

    // Espace d'administration (v12.1) — module dédié (admin.js).
    if (screenId === "adminScreen") {
      if (typeof AdminUI !== "undefined" && AdminUI.show) AdminUI.show();
    } else if (typeof AdminUI !== "undefined" && AdminUI.hide) {
      AdminUI.hide();
    }

    showScreen(screenId);
  }

  function goHome() {
    showScreen("homeScreen");
  }

  // ------------------------------------------------------- États et rendus

  /**
   * Crée un bouton de navigation à icône circulaire (SVG de la charte v12.2).
   * Le libellé n'est jamais affiché : il est porté par aria-label (accessibilité)
   * et par data-tooltip (infobulle CSS au survol / focus).
   */
  function createIconNavButton(label, navTarget, iconPath) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "icon-btn";
    btn.setAttribute("aria-label", label);
    btn.dataset.tooltip = label;
    btn.dataset.accountNav = navTarget;
    const img = document.createElement("img");
    img.src = iconPath;
    img.alt = "";
    img.width = 48;
    img.height = 48;
    img.decoding = "async";
    btn.appendChild(img);
    return btn;
  }

  function renderAccountBar() {
    const bar = document.getElementById("accountBar");
    if (!bar) return;
    bar.innerHTML = "";
    bar.className = "account-bar";

    if (user) {
      const chip = document.createElement("div");
      chip.className = "account-chip";
      const label = document.createElement("span");
      label.className = "account-chip-label";
      label.textContent = i18nT("auth.connected", { login: user.login }, "Connecté : " + user.login);
      const btnAccueil = createIconNavButton(i18nT("nav.home", null, "Accueil"), "home", "assets/icons/accueil.svg");
      const btnAccount = createIconNavButton(i18nT("nav.myAccount", null, "Mon compte"), "account", "assets/icons/compte.svg");
      const btnStats = createIconNavButton(i18nT("nav.myStats", null, "Mes statistiques"), "stats", "assets/icons/statistiques.svg");
      const btnAdmin = createIconNavButton(i18nT("nav.administration", null, "Administration"), "admin", "assets/icons/administration.svg");
      btnAdmin.hidden = !(user.role === "admin");
      const btnLogout = document.createElement("button");
      btnLogout.type = "button";
      btnLogout.className = "btn btn-secondary btn-small";
      btnLogout.textContent = i18nT("account.logout", null, "Se déconnecter");
      btnLogout.dataset.accountLogout = "";
      chip.append(label, btnAccueil, btnAccount, btnStats, btnAdmin, btnLogout);
      bar.appendChild(chip);
    } else {
      const chip = document.createElement("div");
      chip.className = "account-chip account-chip-guest";
      const hint = document.createElement("span");
      hint.className = "account-chip-label";
      hint.textContent = i18nT("account.guestMode", null, "Mode invité");
      const btnAccueil = createIconNavButton(i18nT("nav.home", null, "Accueil"), "home", "assets/icons/accueil.svg");
      const btnLogin = document.createElement("button");
      btnLogin.type = "button";
      btnLogin.className = "btn btn-secondary btn-small";
      btnLogin.textContent = i18nT("account.loginOrRegister", null, "Se connecter / S’inscrire");
      btnLogin.dataset.accountNav = "login";
      chip.append(hint, btnAccueil, btnLogin);
      bar.appendChild(chip);
    }
    syncAdminAccess();
  }

  /**
   * Garde l'interface d'administration cohérente avec le rôle actuel :
   * - masque le bouton « Administration » pour les non-admin ;
   * - si l'utilisateur perd le rôle admin (ou se déconnecte) alors qu'il est
   *   sur l'écran admin, on le ramène à l'accueil pour ne pas laisser une
   *   interface vide (la protection, elle, reste 100 % côté serveur).
   */
  function syncAdminAccess() {
    if (typeof window.AdminUI === "undefined") return;
    const isAdmin = !!user && user.role === "admin";
    // Masquer le bouton du menu (géré par renderAccountBar via hidden).
    if (isAdmin) {
      window.AdminUI.updateAccess(true);
    } else {
      window.AdminUI.updateAccess(false);
      const adminScreen = document.getElementById("adminScreen");
      if (adminScreen && adminScreen.classList.contains("active")) {
        goHome();
      }
    }
  }

  function renderAccountScreen() {
    const summary = document.getElementById("accountSummary");
    if (!summary) return;
    summary.innerHTML = "";
    if (!user) return;

    const idLabel = escapeHtml(i18nT("account.identifiant", null, "Identifiant :"));
    const roleLabel = escapeHtml(i18nT("account.role", null, "Rôle :"));
    const sinceLabel = escapeHtml(i18nT("account.registeredOn", null, "Inscrit le :"));

    const wrap = document.createElement("div");
    wrap.className = "account-summary-inner";
    const login = document.createElement("div");
    login.innerHTML = "<strong>" + idLabel + "</strong> " + escapeHtml(user.login || "");
    const role = document.createElement("div");
    role.innerHTML = "<strong>" + roleLabel + "</strong> " + escapeHtml(user.role || "user");
    const since = document.createElement("div");
    since.innerHTML = "<strong>" + sinceLabel + "</strong> " + formatDate(user.created_at || "");
    wrap.append(login, role, since);
    summary.appendChild(wrap);
  }

  // --------------------------------------------------------------------- Auth

  /** Récupère le jeton CSRF frais de la session courante. */
  async function refreshCsrf() {
    const res = await api("auth/csrf", null, "GET");
    if (res.ok && res.data && res.data.token) {
      csrfToken = res.data.token;
      return true;
    }
    return false;
  }

  // ---------------------------------------------------- v12.6-C2 (langue compte)

  /**
   * Applique la langue du compte (préferred_language) SANS toucher à la
   * préférence locale invitée (persist:false) et SANS la renvoyer au serveur
   * comme un « choix utilisateur » (applyingAccountLang). Attend le chargement
   * du catalogue si nécessaire.
   */
  async function applyAccountLanguage(locale) {
    if (!window.I18N || typeof window.I18N.setLocale !== "function") return;
    let norm = locale;
    if (typeof window.I18N._normalizeLocale === "function") {
      norm = window.I18N._normalizeLocale(locale);
    }
    if (!norm) return;
    applyingAccountLang = true;
    try {
      await window.I18N.setLocale(norm, { persist: false });
    } finally {
      applyingAccountLang = false;
    }
  }

  /** Restaure la langue invitée (localStorage ou détection) après déconnexion. */
  async function restoreGuestLocale() {
    if (window.I18N && typeof window.I18N.restoreGuestPreference === "function") {
      await window.I18N.restoreGuestPreference();
    }
  }

  /**
   * Sauvegarde la préférence de langue du compte (POST profile/language).
   *
   * Garanties face aux changements rapides et aux réponses HTTP désordonnées :
   *  - Écritures SÉRIALISÉES et coalescées : une seule requête à la fois, et le
   *    dernier choix utilisateur est toujours la dernière écriture envoyée au
   *    serveur (donc la dernière persistée, quel que soit l'ordre réel).
   *  - « Dernier choix gagnant » : une réponse obsolète (pour une langue qui
   *    n'est plus la dernière demandée) n'actualise jamais l'état à tort.
   *  - Échec réseau : on ne déconnecte pas, on ne prétend pas avoir sauvegardé
   *    et on laisse la langue en attente pour une nouvelle tentative.
   */
  async function saveLanguagePreference(lang) {
    lastSelectedLang = lang;
    pendingLang = lang;
    if (savingLang) return; // une écriture est déjà en vol ; la boucle la reprendra
    savingLang = true;
    try {
      while (pendingLang !== null) {
        const toSave = pendingLang;
        pendingLang = null;
        const res = await api("profile/language", { preferred_language: toSave });
        // On n'actualise l'état que si cette réponse correspond encore au dernier
        // choix demandé (une réponse obsolète est ignorée ; l'écriture la plus
        // récente suivra de toute façon dans la boucle).
        if (toSave === lastSelectedLang && res && res.ok && res.data && res.data.user) {
          user = res.data.user;
          const saved = res.data.user.preferred_language || toSave;
          if (window.I18N && window.I18N.getLocale() !== saved) {
            await applyAccountLanguage(saved);
          }
          renderAccountBar();
        }
      }
    } finally {
      savingLang = false;
    }
  }

  /** Récupère l'utilisateur connecté (ou null) et met à jour l'état. */
  async function refreshProfile() {
    const res = await api("profile", null, "GET");
    user = res.ok && res.data && res.data.user ? res.data.user : null;
    // v12.6-C2 — Restauration de la préférence linguistique du compte (session
    // existante), prioritaire sur la langue locale.
    if (user && user.preferred_language) {
      await applyAccountLanguage(user.preferred_language);
    }
    syncGuestSession();
    renderAccountBar();
    return user;
  }

  /** Initialisation au chargement / actualisation de la page. */
  async function init() {
    // 1) Jeton CSRF, 2) état de connexion. On synchronise ensuite le module invité.
    await refreshCsrf();
    await refreshProfile();
    accountReady = true;
    renderAccountBar();

    // v12.6-B3.2 — Actualisation immédiate des écrans de compte lors d'un
    // changement de langue : on régénère uniquement les libellés visibles,
    // sans relancer d'authentification ni recréer les champs (les saisies sont
    // donc conservées) et sans afficher de notification supplémentaire. La
    // session PHP n'est pas modifiée.
    if (window.I18N && window.I18N.onLocaleChange) {
      window.I18N.onLocaleChange((locale) => {
        renderAccountBar();
        const account = document.getElementById("accountScreen");
        if (account && account.classList.contains("active")) {
          renderAccountScreen();
        }
        // v12.6-C2 — Changement de langue pendant une session authentifiée : on
        // sauvegarde le choix via profile/language, uniquement s'il provient
        // d'une action de l'utilisateur (sélecteur) et non de l'application
        // d'une langue de compte. On évite une requête inutile si la langue est
        // déjà celle du compte et qu'aucune écriture n'est en attente.
        if (user && !applyingAccountLang) {
          if (locale !== (user.preferred_language || null) || pendingLang !== null) {
            saveLanguagePreference(locale);
          }
        }
      });
    }

    // Branche la gestion des sessions expirées de l'écran statistiques (étape 6B) :
    // en cas de 401 renvoyé par l'API stats, on réutilise le flux de compte existant.
    if (typeof StatsUI !== "undefined" && StatsUI.setSessionHandler) {
      StatsUI.setSessionHandler(async () => {
        await handleSessionExpired(i18nT("auth.sessionExpired", null, "Votre session a expiré. Reconnectez-vous."));
      });
    }
  }


  async function handleLogin() {
    clearFeedback("loginFeedback");
    const login = (document.getElementById("loginIdentifier").value || "").trim();
    const password = document.getElementById("loginPassword").value;

    if (!login || !password) {
      setFeedback("loginFeedback", i18nT("auth.missingCredentials", null, "Renseignez votre identifiant et votre mot de passe."), "error");
      return;
    }

    const btn = document.getElementById("loginSubmit");
    setBusy(btn, true, i18nT("auth.loginBusy", null, "Connexion…"));
    const res = await api("auth/login", { login, password });
    setBusy(btn, false);

    if (!res.ok) {
      if (isAuthError(res) || res.status === 0) {
        // Session expirée ou réseau : on rafraîchit le jeton pour un nouvel essai.
        await refreshCsrf();
      }
      setFeedback("loginFeedback", translateServerError(res.error) || i18nT("auth.loginFailed", null, "Impossible de se connecter."), "error");
      return;
    }

    // Succès : mise à jour de l'état, synchronisation du module invité, retour à l'accueil.
    user = res.data && res.data.user ? res.data.user : null;
    // v12.6-C2 — La langue du compte devient prioritaire dès la connexion, sans
    // écraser la préférence locale invitée.
    if (user && user.preferred_language) {
      await applyAccountLanguage(user.preferred_language);
    }
    await refreshCsrf();
    syncGuestSession();
    renderAccountBar();
    showToast(i18nT("auth.loginSuccess", { login: user ? user.login : "" }, "Connexion réussie. Bienvenue, " + (user ? user.login : "") + " !"));
    goHome();
  }

  async function handleRegister() {
    clearFeedback("registerFeedback");
    const login = (document.getElementById("registerLogin").value || "").trim();
    const password = document.getElementById("registerPassword").value;
    const confirm = document.getElementById("registerPasswordConfirm").value;

    if (!login) {
      setFeedback("registerFeedback", i18nT("auth.registerLoginRequired", null, "Le nom d’utilisateur est obligatoire."), "error");
      return;
    }
    if (login.length < 3 || login.length > 40 || !/^[A-Za-z0-9_]+$/.test(login)) {
      setFeedback("registerFeedback", i18nT("auth.registerFormat", null, "Le nom d’utilisateur doit contenir 3 à 40 caractères (lettres, chiffres, _)."), "error");
      return;
    }
    if (password.length < 10) {
      setFeedback("registerFeedback", i18nT("auth.registerPasswordTooShort", null, "Le mot de passe doit comporter au moins 10 caractères."), "error");
      return;
    }
    if (password !== confirm) {
      setFeedback("registerFeedback", i18nT("auth.registerMismatch", null, "Les deux mots de passe ne correspondent pas."), "error");
      return;
    }

    const btn = document.getElementById("registerSubmit");
    setBusy(btn, true, i18nT("auth.registerBusy", null, "Inscription…"));
    // v12.6-C2 — Le compte hérite de la langue actuellement sélectionnée dans
    // l'interface (le sélecteur suffit ; aucun champ visible supplémentaire).
    const registerLocale = (window.I18N && typeof window.I18N.getLocale === "function")
      ? window.I18N.getLocale()
      : "fr";
    const res = await api("auth/register", { login, password, preferred_language: registerLocale });
    setBusy(btn, false);

    if (!res.ok) {
      if (isAuthError(res) || res.status === 0) await refreshCsrf();
      setFeedback("registerFeedback", translateServerError(res.error) || i18nT("auth.registerFailed", null, "Impossible de créer le compte."), "error");
      return;
    }

    showToast(i18nT("auth.registerSuccess", null, "Compte créé. Vous pouvez maintenant vous connecter."));
    const registerForm = document.getElementById("registerForm");
    if (registerForm) registerForm.reset();
    navigate("loginScreen");
  }

  async function handleLogout() {
    await api("auth/logout", {});
    user = null;
    // v12.6-C2 — Abandon des mises à jour de langue en attente et retour à la
    // langue invitée (la préférence du compte n'est pas modifiée par la déco).
    pendingLang = null;
    lastSelectedLang = null;
    savingLang = false;
    await refreshCsrf();
    syncGuestSession();
    renderAccountBar();
    await restoreGuestLocale();
    showToast(i18nT("auth.loggedOut", null, "Vous êtes déconnecté(e)."));
    goHome();
  }

  // ------------------------------------------------------------------- Profile

  async function handlePasswordChange(form) {
    clearFeedback("passwordFeedback");
    if (!user) return;
    const oldPassword = document.getElementById("oldPassword").value;
    const newPassword = document.getElementById("newPassword").value;
    const confirm = document.getElementById("newPasswordConfirm").value;

    if (newPassword.length < 10) {
      setFeedback("passwordFeedback", i18nT("account.passwordTooShort", null, "Le nouveau mot de passe doit comporter au moins 10 caractères."), "error");
      return;
    }
    if (newPassword !== confirm) {
      setFeedback("passwordFeedback", i18nT("account.passwordMismatch", null, "Les deux nouveaux mots de passe ne correspondent pas."), "error");
      return;
    }

    const btn = document.getElementById("passwordSubmit");
    setBusy(btn, true, i18nT("account.passwordBusy", null, "Changement en cours…"));
    const res = await api("profile/password", { old_password: oldPassword, new_password: newPassword });
    setBusy(btn, false);

    if (!res.ok) {
      if (isAuthError(res)) {
        await handleSessionExpired(i18nT("auth.sessionExpired", null, "Votre session a expiré. Reconnectez-vous."));
        return;
      }
      setFeedback("passwordFeedback", translateServerError(res.error) || i18nT("account.passwordChangeFailed", null, "Impossible de changer le mot de passe."), "error");
      return;
    }

    if (form) form.reset();
    setFeedback("passwordFeedback", i18nT("account.passwordChanged", null, "Mot de passe modifié avec succès."), "success");
  }

  /** Gère proprement l'expiration de session : réinitialise l'état et informe. */
  async function handleSessionExpired(message) {
    user = null;
    // v12.6-C2 — Retour au comportement invité (langue locale) après expiration.
    pendingLang = null;
    lastSelectedLang = null;
    savingLang = false;
    await refreshCsrf();
    syncGuestSession();
    renderAccountBar();
    await restoreGuestLocale();
    showToast(message);
    navigate("loginScreen");
  }


  // --------------------------------------------------------------------- Événements

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const navBtn = event.target.closest("[data-account-nav]");
      if (navBtn) {
        const target = navBtn.dataset.accountNav || "home";
        if (target === "account") {
          navigate("accountScreen");
        } else {
          navigate(target + "Screen");
        }
        return;
      }

      if (event.target.closest("[data-account-logout]")) {
        handleLogout();
        return;
      }
    });

    document.addEventListener("submit", (event) => {
      const form = event.target;
      if (form.id === "loginForm") {
        event.preventDefault();
        handleLogin();
      } else if (form.id === "registerForm") {
        event.preventDefault();
        handleRegister();
      } else if (form.id === "passwordForm") {
        event.preventDefault();
        handlePasswordChange(form);
      }
    });
  }

  // --------------------------------------------------------------------- Divers

  function escapeHtml(value) {
    return String(value)
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    const I = window.I18N;
    if (I && typeof I.formatDate === "function") {
      return I.formatDate(d, { day: "2-digit", month: "long", year: "numeric" });
    }
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
  }

  function isAuthError(res) {
    return res !== null && res !== undefined && !res.ok && res.status === 401;
  }

  // ------------------------------------------------------------------- Démarrage

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();
    init();
  });

  return {
    init,
    refreshProfile,
    api,
    showToast,
    handleSessionExpired,
    // Accès à l'état utilisateur courant (utilisé par l'interface admin).
    getUser: () => user,
    isAdmin: () => !!user && user.role === "admin",
    // v12.6-C2 — Aides de test (JXA) : la logique de synchronisation de langue.
    __test: {
      applyAccountLanguage,
      restoreGuestLocale,
      saveLanguagePreference,
      setUser: (u) => { user = u; },
      getState: () => ({ lastSelectedLang, pendingLang, savingLang, applyingAccountLang }),
      resetState: () => {
        lastSelectedLang = null;
        pendingLang = null;
        savingLang = false;
        applyingAccountLang = false;
      },
      getUser: () => user,
    },
  };
})();

if (typeof window !== "undefined") {
  window.AccountUI = AccountUI;
}
