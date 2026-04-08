const state = {
  token: localStorage.getItem("ts_token") || "",
  userId: null,
  displayName: "",
  icon: "🚃",
  cities: [],
  lines: [],
  stations: [],
  currentGameCode: "",
  pollTimer: null,
  gameState: null,
  selectedLineKey: null,
  selectedDirectionStationId: null,
  rollOptions: null,
  stageLock: false,
  waitingTimer: null,
  stagePlayback: false,
  map: null,
  mapMarkers: new Map(),
  mapRoute: null,
  pendingPath: null,
  pendingDest: null,
  pendingArrow: null,
  pendingDestReady: false,
  hidePendingPath: false,
  routeTrailPoints: null,
  pendingCurrentStation: null,
  mapLastUserMoveAt: 0,
  lastFollowPos: null,
  didInitialFollow: false,
  pointerSyncTimer: null,
  recentPath: null,
  recentPathGroup: null,
  lastCreateKey: "ts_last_create",
  holdCheckinStage: false,
};

const $ = (id) => document.getElementById(id);
const screens = ["screenLogin", "screenCreate", "screenLobby", "screenGame"];

function on(id, event, handler) {
  const el = $(id);
  if (!el) return;
  el.addEventListener(event, handler);
}

function showScreen(id) {
  for (const s of screens) $(s).classList.toggle("hidden", s !== id);
}

function authHeaders() {
  const h = { "Content-Type": "application/json" };
  if (state.token) h.Authorization = `Bearer ${state.token}`;
  return h;
}

