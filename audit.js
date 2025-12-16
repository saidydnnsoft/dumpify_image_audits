import {
  getBucket,
  getProcessedRowIds,
  writeJSON,
  addToProcessedIndex,
  getValidPlacas,
} from "./bucket.js";
import { auditWithGemini } from "./gemini.js";
import { exportAuditToExcelBuffer } from "./excel.js";
import { sendAuditEmail, createTransporter } from "./email.js";

/**
 * Get list of row IDs that haven't been processed yet
 */
export async function getUnprocessedRecords(records, datePath) {
  const bucket = getBucket();
  if (!bucket) {
    console.log("⚠️ No bucket available, processing all records");
    return records;
  }

  const processedIds = await getProcessedRowIds(bucket, datePath);
  console.log(`📊 Found ${processedIds.length} already processed records`);

  const unprocessed = records.filter(
    (record) => !processedIds.includes(record.rowId)
  );

  console.log(
    `📝 ${unprocessed.length} records remaining to process (${records.length} total)`
  );

  return unprocessed;
}

/**
 * Process a single record with Gemini
 */
export async function auditRecord(record, imagePath, datePath, validPlacas) {
  const rowId = record.rowId;

  try {
    console.log(`🔍 Auditing record: ${rowId}`);

    // Call Gemini to audit the vale
    const geminiResult = await auditWithGemini(record, imagePath, validPlacas);

    // Check if manual review is required
    if (geminiResult.requiresManualReview) {
      const manualReviewResult = {
        row_id: rowId,
        timestamp: new Date().toISOString(),
        aprobado: false,
        obra: record.obra || null,
        image_path: imagePath,
        gemini_extraction: geminiResult.extracciones,
        appsheet_values: {
          numeroVale: record.numeroVale || null,
          placa: record.placa || null,
          m3: record.m3 || null,
          fecha: record.fecha || null,
        },
        comparaciones: geminiResult.comparaciones,
        discrepancies: [],
        status: "requiere_revision_manual",
        qualityScore: geminiResult.qualityScore,
        manualReviewReason: geminiResult.reason,
        error: null,
      };

      // Save to bucket
      const bucket = getBucket();
      if (bucket) {
        const auditPath = `audits/${datePath}/manual_review/${rowId}.json`;
        await writeJSON(bucket, auditPath, manualReviewResult);

        // Add to processed index so it doesn't retry
        await addToProcessedIndex(bucket, datePath, rowId);
      }

      return manualReviewResult;
    }

    // Build discrepancies list
    const discrepancies = [];

    Object.keys(geminiResult.comparaciones).forEach((field) => {
      const comparison = geminiResult.comparaciones[field];
      if (!comparison.coincide) {
        discrepancies.push({
          field,
          extracted: geminiResult.extracciones[field],
          expected: record[field],
          confidence: comparison.confianza,
          reason: comparison.observacion,
        });
      }
    });

    const auditResult = {
      row_id: rowId,
      timestamp: new Date().toISOString(),
      aprobado: geminiResult.aprobado,
      obra: record.obra || null,
      image_path: imagePath,
      gemini_extraction: geminiResult.extracciones,
      appsheet_values: {
        numeroVale: record.numeroVale || null,
        placa: record.placa || null,
        m3: record.m3 || null,
        fecha: record.fecha || null,
      },
      comparaciones: geminiResult.comparaciones,
      discrepancies,
      status: geminiResult.status || (geminiResult.aprobado ? "aprobado" : "inconsistencias_encontradas"),
      manualReviewReason: geminiResult.manualReviewReason || null,
      error: null,
    };

    // Save audit result to bucket (new YYYY/MM/DD structure)
    const bucket = getBucket();
    if (bucket) {
      const auditPath = `audits/${datePath}/processed/${rowId}.json`;
      await writeJSON(bucket, auditPath, auditResult);

      // Update index for fast resume checks
      await addToProcessedIndex(bucket, datePath, rowId);
    }

    return auditResult;
  } catch (error) {
    console.error(`❌ Error auditing record ${rowId}:`, error);

    const errorResult = {
      row_id: rowId,
      timestamp: new Date().toISOString(),
      obra: record.obra || null,
      image_path: imagePath,
      status: "error",
      error: error.message,
    };

    // Save error result to a separate failures folder (not processed)
    const bucket = getBucket();
    if (bucket) {
      const errorPath = `audits/${datePath}/failed/${rowId}.json`;
      await writeJSON(bucket, errorPath, errorResult);

      // DO NOT add to processed index - allow retry on next run
    }

    return errorResult;
  }
}

