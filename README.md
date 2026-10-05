# Dapoer Pasta — Full Stack Serverless v3

Website Dapoer Pasta berjalan di Vercel dengan frontend statis, Vercel Functions, Neon Postgres, checkout WhatsApp, dan dashboard admin private.

## Fitur

- Menu dinamis dari backend
- Keranjang belanja localStorage
- Checkout form: nama, WhatsApp, alamat, pembayaran, catatan
- Harga dan total dihitung ulang di backend
- Pesanan disimpan ke Postgres
- Nomor order unik
- Checkout diteruskan ke WhatsApp
- Dashboard private di `/admin/`
- Status pesanan: baru, diproses, dikirim, selesai, dibatalkan
- Chatbot Gemini via backend
- Security headers melalui `vercel.json`

## Arsitektur

```text
Customer
   ↓
Website + Cart
   ↓
Checkout Form
   ↓
POST /api/order
   ├─ validasi customer
   ├─ validasi produk dan quantity
   ├─ hitung ulang total
   ├─ simpan ke Neon Postgres
   └─ buat URL WhatsApp

Admin
   ↓
/admin/
   ↓
Login private
   ↓
HttpOnly signed session cookie
   ↓
/api/admin/orders
   ↓
Neon Postgres
```

## Environment Variables

Atur di Vercel Project Settings → Environment Variables:

```text
DATABASE_URL=
ADMIN_EMAIL=
ADMIN_PASSWORD=
ADMIN_SESSION_SECRET=
GEMINI_API_KEY=
GEMINI_MODEL=gemini-2.5-flash-lite
```

Gunakan password admin yang kuat dan isi `ADMIN_SESSION_SECRET` dengan string acak panjang. Jangan commit nilai secret ke GitHub.

## Database

Project memakai `@neondatabase/serverless`. Tabel `orders` dibuat otomatis ketika database pertama kali dipakai.

Data order yang disimpan:
- nomor order
- nama customer
- nomor WhatsApp
- alamat
- catatan
- metode pembayaran
- item pesanan
- total
- status
- waktu dibuat / diperbarui

## Admin Dashboard

Buka:

```text
/admin/
```

Dashboard tidak menampilkan data tanpa session admin yang valid.

## Catatan

Website publik tidak membutuhkan akun customer. Customer tetap checkout langsung dan dilanjutkan ke WhatsApp setelah order divalidasi oleh backend.
