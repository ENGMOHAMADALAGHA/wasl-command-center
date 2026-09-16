import { tenantDb, systemDb } from "./src/security/tenantGuard.mjs";
import crypto from "node:crypto";
import { normalizePhone } from "./src/utils/phone.mjs";
import { ammanDateStr } from "./src/utils/time.mjs";

const nid = (prefix) => `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, 12)}`;

export async function bookAppointment({ tenantId, phone, name, service, day, slot }) {
  phone = normalizePhone(phone);
  // DB-level uniqueness (@@unique tenantId/day/slot) is the last line of defense.
  // Map P2002 → clean SLOT_TAKEN error so callers can offer freeSlots().
  try {
    const row = await tenantDb(tenantId).appointment.create({
      data: {
        id: nid("bk"),
        phone, name: name || phone, service, day, slot,
      },
    });
    const booking = rowToBooking(row);
    // مزامنة Sheets بالخلفية — فشلها لا يكسر التدفق أبداً (fire-and-forget)
    syncBookingToGoogleSheets(booking).catch(() => {});
    return booking;
  } catch (e) {
    if (e?.code === "P2002") {
      const err = new Error("SLOT_TAKEN");
      err.code = "SLOT_TAKEN";
      err.meta = { tenantId, day, slot };
      throw err;
    }
    throw e;
  }
}

// ── مزامنة لحظية مع Google Sheets (عبر Make/n8n/Apps Script webhook) ──
// تُستدعى عند كل حجز مؤكد. آمنة تماماً: مهلة 10ث + كل الأخطاء مبلوعة داخلياً.
export async function syncBookingToGoogleSheets(booking) {
  try {
    const url = process.env.CRM_WEBHOOK_URL;
    if (!url || !booking) return { ok: false, reason: "skipped" };
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 10000);
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        signal: ctrl.signal,
        body: JSON.stringify({
          event: "appointment_created",
          tenant_id: booking.tenantId,
          booking_id: booking.id,
          customer_name: booking.name || booking.phone,
          phone: booking.phone,
          service: booking.service || "",
          date_time: `${booking.day || ""} ${booking.slot || ""}`.trim(),
          created_at: booking.createdAt instanceof Date ? booking.createdAt.toISOString() : new Date(booking.createdAt || Date.now()).toISOString(),
        }),
      });
      if (!res.ok) return { ok: false, reason: `HTTP ${res.status}` };
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  } catch (e) {
    console.error(`  ⚠️ فشل مزامنة Sheets للحجز ${booking?.id}: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}

// ── تعديل حجز: أي حقل (اسم/هاتف/خدمة/يوم/وقت) — اليوم والوقت يحترمان القيد الفريد ──
export async function updateAppointment(id, tenantId, patch = {}) {
  const data = {};
  if (patch.name !== undefined) data.name = String(patch.name).trim() || undefined;
  if (patch.phone !== undefined && String(patch.phone).trim()) data.phone = normalizePhone(String(patch.phone).trim());
  if (patch.service !== undefined) data.service = String(patch.service).trim() || "موعد";
  if (patch.day !== undefined && String(patch.day).trim()) data.day = String(patch.day).trim();
  if (patch.slot !== undefined && String(patch.slot).trim()) data.slot = String(patch.slot).trim();
  if (!Object.keys(data).length) throw new Error("لا حقول للتعديل");
  try {
    const row = await tenantDb(tenantId).appointment.update({ where: { id }, data });
    return rowToBooking(row);
  } catch (e) {
    if (e?.code === "P2002") {
      const err = new Error("SLOT_TAKEN");
      err.code = "SLOT_TAKEN";
      err.meta = { tenantId, ...data };
      throw err;
    }
    if (e?.code === "P2025" || e?.code === "TENANT_DENIED") return null;
    throw e;
  }
}

// ── إعادة جدولة: نقل الحجز لموعد جديد مع احترام القيد الفريد ──
export async function rescheduleAppointment(id, tenantId, { day, slot }) {
  if (!day || !slot) throw new Error("day و slot مطلوبان");
  try {
    const row = await tenantDb(tenantId).appointment.update({
      where: { id },
      data: { day, slot, remindedAt: null },
    });
    return rowToBooking(row);
  } catch (e) {
    if (e?.code === "P2002") {
      const err = new Error("SLOT_TAKEN");
      err.code = "SLOT_TAKEN";
      err.meta = { tenantId, day, slot };
      throw err;
    }
    if (e?.code === "P2025") return null;
    throw e;
  }
}

// ── CSV للحجوزات (Excel مباشرة — UTF-8 BOM للعربية) ──
export function bookingsToCSV(rows) {
  const header = "id,customer_name,phone,service,day,slot,status,reminded_at,created_at";
  const lines = (rows || []).map((b) =>
    [b.id, b.name || "", b.phone || "", b.service || "", b.day || "", b.slot || "", b.status || "", b.remindedAt || "", b.createdAt || ""]
      .map((v) => `"${String(v ?? "").replace(/"/g, '""')}"`)
      .join(",")
  );
  return "\uFEFF" + [header, ...lines].join("\n");
}

