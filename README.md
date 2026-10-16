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
- Tambah menu pada pesanan yang sama, dengan persetujuan admin bila sudah diproses
- Pilihan diantar atau ambil sendiri, ongkir admin, dan total akhir terperinci
- Pemulihan pesanan di perangkat lain melalui kode WhatsApp yang dikirim admin
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
Jika pelanggan tidak melanjutkan konfirmasi, admin dapat membatalkan pesanan
berstatus **baru** atau **diproses**: stok kembali tepat satu kali. Pesanan
yang sudah dikirim atau selesai tidak dapat dibatalkan melalui perubahan
status ini, agar barang yang sudah keluar tidak otomatis menjadi persediaan.
Pesanan yang sudah dibatalkan tidak dapat dibuka kembali; buat pesanan baru
agar stok diperiksa ulang. Pesanan lama yang
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

### Riwayat keluar-masuk stok

Di **Stok Menu → Riwayat stok**, pilih periode harian, mingguan, bulanan,
atau tahunan dan tanggal acuannya. Minggu dihitung Senin–Minggu; seluruh
batas tanggal memakai WIB. Filter produk membatasi ringkasan dan catatan
yang ditampilkan maupun diunduh. Ringkasan memperlihatkan saldo awal, jumlah
masuk, jumlah keluar, dan saldo akhir untuk setiap produk.

Perubahan persediaan dicatat otomatis bersama transaksi database: penambahan,
pengurangan, pengaturan jumlah akhir, pengosongan, pemesanan, dan pengembalian
stok akibat pembatalan yang diizinkan. Catatan menyimpan waktu, jumlah sebelum
dan sesudah, sumber, keterangan, serta nomor pesanan bila ada. Keterangan
opsional di editor stok dapat dipakai untuk menjelaskan stok rusak, koreksi
stok fisik, atau penerimaan barang. Pengiriman ulang tindakan yang sama tidak
membuat catatan tambahan; perubahan yang gagal atau dibatalkan transaksinya
tidak muncul pada riwayat.

Saat fitur mulai aktif, stok yang benar-benar tersimpan menjadi saldo awal.
Riwayat sebelum waktu aktivasi tidak dibuat ulang. Laporan menampilkan batas
ketersediaan data agar saldo awal pada periode yang mencakup waktu aktivasi
tidak disalahartikan sebagai saldo dari sebelum pencatatan dimulai. Catatan
riwayat tidak dapat diedit atau dihapus dari dashboard; koreksi dilakukan
dengan perubahan stok baru sehingga jejak sebelumnya tetap tersedia.

Unduhan **PDF**, **Excel (.xlsx)**, dan **CSV** mencakup seluruh catatan pada
periode dan produk yang dipilih, termasuk halaman yang belum dibuka. Data
dibekukan saat laporan dimuat agar ringkasan, halaman berikutnya, dan unduhan
tetap cocok ketika pesanan baru masuk. Gunakan **Refresh** pada tab riwayat untuk
mengambil keadaan terbaru. Snapshot laporan berlaku sementara; setelah
kedaluwarsa, muat ulang laporan sebelum mengunduh.

Riwayat memakai endpoint admin stok yang sama, dengan sesi dan pembatasan
akses yang sama. Tabel saldo awal, jurnal stok, dan snapshot laporan dibuat
otomatis di database yang sudah digunakan. Tidak ada layanan, kredensial,
atau endpoint serverless tambahan. Pencatatan mengukur **jumlah unit**, bukan
nilai persediaan atau harga pokok; laporan keuangan tetap terpisah.

Untuk integrasi, gunakan `GET /api/admin/stock?view=history&period=week&date=2026-10-15`
(pilihan periode: `day`, `week`, `month`, `year`; filter opsional `productId`).
Halaman berikutnya memakai `snapshot` dan `cursor` dari `pagination` tanpa
mengirim ulang filter. `pageSize` maksimal 1.000 untuk pengambilan unduhan.
Snapshot kedaluwarsa mengembalikan `410 STOCK_HISTORY_EXPIRED`; buat laporan
baru, jangan menggabungkan halaman dari snapshot berbeda.

## Riwayat Pesanan

