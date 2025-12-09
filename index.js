import { extract } from "./extract.js";
import {
  getDriveClient,
  findFileIdByName,
  downloadFile as downloadFromDrive,
} from "./drive.js";
import { getBucket, uploadFile, fileExists } from "./bucket.js";
import { auditAllRecords } from "./audit.js";
import { getYesterdayDateString, getDatePath } from "./utils.js";
import dotenv from "dotenv";
import fs from "fs";
import path from "path";

if (fs.existsSync(".env")) {
  dotenv.config();
}

import { http } from "@google-cloud/functions-framework";

/**
 * Download all images from Google Drive and upload to bucket
 */
async function downloadAndCacheImages(records, datePath) {
  const drive = await getDriveClient();
  const bucket = getBucket();

  console.log(`📸 Processing ${records.length} images...`);

  const localDownloadDir = "./temp_downloads";
  if (!fs.existsSync(localDownloadDir)) {
    fs.mkdirSync(localDownloadDir, { recursive: true });
  }

  for (const record of records) {
    if (!record.fotoVale) {
      console.log(`⚠️ No fotoVale for record ${record.rowId}`);
      continue;
    }

    const fileName = record.fotoVale.split("/").pop();
    const localPath = path.join(localDownloadDir, fileName);
    const bucketPath = `images/${datePath}/${fileName}`;

    try {
      // Check if already in bucket
      if (bucket && (await fileExists(bucket, bucketPath))) {
        console.log(`⏭️  Already cached: ${fileName}`);
        continue;
      }

      // Find file in Drive
      console.log(`🔍 Searching for: ${fileName}`);
      const fileId = await findFileIdByName(drive, fileName);

      if (!fileId) {
        console.log(`❌ File not found in Drive: ${fileName}`);
        continue;
      }

      // Download from Drive
      console.log(`⬇️ Downloading from Drive: ${fileName}`);
      await downloadFromDrive(drive, fileId, localPath);

      // Upload to bucket
      if (bucket) {
        console.log(`⬆️ Uploading to bucket: ${bucketPath}`);
        await uploadFile(bucket, localPath, bucketPath);

        // Clean up local file
        fs.unlinkSync(localPath);
      }
    } catch (error) {
      console.error(`❌ Error processing image ${fileName}:`, error.message);
    }
  }

  // Clean up temp directory
  if (fs.existsSync(localDownloadDir)) {
    fs.rmSync(localDownloadDir, { recursive: true });
  }

  console.log("✅ All images processed");
}

// --- Main HTTP Function ---
http("audit_images", async (req, res) => {
  if (req.method !== "POST") {
    return res.status(405).send("Method Not Allowed");
  }

  try {
    const date = getYesterdayDateString();
    const datePath = getDatePath(date);
    console.log(`📅 Processing date: ${date} (path: ${datePath})`);

    // Step 1: Extract data (from cache or AppSheet)
    console.log("\n--- Step 1: Extracting data ---");
    const rawData = await extract(date);
    const viajeRecords = rawData.viaje || [];
    const usuariosMap = rawData.usuariosMap || new Map();

    if (viajeRecords.length === 0) {
      console.log("⚠️ No viaje records found with estado=Finalizado");
      return res.send("No records to process");
    }

    console.log(`✅ Found ${viajeRecords.length} records (estado=Finalizado)`);

    // Step 2: Determine which records need processing
    console.log("\n--- Step 2: Checking processing status ---");
    const { getUnprocessedRecords } = await import("./audit.js");
    const unprocessedRecords = await getUnprocessedRecords(
      viajeRecords,
      datePath
    );

    let auditResults = [];

    if (unprocessedRecords.length === 0) {
      console.log("✅ All records already processed!");
      console.log("📧 Will still send email report with existing results...");
    } else {
      console.log(
        `📊 ${unprocessedRecords.length} unprocessed, ${
          viajeRecords.length - unprocessedRecords.length
        } already done`
      );

      // Step 3: Download images ONLY for unprocessed records
      console.log(
        "\n--- Step 3: Downloading images for unprocessed records ---"
      );
      await downloadAndCacheImages(unprocessedRecords, datePath);

      // Step 4: Audit records with Gemini
      console.log("\n--- Step 4: Auditing records ---");
      auditResults = await auditAllRecords(viajeRecords, datePath);
    }

    // Step 5: Generate and send report
    console.log("\n--- Step 5: Generating and sending report ---");
    const { getAllAuditResults, sendAuditReport } = await import("./audit.js");
    const allResults = await getAllAuditResults(datePath);

    if (allResults.length > 0) {
      await sendAuditReport(date, datePath, allResults, usuariosMap);
    } else {
      console.log("⚠️ No audit results found, skipping email report");
    }

    res.send({
      success: true,
      date,
      date_path: datePath,
      total_records: viajeRecords.length,
      audited: auditResults.length,
      message: "✅ Audit complete!",
    });
  } catch (error) {
    console.error("❌ Send notifications failed: ", error.message);
    if (error.stack) console.error(error.stack);
    if (error.errors) {
      error.errors.forEach((err) =>
        console.error(
          `Error: ${err.message}, Reason: ${err.reason}, Location: ${err.location}`
        )
      );
    }
    res.status(500).send(`Job failed: ${error.message}`);
  }
});
