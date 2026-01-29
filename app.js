// ========= CONFIG YOU MUST SET =========
const API_BASE = "https://YOUR_WORKER_SUBDOMAIN.workers.dev"; // Cloudflare Worker URL
const API_KEY  = "YOUR_LONG_RANDOM_KEY"; // must match Config->ApiKey

// ========= STATE =========
let config = null;
let weeks = [];
let progressChart = null;

const el = (id) => document.getElementById(id);

function setStatus(msg, isError=false) {
  const s = el("status");
  s.textContent = msg || "";
  s.className = isError ? "danger" : "muted";
}

function fmt(n) {
  const x = Number(n || 0);
  return (Math.round(x * 100) / 100).toFixed(2);
}

function datesBetween(start, end) {
  const out = [];
  const d = new Date(start + "T00:00:00");
  const e = new Date(end + "T00:00:00");
  while (d <= e) {
    const yyyy = d.getFullYear();
    const mm = String(d.getMonth() + 1).padStart(2, "0");
    const dd = String(d.getDate()).padStart(2, "0");
    out.push(`${yyyy}-${mm}-${dd}`);
    d.setDate(d.getDate() + 1);
  }
  return out;
}

async function apiGet(params) {
  const url = new URL(API_BASE);
  Object.entries(params).forEach(([k,v]) => url.searchParams.set(k, v));
  const r = await fetch(url.toString(), { method: "GET" });
  return await r.json();
}

async function apiPost(form) {
  const body = new URLSearchParams(form);
  const r = await fetch(API_BASE, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body
  });
  return await r.json();
}

// ========= INIT =========
async function init() {
  // Tabs
  document.querySelectorAll(".tab").forEach(t => {
    t.addEventListener("click", () => {
      document.querySelectorAll(".tab").forEach(x => x.classList.remove("active"));
      t.classList.add("active");
      const tab = t.dataset.tab;
      el("tab-log").style.display = tab === "log" ? "block" : "none";
      el("tab-progress").style.display = tab === "progress" ? "block" : "none";
      if (tab === "progress") refreshProgress();
    });
  });

  // Load config + weeks
  setStatus("Loading...");
  const data = await apiGet({ action: "data" });
  if (!data.ok) {
    setStatus(data.error || "Failed to load", true);
    return;
  }

  config = data.config;
  weeks = data.weeks || [];

  // Populate dropdowns
  el("yearLabel").textContent = config.Year;

  el("person").innerHTML = config.People.map(p => `<option value="${p}">${p}</option>`).join("");
  el("category").innerHTML = config.Categories.map(c => `<option value="${c}">${c}</option>`).join("");

  el("week").innerHTML = weeks.map(w =>
    `<option value="${w.weekNum}">Week ${w.weekNum} (${w.startDate} → ${w.endDate})</option>`
  ).join("");

  // Default selections
  el("week").selectedIndex = Math.max(0, weeks.length - 1);

  // Wire events
  el("week").addEventListener("change", () => {
    rebuildDaySelect();
    refreshWeek();
  });
  el("person").addEventListener("change", () => {
    refreshWeek();
    refreshProgress();
  });

  el("addBtn").addEventListener("click", addLog);

  rebuildDaySelect();
  await refreshWeek();
  await refreshProgress();

  setStatus("");
}

function rebuildDaySelect() {
  const weekNum = parseInt(el("week").value, 10);
  const w = weeks.find(x => x.weekNum === weekNum);
  if (!w) return;

  const days = datesBetween(w.startDate, w.endDate);
  el("day").innerHTML = days.map(d => `<option value="${d}">${d}</option>`).join("");
  el("day").value = days[0];

  el("weekRange").textContent = `${w.startDate} → ${w.endDate}`;
}

async function refreshWeek() {
  const person = el("person").value;
  const weekNum = el("week").value;

  setStatus("Loading week...");
  const data = await apiGet({ action: "week", person, weekNum, year: config.Year });

  if (!data.ok) {
    setStatus(data.error || "Failed to load week", true);
    return;
  }

  el("weekTotal").textContent = fmt(data.weekTotal || 0);
  el("weekRange").textContent = `${data.week.startDate} → ${data.week.endDate}`;

  renderDailyTotals(data.dailyTotals || {}, data.week.startDate, data.week.endDate);
  renderLogs(data.logs || []);

  setStatus("");
}

