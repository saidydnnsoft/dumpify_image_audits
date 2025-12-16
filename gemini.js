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
1. **numero_vale**: Printed/stamped number (usually top right corner, but image may be rotated - look for large printed/stamped number labeled "No." or similar)
2. **placa**: Vehicle license plate (after "PLACA" label, handwritten - use valid placas list below to help identify correct characters)
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

**VALID PLACAS LIST** (to help identify handwritten characters - ${validPlacas.length} total):
${validPlacas.join(", ")}

**COMPARISON RULES:**

1. **numero_vale**:
   - This is PRINTED/STAMPED (not handwritten) - should be very clear
   - MUST match the reference EXACTLY character-by-character
   - Extract ONLY the printed/stamped number (ignore any handwritten corrections or notes)
   - If printed number is "97837" but reference is "57837" → coincide=false
   - Do NOT make up alternative explanations or consider handwritten numbers
   - If they don't match exactly → coincide=false, explain in observacion
   - High confidence required: 0.95-1.0 for exact matches, <0.5 for mismatches

2. **placa**:
   - This is HANDWRITTEN - extract what you see
   - Use the valid placas list as a REFERENCE to help identify ambiguous handwritten characters
   - Example: If handwriting looks like "CVB8q1" or "CVB891", check if "CVB891" is in valid placas list
   - IMPORTANT: Only use exact matches - no fuzzy matching
   - If what you extract doesn't EXACTLY match the reference → coincide=false
   - The valid placas list helps you READ the handwriting correctly, not to auto-approve mismatches
   - Be honest in observacion about extraction uncertainty

3. **m3**:
   - CRITICAL FIELD - must match EXACTLY
   - NO TOLERANCE for differences whatsoever
   - Handwritten number must equal reference value precisely
   - 16 ≠ 15, 16 ≠ 10, 12 ≠ 11
   - Be extremely careful with digit recognition (6 vs 0, 1 vs 7, 3 vs 8)
   - Double-check before confirming

4. **fecha**:
   - This is HANDWRITTEN
   - Image uses DD-MM-YY or DD/MM/YY format (2-digit year)
   - Reference uses DD/MM/YYYY format (4-digit year)
   - **CRITICAL: The current year is ${currentYear}**
   - When you see "25" as year, interpret as "2025"
   - Be flexible with format: 04-12-25 = 04/12/2025
   - Handwriting can make digits look similar: 2↔7, 1↔7, 3↔8, 5↔3, 5↔6, 0↔9
   - **Allow up to 2-day difference**: Dates that differ by 1 or 2 days should be marked as coincide=true (confidence ~0.85-0.9)
   - Examples:
     * 10/12/2025 vs 09/12/2025 = coincide=true (1 day, within tolerance)
     * 10/12/2025 vs 12/12/2025 = coincide=true (2 days, within tolerance)
     * 10/12/2025 vs 13/12/2025 = coincide=false (3 days, exceeds tolerance)
     * 10/12/2025 vs 04/12/2025 = coincide=false (6 days, exceeds tolerance)

**CONFIDENCE SCORING:**
- 1.0 = Perfect match, crystal clear
- 0.8-0.9 = Very likely match, minor OCR ambiguity
- 0.6-0.7 = Probable match, significant handwriting challenge
- 0.4-0.5 = Uncertain, major discrepancy but possibly explainable
- 0.0-0.3 = Clear mismatch

**CRITICAL RULE FOR coincide:**
- ONLY set coincide=true if your confianza is >= 0.6
- If confianza < 0.6, you MUST set coincide=false (even if it might match)
- This ensures consistency: coincide=true always means the field is acceptable

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

**APPROVAL RULE (CRITICAL):**
Set "aprobado" to true ONLY if ALL 4 fields have coincide=true

Since you're already required to set coincide=true only when confianza >= 0.6, you just need to check:
- If ALL fields have coincide=true → aprobado=true
- If ANY field has coincide=false → aprobado=false

Examples of observacion in Spanish:
- "Coincidencia exacta"
- "Diferencia de 1 día, dentro de tolerancia"
- "Número impreso no coincide con referencia"
- "Cantidad no coincide: extraído 15, esperado 16"
- "Fecha fuera de tolerancia (diferencia de 6 días)"`;
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
async function checkImageQuality(model, imageBase64) {
  const qualityPrompt = `You are an image quality assessor for document scanning.

Analyze this vale (transport document) image and rate its quality on a scale of 0-10.

**Quality criteria:**
- 0-3: Severely illegible (heavy blur, extreme overexposure/underexposure, text unreadable)
- 4-5: Poor quality (significant blur, poor lighting, most text difficult to read)
- 6-7: Acceptable quality (some blur or lighting issues, but main text is readable)
- 8-10: Good to excellent quality (clear, well-lit, text easily readable)

**Focus on:**
- Can you clearly read the printed number in the top right corner?
- Can you read the handwritten fields (PLACA, CANTIDAD, FECHA)?
- Is the lighting adequate?
- Is the image focused (not blurry)?

Return ONLY valid JSON (no markdown):
{
  "qualityScore": 0-10,
  "isReadable": true/false,
  "reason": "Brief explanation in Spanish of quality issues if any"
}

