import { GoogleGenerativeAI } from "@google/generative-ai";
import { getBucket, downloadFile } from "./bucket.js";
import fs from "fs";
import path from "path";

/**
 * Build the audit prompt for Gemini
 */
function buildAuditPrompt(record, validPlacas) {
  const currentYear = new Date().getFullYear();

  return `You are an expert auditor for construction material transport documents (vales) in Colombia and Costa Rica.

**YOUR TASK:**
1. Extract 4 key fields from the vale image
2. Compare extracted values with the reference data provided
3. Account for handwriting variations and OCR challenges

**FIELD EXTRACTION:**
Extract these 4 fields:
1. **numero_vale**: Printed/stamped number in top right corner (NOT handwritten, easy to read)
2. **placa**: Vehicle license plate (after "PLACA" label, handwritten)
3. **m3**: Cubic meters quantity (in "CANTIDAD" field, look for handwritten number followed by "M3" checkbox)
4. **fecha**: Date (after "FECHA" label, format usually DD-MM-YY or DD/MM/YY, handwritten)

**REFERENCE DATA TO COMPARE:**
${JSON.stringify(
  {
    numeroVale: record.numeroVale,
    placa: record.placa,
    m3: record.m3,
    fecha: record.fecha, // Format: DD/MM/YYYY
  },
  null,
  2
)}

**VALID PLACAS LIST** (for fuzzy matching - ${validPlacas.length} total):
${validPlacas.join(", ")}

**COMPARISON RULES:**

1. **numero_vale**:
   - This is PRINTED/STAMPED (not handwritten), so should be very clear and easy to read
   - If the printed/stamped number matches the reference exactly, mark as coincide=true
   - Do NOT create false discrepancies or mention "control numbers"
   - Only mark as false if there is a clear, visible difference
   - High confidence expected (0.95-1.0 for exact matches)

2. **placa**:
   - This is HANDWRITTEN - be VERY flexible
   - Letters can be misread (T↔I, O↔D, N↔H, etc.)
   - Try to match against the valid placas list
   - If extracted placa is similar to a valid placa, use the valid placa
   - Example: If you read "TIN893" but valid list has "TTN893", consider them matching
   - Prioritize matches from the valid placas list

3. **m3**:
   - CRITICAL FIELD - must match EXACTLY
   - NO TOLERANCE for differences
   - Handwritten number must equal reference value
   - 16 ≠ 15, 16 ≠ 10
   - Be careful with digit recognition (6 vs 0, 1 vs 7, 3 vs 8)

4. **fecha**:
   - This is HANDWRITTEN
   - Image uses DD-MM-YY or DD/MM/YY format (2-digit year)
   - Reference uses DD/MM/YYYY format (4-digit year)
   - **CRITICAL: The current year is ${currentYear}**
   - When you see a 2-digit year like "25" or "23", it MUST be "20${
     currentYear % 100
   }" (i.e., "2025")
   - Recent vales are from late ${currentYear}, so years like "23" are likely misreads of "25"
   - Be flexible: 04-12-25 = 04/12/2025
   - Handwriting can make digits look similar: 2↔7, 1↔7, 3↔8, 5↔3, 5↔6
   - **Allow 1-day difference**: Dates that differ by exactly 1 day should STILL be marked as coincide=true (confidence ~0.9)
   - Example: 01/12/2025 vs 02/12/2025 = coincide=true (1 day tolerance)

**CONFIDENCE SCORING:**
- 1.0 = Perfect match, crystal clear
- 0.8-0.9 = Very likely match, minor OCR ambiguity
- 0.6-0.7 = Probable match, significant handwriting challenge
- 0.4-0.5 = Uncertain, major discrepancy but possibly explainable
- 0.0-0.3 = Clear mismatch

**RESPONSE FORMAT:**
Return ONLY valid JSON (no markdown, no extra text).
**IMPORTANT: All "observacion" fields must be in Spanish.**

{
  "extracciones": {
    "numeroVale": "extracted value",
    "placa": "extracted value (use closest valid placa if fuzzy match)",
    "m3": "extracted value",
    "fecha": "extracted value in DD/MM/YYYY format"
  },
  "comparaciones": {
    "numeroVale": {
      "coincide": true/false,
      "confianza": 0.0-1.0,
      "observacion": "Only explain if coincide=false, otherwise leave empty string (in Spanish)"
    },
    "placa": {
      "coincide": true/false,
      "confianza": 0.0-1.0,
      "observacion": "Only explain if there's a fuzzy match or mismatch, otherwise leave empty string (in Spanish)"
    },
    "m3": {
      "coincide": true/false,
      "confianza": 0.0-1.0,
      "observacion": "Only explain if coincide=false, otherwise leave empty string (in Spanish)"
    },
    "fecha": {
      "coincide": true/false,
      "confianza": 0.0-1.0,
      "observacion": "Only explain if there's a date issue or 1-day tolerance applied, otherwise leave empty string (in Spanish)"
    }
  },
  "aprobado": true/false
}

Set "aprobado" to true if all 4 fields have coincide=true with confianza >= 0.6

Examples of observacion in Spanish:
- "Coincidencia exacta"
- "Diferencia de 1 día, dentro de tolerancia"
- "Placa coincide con lista válida"
- "Cantidad no coincide: extraído 15, esperado 16"`;
}

