// معالج الامتثال والطاقم: إلغاء/إعادة اشتراك + أوامر الموظف + takeover
import { STAFF_PHONE } from "../../../../config/env.mjs";
import { normalizePhone } from "../../../../utils/phone.mjs";
import { sendChText } from "../../../../channels/send.mjs";
import { pushHistory } from "../../../../memory/conversations.mjs";
import { setTakeover, isTakeover } from "../../../../inbox/service.mjs";
import { logEvent } from "../../../../../crm.mjs";

export async function handleCompliance(ctx) {
  const { from, tenant, text } = ctx;
  const { isOptOut, isOptIn, markOptedOut, clearOptOut } = await import("../../../../compliance/messaging.mjs");
  if (isOptOut(text)) {
    await markOptedOut(tenant?.id, from);
    const reply = `تم يا غالي ✅ ألغينا اشتراكك وما رح نراسلك بأي عروض. إذا غيّرت رأيك ابعت "اشتراك".`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    logEvent("opt_out", { tenantId: tenant?.id, phone: from }).catch(() => {});
    try {
      await sendChText(ctx, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل إرسال تأكيد الإلغاء: ${e.message}`);
    }
    console.log(`  🚫 إلغاء اشتراك ${from} (${tenant?.id})`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
  if (isOptIn(text)) {
    await clearOptOut(tenant?.id, from);
    const reply = `أهلاً بعودتك يا غالي! 🎉 رجّعنا اشتراكك ورح توصلك عروضنا. كيف بقدر أساعدك اليوم؟`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    logEvent("opt_in", { tenantId: tenant?.id, phone: from }).catch(() => {});
    try {
      await sendChText(ctx, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل الإرسال: ${e.message}`);
    }
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
  return false;
}

export async function handleStaff(ctx) {
  const { from, tenant, text } = ctx;
  // —— أوامر الطاقم: "قف" يُسكت البوت على هذه المحادثة (takeover)، "شغّل" يرجعّه — رقم الموظف المسجل فقط ——
  // السلوك قبل هذه الكتلة: لو كان takeover نشطاً نتجاهل الرسالة — لذلك تُعترض هنا قبل فحصه
  // حتى يتمكن الموظف المُسكَت نفسه من إعادة تفعيل البوت بكلمة "شغّل".
  const staffNum = tenant?.features?.staffPhone || STAFF_PHONE;
  const cmdText = text.trim().replace(/^(البوت\s*|يا\s*بوت\s*)/, "");
  if ((cmdText === "قف" || cmdText === "شغّل") && staffNum && normalizePhone(staffNum) === from) {
    const on = cmdText === "قف";
    await setTakeover(tenant?.id, from, on, `staff:${from}`);
    const reply = on
      ? "تم ✅ سكّت البوت على هالمحادثة — بيرد الموظف من الموقع مباشرة. لإرجاعه ابعت \"شغّل\"."
      : "تمام ✅ البوت رجع يرد على هالمحادثة.";
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    logEvent(on ? "staff_pause" : "staff_resume", { tenantId: tenant?.id, phone: from }).catch(() => {});
    try {
      await sendChText(ctx, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل إرسال تأكيد أمر الطاقم: ${e.message}`);
    }
    console.log(`  🎛️  أمر طاقم ${cmdText} من ${from} (${tenant?.id})`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
  if (await isTakeover(tenant?.id, from)) {
    await pushHistory(from, "user", text, tenant);
    console.log(`  ⏸️ takeover نشط (${from}) - حُفظت الرسالة بدون رد آلي`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }
  return false;
}

// ── Coexistence: صدى رسائل العيادة من تطبيق واتساب بزنس (نفس الرقم) ──
// from = رقم البوت نفسه → ليست رسالة زبون: تُخزن بدور staff + إيقاف تلقائي
// للبوت على هاي المحادثة، وبلا رد أبداً (يمنع رد البوت على كلام الدكتور).
// الطرف الثاني بأولوية msg.to ثم جهات الاتصال — وإن غاب يُوثق للمراجعة بدل التخمين.
const COEX_TAKEOVER_MS = 45 * 60 * 1000; // إيقاف 45 دقيقة ثم يعود البوت تلقائياً
export async function handleCoexEcho({ msg, value, contacts, tenant, ch }) {
  if (!ch?.isEcho?.(msg, value)) return false;
  const biz = ch.businessNumber(value);
  const customer = ch.echoCustomer(msg, contacts || [], biz);
  const { isDuplicateMessageAsync } = await import("../../../../memory/conversations.mjs");
  if (msg?.id && (await isDuplicateMessageAsync(msg.id))) return true;
  if (!customer) {
    console.warn(`  🪞 صدى تعايش بلا طرف ثانٍ (${tenant?.id}) — حُفظ للمراجعة`);
    logEvent("dead_letter", { scope: "coex", reason: "echo-unresolved", tenantId: tenant?.id, wamid: msg?.id || null, keys: msg ? Object.keys(msg).slice(0, 12).join(",") : null }).catch(() => {});
    return true;
  }
  const ex = ch.extractText(msg, contacts || [], customer);
  let text = ex.text;
  if (!text) {
    const media = ch.extractMedia ? ch.extractMedia(msg) : null;
    text = media ? `[من العيادة: ${media.kind === "audio" ? "رسالة صوتية" : "مرفق"}]` : "[من العيادة: مرفق]";
  }
  await pushHistory(customer, "staff", text, tenant);
  // الحية توقف البوت مؤقتاً؛ القديمة (مزامنة سجل) تُخزن بصمت فقط
  const msgTs = Number(msg?.timestamp) * 1000;
  const fresh = !msgTs || Date.now() - msgTs < 10 * 60 * 1000;
  if (fresh) {
    await setTakeover(tenant?.id, customer, true, "coex:human", COEX_TAKEOVER_MS);
    logEvent("coex_takeover", { tenantId: tenant?.id, phone: customer }).catch(() => {});
    console.log(`  🪞 صدى من العيادة إلى ${customer} — حُفظ + إيقاف البوت 45د (${tenant?.id})`);
  } else {
    console.log(`  🪞 صدى قديم (مزامنة سجل) إلى ${customer} — حُفظ بصمت`);
  }
  return true;
}
