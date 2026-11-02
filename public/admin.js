"use strict";

const AdminUI = (() => {
  const API_BASE = "api/index.php";
  let currentSearch = "";
  let currentDetailId = null;
  let visible = false;
  let statsSeq = 0;
  let usersSeq = 0;
  let detailSeq = 0;
  // Nombre d'administrateurs ACTIFS (source : admin/stats → users.admins_active).
  // Permet d'identifier le dernier administrateur actif et de verrouiller les
  // actions « Désactiver » / « Rétrograder » dans l'interface.
  let activeAdmins = null;
  // Données déjà chargées en mémoire (v12.6-B3.4). Elles permettent un
  // réaffichage immédiat des statistiques, de la liste et de la fiche ouverte
  // après un changement de langue, SANS relancer de requête réseau ni
  // d'action administrative.
  let lastStats = null;
  let lastUsers = null;
  let lastDetail = null;


  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  /** Traduit via le moteur i18n (clé admin.*) avec repli français. */
  function t(key, vars, fallback) {
    const I = window && window.I18N;
    if (I && typeof I.t === "function") {
      const out = I.t(key, vars);
      if (typeof out === "string" && out !== key) return out;
    }
    return fallback;
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const I = window && window.I18N;
    try {
      const fmt = (I && typeof I.formatDate === "function")
        ? I.formatDate(d, { day: "2-digit", month: "long", year: "numeric" })
        : d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
      return fmt;
    } catch (_e2) {
      return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
    }
  }

  /** Date numérique COMPACTE sur une ligne (tableau des comptes uniquement).
   *  Passe par le moteur i18n / Intl.DateTimeFormat de la langue active : le
   *  format suit la locale (ex. en -> 11/01/2026, zh -> 2026/11/01), sans
   *  modifier la date réelle ni le fuseau. N'affecte PAS formatDate() utilisé
   *  par les autres écrans (fiche compte, etc.). */
  function formatDateCompact(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const I = window && window.I18N;
    try {
      const opts = { day: "2-digit", month: "2-digit", year: "numeric" };
      const fmt = (I && typeof I.formatDate === "function")
        ? I.formatDate(d, opts)
        : new Intl.DateTimeFormat("fr-FR", opts).format(d);
      if (typeof fmt === "string" && fmt.trim() !== "") return fmt;
    } catch (_e2) { /* repli ci-dessous */ }
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "2-digit", year: "numeric" });
  }

  /** Construit un bouton d'action ADMINISTRATIF compact à icône (P3).
   *  Le texte visible est remplacé par une icône SVG locale rendue en masque
   *  CSS (CSS mask, remplissage via currentColor) : la couleur active / désactivée
   *  est ainsi contrôlée par le CSS, sans modifier les tracés SVG. Le nom
   *  accessible (aria-label) et l'info-bulle (title) portent la traduction.
   *  Pour les actions INTERDITES (opts.disabled), le `title` vient du bloc
   *  `disabled` passé dans attrs (explication du dernier admin) ; on n'ajoute
   *  donc pas de second `title`. Les boutons restent réellement disabled :
   *  jamais remplacés par un simple aria-disabled. */
  function actIconButton(label, icon, attrs, opts) {
    opts = opts || {};
    var tip = opts.disabled ? "" : ' title="' + escapeHtml(label) + '"';
    return '<button type="button" class="btn btn-secondary btn-small admin-act"' +
      attrs + tip + ' aria-label="' + escapeHtml(label) + '">' +
      '<span class="admin-act-icon" data-icon="' + icon + '"></span></button>';
  }

  function isAdmin() {
    return typeof window.AccountUI !== "undefined" && typeof window.AccountUI.isAdmin === "function"
      ? window.AccountUI.isAdmin()
      : false;
  }

  function currentUser() {
    return typeof window.AccountUI !== "undefined" && typeof window.AccountUI.getUser === "function"
      ? window.AccountUI.getUser()
      : null;
  }

  async function call(action, queryParams, method) {
    if (method === "GET") {
      try {
        let url = API_BASE + "?action=" + encodeURIComponent(action);
        if (queryParams) {
          for (const key of Object.keys(queryParams)) {
            const val = queryParams[key];
            if (val !== undefined && val !== null && val !== "") {
              url += "&" + encodeURIComponent(key) + "=" + encodeURIComponent(val);
            }
          }
        }
        const res = await fetch(url, { method: "GET", credentials: "same-origin" });
        const body = await res.json().catch(() => ({}));
        return {
          ok: res.status >= 200 && res.status < 300 && body.ok === true,
          status: res.status,
          data: body.data || null,
          error: body.error || (res.status === 401 ? t("error.authRequired", null, "Authentification requise.") : ""),
        };
      } catch (_e) {
        return { ok: false, status: 0, data: null, error: t("error.network", null, "réseau") };
      }
    }
    if (typeof window.AccountUI === "undefined" || typeof window.AccountUI.api !== "function") {
      return { ok: false, status: 0, data: null, error: "interface indisponible" };
    }
    return window.AccountUI.api(action, queryParams || {}, method || "POST");
  }

  function toast(message) {
    if (typeof window.AccountUI !== "undefined" && typeof window.AccountUI.showToast === "function") {
      window.AccountUI.showToast(message);
    }
  }

  async function handleError(res, fallback) {
    if (res.status === 401) {
      if (typeof window.AccountUI !== "undefined" && typeof window.AccountUI.handleSessionExpired === "function") {
        await window.AccountUI.handleSessionExpired(t("admin.sessionExpiredOrDisabled", null, "Votre session a expiré ou votre compte a été désactivé."));
      }
      return true;
    }
    toast(fallback || t("error.actionImpossible", null, "Action impossible."));
    return false;
  }

  function copyText(text) {
    const legacy = () => {
      const ta = document.createElement("textarea");
      ta.value = text;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand("copy");
        toast(t("admin.passwordCopied", null, "Mot de passe temporaire copié."));
      } catch (_e) {
        toast(t("admin.copyFailed", null, "Impossible de copier automatiquement. Sélectionnez le mot de passe manuellement."));
      }
      ta.remove();
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(
        () => toast(t("admin.passwordCopied", null, "Mot de passe temporaire copié.")),
        legacy
      );
    } else {
      legacy();
    }
  }


  function updateAccess(show) {
    visible = Boolean(show);
    if (!visible) {
      statsSeq++;
      usersSeq++;
      detailSeq++;
      currentDetailId = null;
    }
  }

  async function show() {
    if (!isAdmin()) {
      if (typeof window.AccountUI !== "undefined" && typeof window.AccountUI.handleSessionExpired === "function") {
        await window.AccountUI.handleSessionExpired(t("admin.accessDenied", null, "Accès réservé aux administrateurs."));
      }
      return;
    }
    visible = true;
    // loadStats est chargé AVANT loadUsers : c'est lui qui fixe activeAdmins
    // (nombre d'administrateurs actifs), nécessaire pour verrouiller les boutons
    // « Désactiver » / « Rétrograder » du dernier administrateur actif.
    await loadStats();
    await loadUsers(currentSearch);
  }

  function hide() {
    statsSeq++;
    usersSeq++;
    detailSeq++;
  }

  function statCard(label, value, hint) {
    return (
      '<div class="stat-card">' +
      '<span class="stat-card-label">' + escapeHtml(label) + "</span>" +
      '<span class="stat-card-value">' + escapeHtml(value) + "</span>" +
      (hint ? '<span class="stat-card-hint">' + escapeHtml(hint) + "</span>" : "") +
      "</div>"
    );
  }

  async function loadStats() {
    const box = document.getElementById("adminStats");
    if (!box) return;
    const seq = ++statsSeq;
    box.innerHTML = '<div class="stats-status"><span class="spinner"></span><p>' + escapeHtml(t("admin.loadingStats", null, "Chargement des statistiques…")) + "</p></div>";
    const res = await call("admin/stats", null, "GET");
    if (seq !== statsSeq || !visible) return;
    if (!res.ok) {
      if (await handleError(res, t("error.loadStatsFailed", null, "Impossible de charger les statistiques."))) return;
      box.innerHTML = '<div class="stats-error"><h3>' + escapeHtml(t("admin.statsUnavailable", null, "Statistiques indisponibles")) + "</h3></div>";
      return;
    }
    const statsData = res.data || {};
    lastStats = statsData;
    // Nombre d'administrateurs actifs : source de vérité pour verrouiller les
    // boutons du dernier administrateur actif (indépendant de la pagination et
    // de la recherche de la liste des comptes).
    const adminsActive = Number(statsData.users && statsData.users.admins_active);
    activeAdmins = Number.isFinite(adminsActive) ? adminsActive : null;
    renderStats(box, statsData);
  }

  function renderStats(box, data) {
    const u = data.users || {};
    const g = data.games || {};
    const html =
      '<div class="stats-cards admin-cards">' +
      statCard(t("admin.statComptes", null, "Comptes"), u.total ?? 0) +
      statCard(t("admin.statAdministrateurs", null, "Administrateurs"), u.admins ?? 0) +
      statCard(t("admin.statComptesActifs", null, "Comptes actifs"), u.active ?? 0) +
      statCard(t("admin.statPartiesJouees", null, "Parties jouées"), g.total ?? 0) +
      statCard(t("admin.stat7jours", null, "7 derniers jours"), g.last_7d ?? 0) +
      statCard(t("admin.stat30jours", null, "30 derniers jours"), g.last_30d ?? 0) +
      statCard(t("admin.statMultiplications", null, "Multiplications"), (g.multiplication_pct ?? 0) + " %") +
      statCard(t("admin.statAdditions", null, "Additions"), (g.addition_pct ?? 0) + " %") +
      "</div>" +
      '<p class="stats-note">' +
      escapeHtml(t("admin.statsNoteShare", null,
        "Répartition relative des parties par type de calcul ; les périodes « 7 et 30 derniers jours » sont calculées en fonction de l’heure du serveur.")) +
      "</p>";
    box.innerHTML = html;
  }

  function badge(text, kind) {
    return '<span class="admin-badge admin-badge-' + escapeHtml(kind || "neutral") + '">' + escapeHtml(text) + "</span>";
  }


  async function loadUsers(search) {
    const list = document.getElementById("adminUserList");
    if (!list) return;
    if (typeof search === "string") currentSearch = search.trim();
    const seq = ++usersSeq;
    list.innerHTML = '<div class="stats-status"><span class="spinner"></span><p>' + escapeHtml(t("admin.loadingUsers", null, "Chargement des comptes…")) + "</p></div>";
    const res = await call("admin/users", { limit: 200, q: currentSearch }, "GET");
    if (seq !== usersSeq || !visible) return;
    if (!res.ok) {
      if (await handleError(res, t("error.loadUsersFailed", null, "Impossible de charger la liste des comptes."))) return;
      list.innerHTML = '<div class="stats-error"><h3>' + escapeHtml(t("admin.listUnavailable", null, "Liste indisponible")) + "</h3></div>";
      return;
    }
    lastUsers = res.data || {};
    renderUsers(list, lastUsers);
  }

  function renderUsers(list, data) {
    const users = Array.isArray(data.users) ? data.users : [];
    if (users.length === 0) {
      list.innerHTML = '<div class="empty-state">' +
        escapeHtml(currentSearch
          ? t("admin.noAccountsFor", { query: currentSearch }, "Aucun compte pour « " + currentSearch + " ».")
          : t("admin.noAccounts", null, "Aucun compte") + ".") +
        "</div>";
      return;
    }
    const me = currentUser();
    const myId = me ? me.id : null;

    let rows = "";
    for (const u of users) {
      const self = u.id === myId;
      const activeTxt = u.is_active ? t("admin.active", null, "Activé") : t("admin.inactive", null, "Désactivé");
      const activeKind = u.is_active ? "ok" : "danger";
      const roleTxt = u.role === "admin" ? t("admin.roleAdmin", null, "Admin") : t("admin.roleUser", null, "Utilisateur");
      const roleKind = u.role === "admin" ? "admin" : "neutral";
      // Dernier administrateur ACTIF : on doit empêcher sa rétrogradation et sa
      // désactivation tant qu'aucun autre administrateur actif ne peut prendre le relais.
      const isLastActiveAdmin = u.role === "admin" && u.is_active === true && activeAdmins === 1;

      // Consulter reste toujours disponible.
      let actions = actIconButton(t("admin.consult", null, "Consulter"), "eye", ' data-admin-view="' + u.id + '"');

      if (isLastActiveAdmin) {
        // Les deux actions interdites sont désactivées (visuellement et fonctionnellement).
        // Aucun message permanent n'est affiché dans la ligne. L'explication reste
        // disponible aux technologies d'assistance via un texte masqué visuellement
        // (classe .sr-only) référencé par aria-describedby, et via l'info-bulle
        // « title » sur ordinateur. Les boutons restent réellement disabled :
        // on ne remplace jamais disabled par un simple aria-disabled.
        const noteId = "lastAdminNote-" + u.id;
        const lastNote = t("admin.lastActiveAdminNote", null, "Impossible : ce compte est le dernier administrateur actif.");
        const disabledBtn = ' disabled aria-disabled="true" title="' + escapeHtml(lastNote) + '" aria-describedby="' + noteId + '"';
        actions +=
          actIconButton(t("admin.deactivate", null, "Désactiver"), "user-x-locked",
            disabledBtn + ' data-admin-active="' + u.id + '" data-active="0"', { disabled: true }) +
          actIconButton(t("admin.demote", null, "Rétrograder"), "shield-minus-locked",
            disabledBtn + ' data-admin-role="' + u.id + '" data-makeadmin="0"', { disabled: true });
        // Description accessible (masquée visuellement via .sr-only), référencée
        // par aria-describedby : aucune perte d'info pour les lecteurs d'écran,
        // sans message permanent visible dans la ligne ni sur smartphone.
        actions +=
          '<span class="sr-only" id="' + noteId + '">' + escapeHtml(lastNote) + "</span>";
      } else {
        const actKey = u.is_active ? "deactivate" : "reactivate";
        const actIcon = u.is_active ? "user-x" : "user-check";
        const roleKey = u.role === "admin" ? "demote" : "promoteAdmin";
        const roleIcon = u.role === "admin" ? "shield-minus" : "shield-plus";
        actions +=
          actIconButton(t("admin." + actKey, null, ""), actIcon,
            ' data-admin-active="' + u.id + '" data-active="' + (u.is_active ? "0" : "1") + '"') +
          actIconButton(t("admin." + roleKey, null, ""), roleIcon,
            ' data-admin-role="' + u.id + '" data-makeadmin="' + (u.role === "admin" ? "0" : "1") + '"');
      }
      actions +=
        actIconButton(t("admin.resetPassword", null, "Reset mot de passe"), "key-round", ' data-admin-reset="' + u.id + '"');
      rows +=
        "<tr>" +
        "<td><strong>" + escapeHtml(u.login) + "</strong>" + (self ? ' <span class="admin-self">' + escapeHtml(t("admin.you", null, "(vous)")) + "</span>" : "") + "</td>" +
        "<td>" + badge(roleTxt, roleKind) + "</td>" +
        "<td>" + badge(activeTxt, activeKind) + "</td>" +
        "<td class=\"admin-date\">" + formatDateCompact(u.created_at) + "</td>" +
        "<td class=\"admin-actions\">" +
          '<div class="admin-actions-group">' + actions + "</div>" +
        "</td>" +
        "</tr>";
    }

    list.innerHTML =
      '<div class="table-scroll">' +
      '<table class="leaderboard-table admin-table">' +
      "<thead><tr>" +
      "<th>" + escapeHtml(t("admin.columnIdentifiant", null, "Identifiant")) + "</th>" +
      "<th>" + escapeHtml(t("admin.columnRole", null, "Rôle")) + "</th>" +
      "<th>" + escapeHtml(t("admin.columnStatut", null, "Statut")) + "</th>" +
      "<th>" + escapeHtml(t("admin.columnCreeLe", null, "Créé le")) + "</th>" +
      "<th>" + escapeHtml(t("admin.columnActions", null, "Actions")) + "</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<p class="stats-note">' + escapeHtml(t("admin.resetNote", null, "Réinitialiser un mot de passe génère un mot de passe temporaire à usage unique.")) + "</p>";
  }


  async function openDetail(id) {
    currentDetailId = id;
    const list = document.getElementById("adminUserList");
    if (!list) return;
    const existing = document.getElementById("adminDetailPanel");
    if (existing) existing.remove();
    const seq = ++detailSeq;
    list.insertAdjacentHTML("beforeend",
      '<div id="adminDetailPanel" class="admin-detail"><div class="stats-status"><span class="spinner"></span><p>' +
      escapeHtml(t("admin.loadingAccount", null, "Consultation du compte…")) + "</p></div></div>");
    const res = await call("admin/user", { id }, "GET");
    if (seq !== detailSeq || !visible) return;
    const panel = document.getElementById("adminDetailPanel");
    if (!res.ok) {
      if (await handleError(res, t("error.loadAccountFailed", null, "Impossible de charger le compte."))) return;
      if (panel) panel.remove();
      return;
    }
    if (!panel) return;
    lastDetail = { id, user: (res.data && res.data.user) || {} };
    renderDetail(panel, lastDetail.user);
  }

  function renderDetail(panel, u) {
    const hist = Array.isArray(u.history) ? u.history : [];
    let histHtml;
    if (hist.length === 0) {
      histHtml = '<div class="admin-detail-empty">' + escapeHtml(t("admin.detailNoGames", null, "Aucune partie enregistrée pour ce compte.")) + "</div>";
    } else {
      let hRows = "";
      for (const g of hist.slice(0, 20)) {
        const modeLabel = g.mode === "addition" ? t("common.additions", null, "Additions") : t("common.multiplications", null, "Multiplications");
        hRows += "<tr><td>" + formatDate(g.played_at) + "</td><td>" + escapeHtml(modeLabel) + "</td><td>" + escapeHtml(g.score) + " / 10</td></tr>";
      }
      histHtml =
        '<div class="table-scroll"><table class="leaderboard-table admin-table">' +
        "<thead><tr>" +
        "<th>" + escapeHtml(t("admin.tableDate", null, "Date")) + "</th>" +
        "<th>" + escapeHtml(t("admin.tableType", null, "Type")) + "</th>" +
        "<th>" + escapeHtml(t("admin.tableScore", null, "Score")) + "</th>" +
        "</tr></thead><tbody>" +
        hRows + "</tbody></table></div>" +
        (hist.length > 20 ? '<p class="stats-note">' + escapeHtml(t("admin.detailLast20", null, "20 dernières parties affichées.")) + "</p>" : "");
    }

    panel.innerHTML =
      '<div class="admin-detail-head">' +
      "<h4>" + escapeHtml(t("admin.detailTitle", { login: u.login }, "Compte « " + (u.login || "") + " »")) + "</h4>" +
      '<button type="button" class="btn btn-secondary btn-small" data-admin-close-detail>' +
      escapeHtml(t("admin.detailClose", null, "Fermer")) + "</button>" +
      "</div>" +
      '<div class="admin-detail-grid">' +
      "<div><strong>" + escapeHtml(t("admin.detailIdentifiant", null, "Identifiant")) + "</strong><span>" + escapeHtml(u.login || "—") + "</span></div>" +
      "<div><strong>" + escapeHtml(t("admin.detailRole", null, "Rôle")) + "</strong><span>" + badge(u.role === "admin" ? t("admin.roleAdmin", null, "Admin") : t("admin.roleUser", null, "Utilisateur"), u.role === "admin" ? "admin" : "neutral") + "</span></div>" +
      "<div><strong>" + escapeHtml(t("admin.detailStatut", null, "Statut")) + "</strong><span>" + badge(u.is_active ? t("admin.active", null, "Activé") : t("admin.inactive", null, "Désactivé"), u.is_active ? "ok" : "danger") + "</span></div>" +
      "<div><strong>" + escapeHtml(t("admin.detailCreeLe", null, "Créé le")) + "</strong><span>" + formatDate(u.created_at) + "</span></div>" +
      "<div><strong>" + escapeHtml(t("admin.detailDernierAcces", null, "Dernier accès")) + "</strong><span>" + formatDate(u.last_login_at) + "</span></div>" +
      "<div><strong>" + escapeHtml(t("admin.detailPartiesJouees", null, "Parties jouées")) + "</strong><span>" + escapeHtml(u.played_games ?? 0) + "</span></div>" +
      "</div>" +
      "<h5>" + escapeHtml(t("admin.detailHistory", null, "Historique récent")) + "</h5>" + histHtml;
  }

  function closeDetail() {
    currentDetailId = null;
    const panel = document.getElementById("adminDetailPanel");
    if (panel) panel.remove();
  }


  async function toggleActive(id, active) {
    if (!window.confirm(
      active
        ? t("admin.confirmReactivate", null,
            "Confirmer la réactivation de ce compte ?\n\nUn compte désactivé ne peut plus se connecter, et toute session déjà ouverte devient immédiatement inutilisable. Son historique est conservé.")
        : t("admin.confirmDeactivate", null,
            "Confirmer la désactivation de ce compte ?\n\nUn compte désactivé ne peut plus se connecter, et toute session déjà ouverte devient immédiatement inutilisable. Son historique est conservé.")
    )) return;
    const res = await call("admin/active", { user_id: id, is_active: active }, "POST");
    if (!res.ok) {
      await handleError(res, active
        ? t("admin.actionFailedReactivate", null, "Impossible de réactiver le compte.")
        : t("admin.actionFailedDeactivate", null, "Impossible de désactiver le compte."));
      return;
    }
    toast(active
      ? t("admin.toastReactivated", null, "Compte réactivé.")
      : t("admin.toastDeactivated", null, "Compte désactivé."));
    await reloadAfterChange();
  }

  async function toggleRole(id, makeAdmin) {
    const message = makeAdmin
      ? t("admin.confirmPromote", null,
          "Confirmer la promotion de ce compte au rôle administrateur ?\n\nLes droits d’administration s’appliquent immédiatement.")
      : t("admin.confirmDemote", null,
          "Confirmer la rétrogradation de ce compte au rôle utilisateur ?\n\nLe rôle ne peut pas être retiré au dernier administrateur actif.");
    if (!window.confirm(message)) return;
    const res = await call("admin/role", { user_id: id, make_admin: makeAdmin }, "POST");
    if (!res.ok) {
      await handleError(res, t("admin.actionFailedRole", null, "Impossible de modifier le rôle."));
      return;
    }
    toast(t("admin.toastRoleUpdated", null, "Rôle mis à jour."));
    syncAdminAccessAfterChange();
    await reloadAfterChange();
  }

  async function resetPassword(id) {
    if (!window.confirm(
      t("admin.confirmReset", null,
        "Réinitialiser le mot de passe de ce compte ?\n\nUn mot de passe temporaire sera généré et affiché une seule fois. Le mot de passe actuel cessera immédiatement de fonctionner.")
    )) return;
    const btn = document.querySelector('[data-admin-reset="' + id + '"]');
    if (btn) {
      btn.dataset.original = btn.textContent;
      btn.textContent = t("admin.resetInProgress", null, "Génération…");
      btn.disabled = true;
    }
    const res = await call("admin/password", { user_id: id }, "POST");
    if (btn) {
      btn.textContent = btn.dataset.original || t("admin.resetPassword", null, "Reset mot de passe");
      btn.disabled = false;
    }
    if (!res.ok) {
      await handleError(res, t("admin.actionFailedReset", null, "Impossible de réinitialiser le mot de passe."));
      return;
    }
    const reset = (res.data && res.data.reset) || {};
    showTemporaryPassword(reset.login || "", reset.temporary_password || "");
  }

  function showTemporaryPassword(login, pwd) {
    let box = document.getElementById("adminResetModal");
    if (!box) {
      box = document.createElement("div");
      box.id = "adminResetModal";
      box.className = "admin-reset-modal";
      box.setAttribute("role", "dialog");
      box.setAttribute("aria-modal", "true");
      box.setAttribute("aria-labelledby", "adminResetTitle");
      document.body.appendChild(box);
    }
    box.innerHTML =
      '<div class="admin-reset-card">' +
      '<h3 id="adminResetTitle">' + escapeHtml(t("admin.temporaryPasswordTitle", null, "Mot de passe temporaire")) + "</h3>" +
      '<p class="muted">' + escapeHtml(t("admin.temporaryPasswordFor", { login }, "Pour le compte " + login + ".")) + " " +
      escapeHtml(t("admin.temporaryPasswordNote", null, "À communiquer de manière sécurisée. Il ne sera plus affiché après fermeture.")) + "</p>" +
      '<div class="admin-reset-password">' + escapeHtml(pwd) + "</div>" +
      '<div class="form-actions">' +
      '<button type="button" class="btn btn-primary" id="adminResetCopy">' +
      escapeHtml(t("admin.copy", null, "Copier")) + "</button>" +
      '<button type="button" class="btn btn-secondary" id="adminResetClose">' +
      escapeHtml(t("admin.copiedClose", null, "J’ai copié, fermer")) + "</button>" +
      "</div></div>";
    const copyBtn = box.querySelector("#adminResetCopy");
    const closeBtn = box.querySelector("#adminResetClose");
    if (copyBtn) copyBtn.addEventListener("click", () => copyText(pwd));
    if (closeBtn) closeBtn.addEventListener("click", () => box.remove());
  }

  function syncAdminAccessAfterChange() {
    if (typeof window.AccountUI !== "undefined" && typeof window.AccountUI.refreshProfile === "function") {
      window.AccountUI.refreshProfile();
    }
  }

  async function reloadAfterChange() {
    if (!visible) return;
    // Séquence nécessaire : loadStats fixe activeAdmins avant le re-rendu des
    // lignes (loadUsers), pour que les boutons reflètent l'état mis à jour.
    await loadStats();
    await loadUsers(currentSearch);
    if (currentDetailId) {
      const id = currentDetailId;
      currentDetailId = null;
      await openDetail(id);
    }
  }


  function bindEvents() {
    const searchInput = document.getElementById("adminSearchInput");
    const searchBtn = document.getElementById("adminSearchBtn");
    if (searchInput) {
      let timer = null;
      searchInput.addEventListener("input", () => {
        clearTimeout(timer);
        timer = setTimeout(() => loadUsers(searchInput.value), 350);
      });
    }
    if (searchBtn) {
      searchBtn.addEventListener("click", () => {
        const inp = document.getElementById("adminSearchInput");
        loadUsers(inp ? inp.value : "");
      });
    }

    document.addEventListener("click", async (event) => {
      const view = event.target.closest("[data-admin-view]");
      if (view) { openDetail(Number(view.dataset.adminView)); return; }
      const close = event.target.closest("[data-admin-close-detail]");
      if (close) { closeDetail(); return; }
      const act = event.target.closest("[data-admin-active]");
      if (act) { await toggleActive(Number(act.dataset.adminActive), act.dataset.active === "1"); return; }
      const role = event.target.closest("[data-admin-role]");
      if (role) { await toggleRole(Number(role.dataset.adminRole), role.dataset.makeadmin === "1"); return; }
      const reset = event.target.closest("[data-admin-reset]");
      if (reset) { await resetPassword(Number(reset.dataset.adminReset)); return; }
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();

    // v12.6-B3.4 — Changement de langue immédiat : on réaffiche les données
    // DÉJÀ EN MÉMOIRE (aucune requête réseau, aucune action administrative,
    // aucun rechargement de page). La recherche saisie est conservée ; la fiche
    // ouverte n'est pas fermée ; aucune notification n'est émise.
    if (window.I18N && typeof window.I18N.onLocaleChange === "function") {
      window.I18N.onLocaleChange(() => {
        applyStaticAdminLabels();
        reRender();
      });
    }
  });

  /** Réapplique les libellés statiques administrés par data-i18n (repli). */
  function applyStaticAdminLabels() {
    if (!window.I18N || typeof window.I18N.t !== "function") return;
    document.querySelectorAll("[data-admin-static]").forEach((elx) => {
      const key = elx.getAttribute("data-admin-static");
      if (key) elx.textContent = window.I18N.t(key);
    });
  }

  /**
   * Réaffiche les statistiques, la liste et la fiche ouverte à partir des
   * données mémorisées, avec la langue courante. Ne déclenche aucun fetch et
   * aucune action administrative.
   */
  function reRender() {
    if (!visible) return;
    const statsBox = document.getElementById("adminStats");
    if (statsBox && lastStats) renderStats(statsBox, lastStats);
    const list = document.getElementById("adminUserList");
    if (list && lastUsers) renderUsers(list, lastUsers);
    if (lastDetail && currentDetailId != null) {
      const existing = document.getElementById("adminDetailPanel");
      const panel = existing || createDetailPanel();
      renderDetail(panel, lastDetail.user);
    }
  }

  /** Crée le conteneur de fiche s'il n'existe pas (réaffichage après langue). */
  function createDetailPanel() {
    const panel = document.createElement("div");
    panel.id = "adminDetailPanel";
    panel.className = "admin-detail";
    const list = document.getElementById("adminUserList");
    if (list) list.appendChild(panel);
    return panel;
  }

  return {
    updateAccess,
    show,
    hide,
    /** Aides pures exposées pour les tests JXA (v12.6-B3.4). */
    __test: {
      t,
      formatDate,
      formatDateCompact,
      escapeHtml,
      reRender,
      applyStaticAdminLabels,
      actIconButton,
    },
  };
})();

if (typeof window !== "undefined") {
  window.AdminUI = AdminUI;
}

