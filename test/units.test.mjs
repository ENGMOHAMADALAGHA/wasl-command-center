// اختبارات وحدات حرجة — node:test + assert أصيل (بلا مكتبات خارجية)
// التشغيل: node --test test/  (أو npm test)
import assert from "node:assert/strict";
import { test } from "node:test";

// مفتاح تشفير تجريبي قبل تحميل secrets/env (dotenv لا يتجاوز ما هو مضبوط)
process.env.TOKEN_ENC_KEY = "unit-test-key-123";

const { ammanDateStr } = await import("../src/utils/time.mjs");
const { detectTotal, detectItem } = await import("../orders.mjs");
const { encryptSecret, decryptSecret } = await import("../src/security/secrets.mjs");
const { createQueue } = await import("../src/jobs/queue.mjs");
const { csrfGuard } = await import("../src/web/middleware.mjs");

const KAREEM = {
  deliveryFee: 5,
  products: [
    { name: "حذاء ركض", price: 50 },
    { name: "حذاء شتوي", price: 40 },
    { name: "حزام ظهر", price: 20 },
  ],
  bundleOffer: { enabled: true, price: 70 },
};

function ammanRef(offsetDays = 0) {
  const d = new Date(Date.now() + offsetDays * 86400000);
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Amman", year: "numeric", month: "2-digit", day: "2-digit",
  }).format(d);
}

// ── توقيت عمّان ──
test("ammanDateStr: اليوم والغد في منطقة عمّان", () => {
  assert.equal(ammanDateStr(0), ammanRef(0));
  assert.equal(ammanDateStr(1), ammanRef(1));
  assert.equal(ammanDateStr(-1), ammanRef(-1));
});

// ── detectItem: تطابق الاسم الكامل أولاً ──
test("detectItem: يفضّل التطابق الكامل على الكلمة الأولى المشتركة", () => {
  assert.equal(detectItem(KAREEM, "أريد حذاء ركض", ""), "حذاء ركض");
  assert.equal(detectItem(KAREEM, "حزام ظهر", ""), "حزام ظهر");
});
test("detectItem: سلعتان متنازعتان على كلمة أولى → يُدمج الكاملتان", () => {
  const r = detectItem(KAREEM, "بين حذاء ركض و حذاء شتوي", "");
  assert.ok(r.includes("حذاء ركض") && r.includes("حذاء شتوي"));
});
test("detectItem: بلا ذكر سلعة → جميع المنتجات", () => {
  const r = detectItem(KAREEM, "مرحبا", "");
  assert.ok(r.includes("حذاء ركض") && r.includes("حزام ظهر"));
});

// ── detectTotal: مرتكز الكتالوج ──
test("detectTotal: إجمالي صريح مطابق للسلعة المختارة", () => {
  assert.equal(detectTotal(KAREEM, "منتجاتك", "حذاء ركض الإجمالي 55 د.أ"), 55);
});
test("detectTotal: مبلغ أجنبي من عرض جنبي يُصحَّح لسلعة المختارة", () => {
  assert.equal(detectTotal(KAREEM, "أريد حزام ظهر", "الإجمالي 100 د.أ"), 25);
});
test("detectTotal: bundle صريح مع التفعيل", () => {
  assert.equal(detectTotal(KAREEM, "الحذاء والحزام", "الإجمالي 70 د.أ"), 70);
});
test("detectTotal: أرقام النص اللصيقة بالكتالوج", () => {
  assert.equal(detectTotal(KAREEM, "بكم الحزام؟ 20 د.أ", ""), 25);
  assert.equal(detectTotal(KAREEM, "بكم الحذاء؟ 50", ""), 55);
});
test("detectTotal: بلا أرقام → القيمة الأقصى المعروفة", () => {
  assert.equal(detectTotal(KAREEM, "مرحبا", ""), 55);
});

