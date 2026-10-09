const TIME_ZONE = "Asia/Jakarta";
const RETRYABLE_SCHEMA_CODES = new Set(["40P01", "55P03", "40001"]);

function queueMetadata(order = {}) {
  const number = Number(order.queue_number ?? order.queueNumber);
  const rawDate = order.queue_date ?? order.queueDate;
  const date = rawDate instanceof Date && !Number.isNaN(rawDate.getTime()) ? rawDate.toISOString().slice(0, 10) : rawDate;
  const validDate = typeof date === "string" && /^\d{4}-\d{2}-\d{2}$/.test(date) &&
    !Number.isNaN(Date.parse(`${date}T00:00:00Z`)) && new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) === date;
  if (!Number.isInteger(number) || number < 1 || number > 2147483647 || !validDate) {
    return { queueNumber: null, queueDate: null, queueLabel: null };
  }
  return { queueNumber: number, queueDate: date, queueLabel: `A${String(number).padStart(3, "0")}` };
}

async function ensureOrderQueueSchema(sql) {
  // One PostgreSQL statement is also one transaction through Neon's HTTP
  // driver. The trigger is the committed migration marker: another cold
  // instance either sees the complete migration or waits and rechecks it.
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await sql`
        DO $queue_migration$
        BEGIN
          IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'orders'::regclass
                     AND tgname = 'dapoer_order_queue_insert_v1' AND NOT tgisinternal) THEN
            RETURN;
          END IF;
          PERFORM set_config('lock_timeout', '3s', TRUE);
          -- Take the strongest lock immediately or retry. Queuing a weaker
          -- lock then upgrading for ALTER could deadlock an in-flight legacy
          -- stock-first save with a cancellation that is waiting for its stock.
          LOCK TABLE orders IN ACCESS EXCLUSIVE MODE NOWAIT;
          IF EXISTS (SELECT 1 FROM pg_trigger WHERE tgrelid = 'orders'::regclass
                     AND tgname = 'dapoer_order_queue_insert_v1' AND NOT tgisinternal) THEN
            RETURN;
          END IF;
          PERFORM pg_advisory_xact_lock(1885433957, 113);
          ALTER TABLE orders ADD COLUMN IF NOT EXISTS queue_number INTEGER;
          ALTER TABLE orders ADD COLUMN IF NOT EXISTS queue_date DATE;
          CREATE TABLE IF NOT EXISTS order_queue_counters (
            queue_date DATE PRIMARY KEY,
            last_number INTEGER NOT NULL CHECK (last_number > 0)
          );
          -- Preserve existing assignments and every business field. Historical
          -- missing numbers follow created_at/id within their original WIB day.
          UPDATE orders SET queue_date = (created_at AT TIME ZONE 'Asia/Jakarta')::date
          WHERE queue_number IS NOT NULL AND queue_date IS NULL;
          WITH high_water AS (
            SELECT queue_date, MAX(last_number) AS last_number FROM (
              SELECT queue_date, MAX(queue_number) AS last_number
              FROM orders WHERE queue_number IS NOT NULL GROUP BY queue_date
              UNION ALL
              SELECT queue_date, last_number FROM order_queue_counters
            ) AS assigned GROUP BY queue_date
          ), missing AS (
            SELECT id, (created_at AT TIME ZONE 'Asia/Jakarta')::date AS day,
                   ROW_NUMBER() OVER (
                     PARTITION BY (created_at AT TIME ZONE 'Asia/Jakarta')::date
                     ORDER BY created_at, id
                   ) AS position
            FROM orders WHERE queue_number IS NULL
          )
          UPDATE orders SET
            queue_date = missing.day,
            queue_number = (COALESCE(high_water.last_number, 0) + missing.position)::integer
          FROM missing LEFT JOIN high_water ON high_water.queue_date = missing.day
          WHERE orders.id = missing.id;
          INSERT INTO order_queue_counters (queue_date, last_number)
          SELECT queue_date, MAX(queue_number) FROM orders GROUP BY queue_date
          ON CONFLICT (queue_date) DO UPDATE SET
            last_number = GREATEST(order_queue_counters.last_number, EXCLUDED.last_number);
          ALTER TABLE orders ALTER COLUMN queue_number SET NOT NULL;
          ALTER TABLE orders ALTER COLUMN queue_date SET NOT NULL;
          ALTER TABLE orders ADD CONSTRAINT orders_queue_number_positive CHECK (queue_number > 0);
          ALTER TABLE orders ADD CONSTRAINT orders_queue_created_day CHECK (
            queue_date = (created_at AT TIME ZONE 'Asia/Jakarta')::date
          );
          CREATE UNIQUE INDEX orders_queue_date_number_idx ON orders(queue_date, queue_number);

          CREATE OR REPLACE FUNCTION dapoer_allocate_order_queue(p_timestamp TIMESTAMPTZ DEFAULT NULL)
          RETURNS JSONB LANGUAGE plpgsql AS $queue_allocator$
          DECLARE
            allocated_at TIMESTAMPTZ;
            allocated_day DATE;
            allocated_number INTEGER;
          BEGIN
            -- Capture the day only after waiting. A request that crosses WIB
            -- midnight while waiting receives the new day's number and date.
            PERFORM pg_advisory_xact_lock(1885433957, 113);
            allocated_at := COALESCE(p_timestamp, clock_timestamp());
            allocated_day := (allocated_at AT TIME ZONE 'Asia/Jakarta')::date;
            INSERT INTO order_queue_counters(queue_date, last_number)
            VALUES (allocated_day, 1)
            ON CONFLICT (queue_date) DO UPDATE SET
              last_number = order_queue_counters.last_number + 1
            RETURNING last_number INTO allocated_number;
            RETURN jsonb_build_object('number', allocated_number, 'date', allocated_day, 'createdAt', allocated_at);
          END;
          $queue_allocator$;

          CREATE OR REPLACE FUNCTION dapoer_assign_order_queue()
          RETURNS TRIGGER LANGUAGE plpgsql AS $queue_insert$
          DECLARE
            allocation JSONB;
          BEGIN
            IF NEW.queue_number IS NULL AND NEW.queue_date IS NULL THEN
              allocation := dapoer_allocate_order_queue(
                CASE WHEN NEW.created_at = transaction_timestamp() THEN NULL ELSE NEW.created_at END
              );
              NEW.queue_number := (allocation->>'number')::integer;
              NEW.queue_date := (allocation->>'date')::date;
              NEW.created_at := (allocation->>'createdAt')::timestamptz;
              IF NEW.updated_at = transaction_timestamp() THEN NEW.updated_at := NEW.created_at; END IF;
            ELSE
              IF NEW.queue_number IS NULL OR NEW.queue_date IS NULL OR NEW.queue_number < 1 OR
                 NEW.queue_date <> (NEW.created_at AT TIME ZONE 'Asia/Jakarta')::date THEN
                RAISE EXCEPTION 'INVALID_ORDER_QUEUE';
              END IF;
              PERFORM pg_advisory_xact_lock(1885433957, 113);
              INSERT INTO order_queue_counters(queue_date, last_number)
              VALUES (NEW.queue_date, NEW.queue_number)
              ON CONFLICT (queue_date) DO UPDATE SET
                last_number = GREATEST(order_queue_counters.last_number, EXCLUDED.last_number);
            END IF;
            RETURN NEW;
          END;
          $queue_insert$;

          CREATE OR REPLACE FUNCTION dapoer_preserve_order_queue()
          RETURNS TRIGGER LANGUAGE plpgsql AS $queue_immutable$
          BEGIN
            IF NEW.queue_number IS DISTINCT FROM OLD.queue_number OR NEW.queue_date IS DISTINCT FROM OLD.queue_date THEN
              RAISE EXCEPTION 'ORDER_QUEUE_IMMUTABLE';
            END IF;
            RETURN NEW;
          END;
          $queue_immutable$;
          CREATE TRIGGER dapoer_order_queue_immutable_v1
            BEFORE UPDATE OF queue_number, queue_date ON orders
            FOR EACH ROW EXECUTE FUNCTION dapoer_preserve_order_queue();
          CREATE TRIGGER dapoer_order_queue_insert_v1
            BEFORE INSERT ON orders FOR EACH ROW EXECUTE FUNCTION dapoer_assign_order_queue();
        END;
        $queue_migration$
      `;
      return;
    } catch (error) {
      // A request already running the old stock function during deployment can
      // briefly hold inventory before the relation lock. Retry the fully rolled
      // back migration on deadlock/lock timeout; never continue partial DDL.
      if (!RETRYABLE_SCHEMA_CODES.has(error?.code) || attempt === 3) throw error;
      await new Promise(resolve => setTimeout(resolve, 25 * (attempt + 1)));
    }
  }
}

module.exports = { TIME_ZONE, queueMetadata, ensureOrderQueueSchema };
