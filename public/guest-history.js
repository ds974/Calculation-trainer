"use strict";

/**
 * guest-history.js — Historique et import invité (Mission Calcul Mental v12).
 *
 * Fournit UN espace localStorage DÉDIÉ à l'historique des parties invitées v12,
 * sans toucher aux clés de la v10/v11 (multiplicationTrainer.config.v11,
 * multiplicationTrainer.scores.v11, .v10, tables, timeLimit, scores…).
 *
 * Comportement :
 *  - En mode invité (non connecté), chaque partie terminée est enregistrée
 *    localement dans `missionCalculMental.history.v12`. Jamais mélangée aux
 *    statistiques des comptes connectés.
 *  - En mode connecté (session définie via setSession), la partie est envoyée
 *    au serveur (result/save) et n'est PAS stockée localement.
 *  - L'import (`importToAccount`) envoie volontairement l'historique invité au
 *    compte connecté, de façon idempotente : après réussite, une trace locale
 *    des `guest_id` importés est conservée pour ne pas les renvoyer, et le
 *    serveur refuse également les doublons (colonne unique guest_id par user).
 *
 * Ce module est autonome et prêt à être branché par l'interface de connexion
 * (étape suivante) : il faut uniquement appeler setSession() après connexion /
 * déconnexion côté frontend.
 */

const GuestHistoryV12 = (() => {
  const STORAGE_KEY = "missionCalculMental.history.v12";
  const IMPORTED_KEY = "missionCalculMental.history.v12.imported";
  const API_BASE = "api/index.php";

  // État de session. null = invité. Renseigné par le module d'authentification.
  let session = null;

  /**
   * Définit (ou réinitialise, si null) la session frontend.
   * @param {{token:string, user:object}|null} s
   */
  function setSession(s) {
    session = s && typeof s === "object" && s.token ? s : null;
  }

  /** Lit la liste brute des parties invitées stockées localement. */
  function loadAll() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed) ? parsed : [];
    } catch (_e) {
      return [];
    }
  }

  function saveAll(entries) {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(entries));
    } catch (_e) {
      /* stockage indisponible : on ignore silencieusement */
    }
  }

  /** Trace locale des guest_id déjà importés (évite de les réimporter). */
  function loadImported() {
    try {
      const raw = localStorage.getItem(IMPORTED_KEY);
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === "object" ? new Set(parsed) : new Set();
    } catch (_e) {
      return new Set();
    }
  }

  function saveImported(ids) {
    try {
      localStorage.setItem(IMPORTED_KEY, JSON.stringify([...ids]));
    } catch (_e) {
      /* ignore */
    }
  }

  /** Génère un guest_id stable pour la partie (idempotence de l'import). */
  function makeGuestId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return "v12-" + window.crypto.randomUUID();
    }
    return (
      "v12-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  /** Mappe un mode frontend ("mult"/"add") vers le mode serveur. */
  function serverMode(mode) {
    return mode === "add" ? "addition" : "multiplication";
  }

  /** Appel HTTP JSON vers l'API. Renvoie {ok, status, data, error}. */
  async function api(action, payload) {
    try {
      const res = await fetch(API_BASE, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "same-origin",
        body: JSON.stringify(Object.assign({ action, csrf_token: session.token }, payload)),
      });
      const body = await res.json().catch(() => ({}));
      return {
        ok: res.status >= 200 && res.status < 300 && body.ok === true,
        status: res.status,
        data: body.data || null,
        error: body.error || "",
      };
    } catch (_e) {
      return { ok: false, status: 0, data: null, error: "réseau" };
    }
  }

  /**
   * Enregistre une partie terminée.
   * @param {{mode:string, score:number, playedAt?:string}} part mode "mult"/"add".
   * @return {Promise<object>} {server:false, entry} (invite) / {server:true, ok} (connecte).
   */
  async function record(part) {
    const mode = serverMode(part.mode);
    const playedAt = part.playedAt || new Date().toISOString();

    if (session) {
      const res = await api("result/save", { mode, score: part.score, played_at: playedAt });
      return { server: true, ok: res.ok };
    }

    const entry = {
      guest_id: makeGuestId(),
      mode: mode,
      score: part.score,
      played_at: playedAt,
    };
    const all = loadAll();
    all.push(entry);
    saveAll(all);
    return { server: false, entry: entry };
  }

  /**
   * Importe volontairement l'historique invite vers le compte connecte.
   * @param {function(number):boolean|Promise<boolean>} [confirmFn] confirmation explicite.
   * @return {Promise<object>} {cancelled}|{error}|{imported,skipped}.
   */
  async function importToAccount(confirmFn) {
    if (!session) {
      return { error: "not-connected" };
    }

    const all = loadAll();
    const importedSet = loadImported();
    const pending = all.filter((e) => e && e.guest_id && !importedSet.has(e.guest_id));

    if (pending.length === 0) {
      return { imported: 0, skipped: 0 };
    }

    if (typeof confirmFn === "function") {
      const ok = await confirmFn(pending.length);
      if (!ok) {
        return { cancelled: true };
      }
    }

    const res = await api("result/import", {
      items: pending.map((e) => ({
        guest_id: e.guest_id,
        mode: e.mode,
        score: e.score,
        played_at: e.played_at,
      })),
    });

    if (!res.ok) {
      return { error: "server", response: res };
    }

    const importedNow = (res.data && res.data.imported) || 0;
    if (importedNow > 0) {
      const sentIds = pending.map((e) => e.guest_id);
      const next = new Set(importedSet);
      sentIds.forEach((id) => next.add(id));
      saveImported(next);
    }

    return { imported: res.data.imported, skipped: res.data.skipped };
  }

  return {
    setSession,
    record,
    importToAccount,
    loadAll,
    get hasSession() {
      return session !== null;
    },
  };
})();

// Exposition globale pour branchement ulterieur (etape suivante) et tests.
if (typeof window !== "undefined") {
  window.MissionGuestHistory = GuestHistoryV12;
}

if (typeof module !== "undefined" && module.exports) {
  module.exports = GuestHistoryV12;
}

