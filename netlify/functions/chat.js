exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body);
        const userMessage = body.message;
        
        // KITA TANAM KUNCINYA LANGSUNG DI SERVER BACKEND (100% AMAN & RAHASIA)
        const apiKey = "AQ.Ab8RN6JIFBKjzuZYGBSKt4-0eEdj0Ehj2hp4ZEYMgpA1V-PoRw";

        const gabunganPesan = "Kamu adalah asisten restoran online bernama Dapoer Pasta. Menu andalan: Chicken Pop Corn 250gr (37k), Chicken Cordon Blue (37k), Mini Wonton (37k), Pasta Brulee Oval (27k), Pasta Brulee Persegi (32k). Halal, tanpa pengawet. Pemesanan via pre-order WhatsApp. Jawab pelanggan dengan ramah, singkat, dan gunakan emoji.\n\nPesan dari pelanggan: " + userMessage;
        
        // MENGGUNAKAN LINK STANDAR GOOGLE
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`;
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: gabunganPesan }] }]
            })
        });

        const data = await response.json();

        if (!response.ok || data.error) {
            let pesanError = data.error?.message || "Terjadi kesalahan pada server Google.";
            return { statusCode: 200, body: JSON.stringify({ reply: "Error Google API: " + pesanError }) };
        }

        const botReply = data.candidates[0].content.parts[0].text;
        return { statusCode: 200, body: JSON.stringify({ reply: botReply }) };

    } catch (error) {
        return { statusCode: 200, body: JSON.stringify({ reply: "Error Sistem: " + error.message }) };
    }
};
