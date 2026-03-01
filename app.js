const state = {
  username: "",
  password: "",
  profile: null,
  mode: "live",
  categories: [],
  items: [],
  selectedCategory: "",
  selectedItemId: "",
  selectedSeriesId: "",
  currentPlayUrl: "",
  currentPlayType: "",
  epg: [],
  episodes: [],
  search: "",
  playToken: 0,
  retryCount: 0,
  retryTimer: null,
  hls: null,
};

const els = {
  loginCard: document.getElementById("loginCard"),
  playerApp: document.getElementById("playerApp"),
  loginForm: document.getElementById("loginForm"),
  usernameInput: document.getElementById("usernameInput"),
  passwordInput: document.getElementById("passwordInput"),
  loginStatus: document.getElementById("loginStatus"),
  logoutBtn: document.getElementById("logoutBtn"),
  sessionInfo: document.getElementById("sessionInfo"),
  modeButtons: Array.from(document.querySelectorAll(".mode-btn")),
  searchInput: document.getElementById("searchInput"),
  categoryList: document.getElementById("categoryList"),
  itemList: document.getElementById("itemList"),
  contentTitle: document.getElementById("contentTitle"),
  contentMeta: document.getElementById("contentMeta"),
  video: document.getElementById("video"),
  videoOverlay: document.getElementById("videoOverlay"),
  nowPlaying: document.getElementById("nowPlaying"),
  epgList: document.getElementById("epgList"),
  seriesPanel: document.getElementById("seriesPanel"),
  episodeList: document.getElementById("episodeList"),
  closeSeriesBtn: document.getElementById("closeSeriesBtn"),
};

const MODE_CONFIG = {
  live: {
    title: "Live Channels",
    categoryAction: "get_live_categories",
    itemsAction: "get_live_streams",
  },
  movie: {
    title: "Movies",
    categoryAction: "get_vod_categories",
    itemsAction: "get_vod_streams",
  },
  series: {
    title: "Serien",
    categoryAction: "get_series_categories",
    itemsAction: "get_series",
  },
};

bootstrap();

function bootstrap() {
  wireEvents();
  restoreSession();
}

function wireEvents() {
  els.loginForm.addEventListener("submit", onLoginSubmit);
  els.logoutBtn.addEventListener("click", logout);
  els.searchInput.addEventListener("input", () => {
    state.search = els.searchInput.value.trim().toLowerCase();
    renderItems();
  });
  els.closeSeriesBtn.addEventListener("click", () => {
    state.episodes = [];
    state.selectedSeriesId = "";
    els.seriesPanel.classList.add("hidden");
    renderEpisodes();
  });

  els.modeButtons.forEach((btn) => {
    btn.addEventListener("click", async () => {
      const mode = btn.dataset.mode;
      if (!mode || mode === state.mode) {
        return;
      }
      state.mode = mode;
      state.selectedCategory = "";
      state.selectedItemId = "";
      state.episodes = [];
      state.selectedSeriesId = "";
      els.seriesPanel.classList.add("hidden");
      updateModeButtons();
      await loadMode();
    });
  });

  els.video.addEventListener("playing", () => {
    state.retryCount = 0;
    showOverlay("");
  });

  els.video.addEventListener("error", () => {
    scheduleRetry("Video playback error");
  });
}

function restoreSession() {
  try {
    const raw = localStorage.getItem("webplayer_next_session");
    if (!raw) {
      return;
    }
    const parsed = JSON.parse(raw);
    if (!parsed?.username || !parsed?.password) {
      return;
    }
    state.username = parsed.username;
    state.password = parsed.password;
    els.usernameInput.value = parsed.username;
    els.passwordInput.value = parsed.password;
    login(parsed.username, parsed.password, true).catch(() => {
      setLoginStatus("Session konnte nicht wiederhergestellt werden.");
    });
  } catch {
    setLoginStatus("Session-Lesen fehlgeschlagen.");
  }
}

async function onLoginSubmit(event) {
  event.preventDefault();
  const username = els.usernameInput.value.trim();
  const password = els.passwordInput.value.trim();
  await login(username, password, false);
}

