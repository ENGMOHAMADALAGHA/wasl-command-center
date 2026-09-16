import { systemDb } from "./src/security/tenantGuard.mjs";
import { decryptSecret, encryptSecret } from "./src/security/secrets.mjs";
import { SHARED_NUMBER_TENANT_ID } from "./src/config/env.mjs";

// كاش قصير للبوتات (تتغير نادراً)
let cache = { data: null, at: 0 };
const CACHE_TTL_MS = 60 * 1000;

// كاش صفوف البوتات المنفردة (getTenant كان يضرب DB مع كل رسالة)
const rowCache = new Map(); // id -> { data, at }
const ROW_TTL_MS = 60 * 1000;

function invalidate() {
  cache = { data: null, at: 0 };
  rowCache.clear();
}

async function loadTenants() {
  if (cache.data && Date.now() - cache.at < CACHE_TTL_MS) return cache.data;
  if (!process.env.DATABASE_URL) throw new Error("لا توجد DATABASE_URL — اضبط قاعدة البيانات أولاً");
  const rows = await systemDb("tenants:list").tenant.findMany({ orderBy: { id: "asc" } });
  cache = { data: rows, at: Date.now() };
  return rows;
}

function toPublic(t) {
  return {
    id: t.id,
    name: t.name,
    botName: t.botName,
    enabled: t.enabled !== false,
    businessType: t.businessType,
    phone_number_id: t.phoneNumberId || process.env.WHATSAPP_PHONE_ID || null,
    productsCount: (t.products || []).length,
    plan: t.plan || "trial",
    trialEndsAt: t.trialEndsAt || null,
    trialExpired: isTrialExpired(t),
    hasOwnToken: !!t.whatsappToken,
  };
}

// انتهاء التجربة: plan=trial مع trialEndsAt ماضٍ (null = مفتوح/مدفوع)
// البوت نشط = مفعّل وغير منتهي التجربة
export function isTrialExpired(t) {
  if (!t || (t.plan || "trial") !== "trial" || !t.trialEndsAt) return false;
  return new Date(t.trialEndsAt) < new Date();
}
export function isTenantActive(t) {
  return !!t && t.enabled !== false && !isTrialExpired(t);
}

export async function listTenants() {
  return (await loadTenants()).map(toPublic);
}

export async function getTenant(id) {
  if (!id) return null;
  const hit = rowCache.get(id);
  if (hit && Date.now() - hit.at < ROW_TTL_MS) return hit.data;
  const row = await systemDb("tenants:get").tenant.findUnique({ where: { id } });
  if (row) rowCache.set(id, { data: row, at: Date.now() });
  else rowCache.delete(id);
  return row;
}