Riwayat dibuka pada **hari ini menurut WIB (Asia/Jakarta)**. Pilih tanggal untuk melihat pesanan hari sebelumnya, atau gunakan tombol panah untuk berpindah hari. Pesanan lama tetap tersimpan di database. Tombol **Hari ini** mengaktifkan pergantian tanggal otomatis pada pukul 00.00 WIB; tanggal riwayat yang dipilih manual tetap ditampilkan sampai admin menggantinya.

Ringkasan menghitung seluruh pesanan pada tanggal pilihan. Daftar memuat 100 pesanan per halaman; tombol **Muat pesanan berikutnya** membuka sisanya. Pencarian dan filter status berlaku pada pesanan yang sudah dimuat. Refresh berkala mempertahankan halaman yang sudah dibuka. Memilih tanggal atau berganti hari tidak memicu notifikasi untuk pesanan lama.

API tetap menggunakan `GET /api/admin/orders`, dengan parameter opsional `date=YYYY-MM-DD`, `page=1`, dan `pageSize=100` (maksimal 200). Tanpa tanggal, API memakai hari ini dalam WIB. Indeks `orders_created_at_id_idx` dibuat otomatis untuk pencarian tanggal dan urutan halaman; tidak ada pesanan yang dihapus. URL dashboard, tracking, dan nota tetap sama. Loader dan stylesheet tambahan memastikan kontrol harian juga tersedia bagi browser yang masih menyimpan aset admin versi lama.

## Catatan

Website publik tidak membutuhkan akun customer. Customer tetap checkout langsung dan dilanjutkan ke WhatsApp setelah order divalidasi oleh backend.

## Pengamanan link publik di Vercel

Alamat beranda, dashboard, tracking, nota, endpoint API, parameter `id`/`token`, dan URL aset tetap sama. Nota dan `GET /api/receipt` hanya tersedia dengan sesi admin yang valid, termasuk bila tautan lama menyertakan token tracking. Customer melihat ringkasan dan status melalui tracking; tautan struk dan QR nota tidak ditampilkan pada checkout maupun tracking. Nama, nomor WhatsApp, alamat, dan catatan pelanggan tidak dikirim melalui API tracking publik. Admin menerima detail pengiriman lewat checkout WhatsApp dan dashboard.

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

Halaman/API pesanan dan admin menggunakan cache privat tanpa penyimpanan dan tidak diindeks. `no-referrer` mencegah token URL terkirim sebagai referer ke situs lain. Aset baru harus divalidasi ulang oleh browser; stylesheet privasi tambahan memperbaiki overlay nota sekalipun CSS lama masih tersimpan di cache. Pembatasan struk berlaku di backend, sehingga tautan customer versi lama tetap memerlukan sesi admin.

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
lama tanpa token. Menyertakan token tidak memberikan akses customer ke struk.
API memeriksa sesi sebelum pencarian pesanan atau query pembatas trafik.
Print/PDF admin memeriksa ulang
nota; kesalahan akses membersihkan pratinjau dan menonaktifkan cetak/unduh.
Tidak ada endpoint Vercel, kredensial, atau dependensi aplikasi baru.

## Pengambilan dan Ongkir

Saat checkout customer memilih **Diantar** atau **Ambil sendiri**. Alamat
wajib diisi untuk pengantaran; ambil sendiri tidak memerlukan alamat dan
ongkirnya selalu Rp0. Checkout lama tanpa pilihan pengambilan tetap dianggap
diantar. Customer tidak dapat menetapkan ongkir melalui payload checkout.

Untuk pengantaran, ongkir awal berstatus **Menunggu konfirmasi admin**.
Dashboard menyediakan isian ongkir pada pesanan baru atau diproses. Admin dapat
menetapkan nominal, termasuk Rp0 untuk gratis ongkir. Perubahan memakai UUID
dan versi pesanan yang diamati; retry tidak menambahkan nominal yang sama dua
kali. Mengubah ongkir mengganti nominal sebelumnya. Pesanan yang sudah dikirim,
selesai, atau dibatalkan tidak menerima perubahan ongkir.

