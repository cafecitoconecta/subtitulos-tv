# Subtítulos TV (beta)

Muestra subtítulos externos (.srt) **encima de cualquier app** de tu Android TV / Google TV (Netflix, Prime Video, Max…) y los controlas desde el navegador del móvil. Útil cuando la plataforma no ofrece subtítulos en tu idioma.

> ⚠️ Versión beta para testers. Puede fallar; tu feedback ayuda mucho.

## Dispositivos compatibles
- Teles y reproductores con **Android TV o Google TV, Android 8.0 o superior** (Chromecast con Google TV, Fire TV no probado).
- Un móvil (Android o iPhone) con navegador, **en la misma red Wi‑Fi** que la tele.

## Instalación
### Opción A: app «Downloader» (sin ordenador)
1. En la tele, instala **Downloader** (de AFTVnews) desde Google Play.
2. Permite a Downloader instalar apps desconocidas (Ajustes → Apps → Acceso especial → Instalar apps desconocidas).
3. En Downloader escribe el código o la URL del APK: `TODO: código Downloader / enlace de la release`.
4. Instala y abre **Subtítulos TV**.

### Opción B: ADB
```
adb connect IP_DE_LA_TELE
adb install SubtitulosTV-0.6.1-beta.apk
```

## Primer uso
1. Abre la app en la tele y pulsa **Activar subtítulos**. Concede el permiso «Mostrar sobre otras apps».
2. (Opcional) Pulsa **Permitir pausa automática** para que los subtítulos se paren cuando pausas la peli.
3. Escanea con el móvil el **código QR** que aparece en la tele (o abre la URL que se muestra). El navegador avisará de que el certificado no es de confianza: es normal, la conexión es local con tu tele; acepta para continuar.
4. En el móvil, busca la peli o serie con 🔎 **Buscar** y carga los subtítulos.
5. Pon la peli en la tele y sincroniza: escribe la hora que marca el reproductor (p. ej. `23:15`) o pulsa **Resincronizar** con el móvil cerca de la tele. Ajusta con **Salen tarde / Salen pronto** si hace falta.

## Limitaciones conocidas
- **Resincronizar es beta**: funciona mejor en escenas con diálogo; con música o mucho ruido puede no encontrar el punto.
- El dictado de voz **necesita internet** y funciona mejor en Chrome (Android). Elige en Ajustes «Idioma del audio» el idioma real de la peli.
- Si el doblaje no dice lo mismo que el subtítulo, la resincronización por voz puede no coincidir.
- La app no descarga ni incluye subtítulos con copyright: usa archivos que tengas derecho a usar.

## Privacidad
- El micrófono del móvil **solo se activa al pulsar Resincronizar** (unos 20 segundos).
- El audio lo procesa el navegador del móvil con su servicio de reconocimiento de voz (en Chrome, el de Google). La app de la tele no graba ni envía audio.
- Móvil y tele hablan directamente en tu red local, protegidos por un código aleatorio que se crea en cada tele. No hay cuentas ni servidores propios.

## Feedback
TODO: enlace al formulario / issues de GitHub.

## Compilar
Requiere Android SDK (build-tools 35, platform 34) y JDK: `android/build.sh` (ver variables `KS`, `KS_PASS`, `KS_ALIAS` para firmar).

## Licencia
MIT. Ver [LICENSE](LICENSE).

---

## English
**Subtítulos TV** overlays external .srt subtitles on top of any app on Android TV / Google TV (Android 8.0+), controlled from your phone's browser on the same Wi‑Fi. Install the APK via the *Downloader* app or `adb install`, open it, enable the overlay permission, scan the QR code with your phone, load subtitles and sync (manual time, early/late buttons, or the beta voice-based **Resincronizar**, which uses the phone browser's speech recognition and needs internet). The mic is only used while resyncing. Beta software, MIT licensed. Feedback: TODO. Donations: TODO.