// أهم دالة للعزل: نحل أي حدث لأي tenant حسب معرف القناة
// (واتساب: phoneNumberId — ماسنجر: features.messengerPageId — انستغرام: features.instagramId)
export async function resolveTenant({ phoneNumberId, verifyToken, pageId, channel } = {}) {
  const tenants = await loadTenants();
  const envPhoneId = process.env.WHATSAPP_PHONE_ID;
  const envVerify = process.env.WEBHOOK_VERIFY_TOKEN || "my_secret_token";

  if (phoneNumberId) {
    // أولاً: كل البوتات المسجلة على هذا الرقم — يجب أن يكون واحداً فقط.
    // رقم مشترك = خطأ إعداد: نرفض التوجيه (fail-closed) بدل تخمين بوت —
    // لا أفضلية لأي بوت؛ كل البوتات سواسية داخل منصة وصل.
    const matches = tenants.filter((t) => t.phoneNumberId && t.phoneNumberId === phoneNumberId);
    if (matches.length > 1) {
      // رقم مشترك = خطأ إعداد (رقم واحد لكل بوت). fail-closed افتراضياً.
      // استثناء معلن واحد: SHARED_NUMBER_TENANT_ID (وضع قائم مؤقت حتى فصل الأرقام) —
      // يُسجَّل بصوت عالٍ في كل مرة حتى لا يبقى صامتاً.
      const designated = SHARED_NUMBER_TENANT_ID && matches.find((t) => t.id === SHARED_NUMBER_TENANT_ID);
      if (designated) {
        console.error(`  ⛔ رقم مشترك ${phoneNumberId} على ${matches.map((t) => t.id).join("، ")} — توجيه مؤقت معلن إلى "${designated.id}" (SHARED_NUMBER_TENANT_ID). افصل الأرقام فوراً: رقم واحد لكل بوت`);
        return withEnvDefaults(designated);
      }
      console.error(`  ⛔ رقم مشترك مرفوض: ${phoneNumberId} مسجَّل عند ${matches.map((t) => t.id).join("، ")} — أزل التكرار من /admin/tenants (رقم واحد لكل بوت)`);
      return null;
    }
    const exact = matches[0];
    if (exact) return withEnvDefaults(exact);
    // ثانياً: مطابقة رقم البيئة المشترك (بوتات بلا رقم خاص)
    const def = tenants.find((t) => (t.phoneNumberId || envPhoneId) === phoneNumberId);
    if (def) return withEnvDefaults(def);
    // رقم بوت غير معروف إطلاقاً — لا نعالجه كبوت افتراضي (منع خلط المستأجرين)
    console.warn(`  ⛔ phone_number_id غير مسجل (${phoneNumberId}) — تجاهل لتجنب خلط البوتات`);
    return null;
  }
  if (verifyToken) {
    const hit = tenants.find((t) => (t.verifyToken || envVerify) === verifyToken);
    if (hit) return withEnvDefaults(hit);
  }
  // قنوات وصل: ماسنجر/انستغرام تُحل عبر معرف الصفحة/الحساب ببيانات البوت —
  // رقم واحد لكل هوية: التكرار مرفوض مثل أرقام واتساب (fail-closed)
  if (pageId) {
    const matches = tenants.filter(
      (t) => t.features?.messengerPageId === pageId || t.features?.instagramId === pageId
    );
    if (matches.length > 1) {
      console.error(`  ⛔ هوية قناة مشتركة مرفوضة: ${pageId} على ${matches.map((t) => t.id).join("، ")} — هوية واحدة لكل بوت`);
      return null;
    }
    if (matches[0]) return withEnvDefaults(matches[0]);
    console.warn(`  ⛔ هوية قناة غير مسجلة (${channel || "?"}:${pageId}) — تجاهل`);
    return null;
  }
  // بلا معيار مطابقة: لا بوت افتراضي صامت — المتصل يحدد البوت صراحةً
  console.warn("  ⚠️ resolveTenant بلا phoneNumberId ولا verifyToken — رفض (لا افتراضي صامت بمنصة وصل)");
  return null;
}

const envFallbackWarned = new Set();
function withEnvDefaults(t) {
  let perTenantToken = null;
  try {
    // فك متزامن وخفيف (AES-GCM) — التوكن الخاص أولاً، ثم المشترك
    if (t?.whatsappToken) perTenantToken = decryptSecret(t.whatsappToken);
  } catch { /* رجوع للمشترك */ }
  // شفافية المنصة: البوت بلا بياناته الخاصة يستخدم المشتركة — نحذر مرة واحدة لكل بوت
  // (الحالة الصحيحة: كل بوت له phoneNumberId وتوكن خاصان من /admin/tenants)
  if ((!t?.phoneNumberId || !perTenantToken) && t?.id && !envFallbackWarned.has(t.id)) {
    envFallbackWarned.add(t.id);
    console.warn(`  ⚠️ البوت ${t.id} بلا بيانات ربط خاصة (يستخدم المشتركة) — أدخل phoneNumberId والتوكن من /admin/tenants`);
  }
  return {
    ...t,
    phone_number_id: t.phoneNumberId || process.env.WHATSAPP_PHONE_ID || null,
    verify_token: t.verifyToken || process.env.WEBHOOK_VERIFY_TOKEN || "my_secret_token",
    whatsapp_token: perTenantToken || process.env.WHATSAPP_TOKEN || null,
    hasOwnToken: !!perTenantToken,
    trialExpired: isTrialExpired(t),
  };
}

