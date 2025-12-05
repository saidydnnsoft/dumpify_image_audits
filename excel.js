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
    { header: "Estado", key: "status", width: 15 },
    { header: "Aprobado", key: "aprobado", width: 12 },
    { header: "Número Vale", key: "numeroVale", width: 15 },
    { header: "Vale (Extraído)", key: "numeroVale_extracted", width: 18 },
    { header: "Vale Coincide", key: "numeroVale_match", width: 15 },
    { header: "Placa", key: "placa", width: 12 },
    { header: "Placa (Extraída)", key: "placa_extracted", width: 15 },
    { header: "Placa Coincide", key: "placa_match", width: 15 },
    { header: "M3", key: "m3", width: 10 },
    { header: "M3 (Extraído)", key: "m3_extracted", width: 15 },
    { header: "M3 Coincide", key: "m3_match", width: 12 },
    { header: "Fecha", key: "fecha", width: 15 },
    { header: "Fecha (Extraída)", key: "fecha_extracted", width: 15 },
    { header: "Fecha Coincide", key: "fecha_match", width: 15 },
    { header: "Discrepancias", key: "discrepancies", width: 50 },
    { header: "Error", key: "error", width: 50 },
  ];

  // Add rows
  const rows = auditResults.map((result) => {
    if (result.status === "error") {
      return {
        row_id: result.row_id,
        status: "ERROR",
        aprobado: "N/A",
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

    return {
      row_id: result.row_id,
      status: result.status,
      aprobado: result.aprobado ? "SÍ" : "NO",
      numeroVale: result.appsheet_values?.numeroVale || "",
      numeroVale_extracted: result.gemini_extraction?.numeroVale || "",
      numeroVale_match: comparaciones.numeroVale?.coincide ? "SÍ" : "NO",
      placa: result.appsheet_values?.placa || "",
      placa_extracted: result.gemini_extraction?.placa || "",
      placa_match: comparaciones.placa?.coincide ? "SÍ" : "NO",
      m3: result.appsheet_values?.m3 || "",
      m3_extracted: result.gemini_extraction?.m3 || "",
      m3_match: comparaciones.m3?.coincide ? "SÍ" : "NO",
      fecha: result.appsheet_values?.fecha || "",
      fecha_extracted: result.gemini_extraction?.fecha || "",
      fecha_match: comparaciones.fecha?.coincide ? "SÍ" : "NO",
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

    if (row.status === "ERROR") {
      // Red background for errors
      excelRow.fill = {
        type: "pattern",
        pattern: "solid",
        fgColor: { argb: "FFFFC7CE" },
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

    // Color code the "match" columns
    ["F", "I", "L", "O"].forEach((col) => {
      const cell = sheet.getCell(`${col}${rowNum}`);
      if (cell.value === "NO") {
        cell.font = { color: { argb: "FF9C0006" }, bold: true };
      } else if (cell.value === "SÍ") {
        cell.font = { color: { argb: "FF006100" }, bold: true };
      }
    });
  });

  return workbook.xlsx.writeBuffer();
}
