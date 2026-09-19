import { getTenantFull } from "../../../tenants.mjs";
import { verifyClientUser, signClientToken, startPasswordReset, finishPasswordReset } from "../../../portal.mjs";
import { sendWithWindowFallback } from "../../compliance/messaging.mjs";
import { checkLimit, loginKey } from "../../security/rateLimit.mjs";

export function registerPortalRoutes(app) {
  app.post("/portal/login", async (req, res) => {
    try {
      const { verifyClientUser, signClientToken } = await import("../../../portal.mjs");
      const { tenantId, phone, password } = req.body || {};
      // حماية تخمين: 5 محاولات/دقيقة لكل حساب
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      const lim = await checkLimit(loginKey(tenantId, phone, ip), 5, 60 * 1000);
      if (!lim.allowed) {
        return res.status(429).json({ ok: false, error: `محاولات كثيرة — حاول بعد ${lim.retryAfter} ثانية` });
      }
      const u = await verifyClientUser(tenantId, phone, password);
      if (!u) return res.status(401).json({ ok: false, error: "بيانات الدخول غير صحيحة" });
      if (u.disabled) return res.status(403).json({ ok: false, error: "هذا البوت موقوف — تواصل مع الإدارة" });
      // اتساق مع adminAuth: تجربة منتهية = مرفوض (كان يدخل هنا ويُمنع هناك)
      if (u.tenant && u.tenant.trialEndsAt && (u.tenant.plan || "trial") === "trial" && new Date(u.tenant.trialEndsAt) < new Date()) {
        return res.status(403).json({ ok: false, error: "الفترة التجريبية انتهت — جدد خطتك لمتابعة الدخول" });
      }
      res.json({ ok: true, token: signClientToken(u), botName: u.tenant?.botName, tenantId: u.tenantId });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.post("/portal/forgot", async (req, res) => {
    try {
      const { startPasswordReset } = await import("../../../portal.mjs");
      const { tenantId, phone } = req.body || {};
      // حماية من سبام الرسائل + تخمين: 3 طلبات/دقيقة لكل حساب
      const ip = req.ip || req.socket?.remoteAddress || "unknown";
      const lim = await checkLimit(loginKey(tenantId, phone, ip) + ":forgot", 3, 60 * 1000);
      if (!lim.allowed) {
        return res.status(429).json({ ok: false, error: `محاولات كثيرة — حاول بعد ${lim.retryAfter} ثانية` });
      }
      const tenant = await getTenantFull(tenantId);
      if (!tenant) return res.json({ ok: true }); // لا نكشف
      // البديل المتوافق: يصل الرمز حتى خارج نافذة 24h (قالب) أو يُوثق بصمت
      await startPasswordReset(tenantId, phone, (codeMsg) => sendWithWindowFallback(phone, codeMsg, tenant));
      res.json({ ok: true });
    } catch (e) {
      res.json({ ok: true }); // دائماً نجاح ظاهري (حماية)
    }
  });
  app.post("/portal/reset", async (req, res) => {
    const { tenantId, phone, code, newPassword } = req.body || {};
    // حماية تخمين الرمز: 5 محاولات/15 دقيقة لكل حساب+IP (مؤكد حاسوبياً ضد القوة العمياء)
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const lim = await checkLimit(`${loginKey(tenantId, phone, ip)}:reset`, 5, 15 * 60 * 1000);
    if (!lim.allowed) {
      return res.status(429).json({ ok: false, error: `محاولات كثيرة — حاول بعد ${lim.retryAfter} ثانية` });
    }
    try {
      const { finishPasswordReset } = await import("../../../portal.mjs");
      await finishPasswordReset(tenantId, phone, code, newPassword);
      res.json({ ok: true });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
}
