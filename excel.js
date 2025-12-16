import ExcelJS from "exceljs";

export async function exportToExcelBuffer(data) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Resumen");

  sheet.columns = [
    { header: "Obra", key: "obra", width: 25 },
    { header: "Frente", key: "frente", width: 25 },
    { header: "Unidad de Control", key: "unidadDeControl", width: 25 },
    {
      header: "Estado Unidad de Control",
      key: "estadoUnidadDeControl",
      width: 25,
    },
    { header: "Material", key: "material", width: 30 },
    { header: "Cupo", key: "cupo", width: 12, style: { numFmt: "#,##0.00" } },
    {
      header: "Consumido anterior",
      key: "consumidoAnterior",
      width: 18,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Consumido hoy",
      key: "consumidoHoy",
      width: 15,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Consumido total",
      key: "consumidoTotal",
      width: 15,
      style: { numFmt: "#,##0.00" },
    },
    {
      header: "Saldo",
      key: "disponible",
      width: 12,
      style: { numFmt: "#,##0.00" },
    },
  ];

  sheet.addRows(
    data.map((row) => ({
      obra: row.obra,
      frente: row.frente,
      unidadDeControl: row.unidadDeControl,
      estadoUnidadDeControl: row.estadoUnidadDeControl,
      material: row.material,
      cupo: row.cupo,
      consumidoAnterior: row.consumidoAnterior,
      consumidoHoy: row.consumidoHoy,
      consumidoTotal: row.consumidoTotal,
      disponible: row.disponible,
    }))
  );

  sheet.addTable({
    name: "ResumenConsumo",
    ref: "A1",
    headerRow: true,
    style: {
      theme: "TableStyleMedium9",
      showRowStripes: true,
    },
    columns: sheet.columns.map((col) => ({
      name: col.header,
      filterButton: true,
    })),
    rows: data.map((row) => [
      row.obra,
      row.frente,
      row.unidadDeControl,
      row.material,
      row.cupo,
      row.consumidoAnterior,
      row.consumidoHoy,
      row.consumidoTotal,
      row.disponible,
    ]),
  });

  const startRow = 2;
  data.forEach((row, i) => {
    const cell = sheet.getCell(`I${i + startRow}`);
    cell.numFmt = "#,##0.00";
    if (cell.value < 0) {
      cell.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFC7CE" },
      };
      cell.font = { color: { argb: "9C0006" } };
    }
  });

  return workbook.xlsx.writeBuffer();
}

/**
 * Export audit results to Excel buffer
 */