/**
 * Process all unprocessed records
 */
export async function auditAllRecords(records, datePath) {
  const unprocessed = await getUnprocessedRecords(records, datePath);

  if (unprocessed.length === 0) {
    console.log("✅ All records already processed!");
    return [];
  }

  // Get valid placas for fuzzy matching
  const bucket = getBucket();
  const validPlacas = bucket ? await getValidPlacas(bucket, datePath) : [];

  if (validPlacas.length === 0) {
    console.log("⚠️ No valid placas found, continuing without fuzzy matching");
  }

  const results = [];

  for (const record of unprocessed) {
    const imagePath = `images/${datePath}/${record.fotoVale?.split("/").pop()}`;

    const result = await auditRecord(record, imagePath, datePath, validPlacas);
    results.push(result);
  }

  // Generate summary report
  const successful = results.filter((r) => r.status !== "error");
  const failed = results.filter((r) => r.status === "error");

  console.log(`\n📊 Audit Summary:`);
  console.log(`   Total processed: ${results.length}`);
  console.log(`   ✅ Successful: ${successful.length}`);
  console.log(`   ❌ Failed: ${failed.length}`);

  if (failed.length > 0) {
    console.log(`\n⚠️  Failed records:`);
    failed.forEach((f) => {
      console.log(`   - ${f.row_id}: ${f.error}`);
    });
    console.log(`\n💡 Failed records will be retried on next run`);

    // Save failed records summary to bucket
    const bucket = getBucket();
    if (bucket) {
      const failureSummary = {
        date: datePath,
        timestamp: new Date().toISOString(),
        total_failed: failed.length,
        failed_records: failed.map((f) => ({
          row_id: f.row_id,
          error: f.error,
        })),
      };
      await writeJSON(
        bucket,
        `audits/${datePath}/failure_summary.json`,
        failureSummary
      );
      console.log(
        `📝 Saved failure summary to audits/${datePath}/failure_summary.json`
      );
    }
  }

  console.log(`\n✅ Completed audit of ${results.length} records`);
  return results;
}

/**
 * Get all audit results for a date (for reporting)
 */
export async function getAllAuditResults(datePath) {
  const bucket = getBucket();
  if (!bucket) {
    console.log("⚠️ No bucket available");
    return [];
  }

  try {
    const { listFiles, readJSON } = await import("./bucket.js");

    // Get all processed audit files
    const processedFiles = await listFiles(
      bucket,
      `audits/${datePath}/processed/`
    );

    // Get all failed audit files
    const failedFiles = await listFiles(bucket, `audits/${datePath}/failed/`);

    // Get all manual review files
    const manualReviewFiles = await listFiles(bucket, `audits/${datePath}/manual_review/`);

    const allFiles = [...processedFiles, ...failedFiles, ...manualReviewFiles];
    console.log(
      `📂 Found ${allFiles.length} total audit files for ${datePath} (${manualReviewFiles.length} require manual review)`
    );

    // Read all audit results
    const allResults = [];
    for (const filePath of allFiles) {
      const result = await readJSON(bucket, filePath);
      if (result) {
        allResults.push(result);
      }
    }

    return allResults;
  } catch (error) {
    console.error("Error getting all audit results:", error);
    return [];
  }
}

/**
 * Send audit reports via email - one per obra to relevant users
 */
