import { subDays, format } from "date-fns";
import { formatInTimeZone } from "date-fns-tz";

export function getYesterdayDateString() {
  const today = new Date();
  const yesterday = subDays(today, 1);
  return format(yesterday, "MM/dd/yyyy");
}

/**
 * Get date path in YYYY/MM/DD format for bucket storage
 * @param {string} dateString - Date in MM/dd/yyyy format
 * @returns {string} - Date path like "2025/11/26"
 */
export function getDatePath(dateString) {
  const [month, day, year] = dateString.split("/");
  return `${year}/${month}/${day}`;
}

export function formatAppsheetDate(dateStr) {
  if (!dateStr) return null;
  const datePart = dateStr.split(" ")[0];
  const [month, day, year] = datePart.split("/");
  if (!year || !month || !day) return null;
  return `${day}/${month}/${year}`;
}

export function getBogotaDateString(formatStr = "yyyy-MM-dd") {
  return formatInTimeZone(new Date(), "America/Bogota", formatStr);
}
