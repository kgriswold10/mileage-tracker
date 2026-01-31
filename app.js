/* Mileage Tracker - Fast Load + Week->Day input + multi-entry/day cumulative
   - Warm-up ping
   - LocalStorage cache (config + weeks + per-week details)
   - Render from cache instantly, refresh in background
   - AbortController timeouts to avoid hanging loads
*/

/** =========================
 *  1) CONFIG - SET THIS
 *  =========================
 *  Put your Cloudflare Worker URL here (preferred).
 *  If you're calling Apps Script directly, use that /exec URL instead.
 */
const API_BASE_URL =
  window.API_BASE_URL || "https://lively-sunset-250f.kgriswold10.workers.dev/"; // <-- change me

/** Local cache keys */
const CACHE_KEYS = {
  config: "mt_cache_config_v1",
  weeks: "mt_cache_weeks_v1",
  weekDetailsPrefix: "mt_cache_week_details_v1_", // + weekId + "_" + person
};

const REQUEST_TIMEOUT_MS = 25000;
const SOFT_REFRESH_AFTER_MS = 20_000;

/** =========================
 *  2) DOM (initialized after DOMContentLoaded)
 *  ========================= */
let els = null;

function mustGet(id) {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing required DOM element: #${id}`);
  return el;
}

function initEls() {
  // If any of these IDs don't exist in your HTML, init will fail with a clear message.
  els = {
    netPill: mustGet("netPill"),
    statusLine: mustGet("statusLine"),

    personSkeleton: document.getElementById("personSkeleton"),
    weekSkeleton: document.getElementById("weekSkeleton"),
    daySkeleton: document.getElementById("daySkeleton"),

    personSelect: mustGet("personSelect"),
    weekSelect: mustGet("weekSelect"),
    daySelect: mustGet("daySelect"),

    categorySelect: mustGet("categorySelect"),
    milesInput: mustGet("milesInput"),
    addBtn: mustGet("addBtn"),
    refreshBtn: mustGet("refreshBtn"),

    weekTotal: mustGet("weekTotal"),
    dayTotal: mustGet("dayTotal"),
    weekRange: mustGet("weekRange"),

    entriesList: mustGet("entriesList"),
  };
}

/** =========================
 *  3) STATE
 *  ========================= */
const state = {
  config: null,
  weeks: [],
  selectedPerson: null,
  selectedWeekId: null,
  selectedDayISO: null,
  selectedCategory: null,
  weekDetails: null,
};

/** =========================
 *  0) BOOT (DON’T TOUCH)
 *  =========================
 * Ensures DOM exists before we touch document.getElementById.
 */
window.addEventListener("error", (ev) => {
  console.error("Window error:", ev.error || ev.message);
});
window.addEventListener("unhandledrejection", (ev) => {
  console.error("Unhandled rejection:", ev.reason);
});

document.addEventListener("DOMContentLoaded", () => {
  try {
    initEls();
  } catch (e) {
    console.error(e);
    // Can't call setStatus safely if els didn't initialize; use alert as last resort.
    alert(e?.message || String(e));
    return;
  }

  init().catch((e) => {
    console.error(e);
    setStatus(`Load failed: ${e?.message || e}`, true);
    setNetPill("Load failed", "danger");
  });
});

/** =========================
 *  4) INIT
 *  ========================= */
 document.addEventListener("click", (e) => {
  // shows what element actually receives the click
  console.log("CLICK TARGET:", e.target?.id || e.target?.className || e.target?.tagName);
}, true); // capture phase


