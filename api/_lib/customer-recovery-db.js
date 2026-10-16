const crypto = require("node:crypto");
const { operationError, fingerprint } = require("./operations");
const { normalizePhone, requiredRequestId, challengeId, codeForChallenge, codeDigest,
  phoneDigest, maskPhone, publicChallenge, recoveredOrder, recoveryWhatsAppUrl } = require("./customer-recovery");

const schemaPromises = new WeakMap();
let defaultSchemaPromise, defaultDatabaseUrl;
const BUSINESS_ERRORS = new Set(["REQUEST_CONFLICT", "RECOVERY_RATE_LIMIT", "RECOVERY_NOT_FOUND",
  "RECOVERY_EXPIRED", "RECOVERY_CONSUMED"]);

async function migrate(sql) {
  await sql`
    DO $recovery_schema$
    BEGIN
      PERFORM pg_advisory_xact_lock(1885433957,121);
      CREATE OR REPLACE FUNCTION dapoer_recovery_phone(p_phone TEXT)
      RETURNS TEXT LANGUAGE plpgsql IMMUTABLE AS $function$
      DECLARE normalized TEXT;
      BEGIN
        IF p_phone IS NULL OR length(p_phone)>40 OR p_phone!~'^[+0-9()[:space:].-]+$' THEN RETURN NULL; END IF;
        normalized:=regexp_replace(p_phone,'[[:space:]().-]','','g');
        IF left(normalized,1)='+' THEN normalized:=substring(normalized FROM 2); END IF;
        IF left(normalized,2)='08' THEN normalized:='62'||substring(normalized FROM 2); END IF;
        IF normalized!~'^628[1-9][0-9]{7,10}$' THEN RETURN NULL; END IF;
        RETURN normalized;
      END;
      $function$;

      CREATE TABLE IF NOT EXISTS customer_recovery_challenges (
        challenge_id TEXT PRIMARY KEY CHECK(challenge_id~'^[a-f0-9]{48}$'),
        request_id UUID NOT NULL UNIQUE,
        fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
        phone TEXT NOT NULL CHECK(phone~'^628[1-9][0-9]{7,10}$'),
        phone_hash TEXT NOT NULL CHECK(length(phone_hash)=64),
        code_hash TEXT NOT NULL CHECK(length(code_hash)=64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
        expires_at TIMESTAMPTZ NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0 CHECK(attempts BETWEEN 0 AND 5),
        issued_at TIMESTAMPTZ,
        issue_request UUID UNIQUE,
        consumed_at TIMESTAMPTZ,
        CHECK(expires_at>created_at)
      );
      CREATE INDEX IF NOT EXISTS customer_recovery_phone_idx ON customer_recovery_challenges(phone_hash,created_at DESC);
      CREATE INDEX IF NOT EXISTS customer_recovery_expiry_idx ON customer_recovery_challenges(expires_at);
      CREATE TABLE IF NOT EXISTS customer_recovery_attempts (
        request_id UUID PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES customer_recovery_challenges(challenge_id) ON DELETE CASCADE,
        fingerprint TEXT NOT NULL CHECK(length(fingerprint)=64),
        result JSONB NOT NULL,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS customer_recovery_attempt_challenge_idx ON customer_recovery_attempts(challenge_id);
      CREATE TABLE IF NOT EXISTS customer_recovery_issues (
        request_id UUID PRIMARY KEY,
        challenge_id TEXT NOT NULL REFERENCES customer_recovery_challenges(challenge_id) ON DELETE CASCADE,
        created_at TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp()
      );
      CREATE INDEX IF NOT EXISTS customer_recovery_issue_challenge_idx ON customer_recovery_issues(challenge_id);

      CREATE OR REPLACE FUNCTION dapoer_recovery_orders(p_phone TEXT)
      RETURNS JSONB LANGUAGE sql VOLATILE AS $function$
        SELECT COALESCE(jsonb_agg(jsonb_build_object('id',eligible.id,'trackingToken',eligible.tracking_token,
          'status',eligible.status,'total',eligible.total,'queueNumber',eligible.queue_number,'queueDate',eligible.queue_date,
          'deliveryMethod',eligible.delivery_method,'shippingFee',eligible.shipping_fee,
          'createdAt',eligible.created_at,'updatedAt',eligible.updated_at) ORDER BY eligible.created_at DESC,eligible.id DESC),'[]'::jsonb)
        FROM (SELECT id,tracking_token,status,total,queue_number,queue_date,delivery_method,shipping_fee,created_at,updated_at FROM orders
          WHERE dapoer_recovery_phone(customer_phone)=p_phone AND status IN('baru','diproses','dikirim')
            AND created_at>=clock_timestamp()-INTERVAL '30 days' AND tracking_token~'^[a-fA-F0-9]{48}$'
          ORDER BY created_at DESC,id DESC LIMIT 20) eligible
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_request_recovery(p_request UUID,p_fingerprint TEXT,p_challenge TEXT,
        p_phone TEXT,p_phone_hash TEXT,p_code_hash TEXT)
      RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE prior customer_recovery_challenges%ROWTYPE; created customer_recovery_challenges%ROWTYPE;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('recovery-request:'||p_request::text,0));
        SELECT * INTO prior FROM customer_recovery_challenges WHERE request_id=p_request;
        IF FOUND THEN
          IF prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
          RETURN jsonb_build_object('challengeId',prior.challenge_id,'expiresAt',prior.expires_at,'status','awaiting-admin');
        END IF;
        PERFORM pg_advisory_xact_lock(hashtextextended('recovery-phone:'||p_phone_hash,0));
        IF EXISTS(SELECT 1 FROM customer_recovery_challenges WHERE phone_hash=p_phone_hash
            AND created_at>clock_timestamp()-INTERVAL '1 minute') OR
          (SELECT COUNT(*) FROM customer_recovery_challenges WHERE phone_hash=p_phone_hash
            AND created_at>clock_timestamp()-INTERVAL '1 hour')>=3 THEN RAISE EXCEPTION 'RECOVERY_RATE_LIMIT'; END IF;
        -- Bounded TTL cleanup touches only this private, temporary feature.
        DELETE FROM customer_recovery_challenges WHERE challenge_id IN
          (SELECT challenge_id FROM customer_recovery_challenges WHERE expires_at<clock_timestamp()-INTERVAL '1 hour'
           ORDER BY expires_at LIMIT 200 FOR UPDATE SKIP LOCKED);
        INSERT INTO customer_recovery_challenges(challenge_id,request_id,fingerprint,phone,phone_hash,code_hash,expires_at)
          VALUES(p_challenge,p_request,p_fingerprint,p_phone,p_phone_hash,p_code_hash,clock_timestamp()+INTERVAL '10 minutes')
          RETURNING * INTO created;
        RETURN jsonb_build_object('challengeId',created.challenge_id,'expiresAt',created.expires_at,'status','awaiting-admin');
      END;
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_issue_recovery(p_challenge TEXT,p_request UUID)
      RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE challenge customer_recovery_challenges%ROWTYPE; prior_id TEXT; stored_phone TEXT;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('recovery-issue:'||p_request::text,0));
        SELECT challenge_id INTO prior_id FROM customer_recovery_issues WHERE request_id=p_request;
        IF FOUND AND prior_id<>p_challenge THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
        -- Preserve request identities from challenges issued by an earlier schema.
        SELECT challenge_id INTO prior_id FROM customer_recovery_challenges WHERE issue_request=p_request;
        IF FOUND AND prior_id<>p_challenge THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
        SELECT * INTO challenge FROM customer_recovery_challenges WHERE challenge_id=p_challenge FOR UPDATE;
        IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_NOT_FOUND'; END IF;
        IF challenge.expires_at<=clock_timestamp() THEN RAISE EXCEPTION 'RECOVERY_EXPIRED'; END IF;
        IF challenge.consumed_at IS NOT NULL OR challenge.attempts>=5 THEN RAISE EXCEPTION 'RECOVERY_CONSUMED'; END IF;
        -- Resolve the destination from eligible persisted orders each time. No
        -- public recipient or order identifier is ever accepted by this action.
        SELECT dapoer_recovery_phone(customer_phone) INTO stored_phone FROM orders
          WHERE dapoer_recovery_phone(customer_phone)=challenge.phone AND status IN('baru','diproses','dikirim')
            AND created_at>=clock_timestamp()-INTERVAL '30 days' AND tracking_token~'^[a-fA-F0-9]{48}$'
          ORDER BY created_at DESC,id DESC LIMIT 1;
        IF NOT FOUND THEN RAISE EXCEPTION 'RECOVERY_NOT_FOUND'; END IF;
        IF challenge.issued_at IS NULL THEN
          UPDATE customer_recovery_challenges SET issued_at=clock_timestamp(),issue_request=p_request
            WHERE challenge_id=p_challenge;
        END IF;
        INSERT INTO customer_recovery_issues(request_id,challenge_id) VALUES(p_request,p_challenge)
          ON CONFLICT(request_id) DO NOTHING;
        RETURN jsonb_build_object('challengeId',p_challenge,'phone',stored_phone,'expiresAt',challenge.expires_at,'status','issued');
      END;
      $function$;

      CREATE OR REPLACE FUNCTION dapoer_verify_recovery(p_challenge TEXT,p_request UUID,p_fingerprint TEXT,p_code_hash TEXT)
      RETURNS JSONB LANGUAGE plpgsql AS $function$
      DECLARE challenge customer_recovery_challenges%ROWTYPE; prior customer_recovery_attempts%ROWTYPE; saved JSONB;
      BEGIN
        PERFORM pg_advisory_xact_lock(hashtextextended('recovery-verify:'||p_request::text,0));
        SELECT * INTO challenge FROM customer_recovery_challenges WHERE challenge_id=p_challenge FOR UPDATE;
        IF NOT FOUND OR challenge.expires_at<=clock_timestamp() THEN RETURN jsonb_build_object('status','expired'); END IF;
        SELECT * INTO prior FROM customer_recovery_attempts WHERE request_id=p_request;
        IF FOUND THEN
          IF prior.challenge_id<>p_challenge OR prior.fingerprint<>p_fingerprint THEN RAISE EXCEPTION 'REQUEST_CONFLICT'; END IF;
          IF prior.result->>'status'='verified' THEN
            -- A retry may recover its original result only while the challenge
            -- is live. Never return a token revoked since that original result,
            -- or add orders created after ownership was verified.
            SELECT COALESCE(jsonb_agg(current_order),'[]'::jsonb) INTO saved
            FROM jsonb_array_elements(dapoer_recovery_orders(challenge.phone)) AS current_orders(current_order)
            WHERE EXISTS(SELECT 1 FROM jsonb_array_elements(prior.result->'orders') AS previous_orders(previous_order)
              WHERE previous_order->>'id'=current_order->>'id'
                AND lower(previous_order->>'trackingToken')=lower(current_order->>'trackingToken'));
            RETURN jsonb_set(prior.result,'{orders}',saved);
          END IF;
          RETURN prior.result;
        END IF;
        IF challenge.consumed_at IS NOT NULL OR challenge.attempts>=5 THEN
          RETURN jsonb_build_object('status','invalid','remainingAttempts',0);
        END IF;
        IF challenge.issued_at IS NULL THEN RETURN jsonb_build_object('status','awaiting-admin'); END IF;
        IF challenge.code_hash=p_code_hash THEN
          saved:=jsonb_build_object('status','verified','orders',dapoer_recovery_orders(challenge.phone));
          UPDATE customer_recovery_challenges SET consumed_at=clock_timestamp(),attempts=attempts+1 WHERE challenge_id=p_challenge;
        ELSE
          saved:=jsonb_build_object('status','invalid','remainingAttempts',4-challenge.attempts);
          UPDATE customer_recovery_challenges SET attempts=attempts+1 WHERE challenge_id=p_challenge;
        END IF;
        INSERT INTO customer_recovery_attempts(request_id,challenge_id,fingerprint,result)
          VALUES(p_request,p_challenge,p_fingerprint,saved);
        RETURN saved;
      END;
      $function$;
    END;
    $recovery_schema$
  `;
  return sql;
}

