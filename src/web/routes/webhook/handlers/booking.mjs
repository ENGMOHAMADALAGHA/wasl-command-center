// معالج الحجوزات: فرز الأعراض + انتظار + عروض + بدء/خدمة/وقت — يرجع true إذا عالج
import {
  bookAppointment,
  getBookingState,
  setBookingState,
  joinWaitingList,
  isSlotTaken,
  freeSlots,
} from "../../../../../bookings.mjs";
import { sendChText, sendChButtons } from "../../../../channels/send.mjs";
import { pushHistory } from "../../../../memory/conversations.mjs";
import { notifyOwner } from "../../../../compliance/messaging.mjs";
import { logEvent } from "../../../../../crm.mjs";
import { bookingDay } from "../helpers.mjs";

export async function handleBooking(ctx) {
  const { from, tenant, name } = ctx;
  const text = ctx.text;
  const buttonId = ctx.buttonId;
  const wantsBooking = ctx.wantsBooking;
  const bookingState = ctx.bookingState;

  // —— فرز أولي Triage (أعراض الأسنان) ——
  const triageOn = tenant?.features?.booking && tenant?.businessType === "dental";
  const symptomHit = triageOn && !bookingState && /(وجع|ألم|يوجع|يؤلم|ورم|منتفخ|انتفاخ|كسر|مكسور|انكسر|نزيف|دم|حرارة|سخونة|سخن|خراج|حساسية|حساس|بارد|ساخن|ضرس العقل|pain|ache|swell|swollen|broken|bleed|fever|abscess|sensitive)/i.test(text);

  // 1ب) بدء الفرز: سؤال المكان
  if (symptomHit) {
    await setBookingState(tenant.id, from, { step: "triage_q1", answers: { symptom: text.slice(0, 200) } });
    const reply = `سلامتك يا غالي 🙏 عشان نوجهك صح، وين الألم بالضبط؟ (ضرس / لثة / فك)`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    try {
      await sendChButtons(ctx, reply, [
        { id: "pain_tooth", title: "🦷 ضرس" },
        { id: "pain_gum", title: "لثة" },
        { id: "pain_jaw", title: "فك" },
      ], tenant);
    } catch (e) {
      await sendChText(ctx, reply, tenant).catch(() => {});
    }
    console.log(`  🩺 بدء فرز ${tenant.id} للعميل ${from}`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }

  // 1ج) الفرز س2: المدة
  if (bookingState?.step === "triage_q1") {
    const answers = { ...(bookingState.answers || {}), place: text.slice(0, 100) };
    await setBookingState(tenant.id, from, { step: "triage_q2", answers });
    const reply = `تمام، ومن متى بلش الألم؟ (اليوم / من كم يوم / من أسابيع)`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    try {
      await sendChText(ctx, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل الإرسال: ${e.message}`);
    }
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }

  // 1د) الفرز س3: علامات الخطر + التصنيف
  if (bookingState?.step === "triage_q2") {
    const answers = { ...(bookingState.answers || {}), since: text.slice(0, 100) };
    await setBookingState(tenant.id, from, { step: "triage_q3", answers });
    const reply = `آخر سؤال يا غالي: هل عندك أي من هاي؟ (ورم / حرارة / نزيف / ألم لا يُحتمل) — ابعت "لا" إذا ما في شي منها.`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    try {
      await sendChButtons(ctx, reply, [
        { id: "red_swelling", title: "ورم" },
        { id: "red_none", title: "لا، ما في" },
      ], tenant);
    } catch (e) {
      await sendChText(ctx, reply, tenant).catch(() => {});
    }
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }

  // 1هـ) التصنيف: طارئ أم عادي
  if (bookingState?.step === "triage_q3") {
    const { ammanDateStr } = await import("../../../../utils/time.mjs");
    const red = /(ورم|منتفخ|انتفاخ|حرارة|سخونة|سخن|نزيف|دم|كسر|مكسور|انكسر|خراج|لا يُحتمل|لا يحتمل|شديد جدا|swell|fever|bleed|broken|abscess|red_swelling)/i.test(text + " " + (buttonId || ""));
    const answers = { ...(bookingState.answers || {}), redFlags: red ? text.slice(0, 100) : "لا" };
    const summary = `العرض: ${answers.symptom || ""} | المكان: ${answers.place || ""} | المدة: ${answers.since || ""} | علامات: ${answers.redFlags}`;
    logEvent("triage", { tenantId: tenant.id, phone: from, emergency: red, summary: summary.slice(0, 300) }).catch(() => {});
    if (red) {
      await setBookingState(tenant.id, from, null);
              // موعد طوارئ فريد: تاريخ اليوم بمنطقة الأردن + وقت فوري بالثواني
              // (الدقيقة وحدها تتصادم على القيد الفريد @@unique عند حالتين بنفس الدقيقة)
              const now = new Date();
              const day = ammanDateStr(0);
              const slot = `طوارئ فوري ${now.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}`;
      try {
        const booking = await bookAppointment({ tenantId: tenant.id, phone: from, name, service: "حالة طارئة 🆘", day, slot });
        const reply = `سلامتك أولاً يا غالي 🆘 الأعراض اللي ذكرتها تحتاج تدخل سريع — حجزتلك موعد طارئ اليوم (${booking.id}). تعال مباشرة على العيادة، والدكتور بانتظارك. إذا الوضع خطير اتصل فينا فوراً.`;
        await pushHistory(from, "user", text, tenant);
        await pushHistory(from, "assistant", reply, tenant);
        try {
          await sendChText(ctx, reply, tenant);
        } catch (e) {
          console.error(`  ❌ فشل الإرسال: ${e.message}`);
        }
        console.log(`  🆘 حالة طارئة ${tenant.id} ${from} (${booking.id})`);
      } catch (e) {
        // لا صمت أبداً: حتى لو تعارض، نخبر المريض بالاتصال المباشر
        console.error(`  ❌ تعارض حجز طارئ: ${e.message}`);
        const staffReply = `سلامتك يا غالي 🆘 الملف الطارئ مفتوح عندنا هلا — اتصل بالعيادة مباشرة 📞 أو ابعت "أريد موظف" للتنسيق الفوري. هذا تنبيه آلي وليس استشارة طبية.`;
        await pushHistory(from, "user", text, tenant);
        await pushHistory(from, "assistant", staffReply, tenant);
        try {
          await sendChText(ctx, staffReply, tenant);
        } catch (se) {
          console.error(`  ❌ فشل إرسال تنبيه الطوارئ: ${se.message}`);
        }
      }
      console.log(`${"─".repeat(60)}\n`);
      return true;
    }
    // عادي → كمّل للحجز مع تلخيص الإجابات في الذاكرة
    await setBookingState(tenant.id, from, { step: "slot", triage: summary.slice(0, 300) });
    const slots = (tenant.features.bookingSlots || []).join("، ");
    const reply = `تمام يا غالي، حالتك تبدو عادية 😊 سجلت ملاحظاتك للدكتور. اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00).`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    try {
      await sendChButtons(ctx, reply, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
    } catch (e) {
      await sendChText(ctx, reply, tenant).catch(() => {});
    }
    console.log(`  🩺 فرز عادي → حجز ${tenant.id} ${from}`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }

  // 1و) الانضمام لقائمة الانتظار
  if (tenant?.features?.booking && /(انتظار|ضيفني|قائمة الانتظار|waitlist|waiting)/i.test(text)) {
    const service = bookingState?.service || (tenant.products || [])[0]?.name || "موعد";
    const w = await joinWaitingList({ tenantId: tenant.id, phone: from, name, service });
    const reply = `تم يا غالي ✅ انضميت لقائمة الانتظار (${w.id}) لخدمة ${service}. أول ما يفضى موعد بنخبرك فوراً هنا.`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    logEvent("waiting_join", { tenantId: tenant.id, phone: from, service }).catch(() => {});
    try {
      await sendChText(ctx, reply, tenant);
    } catch (e) {
      console.error(`  ❌ فشل الإرسال: ${e.message}`);
    }
    console.log(`  📋 انضمام انتظار ${tenant.id} ${from}`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }

  // 1ز) قبول عرض موعد من الانتظار
  if (bookingState?.step === "offer" && /^(تم|موافق|نعم|ok|yes)$/i.test(text.trim())) {
    // مهلة العرض الفعلية: ساعة (كما وعدنا العميل) لا 24 ساعة
    // fail-closed: عرض بلا offeredAt يُعامل كمنتهي بدل قبوله للأبد
    const offerAge = bookingState.offeredAt ? Date.now() - bookingState.offeredAt : Infinity;
    if (offerAge > 60 * 60 * 1000) {
      await setBookingState(tenant.id, from, null);
      const expired = `انتهت مهلة العرض يا غالي 😊 الموعد بيعطي بالعادة خلال ساعة من عرضه. ابعت "حجز" لموعد جديد أو "انتظار" لعودتك للقائمة.`;
      await pushHistory(from, "user", text, tenant);
      await pushHistory(from, "assistant", expired, tenant);
      try { await sendChText(ctx, expired, tenant); } catch (e) { console.error(`  ❌ فشل الإرسال: ${e.message}`); }
      console.log(`  ⏳ عرض منتهي ${tenant.id} ${from}`);
      console.log(`${"─".repeat(60)}\n`);
      return true;
    }
    try {
      const accepted = await bookAppointment({ tenantId: tenant.id, phone: from, name, service: bookingState.service || "موعد", day: bookingDay(bookingState.day), slot: bookingState.slot || "" });
      await setBookingState(tenant.id, from, null);
      const reply = `ممتاز! 🎉 تم تأكيد موعدك ${accepted.service} (${accepted.id}). بنتشرف فيك!`;
      await pushHistory(from, "user", text, tenant);
      await pushHistory(from, "assistant", reply, tenant);
      logEvent("booking", { tenantId: tenant.id, phone: from, bookingId: accepted.id, fromWaiting: true }).catch(() => {});
      try {
        await sendChText(ctx, reply, tenant);
      } catch (e) {
        console.error(`  ❌ فشل الإرسال: ${e.message}`);
      }
      notifyOwner(tenant, "booking", `📅 حجز من الانتظار: ${accepted.service} — ${from} (${accepted.id})`).catch(() => {});
      console.log(`  📋 تأكيد من الانتظار ${accepted.id} ${from}`);
    } catch (e) {
      const taken = e?.code === "SLOT_TAKEN" || e?.code === "P2002";
      await setBookingState(tenant.id, from, null);
      const free = taken ? await freeSlots(tenant.id, bookingDay(bookingState.day), tenant.features?.bookingSlots) : [];
      const reply = taken
        ? (free.length
            ? `للأسف الموعد انحجز قبل لحظات 😅 الفارغ مثل: ${free.join("، ")} — اختر واحد؟ أو "انتظار"`
            : `للأسف كل الأوقات انحجزت 😅 ابعت "حجز" لبدء حجز جديد أو "انتظار" للقائمة.`)
        : `للأسف تعذر تأكيد العرض 🤔 ابعت "حجز" لموعد جديد.`;
      await pushHistory(from, "user", text, tenant);
      await pushHistory(from, "assistant", reply, tenant);
      try {
        if (taken && free.length) await sendChButtons(ctx, reply, free.slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
        else await sendChText(ctx, reply, tenant);
      } catch (se) { console.error(`  ❌ فشل الإرسال: ${se.message}`); }
      console.log(`  ⚠️ فشل تأكيد العرض ${tenant.id} ${from}: ${e.message}`);
    }
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }

  // 2) بدء الحجز
  if (wantsBooking && !bookingState) {
    const services = tenant.products || [];
    // أكثر من خدمة → خطوة اختيار الخدمة أولاً
    if (services.length > 1) {
      await setBookingState(tenant.id, from, { step: "service" });
      const reply = `تمام يا غالي 😊 بتبسط في ${tenant.name} هالخدمات:\n${services.map((s) => `• ${s.name} (${s.price} د.أ)`).join("\n")}\nأي خدمة بدك تحجز؟`;
      ctx.result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
      await pushHistory(from, "user", text, tenant);
      await pushHistory(from, "assistant", reply, tenant);
      try {
        await sendChButtons(ctx, reply, services.slice(0, 3).map((s, i) => ({ id: `svc_${i}`, title: `${s.name} (${s.price} د.أ)` })), tenant);
      } catch (e) {
        await sendChText(ctx, reply, tenant).catch(() => {});
      }
      console.log(`  📅 بدء حجز (اختيار خدمة) ${tenant.id} للعميل ${from}`);
      console.log(`${"─".repeat(60)}\n`);
      return true;
    }
    const slots = (tenant.features.bookingSlots || []).join("، ");
    await setBookingState(tenant.id, from, { step: "slot", day: "أقرب يوم متاح" });
    const reply = `تمام يا غالي 😊 احجز موعدك في ${tenant.name}. أوقاتنا: ${tenant.features.workingHours || ""}. اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00).`;
    ctx.result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reply, tenant);
    try {
      await sendChButtons(ctx, reply, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
    } catch (e) {
      await sendChText(ctx, reply, tenant).catch(() => {});
    }
    console.log(`  📅 بدء حجز ${tenant.id} للعميل ${from}`);
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }

  // 2ب) اختيار الخدمة (عيادات/خدمات متعددة)
  if (bookingState?.step === "service") {
    const services = tenant.products || [];
    const chosen = services.find((s, i) => {
      if (buttonId && buttonId.startsWith("svc_")) return Number(buttonId.replace("svc_", "")) === i;
      const kw = (s.name || "").split(" ")[0].toLowerCase();
      return kw && text.toLowerCase().includes(kw);
    });
    if (chosen) {
      await setBookingState(tenant.id, from, { step: "slot", day: "أقرب يوم متاح", service: chosen.name });
      const slots = (tenant.features.bookingSlots || []).join("، ");
      const reply = `ممتاز ${chosen.name} 👍 اختر الوقت المناسب: ${slots}. ابعت الوقت (مثال: 14:00).`;
      await pushHistory(from, "user", text, tenant);
      await pushHistory(from, "assistant", reply, tenant);
      try {
        await sendChButtons(ctx, reply, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
      } catch (e) {
        await sendChText(ctx, reply, tenant).catch(() => {});
      }
      console.log(`  🩺 اختيرت الخدمة ${chosen.name} ${tenant.id} ${from}`);
      console.log(`${"─".repeat(60)}\n`);
      return true;
    }
    const reask = `ما فهمت أي خدمة قصدك يا غالي 😅 اختر من القائمة:`;
    await pushHistory(from, "user", text, tenant);
    await pushHistory(from, "assistant", reask, tenant);
    try {
      await sendChButtons(ctx, reask, services.slice(0, 3).map((s, i) => ({ id: `svc_${i}`, title: `${s.name} (${s.price} د.أ)` })), tenant);
    } catch (e) {
      await sendChText(ctx, reask, tenant).catch(() => {});
    }
    console.log(`${"─".repeat(60)}\n`);
    return true;
  }

  // 3) استكمال الحجز (اختار وقت)
  if (bookingState?.step === "slot") {
    // دعم الأرقام العربية-الهندية (١٤:٠٠) بتوحيدها قبل المطابقة
    const norm = text.replace(/[٠-٩]/g, (d) => String("٠١٢٣٤٥٦٧٨٩".indexOf(d)))
      .replace(/[۰-۹]/g, (d) => String("۰۱۲۳۴۵۶۷۸۹".indexOf(d)));
    const slotMatch = norm.match(/(\d{1,2}:\d{2})/) || (buttonId?.startsWith("slot_") ? [null, buttonId.replace("slot_", "")] : null);
    if (slotMatch) {
      const slot = slotMatch[1];
      const service = bookingState.service || (tenant.products || [])[0]?.name || "موعد";
      const day = bookingDay(bookingState.day || "أقرب يوم متاح");
      // سياسة ثابتة: موعد واحد لكل وقت (طبيب/مزرعة/تجميل — لا حجوزات مزدوجة أبداً)
      if (await isSlotTaken(tenant.id, day, slot)) {
        const free = await freeSlots(tenant.id, day, tenant.features?.bookingSlots);
        const reply = free.length
          ? `للأسف الساعة ${slot} محجوزة يا غالي 😅 بس الفارغ عندنا: ${free.join("، ")}. اختر واحد منهم؟ أو ابعت "انتظار" لأضيفك لقائمة الانتظار.`
          : `للأسف كل الأوقات محجوزة اليوم 😅 أضفتك تلقائياً لقائمة الانتظار، وأول ما يفضى موعد بخبرك فوراً.`;
        if (!free.length) {
          await joinWaitingList({ tenantId: tenant.id, phone: from, name, service });
        }
        await pushHistory(from, "user", text, tenant);
        await pushHistory(from, "assistant", reply, tenant);
        try {
          if (free.length) {
            await sendChButtons(ctx, reply, free.slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
          } else {
            await sendChText(ctx, reply, tenant);
          }
        } catch (e) {
          console.error(`  ❌ فشل الإرسال: ${e.message}`);
        }
        console.log(`  ⚠️ تعارض ${tenant.id} ${day} ${slot} — عُرضت البدائل`);
        console.log(`${"─".repeat(60)}\n`);
        return true;
      }
      let booking;
      try {
        booking = await bookAppointment({ tenantId: tenant.id, phone: from, name, service, day, slot });
      } catch (e) {
        if (e?.code === "SLOT_TAKEN" || e?.code === "P2002") {
          const free = await freeSlots(tenant.id, day, tenant.features?.bookingSlots);
          const reply = free.length
            ? `للأسف الساعة ${slot} انحجزت قبل لحظات 😅 الفارغ عندنا: ${free.join("، ")}. اختر واحد منهم؟`
            : `للأسف كل الأوقات انحجزت 😅 أضفتك لقائمة الانتظار.`;
          if (!free.length) await joinWaitingList({ tenantId: tenant.id, phone: from, name, service });
          await pushHistory(from, "user", text, tenant);
          await pushHistory(from, "assistant", reply, tenant);
          try { await sendChText(ctx, reply, tenant); } catch (se) { console.error(`  ❌ فشل الإرسال: ${se.message}`); }
          console.log(`${"─".repeat(60)}\n`);
          return true;
        }
        throw e;
      }
      await setBookingState(tenant.id, from, null);
      const reply = `تم تأكيد حجزك يا غالي ✅ ${service} - يوم ${day} - الساعة ${slot} (${booking.id}). بنتشرف فيك في ${tenant.name}! لإلغاء/تعديل ابعت "أريد موظف".`;
      ctx.result = { reply, transfer_to_human: false, intent: "حجز_موعد" };
      await pushHistory(from, "user", text, tenant);
      await pushHistory(from, "assistant", reply, tenant);
      logEvent("booking", { tenantId: tenant.id, phone: from, bookingId: booking.id, service, slot }).catch(() => {});
      try {
        await sendChText(ctx, reply, tenant);
      } catch (e) {
        console.error(`  ❌ فشل الإرسال: ${e.message}`);
      }
      // ClinicCare: موقع العيادة بعد الحجز + مزامنة التقويم (تسجيل فقط حتى OAuth الحقيقي)
      // القاعدة: فشل الملحقات لا يكسر الحجز أبداً — لكن يُوثق بصوت عالٍ (ممنوع الكتم الصامت)
      const loc = tenant?.features?.location;
      const lat = Number(loc?.lat);
      const lng = Number(loc?.lng);
      if (Number.isFinite(lat) && Number.isFinite(lng)) {
        try {
          const { sendLocation } = await import("../../../../whatsapp/sender.mjs");
          await sendLocation(from, lat, lng, loc.name || tenant.name, loc.address || "", tenant);
          await pushHistory(from, "assistant", "[موقع العيادة]", tenant);
          logEvent("location_sent", { tenantId: tenant.id, bookingId: booking.id }).catch(() => {});
        } catch (e) {
          console.error(`  ❌ فشل إرسال الموقع ${booking.id}: ${e.message}`);
          logEvent("dead_letter", { scope: "booking", reason: "location-failed", tenantId: tenant.id, bookingId: booking.id, error: String(e?.message || e).slice(0, 200) }).catch(() => {});
        }
      } else if (loc) {
        console.warn(`  ⚠️ موقع العيادة ناقص الإحداثيات (${tenant.id}) — تُخطي الإرسال`);
      }
      if (tenant?.features?.googleCalendarId) {
        try {
          const { syncBookingToGoogleCalendar } = await import("../../../../integrations/googleCalendar.mjs");
          const r = await syncBookingToGoogleCalendar(booking, tenant);
          if (!r?.ok) console.warn(`  ⚠️ مزامنة التقويم ${booking.id}: ${r?.reason || "غير معروفة"}`);
        } catch (e) {
          console.error(`  ❌ فشل مزامنة التقويم ${booking.id}: ${e.message}`);
          logEvent("dead_letter", { scope: "booking", reason: "calendar-failed", tenantId: tenant.id, bookingId: booking.id, error: String(e?.message || e).slice(0, 200) }).catch(() => {});
        }
      }
      // المالك يتفرج من واتسابه: إشعار فوري بالحجز الجديد
      notifyOwner(tenant, "booking", `📅 حجز جديد: ${service} — ${from} (${name}) — الساعة ${slot} (${booking.id})`).catch(() => {});
      console.log(`  📅 تأكيد حجز ${booking.id} ${tenant.id} ${from} ${slot}`);
      console.log(`${"─".repeat(60)}\n`);
      return true;
    } else if (!/موظف|انسان|بشري|انتظار|قائمة|إلغ|الغى|الغاء|الغائ/.test(text)) {
      // في خطوة الوقت لكن الرسالة بلا ساعة — أعد عرض الأزرار (لا نتركه بلا مسار)
      const hint = `تمام يا غالي 😊 اختر الساعة من القائمة أو ابعت الوقت بصيغة رقمية (مثال: 14:00):`;
      await pushHistory(from, "user", text, tenant);
      await pushHistory(from, "assistant", hint, tenant);
      try {
        await sendChButtons(ctx, hint, (tenant.features.bookingSlots || []).slice(0, 3).map((s) => ({ id: `slot_${s}`, title: `🕐 ${s}` })), tenant);
      } catch (e) {
        await sendChText(ctx, hint, tenant).catch(() => {});
      }
      console.log(`${"─".repeat(60)}\n`);
      return true;
    }
  }
  return false;
}
