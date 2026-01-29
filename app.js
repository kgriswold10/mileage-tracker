// === YOUR CONFIG ===
const API_URL = "https://lively-sunset-250f.kgriswold10.workers.dev/";
const API_KEY = "AKfycbyCjgHj0DKECwpO7xE4RUe84vW3eSaaTuZmGS1UJpjoWMhSAbe1uY7gZjpVT3fI-xdauw";
// ===================

let state = { config: null, weeks: [], entries: [] };

const $ = (id) => document.getElementById(id);
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

function computeWeeklyTotal() {
  const total = Number($("walk").value || 0) + Number($("bike").value || 0) + Number($("other").value || 0);
  $("weeklyTotal").textContent = fmt(total);
}

["walk", "bike", "other"].forEach((id) => $(id).addEventListener("input", computeWeeklyTotal));

function currentWeekNum() {
  const today = new Date();
  for (const w of state.weeks) {
    const s = new Date(w.startDate);
    const e = new Date(w.endDate);
    s.setHours(0,0,0,0);
    e.setHours(23,59,59,999);
    if (today >= s && today <= e) return w.weekNum;
  }
  return 1; 
}

function ytd(person, upToWeek) {
  return state.entries
    .filter((e) => e.person === person && e.weekNum <= upToWeek)
    .reduce((sum, e) => sum + e.weeklyTotal, 0);
}

function expected(weekNum) {
  return (state.config.annualGoal / 52) * weekNum;
}

function renderDashboard() {
  const cards = $("cards");
  cards.innerHTML = "";
  const wk = currentWeekNum();

  for (const p of state.config.people) {
    const y = ytd(p, wk);
    const exp = expected(wk);
    const diff = exp - y;
    const pct = y / state.config.annualGoal;
    const thisWeek = state.entries.find((e) => e.person === p && e.weekNum === wk);

    const div = document.createElement("div");
    div.className = "card";
    div.style.minWidth = "250px";
    div.innerHTML = `
      <div class="big">${p}</div>
      <div>YTD <span class="pill">${fmt(y)} mi</span></div>
      <div>% Goal <span class="pill">${fmt(pct * 100)}%</span></div>
      <div>${diff >= 0 ? "Behind" : "Ahead"} <span class="pill">${fmt(Math.abs(diff))} mi</span></div>
      <div>This Week <span class="pill">${fmt(thisWeek ? thisWeek.weeklyTotal : 0)} mi</span></div>
      <button class="secondary" data-person="${p}" data-week="${wk}">Edit This Week</button>
    `;
    div.querySelector("button").addEventListener("click", () => prefill(p, wk));
    cards.appendChild(div);
  }
}

function renderSelectors() {
  $("person").innerHTML = state.config.people.map((p) => `<option value="${p}">${p}</option>`).join("");

  $("week").innerHTML = state.weeks.map((w) => {
    const s = new Date(w.startDate).toLocaleDateString();
    const e = new Date(w.endDate).toLocaleDateString();
    return `<option value="${w.weekNum}">Week ${w.weekNum} (${s} – ${e})</option>`;
  }).join("");

  $("week").value = String(currentWeekNum());
}

function renderTable() {
  const tbody = $("entriesTable").querySelector("tbody");
  tbody.innerHTML = "";

  [...state.entries]
    .sort((a, b) => a.person.localeCompare(b.person) || a.weekNum - b.weekNum)
    .forEach((e) => {
      const tr = document.createElement("tr");
      tr.innerHTML = `
        <td>${e.person}</td>
        <td>${e.weekNum}</td>
        <td>${new Date(e.weekStart).toLocaleDateString()} – ${new Date(e.weekEnd).toLocaleDateString()}</td>
        <td>${fmt(e.walk)}</td>
        <td>${fmt(e.bike)}</td>
        <td>${fmt(e.other)}</td>
        <td><b>${fmt(e.weeklyTotal)}</b></td>
        <td>${e.updatedAt ? new Date(e.updatedAt).toLocaleString() : ""}</td>
      `;
      tbody.appendChild(tr);
    });
}

function prefill(person, week) {
  $("person").value = person;
  $("week").value = String(week);
  loadForm();
}

function loadForm() {
  const p = $("person").value;
  const w = Number($("week").value);
  const e = state.entries.find((x) => x.person === p && x.weekNum === w);
  $("walk").value = e ? e.walk : 0;
  $("bike").value = e ? e.bike : 0;
  $("other").value = e ? e.other : 0;
  computeWeeklyTotal();
}

$("person").addEventListener("change", loadForm);
$("week").addEventListener("change", loadForm);

async function loadData() {
  $("err").textContent = "";
  $("status").textContent = "Loading…";

  const res = await fetch(`${API_URL}?action=data&key=${encodeURIComponent(API_KEY)}`);
  const json = await res.json();

  if (json.error) throw new Error(json.error);

  state.config = json.config;
  state.weeks = json.weeks;
  state.entries = json.entries.filter((e) => e.year === state.config.year);

  $("status").textContent = "Loaded.";
  renderSelectors();
  loadForm();
  renderDashboard();
  renderTable();
}

async function saveEntry() {
  $("err").textContent = "";
  const payload = {
    action: "upsert",
    key: API_KEY,
    year: state.config.year,
    person: $("person").value,
    weekNum: Number($("week").value),
    walk: Number($("walk").value || 0),
    bike: Number($("bike").value || 0),
    other: Number($("other").value || 0),
  };

  const res = await fetch(API_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });

  const json = await res.json();
  if (json.error) throw new Error(json.error);

  await loadData();
}

$("refreshBtn").addEventListener("click", () => loadData().catch((e) => ($("err").textContent = String(e))));
$("saveBtn").addEventListener("click", () => saveEntry().catch((e) => ($("err").textContent = String(e))));

loadData().catch((e) => {
  $("status").textContent = "Not connected.";
  $("err").textContent = String(e);
});
