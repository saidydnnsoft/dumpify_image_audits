import { GoogleGenAI } from "@google/genai";
import { getBucket, downloadFile } from "./bucket.js";
import { imageSize } from "image-size";
import fs from "fs";
import path from "path";

// ---------------------------------------------------------------------------
// Gemini configuration (all overridable via env)
// ---------------------------------------------------------------------------
const GEMINI_MODEL = process.env.GEMINI_MODEL || "gemini-flash-lite-latest";
const GEMINI_TIMEOUT_MS = parseInt(process.env.GEMINI_TIMEOUT_MS || "120000", 10);
const GEMINI_MAX_RETRIES = parseInt(process.env.GEMINI_MAX_RETRIES || "2", 10);
const GEMINI_THINKING_LEVEL = (process.env.GEMINI_THINKING_LEVEL || "medium")
  .toLowerCase()
  .trim();
const GEMINI_MEDIA_RESOLUTION = (process.env.GEMINI_MEDIA_RESOLUTION || "high")
  .toLowerCase()
  .trim();

const MEDIA_RESOLUTION_MAP = {
  low: "MEDIA_RESOLUTION_LOW",
  medium: "MEDIA_RESOLUTION_MEDIUM",
  high: "MEDIA_RESOLUTION_HIGH",
  ultra_high: "MEDIA_RESOLUTION_ULTRA_HIGH",
};

// Single client instance; timeout is applied per request via httpOptions.
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: { timeout: GEMINI_TIMEOUT_MS },
});

/**
 * Build the request config from env.
 * IMPORTANT: the API default media resolution is LOWER than AI Studio; on vale
 * photos with small text/digits that makes the model guess. We force it up.
 * Lite models do NOT support thinkingConfig (400 INVALID_ARGUMENT), so we only
 * attach it when thinkingLevel is a real level (not 'off'/empty).
 */
function buildGeminiConfig() {
  const config = {};

  const mediaResolution = MEDIA_RESOLUTION_MAP[GEMINI_MEDIA_RESOLUTION];
  if (mediaResolution) {
    config.mediaResolution = mediaResolution;
  }

  if (GEMINI_THINKING_LEVEL && GEMINI_THINKING_LEVEL !== "off") {
    config.thinkingConfig = { thinkingLevel: GEMINI_THINKING_LEVEL };
  }

  return config;
}

/**
 * Detect transient errors worth retrying (only these).
 */
function isTransientError(error) {
  const status = error?.status ?? error?.code;
  if (status === 503 || status === 429) return true;
  return /UNAVAILABLE|RESOURCE_EXHAUSTED|Deadline expired/i.test(
    error?.message || ""
  );
}

/**
 * Call Gemini with exponential backoff on transient errors only.
 * Returns the raw text of the response. Any non-transient error is rethrown
 * immediately (per-record error handling lives in audit.js:auditRecord).
 */
async function generateContentWithRetry(contents, config, label) {
  let lastError;
  for (let attempt = 0; attempt <= GEMINI_MAX_RETRIES; attempt++) {
    try {
      const response = await ai.models.generateContent({
        model: GEMINI_MODEL,
        contents,
        config,
      });
      return response.text;
    } catch (error) {
      lastError = error;
      if (!isTransientError(error) || attempt === GEMINI_MAX_RETRIES) {
        throw error;
      }
      const delay = 1000 * Math.pow(2, attempt); // 1s, 2s, ...
      console.log(
        `⏳ Transient error (${label}), retry ${attempt + 1}/${GEMINI_MAX_RETRIES} in ${
          delay / 1000
        }s: ${error.message}`
      );
      await sleep(delay);
    }
  }
  throw lastError;
}

// ---------------------------------------------------------------------------
// Robust JSON parsing of Gemini output
// ---------------------------------------------------------------------------

/** Strip ```json fences and trim to the outermost { ... } object. */
function extractJson(text) {
  const cleaned = text
    .replace(/^```json?\s*/i, "")
    .replace(/\s*```$/i, "")
    .trim();
  const start = cleaned.indexOf("{");
  const end = cleaned.lastIndexOf("}");
  if (start === -1 || end === -1 || end < start) return cleaned;
  return cleaned.slice(start, end + 1);
}

