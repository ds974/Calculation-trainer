"use strict";

// Les clés v10 sont volontairement conservées pour garder les paramètres
// et les scores déjà enregistrés lors du passage à la v10b.
const STORAGE = {
  config: "multiplicationTrainer.config.v10",
  scores: "multiplicationTrainer.scores.v10",
  legacyTables: "tables",
  legacyTime: "timeLimit",
  legacyScores: "scores"
};

const DEFAULT_CONFIG = {
  tables: [1,2,3,4,5,6,7,8,9,10],
  timePerQuestion: 5
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
  migrateLegacyScoresIfPossible();
  buildConfigControls();
  bindActions();
  bindAnswerInput();
  bindNumericKeypad();
  resetRocket();
  showScreen("homeScreen");
}

function bindActions() {
  document.addEventListener("click", (event) => {
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

function bindAnswerInput() {
  const answer = document.getElementById("answer");

  answer.addEventListener("input", () => {
    if (state.questionLocked || state.currentIndex >= state.questions.length) return;
    const value = answer.value.trim();
    if (value === "") return;

    const q = state.questions[state.currentIndex];
    if (Number(value) === q.a * q.b) {
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
      if (numericValue !== q.a * q.b) finishQuestion(false, numericValue);
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
  renderLeaderboard("leaderboardBody", "leaderboardEmpty");
  showScreen("leaderboardScreen");
}

function buildConfigControls() {
  const container = document.getElementById("tableCheckboxes");
  container.innerHTML = "";

  for (let table = 1; table <= 10; table++) {
    const label = document.createElement("label");
    label.className = "table-option";

    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.value = String(table);
    checkbox.checked = state.config.tables.includes(table);
    checkbox.addEventListener("change", handleTableChange);

    const text = document.createElement("span");
    text.textContent = `Table de ${table}`;

    label.append(checkbox, text);
    container.appendChild(label);
  }

  const timeLimit = document.getElementById("timeLimit");
  timeLimit.value = String(state.config.timePerQuestion);
  timeLimit.addEventListener("change", handleTimeChange);
  timeLimit.addEventListener("blur", handleTimeChange);
}

function syncConfigControls() {
  document.querySelectorAll("#tableCheckboxes input[type='checkbox']").forEach((checkbox) => {
    checkbox.checked = state.config.tables.includes(Number(checkbox.value));
  });
  document.getElementById("timeLimit").value = String(state.config.timePerQuestion);
}

function handleTableChange(event) {
  const checked = [...document.querySelectorAll("#tableCheckboxes input:checked")]
    .map((input) => Number(input.value))
    .sort((a, b) => a - b);

  const warning = document.getElementById("tableWarning");
  if (checked.length * checked.length < 10) {
    event.target.checked = true;
    warning.textContent = "Sélectionnez au moins 4 tables pour obtenir 10 calculs différents.";
    return;
  }

  warning.textContent = "";
  state.config.tables = checked;
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
  if (state.config.tables.length * state.config.tables.length < 10) {
    showScreen("configScreen");
    document.getElementById("tableWarning").textContent = "Sélectionnez au moins 4 tables pour obtenir 10 calculs différents.";
    return;
  }
  state.questions = generateUniqueQuestions(state.config.tables);
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

function generateUniqueQuestions(tables) {
  const pool = [];
  for (const a of tables) {
    for (const b of tables) {
      pool.push({ a, b });
    }
  }

  // Les nombres décochés sont exclus des deux facteurs, mais peuvent toujours apparaître comme résultat.
  // Fisher-Yates : chaque couple a × b n'apparaît qu'une seule fois dans la mission.
  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [pool[i], pool[j]] = [pool[j], pool[i]];
  }
  return pool.slice(0, 10);
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
  document.getElementById("question").textContent = `${q.a} × ${q.b}`;
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
    correctAnswer: q.a * q.b,
    userAnswer,
    correct: isCorrect,
    timedOut,
    time: Math.round(elapsed * 10) / 10
  });

  const answer = document.getElementById("answer");
  answer.disabled = true;

  const feedback = document.getElementById("feedback");
  if (isCorrect) {
    feedback.textContent = `Bravo ! ${q.a} × ${q.b} = ${q.a * q.b}`;
    feedback.className = "feedback correct";
  } else {
    feedback.textContent = `${timedOut ? "Temps écoulé" : "Faux"} — ${q.a} × ${q.b} = ${q.a * q.b}`;
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
  const usedTables = [...state.config.tables].sort((a, b) => a - b);

  state.finalScore = {
    score: state.score,
    time: totalTime,
    tables: usedTables
  };

  document.getElementById("scoreDisplay").textContent = `${message} Score : ${state.score}/10 — Temps : ${totalTime.toFixed(1)} s`;

  const reward = document.getElementById("missionReward");
  reward.className = `mission-reward${state.score === 10 ? " perfect" : ""}`;
  reward.textContent = state.score === 10
    ? "Fusée complète : décollage réussi !"
    : `Fusée construite à ${state.score}/10. Encore ${10 - state.score} pièce${10 - state.score > 1 ? "s" : ""} à gagner.`;

  renderDebrief();
  renderLeaderboard("resultLeaderboardBody", "resultLeaderboardEmpty");
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
    calculation.textContent = `${item.a} × ${item.b} = ${item.correctAnswer}`;

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
    tables: [...state.finalScore.tables],
    date: new Date().toISOString()
  });
  saveScores(scores);
  state.savedCurrentResult = true;
  renderLeaderboard("resultLeaderboardBody", "resultLeaderboardEmpty");
  return true;
}

// Fonction UNIQUE utilisée par le classement du menu ET par celui de fin de mission.
function renderLeaderboard(tbodyId, emptyStateId) {
  const tbody = document.getElementById(tbodyId);
  const emptyState = document.getElementById(emptyStateId);
  const scores = getTopScores(20);
  tbody.innerHTML = "";

  if (scores.length === 0) {
    emptyState.hidden = false;
    tbody.closest("table").hidden = true;
    return;
  }

  emptyState.hidden = true;
  tbody.closest("table").hidden = false;

  scores.forEach((entry) => {
    const row = document.createElement("tr");

    const name = document.createElement("td");
    name.textContent = entry.name;

    const score = document.createElement("td");
    score.textContent = `${entry.score}/10`;

    const time = document.createElement("td");
    time.textContent = `${Number(entry.time).toFixed(1)} s`;

    const tables = document.createElement("td");
    tables.textContent = entry.tables.length ? entry.tables.join(", ") : "—";

    row.append(name, score, time, tables);
    tbody.appendChild(row);
  });
}

function getTopScores(limit) {
  return loadScores()
    .map(normalizeScore)
    .filter(Boolean)
    .sort((a, b) => (b.score - a.score) || (a.time - b.time))
    .slice(0, limit);
}

function normalizeScore(entry) {
  if (!entry || typeof entry !== "object") return null;
  const name = String(entry.name ?? "").trim();
  const score = Number(entry.score);
  const time = Number(entry.time);
  const tables = Array.isArray(entry.tables)
    ? entry.tables.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10).sort((a,b) => a-b)
    : [];

  if (!name || !Number.isFinite(score) || !Number.isFinite(time)) return null;
  return { name, score, time, tables, date: entry.date || "" };
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
  try {
    const raw = localStorage.getItem(STORAGE.config);
    if (raw) {
      const parsed = JSON.parse(raw);
      return normalizeConfig(parsed);
    }

    const legacyTablesRaw = localStorage.getItem(STORAGE.legacyTables);
    const legacyTimeRaw = localStorage.getItem(STORAGE.legacyTime);
    if (legacyTablesRaw || legacyTimeRaw) {
      return normalizeConfig({
        tables: legacyTablesRaw ? JSON.parse(legacyTablesRaw) : DEFAULT_CONFIG.tables,
        timePerQuestion: legacyTimeRaw ? Number(legacyTimeRaw) : DEFAULT_CONFIG.timePerQuestion
      });
    }
  } catch {
    // Valeurs par défaut ci-dessous.
  }
  return { ...DEFAULT_CONFIG, tables: [...DEFAULT_CONFIG.tables] };
}

function normalizeConfig(config) {
  let tables = Array.isArray(config?.tables)
    ? config.tables.map(Number).filter((n) => Number.isInteger(n) && n >= 1 && n <= 10)
    : [...DEFAULT_CONFIG.tables];
  tables = [...new Set(tables)].sort((a, b) => a - b);
  if (tables.length === 0) tables = [...DEFAULT_CONFIG.tables];

  let timePerQuestion = Number(config?.timePerQuestion);
  if (!Number.isFinite(timePerQuestion)) timePerQuestion = DEFAULT_CONFIG.timePerQuestion;
  timePerQuestion = Math.min(60, Math.max(1, Math.round(timePerQuestion * 10) / 10));

  return { tables, timePerQuestion };
}

function saveConfig() {
  localStorage.setItem(STORAGE.config, JSON.stringify(state.config));
}

function migrateLegacyScoresIfPossible() {
  if (localStorage.getItem(STORAGE.scores)) return;

  try {
    const legacyRaw = localStorage.getItem(STORAGE.legacyScores);
    if (!legacyRaw) return;
    const legacy = JSON.parse(legacyRaw);
    if (!Array.isArray(legacy)) return;
    const normalized = legacy.map(normalizeScore).filter(Boolean);
    if (normalized.length > 0) saveScores(normalized);
  } catch {
    // Pas de migration si l'ancien format est invalide.
  }
}
