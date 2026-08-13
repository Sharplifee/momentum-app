/**
 * Normalize a US phone number to E.164 (+1XXXXXXXXXX).
 * Returns null if it can't be confidently normalized.
 */
export function toE164(raw: string): string | null {
  if (!raw) return null;
  const digits = raw.replace(/[^\d]/g, "");
  if (digits.length === 10) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
  if (raw.startsWith("+") && digits.length >= 10 && digits.length <= 15) return `+${digits}`;
  return null;
}
