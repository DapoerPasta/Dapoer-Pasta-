# Dapoer Pasta — Full Stack Serverless v3

Website Dapoer Pasta berjalan di Vercel dengan frontend statis, Vercel Functions, Neon Postgres, checkout WhatsApp, dan dashboard admin private.

## Fitur

- Menu dinamis dari backend
- Stok setiap menu terlihat oleh pelanggan dan bisa ditambah / dikurangi admin
- Keranjang belanja localStorage
- Checkout form: nama, WhatsApp, alamat, pembayaran, catatan
- Harga dan total dihitung ulang di backend
- Pesanan disimpan ke Postgres
- Nomor order unik
- Nomor antrean harian WIB yang tersimpan pada setiap pesanan
- Struk customer thermal 58/80 mm, nota A4, dan unduhan PDF
- Checkout diteruskan ke WhatsApp
- Dashboard private di `/admin/`
- Riwayat pesanan per tanggal WIB, ringkasan harian, dan pemuatan halaman berikutnya
- Laporan keuangan harian, mingguan, bulanan, dan tahunan dengan pencatatan pengeluaran
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

Gunakan password admin minimal 12 karakter dan isi `ADMIN_SESSION_SECRET` dengan string acak minimal 32 karakter. Login ditolak jika konfigurasi ini belum memenuhi persyaratan. Jangan commit nilai secret ke GitHub. Untuk mengakhiri semua sesi admin yang sudah aktif, ganti `ADMIN_SESSION_SECRET` dan redeploy.

## Database

Project memakai `@neondatabase/serverless`. Tabel `orders` dibuat otomatis ketika database pertama kali dipakai.

Data order yang disimpan:
- nomor order
- nomor dan tanggal antrean WIB
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

## Stok Menu

Di `/admin/`, buka **Stok Menu**, lalu pilih tombol **Kelola stok** pada produk.
Satu jendela menyediakan **Tambah**, **Kurangi**, **Atur jumlah**, dan
**Kosongkan**. Tambah/Kurangi memakai jumlah selisih; misalnya stok saat ini 5,
memasukkan 3 pada Tambah menghasilkan stok 8. Atur jumlah memakai stok akhir;
memasukkan 3 menghasilkan stok 3. Perbandingan sebelum/sesudah dan penjelasan
input mengikuti pilihan tindakan. Persediaan tersimpan di tabel
`inventory` pada database Neon yang sama, bukan di browser admin.

Pada penggunaan pertama, seluruh stok dimulai dari **0**. Setelah deployment,
admin perlu memasukkan jumlah persediaan fisik sebenarnya. Produk dengan stok
0 tampil sebagai **Stok habis** dan tidak bisa ditambahkan ke keranjang.
Jumlah pesanan mengikuti satuan produk pada katalog (contoh: satu produk
“Pasta brulee oval 2 pcs” berarti satu paket berisi dua buah).

Menu pelanggan memuat stok terbaru tanpa cache, diperbarui setiap 15 detik
ketika halaman aktif, dan diperiksa kembali sebelum checkout. Dashboard stok
admin diperbarui setiap 10 detik; input penyesuaian tetap terjaga saat refresh.
Jika stok berubah, keranjang tetap tersedia agar pelanggan dapat memperbaiki
jumlahnya. Backend selalu memeriksa persediaan terbaru dan menolak checkout
yang tidak mencukupi dengan `409 INSUFFICIENT_STOCK`.

Stok berkurang ketika pesanan **berhasil disimpan**, sebelum pelanggan membuka
WhatsApp. Pengurangan semua produk dan penyimpanan pesanan dilakukan dalam
satu transaksi PostgreSQL dengan kunci baris, sehingga checkout bersamaan
tidak menjual stok yang sama dan kegagalan tidak mengurangi sebagian stok.
Jika pelanggan tidak melanjutkan konfirmasi, admin dapat membatalkan pesanan:
stok kembali tepat satu kali. Pesanan baru yang sudah dibatalkan tidak dapat
dibuka kembali; buat pesanan baru agar stok diperiksa ulang. Pesanan lama yang
dibuat sebelum fitur ini tidak mengurangi atau mengembalikan stok.

