
function displayScoreTable(targetElementId) {
    const raw = localStorage.getItem('scores');
    const scores = raw ? JSON.parse(raw) : [];

    scores.sort((a, b) => b.score - a.score || a.time - b.time);
    const top20 = scores.slice(0, 20);

    const tbody = document.getElementById(targetElementId);
    if (!tbody) return;
    tbody.innerHTML = "";

    top20.forEach(entry => {
        const row = document.createElement("tr");
        row.innerHTML = `
            <td>${entry.name}</td>
            <td>${entry.score}</td>
            <td>${entry.time}</td>
            <td>${(entry.tables || []).join(", ")}</td>
        `;
        tbody.appendChild(row);
    });
}
