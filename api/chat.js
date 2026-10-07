const { buildMenuContext } = require("./_lib/catalog");
const { guardRequest } = require("./_lib/security");

function sanitizeMessage(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function shouldRetry(status) {
  return status === 408 || status === 429 || status >= 500;
}

async function callGemini({ apiKey, model, message }) {
  const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
  const delays = [0, 900, 1900];

  for (let attempt = 0; attempt < delays.length; attempt += 1) {
    if (delays[attempt]) {
      const jitter = Math.floor(Math.random() * 250);
      await sleep(delays[attempt] + jitter);
    }

    let response;
    let data;

    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": apiKey
        },
        signal: AbortSignal.timeout(10000),
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: buildMenuContext() }] },
          contents: [{ role: "user", parts: [{ text: message }] }],
          generationConfig: {
            maxOutputTokens: 512,
            thinkingConfig: { thinkingLevel: "low" }
          }
        })
      });

      data = await response.json();
    } catch (error) {
      if (attempt < delays.length - 1) continue;
      throw error;
    }

    if (response.ok && !data?.error) return data;

    console.error("Gemini request rejected", {
      status: response.status,
      model,
      attempt: attempt + 1,
      code: data?.error?.code || null,
      message: data?.error?.message || null,
      statusText: data?.error?.status || null
    });

    if (!shouldRetry(response.status) || attempt === delays.length - 1) {
      const error = new Error("GEMINI_REQUEST_FAILED");
      error.status = response.status;
      throw error;
    }
  }

  throw new Error("GEMINI_REQUEST_FAILED");
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (!(await guardRequest(req, res, { scope: "chat", methods: ["POST"] }))) return;

  const message = sanitizeMessage(req.body?.message || req.body?.text || req.body?.chat);
  if (!message) {
    return res.status(400).json({ reply: "Silakan tulis pertanyaan terlebih dahulu." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-3.8-flash";

  if (!apiKey) {
    return res.status(503).json({
      reply: "Chatbot belum diaktifkan. Silakan hubungi WhatsApp Dapoer Pasta untuk pemesanan."
    });
  }

  try {
    const data = await callGemini({ apiKey, model, message });
    const reply = data?.candidates?.[0]?.content?.parts
      ?.map((part) => part?.text || "")
      .join("")
      .trim();

    return res.status(200).json({
      reply: reply || "Maaf, saya belum mendapat jawaban. Silakan hubungi WhatsApp Dapoer Pasta."
    });
  } catch (error) {
    console.error("Chat function failed", {
      model,
      name: error?.name || "Error",
      message: error?.message || "Unknown error",
      status: error?.status || null
    });

    return res.status(502).json({
      reply: "Maaf, layanan chat sedang sibuk. Silakan coba lagi beberapa detik."
    });
  }
};