`orders.total` berisi subtotal menu ditambah ongkir yang telah ditetapkan.
`shipping_fee` bernilai `NULL` sebelum ditetapkan, sehingga berbeda dari
ongkir Rp0 yang sudah dikonfirmasi. Respons publik menambahkan
`deliveryMethod`, `itemsSubtotal`, `shippingFee`, `shippingConfirmed`, dan
`grandTotal`; total akhir bernilai `null` selama ongkir belum diketahui.
Tampilan customer, WhatsApp, nota admin, PDF thermal/A4, dan laporan keuangan
mengikuti nominal terbaru. Tambah menu mempertahankan ongkir yang sudah ada.
Jurnal stok tidak berubah karena penetapan ongkir tidak mengubah persediaan.

## Pemulihan Pesanan di HP Lain

Customer membuka **Cari pesanan saya** di footer atau `/track/`, memasukkan
nomor WhatsApp yang dipakai saat checkout, lalu meminta kode. Permintaan publik
selalu memberikan respons umum tanpa menunjukkan apakah nomor memiliki pesanan.
Format nomor Indonesia `08…`, `628…`, dan `+628…` dinormalisasi ke nomor yang sama.

Admin membuka bagian **Pemulihan pesanan**, memilih **Siapkan kode**, lalu
**Buka WhatsApp & kirim kode**. Admin tetap harus menekan **Kirim** di WhatsApp.
Tujuan pesan diambil dari nomor pada pesanan yang tersimpan; browser customer
tidak dapat mengganti tujuan pengiriman. Pengiriman otomatis melalui WhatsApp
API tidak diaktifkan dan tidak memerlukan kredensial layanan tambahan.

Customer memasukkan kode 6 angka pada perangkat baru. Kode berlaku 10 menit
sejak permintaan dibuat, dengan maksimal lima percobaan. Retry yang memakai
UUID sama tidak menghitung percobaan dua kali atau memperpanjang masa berlaku.
Kode hanya dapat digunakan setelah admin menyiapkannya. Database menyimpan
hash kode; kode diturunkan menggunakan `ADMIN_SESSION_SECRET` yang sudah ada.
Tautan pesanan hanya diberikan setelah verifikasi berhasil dan tetap diperiksa
ketika token pesanan dicabut.

Hasil pemulihan berisi paling banyak 20 pesanan aktif dari 30 hari terakhir,
beserta ringkasan, antrean, status, dan tautan tracking. Nama, alamat, catatan,
serta struk admin tidak ikut ditampilkan. Memilih pesanan membuka pesanan yang
sama tanpa checkout baru; pilihan tersebut dapat menjadi pengingat pada
perangkat baru setelah tracking diverifikasi. Formulir pemulihan memakai
penyimpanan sesi terbatas, tanpa menyimpan nomor atau kode secara permanen.

Alur ini memakai `POST /api/track` dengan `action: "request-recovery"` atau
`"verify-recovery"`; daftar permintaan tersedia pada
`GET /api/admin/orders?view=recovery-requests`. Admin menyiapkan kode melalui
`POST /api/admin/orders` dengan `action: "send-recovery-code"` dan mengubah
ongkir melalui `action: "set-shipping"`. Sesi admin, pemeriksaan asal, batas
payload, serta pembatasan permintaan berdasarkan IP dan nomor/challenge tetap
berlaku. Tidak ada endpoint Vercel baru, status pembayaran baru, atau pembatalan
pesanan otomatis yang ditambahkan.

## Tambah Menu pada Pesanan Aktif

Customer membuka **Lacak pesanan → Tambah Menu**, atau memakai tombol
**Tambah Menu** dari layar pesanan tersimpan. Customer memilih jumlah tambahan
tanpa mengisi nama, nomor WhatsApp, atau alamat lagi. Nomor pesanan dan antrean
tetap sama. Harga menu yang sudah dipesan tetap dipertahankan; menu tambahan
memakai harga katalog terbaru, dengan subtotal tambahan dan total gabungan
ditampilkan sebelum konfirmasi.

Pada status **baru**, tambahan langsung masuk ke pesanan setelah stok diperiksa.
Pada status **diproses**, tambahan menjadi **menunggu persetujuan admin**.
Permintaan tersebut belum mengurangi stok atau menambah tagihan. Admin melihat
rincian tambahan pada kartu pesanan, lalu memilih **Setujui** atau **Tolak**.
Persetujuan memeriksa kembali harga, stok, dan versi pesanan sebelum mengubah
total serta stok dalam satu transaksi. Customer dapat mengonfirmasi tambahan
dan total terbaru melalui WhatsApp; pesan untuk permintaan yang masih menunggu
persetujuan menjelaskan bahwa tambahan belum perlu dibayar.