async function login(username, password, silent) {
  if (!username || !password) {
    setLoginStatus("Benutzername und Passwort fehlen.");
    return;
  }

  setLoginStatus("Anmeldung wird geprueft ...");

  const payload = await apiCall({ username, password });
  const user = payload?.user_info;
  const server = payload?.server_info;

  if (!user || Number(user.auth) !== 1) {
    throwUiError("Login fehlgeschlagen. Zugangsdaten pruefen.");
  }

  if (String(user.status || "").toLowerCase() !== "active") {
    throwUiError(`Account ist nicht aktiv: ${user.status || "unknown"}`);
  }

  state.username = username;
  state.password = password;
  state.profile = payload;

  localStorage.setItem(
    "webplayer_next_session",
    JSON.stringify({ username, password }),
  );

  els.sessionInfo.textContent = `${user.username} | ${server.url}:${server.port} | aktiv ${user.active_cons}/${user.max_connections}`;
  els.sessionInfo.classList.remove("hidden");
  els.logoutBtn.classList.remove("hidden");
  els.loginCard.classList.add("hidden");
  els.playerApp.classList.remove("hidden");

  if (!silent) {
    setLoginStatus("");
  }

  updateModeButtons();
  await loadMode();
}

function logout() {
  stopPlayback(true);
  localStorage.removeItem("webplayer_next_session");
  state.username = "";
  state.password = "";
  state.profile = null;
  state.categories = [];
  state.items = [];
  state.epg = [];
  state.episodes = [];
  state.search = "";
  state.selectedCategory = "";
  state.selectedItemId = "";
  state.selectedSeriesId = "";
  els.searchInput.value = "";
  els.sessionInfo.classList.add("hidden");
  els.logoutBtn.classList.add("hidden");
  els.loginCard.classList.remove("hidden");
  els.playerApp.classList.add("hidden");
  setLoginStatus("Abgemeldet.");
}

function updateModeButtons() {
  els.modeButtons.forEach((btn) => {
    btn.classList.toggle("active", btn.dataset.mode === state.mode);
  });
}

async function loadMode() {
  const cfg = MODE_CONFIG[state.mode];
  els.contentTitle.textContent = cfg.title;
  els.contentMeta.textContent = "lade Kategorien ...";
  renderListLoading(els.categoryList, "Kategorien laden ...");
  renderListLoading(els.itemList, "Streams laden ...");

  const categoriesRaw = await apiCall({
    username: state.username,
    password: state.password,
    action: cfg.categoryAction,
  });

  state.categories = normalizeCategories(categoriesRaw);
  if (!state.selectedCategory) {
    const firstReal = state.categories.find((entry) => entry.id !== "all");
    state.selectedCategory = firstReal?.id || state.categories[0]?.id || "";
  }

  renderCategories();
  await loadItems();
}

async function loadItems() {
  const cfg = MODE_CONFIG[state.mode];
  els.contentMeta.textContent = "lade Streams ...";

  const params = {
    username: state.username,
    password: state.password,
    action: cfg.itemsAction,
  };

  if (state.selectedCategory && state.selectedCategory !== "all") {
    params.category_id = state.selectedCategory;
  }

  const itemsRaw = await apiCall(params);
  state.items = normalizeItems(itemsRaw, state.mode);

  state.selectedItemId = "";
  state.epg = [];
  renderItems();
  renderEpg();

  els.contentMeta.textContent = `${state.items.length} Eintraege`;
}
function normalizeCategories(input) {
  const rows = Array.isArray(input) ? input : [];
  const mapped = rows
    .map((row) => ({
      id: String(row.category_id ?? row.parent_id ?? ""),
      name: String(row.category_name ?? row.name ?? "Unbekannt"),
    }))
    .filter((row) => row.id);

  return [{ id: "all", name: "Alle" }, ...mapped];
}

function normalizeItems(input, mode) {
  const rows = Array.isArray(input) ? input : [];

  return rows.map((row) => {
    const id = row.stream_id ?? row.series_id ?? row.id;
    const ext = row.container_extension || "mp4";
    return {
      id: String(id ?? ""),
      name: String(row.name ?? row.title ?? "Unbenannt"),
      categoryId: String(row.category_id ?? ""),
      epgChannelId: String(row.epg_channel_id ?? ""),
      streamIcon: String(row.stream_icon ?? row.cover ?? ""),
      extension: String(ext),
      mode,
    };
  });
}