function renderDailyTotals(dailyTotals, startDate, endDate) {
  const days = datesBetween(startDate, endDate);
  const cats = config.Categories;

  let html = `<table>
    <thead><tr>
      <th>Date</th>
      ${cats.map(c => `<th class="right">${c}</th>`).join("")}
      <th class="right">Day Total</th>
    </tr></thead><tbody>`;

  for (const d of days) {
    let dayTotal = 0;
    const row = dailyTotals[d] || {};
    html += `<tr><td>${d}</td>`;
    for (const c of cats) {
      const v = Number(row[c] || 0);
      dayTotal += v;
      html += `<td class="right">${fmt(v)}</td>`;
    }
    html += `<td class="right"><b>${fmt(dayTotal)}</b></td></tr>`;
  }

  html += `</tbody></table>`;
  el("dailyTotalsWrap").innerHTML = html;
}

function renderLogs(logs) {
  if (!logs.length) {
    el("logsWrap").innerHTML = `<div class="muted">No entries for this week.</div>`;
    return;
  }

  let html = `<table>
    <thead><tr>
      <th>Date</th>
      <th>Category</th>
      <th class="right">Miles</th>
      <th>Created</th>
      <th></th>
    </tr></thead><tbody>`;

  for (const l of logs) {
    html += `<tr>
      <td>${l.date}</td>
      <td>${l.category}</td>
      <td class="right"><b>${fmt(l.miles)}</b></td>
      <td class="muted">${l.createdAt}</td>
      <td class="right">
        <button data-logid="${l.logId}" class="delBtn">Delete</button>
      </td>
    </tr>`;
  }

  html += `</tbody></table>`;
  el("logsWrap").innerHTML = html;

  document.querySelectorAll(".delBtn").forEach(btn => {
    btn.addEventListener("click", async () => {
      const logId = btn.dataset.logid;
      await deleteLog(logId);
    });
  });
}

async function addLog() {
  const person = el("person").value;
  const date = el("day").value;
  const category = el("category").value;
  const miles = el("miles").value;

  if (!miles || Number(miles) <= 0) {
    setStatus("Miles must be > 0", true);
    return;
  }

  setStatus("Adding...");
  const res = await apiPost({
    action: "log",
    apiKey: API_KEY,
    year: config.Year,
    person,
    date,
    category,
    miles
  });

  if (!res.ok) {
    setStatus(res.error || "Failed to add", true);
    return;
  }

  el("miles").value = "";
  await refreshWeek();
  await refreshProgress();
  setStatus("");
}

async function deleteLog(logId) {
  if (!confirm("Delete this entry?")) return;

  setStatus("Deleting...");
  const res = await apiPost({
    action: "delete",
    apiKey: API_KEY,
    logId
  });

  if (!res.ok) {
    setStatus(res.error || "Failed to delete", true);
    return;
  }

  await refreshWeek();
  await refreshProgress();
  setStatus("");
}

async function refreshProgress() {
  if (!config) return;
  const person = el("person").value;

  const data = await apiGet({ action: "progress", person, year: config.Year });
  if (!data.ok) return;

  el("progTotal").textContent = fmt(data.total);
  el("progGoal").textContent = fmt(data.annualGoal);
  el("progRemaining").textContent = fmt(data.remaining);

  const completed = Number(data.total || 0);
  const remaining = Math.max(0, Number(data.annualGoal || 0) - completed);

  const ctx = el("progressChart");
  const chartData = {
    labels: ["Completed", "Remaining"],
    datasets: [{
      data: [completed, remaining]
    }]
  };

  if (!progressChart) {
    progressChart = new Chart(ctx, {
      type: "pie",
      data: chartData
    });
  } else {
    progressChart.data = chartData;
    progressChart.update();
  }
}

init();
