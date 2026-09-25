# Dapoer Pasta

Storefront full-stack serverless untuk Dapoer Pasta.

## Stack

- Frontend: HTML, CSS, JavaScript vanilla
- Backend: Netlify Functions
- Data menu: JSON statis
- Checkout: WhatsApp
- Cart persistence: localStorage
- AI concierge: Gemini API melalui server-side function

Arsitektur ini sengaja tidak memakai database atau framework berat supaya mudah dirawat dan tetap cocok untuk paket gratis.

## Struktur

```text
.
├── index.html
├── css/
│   └── styles.css
├── js/
│   └── app.js
├── data/
│   └── menu.json
├── netlify/
│   └── functions/
│       └── chat.js
└── netlify.toml
```

## Menjalankan di Netlify

1. Hubungkan repository ini ke Netlify.
2. Publish directory: `.`
3. Functions directory sudah diatur di `netlify.toml`.
4. Tambahkan environment variable di Netlify:
   - `GEMINI_API_KEY`
   - opsional: `GEMINI_MODEL`
5. Deploy.

Jangan simpan API key di source code atau commit GitHub.

## Pengembangan lokal

Website tetap dapat dibuka sebagai static site, tetapi endpoint `/api/chat` memerlukan Netlify Functions.

Jika menggunakan Netlify CLI:

```bash
netlify dev
```

## Catatan keamanan

- Input chat dibatasi 500 karakter.
- Chat dirender dengan `textContent`, bukan HTML mentah.
- API key hanya dibaca dari environment variable server.
- Response error internal tidak diekspos ke pelanggan.
- Security headers diatur melalui `netlify.toml`.

## Biaya

Checkout WhatsApp, frontend statis, JSON menu, dan localStorage tidak memerlukan database berbayar. Penggunaan AI bergantung pada kuota/provider yang digunakan; jika kuota AI habis atau belum dikonfigurasi, storefront dan checkout tetap berfungsi.