async function api(path, method = "GET", body = null) {
  const res = await fetch(path, {
    method,
    headers: authHeaders(),
    body: body ? JSON.stringify(body) : null,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.detail || `HTTP ${res.status}`);
  return json;
}

function pickRandom(items) {
  if (!items || items.length === 0) return null;
  return items[Math.floor(Math.random() * items.length)];
}

function getPlayType() {
  return document.querySelector("input[name='playType']:checked").value;
}

function selectedMode() {
  const t = getPlayType();
  if (t === "multi") return $("multiMode").value;
  return $("goalEnabled").checked ? "solo_goal" : "solo_endless";
}

function updateCreateFormByType() {
  const multi = getPlayType() === "multi";
  $("multiModeLabel").classList.toggle("hidden", !multi);
  $("multiMode").classList.toggle("hidden", !multi);
  $("passwordRow").classList.toggle("hidden", !multi);
  $("playerCount").value = multi ? "2" : "1";
  $("playerCount").disabled = !multi;
  if (multi) $("goalEnabled").checked = true;
}

function saveLastCreate() {
  const data = {
    city: $("city").value,
    playType: getPlayType(),
    multiMode: $("multiMode").value,
    playerCount: $("playerCount").value,
    startLine: $("startLine").value,
    startStation: $("startStation").value,
    goalLine: $("goalLine").value,
    goalStation: $("goalStation").value,
    goalEnabled: $("goalEnabled").checked,
    minStay: $("minStay").value,
  };
  localStorage.setItem(state.lastCreateKey, JSON.stringify(data));
}

async function applyLastCreate() {
  const raw = localStorage.getItem(state.lastCreateKey);
  if (!raw) {
    await applyDefaultCreate();
    return;
  }
  let data = null;
  try { data = JSON.parse(raw); } catch { return; }
  if (!data) return;
  if (data.city && state.cities.includes(data.city)) {
    $("city").value = data.city;
    await loadLines();
  }
  if (data.playType) {
    document.querySelector(`input[name='playType'][value='${data.playType}']`)?.click();
  }
  if (data.multiMode) $("multiMode").value = data.multiMode;
  if (data.playerCount) $("playerCount").value = data.playerCount;
  if (data.startLine) $("startLine").value = data.startLine;
  await loadStations("start");
  if (data.startStation) $("startStation").value = data.startStation;
  if (data.goalLine) $("goalLine").value = data.goalLine;
  await loadStations("goal");
  if (data.goalStation) $("goalStation").value = data.goalStation;
  if (typeof data.goalEnabled === "boolean") $("goalEnabled").checked = data.goalEnabled;
  if (data.minStay) $("minStay").value = data.minStay;
}

async function applyDefaultCreate() {
  const defaultCity = "名古屋";
  const defaultStartLine = "名古屋市|1号線(東山線)";
  const defaultGoalLine = "名古屋市|4号線(名城線)";
  const defaultStart = "名古屋";
  const defaultGoal = "金山";
  if (!state.cities.includes(defaultCity)) return;
  $("city").value = defaultCity;
  await loadLines();
  if (Array.from($("startLine").options).some((o) => o.value === defaultStartLine)) {
    $("startLine").value = defaultStartLine;
  }
  if (Array.from($("goalLine").options).some((o) => o.value === defaultGoalLine)) {
    $("goalLine").value = defaultGoalLine;
  }
  await loadStations("start");
  await loadStations("goal");
  const findByText = (el, name) => {
    const opt = Array.from(el.options).find((o) => o.textContent === name);
    if (opt) el.value = opt.value;
  };
  findByText($("startStation"), defaultStart);
  findByText($("goalStation"), defaultGoal);
  $("minStay").value = "10";
}

function applyJoinCodeFromQuery() {
  const q = new URLSearchParams(location.search);
  const join = (q.get("join") || "").trim().toUpperCase();
  if (join) $("joinCode").value = join;
}

async function loadConfig() {
  const cfg = await api("/api/config");
  state.cities = cfg.cities;
  const cityEl = $("city");
  cityEl.innerHTML = "";
  for (const c of cfg.cities) {
    const o = document.createElement("option");
    o.value = c;
    o.textContent = c;
    cityEl.appendChild(o);
  }
}

async function loadLines() {
  const city = $("city").value;
  const out = await api(`/api/lines?city=${encodeURIComponent(city)}`);
  state.lines = out.lines || [];
  for (const id of ["startLine", "goalLine"]) {
    const el = $(id);
    el.innerHTML = "";
    for (const ln of state.lines) {
      const o = document.createElement("option");
      o.value = ln.line_key;
      o.textContent = ln.name;
      el.appendChild(o);
    }
  }
}

async function loadStations(target) {
  const city = $("city").value;
  const lineId = target === "start" ? "startLine" : "goalLine";
  const stationId = target === "start" ? "startStation" : "goalStation";
  const lineKey = $(lineId).value;
  const out = await api(`/api/stations?city=${encodeURIComponent(city)}&line_key=${encodeURIComponent(lineKey)}`);
  const stations = out.stations || [];
  const el = $(stationId);
  el.innerHTML = "";
  for (const s of stations) {
    const o = document.createElement("option");
    o.value = s.station_id;
    o.textContent = s.name;
    el.appendChild(o);
  }
  if (target === "goal" && stations.length > 1) el.selectedIndex = 1;
}

async function loadRouteBasedStationSelectors() {
  if (!state.cities.length) await loadConfig();
  if (!$("city").value && state.cities.length) {
    $("city").value = state.cities[0];
  }
  await loadLines();
  await loadStations("start");
  await loadStations("goal");
  await applyLastCreate();
}

async function requestCode() {
  const email = $("email").value.trim();
  if (!email) throw new Error("メールアドレスを入力してください");
  const out = await api("/api/auth/request-code", "POST", { email });
  $("authInfo").textContent = `開発用コード: ${out.dev_code} (期限: ${out.expires_at})`;
  if (out.dev_code) {
    $("code").value = out.dev_code;
    await verifyCode();
  }
}

async function verifyCode() {
  const email = $("email").value.trim();
  const code = $("code").value.trim();
  if (!email) throw new Error("メールアドレスを入力してください");
  if (!code) throw new Error("コードを入力してください");
  const out = await api("/api/auth/verify-code", "POST", { email, code });
  state.token = out.token;
  state.userId = out.user.id;
  state.displayName = out.user.display_name;
  state.icon = out.user.icon || "🚃";
  localStorage.setItem("ts_token", state.token);
  $("authInfo").textContent = `ログイン: ${out.user.display_name}`;
  $("nicknameInput").value = out.user.display_name;
  $("iconInput").value = state.icon;
  updateIconPreview(state.icon);
  $("nicknameInfo").textContent = "";
  await loadRouteBasedStationSelectors();
  showScreen("screenCreate");
  applyJoinCodeFromQuery();
}

async function saveNickname() {
  const displayName = $("nicknameInput").value.trim();
  const icon = $("iconInput").value.trim() || "🚃";
  const out = await api("/api/me/profile", "POST", { display_name: displayName, icon });
  state.displayName = out.user.display_name;
  state.icon = out.user.icon || "🚃";
  $("iconInput").value = state.icon;
  updateIconPreview(state.icon);
  $("nicknameInfo").textContent = `保存: ${out.user.display_name}`;
}

async function ensureNicknameSynced() {
  const displayName = $("nicknameInput").value.trim();
  const icon = ($("iconInput").value || "").trim() || "🚃";
  if (!displayName) throw new Error("ニックネームを入力してください");
  if (displayName !== state.displayName || icon !== state.icon) {
    await saveNickname();
  }
}

function updateIconPreview(val) {
  const el = $("iconPreview");
  if (!el) return;
  const v = (val || "").trim();
  if (v.startsWith("http://") || v.startsWith("https://") || v.startsWith("/static/")) {
    el.textContent = "";
    el.style.backgroundImage = `url('${v}')`;
    el.style.backgroundSize = "cover";
    el.style.backgroundPosition = "center";
  } else {
    el.style.backgroundImage = "none";
    el.textContent = v || "🚃";
  }
}

async function uploadIconImage() {
  const file = $("iconFile").files[0];
  if (!file) throw new Error("画像ファイルを選択してください");
  const fd = new FormData();
  fd.append("file", file);
  const res = await fetch("/api/me/icon-upload", {
    method: "POST",
    headers: state.token ? { Authorization: `Bearer ${state.token}` } : {},
    body: fd,
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(json.detail || `HTTP ${res.status}`);
  $("iconInput").value = json.url;
  updateIconPreview(json.url);
}

async function createGame() {
  await ensureNicknameSynced();
  const mode = selectedMode();
  const playType = getPlayType();
  const maxPlayers = playType === "multi"
    ? Number($("playerCount").value || "2")
    : 1;
  const body = {
    city: $("city").value,
    mode,
    start_station_id: $("startStation").value,
    start_random: false,
    goal_enabled: $("goalEnabled").checked,
    goal_station_id: $("goalStation").value,
    goal_random: false,
    join_password: playType === "multi" ? $("joinPasswordCreate").value : null,
    min_stay_minutes: Number($("minStay").value || "3"),
    max_players: maxPlayers,
  };
  if (playType === "multi" && !String(body.join_password || "").trim()) {
    throw new Error("複数人プレイでは参加パスワードを設定してください");
  }

  const out = await api("/api/games", "POST", body);
  state.currentGameCode = out.game_code;
  state.routeTrailPoints = loadTrail(state.currentGameCode);
  $("createInfo").textContent = `作成完了: ${out.game_code}`;
  saveLastCreate();
  await refreshState();
}

async function joinGame() {
  await ensureNicknameSynced();
  const gameCode = $("joinCode").value.trim().toUpperCase();
  const joinPassword = $("joinPasswordJoin").value;
  await api(`/api/games/${gameCode}/join`, "POST", { join_password: joinPassword });
  state.currentGameCode = gameCode;
  state.routeTrailPoints = loadTrail(state.currentGameCode);
  await refreshState();
}

function renderLobby(data) {
  const game = data.game;
  const joinAbs = `${location.origin}${game.join_url}`;
  $("lobbyGameInfo").textContent = `${game.city} / ${game.mode} / ${game.start_station_name} -> ${game.goal_station_name || "なし"} / 募集: ${game.max_players}人`;
  $("joinUrl").href = joinAbs;
  $("joinUrl").textContent = joinAbs;
  $("startGameBtn").disabled = !game.can_start;

  const ul = $("lobbyPlayers");
  ul.innerHTML = "";
  for (const p of data.players) {
    const li = document.createElement("li");
    li.textContent = `${p.display_name} - 現在: ${p.current_station_name}`;
    ul.appendChild(li);
  }
}

function formatJstTime(ts) {
  const d = new Date(ts);
  if (Number.isNaN(d.getTime())) return ts;
  return d.toLocaleString("ja-JP", { timeZone: "Asia/Tokyo", hour12: false });
}

function renderLogs(data) {
  const ul = $("actionLogs");
  ul.innerHTML = "";
  for (const log of data.logs || []) {
    const li = document.createElement("li");
    li.textContent = `(${formatJstTime(log.created_at)}) ${log.message}`;
    ul.appendChild(li);
  }
}

function setStage({ label, title, choices, buttonText, result }) {
  $("stageLabel").textContent = label || "";
  $("stageTitle").textContent = title || "";
  $("stageChoices").textContent = choices || "";
  $("stageActionBtn").textContent = buttonText || "実行";
  $("stageResult").textContent = result || "";
  if ((label || "").includes("ルーレット")) {
    showRoulette(true);
  }
}

function enableStageAction(handler) {
  const btn = $("stageActionBtn");
  btn.disabled = false;
  btn.onclick = () => run(handler);
}

function disableStageAction() {
  const btn = $("stageActionBtn");
  btn.disabled = true;
  btn.onclick = null;
}

function waitStageNext(label = "次へ") {
  return new Promise((resolve) => {
    const btn = $("stageActionBtn");
    // Prevent accidental auto-advance from a previous click (e.g., mouse held down across stage transitions)
    btn.disabled = true;
    btn.textContent = label;
    btn.onclick = null;
    btn.blur();

    // Enable after a short delay to avoid "carry-over" clicks from the previous stage.
    setTimeout(() => {
      btn.disabled = false;
      btn.onclick = () => {
        btn.disabled = true;
        btn.onclick = null;
        resolve();
      };
    }, 120);
  });
}

async function animateRandomSpin(options, finalValue, renderText) {
  const opts = (options || []).filter((x) => String(x).length > 0);
  if (!opts.length) {
    renderText(String(finalValue || ""));
    return;
  }
  const durationMs = 3000;
  const intervalMs = 90;
  return new Promise((resolve) => {
    const tick = setInterval(() => {
      const v = opts[Math.floor(Math.random() * opts.length)];
      renderText(String(v));
    }, intervalMs);
    setTimeout(() => {
      clearInterval(tick);
      renderText(String(finalValue));
      resolve();
    }, durationMs);
  });
}

function forceAlignWheelLabel(wheelEl, labels, selectedValue) {
  const wheel = wheelEl;
  if (!wheel) return;
  const opts = (labels || []).map((x) => String(x));
  const n = Math.max(1, opts.length);
  const selectedStr = String(selectedValue ?? "");
  let idx = opts.findIndex((x) => x === selectedStr);
  if (idx < 0) idx = 0;
  const step = 360 / n;
  let rot = Number(wheel.dataset.rot || "0");
  const computed = getComputedStyle(wheel).transform;
  if (computed && computed !== "none") {
    const m = computed.match(/matrix\\(([^)]+)\\)/);
    if (m) {
      const parts = m[1].split(",").map((v) => parseFloat(v.trim()));
      if (parts.length >= 2 && Number.isFinite(parts[0]) && Number.isFinite(parts[1])) {
        const angle = Math.atan2(parts[1], parts[0]) * 180 / Math.PI;
        rot = angle;
      }
    }
  }
  const start = -90;
  const angle = ((0 - (rot % 360)) + 360) % 360;
  const rel = ((angle - start) + 360) % 360;
  const idxAtPointer = Math.floor(rel / step);
  if (idxAtPointer === idx) return;
  let diff = idx - idxAtPointer;
  if (diff > n / 2) diff -= n;
  if (diff < -n / 2) diff += n;
  wheel.classList.add("no-spin");
  const target = rot + diff * step;
  wheel.dataset.rot = String(target);
  wheel.style.transform = `rotate(${target}deg)`;
  void wheel.offsetHeight;
  wheel.classList.remove("no-spin");
}

function spinRouletteToValue(wheelEl, labels, selectedValue, opts = {}) {
  const wheel = wheelEl;
  if (!wheel) return;
  const values = (labels || []).map((x) => String(x));
  if (!values.length) return;
  const selected = String(selectedValue ?? values[0] ?? "");
  let idx = values.findIndex((x) => x === selected);
  if (idx < 0) idx = 0;

  const step = 360 / values.length;
  const baseRot = Number(wheel.dataset.rot || "0");
  const currentRot = Number.isFinite(baseRot) ? baseRot : 0;
  const currentNorm = ((currentRot % 360) + 360) % 360;
  const pointerAngle = 90;
  const safeMargin = Math.min(step * 0.18, 8);
  const minOffset = safeMargin;
  const maxOffset = Math.max(safeMargin, step - safeMargin);
  const randomOffset = minOffset + Math.random() * (maxOffset - minOffset);
  const targetNorm = ((pointerAngle - (idx * step + randomOffset)) % 360 + 360) % 360;
  const delta = ((targetNorm - currentNorm) % 360 + 360) % 360;
  const minTurns = Number.isFinite(opts.minTurns) ? opts.minTurns : 5;
  const extraTurns = Number.isFinite(opts.extraTurns) ? opts.extraTurns : Math.floor(Math.random() * 3);
  const durationMs = Number.isFinite(opts.durationMs) ? opts.durationMs : 4200;
  const finalRot = currentRot + delta + (minTurns + extraTurns) * 360;

  wheel.classList.remove("no-spin");
  wheel.style.transition = `transform ${durationMs}ms cubic-bezier(0.08, 0.82, 0.18, 1)`;
  wheel.dataset.rot = String(finalRot);
  wheel.style.transform = `rotate(${finalRot}deg)`;
}

function waitWheelStop(wheelEl) {
  const wheel = wheelEl;
  if (!wheel) return Promise.resolve();
  const style = getComputedStyle(wheel);
  const durations = (style.transitionDuration || "0s").split(",").map((v) => v.trim());
  const d = durations[0] || "0s";
  const ms = d.endsWith("ms") ? Number(d.replace("ms", "")) : Number(d.replace("s", "")) * 1000;
  if (!ms || !Number.isFinite(ms)) return Promise.resolve();
  return new Promise((resolve) => {
    let done = false;
    const finish = () => {
      if (done) return;
      done = true;
      wheel.removeEventListener("transitionend", onEnd);
      resolve();
    };
    const onEnd = (e) => {
      if (e.propertyName !== "transform") return;
      finish();
    };
    wheel.addEventListener("transitionend", onEnd);
    setTimeout(finish, ms + 80);
  });
}

function lineLabel(lineKey) {
  const s = String(lineKey || "");
  const i = s.indexOf("|");
  return i >= 0 ? s.slice(i + 1) : s;
}

function startPointerSync(wheelEl, labels, renderText) {
  stopPointerSync();
  const wheel = wheelEl;
  if (!wheel) return;
  const opts = (labels || []).map((x) => String(x));
  const n = Math.max(1, opts.length);
  const step = 360 / n;
  state.pointerSyncTimer = setInterval(() => {
    const computed = getComputedStyle(wheel).transform;
    if (!computed || computed === "none") return;
    const m = computed.match(/matrix\\(([^)]+)\\)/);
    if (!m) return;
    const parts = m[1].split(",").map((v) => parseFloat(v.trim()));
    if (parts.length < 2 || !Number.isFinite(parts[0]) || !Number.isFinite(parts[1])) return;
    const angle = Math.atan2(parts[1], parts[0]) * 180 / Math.PI;
    const start = -90;
    const a = ((0 - (angle % 360)) + 360) % 360;
    const rel = ((a - start) + 360) % 360;
    const idx = Math.floor(rel / step);
    const v = opts[idx] || "";
    renderText(v);
  }, 60);
}

function stopPointerSync() {
  if (state.pointerSyncTimer) clearInterval(state.pointerSyncTimer);
  state.pointerSyncTimer = null;
}

function showRoulette(show) {
  $("rouletteWrap").classList.toggle("hidden", !show);
}

function previewRoulette(wheelEl, labels) {
  const wheel = wheelEl;
  if (!wheel) return;
  drawRoulette(wheel, labels);
  wheel.classList.add("no-spin");
  wheel.style.transition = "none";
  wheel.dataset.rot = "0";
  wheel.style.transform = "rotate(0deg)";
  void wheel.offsetHeight;
}

function trailStorageKey(gameCode) {
  return `trail_${gameCode || "unknown"}`;
}

function loadTrail(gameCode) {
  try {
    const raw = localStorage.getItem(trailStorageKey(gameCode));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    // ignore
  }
  return null;
}

function saveTrail(gameCode, points) {
  if (!gameCode) return;
  try {
    localStorage.setItem(trailStorageKey(gameCode), JSON.stringify(points || []));
  } catch {
    // ignore
  }
}

function appendTrailPoints(points) {
  if (!points || points.length < 2) return;
  const current = Array.isArray(state.routeTrailPoints) ? state.routeTrailPoints : [];
  const next = current.slice();
  for (const p of points) {
    const last = next[next.length - 1];
    if (!last || last[0] !== p[0] || last[1] !== p[1]) {
      next.push(p);
    }
  }
  state.routeTrailPoints = next;
  saveTrail(state.currentGameCode, next);
}

function distanceKm(a, b) {
  const lat1 = Number(a[0]);
  const lon1 = Number(a[1]);
  const lat2 = Number(b[0]);
  const lon2 = Number(b[1]);
  if (![lat1, lon1, lat2, lon2].every((v) => Number.isFinite(v))) return Infinity;
  const toRad = (v) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const rLat1 = toRad(lat1);
  const rLat2 = toRad(lat2);
  const aVal = Math.sin(dLat / 2) ** 2 + Math.cos(rLat1) * Math.cos(rLat2) * Math.sin(dLon / 2) ** 2;
  const c = 2 * Math.atan2(Math.sqrt(aVal), Math.sqrt(1 - aVal));
  return 6371 * c;
}

function drawRoulette(canvasEl, labels) {
  const canvas = canvasEl;
  if (!canvas) return;
  if (!labels || labels.length === 0) {
    canvas.style.display = "none";
    return;
  }
  canvas.style.display = "";
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  const n = Math.max(1, labels.length);
  const w = canvas.width;
  const h = canvas.height;
  const cx = w / 2;
  const cy = h / 2;
  const r = Math.min(cx, cy) - 10;
  ctx.clearRect(0, 0, w, h);
  const step = (Math.PI * 2) / n;
  const basePalette = ["#4a6cf7", "#ff7a7a", "#7be7a4", "#ffe08a", "#c99bff", "#7dd3fc"];
  const palette = [];
  for (let i = 0; i < n; i += 1) {
    const base = basePalette[i % basePalette.length];
    if (i >= basePalette.length) {
      palette.push(`hsl(${(i * 47) % 360} 70% 72%)`);
    } else {
      palette.push(base);
    }
  }

  for (let i = 0; i < n; i += 1) {
    const start = i * step - Math.PI / 2;
    const end = start + step;
    ctx.beginPath();
    ctx.arc(cx, cy, r * 0.5, start, end);
    ctx.strokeStyle = palette[i];
    ctx.lineWidth = r;
    ctx.stroke();

    const angle = (start + end) / 2;
    const raw = String(labels[i] || "");
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(angle);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const base = n <= 6 ? 22 : n <= 12 ? 16 : n <= 24 ? 12 : 10;
    ctx.font = `700 ${base}px "Zen Kaku Gothic New", "Hiragino Kaku Gothic ProN", sans-serif`;
    const arcLen = step * r * 0.92;
    const metrics = ctx.measureText(raw);
    const scale = Math.min(1, arcLen / (metrics.width + 8));
    const size = Math.max(8, Math.floor(base * scale));
    ctx.font = `700 ${size}px "Zen Kaku Gothic New", "Hiragino Kaku Gothic ProN", sans-serif`;
    const maxChars = Math.max(3, Math.floor(arcLen / (size * 0.6)));
    const text = raw.length > maxChars ? `${raw.slice(0, maxChars)}…` : raw;
    ctx.lineWidth = 4;
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.fillStyle = "#0f172a";
    ctx.strokeText(text, r * 0.95, 0);
    ctx.fillText(text, r * 0.95, 0);
    ctx.restore();
  }
  ctx.beginPath();
  ctx.arc(cx, cy, 12, 0, Math.PI * 2);
  ctx.fillStyle = "#fff";
  ctx.fill();
}

async function roulettePickStation(target) {
  const lineId = target === "start" ? "startLine" : "goalLine";
  const stationId = target === "start" ? "startStation" : "goalStation";
  if (!state.lines.length) await loadLines();
  const lineEntries = state.lines.map((l) => ({ key: l.line_key, label: lineLabel(l.line_key) }));
  const pickedLine = pickRandom(lineEntries);
  $("createRouletteTitle").textContent = `${target === "start" ? "スタート" : "ゴール"}路線ルーレット`;
  $("createRouletteChoices").textContent = `候補: ${lineEntries.map((x) => x.label).join(" / ")}`;
  $("createRouletteResult").textContent = "回転中...";
  const lineLabels = lineEntries.map((x) => x.label);
  drawRoulette($("createRouletteWheel"), lineLabels);
  spinRouletteToValue($("createRouletteWheel"), lineLabels, pickedLine?.label || "");
  startPointerSync($("createRouletteWheel"), lineLabels, (txt) => {
    $("createRouletteResult").textContent = `決定: ${txt}`;
  });
  await waitWheelStop($("createRouletteWheel"));
  stopPointerSync();
  $("createRouletteResult").textContent = `決定: ${pickedLine?.label || ""}`;
  // keep natural stop position
  $(lineId).value = pickedLine?.key || "";
  await loadStations(target);
  const stationSelect = $(stationId);
  const stationOptions = Array.from(stationSelect.options).map((o) => o.value);
  const pickedStation = pickRandom(stationOptions);
  $("createRouletteTitle").textContent = `${target === "start" ? "スタート" : "ゴール"}駅ルーレット`;
  $("createRouletteChoices").textContent = `候補: ${Array.from(stationSelect.options).map((o) => o.textContent).join(" / ")}`;
  $("createRouletteResult").textContent = "回転中...";
  const stationLabels = Array.from(stationSelect.options).map((o) => o.textContent);
  drawRoulette($("createRouletteWheel"), stationLabels);
  spinRouletteToValue(
    $("createRouletteWheel"),
    stationLabels,
    stationSelect.options[stationOptions.indexOf(pickedStation)]?.textContent || "",
  );
  startPointerSync($("createRouletteWheel"), stationLabels, (txt) => {
    $("createRouletteResult").textContent = `決定: ${txt}`;
  });
  await waitWheelStop($("createRouletteWheel"));
  stopPointerSync();
  $("createRouletteResult").textContent = `決定: ${stationSelect.options[stationOptions.indexOf(pickedStation)]?.textContent || ""}`;
  // keep natural stop position
  stationSelect.value = pickedStation;
}

function formatDirectionChoices(directionChoices) {
  return directionChoices.map((d) => `${d.name} 方面`).join(" / ");
}

function normalizeStationName(name) {
  return String(name || "")
    .replace(/\s+/g, "")
    .replace(/（.*?）/g, "")
    .replace(/\(.*?\)/g, "")
    .replace(/［.*?］/g, "")
    .replace(/【.*?】/g, "")
    .replace(/駅$/, "");
}

function findStationByName(stations, targetName) {
  const target = normalizeStationName(targetName);
  return stations.find((s) => normalizeStationName(s.station_name || s.name) === target) || null;
}

function applyPendingCurrentStation(station, nameOverride = null) {
  if (!station) return;
  const lat = Number(station.lat);
  const lon = Number(station.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return;
  const name = String(
    nameOverride ||
      station.station_name ||
      station.name ||
      station.current_station_name ||
      ""
  );
  state.pendingCurrentStation = {
    name,
    lat,
    lon,
    stationId: String(station.station_id || ""),
  };
  const me = (state.gameState?.players || []).find((p) => p.user_id === state.userId);
  if (me) {
    me.lat = lat;
    me.lon = lon;
    me.current_station_name = name || me.current_station_name || "";
  }
  if (state.mapMarkers.has(state.userId)) {
    state.mapMarkers.get(state.userId).setLatLng([lat, lon]);
  } else if (state.map) {
    const iconVal = String(me?.icon || "🚃");
    let icon = L.divIcon({ html: `<div style="font-size:20px">${me?.icon || "🚃"}</div>`, className: "", iconSize: [24, 24] });
    if (iconVal.startsWith("http://") || iconVal.startsWith("https://") || iconVal.startsWith("/static/")) {
      icon = L.icon({ iconUrl: iconVal, iconSize: [28, 28], className: "leaflet-user-icon" });
    }
    const m = L.marker([lat, lon], { icon }).addTo(state.map);
    state.mapMarkers.set(state.userId, m);
  }
  const shownName = name || "-";
  if ($("currentStation")) $("currentStation").textContent = `現在地: ${shownName}`;
  if (state.gameState) {
    renderMapLeaflet(state.gameState, me || null);
  }
}

function findStationIndexByName(pathStations, pathNames, targetName, startIdx = 0) {
  const target = normalizeStationName(targetName);
  for (let i = Math.max(0, startIdx); i < pathStations.length; i += 1) {
    const st = pathStations[i];
    const candidate = st?.station_name || st?.name || pathNames[i];
    if (normalizeStationName(candidate) === target) return i;
  }
  return -1;
}

function buildPendingPathSegment(pathStations, pathNames, transferNames, startIdx = 0) {
  const safeStartIdx = Math.max(0, startIdx);
  if (!Array.isArray(pathStations) || pathStations.length - safeStartIdx < 2) {
    return { pendingPath: null, pendingDestReady: false };
  }

  let endIdx = pathStations.length - 1;
  let hasUpcomingTransfer = false;
  for (const name of transferNames || []) {
    const idx = findStationIndexByName(pathStations, pathNames, name, safeStartIdx + 1);
    if (idx !== -1) {
      endIdx = idx;
      hasUpcomingTransfer = true;
      break;
    }
  }

  const segment = pathStations.slice(safeStartIdx, endIdx + 1);
  const points = segment
    .map((s) => [Number(s.lat), Number(s.lon)])
    .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
  const stationIds = segment.map((s) => String(s.station_id));
  const stationNames = segment.map((s) => String(s.station_name || s.name || ""));
  return {
    pendingPath: points.length >= 2 ? { points, stationIds, stationNames } : null,
    pendingDestReady: !hasUpcomingTransfer,
  };
}

async function fetchRollOptions(selectedLineKey = null) {
  const q = selectedLineKey ? `?selected_line_key=${encodeURIComponent(selectedLineKey)}` : "";
  state.rollOptions = await api(`/api/games/${state.currentGameCode}/roll-options${q}`);
}

function renderGame(data) {
  const game = data.game;
  const me = data.players.find((p) => p.user_id === state.userId) || data.players[0];

  $("gameSummary").textContent = `${game.city} / ${game.mode} / スタート: ${game.start_station_name} / ゴール: ${game.goal_station_name || "なし"}`;
  const pendingName = state.pendingCurrentStation?.name;
  const shownName = pendingName || (me ? me.current_station_name : "-");
  $("currentStation").textContent = `現在地: ${shownName || "-"}`;
  renderMapLeaflet(data, me);
  // renderLogs(data); // Hide logs to avoid spoilers during gameplay
}

function renderMapLeaflet(data, me) {
  const mapData = data.map || {};
  const stations = mapData.stations || [];
  const myRoute = mapData.my_route || [];
  const players = mapData.players || [];
  const myId = me ? me.user_id : state.userId;
  if (!stations.length) return;

  const myPlayer = players.find((p) => p.user_id === myId);
  if (!state.map) {
    state.map = L.map("map");
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
      maxZoom: 18,
      attribution: "© OpenStreetMap contributors",
    }).addTo(state.map);
    const lats = stations.map((s) => Number(s.lat));
    const lons = stations.map((s) => Number(s.lon));
    const bounds = L.latLngBounds(
      [Math.min(...lats), Math.min(...lons)],
      [Math.max(...lats), Math.max(...lons)],
    );
    state.map.fitBounds(bounds.pad(0.1));
    const markUserMove = () => {
      state.mapLastUserMoveAt = Date.now();
    };
    state.map.on("dragstart", markUserMove);
    state.map.on("zoomstart", markUserMove);
    state.map.on("movestart", markUserMove);

    if (myPlayer) {
      const p = [Number(myPlayer.lat), Number(myPlayer.lon)];
      if (Number.isFinite(p[0]) && Number.isFinite(p[1])) {
        state.map.setView(p, Math.max(state.map.getZoom(), 13), { animate: true });
        state.lastFollowPos = p;
        state.didInitialFollow = true;
      }
    }
  }

  for (const [uid, marker] of state.mapMarkers.entries()) {
    if (!players.find((p) => p.user_id === uid)) {
      state.map.removeLayer(marker);
      state.mapMarkers.delete(uid);
    }
  }

  const pending = state.pendingCurrentStation;
  for (const p of players) {
    const iconHtml = `<div style="font-size:20px">${p.icon || "🚃"}</div>`;
    let icon = L.divIcon({ html: iconHtml, className: "", iconSize: [24, 24] });
    const iconVal = String(p.icon || "🚃");
    if (iconVal.startsWith("http://") || iconVal.startsWith("https://") || iconVal.startsWith("/static/")) {
      icon = L.icon({
        iconUrl: iconVal,
        iconSize: [28, 28],
        className: "leaflet-user-icon",
      });
    }
    const isMe = p.user_id === myId;
    let pos = [Number(p.lat), Number(p.lon)];
    if (isMe && pending && Number.isFinite(pending.lat) && Number.isFinite(pending.lon)) {
      pos = [Number(pending.lat), Number(pending.lon)];
    }
    if (!Number.isFinite(pos[0]) || !Number.isFinite(pos[1])) continue;
    const stationName = isMe && pending?.name ? pending.name : (p.station_name || p.current_station_name || "");
    if (state.mapMarkers.has(p.user_id)) {
      const m = state.mapMarkers.get(p.user_id);
      m.setLatLng(pos).setIcon(icon);
      m.setPopupContent(`${p.display_name} / ${stationName}`);
    } else {
      const m = L.marker(pos, { icon }).addTo(state.map);
      m.bindPopup(`${p.display_name} / ${stationName}`);
      state.mapMarkers.set(p.user_id, m);
    }
    if (isMe) {
      const last = state.lastFollowPos;
      if (!last || last[0] !== pos[0] || last[1] !== pos[1]) {
        state.map.setView(pos, Math.max(state.map.getZoom(), 13), { animate: true });
        state.lastFollowPos = pos;
      }
    }
  }

  if (state.mapRoute) {
    state.map.removeLayer(state.mapRoute);
    state.mapRoute = null;
  }
  // Always keep the full traveled route in red.
  // Prefer station-by-station points (myRoute) to avoid straight skips.
  let trailPoints = null;
  if (myRoute.length >= 2) {
    const points = myRoute.map((s) => [Number(s.lat), Number(s.lon)]);
    if (points.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]))) {
      trailPoints = points;
    }
  }
  if (!trailPoints) {
    trailPoints = Array.isArray(state.routeTrailPoints) ? state.routeTrailPoints : null;
  }
  if (trailPoints && trailPoints.length >= 2) {
    const group = L.layerGroup();
    for (let i = 0; i < trailPoints.length - 1; i += 1) {
      const seg = [trailPoints[i], trailPoints[i + 1]];
      if (distanceKm(seg[0], seg[1]) <= 2.2) {
        L.polyline(seg, { color: "#e23c3c", weight: 4 }).addTo(group);
      }
    }
    for (const p of trailPoints) {
      L.circleMarker(p, { radius: 4, color: "#e23c3c", fillColor: "#fecaca", fillOpacity: 1 }).addTo(group);
    }
    group.addTo(state.map);
    state.mapRoute = group;
  }

  if (state.pendingPath?.group) {
    state.map.removeLayer(state.pendingPath.group);
    delete state.pendingPath.group;
  }
  if (state.pendingDest) {
    state.map.removeLayer(state.pendingDest);
    state.pendingDest = null;
  }
  if (state.pendingArrow) {
    state.map.removeLayer(state.pendingArrow);
    state.pendingArrow = null;
  }

  if (state.pendingPath && !state.hidePendingPath) {
    const latlngs = state.pendingPath.points;
    const group = L.layerGroup();
    for (let i = 0; i < latlngs.length - 1; i += 1) {
      const seg = [latlngs[i], latlngs[i + 1]];
      L.polyline(seg, { color: "#94a3b8", weight: 4, dashArray: "6 6" }).addTo(group);
    }
    for (const p of latlngs) {
      L.circleMarker(p, { radius: 4, color: "#94a3b8", fillColor: "#e2e8f0", fillOpacity: 1 }).addTo(group);
    }
    group.addTo(state.map);
    state.pendingPath.group = group;
    if (state.pendingDestReady) {
      const last = latlngs[latlngs.length - 1];
      const destIcon = L.divIcon({
        html: "<div style='font-size:28px'>🎯</div>",
        className: "",
        iconSize: [32, 32],
      });
      state.pendingDest = L.marker(last, { icon: destIcon }).addTo(state.map);
    }

    // direction arrow removed
  }
}