/**
 * Repair the most common issues that break JSON.parse. Safe for this service's
 * schema (extracted values are strings, only `confianza` is numeric):
 * - decimal comma between digits (5,75 -> 5.75); helps if m3 comes as "5,75".
 * - leading "+" before a number after `":` (no-op here, kept for parity).
 * - leading zeros on a numeric value after `":` (no-op here, kept for parity).
 * The last two are anchored to `":` so they never touch the ":" inside times.
 */
function repairJson(json) {
  return json
    .replace(/(\d),(\d)/g, "$1.$2")
    .replace(/":(\s*)\+(\d)/g, '":$1$2')
    .replace(/":(\s*)(-?)0+(\d)/g, '":$1$2$3');
}

function parseGeminiResponse(text) {
  const json = extractJson(text);
  try {
    return JSON.parse(json);
  } catch (err) {
    try {
      return JSON.parse(repairJson(json));
    } catch (err2) {
      console.error("Gemini JSON parse failed. Raw output:", text);
      throw err2;
    }
  }
}

/**
 * Build the extraction-only prompt for Gemini (no comparison, just OCR)
 */
function buildExtractionPrompt(validPlacas, referenceValues) {
  const currentYear = new Date().getFullYear();
  const currentMonth = new Date().getMonth() + 1; // 1-12

  return `You are an OCR expert extracting data from construction material transport documents (vales).

**YOUR ONLY TASK: Extract 4 fields from the image**

Extract these fields exactly as you see them:

1. **numeroVale**: Large PRINTED/STAMPED number (usually in red, top area of document)
   - This is printed, NOT handwritten
   - Typically 5-6 digits
   - Look for the largest, clearest printed number
   - Extract exactly what you see (usually very clear)
   - **IMPORTANT**: Remove any leading zeros (e.g., "00023" should be extracted as "23")

2. **placa**: Vehicle license plate (next to "PLACA:" label)
   - This is HANDWRITTEN
   - Format: 3 letters + 3 digits (e.g., "ABC123") or 1 letter + 5 digits (e.g., "C144789")
   - Use this list to help identify unclear handwriting (${
     validPlacas.length
   } valid placas): ${validPlacas.join(", ")}
   - Reference value: ${referenceValues.placa || "N/A"}
   - **CRITICAL**: When in doubt about any character in the placa, strongly prefer the reference value

3. **m3**: Cubic meters quantity (nex to "CANTIDAD:" field and before "M3")
   - This is HANDWRITTEN
   - Look for number followed by "M3" checkbox or label
   - Usually between 6-20
   - Extract exactly what you see

4. **fecha**: Date (after "FECHA:" label)
   - This is HANDWRITTEN
   - Format on image: DD-MM-YY or DD/MM/YY (2-digit year)
   - Current date context: Month ${currentMonth}, Year ${currentYear}
   - Convert 2-digit year to 4-digit: "25" → "2025", "24" → "2024"
   - Return in format: DD/MM/YYYY
   - Reference value: ${referenceValues.fecha || "N/A"}
   - **CRITICAL**: When in doubt about the year or month, strongly prefer the reference value
   - **DATE VALIDATION**: We are in month ${currentMonth}/${currentYear}. Years like 19${currentYear.toString().slice(-2)}, 1980, etc. are WRONG. Valid years: ${currentYear - 1}-${currentYear}
   - If you see "7${currentYear.toString().slice(-1)}" or "80" as year, it's likely "${currentYear.toString().slice(-2)}" or "20" written unclearly - use the reference year
   - Months must be 01-12. If month seems invalid, use reference value

**IMPORTANT: Using reference values for placa and fecha ONLY**
For numeroVale and m3: Extract exactly what you see (these are usually extracted correctly).
For placa and fecha: When you encounter ambiguous characters (e.g., "4" vs "9", "1" vs "7", "S" vs "5", "2" vs "7"), use the reference value as a guide.

**SPECIAL ATTENTION for placa and fecha:**
- These fields have the most OCR errors due to handwriting
- When there's ANY doubt about characters in placa or fecha, strongly prefer the reference value
- For fecha: If year seems illogical (1975, 1980, etc.), it's definitely OCR error - use reference

Examples:
- Reference placa "TTT840" and image could be "TTT840" or "TTT890" (4 vs 9 ambiguity) → extract "TTT840"
- Reference fecha "16/12/2025" and image could be "16/12/75" or "16/12/25" (7 vs 2 in year) → extract "16/12/2025"
- Reference placa "ABC123" and image could be "ABC123" or "ABC128" (3 vs 8 ambiguity) → extract "ABC123"
- For numeroVale and m3: Extract what you see, do NOT use reference to resolve ambiguity

**CONFIDENCE SCORING:**
Rate how clearly you can READ each field (NOT how certain you are it's correct):
- 1.0 = Crystal clear, perfectly legible, zero ambiguity
- 0.8-0.9 = Very clear, minor blur but confident in reading
- 0.6-0.7 = Readable but messy handwriting or slight ambiguity
- 0.4-0.5 = Barely readable, could be interpreted multiple ways
- 0.0-0.3 = Cannot read clearly, very blurry or illegible

**IMPORTANT RULES:**
- If you cannot read a field at all, return empty string "" with confidence 0.0
- Do NOT make up values
- Do NOT compare with any reference data
- Do NOT explain your reasoning
- Confidence measures READABILITY only (how clear the text is)

**RESPONSE FORMAT:**
Return ONLY valid JSON (no markdown, no code blocks, no extra text):

{
  "numeroVale": {
    "valor": "extracted number or empty string",
    "confianza": 0.0-1.0
  },
  "placa": {
    "valor": "extracted plate or empty string",
    "confianza": 0.0-1.0
  },
  "m3": {
    "valor": "extracted quantity or empty string",
    "confianza": 0.0-1.0
  },
  "fecha": {
    "valor": "DD/MM/YYYY or empty string",
    "confianza": 0.0-1.0
  }
}

Examples:
- Printed number "24697" perfectly clear → {"valor": "24697", "confianza": 1.0}
- Printed number "00023" perfectly clear → {"valor": "23", "confianza": 1.0}
- Handwritten "15" clear and readable → {"valor": "15", "confianza": 0.90}
- Handwritten placa "LJU868" messy but identifiable → {"valor": "LJU868", "confianza": 0.65}
- Date "16-12-25" clear handwriting → {"valor": "16/12/2025", "confianza": 0.95}
- Date with ambiguous digit (could be "3" or "8") → {"valor": "16/03/2025", "confianza": 0.60}
- Completely blurry/illegible field → {"valor": "", "confianza": 0.0}`;
}

/**
 * Sleep helper for exponential backoff
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Check image quality before processing
 */
async function checkImageQuality(imageBase64, config) {
  const qualityPrompt = `You are an image quality assessor for document scanning.

Analyze this vale (transport document) image and rate its quality on a scale of 0-10.

**Quality criteria:**
- 0-3: Severely illegible (heavy blur, extreme overexposure/underexposure, text unreadable)
- 4-5: Poor quality (significant blur, poor lighting, most text difficult to read)
- 6-7: Acceptable quality (some blur or lighting issues, but main text (printed and handwritten) is readable)
- 8-10: Good to excellent quality (clear, well-lit, text (printed and handwritten) easily readable)

**Focus on:**
- Can you clearly read the printed number (usually in red) in the top right corner of the document?
- Can you read the handwritten fields (PLACA, CANTIDAD, FECHA)?
- Is the lighting adequate?
- Is the image focused (not blurry)?

Return ONLY valid JSON (no markdown):
{
  "qualityScore": 0-10,
  "isReadable": true/false,
  "reason": "Brief explanation in Spanish of quality issues if any"
}

Set "isReadable" to true only if qualityScore >= 7.`;

  const contents = [
    { inlineData: { data: imageBase64, mimeType: "image/jpeg" } },
    { text: qualityPrompt },
  ];

  const text = await generateContentWithRetry(contents, config, "quality-check");
  return parseGeminiResponse(text);
}

/**
 * Call Gemini Vision API to audit a vale image.
 *
 * The vale image comes from the GCS bucket (originally uploaded to Drive by
 * AppSheet). Transient-error retries live in generateContentWithRetry; a
 * failure here bubbles up to audit.js:auditRecord, which isolates it per record
 * so one bad record never tumbles the whole batch.
 */
export async function auditWithGemini(record, imagePathInBucket, validPlacas) {
  const bucket = getBucket();
  if (!bucket) {
    throw new Error("Bucket not available");
  }

  const config = buildGeminiConfig();

  const localDir = "./temp_audit";
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  try {
    // Download the actual vale image from the bucket.
    const localImagePath = path.join(
      localDir,
      path.basename(imagePathInBucket)
    );
    await downloadFile(bucket, imagePathInBucket, localImagePath);

    const imageBuffer = fs.readFileSync(localImagePath);
    const imageBase64 = imageBuffer.toString("base64");

    // Diagnostic: confirm we are getting a full-resolution image (AppSheet
    // "Image upload size" = Full), not a compressed thumbnail. No URL/filename
    // is logged (nothing sensitive).
    try {
      const { width, height } = imageSize(imageBuffer);
      console.log(
        `🖼️  Image for ${record.rowId}: ${(imageBuffer.length / 1024).toFixed(
          0
        )} KB, ${width}x${height}px (image/jpeg)`
      );
    } catch (dimErr) {
      console.warn(
        `⚠️ Could not read image dimensions for ${record.rowId}: ${dimErr.message}`
      );
    }

    const imageParts = [
      { inlineData: { data: imageBase64, mimeType: "image/jpeg" } },
    ];

    // STEP 1: Check image quality first
    let qualityScore = null;
    console.log(`🔍 Checking image quality for record ${record.rowId}...`);
    try {
      const qualityCheck = await checkImageQuality(imageBase64, config);
      qualityScore = qualityCheck.qualityScore;
      console.log(
        `📊 Quality score: ${qualityCheck.qualityScore}/10 - Readable: ${qualityCheck.isReadable}`
      );

      if (!qualityCheck.isReadable) {
        console.log(
          `⚠️ Image quality too low (score: ${qualityCheck.qualityScore}). Marking for manual review.`
        );

        return {
          requiresManualReview: true,
          qualityScore: qualityCheck.qualityScore,
          reason: qualityCheck.reason,
          extracciones: {
            numeroVale: "",
            placa: "",
            m3: "",
            fecha: "",
          },
          comparaciones: {
            numeroVale: {
              coincide: false,
              confianza: 0,
              observacion: "Imagen ilegible - requiere revisión manual",
            },
            placa: {
              coincide: false,
              confianza: 0,
              observacion: "Imagen ilegible - requiere revisión manual",
            },
            m3: {
              coincide: false,
              confianza: 0,
              observacion: "Imagen ilegible - requiere revisión manual",
            },
            fecha: {
              coincide: false,
              confianza: 0,
              observacion: "Imagen ilegible - requiere revisión manual",
            },
          },
          aprobado: false,
        };
      }
    } catch (qualityError) {
      console.warn(
        `⚠️ Quality check failed, proceeding with audit anyway:`,
        qualityError.message
      );
      // If quality check fails, continue with normal audit
    }

    // STEP 2: Call Gemini for extraction only
    const referenceValues = {
      numeroVale: record.numeroVale || "",
      placa: record.placa || "",
      m3: record.m3 || "",
      fecha: record.fecha || "",
    };
    const prompt = buildExtractionPrompt(validPlacas, referenceValues);

    const effectiveThinking =
      config.thinkingConfig?.thinkingLevel || "off (not sent)";
    console.log(
      `🤖 Gemini extraction for ${record.rowId} → model=${GEMINI_MODEL}, ` +
        `thinkingLevel=${effectiveThinking}, ` +
        `mediaResolution=${config.mediaResolution || "(default)"}, ` +
        `timeoutMs=${GEMINI_TIMEOUT_MS}, maxRetries=${GEMINI_MAX_RETRIES}`
    );

    const contents = [...imageParts, { text: prompt }];
    const text = await generateContentWithRetry(contents, config, "extraction");
    const extractionResult = parseGeminiResponse(text);

    // STEP 3: Perform validation in JavaScript
    const { validateExtraction } = await import("./validation.js");
    const validationResult = validateExtraction(
      extractionResult,
      record,
      validPlacas
    );

    // Combine extraction, validation, and quality score
    return {
      extracciones: {
        numeroVale: extractionResult.numeroVale.valor,
        placa: extractionResult.placa.valor,
        m3: extractionResult.m3.valor,
        fecha: extractionResult.fecha.valor,
      },
      confianzas: {
        numeroVale: extractionResult.numeroVale.confianza,
        placa: extractionResult.placa.confianza,
        m3: extractionResult.m3.confianza,
        fecha: extractionResult.fecha.confianza,
      },
      comparaciones: validationResult.comparaciones,
      aprobado: validationResult.aprobado,
      status: validationResult.status,
      manualReviewReason: validationResult.manualReviewReason,
      qualityScore: qualityScore,
    };
  } finally {
    // Always clean up temp files.
    if (fs.existsSync(localDir)) {
      fs.rmSync(localDir, { recursive: true });
    }
  }
}
