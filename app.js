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
const API_BASE_URL = window.API_BASE_URL || "https://lively-sunset-250f.kgriswold10.workers.dev/"; // <-- change me

/** Local cache keys */
const CACHE_KEYS = {
  config: "mt_cache_config_v1",
  weeks: "mt_cache_weeks_v1",
  weekDetailsPrefix: "mt_cache_week_details_v1_", // + weekId
};

const REQUEST_TIMEOUT_MS = 25000;
const SOFT_REFRESH_AFTER_MS = 20_000; // allow cached data to show quickly; refresh if older than this

/** =========================
 *  2) DOM
 *  ========================= */
const els = {
  netPill: document.getElementById("netPill"),
  statusLine: document.getElementById("statusLine"),

  personSkeleton: document.getElementById("personSkeleton"),
  weekSkeleton: document.getElementById("weekSkeleton"),
  daySkeleton: document.getElementById("daySkeleton"),

  personSelect: document.getElementById("personSelect"),
  weekSelect: document.getElementById("weekSelect"),
  daySelect: document.getElementById("daySelect"),

  categorySelect: document.getElementById("categorySelect"),
  milesInput: document.getElementById("milesInput"),
  addBtn: document.getElementById("addBtn"),
  refreshBtn: document.getElementById("refreshBtn"),

  weekTotal: document.getElementById("weekTotal"),
  dayTotal: document.getElementById("dayTotal"),
  weekRange: document.getElementById("weekRange"),

  entriesList: document.getElementById("entriesList"),
};

/** =========================
 *  3) STATE
 *  ========================= */
const state = {
  config: null,
  weeks: [], // list
  selectedPerson: null,
  selectedWeekId: null,
  selectedDayISO: null,
  selectedCategory: null,

  weekDetails: null, // { weekId, startDate, endDate, entries: [...] }
};