// ── تشفير الأسرار ──
test("encrypt/decrypt: جولة ذهاب وإياب بصيغة enc:v1", () => {
  const enc = encryptSecret("TOKEN-XYZ");
  assert.ok(enc.startsWith("enc:v1:"));
  assert.notEqual(enc, "TOKEN-XYZ");
  assert.equal(decryptSecret(enc), "TOKEN-XYZ");
});
test("encrypt: القيم الفارغة تُرجع null", () => {
  assert.equal(encryptSecret(null), null);
  assert.equal(encryptSecret(""), null);
});
test("decrypt: سجلات قديمة plaintext تُقرأ شفافاً (ممر هجرة)", () => {
  assert.equal(decryptSecret("old-plain-token"), "old-plain-token");
});

// ── الطابور: FIFO/إعادة محاولة/مهلة ──
test("queue: enqueueOrdered يحافظ على الترتيب لكل مفتاح", async () => {
  const q = createQueue({ concurrency: 1 });
  const order = [];
  await Promise.all([
    q.enqueueOrdered("a", "t1", async () => { order.push(1); }),
    q.enqueueOrdered("a", "t2", async () => { order.push(2); }),
    q.enqueueOrdered("a", "t3", async () => { order.push(3); }),
  ]);
  assert.deepEqual(order, [1, 2, 3]);
});
test("queue: إعادة محاولة حتى النجاح", async () => {
  const q = createQueue({ retries: 1 });
  let n = 0;
  const ok = await q.run("retry", async () => {
    n++;
    if (n < 2) throw new Error("عابر");
    return "تم";
  });
  assert.equal(ok, "تم");
  assert.ok(n >= 2);
});
test("queue: تجاوز المهلة يرفض ولن يعلّق العامل", async () => {
  const q = createQueue({ timeoutMs: 40, retries: 0 });
  const v = q.run("hang", () => new Promise(() => {}));
  await assert.rejects(v, /المهلة/);
  // بعجلة المعالجة ما زالت حية تجيب وظيفة لاحقة
  const after = await q.run("after", async () => "حيا");
  assert.equal(after, "حيا");
});

// ── CSRF guard ──
function fake() {
  const res = {
    code: null,
    status(c) { this.code = c; return { json: () => {} }; },
  };
  return res;
}
test("csrfGuard: cross-site مرفوض", () => {
  const res = fake();
  csrfGuard(
    { method: "POST", path: "/x", headers: { "sec-fetch-site": "cross-site", host: "k.com" } },
    res,
    () => assert.fail("لا يجب أن يمر")
  );
  assert.equal(res.code, 403);
});
test("csrfGuard: Origin متطابق يمر، Meta بلا Origin يمر", () => {
  let called = 0;
  csrfGuard({ method: "POST", path: "/x", headers: { origin: "https://k.com", host: "k.com" } }, fake(), () => called++);
  csrfGuard({ method: "POST", path: "/webhook", headers: {} }, fake(), () => called++);
  assert.equal(called, 2);
});
test("csrfGuard: Origin مخالف يرفض", () => {
  const res = fake();
  csrfGuard(
    { method: "PATCH", path: "/x", headers: { origin: "https://evil.com", host: "k.com" } },
    res,
    () => assert.fail("لا يجب أن يمر")
  );
  assert.equal(res.code, 403);
});

// ── adminRateLimit: 20/دقيقة لكل IP ──
test("adminRateLimit: حامل JWT معفي (رشقات البوابة) وغيره 20 ثم 429", async () => {
  const { adminRateLimit } = await import("../src/web/middleware.mjs");
  // Bearer يمر دائماً بلا عد
  let passed = 0;
  for (let i = 0; i < 25; i++) {
    adminRateLimit({ ip: "9.9.9.9", headers: { authorization: "Bearer jwt.jwt.jwt" } }, { setHeader() {}, status(c) { this.code = c; return { json: () => {} }; } }, () => passed++);
  }
  assert.equal(passed, 25);
  const ip = `test-${Date.now()}-${Math.random()}`;
  let allowed = 0;
  let blocked = 0;
  for (let i = 0; i < 25; i++) {
    let passed = false;
    const res = { setHeader() {}, status(c) { this.code = c; return { json: () => {} }; } };
    adminRateLimit({ ip, path: "/tenants" }, res, () => { passed = true; });
    if (passed) allowed++;
    else if (res.code === 429) blocked++;
  }
  assert.equal(allowed, 20);
  assert.ok(blocked >= 5);
});

