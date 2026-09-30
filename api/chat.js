const { buildMenuContext } = require("./_lib/catalog");

function sanitizeMessage(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500);
}

module.exports = async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ reply: "Metode tidak diizinkan." });
  }

  const message = sanitizeMessage(req.body?.message || req.body?.text || req.body?.chat);
  if (!message) return res.status(400).json({ reply: "Silakan tulis pertanyaan terlebih dahulu." });

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";
  if (!apiKey) {
    return res.status(503).json({ reply: "Chatbot belum diaktifkan. Silakan hubungi WhatsApp Dapoer Pasta untuk pemesanan." });
  }

  try {
    const endpoint = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
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
      return res.status(502).json({ reply: "Maaf, layanan chat sedang tidak tersedia. Silakan hubungi WhatsApp Dapoer Pasta." });
    }

    const reply = data?.candidates?.[0]?.content?.parts?.map((p) => p?.text || "").join("").trim();
    return res.status(200).json({ reply: reply || "Maaf, saya belum mendapat jawaban. Silakan hubungi WhatsApp Dapoer Pasta." });
  } catch (error) {
    console.error("Chat function failed", error);
    return res.status(500).json({ reply: "Maaf, asisten sedang sibuk. Silakan hubungi WhatsApp Dapoer Pasta." });
  }
};
