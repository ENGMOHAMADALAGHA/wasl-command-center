// راوتر المحادثات الحية: inbox + takeover + send + صفحة inbox
import { getTenantFull } from "../../../../tenants.mjs";
import { normalizePhone } from "../../../utils/phone.mjs";
import { pushHistory } from "../../../memory/conversations.mjs";
import { setTakeover, isTakeover, listInbox, getConversation } from "../../../inbox/service.mjs";
import { sendWithWindowFallback } from "../../../compliance/messaging.mjs";
import { logEvent } from "../../../../crm.mjs";
import { resolveScope, denyGlobal } from "./scope.mjs";

export function registerInboxRoutes(app) {
  app.get("/admin/inbox", async (req, res) => {
    const scope = resolveScope(req, req.query.tenant);
    if (scope.denied) return denyGlobal(res);
    const page = Math.max(1, Number(req.query.page || 1));
    const limit = Math.min(Math.max(1, Number(req.query.limit || 50)), 100);
    const inbox = await listInbox(scope.global ? undefined : scope.tenant);
    const total = inbox.length;
    const slice = inbox.slice((page - 1) * limit, page * limit);
    res.json({ count: total, page, limit, inbox: slice });
  });
  app.get("/admin/inbox/:tenantId/:phone", async (req, res) => {
    if (req.clientTenant && req.params.tenantId !== req.clientTenant) {
      return res.status(403).json({ ok: false, error: "غير مصرح — هذه المحادثة ليست لك" });
    }
    const tenantId = req.clientTenant || req.params.tenantId;
    const phone = normalizePhone(req.params.phone);
    res.json({
      tenantId, phone,
      takeover: await isTakeover(tenantId, phone),
      messages: await getConversation(tenantId, phone),
    });
  });
  app.post("/admin/takeover", async (req, res) => {
    let { tenantId, phone, enabled, by } = req.body || {};
    if (!tenantId || !phone) return res.status(400).json({ ok: false, error: "tenantId و phone مطلوبان" });
    phone = normalizePhone(phone);
    await setTakeover(tenantId, phone, !!enabled, by);
    logEvent(!!enabled ? "takeover" : "handover", { tenantId, phone, by }).catch(() => {});
    res.json({ ok: true, takeover: await isTakeover(tenantId, phone) });
  });
  app.post("/admin/send", async (req, res) => {
    const { tenantId, text } = req.body || {};
    let { phone } = req.body || {};
    if (!tenantId || !phone || !text) return res.status(400).json({ ok: false, error: "tenantId و phone و text مطلوبة" });
    phone = normalizePhone(phone);
    const tenant = await getTenantFull(tenantId);
    if (!tenant) return res.status(404).json({ ok: false, error: "tenant غير موجود" });
    try {
      const r = await sendWithWindowFallback(phone, text, tenant);
      if (!r.ok) {
        return res.json({ ok: false, skipped: r.reason, phone });
      }
      await pushHistory(phone, "assistant", text, tenant);
      res.json({ ok: true, result: r });
    } catch (e) {
      res.status(500).json({ ok: false, error: e.message });
    }
  });
  app.get("/admin/inbox.html", (req, res) => {
    res.send(`<!doctype html><html dir="rtl" lang="ar"><head><meta charset="utf-8"><title>Inbox</title>
<style>body{font-family:system-ui;margin:20px}table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:8px}.u{color:#0a7}.a{color:#06c}</style></head><body>
<h2>📥 Inbox — المحادثات الحية</h2>
<p>API: <code>/admin/inbox?tenant=ID</code> | محادثة: <code>/admin/inbox/:tenant/:phone</code></p>
<table id="t"><tr><th>البوت</th><th>الرقم</th><th>takeover</th><th>آخر رسالة</th><th>إجراء</th></tr></table>
<script>
async function load(){ const q=new URLSearchParams(location.search); const r=await fetch('/admin/inbox?tenant='+(q.get('tenant')||'')); const j=await r.json();
const t=document.getElementById('t');
j.inbox.forEach(c=>{ const tr=document.createElement('tr');
const td1=document.createElement('td'); td1.textContent=c.tenantId||''; tr.appendChild(td1);
const td2=document.createElement('td'); td2.textContent=c.phone||''; tr.appendChild(td2);
const td3=document.createElement('td'); td3.textContent=(c.takeover?'⏸️':'✅'); tr.appendChild(td3);
const td4=document.createElement('td'); td4.textContent=(c.lastMessage?c.lastMessage.text:''); tr.appendChild(td4);
const b=document.createElement('button'); b.textContent=c.takeover?'تشغيل البوت':'إيقاف للموظف';
b.onclick=async()=>{ await fetch('/admin/takeover',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({tenantId:c.tenantId,phone:c.phone,enabled:!c.takeover})}); load(); };
const td=document.createElement('td'); td.appendChild(b); tr.appendChild(td); t.appendChild(tr); }); }
load();
</script></body></html>`);
  });
}
