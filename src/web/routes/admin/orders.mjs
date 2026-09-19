// راوتر الطلبات: orders + summary + confirm + proof-media + reject + cart-remind-run
import { getTenantFull, isTenantActive } from "../../../../tenants.mjs";
import { listOrders, markCartReminded, fmtMoney } from "../../../../orders.mjs";
import { pushHistory } from "../../../memory/conversations.mjs";
import { sendWithWindowFallback } from "../../../compliance/messaging.mjs";
import { logEvent } from "../../../../crm.mjs";
import { resolveScope, denyGlobal } from "./scope.mjs";

export function registerOrderRoutes(app) {
  app.get("/admin/orders", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(Math.max(1, Number(req.query.limit || 50)), 100);
    const { listOrdersAll } = await import("../../../../orders.mjs");
    const _or = scope.global ? await listOrdersAll() : await listOrders(scope.tenant);
    const total = _or.length;
    const slice = _or.slice((page - 1) * limit, page * limit);
    res.json({ count: total, page, limit, orders: slice });
  });
  // ملخص عددي خفيف للطلبات (للكواجهات KPI — تجميع واحد بدل سحب 500 صف)
  app.get("/admin/orders/summary", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { tenantDb, systemDb } = await import("../../../security/tenantGuard.mjs");
    const T = scope.global ? systemDb("orders:summary") : tenantDb(scope.tenant);
    const groups = await T.order.groupBy({ by: ["status"], _count: { _all: true } });
    const byStatus = {};
    let total = 0;
    for (const g of groups) {
      byStatus[g.status] = g._count._all;
      total += g._count._all;
    }
    res.json({ ok: true, tenant: scope.global ? "all" : scope.tenant, total, byStatus });
  });
  // تأكيد دفع يدوي (موظف تحقق من المحفظة) + إشعار الزبون — عبر المسار الذري الموحد
  app.post("/admin/orders/:id/confirm", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const { getTenantFull, isTenantActive } = await import("../../../../tenants.mjs");
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    // kill-switch: لا تأكيد مدفوعات لبوت موقوف/منتهي (اتساق مع المجدول والبث)
    if (!isTenantActive(tenant)) {
      return res.status(403).json({ ok: false, error: tenant.enabled === false ? "هذا البوت موقوف" : "الفترة التجريبية لهذا البوت انتهت — جدد الخطة" });
    }
    const { getOrder } = await import("../../../../orders.mjs");
    const order = await getOrder(req.params.id, tenantId).catch(() => null);
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    const { finalizePaidOrder } = await import("../billing.mjs");
    let already = false;
    try {
      ({ already } = await finalizePaidOrder(order.id, "manual", { csat: false }));
    } catch (e) {
      return res.status(400).json({ ok: false, error: e.message });
    }
    if (already) return res.json({ ok: true, orderId: order.id, already: true });
    const { pushHistory } = await import("../../../memory/conversations.mjs");
    const { sendWithWindowFallback } = await import("../../../compliance/messaging.mjs");
    const msg = `تم استلام الدفع يا غالي ✅ طلبك ${order.id} (${fmtMoney(order.total, order.currency)}) تأكد وبتجهز هلا للتوصيل. شكراً لثقتك!`;
    // الدفع مثبّت — الإشعار أفضل-جهد عبر البديل (قالب خارج النافذة) ولا يفشل التأكيد
    let notified = true;
    let notifyReason = null;
    try {
      const r = await sendWithWindowFallback(order.phone, msg, tenant);
      notified = r.ok;
      notifyReason = r.ok ? null : r.reason;
      if (r.ok) await pushHistory(order.phone, "assistant", msg, tenant);
    } catch (e) {
      notified = false;
      notifyReason = e.message;
    }
    res.json({ ok: true, orderId: order.id, notified, notifyReason });
  });
  // عرض صورة الإيصال داخل الأدمن (تحميل مؤقت من واتساب عبر Graph API — لا تُخزَّن)
  app.get("/admin/orders/:id/proof-media", async (req, res) => {
    const tenantId = req.clientTenant || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    try {
      const { getOrder } = await import("../../../../orders.mjs");
      const { downloadWhatsAppMedia } = await import("../../../../voice.mjs");
      const order = await getOrder(req.params.id, tenantId).catch(() => null);
      if (!order?.proof?.mediaId) return res.status(404).json({ ok: false, error: "لا إيصال مرفق بهذا الطلب" });
      const { getTenantFull } = await import("../../../../tenants.mjs");
      const tenant = await getTenantFull(tenantId);
      const token = tenant?.whatsapp_token || process.env.WHATSAPP_TOKEN;
      const { buffer, mimeType } = await downloadWhatsAppMedia(order.proof.mediaId, token);
      res.setHeader("Content-Type", mimeType || "image/jpeg");
      res.setHeader("Content-Disposition", `inline; filename="receipt-${order.id}.jpg"`);
      res.send(buffer);
    } catch (e) {
      res.status(404).json({ ok: false, error: e.message });
    }
  });
  // رفض الإيصال بسبب إلزامي: يُسجَّل ويُخطر العميل — يغلق حلقة المراجعة بدل حالة معلقة للأبد
  app.post("/admin/orders/:id/reject", async (req, res) => {
    const tenantId = req.clientTenant || req.body?.tenantId || req.query.tenant;
    if (!tenantId) return res.status(400).json({ ok: false, error: "tenantId مطلوب" });
    const reason = String(req.body?.reason || "").trim();
    if (!reason) return res.status(400).json({ ok: false, error: "سبب الرفض مطلوب" });
    const { getOrder, rejectOrder } = await import("../../../../orders.mjs");
    const order = await getOrder(req.params.id, tenantId).catch(() => null);
    if (!order) return res.status(404).json({ ok: false, error: "الطلب غير موجود" });
    await rejectOrder(order.id, tenantId, { reason });
    const { getTenantFull } = await import("../../../../tenants.mjs");
    const tenant = await getTenantFull(tenantId);
    const { pushHistory } = await import("../../../memory/conversations.mjs");
    logEvent("proof_rejected", { tenantId, phone: order.phone, orderId: order.id, reason }).catch(() => {});
    const msg = `عذراً يا غالي 🙏 في مشكلة باعتماد إيصال طلبك ${order.id}: ${reason}.\nأرسل اللقطة من جديد هون 📸 لإعادة المحاولة، أو ابعت "أريد موظف" ونساعدك مباشرة.`;
    if (tenant) {
      await sendWithWindowFallback(order.phone, msg, tenant).catch(() => {});
      await pushHistory(order.phone, "assistant", msg, tenant);
    }
    res.json({ ok: true, orderId: order.id });
  });
  app.post("/admin/cart-remind-run", async (req, res) => {
    const afterMinutes = Number(req.body?.afterMinutes ?? 60);
    const scopeTenant = req.clientTenant || req.body?.tenantId || null;
    const { dueCartRemindersAll, dueCartReminders } = await import("../../../../orders.mjs");
    const { getTenantFull } = await import("../../../../tenants.mjs");
    const due = scopeTenant
      ? await dueCartReminders(scopeTenant, { afterMinutes })
      : await dueCartRemindersAll({ afterMinutes });
    // تجميع: رسالة واحدة لكل رقم بدل رسالة لكل طلب
    const byPhone = new Map();
    for (const o of due) {
      const key = `${o.tenantId}::${o.phone}`;
      if (!byPhone.has(key)) byPhone.set(key, []);
      byPhone.get(key).push(o);
    }
    const sent = [];
    for (const [, list] of byPhone) {
      const first = list[0];
      const tenant = await getTenantFull(first.tenantId);
      if (!tenant || !isTenantActive(tenant)) continue; // kill-switch: لا سلة مهجورة لموقوف/منتهي
      // ادّعاء ذري لكل الطلبات قبل الإرسال — لا تكرار مع المؤقت
      const claimed = [];
      for (const o of list) {
        if (await markCartReminded(o.id, o.tenantId)) claimed.push(o);
      }
      if (!claimed.length) continue;
      const lines = claimed.map((o) => `• ${o.id} (${fmtMoney(o.total, o.currency)})`).join("\n");
      const msg = claimed.length === 1
        ? `يا هلا يا غالي! 👋 شفنا طلبك ${claimed[0].id} (${fmtMoney(claimed[0].total, claimed[0].currency)}) لسه ما اكتمل. تحب نكمله؟ ابعت لقطة الشاشة هون 📸`
        : `يا هلا يا غالي! 👋 عندك ${claimed.length} طلبات لسه ما اكتملت:\n${lines}\nابعت رقم الطلب لنكمله مع بعض.`;
      try {
        const r = await sendWithWindowFallback(first.phone, msg, tenant);
        if (!r.ok) {
          console.log(`  ⏭️ سلة مهجورة -> ${first.phone}: ${r.reason}`);
        } else {
          await pushHistory(first.phone, "assistant", msg, tenant);
        }
        logEvent("cart_reminded", { tenantId: first.tenantId, phone: first.phone, orderIds: claimed.map((o) => o.id), skipped: r.ok ? undefined : r.reason }).catch(() => {});
        sent.push(...claimed.map((o) => o.id));
      } catch (e) {
        const { unmarkCartReminded } = await import("../../../../orders.mjs");
        for (const o of claimed) await unmarkCartReminded(o.id, o.tenantId);
        console.error(`  ❌ فشل تذكير السلة لـ ${first.phone}: ${e.message}`);
      }
    }
    res.json({ ok: true, due: due.length, sent });
  });
}