async function init() {
  wireEvents();

  // Warm-up ping immediately (don’t block UI)
  warmUpPing();

  // Render from cache ASAP (instant UI if present)
  const cachedConfig = readCache(CACHE_KEYS.config);
  const cachedWeeks = readCache(CACHE_KEYS.weeks);

  if (cachedConfig?.data) {
    state.config = cachedConfig.data;
    renderConfig(state.config);
  }
  if (cachedWeeks?.data) {
    state.weeks = cachedWeeks.data;
    renderWeeks(state.weeks);
  }

  if (cachedConfig?.data || cachedWeeks?.data) {
    setStatus("Loaded from cache — refreshing…");
    setNetPill("Cached", "ok");
  } else {
    setStatus("Loading…");
    setNetPill("Loading", "muted");
  }

  await loadFreshBootstrap();

  // Defaults
  if (!state.selectedPerson && state.config?.people?.length) {
    state.selectedPerson = state.config.people[0];
    els.personSelect.value = state.selectedPerson;
  }
  if (!state.selectedWeekId && state.weeks?.length) {
    state.selectedWeekId = state.weeks[0].weekId;
    els.weekSelect.value = state.selectedWeekId;
  }

  // Populate day dropdown based on selected week
  syncDayDropdown();

  // Load week details
  if (state.selectedWeekId && state.selectedPerson) {
    await loadWeekDetails(state.selectedWeekId, state.selectedPerson);
  }

  setStatus("Ready.");
  setNetPill("Ready", "ok");
}
// Emergency CSS override: ensure selects are clickable
const style = document.createElement("style");
style.textContent = `
  #personSelect, #weekSelect, #daySelect, #categorySelect {
    pointer-events: auto !important;
    position: relative !important;
    z-index: 99999 !important;
  }
  #personSkeleton, #weekSkeleton, #daySkeleton {
    display: none !important;
    pointer-events: none !important;
  }
`;
document.head.appendChild(style);

/** =========================
 *  5) EVENTS
 *  ========================= */
function wireEvents() {
  // Defensive: ensure selects exist & are interactive
  els.personSelect.disabled = false;
  els.weekSelect.disabled = false;
  els.daySelect.disabled = false;

  els.personSelect.addEventListener("change", async () => {
    try {
      state.selectedPerson = els.personSelect.value;
      console.log("person change fired:", state.selectedPerson);

      setStatus("Person changed — loading…");
      setNetPill("Loading", "muted");

      if (state.selectedWeekId) {
        await loadWeekDetails(state.selectedWeekId, state.selectedPerson);
      }

      setStatus("Ready.");
      setNetPill("Ready", "ok");
    } catch (e) {
      console.error("person change failed", e);
      setStatus(`Person change failed: ${e?.message || e}`, true);
      setNetPill("Failed", "danger");
    }
  });

  els.weekSelect.addEventListener("change", async () => {
    try {
      state.selectedWeekId = els.weekSelect.value;
      console.log("week change fired:", state.selectedWeekId);

      setStatus("Week changed — loading…");
      setNetPill("Loading", "muted");

      syncDayDropdown();

      if (state.selectedWeekId && state.selectedPerson) {
        await loadWeekDetails(state.selectedWeekId, state.selectedPerson);
      }

      setStatus("Ready.");
      setNetPill("Ready", "ok");
    } catch (e) {
      console.error("week change failed", e);
      setStatus(`Week change failed: ${e?.message || e}`, true);
      setNetPill("Failed", "danger");
    }
  });

  els.daySelect.addEventListener("change", () => {
    state.selectedDayISO = els.daySelect.value;
    console.log("day change fired:", state.selectedDayISO);
    renderTotals();
  });

  els.categorySelect.addEventListener("change", () => {
    state.selectedCategory = els.categorySelect.value;
  });

  els.addBtn.addEventListener("click", async () => {
    await handleAddEntry();
  });

  els.refreshBtn.addEventListener("click", async () => {
    await loadFreshBootstrap(true);
    if (state.selectedWeekId && state.selectedPerson) {
      await loadWeekDetails(state.selectedWeekId, state.selectedPerson, true);
    }
  });
}

/** =========================
 *  6) LOADERS (FAST)
 *  ========================= */
