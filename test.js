import { extract } from "./extract.js";
import { getBucket, getValidPlacas } from "./bucket.js";
import { auditRecord } from "./audit.js";
import { getYesterdayDateString, getDatePath } from "./utils.js";
import dotenv from "dotenv";
import fs from "fs";

if (fs.existsSync(".env")) {
  dotenv.config();
}

async function testAudit() {
  try {
    const date = getYesterdayDateString();
    const datePath = getDatePath(date);
    console.log(`📅 Testing audit for date: ${date} (path: ${datePath})`);

    // Step 1: Extract data
    console.log("\n--- Step 1: Extracting data ---");
    const rawData = await extract(date);
    const viajeRecords = rawData.viaje || [];

    if (viajeRecords.length === 0) {
      console.log("⚠️ No viaje records found");
      return;
    }

    // Step 2: Get only first 3 records for testing
    const testRecords = viajeRecords.slice(0, 3);
    console.log(`\n📊 Testing with ${testRecords.length} records:`);
    testRecords.forEach((r, i) => {
      console.log(
        `  ${i + 1}. ${r.rowId} - Vale: ${r.numeroVale} - Placa: ${r.placa}`
      );
    });

    // Step 3: Get valid placas
    const bucket = getBucket();
    const validPlacas = bucket ? await getValidPlacas(bucket, datePath) : [];
    console.log(`\n📋 Loaded ${validPlacas.length} valid placas for fuzzy matching`);

    // Step 4: Audit each test record
    console.log("\n--- Starting Audit ---");
    const results = [];

    for (const record of testRecords) {
      const imagePath = `images/${datePath}/${record.fotoVale?.split("/").pop()}`;
      console.log(`\n🔍 Auditing: ${record.numeroVale} (${record.rowId})`);

      try {
        const result = await auditRecord(record, imagePath, datePath, validPlacas);
        results.push(result);

        console.log(`✅ Status: ${result.status}`);
        console.log(`   Aprobado: ${result.aprobado}`);

        if (result.discrepancies && result.discrepancies.length > 0) {
          console.log(`   Discrepancias (${result.discrepancies.length}):`);
          result.discrepancies.forEach((d) => {
            console.log(`     - ${d.field}: ${d.reason || 'No coincide'}`);
            if (d.extracted !== undefined) {
              console.log(`       Extraído: "${d.extracted}" vs Esperado: "${d.expected}"`);
            }
          });
        } else if (result.status !== "error") {
          console.log(`   ✅ No discrepancies found`);
        }
      } catch (error) {
        console.error(`❌ Error auditing ${record.rowId}:`, error.message);
        results.push({
          row_id: record.rowId,
          status: "error",
          error: error.message,
        });
      }
    }

    // Step 5: Summary
    console.log("\n--- Test Summary ---");
    const approved = results.filter((r) => r.aprobado).length;
    const errors = results.filter((r) => r.status === "error").length;
    console.log(`✅ Approved: ${approved}/${testRecords.length}`);
    console.log(`❌ With discrepancies: ${testRecords.length - approved - errors}`);
    console.log(`⚠️ Errors: ${errors}`);

    // Save results to a test file
    const testResultPath = `./test_results_${date.replace(/\//g, "-")}.json`;
    fs.writeFileSync(testResultPath, JSON.stringify(results, null, 2));
    console.log(`\n💾 Test results saved to: ${testResultPath}`);
  } catch (error) {
    console.error("❌ Test failed:", error.message);
    if (error.stack) console.error(error.stack);
  }
}

testAudit();
