import fs from "fs";
import path from "path";
import { google } from "googleapis";
import fsSync from "fs";

export async function getDriveClient() {
  const KEYFILEPATH =
    process.env.DRIVE_KEYFILE_PATH || "./service-account.json";

  const auth = new google.auth.GoogleAuth({
    ...(fsSync.existsSync(KEYFILEPATH) ? { keyFile: KEYFILEPATH } : {}),
    scopes: ["https://www.googleapis.com/auth/drive.readonly"],
  });

  const authClient = await auth.getClient();

  const drive = google.drive({
    version: "v3",
    auth: authClient,
  });

  return drive;
}

export async function findFileIdByName(drive, fileName) {
  const res = await drive.files.list({
    q: `name='${fileName}' and trashed=false`,
    fields: "files(id, name)",
    spaces: "drive",
  });
  if (res.data.files.length > 0) {
    return res.data.files[0].id;
  }
  return null;
}

export async function downloadFile(drive, fileId, destPath) {
  // Asegura que la carpeta destino existe
  const dir = path.dirname(destPath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const dest = fs.createWriteStream(destPath);
  return new Promise((resolve, reject) => {
    drive.files.get(
      { fileId, alt: "media" },
      { responseType: "stream" },
      (err, res) => {
        if (err) return reject(err);
        res.data
          .pipe(dest)
          .on("finish", () => resolve(destPath))
          .on("error", reject);
      }
    );
  });
}
