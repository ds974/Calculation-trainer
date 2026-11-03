"use strict";

// Les clés v10 et v11 sont volontairement conservées pour garder les paramètres
// et les scores déjà enregistrés lors du passage à la v10b puis à la v11.
// Les clés v11 supportent les modes Multiplications et Additions.
const STORAGE = {
  config: "multiplicationTrainer.config.v11",
  scores: "multiplicationTrainer.scores.v11",
  legacyConfig: "multiplicationTrainer.config.v10",
  legacyScores: "multiplicationTrainer.scores.v10",
  legacyTables: "tables",
  legacyTime: "timeLimit",
  oldLegacyScores: "scores"
};

// MODES centralise les opérations : le symbole d'affichage, le libellé et le calcul.
// Toute nouvelle opération (soustraction, division…) s'ajoutera ici.
const MODES = {
  mult: {
    key: "mult",
    label: "Multiplications",
    symbol: "×",
    compute: (a, b) => a * b
  },
  add: {
    key: "add",
    label: "Additions",
    symbol: "+",
    compute: (a, b) => a + b
  }
};

const QUESTION_COUNT = 10;

// Durée (ms) d'affichage de la correction pédagogique après une réponse
// incorrecte ou un temps écoulé (v12.3). La transition reste brève (700 ms)
// après une bonne réponse, où aucune correction n'est nécessaire.
const QUESTION_CORRECTION_MS = 4000;

// QUESTION_TYPES centralise les trois types de questions (v12.3) : le libellé
// d'affichage et la valeur interne. Toute nouvelle forme de question s'ajoutera ici.
const QUESTION_TYPES = {
  classic: {
    key: "classic",
    label: "Classique"
  },
  hole: {
    key: "hole",
    label: "À trou"
  },
  mixed: {
    key: "mixed",
    label: "Mélange"
  }
};

const DEFAULT_CONFIG = {
  mode: "mult",
  questionType: "classic",
  timePerQuestion: 5,
  // v12.5 — entraînement adaptatif activé par défaut. Les anciennes configs
  // (sans cette propriété) sont considérées comme activées : on retombe ici.
  adaptive: true,
  mult: { tables: [2,3,4,5,6,7,8,9] },
  add: { min: 1, max: 20 }
};

const state = {
  config: loadConfig(),
  questions: [],
  currentIndex: 0,
  score: 0,
  results: [],
  questionStart: 0,
  countdownInterval: null,
  timeoutHandle: null,
  questionLocked: false,
  finalScore: null,
  savedCurrentResult: false,
  finalSavePromise: null,
  launchInProgress: false,
  missionId: null
};

// --- v12.8-B4.2 — État de l'écran des classements (partagé + local). ---
// `view` : "shared" (classement partagé serveur, affichage principal)
//          ou "local" (tableau des scores du navigateur, inchangé).
// `mode` : mode interne JS ("mult" | "add") du classement courant.
// `schoolLevel` / `questionType` : filtres du classement partagé, conservés
//          lors d'un changement de langue ou de mode.
// `requestId` : compteur anti-réponses obsolètes (une vieille réponse réseau ne
//          remplace jamais la requête la plus récente).
const leaderboardState = {
  view: "shared",
  mode: state.config.mode === "add" ? "add" : "mult",
  schoolLevel: "unspecified",
  questionType: "classic",
  requestId: 0,
};

/** Convertit le mode interne JS vers l'identifiant API du classement partagé. */
function leaderboardApiMode(mode) {
  return mode === "add" ? "addition" : "multiplication";
}

/** Paramètres d'appel du endpoint `leaderboard` (GET public, sans CSRF). */
function leaderboardApiParams() {
  return {
    mode: leaderboardApiMode(leaderboardState.mode),
    school_level: leaderboardState.schoolLevel,
    question_type: leaderboardState.questionType,
    limit: 20,
  };
}

/** Niveau scolaire déclaré du compte courant (ou null en mode invité). */
function currentUserSchoolLevel() {
  const gh = (typeof window !== "undefined" && typeof window.MissionGuestHistory !== "undefined")
    ? window.MissionGuestHistory
    : null;
  const u = (gh && gh.currentUser) ? gh.currentUser : null;
  return u && u.school_level ? String(u.school_level) : null;
}

/**
 * Niveau filtrant par défaut du classement partagé :
 * - compte connecté avec niveau déclaré -> son niveau scolaire (historique) ;
 * - compte connecté sans niveau déclarée, ou invité -> "unspecified".
 * `all` n'est jamais choisi automatiquement.
 */
function defaultLeaderboardLevel() {
  const level = currentUserSchoolLevel();
  return level || "unspecified";
}

document.addEventListener("DOMContentLoaded", init);

function init() {
  migrateScoresIfNeeded();
  buildConfigControls();
  bindActions();
  bindAnswerInput();
  bindNumericKeypad();
  resetRocket();
  // v12.6-B3.1 — régénère tous les textes dynamiques quand la langue change
  // (titre d'accueil, paramètres, classements, rapport de mission), sans
  // jamais relancer une mission ni toucher aux données de la partie en cours.
  if (window.I18N && window.I18N.onLocaleChange) {
    window.I18N.onLocaleChange(() => refreshI18n());
  }
  refreshI18n();
  showScreen("homeScreen");
}

/**
 * v12.6-B3.1 — Re-rend les textes dynamiques dans la langue courante après un
 * changement de langue. Les éléments purement statiques sont déjà traduits par
 * le moteur (attributs data-i18n) ; seuls les textes générés par app.js sont ici
 * régénérés, en fonction de l'écran actif.
 */
function refreshI18n() {
  updateHomeTitle();

  // Paramètres : rebaptise les cases « Table de N » sans perdre la sélection.
  document.querySelectorAll("#tableCheckboxes .table-option span").forEach((labelEl) => {
    const input = labelEl.parentElement && labelEl.parentElement.querySelector("input[type='checkbox']");
    if (input) {
      labelEl.textContent = i18nT("config.tableTitle", { table: input.value }, `Table de ${input.value}`);
    }
  });

  // Si un avertissement est affiché, on le régénère dans la langue courante.
  const warning = document.getElementById("tableWarning");
  if (warning && warning.textContent) {
    warning.textContent = validateQuestionPool() || "";
  }

  // Classement du menu (B4.2) : retraduit les libellés dynamiques et ré-affiche
  // le tableau courant, sans réinitialiser les filtres sélectionnés.
  const leaderboardScreen = document.getElementById("leaderboardScreen");
  if (leaderboardScreen && leaderboardScreen.classList.contains("active")) {
    renderLeaderboardHeadline();
    // Selon la vue active, on rafraîchit l'état sans perdre les sélections.
    if (leaderboardState.view === "shared") {
      renderSharedLeaderboardState();
    } else {
      switchLeaderboardMode(leaderboardState.mode);
    }
  }

  // Rapport de mission (sans toucher à la progression ni aux réponses saisies).
  const resultScreen = document.getElementById("resultScreen");
  if (resultScreen && resultScreen.classList.contains("active") && state.finalScore) {
    renderResultContent();
  }
}

