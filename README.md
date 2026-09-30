# Dapoer Pasta — Full Stack Serverless v2

Website Dapoer Pasta menggunakan frontend modular dan backend Netlify Functions. Arsitektur dibuat ringan agar tetap cocok untuk paket gratis.

## Yang dipertahankan

- WhatsApp: `6285175391181`
- Instagram: `@Dapoer.Pasta`
- Foto produk: `8.png`, `9.png`, `7 m.png`, `10.png`, `11.png`
- Harga seluruh menu
- Chatbot Gemini
- Checkout ke WhatsApp
- Gaya visual Italia profesional

## Arsitektur

```text
Browser
  │
  ├─ GET  /.netlify/functions/menu
  │       └─ katalog resmi server
  │
  ├─ POST /.netlify/functions/order
  │       ├─ validasi ID produk
  │       ├─ validasi jumlah
  │       ├─ hitung ulang harga server-side
  │       └─ hasilkan URL checkout WhatsApp
  │
  └─ POST /.netlify/functions/chat
          └─ Gemini API melalui secret server-side
```

## Satu sumber data

Menu, harga, data toko, dan konteks chatbot berasal dari:

`netlify/functions/_lib/catalog.js`

Frontend tidak menjadi sumber kebenaran untuk harga.

## Keamanan

- `GEMINI_API_KEY` hanya dibaca dari Netlify Environment Variables.
- Input chatbot dibatasi dan disanitasi.
- Order dihitung ulang di backend agar manipulasi harga di browser tidak dipercaya.
- Security headers diatur melalui `netlify.toml`.

## Environment Variables

```text
GEMINI_API_KEY=API_KEY_BARU_ANDA
GEMINI_MODEL=gemini-2.5-flash-lite
```

## Catatan

Cart tetap disimpan lokal di browser agar tidak memerlukan database berbayar. Order belum disimpan permanen di server; setelah divalidasi backend, pengguna diarahkan ke WhatsApp untuk menyelesaikan pemesanan.