export async function getTenantFull(id) {
  const t = await getTenant(id);
  return t ? withEnvDefaults(t) : null;
}

// مفتاح الذاكرة المعزول: tenant + phone (مستحيل يختلطوا)
export function memoryKey(tenantId, phone) {
  return `${tenantId}::${phone}`;
}

// حل مرن: id نصي أو كائن tenant جاهز (يستخدمه المرسل والذاكرة)
// بلا مدخل أو id مجهول: null (لا افتراضي صامت — المتصل يحدد البوت صراحةً)
export async function resolveTenantInput(input) {
  if (!input) return null;
  if (typeof input === "string") return (await getTenantFull(input)) || null;
  return input;
}

const PLANS = ["trial", "basic", "clinic", "pro"];
function cleanPlan(p) {
  const v = String(p || "trial").toLowerCase();
  if (!PLANS.includes(v)) throw new Error(`plan غير صالح — المسموح: ${PLANS.join(", ")}`);
  return v;
}
function cleanTrialDate(v) {
  if (v === null || v === undefined || v === "") return null;
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) throw new Error("trialEndsAt تاريخ غير صالح");
  return d;
}

export async function updateTenant(id, data) {
  const allowed = ["name", "botName", "enabled", "phoneNumberId", "verifyToken", "businessType", "products", "deliveryFee", "bundleOffer", "tone", "languages", "features", "plan", "trialEndsAt"];
  const clean = {};
  for (const k of allowed) if (data[k] !== undefined) clean[k] = data[k];
  // قاعدة المنصة: رقم واحد لكل بوت — مشاركة الأرقام مرفوضة (تمنع خلط الردود)
  if (clean.phoneNumberId) await assertPhoneUnique(clean.phoneNumberId, id);
  if (clean.features) await assertChannelIdentities(clean.features, id);
  // whatsappToken يُقبل باسم whatsappToken أو whatsapp_token ويُشفر قبل التخزين
  const rawToken = data.whatsappToken ?? data.whatsapp_token;
  if (rawToken !== undefined) {
    if (!rawToken) clean.whatsappToken = null; // مسح التوكن → رجوع للمشترك
    else clean.whatsappToken = encryptSecret(String(rawToken));
  }
  if (clean.plan !== undefined) clean.plan = cleanPlan(clean.plan);
  if (clean.trialEndsAt !== undefined) clean.trialEndsAt = cleanTrialDate(clean.trialEndsAt);
  // تجربة خالدة مرفوضة: trialEndsAt=null مع خطة trial = تجربة لا تنتهي —
  // null مسموح فقط للخطط المدفوعة، وإلا تُمنح 14 يوماً افتراضياً
  if (clean.trialEndsAt === null && (clean.plan || "trial") === "trial") {
    const row = await systemDb("tenants:trial-check").tenant.findUnique({ where: { id }, select: { plan: true } }).catch(() => null);
    if (!row || (row.plan || "trial") === "trial") clean.trialEndsAt = defaultTrialEnd();
  }
  const updated = await systemDb("tenants:update").tenant.update({ where: { id }, data: clean });
  invalidate();
  return updated;
}

