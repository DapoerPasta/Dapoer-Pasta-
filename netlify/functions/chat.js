exports.handler = async function(event, context) {
  if (event.httpMethod !== 'POST') return { statusCode: 405, body: 'Method Not Allowed' }; 
  
  try {
    const body = JSON.parse(event.body); 
    const userMessage = body.message; 
    
    // Mengambil kunci rahasia baru Anda dari Netlify
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : ""; 
    
    if (!apiKey) {
      return { statusCode: 200, body: JSON.stringify({ reply: "Sistem: Kunci API belum terbaca." }) }; 
    } 
    
    const gabunganPesan = "Kamu adalah asisten restoran online bernama Dapoer Pasta. Menu andalan: Chicken Pop Corn 250gr (37k), Chicken Cordon Blue (37k), Mini Wonton (37k), Pasta Brulee Oval (27k), Pasta Brulee Persegi (32k). Halal, tanpa pengawet. Pemesanan via pre-order WhatsApp. Jawab pelanggan dengan ramah, luwes, singkat, dan gunakan emoji.\n\nPesan dari pelanggan: " + userMessage; 
    
    // Format link diperbarui ke gemini-1.5-flash-latest
    const apiUrl = `https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent?key=${apiKey}`; 
    
    const response = await fetch(apiUrl, {
      method: 'POST', 
      headers: { 'Content-Type': 'application/json' }, 
      body: JSON.stringify({
        contents: [{ parts: [{ text: gabunganPesan }] }] 
      }) 
    }); 
    
    const data = await response.json(); 
    
    if (!response.ok || data.error) {
      let pesanError = data.error?.message || "Kesalahan server Google."; 
      return { statusCode: 200, body: JSON.stringify({ reply: "Error Google API: " + pesanError }) }; 
    } 
    
    const botReply = data.candidates[0].content.parts[0].text; 
    return { statusCode: 200, body: JSON.stringify({ reply: botReply }) }; 
    
  } catch (error) {
    return { statusCode: 200, body: JSON.stringify({ reply: "Error Sistem: " + error.message }) }; 
  } 
};