// ── JWT: توكن العميل 12 ساعة ──
test("signClientToken: انتهاء 12h (43200 ثانية)", async () => {
  process.env.JWT_SECRET = process.env.JWT_SECRET || "unit-test-jwt-secret-1234567890";
  const { signClientToken } = await import("../portal.mjs");
  const t = signClientToken({ id: "u1", tenantId: "t1", phone: "p1" });
  const payload = JSON.parse(Buffer.from(t.split(".")[1], "base64").toString());
  assert.equal(payload.exp - payload.iat, 12 * 60 * 60);
});

// ── القنوات: سجل القنوات الثلاث وتعيين الأحداث ──
test("channels: الثلاث معرفة والمجهول يرمي وتعيين الأحداث صح", async () => {
  const { getChannel, channelIds, channelForWebhookObject } = await import("../src/channels/registry.mjs");
  assert.deepEqual(channelIds().sort(), ["instagram", "messenger", "whatsapp"]);
  assert.equal(getChannel("whatsapp").id, "whatsapp");
  assert.equal(getChannel("messenger").id, "messenger");
  assert.equal(getChannel("instagram").id, "instagram");
  assert.throws(() => getChannel("telegram"), /غير معروف/);
  assert.equal(channelForWebhookObject("whatsapp_business_account"), "whatsapp");
  assert.equal(channelForWebhookObject("page"), "messenger");
  assert.equal(channelForWebhookObject("instagram"), "instagram");
  assert.equal(channelForWebhookObject("nope"), null);
});
test("channels/whatsapp: استخراج نص/زر/اسم ووسائط وتطبيع المرسل", async () => {
  const { getChannel } = await import("../src/channels/registry.mjs");
  const ch = getChannel("whatsapp");
  const t = ch.extractText(
    { text: { body: "مرحبا" }, interactive: { button_reply: { id: "buy_shoes", title: "شراء" } } },
    [{ wa_id: "962790000000", profile: { name: "أحمد" } }],
    "962790000000"
  );
  assert.equal(t.text, "مرحبا");
  assert.equal(t.buttonId, "buy_shoes");
  assert.equal(t.name, "أحمد");
  assert.equal(ch.receiverId({ metadata: { phone_number_id: "P1" } }), "P1");
  assert.equal(ch.extractMedia({ type: "audio", audio: { id: "A1" } }).kind, "audio");
  const img = ch.extractMedia({ type: "image", image: { id: "I1", caption: "ord_abc" } });
  assert.equal(img.kind, "image");
  assert.equal(img.caption, "ord_abc");
  assert.equal(ch.extractMedia({ type: "text", text: { body: "x" } }), null);
  assert.equal(ch.normalizeSender("0790000000"), "962790000000");
});
test("platform: resolveTenantInput(null) → null (لا افتراضي صامت)", async () => {
  const { resolveTenantInput } = await import("../tenants.mjs");
  assert.equal(await resolveTenantInput(null), null);
  assert.equal(await resolveTenantInput(undefined), null);
});
test("platform: defaultButtonsFor من features.quickButtons (لا ids بالكود)", async () => {
  const { defaultButtonsFor } = await import("../src/whatsapp/sender.mjs");
  const btns = await defaultButtonsFor({ id: "demo-bot", features: { quickButtons: [{ id: "b1", title: "زر1" }] }, products: [] });
  assert.deepEqual(btns, [{ id: "b1", title: "زر1" }]);
});
test("queue: الامتلاء يُسقط مع QUEUE_FULL بدل النمو للأبد", async () => {
  const q = createQueue({ concurrency: 1, maxQueued: 3 });
  // اشغل العامل بمهمة معلقة حتى يتراكم pending
  let release;
  const gate = new Promise((r) => { release = r; });
  const first = q.run("busy", () => gate);
  q.enqueue("q1", async () => {});
  q.enqueue("q2", async () => {});
  q.enqueue("q3", async () => {});
  const overflow = q.enqueue("OVERFLOW", async () => {});
  assert.equal(overflow, -1);
  await assert.rejects(q.run("X", async () => {}), /الطابور ممتلئ/);
  release();
  await first;
  const s = q.stats();
  assert.ok(s.dropped >= 1);
  assert.equal(s.maxQueued, 3);
});

