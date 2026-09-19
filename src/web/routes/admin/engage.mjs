// راوتر التفاعل: broadcast + report + csat + crm
import { getTenantFull } from "../../../../tenants.mjs";
import { normalizePhone } from "../../../utils/phone.mjs";
import { pushHistory } from "../../../memory/conversations.mjs";
import {
  saveBroadcast,
  listBroadcasts,
  requestCsat,
  csatStats,
} from "../../../../engage.mjs";
import { logEvent, listEvents, toCSV } from "../../../../crm.mjs";
import { fmtMoney } from "../../../../orders.mjs";
import { resolveScope, denyGlobal } from "./scope.mjs";

export function registerEngageRoutes(app) {
  app.post("/admin/broadcast", async (req, res) => {
    const { tenantId, text, phones } = req.body || {};
    if (!tenantId || !text || !Array.isArray(phones) || !phones.length) {
      return res.status(400).json({ ok: false, error: "tenantId و text و phones[] مطلوبة" });
    }
    if (phones.length > 50) return res.status(400).json({ ok: false, error: "الحد الأقصى 50 رقم لكل بث" });
    const normPhones = [...new Set(phones.map((p) => normalizePhone(p)).filter(Boolean))];
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const { isTenantActive } = await import("../../../../tenants.mjs");
    if (!isTenantActive(tenant)) {
      return res.status(403).json({ ok: false, error: tenant.enabled === false ? "هذا البوت موقوف" : "الفترة التجريبية لهذا البوت انتهت — جدد الخطة" });
    }
    const { isOptedOut } = await import("../../../compliance/messaging.mjs");
    const eligible = [];
    const skippedOptOut = [];
    for (const phone of normPhones) {
      if (await isOptedOut(tenantId, phone)) skippedOptOut.push(phone);
      else eligible.push(phone);
    }
    if (!eligible.length) {
      const rec = await saveBroadcast({ tenantId, text, phones: normPhones, results: normPhones.map((p) => ({ phone: p, ok: false, error: skippedOptOut.includes(p) ? "opted-out" : "no-eligible" })) });
      return res.json({ ok: true, broadcast: rec, skippedOptOut, skippedSimulated: 0, queued: 0 });
    }
    const { outboundQueue } = await import("../../../jobs/queue.mjs");
    const broadcastId = `bc_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const rec = await saveBroadcast({ tenantId, text, phones: normPhones, results: eligible.map((p) => ({ phone: p, ok: false, pending: true })) });
    // حفظ معرف البث الحقيقي للربط — نحدّثه لاحقاً بالنتائج
    const jobLabel = `broadcast:${broadcastId}:${tenantId}`;
    outboundQueue.enqueue(jobLabel, async () => {
      const results = [];
      let skippedSimulated = 0;
      for (const phone of eligible) {
        try {
          const { sendWithWindowFallback } = await import("../../../compliance/messaging.mjs");
          const r = await sendWithWindowFallback(phone, text, tenant);
          if (r.ok) {
            await pushHistory(phone, "assistant", text, tenant);
            results.push({ phone, ok: true });
          } else {
            if (r.reason === "simulated-no-credentials") skippedSimulated++;
            results.push({ phone, ok: false, error: r.reason });
          }
        } catch (e) {
          results.push({ phone, ok: false, error: e.message });
        }
        await new Promise((r) => setTimeout(r, 800));
      }
      try {
        const { tenantDb } = await import("../../../security/tenantGuard.mjs");
        const merged = normPhones.map((p) => {
          const found = results.find((x) => x.phone === p);
          return found || { phone: p, ok: false, error: skippedOptOut.includes(p) ? "opted-out" : "unknown" };
        });
        await tenantDb(tenantId).broadcast.update({ where: { id: rec.id }, data: { results: merged } }).catch(() => {});
      } catch {}
      logEvent("broadcast", { tenantId, count: normPhones.length, sent: results.filter((r) => r.ok).length, broadcastId: rec.id, skippedOptOut: skippedOptOut.length, skippedSimulated }).catch(() => {});
    });
    res.status(202).json({ ok: true, queued: true, broadcastId: rec.id, broadcast: rec, skippedOptOut, eligible: eligible.length });
  });
  app.get("/admin/broadcasts", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    if (scope.global && !req.isSuperAdmin) return denyGlobal(res);
    const all = await listBroadcasts(scope.global ? undefined : scope.tenant);
    res.json({ count: all.length, broadcasts: all });
  });
  app.get("/admin/report", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const tenantId = scope.global ? undefined : scope.tenant;
    const days = Number(req.query.days || 30);
    const since = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    const { tenantDb, systemDb } = await import("../../../security/tenantGuard.mjs");
    const T = tenantId ? tenantDb(tenantId) : systemDb("report:global");
    const where = { createdAt: { gte: since } };
    const [msgs, orders, bookings, ratings, broadcasts] = await Promise.all([
      T.message.count({ where }),
      T.order.findMany({ where, select: { total: true, status: true } }),
      T.appointment.count({ where }),
      T.rating.findMany({ where, select: { score: true } }),
      T.broadcast.count({ where }),
    ]);
    const revenue = orders.filter((o) => o.status === "paid").reduce((s, o) => s + Number(o.total), 0);
    const avgCsat = ratings.length ? Number((ratings.reduce((s, r) => s + r.score, 0) / ratings.length).toFixed(2)) : null;
    const staffHoursSaved = Number(((msgs * 3) / 60).toFixed(1)); // 3 دقائق لكل رد آلي
    res.json({
      ok: true, tenant: tenantId || "all", days,
      messagesHandled: msgs,
      orders: { count: orders.length, paid: orders.filter((o) => o.status === "paid").length, revenue },
      bookings: bookings,
      csat: { avg: avgCsat, count: ratings.length },
      broadcasts,
      staffHoursSaved,
      message: `البوت رد على ${msgs} رسالة (~${staffHoursSaved} ساعة موظفين)، وحقق ${fmtMoney(revenue, "JOD")} مدفوعات، بتقييم ${avgCsat || "—"}/5`,
    });
  });
  app.post("/admin/csat-request", async (req, res) => {
    const { tenantId, phone } = req.body || {};
    if (!tenantId || !phone) return res.status(400).json({ ok: false, error: "tenantId و phone مطلوبان" });
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    const msg = `شكراً لتعاملك معنا يا غالي! 🙏 قيّم تجربتك من 1 (سيئة) إلى 5 (ممتازة) — ابعت الرقم فقط.`;
    await requestCsat(tenantId, phone, null);
    try {
      // عبر البديل الموحد: خارج النافذة يُستخدم القالب، والمحاكاة تُرجع سبباً صريحاً
      const { sendWithWindowFallback } = await import("../../../compliance/messaging.mjs");
      const r = await sendWithWindowFallback(phone, msg, tenant);
      if (!r.ok) return res.status(502).json({ ok: false, error: r.reason });
      await pushHistory(phone, "assistant", msg, tenant);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.get("/admin/csat", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    res.json({ ok: true, ...(await csatStats(scope.global ? undefined : scope.tenant)) });
  });
  app.get("/admin/crm", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { type, limit } = req.query;
    const events = await listEvents({ tenantId: scope.global ? undefined : scope.tenant, type, limit: Number(limit || 100) });
    res.json({ count: events.length, events });
  });
  app.get("/admin/crm/export.csv", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const { type } = req.query;
    const events = await listEvents({ tenantId: scope.global ? undefined : scope.tenant, type, limit: 2000 });
    res.setHeader("Content-Type", "text/csv; charset=utf-8");
    res.setHeader("Content-Disposition", "attachment; filename=crm.csv");
    res.send("\uFEFF" + toCSV(events));
  });
}
