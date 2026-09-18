// راوتر البوتات والمستخدمين: tenants + preview + test-link + invites + users
import { getTenantFull, listTenants, addTenant } from "../../../../tenants.mjs";
import { getMemoryStats } from "../../../memory/conversations.mjs";
import { sendWithWindowFallback } from "../../../compliance/messaging.mjs";
import { logEvent } from "../../../../crm.mjs";
import { resolveScope, denyGlobal } from "./scope.mjs";

export function registerTenantRoutes(app) {
  app.get("/admin/queue", async (req, res) => {
    const { webhookQueue } = await import("../../../jobs/queue.mjs");
    res.json({ ok: true, ...webhookQueue.stats() });
  });
  app.get("/admin/tenants", async (req, res) => {
    const list = await listTenants();
    res.json({ count: list.length, tenants: list, memory: getMemoryStats() });
  });
  app.post("/admin/tenants", async (req, res) => {
    try {
      const created = await addTenant(req.body || {});
      console.log(`  ➕ tenant جديد: ${created.id} (${created.name}) plan=${created.plan}`);
      const { whatsappToken: _s, ...safe } = created;
      res.status(201).json({ ok: true, tenant: { ...safe, hasOwnToken: !!created.whatsappToken } });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.patch("/admin/tenants/:id", async (req, res) => {
    // عزل العملاء: JWT العميل مقيد ببوته فقط — أي id آخر مرفوض
    if (req.clientTenant && req.params.id !== req.clientTenant) {
      return res.status(403).json({ ok: false, error: "غير مصرح — هذا البوت ليس لك" });
    }
    try {
      const { updateTenant, isTrialExpired } = await import("../../../../tenants.mjs");
      const updated = await updateTenant(req.params.id, req.body || {});
      console.log(`  🔌 tenant ${updated.id} enabled=${updated.enabled} plan=${updated.plan}`);
      res.json({ ok: true, tenant: { id: updated.id, enabled: updated.enabled, plan: updated.plan, trialExpired: isTrialExpired(updated) } });
    } catch (e) {
      // P2025 = البوت غير موجود بهذه القاعدة (قائمة قديمة؟ سيرفر مختلف؟) — 404 واضحة بدل 400 عمياء
      if (e?.code === "P2025") {
        return res.status(404).json({ ok: false, error: `البوت "${req.params.id}" غير موجود — حدّث قائمة البوتات وحاول مجدداً` });
      }
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  // معاينة منظور العميل (سوبر فقط): رابط بوابة مؤقت 10 دقائق لنفس البوت
  // للعروض التقديمية — العميل يرى بوابته بالضبط، بنفس العزل الكامل
  app.get("/admin/preview/:tenantId", async (req, res) => {
    if (!req.isSuperAdmin) {
      return res.status(403).json({ ok: false, error: "المعاينة للسوبر أدمن فقط" });
    }
    const t = await getTenantFull(req.params.tenantId);
    if (!t) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const { signPreviewToken } = await import("../../../../portal.mjs");
    const { PUBLIC_BASE_URL } = await import("../../../config/env.mjs");
    const base = (PUBLIC_BASE_URL || "").replace(/\/$/, "");
    const url = `/portal/?tenant=${encodeURIComponent(t.id)}&preview=${encodeURIComponent(signPreviewToken(t.id))}`;
    logEvent("preview", { tenantId: t.id }).catch(() => {});
    res.json({ ok: true, tenantId: t.id, url, absoluteUrl: base ? base + url : url, expiresIn: "10m" });
  });
  // حذف بوت (سوبر فقط عبر SUPER_ONLY) — الحذف متتالٍ لكل بياناته
  app.delete("/admin/tenants/:id", async (req, res) => {
    try {
      const { deleteTenant } = await import("../../../../tenants.mjs");
      const out = await deleteTenant(req.params.id);
      console.log(`  🗑️ حذف tenant: ${out.id}`);
      res.json({ ok: true, deleted: out.id });
    } catch (e) {
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  // فحص الربط الحي: هل Phone ID + Token شغالان فعلاً على Meta؟ (وضع Coexistence)
  app.post("/admin/tenants/:id/test-link", async (req, res) => {
    if (req.clientTenant && req.params.id !== req.clientTenant) {
      return res.status(403).json({ ok: false, error: "غير مصرح — هذا البوت ليس لك" });
    }
    const t = await getTenantFull(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const token = t.whatsapp_token;
    const phoneId = t.phone_number_id;
    if (!token || !phoneId) {
      return res.json({ ok: false, linked: false, reason: "لا توجد بيانات ربط — أدخل Phone ID و Token أولاً" });
    }
    try {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 15000);
      let r, data;
      try {
        r = await fetch(`https://graph.facebook.com/v18.0/${phoneId}?fields=id,display_phone_number,verified_name,quality_rating`, {
          headers: { Authorization: `Bearer ${token}` },
          signal: ctrl.signal,
        });
        data = await r.json().catch(() => ({}));
      } finally {
        clearTimeout(timer);
      }
      if (!r.ok) {
        return res.json({ ok: false, linked: false, reason: data?.error?.message || ("Meta HTTP " + r.status) });
      }
      logEvent("link_test", { tenantId: t.id, ok: true }).catch(() => {});
      res.json({ ok: true, linked: true, number: data.display_phone_number || null, name: data.verified_name || null, quality: data.quality_rating || null });
    } catch (e) {
      res.json({ ok: false, linked: false, reason: e.message });
    }
  });
  // ── تتبع تشخيصي لخطوات الربط (breadcrumbs بلا أسرار — لتشخيص انقطاع النافذة) ──
  app.post("/admin/onboard/debug", async (req, res) => {
    if (!req.isSuperAdmin) return res.status(403).json({ ok: false });
    try {
      const { storeGet, storeSet } = await import("../../../../store.mjs");
      const { tenantId, stage, info } = req.body || {};
      if (!tenantId || !stage) return res.status(400).json({ ok: false });
      const key = `onboard_dbg:${tenantId}`;
      const list = (await storeGet(key).catch(() => null)) || [];
      list.push({ at: Date.now(), stage: String(stage).slice(0, 40), info: String(info || "").slice(0, 200) });
      await storeSet(key, list.slice(-20), 24 * 60 * 60 * 1000).catch(() => {});
      res.json({ ok: true });
    } catch { res.json({ ok: false }); }
  });
  app.get("/admin/onboard/debug", async (req, res) => {
    if (!req.isSuperAdmin) return res.status(403).json({ ok: false });
    try {
      const { storeGet } = await import("../../../../store.mjs");
      const tenantId = req.query.tenant;
      if (!tenantId) return res.status(400).json({ ok: false });
      res.json({ ok: true, crumbs: (await storeGet(`onboard_dbg:${tenantId}`).catch(() => null)) || [] });
    } catch { res.json({ ok: false }); }
  });
  // ── Embedded Signup: إعداد علني + تبادل الكود (onboarding ذاتي بدقيقتين) ──
  // الزر بلوحة الإدارة يفتح نافذة Meta، والعميل يربط رقمه بنفسه: دخول → محفظة →
  // WABA → رقم → صلاحيات. الكود صلاحيته ~60 ثانية ويُبادل server-side فقط.
  // المتطلب المسبق بلوحة Meta (مرة واحدة): منتج Facebook Login for Business +
  // Configuration ID بالصلاحيات + Allowed Domains (وإلا enabled=false بزر معطل مبرر).
  app.get("/admin/onboard/config", async (req, res) => {
    // مسموح للسوبر + العميل (JWT مقفل على بوته): المعرفات علنية بالتصميم (تُضمن بزر الربط)
    if (!req.isSuperAdmin && !req.clientTenant) return res.status(403).json({ ok: false, error: "غير مصرح" });
    const { META_APP_ID, META_EMBEDDED_CONFIG_ID, META_EMBEDDED_CONFIG_ID_COEX } = await import("../../../config/env.mjs");
    res.json({ ok: true, enabled: !!(META_APP_ID && META_EMBEDDED_CONFIG_ID), appId: META_APP_ID || null, configId: META_EMBEDDED_CONFIG_ID || null, coexConfigId: META_EMBEDDED_CONFIG_ID_COEX || null, coexEnabled: !!(META_APP_ID && META_EMBEDDED_CONFIG_ID_COEX) });
  });
  // منطق التبادل المشترك: السوبر يمرر أي tenantId، والعميل يُقفل على بوته فقط
  async function runOnboardExchange({ tenantId, code, waba_id, phone_number_id, mode }) {
    const onboardingMode = mode === "coexistence" ? "coexistence" : "full";
    if (!tenantId || !code || !phone_number_id) {
      return { http: 400, json: { ok: false, error: "tenantId و code و phone_number_id مطلوبة" } };
    }
    try {
      const { META_APP_ID, META_APP_SECRET } = await import("../../../config/env.mjs");
      if (!META_APP_ID || !META_APP_SECRET) throw new Error("META_APP_ID/META_APP_SECRET غير مضبوطة بالبيئة");
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), 20000);
      try {
        // 1) تبادل الكود بتوكن تكامل دائم (server-side فقط — الكود لا يُخزن)
        const u = `https://graph.facebook.com/v21.0/oauth/access_token?client_id=${encodeURIComponent(META_APP_ID)}&client_secret=${encodeURIComponent(META_APP_SECRET)}&code=${encodeURIComponent(code)}`;
        const r = await fetch(u, { signal: ctrl.signal });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || !j.access_token) throw new Error(j?.error?.message || ("تعذر تبادل الكود (HTTP " + r.status + ")"));
        const token = j.access_token;
        // 2) اشتراك تطبيقنا بأحداث هذه الـ WABA (وصول الرسائل للـ webhook)
        if (waba_id) {
          await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(waba_id)}/subscribed_apps`, {
            method: "POST", headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal,
          }).catch(() => {});
        }
        // 3) بيانات الرقم للعرض والتأكيد فقط
        let number = null, vname = null;
        try {
          const m = await fetch(`https://graph.facebook.com/v21.0/${encodeURIComponent(phone_number_id)}?fields=id,display_phone_number,verified_name`, {
            headers: { Authorization: `Bearer ${token}` }, signal: ctrl.signal,
          });
          const mj = await m.json().catch(() => ({}));
          if (m.ok) { number = mj.display_phone_number || null; vname = mj.verified_name || null; }
        } catch { /* عرض فقط */ }
        // 4) ربط البوت: هوية الرقم + التوكن المشفر (تفرد إجباري يمنع الخلط)
        // + بصمة وضع الربط: التعايش يحتاجها لاحقاً (كشف الصدى/السجل القديم)
        const { updateTenant, getTenantFull: getFull } = await import("../../../../tenants.mjs");
        const prev = await getFull(tenantId).catch(() => null);
        if (!prev) return { http: 404, json: { ok: false, error: "البوت غير موجود" } };
        const prevFeatures = (prev && typeof prev.features === "object" && prev.features) || {};
        await updateTenant(tenantId, {
          phoneNumberId: String(phone_number_id),
          whatsappToken: token,
          features: { ...prevFeatures, onboardingMode, linkedAt: Date.now() },
        });
        logEvent("onboard_exchange", { tenantId, waba: waba_id || null, number, mode: onboardingMode }).catch(() => {});
        // التوكن لا يغادر الخادم أبداً — الرد هوية وتأكيد فقط
        return { http: 200, json: { ok: true, linked: true, number, name: vname, mode: onboardingMode } };
      } finally {
        clearTimeout(timer);
      }
    } catch (e) {
      logEvent("onboard_failed", { tenantId, error: String(e?.message || e).slice(0, 200) }).catch(() => {});
      return { http: 400, json: { ok: false, error: e.message } };
    }
  }
  app.post("/admin/onboard/exchange", async (req, res) => {
    if (!req.isSuperAdmin) return res.status(403).json({ ok: false, error: "للسوبر أدمن فقط" });
    const out = await runOnboardExchange(req.body || {});
    res.status(out.http).json(out.json);
  });
  // ربط العميل برقمه من بوابته: مقفل على بوته فقط (JWT)، مع حد معدل ضد إساءة تبادل الأكواد
  app.post("/admin/onboard/client-exchange", async (req, res) => {
    const tenantId = req.clientTenant;
    if (!tenantId) return res.status(403).json({ ok: false, error: "دخول العميل فقط — سجل دخولك ببوابتك" });
    // توكن المعاينة (عروض السوبر) للفرجة فقط — ممنوع يربط أرقاماً حقيقية
    try {
      const { verifyClientToken } = await import("../../../../portal.mjs");
      const p = verifyClientToken((req.headers.authorization || "").split(" ")[1] || "");
      if (!p || p.preview) return res.status(403).json({ ok: false, error: "وضع المعاينة للعرض فقط" });
    } catch { return res.status(403).json({ ok: false }); }
    try {
      const { checkLimit } = await import("../../../security/rateLimit.mjs");
      const rl = checkLimit(`onboard:${tenantId}`, 5, 60 * 1000);
      if (!rl.allowed) return res.status(429).json({ ok: false, error: `محاولات كثيرة — حاول بعد ${rl.retryAfter} ثانية` });
    } catch { /* بلا حد = أكمل */ }
    const { isTenantActive } = await import("../../../../tenants.mjs");
    const { getTenantFull } = await import("../../../../tenants.mjs");
    const t = await getTenantFull(tenantId).catch(() => null);
    if (!t || !isTenantActive(t)) return res.status(403).json({ ok: false, error: "هذا البوت موقوف أو منتهي التجربة" });
    const out = await runOnboardExchange({ ...(req.body || {}), tenantId });
    res.status(out.http).json(out.json);
  });
  // دعوة عميل: إنشاء حساب بوابة + كلمة مؤقتة + رابط دخول + إرسال واتساب اختياري
  app.post("/admin/invites", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId;
    const { phone, name, send } = req.body || {};
    if (!tenantId || !phone) return res.status(400).json({ ok: false, error: "tenantId و phone مطلوبان" });
    const { isTenantActive } = await import("../../../../tenants.mjs");
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    if (!isTenantActive(tenant)) {
      return res.status(403).json({ ok: false, error: "هذا البوت موقوف أو منتهي التجربة" });
    }
    const cryptoMod = await import("node:crypto");
    const tempPassword = cryptoMod.randomBytes(4).toString("hex"); // 8 خانات
    const { createClientUser } = await import("../../../../portal.mjs");
    const { PUBLIC_BASE_URL } = await import("../../../config/env.mjs");
    let u;
    try {
      u = await createClientUser({ tenantId, phone: String(phone).trim(), name: (name || "").trim() || String(phone).trim(), password: tempPassword, allowReset: true });
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    const portalUrl = `${(PUBLIC_BASE_URL || "").replace(/\/$/, "")}/portal/?tenant=${encodeURIComponent(tenantId)}`;
    logEvent("invite_created", { tenantId, phone: u.phone }).catch(() => {});
    let sent = false;
    let sendError = null;
    if (send) {
      const msg =
        `أهلاً ${u.name} 👋 تم ربط رقمك مع ${tenant.name} على منصة وصل.\n` +
        `🔗 رابط الدخول: ${portalUrl}\n` +
        `🤖 البوت: ${tenantId}\n📱 الجوال: ${u.phone}\n🔑 كلمة مؤقتة: ${tempPassword}\n` +
        `ادخل وغيّر الكلمة من (نسيت كلمة السر) بعد أول دخول.`;
      try {
        await sendWithWindowFallback(String(phone).trim(), msg, tenant);
        sent = true;
        logEvent("invite_sent", { tenantId, phone: u.phone }).catch(() => {});
      } catch (e) {
        sendError = e.message;
      }
    }
    res.status(201).json({ ok: true, invite: { tenantId, phone: u.phone, name: u.name, tempPassword, portalUrl, sent, sendError } });
  });
  app.post("/admin/users", async (req, res) => {
    try {
      const { createClientUser } = await import("../../../../portal.mjs");
      const u = await createClientUser(req.body || {});
      res.status(201).json({ ok: true, user: { id: u.id, tenantId: u.tenantId, phone: u.phone, name: u.name } });
    } catch (e) {
      if (e?.code === "USER_EXISTS") return res.status(409).json({ ok: false, error: e.message });
      res.status(400).json({ ok: false, error: e.message });
    }
  });
  app.get("/admin/users", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    // User list is SUPER_ONLY per middleware, but double-guard global reads here.
    if (scope.global && !req.isSuperAdmin) return denyGlobal(res);
    const { listClientUsers } = await import("../../../../portal.mjs");
    const rows = await listClientUsers(scope.global ? undefined : scope.tenant);
    res.json({ count: rows.length, users: rows });
  });
  app.get("/admin/tenants/:id", async (req, res) => {
    if (req.clientTenant && req.params.id !== req.clientTenant) {
      return res.status(403).json({ ok: false, error: "غير مصرح — هذا البوت ليس لك" });
    }
    const t = await getTenantFull(req.params.id);
    if (!t) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    // إخفاء التوكن (المشفر والمفكوك معاً — لا يغادر الخادم أبداً)
    const { whatsapp_token, whatsappToken: _enc, ...safe } = t;
    res.json({ ok: true, tenant: { ...safe, hasToken: !!whatsapp_token, hasOwnToken: !!_enc } });
  });
}
