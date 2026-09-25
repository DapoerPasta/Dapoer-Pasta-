# Dapoer Pasta — Full Stack Serverless

Website Dapoer Pasta dengan frontend modular dan backend Netlify Functions. Dibuat agar tetap ringan dan cocok untuk paket gratis.

## Yang dipertahankan

- WhatsApp: `6285175391181`
- Instagram: `@Dapoer.Pasta`
- Foto produk: `8.png`, `9.png`, `7 m.png`, `10.png`, `11.png`
- Harga seluruh menu
- Chatbot berbasis Gemini melalui Netlify Function
- Checkout langsung ke WhatsApp

## Struktur

```text
.
├── index.html
├── assets/
│   ├── css/style.css
│   └── js/app.js
├── netlify/
│   └── functions/
│       ├── menu.js
│       └── chat.js
├── netlify.toml
└── .env.example
```

## Backend

- `/.netlify/functions/menu` menyajikan data toko dan menu.
- `/.netlify/functions/chat` menangani chatbot Gemini di sisi server.
- API key tidak disimpan di frontend atau repository.

## Netlify

Tambahkan Environment Variables:

```text
GEMINI_API_KEY=API_KEY_BARU_ANDA
GEMINI_MODEL=gemini-2.5-flash-lite
```

API key lama yang pernah disimpan di repository public harus di-revoke/rotate sebelum deploy.

## Biaya

Website tidak membutuhkan database atau VPS. Frontend, keranjang lokal, checkout WhatsApp, dan Netlify Functions dapat dipakai dengan arsitektur free-tier. Penggunaan chatbot mengikuti kuota API Gemini yang tersedia pada akun Anda.
