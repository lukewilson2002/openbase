/**
 * The browser's WebAuthn API, spoken to the server's JSON.
 *
 * The server (webauthn-rs) sends the options of a ceremony as JSON with its binary members
 * (`challenge`, `user.id`, credential ids) in unpadded base64url; `navigator.credentials` wants
 * `ArrayBuffer`s and answers with `ArrayBuffer`s. This module is the conversion in both
 * directions plus a few helpers for support detection and errors. It is deliberately small and
 * has no dependency: `PublicKeyCredential.parseCreationOptionsFromJSON` and `.toJSON()` would
 * do the same, but are not in every browser yet (Safari 18.4, Chrome 129, Firefox 119), so a
 * library like @simplewebauthn/browser would only be bundling these ~100 lines plus polyfills
 * for them.
 *
 * Nothing here talks to the server or knows about OpenBase's endpoints.
 */
import type { JsonValue } from "@/api/types";

/** Unpadded base64url of some bytes. */
export function bytesToBase64Url(bytes: ArrayBuffer | ArrayBufferView): string {
  const view = bytes instanceof ArrayBuffer ? new Uint8Array(bytes) : new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let binary = "";
  for (const b of view) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** The bytes of a base64url (padded or not) string. Throws on characters outside the alphabet. */
export function base64UrlToBytes(text: string): Uint8Array<ArrayBuffer> {
  if (!/^[A-Za-z0-9_-]*={0,2}$/.test(text)) throw new TypeError("not base64url");
  const base64 = text.replace(/-/g, "+").replace(/_/g, "/").replace(/=+$/, "");
  const binary = atob(base64 + "=".repeat((4 - (base64.length % 4)) % 4));
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

type Json = Record<string, unknown>;

function asObject(value: unknown, what: string): Json {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new TypeError(`${what} is not an object`);
  return value as Json;
}

function decodeDescriptors(list: unknown): PublicKeyCredentialDescriptor[] {
  if (!Array.isArray(list)) return [];
  return list.map((entry) => {
    const d = asObject(entry, "a credential descriptor");
    return { type: "public-key" as const, id: base64UrlToBytes(String(d["id"])), ...(Array.isArray(d["transports"]) ? { transports: d["transports"] as AuthenticatorTransport[] } : {}) };
  });
}

/** The options the server sent for registering, as `navigator.credentials.create()` takes them. */
export function creationOptionsFromJson(options: unknown): CredentialCreationOptions {
  const pk = asObject(asObject(options, "the options")["publicKey"], "publicKey");
  const user = asObject(pk["user"], "user");
  const decoded = {
    ...pk,
    challenge: base64UrlToBytes(String(pk["challenge"])),
    user: { ...user, id: base64UrlToBytes(String(user["id"])) },
    excludeCredentials: decodeDescriptors(pk["excludeCredentials"]),
  };
  return { publicKey: decoded as unknown as PublicKeyCredentialCreationOptions };
}

/**
 * The options the server sent for signing in, as `navigator.credentials.get()` takes them.
 * `mediation: "conditional"` makes the passkeys appear in the autofill list of a field marked
 * `autocomplete="... webauthn"` instead of opening a dialog; the server always suggests it, so
 * the caller decides.
 */
export function requestOptionsFromJson(options: unknown, mediation?: CredentialMediationRequirement): CredentialRequestOptions {
  const pk = asObject(asObject(options, "the options")["publicKey"], "publicKey");
  const decoded = {
    ...pk,
    challenge: base64UrlToBytes(String(pk["challenge"])),
    allowCredentials: decodeDescriptors(pk["allowCredentials"]),
  };
  return { publicKey: decoded as unknown as PublicKeyCredentialRequestOptions, ...(mediation ? { mediation } : {}) };
}

/** What the server's `register/finish` and `passkey-login/finish` take as `credential`. */
export type CredentialJson = { [key: string]: JsonValue };

function clientExtensionResults(credential: PublicKeyCredential): CredentialJson {
  try {
    return JSON.parse(JSON.stringify(credential.getClientExtensionResults())) as CredentialJson;
  } catch {
    return {};
  }
}

/** A credential from `create()`, in the JSON the server expects. */
export function attestationToJson(credential: PublicKeyCredential): CredentialJson {
  const response = credential.response as AuthenticatorAttestationResponse;
  const transports = typeof response.getTransports === "function" ? response.getTransports() : [];
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      attestationObject: bytesToBase64Url(response.attestationObject),
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      transports,
    },
    clientExtensionResults: clientExtensionResults(credential),
  };
}

