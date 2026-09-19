// الموزع الرئيسي: حلقة entries/changes/messages + درع لكل رسالة + ترتيب المعالجات
// الترتيب محفوظ كما كان في webhook.mjs الأصلي — أي تغيير بالترتيب يغير السلوك.
import { resolveTenant } from "../../../../tenants.mjs";
import { getChannel } from "../../../channels/registry.mjs";
import { checkLimit, senderKey } from "../../../security/rateLimit.mjs";
import { getHistory, isDuplicateMessageAsync, pushHistory, hasSeenMessageAsync } from "../../../memory/conversations.mjs";
import { getBookingState } from "../../../../bookings.mjs";
import { logEvent } from "../../../../crm.mjs";
import { handleVoice, handleReceiptImage } from "./handlers/media.mjs";
import { handleCompliance, handleStaff, handleCoexEcho } from "./handlers/compliance.mjs";
import { handleCancelIntent, handleOrderQuery, handleCsat } from "./handlers/orders.mjs";
import { handleProductButtons, handleAi } from "./handlers/ai.mjs";
import { handleBooking } from "./handlers/booking.mjs";

export async function processWebhookBody(body) {
  try {
    const entries = body.entry || [];

    let hasMessage = false;

    for (const entry of entries) {
      const changes = entry.changes || [];
      for (const change of changes) {
        const value = change.value || {};
        const messages = value.messages || [];
        const contacts = value.contacts || [];

        // حل الـ tenant من رقم البوت المستقبل (عزل تام)
        const phoneNumberId = value.metadata?.phone_number_id || value.phone_number_id || null;
        const tenant = await resolveTenant({ phoneNumberId });
        if (tenant && (tenant.enabled === false || tenant.trialExpired)) {
          console.log(`  ⏸️ tenant موقوف/منتهي: ${tenant.id} - تم تجاهل الرسالة`);
          continue;
        }
        // عزل تام (الدفاع الأعمق): أي دفعة بلا رقم بوت مسجل نتجاهلها كاملةً —
        // (أ) رقم غير مسجل → null من resolveTenant (ب) رقم غائب → لا بوت افتراضي بمنصة وصل.
        // بدون هذا، رسائل غريبة بلا phone_number_id كانت تُسند لبوت ما (تسريب مستأجرين).
        if (!tenant || !phoneNumberId) {
          const why = !phoneNumberId ? "phone_number_id غائب في الدفعة" : `رقم بوت غير مسجل (${phoneNumberId})`;
          console.log(`  ⛔ دفعة بلا tenant مسجل — ${why} — تجاهل كامل`);
          // P0-1: سجل ميت بدل التجاهل الصامت — تُرى بلوحة CRM وتُتابع
          logEvent("dead_letter", { scope: "batch", reason: "unknown-tenant", phoneNumberId: phoneNumberId || null }).catch(() => {});
          continue;
        }

        for (const msg of messages) {
          // P0-2: الخصم (dedupe) بعد الفحص لا قبله — تُفحص الرسالة أولاً (حد/نص/امتثال)
          // ثم تُعلَّم. رسالة مُسقطة تبقى غير مُعلَّمة فلا تُحجب إعادتها للأبد.

          // درع لكل رسالة على حدة: تعثّر رسالة ما يجب ألا يُسقط باقي دفعة Meta
          let from = null;
          try {
          // الاستخراج عبر طبقة القنوات (وصل: واتساب/ماسنجر/انستغرام) — نفس السلوك، مصدر واحد
          const ch = getChannel("whatsapp");
          // استخراج رقم العميل ونص الرسالة (يدعم الأزرار + الفويس)
          const fromAddr = ch.normalizeSender(msg.from); // رقم العميل — موحد E.164 دائماً
          from = fromAddr;
          // A5: مكرر مبكر (نظرة بلا تعليم) — يمنع إعادة التفريغ الصوتي وتأكيد opt-out
          // قبل أي تكلفة. التعليم النهائي يبقى لاحقاً بعد الفحوص (P0-2).
          if (msg.id && (await hasSeenMessageAsync(msg.id))) {
            console.log(`  🔁 مكرر مبكر (id=${msg.id}) - تم التجاهل بلا تكلفة`);
            continue;
          }
          // Coexistence: صدى العيادة من تطبيقها (from = رقم البوت) — مسار خاص:
          // تخزين + إيقاف مؤقت، بلا حد معدل ولا امتثال ولا رد أبداً
          if (await handleCoexEcho({ msg, value, contacts, tenant, ch })) continue;
          const rl = await checkLimit(senderKey(from), 30, 60 * 1000);
          if (!rl.allowed) {
            console.warn(`  ⏱️ تجاوز الحد من ${from} — تم التجاهل (${rl.retryAfter}ث)`);
            logEvent("dead_letter", { scope: "message", reason: "rate-limited", tenantId: tenant?.id, phone: from, wamid: msg?.id || null, retryAfter: rl.retryAfter }).catch(() => {});
            continue;
          }
          const extracted = ch.extractText(msg, contacts, from);
          let text = extracted.text;
          const buttonId = extracted.buttonId;
          const name = extracted.name;
          // Coexistence + إعادة التشغيل: رسالة أقدم من وقت الربط (مزامنة سجل/دفعة قديمة) —
          // تخزين صامت فقط: بلا فويس مكلف ولا حجز ولا AI. (سماح 60ث لانحراف الساعات)
          if (tenant?.features?.linkedAt && Number(msg?.timestamp) * 1000 < Number(tenant.features.linkedAt) - 60000) {
            if (msg.id && !(await isDuplicateMessageAsync(msg.id))) {
              await pushHistory(from, "user", text || `[سجل: ${msg.type || "رسالة"}]`, tenant);
            }
            console.log(`  🕰️ سجل قديم من ${from} — حُفظ بلا رد (${tenant?.id})`);
            continue;
          }

          const ctx = { msg, contacts, tenant, from, name, text, buttonId, channel: ch, result: null, wantsBooking: false, bookingState: null };

          // وسائط: فويس (يحوّل لنص ويكمل) + صور إيصالات (تعالج وتغلق)
          if (await handleVoice(ctx)) continue;
          text = ctx.text;
          if (await handleReceiptImage(ctx)) continue;

          if (!ctx.text) {
            console.log(`  📥 رسالة بدون نص من ${from} (type=${msg.type}) - تم تجاهلها`);
            continue;
          }

          // امتثال واتساب قبل أي منطق
          if (await handleCompliance(ctx)) continue;

          // منع التكرار: نفس الـ wamid لا يُعالج مرتين أبداً (دائم عبر restart)
          if (msg.id && (await isDuplicateMessageAsync(msg.id))) {
            console.log(`  🔁 رسالة مكررة (id=${msg.id}) - تم تجاهلها`);
            continue;
          }
          hasMessage = true;

          console.log(`\n${"─".repeat(60)}`);
          console.log(`  🏢 tenant=${tenant?.id} | بوت=${tenant?.botName}`);
          console.log(`  📥 رسالة واتساب من ${name} (${from}): "${String(ctx.text||"").slice(0,80)}"${buttonId ? ` [btn=${buttonId}]` : ""}`);
          console.log(`  🧠 الذاكرة: ${(await getHistory(from, tenant)).length} رسائل سابقة`);

          // ملاحظة الترتيب: الطاقم/takeover أولاً — زر الشراء لا يتجاوز إسكات "قف"
          if (await handleStaff(ctx)) continue;

          // طلبات: نسيان + استعلام + تقييم
          if (await handleCancelIntent(ctx)) continue;
          if (await handleOrderQuery(ctx)) continue;
          if (await handleCsat(ctx)) continue;

          // —— تدفق الحجز (للعيادات) قبل الـ AI ——
          ctx.wantsBooking = tenant?.features?.booking && /(حجز|موعد|احجز|book|appointment)/i.test(ctx.text + " " + (buttonId || ""));
          ctx.bookingState = await getBookingState(tenant?.id, from);
          // أزرار منتجات البوت (بعد الطلبات وقبل الفرز — وتحترم takeover)
          if (await handleProductButtons(ctx)) continue;
          if (await handleBooking(ctx)) continue;

          // —— المسار العادي: AI ——
          await handleAi(ctx);

          console.log(`${"─".repeat(60)}\n`);
          } catch (msgErr) {
            console.error(`  ❌ خطأ معالجة رسالة ${msg?.id || "؟"}: ${msgErr?.message || msgErr}`);
            // P0-1: أي عطل بالرسالة يُوثق كرسالة ميتة بدل الصمت بعد 200
            logEvent("dead_letter", { scope: "message", reason: "handler-error", tenantId: tenant?.id, phone: from, wamid: msg?.id || null, error: String(msgErr?.message || msgErr).slice(0, 300) }).catch(() => {});
          }
        }

        // تجاهل حالات statuses (delivered/read) بدون رسائل
        if (messages.length === 0 && value.statuses) {
          console.log(`  📊 حالة رسالة: ${value.statuses[0]?.status || "unknown"}`);
        }
      }
    }

    if (!hasMessage) {
      console.log("  📥 POST /webhook - لا توجد رسائل جديدة (ربما statuses)");
    }
  } catch (err) {
    console.error(`  ❌ خطأ في معالجة Webhook: ${err.message}`, err.stack);
    // P0-1: انهيار الدفعة كاملة يُوثق مع عدد الـ entries بدل الصمت بعد 200
    try {
      const { logEvent: le } = await import("../../../../crm.mjs");
      le("dead_letter", { scope: "batch", reason: "processor-crash", error: String(err?.message || err).slice(0, 300), entries: (body.entry || []).length }).catch(() => {});
    } catch { /* توثيق أفضل جهد */ }
  }
}
