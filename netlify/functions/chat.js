const { buildMenuContext } = require("./_lib/catalog");

const HEADERS = {
  "Content-Type": "application/json; charset=utf-8",
  "Cache-Control": "no-store"
};

const json = (statusCode, payload, extraHeaders = {}) => ({
  statusCode,
  headers: { ...HEADERS, ...extraHeaders },
  body: JSON.stringify(payload)
});

function sanitizeMessage(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500);
}

exports.handler = async function handler(event) {
  if (event.httpMethod === "OPTIONS") {
    return { statusCode: 204, headers: { ...HEADERS, Allow: "POST, OPTIONS" }, body: "" };
  }

  if (event.httpMethod !== "POST") {
    return json(405, { reply: "Metode tidak diizinkan." }, { Allow: "POST, OPTIONS" });
  }

  let payload;
  try {
    payload = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { reply: "Format pesan tidak valid." });
  }

  const message = sanitizeMessage(payload.message || payload.text || payload.chat);
  if (!message) return json(400, { reply: "Silakan tulis pertanyaan terlebih dahulu." });

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

  if (!apiKey) {
    return json(503, {
      reply: "Chatbot belum diaktifkan. Silakan hubungi WhatsApp Dapoer Pasta untuk pemesanan."
    });
  }

  try {
    const endpoint =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: { parts: [{ text: buildMenuContext() }] },
        contents: [{ role: "user", parts: [{ text: message }] }],
        generationConfig: { temperature: 0.45, maxOutputTokens: 260 }
      })
    });

    const data = await response.json();

    if (!response.ok || data.error) {
      console.error("Gemini error", response.status, data?.error?.message);
      return json(502, {
        reply: "Maaf, layanan chat sedang tidak tersedia. Silakan hubungi WhatsApp Dapoer Pasta."
      });
    }

    const reply = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("")
      .trim();

    return json(200, {
      reply:
        reply ||
        "Maaf, saya belum mendapat jawaban. Silakan hubungi WhatsApp Dapoer Pasta."
    });
  } catch (error) {
    console.error("Chat function failed", error);
    return json(500, {
      reply: "Maaf, asisten sedang sibuk. Silakan hubungi WhatsApp Dapoer Pasta."
    });
  }
};