function renderCategories() {
  if (!state.categories.length) {
    renderListEmpty(els.categoryList, "Keine Kategorien gefunden.");
    return;
  }

  const html = state.categories
    .map((cat) => {
      const active = cat.id === state.selectedCategory ? "active" : "";
      return `<button class="${active}" data-cat="${escapeHtml(cat.id)}" type="button">${escapeHtml(cat.name)}</button>`;
    })
    .join("");

  els.categoryList.innerHTML = html;
  els.categoryList.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const next = btn.dataset.cat || "";
      if (!next || next === state.selectedCategory) {
        return;
      }
      state.selectedCategory = next;
      state.search = "";
      els.searchInput.value = "";
      renderCategories();
      await loadItems();
    });
  });
}

function renderItems() {
  let rows = state.items;
  if (state.search) {
    rows = rows.filter((item) => item.name.toLowerCase().includes(state.search));
  }

  if (!rows.length) {
    renderListEmpty(els.itemList, "Keine Eintraege.");
    return;
  }

  const html = rows
    .map((item) => {
      const active = item.id === state.selectedItemId ? "active" : "";
      const subtitle = item.mode === "series" ? `Serie #${item.id}` : `ID ${item.id}`;
      return `
        <button class="${active}" data-item="${escapeHtml(item.id)}" type="button">
          <div class="item-title">${escapeHtml(item.name)}</div>
          <div class="item-sub">${escapeHtml(subtitle)}</div>
        </button>
      `;
    })
    .join("");

  els.itemList.innerHTML = html;
  els.itemList.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const id = btn.dataset.item;
      const item = state.items.find((entry) => entry.id === id);
      if (!item) {
        return;
      }
      state.selectedItemId = id;
      renderItems();
      await selectItem(item);
    });
  });
}

async function selectItem(item) {
  if (item.mode === "live") {
    const url = `/live/${encodeURIComponent(state.username)}/${encodeURIComponent(state.password)}/${encodeURIComponent(item.id)}.m3u8`;
    state.currentPlayType = "live";
    state.retryCount = 0;
    await startPlayback(url, "hls");
    els.nowPlaying.textContent = `Live: ${item.name}`;
    await loadEpg(item.id);
    return;
  }

  if (item.mode === "movie") {
    const ext = item.extension || "mp4";
    const url = `/movie/${encodeURIComponent(state.username)}/${encodeURIComponent(state.password)}/${encodeURIComponent(item.id)}.${encodeURIComponent(ext)}`;
    state.currentPlayType = "movie";
    state.retryCount = 0;
    await startPlayback(url, ext === "m3u8" ? "hls" : "file");
    els.nowPlaying.textContent = `Movie: ${item.name}`;
    state.epg = [];
    renderEpg();
    return;
  }

  if (item.mode === "series") {
    state.currentPlayType = "series";
    state.selectedSeriesId = item.id;
    els.nowPlaying.textContent = `Serie ausgewaehlt: ${item.name}`;
    await loadSeriesEpisodes(item.id);
  }
}

async function loadSeriesEpisodes(seriesId) {
  renderListLoading(els.episodeList, "Folgen laden ...");
  els.seriesPanel.classList.remove("hidden");

  const payload = await apiCall({
    username: state.username,
    password: state.password,
    action: "get_series_info",
    series_id: seriesId,
  });

  const episodesObj = payload?.episodes;
  const episodes = [];

  if (episodesObj && typeof episodesObj === "object") {
    for (const seasonKey of Object.keys(episodesObj)) {
      const seasonEpisodes = Array.isArray(episodesObj[seasonKey])
        ? episodesObj[seasonKey]
        : [];
      seasonEpisodes.forEach((ep) => {
        episodes.push({
          id: String(ep.id ?? ""),
          title: String(ep.title ?? `S${seasonKey}E${ep.episode_num || "?"}`),
          season: String(seasonKey),
          extension: String(ep.container_extension || "mp4"),
        });
      });
    }
  }

  state.episodes = episodes;
  renderEpisodes();

  if (episodes[0]) {
    await selectEpisode(episodes[0]);
  }
}

