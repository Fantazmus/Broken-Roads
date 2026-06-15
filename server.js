import cors from "cors";
import express from "express";

const HOST = String(process.env.HOST || "0.0.0.0").trim() || "0.0.0.0";
const PORT = clampInteger(process.env.PORT, 3000, 1, 65535);
const REQUEST_TIMEOUT_MS = clampInteger(process.env.REQUEST_TIMEOUT_MS, 10000, 2000, 30000);
const BROKEN_ROADS_STATUS_CACHE_TTL_MS = clampInteger(process.env.BROKEN_ROADS_STATUS_CACHE_TTL_MS, 60000, 1000, 300000);

const BROKEN_ROADS_STEAM_APP_ID = 1403440;
const BROKEN_ROADS_STEAM_URL = "https://store.steampowered.com/app/1403440/Broken_Roads/";
const BROKEN_ROADS_COMMUNITY_URL = "https://steamcommunity.com/app/1403440/";
const BROKEN_ROADS_DISCUSSIONS_URL = "https://steamcommunity.com/app/1403440/discussions/";
const BROKEN_ROADS_NEWS_URL = "https://store.steampowered.com/news/app/1403440";
const BROKEN_ROADS_DISCORD_URL = "https://discord.gg/W9UZzrk";
const BROKEN_ROADS_SITE_URL = "https://www.brokenroadsgame.com/";

const app = express();
const responseCache = new Map();

app.disable("x-powered-by");
app.use(cors());
app.use(express.json());

function clampInteger(value, fallback, min, max) {
  const parsed = Number.parseInt(String(value ?? ""), 10);

  if (!Number.isFinite(parsed)) {
    return fallback;
  }

  return Math.min(max, Math.max(min, parsed));
}

function normalizeOptionalInteger(value, min, max) {
  if (value === undefined || value === null || value === "") {
    return null;
  }

  const parsed = Number.parseInt(String(value), 10);

  if (!Number.isFinite(parsed)) {
    return null;
  }

  return Math.min(max, Math.max(min, parsed));
}

function sanitizeDisplayText(value, maxLength = 240) {
  return String(value || "")
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function getCachedPayload(key, ttlMs) {
  const cached = responseCache.get(key);

  if (!cached) {
    return null;
  }

  if (Date.now() - cached.createdAt > ttlMs) {
    responseCache.delete(key);
    return null;
  }

  return cached.payload;
}

function setCachedPayload(key, payload) {
  responseCache.set(key, {
    payload,
    createdAt: Date.now()
  });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchPageStatus(url, sourceLabel) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(url, {
      method: "GET",
      headers: {
        "User-Agent": "falloutfanatics-broken-roads-api/1.0",
        Accept: "text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8"
      },
      redirect: "follow",
      signal: controller.signal
    });

    return {
      ok: response.ok,
      status: response.status,
      url: response.url || url
    };
  } catch (error) {
    if (error?.name === "AbortError") {
      throw new Error(`${sourceLabel} request timed out`);
    }

    throw error;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function fetchSteamCurrentPlayers(appId = BROKEN_ROADS_STEAM_APP_ID) {
  let lastError = null;

  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
      let payload;

      try {
        const response = await fetch(
          `https://api.steampowered.com/ISteamUserStats/GetNumberOfCurrentPlayers/v1/?appid=${appId}`,
          {
            redirect: "follow",
            signal: controller.signal
          }
        );

        if (!response.ok) {
          throw new Error(`Steam current players API returned HTTP ${response.status}`);
        }

        payload = await response.json();
      } finally {
        clearTimeout(timeoutId);
      }

      return normalizeOptionalInteger(payload?.response?.player_count, 0, 50000000);
    } catch (error) {
      lastError = error;

      if (attempt < 1) {
        await sleep(350);
      }
    }
  }

  throw lastError || new Error("Steam current players API request failed.");
}

function getStateFromStatus(ok, hasValue = true) {
  if (ok === true && hasValue) {
    return "online";
  }

  if (ok === false) {
    return "offline";
  }

  return "unknown";
}

function toHttpValueLabel(statusCode) {
  return statusCode ? `HTTP ${statusCode}` : "—";
}