export async function listAppointments(tenantId) {
  if (!tenantId) throw new Error("listAppointments يتطلب tenantId — استخدم listAppointmentsAll للسوبر");
  const rows = await tenantDb(tenantId).appointment.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return rows.map(rowToBooking);
}

// للسوبر أدمن فقط (قائمة عامة) — مسار معلن ومراقب
export async function listAppointmentsAll() {
  const rows = await systemDb("bookings:listAll").appointment.findMany({
    orderBy: { createdAt: "desc" },
    take: 500,
  });
  return rows.map(rowToBooking);
}

function rowToBooking(r) {
  if (!r) return null;
  return {
    id: r.id, tenantId: r.tenantId, phone: r.phone, name: r.name,
    service: r.service, day: r.day, slot: r.slot, status: r.status,
    remindedAt: r.remindedAt, createdAt: r.createdAt,
  };
}

// تذكير: حجوزات مؤكدة يوم غد (التذكير قبل الموعد بيوم) بلا تذكير سابق
// "العمود when" الحقيقي: day يُخزّن ISO فعلي منذ إصلاح bookingDay. عند مطابقة غداً فقط
// نتأكد أننا نذكّر قبل الموعد وليس 60 دقيقة بعد الحجز.
export function isoDay(offsetDays = 0) {
  return ammanDateStr(offsetDays);
}

export async function dueReminders({ afterMinutes = 60 } = {}) {
  const tomorrow = isoDay(1);
  const rows = await systemDb("scheduler:dueReminders").appointment.findMany({
    where: {
      status: "confirmed",
      remindedAt: null,
      // لا نذكّر حجزاً خرج من دقيقة (بداية هادئة في حال أضاف الطاقم موعداً للغد من اللوحة)
      createdAt: { lt: new Date(Date.now() - afterMinutes * 60 * 1000) },
      OR: [
        { day: tomorrow },
        // انتقال للحجز القديم قبل توحيد اليوم (أقرب يوم متاح/غداً/اليوم) — ذُكَّر مرة واحدة
        { day: "أقرب يوم متاح" },
        { day: { in: ["غداً", "غدا", "اليوم"] } },
      ],
    },
  });
  return rows.map(rowToBooking);
}

export async function markReminded(id, tenantId) {
  // ادّعاء ذري قبل الإرسال: updateMany بشرط remindedAt=null —
  // نسخة أخرى/مؤقت منافس لا يستطيع تكرار نفس التذكير (لا رسائل مكررة).
  const r = await tenantDb(tenantId).appointment.updateMany({
    where: { id, remindedAt: null },
    data: { remindedAt: new Date() },
  }).catch(() => ({ count: 0 }));
  return r?.count > 0;
}

// إلغاء الادعاء عند فشل الإرسال (للإعادة في الدورة التالية) — لا نضيّع التذكير بفشل عابر
export async function unmarkReminded(id, tenantId) {
  await tenantDb(tenantId).appointment.updateMany({
    where: { id },
    data: { remindedAt: null },
  }).catch(() => null);
}

export async function cancelAppointment(id, tenantId) {
  // الإلغاء يحذف الصف (لا تعليمه ملغياً): القيد الفريد @@unique(tenantId,day,slot)
  // يمنع أي حجز لاحق لنفس الموعد لو بقي الصف — الحذف يحرر الموعد فوراً.
  // السجل التاريخي محفوظ بأحداث CRM (booking_canceled).
  const T = tenantDb(tenantId);
  const existing = await T.appointment.findFirst({ where: { id } }).catch(() => null);
  if (!existing) return null;
  await T.appointment.delete({ where: { id } }).catch(() => null);
  return rowToBooking(existing);
}