Endpoint Vercel `GET /api/menu` menyertakan `stock` untuk setiap produk.
`GET /api/admin/stock` dan `PATCH /api/admin/stock` (JSON `{ "id": "product-id",
"delta": 3 }`) memakai sesi admin yang sama. Nilai delta positif menambah
persediaan, nilai negatif mengurangi; saldo tidak bisa menjadi negatif.
Stok yang sudah dimasukkan tetap dapat diedit setiap saat. Di **Kelola stok**,
pilih **Atur jumlah**
untuk memasukkan jumlah akhir sesuai stok fisik (termasuk 0), lalu periksa
perbandingan sebelum/sesudah dan pilih **Simpan jumlah**. Pilih **Kosongkan**
untuk menghapus jumlah persediaan dengan konfirmasi. Menu tetap ada, ditandai
habis untuk pelanggan, dan bisa diisi kembali lewat Tambah atau Atur jumlah.
Mengosongkan stok tidak menghapus atau membatalkan pesanan yang sudah dibuat.

Pengaturan jumlah akhir memakai `PATCH /api/admin/stock` dengan JSON
`{ "id": "product-id", "stock": 0, "expectedStock": 5 }`. `stock` dan
`expectedStock` harus berupa bilangan bulat 0–1.000.000. Jumlah saat editor
dibuka dikirim sebagai `expectedStock`; jika pesanan atau admin lain sudah
mengubahnya, API mengembalikan `409 STOCK_CONFLICT` tanpa menimpa stok terbaru.
Dashboard memuat ulang persediaan dan meminta admin menutup lalu membuka
editor kembali untuk memeriksa jumlah terbaru. Input yang sedang diedit
tetap terjaga selama refresh otomatis dan saat berpindah pilihan tindakan.
Pratinjau Tambah/Kurangi mengikuti stok terbaru; Atur jumlah/Kosongkan tetap
memakai stok yang diperiksa saat jendela dibuka. Permintaan jumlah akhir tidak dapat
digabungkan dengan `delta`; format tambah/kurangi sebelumnya tetap berlaku.

Endpoint admin mempertahankan proteksi asal permintaan, JSON, ukuran payload,
dan pembatasan trafik. Fitur ini ditujukan untuk deployment Vercel yang
dijelaskan di atas; fungsi Netlify lama tidak menjalankan workflow stok ini.

Tabel `inventory`, kolom `orders.stock_reserved`, dan fungsi transaksi
`dapoer_save_order` / `dapoer_update_order_status` dibuat otomatis.
Role database harus dapat membuat / mengubah tabel, indeks, dan fungsi
PL/pgSQL di schema aplikasi, serta membaca dan memperbarui persediaan.
Tidak ada kredensial baru yang diperlukan.

Riwayat dibuka pada **hari ini menurut WIB (Asia/Jakarta)**. Pilih tanggal untuk melihat pesanan hari sebelumnya, atau gunakan tombol panah untuk berpindah hari. Pesanan lama tetap tersimpan di database. Tombol **Hari ini** mengaktifkan pergantian tanggal otomatis pada pukul 00.00 WIB; tanggal riwayat yang dipilih manual tetap ditampilkan sampai admin menggantinya.

Ringkasan menghitung seluruh pesanan pada tanggal pilihan. Daftar memuat 100 pesanan per halaman; tombol **Muat pesanan berikutnya** membuka sisanya. Pencarian dan filter status berlaku pada pesanan yang sudah dimuat. Refresh berkala mempertahankan halaman yang sudah dibuka. Memilih tanggal atau berganti hari tidak memicu notifikasi untuk pesanan lama.

API tetap menggunakan `GET /api/admin/orders`, dengan parameter opsional `date=YYYY-MM-DD`, `page=1`, dan `pageSize=100` (maksimal 200). Tanpa tanggal, API memakai hari ini dalam WIB. Indeks `orders_created_at_id_idx` dibuat otomatis untuk pencarian tanggal dan urutan halaman; tidak ada pesanan yang dihapus. URL dashboard, tracking, dan nota tetap sama. Loader dan stylesheet tambahan memastikan kontrol harian juga tersedia bagi browser yang masih menyimpan aset admin versi lama.

## Catatan