async function openTurnFlow() {
  if (state.stageLock) return;
  state.stageLock = true;
  try {
    if (state.recentPathGroup) {
      state.map.removeLayer(state.recentPathGroup);
      state.recentPathGroup = null;
    }
    state.recentPath = null;
    state.selectedLineKey = null;
    state.selectedDirectionStationId = null;
    state.pendingDestReady = false;
    state.hidePendingPath = false;
    state.holdCheckinStage = false;
    state.pendingCurrentStation = null;
    $("routeResult").textContent = "";
    $("stageResult").textContent = "";

    await fetchRollOptions();
    const lines = state.rollOptions.line_choices || [];
    const lineEntries = lines.map((key) => ({ key, label: lineLabel(key) }));

    if (lines.length > 1) {
      setStage({
        label: "ルーレット",
        title: "路線を決めます",
        choices: `候補: ${lineEntries.map((x) => x.label).join(" / ")}`,
        buttonText: "路線ルーレットを回す",
        result: "",
      });
      showRoulette(true);
      previewRoulette($("rouletteWheel"), lineEntries.map((x) => x.label));
      enableStageAction(spinLineThenNext);
      return;
    }

    state.selectedLineKey = lines[0] || null;
    await afterLineFixed();
  } finally {
    state.stageLock = false;
  }
}

