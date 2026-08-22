/**
 * Browser-side file reading for the upload endpoints.
 *
 * The API takes base64 in a JSON body and measures the byte length and SHA-256
 * itself, so nothing here is trusted downstream — `sizeBytes` is sent for the
 * error message, not for the record.
 */

export interface UploadPayload {
  fileName: string;
  contentType: string;
  sizeBytes: number;
  dataBase64: string;
}

/** Strips the `data:...;base64,` prefix a FileReader result carries. */
function stripDataUrl(result: string): string {
  const comma = result.indexOf(',');
  return comma >= 0 ? result.slice(comma + 1) : result;
}

export function readFileAsUpload(file: File): Promise<UploadPayload> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => {
      const result = typeof reader.result === 'string' ? reader.result : '';
      if (!result) {
        reject(new Error(`${file.name} came back empty`));
        return;
      }
      resolve({
        fileName: file.name,
        contentType: file.type || 'application/octet-stream',
        sizeBytes: file.size,
        dataBase64: stripDataUrl(result),
      });
    };
    reader.readAsDataURL(file);
  });
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * Browser geolocation, as a promise that resolves to null rather than throwing.
 *
 * Location on a job photo is useful and optional in equal measure: it is what
 * lets a photo answer "was this taken at the address on the permit", and a
 * contractor who declines still needs the upload to work. So a denial, a
 * timeout and an unsupported browser all land in the same place — no location,
 * carry on.
 */
export function tryGeolocate(timeoutMs = 8000): Promise<{ lat: number; lng: number; accuracyM: number | null } | null> {
  return new Promise((resolve) => {
    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      resolve(null);
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) =>
        resolve({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracyM: Number.isFinite(pos.coords.accuracy) ? Math.round(pos.coords.accuracy) : null,
        }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 60_000 },
    );
  });
}
