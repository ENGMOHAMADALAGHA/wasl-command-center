// ──────────────────────────────────────────────
// طبقة واتساب: الإرسال فقط (نص / أزرار / صورة)
// لا تعرف شيئاً عن AI أو المنطق — تستقبل tenant جاهزاً.
// ──────────────────────────────────────────────
import { resolveTenantInput } from "../../tenants.mjs";
import { WHATSAPP_TOKEN, WHATSAPP_PHONE_ID, OUTBOUND_TIMEOUT_MS, WA_TEMPLATE_LANG, WA_FOLLOWUP_TEMPLATE } from "../config/env.mjs";
import { checkLimit, tenantSendKey } from "../security/rateLimit.mjs";
import { sendWithRetry } from "./outbound.mjs";
import { normalizePhone } from "../utils/phone.mjs";

async function guardSend(tenant, phoneId) {
  const lim = await checkLimit(tenantSendKey(tenant?.id || phoneId || "default"), 60, 60 * 1000);
  if (!lim.allowed) {
    const e = new Error(`تجاوز حد الإرسال — أعد المحاولة بعد ${lim.retryAfter}ث`);
    e.code = "RATE_LIMITED";
    throw e;
  }
}

async function creds(tenantInput) {
  const tenant = await resolveTenantInput(tenantInput);
  return {
    tenant,
    token: tenant?.whatsapp_token || WHATSAPP_TOKEN,
    phoneId: tenant?.phone_number_id || WHATSAPP_PHONE_ID,
  };
}

function isDemo(token, phoneId) {
  return !token || token === "DEMO_WHATSAPP_TOKEN" || !phoneId || phoneId === "DEMO_PHONE_ID";
}

// POST واحد على Graph مع مهلة + إعادة ذكية (429/5xx) + DLQ.
// الأخطاء تحمل status للتصنيف، وWINDOW_CLOSED لنفاد نافذة 24h.
async function graphPost(url, token, body, label) {
  // متحكم إلغاء لكل محاولة (لا يُشترك بين المحاولات — إشارة مجهضة تبقى مجهضة)
  return await sendWithRetry(async () => {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), OUTBOUND_TIMEOUT_MS);
    try {
      let res;
      try {
        res = await fetch(url, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify(body),
          signal: ctrl.signal,
        });
      } catch (e) {
        if (e?.name === "AbortError") {
          const err = new Error(`تجاوز مهلة الإرسال ${OUTBOUND_TIMEOUT_MS}ms`);
          err.code = "TIMEOUT";
          throw err;
        }
        throw e;
      }
      let data = null;
      try { data = await res.json(); } catch { /* رد غير JSON */ }
      if (!res.ok) {
        const err = new Error(data?.error?.message || `HTTP ${res.status}`);
        err.status = res.status;
        err.code = data?.error?.code;
        // نافذة 24h مغلقة (Meta code 131047) — لا فائدة من إعادة المحاولة
        if (data?.error?.code === 131047 || /outside.*24|24.*hour|window/i.test(err.message)) {
          err.code = "WINDOW_CLOSED";
        }
        throw err;
      }
      return data;
    } finally {
      clearTimeout(t);
    }
    }, { label });
}

export async function sendWhatsAppMessage(to, text, tenantInput = null) {
  to = normalizePhone(to); // E.164 مركزياً — Meta ترفض أي صيغة أخرى
  const { tenant, token, phoneId } = await creds(tenantInput);
  await guardSend(tenant, phoneId);

  if (isDemo(token, phoneId)) {
    console.log(`  📤 [محاكاة إرسال] إلى ${to}: "${text}"`);
    console.log(`  💡 ضع WHATSAPP_TOKEN و WHATSAPP_PHONE_ID الحقيقيين في .env للإرسال الفعلي`);
    return { simulated: true, to, text };
  }

  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;

  try {
    const data = await graphPost(url, token, {
      messaging_product: "whatsapp",
      to,
      type: "text",
      text: { body: text, preview_url: false },
    }, `text:${tenant?.id || phoneId}`);

    console.log(`  ✅ تم إرسال الرد إلى ${to} | ID: ${data.messages?.[0]?.id || "N/A"}`);
    return data;
  } catch (err) {
    console.error(`  ❌ خطأ في sendWhatsAppMessage: ${err.message}`);
    throw err;
  }
}

