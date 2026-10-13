/** Client-side minimum for early feedback; mirrors og server MIN_PASSWORD_LEN (the server is authoritative). */
export const MIN_PASSWORD_LENGTH = 10;

/** Returns an error message, or null when the pair is acceptable. */
export function validatePasswords(password: string, confirm: string): string | null {
  if (password.length < MIN_PASSWORD_LENGTH) return `Password must be at least ${MIN_PASSWORD_LENGTH} characters.`;
  if (password !== confirm) return "Passwords do not match.";
  return null;
}
