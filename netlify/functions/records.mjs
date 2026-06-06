import { getStore } from "@netlify/blobs";

const STORE_NAME = "solo-game-records";
const HISTORY_KEY = "history";
const DELETE_PASSWORD = process.env.DELETE_HISTORY_PASSWORD;

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

const writeHistory = async (history) => {
  const store = getStore(STORE_NAME);
  await store.setJSON(HISTORY_KEY, history.slice(0, 200));
};

export default async (request) => {
  try {
    if (request.method === "GET") {
      return json({ history: await readHistory() });
    }

    if (request.method === "POST") {
      const body = await request.json();
      if (!body?.record?.id) return json({ error: "Missing record" }, 400);
      const history = await readHistory();
      const next = [body.record, ...history.filter((record) => record.id !== body.record.id)];
      await writeHistory(next);
      return json({ history: next.slice(0, 200) });
    }

    if (request.method === "DELETE") {
      const body = await request.json();
      if (!DELETE_PASSWORD) return json({ error: "Delete password is not configured" }, 500);
      if (body?.password !== DELETE_PASSWORD) return json({ error: "Invalid password" }, 403);
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