async function getBrokenRoadsStatusPayload() {
  const cacheKey = "broken-roads:status";
  const cached = getCachedPayload(cacheKey, BROKEN_ROADS_STATUS_CACHE_TTL_MS);

  if (cached?.items && Array.isArray(cached.items)) {
    return {
      ...cached,
      cached: true
    };
  }

  const [
    steamPlayersResult,
    steamStorePageResult,
    communityPageResult,
    discussionsPageResult,
    sitePageResult,
    newsPageResult,
    discordPageResult
  ] = await Promise.allSettled([
    fetchSteamCurrentPlayers(),
    fetchPageStatus(BROKEN_ROADS_STEAM_URL, "Broken Roads Steam store page"),
    fetchPageStatus(BROKEN_ROADS_COMMUNITY_URL, "Broken Roads Steam community page"),
    fetchPageStatus(BROKEN_ROADS_DISCUSSIONS_URL, "Broken Roads Steam discussions page"),
    fetchPageStatus(BROKEN_ROADS_SITE_URL, "Broken Roads official site"),
    fetchPageStatus(BROKEN_ROADS_NEWS_URL, "Broken Roads Steam news page"),
    fetchPageStatus(BROKEN_ROADS_DISCORD_URL, "Broken Roads Discord")
  ]);

  const steamPlayers = steamPlayersResult.status === "fulfilled" ? steamPlayersResult.value : null;
  const steamPlayersError = steamPlayersResult.status === "rejected"
    ? sanitizeDisplayText(steamPlayersResult.reason?.message || "Steam players request failed.", 180)
    : "";

  const steamStorePage = steamStorePageResult.status === "fulfilled" ? steamStorePageResult.value : null;
  const steamStorePageError = steamStorePageResult.status === "rejected"
    ? sanitizeDisplayText(steamStorePageResult.reason?.message || "Steam store request failed.", 180)
    : "";

  const communityPage = communityPageResult.status === "fulfilled" ? communityPageResult.value : null;
  const communityPageError = communityPageResult.status === "rejected"
    ? sanitizeDisplayText(communityPageResult.reason?.message || "Steam community request failed.", 180)
    : "";

  const discussionsPage = discussionsPageResult.status === "fulfilled" ? discussionsPageResult.value : null;
  const discussionsPageError = discussionsPageResult.status === "rejected"
    ? sanitizeDisplayText(discussionsPageResult.reason?.message || "Steam discussions request failed.", 180)
    : "";

  const sitePage = sitePageResult.status === "fulfilled" ? sitePageResult.value : null;
  const sitePageError = sitePageResult.status === "rejected"
    ? sanitizeDisplayText(sitePageResult.reason?.message || "Official site request failed.", 180)
    : "";

  const newsPage = newsPageResult.status === "fulfilled" ? newsPageResult.value : null;
  const newsPageError = newsPageResult.status === "rejected"
    ? sanitizeDisplayText(newsPageResult.reason?.message || "Steam news request failed.", 180)
    : "";

  const discordPage = discordPageResult.status === "fulfilled" ? discordPageResult.value : null;
  const discordPageError = discordPageResult.status === "rejected"
    ? sanitizeDisplayText(discordPageResult.reason?.message || "Discord request failed.", 180)
    : "";

  const items = [
    {
      key: "steam-players",
      kind: "players",
      name: "Steam онлайн",
      sourceLabel: "Steam",
      status: getStateFromStatus(steamPlayers !== null, steamPlayers !== null),
      value: steamPlayers,
      valueLabel: steamPlayers !== null ? String(steamPlayers) : "—",
      httpStatus: null,
      url: BROKEN_ROADS_STEAM_URL,
      title: "Broken Roads on Steam",
      description: "Текущий онлайн Broken Roads в Steam. Это число игроков в PC Steam, а не какой-либо общий серверный онлайн.",
      note: steamPlayersError ? "Steam временно не отдал число игроков." : "Число игроков получено из официального Steam current players API."
    },
    {
      key: "steam-store",
      kind: "store",
      name: "Страница Steam",
      sourceLabel: "Steam Store",
      status: getStateFromStatus(Boolean(steamStorePage?.ok)),
      value: steamStorePage?.status ?? null,
      valueLabel: toHttpValueLabel(steamStorePage?.status ?? null),
      httpStatus: steamStorePage?.status ?? null,
      url: steamStorePage?.url || BROKEN_ROADS_STEAM_URL,
      title: "Broken Roads on Steam",
      description: "Основная страница Broken Roads в Steam с описанием игры, системными требованиями и обновлениями магазина.",
      note: steamStorePageError ? "Страница Steam временно не ответила." : (steamStorePage?.ok ? "Страница Steam доступна." : "Страница Steam сейчас не подтвердила корректный ответ.")
    },
    {
      key: "steam-community",
      kind: "community",
      name: "Центр сообщества",
      sourceLabel: "Steam Community",
      status: getStateFromStatus(Boolean(communityPage?.ok)),
      value: communityPage?.status ?? null,
      valueLabel: toHttpValueLabel(communityPage?.status ?? null),
      httpStatus: communityPage?.status ?? null,
      url: communityPage?.url || BROKEN_ROADS_COMMUNITY_URL,
      title: "Broken Roads Community Hub",
      description: "Центр сообщества Steam для Broken Roads: обсуждения, скриншоты, обзоры и активность игроков.",
      note: communityPageError ? "Центр сообщества временно не ответил." : (communityPage?.ok ? "Центр сообщества доступен." : "Центр сообщества сейчас не подтвердил корректный ответ.")
    },
    {
      key: "steam-discussions",
      kind: "community",
      name: "Обсуждения Steam",
      sourceLabel: "Steam Discussions",
      status: getStateFromStatus(Boolean(discussionsPage?.ok)),
      value: discussionsPage?.status ?? null,
      valueLabel: toHttpValueLabel(discussionsPage?.status ?? null),
      httpStatus: discussionsPage?.status ?? null,
      url: discussionsPage?.url || BROKEN_ROADS_DISCUSSIONS_URL,
      title: "Steam Community :: Broken Roads Discussions",
      description: "Раздел обсуждений Broken Roads в Steam Community с вопросами, ответами и советами игроков.",
      note: discussionsPageError ? "Раздел обсуждений временно не ответил." : (discussionsPage?.ok ? "Раздел обсуждений доступен." : "Раздел обсуждений сейчас не подтвердил корректный ответ.")
    },
    {
      key: "official-site",
      kind: "site",
      name: "Официальный сайт",
      sourceLabel: "Broken Roads",
      status: getStateFromStatus(Boolean(sitePage?.ok)),
      value: sitePage?.status ?? null,
      valueLabel: toHttpValueLabel(sitePage?.status ?? null),
      httpStatus: sitePage?.status ?? null,
      url: sitePage?.url || BROKEN_ROADS_SITE_URL,
      title: "Broken Roads",
      description: "Официальная страница Broken Roads. Здесь обычно находится основная информация по игре, разработчикам и ключевым ссылкам проекта.",
      note: sitePageError ? "Официальный сайт временно не ответил." : (sitePage?.ok ? "Официальный сайт доступен." : "Официальный сайт сейчас не подтвердил корректный ответ.")
    },
    {
      key: "steam-news",
      kind: "news",
      name: "Новости Steam",
      sourceLabel: "Steam News",
      status: getStateFromStatus(Boolean(newsPage?.ok)),
      value: newsPage?.status ?? null,
      valueLabel: toHttpValueLabel(newsPage?.status ?? null),
      httpStatus: newsPage?.status ?? null,
      url: newsPage?.url || BROKEN_ROADS_NEWS_URL,
      title: "Broken Roads News",
      description: "Лента новостей и обновлений Broken Roads в Steam с патчами, объявлениями и заметками разработчиков.",
      note: newsPageError ? "Страница новостей временно не ответила." : (newsPage?.ok ? "Страница новостей доступна." : "Страница новостей сейчас не подтвердила корректный ответ.")
    },
    {
      key: "discord",
      kind: "community",
      name: "Discord",
      sourceLabel: "Discord",
      status: getStateFromStatus(Boolean(discordPage?.ok)),
      value: discordPage?.status ?? null,
      valueLabel: toHttpValueLabel(discordPage?.status ?? null),
      httpStatus: discordPage?.status ?? null,
      url: discordPage?.url || BROKEN_ROADS_DISCORD_URL,
      title: "Broken Roads Discord",
      description: "Официальный Discord Broken Roads для общения с сообществом, обсуждений и новостей по игре.",
      note: discordPageError ? "Discord временно не ответил." : (discordPage?.ok ? "Discord доступен." : "Discord сейчас не подтвердил корректный ответ.")
    }
  ];

  const availableCount = items.filter((item) => item.status === "online").length;
  const offlineCount = items.filter((item) => item.status === "offline").length;
  const unknownCount = items.length - availableCount - offlineCount;
  const overallStatus = offlineCount > 0 ? "degraded" : availableCount > 0 ? "online" : "unknown";

  const payload = {
    service: "falloutfanatics-broken-roads-api",
    source: "public-pages-and-steam",
    fetchedAt: new Date().toISOString(),
    cached: false,
    summary: {
      signalCount: items.length,
      availableCount,
      offlineCount,
      unknownCount,
      steamPlayers,
      overallStatus
    },
    disclaimer: "Broken Roads — одиночная постапокалиптическая RPG от Drop Bear Bytes. Эта страница показывает реальный Steam онлайн и доступность ключевых публичных страниц по игре.",
    items
  };

  setCachedPayload(cacheKey, payload);
  return payload;
}

app.get("/", (_req, res) => {
  res.type("text/plain").send("FalloutFanatics Broken Roads API is running.");
});

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    service: "falloutfanatics-broken-roads-api",
    fetchedAt: new Date().toISOString()
  });
});

app.get("/api/broken-roads-status", async (_req, res) => {
  try {
    const payload = await getBrokenRoadsStatusPayload();
    res.json(payload);
  } catch (error) {
    res.status(502).json({
      ok: false,
      error: "BROKEN_ROADS_STATUS_FETCH_FAILED",
      message: error?.message || "Unable to build Broken Roads status payload.",
      fetchedAt: new Date().toISOString()
    });
  }
});

app.use((_req, res) => {
  res.status(404).json({
    ok: false,
    error: "NOT_FOUND"
  });
});

app.listen(PORT, HOST, () => {
  console.log(`Broken Roads API listening on http://${HOST}:${PORT}`);
});

