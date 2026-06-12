import { getStore } from "@netlify/blobs";

const STORE_NAME = "solo-game-records";
const HISTORY_KEY = "history";
const SETTINGS_KEY = "settings";
const DEFAULT_PLAYER_NAMES = [];
const LOCAL_ADMIN_USERNAME = "admin";
const LOCAL_ADMIN_PASSWORD = "admin123456";
const getEnv = (key) => globalThis.Netlify?.env?.get(key) || process.env[key] || "";
const isLocalRuntime = () => getEnv("NETLIFY_DEV") === "true" || (!getEnv("NETLIFY") && !getEnv("CONTEXT"));
const getAdminUsername = () => getEnv("ADMIN_USERNAME") || (isLocalRuntime() ? LOCAL_ADMIN_USERNAME : "");
const getAdminPassword = () =>
  getEnv("ADMIN_PASSWORD") || getEnv("DELETE_HISTORY_PASSWORD") || (isLocalRuntime() ? LOCAL_ADMIN_PASSWORD : "");

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });

const readHistory = async () => {
  const store = getStore(STORE_NAME);
  const records = await store.get(HISTORY_KEY, { type: "json" });
  return Array.isArray(records) ? records : [];
};

const normalizePlayerNames = (names = []) => {
  const seen = new Set();
  const normalized = [];
  for (const name of Array.isArray(names) ? names : []) {
    const value = String(name || "").trim();
    if (!value || seen.has(value)) continue;
    seen.add(value);
    normalized.push(value);
  }
  return normalized.length ? normalized : DEFAULT_PLAYER_NAMES;
};

const readSettings = async () => {
  const store = getStore(STORE_NAME);
  const settings = await store.get(SETTINGS_KEY, { type: "json" });
  return { playerNames: normalizePlayerNames(settings?.playerNames) };
};

const writeSettings = async (settings) => {
  const store = getStore(STORE_NAME);
  const normalized = { playerNames: normalizePlayerNames(settings?.playerNames) };
  await store.setJSON(SETTINGS_KEY, normalized);
  return normalized;
};

const writeHistory = async (history) => {
  const store = getStore(STORE_NAME);
  await store.setJSON(HISTORY_KEY, history.slice(0, 200));
};

const assertAdmin = (body) => {
  const adminPassword = getAdminPassword();
  if (!adminPassword) return "管理员密码没有配置到 Netlify Functions 环境变量。";
  if (body?.username !== getAdminUsername() || body?.password !== adminPassword) return "管理员账号或密码不正确。";
  return "";
};

export default async (request) => {
  try {
    if (request.method === "GET") {
      return json({ history: await readHistory(), settings: await readSettings() });
    }

    const url = new URL(request.url);

    if (request.method === "POST" && url.searchParams.get("action") === "admin-login") {
      const body = await request.json();
      const adminError = assertAdmin(body);
      if (adminError) return json({ error: adminError }, adminError.includes("没有配置") ? 500 : 403);
      return json({ ok: true });
    }

    if (request.method === "POST") {
      const body = await request.json();
      if (!body?.record?.id) return json({ error: "Missing record" }, 400);
      const history = await readHistory();
      const next = [body.record, ...history.filter((record) => record.id !== body.record.id)];
      await writeHistory(next);
      return json({ history: next.slice(0, 200) });
    }

    if (request.method === "PUT" && url.searchParams.get("action") === "settings") {
      const body = await request.json();
      const adminError = assertAdmin(body);
      if (adminError) return json({ error: adminError }, adminError.includes("没有配置") ? 500 : 403);
      return json({ settings: await writeSettings(body.settings || {}) });
    }

    if (request.method === "DELETE") {
      const body = await request.json();
      const adminError = assertAdmin(body);
      if (adminError) return json({ error: adminError }, adminError.includes("没有配置") ? 500 : 403);
      if (!body?.id) return json({ error: "Missing id" }, 400);
      const history = await readHistory();
      const next = history.filter((record) => record.id !== body.id);
      await writeHistory(next);
      return json({ history: next });
    }

    return json({ error: "Method not allowed" }, 405);
  } catch (error) {
    return json({ error: error.message || "Unexpected error" }, 500);
  }
};