function bindActions() {
  document.addEventListener("click", (event) => {
    // Changement d'onglet du classement (indépendant des boutons d'action).
    const modeTab = event.target.closest("[data-leaderboard-mode]");
    if (modeTab) {
      switchLeaderboardMode(modeTab.dataset.leaderboardMode);
      return;
    }

    // Bascule Classement partagé / Scores locaux.
    const viewBtn = event.target.closest("[data-leaderboard-view]");
    if (viewBtn) {
      switchLeaderboardView(viewBtn.dataset.leaderboardView);
      return;
    }

    const button = event.target.closest("[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    if (action === "start") startMission();
    if (action === "config") showConfig();
    if (action === "leaderboard") showLeaderboard();
    if (action === "retry-leaderboard") retrySharedLeaderboard();
    if (action === "home") {
      // En quittant l'écran, la prochaine ouverture recalcule le filtre par
      // défaut selon le compte courant (B4.2). Aucun appel réseau n'est lancé.
      showScreen("homeScreen");
    }
    if (action === "restart") saveThen(() => startMission());
    if (action === "save-home") saveThen(() => showScreen("homeScreen"));
  });

  // --- Filtres du classement partagé (B4.2). ---
  const levelSelect = document.getElementById("sharedLeaderboardLevel");
  if (levelSelect) {
    levelSelect.addEventListener("change", () => {
      leaderboardState.schoolLevel = levelSelect.value;
      loadSharedLeaderboard();
    });
  }
  const typeSelect = document.getElementById("sharedLeaderboardType");
  if (typeSelect) {
    typeSelect.addEventListener("change", () => {
      leaderboardState.questionType = typeSelect.value;
      loadSharedLeaderboard();
    });
  }
}

// --- Opérations centralisées ---
// Ces fonctions sont les SEULES à connaître le calcul et le symbole d'une opération.
// Le mode est attaché à chaque question, garantissant la cohérence même si l'utilisateur
// change de mode en cours de partie.
function computeAnswer(q) {
  const mode = MODES[q.mode] || MODES[DEFAULT_CONFIG.mode];
  return mode.compute(q.a, q.b);
}

/**
 * Réponse attendue pour une question, indépendamment de la position du trou (v12.3).
 *  - question classique : le résultat du calcul  a (symbole) b = ? ;
 *  - trou en première position (? (symbole) b = résultat) : la réponse est `a` ;
 *  - trou en deuxième position (a (symbole) ? = résultat) : la réponse est `b`.
 */
function questionAnswer(q) {
  if (q && q.hole === "a") return q.a;
  if (q && q.hole === "b") return q.b;
  return computeAnswer(q);
}

/**
 * Texte affiché pour une question, selon que l'opérande manquant se trouve en
 * première ou deuxième position, ou qu'il s'agisse d'une question classique.
 */
function questionDisplay(q) {
  const symbol = operatorSymbol(q.mode);
  if (q.hole === "a") return `? ${symbol} ${q.b} = ${computeAnswer(q)}`;
  if (q.hole === "b") return `${q.a} ${symbol} ? = ${computeAnswer(q)}`;
  return `${q.a} ${symbol} ${q.b} = ?`;
}

/**
 * HTML de l'équation corrigée, affichée DANS la zone de question pendant la
 * correction (v12.3). La bonne réponse remplace visuellement le « ? » à son
 * emplacement exact — quel que soit le type de question — et est rendue en rouge
 * via la classe « answer-reveal » (qui ajoute aussi un signal non chromatique).
 *
 *  - classique : `3 × 6 = ?`  -> `3 × 6 = <span class="answer-reveal">18</span>`
 *  - trou (a)  : `? × 6 = 18` -> `<span class="answer-reveal">3</span> × 6 = 18`
 *  - trou (b)  : `3 × ? = 18` -> `3 × <span class="answer-reveal">6</span> = 18`
 *
 * La bonne réponse n'apparaît qu'une seule fois (dans l'équation) : le message
 * de retour (feedback) ne la répète pas. Fonction PURE (aucun accès au DOM),
 * donc facilement testable.
 */
function questionCorrectionHTML(q) {
  const symbol = operatorSymbol(q.mode);
  const answer = computeAnswer(q);
  // Le libellé d'accessibilité est traduit ; la valeur (calculée, non saisie
  // par l'utilisateur) est interpolée en toute sécurité dans cet HTML.
  const revealLabel = i18nT("feedback.answerReveal", null, "réponse : {value}");
  const reveal = (v) => `<span class="answer-reveal" aria-label="${revealLabel.replace("{value}", v)}">${v}</span>`;
  if (q.hole === "a") return `${reveal(q.a)} ${symbol} ${q.b} = ${answer}`;
  if (q.hole === "b") return `${q.a} ${symbol} ${reveal(q.b)} = ${answer}`;
  return `${q.a} ${symbol} ${q.b} = ${reveal(answer)}`;
}

function operatorSymbol(modeKey = state.config.mode) {
  const mode = MODES[modeKey] || MODES[DEFAULT_CONFIG.mode];
  return mode.symbol;
}

function modeLabel(modeKey = state.config.mode) {
  const mode = MODES[modeKey] || MODES[DEFAULT_CONFIG.mode];
  return i18nT(mode.key === "add" ? "config.modeAddition" : "config.modeMultiplication", null, mode.label);
}

// ---- v12.6-B3.1 — Accès au moteur i18n (repli français tant que le moteur
// n'est pas prêt, afin de ne jamais exposer une clé technique à l'écran). ----
function i18nReady() {
  const I = window.I18N;
  return !!(I && I.isReady && I.isReady());
}
function i18nT(key, vars, fallback) {
  const I = window.I18N;
  if (I && typeof I.t === "function") return I.t(key, vars);
  return fallback;
}
function i18nPl(baseKey, count, vars, fallback) {
  const I = window.I18N;
  if (I && typeof I.pl === "function") return I.pl(baseKey, count, vars);
  return fallback;
}

// Libellé traduit d'un type de question (classique / à trou / mélange).
function questionTypeLabel(type) {
  const key = type === "hole" ? "config.questionTypeHole"
    : type === "mixed" ? "config.questionTypeMixed"
    : "config.questionTypeClassic";
  return i18nT(key, null, (QUESTION_TYPES[type] || {}).label || type);
}

function bindAnswerInput() {
  const answer = document.getElementById("answer");

  answer.addEventListener("input", () => {
    if (state.questionLocked || state.currentIndex >= state.questions.length) return;
    const value = answer.value.trim();
    if (value === "") return;

    const q = state.questions[state.currentIndex];
    if (Number(value) === questionAnswer(q)) {
      finishQuestion(true, Number(value));
    }
  });

  // Le clavier physique reste utilisable sur ordinateur.
  answer.addEventListener("keydown", (event) => {
    if (state.questionLocked) return;

    if (event.key === "Enter") {
      const value = answer.value.trim();
      if (value === "") return;
      const q = state.questions[state.currentIndex];
      const numericValue = Number(value);
      if (numericValue !== questionAnswer(q)) finishQuestion(false, numericValue);
      return;
    }

    const allowedControlKeys = ["Backspace", "Delete", "Tab", "ArrowLeft", "ArrowRight", "Home", "End"];
    if (/^\d$/.test(event.key) || allowedControlKeys.includes(event.key)) return;
    if (event.ctrlKey || event.metaKey) return;
    event.preventDefault();
  });
}


function bindNumericKeypad() {
  const keypad = document.getElementById("numericKeypad");
  if (!keypad) return;

  keypad.addEventListener("click", (event) => {
    const keyButton = event.target.closest("[data-key]");
    if (!keyButton || state.questionLocked) return;

    const answer = document.getElementById("answer");
    const key = keyButton.dataset.key;

    if (key === "clear") {
      answer.value = "";
    } else if (key === "backspace") {
      answer.value = answer.value.slice(0, -1);
    } else if (/^\d$/.test(key)) {
      answer.value += key;
    }

    answer.dispatchEvent(new Event("input", { bubbles: true }));
    answer.focus({ preventScroll: true });
  });
}

function showScreen(screenId) {
  clearQuestionTimers();
  document.querySelectorAll(".screen").forEach((screen) => {
    screen.classList.toggle("active", screen.id === screenId);
  });
  // Le panneau de navigation supérieur est masqué pendant une mission de calcul.
  updateAccountPanelVisibility();
}

/**
 * Affiche / masque le panneau de navigation supérieur (v12.2).
 * – Masqué pendant une mission (l'écran de jeu est actif) pour ne pas
 *   perturber l'exercice.
 * – Visible sur tous les autres écrans (accueil, paramètres, scores,
 *   compte, statistiques, administration), y compris au défilement
 *   grâce au positionnement sticky défini dans style.css.
 */
function updateAccountPanelVisibility() {
  const panel = document.getElementById("accountNavBar");
  if (!panel) return;
  const game = document.getElementById("gameScreen");
  const gameActive = !!game && game.classList.contains("active");
  panel.classList.toggle("is-hidden", gameActive);
}

function showConfig() {
  syncConfigControls();
  showScreen("configScreen");
}

function showLeaderboard() {
  // B4.2 — À chaque ouverture (nouvelle visite), on applique le filtre par
  // défaut du compte courant, puis on affiche le classement partagé en premier.
  resetLeaderboardDefaultFilters();
  syncLeaderboardFilterControls();
  switchLeaderboardMode(leaderboardState.mode);
  renderLeaderboardHeadline();
  showScreen("leaderboardScreen");
  renderLeaderboardView();
}

function buildConfigControls() {
  // Sélecteur de mode (Multiplications / Additions)
  document.querySelectorAll("[data-mode-option]").forEach((radio) => {
    radio.checked = radio.value === state.config.mode;
    radio.addEventListener("change", handleModeChange);
  });

  // v12.3 — sélecteur du type de questions (Classique / À trou / Mélange).
  document.querySelectorAll("[data-question-type-option]").forEach((radio) => {
    radio.checked = radio.value === state.config.questionType;
    radio.addEventListener("change", handleQuestionTypeChange);
  });

  // v12.5 — entraînement adaptatif (case à cocher).
  const adaptiveBox = document.querySelector("[data-adaptive-option]");
  if (adaptiveBox) {
    adaptiveBox.checked = state.config.adaptive === true;
    adaptiveBox.addEventListener("change", handleAdaptiveChange);
  }

  buildTableCheckboxes();
  buildRangeInputs();

  const timeLimit = document.getElementById("timeLimit");
  timeLimit.value = String(state.config.timePerQuestion);
  timeLimit.addEventListener("change", handleTimeChange);
  timeLimit.addEventListener("blur", handleTimeChange);

  applyConfigVisibility();
}

function buildTableCheckboxes() {
  const container = document.getElementById("tableCheckboxes");
  container.innerHTML = "";

  for (let table = 1; table <= 10; table++) {
    const label = document.createElement("label");
    label.className = "table-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(table);
    checkbox.checked = state.config.mult.tables.includes(table);
    checkbox.addEventListener("change", handleTableChange);

    const text = document.createElement("span");
    text.textContent = i18nT("config.tableTitle", { table }, `Table de ${table}`);

    label.append(checkbox, text);
    container.appendChild(label);
  }
}

function buildRangeInputs() {
  const minInput = document.getElementById("addMin");
  const maxInput = document.getElementById("addMax");
  if (!minInput || !maxInput) return;

  minInput.value = String(state.config.add.min);
  maxInput.value = String(state.config.add.max);
  minInput.addEventListener("change", handleRangeChange);
  minInput.addEventListener("blur", handleRangeChange);
  maxInput.addEventListener("change", handleRangeChange);
  maxInput.addEventListener("blur", handleRangeChange);
}

function syncConfigControls() {
  document.querySelectorAll("[data-mode-option]").forEach((radio) => {
    radio.checked = radio.value === state.config.mode;
  });
  document.querySelectorAll("[data-question-type-option]").forEach((radio) => {
    radio.checked = radio.value === state.config.questionType;
  });
  const adaptiveBox = document.querySelector("[data-adaptive-option]");
  if (adaptiveBox) adaptiveBox.checked = state.config.adaptive === true;
  document.querySelectorAll("#tableCheckboxes input[type='checkbox']").forEach((checkbox) => {
    checkbox.checked = state.config.mult.tables.includes(Number(checkbox.value));
  });
  const minInput = document.getElementById("addMin");
  const maxInput = document.getElementById("addMax");
  if (minInput) minInput.value = String(state.config.add.min);
  if (maxInput) maxInput.value = String(state.config.add.max);
  document.getElementById("timeLimit").value = String(state.config.timePerQuestion);
  applyConfigVisibility();
}

function applyConfigVisibility() {
  const isMult = state.config.mode === "mult";
  const multBlock = document.getElementById("multConfigBlock");
  const addBlock = document.getElementById("addConfigBlock");
  if (multBlock) multBlock.hidden = !isMult;
  if (addBlock) addBlock.hidden = isMult;
}

function handleModeChange(event) {
  state.config.mode = event.target.value;
  saveConfig();
  syncConfigControls();
  updateHomeTitle();
}

// v12.3 — mise à jour du type de questions (classique / à trou / mélange).
function handleQuestionTypeChange(event) {
  const value = event.target.value;
  if (!QUESTION_TYPES[value]) return;
  state.config.questionType = value;
  saveConfig();
  syncConfigControls();
}

// v12.5 — bascule de l'entraînement adaptatif. La préférence est persistée
// comme toutes les autres options, dans localStorage.
function handleAdaptiveChange(event) {
  state.config.adaptive = event.target.checked === true;
  saveConfig();
}

// Met à jour le titre de l'accueil et la description selon le mode choisi.
function updateHomeTitle() {
  const I = window.I18N;
  const mode = state.config.mode;
  const title = document.getElementById("homeTitle");
  const subtitle = document.getElementById("homeSubtitle");
  // Comportement inchangé si le moteur i18n n'est pas prêt (repli français).
  if (I && I.isReady && I.isReady()) {
    if (title) title.textContent = I.t("home.title");
    if (subtitle) {
      subtitle.textContent = I.t(mode === "add" ? "home.subtitleAddition" : "home.subtitleMultiplication");
    }
  } else {
    if (title) title.textContent = `Mission ${modeLabel()}`;
    if (subtitle) {
      subtitle.textContent = mode === "add"
        ? "10 additions, un chrono et une fusée à construire."
        : "10 calculs, un chrono et une fusée à construire.";
    }
  }
}

function handleTableChange() {
  const checked = [...document.querySelectorAll("#tableCheckboxes input:checked")]
    .map((input) => Number(input.value))
    .sort((a, b) => a - b);

  state.config.mult.tables = checked;
  saveConfig();
}

function handleRangeChange() {
  const minInput = document.getElementById("addMin");
  const maxInput = document.getElementById("addMax");
  let min = Number(minInput.value);
  let max = Number(maxInput.value);
  if (!Number.isInteger(min)) min = DEFAULT_CONFIG.add.min;
  if (!Number.isInteger(max)) max = DEFAULT_CONFIG.add.max;
  min = Math.min(99, Math.max(1, min));
  max = Math.min(99, Math.max(1, max));
  if (min > max) [min, max] = [max, min];
  minInput.value = String(min);
  maxInput.value = String(max);
  state.config.add.min = min;
  state.config.add.max = max;
  saveConfig();
}

function handleTimeChange() {
  const input = document.getElementById("timeLimit");
  let value = Number(input.value);
  if (!Number.isFinite(value)) value = DEFAULT_CONFIG.timePerQuestion;
  value = Math.min(60, Math.max(1, Math.round(value * 10) / 10));
  input.value = String(value);
  state.config.timePerQuestion = value;
  saveConfig();
}

function startMission() {
  clearQuestionTimers();
  const generationError = validateQuestionPool();
  if (generationError) {
    // Le message s'affiche dans la zone d'avertissement des paramètres.
    const warning = document.getElementById("tableWarning");
    if (warning) {
      warning.textContent = generationError;
      warning.scrollIntoView({ behavior: "smooth", block: "nearest" });
    }
    showScreen("configScreen");
    return;
  }
  // v12.5 — Étape 2C : intégration de l'entraînement adaptatif.
  // Le démarrage est asynchrone (il peut attendre la réponse de
  // `difficulty/operations`). Un verrou interne empêche tout double lancement
  // pendant le chargement des difficultés.
  if (state.launchInProgress) return;
  state.launchInProgress = true;
  generateMissionQuestions().then((questions) => {
    state.launchInProgress = false;
    state.questions = questions;
    state.currentIndex = 0;
    state.score = 0;
    state.results = [];
    state.finalScore = null;
    state.savedCurrentResult = false;
    state.finalSavePromise = null;
    // v12.4 : identifiant stable et unique de LA mission. Conservé lors des
    // tentatives de sauvegarde répétées ; le serveur s'en sert pour garantir
    // l'idempotence (une seule écriture par mission_id).
    if (window.MissionGuestHistory && typeof window.MissionGuestHistory.makeMissionId === "function") {
      state.missionId = window.MissionGuestHistory.makeMissionId();
    } else {
      state.missionId = null;
    }

    document.getElementById("playerName").value = "";
    document.getElementById("nameWarning").textContent = "";
    document.getElementById("missionReward").textContent = "";
    // Le bloc « Prénom » est de nouveau visible au départ d'une mission : sa
    // visibilité sera ajustée à la fin selon que l'on est connecté ou invité.
    const nameBlock = document.querySelector(".name-block");
    if (nameBlock) nameBlock.hidden = false;
    const saveStatus = document.getElementById("saveStatus");
    if (saveStatus) {
      saveStatus.hidden = true;
      saveStatus.textContent = "";
      saveStatus.className = "inline-message save-status";
    }
    resetRocket();
    showScreen("gameScreen");
    presentQuestion();
  });
}

/**
 * v12.5 — Produit la liste des questions de la mission, en appliquant
 * l'entraînement adaptatif lorsque les conditions sont réunies, sinon le
 * générateur ordinaire existant.
 *
 * Conditions de l'adaptatif (v12.5, étape 2C) :
 *  - utilisateur connecté (une mémoire personnelle existe) ;
 *  - option « M'entraîner sur mes difficultés » activée ;
 *  - moteur `AdaptiveGenerator` chargé (fichier adaptive-generator.js).
 *
 * Dans ce cas on interroge UNE SEULE FOIS `difficulty/operations` avec les
 * filtres correspondant aux paramètres réels de la mission, on attend la
 * réponse, puis on confie le pool ordinaire complet + les difficultés au moteur.
 * Un repli propre vers le générateur ordinaire est garanti en cas
 * d'indisponibilité de l'API ou d'absence de difficultés compatibles. Une
 * véritable erreur de programmation du moteur n'est PAS masquée silencieusement
 * (elle se propage).
 *
 * @return {Promise<Array<{a,b,mode,hole}>>}
 */
async function generateMissionQuestions() {
  const ordinary = () => generateUniqueQuestions();

  if (!isConnected()) return ordinary();
  if (state.config.adaptive !== true) return ordinary();
  if (typeof window.AdaptiveGenerator === "undefined" ||
      typeof window.AdaptiveGenerator.adaptiveGenerateQuestions !== "function") {
    return ordinary();
  }

  // Récupération des difficultés (filtres = paramètres réels de la mission).
  const difficulties = await fetchDifficulties();
  if (!difficulties) return ordinary();

  // Pool ORDINAIRE complet réutilisé (source unique de vérité des calculs).
  const normalPool = buildQuestionPool();
  const result = window.AdaptiveGenerator.adaptiveGenerateQuestions(
    normalPool,
    difficulties,
    {
      mode: state.config.mode,
      questionType: state.config.questionType,
      mult: { tables: state.config.mult.tables },
      add: { min: state.config.add.min, max: state.config.add.max }
    }
  );

  // Le moteur renvoie null lorsque l'adaptation ne s'applique pas (aucune
  // difficulté compatible, ou désactivée) : on conserve le comportement actuel.
  return result || ordinary();
}

/**
 * v12.5 — Interroge `difficulty/operations` avec les filtres correspondant aux
 * paramètres réels de la mission. Renvoie le tableau des opérations difficiles,
 * ou `null` en cas d'indisponibilité de l'API (repli propre vers la mission
 * ordinaire, sans bloquer l'élève ni masquer une erreur de programmation).
 *
 * @return {Promise<Array|null>}
 */
async function fetchDifficulties() {
  try {
    // Délégation à AccountUI.api (GET), déjà chargé par account.js.
    if (typeof window.AccountUI === "undefined" || typeof window.AccountUI.api !== "function") {
      return null;
    }
    const params = difficultyFilters();
    const res = await window.AccountUI.api("difficulty/operations", params, "GET");
    if (!res.ok) return null;
    return Array.isArray(res.data && res.data.operations) ? res.data.operations : [];
  } catch (_e) {
    // Indisponibilité réseau / API : repli ordinaire. Un éventuel problème de
    // programmation se manifesterait ailleurs (fonctions appelées plus haut).
    return null;
  }
}

/**
 * v12.5 — Filtres transmis à `difficulty/operations`, alignés sur les valeurs
 * du serveur (`multiplication`/`addition`, `classic`/`hole`/`mixed`, tables,
 * plage d'additions) et les paramètres réels de la mission.
 */
function difficultyFilters() {
  const filters = {};
  const mode = state.config.mode;
  filters.mode = mode === "add" ? "addition" : "multiplication";
  // "mixed" signifie « les deux » (classic ET hole) côté serveur, cohérent.
  filters["question_type"] = state.config.questionType;
  if (mode === "mult") {
    filters.tables = state.config.mult.tables.join(",");
  } else {
    filters.add_min = String(state.config.add.min);
    filters.add_max = String(state.config.add.max);
  }
  return filters;
}

// Nombre de calculs distincts (sans doublons commutatifs) disponibles selon le mode courant.
function poolSize() {
  if (state.config.mode === "add") {
    const { min, max } = state.config.add;
    const count = max - min + 1;
    if (count <= 0) return 0;
    // Couples {a,b} avec min ≤ a ≤ b ≤ max : doubles autorisés (a,a) mais pas d'ordre doublon.
    return (count * (count + 1)) / 2;
  }
  // Multiplication : produit cartésien des tables cochées.
  return state.config.mult.tables.length * state.config.mult.tables.length;
}

function validateQuestionPool() {
  if (state.config.mode === "mult") {
    if (state.config.mult.tables.length * state.config.mult.tables.length < QUESTION_COUNT) {
      return i18nT("mission.rangeWarning", null, "Sélectionnez au moins 4 tables pour obtenir 10 calculs différents.");
    }
    return null;
  }
  // Addition : la plage doit permettre au moins 10 calculs distincts.
  const size = poolSize();
  if (size < QUESTION_COUNT) {
    const { min, max } = state.config.add;
    const fallback = size > 1
      ? `La plage ${min} à ${max} ne permet que ${size} calculs différents. Élargissez la plage pour obtenir 10 calculs.`
      : `La plage ${min} à ${max} ne permet qu’un calcul différent. Élargissez la plage pour obtenir 10 calculs.`;
    return i18nReady()
      ? i18nPl("mission.rangeTooSmall", size, { min, max }, fallback)
      : fallback;
  }
  return null;
}

function generateUniqueQuestions() {
  const questionType = state.config.questionType;
  const pool = buildQuestionPool();
  // Fisher-Yates : chaque couple n'apparaît qu'une seule fois dans la mission.
  shuffleArray(pool);
  const selected = pool.slice(0, QUESTION_COUNT);

  // Répartition des trous selon le type de questions (v12.3).
  //  - classique : aucune question à trou ;
  //  - à trou     : toutes les questions ont un trou (position aléatoire) ;
  //  - mélange    : répartition équilibrée classique/à-trou (au plus un écart si impair),
  //                 position du trou aléatoire pour les questions à trou.
  if (questionType === "hole") {
    selected.forEach((q) => {
      q.hole = Math.random() < 0.5 ? "a" : "b";
    });
    return selected;
  }

  if (questionType === "mixed") {
    const half = Math.round(QUESTION_COUNT / 2);
    const holeCount = half; // 10 questions => 5 à trou, 5 classiques (écart 0)
    let placedHoles = 0;
    while (placedHoles < holeCount && placedHoles < selected.length) {
      const idx = Math.floor(Math.random() * selected.length);
      if (selected[idx].hole) continue;
      selected[idx].hole = Math.random() < 0.5 ? "a" : "b";
      placedHoles++;
    }
    return selected;
  }

  // classique (défaut) : aucune question à trou.
  return selected;
}

/**
 * v12.5 — Construit le pool ORDINAIRE complet (toutes les paires {a, b, mode}
 * uniques, sans doublon commutatif) selon les paramètres courants.
 *
 * Réutilisée à la fois par le générateur ordinaire (generateUniqueQuestions) et
 * par l'entraînement adaptatif (qui doit disposer de la TOTALITÉ du pool pour
 * sélectionner ses questions ciblées). Il s'agit de la SEULE source de vérité
 * pour la création des calculs : on ne développe pas un second moteur.
 */
function buildQuestionPool() {
  const mode = state.config.mode;
  let pool = [];

  if (mode === "add") {
    const { min, max } = state.config.add;
    for (let a = min; a <= max; a++) {
      for (let b = a; b <= max; b++) {
        pool.push({ a, b, mode });
      }
    }
  } else {
    // Multiplication : produit cartésien des tables cochées, sans duplication
    // commutative (6×7 et 7×6) — on ne retient que les couples où a <= b.
    const tables = state.config.mult.tables;
    for (const a of tables) {
      for (const b of tables) {
        if (a <= b) {
          pool.push({ a, b, mode });
        }
      }
    }
  }
  return pool;
}

function shuffleArray(array) {
  for (let i = array.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [array[i], array[j]] = [array[j], array[i]];
  }
}

function presentQuestion() {
  if (state.currentIndex >= state.questions.length) {
    endMission();
    return;
  }

  state.questionLocked = false;
  const q = state.questions[state.currentIndex];
  const answer = document.getElementById("answer");
  const feedback = document.getElementById("feedback");

  document.getElementById("progressText").textContent = i18nReady()
    ? i18nT("mission.questionProgress", { n: state.currentIndex + 1, total: QUESTION_COUNT })
    : `Question ${state.currentIndex + 1} / ${QUESTION_COUNT}`;
  document.getElementById("missionProgressBar").style.width = `${((state.currentIndex + 1) / 10) * 100}%`;
  document.getElementById("question").textContent = questionDisplay(q);
  answer.value = "";
  answer.disabled = false;
  feedback.textContent = "";
  feedback.className = "feedback";
  answer.focus();

  state.questionStart = performance.now();
  updateTimerDisplay();
  state.countdownInterval = setInterval(updateTimerDisplay, 50);
  state.timeoutHandle = setTimeout(
    () => finishQuestion(false, null, true),
    state.config.timePerQuestion * 1000
  );
}

function updateTimerDisplay() {
  const elapsed = (performance.now() - state.questionStart) / 1000;
  const remaining = Math.max(0, state.config.timePerQuestion - elapsed);
  const ratio = state.config.timePerQuestion > 0 ? remaining / state.config.timePerQuestion : 0;

  document.getElementById("time").textContent = remaining.toFixed(1);
  document.getElementById("timerRing").style.strokeDashoffset = String(100 * (1 - ratio));
  document.getElementById("timerWidget").classList.toggle("warning", ratio <= 0.35);
}

function finishQuestion(isCorrect, userAnswer, timedOut = false) {
  if (state.questionLocked) return;
  state.questionLocked = true;
  clearQuestionTimers();

  const q = state.questions[state.currentIndex];
  const elapsed = Math.min(
    state.config.timePerQuestion,
    (performance.now() - state.questionStart) / 1000
  );

  if (isCorrect) {
    state.score += 1;
    updateRocket(state.score);
  }

  state.results.push({
    a: q.a,
    b: q.b,
    mode: q.mode,
    hole: q.hole || null,
    correctAnswer: computeAnswer(q),
    userAnswer,
    correct: isCorrect,
    timedOut,
    time: Math.round(elapsed * 10) / 10
  });

  const answer = document.getElementById("answer");
  answer.disabled = true;

  const feedback = document.getElementById("feedback");
  const questionEl = document.getElementById("question");
  if (isCorrect) {
    // Réponse juste : pas de correction nécessaire, transition brève inchangée.
    // La bonne réponse n'est pas répétée (elle tient lieu du « ? » de l'équation).
    feedback.textContent = i18nT("mission.correct", null, "Bravo !");
    feedback.className = "feedback correct";
  } else {
    // Réponse incorrecte / temps écoulé : on remplace le « ? » de l'équation par
    // la bonne réponse (rendue en rouge) DANS la zone de question, pendant une
    // pause pédagogique de QUESTION_CORRECTION_MS ms. Le feedback n'affiche
    // qu'un message court, sans redoubler la réponse.
    questionEl.innerHTML = questionCorrectionHTML(q);
    feedback.textContent = timedOut
      ? i18nT("mission.timeout", null, "Temps écoulé")
      : i18nT("mission.incorrect", null, "Réponse incorrecte");
    feedback.className = "feedback incorrect";
  }

  // Le chronomètre et le timeout ont déjà été stoppés par clearQuestionTimers()
  // ci-dessus : la correction s'affiche sans que le compte à rebours ne tourne.
  const delay = isCorrect ? 700 : QUESTION_CORRECTION_MS;
  setTimeout(() => {
    state.currentIndex += 1;
    presentQuestion();
  }, delay);
}

function clearQuestionTimers() {
  if (state.countdownInterval !== null) {
    clearInterval(state.countdownInterval);
    state.countdownInterval = null;
  }
  if (state.timeoutHandle !== null) {
    clearTimeout(state.timeoutHandle);
    state.timeoutHandle = null;
  }
}

function resetRocket() {
  document.querySelectorAll("#rocketAssembly .rocket-piece").forEach((piece) => {
    piece.classList.remove("is-built", "piece-pop");
  });
  const zone = document.getElementById("rocketZone");
  if (zone) zone.classList.remove("is-launching");
  const count = document.getElementById("rocketPieceCount");
  if (count) count.textContent = i18nT("mission.rocketCount", { count: 0, total: QUESTION_COUNT }, `0 / ${QUESTION_COUNT}`);
  const launchMessage = document.getElementById("launchMessage");
  if (launchMessage) {
    launchMessage.textContent = "";
    launchMessage.className = "launch-message";
  }
}

function updateRocket(correctCount) {
  const piece = document.querySelector(`#rocketAssembly .rocket-piece[data-piece="${correctCount}"]`);
  if (piece) {
    piece.classList.add("is-built");
    piece.classList.remove("piece-pop");
    void piece.getBoundingClientRect();
    piece.classList.add("piece-pop");
  }
  document.getElementById("rocketPieceCount").textContent = i18nT("mission.rocketCount", { count: correctCount, total: QUESTION_COUNT }, `${correctCount} / ${QUESTION_COUNT}`);
}

function endMission() {
  clearQuestionTimers();
  if (state.score === 10 && !state.launchInProgress) {
    runPerfectLaunch(finalizeMission);
    return;
  }
  finalizeMission();
}

function runPerfectLaunch(onComplete) {
  state.launchInProgress = true;
  const message = document.getElementById("launchMessage");
  const zone = document.getElementById("rocketZone");
  const steps = ["3", "2", "1"];

  steps.forEach((text, index) => {
    setTimeout(() => {
      message.classList.remove("show");
      void message.getBoundingClientRect();
      message.textContent = text;
      message.classList.add("show");
    }, index * 350);
  });

  setTimeout(() => {
    message.classList.remove("show");
    void message.getBoundingClientRect();
    message.textContent = i18nT("mission.launch", null, "Décollage !");
    message.classList.add("show");
    zone.classList.add("is-launching");
  }, 1050);

  setTimeout(() => {
    state.launchInProgress = false;
    onComplete();
  }, 1980);
}

function finalizeMission() {
  // Le temps du classement est la somme des seuls temps de réponse.
  // Les pauses d'affichage Bravo/Faux et le décollage ne sont pas comptés.
  const totalTime = Math.round(state.results.reduce((sum, item) => sum + item.time, 0) * 10) / 10;
  const mode = state.config.mode;
  const range = mode === "add"
    ? `${state.config.add.min}–${state.config.add.max}`
    : [...state.config.mult.tables].sort((a, b) => a - b).join(", ");

  state.finalScore = {
    score: state.score,
    time: totalTime,
    mode,
    questionType: state.config.questionType,
    tables: mode === "add" ? [] : [...state.config.mult.tables].sort((a, b) => a - b),
    range: mode === "add" ? range : ""
  };

  // v12.6-B3.1 — l'affichage du rapport (score, fusée, débrief, classement) est
  // isolé dans renderResultContent() afin d'être régénéré lors d'un changement
  // de langue sans relancer la mission ni perdre les données déjà saisies.
  renderResultContent();
  showScreen("resultScreen");

  // v12.2 — fin de mission simplifiée.
  //  - Utilisateur connecté : plus de saisie de prénom ; enregistrement AUTOMATIQUE
  //    sur le compte (identité = session serveur, jamais un user_id client) avec
  //    confirmation discrète et « Réessayer » en cas d'échec (aucun doublon).
  //  - Invité : le prénom reste demandé pour le classement local (Top 20).
  const connected = isConnected();
  const nameBlock = document.querySelector(".name-block");
  const saveStatus = document.getElementById("saveStatus");

  if (connected) {
    if (nameBlock) nameBlock.hidden = true;
    if (saveStatus) saveStatus.hidden = false;
    // Sauvegarde serveur hors-UI : le résultat est enregistré sur le compte ET,
    // une fois confirmé, alimente aussi le Tableau des scores local (Top 20)
    // sous l'identifiant du compte (voir saveConnectedResult / addAccountResultToLeaderboard).
    state.finalSavePromise = saveConnectedResult();
  } else {
    if (nameBlock) nameBlock.hidden = false;
    if (saveStatus) saveStatus.hidden = true;
    setTimeout(() => {
      const input = document.getElementById("playerName");
      if (input) input.focus();
    }, 0);
  }
}

/**
 * v12.6-B3.1 — Affiche le rapport de mission (score, récompense fusée, débrief,
 * classement local) dans la langue courante. Aucune donnée de partie n'est ici
 * modifiée : cette fonction n'est appelée que pour le rendu.
 */
function renderResultContent() {
  if (!state.finalScore) return;
  const message = encouragementFor(state.finalScore.score);
  document.getElementById("scoreDisplay").textContent = i18nT(
    "result.scoreLine",
    { message, score: state.finalScore.score, total: QUESTION_COUNT, time: state.finalScore.time.toFixed(1) },
    `${message} Score : ${state.finalScore.score}/${QUESTION_COUNT} — Temps : ${state.finalScore.time.toFixed(1)} s`
  );

  const remaining = QUESTION_COUNT - state.finalScore.score;
  const reward = document.getElementById("missionReward");
  reward.className = `mission-reward${state.finalScore.score === QUESTION_COUNT ? " perfect" : ""}`;
  reward.textContent = state.finalScore.score === QUESTION_COUNT
    ? i18nT("result.rewardPerfect", null, `Fusée complète : décollage réussi !`)
    : i18nPl(
        "result.rewardPartial",
        remaining,
        { score: state.finalScore.score, total: QUESTION_COUNT, remaining },
        `Fusée construite à ${state.finalScore.score}/${QUESTION_COUNT}. Encore ${remaining} pièce${remaining > 1 ? "s" : ""} à gagner.`
      );

  renderDebrief();
  renderLeaderboard("resultLeaderboardBody", "resultLeaderboardEmpty", state.config.mode);
}

function encouragementFor(score) {
  if (score === 10) return i18nT("result.encouragementPerfect", null, "Parfait, mission accomplie !");
  if (score >= 8) return i18nT("result.encouragementGreat", null, "Excellent travail !");
  if (score >= 5) return i18nT("result.encouragementGood", null, "Bien joué, continue ainsi !");
  return i18nT("result.encouragementContinue", null, "Continue, chaque mission vous fait progresser !");
}

function renderDebrief() {
  const tbody = document.getElementById("feedbackBody");
  tbody.innerHTML = "";

  state.results.forEach((item) => {
    const row = document.createElement("tr");
    if (!item.correct) row.classList.add("wrong");

    const calculation = document.createElement("td");
    calculation.className = "calculation-cell";
    // Correction : affiche l'équation complète (opérandes révélés et résultat),
    // même pour une question à trou dont l'opérande manquant est ainsi explicité.
    calculation.textContent =
      `${item.a} ${operatorSymbol(item.mode)} ${item.b} = ${item.correctAnswer}`;

    const status = document.createElement("td");
    status.className = item.correct ? "status-ok" : "status-wrong";
    status.textContent = item.correct ? i18nT("feedback.correct", null, "Juste") : i18nT("feedback.incorrect", null, "Faux");

    const time = document.createElement("td");
    time.className = "time-cell";
    time.textContent = `${item.time.toFixed(1)} s`;

    row.append(calculation, status, time);
    tbody.appendChild(row);
  });
}

/** Vrai si l'utilisateur est connecté (session serveur active, propagée par
 *  account.js via GuestHistoryV12.setSession). */
function isConnected() {
  return typeof window.MissionGuestHistory !== "undefined" &&
    window.MissionGuestHistory.hasSession === true;
}

/**
 * Enregistrement AUTOMATIQUE du score d'un utilisateur connecté sur son compte.
 * L'identité est celle de la connexion (session serveur) : le client ne transmet
 * AUCUN user_id, l'API détermine le compte via `result/save`.
 *
 * Anti-doublon : la partie n'est marquée sauvegardée qu'une fois le serveur a
 * CONFIRMÉ la réussite (`state.savedCurrentResult = true`). Tant que ce n'est
 * pas confirmé, un nouvel essai est possible sans jamais écrire deux fois un
 * même résultat. Une confirmation n'est affichée qu'après cette réussite réelle.
 *
 * @return {Promise<boolean>} true si la sauvegarde est effectivement confirmée.
 */
async function saveConnectedResult() {
  if (state.savedCurrentResult) return true;
  if (!state.finalScore) return false;

  const statusEl = document.getElementById("saveStatus");
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "inline-message save-status is-busy";
    statusEl.textContent = i18nT("result.saveStatusPending", null, "Enregistrement de votre score…");
  }

  let res = null;
  try {
    if (typeof window.MissionGuestHistory !== "undefined" && window.MissionGuestHistory.record) {
      const details = (state.results || []).map((item) => ({
        mode: item.mode === "add" ? "addition" : "multiplication",
        // Classification INDIVIDUELLE : classic ou hole selon la présence d'un trou.
        question_type: item.hole ? "hole" : "classic",
        a: item.a,
        b: item.b,
        hole: item.hole || null,
        // Le serveur RECALCULE la justesse ; on ne transmet pas de flag `correct`.
        // Une expiration (timedOut) est envoyée sans réponse => erreur côté serveur.
        user_answer: item.timedOut ? null : item.userAnswer,
      }));
      res = await window.MissionGuestHistory.record({
        mode: state.config.mode,
        questionType: state.finalScore.questionType || "classic",
        score: state.score,
        playedAt: new Date().toISOString(),
        missionId: state.missionId || undefined,
        durationMs: Math.round(state.finalScore.time * 1000),
        details,
      });
    }
  } catch (_e) {
    res = { server: true, ok: false, error: "réseau" };
  }

  if (res && res.server && res.ok) {
    // Confirmation EFFECTIVE : le serveur a enregistré. Aucun doublon possible.
    state.savedCurrentResult = true;
    // v12.2 — correction : le résultat confirmé d'un compte doit aussi alimenter le
    // Tableau des scores général (sous l'identifiant du compte, sans suffixe invité).
    addAccountResultToLeaderboard();
    if (statusEl) {
      statusEl.hidden = false;
      statusEl.className = "inline-message save-status is-success";
      statusEl.textContent = i18nT("result.saveStatusSuccess", null, "Score enregistré sur votre compte.");
    }
    return true;
  }

  // Échec : avertissement clair + bouton « Réessayer » (sans doublon).
  if (statusEl) {
    statusEl.hidden = false;
    statusEl.className = "inline-message save-status is-error";
    statusEl.innerHTML = "";
    statusEl.appendChild(document.createTextNode(
      i18nT("result.saveStatusError", null, "Impossible d\u2019enregistrer le score sur votre compte.")
    ));
    const retry = document.createElement("button");
    retry.type = "button";
    retry.className = "retry-save-btn";
    retry.textContent = i18nT("result.retry", null, "Réessayer");
    retry.addEventListener("click", () => {
      state.finalSavePromise = saveConnectedResult();
    });
    statusEl.appendChild(retry);
  }
  return false;
}

