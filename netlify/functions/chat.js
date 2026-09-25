const DEFAULT_HEADERS = {
  "Content-Type": "application/json",
  "Cache-Control": "no-store"
};

const STORE_CONTEXT = `
Kamu adalah Concierge Dapoer Pasta, asisten toko makanan online.
Jawab dalam Bahasa Indonesia yang ramah, singkat, dan jelas.
Jangan mengarang harga, promo, alamat, stok, ongkir, sertifikasi, atau kebijakan yang tidak diberikan.
Jika informasi tidak tersedia, arahkan pelanggan untuk menghubungi admin WhatsApp.
Menu:
- Chicken Pop Corn 250gr — Rp37.000
- Chicken Cordon Bleu 7 pcs — Rp37.000
- Mini Wonton 250gr — Rp37.000
- Pasta Brulee Oval 2 pcs — Rp27.000
- Pasta Brulee Persegi 2 pcs — Rp32.000
Pembayaran: OVO, ShopeePay, DANA.
Pemesanan: pre-order melalui WhatsApp.
`.trim();

function json(statusCode, payload, extraHeaders = {}) {
  return {
    statusCode,
    headers: { ...DEFAULT_HEADERS, ...extraHeaders },
    body: JSON.stringify(payload)
  };
}

function cleanMessage(value) {
  if (typeof value !== "string") return "";
  return value.replace(/[\u0000-\u001F\u007F]/g, " ").trim().slice(0, 500);
}

exports.handler = async function handler(event) {
  if (event.httpMethod !== "POST") {
    return json(405, { reply: "Method not allowed." }, { Allow: "POST" });
  }

  let body;
  try {
    body = JSON.parse(event.body || "{}");
  } catch {
    return json(400, { reply: "Format permintaan tidak valid." });
  }

  const message = cleanMessage(body.message);
  if (!message) {
    return json(400, { reply: "Silakan tulis pertanyaan terlebih dahulu." });
  }

  const apiKey = process.env.GEMINI_API_KEY;
  const model = process.env.GEMINI_MODEL || "gemini-2.5-flash-lite";

  if (!apiKey) {
    return json(503, {
      reply: "Chat AI belum diaktifkan. Untuk pemesanan, silakan hubungi WhatsApp Dapoer Pasta."
    });
  }

  try {
    const apiUrl =
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;

    const response = await fetch(apiUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        systemInstruction: {
          parts: [{ text: STORE_CONTEXT }]
        },
        contents: [
          {
            role: "user",
            parts: [{ text: message }]
          }
        ],
        generationConfig: {
          temperature: 0.4,
          maxOutputTokens: 250
        }
      })
    });

    const data = await response.json();

    if (!response.ok) {
      console.error("Gemini API error", response.status, data?.error?.message);
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
      reply: "Maaf, layanan chat sedang bermasalah. Silakan hubungi WhatsApp Dapoer Pasta."
    });
  }
};