async function setup(sql) {
  for (let attempt = 0; attempt < 4; attempt++) {
    try { return await migrate(sql); }
    catch (error) {
      const retryable = ["40P01", "55P03", "40001"].includes(error?.code) ||
        (error?.code === "XX000" && error?.message === "tuple concurrently updated");
      if (!retryable || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

async function ensureRecoverySchema(providedSql) {
  if (providedSql) {
    if (!schemaPromises.has(providedSql)) {
      const promise = setup(providedSql).catch(error => { schemaPromises.delete(providedSql); throw error; });
      schemaPromises.set(providedSql, promise);
    }
    return schemaPromises.get(providedSql);
  }
  if (defaultDatabaseUrl !== process.env.DATABASE_URL) {
    defaultDatabaseUrl = process.env.DATABASE_URL;
    defaultSchemaPromise = undefined;
  }
  if (!defaultSchemaPromise) {
    defaultSchemaPromise = (async () => {
      const sql = await require("./db").ensureSchema();
      if (!sql) throw operationError("DATABASE_NOT_CONFIGURED");
      return ensureRecoverySchema(sql);
    })().catch(error => { defaultSchemaPromise = undefined; throw error; });
  }
  return defaultSchemaPromise;
}

function rethrow(error) {
  if (BUSINESS_ERRORS.has(error?.message)) throw operationError(error.message);
  throw error;
}

async function requestRecovery(input = {}, providedSql) {
  const phone = normalizePhone(input.phone);
  const request = requiredRequestId(input.requestId);
  const phoneHash = phoneDigest(phone);
  const id = crypto.randomBytes(24).toString("hex");
  const codeHash = codeDigest(id, codeForChallenge(id));
  const intent = fingerprint({ phoneHash });
  const sql = await ensureRecoverySchema(providedSql);
  try {
    const rows = await sql`SELECT dapoer_request_recovery(${request}::uuid,${intent},${id},${phone},${phoneHash},${codeHash}) AS result`;
    return publicChallenge(rows[0].result);
  } catch (error) { rethrow(error); }
}

async function listRecoveryRequests(providedSql) {
  const sql = await ensureRecoverySchema(providedSql);
  const rows = await sql`
    SELECT challenge.challenge_id,challenge.phone,challenge.created_at,challenge.expires_at,challenge.issued_at,
      jsonb_array_length(dapoer_recovery_orders(challenge.phone)) AS order_count
    FROM customer_recovery_challenges challenge
    WHERE challenge.expires_at>clock_timestamp() AND challenge.consumed_at IS NULL AND challenge.attempts<5
      AND EXISTS(SELECT 1 FROM orders WHERE dapoer_recovery_phone(customer_phone)=challenge.phone
        AND status IN('baru','diproses','dikirim') AND created_at>=clock_timestamp()-INTERVAL '30 days'
        AND tracking_token~'^[a-fA-F0-9]{48}$')
    ORDER BY challenge.created_at DESC,challenge.challenge_id DESC LIMIT 50
  `;
  return rows.map(row => ({ challengeId: row.challenge_id, phone: row.phone, maskedPhone: maskPhone(row.phone),
    createdAt: row.created_at, expiresAt: row.expires_at, status: row.issued_at ? "issued" : "awaiting-admin",
    orderCount: Number(row.order_count) }));
}

async function issueRecoveryCode(input = {}, providedSql) {
  const id = challengeId(input.challengeId);
  const request = requiredRequestId(input.requestId);
  // Fail closed before changing issued state when the signing secret is absent.
  codeForChallenge(id);
  const sql = await ensureRecoverySchema(providedSql);
  try {
    const rows = await sql`SELECT dapoer_issue_recovery(${id},${request}::uuid) AS result`;
    const result = rows[0].result;
    return { challengeId: id, status: "issued", expiresAt: result.expiresAt,
      whatsappUrl: recoveryWhatsAppUrl({ phone: result.phone, challengeId: id, expiresAt: result.expiresAt }) };
  } catch (error) { rethrow(error); }
}

async function verifyRecoveryCode(input = {}, providedSql) {
  const id = challengeId(input.challengeId);
  const request = requiredRequestId(input.requestId);
  const codeHash = codeDigest(id, input.code);
  const intent = fingerprint({ challengeId: id, codeHash });
  const sql = await ensureRecoverySchema(providedSql);
  try {
    const rows = await sql`SELECT dapoer_verify_recovery(${id},${request}::uuid,${intent},${codeHash}) AS result`;
    const result = rows[0].result;
    if (result.status !== "verified") return result;
    return { status: "verified", orders: (Array.isArray(result.orders) ? result.orders : []).map(recoveredOrder).filter(Boolean).slice(0, 20) };
  } catch (error) { rethrow(error); }
}

module.exports = { ensureRecoverySchema, requestRecovery, listRecoveryRequests, issueRecoveryCode, verifyRecoveryCode };