export async function addTenant(data) {
  if (!data || !data.id || !data.name || !data.botName) {
    throw new Error("id و name و botName مطلوبة");
  }
  if (!/^[a-z0-9-]+$/.test(data.id)) {
    throw new Error("id يجب أن يكون حروف إنجليزية صغيرة وأرقام و - فقط");
  }
  const phoneNumberId = data.phone_number_id || data.phoneNumberId || null;
  if (phoneNumberId) await assertPhoneUnique(phoneNumberId, null);
  if (data.features) await assertChannelIdentities(data.features, null);
  const rawToken = data.whatsappToken ?? data.whatsapp_token;
  const created = await systemDb("tenants:create").tenant.create({
    data: {
      id: data.id,
      name: data.name,
      botName: data.botName,
      enabled: data.enabled !== false,
      phoneNumberId,
      verifyToken: data.verify_token || data.verifyToken || null,
      whatsappToken: rawToken ? encryptSecret(String(rawToken)) : null,
      plan: cleanPlan(data.plan),
      trialEndsAt: cleanTrialDate(data.trialEndsAt ?? defaultTrialEnd()),
      businessType: data.businessType || "general",
      products: Array.isArray(data.products) ? data.products : [],
      deliveryFee: data.deliveryFee ?? 5,
      bundleOffer: data.bundleOffer || {},
      tone: data.tone || "ودود ومهني",
      languages: Array.isArray(data.languages) ? data.languages : ["ar", "en"],
      features: data.features || {},
    },
  });
  invalidate();
  return created;
}

// تجربة افتراضية 14 يوماً للبوتات الجديدة (ما لم يُحدد plan مدفوع)
function defaultTrialEnd() {
  return new Date(Date.now() + 14 * 24 * 60 * 60 * 1000);
}

// رقم واحد لكل بوت: يرمي خطأً واضحاً عند تكرار phoneNumberId على بوت آخر
async function assertPhoneUnique(phoneNumberId, exceptId) {
  if (!phoneNumberId) return;
  const clash = (await loadTenants()).find((t) => t.phoneNumberId === phoneNumberId && t.id !== exceptId);
  if (clash) {
    const e = new Error(`الرقم ${phoneNumberId} مسجل مسبقاً على بوت "${clash.id}" — رقم واحد لكل بوت`);
    e.code = "PHONE_TAKEN";
    throw e;
  }
}

// هوية قناة واحدة لكل بوت (صفحة ماسنجر / حساب انستغرام) — نفس قاعدة الأرقام
async function assertChannelIdentities(features, exceptId) {
  const ids = [features?.messengerPageId, features?.instagramId].filter(Boolean);
  if (!ids.length) return;
  const all = await loadTenants();
  for (const id of ids) {
    const clash = all.find(
      (t) => t.id !== exceptId && (t.features?.messengerPageId === id || t.features?.instagramId === id)
    );
    if (clash) {
      const e = new Error(`هوية القناة ${id} مسجلة مسبقاً على بوت "${clash.id}" — هوية واحدة لكل بوت`);
      e.code = "CHANNEL_TAKEN";
      throw e;
    }
  }
}

export async function deleteTenant(id) {
  const all = await loadTenants();
  if (all.length <= 1) throw new Error("ممنوع حذف البوت الأخير");
  const row = await systemDb("tenants:delete").tenant.delete({ where: { id } }).catch(() => null);
  if (!row) throw new Error("tenant غير موجود");
  invalidate();
  return { id: row.id };
}