async function loadFreshBootstrap(force = false) {
  const now = Date.now();

  const cachedConfig = readCache(CACHE_KEYS.config);
  const cachedWeeks = readCache(CACHE_KEYS.weeks);

  const configFreshEnough =
    cachedConfig?.ts && now - cachedConfig.ts < SOFT_REFRESH_AFTER_MS;
  const weeksFreshEnough =
    cachedWeeks?.ts && now - cachedWeeks.ts < SOFT_REFRESH_AFTER_MS;

  if (!force && configFreshEnough && weeksFreshEnough) return;

  setStatus(force ? "Refreshing…" : "Refreshing (background)…");

  const [config, weeks] = await Promise.all([apiGet("/config"), apiGet("/weeks")]);

  if (config) {
    state.config = config;
    writeCache(CACHE_KEYS.config, config);
    renderConfig(config);
  }

  if (Array.isArray(weeks)) {
    state.weeks = weeks;
    writeCache(CACHE_KEYS.weeks, weeks);
    renderWeeks(weeks);
  }

  showSelect(els.personSkeleton, els.personSelect);
  showSelect(els.weekSkeleton, els.weekSelect);
  showSelect(els.daySkeleton, els.daySelect);
}

async function loadWeekDetails(weekId, person, force = false) {
  const cacheKey = CACHE_KEYS.weekDetailsPrefix + weekId + "_" + person;
  const cached = readCache(cacheKey);

  if (!force && cached?.data) {
    state.weekDetails = normalizeWeekDetails(cached.data, weekId);
    renderWeekDetails();
    setStatus("Week loaded (cached) — refreshing…");
  } else {
    setStatus("Loading week details…");
  }

  const now = Date.now();
  const freshEnough = cached?.ts && now - cached.ts < SOFT_REFRESH_AFTER_MS;
  if (!force && freshEnough) {
    setStatus("Ready.");
    return;
  }

  try {
    const details = await apiGet(
      `/week?weekId=${encodeURIComponent(weekId)}&person=${encodeURIComponent(person)}`
    );
    if (details) {
      state.weekDetails = normalizeWeekDetails(details, weekId);
      writeCache(cacheKey, state.weekDetails);
      renderWeekDetails();
      setStatus("Ready.");
    }
  } catch (e) {
    if (!cached?.data) {
      setStatus(`Week load failed: ${e?.message || e}`, true);
      setNetPill("Offline?", "danger");
    } else {
      setStatus("Using cached week (refresh failed).", true);
      setNetPill("Cached", "ok");
    }
  }
}

/** =========================
 *  7) ADD ENTRY
 *  ========================= */
async function handleAddEntry() {
  const weekId = state.selectedWeekId;
  const person = state.selectedPerson;
  const dayISO = els.daySelect.value;
  const category = els.categorySelect.value;
  const milesStr = (els.milesInput.value || "").trim();

  if (!weekId || !person || !dayISO || !category) {
    setStatus("Missing selection (person/week/day/category).", true);
    return;
  }

  const miles = parseFloat(milesStr);
  if (!Number.isFinite(miles) || miles <= 0) {
    setStatus("Enter a valid miles number (e.g., 2.5).", true);
    return;
  }

  els.addBtn.disabled = true;
  setStatus("Adding entry…");

  const entry = {
    id: `local_${cryptoRandom()}`,
    person,
    weekId,
    dateISO: dayISO,
    category,
    miles,
    ts: new Date().toISOString(),
  };

  ensureWeekDetailsForOptimism(weekId);
  state.weekDetails.entries.push(entry);
  renderWeekDetails();
  els.milesInput.value = "";

  try {
    await apiPost("/entry", entry);
    await loadWeekDetails(weekId, person, true);
    setStatus("Entry added.");
    setNetPill("Synced", "ok");
  } catch (e) {
    state.weekDetails.entries = state.weekDetails.entries.filter((x) => x.id !== entry.id);
    renderWeekDetails();

    setStatus(`Add failed: ${e?.message || e}`, true);
    setNetPill("Failed", "danger");
  } finally {
    els.addBtn.disabled = false;
  }
}

