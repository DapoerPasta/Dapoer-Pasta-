const crypto = require("node:crypto");
const { isIP } = require("node:net");

const MAX_BODY_BYTES = 16 * 1024;
const DEFAULT_POLICIES = Object.freeze({
  login: { limit: 10, windowSeconds: 15 * 60 },
  chat: { limit: 15, windowSeconds: 60, globalLimit: 300 },
  order: { limit: 10, windowSeconds: 5 * 60 },
  track: { limit: 60, windowSeconds: 60 },
  receipt: { limit: 30, windowSeconds: 60 },
  admin: { limit: 60, windowSeconds: 60 }
});

function securityHeaders(res) {
  res.setHeader("Cache-Control", "private, no-store");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Content-Type-Options", "nosniff");
}

function reject(res, status, message) {
  res.status(status).json({ error: message, reply: message });
  return false;
}

function header(req, name) {
  const value = req.headers?.[name];
  return typeof value === "string" ? value : "";
}

function mutationAllowed(req, environment) {
  if (header(req, "sec-fetch-site").toLowerCase() === "cross-site") return false;
  const origin = req.headers?.origin;
  if (origin === undefined) return true; // Non-browser clients do not supply Origin.
  if (typeof origin !== "string" || origin === "null" || !origin) return false;
  const host = header(req, "host");
  if (!host || /[\s/\\@?#]/.test(host)) return false;
  const protocol = environment.VERCEL === "1" || req.socket?.encrypted ? "https:" : "http:";
  try {
    const source = new URL(origin);
    const target = new URL(`${protocol}//${host}`);
    return source.origin !== "null" && source.origin === target.origin &&
      source.pathname === "/" && !source.search && !source.hash &&
      !source.username && !source.password;
  } catch {
    return false;
  }
}

function validJsonBody(req, options) {
  const rawLength = req.headers?.["content-length"];
  if (rawLength !== undefined && (typeof rawLength !== "string" || !/^\d+$/.test(rawLength))) {
    return { status: 400, message: "Ukuran permintaan tidak valid." };
  }
  if (Number(rawLength || 0) > MAX_BODY_BYTES) {
    return { status: 413, message: "Permintaan terlalu besar." };
  }
  const empty = req.body === undefined || req.body === null || req.body === "";
  const contentType = header(req, "content-type").split(";", 1)[0].trim().toLowerCase();
  if (empty && options.allowEmptyBody && !contentType && Number(rawLength || 0) === 0) return null;
  if (contentType !== "application/json") {
    return { status: 415, message: "Gunakan format JSON untuk permintaan ini." };
  }
  try {
    const serialized = Buffer.isBuffer(req.body)
      ? req.body.toString("utf8")
      : typeof req.body === "string" ? req.body : JSON.stringify(req.body ?? {});
    if (Buffer.byteLength(serialized, "utf8") > MAX_BODY_BYTES) {
      return { status: 413, message: "Permintaan terlalu besar." };
    }
    if (typeof req.body === "string" || Buffer.isBuffer(req.body)) req.body = JSON.parse(serialized);
    if (req.body !== undefined && (req.body === null || typeof req.body !== "object" || Array.isArray(req.body))) {
      return { status: 400, message: "Data JSON tidak valid." };
    }
    return null;
  } catch {
    return { status: 400, message: "Data JSON tidak valid." };
  }
}

function clientIp(req, environment) {
  // @vercel/functions ipAddress() uses x-real-ip, supplied by Vercel Proxy.
  // Other forwarding headers may be caller-controlled; local servers use the
  // actual socket address instead of trusting any forwarded header.
  const raw = environment.VERCEL === "1"
    ? header(req, "x-real-ip").trim()
    : req.socket?.remoteAddress || req.connection?.remoteAddress || "";
  if (!isIP(raw)) return null;
  if (raw.startsWith("::ffff:") && isIP(raw.slice(7)) === 4) return raw.slice(7);
  return isIP(raw) === 6 ? new URL(`http://[${raw}]/`).hostname : raw;
}

function keyHash(kind, value) {
  return crypto.createHash("sha256").update(`${kind}\0${value}`).digest("hex");
}

function createRequestGuard({
  getSql = () => require("./db").getSql(),
  environment = process.env,
  now = Date.now,
  maxMemoryKeys = 5000
} = {}) {
  const memory = new Map();
  let schemaPromise;

  async function ensureSchema(sql) {
    if (!schemaPromise) {
      schemaPromise = (async () => {
        await sql`
          CREATE TABLE IF NOT EXISTS security_rate_limits (
            scope TEXT NOT NULL,
            key_hash TEXT NOT NULL,
            requests BIGINT NOT NULL,
            expires_at TIMESTAMPTZ NOT NULL,
            PRIMARY KEY (scope, key_hash)
          )
        `;
        await sql`CREATE INDEX IF NOT EXISTS security_rate_limits_expiry_idx ON security_rate_limits(expires_at)`;
      })().catch((error) => {
        schemaPromise = undefined;
        throw error;
      });
    }
    await schemaPromise;
  }

  async function consume(sql, scope, hash, limit, windowSeconds) {
    if (sql) {
      await ensureSchema(sql);
      // The conflict update locks this bucket inside Postgres. Requests handled
      // by concurrent serverless instances therefore cannot each take a slot.
      const rows = await sql`
        WITH expired AS (
          DELETE FROM security_rate_limits
          WHERE (scope, key_hash) IN (
            SELECT scope, key_hash FROM security_rate_limits
            WHERE expires_at < NOW() - INTERVAL '1 day'
              AND (scope <> ${scope} OR key_hash <> ${hash})
            LIMIT 100
          )
        )
        INSERT INTO security_rate_limits (scope, key_hash, requests, expires_at)
        VALUES (${scope}, ${hash}, 1, NOW() + ${windowSeconds} * INTERVAL '1 second')
        ON CONFLICT (scope, key_hash) DO UPDATE SET
          requests = CASE WHEN security_rate_limits.expires_at <= NOW()
            THEN 1 ELSE security_rate_limits.requests + 1 END,
          expires_at = CASE WHEN security_rate_limits.expires_at <= NOW()
            THEN NOW() + ${windowSeconds} * INTERVAL '1 second'
            ELSE security_rate_limits.expires_at END
        RETURNING requests,
          CEIL(EXTRACT(EPOCH FROM (expires_at - NOW())))::INTEGER AS retry_after
      `;
      const count = Number(rows?.[0]?.requests);
      const retryAfter = Number(rows?.[0]?.retry_after);
      if (!Number.isFinite(count) || count < 1 || !Number.isFinite(retryAfter)) throw new Error("LIMITER_UNAVAILABLE");
      return { allowed: count <= limit, retryAfter: Math.max(1, Math.ceil(retryAfter)) };
    }
    if (environment.NODE_ENV === "production" || environment.VERCEL) throw new Error("LIMITER_UNAVAILABLE");
    const timestamp = now();
    const key = `${scope}:${hash}`;
    let bucket = memory.get(key);
    if (!bucket || bucket.expiresAt <= timestamp) {
      if (!bucket && memory.size >= maxMemoryKeys) {
        for (const [storedKey, stored] of memory) {
          if (stored.expiresAt <= timestamp) memory.delete(storedKey);
        }
        if (memory.size >= maxMemoryKeys) throw new Error("LIMITER_UNAVAILABLE");
      }
      bucket = { requests: 0, expiresAt: timestamp + windowSeconds * 1000 };
      memory.set(key, bucket);
    }
    bucket.requests += 1;
    return {
      allowed: bucket.requests <= limit,
      retryAfter: Math.max(1, Math.ceil((bucket.expiresAt - timestamp) / 1000))
    };
  }

  return async function guard(req, res, options = {}) {
    securityHeaders(res);
    const methods = options.methods || ["POST"];
    if (!methods.includes(req.method)) {
      res.setHeader("Allow", methods.join(", "));
      return reject(res, 405, "Metode tidak diizinkan.");
    }
    if (!["GET", "HEAD", "OPTIONS"].includes(req.method)) {
      if (!mutationAllowed(req, environment)) return reject(res, 403, "Asal permintaan tidak diizinkan.");
      const bodyError = validJsonBody(req, options);
      if (bodyError) return reject(res, bodyError.status, bodyError.message);
    }
    try {
      const scope = options.scope || "api";
      const policy = { limit: 60, windowSeconds: 60, ...DEFAULT_POLICIES[scope], ...options };
      if (!Number.isSafeInteger(policy.limit) || policy.limit < 1 ||
          !Number.isSafeInteger(policy.windowSeconds) || policy.windowSeconds < 1) throw new Error("INVALID_POLICY");
      const ip = clientIp(req, environment);
      if (!ip) throw new Error("LIMITER_UNAVAILABLE");
      const sql = getSql();
      const checks = [{ scope: `${scope}:ip`, hash: keyHash("ip", ip), limit: policy.limit, seconds: policy.windowSeconds }];
      const account = options.account ?? (scope === "login" ? req.body?.email : undefined);
      if (typeof account === "string" && account.trim()) {
        checks.push({ scope: `${scope}:account`, hash: keyHash("account", account.trim().toLowerCase()), limit: 8, seconds: 15 * 60 });
      }
      if (policy.globalLimit !== undefined) {
        if (!Number.isSafeInteger(policy.globalLimit) || policy.globalLimit < 1) throw new Error("INVALID_POLICY");
        checks.push({ scope: `${scope}:global`, hash: keyHash("global", scope), limit: policy.globalLimit, seconds: 24 * 60 * 60 });
      }
      for (const check of checks) {
        const result = await consume(sql, check.scope, check.hash, check.limit, check.seconds);
        if (!result.allowed) {
          res.setHeader("Retry-After", String(result.retryAfter));
          return reject(res, 429, "Terlalu banyak permintaan. Silakan coba lagi nanti.");
        }
      }
      return true;
    } catch {
      // Database URLs, request bodies and upstream errors must not enter logs.
      return reject(res, 503, "Layanan sementara tidak tersedia. Silakan coba lagi nanti.");
    }
  };
}

module.exports = { guardRequest: createRequestGuard(), createRequestGuard, securityHeaders };