Set "isReadable" to true only if qualityScore >= 6.`;

  const imageParts = [
    {
      inlineData: {
        data: imageBase64,
        mimeType: "image/jpeg",
      },
    },
  ];

  const result = await model.generateContent([qualityPrompt, ...imageParts]);
  const response = result.response;
  const text = response.text();

  // Clean up response
  let cleanedText = text.trim();
  if (cleanedText.startsWith("```json")) {
    cleanedText = cleanedText
      .replace(/```json\n?/g, "")
      .replace(/```\n?/g, "");
  } else if (cleanedText.startsWith("```")) {
    cleanedText = cleanedText.replace(/```\n?/g, "");
  }

  return JSON.parse(cleanedText);
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

      // STEP 1: Check image quality first
      if (attempt === 0) {
        console.log(`🔍 Checking image quality for record ${record.rowId}...`);
        try {
          const qualityCheck = await checkImageQuality(model, imageBase64);
          console.log(`📊 Quality score: ${qualityCheck.qualityScore}/10 - Readable: ${qualityCheck.isReadable}`);

          if (!qualityCheck.isReadable) {
            console.log(`⚠️ Image quality too low (score: ${qualityCheck.qualityScore}). Marking for manual review.`);
            // Clean up temp files
            fs.rmSync(localDir, { recursive: true });

            return {
              requiresManualReview: true,
              qualityScore: qualityCheck.qualityScore,
              reason: qualityCheck.reason,
              extracciones: {
                numeroVale: "",
                placa: "",
                m3: "",
                fecha: ""
              },
              comparaciones: {
                numeroVale: { coincide: false, confianza: 0, observacion: "Imagen ilegible - requiere revisión manual" },
                placa: { coincide: false, confianza: 0, observacion: "Imagen ilegible - requiere revisión manual" },
                m3: { coincide: false, confianza: 0, observacion: "Imagen ilegible - requiere revisión manual" },
                fecha: { coincide: false, confianza: 0, observacion: "Imagen ilegible - requiere revisión manual" }
              },
              aprobado: false
            };
          }
        } catch (qualityError) {
          console.warn(`⚠️ Quality check failed, proceeding with audit anyway:`, qualityError.message);
          // If quality check fails, continue with normal audit
        }
      }

      // STEP 2: Proceed with normal audit
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

      let auditResult;
      try {
        auditResult = JSON.parse(cleanedText);
      } catch (parseError) {
        console.warn(`⚠️ JSON parse error for ${record.rowId}:`, parseError.message);
        console.warn(`Response text: ${cleanedText.substring(0, 500)}...`);

        // Retry on JSON parse errors (Gemini might have returned malformed JSON)
        if (attempt < maxRetries - 1) {
          lastError = new Error(`JSON parse error: ${parseError.message}`);
          const delay = baseDelay * Math.pow(2, attempt);
          console.log(`⏳ Retrying due to malformed JSON, waiting ${delay / 1000}s...`);
          await sleep(delay);
          continue;
        }
        throw parseError;
      }

      // VALIDATION: Apply decision flow based on coincide and confianza
      const allFieldsCoincide = Object.keys(auditResult.comparaciones).every((field) => {
        return auditResult.comparaciones[field].coincide === true;
      });

      const allFieldsHighConfidence = Object.keys(auditResult.comparaciones).every((field) => {
        return auditResult.comparaciones[field].confianza >= 0.6;
      });

      const hasLowConfidenceOnMismatch = Object.keys(auditResult.comparaciones).some((field) => {
        const comp = auditResult.comparaciones[field];
        return comp.coincide === false && comp.confianza < 0.6;
      });

      // Decision flow:
      // 1. All match + all high confidence → aprobado
      // 2. All match + some low confidence → requiere_revision_manual
      // 3. Some mismatch + low confidence on mismatch → requiere_revision_manual
      // 4. Some mismatch + high confidence → inconsistencias_encontradas

      let correctStatus;
      let correctAprobado;

      if (allFieldsCoincide && allFieldsHighConfidence) {
        correctStatus = "aprobado";
        correctAprobado = true;
      } else if (allFieldsCoincide && !allFieldsHighConfidence) {
        correctStatus = "requiere_revision_manual";
        correctAprobado = false;
        auditResult.manualReviewReason = "Valores coinciden pero confianza de extracción baja";
      } else if (!allFieldsCoincide && hasLowConfidenceOnMismatch) {
        correctStatus = "requiere_revision_manual";
        correctAprobado = false;
        auditResult.manualReviewReason = "Inconsistencias detectadas con baja confianza";
      } else {
        correctStatus = "inconsistencias_encontradas";
        correctAprobado = false;
      }

      // Correct aprobado if needed
      if (auditResult.aprobado !== correctAprobado) {
        console.warn(`⚠️ Gemini set aprobado=${auditResult.aprobado} for ${record.rowId}. Correcting to ${correctAprobado} (status: ${correctStatus}).`);
        auditResult.aprobado = correctAprobado;
      }

      // Add status to result for downstream processing
      auditResult.status = correctStatus;

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
