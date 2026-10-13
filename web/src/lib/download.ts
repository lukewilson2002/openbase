/** Hand a file to the browser's download manager. */
export function saveBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  a.rel = "noopener";
  a.style.display = "none";
  document.body.appendChild(a);
  a.click();
  a.remove();
  // Give the browser a moment to start reading the blob before it is released.
  setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

/** A file name safe for every platform, for the case the server does not suggest one. */
export function safeFilename(name: string, fallback = "download"): string {
  const cleaned = name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "_").trim().replace(/^\.+/, "");
  return cleaned === "" ? fallback : cleaned.slice(0, 120);
}