// إرسال generic (نص / أزرار / صورة) - نفس التوكن لكل بوت
async function sendPayload(to, payload, tenantInput = null) {
  to = normalizePhone(to); // Meta تقبل E.164 فقط — أي صيغة تُطبَّع هنا مركزياً
  const { tenant, token, phoneId } = await creds(tenantInput);
  await guardSend(tenant, phoneId);

  if (isDemo(token, phoneId)) {
    console.log(`  📤 [محاكاة إرسال ${payload.type}] إلى ${to}: ${JSON.stringify(payload).slice(0, 200)}`);
    return { simulated: true, to, payload };
  }
  const url = `https://graph.facebook.com/v21.0/${phoneId}/messages`;
  const data = await graphPost(url, token,
    { messaging_product: "whatsapp", to, ...payload },
    `${payload.type}:${tenant?.id || phoneId}`);
  console.log(`  ✅ تم الإرسال (${payload.type}) إلى ${to} | ID: ${data.messages?.[0]?.id || "N/A"}`);
  return data;
}

export async function sendButtons(to, bodyText, buttons, tenantInput = null) {
  const btns = (buttons || []).slice(0, 3).map((b, i) => ({
    type: "reply",
    reply: { id: b.id || `btn_${i}`, title: (b.title || `خيار ${i + 1}`).slice(0, 20) },
  }));
  if (!btns.length) return sendWhatsAppMessage(to, bodyText, tenantInput);
  return sendPayload(to, {
    type: "interactive",
    interactive: {
      type: "button",
      body: { text: bodyText.slice(0, 1024) },
      action: { buttons: btns },
    },
  }, tenantInput);
}

export async function sendImage(to, link, caption = "", tenantInput = null) {
  return sendPayload(to, {
    type: "image",
    image: { link, caption: caption.slice(0, 1024) },
  }, tenantInput);
}

export async function sendLocation(to, lat, lng, name = "", address = "", tenantInput = null) {
  if (lat == null || lng == null) throw new Error("إحداثيات الموقع مطلوبة");
  return sendPayload(to, {
    type: "location",
    location: { latitude: Number(lat), longitude: Number(lng), name: String(name).slice(0, 1000), address: String(address).slice(0, 1000) },
  }, tenantInput);
}

// قالب Meta معتمد (للرسائل خارج نافذة 24h) — يتطلب قالباً معتمداً مسبقاً.
export async function sendTemplate(to, templateName, params = [], tenantInput = null, lang = WA_TEMPLATE_LANG) {
  if (!templateName) throw new Error("اسم القالب مطلوب");
  return sendPayload(to, {
    type: "template",
    template: {
      name: templateName,
      language: { code: lang },
      components: params.length
        ? [{ type: "body", parameters: params.map((p) => ({ type: "text", text: String(p).slice(0, 256) })) }]
        : [],
    },
  }, tenantInput);
}

// أزرار افتراضية لكل tenant: من features.quickButtons إن عرّفها البوت، وإلا من منتجاته
// (لا أزرار مكتوبة لأي بوت بالكود — كل بوت يعرّف أزراره ببياناته)
export async function defaultButtonsFor(tenant) {
  const t = await resolveTenantInput(tenant);
  if (Array.isArray(t?.features?.quickButtons) && t.features.quickButtons.length) {
    return t.features.quickButtons.slice(0, 3);
  }
  const btns = (t.products || []).slice(0, 2).map((p) => ({
    id: p.buttonId || p.name,
    title: `${p.name} ${p.price} د.أ`.slice(0, 20),
  }));
  if (t?.features?.booking) btns.push({ id: "booking", title: "📅 احجز موعد" });
  return btns.slice(0, 3);
}
