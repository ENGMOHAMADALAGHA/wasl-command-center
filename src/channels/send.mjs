// ──────────────────────────────────────────────
// امتثال واتساب: إلغاء الاشتراك + تنبيه الموظف + قوالب نافذة 24h
// ──────────────────────────────────────────────
// الإرسال الموحد عبر القناة — نقطة التحويل الوحيدة للردود.
// واتساب: كل الأنواع (نص/أزرار/صور) عبر بديل الامتثال (opt-out + نافذة 24h + قالب).
// ماسنجر/انستغرام: فحص opt-out ثم إرسال مباشر عبر محول القناة.
// كل دوال ctx ترمي عند التخطي/الفشل — المتصلون الحاليون يلتقطونها ويسجلونها already.
import { getChannel } from "./registry.mjs";

export function chOf(ctx) {
  if (ctx?.channel && typeof ctx.channel.sendText === "function") return ctx.channel;
  return getChannel("whatsapp");
}

function skipped(reason) {
  const e = new Error(reason);
  e.code = "SEND_SKIPPED";
  e.reason = reason;
  return e;
}

export async function sendChText(ctx, text) {
  const { from, tenant } = ctx;
  const ch = chOf(ctx);
  if (ch.id !== "whatsapp") {
    const { isOptedOut } = await import("../compliance/messaging.mjs");
    if (await isOptedOut(tenant?.id, from)) {
      console.log(`  ⏭️ تخطي الإرسال [${ch.id}] لـ ${from} — ألغى الاشتراك`);
      throw skipped("opted-out");
    }
    return ch.sendText(from, text, tenant);
  }
  const { sendWithWindowFallback } = await import("../compliance/messaging.mjs");
  const r = await sendWithWindowFallback(from, text, tenant);
  if (!r.ok) throw skipped(r.reason || "send-failed");
  return r.result;
}

export async function sendChButtons(ctx, text, buttons) {
  const { from, tenant } = ctx;
  const ch = chOf(ctx);
  if (ch.id !== "whatsapp") {
    const { isOptedOut } = await import("../compliance/messaging.mjs");
    if (await isOptedOut(tenant?.id, from)) throw skipped("opted-out");
    return ch.sendButtons(from, text, buttons, tenant);
  }
  const { sendButtonsWithFallback } = await import("../compliance/messaging.mjs");
  const r = await sendButtonsWithFallback(from, text, buttons, tenant);
  if (!r.ok) throw skipped(r.reason || "send-failed");
  return r.result;
}

export async function sendChImage(ctx, link, caption = "") {
  const { from, tenant } = ctx;
  const ch = chOf(ctx);
  if (ch.id !== "whatsapp") {
    const { isOptedOut } = await import("../compliance/messaging.mjs");
    if (await isOptedOut(tenant?.id, from)) throw skipped("opted-out");
    return ch.sendImage(from, link, caption, tenant);
  }
  const { sendImageWithFallback } = await import("../compliance/messaging.mjs");
  const r = await sendImageWithFallback(from, link, caption, tenant);
  if (!r.ok) throw skipped(r.reason || "send-failed");
  return r.result;
}