/**
 * Ajoute (au plus une fois) le résultat CONFIRMÉ d'un compte au classement
 * général local `STORAGE.scores`, sous l'identifiant du compte (sans le suffixe
 * "(invité)", grâce au marqueur `account:true`). Ce marqueur permet à
 * `renderLeaderboard()` de ne PAS suffixer le nom, et à `normalizeScore()` de
 * conserver la distinction entre entrées de comptes et entrées d'invités.
 *
 * Appelée uniquement après la confirmation serveur (`saveConnectedResult`) : le
 * drapeau `state.savedCurrentResult` étant posé, une éventuelle relance (bouton
 * « Réessayer » ou navigation) ne provoque aucun double enregistrement.
 */
function addAccountResultToLeaderboard() {
  const connectedAccount =
    (typeof window.MissionGuestHistory !== "undefined" && window.MissionGuestHistory.currentUser)
    ? window.MissionGuestHistory.currentUser
    : null;
  const login = connectedAccount && connectedAccount.login
    ? String(connectedAccount.login).trim()
    : "";
  if (!login || !state.finalScore) return;

  const scores = loadScores();
  scores.push({
    name: login,
    account: true,
    score: state.finalScore.score,
    time: state.finalScore.time,
    mode: state.finalScore.mode,
    questionType: state.finalScore.questionType || "classic",
    tables: [...state.finalScore.tables],
    range: state.finalScore.range || "",
    date: new Date().toISOString()
  });
  saveScores(scores);
  // Rafraîchit le classement de l'écran de fin de mission et celui du menu.
  renderLeaderboard("resultLeaderboardBody", "resultLeaderboardEmpty", state.config.mode);
  renderLeaderboard("leaderboardBody", "leaderboardEmpty", state.config.mode);
}

