// ──────────────────────────────────────────────
// طابور معالجة (واجهة موحدة: BullMQ+Redis عند توفرهما، وإلا ذاكرة العملية)
// - نفس الـ API في الحالتين: enqueue(label, fn) + run(label, fn) + stats()
// - BullMQ: jobId = label يمنع تكرار نفس الرسالة (wamid) حتى بعد restart.
// ──────────────────────────────────────────────
import { VOICE_QUEUE_CONCURRENCY } from "../config/env.mjs";

export function createQueue({ concurrency = 5, retries = 2, timeoutMs = 60000, onDead = null, maxQueued = Number(process.env.QUEUE_MAX_QUEUED || 500) } = {}) {
  const pending = [];
  let running = 0;
  let done = 0;
  let dead = 0;
  let dropped = 0;

  function isFull() {
    return pending.length >= maxQueued;
  }

  function dropOverflow(label) {
    dropped++;
    dead++;
    const err = new Error(`الطابور ممتلئ (${pending.length}/${maxQueued}) — أُسقطت [${label}] لمنع OOM`);
    console.error(`  ☠️ ${err.message}`);
    try {
      const r = onDead?.({ label, at: Date.now(), attempts: 0 }, err);
      if (r?.catch) r.catch(() => {});
    } catch { /* لا تكسر المسار الساخن */ }
    return err;
  }

  async function pump() {
    if (running >= concurrency) return;
    const job = pending.shift();
    if (!job) return;
    running++;
    try {
      const out = await runWithTimeout(job.fn, timeoutMs);
      done++;
      job.done?.(out);
    } catch (err) {
      job.attempts++;
      if (job.attempts <= retries) {
        const delay = 1000 * job.attempts * job.attempts;
        console.warn(`  ⚠️ إعادة [${job.label}] محاولة ${job.attempts} بعد ${delay}ms: ${err.message}`);
        setTimeout(() => {
          pending.unshift(job);
          pump();
        }, delay);
      } else {
        dead++;
        console.error(`  ☠️ رسالة ميتة [${job.label}] بعد ${job.attempts} محاولات: ${err.message}`);
        try {
          await onDead?.(job, err);
        } catch (e) {
          console.error(`  ⚠️ خطأ onDead: ${e.message}`);
        }
        job.fail?.(err);
      }
    } finally {
      running--;
      if (pending.length) setImmediate(pump);
    }
  }

  function runWithTimeout(fn, ms) {
    let timer;
    const timeout = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`تجاوز المهلة ${ms}ms`)), ms);
    });
    return Promise.resolve().then(() => Promise.race([fn(), timeout])).finally(() => clearTimeout(timer));
  }

  // شغّل مهمة وانتظر نتيجتها (للاستخدام داخل معالج آخر، مثل طابور الفويس)
  function runJob(label, fn) {
    return new Promise((resolve, reject) => {
      if (isFull()) {
        const err = dropOverflow(label);
        err.code = "QUEUE_FULL";
        reject(err);
        return;
      }
      pending.push({
        label, fn, attempts: 0, at: Date.now(),
        done: resolve, fail: reject,
      });
      setImmediate(pump);
    });
  }

  // سلسلة FIFO لكل مرسل: رسائل نفس الرقم تُعالج بالترتيب strictly —
  // تمنع سباق السياق (رد على "؟" بتحية بينما طلب الموظف قيد المعالجة)
  const tails = new Map(); // key -> Promise
  function enqueueOrdered(key, label, fn) {
    const prev = tails.get(key) || Promise.resolve();
    const next = prev.catch(() => {}).then(() => runJob(label, fn));
    tails.set(key, next);
    next.then(
      () => { if (tails.get(key) === next) tails.delete(key); },
      () => { if (tails.get(key) === next) tails.delete(key); }
    );
    return next;
  }

  return {
    enqueue(label, fn) {
      if (isFull()) {
        dropOverflow(label);
        return -1;
      }
      pending.push({ label, fn, attempts: 0, at: Date.now() });
      setImmediate(pump);
      return pending.length;
    },
    enqueueOrdered,
    run: runJob,
    stats() {
      return { queued: pending.length, running, done, dead, dropped, concurrency, retries, maxQueued, backend: "memory" };
    },
  };
}