async function spinLineThenNext() {
  if (state.stageLock) return;
  state.stageLock = true;
  try {
    const lines = state.rollOptions.line_choices || [];
    const lineEntries = lines.map((key) => ({ key, label: lineLabel(key) }));
    const picked = pickRandom(lineEntries);
    state.selectedLineKey = picked?.key || null;
    disableStageAction();
    const labels = lineEntries.map((x) => x.label);
    drawRoulette($("rouletteWheel"), labels);
    spinRouletteToValue($("rouletteWheel"), labels, picked?.label || "");
    startPointerSync($("rouletteWheel"), labels, (txt) => {
      $("stageResult").textContent = `決定: ${txt}`;
    });
    await waitWheelStop($("rouletteWheel"));
    stopPointerSync();
    $("stageResult").textContent = `決定: ${picked?.label || ""}`;
    await waitStageNext("次へ");
    await afterLineFixed();
  } finally {
    state.stageLock = false;
  }
}

async function afterLineFixed() {
  await fetchRollOptions(state.selectedLineKey);
  const dirs = state.rollOptions.direction_choices || [];

  if (dirs.length > 1) {
    setStage({
      label: "ルーレット",
      title: "方面を決めます",
      choices: formatDirectionChoices(dirs),
      buttonText: "方面ルーレットを回す",
      result: "",
    });
    showRoulette(true);
    previewRoulette($("rouletteWheel"), dirs.map((d) => d.name));
    enableStageAction(spinDirectionThenDice);
    return;
  }

  state.selectedDirectionStationId = dirs.length === 1 ? dirs[0].station_id : null;
  await showDiceStage();
}

