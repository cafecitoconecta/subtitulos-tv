# Subtítulos TV (beta)

**🇪🇸 Español** · [🇬🇧 English](#english)

Muestra subtítulos externos (.srt) **encima de cualquier app** de tu Android TV / Google TV (Netflix, Prime Video, Max…) y los controlas desde el navegador del móvil. Útil cuando la plataforma no ofrece subtítulos en tu idioma.

> ⚠️ Versión beta para testers. Puede fallar; tu feedback ayuda mucho.

La página del móvil está en **español e inglés** (botón 🇪🇸 ES / 🇬🇧 EN arriba) y la app de la tele sale en el idioma del sistema.

### 🎬 Demo



https://github.com/user-attachments/assets/c5aa5a96-2827-4387-97f4-70cf30c3b017



## Dispositivos compatibles
- Teles y reproductores con **Android TV o Google TV, Android 8.0 o superior** (Chromecast con Google TV, Fire TV no probado).
- Un móvil (Android o iPhone) con navegador, **en la misma red Wi‑Fi** que la tele.

## Instalación
Descarga el APK de la última versión en [Releases](https://github.com/cafecitoconecta/subtitulos-tv/releases).

### Opción A: app «Downloader» (sin ordenador)
1. En la tele, instala **Downloader** (de AFTVnews) desde Google Play.
2. Permite a Downloader instalar apps desconocidas (Ajustes → Apps → Acceso especial → Instalar apps desconocidas).
3. En Downloader escribe la URL del APK de la página de [Releases](https://github.com/cafecitoconecta/subtitulos-tv/releases).
4. Instala y abre **Subtítulos TV**.

### Opción B: ADB
```
adb connect IP_DE_LA_TELE
adb install SubtitulosTV-0.6.2-beta.apk
```

## Primer uso
1. Abre la app en la tele y pulsa **Activar subtítulos**. Concede el permiso «Mostrar sobre otras apps».
2. (Opcional) Pulsa **Permitir pausa automática** para que los subtítulos se paren cuando pausas la peli.
3. Escanea con el móvil el **código QR** que aparece en la tele (o abre la URL que se muestra). El navegador avisará de que el certificado no es de confianza: es normal, la conexión es local con tu tele; acepta para continuar.
4. En el móvil, busca la peli o serie con 🔎 **Buscar** y carga los subtítulos (o usa tus propios .srt, en cualquier idioma).
5. Pon la peli en la tele y sincroniza: escribe la hora que marca el reproductor (p. ej. `23:15`) o pulsa **Resincronizar** con el móvil cerca de la tele. Ajusta con **Salen tarde / Salen pronto** si hace falta.

## Limitaciones conocidas
- **Resincronizar es beta**: funciona mejor en escenas con diálogo; con música o mucho ruido puede no encontrar el punto.
- El dictado de voz **necesita internet** y funciona mejor en Chrome (Android). Elige en Ajustes «Idioma del audio» el idioma real que se oye (español, inglés, francés, alemán, italiano, portugués, neerlandés o el idioma original de la serie).
- Si el doblaje no dice lo mismo que el subtítulo, la resincronización por voz puede no coincidir.
- La app no descarga ni incluye subtítulos con copyright: usa archivos que tengas derecho a usar.

## Privacidad
- El micrófono del móvil **solo se activa al pulsar Resincronizar** (unos 20 segundos).
- El audio lo procesa el navegador del móvil con su servicio de reconocimiento de voz (en Chrome, el de Google). La app de la tele no graba ni envía audio.
- Móvil y tele hablan directamente en tu red local, protegidos por un código aleatorio que se crea en cada tele. No hay cuentas ni servidores propios.

## Feedback
¿Algo falla o tienes una idea? Cuéntalo en las [Issues del repositorio](https://github.com/cafecitoconecta/subtitulos-tv/issues).

## Apoyar el proyecto

La app es gratuita. Si te resulta útil y quieres invitar a un café: [ko-fi.com/cafecitoconecta](https://ko-fi.com/cafecitoconecta) ☕

## Compilar
Requiere Android SDK (build-tools 35, platform 34) y JDK: `android/build.sh` (ver variables `KS`, `KS_PASS`, `KS_ALIAS` para firmar).

## Licencia
MIT. Ver [LICENSE](LICENSE).

---

<a id="english"></a>
# Subtítulos TV (beta) — English

Shows external subtitles (.srt) **on top of any app** on your Android TV / Google TV (Netflix, Prime Video, Max…), controlled from your phone's browser. Useful when the platform doesn't offer subtitles in your language.

> ⚠️ Beta version for testers. It may fail; your feedback helps a lot.

The phone page is available in **English and Spanish** (🇪🇸 ES / 🇬🇧 EN toggle at the top) and the TV app follows the system language.

## Supported devices
- TVs and boxes with **Android TV or Google TV, Android 8.0 or later** (Chromecast with Google TV; Fire TV untested).
- A phone (Android or iPhone) with a browser, **on the same Wi‑Fi network** as the TV.

## Installation
Download the APK of the latest version from [Releases](https://github.com/cafecitoconecta/subtitulos-tv/releases).

### Option A: “Downloader” app (no computer needed)
1. On the TV, install **Downloader** (by AFTVnews) from Google Play.
2. Allow Downloader to install unknown apps (Settings → Apps → Special access → Install unknown apps).
3. In Downloader, enter the APK URL from the [Releases](https://github.com/cafecitoconecta/subtitulos-tv/releases) page.
4. Install and open **Subtítulos TV**.

### Option B: ADB
```
adb connect TV_IP_ADDRESS
adb install SubtitulosTV-0.6.2-beta.apk
```

## First use
1. Open the app on the TV and press **Enable subtitles**. Grant the “Display over other apps” permission.
2. (Optional) Press **Allow auto-pause** so the subtitles stop when you pause the film.
3. Scan the **QR code** shown on the TV with your phone (or open the URL shown). The browser will warn that the certificate is not trusted: that's expected, the connection is local to your TV; accept to continue.
4. On the phone, find the film or show with 🔎 **Search** and load the subtitles (or use your own .srt files, in any language).
5. Play the film on the TV and sync: type the time shown by the player (e.g. `23:15`) or tap **Resync** with the phone near the TV. Fine-tune with **Too late / Too early** if needed.

## Known limitations
- **Resync is beta**: it works best in scenes with dialogue; with music or lots of noise it may not find the spot.
- Voice dictation **needs internet** and works best in Chrome (Android). In Settings, set “Audio language” to the language actually being spoken (Spanish, English, French, German, Italian, Portuguese, Dutch, or the show's original language).
- If the dub doesn't say the same as the subtitle, voice resync may not match.
- The app doesn't download or bundle copyrighted subtitles: use files you have the right to use.

## Privacy
- The phone's microphone **is only turned on when you tap Resync** (about 20 seconds).
- Audio is processed by the phone's browser using its speech recognition service (in Chrome, Google's). The TV app doesn't record or send audio.
- Phone and TV talk directly over your local network, protected by a random code created on each TV. No accounts, no servers of our own.

## Feedback
Something broken or have an idea? Tell us in the [repository Issues](https://github.com/cafecitoconecta/subtitulos-tv/issues).

## Support the project

The app is free. If you find it useful and want to buy us a coffee: [ko-fi.com/cafecitoconecta](https://ko-fi.com/cafecitoconecta) ☕

## Building
Requires the Android SDK (build-tools 35, platform 34) and a JDK: `android/build.sh` (see the `KS`, `KS_PASS`, `KS_ALIAS` variables for signing).

## License
MIT. See [LICENSE](LICENSE).
