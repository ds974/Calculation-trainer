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


  function escapeHtml(value) {
    return String(value ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function formatDate(iso) {
    if (!iso) return "—";
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    return d.toLocaleDateString("fr-FR", { day: "2-digit", month: "long", year: "numeric" });
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
          error: body.error || (res.status === 401 ? "Authentification requise." : ""),
        };
      } catch (_e) {
        return { ok: false, status: 0, data: null, error: "réseau" };
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
        await window.AccountUI.handleSessionExpired("Votre session a expiré ou votre compte a été désactivé.");
      }
      return true;
    }
    toast(fallback || "Action impossible.");
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
        toast("Mot de passe temporaire copié.");
      } catch (_e) {
        toast("Impossible de copier automatiquement. Sélectionnez le mot de passe manuellement.");
      }
      ta.remove();
    };
    if (navigator.clipboard && typeof navigator.clipboard.writeText === "function") {
      navigator.clipboard.writeText(text).then(
        () => toast("Mot de passe temporaire copié."),
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
        await window.AccountUI.handleSessionExpired("Accès réservé aux administrateurs.");
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
    box.innerHTML = '<div class="stats-status"><span class="spinner"></span><p>Chargement des statistiques…</p></div>';
    const res = await call("admin/stats", null, "GET");
    if (seq !== statsSeq || !visible) return;
    if (!res.ok) {
      if (await handleError(res, "Impossible de charger les statistiques.")) return;
      box.innerHTML = '<div class="stats-error"><h3>Statistiques indisponibles</h3></div>';
      return;
    }
    const statsData = res.data || {};
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
      statCard("Comptes", u.total ?? 0) +
      statCard("Administrateurs", u.admins ?? 0) +
      statCard("Comptes actifs", u.active ?? 0) +
      statCard("Parties jouées", g.total ?? 0) +
      statCard("7 derniers jours", g.last_7d ?? 0) +
      statCard("30 derniers jours", g.last_30d ?? 0) +
      statCard("Multiplications", (g.multiplication_pct ?? 0) + " %") +
      statCard("Additions", (g.addition_pct ?? 0) + " %") +
      "</div>" +
      '<p class="stats-note">' +
      "Répartition relative des parties par type de calcul ; les périodes « 7 et 30 derniers jours » " +
      "sont calculées en fonction de l’heure du serveur." +
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
    list.innerHTML = '<div class="stats-status"><span class="spinner"></span><p>Chargement des comptes…</p></div>';
    const res = await call("admin/users", { limit: 200, q: currentSearch }, "GET");
    if (seq !== usersSeq || !visible) return;
    if (!res.ok) {
      if (await handleError(res, "Impossible de charger la liste des comptes.")) return;
      list.innerHTML = '<div class="stats-error"><h3>Liste indisponible</h3></div>';
      return;
    }
    renderUsers(list, res.data || {});
  }

  function renderUsers(list, data) {
    const users = Array.isArray(data.users) ? data.users : [];
    if (users.length === 0) {
      list.innerHTML = '<div class="empty-state">Aucun compte' +
        (currentSearch ? " pour « " + escapeHtml(currentSearch) + " »" : "") + ".</div>";
      return;
    }
    const me = currentUser();
    const myId = me ? me.id : null;

    let rows = "";
    for (const u of users) {
      const self = u.id === myId;
      const activeTxt = u.is_active ? "Activé" : "Désactivé";
      const activeKind = u.is_active ? "ok" : "danger";
      const roleTxt = u.role === "admin" ? "Admin" : "Utilisateur";
      const roleKind = u.role === "admin" ? "admin" : "neutral";
      // Dernier administrateur ACTIF : on doit empêcher sa rétrogradation et sa
      // désactivation tant qu'aucun autre administrateur actif ne peut prendre le relais.
      const isLastActiveAdmin = u.role === "admin" && u.is_active === true && activeAdmins === 1;

      // Consulter reste toujours disponible.
      let actions =
        '<button type="button" class="btn btn-secondary btn-small" data-admin-view="' + u.id + '">Consulter</button>';

      if (isLastActiveAdmin) {
        // Les deux actions interdites sont désactivées (visuellement et fonctionnellement).
        // La note visible décrit la raison, et est atteignable au clavier (tabindex) :
        // elle ne dépend pas uniquement de l'infobulle title d'un bouton désactivé
        // (que Firefox n'affiche d'ailleurs pas pour un élément disabled).
        const noteId = "lastAdminNote-" + u.id;
        const disabledBtn = ' disabled aria-disabled="true" title="Impossible : ce compte est le dernier administrateur actif." aria-describedby="' + noteId + '"';
        actions +=
          '<button type="button" class="btn btn-secondary btn-small"' + disabledBtn + ' data-admin-active="' + u.id + '" data-active="0">Désactiver</button>' +
          '<button type="button" class="btn btn-secondary btn-small"' + disabledBtn + ' data-admin-role="' + u.id + '" data-makeadmin="0">Rétrograder</button>';
        actions +=
          '<span class="admin-last-admin-note" id="' + noteId + '" role="note" tabindex="0">' +
          "Impossible : ce compte est le dernier administrateur actif.</span>";
      } else {
        actions +=
          '<button type="button" class="btn btn-secondary btn-small" data-admin-active="' + u.id + '" data-active="' + (u.is_active ? "0" : "1") + '">' +
          (u.is_active ? "Désactiver" : "Réactiver") + "</button>" +
          '<button type="button" class="btn btn-secondary btn-small" data-admin-role="' + u.id + '" data-makeadmin="' + (u.role === "admin" ? "0" : "1") + '">' +
          (u.role === "admin" ? "Rétrograder" : "Promouvoir admin") + "</button>";
      }
      actions +=
        '<button type="button" class="btn btn-secondary btn-small" data-admin-reset="' + u.id + '">Reset mot de passe</button>';
      rows +=
        "<tr>" +
        "<td><strong>" + escapeHtml(u.login) + "</strong>" + (self ? ' <span class="admin-self">(vous)</span>' : "") + "</td>" +
        "<td>" + badge(roleTxt, roleKind) + "</td>" +
        "<td>" + badge(activeTxt, activeKind) + "</td>" +
        "<td>" + formatDate(u.created_at) + "</td>" +
        "<td class=\"admin-actions\">" + actions + "</td>" +
        "</tr>";
    }

    list.innerHTML =
      '<div class="table-scroll">' +
      '<table class="leaderboard-table admin-table">' +
      "<thead><tr>" +
      "<th>Identifiant</th><th>Rôle</th><th>Statut</th><th>Créé le</th><th>Actions</th>" +
      "</tr></thead><tbody>" + rows + "</tbody></table></div>" +
      '<p class="stats-note">Réinitialiser un mot de passe génère un mot de passe temporaire à usage unique.</p>';
  }


  async function openDetail(id) {
    currentDetailId = id;
    const list = document.getElementById("adminUserList");
    if (!list) return;
    const existing = document.getElementById("adminDetailPanel");
    if (existing) existing.remove();
    const seq = ++detailSeq;
    list.insertAdjacentHTML("beforeend",
      '<div id="adminDetailPanel" class="admin-detail"><div class="stats-status"><span class="spinner"></span><p>Consultation du compte…</p></div></div>');
    const res = await call("admin/user", { id }, "GET");
    if (seq !== detailSeq || !visible) return;
    const panel = document.getElementById("adminDetailPanel");
    if (!res.ok) {
      if (await handleError(res, "Impossible de charger le compte.")) return;
      if (panel) panel.remove();
      return;
    }
    if (!panel) return;
    renderDetail(panel, (res.data && res.data.user) || {});
  }

  function renderDetail(panel, u) {
    const hist = Array.isArray(u.history) ? u.history : [];
    let histHtml;
    if (hist.length === 0) {
      histHtml = '<div class="admin-detail-empty">Aucune partie enregistrée pour ce compte.</div>';
    } else {
      let hRows = "";
      for (const g of hist.slice(0, 20)) {
        const modeLabel = g.mode === "addition" ? "Additions" : "Multiplications";
        hRows += "<tr><td>" + formatDate(g.played_at) + "</td><td>" + escapeHtml(modeLabel) + "</td><td>" + escapeHtml(g.score) + " / 10</td></tr>";
      }
      histHtml =
        '<div class="table-scroll"><table class="leaderboard-table admin-table">' +
        "<thead><tr><th>Date</th><th>Type</th><th>Score</th></tr></thead><tbody>" +
        hRows + "</tbody></table></div>" +
        (hist.length > 20 ? '<p class="stats-note">20 dernières parties affichées.</p>' : "");
    }

    panel.innerHTML =
      '<div class="admin-detail-head">' +
      "<h4>Compte « " + escapeHtml(u.login) + " »</h4>" +
      '<button type="button" class="btn btn-secondary btn-small" data-admin-close-detail>Fermer</button>' +
      "</div>" +
      '<div class="admin-detail-grid">' +
      "<div><strong>Identifiant</strong><span>" + escapeHtml(u.login || "—") + "</span></div>" +
      "<div><strong>Rôle</strong><span>" + badge(u.role === "admin" ? "Admin" : "Utilisateur", u.role === "admin" ? "admin" : "neutral") + "</span></div>" +
      "<div><strong>Statut</strong><span>" + badge(u.is_active ? "Activé" : "Désactivé", u.is_active ? "ok" : "danger") + "</span></div>" +
      "<div><strong>Créé le</strong><span>" + formatDate(u.created_at) + "</span></div>" +
      "<div><strong>Dernier accès</strong><span>" + formatDate(u.last_login_at) + "</span></div>" +
      "<div><strong>Parties jouées</strong><span>" + escapeHtml(u.played_games ?? 0) + "</span></div>" +
      "</div>" +
      "<h5>Historique récent</h5>" + histHtml;
  }

  function closeDetail() {
    currentDetailId = null;
    const panel = document.getElementById("adminDetailPanel");
    if (panel) panel.remove();
  }


  async function toggleActive(id, active) {
    const verb = active ? "réactiver" : "désactiver";
    const noun = active ? "réactivation" : "désactivation";
    if (!window.confirm(
      "Confirmer la " + noun + " de ce compte ?\n\n" +
      "Un compte désactivé ne peut plus se connecter, et toute session déjà ouverte " +
      "devient immédiatement inutilisable. Son historique est conservé."
    )) return;
    const res = await call("admin/active", { user_id: id, is_active: active }, "POST");
    if (!res.ok) {
      await handleError(res, "Impossible de " + verb + " le compte.");
      return;
    }
    toast("Compte " + (active ? "réactivé" : "désactivé") + ".");
    await reloadAfterChange();
  }

  async function toggleRole(id, makeAdmin) {
    const message = makeAdmin
      ? "Confirmer la promotion de ce compte au rôle administrateur ?\n\n" +
        "Les droits d’administration s’appliquent immédiatement."
      : "Confirmer la rétrogradation de ce compte au rôle utilisateur ?\n\n" +
        "Le rôle ne peut pas être retiré au dernier administrateur actif.";
    if (!window.confirm(message)) return;
    const res = await call("admin/role", { user_id: id, make_admin: makeAdmin }, "POST");
    if (!res.ok) {
      await handleError(res, "Impossible de modifier le rôle.");
      return;
    }
    toast("Rôle mis à jour.");
    syncAdminAccessAfterChange();
    await reloadAfterChange();
  }

  async function resetPassword(id) {
    if (!window.confirm(
      "Réinitialiser le mot de passe de ce compte ?\n\n" +
      "Un mot de passe temporaire sera généré et affiché une seule fois. " +
      "Le mot de passe actuel cessera immédiatement de fonctionner."
    )) return;
    const btn = document.querySelector('[data-admin-reset="' + id + '"]');
    if (btn) {
      btn.dataset.original = btn.textContent;
      btn.textContent = "Génération…";
      btn.disabled = true;
    }
    const res = await call("admin/password", { user_id: id }, "POST");
    if (btn) {
      btn.textContent = btn.dataset.original || "Reset mot de passe";
      btn.disabled = false;
    }
    if (!res.ok) {
      await handleError(res, "Impossible de réinitialiser le mot de passe.");
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
      '<h3 id="adminResetTitle">Mot de passe temporaire</h3>' +
      '<p class="muted">Pour le compte <strong>' + escapeHtml(login) + "</strong>.<br>" +
      "À communiquer de manière sécurisée. Il ne sera plus affiché après fermeture.</p>" +
      '<div class="admin-reset-password">' + escapeHtml(pwd) + "</div>" +
      '<div class="form-actions">' +
      '<button type="button" class="btn btn-primary" id="adminResetCopy">Copier</button>' +
      '<button type="button" class="btn btn-secondary" id="adminResetClose">J’ai copié, fermer</button>' +
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
  });

  return {
    updateAccess,
    show,
    hide,
  };
})();

if (typeof window !== "undefined") {
  window.AdminUI = AdminUI;
}

