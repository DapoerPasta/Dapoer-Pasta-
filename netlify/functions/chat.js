const MENU_CONTEXT=`
Kamu adalah Concierge Dapoer Pasta, asisten restoran online Dapoer Pasta.
Jawab dalam Bahasa Indonesia yang ramah, hangat, singkat, profesional, dan luwes. Emoji boleh digunakan secukupnya.
Jangan mengarang stok, promo, ongkir, alamat, sertifikasi, atau informasi yang tidak tersedia.
Jika pertanyaan memerlukan informasi yang tidak tersedia, arahkan pelanggan untuk menghubungi WhatsApp Dapoer Pasta.

Menu Dapoer Pasta:
- Chicken pop corn 250gr — Rp 37.000
- Chicken Cordon Blue 7 pcs — Rp 37.000
- Mini wonton 250gr — Rp 37.000
- Pasta brulee oval 2 pcs — Rp 27.000
- Pasta brulee persegi 2 pcs — Rp 32.000

Informasi toko:
- Halal Indonesia
- Tanpa pengawet
- Homemade
- Pemesanan via pre-order WhatsApp
- Pembayaran: OVO, ShopeePay, DANA
`;
const headers={"Content-Type":"application/json; charset=utf-8","Cache-Control":"no-store"};
const json=(statusCode,payload,extraHeaders={})=>({statusCode,headers:{...headers,...extraHeaders},body:JSON.stringify(payload)});
function sanitizeMessage(value){if(typeof value!=="string")return"";return value.replace(/[\u0000-\u001F\u007F]/g," ").trim().slice(0,500)}
exports.handler=async function(event){
if(event.httpMethod==="OPTIONS")return{statusCode:204,headers:{...headers,Allow:"POST, OPTIONS"},body:""};
if(event.httpMethod!=="POST")return json(405,{reply:"Metode tidak diizinkan."},{Allow:"POST, OPTIONS"});
let payload;try{payload=JSON.parse(event.body||"{}")}catch{return json(400,{reply:"Format pesan tidak valid."})}
const message=sanitizeMessage(payload.message||payload.text||payload.chat);if(!message)return json(400,{reply:"Silakan tulis pertanyaan terlebih dahulu."});
const apiKey=process.env.GEMINI_API_KEY;const model=process.env.GEMINI_MODEL||"gemini-2.5-flash-lite";
if(!apiKey)return json(503,{reply:"Chatbot belum diaktifkan. Silakan hubungi WhatsApp Dapoer Pasta untuk pemesanan."});
try{
const endpoint=`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
const response=await fetch(endpoint,{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({systemInstruction:{parts:[{text:MENU_CONTEXT}]},contents:[{role:"user",parts:[{text:message}]}],generationConfig:{temperature:.45,maxOutputTokens:260}})});
const data=await response.json();
if(!response.ok||data.error){console.error("Gemini error",response.status,data?.error?.message);return json(502,{reply:"Maaf, layanan chat sedang tidak tersedia. Silakan hubungi WhatsApp Dapoer Pasta."})}
const reply=data?.candidates?.[0]?.content?.parts?.map(p=>p?.text||"").join("").trim();
return json(200,{reply:reply||"Maaf, saya belum mendapat jawaban. Silakan hubungi WhatsApp Dapoer Pasta."});
}catch(error){console.error("Chat function failed",error);return json(500,{reply:"Maaf, asisten sedang sibuk. Silakan hubungi WhatsApp Dapoer Pasta."})}
};