async function spinDirectionThenDice() {
  if (state.stageLock) return;
  state.stageLock = true;
  try {
    const dirs = state.rollOptions.direction_choices || [];
    const picked = pickRandom(dirs);
    state.selectedDirectionStationId = picked.station_id;
    disableStageAction();
    const labels = dirs.map((d) => d.name);
    drawRoulette($("rouletteWheel"), labels);
    spinRouletteToValue($("rouletteWheel"), labels, picked.name);
    startPointerSync($("rouletteWheel"), labels, (txt) => {
      $("stageResult").textContent = `決定: ${txt} 方面`;
    });
    await waitWheelStop($("rouletteWheel"));
    stopPointerSync();
    $("stageResult").textContent = `決定: ${picked.name} 方面`;
    await waitStageNext("次へ");
    await showDiceStage();
  } finally {
    state.stageLock = false;
  }
}

async function showDiceStage() {
  setStage({
    label: "サイコロ",
    title: "サイコロを振ります",
    choices: "準備ができたら押してください",
    buttonText: "サイコロを振る",
    result: "",
  });
  showRoulette(true);
  previewRoulette($("rouletteWheel"), ["1","2","3","4","5","6"]);
  enableStageAction(rollDice);
}

async function showCheckinStage() {
  const me = (state.gameState?.players || []).find((p) => p.user_id === state.userId);
  const isTerminalCheckin = (me?.checkin_phase === 1 && me?.pending_terminal_station_name);
  const station = isTerminalCheckin
    ? me.pending_terminal_station_name
    : (me?.pending_station_name || "目的地");
  setStage({
    label: "移動",
    title: `${station} 駅に向かってください`,
    choices: isTerminalCheckin
      ? "終点に到着したら改札を出て、入り直してください"
      : "駅に到着したらチェックインしてください",
    buttonText: "チェックイン",
    result: "",
  });
  showRoulette(false);
  enableStageAction(doCheckin);
}