Hanya satu permintaan tambahan boleh menunggu persetujuan pada setiap pesanan.
Pesanan **dikirim**, **selesai**, atau **dibatalkan** tidak menerima tambahan;
permintaan yang belum diputuskan berakhir ketika pesanan mencapai status itu.
Pesanan lama yang stoknya tidak pernah dipesan melalui sistem tidak menerima
tambahan agar pembatalannya tidak mengembalikan stok yang belum pernah dipotong.

`POST /api/order` memakai `action: "add-items"`, ID dan token tracking,
`requestId` UUID, daftar `{id, quantity}`, serta `expectedTotal` untuk subtotal
tambahan. Endpoint checkout biasa tetap menerima format sebelumnya.
`POST /api/admin/orders` memakai `action: "review-addition"`, ID pesanan,
`additionId`, `decision` (`approve`/`reject`), UUID permintaan, dan pasangan
`expectedStatus`/`expectedUpdatedAt`. Sesi admin dan pemeriksaan asal permintaan
tetap diwajibkan. Endpoint Vercel baru tidak diperlukan.

UUID tambahan disimpan sementara agar retry setelah koneksi terputus memakai
permintaan yang sama. Database menyimpan UUID dan fingerprint secara atomik;
retry tidak mengurangi stok atau menambah menu dua kali. Riwayat tambahan
tersimpan pada `order_additions`. Perubahan stok memakai jurnal stok yang sama,
beserta nomor pesanan dan alasan tambahan. Struk admin dan laporan keuangan
membaca item serta total pesanan yang sudah diperbarui. Item dengan harga lama
dan harga baru tetap terpisah bila harganya berbeda. Jumlah baris item dibatasi
100 agar nota tetap dapat dicetak.

## Pemulihan Koneksi dan Alur Operasional

Checkout memakai satu `requestId` UUID untuk satu pesanan. Jika respons hilang,
gunakan **Periksa kembali pesanan sebelumnya**; permintaan memakai data dan ID
yang sama serta mengembalikan pesanan, harga, tracking, dan antrean yang sudah
tersimpan. Penyimpanan hasil dan pengurangan stok berada dalam transaksi yang
sama. UUID dengan isi berbeda ditolak dengan `409 REQUEST_CONFLICT`; harga yang
berbeda dari `expectedTotal` ditolak dengan `409 PRICE_CHANGED` sebelum stok
atau pesanan berubah. Frontend memperbarui harga keranjang dari menu terbaru
dan meminta pemeriksaan ulang jika harga berubah sebelum konfirmasi.

Halaman sukses menyediakan **Konfirmasi di WhatsApp** dan **Lacak pesanan**.
Struk hanya dibuka dan dicetak oleh admin. Pembukaan WhatsApp dilakukan dengan
klik langsung agar tetap bekerja setelah koneksi lambat. Beranda tetap memakai
satu tombol gold **Pilih Menu & Pesan**.
Setelah checkout tersimpan, tracking memeriksa total terbaru sebelum tautan
WhatsApp ditampilkan. Replay checkout lama tidak memakai total awal ketika menu
sudah ditambahkan. Jika pemeriksaan gagal, pesanan tetap tercatat dan konfirmasi
dapat dilanjutkan melalui pengingat setelah koneksi pulih.

Jika layar sukses tidak sengaja ditutup, pengingat **Lanjutkan konfirmasi**
membuka kembali pesanan yang sama setelah statusnya diperiksa melalui tracking.
Tindakan ini tidak mengirim checkout baru, mengurangi stok lagi, atau meminta
customer mengisi ulang data yang sudah tersimpan di database. Pengingat hanya
berlaku untuk satu pesanan aktif terakhir, selama 24 jam pada browser/perangkat
yang sama; pesanan selesai, dibatalkan, atau tautannya dicabut tidak ditawarkan
untuk konfirmasi. Tidak ada daftar riwayat pesanan di hero.
Tab versi lama yang masih menyimpan konfirmasi WhatsApp dalam sesi dipulihkan
setelah pesanan aktif diverifikasi; migrasi ini tidak mengirim checkout ulang
atau memperpanjang masa berlaku saat halaman dimuat ulang.

