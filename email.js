import { fileURLToPath } from "url";
import fs from "fs";
import handlebars from "handlebars";
import { getBogotaDateString } from "./utils.js";
import nodemailer from "nodemailer";

export function renderTemplate(data) {
  const fileUrl = new URL("./plantilla-resumen-consumos.hbs", import.meta.url);
  const filePath = fileURLToPath(fileUrl);
  const templateString = fs.readFileSync(filePath, "utf-8");
  const compiled = handlebars.compile(templateString);
  return compiled(data);
}

export async function sendResumenEmail(to, name, attachments, transporter) {
  const html = renderTemplate({
    name,
    date: getBogotaDateString("dd/MM/yyyy"),
  });

  await transporter.sendMail({
    from: `"${process.env.EMAIL_NAME}" <${process.env.EMAIL_FROM}>`,
    to,
    subject: "Resumen de consumo de materiales",
    html,
    attachments,
  });
}

/**
 * Create nodemailer transporter
 */
export function createTransporter() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST || "smtp.gmail.com",
    port: parseInt(process.env.SMTP_PORT || "587"),
    secure: process.env.SMTP_SECURE === "true",
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS,
    },
  });
}

/**
 * Send audit report email with Excel attachment
 */
export async function sendAuditEmail(
  to,
  date,
  excelBuffer,
  summary,
  transporter,
  obraName = null
) {
  const totalRecords = summary.successful + summary.failed;
  const approvedRecords = summary.approved || 0;
  const discrepancyRecords = summary.discrepancies || 0;

  const html = `
    <html>
      <head>
        <style>
          body { font-family: Arial, sans-serif; line-height: 1.6; color: #333; }
          .container { max-width: 600px; margin: 0 auto; padding: 20px; }
          .header { background-color: #4472C4; color: white; padding: 20px; text-align: center; }
          .content { padding: 20px; background-color: #f9f9f9; }
          .summary-box { background-color: white; padding: 15px; margin: 10px 0; border-left: 4px solid #4472C4; }
          .stat { display: flex; justify-content: space-between; padding: 8px 0; border-bottom: 1px solid #eee; }
          .stat:last-child { border-bottom: none; }
          .stat-label { font-weight: bold; }
          .success { color: #28a745; }
          .warning { color: #ffc107; }
          .danger { color: #dc3545; }
          .footer { text-align: center; padding: 20px; color: #666; font-size: 12px; }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>📊 Reporte de Auditoría de Vales</h1>
            ${obraName ? `<h2>${obraName}</h2>` : ""}
            <p>Fecha: ${date}</p>
          </div>
          <div class="content">
            <div class="summary-box">
              <h2>Resumen de Auditoría</h2>
              <div class="stat">
                <span class="stat-label">Total de registros procesados:</span>
                <span>${totalRecords}</span>
              </div>
              <div class="stat">
                <span class="stat-label">✅ Exitosos:</span>
                <span class="success">${summary.successful}</span>
              </div>
              <div class="stat">
                <span class="stat-label">❌ Fallidos:</span>
                <span class="danger">${summary.failed}</span>
              </div>
              ${
                summary.successful > 0
                  ? `
              <div class="stat">
                <span class="stat-label">🟢 Aprobados:</span>
                <span class="success">${approvedRecords}</span>
              </div>
              <div class="stat">
                <span class="stat-label">🟡 Con discrepancias:</span>
                <span class="warning">${discrepancyRecords}</span>
              </div>
              `
                  : ""
              }
            </div>
            <p>Adjunto encontrarás el reporte completo en formato Excel con todos los detalles de la auditoría.</p>
            ${
              summary.failed > 0
                ? `<p><strong>Nota:</strong> Los registros fallidos serán reintentados en la próxima ejecución.</p>`
                : ""
            }
          </div>
          <div class="footer">
            <p>🤖 Generado automáticamente por el sistema de auditoría de vales</p>
          </div>
        </div>
      </body>
    </html>
  `;

  const subjectSuffix = obraName ? ` - ${obraName}` : "";

  await transporter.sendMail({
    from: `"${process.env.EMAIL_NAME || "Sistema de Auditoría"}" <${
      process.env.EMAIL_FROM || process.env.SMTP_USER
    }>`,
    to,
    subject: `Reporte de Auditoría de Vales - ${date}${subjectSuffix}`,
    html,
    attachments: [
      {
        filename: `auditoria-vales-${obraName ? `${obraName}-` : ""}${date.replace(/\//g, "-")}.xlsx`,
        content: excelBuffer,
      },
    ],
  });
}
