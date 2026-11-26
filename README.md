# TikPulse LIVE — Panel Interactivo, TTS, Alertas y Batallas PK

## Cómo subir a GitHub y alojar gratis en Render

1. **Crea un repositorio en GitHub** (público o privado) llamado `tikpulse-live`.
2. **Sube todos los archivos** de esta carpeta (`server.js`, `package.json`, `.gitignore`, `.env.example`, `README.md` y la carpeta `public/`).
3. **Saca tu API Key gratis en EulerStream** (`https://www.eulerstream.com/`, plan Community gratuito) para conectar de forma estable con los directos de TikTok.
4. **Conecta tu repositorio en Render** (`https://render.com/`):
   - Crea un nuevo **Web Service** -> elige tu repo `tikpulse-live`.
   - **Build Command:** `npm install`
   - **Start Command:** `npm start`
   - **Instance Type:** `Free` (sin tarjeta).
5. **Agrega la variable de entorno en Render:**
   - Key: `EULER_API_KEY`
   - Value: *(pega tu clave gratuita de EulerStream)*
6. **Abre tu URL pública** (ej. `https://tikpulse-live.onrender.com`) en PC o Android y pega `https://tikpulse-live.onrender.com/overlay?token=TU_TOKEN` en OBS o TikTok LIVE Studio.
