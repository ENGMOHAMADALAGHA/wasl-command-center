// محوّل واتساب: استخراج من حدث Meta + إرسال عبر الطبقة الحالية
// السلوك مطابق 100% لكود webhook/process السابق — نُقل هنا بلا تغيير منطق.
import { normalizePhone } from "../utils/phone.mjs";
import { sendWhatsAppMessage, sendButtons, sendImage } from "../whatsapp/sender.mjs";

export const whatsappChannel = {
  id: "whatsapp",
  supportsMedia: true,

  // رقم البوت المستقبل من الحدث (للعزل)
  receiverId(value) {
    return value?.metadata?.phone_number_id || value?.phone_number_id || null;
  },

  // ── Coexistence: رقم العيادة المعلن من بيانات الدفعة نفسها ──
  businessNumber(value) {
    const raw = value?.metadata?.display_phone_number || null;
    return raw ? normalizePhone(raw) : null;
  },

  // صدى = رسالة from هو رقم البوت نفسه (الدكتور رد من تطبيق البزنس)
  isEcho(msg, value) {
    if (!msg?.from) return false;
    const biz = whatsappChannel.businessNumber(value);
    if (!biz) return false;
    return normalizePhone(msg.from) === biz;
  },

  // الطرف الثاني للصدى: msg.to أولاً ثم جهات الاتصال (باستثناء رقم البوت) — وإلا null للمراجعة
  echoCustomer(msg, contacts = [], biz = null) {
    const to = msg?.to ? normalizePhone(msg.to) : null;
    if (to && to !== biz) return to;
    const c = (contacts || [])
      .map((x) => (x?.wa_id ? normalizePhone(x.wa_id) : null))
      .find((n) => n && n !== biz);
    return c || null;
  },

  extractText(msg, contacts = [], from = "") {
    const text =
      msg.text?.body ||
      msg.button?.text ||
      msg.interactive?.button_reply?.title ||
      msg.interactive?.button_reply?.id ||
      msg.interactive?.list_reply?.title ||
      "";
    const buttonId = msg.interactive?.button_reply?.id || msg.interactive?.list_reply?.id || null;
    const name = contacts.find((c) => c.wa_id === from)?.profile?.name || from;
    return { text, buttonId, name };
  },

  extractMedia(msg) {
    if ((msg.type === "audio" || msg.audio?.id)) {
      return { kind: "audio", id: msg.audio?.id || null, mimeType: null, caption: "" };
    }
    if (msg.type === "image" || msg.image?.id || msg.type === "document" || msg.document?.id) {
      return {
        kind: msg.type === "document" || msg.document?.id ? "document" : "image",
        id: msg.image?.id || msg.document?.id || null,
        mimeType: msg.document?.mime_type || "image/jpeg",
        caption: msg.image?.caption || msg.document?.caption || msg.document?.filename || "",
      };
    }
    return null;
  },

  normalizeSender(rawFrom) {
    return normalizePhone(rawFrom);
  },

  sendText(to, text, tenant) {
    return sendWhatsAppMessage(to, text, tenant);
  },
  sendButtons(to, text, buttons, tenant) {
    return sendButtons(to, text, buttons, tenant);
  },
  sendImage(to, link, caption, tenant) {
    return sendImage(to, link, caption, tenant);
  },
};
