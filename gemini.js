import { GoogleGenerativeAI } from "@google/generative-ai";
import { getBucket, downloadFile } from "./bucket.js";
import fs from "fs";
import path from "path";

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
async function checkImageQuality(model, imageBase64) {
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
    cleanedText = cleanedText.replace(/```json\n?/g, "").replace(/```\n?/g, "");
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
      let qualityScore = null;
      if (attempt === 0) {
        console.log(`🔍 Checking image quality for record ${record.rowId}...`);
        try {
          const qualityCheck = await checkImageQuality(model, imageBase64);
          qualityScore = qualityCheck.qualityScore;
          console.log(
            `📊 Quality score: ${qualityCheck.qualityScore}/10 - Readable: ${qualityCheck.isReadable}`
          );

          if (!qualityCheck.isReadable) {
            console.log(
              `⚠️ Image quality too low (score: ${qualityCheck.qualityScore}). Marking for manual review.`
            );
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
      }

      // STEP 2: Call Gemini for extraction only
      const referenceValues = {
        numeroVale: record.numeroVale || "",
        placa: record.placa || "",
        m3: record.m3 || "",
        fecha: record.fecha || "",
      };
      const prompt = buildExtractionPrompt(validPlacas, referenceValues);

      if (attempt === 0) {
        console.log(
          `🤖 Calling Gemini for extraction on record ${record.rowId}...`
        );
      } else {
        console.log(
          `🔄 Retry ${attempt}/${maxRetries - 1} for record ${record.rowId}...`
        );
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

      let extractionResult;
      try {
        extractionResult = JSON.parse(cleanedText);
      } catch (parseError) {
        console.warn(
          `⚠️ JSON parse error for ${record.rowId}:`,
          parseError.message
        );
        console.warn(`Response text: ${cleanedText.substring(0, 500)}...`);

        // Retry on JSON parse errors (Gemini might have returned malformed JSON)
        if (attempt < maxRetries - 1) {
          lastError = new Error(`JSON parse error: ${parseError.message}`);
          const delay = baseDelay * Math.pow(2, attempt);
          console.log(
            `⏳ Retrying due to malformed JSON, waiting ${delay / 1000}s...`
          );
          await sleep(delay);
          continue;
        }
        throw parseError;
      }

      // STEP 3: Perform validation in JavaScript
      const { validateExtraction } = await import("./validation.js");
      const validationResult = validateExtraction(
        extractionResult,
        record,
        validPlacas
      );

      // Combine extraction, validation, and quality score
      const auditResult = {
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

      // Clean up temp files
      fs.rmSync(localDir, { recursive: true });

      return auditResult;
    } catch (error) {
      lastError = error;

      // Check if it's a rate limit error (429) or server error (5xx)
      const isRetriable =
        error.status === 429 || (error.status >= 500 && error.status < 600);

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
          (detail) =>
            detail["@type"] === "type.googleapis.com/google.rpc.RetryInfo"
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
