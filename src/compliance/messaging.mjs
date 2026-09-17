// ──────────────────────────────────────────────
// امتثال واتساب: إلغاء الاشتراك + تنبيه الموظف + قوالب نافذة 24h
// ──────────────────────────────────────────────
import { STAFF_PHONE, WA_FOLLOWUP_TEMPLATE } from "../config/env.mjs";
import { samePhone } from "../utils/phone.mjs";

// كلمات إلغاء الاشتراك (عربي/إنجليزي) — إلزامية لمنع حظر البث
const OPT_OUT_RE = /^(إلغاء|الغاء|الغاء الاشتراك|إلغاء الاشتراك|أوقف|اوقف|وقف|لا تراسلني|احذفني|stop|unsubscribe|cancel|opt ?out|stop messaging)$/i;

export function isOptOut(text) {
  return OPT_OUT_RE.test(String(text || "").trim());
}

const optKey = (tenantId, phone) => `optout:${tenantId}::${phone}`;

export async function markOptedOut(tenantId, phone) {
  const { storeSet } = await import("../../store.mjs");
  // بدون TTL — يبقى حتى يطلب العميل الاشتراك مجدداً
  await storeSet(optKey(tenantId, phone), { at: Date.now() });
}

export async function clearOptOut(tenantId, phone) {
  const { storeDel } = await import("../../store.mjs");
  await storeDel(optKey(tenantId, phone));
}

export async function isOptedOut(tenantId, phone) {
  try {
    const { storeGet } = await import("../../store.mjs");
    return !!(await storeGet(optKey(tenantId, phone)));
  } catch {
    return false;
  }
}

// كلمات إعادة الاشتراك
const OPT_IN_RE = /^(اشتراك|اشترك|ابدا|ابدأ|start|subscribe|opt ?in)$/i;
export function isOptIn(text) {
  return OPT_IN_RE.test(String(text || "").trim());
}

// ── تنبيه المالك واتساب: هل يريد إشعاراً لهذا النوع من الأحداث؟ ──
// يُفعّل تلقائياً عند وجود رقم طاقم (staffPhone)، ويُطفأ لكل نوع عبر:
// features.ownerAlerts = { booking: true/false, payment: true/false }
export function ownerAlertsEnabled(tenant, kind) {
  const to = tenant?.features?.staffPhone || STAFF_PHONE;
  if (!to) return false;
  const cfg = tenant?.features?.ownerAlerts;
  if (cfg && cfg[kind] === false) return false;
  return true;
}

