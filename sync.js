import { createHash } from "node:crypto";

function send(res, status, data) {
  res.status(status).json(data);
}

export default async function handler(req, res) {
  if (req.method === "OPTIONS") {
    res.setHeader("Allow", "GET, PUT, OPTIONS");
    return res.status(204).end();
  }

  if (req.method !== "GET" && req.method !== "PUT") {
    res.setHeader("Allow", "GET, PUT, OPTIONS");
    return send(res, 405, { error: "Niedozwolona metoda" });
  }

  const code = String(req.headers["x-sync-code"] || "").trim();
  if (code.length < 4 || code.length > 100) {
    return send(res, 401, { error: "Nieprawidłowy kod synchronizacji" });
  }

  const redisUrl = process.env.UPSTASH_REDIS_REST_URL;
  const redisToken = process.env.UPSTASH_REDIS_REST_TOKEN;

  if (!redisUrl || !redisToken) {
    return send(res, 500, { error: "Brakuje ustawień bazy Upstash w Vercel" });
  }

  // Kod synchronizacji nie jest zapisywany jako klucz w bazie.
  const keyHash = createHash("sha256").update("dziennik-kotow:" + code).digest("hex");
  const redisKey = "dziennik-kotow:sync:" + keyHash;

  try {
    if (req.method === "GET") {
      const response = await fetch(redisUrl, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${redisToken}`,
          "Content-Type": "application/json"
        },
        body: JSON.stringify(["GET", redisKey])
      });

      const result = await response.json();
      if (!response.ok || result.error) {
        return send(res, 502, { error: "Błąd odczytu z bazy danych" });
      }

      let data = null;
      if (result.result) {
        try {
          data = JSON.parse(result.result);
        } catch {
          return send(res, 500, { error: "Dane synchronizacji są uszkodzone" });
        }
      }
      return send(res, 200, { data });
    }

    let data = req.body;
    if (typeof data === "string") {
      try { data = JSON.parse(data); } catch {
        return send(res, 400, { error: "Nieprawidłowe dane" });
      }
    }

    if (!data || typeof data !== "object" || Array.isArray(data)) {
      return send(res, 400, { error: "Nieprawidłowe dane" });
    }

    // PIN pozostaje lokalny na urządzeniu — tak jak w kodzie strony.
    delete data.pinHash;

    const response = await fetch(redisUrl, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${redisToken}`,
        "Content-Type": "application/json"
      },
      body: JSON.stringify(["SET", redisKey, JSON.stringify(data)])
    });

    const result = await response.json();
    if (!response.ok || result.error || result.result !== "OK") {
      return send(res, 502, { error: "Błąd zapisu do bazy danych" });
    }

    return send(res, 200, { ok: true });
  } catch {
    return send(res, 500, { error: "Nie udało się połączyć z bazą Upstash" });
  }
}
