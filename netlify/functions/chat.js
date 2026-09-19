exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body);
        const userMessage = body.message;
        const apiKey = process.env.GEMINI_API_KEY;

        // Cek apakah API Key terbaca oleh sistem
        if (!apiKey) {
            return { statusCode: 200, body: JSON.stringify({ reply: "Sistem: Kunci API belum terbaca oleh Netlify." }) };
        }

        // Kepribadian dan pengetahuan Bot
        const systemPrompt = "Kamu adalah asisten restoran online bernama Dapoer Pasta. Menu andalan: Chicken Pop Corn 250gr (37k), Chicken Cordon Blue (37k), Mini Wonton (37k), Pasta Brulee Oval (27k), Pasta Brulee Persegi (32k). Halal, tanpa pengawet. Pemesanan via pre-order WhatsApp. Jawab pelanggan dengan singkat, luwes, natural, dan ramah menggunakan emoji.";
        
        // Memanggil API Gemini (Dengan format systemInstruction yang benar)
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                systemInstruction: { parts: [{ text: systemPrompt }] },
                contents: [{ parts: [{ text: userMessage }] }]
            })
        });

        const data = await response.json();

        // Jika API Gemini menolak/error (misal kuota habis)
        if (!response.ok || data.error) {
            return { statusCode: 200, body: JSON.stringify({ reply: "Maaf, sistem asisten AI sedang ada pemeliharaan. Silakan hubungi via WhatsApp ya! 🙏" }) };
        }

        // Ambil balasan dan kirim ke pelanggan
        const botReply = data.candidates[0].content.parts[0].text;
        return { statusCode: 200, body: JSON.stringify({ reply: botReply }) };

    } catch (error) {
        // Jika kode gagal dieksekusi, berikan balasan ini (Bukan "undefined")
        return { statusCode: 200, body: JSON.stringify({ reply: "Waduh, koneksi asisten terputus nih. Langsung chat admin via WhatsApp aja ya! 😅" }) };
    }
};
