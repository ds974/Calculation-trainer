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

const DEFAULT_CONFIG = {
  mode: "mult",
  timePerQuestion: 5,
  mult: { tables: [1,2,3,4,5,6,7,8,9,10] },
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
  launchInProgress: false
};

document.addEventListener("DOMContentLoaded", init);

function init() {
  migrateScoresIfNeeded();
  buildConfigControls();
  bindActions();
  bindAnswerInput();
  bindNumericKeypad();
  resetRocket();
  updateHomeTitle();
  showScreen("homeScreen");
}

function bindActions() {
  document.addEventListener("click", (event) => {
    // Changement d'onglet du classement (indépendant des boutons d'action).
    const modeTab = event.target.closest("[data-leaderboard-mode]");
    if (modeTab) {
      switchLeaderboardMode(modeTab.dataset.leaderboardMode);
      return;
    }

    const button = event.target.closest("[data-action]");
    if (!button) return;

    const action = button.dataset.action;
    if (action === "start") startMission();
    if (action === "config") showConfig();
    if (action === "leaderboard") showLeaderboard();
    if (action === "home") showScreen("homeScreen");
    if (action === "restart") saveThen(() => startMission());
    if (action === "save-home") saveThen(() => showScreen("homeScreen"));
  });
}

// --- Opérations centralisées ---
// Ces fonctions sont les SEULES à connaître le calcul et le symbole d'une opération.
// Le mode est attaché à chaque question, garantissant la cohérence même si l'utilisateur
// change de mode en cours de partie.
function computeAnswer(q) {
  const mode = MODES[q.mode] || MODES[DEFAULT_CONFIG.mode];
  return mode.compute(q.a, q.b);
}

function operatorSymbol(modeKey = state.config.mode) {
  const mode = MODES[modeKey] || MODES[DEFAULT_CONFIG.mode];
  return mode.symbol;
}

function modeLabel(modeKey = state.config.mode) {
  const mode = MODES[modeKey] || MODES[DEFAULT_CONFIG.mode];
  return mode.label;
}

