exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body);
        const userMessage = body.message;
        
        // Membersihkan kunci dari spasi yang tidak sengaja terbawa
        const rawApiKey = process.env.GEMINI_API_KEY || "";
        const apiKey = rawApiKey.trim();

        if (!apiKey) {
            return { statusCode: 200, body: JSON.stringify({ reply: "Sistem: Kunci API belum terbaca oleh Netlify." }) };
        }

        const gabunganPesan = "Kamu adalah asisten restoran online bernama Dapoer Pasta. Menu andalan: Chicken Pop Corn 250gr (37k), Chicken Cordon Blue (37k), Mini Wonton (37k), Pasta Brulee Oval (27k), Pasta Brulee Persegi (32k). Halal, tanpa pengawet. Pemesanan via pre-order WhatsApp. Jawab pelanggan dengan ramah, luwes, singkat, dan gunakan emoji.\n\nPesan dari pelanggan: " + userMessage;
        
        // LINK BERSIH: Kita menggunakan model paling canggih v1beta, tanpa kunci API di dalamnya
        const apiUrl = "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent";
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 
                'Content-Type': 'application/json',
                'x-goog-api-key': apiKey // KUNCI API DIKIRIM LEWAT JALUR RAHASIA INI
            },
            body: JSON.stringify({
                contents: [{ parts: [{ text: gabunganPesan }] }]
            })
        });

        const data = await response.json();

        // Menangkap error jika Google masih menolak
        if (!response.ok || data.error) {
            let pesanError = data.error?.message || "Kesalahan tidak dikenal pada server Google.";
            return { statusCode: 200, body: JSON.stringify({ reply: "Error Google API: " + pesanError }) };
        }

        // Jika berhasil, kirim balasan ke pelanggan
        const botReply = data.candidates[0].content.parts[0].text;
        return { statusCode: 200, body: JSON.stringify({ reply: botReply }) };

    } catch (error) {
        return { statusCode: 200, body: JSON.stringify({ reply: "Error Sistem: " + error.message }) };
    }
};