// بناء System Prompt لكل tenant من إعداداته
export function buildSystemPrompt(tenant) {
  const products = ((tenant?.products) || []).map((p, i) => `${i + 1}. ${p.name} — ${p.price} د.أ`).join("\n");
  const bundle = tenant?.bundleOffer?.enabled
    ? `\n🎁 عرض Bundle: ${tenant.bundleOffer.description}`
    : "";

  // ClinicCare Agent — شخصية السكرتيرة الذكية للعيادات (تُعمم على كل بوت عيادة)
  const isClinic = tenant?.businessType === "dental" || tenant?.businessType === "clinic" || tenant?.features?.clinicCare === true;
  const clinicPersona = isClinic ? `
# شخصيتك: السكرتيرة الذكية - ClinicCare Agent
- أنت سكرتيرة ذكية ودودة، تستقبلين المرضى على واتساب **بصوت أنثوي ولهجة أردنية خفيفة وبسيطة** (مش فصحى جامدة).
- افتحي كل حجز بترحيب: "أهلاً حبيبتي، معك ${tenant?.botName || "العيادة"}، كيف أقدر أساعدك؟" (للمذكر: "أهلاً حبيبي").
- تفهمين: "بدي أحجز"، "كم كشفية الدكتور؟"، "التأمين بغطي؟"، وتردين بلطف مع كبار السن.
- الخصوصية: لا تطلبي معلومات حساسة (رقم وطني، تشخيص مفصل) على واتساب — وجهي للعيادة.
- بعد الحجز: أرسلي موقع العيادة تلقائياً + تعليمات بسيطة.
- بعد الزيارة: رسالة متابعة + طلب تقييم لطيف على Google Maps إن وجد رابط المراجعة.
` : "";

  // ClinicCare: قاعدة أسئلة متكررة + موقع + رابط تقييم
  const faq = Array.isArray(tenant?.features?.clinicFaq) ? tenant.features.clinicFaq : [];
  const faqBlock = faq.length
    ? `\n# أسئلة العيادة المتكررة (أجب منها حرفياً):\n` + faq.map((q) => `- س: ${q.q}\n  ج: ${q.a}`).join("\n")
    : "";
  const locationBlock = tenant?.features?.location
    ? `\n# موقع العيادة: ${tenant.features.location.name || ""} — ${tenant.features.location.address || ""} (أرسل location بعد الحجز)`
    : "";
  const reviewBlock = tenant?.features?.googleReviewUrl
    ? `\n# بعد الزيارة: اطلب تقييم لطيف على Google Maps: ${tenant.features.googleReviewUrl}`
    : "";

  return `
أنت "${tenant?.botName || "وكيل"}"، وكيل ذكي لـ ${tenant?.name || "منصة وصل"} على واتساب — أسلوبك: ${tenant?.tone || (isClinic ? "لطيف، أردني بسيط، محترم للخصوصية" : "ودود")}.\n${clinicPersona}${faqBlock}${locationBlock}${reviewBlock}

# المنتجات المتاحة فقط (ممنوع اقتراح أي شيء خارجها):
${products}
${tenant?.deliveryFee ? `رسوم التوصيل ثابتة — ${tenant.deliveryFee} د.أ (تُضاف على أي طلب)` : ""}${bundle}

# قواعد البيع:
- ممنوع اقتراح منتجات أو أسعار غير مذكورة أعلاه.
- إذا اعترض العميل على السعر: وضّح القيمة أو اقترح منتجاً مكملاً.
- اذكر السعر الإجمالي مع التوصيل عند تأكيد الشراء.

# التصعيد للبشر (transfer_to_human):
- إذا طلب العميل التحدث مع موظف / إنسان / مدير / خدمة عملاء → transfer_to_human = true ورد يؤكد إبلاغ الفريق.

# اللغات: ${((tenant?.languages) || ["ar"]).join("، ")} - رد بنفس لغة العميل.

# العملة: دينار أردني (د.أ) دائماً — اكتب الأسعار مثل "50 د.أ" ولا تستخدم $ أبداً.

# هيكل الرد (JSON فقط بدون markdown):
{
  "reply": "نص الرد بنفس لغة العميل",
  "transfer_to_human": false,
  "intent": "استفسار | شراء | اعتراض_على_السعر | تصعيد | حجز_موعد",
  "buttons": [{"id": "x", "title": "زر"}],
  "image": "رابط صورة (اختياري)"
}
- buttons: اختياري حتى 3 أزرار من أزرار منتجاتك.
- حجز_موعد: فقط إذا كان الحجز مفعّلاً وطلب العميل موعداً.
`;
}