Metadata ID, token tracking, total, dan antrean untuk pemulihan disimpan di
`localStorage` dengan masa berlaku 24 jam. Nama, nomor WhatsApp, alamat,
catatan, dan pesan WhatsApp lengkap tidak dimasukkan ke penyimpanan permanen
ini. Pesan WhatsApp lengkap serta draf formulir hanya tersedia dalam sesi tab,
maksimal 24 jam, dengan cadangan memori bila penyimpanan tidak tersedia.
Isian draf yang belum dikirim dipulihkan pada kolom kosong setelah reload;
isian baru tidak ditimpa. Draf yang sudah berhasil disimpan dibersihkan hanya
jika formulir belum diubah selama penyimpanan berlangsung.

Setelah tab/browser ditutup dan pesan sesi tidak tersedia, status pesanan
divalidasi dengan token tracking; WhatsApp dapat dibuka dengan nomor pesanan,
antrean, item, total, dan tautan tracking. Admin mengambil data pemesan dan
alamat dari pesanan yang sudah tersimpan. API tracking tetap tidak mengirim
identitas customer atau pesan WhatsApp lengkap. Jika koneksi tidak tersedia,
pengingat memberikan kesempatan mencoba lagi tanpa membuat pesanan baru.
Checkout yang responsnya belum pasti tetap memakai pemulihan UUID tersendiri;
perubahan baru di keranjang dan formulir tetap dipertahankan.

Pemeriksaan menu dibatasi 15 detik agar koneksi yang menggantung tidak
mengunci checkout. Pemutakhiran berkala dan pemulihan saat koneksi kembali
dipasang sejak halaman mulai berjalan; ketika menu belum tersedia, pelanggan
dapat memilih **Coba muat menu lagi**. Harga dan stok tetap harus berhasil diperiksa
sebelum membuat pesanan baru. Menutup keranjang ketika pemeriksaan sedang
berlangsung membatalkan pembukaan checkout, sehingga formulir tidak muncul
kembali setelah pelanggan berpindah.

Keranjang disinkronkan lintas tab termasuk saat pesanan sedang disimpan.
Penyelesaian pesanan memeriksa kembali keranjang tersimpan sebelum
mengosongkannya, agar perubahan baru dari tab lain tetap tersedia. Pembaruan
nama dan harga dari katalog tidak menyiarkan ulang perubahan jumlah ke tab
lain. Jika penyimpanan browser tidak tersedia, cadangan keranjang di memori
tetap dipakai. Validasi formulir mengikuti data yang diperiksa server: nama
minimal dua karakter, nomor WhatsApp minimal delapan digit, dan alamat minimal
lima karakter, dengan petunjuk pada kolom yang perlu diperbaiki.

Pilihan pembayaran customer adalah **OVO**, **ShopeePay**, **DANA**, dan
**Transfer Bank**. Pilihan disimpan bersama pesanan dan diteruskan ke pesan
WhatsApp, dashboard admin, struk, serta rincian laporan keuangan. Untuk
Transfer Bank, pelanggan mengonfirmasi rekening tujuan dan pembayaran
melalui WhatsApp admin.

Semua tindakan stok dari dashboard juga memakai UUID yang dipertahankan saat
hasil koneksi belum pasti. Percobaan ulang memeriksa hasil tindakan yang sama,
kemudian memuat persediaan terbaru. Mengubah isi tindakan dengan UUID yang
sudah terpakai ditolak. API lama tanpa `requestId` tetap diterima untuk
kompatibilitas, tetapi tidak dapat mengidentifikasi percobaan ulang; gunakan
versi website terbaru untuk perlindungan ini.

