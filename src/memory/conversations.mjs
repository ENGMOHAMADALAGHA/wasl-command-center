import { resolveTenantInput, memoryKey } from "../../tenants.mjs";
import { MAX_HISTORY, MEMORY_TTL_MS } from "../config/env.mjs";
import { tenantDb } from "../security/tenantGuard.mjs";

function keyOf(phone, tenant) {
  const tid = tenant?.id || "wasl-unscoped";
  // عزل تام: tenant + phone (نفس الرقم عند بوتين = ذاكرتين منفصلتين)
  return memoryKey(tid, phone);
}

async function tenantOf(input) {
  return resolveTenantInput(input);
}

const conversations = new Map(); // phone -> [{role, text, timestamp}]
const MAX_CONVERSATIONS = Number(process.env.MEMORY_MAX_KEYS || 2000);

function pruneConversations() {
  if (conversations.size <= MAX_CONVERSATIONS) return;
  // LRU بسيط: احذف الأقدم تحديثاً أولاً
  const entries = [...conversations.entries()].sort((a, b) => (a[1].updatedAt || 0) - (b[1].updatedAt || 0));
  for (const [k] of entries) {
    conversations.delete(k);
    if (conversations.size <= MAX_CONVERSATIONS) break;
  }
}

// ── منع التكرار: Meta يعيد إرسال نفس الرسالة إذا تأخر الـ 200 ──
const seenMessageIds = new Map(); // wamid -> timestamp
const SEEN_TTL_MS = 1000 * 60 * 60 * 24; // 24 ساعة
const SEEN_MAX = Number(process.env.SEEN_MAX_KEYS || 5000);

function pruneSeen() {
  if (seenMessageIds.size <= SEEN_MAX) return;
  const now = Date.now();
  for (const [k, ts] of seenMessageIds) {
    if (now - ts > SEEN_TTL_MS) seenMessageIds.delete(k);
  }
  // لو ما زال ممتلئاً بمعرفات طازجة: احذف الأقدم إدخالاً (Map يحفظ الترتيب)
  for (const k of seenMessageIds.keys()) {
    if (seenMessageIds.size <= SEEN_MAX) break;
    seenMessageIds.delete(k);
  }
}
// تحديث آخر رد للمساعد (مثلاً بعد إلحاق تعليمات الدفع) — كاش + DB
export async function updateLastAssistant(phone, text, tenantInput) {
  const tenant = await tenantOf(tenantInput);
  const key = keyOf(phone, tenant);
  const entry = conversations.get(key);
  if (entry && entry.messages.length) {
    for (let i = entry.messages.length - 1; i >= 0; i--) {
      if (entry.messages[i].role === "assistant") {
        entry.messages[i].text = text;
        break;
      }
    }
    entry.updatedAt = Date.now();
  }
  try {
    const rows = await tenantDb(tenant?.id).message.findMany({
      where: { phone, role: "assistant" },
      orderBy: { createdAt: "desc" },
      take: 1,
    });
    if (rows[0]) {
      await tenantDb(tenant?.id).message.update({
        where: { id: rows[0].id },
        data: { text },
      });
    }
  } catch (e) {
    console.error(`  ⚠️ فشل تحديث الرد: ${e.message}`);
  }
}

export function isDuplicateMessage(msgId) {
  if (!msgId) return false;
  pruneSeen();
  if (seenMessageIds.has(msgId)) return true;
  seenMessageIds.set(msgId, Date.now());
  pruneSeen();
  // ثبات عبر restart: احفظ المعرف في KvStore (fire-and-forget)
  persistSeenMessage(msgId);
  return false;
}

// A5: نظرة خاطفة بلا تعليم — للمكرر المبكر قبل الفويس/الامتثال (لا تكاليف ولا آثار).
// التعليم يبقى لاحقاً عبر isDuplicateMessageAsync بعد الفحوص (حماية P0-2 للرسائل المُسقطة).
export async function hasSeenMessageAsync(msgId) {
  if (!msgId) return false;
  try {
    if (seenMessageIds.has(msgId)) return true;
  } catch { /* ذاكرة فقط */ }
  try {
    const { storeGet } = await import("../../store.mjs");
    if (await storeGet(`wamid:${msgId}`)) {
      try { seenMessageIds.set(msgId, Date.now()); } catch { /* تجاهل */ }
      return true;
    }
  } catch { /* الأمان: غير مرئي = عالج */ }
  return false;
}

