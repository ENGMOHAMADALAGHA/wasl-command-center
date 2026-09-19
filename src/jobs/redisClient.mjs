// ──────────────────────────────────────────────
// عميل Redis الاختياري (للطوابير الدائمة + dedup + rate-limit)
// - بدون REDIS_URL أو بدون حزمة ioredis → يرجع null ويعمل وضع الذاكرة.
// - التحميل كسول ولا يكسر الإقلاع أبداً.
// ──────────────────────────────────────────────
let clientPromise = null;
let unavailableLogged = false;

export async function getRedis() {
  const REDIS_URL = process.env.REDIS_URL || (await import("../config/env.mjs").then(m=>m.REDIS_URL).catch(()=> ""));
  if (!REDIS_URL) return null;
  if (!clientPromise) {
    clientPromise = (async () => {
      try {
        const { default: Redis } = await import("ioredis");
        const client = new Redis(REDIS_URL, {
          maxRetriesPerRequest: 2,
          enableReadyCheck: true,
          lazyConnect: false,
        });
        client.on("error", (e) => console.error(`  ❌ Redis: ${e.message}`));
        await client.ping();
        console.log("  🔗 Redis متصل — الطوابير الدائمة مفعّلة");
        return client;
      } catch (e) {
        if (!unavailableLogged) {
          console.warn(`  ⚠️ Redis غير متاح (${e.message?.slice(0, 100)}) — رجوع لوضع الذاكرة`);
          unavailableLogged = true;
        }
        return null;
      }
    })();
  }
  return clientPromise;
}

// تنفيذ ذري: SETNX مع TTL (لمنع التكرار عبر النسخ)
export async function redisSetNx(key, ttlMs) {
  const r = await getRedis();
  if (!r) return null; // null = لا حكم (استخدم مسار الذاكرة)
  try {
    const res = await r.set(key, String(Date.now()), "PX", ttlMs, "NX");
    return res === "OK" ? false : true; // true = مكرر
  } catch {
    return null;
  }
}