async function doCheckin() {
  disableStageAction();
  const out = await api(`/api/games/${state.currentGameCode}/checkin`, "POST");

  // Ensure the player marker is updated immediately on checkin (especially for transfer checkins)
  // even if pendingPath is not present or being updated.
  const mapStations = (state.gameState?.map?.stations || []);
  const stationId = out.station_id ? String(out.station_id) : null;
  let checkinStation = stationId
    ? mapStations.find((s) => String(s.station_id) === stationId)
    : null;
  if (!checkinStation && out.station_name) {
    checkinStation = findStationByName(mapStations, out.station_name);
  }

  let resolvedLatLon = null;
  if (checkinStation) {
    const lat = Number(checkinStation.lat);
    const lon = Number(checkinStation.lon);
    if (Number.isFinite(lat) && Number.isFinite(lon)) {
      resolvedLatLon = [lat, lon];
    }
  }

  // If the server didn't return a station name, try to derive it from our pendingPath data.
  let fallbackStationName = null;
  if ((!out.station_name || !out.station_name.trim()) && stationId && state.pendingPath?.stationIds?.length && state.pendingPath?.stationNames?.length) {
    const idx = state.pendingPath.stationIds.findIndex((id) => String(id) === stationId);
    if (idx !== -1) {
      fallbackStationName = state.pendingPath.stationNames[idx];
    }
  }

  // Fallback: use pendingPath to resolve station coordinates (common when map data lacks coords)
  if (!resolvedLatLon && stationId && state.pendingPath?.stationIds?.length && state.pendingPath?.points?.length) {
    const idx = state.pendingPath.stationIds.findIndex((id) => String(id) === stationId);
    if (idx !== -1 && state.pendingPath.points[idx]) {
      resolvedLatLon = state.pendingPath.points[idx];
    }
  }

  // If we still don't have coords, fall back to current marker or player coords (so at least name updates).
  if (!resolvedLatLon && state.mapMarkers.has(state.userId)) {
    const pos = state.mapMarkers.get(state.userId).getLatLng();
    resolvedLatLon = [pos.lat, pos.lng];
  }
  if (!resolvedLatLon) {
    const me = (state.gameState?.players || []).find((p) => p.user_id === state.userId);
    if (me && Number.isFinite(Number(me.lat)) && Number.isFinite(Number(me.lon))) {
      resolvedLatLon = [Number(me.lat), Number(me.lon)];
    }
  }

  if (resolvedLatLon) {
    const nameToUse = out.station_name || fallbackStationName || (checkinStation?.station_name || checkinStation?.name || "");
    applyPendingCurrentStation({
      station_name: nameToUse,
      lat: resolvedLatLon[0],
      lon: resolvedLatLon[1],
      station_id: stationId,
    }, nameToUse);
  }

  if (out.phase === "terminal") {
    setStage({
      label: "終点チェックイン完了",
      title: `${out.station_name} でチェックインしました`,
      choices: `${out.next_checkin_station_name}駅へ向かってください`,
      buttonText: "次のチェックインへ",
      result: "",
    });
    if (state.pendingPath && state.pendingPath.points) {
      appendTrailPoints(state.pendingPath.points);
    }
    const me = (state.gameState?.players || []).find((p) => p.user_id === state.userId);
    let terminalPos = null;
    if (out.station_id) {
      const st = (state.gameState?.map?.stations || []).find((s) => String(s.station_id) === String(out.station_id));
      if (st) terminalPos = [Number(st.lat), Number(st.lon)];
    }
    if (!terminalPos && state.pendingPath && state.pendingPath.points) {
      terminalPos = state.pendingPath.points[state.pendingPath.points.length - 1] || null;
    }
    if (terminalPos) {
      if (me) {
        me.lat = Number(terminalPos[0]);
        me.lon = Number(terminalPos[1]);
        me.current_station_name = out.station_name;
      }
      state.pendingCurrentStation = {
        name: String(out.station_name || ""),
        lat: Number(terminalPos[0]),
        lon: Number(terminalPos[1]),
        stationId: String(out.station_id || ""),
      };
      if (state.mapMarkers.has(state.userId)) {
        state.mapMarkers.get(state.userId).setLatLng([Number(terminalPos[0]), Number(terminalPos[1])]);
      } else if (state.map) {
        const iconVal = String(me?.icon || "🚃");
        let icon = L.divIcon({ html: `<div style="font-size:20px">${me?.icon || "🚃"}</div>`, className: "", iconSize: [24, 24] });
        if (iconVal.startsWith("http://") || iconVal.startsWith("https://") || iconVal.startsWith("/static/")) {
          icon = L.icon({ iconUrl: iconVal, iconSize: [28, 28], className: "leaflet-user-icon" });
        }
        const m = L.marker([Number(terminalPos[0]), Number(terminalPos[1])], { icon }).addTo(state.map);
        state.mapMarkers.set(state.userId, m);
      }
    }
    if (me) renderMapLeaflet(state.gameState, me);
    if (state.pendingDest) {
      state.map.removeLayer(state.pendingDest);
      state.pendingDest = null;
    }
    if (state.pendingPath && state.pendingPath.group) {
      state.map.removeLayer(state.pendingPath.group);
    }
    state.pendingPath = null;
    state.holdCheckinStage = true;
    enableStageAction(() => {
      state.holdCheckinStage = false;
      showCheckinStage();
    });
    return;
  }
  let partialCheckin = false;
  if (state.pendingPath && state.pendingPath.points) {
    const pendingPts = state.pendingPath.points;
    const pendingIds = Array.isArray(state.pendingPath.stationIds)
      ? state.pendingPath.stationIds.map((x) => String(x))
      : null;
    const me = (state.gameState?.players || []).find((p) => p.user_id === state.userId);
    let checkinPos = null;
    if (out.station_id) {
      const st = (state.gameState?.map?.stations || []).find((s) => String(s.station_id) === String(out.station_id));
      if (st) checkinPos = [Number(st.lat), Number(st.lon)];
    }
    let splitIdx = -1;
    if (out.station_id && pendingIds) {
      splitIdx = pendingIds.findIndex((id) => id === String(out.station_id));
    } else if (checkinPos) {
      splitIdx = pendingPts.findIndex((p) => Number(p[0]) === Number(checkinPos[0]) && Number(p[1]) === Number(checkinPos[1]));
    }
    if (splitIdx >= 0 && splitIdx < pendingPts.length) {
      const traveled = pendingPts.slice(0, splitIdx + 1);
      if (traveled.length >= 2) {
        appendTrailPoints(traveled);
      }
      if (splitIdx < pendingPts.length - 1) {
        const remaining = pendingPts.slice(splitIdx);
        const remainingIds = pendingIds ? pendingIds.slice(splitIdx) : null;
        state.pendingPath = remaining.length >= 2 ? { points: remaining, stationIds: remainingIds } : null;
        partialCheckin = true;
      }
      if (!checkinPos) {
        checkinPos = pendingPts[splitIdx] || null;
      }
    } else {
      appendTrailPoints(pendingPts);
    }
    let last = pendingPts[pendingPts.length - 1];
    if (checkinPos) {
      last = checkinPos;
    }
    if (last) {
      if (me) {
        me.lat = Number(last[0]);
        me.lon = Number(last[1]);
        me.current_station_name = out.station_name;
      }
      state.pendingCurrentStation = {
        name: String(out.station_name || ""),
        lat: Number(last[0]),
        lon: Number(last[1]),
        stationId: String(out.station_id || ""),
      };
      if (state.mapMarkers.has(state.userId)) {
        state.mapMarkers.get(state.userId).setLatLng([Number(last[0]), Number(last[1])]);
      } else if (state.map) {
        const iconVal = String(me?.icon || "🚃");
        let icon = L.divIcon({ html: `<div style="font-size:20px">${me?.icon || "🚃"}</div>`, className: "", iconSize: [24, 24] });
        if (iconVal.startsWith("http://") || iconVal.startsWith("https://") || iconVal.startsWith("/static/")) {
          icon = L.icon({ iconUrl: iconVal, iconSize: [28, 28], className: "leaflet-user-icon" });
        }
        const m = L.marker([Number(last[0]), Number(last[1])], { icon }).addTo(state.map);
        state.mapMarkers.set(state.userId, m);
      }
    }
    if (me) renderMapLeaflet(state.gameState, me);
  }
  if (!partialCheckin) {
    if (state.pendingPath && state.pendingPath.group) {
      state.map.removeLayer(state.pendingPath.group);
    }
    state.pendingPath = null;
    if (state.pendingDest) {
      state.map.removeLayer(state.pendingDest);
      state.pendingDest = null;
    }
    if (state.pendingArrow) {
      state.map.removeLayer(state.pendingArrow);
      state.pendingArrow = null;
    }
  }
  setStage({
    label: "チェックイン完了",
    title: `${out.station_name} でチェックインしました`,
    choices: `次のターンまで ${out.next_roll_in_seconds} 秒`,
    buttonText: "状態更新",
    result: "",
  });
  enableStageAction(() => refreshState());
  // wait for user to proceed
  // state.pendingCurrentStation will be cleared by refreshState()
}