function renderEpisodes() {
  if (!state.episodes.length) {
    renderListEmpty(els.episodeList, "Keine Folgen gefunden.");
    return;
  }

  const html = state.episodes
    .map((ep) => {
      const active = state.selectedItemId === ep.id ? "active" : "";
      return `<button class="${active}" data-episode="${escapeHtml(ep.id)}" type="button"><div class="item-title">${escapeHtml(ep.title)}</div><div class="item-sub">Season ${escapeHtml(ep.season)}</div></button>`;
    })
    .join("");

  els.episodeList.innerHTML = html;
  els.episodeList.querySelectorAll("button").forEach((btn) => {
    btn.addEventListener("click", async () => {
      const ep = state.episodes.find((row) => row.id === btn.dataset.episode);
      if (!ep) {
        return;
      }
      await selectEpisode(ep);
    });
  });
}

async function selectEpisode(episode) {
  state.selectedItemId = episode.id;
  renderEpisodes();

  const url = `/series/${encodeURIComponent(state.username)}/${encodeURIComponent(state.password)}/${encodeURIComponent(episode.id)}.${encodeURIComponent(episode.extension)}`;
  state.retryCount = 0;
  await startPlayback(url, episode.extension === "m3u8" ? "hls" : "file");
  els.nowPlaying.textContent = `Serie: ${episode.title}`;
  state.epg = [];
  renderEpg();
}
async function loadEpg(streamId) {
  renderListLoading(els.epgList, "EPG laden ...");
  let epgPayload = null;

  try {
    epgPayload = await apiCall({
      username: state.username,
      password: state.password,
      action: "get_short_epg",
      stream_id: streamId,
      limit: 12,
    });
  } catch {
    epgPayload = null;
  }

  let listings = Array.isArray(epgPayload?.epg_listings)
    ? epgPayload.epg_listings
    : [];

  if (!listings.length) {
    try {
      const fallback = await apiCall({
        username: state.username,
        password: state.password,
        action: "get_simple_data_table",
        stream_id: streamId,
      });
      listings = Array.isArray(fallback?.epg_listings)
        ? fallback.epg_listings
        : [];
    } catch {
      listings = [];
    }
  }

  state.epg = listings.map((row) => normalizeEpgRow(row)).filter(Boolean);
  renderEpg();
}

function normalizeEpgRow(row) {
  if (!row || typeof row !== "object") {
    return null;
  }

  const startTs = toTimestamp(row.start_timestamp ?? row.start ?? row.start_datetime);
  const stopTs = toTimestamp(row.stop_timestamp ?? row.stop ?? row.end ?? row.end_datetime);

  return {
    start: startTs,
    stop: stopTs,
    title: decodeMaybeBase64(String(row.title ?? row.name ?? "")),
    description: decodeMaybeBase64(String(row.description ?? row.descr ?? "")),
  };
}

function renderEpg() {
  if (!state.epg.length) {
    renderListEmpty(els.epgList, "Keine EPG-Daten verfuegbar.");
    return;
  }

  const html = state.epg
    .slice(0, 10)
    .map((row) => {
      const range = `${formatTime(row.start)} - ${formatTime(row.stop)}`;
      return `
        <div class="epg-item">
          <div class="epg-time">${escapeHtml(range)}</div>
          <div class="epg-title">${escapeHtml(row.title || "Unbenannt")}</div>
          <div class="epg-desc">${escapeHtml(row.description || "")}</div>
        </div>
      `;
    })
    .join("");

  els.epgList.innerHTML = html;
}

async function startPlayback(url, type) {
  const token = ++state.playToken;
  state.currentPlayUrl = url;
  clearRetry();
  stopPlayback(false);
  showOverlay("Verbinde ...");

  await sleep(900);
  if (token !== state.playToken) {
    return;
  }

  if (type === "hls" || url.endsWith(".m3u8")) {
    await playHls(url, token);
  } else {
    await playFile(url, token);
  }
}

async function playHls(url, token) {
  if (token !== state.playToken) {
    return;
  }

  const video = els.video;
  if (video.canPlayType("application/vnd.apple.mpegurl")) {
    video.src = url;
    try {
      await video.play();
      showOverlay("");
    } catch {
      scheduleRetry("Native HLS Play failed");
    }
    return;
  }

  if (!(window.Hls && window.Hls.isSupported())) {
    showOverlay("HLS wird in diesem Browser nicht unterstuetzt.");
    return;
  }

  state.hls = new window.Hls({
    lowLatencyMode: false,
    maxBufferLength: 20,
    backBufferLength: 10,
  });

  state.hls.on(window.Hls.Events.ERROR, (_, data) => {
    if (data?.fatal) {
      scheduleRetry(`HLS fatal: ${data.type || "unknown"}`);
    }
  });

  state.hls.loadSource(url);
  state.hls.attachMedia(video);
  state.hls.on(window.Hls.Events.MANIFEST_PARSED, async () => {
    if (token !== state.playToken) {
      return;
    }
    try {
      await video.play();
      showOverlay("");
    } catch {
      scheduleRetry("HLS autoplay failed");
    }
  });
}