// ── القنوات الكاملة: ماسنجر/انستغرام استخراج + إرسال موحد عبر ctx ──
test("channels/messenger+instagram: استخراج حدث messaging + ردود سريعة", async () => {
  const { getChannel } = await import("../src/channels/registry.mjs");
  const { toQuickReplies } = await import("../src/channels/messenger.mjs");
  const mg = getChannel("messenger");
  assert.equal(mg.receiverId({ recipient: { id: "PAGE1" } }), "PAGE1");
  const t = mg.extractText({ sender: { id: "U1" }, message: { text: "مرحبا" } });
  assert.equal(t.text, "مرحبا");
  assert.equal(t.buttonId, null);
  const pb = mg.extractText({ sender: { id: "U1" }, postback: { payload: "slot_10:00", title: "10:00" } });
  assert.equal(pb.buttonId, "slot_10:00");
  assert.equal(mg.extractMedia({ message: { attachments: [{ type: "image", payload: { url: "https://x/y.jpg" } }] } }).id, "https://x/y.jpg");
  assert.equal(mg.extractMedia({ message: { text: "x" } }), null);
  const ig = getChannel("instagram");
  assert.equal(ig.receiverId({ recipient: { id: "IG1" } }), "IG1");
  assert.deepEqual(toQuickReplies([{ id: "a", title: "عنوان طويل جداً جداً جداً جداً" }]), [
    { content_type: "text", title: "عنوان طويل جداً جداً", payload: "a" },
  ]);
});
test("channels/send: التوجيه حسب القناة + رفض opt-out", async () => {
  const { sendChText, sendChButtons } = await import("../src/channels/send.mjs");
  const calls = [];
  const fakeTenant = { id: "t1" };
  const mgCtx = {
    from: "msg:U1",
    tenant: fakeTenant,
    channel: {
      id: "messenger",
      async sendText(to, text) { calls.push(["text", to, text]); return { ok: true }; },
      async sendButtons(to, text, buttons) { calls.push(["btn", to, text, buttons]); return { ok: true }; },
    },
  };
  await sendChText(mgCtx, "هلا");
  await sendChButtons(mgCtx, "اختر", [{ id: "a", title: "أ" }]);
  assert.deepEqual(calls[0], ["text", "msg:U1", "هلا"]);
  assert.equal(calls[1][0], "btn");
  // whatsapp بلا توكن حقيقي → وضع محاكاة صريح (لا يلمس الشبكة أبداً)
  const { getChannel } = await import("../src/channels/registry.mjs");
  const waCtx = {
    from: "962790000000",
    tenant: { id: "t1", features: {}, whatsapp_token: "DEMO_WHATSAPP_TOKEN", phone_number_id: "DEMO_PHONE_ID" },
    channel: getChannel("whatsapp"),
  };
  await assert.rejects(sendChText(waCtx, "x"), /simulated-no-credentials/);
});

test("ui: سكربتات admin.html و client.html سليمة الصياغة (تمنع موت كل الأزرار)", async () => {
  const { readFileSync } = await import("node:fs");
  const { default: vm } = await import("node:vm");
  for (const f of ["admin.html", "client.html"]) {
    const h = readFileSync(new URL("../" + f, import.meta.url), "utf8");
    const blocks = h.split("<script>").slice(1).map((p) => p.split("</scr" + "ipt>")[0]);
    assert.ok(blocks.length >= 1, f + ": لا سكربت داخلي");
    for (const code of blocks) {
      if (!code.trim()) continue;
      new vm.Script(code, { filename: f }); // يرمي عند أي خطأ صياغي — بلا تنفيذ
    }
  }
});