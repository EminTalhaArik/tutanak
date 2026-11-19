#!/bin/bash
# Paketlenmiş Tutanak'ı /Applications'a kurar ve sabit bir kimlikle imzalar.
#
# macOS izinleri (Ekran Kaydı, Sistem Sesi Kaydı, Mikrofon, Konuşma Tanıma) uygulamanın imza
# gereksinimine bağlıdır. Geçici (ad-hoc) imza her derlemede değiştiği için izinler sıfırlanır;
# geliştirici sertifikasıyla imzalanan uygulamada gereksinim sertifika adına bağlı kalır, izinler
# güncellemelerde korunur.
#
# Kullanım: npm run kur  (önce paketler)   ya da   bash scripts/kur.sh  (dist/ hazırsa)
# İmzalayacak sertifika (Anahtar Zinciri'nde göründüğü tam adıyla), sırasıyla:
#   TUTANAK_IMZA / AJANDA_IMZA ortam değişkeni → depoya girmeyen .imza dosyasının ilk satırı →
#   Anahtar Zinciri'ndeki ilk "Apple Development" sertifikası → yoksa geçici imza
set -euo pipefail

cd "$(dirname "$0")/.."
KAYNAK="dist/Tutanak-darwin-arm64/Tutanak.app"
HEDEF="/Applications/Tutanak.app"
IMZA_ADI="${TUTANAK_IMZA:-${AJANDA_IMZA:-}}"
if [ -z "$IMZA_ADI" ] && [ -f .imza ]; then IMZA_ADI=$(head -n 1 .imza); fi
YARDIMCI="Contents/Resources/app.asar.unpacked/bin/tutanak-helper"

[ -d "$KAYNAK" ] || { echo "Önce paketleyin: npm run package" >&2; exit 1; }

# Kayıt sürerken uygulama kapatılırsa kayıt yarım kalır
if pgrep -f 'tutanak-helper record' >/dev/null; then
  echo "Şu an bir toplantı kaydediliyor; kayıt bitince tekrar deneyin." >&2
  exit 1
fi

# Aynı adlı birden çok geçerli sertifika olabilir (yenileme); herhangi biri aynı gereksinimi verir.
if [ -n "$IMZA_ADI" ]; then
  KIMLIK=$(security find-identity -v -p codesigning | awk -v ad="\"$IMZA_ADI\"" 'index($0, ad) && !/CSSMERR/ { print $2; exit }')
else
  IMZA_ADI="Apple Development"
  KIMLIK=$(security find-identity -v -p codesigning | awk '/"Apple Development: / && !/CSSMERR/ { print $2; exit }')
fi
if [ -z "$KIMLIK" ]; then
  echo "UYARI: \"$IMZA_ADI\" sertifikası bulunamadı ya da süresi dolmuş; geçici imza kullanılıyor." >&2
  echo "       macOS izinleri (Ekran Kaydı, Sistem Sesi, Mikrofon) yeniden istenecek. Sertifikayı Xcode → Settings → Accounts'tan yenileyin." >&2
  KIMLIK="-"
fi

# Masaüstü/iCloud klasöründeki ek öznitelikler imzayı bozduğu için geçici klasörde imzalanır.
GECICI=$(mktemp -d "${TMPDIR:-/tmp}/tutanak-kur.XXXXXX")
trap 'rm -rf "$GECICI"' EXIT
ditto --norsrc --noextattr "$KAYNAK" "$GECICI/Tutanak.app"

# İçten dışa: önce kayıt/döküm yardımcısı, sonra uygulama ve içindeki Electron parçaları
codesign --force --sign "$KIMLIK" --identifier org.teinn.tutanak.helper "$GECICI/Tutanak.app/$YARDIMCI"
codesign --force --deep --sign "$KIMLIK" "$GECICI/Tutanak.app"
codesign --verify --deep --strict "$GECICI/Tutanak.app"

# Yalnızca pencereli uygulama; Claude'un başlattığı MCP sunucuları da aynı ikiliyle çalışır ve kapanmaz.
acik() { pgrep -f '/Tutanak\.app/Contents/MacOS/Tutanak$' >/dev/null; }
if acik; then
  osascript -e 'tell application "Tutanak" to quit' >/dev/null 2>&1 || true
  for _ in $(seq 1 20); do acik || break; sleep 0.5; done
  if acik; then echo "Tutanak kapanmadı; kapatıp tekrar deneyin." >&2; exit 1; fi
fi

rm -rf "$HEDEF"
mv "$GECICI/Tutanak.app" "$HEDEF"
open "$HEDEF"

echo "Kuruldu: $HEDEF"
codesign -dr - "$HEDEF" 2>&1 | grep designated