Website publik tidak membutuhkan akun customer. Customer tetap checkout langsung dan dilanjutkan ke WhatsApp setelah order divalidasi oleh backend.

## Pengamanan link publik di Vercel

Alamat beranda, dashboard, tracking, nota, endpoint API, parameter `id`/`token`, dan URL aset tetap sama. Nota yang dibuka tanpa sesi admin hanya menampilkan ringkasan transaksi. Nama, nomor WhatsApp, alamat, dan catatan pelanggan tidak dikirim melalui API publik; admin yang login dapat melihat data lengkap melalui link nota yang sama. Pembeli tetap menerima ringkasan pesanan, sementara admin menerima detail pengiriman lewat checkout WhatsApp dan dashboard.

API sensitif membatasi permintaan melalui tabel `security_rate_limits` di Neon. Tabel dan indeksnya dibuat otomatis menggunakan koneksi `DATABASE_URL` yang sama dengan pesanan. Counter diperbarui secara atomik sehingga batas tetap berlaku pada beberapa instance Vercel. Role database harus dapat membuat tabel/indeks dan menjalankan INSERT, UPDATE, SELECT, serta DELETE. Di produksi, jika database atau identitas IP dari Vercel tidak tersedia, API sensitif mengembalikan `503` sebelum menjalankan operasi. Penyimpanan counter di memori hanya berlaku untuk pengembangan lokal, bukan produksi.

| Operasi | Batas bawaan |
| --- | --- |
| Login admin | 10 per IP dan 8 per akun dalam 15 menit |
| Checkout | 10 per IP dalam 5 menit |
| Chatbot | 15 per IP per menit; 300 total per hari |
| Tracking | 60 per IP per menit |
| Nota | 30 per IP per menit |
| Perubahan status / logout | 60 per IP per menit |

Permintaan yang melampaui batas menerima `429` dengan header `Retry-After`. Batas dapat disesuaikan di `api/_lib/security.js`. POST/PATCH menolak asal browser yang berbeda, format selain JSON, dan payload di atas 16 KiB; logout tetap mendukung permintaan tanpa body.

Halaman/API pesanan dan admin menggunakan cache privat tanpa penyimpanan dan tidak diindeks. `no-referrer` mencegah token URL terkirim sebagai referer ke situs lain. Skrip QR yang URL-nya tetap sama memakai pemeriksaan integritas SRI. Aset baru harus divalidasi ulang oleh browser; stylesheet privasi tambahan memperbaiki overlay nota sekalipun CSS lama masih tersimpan di cache. Perlindungan data pribadi berlaku di backend, sehingga tetap aman ketika browser masih memakai JavaScript versi lama.

Sesudah perubahan di-deploy ke **project Vercel yang sama**, URL situs tetap sama. Konfigurasi secret produksi, akses Neon, dan respons deployment perlu diverifikasi sebelum menganggap pengamanan sudah aktif. Pembatasan aplikasi tidak menggantikan perlindungan trafik di Vercel Firewall; aktifkan perlindungan tambahan di sana sesuai kebutuhan trafik dan anggaran.

## Laporan Keuangan

Di `/admin/`, buka **Laporan Keuangan** untuk memilih periode harian,
mingguan (Senin–Minggu), bulanan, atau tahunan, beserta tanggal acuannya.
Semua periode memakai WIB. Ringkasan, grafik, perbandingan periode sebelumnya,
dan rincian metode pembayaran menghitung seluruh pesanan dalam periode,
termasuk data yang belum dimuat pada daftar riwayat pesanan.
Pilih format **PDF, Excel (.xlsx), OpenDocument (.ods), CSV, JSON, atau teks (.txt)**
lalu klik **Unduh laporan**. File Excel dan ODS dapat dibuka atau diimpor ke
Google Sheets. PDF memiliki tabel dengan judul berulang dan nomor halaman;
spreadsheet memakai beberapa lembar dengan angka yang bisa dihitung kembali.
Unduhan mencakup ringkasan, rincian per tanggal/bulan,
metode pembayaran, kategori biaya, dan perbandingan seluruh periode dari
satu snapshot data. Rincian catatan pengeluaran tersedia melalui tabel
dashboard dengan halaman berikutnya.
Komponen pembuat PDF dan spreadsheet disimpan lokal dan dimuat saat dibutuhkan.
Semua format memakai data terbaru dan membatalkan unduhan jika sesi admin atau
periode berubah sebelum file selesai disiapkan.

