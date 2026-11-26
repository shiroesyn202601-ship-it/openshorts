# Catatan perubahan (fork pribadi)

Semua perubahan yang diminta di fork ini, dari yang terbaru. Fitur bawaan
OpenShorts tidak dicatat di sini; lihat `git log upstream/main` untuk itu.

---

## 2026-11-26 — Hapus project (file benar-benar dihapus)

**Diminta:** project bisa dihapus, dan filenya benar-benar dibersihkan dari
server, bukan cuma hilang dari tampilan.

**Diubah:**
- Tombol **delete** di menu Projects, dengan konfirmasi.
- `DELETE /api/local/projects/{id}` menghapus folder `output/<id>/` (clip,
  hasil edit, video sumber hasil download, transcript, file pendukung) dan
  file upload `uploads/<id>_*`, lalu melupakan job di memori. Ukuran yang
  dibebaskan ditampilkan.
- Project yang masih diproses: prosesnya dimatikan dulu, auto-retry dan
  resume dicegah, ditunggu sampai benar-benar berhenti, baru filenya dihapus.
- Kalau project yang dihapus sedang terbuka, dashboard kembali ke layar awal.

**File:** `app.py`, `dashboard/src/components/LocalProjectsTab.jsx`, `dashboard/src/App.jsx`

---

## 2026-11-26 — Perbaikan transcribe Groq

**Diminta:** transcribe gagal dengan `'ThreadPoolExecutor' object has no attribute 'acquire'`
lalu jatuh ke Whisper lokal (lama).

**Diubah:**
- Nama variabel daftar key tertimpa oleh thread pool: diganti.
- Field berulang `timestamp_granularities[]` dikirim dalam format yang diterima `httpx`.
- Dites ke Groq sungguhan: video 67 menit ditranscribe dalam 20 detik.

**File:** `asr_api.py`

---

## 2026-11-26 — Menu Projects (pindah antar video)

**Diminta:** bisa kembali ke video A saat sedang mengerjakan video B.

**Diubah:**
- Menu **Projects** di sidebar (self-host): daftar semua video di server
  (judul, sumber, status, jumlah clip, tanggal, cuplikan). Tombol **open**
  membuka video itu di Clip Generator. Video yang masih diproses tetap jalan.
- Endpoint `GET /api/local/projects`; nama link/file sumber disimpan di
  `output/<job>/.label`.

**File:** `app.py`, `dashboard/src/App.jsx`, `dashboard/src/components/LocalProjectsTab.jsx`

---

## 2026-11-25 — Overlay & logo, preview instan, audio tidak tumpang tindih

**Diminta:**
1. Background overlay di atas video: gambar atau warna solid, transparansi,
   gradasi (radial, atas→bawah, bawah→atas, kanan→kiri, kiri→kanan), blur.
2. Logo dengan posisi yang bisa diatur.
3. Preview instan; render hanya saat edit sudah final (termasuk hook bersuara).
4. Memutar satu clip harus menghentikan clip lain.

**Diubah:**
- Tombol **overlay & logo** per clip: preview langsung dengan CSS, render
  sekali saat **apply** (`clip_style.py`, `POST /api/style`). Overlay ada di
  bawah teks hook dan caption; hook, caption, dan suara intro dipasang ulang
  di atasnya.
- Editor hook: tombol **preview intro** memutar suara di atas frame pertama
  lalu lanjut ke video, tanpa render.
- Memutar satu clip mem-pause clip lain.
- Perbaikan: mengganti hook bersuara di clip tanpa caption tidak lagi
  menambahkan caption.

**File:** `clip_style.py`, `app.py`, `dashboard/src/components/StyleModal.jsx`,
`HookModal.jsx`, `ResultCard.jsx`

---

## 2026-11-25 — Transcribe online (Groq) dengan banyak API key

**Diminta:** transcribe lebih cepat pakai Whisper online (Groq); bisa pasang
beberapa key Groq, pindah otomatis kalau satu kena limit.

**Diubah:**
- `TRANSCRIBE_BACKEND=api`: audio dipotong per 10 menit (MP3 kecil), dikirim
  paralel ke Groq (`whisper-large-v3-turbo`), timestamp disambung lagi.
- `ASR_API_KEY` bisa berisi beberapa key dipisah koma. Key yang kena limit
  (429) diistirahatkan sesuai permintaan Groq dan potongan pindah ke key
  lain; key ditolak (401/403) dilewati. Semua key limit: tunggu maks.
  `ASR_API_MAX_WAIT` (90 dtk), lalu kembali ke Whisper lokal.
- Gagal apa pun → otomatis kembali ke Whisper lokal.

**File:** `asr_api.py`, `transcribe_backends.py`, `.env.example`

---

## 2026-11-25 — Hook bersuara (Gemini TTS) dengan kecepatan yang bisa diatur

**Diminta:** hook bukan cuma teks, tapi juga dibacakan suara (Gemini);
kecepatan suara bisa diatur (mis. 3 detik jadi 2 detik) tanpa memotong
audio; percakapan podcast tidak boleh tertimpa (clip 28 dtk + hook 4 dtk = 32 dtk).

**Diubah:**
- Editor hook: centang **Voice**, pilih suara, **generate voice**, atur
  panjang suara (kecepatan via `atempo`, nada tetap, tidak dipotong).
- Suara dipasang sebagai **intro di depan clip**: frame pertama (dengan teks
  hook) ditahan selama suara diputar, lalu clip utuh menyusul dengan audio
  aslinya. Lapisan paling luar (`voiced_<ts>_`), setelah caption.
- Model TTS: `GEMINI_TTS_MODEL` (default `gemini-2.5-flash-preview-tts`).

**File:** `hook_voice.py`, `app.py`, `dashboard/src/components/HookModal.jsx`, `ResultCard.jsx`
