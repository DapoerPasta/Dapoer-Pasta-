const STORE = Object.freeze({
  name: "Dapoer Pasta",
  whatsapp: "6285175391181",
  instagram: "Dapoer.Pasta",
  paymentMethods: ["OVO", "ShopeePay", "DANA"]
});

const PRODUCTS = Object.freeze([
  Object.freeze({id:"chicken-pop-corn-250gr",name:"Chicken pop corn 250gr",price:37000,image:"/8.png",badge:"Casa",description:"Ayam pilihan dengan tekstur renyah, praktis untuk dinikmati kapan saja."}),
  Object.freeze({id:"chicken-cordon-blue-7pcs",name:"Chicken Cordon Blue 7 pcs",price:37000,image:"/9.png",badge:"Signature",description:"Ayam dengan smoked beef dan mozzarella, gurih dengan bagian dalam yang creamy."}),
  Object.freeze({id:"mini-wonton-250gr",name:"Mini wonton 250gr",price:37000,image:"/7 m.png",badge:"Croccante",description:"Mini wonton berisi ayam dan udang dengan sensasi renyah yang menggugah selera."}),
  Object.freeze({id:"pasta-brulee-oval-2pcs",name:"Pasta brulee oval 2 pcs",price:27000,image:"/10.png",badge:"Brûlée",description:"Pasta creamy dengan ayam dan keju leleh dalam porsi oval yang praktis."}),
  Object.freeze({id:"pasta-brulee-persegi-2pcs",name:"Pasta brulee persegi 2 pcs",price:32000,image:"/11.png",badge:"Signature",description:"Pasta creamy dengan ayam dan keju leleh dalam porsi persegi yang lebih mantap."})
]);

function buildMenuContext() {
  const menu = PRODUCTS.map((p) => `- ${p.name} — Rp ${p.price.toLocaleString("id-ID")}`).join("\n");
  return `Kamu adalah Concierge Dapoer Pasta, asisten restoran online Dapoer Pasta.
Jawab dalam Bahasa Indonesia yang ramah, hangat, singkat, profesional, dan luwes. Emoji boleh digunakan secukupnya.
Jangan mengarang stok, promo, ongkir, alamat, sertifikasi, atau informasi yang tidak tersedia.
Jika pertanyaan memerlukan informasi yang tidak tersedia, arahkan pelanggan untuk menghubungi WhatsApp Dapoer Pasta.

Menu Dapoer Pasta:
${menu}

Informasi toko:
- Halal Indonesia
- Tanpa pengawet
- Homemade
- Pemesanan via pre-order WhatsApp
- Pembayaran: ${STORE.paymentMethods.join(", ")}`;
}

module.exports = { STORE, PRODUCTS, buildMenuContext };