function ensureWeekDetailsForOptimism(weekId) {
  if (state.weekDetails && state.weekDetails.weekId === weekId) return;

  const weekMeta = (state.weeks || []).find((w) => w.weekId === weekId) || {};
  state.weekDetails = {
    weekId,
    startDate: weekMeta.startDate || null,
    endDate: weekMeta.endDate || null,
    entries: [],
  };
}

/** =========================
 *  8) RENDER
 *  ========================= */
function renderConfig(config) {
  const people = Array.isArray(config.people) ? config.people : [];
  if (people.length) {
    els.personSelect.innerHTML = people
      .map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`)
      .join("");
    showSelect(els.personSkeleton, els.personSelect);
    if (!state.selectedPerson) {
      state.selectedPerson = people[0];
      els.personSelect.value = state.selectedPerson;
    }
  }

  const categories = Array.isArray(config.categories)
    ? config.categories
    : ["Walk", "Bike", "Other"];

  els.categorySelect.innerHTML = categories
    .map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`)
    .join("");

  if (!state.selectedCategory) {
    state.selectedCategory = categories[0];
    els.categorySelect.value = state.selectedCategory;
  }
}

function renderWeeks(weeks) {
  const safeWeeks = Array.isArray(weeks) ? weeks : [];
  if (!safeWeeks.length) return;

  els.weekSelect.innerHTML = safeWeeks
    .map((w) => {
      const label = weekLabel(w);
      return `<option value="${escapeHtml(w.weekId)}">${escapeHtml(label)}</option>`;
    })
    .join("");

  showSelect(els.weekSkeleton, els.weekSelect);

  if (!state.selectedWeekId) {
    state.selectedWeekId = safeWeeks[0].weekId;
    els.weekSelect.value = state.selectedWeekId;
  }
}

function syncDayDropdown() {
  const weekId = state.selectedWeekId;
  const w = (state.weeks || []).find((x) => x.weekId === weekId);

  if (!w?.startDate) {
    els.daySelect.innerHTML = `<option value="">Select a week first</option>`;
    showSelect(els.daySkeleton, els.daySelect);
    return;
  }

  const days = buildWeekDays(w.startDate);
  els.daySelect.innerHTML = days
    .map((d) => {
      const label = dayLabel(d);
      return `<option value="${escapeHtml(d)}">${escapeHtml(label)}</option>`;
    })
    .join("");

  showSelect(els.daySkeleton, els.daySelect);

  if (!state.selectedDayISO || !days.includes(state.selectedDayISO)) {
    state.selectedDayISO = days[0];
    els.daySelect.value = state.selectedDayISO;
  } else {
    els.daySelect.value = state.selectedDayISO;
  }

  const start = new Date(w.startDate);
  const end = new Date(days[6] + "T00:00:00");
  els.weekRange.textContent = `Week: ${formatShort(start)} – ${formatShort(end)}`;
}

function renderWeekDetails() {
  renderEntriesList();
  renderTotals();
}

function renderEntriesList() {
  const details = state.weekDetails;
  if (!details || !Array.isArray(details.entries)) {
    els.entriesList.innerHTML = `<div class="small muted">No entries.</div>`;
    return;
  }

  const entries = [...details.entries]
    .map((e) => normalizeEntry(e))
    .sort((a, b) => (b.ts || "").localeCompare(a.ts || ""));

  if (!entries.length) {
    els.entriesList.innerHTML = `<div class="small muted">No entries for this week yet.</div>`;
    return;
  }

  els.entriesList.innerHTML = entries
    .map((e) => {
      const left = `
        <div>
          <div><strong>${escapeHtml(dayLabel(e.dateISO))}</strong> • ${escapeHtml(
        e.category || ""
      )}</div>
          <div class="small muted">${escapeHtml(e.person || "")} • ${escapeHtml(
        new Date(e.ts).toLocaleString()
      )}</div>
        </div>
      `;
      const right = `<div style="text-align:right; min-width:90px;"><strong>${formatMiles(
        e.miles
      )}</strong><div class="small muted">mi</div></div>`;
      return `<div class="list-item">${left}${right}</div>`;
    })
    .join("");
}

