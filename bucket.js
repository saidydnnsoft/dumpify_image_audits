import { Storage } from "@google-cloud/storage";
import { existsSync } from "fs";
import path from "path";

export function getBucket() {
  try {
    const bucketName = process.env.GCP_BUCKET_NAME;
    const storage = existsSync("service-account.json")
      ? new Storage({
          keyFilename: "service-account.json",
        })
      : new Storage();

    return storage.bucket(bucketName);
  } catch (error) {
    console.error("Error initializing GCP Storage:", error);
    return null;
  }
}

/**
 * Check if a file exists in the bucket
 */
export async function fileExists(bucket, filePath) {
  try {
    const file = bucket.file(filePath);
    const [exists] = await file.exists();
    return exists;
  } catch (error) {
    console.error(`Error checking file existence: ${filePath}`, error);
    return false;
  }
}

/**
 * Read JSON file from bucket
 */
export async function readJSON(bucket, filePath) {
  try {
    const file = bucket.file(filePath);
    const [contents] = await file.download();
    return JSON.parse(contents.toString());
  } catch (error) {
    console.error(`Error reading JSON from bucket: ${filePath}`, error);
    return null;
  }
}

/**
 * Write JSON file to bucket
 */
export async function writeJSON(bucket, filePath, data) {
  try {
    const file = bucket.file(filePath);
    await file.save(JSON.stringify(data, null, 2), {
      contentType: "application/json",
      metadata: {
        cacheControl: "no-cache",
      },
    });
    console.log(`✅ Saved JSON to bucket: ${filePath}`);
    return true;
  } catch (error) {
    console.error(`Error writing JSON to bucket: ${filePath}`, error);
    return false;
  }
}

/**
 * Upload a file to the bucket
 */
export async function uploadFile(bucket, localPath, destPath) {
  try {
    await bucket.upload(localPath, {
      destination: destPath,
    });
    console.log(`✅ Uploaded file to bucket: ${destPath}`);
    return true;
  } catch (error) {
    console.error(`Error uploading file to bucket: ${destPath}`, error);
    return false;
  }
}

/**
 * Download a file from the bucket
 */
export async function downloadFile(bucket, filePath, destPath) {
  try {
    const file = bucket.file(filePath);
    await file.download({ destination: destPath });
    console.log(`✅ Downloaded file from bucket: ${filePath}`);
    return true;
  } catch (error) {
    console.error(`Error downloading file from bucket: ${filePath}`, error);
    return false;
  }
}

/**
 * List files with a given prefix
 */
export async function listFiles(bucket, prefix) {
  try {
    const [files] = await bucket.getFiles({ prefix });
    return files.map((file) => file.name);
  } catch (error) {
    console.error(`Error listing files with prefix: ${prefix}`, error);
    return [];
  }
}

/**
 * Get all processed audit row IDs for a given date (using index for performance)
 */
export async function getProcessedRowIds(bucket, datePath) {
  try {
    const indexPath = `audits/${datePath}/index.json`;

    // Try to read index file first (fast path)
    if (await fileExists(bucket, indexPath)) {
      const index = await readJSON(bucket, indexPath);
      if (index && index.processed_ids) {
        console.log(
          `📋 Loaded ${index.processed_ids.length} processed IDs from index`
        );
        return index.processed_ids;
      }
    }

    // Fallback: List individual files (slow path)
    console.log("⚠️ No index found, listing files...");
    const prefix = `audits/${datePath}/processed/`;
    const fileNames = await listFiles(bucket, prefix);
    const processedIds = fileNames.map((name) => path.basename(name, ".json"));

    // Create index for next time
    if (processedIds.length > 0) {
      await updateProcessedIndex(bucket, datePath, processedIds);
    }

    return processedIds;
  } catch (error) {
    console.error("Error getting processed row IDs:", error);
    return [];
  }
}

/**
 * Update the index.json file with processed record IDs
 */
export async function updateProcessedIndex(bucket, datePath, processedIds) {
  try {
    const indexPath = `audits/${datePath}/index.json`;
    const indexData = {
      processed_ids: processedIds,
      count: processedIds.length,
      last_updated: new Date().toISOString(),
    };
    await writeJSON(bucket, indexPath, indexData);
    return true;
  } catch (error) {
    console.error("Error updating processed index:", error);
    return false;
  }
}

/**
 * Add a single record ID to the index (incremental update)
 */
export async function addToProcessedIndex(bucket, datePath, rowId) {
  try {
    const indexPath = `audits/${datePath}/index.json`;
    let processedIds = [];

    // Read existing index
    if (await fileExists(bucket, indexPath)) {
      const index = await readJSON(bucket, indexPath);
      processedIds = index?.processed_ids || [];
    }

    // Add new ID if not already present
    if (!processedIds.includes(rowId)) {
      processedIds.push(rowId);
      await updateProcessedIndex(bucket, datePath, processedIds);
      console.log(`✅ Added ${rowId} to index (${processedIds.length} total)`);
    }

    return true;
  } catch (error) {
    console.error("Error adding to processed index:", error);
    return false;
  }
}

/**
 * Get list of valid placas from cached extraction
 */
export async function getValidPlacas(bucket, datePath) {
  try {
    const extractionPath = `extractions/${datePath}/appsheet_data.json`;

    if (await fileExists(bucket, extractionPath)) {
      const extraction = await readJSON(bucket, extractionPath);
      if (extraction && extraction.valid_placas) {
        console.log(`📋 Loaded ${extraction.valid_placas.length} valid placas`);
        return extraction.valid_placas;
      }
    }

    console.log("⚠️ No valid placas found in cache");
    return [];
  } catch (error) {
    console.error("Error getting valid placas:", error);
    return [];
  }
}