// تنبيه المالك بحدث تشغيلي (حجز/دفع) — يحترم إعدادات ownerAlerts لكل نوع
export async function notifyOwner(tenant, kind, text) {
  if (!ownerAlertsEnabled(tenant, kind)) return { ok: false, reason: "disabled" };
  return notifyStaff(tenant, text);
}
export async function notifyStaff(tenant, text, opts = {}) {
  const to = tenant?.features?.staffPhone || STAFF_PHONE;
  const full = `🔔 [${tenant?.botName || tenant?.id || "bot"}] ${text}`;
  // حماية "يكلم نفسه": إذا المستلم هو نفس المرسل (تست بنفس الرقم) لا ترسل لنفس الدردشة
  // samePhone يتحمل كل الصيغ (079/00962/+962) — الحدث يبقى موثقاً بالسجل
  if (opts.except && to && samePhone(to, opts.except)) {
    try {
      const { logEvent } = await import("../../crm.mjs");
      await logEvent("staff_ping", { tenantId: tenant?.id, text: String(text).slice(0, 300), skipped: "self" }).catch(() => {});
    } catch { /* تجاهل */ }
    console.log(`  🚨 تنبيه موظف مُتجاوَز (نفس رقم المرسل — مسجل بالسجل فقط)`);
    return { ok: false, reason: "self-recipient" };
  }
  try {
    const { logEvent } = await import("../../crm.mjs");
    await logEvent("staff_ping", { tenantId: tenant?.id, text: String(text).slice(0, 300) }).catch(() => {});
    if (!to) {
      console.log(`  🚨 تنبيه موظف (بدون رقم مهيأ): ${full.slice(0, 200)}`);
      return { ok: false, reason: "no-staff-phone" };
    }
    const { sendWhatsAppMessage } = await import("../whatsapp/sender.mjs");
    await sendWhatsAppMessage(to, full.slice(0, 1000), tenant);
    console.log(`  🚨 تم تنبيه الموظف ${to}`);
    return { ok: true, to };
  } catch (e) {
    console.error(`  ⚠️ فشل تنبيه الموظف: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ── إرسال مع بديل القالب خارج نافذة 24h ──
// يحاول الإرسال العادي أولاً؛ عند WINDOW_CLOSED يرسل القالب المعتمد إن وُجد،
// وإلا يُشعر الموظف ويُوثّق (لا رسائل مفقودة بصمت).
export async function sendWithWindowFallback(to, text, tenant) {
  const { sendWhatsAppMessage, sendTemplate } = await import("../whatsapp/sender.mjs");
  const { logEvent } = await import("../../crm.mjs");
  if (await isOptedOut(tenant?.id, to)) {
    console.log(`  ⏭️ تخطي الإرسال لـ ${to} — ألغى الاشتراك`);
    return { ok: false, reason: "opted-out" };
  }
  try {
    const r = await sendWhatsAppMessage(to, text, tenant);
    // وضع المحاكاة (بلا توكن) ليس إرسالاً — نعيده كغير مرسل بصراحة
    // حتى لا تُعلَّم التذكيرات والبثوث "تمت" وهي لم تخرج من الخادم
    if (r?.simulated) {
      console.log(`  📤 [محاكاة] لم يخرج شيء لـ ${to} — يُعامل كغير مرسل`);
      return { ok: false, reason: "simulated-no-credentials" };
    }
    return { ok: true, result: r };
  } catch (e) {
    if (e?.code !== "WINDOW_CLOSED") throw e;
    const tpl = tenant?.features?.followupTemplate || WA_FOLLOWUP_TEMPLATE;
    await logEvent("window_closed", { tenantId: tenant?.id, phone: to }).catch(() => {});
    if (tpl) {
      console.log(`  📋 نافذة 24h مغلقة لـ ${to} — إرسال القالب ${tpl}`);
      const r = await sendTemplate(to, tpl, [tenant?.botName || ""], tenant);
      return { ok: true, result: r, via: "template" };
    }
    await notifyStaff(tenant, `نافذة 24h مغلقة مع ${to} ولا قالب مهيأ — تواصل يدوياً من واتساب.`);
    return { ok: false, reason: "window-closed-no-template" };
  }
}

// ── إرسال أزرار/صور بنفس الامتثال: opt-out أولاً + بديل القالب خارج 24h ──
// (كانت sendChButtons/sendChImage ترسلان مباشرة متجاوزتين الحظر والنافذة — ثغرة امتثال)
async function interactiveFallback(to, text, buttonsOrImage, tenant, kind) {
  const { sendButtons, sendImage, sendTemplate } = await import("../whatsapp/sender.mjs");
  const { logEvent } = await import("../../crm.mjs");
  if (await isOptedOut(tenant?.id, to)) {
    console.log(`  ⏭️ تخطي [${kind}] لـ ${to} — ألغى الاشتراك`);
    return { ok: false, reason: "opted-out" };
  }
  try {
    const r = kind === "buttons"
      ? await sendButtons(to, text, buttonsOrImage, tenant)
      : await sendImage(to, buttonsOrImage.link, buttonsOrImage.caption || "", tenant);
    if (r?.simulated) {
      console.log(`  📤 [محاكاة] [${kind}] لم يخرج لـ ${to} — يُعامل كغير مرسل`);
      return { ok: false, reason: "simulated-no-credentials" };
    }
    return { ok: true, result: r };
  } catch (e) {
    if (e?.code !== "WINDOW_CLOSED") throw e;
    const tpl = tenant?.features?.followupTemplate || WA_FOLLOWUP_TEMPLATE;
    await logEvent("window_closed", { tenantId: tenant?.id, phone: to, kind }).catch(() => {});
    if (tpl) {
      console.log(`  📋 نافذة 24h مغلقة لـ ${to} — قالب نصي بدل [${kind}] ${tpl}`);
      const r = await sendTemplate(to, tpl, [tenant?.botName || ""], tenant);
      return { ok: true, result: r, via: "template", degraded: `${kind}-to-text` };
    }
    await notifyStaff(tenant, `نافذة 24h مغلقة مع ${to} (${kind}) ولا قالب مهيأ — تواصل يدوياً من واتساب.`);
    return { ok: false, reason: "window-closed-no-template" };
  }
}

export async function sendButtonsWithFallback(to, text, buttons, tenant) {
  return interactiveFallback(to, text, buttons, tenant, "buttons");
}

export async function sendImageWithFallback(to, link, caption, tenant) {
  return interactiveFallback(to, "", { link, caption }, tenant, "image");
}