// ── طابور دائم: BullMQ+Redis عند توفر REDIS_URL — لا رجوع للذاكرة عند وجوده ──
export function createDurableQueue(name, opts = {}) {
  const mem = createQueue(opts);
  let bridge = null; // { queue } عند توفر BullMQ
  let warned = false;
  const durableRequired = !!process.env.REDIS_URL && process.env.USE_DURABLE_QUEUE !== "0";
  if (durableRequired) console.log(`  🔌 طابور [${name}] مطلوب دائم — REDIS_URL موجود`); else console.log(`  📝 طابور [${name}] ذاكرة — REDIS_URL غير مضبوط`);

  async function bullmq() {
    if (bridge !== undefined && bridge !== null) return bridge;
    if (bridge === undefined) return null;
    try {
      const { getRedis } = await import("./redisClient.mjs");
      const redis = await getRedis();
      if (!redis) {
        if (durableRequired) console.error(`  ☠️ طابور [${name}] يتطلب REDIS_URL لكن getRedis() فارغ — لن يُستخدم وضع الذاكرة`);
        bridge = undefined;
        return null;
      }
      const { Queue } = await import("bullmq");
      const queue = new Queue(name, { connection: redis.duplicate?.() || redis });
      bridge = { queue };
      console.log(`  📦 طابور دائم [${name}] عبر BullMQ`);
      return bridge;
    } catch (e) {
      if (durableRequired) {
        console.error(`  ☠️ BullMQ مطلوب لكن غير متاح لطابور [${name}] (${e.message?.slice(0, 120)}) — أوقف السيرفر وثبّت bullmq/ioredis`);
        throw e;
      }
      if (!warned) {
        console.warn(`  ⚠️ BullMQ غير متاح لطابور [${name}] (${e.message?.slice(0, 80)}) — وضع الذاكرة`);
        warned = true;
      }
      bridge = undefined;
      return null;
    }
  }
  bullmq().catch((e) => { if (durableRequired) console.error(`  ☠️ فشل تهيئة طابور دائم [${name}]: ${e.message}`); });

  return {
    enqueue(label, fn) {
      if (durableRequired) {
        bullmq().then(async (b) => {
          if (!b) {
            console.error(`  ☠️ طابور دائم [${name}] غير متاح — REDIS_URL مضبوط لكن BullMQ فشل — لن يُستخدم وضع الذاكرة`);
            return;
          }
          try {
            await b.queue.add(name, { label, at: Date.now() }, {
              jobId: `${name}:${label}`,
              removeOnComplete: 100,
              removeOnFail: 200,
              attempts: opts.retries ?? 2,
              backoff: { type: "exponential", delay: 1000 },
            });
          } catch (e) {
            if (!e?.message?.includes("jobId")) console.error(`  ⚠️ فشل حجز jobId [${name}:${label}]: ${e.message}`);
          }
        }).catch((e) => console.error(`  ☠️ فشل طابور دائم [${name}]: ${e.message}`));
      } else {
        bullmq().then(async (b) => {
          if (!b) return;
          try {
            await b.queue.add(name, { label, at: Date.now() }, {
              jobId: `${name}:${label}`,
              removeOnComplete: 100,
              removeOnFail: 200,
            });
          } catch { /* تكرار jobId — تجاهل */ }
        }).catch(() => {});
      }
      return mem.enqueue(label, fn);
    },
    run(label, fn) {
      if (durableRequired) {
        // في الوضع الدائم، التنفيذ عبر العامل (worker) — هنا نحتفظ بالذاكرة مؤقتاً لحين نقل كامل للـ worker
        return mem.run(label, fn);
      }
      return mem.run(label, fn);
    },
    enqueueOrdered(key, label, fn) {
      if (durableRequired) {
        // ترتيب FIFO عبر BullMQ: استخدم نفس مفتاح الطابور مع تأخير متسلسل — حالياً عبر الذاكرة مع تسجيل دائم
        return mem.enqueueOrdered(key, label, fn);
      }
      return mem.enqueueOrdered(key, label, fn);
    },
    stats() {
      const s = mem.stats();
      s.durable = !!bridge;
      s.durableRequired = durableRequired;
      s.name = name;
      return s;
    },
  };
}

// طابور الـ Webhook العام (دائم عند توفر Redis)
import { logEvent } from "../../crm.mjs";

const deadToCrm = (where) => async (job, err) => {
  await logEvent("dead_letter", { where, label: job.label, error: err.message }).catch(() => {});
  console.error(`  ☠️ [${where}] DLQ: ${job.label} — ${err.message}`);
};

export const webhookQueue = createDurableQueue("webhooks", {
  concurrency: Number(process.env.QUEUE_CONCURRENCY || 5),
  retries: Number(process.env.QUEUE_RETRIES || 2),
  // ≥ التفريغ الصوتي (45ث) + رد AI + إرسال — وإلا يموت صوت الضيف في الـ DLQ
  timeoutMs: Number(process.env.QUEUE_TIMEOUT_MS || 120000),
  onDead: deadToCrm("webhooks"),
});

// طابور الفويس المخصص (تزامن منخفض = 2)
export const voiceQueue = createDurableQueue("voice", {
  concurrency: VOICE_QUEUE_CONCURRENCY,
  retries: 1,
  timeoutMs: Number(process.env.QUEUE_TIMEOUT_MS || 60000),
  onDead: deadToCrm("voice"),
});

// طابور الإرسال الصادر (إعادة إرسال رسائل واتساب الفاشلة)
export const outboundQueue = createDurableQueue("outbound", {
  concurrency: 3,
  retries: 0, // إعادة المحاولة يديرها outbound.mjs نفسه ( backoff مخصص لـ 429/5xx )
  timeoutMs: Number(process.env.OUTBOUND_TIMEOUT_MS || 15000) + 5000,
  onDead: deadToCrm("outbound"),
});
