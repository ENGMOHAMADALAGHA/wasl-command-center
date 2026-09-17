import dotenv from "dotenv";

dotenv.config();

// ── طبقة الإعدادات: المصدر الوحيد لمتغيرات البيئة ──

export const AI_PROVIDER = process.env.AI_PROVIDER?.toLowerCase() || "google";
export const GOOGLE_API_KEY = process.env.GOOGLE_API_KEY;
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY;
export const AI_MODEL =
  process.env.AI_MODEL || (AI_PROVIDER === "openai" ? "gpt-4o-mini" : "gemini-flash-lite-latest");

export const PORT = parseInt(process.env.PORT, 10) || 3000;
export const WEBHOOK_VERIFY_TOKEN = process.env.WEBHOOK_VERIFY_TOKEN || "my_secret_token";
export const WHATSAPP_TOKEN = process.env.WHATSAPP_TOKEN;
export const WHATSAPP_PHONE_ID = process.env.WHATSAPP_PHONE_ID;

// ── قنوات وصل: ماسنجر + انستغرام (توكن عام للتطوير — الإنتاج: توكن كل بوت ببياناته) ──
export const MESSENGER_PAGE_TOKEN = process.env.MESSENGER_PAGE_TOKEN || "";
export const INSTAGRAM_PAGE_TOKEN = process.env.INSTAGRAM_PAGE_TOKEN || "";

export const ADMIN_USER = process.env.ADMIN_USER || "";
export const ADMIN_PASS = process.env.ADMIN_PASS || "";
export const JWT_SECRET = process.env.JWT_SECRET || "";
// مخرج طوارئ مؤقت لرقم مشترك: id البوت المالك للرقم (يُستخدم فقط عند تكرار الرقم).
// الوضع الصحيح: رقم واحد لكل بوت (assertPhoneUnique يمنع الجديد) — هذا للوضع القائم فقط حتى يُفصل.
export const SHARED_NUMBER_TENANT_ID = process.env.SHARED_NUMBER_TENANT_ID || "";
export const TOKEN_ENC_KEY = process.env.TOKEN_ENC_KEY || "";

export const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || "https://wasl-command-center.onrender.com";
export const CRM_WEBHOOK_URL = process.env.CRM_WEBHOOK_URL || "";

export const META_APP_SECRET = process.env.META_APP_SECRET || "";

// ── Embedded Signup: ربط العميل برقمه بنفسه (onboarding ذاتي بدقيقتين) ──
// المتطلب بلوحة Meta (مرة واحدة): منتج Facebook Login for Business +
// Configuration ID بصلاحيات whatsapp_business_management/messaging + Allowed Domains.
// GMAPS: القيم علنية بالتصميم (تُضمن بزر الربط) — السر يبقى META_APP_SECRET فقط.
export const META_APP_ID = process.env.META_APP_ID || "";
export const META_EMBEDDED_CONFIG_ID = process.env.META_EMBEDDED_CONFIG_ID || "";
// ── Coexistence: كونفج ثاني لمستخدمي تطبيق واتساب بزنس الحاليين (زر الخيار الثاني) ──
// يُنشأ بلوحة Meta من القالب (Create from template) بنفس الصلاحيات والروابط.
// غيابه = رجوع تلقائي للكونفج الأساسي (مسار الترحيل) — بلا كسر.
// (يُضبط أيضاً على Render > Environment ليعمل بالإنتاج)
export const META_EMBEDDED_CONFIG_ID_COEX = process.env.META_EMBEDDED_CONFIG_ID_COEX || "";

export const VOICE_TIMEOUT_MS = Number(process.env.VOICE_TIMEOUT_MS || 15000);
export const VOICE_MAX_MB = Number(process.env.VOICE_MAX_MB || 8);

export const REMIND_EVERY_MS = Number(process.env.REMIND_EVERY_MS || 5 * 60 * 1000);
export const REMIND_AFTER_MIN = Number(process.env.REMIND_AFTER_MIN || 60);
export const CART_AFTER_MIN = Number(process.env.CART_AFTER_MIN || 60);

export const MAX_HISTORY = 10;
export const MEMORY_TTL_MS = 1000 * 60 * 60 * 6;

// ── سرعة الرد: سياق أصغر + مهلة صارمة على الـ AI ──
export const AI_TIMEOUT_MS = Number(process.env.AI_TIMEOUT_MS || 25000);
export const AI_HISTORY_LIMIT = Number(process.env.AI_HISTORY_LIMIT || 6);
export const AI_HISTORY_CHARS = Number(process.env.AI_HISTORY_CHARS || 500);

// ── P1: طوابير دائمة (Redis/BullMQ — اختياري، رجوع تلقائي للذاكرة) ──
export const REDIS_URL = process.env.REDIS_URL || "";
export const USE_DURABLE_QUEUE = process.env.USE_DURABLE_QUEUE !== "0" && !!process.env.REDIS_URL;

// ── P1: الفويس (طابور منخفض التزامن + مهلات) ──
export const VOICE_QUEUE_CONCURRENCY = Number(process.env.VOICE_QUEUE_CONCURRENCY || 2);
export const VOICE_TRANSCRIBE_TIMEOUT_MS = Number(process.env.VOICE_TRANSCRIBE_TIMEOUT_MS || 45000);

// ── P1: الإرسال الصادر (إعادة + DLQ) ──
export const OUTBOUND_MAX_RETRIES = Number(process.env.OUTBOUND_MAX_RETRIES || 3);
export const OUTBOUND_BASE_DELAY_MS = Number(process.env.OUTBOUND_BASE_DELAY_MS || 1000);
export const OUTBOUND_TIMEOUT_MS = Number(process.env.OUTBOUND_TIMEOUT_MS || 15000);

// ── P1: طاقم العمل والقوالب (امتثال واتساب) ──
export const STAFF_PHONE = process.env.STAFF_PHONE || "";
export const WA_TEMPLATE_LANG = process.env.WA_TEMPLATE_LANG || "ar";
export const WA_FOLLOWUP_TEMPLATE = process.env.WA_FOLLOWUP_TEMPLATE || "";
