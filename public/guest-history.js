"use strict";

/**
 * guest-history.js — Historique des parties invitées (Mission Calcul Mental v12).
 *
 * Fournit UN espace localStorage DÉDIÉ à l'historique des parties invitées v12,
 * sans toucher aux clés de la v10/v11 (multiplicationTrainer.config.v11,
 * multiplicationTrainer.scores.v11, .v10, tables, timeLimit, scores…).
 *
 * Comportement (v12.2) :
 *  - En mode invité (non connecté), chaque partie terminée est enregistrée
 *    localement dans `missionCalculMental.history.v12`. Jamais mélangée aux
 *    statistiques des comptes connectés.
 *  - En mode connecté (session définie via setSession), la partie est envoyée
 *    au serveur (`result/save`) et n'est PAS stockée localement. L'identité du
 *    joueur est celle de la SESSION SERVEUR authentifiée : le client ne transmet
 *    aucun user_id, évitant toute attribution frauduleuse par pseudonyme.
 *
 * L'import des anciennes parties invitées vers un compte a été volontairement
 * SUPPRIMÉ (v12.2) : le module ne propose plus aucune opération d'import, et la
 * route serveur correspondante a été retirée. Les parties invitées restent
 * toutefois conservées localement sans être détruites.
 */

const GuestHistoryV12 = (() => {
  const STORAGE_KEY = "missionCalculMental.history.v12";
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

  /** Génère un identifiant stable pour une partie invitée conservée localement. */
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

  /**
   * Génère un identifiant unique et stable de mission (v12.4).
   *
   * Un même mission_id identifie UNE mission donnée et est conservé lors des
   * tentatives de sauvegarde répétées (bouton « Réessayer », double POST) :
   * le serveur s'en sert pour garantir l'idempotence (une seule écriture).
   */
  function makeMissionId() {
    if (window.crypto && typeof window.crypto.randomUUID === "function") {
      return "v124-" + window.crypto.randomUUID();
    }
    return (
      "v124-" +
      Date.now().toString(36) +
      "-" +
      Math.random().toString(36).slice(2, 10)
    );
  }

  /** Mappe un mode frontend ("mult"/"add") vers le mode serveur. */
  function serverMode(mode) {
    return mode === "add" ? "addition" : "multiplication";
  }

  /**
   * Normalise une date ISO (produite notamment par new Date().toISOString())
   * vers le format strict attendu par le backend : YYYY-MM-DDTHH:mm:ssZ, SANS
   * millisecondes. L'instant est préservé à la précision de la seconde : dans
   * toISOString(), les fractions sont toujours exactement 3 chiffres (.sssZ),
   * on se contente donc de retirer ".sss" en fin de chaîne.
   *
   * @param {string|Date|number} [value] date brute ; si vide ou invalide,
   *   on retombe sur l'instant courant (UTC).
   * @return {string} horodatage UTC au format strict (contrat backend).
   */
  function toUtcSecondsIso(value) {
    const d = value ? new Date(value) : new Date();
    if (isNaN(d.getTime())) {
      return toUtcSecondsIso();
    }
    return d.toISOString().replace(/\.\d{3}Z$/, "Z");
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
   * @param {{mode:string, score:number, playedAt?:string, questionType?:string,
   *          missionId?:string, details?:Array<object>}} part
   *        mode "mult"/"add". `missionId` et `details` (v12.4) sont facultatifs et
   *        utilisés UNIQUEMENT pour un compte connecté : ils alimentent la mémoire
   *        des difficultés (idempotente). En mode invité, ils sont ignorés.
   * @return {Promise<object>} {server:false, entry} (invite) / {server:true, ok} (connecte).
   */
  async function record(part) {
    const mode = serverMode(part.mode);
    const playedAt = toUtcSecondsIso(part.playedAt);
    const questionType = part.questionType === "hole" || part.questionType === "mixed"
      ? part.questionType
      : "classic";

    if (session) {
      const payload = {
        mode,
        score: part.score,
        played_at: playedAt,
        question_type: questionType,
      };
      // v12.4 : détail individuel des réponses + mission_id stable => mémoire
      // des difficultés personnelles côté serveur (atomique et idempotente).
      if (part.missionId && Array.isArray(part.details) && part.details.length) {
        payload.mission_id = part.missionId;
        payload.details = part.details;
      }
      const res = await api("result/save", payload);
      return { server: true, ok: res.ok };
    }

    const entry = {
      guest_id: makeGuestId(),
      mode: mode,
      score: part.score,
      played_at: playedAt,
      question_type: questionType,
    };
    const all = loadAll();
    all.push(entry);
    saveAll(all);
    return { server: false, entry: entry };
  }

  return {
    setSession,
    toUtcSecondsIso,
    record,
    loadAll,
    makeMissionId,
    get hasSession() {
      return session !== null;
    },
    /** Utilisateur courant de la session (null en mode invité). */
    get currentUser() {
      return session ? session.user : null;
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

