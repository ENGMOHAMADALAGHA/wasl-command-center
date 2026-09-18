import express from "express";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// قناع سر قبل الطباعة — لا يُطبع أي توكن كاملاً في السجلات
function maskSecret(s) {
  if (!s) return "(غير مضبوط)";
  const str = String(s);
  return str.length <= 6 ? "••••" : `${str.slice(0, 2)}…${str.slice(-2)}`;
}

import { PORT, WEBHOOK_VERIFY_TOKEN, WHATSAPP_PHONE_ID, AI_PROVIDER, AI_MODEL, ADMIN_USER, ADMIN_PASS, META_APP_SECRET } from "../config/env.mjs";
import { listTenants } from "../../tenants.mjs";
import { isDemoMode } from "../ai/engine.mjs";
import { db } from "../../db.mjs";
import { adminAuth, adminRateLimit, scopeClient, csrfGuard } from "./middleware.mjs";
import { replayInflightWebhooks } from "./routes/webhook.mjs";
import { registerAdminRoutes } from "./routes/admin.mjs";
import { registerPortalRoutes } from "./routes/portal.mjs";
import { registerWebhookRoutes } from "./routes/webhook.mjs";
import { startSchedulers } from "../jobs/schedulers.mjs";

export function createApp() {
  const app = express();

  // ترويسات أمنية عامة بدل الاعتماد على خوادم خارجية
  // (CSP متعمد: بلا ترويض لأن الكونسول يعتمد Tailwind/Script مضمّن — التعقيد وقابلية الكسر أكبر من منفعته)
  app.use((req, res, next) => {
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Referrer-Policy", "no-referrer");
    // لوحات الإدارة لا تُؤطَّر أبداً؛ معاينات البوابة (iframe same-origin) تبقى مسموحة بـ SAMEORIGIN
    res.setHeader("X-Frame-Options", req.path.startsWith("/admin") ? "DENY" : "SAMEORIGIN");
    res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
    if (process.env.NODE_ENV === "production") {
      res.setHeader("Strict-Transport-Security", "max-age=31536000; includeSubDomains");
    }
    next();
  });

  // ضروري لقراءة JSON من واتساب + حفظ الخام للتحقق من التوقيع
  // حد 1MB: الحمولات نصية صغيرة، والصوت/الصور تُسحب كروابط لا base64
  app.use(express.json({
    limit: "1mb",
    verify: (req, res, buf) => {
      req.rawBody = buf;
    },
  }));
  app.use(express.urlencoded({ extended: true, limit: "100kb" }));
  // حماية تغيير الحالة من أصول أجنبية (يُطبق قبل كل المسارات)
  app.use(csrfGuard);
  // أصول محلية (Tailwind مُضمّن — لا سكربتات خارجية حية داخل الكونسول)
  app.use("/assets", express.static(path.join(__dirname, "..", "..", "assets")));
  app.use("/admin", adminAuth);
  app.use("/admin", adminRateLimit);
  app.use("/admin", scopeClient);

  app.get("/", async (req, res) => {
    const tenants = (await listTenants()).length;
    const status = {
      name: "Wasl Command Center — وصل (Multi-Tenant)",
      status: "running",
      webhook: "/webhook",
      admin: "/admin/tenants",
      tenants,
      mode: isDemoMode ? "DEMO" : AI_PROVIDER,
    };
    // عودة Meta من Embedded Signup قد تهبط هنا بدل /admin/ (redirect URI جذري):
    // صفحة Forward صغيرة تعيد المتصفح للأدمن مع التوكن/الكود بدل شاشة JSON ميتة.
    // (عملاء API والمراقبة يقبلون JSON فيبقون على JSON — بلا كسر)
    if ((req.headers.accept || "").includes("text/html")) {
      return res.type("html").send(
        `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>وصل — Wasl Command Center</title></head><body style="font-family:system-ui,Tajawal,Arial;max-width:640px;margin:60px auto;padding:0 20px;line-height:2;color:#1e293b;text-align:center"><h1>وصل — Wasl Command Center</h1><p>الحالة: يعمل ✅ | البوتات: ${tenants}</p><p><a href="/admin/" style="color:#6d28d9">فتح لوحة الإدارة</a></p><script>(function(){var h=location.hash||"",q=location.search||"";if(/(access_token|code)=/.test(h+q)){location.replace("/admin/"+q+h);}})();<\/script></body></html>`
      );
    }
    res.json(status);
  });

  // فحص البقاء/الجاهزية لمزوّد الاستضافة — الآن يختبر القاعدة فعلياً:
// "حية" = السيرفر + قاعدة البيانات معاً؛ وتعطل إحداهما يُظهر 503 (لا صحة وهمية)
  app.get("/healthz", async (req, res) => {
    let dbOk = true;
    try {
      const d = db();
      if (!d) throw new Error("no-db");
      await d.$queryRaw`SELECT 1`;
    } catch {
      dbOk = false;
    }
    if (!dbOk) {
      return res.status(503).json({ ok: false, service: "wasl-agent", error: "db-unreachable" });
    }
    res.status(200).json({
      ok: true,
      service: "wasl-agent",
      pid: process.pid,
      uptimeSec: Math.round(process.uptime()),
      now: new Date().toISOString(),
      mode: isDemoMode ? "DEMO" : AI_PROVIDER,
    });
  });

  // صفحتا /admin/ و /portal/ تُسجَّلان من admin/pages.mjs (مصدر واحد — بلا تكرار)
  registerAdminRoutes(app);
  registerPortalRoutes(app);
  registerWebhookRoutes(app);

  // ── صفحات Meta المطلوبة: سياسة الخصوصية + الشروط + حذف البيانات ──
  // روابط عمومية (بلا auth) على نفس الدومين — تُستخدم بحقول App Dashboard الأساسية.
  const legalPage = (title, body) =>
    `<!DOCTYPE html><html lang="ar" dir="rtl"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} — Wasl Command Center</title><style>body{font-family:system-ui,Tajawal,Arial;max-width:760px;margin:40px auto;padding:0 20px;line-height:1.9;color:#1e293b}h1{font-size:24px}h2{font-size:18px;margin-top:28px}a{color:#6d28d9}</style></head><body><h1>${title} — وصل (Wasl Command Center)</h1>${body}<hr><p>التواصل: alamosh.mhamad1@gmail.com | آخر تحديث: 2026-09-16</p></body></html>`;
  app.get("/privacy", (req, res) => {
    res.type("html").send(legalPage("سياسة الخصوصية",
      `<p>منصة وصل تربط أرقام واتساب الأنشطة التجارية عبر Meta WhatsApp Cloud API الرسمي لأتمتة الردود والحجوزات والطلبات.</p><h2>البيانات التي نجمعها</h2><p>أرقام الهواتف، محتوى رسائل واتساب اللازمة للرد، بيانات الحجوزات والطلبات، وسجلات تقنية (logs) للتشغيل والحماية.</p><h2>كيف نستخدمها</h2><p>تقديم الخدمة فقط: الرد الآلي، إدارة الحجوزات، إشعارات صاحب النشاط. لا نبيع البيانات ولا نشاركها مع طرف ثالث لأغراض تسويقية.</p><h2>صلاحيات Meta</h2><p>نطلب whatsapp_business_management و whatsapp_business_messaging فقط لربط رقم العميل وإرسال ردوده. التوكنات تُخزن مشفرة على الخادم ولا تغادره.</p><h2>الاحتفاظ والحذف</h2><p>تُحفظ البيانات طوال مدة الاشتراك، وتُحذف عند طلب صاحب النشاط عبر صفحة <a href="/data-deletion">حذف البيانات</a> أو عبر البريد أعلاه خلال 30 يوماً.</p>`));
  });
  app.get("/terms", (req, res) => {
    res.type("html").send(legalPage("شروط الخدمة",
      `<p>باستخدام منصة وصل أنت توافق على: استخدام المنصة لأنشطة مشروعة فقط، الالتزام بسياسات واتساب وMeta، وعدم إرسال رسائل مزعجة (spam).</p><h2>الاشتراك والإلغاء</h2><p>الخدمة باشتراك شهري لكل بوت، ويمكن الإلغاء بأي وقت من لوحة الإدارة — يتوقف الربط ويُحذف التوكن.</p><h2>المسؤولية</h2><p>المنصة أداة أتمتة؛ صاحب النشاط مسؤول عن محتوى ردوده وعروضه وأسعاره. نبذل جهداً معقولاً للاستمرارية دون ضمان انقطاع صفر.</p>`));
  });
  app.get("/data-deletion", (req, res) => {
    res.type("html").send(legalPage("تعليمات حذف البيانات",
      `<p>لحذف بيانات نشاطك من منصة وصل:</p><ol><li>راسلنا من بريد النشاط إلى alamosh.mhamad1@gmail.com بعنوان "حذف بيانات" مع اسم البوت ورقم واتساب.</li><li>نحذف المحادثات والحجوزات والطلبات والتوكنات خلال 30 يوماً ونرسل تأكيداً.</li><li>للحذف الفوري من طرف Meta: احذف التطبيق من <a href="https://www.facebook.com/settings?tab=business_tools">إعدادات الأعمال في فيسبوك</a>.</li></ol>`));
  });

  // 404 موحد + ملقم أخطاء يمنع تسرب الستاك
  app.use((req, res) => {
    res.status(404).json({ ok: false, error: "غير موجود" });
  });
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error(`  ❌ خطأ غير معالج [${req.method} ${req.path}]: ${err.message}`);
    if (res.headersSent) return next(err);
    // payload أكبر من حد 1MB → 413 واضح بدل 500 عمياء
    const status = err.type === "entity.too.large" ? 413 : (err.status || err.statusCode || 500);
    const body = status === 413 ? "الطلب أكبر من المسموح" : status === 404 ? "غير موجود" : "خطأ داخلي";
    res.status(status).json({ ok: false, error: body });
  });

  return app;
}