async function playFile(url, token) {
  if (token !== state.playToken) {
    return;
  }

  const video = els.video;
  video.src = url;
  try {
    await video.play();
    showOverlay("");
  } catch {
    scheduleRetry("File playback failed");
  }
}

function scheduleRetry(reason) {
  if (!state.currentPlayUrl) {
    return;
  }

  if (state.retryCount >= 2) {
    showOverlay(`Playback-Fehler: ${reason}`);
    return;
  }

  const waitMs = state.retryCount === 0 ? 1600 : 3200;
  state.retryCount += 1;
  showOverlay(`Reconnect ${state.retryCount}/2 ...`);
  clearRetry();
  state.retryTimer = setTimeout(() => {
    startPlayback(state.currentPlayUrl, state.currentPlayType === "live" ? "hls" : "file").catch(() => {
      showOverlay("Stream konnte nicht wiederhergestellt werden.");
    });
  }, waitMs);
}

function clearRetry() {
  if (state.retryTimer) {
    clearTimeout(state.retryTimer);
    state.retryTimer = null;
  }
}

function stopPlayback(fullReset) {
  clearRetry();

  if (state.hls) {
    try {
      state.hls.destroy();
    } catch {
      // ignore
    }
    state.hls = null;
  }

  const video = els.video;
  video.pause();
  video.removeAttribute("src");
  video.load();

  if (fullReset) {
    state.playToken += 1;
    state.currentPlayUrl = "";
    state.currentPlayType = "";
    showOverlay("");
  }
}

function showOverlay(text) {
  if (!text) {
    els.videoOverlay.textContent = "";
    els.videoOverlay.classList.add("hidden");
    return;
  }

  els.videoOverlay.textContent = text;
  els.videoOverlay.classList.remove("hidden");
}

function renderListLoading(container, text) {
  container.innerHTML = `<div class="muted">${escapeHtml(text)}</div>`;
}

function renderListEmpty(container, text) {
  container.innerHTML = `<div class="muted">${escapeHtml(text)}</div>`;
}

function setLoginStatus(text) {
  els.loginStatus.textContent = text || "";
}
async function apiCall(params) {
  const url = new URL("/player_api.php", window.location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== null && String(value) !== "") {
      url.searchParams.set(key, String(value));
    }
  }

  const response = await fetch(url.toString(), {
    headers: {
      Accept: "application/json,text/plain,*/*",
    },
  });

  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throwUiError(body || `HTTP ${response.status}`);
  }

  return response.json().catch(() => {
    throwUiError("Antwort ist kein JSON.");
  });
}

function throwUiError(message) {
  showOverlay("");
  setLoginStatus(message);
  throw new Error(message);
}

function escapeHtml(value) {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#039;");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function formatTime(ts) {
  if (!Number.isFinite(ts)) {
    return "--:--";
  }
  const d = new Date(ts * 1000);
  return d.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
}

function toTimestamp(value) {
  if (value === null || value === undefined) {
    return NaN;
  }
  const text = String(value).trim();
  if (!text) {
    return NaN;
  }
  if (/^\d+$/.test(text)) {
    const n = Number.parseInt(text, 10);
    return n > 1_000_000_000_000 ? Math.floor(n / 1000) : n;
  }
  const parsed = Date.parse(text.includes("T") ? text : text.replace(" ", "T") + "Z");
  return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : NaN;
}

function decodeMaybeBase64(value) {
  const text = String(value || "").trim();
  if (!text) {
    return "";
  }
  if (!/^[A-Za-z0-9+/=]+$/.test(text) || text.length % 4 !== 0) {
    return text;
  }
  try {
    const raw = atob(text);
    const bytes = new Uint8Array(raw.length);
    for (let i = 0; i < raw.length; i += 1) {
      bytes[i] = raw.charCodeAt(i);
    }
    return new TextDecoder("utf-8", { fatal: false }).decode(bytes);
  } catch {
    return text;
  }
}
