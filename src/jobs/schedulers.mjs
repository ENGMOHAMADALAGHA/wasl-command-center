import { getTenantFull, isTenantActive } from "../../tenants.mjs";
import { dueReminders, markReminded, unmarkReminded } from "../../bookings.mjs";
import { dueCartRemindersAll, markCartReminded, unmarkCartReminded, fmtMoney } from "../../orders.mjs";
import { logEvent } from "../../crm.mjs";
import { sendWithWindowFallback } from "../compliance/messaging.mjs";
import { pushHistory } from "../memory/conversations.mjs";
import { REMIND_EVERY_MS, REMIND_AFTER_MIN, CART_AFTER_MIN } from "../config/env.mjs";

export function startSchedulers() {
  // مجدول تلقائي: تذكير مواعيد + سلة مهجورة
  // قفل تداخل: لو طالت دورة عن REMIND_EVERY_MS لا تبدأ دورة فوقها (تهدر اتصالات limit=1)
  let remindRunning = false;
  if (!global.__remindTimer) {
    global.__remindTimer = setInterval(async () => {
      if (remindRunning) {
        console.warn("  ⏭️ دورة تذكير سابقة ما زالت تعمل — تخطي هذه الدورة لمنع التداخل");
        return;
      }
      remindRunning = true;
      try {
// 1) تذكير مواعيد
        const due = await dueReminders({ afterMinutes: REMIND_AFTER_MIN });
        for (const b of due.slice(0, 20)) {
          const tenant = await getTenantFull(b.tenantId);
          if (!tenant || !isTenantActive(tenant)) continue;
          const isClinic = tenant?.businessType === "dental" || tenant?.businessType === "clinic" || tenant?.features?.clinicCare === true;
          // ClinicCare: تذكير 24 ساعة بنص اللطيف + طلب تأكيد "اضغط 1"
          const msg = isClinic
            ? `أهلاً حبيبتي، تذكير موعدك بكرا الساعة ${b.slot} في ${tenant.name} 🌸 للتأكيد اضغط 1، ولإعادة الجدولة ابعتي "تأجيل". بنستناكي!`
            : `تذكير بموعدك يا غالي ⏰ ${b.service} - يوم ${b.day} - الساعة ${b.slot} (${b.id}) في ${tenant.name}.`;
          // ادّعاء ذري قبل الإرسال — لا رسالتين لنفس الموعد (إما شغل المؤقت أو التشغيل اليدوي)
          const claimed = await markReminded(b.id, b.tenantId);
          if (!claimed) continue;
          try {
            // يمر عبر sendWithWindowFallback: (أ) يمتنع عن ألغوا الاشتراك (ب) قالب بديل خارج النافذة
            const r = await sendWithWindowFallback(b.phone, msg, tenant);
            if (!r.ok) {
              console.log(`  ⏭️ تذكير ${b.id} -> ${b.phone}: ${r.reason}`);
            } else {
              await pushHistory(b.phone, "assistant", msg, tenant).catch(() => {});
            }
            logEvent("booking_reminded", { tenantId: b.tenantId, phone: b.phone, bookingId: b.id, skipped: r.ok ? undefined : r.reason }).catch(() => {});
            console.log(`  ⏰ تذكير تلقائي ${b.id} -> ${b.phone}`);
          } catch (e) {
            // فشل عابر → نفتح الادعاء ليُعاد في الدورة التالية (لا نضيّع التذكير)
            await unmarkReminded(b.id, b.tenantId);
            console.error(`  ❌ فشل التذكير ${b.id}: ${e.message}`);
          }
        }
        // ClinicCare: تذكير ثانٍ قبل 3 ساعات + متابعة بعد الزيارة وطلب تقييم Google
        try {
          const { dueSoonReminders, dueFollowups } = await import("../../bookings.mjs");
          // 3 ساعات
          const soon = (await dueSoonReminders?.({ hours: 3 }).catch(() => [])) || [];
          for (const b of soon.slice(0, 15)) {
            const tenant = await getTenantFull(b.tenantId);
            if (!tenant || !isTenantActive(tenant)) continue;
            const isClinic = tenant?.businessType === "dental" || tenant?.features?.clinicCare === true;
            if (!isClinic) continue;
            const msg = `تذكير: موعدك بعد 3 ساعات الساعة ${b.slot} في ${tenant.name} 🌸 ننتظرك، للتأكيد اضغط 1.`;
            const { storeGet, storeSet } = await import("../../store.mjs");
            const key = `remind3h:${b.id}`;
            if (await storeGet(key).catch(() => null)) continue;
            await storeSet(key, { at: Date.now() }, 24 * 60 * 60 * 1000).catch(() => {});
            try {
              const r = await sendWithWindowFallback(b.phone, msg, tenant);
              if (r.ok) await pushHistory(b.phone, "assistant", msg, tenant).catch(() => {});
            } catch {}
          }
          // متابعة بعد الزيارة بيوم + رابط Google Maps إن وجد
          const follows = (await dueFollowups?.().catch(() => [])) || [];
          for (const b of follows.slice(0, 15)) {
            const tenant = await getTenantFull(b.tenantId);
            if (!tenant || !isTenantActive(tenant)) continue;
            const link = tenant?.features?.googleReviewUrl || tenant?.features?.googleMapsUrl || "";
            const msg = link
              ? `نورتينا اليوم في ${tenant.name} 🌸 كيف كانت زيارتك؟ رأيك يهمنا — قيّمينا على Google Maps: ${link}`
              : `نورتينا اليوم في ${tenant.name} 🌸 كيف كانت زيارتك؟ شاركينا رأيك بكلمة من 1-5.`;
            try {
              const r = await sendWithWindowFallback(b.phone, msg, tenant);
              if (r.ok) await pushHistory(b.phone, "assistant", msg, tenant).catch(() => {});
              logEvent("followup_sent", { tenantId: b.tenantId, bookingId: b.id }).catch(() => {});
            } catch {}
          }
        } catch {}
        // 2) سلة مهجورة — رسالة واحدة لكل رقم (تجميع الطلبات)
        const carts = await dueCartRemindersAll({ afterMinutes: CART_AFTER_MIN });
        const byPhone = new Map();
        for (const o of carts.slice(0, 60)) {
          const key = `${o.tenantId}::${o.phone}`;
          if (!byPhone.has(key)) byPhone.set(key, []);
          byPhone.get(key).push(o);
        }
        for (const [, list] of byPhone) {
          const first = list[0];
          const tenant = await getTenantFull(first.tenantId);
          if (!tenant || !isTenantActive(tenant)) continue;
          // ادّعاء ذري لكل الطلبات قبل الإرسال — الطلبات التي أخذها منافس تُتجاهل (لا تكرار)
          const claimed = [];
          for (const o of list) {
            if (await markCartReminded(o.id, o.tenantId)) claimed.push(o);
          }
          if (!claimed.length) continue;
          const lines = claimed.map((o) => `• ${o.id} (${fmtMoney(o.total, o.currency)})`).join("\n");
          const msg = claimed.length === 1
            ? `يا هلا يا غالي! 👋 شفنا طلبك ${claimed[0].id} (${fmtMoney(claimed[0].total, claimed[0].currency)}) لسه ما اكتمل. تحب نكمله؟ ابعت لقطة الشاشة هون 📸`
            : `يا هلا يا غالي! 👋 عندك ${claimed.length} طلبات لسه ما اكتملت:\n${lines}\nابعت رقم الطلب لنكمله مع بعض.`;
          try {
            // نفس سياسة الامتثال: من ألغى الاشتراك لا يرى سلة مهجورة، وخارج النافذة قالب بديل
            const r = await sendWithWindowFallback(first.phone, msg, tenant);
            if (!r.ok) {
              console.log(`  ⏭️ سلة مهجورة (${claimed.length}) -> ${first.phone}: ${r.reason}`);
            } else {
              await pushHistory(first.phone, "assistant", msg, tenant).catch(() => {});
              console.log(`  🛒 سلة مهجورة (${claimed.length}) -> ${first.phone}`);
            }
            logEvent("cart_reminded", { tenantId: first.tenantId, phone: first.phone, orderIds: claimed.map((o) => o.id), total: claimed.reduce((s, o) => s + Number(o.total), 0), skipped: r.ok ? undefined : r.reason }).catch(() => {});
          } catch (e) {
            // فشل عابر → نفتح الادعاءات ليُعادوا في الدورة التالية
            for (const o of claimed) await unmarkCartReminded(o.id, o.tenantId);
            console.error(`  ❌ فشل تذكير السلة لـ ${first.phone}: ${e.message}`);
          }
        }
      } catch (e) {
        console.error(`  ❌ خطأ المجدول: ${e.message}`);
      } finally {
        remindRunning = false;
      }
    }, REMIND_EVERY_MS);
    if (global.__remindTimer.unref) global.__remindTimer.unref();
  }

  if (!global.__pruneTimer) {
    global.__pruneTimer = setInterval(async () => {
      try {
        const { pruneOldMessages } = await import("../../db.mjs");
        const n = await pruneOldMessages(30);
        if (n) console.log(`  🧹 تنظيف رسائل أقدم من 30 يوم: ${n}`);
      } catch (e) {
        console.error(`  ❌ خطأ تنظيف الرسائل: ${e.message}`);
      }
    }, 60 * 60 * 1000);
    if (global.__pruneTimer.unref) global.__pruneTimer.unref();
  }

}