function showWaitingStage(waitSeconds) {
  const sec = Math.max(0, Number(waitSeconds || 0));
  setStage({
    label: "待機",
    title: "次のターンまで待機中",
    choices: `残り ${sec} 秒`,
    buttonText: "状態更新",
    result: "",
  });
  showRoulette(false);
  enableStageAction(() => refreshState());
}

function stopWaitingCountdown() {
  if (state.waitingTimer) clearInterval(state.waitingTimer);
  state.waitingTimer = null;
}

function startWaitingCountdown(initialSeconds) {
  stopWaitingCountdown();
  let remain = Math.max(0, Number(initialSeconds || 0));
  showWaitingStage(remain);
  if (remain <= 0) return;
  state.waitingTimer = setInterval(() => {
    remain = Math.max(0, remain - 1);
    showWaitingStage(remain);
    if (remain <= 0) stopWaitingCountdown();
  }, 1000);
}

async function rollDice() {
  if (state.stageLock) return;
  state.stageLock = true;
  try {
    disableStageAction();
    if (state.recentPathGroup) {
      state.map.removeLayer(state.recentPathGroup);
      state.recentPathGroup = null;
    }
    state.recentPath = null;
    const out = await api(`/api/games/${state.currentGameCode}/roll`, "POST", {
      selected_line_key: state.selectedLineKey,
      selected_direction_station_id: state.selectedDirectionStationId,
    });

    state.stagePlayback = true;
    setStage({
      label: "サイコロ",
      title: `${out.from_station_name} から進みます`,
      choices: "サイコロ回転中...",
      buttonText: "進行中",
      result: "",
    });
    showRoulette(true);
    disableStageAction();
    const diceLabels = ["1", "2", "3", "4", "5", "6"];
    drawRoulette($("rouletteWheel"), diceLabels);
    spinRouletteToValue($("rouletteWheel"), diceLabels, String(out.roll));
    startPointerSync($("rouletteWheel"), diceLabels, (txt) => {
      $("stageResult").textContent = `出目: ${txt}`;
    });
    await waitWheelStop($("rouletteWheel"));
    stopPointerSync();
    $("stageResult").textContent = `出目: ${out.roll}`;
    await waitStageNext("次へ");

    const transfers = out.transfer_roulettes || [];
    const mapStations = state.gameState?.map?.stations || [];
    const stationById = new Map(mapStations.map((s) => [String(s.station_id), s]));
    const pathIds = (out.path_station_ids || []).map((sid) => String(sid));
    const pathStations = pathIds.map((sid) => stationById.get(sid)).filter(Boolean);
    const pathNames = out.path_station_names || [];
    let progressIndex = 1;
    let currentLineLabel = state.selectedLineKey;

    const updatePendingToIndex = (idx) => {
      if (idx < 1) return;
      const current = pathStations[idx];
      const upcomingTransferNames = transfers.map((x) => x.at_station_name);
      const nextSegment = buildPendingPathSegment(pathStations, pathNames, upcomingTransferNames, idx);
      state.pendingPath = nextSegment.pendingPath;
      state.pendingDestReady = nextSegment.pendingDestReady;
      if (current) applyPendingCurrentStation(current);
    };

    for (let i = 0; i < transfers.length; i += 1) {
      const t = transfers[i];
      const hasMoreTransfers = i < transfers.length - 1;

      if (t.at_station_name) {
        const idx = findStationIndexByName(pathStations, pathNames, t.at_station_name, progressIndex);
        if (idx !== -1) {
          progressIndex = idx;
          updatePendingToIndex(idx);
        }
      }
      state.hidePendingPath = true;
      if (state.gameState) {
        const me = (state.gameState.players || []).find((p) => p.user_id === state.userId) || null;
        renderMapLeaflet(state.gameState, me);
      }

      setStage({
        label: "途中乗換ルーレット",
        title: `${t.at_station_name} で路線ルーレット`,
        choices: `候補: ${(t.choices || []).join(" / ")}（駅に着く前に回すのを強く推奨）`,
        buttonText: "路線ルーレットを回す",
        result: "",
      });
      showRoulette(true);
      previewRoulette($("rouletteWheel"), t.choices || []);
      await waitStageNext("路線ルーレットを回す");
      disableStageAction();
      const transferLabels = t.choices || [];
      drawRoulette($("rouletteWheel"), transferLabels);
      spinRouletteToValue($("rouletteWheel"), transferLabels, t.selected);
      startPointerSync($("rouletteWheel"), transferLabels, (txt) => {
        $("stageResult").textContent = `決定: ${txt}`;
      });
      await waitWheelStop($("rouletteWheel"));
      stopPointerSync();
      $("stageResult").textContent = `決定: ${t.selected}`;
      await waitStageNext("次へ");

      if (t.direction && (t.direction.choices || []).length > 0) {
        setStage({
          label: "途中方面ルーレット",
          title: `${t.at_station_name} で方面ルーレット`,
          choices: `候補: ${(t.direction.choices || []).map((x) => `${x} 方面`).join(" / ")}（駅に着く前に回すのを強く推奨）`,
          buttonText: "方面ルーレットを回す",
          result: "",
        });
        showRoulette(true);
        previewRoulette($("rouletteWheel"), t.direction.choices || []);
        await waitStageNext("方面ルーレットを回す");
        disableStageAction();
        const dirLabels = t.direction.choices || [];
        drawRoulette($("rouletteWheel"), dirLabels);
        spinRouletteToValue($("rouletteWheel"), dirLabels, t.direction.selected);
        startPointerSync($("rouletteWheel"), dirLabels, (txt) => {
          $("stageResult").textContent = `決定: ${txt} 方面`;
        });
        await waitWheelStop($("rouletteWheel"));
        stopPointerSync();
        $("stageResult").textContent = `決定: ${t.direction.selected} 方面`;
        await waitStageNext("次へ");
      }

      const isTransfer = !!t.selected && (!currentLineLabel || t.selected !== currentLineLabel);
      currentLineLabel = t.selected || currentLineLabel;

      if (isTransfer) {
        setStage({
          label: "乗り換えチェックイン",
          title: `${t.at_station_name}駅に到着`,
          choices: "駅のホームに着いたらチェックインしてください",
          buttonText: "チェックイン",
          result: "",
        });
        showRoulette(false);
        await waitStageNext("チェックイン");
        const traveled = pathStations.slice(0, progressIndex + 1);
        const traveledPts = traveled
          .map((s) => [Number(s.lat), Number(s.lon)])
          .filter((p) => Number.isFinite(p[0]) && Number.isFinite(p[1]));
        appendTrailPoints(traveledPts);

        const nextSegment = buildPendingPathSegment(
          pathStations,
          pathNames,
          transfers.slice(i + 1).map((x) => x.at_station_name),
          progressIndex,
        );
        state.pendingPath = nextSegment.pendingPath;
        state.pendingDestReady = nextSegment.pendingDestReady;
      }

      state.hidePendingPath = false;
      if (t.at_station_name) {
        const atStation = pathStations[progressIndex];
        let stationForApply = atStation;
        const normalizedTarget = normalizeStationName(t.at_station_name);
        const matchInPath = atStation && normalizeStationName(atStation.station_name || atStation.name) === normalizedTarget;
        if (!matchInPath) {
          const stByName = findStationByName(mapStations, t.at_station_name);
          if (stByName) stationForApply = stByName;
        }
        if (stationForApply) {
          applyPendingCurrentStation(stationForApply, t.at_station_name);
        }
      }

      setStage({
        label: "乗り換え案内",
        title: `${t.at_station_name}駅で乗り換え`,
        choices: hasMoreTransfers
          ? `${t.at_station_name}で${t.selected}に乗り換えてください`
          : `${t.at_station_name}で${t.selected}に乗り換え、${out.final_station_name}駅に向かってください`,
        buttonText: "次へ",
        result: "",
      });
      showRoulette(false);
      await waitStageNext("次へ");
    }

    setStage({
      label: "結果",
      title: `${out.final_station_name} に向かってください`,
      choices: out.terminal_bounce
        ? `${out.terminal_bounce.terminal_station_name}まで行って折り返し、${out.final_station_name}駅に向かってください`
        : `${(out.path_station_names && out.path_station_names.length > 1) ? out.path_station_names[1] : out.final_station_name}方面に向かってください / ${out.from_station_name} から ${out.roll} マス進む`,
      buttonText: "チェックイン画面へ",
      result: "",
    });
    enableStageAction(showCheckinStage);
    $("routeResult").textContent = `行くべき駅: ${out.final_station_name}`;
    showRoulette(false);
    if (pathStations.length >= 2) {
      const startIdx = transfers.length ? Math.max(0, progressIndex) : 0;
      const nextSegment = buildPendingPathSegment(
        pathStations,
        pathNames,
        [],
        startIdx,
      );
      state.pendingPath = nextSegment.pendingPath;
      state.pendingDestReady = nextSegment.pendingDestReady;
    }
    state.hidePendingPath = false;
    state.stagePlayback = false;
    await refreshState(true);
  } finally {
    state.stagePlayback = false;
    state.stageLock = false;
  }
}