// ClinicCare: حجوزات اليوم التالية خلال 3 ساعات (تذكير ثانٍ) + متابعة بعد الزيارة بيوم
export async function dueSoonReminders({ hours = 3 } = {}) {
  try {
    const today = isoDay(0);
    const rows = await systemDb("scheduler:dueSoon").appointment.findMany({
      where: { status: "confirmed", day: today },
      take: 100,
    });
    // فلترة زمنية بسيطة: slot بصيغة HH:MM ويكون خلال الـ hours القادمة
    const now = new Date();
    const nowMin = now.getHours() * 60 + now.getMinutes();
    return rows
      .filter((r) => {
        const m = String(r.slot || "").match(/(\d{1,2}):(\d{2})/);
        if (!m) return false;
        const slotMin = parseInt(m[1], 10) * 60 + parseInt(m[2], 10);
        const diff = slotMin - nowMin;
        return diff > 0 && diff <= hours * 60;
      })
      .map(rowToBooking);
  } catch {
    return [];
  }
}
export async function dueFollowups() {
  try {
    const yesterday = isoDay(-1);
    const rows = await systemDb("scheduler:followups").appointment.findMany({
      where: { status: "confirmed", day: yesterday },
      take: 50,
    });
    return rows.map(rowToBooking);
  } catch {
    return [];
  }
}

// ── منع التعارض: موعد واحد لكل وقت — سياسة ثابتة (طبيب/مزرعة/تجميل).
// لا حجوزات مزدوجة أبداً: أي capacity>1 قديمة تُتجاهل مع تحذير (قيد DB فريد).
export async function countSlotBookings(tenantId, day, slot) {
  return tenantDb(tenantId).appointment.count({
    where: { day, slot, status: "confirmed" },
  });
}

export async function isSlotTaken(tenantId, day, slot, capacity) {
  if (capacity !== undefined && capacity !== 1) {
    console.warn(`  ⚠️ slotCapacity=${capacity} مرفوضة — موعد واحد لكل وقت (تجاهل)`);
  }
  return (await countSlotBookings(tenantId, day, slot)) >= 1;
}

// أقرب الأوقات الفارغة لنفس اليوم — استعلام واحد بدل N+1
export async function freeSlots(tenantId, day, allSlots) {
  const slots = allSlots || [];
  if (!slots.length) return [];
  const taken = await tenantDb(tenantId).appointment.findMany({
    where: { day, slot: { in: slots }, status: "confirmed" },
    select: { slot: true },
  });
  const takenSet = new Set((taken || []).map((r) => r.slot));
  return slots.filter((s) => !takenSet.has(s));
}

// قائمة الانتظار: حجوزات بحالة waiting (تُعبأ تلقائياً عند الإلغاء)
// ملاحظة: slot فريد لكل صف حتى لا يتعارض مع @@unique(tenantId, day, slot)
export async function joinWaitingList({ tenantId, phone, name, service }) {
  phone = normalizePhone(phone);
  const row = await tenantDb(tenantId).appointment.create({
    data: {
      id: nid("wt"),
      phone, name: name || phone, service, day: "انتظار", slot: `wl_${crypto.randomUUID().replace(/-/g, "").slice(0, 8)}`,
      status: "waiting",
    },
  });
  return rowToBooking(row);
}

export async function listWaiting(tenantId, service) {
  const T = tenantId ? tenantDb(tenantId) : systemDb("bookings:waiting-all");
  const rows = await T.appointment.findMany({
    where: {
      status: "waiting",
      ...(service ? { service } : {}),
    },
    orderBy: { createdAt: "asc" },
    take: 20,
  });
  return rows.map(rowToBooking);
}

export async function popWaiting(tenantId, service) {
  const list = await listWaiting(tenantId, service);
  return list[0] || null;
}

export async function removeFromWaiting(id, tenantId) {
  await tenantDb(tenantId).appointment.delete({ where: { id } }).catch(() => null);
}

// حالة الحجز المؤقتة — دائمة في DB (لا تضيع عند restart)
import { storeGet, storeSet, storeDel } from "./store.mjs";
const bkKey = (tenantId, phone) => `booking:${tenantId}::${phone}`;
export async function getBookingState(tenantId, phone) {
  return storeGet(bkKey(tenantId, phone));
}
export async function setBookingState(tenantId, phone, state) {
  if (!state) return storeDel(bkKey(tenantId, phone));
  return storeSet(bkKey(tenantId, phone), { ...state, updatedAt: Date.now() }, 24 * 60 * 60 * 1000);
}