async function saveThen(nextAction) {
  const ok = await saveCurrentScoreOnce();
  if (!ok) return;
  nextAction();
}

async function saveCurrentScoreOnce() {
  // Déjà enregistré (invité : classement local ; connecté : serveur confirmé).
  if (state.savedCurrentResult) return true;
  if (!state.finalScore) return false;

  if (isConnected()) {
    // La sauvegarde serveur est déclenchée automatiquement à la fin de mission
    // (saveConnectedResult). On attend son issue sans bloquer la navigation : en
    // cas d'échec, le message + « Réessayer » restent visibles sur cet écran.
    if (state.finalSavePromise) {
      await state.finalSavePromise;
    }
    return true;
  }

  // --- Invité : le prénom est requis pour le classement local Top 20. ---
  const input = document.getElementById("playerName");
  const name = input.value.trim();
  if (!name) {
    document.getElementById("nameWarning").textContent = i18nT("result.saveNameRequired", null, "Saisissez le prénom avant d’enregistrer le résultat.");
    input.focus();
    return false;
  }

  document.getElementById("nameWarning").textContent = "";
  const scores = loadScores();
  scores.push({
    name: displayGuestName(name),
    score: state.finalScore.score,
    time: state.finalScore.time,
    mode: state.finalScore.mode,
    questionType: state.finalScore.questionType || "classic",
    tables: [...state.finalScore.tables],
    range: state.finalScore.range || "",
    date: new Date().toISOString()
  });
  saveScores(scores);
  state.savedCurrentResult = true;
  renderLeaderboard("resultLeaderboardBody", "resultLeaderboardEmpty", state.config.mode);
  return true;
}

