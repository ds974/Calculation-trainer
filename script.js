
let questions = [];
let currentIndex = 0;
let score = 0;
let startTime;
let timePerQuestion = 5;
let timer, countdown;
let corrections = [];
let answerTimes = [];
let usedTables = [];

document.addEventListener('DOMContentLoaded', () => {
    const ans = document.getElementById('answer');
    if (ans) {
        ans.addEventListener('input', () => {
            let q = questions[currentIndex];
            if (parseInt(ans.value) === q.a * q.b) {
                clearInterval(countdown);
                clearTimeout(timer);
                score++;
                recordAnswerTime(true);
                showFeedback(true, q);
                setTimeout(() => {
                    currentIndex++;
                    nextQuestion();
                }, 800);
            }
        });
        startGame();
    }
});

function startGame() {
    const tables = JSON.parse(localStorage.getItem("tables") || "[1,2,3,4,5,6,7,8,9,10]");
    usedTables = tables;
    timePerQuestion = parseFloat(localStorage.getItem("timeLimit") || "5");
    questions = [];
    corrections = [];
    answerTimes = [];
    score = 0;
    currentIndex = 0;

    const used = new Set();
    while (questions.length < 10) {
        let a = tables[Math.floor(Math.random() * tables.length)];
        let b = Math.floor(Math.random() * 10) + 1;
        let key = `${a}x${b}`;
        if (!used.has(key)) {
            questions.push({ a, b });
            used.add(key);
        }
    }

    startTime = Date.now();
    nextQuestion();
}

let questionStart;

function nextQuestion() {
    document.getElementById('feedback').innerHTML = '';
    if (currentIndex >= questions.length) {
        endGame();
        return;
    }

    let q = questions[currentIndex];
    document.getElementById('question').innerText = `${q.a} × ${q.b}`;
    document.getElementById('answer').value = '';
    document.getElementById('answer').focus();
    document.getElementById('time').innerText = timePerQuestion.toFixed(1);
    questionStart = Date.now();

    countdown = setInterval(() => {
        let elapsed = (Date.now() - questionStart) / 1000;
        let remaining = timePerQuestion - elapsed;
        document.getElementById('time').innerText = remaining.toFixed(1);
        if (remaining <= 0) {
            clearInterval(countdown);
            submitAnswer(true);
        }
    }, 100);

    timer = setTimeout(() => submitAnswer(true), timePerQuestion * 1000);
}

function showFeedback(isCorrect, q) {
    let fb = document.getElementById('feedback');
    if (isCorrect) {
        fb.innerHTML = "<span class='correct'>Bravo !</span>";
    } else {
        fb.innerHTML = `<span class='incorrect'>Faux. ${q.a} × ${q.b} = ${q.a * q.b}</span>`;
    }
}

function recordAnswerTime(correct) {
    let t = ((Date.now() - questionStart) / 1000).toFixed(1);
    answerTimes.push({ ...questions[currentIndex], correct, time: t });
}

function submitAnswer(timeout = false) {
    clearTimeout(timer);
    clearInterval(countdown);
    let q = questions[currentIndex];
    let userAnswer = parseInt(document.getElementById('answer').value);
    let isCorrect = !timeout && userAnswer === q.a * q.b;
    if (isCorrect) score++;
    recordAnswerTime(isCorrect);
    if (!isCorrect) corrections.push(`${q.a} × ${q.b} = ${q.a * q.b}`);
    showFeedback(isCorrect, q);
    currentIndex++;
    setTimeout(nextQuestion, 1000);
}

function endGame() {
    document.querySelector('.game').style.display = 'none';
    document.querySelector('.result').style.display = 'block';
    let totalTime = ((Date.now() - startTime) / 1000).toFixed(1);
    let message = score >= 8 ? "🎉 Excellent travail !" : score >= 5 ? "👍 Bien joué, continue ainsi !" : "💪 Ne lâche rien, tu progresses !";
    document.getElementById('scoreDisplay').innerText = `${message} Score : ${score}/10 — Temps : ${totalTime}s`;

    const feedbackBody = document.querySelector('#feedbackTable tbody');
    feedbackBody.innerHTML = "";
    answerTimes.forEach(q => {
        let row = document.createElement('tr');
        row.innerHTML = `<td class="${q.correct ? '' : 'incorrect'}">${q.a} × ${q.b} = ${q.a * q.b}</td>
                         <td class="${q.correct ? 'correct' : 'incorrect'}">${q.correct ? '✔' : '✘'}</td>
                         <td style="opacity:0.6">${q.time}</td>`;
        feedbackBody.appendChild(row);
    });

    window.finalScore = { score, time: totalTime, tables: usedTables };
    displayScoreTable('scoreTable');
}

function saveAndRestart() {
    saveScore();
    window.location.href = 'play.html';
}

function saveAndReturn() {
    saveScore();
    window.location.href = 'index.html';
}

function saveScore() {
    let name = document.getElementById('name').value.trim();
    if (!name) return;
    let entry = { name, score: window.finalScore.score, time: window.finalScore.time, tables: window.finalScore.tables };
    let scores = JSON.parse(localStorage.getItem('scores') || '[]');
    scores.push(entry);
    localStorage.setItem('scores', JSON.stringify(scores));
    displayScoreTable('scoreTable');
}