**Penjualan selesai** menjumlahkan pesanan berstatus `selesai` berdasarkan
tanggal pesanan dibuat. Angka ini tidak memverifikasi pembayaran bank;
nilai pesanan yang masih berjalan ditampilkan terpisah dan pesanan dibatalkan
tidak masuk penjualan. **Saldo tercatat** adalah penjualan selesai dikurangi
pengeluaran yang dicatat, sehingga bukan laba bersih maupun saldo rekening.

Admin bisa menambah, mengedit, dan menghapus catatan pengeluaran dengan
tanggal, kategori, keterangan, serta nominal rupiah bulat. Data tersimpan di
tabel `finance_expenses` pada Neon yang sama, dibuat otomatis setelah sesi
admin mengakses laporan. Penghapusan menandai catatan sebagai dihapus;
pengulangan permintaan tambah tidak menggandakan pengeluaran, dan perubahan
bersamaan ditolak agar catatan terbaru tidak tertimpa.

Endpoint `GET /api/admin/finance` menerima `period=daily|weekly|monthly|yearly`,
`date=YYYY-MM-DD`, `expensePage`, dan `expensePageSize` (maksimal 100).
Endpoint yang sama menerima `POST`, `PATCH`, dan `DELETE` untuk catatan
pengeluaran. Semua metode memerlukan sesi admin; perubahan juga memakai
validasi JSON, asal permintaan, dan batas permintaan yang sama dengan admin.
Tidak ada endpoint keuangan publik atau perubahan pada URL fitur yang sudah ada.

## Nomor Antrean dan Struk Customer

Di `/admin/`, buka **Pesanan**, pilih ukuran kertas **Thermal 58 mm**,
**Thermal 80 mm**, atau **A4**, lalu pilih **Cetak struk customer** pada pesanan.
Halaman nota menampilkan pratinjau sesuai ukuran pilihan. Klik **Cetak struk**
untuk membuka menu cetak perangkat, atau **Unduh PDF** untuk menyimpan file
dan membukanya di aplikasi printer. Membuka nota tidak langsung mencetak.

Struk memuat nomor antrean besar, ID pesanan, tanggal WIB, status, rincian
jumlah dan harga, total, serta metode pembayaran. Struk thermal untuk customer
menampilkan nama hanya ketika dibuka oleh admin; nomor WhatsApp pelanggan,
alamat, dan catatan tidak disertakan. Detail pengiriman tetap tersedia pada
nota A4 admin. Metode pembayaran yang dipilih tidak berarti pembayaran sudah
lunas. Cetak ulang tidak mengubah stok, status, atau nomor antrean.

Komputer dapat mencetak melalui driver printer yang terpasang; Android memakai
layanan cetak atau aplikasi printer; iPhone/iPad memakai AirPrint atau aplikasi
printer yang mendukung. USB, Bluetooth, dan WiFi mengikuti dukungan printer,
sistem operasi, dan aplikasi tersebut. Browser tidak menyediakan sambungan
langsung universal ke semua printer Bluetooth/USB. Jika printer tidak muncul
di menu cetak, gunakan PDF melalui aplikasi printer. Pilih ukuran kertas yang
sesuai pada driver, skala 100%, dan nonaktifkan header/footer browser agar
alamat halaman tidak tercetak. PDF thermal memakai lebar fisik 58/80 mm dan
panjang mengikuti isi; pesanan sangat panjang dibagi menjadi beberapa halaman.

Antrean dimulai dari **A001** setiap tanggal WIB (`Asia/Jakarta`). Nomor
disimpan bersama pesanan dan pengurangan stok dalam satu transaksi, sehingga
checkout bersamaan mendapat nomor berbeda dan checkout gagal tidak mengambil
nomor. Pembatalan tetap mempertahankan nomornya. Pesanan lama diberi nomor
berdasarkan urutan waktu dan ID pada tanggal aslinya, tanpa mengubah data
pesanan atau persediaan. Nomor tampil di dashboard, tracking, nota, serta
pesan checkout WhatsApp; pencarian admin menerima nomor seperti A001.

