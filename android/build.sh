#!/bin/bash
# Builds the APK without Gradle: aapt2 + javac + d8 + apksigner.
# Usage: KS=path/to/release.jks KS_PASS=... KS_ALIAS=... ./build.sh   (falls back to a local debug key)
set -euo pipefail
cd "$(dirname "$0")"
SDK=${ANDROID_HOME:-$HOME/android-sdk}; BT=$SDK/build-tools/35.0.0; JAR=$SDK/platforms/android-34/android.jar
OUT=${OUT:-build/SubtitulosTV.apk}
rm -rf build && mkdir -p build/res build/gen build/classes build/dex build/assets
cp -r assets/* build/assets/
# Fresh self-signed TLS cert for the local HTTPS server (not committed).
[ -f build/tv.p12 ] || { keytool -genkeypair -storetype PKCS12 -keystore build/assets/tv.p12 -storepass android -keypass android \
  -alias tv -keyalg RSA -keysize 2048 -validity 3650 -dname "CN=Subtitulos TV" >/dev/null 2>&1; }
$BT/aapt2 compile --dir res -o build/res/
$BT/aapt2 link -o build/base.apk -A build/assets -I $JAR --manifest AndroidManifest.xml --java build/gen build/res/*.flat --auto-add-overlay
javac -source 8 -target 8 -nowarn -Xlint:-options -cp $JAR -d build/classes $(find src build/gen -name '*.java')
$BT/d8 --release --min-api 26 --lib $JAR --output build/dex $(find build/classes -name '*.class')
cp build/base.apk build/unsigned.apk
(cd build/dex && zip -q ../unsigned.apk classes.dex)
$BT/zipalign -f 4 build/unsigned.apk build/aligned.apk
if [ -n "${KS:-}" ]; then
  $BT/apksigner sign --ks "$KS" --ks-pass "pass:$KS_PASS" --ks-key-alias "$KS_ALIAS" --out "$OUT" build/aligned.apk
else
  [ -f debug.keystore ] || keytool -genkeypair -keystore debug.keystore -storepass android -keypass android -alias debug -keyalg RSA -keysize 2048 -validity 10000 -dname "CN=Subtitulos TV debug" >/dev/null 2>&1
  $BT/apksigner sign --ks debug.keystore --ks-pass pass:android --out "$OUT" build/aligned.apk
fi
echo "Built $OUT"
