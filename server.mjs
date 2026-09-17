import { startServer } from "./agent.mjs";
import { db } from "./db.mjs";

let httpServer = null;

// إغلاق نظيف: صرّف اتصالات HTTP الطائرة أولاً ثم القاعدة — بلا قطع لطلبات حية
function gracefulShutdown(signal) {
  console.error(`  🛑 ${signal} — إغلاق نظيف...`);
  const killer = setTimeout(() => process.exit(0), 8000).unref?.();
  const closeHttp = httpServer
    ? new Promise((res) => httpServer.close(() => res()))
    : Promise.resolve();
  closeHttp
    .catch((e) => console.error(`  ⚠️ فشل تصريف HTTP: ${e?.message}`))
    .then(() => Promise.resolve(db()?.$disconnect?.()).catch((e) => console.error(`  ⚠️ فشل إغلاق القاعدة: ${e?.message}`)))
    .finally(() => {
      clearTimeout(killer);
      process.exit(0);
    });
}
process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

// سيرفر مستقل - يستورد منطق وصل من agent.mjs
// للتشغيل: node server.mjs أو npm start

// رفض غير معالَج = حالة مجهولة: سجّل واخرج ليعيد المشرف التشغيل بحالة نظيفة
// (فشل-سريع بدل بوت متدهور صامت — consistent مع uncaughtException)
process.on("unhandledRejection", (reason) => {
  console.error("  ☠️ unhandledRejection (will exit 1):", reason?.message || reason);
  setImmediate(() => process.exit(1));
});
// الأخطاء غير المعالجة قاتلة: سجّل واخرج بكود فشل صريح
// حتى يعيد Render/PM2 التشغيل (فشل-سريع) بدل بوت أصم يخدم صامتاً
process.on("uncaughtException", (err) => {
  console.error("  ☠️ uncaughtException (will exit 1):", err?.message || err);
  if (err?.stack) console.error(err.stack);
  setImmediate(() => process.exit(1));
});

// الإنتاج بلا قاعدة = بوت أصم — ارفض الإقلاع بدل "صحة وهمية"
if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL) {
  console.error("  ☠️ الإنتاج يتطلب DATABASE_URL — أرفض الإقلاع (فشل-سريع) بدل بوت أصم.");
  process.exit(1);
}

// P0-4: فشل-سريع للإنتاج — أسرار ناقصة = webhooks مرفوضة (403) أو توكنات مشتركة صامتة.
// اكتشافها عند الإقلاع بصوت عالٍ بدل تدهور صامت بعد 200 (درس ليلة التسجيل).
if (process.env.NODE_ENV === "production") {
  // META_APP_SECRET ناقص = كل الـ webhooks تُرفض 403 (عطل كامل) — ارفض الإقلاع
  if (!process.env.META_APP_SECRET) {
    console.error("  ☠️ الإنتاج يتطلب META_APP_SECRET — أرفض الإقلاع (فشل-سريع). أضفه في Render > Environment.");
    process.exit(1);
  }
  // TOKEN_ENC_KEY ناقص = سقوط صامت للتوكن المشترك — تحذير عالٍ (لا إيقاف: البوتات بلا توكن مشفر تعمل بالمشترك)
  if (!process.env.TOKEN_ENC_KEY) {
    console.error("  ⚠️ الإنتاج بلا TOKEN_ENC_KEY — أي بوت بتوكن مشفر سيسقط للمشترك. أضفه في Render > Environment.");
  }
  // A4: توكن تحقق افتراضي = خطف اشتراك مؤكد — ارفض الإقلاع (فشل-سريع).
  // (قبل النشر: قيمة قوية في Render > Environment + تحديث Callback بلوحة Meta بها)
  if (!process.env.WEBHOOK_VERIFY_TOKEN || process.env.WEBHOOK_VERIFY_TOKEN === "my_secret_token") {
    console.error("  ☠️ الإنتاج يتطلب WEBHOOK_VERIFY_TOKEN قوياً (غير الافتراضي) — أرفض الإقلاع. اضبطه في Render > Environment وحدّث اشتراك Meta.");
    process.exit(1);
  }
}

setHttpServer(startServer());

export { httpServer };
export function setHttpServer(s) {
  httpServer = s;
}