export async function exportAuditToExcelBuffer(auditResults) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Auditoría Vales");

  // Define columns
  sheet.columns = [
    { header: "ID", key: "row_id", width: 25 },
    { header: "Imagen Vale", key: "image_url", width: 20 },
    { header: "Estado", key: "status", width: 20 },
    { header: "Aprobado", key: "aprobado", width: 12 },
    { header: "Número Vale", key: "numeroVale", width: 15 },
    { header: "Vale (Extraído)", key: "numeroVale_extracted", width: 18 },
    { header: "Vale Coincide", key: "numeroVale_match", width: 15 },
    { header: "Vale Confianza", key: "numeroVale_confidence", width: 15 },
    { header: "Placa", key: "placa", width: 12 },
    { header: "Placa (Extraída)", key: "placa_extracted", width: 15 },
    { header: "Placa Coincide", key: "placa_match", width: 15 },
    { header: "Placa Confianza", key: "placa_confidence", width: 15 },
    { header: "M3", key: "m3", width: 10 },
    { header: "M3 (Extraído)", key: "m3_extracted", width: 15 },
    { header: "M3 Coincide", key: "m3_match", width: 12 },
    { header: "M3 Confianza", key: "m3_confidence", width: 15 },
    { header: "Fecha", key: "fecha", width: 15 },
    { header: "Fecha (Extraída)", key: "fecha_extracted", width: 15 },
    { header: "Fecha Coincide", key: "fecha_match", width: 15 },
    { header: "Fecha Confianza", key: "fecha_confidence", width: 15 },
    { header: "Calidad Imagen", key: "quality_score", width: 15 },
    { header: "Motivo Revisión", key: "manual_review_reason", width: 50 },
    { header: "Discrepancias", key: "discrepancies", width: 50 },
    { header: "Error", key: "error", width: 50 },
  ];

  // Add rows
  const rows = auditResults.map((result) => {
    // Generate public image URL from result.image_path if available
    const imageUrl = result.image_path
      ? `https://storage.googleapis.com/image_audits/${result.image_path}`
      : "";

    if (result.status === "error") {
      return {
        row_id: result.row_id,
        image_url: imageUrl,
        status: "ERROR",
        aprobado: "N/A",
        numeroVale: result.appsheet_values?.numeroVale || "",
        numeroVale_extracted: "",
        numeroVale_match: "N/A",
        numeroVale_confidence: "N/A",
        placa: result.appsheet_values?.placa || "",
        placa_extracted: "",
        placa_match: "N/A",
        placa_confidence: "N/A",
        m3: result.appsheet_values?.m3 || "",
        m3_extracted: "",
        m3_match: "N/A",
        m3_confidence: "N/A",
        fecha: result.appsheet_values?.fecha || "",
        fecha_extracted: "",
        fecha_match: "N/A",
        fecha_confidence: "N/A",
        quality_score: "N/A",
        manual_review_reason: "",
        discrepancies: "",
        error: result.error,
      };
    }

    const comparaciones = result.comparaciones || {};
    const discrepancyList = (result.discrepancies || [])
      .map(
        (d) =>
          `${d.field}: esperado="${d.expected}", extraído="${d.extracted}" (${d.reason})`
      )
      .join(" | ");

    // Format status in Spanish
    let statusDisplay = result.status;
    if (result.status === "aprobado") statusDisplay = "APROBADO";
    else if (result.status === "requiere_revision_manual") statusDisplay = "REVISIÓN MANUAL";
    else if (result.status === "inconsistencias_encontradas") statusDisplay = "INCONSISTENCIAS";

    // Handle quality < 6 case (no extraction performed)
    const isLowQuality = result.status === "requiere_revision_manual" && result.qualityScore && result.qualityScore < 6;

    return {
      row_id: result.row_id,
      image_url: imageUrl,
      status: statusDisplay,
      aprobado: result.aprobado ? "SÍ" : "NO",
      numeroVale: result.appsheet_values?.numeroVale || "",
      numeroVale_extracted: isLowQuality ? "N/A" : (result.gemini_extraction?.numeroVale || ""),
      numeroVale_match: isLowQuality ? "N/A" : (comparaciones.numeroVale?.coincide ? "SÍ" : "NO"),
      numeroVale_confidence: isLowQuality ? "N/A" : (comparaciones.numeroVale?.confianza?.toFixed(2) || "0.00"),
      placa: result.appsheet_values?.placa || "",
      placa_extracted: isLowQuality ? "N/A" : (result.gemini_extraction?.placa || ""),
      placa_match: isLowQuality ? "N/A" : (comparaciones.placa?.coincide ? "SÍ" : "NO"),
      placa_confidence: isLowQuality ? "N/A" : (comparaciones.placa?.confianza?.toFixed(2) || "0.00"),
      m3: result.appsheet_values?.m3 || "",
      m3_extracted: isLowQuality ? "N/A" : (result.gemini_extraction?.m3 || ""),
      m3_match: isLowQuality ? "N/A" : (comparaciones.m3?.coincide ? "SÍ" : "NO"),
      m3_confidence: isLowQuality ? "N/A" : (comparaciones.m3?.confianza?.toFixed(2) || "0.00"),
      fecha: result.appsheet_values?.fecha || "",
      fecha_extracted: isLowQuality ? "N/A" : (result.gemini_extraction?.fecha || ""),
      fecha_match: isLowQuality ? "N/A" : (comparaciones.fecha?.coincide ? "SÍ" : "NO"),
      fecha_confidence: isLowQuality ? "N/A" : (comparaciones.fecha?.confianza?.toFixed(2) || "0.00"),
      quality_score: result.qualityScore ? `${result.qualityScore}/10` : "N/A",
      manual_review_reason: result.manualReviewReason || "",
      discrepancies: discrepancyList,
      error: result.error || "",
    };
  });

  sheet.addRows(rows);

  // Style header row
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).fill = {
    type: "pattern",
    pattern: "solid",
    fgColor: { argb: "FF4472C4" },
  };
  sheet.getRow(1).font = { bold: true, color: { argb: "FFFFFFFF" } };

  // Highlight rows based on status
  const startRow = 2;
  rows.forEach((row, i) => {
    const rowNum = i + startRow;
    const excelRow = sheet.getRow(rowNum);

    // Add hyperlink to image URL column (column B)
    if (row.image_url) {
      const imageCell = sheet.getCell(`B${rowNum}`);
      imageCell.value = {
        text: "Ver Imagen",
        hyperlink: row.image_url,
      };
      imageCell.font = { color: { argb: "FF0563C1" }, underline: true };
    }

    if (row.status === "ERROR") {
      // Red background for errors
      excelRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFC7CE" },
      };
    } else if (row.status === "REVISIÓN MANUAL") {
      // Orange background for manual review
      excelRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFD966" },
      };
    } else if (row.aprobado === "NO") {
      // Yellow background for discrepancies
      excelRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFEB9C" },
      };
    } else {
      // Green background for approved
      excelRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFC6EFCE" },
      };
    }

    // Color code the "match" columns (G, K, O, S - accounting for new confidence columns)
    ["G", "K", "O", "S"].forEach((col) => {
      const cell = sheet.getCell(`${col}${rowNum}`);
      if (cell.value === "NO") {
        cell.font = { color: { argb: "FF9C0006" }, bold: true };
      } else if (cell.value === "SÍ") {
        cell.font = { color: { argb: "FF006100" }, bold: true };
      }
    });

    // Color code confidence columns based on value (H, L, P, T)
    ["H", "L", "P", "T"].forEach((col) => {
      const cell = sheet.getCell(`${col}${rowNum}`);
      if (cell.value !== "N/A" && typeof cell.value === "string") {
        const confValue = parseFloat(cell.value);
        if (!isNaN(confValue)) {
          if (confValue < 0.6) {
            cell.font = { color: { argb: "FF9C0006" }, bold: true }; // Red for low confidence
          } else if (confValue >= 0.6 && confValue < 0.8) {
            cell.font = { color: { argb: "FFE97132" } }; // Orange for medium confidence
          } else {
            cell.font = { color: { argb: "FF006100" } }; // Green for high confidence
          }
        }
      }
    });
  });

  return workbook.xlsx.writeBuffer();
}