// Le classement local (Top 20) mélange désormais :
//  - les résultats d'invités (prénom suivi de « (invité) ») ;
//  - les résultats de comptes connectés (identifiant du compte, sans suffixe),
//    ajoutés sous STORAGE.scores après confirmation serveur (marqueur account).
// Pour un invité, on affiche le prénom suivi de « (invité) », sans jamais
// doubler le suffixe si une entrée (nouvelle ou ancienne) le contenait déjà.

/** Restitue le prénom d'un invité affiché dans le classement : « Prénom (invité) ». */
function displayGuestName(name) {
  const trimmed = String(name || "").trim();
  if (typeof trimmed === "string" && /\(\s*invité\s*\)$/i.test(trimmed)) {
    return trimmed;
  }
  return trimmed + " (invité)";
}

// Fonction UNIQUE utilisée par le classement du menu ET par celui de fin de mission.
// Le paramètre mode filtre les scores pour n'afficher que le mode demandé.
function renderLeaderboard(tbodyId, emptyStateId, mode = "mult") {
  const tbody = document.getElementById(tbodyId);
  const emptyState = document.getElementById(emptyStateId);
  const scores = getTopScores(20, mode);
  tbody.innerHTML = "";

  // Ajuste l'en-tête de la dernière colonne selon le mode.
  const detailHeader = tbodyId === "resultLeaderboardBody"
    ? document.getElementById("resultLeaderboardDetailHeader")
    : document.getElementById("leaderboardDetailHeader");
  if (detailHeader) {
    detailHeader.textContent = i18nT(
      mode === "add" ? "leaderboard.columnDetailAdd" : "leaderboard.columnDetailMult",
      null,
      mode === "add" ? "Plage utilisée" : "Tables utilisées"
    );
  }

  if (scores.length === 0) {
    emptyState.hidden = false;
    tbody.closest("table").hidden = true;
    return;
  }

  emptyState.hidden = true;
  tbody.closest("table").hidden = false;

  const isAdd = mode === "add";
  scores.forEach((entry) => {
    const row = document.createElement("tr");

    const name = document.createElement("td");
    // Entrées de comptes : identifiant tel quel (jamais suffixé). Entrées
    // d'invités : prénom suivi de « (invité) », sans jamais doubler le suffixe.
    name.textContent = entry.account
      ? String(entry.name ?? "")
      : displayGuestName(entry.name);

    const score = document.createElement("td");
    score.textContent = `${entry.score}/10`;

    const time = document.createElement("td");
    time.textContent = `${Number(entry.time).toFixed(1)} s`;

    // v12.3 — colonne « Questions à trou » : Non (mission classique) ou Oui
    // (mission à trou / mélange). Une infobulle précise le mode exact pour Oui.
    const holeCell = document.createElement("td");
    holeCell.className = "hole-cell";
    const mixedOrHole = entry.questionType === "hole" || entry.questionType === "mixed";
    if (mixedOrHole) {
      holeCell.textContent = i18nT("leaderboard.yes", null, "Oui");
      const tooltipLabel = questionTypeLabel(entry.questionType);
      holeCell.setAttribute(
        "data-tooltip",
        i18nT("leaderboard.holeMode", { mode: tooltipLabel }, `Mode : ${tooltipLabel}`)
      );
    } else {
      holeCell.textContent = i18nT("leaderboard.no", null, "Non");
    }

    const detail = document.createElement("td");
    if (isAdd) {
      detail.textContent = entry.range ? entry.range : "—";
    } else {
      detail.textContent = entry.tables.length ? entry.tables.join(", ") : "—";
    }

    if (isAdd) detail.classList.add("range-cell");

    row.append(name, score, time, holeCell, detail);
    tbody.appendChild(row);
  });
}

