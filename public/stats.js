"use strict";

/**
 * stats.js — Écran « Mes statistiques » (Mission Calcul Mental v12, étape 6B).
 *
 * Responsabilités :
 *  - Consommer UNIQUEMENT la route API `GET stats?mode=<multiplication|addition>`
 *    (aucune donnée inventée côté client ; l'utilisateur est identifié par la
 *    session, jamais par un user_id transmis par le navigateur).
 *  - Afficher : total de parties, scores moyens (global, 7 j et 30 j glissants),
 *    meilleur score, courbe des 30 dernières parties et histogramme journalier
 *    sur 30 jours (jours calendaires de La Réunion).
 *  - Dessiner les graphiques avec Chart.js (bibliothèque locale, compatible CSP).
 *  - Détruire proprement les instances Chart.js à chaque changement de mode,
 *    rechargement et départ de l'écran.
 *  - Gérer les sessions expirées (401) et les erreurs réseau, et fournir une
 *    alternative textuelle accessible pour chaque graphique.
 *
 * L'écran n'est accessible que via l'espace du compte connecté : un utilisateur
 * non identifié reçoit un 401 de l'API, relayé automatiquement à la connexion.
 */

const StatsUI = (() => {
  const API_BASE = "api/index.php";
  const MODES = { multiplication: "Multiplications", addition: "Additions" };

  // Instance(s) Chart.js actives, pour destruction propre.
  let charts = [];
  let activeMode = "multiplication";
  let currentFetch = null;
  let sessionTimeoutHandler = null;

  // Données rendues en mémoire (pour le réaffichage sans requête lors d'un
  // changement de langue).
  let cachedData = null;

  // ------------------------------------------------------------------ i18n

  /** Langue courante ; repli français si le moteur est indisponible. */
  function statsLocale() {
    const I = window && window.I18N;
    return (I && typeof I.getLocale === "function") ? I.getLocale() : "fr";
  }

  /** Traduction + interpolation ; repli français si le moteur est indisponible. */
  function i18nT(key, vars, fallback) {
    const I = window && window.I18N;
    if (I && typeof I.t === "function") return I.t(key, vars);
    return fallback;
  }

  /** Séparateur décimal de la langue courante (Intl), sinon « , » (français). */
  function decimalSeparator(locale) {
    try {
      const parts = new Intl.NumberFormat(locale || "fr").formatToParts(1.5);
      for (let i = 0; i < parts.length; i++) {
        if (parts[i].type === "decimal") return parts[i].value;
      }
    } catch (e) { /* formatToParts indisponible */ }
    return ",";
  }

  /** Formatte un nombre selon la langue courante ; repli français sinon. */
  function i18nNumber(value) {
    const I = window && window.I18N;
    if (I && typeof I.formatNumber === "function") return I.formatNumber(value);
    return Number(value).toLocaleString("fr-FR", { maximumFractionDigits: 1 });
  }

  // ------------------------------------------------------------------ Utilitaires

  /** Crée un élément avec du texte (aucune donnée non échappée en HTML). */
  function el(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined && text !== null) node.textContent = text;
    return node;
  }

  /**
   * Formatte "YYYY-MM-DD" (jour calendaire déjà exprimé en heure de La Réunion)
   * selon la langue courante. On construit une date à midi UTC à partir des
   * composantes (année-mois-jour) pour que la présentation ne décale jamais le
   * jour calendaire de référence (Indian/Reunion, UTC+4) : seule l'apparence
   * change, pas la valeur ni le regroupement par jour.
   */
  function formatDay(day) {
    if (typeof day !== "string") return "";
    const m = day.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!m) return day;
    const year = parseInt(m[1], 10);
    const month = parseInt(m[2], 10);
    const d = parseInt(m[3], 10);
    const stable = new Date(Date.UTC(year, month - 1, d, 12, 0, 0));
    if (isNaN(stable.getTime())) return day;
    const I = window && window.I18N;
    try {
      const fmt = (I && typeof I.formatDate === "function")
        ? I.formatDate(stable, { day: "numeric", month: "short" })
        : stable.toLocaleDateString("fr-FR", { day: "numeric", month: "short" });
      return fmt;
    } catch (e) {
      return d + " " + (FR_MONTHS_FALLBACK[month - 1] || "");
    }
  }
  /** Repli français (mois abrégés) si Intl n'est pas disponible. */
  const FR_MONTHS_FALLBACK = ["janv.", "févr.", "mars", "avr.", "mai", "juin", "juil.", "août", "sept.", "oct.", "nov.", "déc."];

  /** Formatte une moyenne : réel → 1 décimale, sinon "—". */
  function fmtAvg(value) {
    if (value === null || value === undefined || isNaN(Number(value))) return "—";
    return i18nNumber(Number(value));
  }

  function destroyCharts() {
    charts.forEach((c) => {
      try { c.destroy(); } catch (_e) { /* déjà détruit */ }
    });
    charts = [];
  }

  // ------------------------------------------------------------- Contenu du haut

  function buildCards(d) {
    const totals = d.totals || {};
    const periods = d.periods || {};
    const last7 = periods.last_7d || {};
    const last30 = periods.last_30d || {};

    const wrapper = el("div", "stats-cards");
    const specs = [
      { label: i18nT("stats.gamesPlayed", null, "Parties jouées"), value: String(totals.games ?? 0), hint: i18nT("stats.hintTotal", null, "au total") },
      { label: i18nT("stats.avgScoreGlobal", null, "Score moyen global"), value: fmtAvg(totals.avg_score), hint: i18nT("stats.hintOver10", null, "/10") },
      { label: i18nT("stats.bestScore", null, "Meilleur score"), value: fmtAvg(totals.best_score), hint: i18nT("stats.hintOver10", null, "/10") },
      { label: i18nT("stats.avg7days", null, "Moyenne · 7 derniers jours"), value: fmtAvg(last7.avg_score), hint: i18nT("stats.hintOver10", null, "/10") },
      { label: i18nT("stats.avg30days", null, "Moyenne · 30 derniers jours"), value: fmtAvg(last30.avg_score), hint: i18nT("stats.hintOver10", null, "/10") },
    ];
    specs.forEach((s) => {
      const card = el("div", "stat-card");
      card.appendChild(el("span", "stat-card-label", s.label));
      card.appendChild(el("span", "stat-card-value", s.value));
      if (s.hint) card.appendChild(el("span", "stat-card-hint", s.hint));
      wrapper.appendChild(card);
    });
    return wrapper;
  }

  function buildPeriodNote() {
    const note = el("div", "stats-note");
    const p = document.createElement("p");
    p.textContent = i18nT("stats.periodNote", null,
      "Les moyennes des 7 et 30 jours concernent des périodes glissantes (7 et 30 derniers jours). " +
      "L'histogramme représente les parties par jour calendaire de La Réunion (UTC+4) sur les 30 derniers jours.");
    note.appendChild(p);
    return note;
  }

  // ------------------------------------------------- Tableaux accessibles

  /** Alternative textuelle (invisible visuellement) pour la courbe. */
  function buildProgressionTable(list) {
    const dl = document.createElement("dl");
    dl.className = "sr-only stats-fallback";
    dl.setAttribute("aria-label", i18nT("aria.progressionDetail", null, "Détail des scores des 30 dernières parties"));
    (list || []).forEach((score, i) => {
      const dt = document.createElement("dt");
      dt.textContent = i18nT("stats.partGame", { n: i + 1 }, "Partie " + (i + 1));
      const dd = document.createElement("dd");
      dd.textContent = score + " / 10";
      dl.append(dt, dd);
    });
    if (!list || list.length === 0) {
      const p = document.createElement("p");
      p.textContent = i18nT("stats.noGames", null, "Aucune partie enregistrée.");
      dl.appendChild(p);
    }
    return dl;
  }

  /** Alternative textuelle (invisible visuellement) pour l'histogramme. */
  function buildDailyTable(daily) {
    const dl = document.createElement("dl");
    dl.className = "sr-only stats-fallback";
    dl.setAttribute("aria-label", i18nT("aria.dailyDetail", null, "Parties jouées par jour (30 derniers jours, jours de La Réunion)"));
    (daily || []).forEach((row) => {
      const dt = document.createElement("dt");
      dt.textContent = formatDay(row.day) || String(row.day);
      const dd = document.createElement("dd");
      const n = Number(row.games) || 0;
      const I = window && window.I18N;
      dd.textContent = (I && typeof I.pl === "function")
        ? I.pl("stats.game", n, { count: n })
        : n + " partie" + (n > 1 ? "s" : "");
      dl.append(dt, dd);
    });
    return dl;
  }


  // ------------------------------------------------------------- Graphiques

  /** Détecte la présence de Chart.js (bibliothèque locale). */
  function chartAvailable() {
    return typeof window.Chart === "function" ||
      (typeof window.Chart !== "undefined" && window.Chart &&
        typeof window.Chart.Chart === "function");
  }

  function chartFactory() {
    if (typeof window.Chart === "function") return window.Chart;
    if (window.Chart && typeof window.Chart.Chart === "function") return window.Chart.Chart;
    return null;
  }

  function baseColors() {
    return {
      primary: "#287f79",
      primaryLight: "#7ed9cb",
      text: "#223139",
      grid: "rgba(34,49,57,.12)",
      muted: "#61737b",
    };
  }

  function buildProgressionChart(canvas, list) {
    const factory = chartFactory();
    if (!factory) return;
    const colors = baseColors();
    const labels = (list || []).map((_, i) => i18nT("stats.partGame", { n: i + 1 }, "Partie " + (i + 1)));
    const chart = new factory(canvas, {
      type: "line",
      data: {
        labels,
        datasets: [{
          label: i18nT("stats.chartLabelScore", null, "Score"),
          data: list || [],
          borderColor: colors.primary,
          backgroundColor: "rgba(40,127,121,.12)",
          fill: true,
          tension: 0.3,
          pointRadius: 3,
          pointHoverRadius: 5,
          borderWidth: 2,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: { label: (ctx) => ctx.parsed.y + " / 10" },
          },
        },
        scales: {
          y: {
            min: 0,
            max: 10,
            ticks: { stepSize: 1, color: colors.text },
            grid: { color: colors.grid },
            title: { display: true, text: i18nT("stats.hintOver10", null, "/10") },
          },
          x: {
            ticks: { color: colors.text, maxTicksLimit: 12, autoSkip: true },
            grid: { display: false },
          },
        },
      },
    });
    charts.push(chart);
  }

  /**
   * Libellé à afficher pour l'indice `index` de l'axe horizontal de
   * l'histogramme journalier (v12.7-P1).
   *
   * Chart.js fournit un tick par indice ; on ne veut PAS les afficher tous
   * (surcharge visuelle), mais on doit GARANTIR la présence du dernier jour
   * (aujourd'hui), même si sa valeur est nulle. On échantillonne donc les
   * graduations intermédiaires (une tous les `step` jours, comme avant :
   * ~12 libellés sur 30) et l'on force toujours le dernier indice.
   *
   * Les indices hors périmètre et les indices non échantillonnés (hors dernier)
   * renvoient une chaîne vide : le tick existe mais ne produit aucun libellé.
   *
   * La date est restituée via `formatDay` (jour calendaire de La Réunion déjà
   * exprimé en « YYYY-MM-DD »), donc la présentation suit la langue courante
   * SANS modifier le jour de référence ni le regroupement.
   *
   * @param {Array<{day:string,games:number}>|null} daily données journalières.
   * @param {number} index indice de tick (0..n-1).
   * @return {string} libellé à afficher, ou "" si aucun.
   */
  function dailyLabelForIndex(daily, index) {
    const rows = daily || [];
    const n = rows.length;
    if (index < 0 || index >= n) return "";
    const isLast = index === n - 1;
    // Une graduation intermédiaire tous les 3 jours (≈ 11-12 libellés sur 30).
    const step = 3;
    if (!isLast && index % step !== 0) return "";
    const row = rows[index];
    return row ? formatDay(row.day) || String(row.day) : "";
  }

  function buildDailyChart(canvas, daily) {
    const factory = chartFactory();
    if (!factory) return;
    const colors = baseColors();
    const labels = (daily || []).map((row) => formatDay(row.day) || String(row.day));
    const values = (daily || []).map((row) => Number(row.games) || 0);
    const chart = new factory(canvas, {
      type: "bar",
      data: {
        labels,
        datasets: [{
          label: i18nT("stats.gamesPlayed", null, "Parties"),
          data: values,
          backgroundColor: colors.primaryLight,
          borderColor: colors.primary,
          borderWidth: 1,
          borderRadius: 4,
        }],
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        animation: { duration: 350 },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: (ctx) => {
                const n = ctx.parsed.y;
                const I = window && window.I18N;
                return (I && typeof I.pl === "function")
                  ? I.pl("stats.game", n, { count: n })
                  : n + " partie" + (n > 1 ? "s" : "");
              },
            },
          },
        },
        scales: {
          y: {
            beginAtZero: true,
            ticks: { stepSize: 1, precision: 0, color: colors.text },
            grid: { color: colors.grid },
            title: { display: true, text: i18nT("stats.gamesPlayed", null, "Parties") },
          },
          x: {
            // v12.7-P1 : `autoSkip` est désactivé pour garantir que TOUS les
            // ticks parviennent jusqu'au callback (Chart.js v4 ne conserve pas
            // forcément le dernier tick durant l'échantillonnage autoSkip).
            // On pilote donc nous-mêmes les libellés : graduations
            // intermédiaires espacées + dernier jour (aujourd'hui) TOUJOURS
            // affiché, même à zéro (cf. dailyLabelForIndex).
            ticks: {
              color: colors.text,
              autoSkip: false,
              maxRotation: 60,
              callback: (index) => dailyLabelForIndex((daily || []), index),
            },
            grid: { display: false },
          },
        },
      },
    });
    charts.push(chart);
  }


  // ------------------------------------------------------------ Rendu principal

  // ------------------------------------------- Bilan « Mes points à travailler »

  /** Libellés pédagogiques des statuts de table (v12.4). */
  function difficultyLabels() {
    return {
      to_work: i18nT("difficulty.statusToWork", null, "À travailler"),
      in_progress: i18nT("difficulty.statusInProgress", null, "En progrès"),
      mastered: i18nT("difficulty.statusMastered", null, "Surmontée"),
      insufficient: i18nT("difficulty.statusInsufficient", null, "À pratiquer"),
    };
  }

  /**
   * Affiche un coefficient de difficulté agrégé (0 à 5) avec une précision au
   * demi-point.
   *
   * Les agrégats par table sont des sommes de contributions pondérées de 0,5
   * (un calcul commutatif 6×7 et 7×6 compte pour 0,5 sur chaque table) : on les
   * restitue donc au demi-point le plus proche, formatés avec le séparateur
   * décimal de la langue courante (virgule en français/espagnol, point en
   * anglais/chinois) et sans décimale terminale inutile. Une difficulté qui
   * baisse de 2 à 1,5 devient ainsi visible, là où l'ancien arrondi entier
   * affichait « 2 » dans les deux cas. La précision au demi-point est
   * strictement préservée (2 → « 2 », 1,5 → « 1,5 »/« 1.5 », 0,5 → « 0,5 »/« 0.5 »).
   */
  function formatDiff(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return "0";
    const half = Math.round(n * 2) / 2; // précision au demi-point
    const integer = Math.floor(half);
    const frac = half - integer;
    if (frac === 0) return String(integer);
    // demi-point : séparateur décimal de la langue courante.
    return integer + decimalSeparator(statsLocale()) + "5";
  }

  /**
   * Libellé du nombre de tentatives.
   *
   * Les tentatives sont PONDÉRÉES (un calcul commutatif 6×7 et 7×6 compte pour
   * 0,5 sur chaque table) : elles peuvent donc être fractionnaires et ne
   * représentent pas un nombre réel de questions. On les présente donc comme
   * une quantité APPROXIMATIVE, arrondie à l'entier, pour rester honnête et
   * lisible par un enfant.
   */
  function attemptsLabel(attempts) {
    const n = Number(attempts);
    if (!Number.isFinite(n) || n <= 0) return i18nT("difficulty.notPracticed", null, "pas encore pratiquée");
    if (n < 1) return i18nT("difficulty.lessThanOneTry", null, "moins d'une tentative");
    const rounded = Math.round(n);
    if (rounded === 1) return i18nT("difficulty.aboutOneTry", null, "environ 1 tentative");
    return i18nT("difficulty.aboutTries", { count: rounded }, "environ " + rounded + " tentatives");
  }

  /**
   * Ordre de priorité pédagogique des statuts de table (v12.4).
   * Plus le nombre est petit, plus la table est prioritaire à travailler.
   * Valeurs alignées sur le backend (src/OperationDifficultyService.php).
   */
  const DIFF_STATUS_ORDER = {
    to_work: 0,
    in_progress: 1,
    insufficient: 2,
    mastered: 3,
  };

  /**
   * Trie une COPIE d'une liste de tables, sans modifier la liste d'origine :
   *   1. coefficient de difficulté décroissant (critère principal, quelle que
   *      soit la catégorie de statut) ;
   *   2. à difficulté égale : statut (À travailler → En progrès → À pratiquer →
   *      Surmontée) ;
   *   3. à statut égal : numéro de table croissant.
   */
  function sortedDifficultyList(list) {
    return (list || []).slice().sort((x, y) => {
      const dx = Number(x.difficulty) || 0;
      const dy = Number(y.difficulty) || 0;
      if (dx !== dy) return dy - dx;
      const ox = DIFF_STATUS_ORDER[x.status] ?? 9;
      const oy = DIFF_STATUS_ORDER[y.status] ?? 9;
      if (ox !== oy) return ox - oy;
      return (Number(x.table) || 0) - (Number(y.table) || 0);
    });
  }

  /** Construit un bloc de tables pour une sous-rubrique (classique / à trou). */
  function buildDifficultyTableBlock(title, list) {
    const block = el("div", "diff-block");
    const head = document.createElement("h4");
    head.textContent = title;
    block.appendChild(head);

    if (!list || list.length === 0) {
      block.appendChild(el("p", "diff-empty",
        i18nT("difficulty.empty", null, "Aucune information pour le moment. Jouez des parties de ce type pour suivre vos progrès.")));
      return block;
    }

    const ul = document.createElement("ul");
    ul.className = "diff-tables";
    sortedDifficultyList(list).forEach((t) => {
      const li = document.createElement("li");
      li.className = "diff-table status-" + (t.status || "");
      li.setAttribute("role", "listitem");
      li.appendChild(el("span", "diff-table-name",
        i18nT("difficulty.table", { table: t.table }, "Table de " + t.table)));
      li.appendChild(el("span", "diff-table-status", difficultyLabels()[t.status] || t.status || ""));
      li.appendChild(el("span", "diff-table-diff",
        i18nT("difficulty.difficultyLabel", { value: formatDiff(t.difficulty) }, "difficulté " + formatDiff(t.difficulty))));
      li.appendChild(el("span", "diff-table-attempts", attemptsLabel(t.attempts)));
      ul.appendChild(li);
    });
    block.appendChild(ul);
    return block;
  }

  /**
   * Rubrique « Mes points à travailler » (v12.4).
   * Organisée par table, filtrée par le mode actif (Additions/Multiplications),
   * avec les sous-rubriques « Calculs classiques » et « Calculs à trou ».
   */
  function buildDifficultySection(d) {
    const container = el("section", "stats-difficulty");
    container.appendChild(el("h3", null, i18nT("difficulty.title", null, "Mes points à travailler")));
    container.appendChild(el("p", "diff-intro",
      i18nT("difficulty.intro", null,
        "Les tables à travailler sont indiquées par une difficulté de 0 (facile) à 5 (difficile). " +
        "Les calculs commutatifs et les deux positions du trou comptent ensemble.")));

    const diff = (d && d.difficulty) || {};
    const modeKey = activeMode === "addition" ? "addition" : "multiplication";
    const rubrique = diff[modeKey] || { classic: [], hole: [] };

    container.appendChild(buildDifficultyTableBlock(
      i18nT("difficulty.classic", null, "Calculs classiques"), rubrique.classic));
    container.appendChild(buildDifficultyTableBlock(
      i18nT("difficulty.hole", null, "Calculs à trou"), rubrique.hole));
    return container;
  }


  function renderData(d) {
    const content = document.getElementById("statsContent");
    if (!content) return;
    content.textContent = "";

    const totals = d.totals || {};
    const totalGames = Number(totals.games) || 0;
    // `progression` est un tableau d'objets {rank, score, played_at} ;
    // on n'en retient que les scores numériques pour le graphe et la lecture.
    const progression = Array.isArray(d.progression)
      ? d.progression.map((entry) => {
          const s = Number(entry && entry.score);
          return Number.isFinite(s) ? s : 0;
        })
      : [];
    const daily = Array.isArray(d.daily_games) ? d.daily_games : [];

    content.appendChild(buildCards(d));
    content.appendChild(buildPeriodNote());
    // v12.4 : bilan pédagogique « Mes points à travailler » (mémoire des
    // difficultés par table), indépendant du sélecteur de mode mais filtré par
    // celui-ci (classique / à trou de chaque mode).
    content.appendChild(buildDifficultySection(d));

    // Aucune partie jouée : état vide explicite (pas de graphique vide).
    if (totalGames === 0) {
      const empty = el("div", "stats-empty");
      const title = el("h3", null, i18nT("stats.noGamesYet", null, "Aucune partie pour le moment"));
      const text = el("p", null, i18nT("stats.noGamesText", { mode: modeLabel(activeMode) },
        "Jouez des parties en « " + modeLabel(activeMode) + " » pour voir apparaître vos statistiques. Elles ne concernent que ce type de calcul."));
      empty.append(title, text);
      content.appendChild(empty);
      return;
    }

    // Chart.js est-il disponible (bibliothèque locale chargée) ?
    if (chartAvailable()) {
      // 1. Courbe des 30 dernières parties.
      const block = el("div", "chart-block");
      const head = document.createElement("h3");
      head.textContent = i18nT("stats.curveTitle", null, "Évolution des scores (30 dernières parties)");
      const canvasWrap = el("div", "chart-box chart-box-line");
      const canvas = document.createElement("canvas");
      canvas.setAttribute("role", "img");
      canvas.setAttribute("aria-label", i18nT("aria.progressionCurve", null, "Courbe des scores des 30 dernières parties"));
      canvasWrap.appendChild(canvas);
      block.appendChild(head);
      block.appendChild(canvasWrap);
      content.appendChild(block);
      content.appendChild(buildProgressionTable(progression));

      // 2. Histogramme journalier.
      const block2 = el("div", "chart-block");
      const head2 = document.createElement("h3");
      head2.textContent = i18nT("stats.dailyTitle", null, "Parties par jour (30 derniers jours · La Réunion)");
      const canvasWrap2 = el("div", "chart-box chart-box-bar");
      const canvas2 = document.createElement("canvas");
      canvas2.setAttribute("role", "img");
      canvas2.setAttribute("aria-label", i18nT("aria.dailyHistogram", null, "Histogramme des parties par jour sur les 30 derniers jours"));
      canvasWrap2.appendChild(canvas2);
      block2.appendChild(head2);
      block2.appendChild(canvasWrap2);
      content.appendChild(block2);
      content.appendChild(buildDailyTable(daily));

      // Destruction des instances précédentes avant de redessiner.
      destroyCharts();
      buildProgressionChart(canvas, progression);
      buildDailyChart(canvas2, daily);
    } else {
      // Chart.js indisponible : alternative textuelle lisible sans graphique.
      const block = el("div", "stats-empty");
      const title = el("h3", null, i18nT("stats.chartsUnavailable", null, "Graphiques indisponibles"));
      const text = el("p", null,
        i18nT("stats.chartsUnavailableText", null,
          "La bibliothèque de graphiques n'a pas pu être chargée. Les données restent consultables ci-dessous."));
      block.append(title, text);
      content.appendChild(block);
      content.appendChild(buildProgressionTable(progression));
      content.appendChild(buildDailyTable(daily));
    }
  }

  // ------------------------------------------------------------ États et erreurs

  /** Libellé localisé du mode de calcul (pour les textes descriptifs). */
  function modeLabel(mode) {
    if (mode === "multiplication") return i18nT("common.multiplications", null, "Multiplications");
    if (mode === "addition") return i18nT("common.additions", null, "Additions");
    return mode || "";
  }

  function setLoading(text) {
    const content = document.getElementById("statsContent");
    if (!content) return;
    content.textContent = "";
    const wrap = el("div", "stats-status");
    const spinner = el("div", "spinner", null);
    spinner.setAttribute("aria-hidden", "true");
    const msg = el("p", null, text);
    wrap.append(spinner, msg);
    content.appendChild(wrap);
  }

  function showError(title, message) {
    const content = document.getElementById("statsContent");
    if (!content) return;
    content.textContent = "";

    const block = el("div", "stats-error");
    const h = el("h3", null, title);
    const p = el("p", null, message);
    block.append(h, p);

    const btn = el("button", "btn btn-secondary", i18nT("common.retry", null, "Réessayer"));
    btn.type = "button";
    btn.addEventListener("click", () => show(activeMode, true));
    block.appendChild(btn);

    content.appendChild(block);
  }


  // -------------------------------------------------  Chargement depuis l'API

  async function show(modeOverride, refresh) {
    const readyMode = modeOverride || activeMode;
    if (MODES[readyMode]) activeMode = readyMode;

    syncModeButtons();
    setLoading(i18nT("stats.loading", null, "Chargement de vos statistiques…"));

    // Réaffichage en mémoire après un changement de langue (aucune requête) :
    // si les données sont déjà là et qu'on n'a pas demandé explicitement un
    // rafraîchissement réseau, on redessine simplement avec la langue courante.
    if (cachedData && !refresh) {
      renderData(cachedData);
      return;
    }

    // Annule toute requête encore en vol (navigation/mode précédent).
    if (currentFetch && currentFetch.abort) currentFetch.abort();
    currentFetch = typeof AbortController !== "undefined"
      ? new AbortController()
      : { signal: undefined, abort() {} };

    try {
      const res = await (async (signal) => {
        const r = await fetch(
          API_BASE + "?action=stats&mode=" + encodeURIComponent(readyMode),
          { method: "GET", credentials: "same-origin", signal: signal || undefined }
        );
        const body = await r.json().catch(() => ({}));
        return {
          ok: r.status >= 200 && r.status < 300 && body.ok === true,
          status: r.status,
          data: body.data || null,
          error: body.error || (r.status === 401 ? i18nT("error.authRequired", null, "Authentification requise.") : ""),
        };
      })(currentFetch.signal);

      currentFetch = null;

      if (res.status === 401) {
        // Session expirée : délégation à la gestion de compte (retour connexion).
        if (typeof sessionTimeoutHandler === "function") sessionTimeoutHandler();
        return;
      }
      if (res.status === 0) {
        showError(i18nT("stats.networkError", null, "Erreur réseau"),
          i18nT("stats.networkErrorText", null, "Impossible de joindre le serveur. Vérifiez votre connexion puis réessayez."));
        return;
      }
      if (!res.ok) {
        showError(i18nT("stats.errorTitle", null, "Impossible de charger les statistiques"),
          res.error || i18nT("stats.serverError", null, "Le serveur a renvoyé une erreur."));
        return;
      }
      cachedData = res.data || {};
      renderData(cachedData);
    } catch (err) {
      currentFetch = null;
      if (err && (err.name === "AbortError" || err.name === "AbortSignal")) return;
      showError(i18nT("stats.networkError", null, "Erreur réseau"),
        i18nT("stats.networkErrorText", null, "Impossible de joindre le serveur. Vérifiez votre connexion puis réessayez."));
    }
  }

  function hide() {
    destroyCharts();
    if (currentFetch && currentFetch.abort) currentFetch.abort();
    currentFetch = null;
  }

  // ---------------------------------------------------------- Sélecteur de mode

  function syncModeButtons() {
    document.querySelectorAll("[data-stats-mode]").forEach((btn) => {
      const on = btn.dataset.statsMode === activeMode;
      btn.classList.toggle("is-active", on);
      btn.setAttribute("aria-pressed", String(on));
    });
  }

  function bindEvents() {
    document.addEventListener("click", (event) => {
      const modeBtn = event.target.closest("[data-stats-mode]");
      if (!modeBtn) return;
      const mode = modeBtn.dataset.statsMode;
      if (!MODES[mode] || mode === activeMode) return;
      activeMode = mode;
      show(mode);
    });
  }

  // ---------------------------------------------------------------- Démarrage

  document.addEventListener("DOMContentLoaded", () => {
    bindEvents();

    // v12.6-B3.3 — Actualisation immédiate des statistiques lors d'un changement
    // de langue : on réaffirme l'écran affiché à partir des données EN MÉMOIRE
    // (aucune requête réseau superflue ; le réaffichage redessine aussi les
    // graphiques Chart.js, les légendes, les infobulles et les catégories de
    // difficulté avec la langue courante). Si l'écran n'est pas actif ou si
    // aucune donnée n'est en mémoire, on ne fait rien : la langue sera prise en
    // compte au prochain chargement.
    if (window.I18N && typeof window.I18N.onLocaleChange === "function") {
      window.I18N.onLocaleChange(() => {
        const screen = document.getElementById("statsScreen");
        if (screen && screen.classList.contains("active") && cachedData) {
          renderModeSelectorLabels();
          show(activeMode);
        }
      });
    }
  });

  /** Réapplique les libellés statiques du sélecteur de mode (data-i18n). */
  function renderModeSelectorLabels() {
    document.querySelectorAll("[data-stats-mode]").forEach((btn) => {
      const key = btn.getAttribute("data-i18n");
      if (key && window.I18N && typeof window.I18N.t === "function") {
        btn.textContent = window.I18N.t(key);
      }
    });
    const fs = document.querySelector(".stats-mode-select");
    if (fs && window.I18N && typeof window.I18N.t === "function") {
      const akey = fs.getAttribute("data-i18n-aria-label");
      if (akey) fs.setAttribute("aria-label", window.I18N.t(akey));
    }
  }

  return {
    show,
    hide,
    /** Enregistre le gestionnaire de session expirée (fourni par account.js). */
    setSessionHandler(fn) {
      sessionTimeoutHandler = fn;
    },
    /** Aides pures exposées pour les tests JXA (v12.6-B3.3). */
    __test: {
      formatDiff,
      attemptsLabel,
      modeLabel,
      formatDay,
      fmtAvg,
      decimalSeparator,
      statsLocale,
      sortedDifficultyList,
      difficultyLabels,
      DIFF_STATUS_ORDER,
      dailyLabelForIndex,
    },
  };
})();

if (typeof window !== "undefined") {
  window.StatsUI = StatsUI;
}

