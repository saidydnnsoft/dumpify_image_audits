/**
 * Validation logic for comparing extracted values with expected values
 */

/**
 * Compare two dates with tolerance of ±2 days
 */
function compareDates(extractedDate, expectedDate) {
  if (!extractedDate || !expectedDate) {
    return {
      coincide: false,
      observacion: "Fecha vacía o inválida"
    };
  }

  try {
    // Parse dates (format: DD/MM/YYYY)
    const [eDay, eMonth, eYear] = extractedDate.split("/").map(Number);
    const [xDay, xMonth, xYear] = expectedDate.split("/").map(Number);

    const extracted = new Date(eYear, eMonth - 1, eDay);
    const expected = new Date(xYear, xMonth - 1, xDay);

    // Calculate difference in days
    const diffTime = Math.abs(extracted - expected);
    const diffDays = Math.ceil(diffTime / (1000 * 60 * 60 * 24));

    if (diffDays === 0) {
      return {
        coincide: true,
        observacion: ""
      };
    } else if (diffDays <= 2) {
      return {
        coincide: true,
        observacion: `Diferencia de ${diffDays} día(s), dentro de tolerancia`
      };
    } else {
      return {
        coincide: false,
        observacion: `Diferencia de ${diffDays} días, fuera de tolerancia (máximo 2 días)`
      };
    }
  } catch (error) {
    return {
      coincide: false,
      observacion: `Error al comparar fechas: ${error.message}`
    };
  }
}

/**
 * Compare placa - exact match only
 */
function comparePlaca(extractedPlaca, expectedPlaca) {
  if (!extractedPlaca) {
    return {
      coincide: false,
      observacion: "Placa no extraída"
    };
  }

  // Clean up placas (remove spaces, uppercase)
  const extracted = extractedPlaca.trim().toUpperCase();
  const expected = expectedPlaca.trim().toUpperCase();

  // Exact match only
  if (extracted === expected) {
    return {
      coincide: true,
      observacion: ""
    };
  } else {
    return {
      coincide: false,
      observacion: `Placa extraída "${extracted}" no coincide con "${expected}"`
    };
  }
}

/**
 * Main validation function
 * @param {Object} extractionResult - Result from Gemini extraction
 * @param {Object} expectedValues - Expected values from AppSheet
 * @param {Array} validPlacas - List of valid placas
 * @returns {Object} Validation result with comparaciones, aprobado, status
 */
export function validateExtraction(extractionResult, expectedValues, validPlacas) {
  const comparaciones = {};

  // 1. numeroVale - strict exact match (printed number)
  const numeroValeExtracted = extractionResult.numeroVale.valor;
  const numeroValeExpected = expectedValues.numeroVale;

  comparaciones.numeroVale = {
    coincide: numeroValeExtracted === numeroValeExpected,
    extracted: numeroValeExtracted,
    expected: numeroValeExpected,
    observacion: numeroValeExtracted === numeroValeExpected
      ? ""
      : `Número extraído "${numeroValeExtracted}" no coincide con "${numeroValeExpected}"`
  };

  // 2. placa - exact match only
  comparaciones.placa = comparePlaca(
    extractionResult.placa.valor,
    expectedValues.placa
  );
  comparaciones.placa.extracted = extractionResult.placa.valor;
  comparaciones.placa.expected = expectedValues.placa;

  // 3. m3 - exact numeric match (no tolerance)
  const m3Extracted = extractionResult.m3.valor;
  const m3Expected = String(expectedValues.m3);

  // Parse and compare as numbers
  const m3ExtractedNum = parseFloat(m3Extracted);
  const m3ExpectedNum = parseFloat(m3Expected);
  const m3Match = !isNaN(m3ExtractedNum) &&
                   !isNaN(m3ExpectedNum) &&
                   Math.abs(m3ExtractedNum - m3ExpectedNum) < 0.01; // Allow tiny floating point differences

  comparaciones.m3 = {
    coincide: m3Match,
    extracted: m3Extracted,
    expected: m3Expected,
    observacion: m3Match
      ? ""
      : `Cantidad extraída "${m3Extracted}" no coincide con "${m3Expected}"`
  };

  // 4. fecha - allow ±2 days tolerance
  const fechaComparison = compareDates(
    extractionResult.fecha.valor,
    expectedValues.fecha
  );
  comparaciones.fecha = {
    ...fechaComparison,
    extracted: extractionResult.fecha.valor,
    expected: expectedValues.fecha
  };

  // Check for empty extractions (manual review required)
  const hasEmptyExtraction =
    !numeroValeExtracted ||
    !extractionResult.placa.valor ||
    !m3Extracted ||
    !extractionResult.fecha.valor;

  if (hasEmptyExtraction) {
    return {
      comparaciones,
      aprobado: false,
      status: "requiere_revision_manual",
      manualReviewReason: "Uno o más campos no pudieron ser extraídos"
    };
  }

  // Check confidence levels (low confidence = manual review)
  const lowConfidenceFields = [];
  const CONFIDENCE_THRESHOLD = 0.7;

  if (extractionResult.numeroVale.confianza < CONFIDENCE_THRESHOLD) {
    lowConfidenceFields.push(`numeroVale (${(extractionResult.numeroVale.confianza * 100).toFixed(0)}%)`);
  }
  if (extractionResult.placa.confianza < CONFIDENCE_THRESHOLD) {
    lowConfidenceFields.push(`placa (${(extractionResult.placa.confianza * 100).toFixed(0)}%)`);
  }
  if (extractionResult.m3.confianza < CONFIDENCE_THRESHOLD) {
    lowConfidenceFields.push(`m3 (${(extractionResult.m3.confianza * 100).toFixed(0)}%)`);
  }
  if (extractionResult.fecha.confianza < CONFIDENCE_THRESHOLD) {
    lowConfidenceFields.push(`fecha (${(extractionResult.fecha.confianza * 100).toFixed(0)}%)`);
  }

  // Decision logic
  const allMatch = Object.values(comparaciones).every(c => c.coincide);
  const hasLowConfidence = lowConfidenceFields.length > 0;

  if (allMatch && !hasLowConfidence) {
    // All fields match and high confidence
    return {
      comparaciones,
      aprobado: true,
      status: "aprobado",
      manualReviewReason: null
    };
  } else if (allMatch && hasLowConfidence) {
    // All match but low confidence on reading
    return {
      comparaciones,
      aprobado: false,
      status: "requiere_revision_manual",
      manualReviewReason: `Confianza baja en: ${lowConfidenceFields.join(", ")}`
    };
  } else if (!allMatch && hasLowConfidence) {
    // Mismatch with low confidence
    return {
      comparaciones,
      aprobado: false,
      status: "requiere_revision_manual",
      manualReviewReason: `Inconsistencias con confianza baja en: ${lowConfidenceFields.join(", ")}`
    };
  } else {
    // Mismatch with high confidence
    return {
      comparaciones,
      aprobado: false,
      status: "inconsistencias_encontradas",
      manualReviewReason: null
    };
  }
}
