// ──────────────────────────────────────────────
// حد المعدل — Redis أولاً ثم ذاكرة محلية
// ──────────────────────────────────────────────
const buckets = new Map(); // fallback

function prune(key, windowMs) {
  const now = Date.now();
  const arr = (buckets.get(key) || []).filter((t) => now - t < windowMs);
  buckets.set(key, arr);
  if (buckets.size > 5000) {
    for (const [k, v] of buckets) {
      if (!v.length || now - v[v.length - 1] > windowMs) buckets.delete(k);
      if (buckets.size < 4000) break;
    }
  }
  return arr;
}

async function checkLimitRedis(key, max, windowMs) {
  try {
    const { getRedis } = await import("../jobs/redisClient.mjs");
    const r = await getRedis();
    if (!r) return null;
    const k = `rl:${key}`;
    const count = await r.incr(k);
    if (count === 1) await r.pexpire(k, windowMs);
    const ttl = await r.pttl(k);
    if (count > max) return { allowed: false, retryAfter: Math.max(Math.ceil(ttl / 1000), 1) };
    return { allowed: true, retryAfter: 0 };
  } catch { return null; }
}

export async function checkLimit(key, max, windowMs) {
  const redisRes = await checkLimitRedis(key, max, windowMs);
  if (redisRes) return redisRes;
  const arr = prune(key, windowMs);
  if (arr.length >= max) {
    const retryAfter = Math.ceil((arr[0] + windowMs - Date.now()) / 1000);
    return { allowed: false, retryAfter: Math.max(retryAfter, 1) };
  }
  arr.push(Date.now());
  return { allowed: true, retryAfter: 0 };
}

export function loginKey(tenantId, phone, ip) {
  return `login:${tenantId}:${phone}:${ip}`;
}

export function senderKey(phone) {
  return `sender:${phone}`;
}

export function tenantSendKey(tenantId) {
  return `tSend:${tenantId}`;
}