/** A credential from `get()`, in the JSON the server expects. */
export function assertionToJson(credential: PublicKeyCredential): CredentialJson {
  const response = credential.response as AuthenticatorAssertionResponse;
  return {
    id: credential.id,
    rawId: bytesToBase64Url(credential.rawId),
    type: credential.type,
    response: {
      authenticatorData: bytesToBase64Url(response.authenticatorData),
      clientDataJSON: bytesToBase64Url(response.clientDataJSON),
      signature: bytesToBase64Url(response.signature),
      userHandle: response.userHandle ? bytesToBase64Url(response.userHandle) : null,
    },
    clientExtensionResults: clientExtensionResults(credential),
  };
}

/** The browser can do WebAuthn here (a secure context: https, or localhost). */
export function passkeysSupported(): boolean {
  return typeof window !== "undefined" && typeof window.PublicKeyCredential === "function" && !!navigator.credentials && typeof navigator.credentials.create === "function";
}

/**
 * Whether the page is open at the address the server's passkeys belong to (its public URL).
 * The browser files a passkey under the site it was made for, so at any other address
 * (an IP, a second domain, a tunnel) WebAuthn refuses with a SecurityError.
 */
export function atPublicAddress(publicUrl: string): boolean {
  try {
    return new URL(publicUrl).origin === window.location.origin;
  } catch {
    return false;
  }
}

/** The browser can offer passkeys in the autofill list of the username field. */
export async function conditionalMediationSupported(): Promise<boolean> {
  if (!passkeysSupported()) return false;
  const check = (PublicKeyCredential as unknown as { isConditionalMediationAvailable?: () => Promise<boolean> }).isConditionalMediationAvailable;
  if (typeof check !== "function") return false;
  try {
    return await check.call(PublicKeyCredential);
  } catch {
    return false;
  }
}

/** Ask the authenticator to create a credential. Resolves `null` when the person closed the prompt. */
export async function createPasskey(options: unknown, signal?: AbortSignal): Promise<CredentialJson | null> {
  const credential = await navigator.credentials.create({ ...creationOptionsFromJson(options), ...(signal ? { signal } : {}) });
  return credential ? attestationToJson(credential as PublicKeyCredential) : null;
}

/** Ask the authenticator to sign in. Resolves `null` when the person closed the prompt. */
export async function getPasskey(options: unknown, opts: { mediation?: CredentialMediationRequirement; signal?: AbortSignal } = {}): Promise<CredentialJson | null> {
  const credential = await navigator.credentials.get({ ...requestOptionsFromJson(options, opts.mediation), ...(opts.signal ? { signal: opts.signal } : {}) });
  return credential ? assertionToJson(credential as PublicKeyCredential) : null;
}

export type WebAuthnFailure = "cancelled" | "already-registered" | "unsupported" | "wrong-address" | "other";

/**
 * Sort a rejection of `create()` / `get()` into what the page should tell the person. A closed
 * or timed-out prompt (`NotAllowedError`) and an aborted request (`AbortError`) are not errors.
 */
export function classifyWebAuthnError(error: unknown): { kind: WebAuthnFailure; message: string } {
  const name = error instanceof DOMException || error instanceof Error ? error.name : "";
  switch (name) {
    case "NotAllowedError":
    case "AbortError":
      return { kind: "cancelled", message: "The passkey prompt was closed or timed out." };
    case "InvalidStateError":
      return { kind: "already-registered", message: "This device already has a passkey for your account." };
    case "NotSupportedError":
      return { kind: "unsupported", message: "This browser or device cannot create a passkey that works here." };
    case "SecurityError":
      return { kind: "wrong-address", message: "Passkeys only work at the address OpenBase is set up for. Open it from its public address and try again." };
    default:
      return { kind: "other", message: error instanceof Error && error.message ? error.message : "The passkey could not be used." };
  }
}

/** A name for a new passkey from what the browser says about itself, e.g. "Chrome on macOS". */
export function defaultPasskeyName(nav: Pick<Navigator, "userAgent"> & { userAgentData?: { platform?: string } } = navigator): string {
  const ua = nav.userAgent ?? "";
  const browser = /Edg\//.test(ua) ? "Edge" : /OPR\/|Opera/.test(ua) ? "Opera" : /Firefox\//.test(ua) ? "Firefox" : /Chrome\/|CriOS\//.test(ua) ? "Chrome" : /Safari\//.test(ua) ? "Safari" : "";
  const platform = nav.userAgentData?.platform;
  const os = /iPhone|iPad|iPod/.test(ua)
    ? "iOS"
    : /Android/.test(ua)
      ? "Android"
      : /Windows/.test(ua)
        ? "Windows"
        : /Mac OS X|Macintosh/.test(ua)
          ? "macOS"
          : /CrOS/.test(ua)
            ? "ChromeOS"
            : /Linux/.test(ua)
              ? "Linux"
              : platform || "";
  if (browser && os) return `${browser} on ${os}`;
  return browser || os || "Passkey";
}
