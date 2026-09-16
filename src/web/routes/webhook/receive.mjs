// استقبال أحداث واتساب (POST /webhook) + إعادة الحمولات العالقة عند الإقلاع
// القاعدة: حفظ دائم قبل رد 200، والرد فوري، والمعالجة عبر طابور FIFO لكل مرسل.
import { verifyMetaSignature } from "../../middleware.mjs";
import { webhookQueue } from "../../../jobs/queue.mjs";
import { storeGet, storeSet, storeDel, storeKeys } from "../../../../store.mjs";
import { channelForWebhookObject } from "../../../channels/registry.mjs";
import { processWebhookBody } from "./process.mjs";
import { processMessagingBody } from "./messaging.mjs";
import { logEvent } from "../../../../crm.mjs";

// P0-1: امتلاء الطابور (QUEUE_FULL) كان رفضاً صامتاً بعد 200 — نوثقه كرسالة ميتة
// ونحفظ الحمولة بمفتاح dlq لاسترجاعها يدوياً من /admin
function queueDlq(label, body, err) {
  console.error(`  ☠️ سقطت [${label}] من الطابور: ${err?.message || err} — حُفظت كرسالة ميتة`);
  logEvent("dead_letter", { scope: "queue", reason: err?.code || "QUEUE_FULL", label, error: String(err?.message || err).slice(0, 200) }).catch(() => {});
  try {
    const key = `dlq:${Date.now()}:${String(label).slice(0, 60)}`;
    storeSet(key, { at: Date.now(), body }, 7 * 24 * 60 * 60 * 1000).catch(() => {});
  } catch { /* أفضل جهد */ }
}

export function registerReceiveRoute(app) {
  app.post("/webhook", verifyMetaSignature, async (req, res) => {
    const body = req.body;

    // التحقق المبدئي من نوع الحدث عبر طبقة القنوات (وصل: واتساب/ماسنجر/انستغرام)
    const channelId = channelForWebhookObject(body?.object);
    if (!channelId) {
      console.log(`  📥 POST /webhook - object غير معروف: ${body?.object}`);
      return res.sendStatus(404);
    }
    // ماسنجر/انستغرام: رد فوري + طابور FIFO لكل مرسل (نفس سياسة واتساب)
    if (channelId !== "whatsapp") {
      res.status(200).send("EVENT_RECEIVED");
      const firstEv = body.entry?.[0]?.messaging?.[0];
      const senderKey = firstEv?.sender?.id ? `sender:${channelId}:${firstEv.sender.id}` : "unknown";
      webhookQueue.enqueueOrdered(senderKey, `${channelId}:${body.entry?.[0]?.id || "event"}`, async () => {
        await processMessagingBody(body, channelId);
      }).catch((e) => queueDlq(`${channelId}:messaging`, body, e));
      return;
    }

    // P0-3 — سد نافذة فقدان الرسائل في الطيران:
    // نُخزّن الحمولة في kv_store (دائم) قبل رد 200، ويمسحها المعالج بعد اكتماله.
    // لو انقطع السيرفر/أعيد النشر بعد 200 وقبل نهاية المعالجة، تعيد إعادة المعالجة
    // عند الإقلاع (replayInflightWebhooks) التعامل معها — بلا فقد ولا تكرار (dedup بالـ wamid).
    const firstMsg = body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const hasMessages = !!firstMsg?.id;
    const inflightKey = `wbh:inflight:${firstMsg?.id || `${body.entry?.[0]?.id || "event"}:${Date.now()}`}`;

    // P0-3 — استدامة قبل رد 200: نُثبّت الحمولة في kv_store قبل الإقرار حتى لا
    // تضيع رسالة لو انقطع السيرفر بين الاستلام والمعالجة (Meta لا تعيد بعد 200).
    if (hasMessages) {
      try {
        await storeSet(inflightKey, { at: Date.now(), body });
      } catch (e) {
        console.error(`  ⚠️ فشل حفظ الحمولة الطائرة قبل 200: ${e?.message || e}`);
      }
    }

    // رد فوري لواتساب (يمنع إعادة الإرسال = يمنع الرد المكرر)
    res.status(200).send("EVENT_RECEIVED");

    // المعالجة عبر الطابور — مرتبة FIFO لكل مرسل (رسائل نفس الزبون لا تتسابق)
    let senderKey = "unknown";
    try {
      if (firstMsg?.from) senderKey = `sender:${firstMsg.from}`;
    } catch { /* مفتاح افتراضي */ }
    webhookQueue.enqueueOrdered(senderKey, `webhook:${body.entry?.[0]?.id || "event"}`, async () => {
      try {
        await processWebhookBody(body);
      } finally {
        if (hasMessages) await storeDel(inflightKey).catch(() => {});
      }
    }).catch((e) => queueDlq("webhook:whatsapp", body, e));
  });
}

// ──────────────────────────────────────────────
// P0-3 — إعادة المعالجة عند الإقلاع: أي حمولة سُجّلت قبل 200 ولم تُمسح
// (انقطاع/إعادة نشر أثناء الطيران) تُعاد معالجتها.
// الـ dedup بالـ wamid يجعل هذا آمناً تماماً: المعالجة المكتملة تُتخطى، والناقصة تُستكمل.
// ──────────────────────────────────────────────
export async function replayInflightWebhooks() {
  let keys = [];
  try {
    keys = await storeKeys("wbh:inflight:");
  } catch {
    return;
  }
  if (!keys.length) return;
  console.log(`  ♻️ إعادة معالجة ${keys.length} حمولة علّقت أثناء الطيران...`);
  for (const key of keys) {
    let rec = null;
    try {
      rec = await storeGet(key);
    } catch { /*  تجاهل */ }
    if (!rec?.body) {
      await storeDel(key).catch(() => {});
      continue;
    }
    const firstMsg = rec.body.entry?.[0]?.changes?.[0]?.value?.messages?.[0];
    const sender = firstMsg?.from ? `sender:${firstMsg.from}` : "unknown";
    const label = `replay:${key.split(":").slice(-1)[0]}`;
    webhookQueue.enqueueOrdered(sender, label, async () => {
      try {
        await processWebhookBody(rec.body);
      } finally {
        await storeDel(key).catch(() => {});
      }
    });
  }
}
