# Tutanak

Teams (ve isteğe bağlı Zoom, Webex, Slack, WhatsApp, FaceTime, tarayıcı) görüşmelerini algılayan,
sağ üstte **"Kaydedilsin mi?"** diye soran, onaylanınca kaydeden ve cihaz üzerinde döküm çıkaran
macOS menü çubuğu uygulaması. Kayıtlar Claude ile MCP üzerinden paylaşılır.

## Kurulum (hazır sürüm)

Gereksinimler: **Apple Silicon (M1 ve sonrası) Mac**, **macOS 26** (cihaz üzerinde Türkçe döküm için) ve
[Homebrew](https://brew.sh) ile kurulmuş **ffmpeg** (ses izlerini birleştirme, döküm ve arşiv için):

```bash
brew install ffmpeg
```

1. [Releases](../../releases/latest) sayfasından `Tutanak-…-arm64.zip` dosyasını indirip açın,
   `Tutanak.app`'i **Uygulamalar** klasörüne sürükleyin.
2. Uygulama Apple tarafından onaylanmış (noterli) olmadığı için ilk açılışta macOS engeller.
   Bir kez açmayı deneyin, sonra **Sistem Ayarları → Gizlilik ve Güvenlik** en altındaki
   **"Yine de Aç"** düğmesine basın. Terminal'i tercih ederseniz:

   ```bash
   xattr -dr com.apple.quarantine /Applications/Tutanak.app
   ```

3. Karşılama ekranında üç izni verin (**Ekran kaydı**, **Sistem sesi kaydı**, **Mikrofon**); ekran kaydı
   iznini verdikten sonra Tutanak'ı kapatıp yeniden açın. Ardından **Test kaydı** ile konuşurken bir
   video oynatın: mikrofon ve sistem sesi için ✓ görmelisiniz.
4. İsterseniz **Claude'a bağla** düğmesiyle Claude masaüstü uygulamasına MCP sunucusu olarak ekleyin
   (Claude'u yeniden başlatın).

Tutanak menü çubuğunda çalışır ve Mac açılınca kendiliğinden başlar. Hazır sürüm geçici (ad-hoc)
imzalıdır: yeni bir sürüm kurduğunuzda macOS izinleri yeniden sorabilir; Sistem Ayarları'nda açık
görünüp uygulamada kapalı görünürse Ayarlar → İzinler → **İzinleri sıfırla**'yı kullanın.

## Nasıl çalışır

- **Algılama:** `tutanak-helper watch` CoreAudio'dan mikrofonu/hoparlörü kullanan süreçleri bildirir.
  İzlenen uygulama mikrofonu ~2,5 sn açık tutunca görüşme başlar; mikrofon da hoparlör de
  `end_grace_sec` (20 sn) kullanılmayınca biter (sessize almak görüşmeyi bitirmez).
- **Kayıt kipleri** (`ayarlar.json → mode`, bildirimde değiştirilebilir):
  - `video` — ekran videosu (H.264) + sistem sesi + mikrofon
  - `audio` — yalnızca ses
  - `shots` — ses + her `shot_interval_sec` (30) saniyede bir ekran görüntüsü
- Ekran ve mikrofon ScreenCaptureKit ile, sistem sesi Core Audio "process tap" ile alınır (Teams karşı tarafın
  sesini penceresiz "Microsoft Teams ModuleHost" sürecinden çalar; ScreenCaptureKit onu yakalamaz). Sistem sesi
  ve mikrofon ayrı izlere yazılır, kayıt bitince ffmpeg ile tek dosyada birleştirilir (`kayit.mp4` / `ses.m4a`).
  Tutanak'ın kendi pencereleri ve sesi kayda girmez.
- **Döküm:** macOS 26 SpeechAnalyzer (Türkçe için DictationTranscriber), tamamen cihaz üzerinde.
  Mikrofon "Ben", sistem sesi "Katılımcılar" olarak etiketlenir; hoparlörden mikrofona sızan yankılar ayıklanır.
- **Arşiv:** video HEVC'ye (düşük fps/çözünürlük), ses mono düşük bit hızlı AAC'ye çevrilir, ekran
  görüntüleri yeniden sıkıştırılıp aynı olan ardışık kareler atılır, ham izler silinir; istenirse arşiv
  klasörüne (harici disk) taşınır. Tek toplantı, seçilenler, "Tümünü arşivle" ya da N gün sonra otomatik.

## Veriler

- Kayıtlar: `~/Movies/Tutanak/<tarih_saat_uygulama>/` (`meeting.json`, kayıt, `kareler/`, `transkript.json/.txt`, `notlar.md`, `ozet.md`)
- Ayarlar: `~/Library/Application Support/Tutanak/ayarlar.json`

## Claude (MCP)

`mcp-server.js` — araçlar: `list_meetings`, `get_meeting`, `get_transcript`, `get_screenshots` (görsel döner),
`search_transcripts`, `update_meeting` (özet, eylem maddeleri, not ekleme). İstemler: `toplanti_ozeti`, `eylem_maddeleri`.
Ayarlar → "Claude'a bağla" `claude_desktop_config.json`'a `tutanak` girdisini ekler (Claude'u yeniden başlatın).

**Ajanda ile:** Mac'te Ajanda (kişisel iş takibi uygulaması) kuruluysa toplantı ekranında
**"Ajanda'ya böl"** düğmesi görünür: `ajanda://parcala?toplanti=<kimlik>` bağlantısıyla Ajanda açılır, Claude dökümü okuyup
görev, not ve proje taslakları hazırlar; hiçbiri Ajanda'da onaylanmadan eklenmez. Ajanda yoksa düğme görünmez.

## İzinler

Ekran kaydı, **Sistem sesi kaydı** (macOS 26'da ekran kaydından ayrı; izin yoksa ses sessiz gelir) ve mikrofon.
Karşılama ekranındaki "Test kaydı" üçünü de doğrular. Gereksinimler: macOS 26, Homebrew ffmpeg.

## Geliştirme

Kaynaktan derlemek için ayrıca Xcode Komut Satırı Araçları (`xcode-select --install`) ve Node.js gerekir.

```bash
npm install
npm run icons       # build/icon.icns ve menü çubuğu simgeleri (depoda hazır; simgeyi değiştirince)
npm run helper      # Swift yardımcısını derler (bin/tutanak-helper)
npm test            # birim + uçtan uca (gerçek ffmpeg ve döküm) testleri
npm start
npm run package     # dist/Tutanak-darwin-arm64/Tutanak.app
```

Arayüz otomasyonu (gerçek ayarlara dokunmaz; veri klasörünü iCloud dışında tutun):

```bash
TUTANAK_DATA_DIR=/tmp/tt/veri TUTANAK_LIBRARY_DIR=/tmp/tt/kayitlar TUTANAK_AUTOMATION=scripts/smoke.js \
SMOKE_STEPS=welcome,detail,prompt,settings,archive,e2e SMOKE_OUT=/tmp/tt/shots npx electron .
```

Kurulum: `npm run kur` (`scripts/kur.sh`) paketler, geliştirici sertifikasıyla (sırasıyla `TUTANAK_IMZA`, depoya girmeyen `.imza` dosyası ya da Anahtar Zinciri'ndeki ilk "Apple Development" sertifikası) imzalar, /Applications'a kurar ve yeniden açar; kayıt sürüyorsa kapatmayı reddeder. İmza gereksinimi sertifika adına bağlı olduğundan Ekran Kaydı, Sistem Sesi, Mikrofon ve Konuşma Tanıma izinleri güncellemelerde korunur; geçici imzada (`--sign -`) her derlemede yeniden istenir. Sertifika bulunamazsa ya da süresi dolmuşsa betik uyarıp geçici imzayla kurar; sertifika Xcode → Settings → Accounts'tan yenilenir. İmzalama, iCloud Masaüstü klasöründe başarısız olduğu için geçici bir klasörde yapılır.