/**
 * Sleep helper for exponential backoff
 */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Call Gemini Vision API to audit a vale image with exponential backoff retry
 */
export async function auditWithGemini(record, imagePathInBucket, validPlacas) {
  const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
  // Use model from env or default to gemini-1.5-flash (more stable and higher quota)
  const modelName = process.env.GEMINI_MODEL || "gemini-1.5-flash";
  const model = genAI.getGenerativeModel({ model: modelName });

  const bucket = getBucket();
  if (!bucket) {
    throw new Error("Bucket not available");
  }

  const localDir = "./temp_audit";
  if (!fs.existsSync(localDir)) {
    fs.mkdirSync(localDir, { recursive: true });
  }

  const maxRetries = parseInt(process.env.GEMINI_MAX_RETRIES || "4");
  const baseDelay = 1000; // Start with 1 second
  let lastError;

  for (let attempt = 0; attempt < maxRetries; attempt++) {
    try {
      // Download the actual vale image (only on first attempt)
      const localImagePath = path.join(
        localDir,
        path.basename(imagePathInBucket)
      );

      if (attempt === 0) {
        await downloadFile(bucket, imagePathInBucket, localImagePath);
      }

      const imageBuffer = fs.readFileSync(localImagePath);
      const imageBase64 = imageBuffer.toString("base64");

      // Prepare image for Gemini (only the actual vale, no template)
      const imageParts = [
        {
          inlineData: {
            data: imageBase64,
            mimeType: "image/jpeg",
          },
        },
      ];

      const prompt = buildAuditPrompt(record, validPlacas);

      if (attempt === 0) {
        console.log(`🤖 Calling Gemini for record ${record.rowId}...`);
      } else {
        console.log(`🔄 Retry ${attempt}/${maxRetries - 1} for record ${record.rowId}...`);
      }

      const result = await model.generateContent([prompt, ...imageParts]);
      const response = result.response;
      const text = response.text();

      // Clean up response (remove markdown code blocks if present)
      let cleanedText = text.trim();
      if (cleanedText.startsWith("```json")) {
        cleanedText = cleanedText
          .replace(/```json\n?/g, "")
          .replace(/```\n?/g, "");
      } else if (cleanedText.startsWith("```")) {
        cleanedText = cleanedText.replace(/```\n?/g, "");
      }

      const auditResult = JSON.parse(cleanedText);

      // Clean up temp files
      fs.rmSync(localDir, { recursive: true });

      return auditResult;
    } catch (error) {
      lastError = error;

      // Check if it's a rate limit error (429) or server error (5xx)
      const isRetriable = error.status === 429 || (error.status >= 500 && error.status < 600);

      if (!isRetriable || attempt === maxRetries - 1) {
        // Not retriable or last attempt - fail now
        if (fs.existsSync(localDir)) {
          fs.rmSync(localDir, { recursive: true });
        }
        throw error;
      }

      // Calculate exponential backoff: 1s, 2s, 4s, 8s, etc.
      const delay = baseDelay * Math.pow(2, attempt);

      // Extract retry delay from error if available (for 429 errors)
      let actualDelay = delay;
      if (error.status === 429 && error.errorDetails) {
        const retryInfo = error.errorDetails.find(
          (detail) => detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
        );
        if (retryInfo?.retryDelay) {
          const delayMatch = retryInfo.retryDelay.match(/(\d+)s/);
          if (delayMatch) {
            actualDelay = parseInt(delayMatch[1]) * 1000;
          }
        }
      }

      console.log(
        `⏳ Rate limit/error for ${record.rowId}, waiting ${
          actualDelay / 1000
        }s before retry ${attempt + 1}/${maxRetries - 1}...`
      );
      await sleep(actualDelay);
    }
  }

  // Clean up temp files if all retries failed
  if (fs.existsSync(localDir)) {
    fs.rmSync(localDir, { recursive: true });
  }
  throw lastError;
}