init().catch((e) => {
  console.error(e);
  setStatus(`Load failed: ${e?.message || e}`, true);
  setNetPill("Load failed", "danger");
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

  // If we had cache, show “loaded from cache” quickly
  if (cachedConfig?.data || cachedWeeks?.data) {
    setStatus("Loaded from cache — refreshing…");
    setNetPill("Cached", "ok");
  } else {
    setStatus("Loading…");
    setNetPill("Loading", "muted");
  }

  // Always fetch fresh in background (with timeout)
  await loadFreshBootstrap();

  // Select defaults if none selected yet
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

  // Load week details on first meaningful selection
  if (state.selectedWeekId && state.selectedPerson) {
    await loadWeekDetails(state.selectedWeekId, state.selectedPerson);
  }

  setStatus("Ready.");
  setNetPill("Ready", "ok");
}

/** =========================
 *  5) EVENTS
 *  ========================= */
function wireEvents() {
  els.personSelect.addEventListener("change", async () => {
    state.selectedPerson = els.personSelect.value;
    // week details depends on person (if your backend filters); reload
    if (state.selectedWeekId) {
      await loadWeekDetails(state.selectedWeekId, state.selectedPerson);
    }
  });

  els.weekSelect.addEventListener("change", async () => {
    state.selectedWeekId = els.weekSelect.value;
    syncDayDropdown();
    if (state.selectedWeekId && state.selectedPerson) {
      await loadWeekDetails(state.selectedWeekId, state.selectedPerson);
    }
  });

  els.daySelect.addEventListener("change", () => {
    state.selectedDayISO = els.daySelect.value;
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

  // If not forcing and cache is fresh enough, skip fetch (still already rendered)
  if (!force && configFreshEnough && weeksFreshEnough) return;

  setStatus(force ? "Refreshing…" : "Refreshing (background)…");

  // Fetch both in parallel
  const [config, weeks] = await Promise.all([
    apiGet("/config"),
    apiGet("/weeks"),
  ]);

  // Update state + cache + UI
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

  // Hide skeletons if now available
  showSelect(els.personSkeleton, els.personSelect);
  showSelect(els.weekSkeleton, els.weekSelect);
  showSelect(els.daySkeleton, els.daySelect);
}

async function loadWeekDetails(weekId, person, force = false) {
  const cacheKey = CACHE_KEYS.weekDetailsPrefix + weekId + "_" + person;
  const cached = readCache(cacheKey);

  // Render cached immediately
  if (!force && cached?.data) {
    state.weekDetails = normalizeWeekDetails(cached.data, weekId);
    renderWeekDetails();
    setStatus("Week loaded (cached) — refreshing…");
  } else {
    setStatus("Loading week details…");
  }

  // Fetch fresh (unless cache is fresh and not forced)
  const now = Date.now();
  const freshEnough = cached?.ts && now - cached.ts < SOFT_REFRESH_AFTER_MS;
  if (!force && freshEnough) {
    setStatus("Ready.");
    return;
  }

  try {
    const details = await apiGet(`/week?weekId=${encodeURIComponent(weekId)}&person=${encodeURIComponent(person)}`);
    if (details) {
      state.weekDetails = normalizeWeekDetails(details, weekId);
      writeCache(cacheKey, state.weekDetails);
      renderWeekDetails();
      setStatus("Ready.");
    }
  } catch (e) {
    // If we had cached, keep going; otherwise show error
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

  // Optimistic UI update
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

  // Persist to backend
  try {
    await apiPost("/entry", entry);
    // After successful add, refresh week details (fast)
    await loadWeekDetails(weekId, person, true);
    setStatus("Entry added.");
    setNetPill("Synced", "ok");
  } catch (e) {
    // Revert optimistic entry if post fails
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

  // Create minimal structure if missing
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
  // People
  const people = Array.isArray(config.people) ? config.people : [];
  if (people.length) {
    els.personSelect.innerHTML = people.map((p) => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join("");
    showSelect(els.personSkeleton, els.personSelect);
    if (!state.selectedPerson) {
      state.selectedPerson = people[0];
      els.personSelect.value = state.selectedPerson;
    }
  }

  // Categories
  const categories = Array.isArray(config.categories) ? config.categories : ["Walk", "Bike", "Other"];
  els.categorySelect.innerHTML = categories.map((c) => `<option value="${escapeHtml(c)}">${escapeHtml(c)}</option>`).join("");
  if (!state.selectedCategory) {
    state.selectedCategory = categories[0];
    els.categorySelect.value = state.selectedCategory;
  }
}

function renderWeeks(weeks) {
  // Expect: [{weekId, weekNum, startDate, endDate}, ...]
  const safeWeeks = Array.isArray(weeks) ? weeks : [];
  if (!safeWeeks.length) return;

  els.weekSelect.innerHTML = safeWeeks.map((w) => {
    const label = weekLabel(w);
    return `<option value="${escapeHtml(w.weekId)}">${escapeHtml(label)}</option>`;
  }).join("");

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

  const days = buildWeekDays(w.startDate); // 7 days ISO
  els.daySelect.innerHTML = days.map((d) => {
    const label = dayLabel(d);
    return `<option value="${escapeHtml(d)}">${escapeHtml(label)}</option>`;
  }).join("");

  showSelect(els.daySkeleton, els.daySelect);

  // Keep current selection if possible
  if (!state.selectedDayISO || !days.includes(state.selectedDayISO)) {
    state.selectedDayISO = days[0];
    els.daySelect.value = state.selectedDayISO;
  } else {
    els.daySelect.value = state.selectedDayISO;
  }

  // Week range pill
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

  els.entriesList.innerHTML = entries.map((e) => {
    const left = `
      <div>
        <div><strong>${escapeHtml(dayLabel(e.dateISO))}</strong> • ${escapeHtml(e.category || "")}</div>
        <div class="small muted">${escapeHtml(e.person || "")} • ${escapeHtml(new Date(e.ts).toLocaleString())}</div>
      </div>
    `;
    const right = `<div style="text-align:right; min-width:90px;"><strong>${formatMiles(e.miles)}</strong><div class="small muted">mi</div></div>`;
    return `<div class="list-item">${left}${right}</div>`;
  }).join("");
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
 *  =========================
 * Supports BOTH styles:
 *  - REST-ish:   BASE + "/config"
 *  - GAS-ish:    BASE + "?action=config"
 *  - Also tries ?route= and ?op=
 */

async function apiGet(path) {
  // path examples we call: "/config", "/weeks", "/week?weekId=..&person=.."
  return smartRequest("GET", path, null);
}

async function apiPost(path, body) {
  // path example we call: "/entry"
  return smartRequest("POST", path, body);
}

async function smartRequest(method, path, body) {
  const base = (API_BASE_URL || "").trim();
  if (!base) throw new Error("API_BASE_URL not set");

  // Normalize what operation is being requested from the path:
  // "/config" -> "config"
  // "/weeks"  -> "weeks"
  // "/ping"   -> "ping"
  // "/week?weekId=..&person=.." -> "week" + keep query params
  const { op, query } = parseOpAndQuery(path);

  // Candidate URL styles (try in this order)
  const candidates = [];

  // 1) REST-ish: BASE + "/config" (only works if Worker supports path routing)
  candidates.push(joinUrl(base, `/${op}${query ? `?${query}` : ""}`));

  // 2) GAS-ish: BASE + "?action=config"
  candidates.push(joinUrl(base, `?action=${encodeURIComponent(op)}${query ? `&${query}` : ""}`));

  // 3) GAS-ish: BASE + "?route=config"
  candidates.push(joinUrl(base, `?route=${encodeURIComponent(op)}${query ? `&${query}` : ""}`));

  // 4) GAS-ish: BASE + "?op=config"
  candidates.push(joinUrl(base, `?op=${encodeURIComponent(op)}${query ? `&${query}` : ""}`));

  // Try each candidate until one works
  let lastErr = null;

  for (const url of candidates) {
    try {
      if (method === "GET") {
        return await fetchJsonWithTimeout(url, { method: "GET" });
      }

      // POST: try JSON first (good for Worker)
      try {
        return await fetchJsonWithTimeout(url, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body ?? {}),
        });
      } catch (e1) {
        // Fallback: urlencoded (often easiest for Apps Script doPost)
        const form = new URLSearchParams();
        // If backend uses action/route/op in POST bodies instead of query, include it too
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
      // keep trying next candidate
    }
  }

  // If all candidates failed, show the last error with helpful info
  throw new Error(
    `All endpoint styles failed for op="${op}". Last error: ${lastErr?.message || lastErr}`
  );
}

function parseOpAndQuery(path) {
  // path is like "/config" or "/week?weekId=1&person=Kyle"
  const clean = String(path || "").trim();
  const noLeading = clean.startsWith("/") ? clean.slice(1) : clean;
  const [rawOp, rawQuery] = noLeading.split("?");
  const op = (rawOp || "").trim();
  const query = (rawQuery || "").trim();
  return { op, query };
}

function joinUrl(base, suffix) {
  // base might already have ?..., so just append if suffix starts with ?
  if (suffix.startsWith("?")) return base + suffix;
  return base.replace(/\/$/, "") + suffix;
}

async function fetchJsonWithTimeout(url, init) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), REQUEST_TIMEOUT_MS);

  try {
    const res = await fetch(url, {
      ...init,
      signal: ctrl.signal,
      cache: "no-store",
    });

    // If it’s a hard HTTP error, throw with body snippet
    if (!res.ok) {
      const text = await safeText(res);
      throw new Error(`${res.status} ${res.statusText}${text ? ` — ${text}` : ""} @ ${url}`);
    }

    const text = await res.text();
    if (!text) return null;

    // Apps Script sometimes returns plain text; try JSON first
    try {
      return JSON.parse(text);
    } catch {
      return text;
    }
  } catch (e) {
    // Bubble up (caller tries next candidate)
    throw e;
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
  // preferred: { weekId, startDate, endDate, entries: [...] }
  const out = {
    weekId: details.weekId || weekId,
    startDate: details.startDate || details.start || details.weekStart || null,
    endDate: details.endDate || details.end || details.weekEnd || null,
    entries: Array.isArray(details.entries) ? details.entries : (Array.isArray(details.data) ? details.data : []),
  };
  return out;
}

function normalizeEntry(e) {
  // Accept multiple shapes; normalize to { person, dateISO, category, miles, ts }
  const dateISO =
    e.dateISO ||
    e.date ||
    e.day ||
    e.entryDate ||
    null;

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

  const wn = w.weekNum != null ? `W${w.weekNum}` : (w.weekId ? w.weekId : "Week");
  if (start && end) return `${wn} • ${formatShort(start)} – ${formatShort(end)}`;
  if (start) return `${wn} • ${formatShort(start)} – +6d`;
  return `${wn}`;
}

function buildWeekDays(startDate) {
  // startDate expected ISO or Date-like; generate 7 ISO dates (YYYY-MM-DD)
  const start = new Date(startDate);
  // normalize to local date by building YYYY-MM-DD from local components
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
    // If already YYYY-MM-DD
    if (/^\d{4}-\d{2}-\d{2}$/.test(input)) return input;
    const d = new Date(input);
    if (Number.isNaN(d.getTime())) return null;
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
  }
  if (input instanceof Date) {
    return `${input.getFullYear()}-${pad2(input.getMonth() + 1)}-${pad2(input.getDate())}`;
  }
  // fallback
  const d = new Date(input);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`;
}

function pad2(n) { return String(n).padStart(2, "0"); }

function formatShort(d) {
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function formatMiles(n) {
  // 2 decimals max, but strip trailing zeros
  const s = (Math.round((Number(n) || 0) * 100) / 100).toFixed(2);
  return s.replace(/\.?0+$/, "");
}

function showSelect(skel, sel) {
  if (skel) skel.style.display = "none";
  if (sel) sel.style.display = "";
}

function setStatus(msg, isError = false) {
  els.statusLine.textContent = msg;
  els.statusLine.className = "status " + (isError ? "danger" : "");
}

function setNetPill(text, tone) {
  els.netPill.textContent = text;
  els.netPill.className = "pill " + (tone === "danger" ? "danger" : tone === "ok" ? "ok" : "muted");
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
  try { return (await res.text()).slice(0, 200); } catch { return ""; }
}

/** =========================
 *  12) WARM-UP PING  ✅ FIXED
 *  =========================
 * - Must exist (no ReferenceError)
 * - Must never throw (cannot block init)
 * - Tries multiple endpoint styles (REST + GAS query params)
 */
function warmUpPing() {
  try {
    const base = (API_BASE_URL || "").trim();
    if (!base) return;

    const baseNoSlash = base.replace(/\/$/, "");

    // Try the same "compat" patterns you use elsewhere
    const urls = [
      `${baseNoSlash}/ping`,
      `${baseNoSlash}?action=ping`,
      `${baseNoSlash}?route=ping`,
      `${baseNoSlash}?op=ping`,
      // Fallback: hit root to wake cold starts even if ping isn't implemented
      `${baseNoSlash}/`,
    ];

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 4000); // short warmup timeout

    // fire-and-forget; ignore failures
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
    // never throw from warmup
  }
}

// Alias in case older call exists somewhere
function warmupPing() { return warmUpPing(); }

function cryptoRandom() {
  try {
    const a = new Uint32Array(2);
    crypto.getRandomValues(a);
    return a[0].toString(16) + a[1].toString(16);
  } catch {
    return Math.random().toString(16).slice(2);
  }
}
