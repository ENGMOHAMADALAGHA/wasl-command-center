import crypto from "node:crypto";
import { ADMIN_USER, ADMIN_PASS, META_APP_SECRET } from "../config/env.mjs";
import { checkLimit } from "../security/rateLimit.mjs";
import { getTenantFull } from "../../tenants.mjs";

export async function adminRateLimit(req, res, next) {
  if (req.isSuperAdmin || req.clientTenant) return next();
  const header = req.headers?.authorization || "";
  if (header.startsWith("Bearer ")) return next();
  const ip = req.ip || req.socket?.remoteAddress || "unknown";
  const lim = await checkLimit(`admin:${ip}`, 20, 60 * 1000);
  if (!lim.allowed) {
    res.setHeader("Retry-After", String(lim.retryAfter));
    return res.status(429).json({ ok: false, error: `محاولات كثيرة — حاول بعد ${lim.retryAfter} ثانية` });
  }
  next();
}

// ── حماية /admin: سوبر أدمن (Basic) أو عميل (JWT) ──
// مسارات ممنوعة على العملاء (إدارة البوتات والمستخدمين فقط للسوبر)
// ملاحظة: req.path هنا بدون بادئة /admin لأن الـ middleware مركّب عليها
const SUPER_ONLY = ["/tenants", "/users"];
export const adminAuth = async (req, res, next) => {
  const header = req.headers.authorization || "";
  const [scheme, encoded] = header.split(" ");
  // 1) عميل بـ JWT؟
  if (scheme === "Bearer" && encoded) {
    const { verifyClientToken } = await import("../../portal.mjs");
    const p = await verifyClientToken(encoded);
    if (p) {
      // kill switch + trial: الموقوف أو منتهي التجربة لا يدخل
      const t = await getTenantFull(p.tenantId);
      if (!t || t.enabled === false) {
        return res.status(403).json({ ok: false, error: "هذا البوت موقوف — تواصل مع الإدارة" });
      }
      if (t.trialExpired) {
        return res.status(403).json({ ok: false, error: "الفترة التجريبية انتهت — جدد خطتك لمتابعة الدخول" });
      }
      if (SUPER_ONLY.some((s) => req.path === s || req.path.startsWith(s + "/"))) {
        return res.status(403).json({ ok: false, error: "غير مصرح" });
      }
      req.clientTenant = p.tenantId; // إجبار النطاق على بوته فقط
      return next();
    }
  }
  // 2) سوبر أدمن؟
  if (scheme === "Basic" && encoded) {
    if (!ADMIN_USER || !ADMIN_PASS) {
      // Fail-closed: missing credentials = deny, never bypass.
      return res.status(503).json({ ok: false, error: "إعدادات المدير ناقصة (ADMIN_USER/ADMIN_PASS)" });
    }
    const [u, pass] = Buffer.from(encoded, "base64").toString().split(":");
    if (u === ADMIN_USER && pass === ADMIN_PASS) {
      req.isSuperAdmin = true;
      return next();
    }
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const lim = await checkLimit(`adminfail:${ip}`, 20, 60 * 1000);
    if (!lim.allowed) {
      res.setHeader("Retry-After", String(lim.retryAfter));
      return res.status(429).json({ ok: false, error: `محاولات كثيرة — حاول بعد ${lim.retryAfter} ثانية` });
    }
  }
  if (!(req.headers.authorization || "")) {
    const ip = req.ip || req.socket?.remoteAddress || "unknown";
    const lim = await checkLimit(`adminanon:${ip}`, 20, 60 * 1000);
    if (!lim.allowed) {
      res.setHeader("Retry-After", String(lim.retryAfter));
      return res.status(429).json({ ok: false, error: `محاولات كثيرة — حاول بعد ${lim.retryAfter} ثانية` });
    }
  }
  if (req.path === "/") res.setHeader("WWW-Authenticate", 'Basic realm="admin"');
  return res.status(401).json({ ok: false, error: "مطلوب تسجيل دخول المدير" });
};
// ── تحقق توقيع Meta (X-Hub-Signature-256) لمنع حقن Webhooks مزيفة ──
// يتطلب META_APP_SECRET + rawBody (يُحفظ عبر express.json verify في app.mjs)
export function verifyMetaSignature(req, res, next) {
  if (!META_APP_SECRET) {
    // Fail-closed: never accept unsigned webhooks when secret is missing.
    console.error("  ❌ META_APP_SECRET غير مضبوط — رفض webhook (fail-closed)");
    return res.sendStatus(403);
  }
  const sig = req.headers["x-hub-signature-256"] || "";
  if (!sig.startsWith("sha256=") || !req.rawBody) {
    console.warn("  ❌ webhook بدون توقيع صالح — مرفوض");
    return res.sendStatus(403);
  }
  const expected = "sha256=" + crypto.createHmac("sha256", META_APP_SECRET).update(req.rawBody).digest("hex");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    console.warn("  ❌ توقيع webhook غير صالح — مرفوض");
    return res.sendStatus(403);
  }
  next();
}

// إجبار نطاق العميل على بوته في كل الطلبات
export function scopeClient(req, res, next) {
  if (req.clientTenant) {
    req.query.tenant = req.clientTenant;
    if (req.body && typeof req.body === "object") {
      req.body.tenantId = req.clientTenant;
      req.body.tenant = req.clientTenant;
    }
    if (req.params.tenantId) req.params.tenantId = req.clientTenant;
  }
  next();
}

// ── حماية CSRF لطلبات تغيير الحالة (POST/PUT/PATCH/DELETE) ──
// خط الدفاع الثاني بعد الـ Authorization header:
// المتصفح يرافق أي طلب بـ Sec-Fetch-Site و/أو Origin — خضورهما من أصل آخر = رفض فوري.
// Meta Graph (webhook) لا يرسل أي منهما — يمر بحرية (server-to-server).
export function csrfGuard(req, res, next) {
  if (!["POST", "PUT", "PATCH", "DELETE"].includes(req.method)) return next();
  const sfs = req.headers["sec-fetch-site"];
  if (sfs === "cross-site") {
    console.warn(`  🛡️ CSRF مرفوض: ${req.method} ${req.path} (sec-fetch-site=cross-site)`);
    return res.status(403).json({ ok: false, error: "طلبات من أصل آخر مرفوضة" });
  }
  const origin = req.headers.origin;
  if (origin) {
    const host = req.headers.host;
    let same = false;
    try {
      const u = new URL(origin);
      same = !!host && u.host === host;
    } catch { same = false; }
    if (!same) {
      console.warn(`  🛡️ CSRF Origin مرفوض: ${origin} ضد host ${host}`);
      return res.status(403).json({ ok: false, error: "اصل الطلب غير متطابق" });
    }
  }
  next();
}