Kolom `orders.queue_number` / `queue_date`, tabel `order_queue_counters`,
indeks unik per hari, dan fungsi/trigger antrean dibuat otomatis di database
yang sama. Fungsi `dapoer_save_order` tetap mengembalikan BOOLEAN untuk
instance lama; `dapoer_save_order_with_queue` mengembalikan metadata yang
tersimpan tanpa permintaan database kedua. `GET /api/receipt?id=...` tanpa
token hanya tersedia dengan sesi admin yang valid, termasuk untuk pesanan
lama tanpa token. Link publik tetap memerlukan token yang cocok dan API tidak
mengirimkan identitas pelanggan tanpa sesi admin. Print/PDF memeriksa ulang
nota; kesalahan akses membersihkan pratinjau dan menonaktifkan cetak/unduh.
Tidak ada endpoint Vercel, kredensial, atau dependensi aplikasi baru.

## Pengujian

Animasi antarmuka memakai `assets/js/motion.js` dan stylesheet tambahan,
tanpa mengubah data maupun alur checkout/admin. Elemen muncul satu kali ketika
masuk layar; kartu menu tidak mengulang animasi saat stok dimuat ulang.
Gerakan mengikuti pengaturan `prefers-reduced-motion`, berhenti ketika elemen
menerima fokus keyboard atau nota dicetak, dan tetap menampilkan konten jika
API animasi/IntersectionObserver tidak tersedia. Animasi masuk bersifat singkat;
pita teks marquee tetap berjalan kontinu seperti sebelumnya dan berhenti
saat pengguna memilih pengurangan gerakan atau halaman dicetak.

Efek kedalaman storefront memakai `assets/css/storefront-depth.css` dan
`assets/js/storefront-depth.js`: artwork DP berlapis dan foto menu miring ringan
mengikuti mouse pada desktop. Gerak tidak aktif pada layar sentuh atau saat
pengurangan gerakan dipilih. Efek kembali ke posisi semula saat pointer keluar,
fokus keyboard, tab tidak aktif, atau halaman dicetak; kartu pengganti dari polling
tetap mendukung efek tanpa mengubah harga, stok, maupun kontrol belanja.
Medali DP memiliki dua sisi dan berputar 360° setiap 22 detik, terpisah dari
gerak tilt scene. Cincin dan keterangan tetap terbaca; pengurangan gerakan
menghentikan putaran dan tampilan cetak hanya menampilkan sisi depan.

Jalankan `npm test`. Pengujian memakai fixture lokal dan database/API tiruan; tidak membuat pesanan produksi atau memanggil Gemini sungguhan. Suite mencakup sesi admin, asal permintaan, batas payload, counter lintas instance, perlindungan data nota, format URL yang harus tetap sama, batas tanggal WIB, ringkasan seluruh hari, paginasi, respons terlambat, dan pergantian hari otomatis.

Suite stok juga mencakup kontrol admin, stok habis, perubahan persediaan pada
keranjang, konflik checkout, dan pembatasan akses. Untuk memverifikasi transaksi
serta checkout bersamaan dengan PostgreSQL nyata, gunakan database lokal khusus
pengujian yang namanya dimulai `dapoer_stock_test` dan paket `pg` (bisa dipasang
di luar checkout):

```bash
STOCK_TEST_DATABASE_URL=postgresql://localhost/dapoer_stock_test \
STOCK_TEST_PG_MODULE=/path/to/node_modules/pg \
node --test test/inventory-postgres.integration.cjs
```

Pengujian integrasi membuat schema terpisah lalu menghapusnya; suite menolak
host database nonlokal dan tidak disertakan pada `npm test`.

Dengan variabel database lokal yang sama, jalankan
`node --test test/order-queue-postgres.test.js test/finance-postgres.test.js`
untuk menguji antrean dan laporan keuangan pada PostgreSQL nyata. Suite antrean
mencakup checkout bersamaan, reset WIB, migrasi riwayat, kompatibilitas instance
lama, pembatalan, dan rollback nomor bersama stok. `npm test` juga memeriksa
akses nota admin/publik, validasi struk, PDF, dan pembatalan unduhan.
