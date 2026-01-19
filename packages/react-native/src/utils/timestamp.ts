/**
 * Get current time in ISO format
 */
export function getCurrentTimeFormatted(): string {
  return new Date().toISOString();
}

/**
 * Format date to YYYY-MM-DD HH:mm format for hashing
 */
export function toDateHourMinute(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hours = String(date.getHours()).padStart(2, "0");
  const minutes = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hours}:${minutes}`;
}

/**
 * Convert milliseconds to seconds
 */
export function millisecondsToSecond(ms: number): number {
  return Math.floor(ms / 1000);
}