Perubahan status hanya boleh maju; admin dapat melewati tahap antara bila
pesanan memang sudah sampai tahap berikutnya. Sebelum membatalkan pesanan
baru/diproses, dashboard meminta konfirmasi. Penyimpanan mengirim
`expectedStatus` dan `expectedUpdatedAt` persis dari data yang dibaca. Perubahan
bersamaan menerima `409 ORDER_CONFLICT` agar status dari tab lama tidak
menimpa status baru. Permintaan ulang transisi yang baru saja berhasil
mengembalikan hasil yang sama. Pilihan status, fokus, dan tombol penyimpanan
yang masih berjalan dipertahankan selama refresh otomatis.

Dashboard menampilkan keadaan koneksi dan waktu pembaruan terakhir. Gangguan
refresh tidak menghilangkan pesanan yang sudah dibaca atau menyatakan koneksi
masih aktif. Tombol **Keluar** tersedia di HP maupun komputer; dashboard baru
menyatakan sesi berakhir setelah logout berhasil. Endpoint logout tetap
memeriksa metode, asal permintaan, dan payload, tetapi tidak memerlukan database
pembatas trafik untuk menghapus cookie.

Logout diteruskan ke tab admin/nota lain melalui BroadcastChannel dan event
penyimpanan browser. Nota privat membersihkan identitas pelanggan ketika tab
ditinggalkan dan memeriksa akses kembali saat aktif. Gunakan tombol **Cetak
struk** untuk nota admin: pencetakan bawaan browser yang belum memvalidasi akses
tidak menampilkan data privat. Nota admin dan PDF thermal tetap mengikuti
proteksi identitas pelanggan yang sama.

Foto menu mempunyai varian WebP 720 dan 1200 piksel serta fallback PNG asli.
Kelima varian 720 piksel total sekitar 424 kB dan varian 1200 piksel sekitar
886 kB, dibanding PNG asli sekitar 8 MB. Browser memilih ukuran berdasarkan
layar, dan lazy loading tetap aktif. Refresh menu/keranjang mempertahankan
elemen dan fokus; dialog mendukung Tab/Escape, serta chat menyesuaikan layar
pendek/mendatar. Tabel/indeks pengeluaran pertama kali dibuat dalam satu
transaksi terkunci agar beberapa instance cloud tidak bertabrakan.

Tabel tambahan `operation_requests` menyimpan hasil tindakan sekali saja dan
`order_status_transitions` menyimpan transisi terakhir untuk pemeriksaan/retry.
Keduanya dibuat otomatis di Neon yang sama, tanpa endpoint atau secret baru.
Role database memerlukan izin membuat tabel/fungsi serta membaca/menulis data
tersebut. Pengujian transaksi tambahan menggunakan database lokal khusus:
`node --test test/integrity-postgres.test.js` dengan variabel pengujian stok
yang dijelaskan di bawah.

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
`node --test test/order-queue-postgres.test.js test/finance-postgres.test.js test/stock-history-postgres.test.js`
untuk menguji antrean dan laporan keuangan pada PostgreSQL nyata. Suite antrean
mencakup checkout bersamaan, reset WIB, migrasi riwayat, kompatibilitas instance
lama, pembatalan, dan rollback nomor bersama stok. `npm test` juga memeriksa
penolakan struk customer, akses nota admin, validasi struk, PDF, pembatalan unduhan,
serta pemulihan konfirmasi dan isian formulir tanpa menggandakan pesanan.

Dengan konfigurasi database lokal yang sama, jalankan
`node --test test/order-additions-postgres.test.js test/order-additions-flow-postgres.test.js`
untuk memeriksa tambahan menu bersamaan, retry, persetujuan, pembatalan,
perubahan harga, jurnal stok, serta alur API sampai struk dan laporan keuangan.
Suite ini hanya berjalan ketika variabel database pengujian lokal tersedia.
Suite `test/fulfillment-postgres.test.js` dan
`test/customer-recovery-postgres.test.js` memakai konfigurasi lokal yang sama
untuk menguji ongkir, pengambilan, batas percobaan kode, masa berlaku, dan
pemulihan pesanan tanpa membuka data sebelum verifikasi.

Suite riwayat stok membuktikan migrasi saldo awal tanpa transaksi rekaan,
pencatatan atomik pesanan/pembatalan, UUID dan konflik stok, batas periode WIB,
saldo yang belum tersedia sebelum aktivasi, serta halaman unduhan yang tetap
konsisten saat transaksi lain baru selesai setelah snapshot laporan dibuat.