function renderTotals() {
  const details = state.weekDetails;
  const dayISO = state.selectedDayISO;

  let weekTotal = 0;
  let dayTotal = 0;

  if (details?.entries?.length) {
    for (const raw of details.entries) {
      const e = normalizeEntry(raw);
      const m = Number(e.miles) || 0;
      weekTotal += m;
      if (dayISO && e.dateISO === dayISO) dayTotal += m;
    }
  }

  els.weekTotal.textContent = formatMiles(weekTotal);
  els.dayTotal.textContent = formatMiles(dayTotal);
}

/** =========================
 *  9) API (COMPAT MODE)
 *  ========================= */
async function apiGet(path) {
  return smartRequest("GET", path, null);
}
async function apiPost(path, body) {
  return smartRequest("POST", path, body);
}

async function smartRequest(method, path, body) {
  const base = (API_BASE_URL || "").trim();
  if (!base) throw new Error("API_BASE_URL not set");

  const { op, query } = parseOpAndQuery(path);

  const candidates = [];
  candidates.push(joinUrl(base, `/${op}${query ? `?${query}` : ""}`));
  candidates.push(joinUrl(base, `?action=${encodeURIComponent(op)}${query ? `&${query}` : ""}`));
  candidates.push(joinUrl(base, `?route=${encodeURIComponent(op)}${query ? `&${query}` : ""}`));
  candidates.push(joinUrl(base, `?op=${encodeURIComponent(op)}${query ? `&${query}` : ""}`));

  let lastErr = null;

  for (const url of candidates) {
    try {
      if (method === "GET") {
        return await fetchJsonWithTimeout(url, { method: "GET" });
      }

      try {
        return await fetchJsonWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
      } catch {
        const form = new URLSearchParams();
        form.set("op", op);
        form.set("action", op);
        form.set("route", op);
        form.set("payload", JSON.stringify(body ?? {}));

        return await fetchJsonWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8" },
          body: form.toString(),
        });
      }
    } catch (err) {
      lastErr = err;
    }
  }

  throw new Error(`All endpoint styles failed for op="${op}". Last error: ${lastErr?.message || lastErr}`);
}

function parseOpAndQuery(path) {
  const clean = String(path || "").trim();
  const noLeading = clean.startsWith("/") ? clean.slice(1) : clean;
  const [rawOp, rawQuery] = noLeading.split("?");
  const op = (rawOp || "").trim();
  const query = (rawQuery || "").trim();
  return { op, query };
}

function joinUrl(base, suffix) {
  if (suffix.startsWith("?")) return base + suffix;
  return base.replace(/\/$/, "") + suffix;
}