function bindAnswerInput() {
  const answer = document.getElementById("answer");

  answer.addEventListener("input", () => {
    if (state.questionLocked || state.currentIndex >= state.questions.length) return;
    const value = answer.value.trim();
    if (value === "") return;

    const q = state.questions[state.currentIndex];
    if (Number(value) === computeAnswer(q)) {
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
      if (numericValue !== computeAnswer(q)) finishQuestion(false, numericValue);
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
}

function showConfig() {
  syncConfigControls();
  showScreen("configScreen");
}

function showLeaderboard() {
  switchLeaderboardMode(state.config.mode);
  showScreen("leaderboardScreen");
}

function buildConfigControls() {
  // Sélecteur de mode (Multiplications / Additions)
  document.querySelectorAll("[data-mode-option]").forEach((radio) => {
    radio.checked = radio.value === state.config.mode;
    radio.addEventListener("change", handleModeChange);
  });

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
    text.textContent = `Table de ${table}`;

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

// Met à jour le titre de l'accueil et la description selon le mode choisi.
function updateHomeTitle() {
  const title = document.getElementById("homeTitle");
  const subtitle = document.getElementById("homeSubtitle");
  if (title) title.textContent = `Mission ${modeLabel()}`;
  if (subtitle) {
    subtitle.textContent = state.config.mode === "add"
      ? "10 additions, un chrono et une fusée à construire."
      : "10 calculs, un chrono et une fusée à construire.";
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
  state.questions = generateUniqueQuestions();
  state.currentIndex = 0;
  state.score = 0;
  state.results = [];
  state.finalScore = null;
  state.savedCurrentResult = false;
  state.launchInProgress = false;

  document.getElementById("playerName").value = "";
  document.getElementById("nameWarning").textContent = "";
  document.getElementById("missionReward").textContent = "";
  resetRocket();
  showScreen("gameScreen");
  presentQuestion();
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
      return "Sélectionnez au moins 4 tables pour obtenir 10 calculs différents.";
    }
    return null;
  }
  // Addition : la plage doit permettre au moins 10 calculs distincts.
  const size = poolSize();
  if (size < QUESTION_COUNT) {
    const { min, max } = state.config.add;
    return `La plage ${min} à ${max} ne permet que ${size} calcul${size > 1 ? "s" : ""} différent${size > 1 ? "s" : ""}. Élargissez la plage pour obtenir 10 calculs.`;
  }
  return null;
}

function generateUniqueQuestions() {
  const mode = state.config.mode;
  let pool;

  if (mode === "add") {
    const { min, max } = state.config.add;
    pool = [];
    for (let a = min; a <= max; a++) {
      for (let b = a; b <= max; b++) {
        pool.push({ a, b, mode });
      }
    }
  } else {
    // Multiplication : produit cartésien des tables cochées.
    const tables = state.config.mult.tables;
    pool = [];
    for (const a of tables) {
      for (const b of tables) {
        pool.push({ a, b, mode });
      }
    }
  }

  // Fisher-Yates : chaque couple n'apparaît qu'une seule fois dans la mission.
  shuffleArray(pool);
  return pool.slice(0, QUESTION_COUNT);
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

  document.getElementById("progressText").textContent = `Question ${state.currentIndex + 1} / 10`;
  document.getElementById("missionProgressBar").style.width = `${((state.currentIndex + 1) / 10) * 100}%`;
  document.getElementById("question").textContent = `${q.a} ${operatorSymbol(q.mode)} ${q.b}`;
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
    correctAnswer: computeAnswer(q),
    userAnswer,
    correct: isCorrect,
    timedOut,
    time: Math.round(elapsed * 10) / 10
  });

  const answer = document.getElementById("answer");
  answer.disabled = true;

  const feedback = document.getElementById("feedback");
  const symbol = operatorSymbol(q.mode);
  const correctAnswer = computeAnswer(q);
  if (isCorrect) {
    feedback.textContent = `Bravo ! ${q.a} ${symbol} ${q.b} = ${correctAnswer}`;
    feedback.className = "feedback correct";
  } else {
    feedback.textContent = `${timedOut ? "Temps écoulé" : "Faux"} — ${q.a} ${symbol} ${q.b} = ${correctAnswer}`;
    feedback.className = "feedback incorrect";
  }

  const delay = isCorrect ? 700 : 1000;
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
  if (count) count.textContent = "0 / 10";
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
  document.getElementById("rocketPieceCount").textContent = `${correctCount} / 10`;
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
    message.textContent = "Décollage !";
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
  const message = encouragementFor(state.score);
  const mode = state.config.mode;
  const range = mode === "add"
    ? `${state.config.add.min}–${state.config.add.max}`
    : [...state.config.mult.tables].sort((a, b) => a - b).join(", ");

  state.finalScore = {
    score: state.score,
    time: totalTime,
    mode,
    tables: mode === "add" ? [] : [...state.config.mult.tables].sort((a, b) => a - b),
    range: mode === "add" ? range : ""
  };

  document.getElementById("scoreDisplay").textContent = `${message} Score : ${state.score}/10 — Temps : ${totalTime.toFixed(1)} s`;

  const reward = document.getElementById("missionReward");
  reward.className = `mission-reward${state.score === 10 ? " perfect" : ""}`;
  reward.textContent = state.score === 10
    ? "Fusée complète : décollage réussi !"
    : `Fusée construite à ${state.score}/10. Encore ${10 - state.score} pièce${10 - state.score > 1 ? "s" : ""} à gagner.`;

  renderDebrief();
  renderLeaderboard("resultLeaderboardBody", "resultLeaderboardEmpty", state.config.mode);
  showScreen("resultScreen");
  setTimeout(() => document.getElementById("playerName").focus(), 0);
}

function encouragementFor(score) {
  if (score === 10) return "Parfait, mission accomplie !";
  if (score >= 8) return "Excellent travail !";
  if (score >= 5) return "Bien joué, continue ainsi !";
  return "Continue, chaque mission vous fait progresser !";
}

function renderDebrief() {
  const tbody = document.getElementById("feedbackBody");
  tbody.innerHTML = "";

  state.results.forEach((item) => {
    const row = document.createElement("tr");
    if (!item.correct) row.classList.add("wrong");

    const calculation = document.createElement("td");
    calculation.className = "calculation-cell";
    calculation.textContent = `${item.a} ${operatorSymbol(item.mode)} ${item.b} = ${item.correctAnswer}`;

    const status = document.createElement("td");
    status.className = item.correct ? "status-ok" : "status-wrong";
    status.textContent = item.correct ? "Juste" : "Faux";

    const time = document.createElement("td");
    time.className = "time-cell";
    time.textContent = `${item.time.toFixed(1)} s`;

    row.append(calculation, status, time);
    tbody.appendChild(row);
  });
}

function saveThen(nextAction) {
  if (!saveCurrentScoreOnce()) return;
  nextAction();
}

function saveCurrentScoreOnce() {
  if (state.savedCurrentResult) return true;
  if (!state.finalScore) return false;

  const input = document.getElementById("playerName");
  const name = input.value.trim();
  if (!name) {
    document.getElementById("nameWarning").textContent = "Saisissez le prénom avant d’enregistrer le résultat.";
    input.focus();
    return false;
  }

  document.getElementById("nameWarning").textContent = "";
  const scores = loadScores();
  scores.push({
    name,
    score: state.finalScore.score,
    time: state.finalScore.time,
    mode: state.finalScore.mode,
    tables: [...state.finalScore.tables],
    range: state.finalScore.range || "",
    date: new Date().toISOString()
  });
  saveScores(scores);
  state.savedCurrentResult = true;
  renderLeaderboard("resultLeaderboardBody", "resultLeaderboardEmpty", state.config.mode);
  return true;
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
    detailHeader.textContent = mode === "add" ? "Plage utilisée" : "Tables utilisées";
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
    name.textContent = entry.name;

    const score = document.createElement("td");
    score.textContent = `${entry.score}/10`;

    const time = document.createElement("td");
    time.textContent = `${Number(entry.time).toFixed(1)} s`;

    const detail = document.createElement("td");
    if (isAdd) {
      detail.textContent = entry.range ? entry.range : "—";
    } else {
      detail.textContent = entry.tables.length ? entry.tables.join(", ") : "—";
    }

    if (isAdd) detail.classList.add("range-cell");

    row.append(name, score, time, detail);
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
  return { name, score, time, mode, tables, range, date: entry.date || "" };
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

  return { mode, timePerQuestion, mult: { tables }, add: { min, max } };
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
  activateLeaderboardTab(mode);
  const headline = document.getElementById("leaderboardHeadline");
  if (headline) {
    headline.textContent = `Top 20 — ${modeLabel(mode)}`;
  }
  const detailHeader = document.getElementById("leaderboardDetailHeader");
  if (detailHeader) {
    detailHeader.textContent = mode === "add" ? "Plage utilisée" : "Tables utilisées";
  }
  renderLeaderboard("leaderboardBody", "leaderboardEmpty", mode);
}

