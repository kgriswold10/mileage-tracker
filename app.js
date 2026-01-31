// === CONFIG ===
const API_URL = "https://script.google.com/macros/s/AKfycbyCjgHj0DKECwpO7xE4RUe84vW3eSaaTuZmGS1UJpjoWMhSAbe1uY7gZjpVT3fI-xdauw/exec";

// IMPORTANT:
// This MUST match the value in your Config sheet "ApiKey" (not the script deployment ID).
const WRITE_API_KEY = "PASTE_YOUR_Config_ApiKey_HERE";
// ==============

let state = {
  config: null,   // {Year, AnnualGoal, People, Categories}
  weeks: [],      // [{weekNum, startDate, endDate}]
  progress: {},   // { [person]: {total, remaining, byCategory...} }
  currentWeek: null,
  currentWeekByPerson: {}, // { [person]: {weekTotal, dailyTotals, logs...} }
};

const $ = (id) => document.getElementById(id);
const fmt = (n) => (Math.round(n * 100) / 100).toFixed(2);

function computeWeeklyTotal() {
  const total =
    Number($("walk").value || 0) +
    Number($("bike").value || 0) +
    Number($("other").value || 0);
  $("weeklyTotal").textContent = fmt(total);
}
["walk", "bike", "other"].forEach((id) => $(id).addEventListener("input", computeWeeklyTotal));

function lsGet(key, maxAgeMs) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    const obj = JSON.parse(raw);
    if ((Date.now() - obj.t) > maxAgeMs) return null;
    return obj.v;
  } catch { return null; }
}
function lsSet(key, value) {
  try { localStorage.setItem(key, JSON.stringify({ t: Date.now(), v: value })); } catch {}
}

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

function getWeekObj(weekNum) {
  return state.weeks.find(w => Number(w.weekNum) === Number(weekNum)) || state.weeks[0] || null;
}

function renderSelectors() {
  $("person").innerHTML = state.config.People.map((p) => `<option value="${p}">${p}</option>`).join("");

  $("week").innerHTML = state.weeks.map((w) => {
    const s = new Date(w.startDate).toLocaleDateString();
    const e = new Date(w.endDate).toLocaleDateString();
    return `<option value="${w.weekNum}">Week ${w.weekNum} (${s} – ${e})</option>`;
  }).join("");

  const wk = currentWeekNum();
  $("week").value = String(wk);
  state.currentWeek = wk;
}

function renderDashboard() {
  const cards = $("cards");
  cards.innerHTML = "";

  const wk = state.currentWeek ?? currentWeekNum();
  const expected = (state.config.AnnualGoal / 52) * wk;

  for (const p of state.config.People) {
    const prog = state.progress[p] || { total: 0, byCategory: {}, remaining: state.config.AnnualGoal };
    const y = prog.total || 0;
    const diff = expected - y;
    const pct = state.config.AnnualGoal ? (y / state.config.AnnualGoal) : 0;

    const cw = state.currentWeekByPerson[p];
    const thisWeekTotal = cw ? cw.weekTotal : 0;

    const div = document.createElement("div");
    div.className = "card";
    div.style.minWidth = "250px";
    div.innerHTML = `
      <div class="big">${p}</div>
      <div>YTD <span class="pill">${fmt(y)} mi</span></div>
      <div>% Goal <span class="pill">${fmt(pct * 100)}%</span></div>
      <div>${diff >= 0 ? "Behind" : "Ahead"} <span class="pill">${fmt(Math.abs(diff))} mi</span></div>
      <div>This Week <span class="pill">${fmt(thisWeekTotal)} mi</span></div>
      <button class="secondary">Edit This Week</button>
    `;
    div.querySelector("button").addEventListener("click", () => prefill(p, wk));
    cards.appendChild(div);
  }
}

function prefill(person, weekNum) {
  $("person").value = person;
  $("week").value = String(weekNum);
  loadForm().catch(e => ($("err").textContent = String(e)));
}

async function apiGet(params) {
  const url = new URL(API_URL);
  Object.entries(params).forEach(([k, v]) => url.searchParams.set(k, String(v)));
  const res = await fetch(url.toString(), { method: "GET" });
  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "Request failed");
  return json;
}

async function apiPostForm(params) {
  // Sends as x-www-form-urlencoded so Code.gs reads e.parameter.*
  const url = new URL(API_URL);
  if (params.action) url.searchParams.set("action", params.action);

  const body = new URLSearchParams();
  Object.entries(params).forEach(([k, v]) => {
    if (k === "action") return;
    body.set(k, String(v));
  });

  const res = await fetch(url.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
    body: body.toString(),
  });

  const json = await res.json();
  if (!json.ok) throw new Error(json.error || "Request failed");
  return json;
}