async function refreshState(skipTurnReset = false) {
  if (!state.currentGameCode) return;
  const data = await api(`/api/games/${state.currentGameCode}`);
  state.gameState = data;

  const multiWaiting = ["multi_race", "multi_station_count"].includes(data.game.mode) && data.game.status === "waiting";
  if (multiWaiting) {
    stopWaitingCountdown();
    renderLobby(data);
    showScreen("screenLobby");
    state.pendingCurrentStation = null;
    return;
  }

  showScreen("screenGame");
  renderGame(data);
  const me = data.players.find((p) => p.user_id === state.userId);
  if (me?.checkin_required) {
    if (state.holdCheckinStage) {
      return;
    }
    stopWaitingCountdown();
    await showCheckinStage();
    return;
  }
  if ((me?.next_roll_in_seconds || 0) > 0) {
    startWaitingCountdown(me.next_roll_in_seconds);
  }
  stopWaitingCountdown();
  // Clear pending state after gameState is updated
  state.pendingCurrentStation = null;
  if (state.pendingPath || state.stagePlayback) {
    return;
  }
  if (!skipTurnReset) {
    await openTurnFlow();
  }
}

async function startGameFromLobby() {
  await api(`/api/games/${state.currentGameCode}/start`, "POST");
  await refreshState();
}

function startPolling() {
  stopPolling();
  state.pollTimer = setInterval(async () => {
    if (!state.currentGameCode) return;
    try {
      const data = await api(`/api/games/${state.currentGameCode}`);
      state.gameState = data;
      const multiWaiting = ["multi_race", "multi_station_count"].includes(data.game.mode) && data.game.status === "waiting";
      if (multiWaiting) {
        stopWaitingCountdown();
        renderLobby(data);
        return;
      }
      renderGame(data);
      if (state.stagePlayback) return;
      const me = data.players.find((p) => p.user_id === state.userId);
      if (me?.checkin_required) {
        stopWaitingCountdown();
        await showCheckinStage();
      } else if ((me?.next_roll_in_seconds || 0) > 0) {
        startWaitingCountdown(me.next_roll_in_seconds);
      } else if (state.pendingPath || state.pendingCurrentStation) {
        // keep current guidance state; don't reset turn flow mid-move
        return;
      }
    } catch {
      // noop
    }
  }, 5000);
}

function stopPolling() {
  if (state.pollTimer) clearInterval(state.pollTimer);
  state.pollTimer = null;
  stopWaitingCountdown();
}

function openRules() {
  $("rulesModal").classList.remove("hidden");
  $("rulesModal").setAttribute("aria-hidden", "false");
}

function closeRules() {
  $("rulesModal").classList.add("hidden");
  $("rulesModal").setAttribute("aria-hidden", "true");
}

function logout() {
  stopPolling();
  state.token = "";
  state.userId = null;
  state.displayName = "";
  state.icon = "🚃";
  state.currentGameCode = "";
  state.gameState = null;
  state.selectedLineKey = null;
  state.selectedDirectionStationId = null;
  state.rollOptions = null;
  state.pendingPath = null;
  state.pendingDest = null;
  state.pendingArrow = null;
  state.pendingDestReady = false;
  state.hidePendingPath = false;
  state.routeTrailPoints = null;
  state.pendingCurrentStation = null;
  state.recentPath = null;
  state.recentPathGroup = null;
  state.holdCheckinStage = false;
  localStorage.removeItem("ts_token");
  $("email").value = "";
  $("code").value = "";
  $("authInfo").textContent = "";
  $("createInfo").textContent = "";
  $("lobbyGameInfo").textContent = "";
  $("routeResult").textContent = "";
  $("stageResult").textContent = "";
  $("currentStation").textContent = "";
  if (state.map) {
    state.map.remove();
    state.map = null;
  }
  state.mapMarkers = new Map();
  state.mapRoute = null;
  state.lastFollowPos = null;
  state.didInitialFollow = false;
  showScreen("screenLogin");
  startPolling();
}

function wire() {
  on("requestCodeBtn", "click", () => run(requestCode));
  on("verifyCodeBtn", "click", () => run(verifyCode));
  on("saveNicknameBtn", "click", () => run(saveNickname));
  on("iconUploadBtn", "click", () => run(uploadIconImage));
  on("iconInput", "input", () => updateIconPreview($("iconInput").value));
  on("profileToggleBtn", "click", () => {
    $("profilePanel").classList.toggle("hidden");
  });
  on("city", "change", () => run(loadRouteBasedStationSelectors));
  on("startLine", "change", () => run(() => loadStations("start")));
  on("goalLine", "change", () => run(() => loadStations("goal")));
  on("createGameBtn", "click", () => run(createGame));
  on("joinBtn", "click", () => run(joinGame));
  on("startGameBtn", "click", () => run(startGameFromLobby));
  on("refreshLobbyBtn", "click", () => run(refreshState));
  on("rulesBtnCreate", "click", openRules);
  on("rulesBtnGame", "click", openRules);
  on("rulesCloseBtn", "click", closeRules);
  on("rulesModalBackdrop", "click", closeRules);
  on("logoutBtnCreate", "click", logout);
  on("logoutBtnLobby", "click", logout);
  on("logoutBtnGame", "click", logout);
  on("startRouletteBtn", "click", () => run(() => roulettePickStation("start")));
  on("goalRouletteBtn", "click", () => run(() => roulettePickStation("goal")));
  document.querySelectorAll("input[name='playType']").forEach((el) => {
    el.addEventListener("change", updateCreateFormByType);
  });
}

async function run(fn) {
  try {
    await fn();
  } catch (e) {
    alert(e.message || String(e));
  }
}

(async function init() {
  wire();
  await loadConfig();
  showScreen("screenLogin");

  if (state.token) {
    try {
      const me = await api("/api/me");
      state.userId = me.user.id;
      state.displayName = me.user.display_name;
      state.icon = me.user.icon || "🚃";
      $("nicknameInput").value = me.user.display_name;
      $("iconInput").value = state.icon;
      updateIconPreview(state.icon);
      $("nicknameInfo").textContent = "";
      await loadRouteBasedStationSelectors();
      showScreen("screenCreate");
      applyJoinCodeFromQuery();
    } catch {
      localStorage.removeItem("ts_token");
      state.token = "";
      showScreen("screenLogin");
    }
  }

  updateCreateFormByType();
  startPolling();
})();

window.addEventListener("beforeunload", stopPolling);
