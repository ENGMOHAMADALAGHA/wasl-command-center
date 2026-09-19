// محوّل ماسنجر الكامل — Messenger Platform عبر Graph API.
// المطلوب لكل بوت: features.messengerPageId + features.messengerToken (مشفر enc:v1)
// أو env للتطوير: MESSENGER_PAGE_TOKEN. الاشتراك بنفس verifyToken الخاص بالبوت.
import { decryptSecret } from "../security/secrets.mjs";
import { MESSENGER_PAGE_TOKEN } from "../config/env.mjs";

function pageToken(tenant) {
  try {
    if (tenant?.features?.messengerToken) return decryptSecret(tenant.features.messengerToken);
  } catch { /* رجوع للعام */ }
  return MESSENGER_PAGE_TOKEN || null;
}

async function graph(path, token, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
  try {
    const r = await fetch(`https://graph.facebook.com/v21.0${path}?access_token=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: ctrl.signal,
      body: JSON.stringify(body),
    });
    const data = await r.json().catch(() => ({}));
    if (!r.ok) {
      const err = new Error(data?.error?.message || `Meta HTTP ${r.status}`);
      err.status = r.status;
      err.code = data?.error?.code;
      throw err;
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

// أزرارنا {id,title} ← ردود سريعة (مدعومة ماسنجر + انستغرام، حتى 13 زراً، +3 نعرض)
export function toQuickReplies(buttons = []) {
  return (buttons || []).slice(0, 3).map((b) => ({
    content_type: "text",
    title: String(b.title || b.id).slice(0, 20),
    payload: String(b.id),
  }));
}

export const messengerChannel = {
  id: "messenger",
  supportsMedia: true,

  receiverId(value) {
    return value?.recipient?.id || null;
  },

  extractText(msg) {
    // msg = messaging.messaging[] عنصر واحد: message / postback
    const m = msg?.message || {};
    const text = m.text || msg?.postback?.title || msg?.postback?.payload || "";
    const buttonId = msg?.postback?.payload || null;
    const name = `${msg?.senderName || ""}`.trim() || "زائر ماسنجر";
    return { text, buttonId, name };
  },

  extractMedia(msg) {
    const atts = msg?.message?.attachments || [];
    const a = atts[0];
    if (!a) return null;
    if (a.type === "audio" && a.payload?.url) {
      return { kind: "audio", id: a.payload.url, mimeType: null, caption: "" };
    }
    if ((a.type === "image" || a.type === "file") && a.payload?.url) {
      return {
        kind: a.type === "file" ? "document" : "image",
        id: a.payload.url,
        mimeType: null,
        caption: msg?.message?.text || "",
      };
    }
    return null;
  },

  normalizeSender(psid) {
    return `msg:${psid}`;
  },

  async sendText(to, text, tenant) {
    const token = pageToken(tenant);
    if (!token) throw Object.assign(new Error("لا توكن ماسنجر لهذا البوت (features.messengerToken)"), { code: "NO_CHANNEL_TOKEN" });
    const psid = String(to).replace(/^msg:/, "");
    return graph("/me/messages", token, {
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: { text: String(text).slice(0, 2000) },
    });
  },

  async sendButtons(to, text, buttons, tenant) {
    const token = pageToken(tenant);
    if (!token) throw Object.assign(new Error("لا توكن ماسنجر لهذا البوت (features.messengerToken)"), { code: "NO_CHANNEL_TOKEN" });
    const psid = String(to).replace(/^msg:/, "");
    return graph("/me/messages", token, {
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: { text: String(text).slice(0, 2000), quick_replies: toQuickReplies(buttons) },
    });
  },

  async sendImage(to, link, caption, tenant) {
    const token = pageToken(tenant);
    if (!token) throw Object.assign(new Error("لا توكن ماسنجر لهذا البوت (features.messengerToken)"), { code: "NO_CHANNEL_TOKEN" });
    const psid = String(to).replace(/^msg:/, "");
    await graph("/me/messages", token, {
      recipient: { id: psid },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "image", payload: { url: link, is_reusable: true } } },
    });
    if (caption) {
      return graph("/me/messages", token, {
        recipient: { id: psid },
        messaging_type: "RESPONSE",
        message: { text: String(caption).slice(0, 2000) },
      });
    }
    return { ok: true };
  },
};