function getTopScores(limit, mode = "mult") {
  return loadScores()
    .map(normalizeScore)
    .filter(Boolean)
    .filter((entry) => entry.mode === mode)
    .sort((a, b) => (b.score - a.score) || (a.time - b.time))
    .slice(0, limit);
}

function normalizeScore(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = String(entry.name ?? "").trim();
  const score = Number(entry.score);
  const time = Number(entry.time);

  // Les anciens scores (sans champ mode) sont affectés au mode Multiplications.
  const mode = entry.mode === "add" ? "add" : "mult";

  const tables = Array.isArray(entry.tables)
    ? entry.tables.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10).sort((a, b) => a - b)
    : [];

  let range = String(entry.range ?? "").trim();
  // Pour un score addition dont on ne connaît pas la plage explicite, on la déduit des termes.
  if (mode === "add" && !range) {
    const min = Array.isArray(entry.aValues) ? Math.min(...entry.aValues) : null;
    const max = Array.isArray(entry.bValues) ? Math.max(...entry.bValues) : null;
    if (min != null && max != null && Number.isFinite(min) && Number.isFinite(max)) {
      range = `${min}–${max}`;
    }
  }

  if (!name || !Number.isFinite(score) || !Number.isFinite(time)) return null;

  // v12.3 — type de questions : classique par défaut (les scores sauvegardés
  // avant cette version n'ont pas ce champ).
  const questionType = QUESTION_TYPES[entry.questionType] ? entry.questionType : "classic";

  return {
    name, score, time, mode, questionType, tables, range,
    date: entry.date || "",
    // Marqueur « compte connecté » : une entrée d'invité n'a pas ce drapeau.
    account: entry.account === true
  };
}

