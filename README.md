# dumpify_image_audit

Servicio en Node.js (Google Cloud Function `audit_images`) que corre en **batch de fin de día**.
Para cada `viaje` finalizado del día, compara lo ingresado en AppSheet contra la foto del vale
físico y envía un reporte por obra a los usuarios habilitados.

## Flujo

1. **Extracción** (`extract.js`): baja de AppSheet los `viaje` finalizados del día (o usa caché en GCS).
2. **Descarga de imágenes** (`index.js` → `drive.js` → `bucket.js`): el `foto_vale` se usa como nombre
   de archivo, se busca en **Google Drive**, se baja con `alt: "media"` (archivo original) y se sube a
   GCS (`images/<YYYY/MM/DD>/<file>`). La resolución de la foto la controla el ajuste **"Image upload
   size"** de la app en AppSheet (debe estar en **Full** para máxima resolución), no el código.
3. **OCR + validación** (`gemini.js` + `validation.js`): Gemini **solo extrae** 4 campos
   (`numeroVale`, `placa`, `m3`, `fecha`); la comparación app-vs-vale la hace JS. Cada registro se
   procesa de forma **secuencial** y aislada: un fallo se guarda en `audits/<date>/failed/` y no tumba
   el lote (se reintenta al día siguiente).
4. **Reporte** (`audit.js` + `excel.js` + `email.js`): genera un Excel por obra y lo envía por correo.

## Gemini (SDK `@google/genai`)

`gemini.js` usa `GoogleGenAI` (`ai.models.generateContent`). El timeout se aplica por request vía
`httpOptions`. Los reintentos son **solo** para errores transitorios (503/429 o mensajes
`UNAVAILABLE|RESOURCE_EXHAUSTED|Deadline expired`) con backoff exponencial (1s, 2s, ...).

## Variables de entorno

| Variable | Default | Descripción |
|---|---|---|
| `APP_ID`, `APP_KEY` | — | Credenciales de la API de AppSheet. |
| `DRIVE_KEYFILE_PATH` | `./service-account.json` | Service account para Drive/GCS. |
| `GCP_BUCKET_NAME` | — | Bucket de GCS para imágenes/auditorías. |
| `GEMINI_API_KEY` | — | API key de Gemini. |
| `GEMINI_MODEL` | `gemini-flash-lite-latest` | Modelo. **Los `*-lite` NO soportan thinking.** |
| `GEMINI_THINKING_LEVEL` | `medium` | `minimal\|low\|medium\|high\|off`. Se envía como `config.thinkingConfig.thinkingLevel`. Con `off`/vacío **no** se envía el campo (evita 400 en modelos lite). |
| `GEMINI_MEDIA_RESOLUTION` | `high` | `low\|medium\|high\|ultra_high`. Se envía como `config.mediaResolution`. La API usa un default menor que AI Studio; subirla evita que el modelo adivine dígitos chicos. |
| `GEMINI_TIMEOUT_MS` | `120000` | Timeout por request. Con thinking medium/high sube la latencia. |
| `GEMINI_MAX_RETRIES` | `2` | Reintentos solo en errores transitorios (503/429). |
| `SMTP_*`, `EMAIL_*` | — | Configuración de correo (ver `.env.example`). |

> **Nota (modelo lite + thinking):** con `gemini-flash-lite-latest` deja `GEMINI_THINKING_LEVEL=off`.
> Aquí el beneficio real viene de `GEMINI_MEDIA_RESOLUTION=high` (o `ultra_high`). Para usar thinking
> de verdad, cambia `GEMINI_MODEL` a un flash no-lite y sube el nivel.

## Requisitos

- Node.js **>= 20**.

## Scripts

- `npm start` — levanta la function localmente (`functions-framework`).
- `npm test` — corre `test.js` (audita los primeros 3 registros del día).
