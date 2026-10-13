import { useEffect, useState } from "react";

/**
 * Renders `value` as a QR code image. The SVG is generated locally (nothing leaves the
 * browser) and shown through an <img data: URI> so no markup is injected into the page.
 * The white backing keeps it scannable in dark mode.
 */
export function QrCode({ value, label, size = 192 }: { value: string; label: string; size?: number }) {
  const [src, setSrc] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let cancelled = false;
    // Loaded on demand: the QR encoder is only needed while enabling two-factor.
    import("qrcode")
      .then(({ default: QRCode }) => QRCode.toString(value, { type: "svg", margin: 0, errorCorrectionLevel: "M" }))
      .then((svg) => {
        if (!cancelled) setSrc(`data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`);
      })
      .catch(() => {
        if (!cancelled) setFailed(true);
      });
    return () => {
      cancelled = true;
    };
  }, [value]);

  if (failed) return <p className="text-[0.8125rem] text-muted">Could not render a QR code. Use the secret key below instead.</p>;
  return (
    <div className="inline-block rounded-md bg-white p-3" style={{ width: size + 24, height: size + 24 }}>
      {src && <img src={src} alt={label} width={size} height={size} />}
    </div>
  );
}
