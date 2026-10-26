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
 *  - Afficher connexion, inscription, profil et import volontaire des parties invitées.
 *  - Désactiver l'accès au compte pendant une partie en cours.
 *
 * L'API PHP existante (auth/*, profile/*, result/import) est réutilisée telle quelle ;
 * ce module n'ajoute aucune logique d'authentification parallèle.
 */

const AccountUI = (() => {
  const API_BASE = "api/index.php";

  // État conservé UNIQUEMENT EN MÉMOIRE (aucune donnée sensible en localStorage).
  let user = null; // utilisateur public { id, login, email, role, created_at }
  let csrfToken = null;
  let accountReady = false;

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
    if (typeof GuestHistoryV12 !== "undefined" && GuestHistoryV12.setSession) {
      if (user && csrfToken) {
        GuestHistoryV12.setSession({ token: csrfToken, user: user });
      } else {
        GuestHistoryV12.setSession(null);
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

  // ---------------------------------------------------------------- Navigation

  function showScreen(screenId) {
    document.querySelectorAll(".screen").forEach((screen) => {
      screen.classList.toggle("active", screen.id === screenId);
    });
    window.scrollTo({ top: 0 });
  }

  /** Navigation de compte ; refuse (avec message) pendant une partie. */
  function navigate(screenId) {
    if (isGameInProgress()) {
      showToast("Terminez la mission en cours avant d’accéder à votre compte.");
      return;
    }
    if (screenId === "accountScreen") {
      renderAccountScreen();
    }
    showScreen(screenId);
  }

  function goHome() {
    showScreen("homeScreen");
  }

  // ------------------------------------------------------- États et rendus

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
      label.textContent = "Connecté : " + user.login;
      const btnAccount = document.createElement("button");
      btnAccount.type = "button";
      btnAccount.className = "btn btn-secondary btn-small";
      btnAccount.textContent = "Mon compte";
      btnAccount.dataset.accountNav = "account";
      const btnLogout = document.createElement("button");
      btnLogout.type = "button";
      btnLogout.className = "btn btn-secondary btn-small";
      btnLogout.textContent = "Se déconnecter";
      btnLogout.dataset.accountLogout = "";
      chip.append(label, btnAccount, btnLogout);
      bar.appendChild(chip);
    } else {
      const chip = document.createElement("div");
      chip.className = "account-chip account-chip-guest";
      const hint = document.createElement("span");
      hint.className = "account-chip-label";
      hint.textContent = "Mode invité";
      const btnLogin = document.createElement("button");
      btnLogin.type = "button";
      btnLogin.className = "btn btn-secondary btn-small";
      btnLogin.textContent = "Se connecter / S’inscrire";
      btnLogin.dataset.accountNav = "login";
      chip.append(hint, btnLogin);
      bar.appendChild(chip);
    }
  }

  function renderAccountScreen() {
    const summary = document.getElementById("accountSummary");
    if (!summary) return;
    summary.innerHTML = "";
    if (!user) return;

    const wrap = document.createElement("div");
    wrap.className = "account-summary-inner";
    const login = document.createElement("div");
    login.innerHTML = "<strong>Identifiant :</strong> " + escapeHtml(user.login || "");
    const role = document.createElement("div");
    role.innerHTML = "<strong>Rôle :</strong> " + (user.role || "user");
    const since = document.createElement("div");
    since.innerHTML = "<strong>Inscrit le :</strong> " + formatDate(user.created_at || "");
    wrap.append(login, role, since);
    summary.appendChild(wrap);

    const emailField = document.getElementById("emailField");
    if (emailField) emailField.value = user.email || "";

    renderImportBlock();
  }

  function renderImportBlock() {
    const block = document.getElementById("guestImportBlock");
    if (!block) return;
    clearFeedback("importFeedback");

    if (!user) {
      block.hidden = true;
      return;
    }

    let pending = 0;
    if (typeof GuestHistoryV12 !== "undefined" && GuestHistoryV12.pendingCount) {
      pending = GuestHistoryV12.pendingCount();
    }

    const info = document.getElementById("guestImportInfo");
    const btn = document.getElementById("importGuestBtn");
    if (pending <= 0) {
      block.hidden = true;
      showToast("Aucune ancienne partie invitée à importer.");
      return;
    }

    block.hidden = false;
    info.textContent =
      "Il reste " + pending + " partie" + (pending > 1 ? "s" : "") +
      " invitée" + (pending > 1 ? "s" : "") +
      " enregistrée" + (pending > 1 ? "s" : "") +
      " dans ce navigateur et non encore importée" + (pending > 1 ? "s" : "") +
      " pour votre compte.";
    if (btn) btn.textContent = "Importer mes anciennes parties (" + pending + ")";
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

  /** Récupère l'utilisateur connecté (ou null) et met à jour l'état. */
  async function refreshProfile() {
    const res = await api("profile", null, "GET");
    user = res.ok && res.data && res.data.user ? res.data.user : null;
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
  }


  async function handleLogin() {
    clearFeedback("loginFeedback");
    const login = (document.getElementById("loginIdentifier").value || "").trim();
    const password = document.getElementById("loginPassword").value;

    if (!login || !password) {
      setFeedback("loginFeedback", "Renseignez votre identifiant et votre mot de passe.", "error");
      return;
    }

    const btn = document.getElementById("loginSubmit");
    setBusy(btn, true, "Connexion…");
    const res = await api("auth/login", { login, password });
    setBusy(btn, false);

    if (!res.ok) {
      if (isAuthError(res) || res.status === 0) {
        // Session expirée ou réseau : on rafraîchit le jeton pour un nouvel essai.
        await refreshCsrf();
      }
      setFeedback("loginFeedback", res.error || "Impossible de se connecter.", "error");
      return;
    }

    // Succès : mise à jour de l'état, synchronisation du module invité, retour à l'accueil.
    user = res.data && res.data.user ? res.data.user : null;
    await refreshCsrf();
    syncGuestSession();
    renderAccountBar();
    showToast("Connexion réussie. Bienvenue, " + (user ? user.login : "") + " !");
    goHome();
  }

  async function handleRegister() {
    clearFeedback("registerFeedback");
    const login = (document.getElementById("registerLogin").value || "").trim();
    const email = (document.getElementById("registerEmail").value || "").trim();
    const password = document.getElementById("registerPassword").value;
    const confirm = document.getElementById("registerPasswordConfirm").value;

    if (!login) {
      setFeedback("registerFeedback", "Le nom d’utilisateur est obligatoire.", "error");
      return;
    }
    if (login.length < 3 || login.length > 40 || !/^[A-Za-z0-9_]+$/.test(login)) {
      setFeedback("registerFeedback", "Le nom d’utilisateur doit contenir 3 à 40 caractères (lettres, chiffres, _).", "error");
      return;
    }
    if (password.length < 10) {
      setFeedback("registerFeedback", "Le mot de passe doit comporter au moins 10 caractères.", "error");
      return;
    }
    if (password !== confirm) {
      setFeedback("registerFeedback", "Les deux mots de passe ne correspondent pas.", "error");
      return;
    }
    if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFeedback("registerFeedback", "L’adresse e-mail n’est pas valide.", "error");
      return;
    }

    const btn = document.getElementById("registerSubmit");
    setBusy(btn, true, "Inscription…");
    const res = await api("auth/register", { login, password, email });
    setBusy(btn, false);

    if (!res.ok) {
      if (isAuthError(res) || res.status === 0) await refreshCsrf();
      setFeedback("registerFeedback", res.error || "Impossible de créer le compte.", "error");
      return;
    }

    showToast("Compte créé. Vous pouvez maintenant vous connecter.");
    const registerForm = document.getElementById("registerForm");
    if (registerForm) registerForm.reset();
    navigate("loginScreen");
  }

  async function handleLogout() {
    await api("auth/logout", {});
    user = null;
    await refreshCsrf();
    syncGuestSession();
    renderAccountBar();
    showToast("Vous êtes déconnecté(e).");
    goHome();
  }

  // ------------------------------------------------------------------- Profile

  async function handleEmailUpdate() {
    clearFeedback("emailFeedback");
    if (!user) return;
    const email = (document.getElementById("emailField").value || "").trim();
    if (email !== "" && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      setFeedback("emailFeedback", "L’adresse e-mail n’est pas valide.", "error");
      return;
    }

    const btn = document.getElementById("emailSubmit");
    setBusy(btn, true, "Enregistrement…");
    const res = await api("profile/update", { email });
    setBusy(btn, false);

    if (!res.ok) {
      if (isAuthError(res)) {
        await handleSessionExpired("Votre session a expiré. Reconnectez-vous.");
        return;
      }
      setFeedback("emailFeedback", res.error || "Impossible d’enregistrer l’e-mail.", "error");
      return;
    }

    user = res.data && res.data.user ? res.data.user : user;
    syncGuestSession();
    renderAccountScreen();
    setFeedback("emailFeedback", "Adresse e-mail mise à jour avec succès.", "success");
  }

  async function handlePasswordChange(form) {
    clearFeedback("passwordFeedback");
    if (!user) return;
    const oldPassword = document.getElementById("oldPassword").value;
    const newPassword = document.getElementById("newPassword").value;
    const confirm = document.getElementById("newPasswordConfirm").value;

    if (newPassword.length < 10) {
      setFeedback("passwordFeedback", "Le nouveau mot de passe doit comporter au moins 10 caractères.", "error");
      return;
    }
    if (newPassword !== confirm) {
      setFeedback("passwordFeedback", "Les deux nouveaux mots de passe ne correspondent pas.", "error");
      return;
    }

    const btn = document.getElementById("passwordSubmit");
    setBusy(btn, true, "Changement en cours…");
    const res = await api("profile/password", { old_password: oldPassword, new_password: newPassword });
    setBusy(btn, false);

    if (!res.ok) {
      if (isAuthError(res)) {
        await handleSessionExpired("Votre session a expiré. Reconnectez-vous.");
        return;
      }
      setFeedback("passwordFeedback", res.error || "Impossible de changer le mot de passe.", "error");
      return;
    }

    if (form) form.reset();
    setFeedback("passwordFeedback", "Mot de passe modifié avec succès.", "success");
  }

  /** Gère proprement l'expiration de session : réinitialise l'état et informe. */
  async function handleSessionExpired(message) {
    user = null;
    await refreshCsrf();
    syncGuestSession();
    renderAccountBar();
    showToast(message);
    navigate("loginScreen");
  }


  // --------------------------------------------------------------------- Import

  async function handleImport() {
    clearFeedback("importFeedback");
    if (!user || typeof GuestHistoryV12 === "undefined" || !GuestHistoryV12.importToAccount) return;

    const pending = GuestHistoryV12.pendingCount ? GuestHistoryV12.pendingCount() : 0;
    if (pending <= 0) {
      setFeedback("importFeedback", "Aucune ancienne partie invitée à importer.", "success");
      return;
    }

    // Confirmation explicite avant l'import.
    const confirmed = window.confirm(
      "Voulez-vous importer " + pending + " ancienne" + (pending > 1 ? "s" : "") +
      " partie" + (pending > 1 ? "s" : "") +
      " invitée" + (pending > 1 ? "s" : "") +
      " vers votre compte ?\n\nCes parties seront ajoutées à votre historique. " +
      "Aucune donnée locale ne sera supprimée."
    );
    if (!confirmed) return;

    const btn = document.getElementById("importGuestBtn");
    setBusy(btn, true, "Import en cours…");
    const result = await GuestHistoryV12.importToAccount(() => true);
    setBusy(btn, false);

    const resp = result.response || {};
    if (result.error === "not-connected" || (result.error === "server" && resp.status === 401)) {
      await handleSessionExpired("Votre session a expiré. Reconnectez-vous.");
      return;
    }
    if (result.error === "réseau" || (result.error !== undefined && resp.status === 0)) {
      setFeedback("importFeedback", "Erreur réseau pendant l’import. Réessayez. Vos données locales sont intactes.", "error");
      return;
    }
    // Vérification correcte : si tout est OK, ne pas afficher d'erreur
    if (result.error === "server" && resp && !resp.ok) {
      setFeedback("importFeedback", "L’import a échoué. Vos parties locales sont conservées.", "error");
      return;
    }
    // Si on arrive ici, c'est que tout s'est bien passé
    if (result.error !== undefined) {
      // Si erreur non gérée, on affiche quand même un message
      setFeedback("importFeedback", "L’import a échoué. Vos parties locales sont conservées.", "error");
      return;
    }

    const imported = result.imported || 0;
    const skipped = result.skipped || 0;
    setFeedback(
      "importFeedback",
      imported + " partie" + (imported > 1 ? "s" : "") + " importée" + (imported > 1 ? "s" : "") +
      (skipped > 0 ? " ; " + skipped + " déjà présente" + (skipped > 1 ? "s" : "") + " (doublon" + (skipped > 1 ? "s" : "") + ")." : "."),
      "success"
    );
    renderImportBlock();
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

      if (event.target.closest("#importGuestBtn")) {
        handleImport();
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
      } else if (form.id === "emailForm") {
        event.preventDefault();
        handleEmailUpdate();
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
  };
})();

if (typeof window !== "undefined") {
  window.AccountUI = AccountUI;
}