async function loadBootstrap() {
  $("err").textContent = "";
  $("status").textContent = "Loading…";

  // show cached bootstrap immediately (1 hour)
  const cached = lsGet("bootstrap_v1", 60 * 60 * 1000);
  if (cached) {
    state.config = cached.config;
    state.weeks = cached.weeks;
    renderSelectors();
    computeWeeklyTotal();
    $("status").textContent = "Loaded (cached).";
    // background refresh
    refreshBootstrap().catch(() => {});
    return;
  }

  await refreshBootstrap();
}

async function refreshBootstrap() {
  const data = await apiGet({ action: "data" });
  // Backend returns config fields as Year/AnnualGoal/People/Categories (your Code.gs)
  state.config = data.config;
  state.weeks = data.weeks;

  lsSet("bootstrap_v1", { config: state.config, weeks: state.weeks });

  renderSelectors();
  computeWeeklyTotal();
  $("status").textContent = "Loaded.";
}

async function loadDashboardData() {
  // Fetch progress for each person (small responses)
  const year = state.config.Year;
  const people = state.config.People;

  const progressResults = await Promise.allSettled(
    people.map(p => apiGet({ action: "progress", year, person: p }))
  );

  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    const r = progressResults[i];
    if (r.status === "fulfilled") state.progress[p] = r.value;
  }

  // Fetch current week totals for each person (optional, but nice for dashboard)
  const wk = state.currentWeek ?? currentWeekNum();
  const weekResults = await Promise.allSettled(
    people.map(p => apiGet({ action: "week", year, person: p, weekNum: wk }))
  );
  for (let i = 0; i < people.length; i++) {
    const p = people[i];
    const r = weekResults[i];
    if (r.status === "fulfilled") state.currentWeekByPerson[p] = r.value;
  }

  renderDashboard();
}

async function loadForm() {
  $("err").textContent = "";
  const person = $("person").value;
  const wk = Number($("week").value);
  const year = state.config.Year;

  // Load week logs for that person/week
  const w = await apiGet({ action: "week", year, person, weekNum: wk });

  // Compute totals for Walk/Bike/Other from week logs
  const totals = { Walk: 0, Bike: 0, Other: 0 };
  for (const log of (w.logs || [])) {
    if (totals[log.category] == null) totals[log.category] = 0;
    totals[log.category] += Number(log.miles || 0);
  }

  $("walk").value = totals.Walk || 0;
  $("bike").value = totals.Bike || 0;
  $("other").value = totals.Other || 0;
  computeWeeklyTotal();
}

$("person").addEventListener("change", () => loadForm().catch(e => ($("err").textContent = String(e))));
$("week").addEventListener("change", () => {
  state.currentWeek = Number($("week").value);
  loadForm().catch(e => ($("err").textContent = String(e)));
  renderDashboard(); // quick rerender while data loads
});

async function saveEntry() {
  $("err").textContent = "";

  const year = state.config.Year;
  const person = $("person").value;
  const wk = Number($("week").value);
  const wObj = getWeekObj(wk);

  if (!wObj) throw new Error("Week not found");
  if (!WRITE_API_KEY) throw new Error("Missing WRITE_API_KEY (must match Config.ApiKey)");

  // We log the weekly amounts on the week's END date (inside range so it counts)
  const date = wObj.endDate;

  const walk = Number($("walk").value || 0);
  const bike = Number($("bike").value || 0);
  const other = Number($("other").value || 0);

  const tasks = [];
  if (walk > 0) tasks.push(apiPostForm({ action: "log", apiKey: WRITE_API_KEY, year, person, date, category: "Walk", miles: walk }));
  if (bike > 0) tasks.push(apiPostForm({ action: "log", apiKey: WRITE_API_KEY, year, person, date, category: "Bike", miles: bike }));
  if (other > 0) tasks.push(apiPostForm({ action: "log", apiKey: WRITE_API_KEY, year, person, date, category: "Other", miles: other }));

  if (tasks.length === 0) throw new Error("Miles must be > 0");

  $("status").textContent = "Saving…";
  await Promise.all(tasks);

  // Refresh only what we need (don’t re-bootstrap everything)
  await loadForm();
  await loadDashboardData();

  $("status").textContent = "Saved.";
}

$("refreshBtn").addEventListener("click", () => {
  loadBootstrap()
    .then(loadDashboardData)
    .catch((e) => { $("err").textContent = String(e); $("status").textContent = "Not connected."; });
});

$("saveBtn").addEventListener("click", () => {
  saveEntry().catch((e) => ($("err").textContent = String(e)));
});

// Start: load bootstrap fast, render UI, then fill dashboard async
loadBootstrap()
  .then(() => {
    renderDashboard();       // renders immediately (0s)
    return loadDashboardData(); // fills in numbers async
  })
  .catch((e) => {
    $("status").textContent = "Not connected.";
    $("err").textContent = String(e);
  });