export function startServer(port = PORT) {
  const app = createApp();
  startSchedulers();
  const server = app.listen(port, () => {
    console.log("\n" + "═".repeat(60));
    console.log("  🤖  Wasl Command Center — وصل | سيرفر واتساب Webhook");
    console.log("═".repeat(60));
    console.log(`  🌐 السيرفر يعمل: http://localhost:${port}`);
    console.log(`  🔗 Webhook URL: http://localhost:${port}/webhook`);
    console.log(`  🔑 Verify Token: ${maskSecret(WEBHOOK_VERIFY_TOKEN)}`);
    console.log(`  📱 Phone ID: ${WHATSAPP_PHONE_ID || "(غير مضبوط - وضع محاكاة)"}`);
    console.log(`  🧠 المزود: ${AI_PROVIDER} | النموذج: ${AI_MODEL} | الوضع: ${isDemoMode ? "DEMO" : "API حقيقي"}`);
    // فحص الإعدادات الحرجة عند الإقلاع (لا فشل صامت — تحذير واضح)
    if (!ADMIN_USER || !ADMIN_PASS) {
      console.log("  ⚠️  ADMIN_USER/ADMIN_PASS غير مضبوطين — /admin سيرفض الدخول (503 fail-closed). أضفهما إلى .env");
    } else {
      console.log("  👤 دخول المدير: مفعّل (/admin يطلب Basic Auth)");
    }
    if (!META_APP_SECRET) {
      console.log("  ⚠️  META_APP_SECRET غير مضبوط — webhooks الواردة ستُرفض (403 fail-closed)");
    }
    if (!WEBHOOK_VERIFY_TOKEN || WEBHOOK_VERIFY_TOKEN === "my_secret_token") {
      console.log("  ⚠️  WEBHOOK_VERIFY_TOKEN افتراضي (my_secret_token) — غيّره في .env قبل أي نشر عمومي لمنع خطف الاشتراك");
    }
    console.log("═".repeat(60));
    console.log(`  💡 للاختبار المحلي: استخدم ngrok أو similar`);
    console.log(`     ngrok http ${port}`);
    console.log("═".repeat(60) + "\n");
    // P0-3 — بعد جاهزية الاستماع: استعادة أي حمولات علّقت أثناء الطيران
    // (انقطاع/إعادة نشر أثناء المعالجة) — بلا فقد ولا تكرار عبر dedup الـ wamid
    setTimeout(() => {
      replayInflightWebhooks().catch((e) => console.error(`  ⚠️ فشل replay: ${e.message}`));
    }, 2500);
  });
  return server;
}