export async function sendAuditReport(date, datePath, allResults, usuarios) {
  try {
    console.log(`\n📧 Preparing email reports...`);

    // ========== FOR TESTING: Send emails by obra to me only ==========
    // Set EMAIL_TEST_MODE=true in .env to send all emails to test address
    const TEST_MODE = process.env.EMAIL_TEST_MODE === "true";
    const TEST_EMAIL = process.env.EMAIL_TEST_ADDRESS || "said.nader@ydn.com.co";
    // ==================================================================

    // Group results by obra
    const resultsByObra = {};
    for (const result of allResults) {
      const obra = result.obra || "Sin Obra";
      if (!resultsByObra[obra]) {
        resultsByObra[obra] = [];
      }
      resultsByObra[obra].push(result);
    }

    console.log(
      `📊 Found ${Object.keys(resultsByObra).length} obras with audit results`
    );

    // Get active usuarios eligible for audit emails (Admin, Super Admin, Auditor)
    const eligibleRoles = ["Admin", "Super Admin", "Auditor"];
    const allUsuarios = Array.from(usuarios.values());

    const activeUsuarios = allUsuarios.filter(
      (u) =>
        u.estado_usuario?.toUpperCase() === "ACTIVO" &&
        eligibleRoles.some(
          (role) => role.toLowerCase() === u.rol?.toLowerCase()
        ) &&
        u.correo
    );

    console.log(
      `👥 Found ${activeUsuarios.length} active users with eligible roles`
    );

    const transporter = createTransporter();
    let emailsSent = 0;

    // For each obra, send email to relevant users
    for (const [obraName, obraResults] of Object.entries(resultsByObra)) {
      console.log(`\n📧 Processing emails for obra: ${obraName}`);

      // Find users who have access to this obra
      const recipientsForObra = activeUsuarios.filter((u) =>
        u.relatedObras?.includes(obraName)
      );

      if (recipientsForObra.length === 0) {
        console.log(`⚠️ No recipients found for obra: ${obraName}`);
        continue;
      }

      // Calculate summary for this obra
      const successful = obraResults.filter((r) => r.status !== "error");
      const failed = obraResults.filter((r) => r.status === "error");
      const manualReview = obraResults.filter((r) => r.status === "requiere_revision_manual");
      const approved = successful.filter((r) => r.aprobado === true && r.status !== "requiere_revision_manual");
      const discrepancies = successful.filter((r) => r.aprobado === false && r.status !== "requiere_revision_manual");

      const summary = {
        successful: successful.length,
        failed: failed.length,
        approved: approved.length,
        discrepancies: discrepancies.length,
        manualReview: manualReview.length,
      };

      // Generate Excel report for this obra
      const excelBuffer = await exportAuditToExcelBuffer(obraResults);

      // Send email to recipients
      const recipientEmails = recipientsForObra.map((u) => u.correo).join(", ");

      if (TEST_MODE) {
        // In TEST_MODE: Send individual email to test address for EACH eligible user
        console.log(
          `📬 [TEST MODE] Would send to ${recipientsForObra.length} users: ${recipientEmails}`
        );
        console.log(
          `📬 [TEST MODE] Sending ${recipientsForObra.length} individual emails to: ${TEST_EMAIL}`
        );

        for (const user of recipientsForObra) {
          await sendAuditEmail(
            TEST_EMAIL,
            date,
            excelBuffer,
            summary,
            transporter,
            `${obraName} - [Para: ${user.correo}]`
          );
          emailsSent++;
          console.log(
            `  ✅ Sent test email for user: ${user.correo} (${user.rol})`
          );
        }
      } else {
        // Production: Send one email to all recipients
        console.log(`📬 Sending to: ${recipientEmails}`);
        await sendAuditEmail(
          recipientEmails,
          date,
          excelBuffer,
          summary,
          transporter,
          obraName
        );
        emailsSent++;
        console.log(
          `✅ Email sent for obra: ${obraName} (${recipientsForObra.length} recipients)`
        );
      }
    }

    console.log(`\n✅ All emails sent: ${emailsSent} obras processed`);
  } catch (error) {
    console.error(`❌ Failed to send email report:`, error.message);
    throw error;
  }
}