// نسخة دائمة: ذاكرة → Redis (SETNX ذري عبر النسخ) → KvStore/DB.
// تُستخدم في الـ webhook لمنع الرد المكرر بعد restart أو عند التوسع.
export async function isDuplicateMessageAsync(msgId) {
  if (!msgId) return false;
  if (seenMessageIds.has(msgId)) return true;
  const remember = (dup) => {
    seenMessageIds.set(msgId, Date.now());
    pruneSeen();
    return dup;
  };
  try {
    const { redisSetNx } = await import("../jobs/redisClient.mjs");
    const dup = await redisSetNx(`wamid:${msgId}`, SEEN_TTL_MS);
    if (dup === true) {
      return remember(true);
    }
    if (dup === false) {
      persistSeenMessage(msgId);
      return remember(false);
    }
    // dup === null: لا Redis — تحقق من DB ثم سجّل
    const { storeGet } = await import("../../store.mjs");
    if (await storeGet(`wamid:${msgId}`)) {
      return remember(true);
    }
    persistSeenMessage(msgId);
    return remember(false);
  } catch {
    return isDuplicateMessage(msgId);
  }
}

function persistSeenMessage(msgId) {
  import("../../store.mjs")
    .then(({ storeSet }) => storeSet(`wamid:${msgId}`, { at: Date.now() }, SEEN_TTL_MS))
    .catch(() => {});
}

export async function getHistory(phone, tenantInput) {
  const tenant = await tenantOf(tenantInput);
  const key = keyOf(phone, tenant);
  const entry = conversations.get(key);
  if (entry) {
    // تنظيف المنتهية
    if (Date.now() - entry.updatedAt > MEMORY_TTL_MS) {
      conversations.delete(key);
    } else {
      return entry.messages;
    }
  }
  // عند غياب الكاش (مثلاً بعد restart) حمّل من Postgres
  try {
    const { tenantDb } = await import("../security/tenantGuard.mjs");
    const rows = await tenantDb(tenant?.id).message.findMany({
      where: { phone },
      orderBy: { createdAt: "desc" },
      take: MAX_HISTORY,
    });
    const messages = rows.reverse().map((row) => ({
      role: row.role, text: row.text, ts: new Date(row.createdAt).getTime(),
    }));
    conversations.set(key, { messages, updatedAt: Date.now() });
    return messages;
  } catch (e) {
    console.error(`  ⚠️ فشل تحميل الذاكرة: ${e.message}`);
  }
  return [];
}

export async function pushHistory(phone, role, text, tenantInput) {
  const tenant = await tenantOf(tenantInput);
  const key = keyOf(phone, tenant);
  let entry = conversations.get(key);
  if (!entry) {
    entry = { messages: [], updatedAt: Date.now() };
    conversations.set(key, entry);
    pruneConversations();
  }
  entry.messages.push({ role, text, ts: Date.now() });
  if (entry.messages.length > MAX_HISTORY) entry.messages.shift();
  entry.updatedAt = Date.now();
  // حفظ دائم في Postgres (لا يضيع عند restart)
  try {
    const { tenantDb } = await import("../security/tenantGuard.mjs");
    await tenantDb(tenant?.id).message.create({
      data: { phone, role, text },
    });
  } catch (e) {
    console.error(`  ⚠️ فشل حفظ الرسالة: ${e.message}`);
  }
}

export function clearMemory(phone, tenantId) {
  if (phone && tenantId) conversations.delete(memoryKey(tenantId, phone));
  else if (phone) {
    // امسح كل مفاتيح هذا الرقم عبر كل البوتات
    for (const k of [...conversations.keys()]) {
      if (k === phone || k.endsWith(`::${phone}`)) conversations.delete(k);
    }
  } else conversations.clear();
}

export function getMemoryStats() {
  return { conversations: conversations.size, maxHistory: MAX_HISTORY };
}