function loadScores() {
  try {
    const raw = localStorage.getItem(STORAGE.scores);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function saveScores(scores) {
  localStorage.setItem(STORAGE.scores, JSON.stringify(scores));
}

function loadConfig() {
  const v11Raw = localStorage.getItem(STORAGE.config);
  if (v11Raw) {
    try {
      return normalizeConfig(JSON.parse(v11Raw));
    } catch {
      // Config v11 invalide : on tente la migration v10 ci-dessous.
    }
  }

  const migrated = migrateConfigIfNeeded();
  if (migrated) return migrated;

  // Dernier recours : anciennes clés pré-v10b (rare).
  try {
    const legacyTablesRaw = localStorage.getItem(STORAGE.legacyTables);
    const legacyTimeRaw = localStorage.getItem(STORAGE.legacyTime);
    if (legacyTablesRaw || legacyTimeRaw) {
      return normalizeConfig({
        mult: {
          tables: legacyTablesRaw ? JSON.parse(legacyTablesRaw) : DEFAULT_CONFIG.mult.tables
        },
        timePerQuestion: legacyTimeRaw ? Number(legacyTimeRaw) : DEFAULT_CONFIG.timePerQuestion
      });
    }
  } catch {
    // Valeurs par défaut ci-dessous.
  }
  return normalizeConfig();
}

// S'il existe une config v10 (multiplication seule) et pas encore de config v11,
// on migre la v10 vers v11 en la conservant intacte.
function migrateConfigIfNeeded() {
  try {
    const v10Raw = localStorage.getItem(STORAGE.legacyConfig);
    if (!v10Raw) return null;
    const v10 = JSON.parse(v10Raw);

    const migrated = normalizeConfig({
      mode: "mult",
      timePerQuestion: v10?.timePerQuestion,
      mult: { tables: v10?.tables },
      add: { ...DEFAULT_CONFIG.add }
    });
    saveConfigRaw(migrated);
    return migrated;
  } catch {
    return null;
  }
}

function normalizeConfig(config) {
  config = config && typeof config === "object" ? config : {};

  const mode = config.mode === "add" ? "add" : "mult";

  // Paramètres du mode multiplication (tables cochées).
  let tables = Array.isArray(config?.mult?.tables) || Array.isArray(config?.tables)
    ? (Array.isArray(config?.mult?.tables) ? config.mult.tables : config.tables)
        .map(Number)
        .filter((n) => Number.isInteger(n) && n >= 1 && n <= 10)
    : [...DEFAULT_CONFIG.mult.tables];
  tables = [...new Set(tables)].sort((a, b) => a - b);
  if (tables.length === 0) tables = [...DEFAULT_CONFIG.mult.tables];

  // Paramètres du mode addition (plage min/max, zéro interdit).
  let min = Number(config?.add?.min);
  let max = Number(config?.add?.max);
  if (!Number.isInteger(min)) min = DEFAULT_CONFIG.add.min;
  if (!Number.isInteger(max)) max = DEFAULT_CONFIG.add.max;
  min = Math.min(99, Math.max(1, min));
  max = Math.min(99, Math.max(1, max));
  if (min > max) [min, max] = [max, min];

  let timePerQuestion = Number(config?.timePerQuestion);
  if (!Number.isFinite(timePerQuestion)) timePerQuestion = DEFAULT_CONFIG.timePerQuestion;
  timePerQuestion = Math.min(60, Math.max(1, Math.round(timePerQuestion * 10) / 10));

  // v12.3 — type de questions (classique par défaut, préservé pour les configs
  // antérieures qui ne possèdent pas ce réglage).
  const questionType = QUESTION_TYPES[config?.questionType]
    ? config.questionType
    : DEFAULT_CONFIG.questionType;

  // v12.5 — entraînement adaptatif : employé par défaut (true), y compris pour
  // les anciennes configurations qui ne possèdent pas cette propriété.
  const adaptive = config?.adaptive !== false;

  return { mode, questionType, timePerQuestion, adaptive, mult: { tables }, add: { min, max } };
}

function saveConfig() {
  saveConfigRaw(state.config);
}

function saveConfigRaw(config) {
  localStorage.setItem(STORAGE.config, JSON.stringify(config));
}

// Migration des scores v10 (et pré-v10b) vers v11, uniquement si aucune donnée v11 n'existe.
function migrateScoresIfNeeded() {
  if (localStorage.getItem(STORAGE.scores)) return;

  // Source prioritaire : scores v10.
  let legacyRaw = localizedGetItem(STORAGE.legacyScores)
    || localizedGetItem(STORAGE.oldLegacyScores);
  if (!legacyRaw) return;

  try {
    const legacy = JSON.parse(legacyRaw);
    if (!Array.isArray(legacy)) return;
    const normalized = legacy.map(normalizeScore).filter(Boolean);
    if (normalized.length > 0) saveScores(normalized);
  } catch {
    // Pas de migration si l'ancien format est invalide.
  }
}

function localizedGetItem(key) {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

// --- Classements à onglets (menu « Tableau des scores ») ---
// Active visuellement l'onglet du mode demandé.
function activateLeaderboardTab(mode) {
  document.querySelectorAll("[data-leaderboard-mode]").forEach((tab) => {
    const active = tab.dataset.leaderboardMode === mode;
    tab.classList.toggle("active", active);
    tab.setAttribute("aria-selected", active ? "true" : "false");
  });
}

function switchLeaderboardMode(mode) {
  leaderboardState.mode = mode;
  activateLeaderboardTab(mode);
  syncLeaderboardFilterControls();
  renderLeaderboardHeadline();
  if (leaderboardState.view === "shared") {
    loadSharedLeaderboard();
  } else {
    renderLeaderboard("leaderboardBody", "leaderboardEmpty", mode);
  }
}

// --- B4.2 — Interface des classements partagés ---

/** Active le bouton de la vue demandée (partagé ou local). */
function activateLeaderboardViewBtn(view) {
  document.querySelectorAll("[data-leaderboard-view]").forEach((btn) => {
    const active = btn.dataset.leaderboardView === view;
    btn.classList.toggle("is-active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
}

/** Masque/affiche le bloc de la vue partagée vs locale. */
function renderLeaderboardView() {
  const shared = document.getElementById("sharedLeaderboardContainer");
  const local = document.getElementById("localLeaderboardContainer");
  const filters = document.getElementById("sharedLeaderboardFilters");
  activateLeaderboardViewBtn(leaderboardState.view);
  if (shared) shared.hidden = leaderboardState.view !== "shared";
  if (local) local.hidden = leaderboardState.view !== "local";
  if (filters) filters.hidden = leaderboardState.view !== "shared";
}

/** Bascule entre Classement partagé et Scores locaux. */
function switchLeaderboardView(view) {
  if (view !== "shared" && view !== "local") return;
  leaderboardState.view = view;
  renderLeaderboardView();
  renderLeaderboardHeadline();
  if (view === "shared") {
    loadSharedLeaderboard();
  } else {
    // Aucun appel serveur : on restitue simplement le classement local (B4.2).
    renderLeaderboard("leaderboardBody", "leaderboardEmpty", leaderboardState.mode);
    const detailHeader = document.getElementById("leaderboardDetailHeader");
    if (detailHeader) {
      detailHeader.textContent = i18nT(
        leaderboardState.mode === "add" ? "leaderboard.columnDetailAdd" : "leaderboard.columnDetailMult",
        null,
        leaderboardState.mode === "add" ? "Plage utilisée" : "Tables utilisées"
      );
    }
  }
}

/** Titre du classement (mode courant), commun aux deux vues. */
function renderLeaderboardHeadline() {
  const headline = document.getElementById("leaderboardHeadline");
  if (!headline) return;
  const label = modeLabel(leaderboardState.mode);
  headline.textContent = i18nT("leaderboard.headline", { mode: label }, `Top 20 — ${label}`);
}

/** Réinitialise les filtres du classement partagé au niveau par défaut du
 *  compte courant (B4.2). Appelé à chaque ouverture de l'écran. */
function resetLeaderboardDefaultFilters() {
  leaderboardState.schoolLevel = defaultLeaderboardLevel();
  leaderboardState.questionType = "classic";
  leaderboardState.view = "shared";
}

/** Synchronise les valeurs DOM des deux sélecteurs avec l'état interne. */
function syncLeaderboardFilterControls() {
  const levelSelect = document.getElementById("sharedLeaderboardLevel");
  if (levelSelect && leaderboardState.schoolLevel !== undefined) {
    if (levelSelect.querySelector(`option[value="${leaderboardState.schoolLevel}"]`)) {
      levelSelect.value = leaderboardState.schoolLevel;
    } else {
      levelSelect.value = "unspecified";
    }
  }
  const typeSelect = document.getElementById("sharedLeaderboardType");
  if (typeSelect && leaderboardState.questionType !== undefined) {
    typeSelect.value = leaderboardState.questionType;
  }
}

/** « Réessayer » après une erreur réseau du classement partagé. */
function retrySharedLeaderboard() {
  loadSharedLeaderboard();
}

/** Ré-affiche l'état courant du partagé après un changement de langue, sans
 *  relancer un appel réseau si des données sont déjà affichées. */
function renderSharedLeaderboardState() {
  const tbody = document.getElementById("sharedLeaderboardBody");
  if (!tbody || !tbody.childElementCount) {
    // Aucune donnée déjà chargée : on relance le chargement.
    loadSharedLeaderboard();
  }
  // Si des rangées existent, les libellés statiques ont déjà été retraduits par
  // le moteur i18n ; on ne modifie ni les sélections ni les données.
}

/** Affiche uniquement le message d'état demandé dans le bloc partagé. */
function showSharedLeaderboardState(stateKey) {
  const loading = document.getElementById("sharedLeaderboardLoading");
  const error = document.getElementById("sharedLeaderboardError");
  const empty = document.getElementById("sharedLeaderboardEmpty");
  const table = document.getElementById("sharedLeaderboardTable");
  if (loading) loading.hidden = stateKey !== "loading";
  if (error) error.hidden = stateKey !== "error";
  if (empty) empty.hidden = stateKey !== "empty";
  if (table) table.hidden = stateKey !== "table";
}

/** Formate la durée (ms) en secondes lisibles ; null -> « — ». */
function formatSharedDuration(durationMs) {
  if (durationMs === null || durationMs === undefined) return "—";
  const seconds = Number(durationMs) / 1000;
  if (!Number.isFinite(seconds)) return "—";
  return `${seconds.toFixed(1)} s`;
}

/**
 * Interroge le classement partagé (GET public, sans jeton CSRF) et affiche le
 * résultat. La réponse n'est prise en compte que si elle correspond à la
 * requête la plus récente (anti-réponses obsolètes).
 */
async function loadSharedLeaderboard() {
  if (typeof window.AccountUI === "undefined" || typeof window.AccountUI.api !== "function") {
    return;
  }
  const requestId = ++leaderboardState.requestId;
  showSharedLeaderboardState("loading");

  try {
    const res = await window.AccountUI.api("leaderboard", leaderboardApiParams(), "GET");
    if (requestId !== leaderboardState.requestId) return; // réponse obsolète
    if (!res.ok || !res.data) {
      showSharedLeaderboardState("error");
      return;
    }
    renderSharedLeaderboard(res.data);
  } catch (_e) {
    if (requestId !== leaderboardState.requestId) return;
    showSharedLeaderboardState("error");
  }
}

/** Construit les rangées du tableau partagé (aucune insertion via innerHTML). */
function renderSharedLeaderboard(data) {
  const entries = Array.isArray(data && data.entries) ? data.entries : [];
  const tbody = document.getElementById("sharedLeaderboardBody");
  if (tbody) tbody.innerHTML = "";

  if (entries.length === 0) {
    showSharedLeaderboardState("empty");
    return;
  }

  showSharedLeaderboardState("table");

  entries.forEach((entry) => {
    const row = document.createElement("tr");

    const rank = document.createElement("td");
    rank.textContent = String(entry && entry.rank !== undefined ? entry.rank : "—");

    const name = document.createElement("td");
    // display_name vient du serveur : texte brut, jamais de HTML non échappé.
    name.textContent = String((entry && entry.display_name) || "");

    const score = document.createElement("td");
    score.textContent = `${Number(entry && entry.score)}/10`;

    const time = document.createElement("td");
    time.textContent = formatSharedDuration(entry && entry.duration_ms);

    row.append(rank, name, score, time);
    tbody.appendChild(row);
  });
}
