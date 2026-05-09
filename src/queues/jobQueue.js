import Queue from "bull";

/**
 * Job queue abstraction with two drivers:
 *   - "inline" (default): jobs run in the same Node process via setImmediate.
 *     The HTTP handler returns 202 first; the work executes immediately
 *     after, off the request thread. No Redis needed — fine for dev.
 *   - "bull": real Bull queues backed by Redis. Use in production with a
 *     separate worker process (`npm run worker`). Requires REDIS_URL.
 *
 * Both drivers expose the same surface:
 *   - registerProcessor(name, processor)
 *   - enqueue(name, data, opts) → { id }
 *
 * Choose explicitly via JOB_QUEUE_DRIVER. Defaults to "inline" so a fresh
 * `npm run dev` works without spinning up Redis.
 */

const driver =
  (process.env.JOB_QUEUE_DRIVER || "inline").toLowerCase() === "bull"
    ? "bull"
    : "inline";

const REDIS_URL = process.env.REDIS_URL || "redis://127.0.0.1:6379";

const processors = new Map();
const queues = new Map();

/**
 * Lazily build a Bull queue for the given name. We share queues per process
 * so the API and worker can connect to the same logical pipeline.
 */
const getBullQueue = (name) => {
  if (queues.has(name)) return queues.get(name);

  const queue = new Queue(name, REDIS_URL, {
    defaultJobOptions: {
      attempts: Number(process.env.JOB_DEFAULT_ATTEMPTS || 2),
      backoff: { type: "exponential", delay: 5_000 },
      removeOnComplete: 200,
      removeOnFail: 500,
    },
  });

  queue.on("error", (error) => {
    // eslint-disable-next-line no-console
    console.error(`[queue:${name}] error`, error.message);
  });

  queues.set(name, queue);
  return queue;
};

/**
 * Register a processor for a named job type. In Bull mode, this attaches the
 * Bull processor (so this should be called inside the worker process).
 * In inline mode, the processor is held in memory and invoked by enqueue().
 */
export const registerProcessor = (name, processor) => {
  processors.set(name, processor);

  if (driver === "bull") {
    const queue = getBullQueue(name);
    const concurrency = Number(process.env.JOB_CONCURRENCY || 2);
    queue.process(concurrency, async (job) => processor(job.data, job));
  }
};

/**
 * Enqueue a job. Returns immediately with `{ id }`. The caller should NOT
 * await the actual work — it executes asynchronously in both drivers.
 */
export const enqueue = async (name, data, opts = {}) => {
  if (driver === "bull") {
    const queue = getBullQueue(name);
    const job = await queue.add(data, opts);
    return { id: String(job.id), driver: "bull" };
  }

  const processor = processors.get(name);
  if (!processor) {
    throw new Error(
      `[jobQueue] No processor registered for "${name}". Call registerProcessor first.`
    );
  }

  // Detach work from the current request so the response can be sent first.
  // Errors are caught and logged so an unhandled rejection doesn't crash.
  setImmediate(() => {
    Promise.resolve()
      .then(() => processor(data, { id: `inline-${Date.now()}` }))
      .catch((error) => {
        // eslint-disable-next-line no-console
        console.error(`[queue:${name}] inline job failed`, error);
      });
  });

  return { id: `inline-${Date.now()}`, driver: "inline" };
};

/**
 * For tests / shutdown: close all known Bull queues.
 */
export const closeAllQueues = async () => {
  if (driver !== "bull") return;
  for (const queue of queues.values()) {
    try {
      await queue.close();
    } catch {
      // best-effort
    }
  }
  queues.clear();
};

export const getDriver = () => driver;
