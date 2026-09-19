exports.handler = async function(event, context) {
    if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body);
        const userMessage = body.message;
        const apiKey = process.env.GEMINI_API_KEY;

        const systemPrompt = "Kamu adalah asisten restoran online bernama Dapoer Pasta. Menu andalan: Chicken Pop Corn 250gr (37k), Chicken Cordon Blue (37k), Mini Wonton (37k), Pasta Brulee Oval (27k), Pasta Brulee Persegi (32k). Halal, tanpa pengawet. Pemesanan via pre-order WhatsApp. Jawab pelanggan dengan singkat, luwes, natural, dan ramah menggunakan emoji.";
        
        const response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash:generateContent?key=${apiKey}`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                system_instruction: { parts: [{ text: systemPrompt }] },
                contents: [{ parts: [{ text: userMessage }] }]
            })
        });

        const data = await response.json();
        const botReply = data.candidates[0].content.parts[0].text;

        return { statusCode: 200, body: JSON.stringify({ reply: botReply }) };
    } catch (error) {
        return { statusCode: 500, body: JSON.stringify({ error: 'Gagal merespons' }) };
    }
};
