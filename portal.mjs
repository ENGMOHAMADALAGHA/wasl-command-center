import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import crypto from "node:crypto";
import { tenantDb, systemDb } from "./src/security/tenantGuard.mjs";
import { normalizePhone } from "./src/utils/phone.mjs";

function secret() {
  const s = process.env.JWT_SECRET;
  if (!s) throw new Error("JWT_SECRET غير مضبوط في البيئة");
  return s;
}

// —— حسابات العملاء (يستدعيها السوبر أدمن فقط) ——
// ملاحظة أمنية: upsert يعيد تعيين الكلمة — إعادة الدعوة مقصودة فقط عبر /admin/invites.
// إنشاء مستخدم موجود عبر /admin/users مرفوض (409) لمنع الاستيلاء على الحسابات.
export async function getClientUser(tenantId, phone) {
  if (!tenantId || !phone) return null;
  phone = normalizePhone(phone);
  return tenantDb(tenantId).tenantUser.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
}

export async function createClientUser({ tenantId, name, phone, password, allowReset = false }) {
  if (!tenantId || !phone || !password) throw new Error("tenantId و phone و password مطلوبة");
  phone = normalizePhone(phone);
  if (String(password).length < 8) throw new Error("كلمة السر 8 أحرف على الأقل");
  if (!allowReset) {
    const existing = await getClientUser(tenantId, phone);
    if (existing) {
      const e = new Error("المستخدم موجود مسبقاً — استخدم دعوة جديدة لتدوير الكلمة");
      e.code = "USER_EXISTS";
      throw e;
    }
  }
  const passwordHash = await bcrypt.hash(String(password), 10);
  return tenantDb(tenantId).tenantUser.upsert({
    where: { tenantId_phone: { tenantId, phone } },
    update: { name: name || undefined, passwordHash },
    create: {
      id: `usr_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`,
      phone, name: name || phone, passwordHash,
    },
  });
}

export async function verifyClientUser(tenantId, phone, password) {
  if (!tenantId || !phone) return null;
  phone = normalizePhone(phone);
  const u = await tenantDb(tenantId).tenantUser.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
    include: { tenant: true },
  });
  if (!u) return null;
  if (u.tenant && u.tenant.enabled === false) return { disabled: true };
  const ok = await bcrypt.compare(String(password), u.passwordHash);
  if (!ok) return null;
  return u;
}

export function signClientToken(user) {
  return jwt.sign(
    { sub: user.id, tenantId: user.tenantId, phone: user.phone, role: "client", v: Date.now() },
    secret(),
    { expiresIn: "12h" }
  );
}

// توكن معاينة قصير (10 دقائق) — السوبر أدمن يشوف بوابة العميل كما يراها تماماً
// يُستخدم للعروض التقديمية فقط، ويُحترم نفس عزل الـ JWT العادي
export function signPreviewToken(tenantId) {
  return jwt.sign(
    { sub: `preview:${tenantId}`, tenantId, phone: "preview", role: "client", preview: true },
    secret(),
    { expiresIn: "10m" }
  );
}

export async function verifyClientToken(token) {
  try {
    const p = jwt.verify(token, secret());
    if (p.role !== "client" || !p.tenantId) return null;
    // إلغاء سريع بعد reset: قارن iat مع revokedAt المخزن
    try {
      const { storeGet } = await import("./store.mjs");
      const revoked = await storeGet(`jwtRevoked:${p.tenantId}:${p.phone}`);
      if (revoked?.at && p.iat * 1000 < revoked.at) return null;
    } catch {}
    return p;
  } catch {
    return null;
  }
}
export function verifyClientTokenSync(token) {
  try {
    const p = jwt.verify(token, secret());
    if (p.role !== "client" || !p.tenantId) return null;
    return p;
  } catch { return null; }
}

// —— نسيت كلمة السر: كود من 6 أرقام عبر واتساب ——
export async function startPasswordReset(tenantId, phone, sendFn) {
  if (!tenantId || !phone) return { ok: false };
  phone = normalizePhone(phone);
  const u = await tenantDb(tenantId).tenantUser.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
  if (!u) return { ok: false }; // لا نكشف وجود الحساب
  // كود 6 أرقام من CSPRNG (لا Math.random — قابل للتنبؤ ببيئة مشتركة)
  const code = String(crypto.randomInt(100000, 1000000));
  const codeHash = await bcrypt.hash(code, 8);
  await tenantDb(tenantId).tenantUser.update({
    where: { id: u.id },
    data: { resetCode: codeHash, resetExpires: new Date(Date.now() + 15 * 60 * 1000) },
  });
  await sendFn(`رمز إعادة تعيين كلمة السر: ${code}\nصالح 15 دقيقة. لا تشاركه مع أحد.`);
  return { ok: true };
}

export async function finishPasswordReset(tenantId, phone, code, newPassword) {
  if (!tenantId || !phone) throw new Error("بيانات ناقصة");
  phone = normalizePhone(phone);
  if (!newPassword || String(newPassword).length < 8) throw new Error("كلمة السر 8 أحرف على الأقل");
  const u = await tenantDb(tenantId).tenantUser.findUnique({
    where: { tenantId_phone: { tenantId, phone } },
  });
  if (!u || !u.resetCode || !u.resetExpires || u.resetExpires < new Date()) {
    throw new Error("الرمز غير صالح أو منتهي");
  }
  const ok = await bcrypt.compare(String(code), u.resetCode);
  if (!ok) throw new Error("الرمز غير صحيح");
  await tenantDb(tenantId).tenantUser.update({
    where: { id: u.id },
    data: { passwordHash: await bcrypt.hash(String(newPassword), 10), resetCode: null, resetExpires: null },
  });
  try {
    const { storeSet } = await import("./store.mjs");
    await storeSet(`jwtRevoked:${tenantId}:${phone}`, { at: Date.now() }, 12 * 60 * 60 * 1000);
  } catch {}
  return true;
}

// قائمة المستخدمين — سوبر أدمن فقط (مسار معلن)
export async function listClientUsers(tenantId) {
  const T = tenantId ? tenantDb(tenantId) : systemDb("portal:users");
  return T.tenantUser.findMany({
    where: {},
    select: { id: true, tenantId: true, name: true, phone: true, createdAt: true },
    take: 200,
  });
}
