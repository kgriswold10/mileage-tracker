/* Mileage Tracker - Fast Load + Week->Day input + multi-entry/day cumulative
   FIXED: dropdowns always visible & selectable
   - DOMContentLoaded boot (await init)
   - Warm-up ping (safe)
   - Cache render + background refresh
   - IMPORTANT FIX: loadFreshBootstrap() now ALWAYS reveals dropdowns
     even when it returns early due to "fresh enough" cache.
   - IMPORTANT FIX: defaults now run only after init + bootstrap
   - IMPORTANT FIX: cfg is always normalized and never undefined
   - IMPORTANT FIX: backend {ok:false,error:"..."} no longer breaks UI
*/

/** =========================
 *  1) CONFIG - SET THIS
 *  ========================= */
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

/** If nothing loads (no cache + API down), use these so UI is usable */
const DEFAULT_CONFIG = {
  year: new Date().getFullYear(),
  annualGoal: 1000,
  people: ["Mom", "Rob", "Kyle"],
  categories: ["Walk", "Bike", "Other"],
  apiKey: null,
};

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
 *  0) BOOT
 *  ========================= */
document.addEventListener("DOMContentLoaded", async () => {
  try {
    initEls();

    // Emergency CSS override: ensure selects are clickable and never hidden by skeleton overlays
    const style = document.createElement("style");
    style.textContent = `
      #personSelect, #weekSelect, #daySelect, #categorySelect {
        pointer-events: auto !important;
        position: relative !important;
        z-index: 99999 !important;
      }
      #personSkeleton, #weekSkeleton, #daySkeleton {
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);

    // IMPORTANT: wait for init to finish before anything else touches cfg/state
    await init();
  } catch (e) {
    console.error(e);
    setStatus(`Load failed: ${e?.message || e}`, true);
    setNetPill("Load failed", "danger");
    // Always reveal selects even if init fails (lets user interact with cached UI)
    forceRevealAllSelects();
  }
});

/** =========================
 *  4) INIT
 *  ========================= */
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
    // Show selects (even if empty) so layout is stable
    forceRevealAllSelects();
  }

  // Fetch fresh config/weeks (or keep cache if API fails)
  await loadFreshBootstrap();

  // Ensure we have *some* config/weeks so dropdowns work even when offline
  ensureFallbacksIfEmpty();

  // Defaults (safe; uses normalized config)
  applyDefaults();

  // Populate day dropdown based on selected week
  syncDayDropdown();

  // Load week details
  if (state.selectedWeekId && state.selectedPerson) {
    await loadWeekDetails(state.selectedWeekId, state.selectedPerson);
  }

  setStatus("Ready.");
  setNetPill("Ready", "ok");
}

function ensureFallbacksIfEmpty() {
  // Config fallback
  const cfg = normalizeConfig(state.config);
  if (!cfg.people.length || !cfg.categories.length) {
    state.config = normalizeConfig(DEFAULT_CONFIG);
    renderConfig(state.config);
  } else {
    state.config = cfg;
  }

  // Weeks fallback
  if (!Array.isArray(state.weeks) || !state.weeks.length) {
    const year = Number(state.config?.year) || new Date().getFullYear();
    state.weeks = generateWeeksMonSun(year);
    renderWeeks(state.weeks);
  }
}

function applyDefaults() {
  state.config = normalizeConfig(state.config);
  const cfg = state.config;

  if (!state.selectedPerson && cfg.people.length) {
    state.selectedPerson = cfg.people[0];
    els.personSelect.value = state.selectedPerson;
  } else if (state.selectedPerson) {
    els.personSelect.value = state.selectedPerson;
  }

  if (!state.selectedWeekId && state.weeks?.length) {
    state.selectedWeekId = state.weeks[0].weekId;
    els.weekSelect.value = state.selectedWeekId;
  } else if (state.selectedWeekId) {
    els.weekSelect.value = state.selectedWeekId;
  }

  if (!state.selectedCategory && cfg.categories.length) {
    state.selectedCategory = cfg.categories[0];
    els.categorySelect.value = state.selectedCategory;
  } else if (state.selectedCategory) {
    els.categorySelect.value = state.selectedCategory;
  }
}

/** =========================
 *  5) EVENTS
 *  ========================= */
function wireEvents() {
  // PERSON
  els.personSelect.addEventListener("change", async () => {
    state.selectedPerson = els.personSelect.value;
    if (state.selectedWeekId) {
      await loadWeekDetails(state.selectedWeekId, state.selectedPerson);
    }
  });

  // WEEK
  els.weekSelect.addEventListener("change", async () => {
    state.selectedWeekId = els.weekSelect.value;
    syncDayDropdown();
    if (state.selectedWeekId && state.selectedPerson) {
      await loadWeekDetails(state.selectedWeekId, state.selectedPerson);
    }
  });

  // DAY
  els.daySelect.addEventListener("change", () => {
    state.selectedDayISO = els.daySelect.value;
    renderTotals();
  });

  // CATEGORY
  els.categorySelect.addEventListener("change", () => {
    state.selectedCategory = els.categorySelect.value;
  });

  // BUTTONS
  els.addBtn.addEventListener("click", async () => {
    await handleAddEntry();
  });

  els.refreshBtn.addEventListener("click", async () => {
    await loadFreshBootstrap(true);
    ensureFallbacksIfEmpty();
    applyDefaults();
    syncDayDropdown();
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

  // IMPORTANT FIX:
  // Even when we skip fetching due to fresh cache, we still must reveal selects.
  if (!force && configFreshEnough && weeksFreshEnough) {
    forceRevealAllSelects();
    return;
  }

  setStatus(force ? "Refreshing…" : "Refreshing (background)…");

  try {
    const [configRaw, weeksRaw] = await Promise.all([apiGet("/config"), apiGet("/weeks")]);

    const config = unwrapOk(configRaw);
    const weeks = unwrapOk(weeksRaw);

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
  } catch (e) {
    // If API fails, keep whatever cache we had and keep UI usable
    setStatus(`Using cache (refresh failed): ${e?.message || e}`, true);
    setNetPill("Cached", "ok");
  }

  forceRevealAllSelects();
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
    const raw = await apiGet(
      `/week?weekId=${encodeURIComponent(weekId)}&person=${encodeURIComponent(person)}`
    );
    const details = unwrapOk(raw);

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
    const res = await apiPost("/entry", entry);
    unwrapOk(res);
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
function normalizeConfig(cfg) {
  // Some backends return { config: {...}, weeks: [...] }
  let c = cfg;
  if (c && typeof c === "object" && c.config && typeof c.config === "object") c = c.config;
  c = (c && typeof c === "object") ? c : {};

  const out = {
    year: c.year ?? DEFAULT_CONFIG.year,
    annualGoal: c.annualGoal ?? DEFAULT_CONFIG.annualGoal,
    apiKey: c.apiKey ?? DEFAULT_CONFIG.apiKey,
    people: Array.isArray(c.people) ? c.people : [],
    categories: Array.isArray(c.categories) ? c.categories : [],
  };

  // If the object exists but arrays are missing, don't force defaults here;
  // fallback logic handles it. But we *do* ensure arrays exist.
  return out;
}

function setSelectOptions(selectEl, values, placeholder) {
  const arr = Array.isArray(values) ? values : [];
  if (!arr.length) {
    selectEl.innerHTML = `<option value="">${escapeHtml(placeholder || "—")}</option>`;
    return;
  }
  selectEl.innerHTML = arr
    .map((v) => `<option value="${escapeHtml(v)}">${escapeHtml(v)}</option>`)
    .join("");
}

function renderConfig(config) {
  const cfg = normalizeConfig(config);

  // People
  const people = Array.isArray(cfg.people) ? cfg.people : [];
  setSelectOptions(els.personSelect, people, "No people yet");
  showSelect(els.personSkeleton, els.personSelect);

  if (!state.selectedPerson && people.length) {
    state.selectedPerson = people[0];
    els.personSelect.value = state.selectedPerson;
  }

  // Categories
  const categories = Array.isArray(cfg.categories) ? cfg.categories : ["Walk", "Bike", "Other"];
  setSelectOptions(els.categorySelect, categories, "No categories");
  if (!state.selectedCategory && categories.length) {
    state.selectedCategory = categories[0];
    els.categorySelect.value = state.selectedCategory;
  }
}

function renderWeeks(weeks) {
  const safeWeeks = Array.isArray(weeks) ? weeks : [];
  if (!safeWeeks.length) {
    els.weekSelect.innerHTML = `<option value="">No weeks yet</option>`;
    showSelect(els.weekSkeleton, els.weekSelect);
    return;
  }

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
    .map((d) => `<option value="${escapeHtml(d)}">${escapeHtml(dayLabel(d))}</option>`)
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
          <div><strong>${escapeHtml(dayLabel(e.dateISO))}</strong> • ${escapeHtml(e.category || "")}</div>
          <div class="small muted">${escapeHtml(e.person || "")} • ${escapeHtml(new Date(e.ts).toLocaleString())}</div>
        </div>
      `;
      const right = `<div style="text-align:right; min-width:90px;"><strong>${formatMiles(e.miles)}</strong><div class="small muted">mi</div></div>`;
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

function forceRevealAllSelects() {
  showSelect(els.personSkeleton, els.personSelect);
  showSelect(els.weekSkeleton, els.weekSelect);
  showSelect(els.daySkeleton, els.daySelect);
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

function unwrapOk(resp) {
  // If backend returns {ok:false,error:"Unknown action"} etc, turn that into an exception
  if (resp && typeof resp === "object" && "ok" in resp) {
    if (resp.ok === false) throw new Error(resp.error || "Backend error");
    // Some backends may return {ok:true, data: ...}
    if ("data" in resp) return resp.data;
  }
  return resp;
}

async function smartRequest(method, path, body) {
  const base = (API_BASE_URL || "").trim();
  if (!base) throw new Error("API_BASE_URL not set");

  const { op, query } = parseOpAndQuery(path);

  const candidates = [];
  // REST-style
  candidates.push(joinUrl(base, `/${op}${query ? `?${query}` : ""}`));
  // Query-param styles
  candidates.push(joinUrl(base, `?action=${encodeURIComponent(op)}${query ? `&${query}` : ""}`));
  candidates.push(joinUrl(base, `?route=${encodeURIComponent(op)}${query ? `&${query}` : ""}`));
  candidates.push(joinUrl(base, `?op=${encodeURIComponent(op)}${query ? `&${query}` : ""}`));

  let lastErr = null;

  for (const url of candidates) {
    try {
      if (method === "GET") {
        return await fetchJsonWithTimeout(url, { method: "GET" });
      }

      // POST JSON first
      try {
        return await fetchJsonWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
      } catch {
        // POST form fallback
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
  // Accept multiple shapes
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
  // Make skeleton non-interactive
  if (skel) {
    skel.style.display = "none";
    skel.style.visibility = "hidden";
    skel.style.pointerEvents = "none";
  }
  // Make select visible + clickable
  if (sel) {
    sel.style.display = "";
    sel.style.visibility = "visible";
    sel.disabled = false;
    sel.style.pointerEvents = "auto";
    sel.style.position = "relative";
    sel.style.zIndex = "99999";
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
 *  12) WARM-UP PING (SAFE)
 *  ========================= */
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

function cryptoRandom() {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(16) + a[1].toString(16);
  } catch {
    return Math.random().toString(16).slice(2);
  }
}

/** =========================
 *  13) WEEK GENERATOR (Mon–Sun)
 *  ========================= */
function generateWeeksMonSun(year) {
  // Weeks are Mon–Sun. We generate week 1 as the Monday of the week that contains Jan 1.
  // (So week 1 may start in the previous year, which is normal for week-style calendars.)
  const jan1 = new Date(year, 0, 1);
  const day = jan1.getDay(); // 0 Sun .. 6 Sat
  const offsetToMon = (day === 0 ? -6 : 1 - day); // move back to Monday
  const firstMon = new Date(year, 0, 1 + offsetToMon);

  const weeks = [];
  let cur = new Date(firstMon);

  // Build weeks until we pass Dec 31 and have covered the last week containing it
  const dec31 = new Date(year, 11, 31);

  let i = 1;
  while (true) {
    const start = new Date(cur);
    const end = new Date(cur);
    end.setDate(end.getDate() + 6);

    const weekId = `${year}-W${String(i).padStart(2, "0")}`;
    weeks.push({
      weekId,
      weekNum: i,
      startDate: toISODate(start),
      endDate: toISODate(end),
    });

    // stop when the week end is after Dec 31 and the week start is after Dec 31 by >=7? no; simple break:
    if (end >= dec31 && start.getFullYear() === year && start.getMonth() === 11 && start.getDate() > 24) {
      break;
    }
    if (weeks.length > 54) break;

    cur.setDate(cur.getDate() + 7);
    i += 1;
  }

  return weeks;
}