async function fetchJsonWithTimeout(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, { ...init, signal: ctrl.signal, cache: "no-store" });

    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ""} @ ${url}`);
    }

    const text = await res.text();
    if (!text) return null;

    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } finally {
    clearTimeout(t);
  }
}

/** =========================
 *  10) CACHE
 *  ========================= */
function writeCache(key, data) {
  try {
    localStorage.setItem(key, JSON.stringify({ ts: Date.now(), data }));
  } catch {}
}
function readCache(key) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** =========================
 *  11) HELPERS / NORMALIZERS
 *  ========================= */
function normalizeWeekDetails(details, weekId) {
  return {
    weekId: details.weekId || weekId,
    startDate: details.startDate || details.start || details.weekStart || null,
    endDate: details.endDate || details.end || details.weekEnd || null,
    entries: Array.isArray(details.entries)
      ? details.entries
      : Array.isArray(details.data)
      ? details.data
      : [],
  };
}

function normalizeEntry(e) {
  const dateISO = e.dateISO || e.date || e.day || e.entryDate || null;

  return {
    id: e.id || e.entryId || e.uuid || null,
    person: e.person || e.name || null,
    weekId: e.weekId || null,
    dateISO: toISODate(dateISO),
    category: e.category || e.type || null,
    miles: Number(e.miles ?? e.distance ?? 0),
    ts: e.ts || e.timestamp || e.createdAt || new Date().toISOString(),
  };
}

function weekLabel(w) {
  const start = w.startDate ? new Date(w.startDate) : null;
  const end = w.endDate ? new Date(w.endDate) : null;

  const wn = w.weekNum != null ? `W${w.weekNum}` : w.weekId ? w.weekId : "Week";
  if (start && end) return `${wn} • ${formatShort(start)} – ${formatShort(end)}`;
  if (start) return `${wn} • ${formatShort(start)} – +6d`;
  return `${wn}`;
}

function buildWeekDays(startDate) {
  const start = new Date(startDate);
  const days = [];
  const d0 = new Date(start.getFullYear(), start.getMonth(), start.getDate());
  for (let i = 0; i < 7; i++) {
    const di = new Date(d0);
    di.setDate(d0.getDate() + i);
    days.push(toISODate(di));
  }
  return days;
}

function dayLabel(isoDate) {
  const d = new Date(isoDate + "T00:00:00");
  const wk = d.toLocaleDateString(undefined, { weekday: "short" });
  const md = d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${wk} • ${md}`;
}

function toISODate(input) {
  if (!input) return null;
  if (typeof input === "string") {
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  if (input instanceof Date) {
    return `${input.getFullYear()}-${pad2(input.getMonth() + 1)}-${pad2(input.getDate())}`;
  }
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pad2(n) {
  return String(n).padStart(2, "0");
}

function formatShort(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatMiles(n) {
  const s = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  return s.replace(/\.?0+$/, "");
}

function showSelect(skel, sel) {
  if (skel) {
    skel.style.display = "none";
    skel.style.pointerEvents = "none";
  }
  if (sel) {
    sel.style.display = "";
    sel.disabled = false;
    sel.style.pointerEvents = "auto";
    sel.style.position = "relative";
    sel.style.zIndex = "2";
  }
}

function setStatus(msg, isError = false) {
  if (!els?.statusLine) return;
  els.statusLine.textContent = msg;
  els.statusLine.className = "status " + (isError ? "danger" : "");
}

function setNetPill(text, tone) {
  if (!els?.netPill) return;
  els.netPill.textContent = text;
  els.netPill.className =
    "pill " + (tone === "danger" ? "danger" : tone === "ok" ? "ok" : "muted");
}

function escapeHtml(s) {
  return String(s ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

async function safeText(res) {
  try {
    return (await res.text()).slice(0, 200);
  } catch {
    return "";
  }
}

/** =========================
 *  12) WARM-UP PING (FIXED)
 *  =========================
 * - Must exist
 * - Must never throw
 * - Tries REST + GAS query styles
 */
function warmUpPing() {
  try {
    const base = (API_BASE_URL || "").trim();
    if (!base) return;

    const baseNoSlash = base.replace(/\/$/, "");
    const urls = [
      `${baseNoSlash}/ping`,
      `${baseNoSlash}?action=ping`,
      `${baseNoSlash}?route=ping`,
      `${baseNoSlash}?op=ping`,
      `${baseNoSlash}/`,
    ];

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000);

    Promise.race(
      urls.map((u) =>
        fetch(u, {
          method: "GET",
          cache: "no-store",
          signal: ctrl.signal,
        }).catch(() => null)
      )
    ).finally(() => clearTimeout(t));
  } catch {
    // never throw
  }
}

// Alias in case older call exists
function warmupPing() {
  return warmUpPing();
}

function cryptoRandom() {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(16) + a[1].toString(16);
  } catch {
    return Math.random().toString(16).slice(2);
  }
}
