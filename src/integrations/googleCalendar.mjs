// مزامنة الحجز مع Google Calendar — واجهة موحدة لكل عيادة
// المتطلب لكل بوت: features.googleCalendarId + (اختياري) features.googleCalendarToken
// حالياً تسجيل وهمي + logEvent حتى تفعيل OAuth الحقيقي — لا يكسر الحجز أبداً
import { logEvent } from "../../crm.mjs";

export async function syncBookingToGoogleCalendar(booking, tenant) {
  if (!tenant?.features?.googleCalendarId || !booking) return { ok: false, reason: "no-calendar" };
  try {
    // TODO: OAuth + googleapis calendar.events.insert — عند تفعيله ضع التوكن بـ features.googleCalendarToken المشفر
    logEvent("calendar_sync", { tenantId: tenant.id, bookingId: booking.id, calendarId: tenant.features.googleCalendarId }).catch(() => {});
    console.log(`  📅 [${tenant.id}] مزامنة تقويم وهمية ${booking.id} → ${tenant.features.googleCalendarId}`);
    return { ok: true, mocked: true };
  } catch (e) {
    console.error(`  ⚠️ فشل مزامنة التقويم ${booking.id}: ${e.message}`);
    return { ok: false, reason: e.message };
  }
}
