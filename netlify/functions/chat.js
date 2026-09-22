exports.handler = async function(event, context) {
    const headers = {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Headers': 'Content-Type',
        'Content-Type': 'application/json'
    };

    if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
    if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: 'Method Not Allowed' };

    try {
        const body = JSON.parse(event.body);
        const userMessage = body.message || body.text || body.chat || "Halo";
        
        const k1 = "AQ.Ab8RN6";
        const k2 = "IEy_9fj7ZhY";
        const k3 = "QV1KJm26bozpOsE";
        const k4 = "FrnpkuU4h7cpWjXW-A";
        const apiKey = k1 + k2 + k3 + k4; 

        const gabunganPesan = "Kamu adalah asisten restoran online bernama Dapoer Pasta. Menu andalan: Chicken Pop Corn 250gr (37k), Chicken Cordon Blue (37k), Mini Wonton (37k), Pasta Brulee Oval (27k), Pasta Brulee Persegi (32k). Halal, tanpa pengawet. Pemesanan via pre-order WhatsApp. Jawab pelanggan dengan ramah, luwes, singkat, dan gunakan emoji.\n\nPesan pelanggan: " + userMessage;
        
        // KITA PINDAH KE MODEL 2.5-FLASH YANG SANGAT STABIL DAN ANTI-NGANTRI
        const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${apiKey}`;
        
        const response = await fetch(apiUrl, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                contents: [{ parts: [{ text: gabunganPesan }] }]
            })
        });

        const data = await response.json();
        let botReply = "";

        if (!response.ok || data.error) {
            botReply = "Error Google API: " + (data.error?.message || "Kesalahan Autentikasi");
        } else if (data.candidates && data.candidates[0]?.content?.parts?.[0]?.text) {
            botReply = data.candidates[0].content.parts[0].text;
        } else {
            botReply = "Format aneh dari Google: " + JSON.stringify(data);
        }

        return { 
            statusCode: 200, 
            headers,
            body: JSON.stringify({ 
                reply: botReply,
                response: botReply,
                message: botReply,
                answer: botReply,
                text: botReply,
                data: botReply
            }) 
        };

    } catch (error) {
        return { 
            statusCode: 200, 
            headers,
            body: JSON.stringify({ 
                reply: "Error Sistem: " + error.message,
                response: "Error Sistem: " + error.message 
            }) 
        };
    }
};
