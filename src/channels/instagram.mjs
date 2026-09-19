// محوّل انستغرام الكامل — Instagram Messaging API (نفس بروتوكول ماسنجر).
// المطلوب لكل بوت: features.instagramId + features.instagramToken (مشفر enc:v1)
// أو env للتطوير: INSTAGRAM_PAGE_TOKEN. ملاحظة: انستغرام لا يدعم الأزرار
// المضمنة — تُرسل ردوداً سريعة (quick_replies) مثل ماسنجر.
import { decryptSecret } from "../security/secrets.mjs";
import { INSTAGRAM_PAGE_TOKEN } from "../config/env.mjs";
import { toQuickReplies } from "./messenger.mjs";

function igToken(tenant) {
  try {
    if (tenant?.features?.instagramToken) return decryptSecret(tenant.features.instagramToken);
  } catch { /* رجوع للعام */ }
  return INSTAGRAM_PAGE_TOKEN || null;
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

export const instagramChannel = {
  id: "instagram",
  supportsMedia: true,

  receiverId(value) {
    return value?.recipient?.id || null;
  },

  extractText(msg) {
    const m = msg?.message || {};
    const text = m.text || msg?.postback?.title || msg?.postback?.payload || "";
    const buttonId = msg?.postback?.payload || null;
    const name = "زائر انستغرام";
    return { text, buttonId, name };
  },

  extractMedia(msg) {
    const atts = msg?.message?.attachments || [];
    const a = atts[0];
    if (!a) return null;
    if (a.type === "audio" && a.payload?.url) {
      return { kind: "audio", id: a.payload.url, mimeType: null, caption: "" };
    }
    if ((a.type === "image" || a.type === "file" || a.type === "video") && a.payload?.url) {
      return {
        kind: a.type === "image" || a.type === "video" ? "image" : "document",
        id: a.payload.url,
        mimeType: null,
        caption: msg?.message?.text || "",
      };
    }
    if (a.type === "fallback" && a.payload?.url) {
      return { kind: "document", id: a.payload.url, mimeType: null, caption: "" };
    }
    return null;
  },

  normalizeSender(igsid) {
    return `ig:${igsid}`;
  },

  async sendText(to, text, tenant) {
    const token = igToken(tenant);
    if (!token) throw Object.assign(new Error("لا توكن انستغرام لهذا البوت (features.instagramToken)"), { code: "NO_CHANNEL_TOKEN" });
    const id = String(to).replace(/^ig:/, "");
    return graph("/me/messages", token, {
      recipient: { id },
      messaging_type: "RESPONSE",
      message: { text: String(text).slice(0, 2000) },
    });
  },

  async sendButtons(to, text, buttons, tenant) {
    const token = igToken(tenant);
    if (!token) throw Object.assign(new Error("لا توكن انستغرام لهذا البوت (features.instagramToken)"), { code: "NO_CHANNEL_TOKEN" });
    const id = String(to).replace(/^ig:/, "");
    return graph("/me/messages", token, {
      recipient: { id },
      messaging_type: "RESPONSE",
      message: { text: String(text).slice(0, 2000), quick_replies: toQuickReplies(buttons) },
    });
  },

  async sendImage(to, link, caption, tenant) {
    const token = igToken(tenant);
    if (!token) throw Object.assign(new Error("لا توكن انستغرام لهذا البوت (features.instagramToken)"), { code: "NO_CHANNEL_TOKEN" });
    const id = String(to).replace(/^ig:/, "");
    await graph("/me/messages", token, {
      recipient: { id },
      messaging_type: "RESPONSE",
      message: { attachment: { type: "image", payload: { url: link, is_reusable: true } } },
    });
    if (caption) {
      return graph("/me/messages", token, {
        recipient: { id },
        messaging_type: "RESPONSE",
        message: { text: String(caption).slice(0, 2000) },
      });
    }
    return { ok: true };
  },
};
