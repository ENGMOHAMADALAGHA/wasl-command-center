import { memoryKey } from "../../tenants.mjs";
import { storeGet, storeSet, storeDel } from "../../store.mjs";
import { getHistory } from "../memory/conversations.mjs";
import { tenantDb, systemDb } from "../security/tenantGuard.mjs";

const takeoverKey = (tenantId, phone) => `takeover:${memoryKey(tenantId, phone)}`;
export async function setTakeover(tenantId, phone, enabled, by = "admin", ttlMs = null) {
  if (enabled) await storeSet(takeoverKey(tenantId, phone), { by, at: Date.now() }, ttlMs);
  else await storeDel(takeoverKey(tenantId, phone));
}
export async function isTakeover(tenantId, phone) {
  return !!(await storeGet(takeoverKey(tenantId, phone)));
}
export async function listInbox(tenantFilter) {
  try {
    const T = tenantFilter ? tenantDb(tenantFilter) : systemDb("inbox:global");
    const rows = await T.message.groupBy({
      by: ["tenantId", "phone"],
      _max: { createdAt: true },
      _count: { _all: true },
    });
    // ترتيب قبل القص — Top-200 الحقيقية (كان يقطع 200 عشوائية ثم يرتب)
    rows.sort((a, b) => new Date(b._max.createdAt) - new Date(a._max.createdAt));
    const slice = rows.slice(0, 200);
    // حمولة واحدة لكل محادثة بدل N+1: نجلب آخر رسالة لكل مجموعة بدفعة
    const lasts = await Promise.all(
      slice.map((g) => tenantDb(g.tenantId).message.findFirst({ where: { phone: g.phone }, orderBy: { createdAt: "desc" } }))
    );
    const takeovers = await Promise.all(slice.map((g) => isTakeover(g.tenantId, g.phone)));
    return slice.map((g, i) => ({
      tenantId: g.tenantId,
      phone: g.phone,
      count: g._count._all,
      updatedAt: new Date(g._max.createdAt).getTime(),
      takeover: takeovers[i],
      lastMessage: lasts[i] ? { role: lasts[i].role, text: (lasts[i].text || "").slice(0, 120) } : null,
    }));
  } catch (e) {
    console.error(`  ⚠️ فشل Inbox: ${e.message}`);
    return [];
  }
}
export async function getConversation(tenantId, phone) {
  const msgs = await getHistory(phone, { id: tenantId });
  return msgs;
}
