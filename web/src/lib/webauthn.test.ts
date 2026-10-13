import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertionToJson,
  atPublicAddress,
  attestationToJson,
  base64UrlToBytes,
  bytesToBase64Url,
  classifyWebAuthnError,
  conditionalMediationSupported,
  createPasskey,
  creationOptionsFromJson,
  defaultPasskeyName,
  getPasskey,
  passkeysSupported,
  requestOptionsFromJson,
} from "./webauthn";

afterEach(() => vi.unstubAllGlobals());

const buf = (...bytes: number[]) => new Uint8Array(bytes).buffer;

describe("base64url", () => {
  it("round-trips bytes, unpadded and URL-safe", () => {
    const bytes = new Uint8Array([0xfb, 0xff, 0xfe, 0x00, 0x10, 0x3e, 0x3f]);
    const text = bytesToBase64Url(bytes);
    expect(text).toBe("-__-ABA-Pw");
    expect(text).not.toMatch(/[+/=]/);
    expect(Array.from(base64UrlToBytes(text))).toEqual(Array.from(bytes));
    expect(bytesToBase64Url(new ArrayBuffer(0))).toBe("");
    expect(base64UrlToBytes("").length).toBe(0);
  });

  it("accepts padding, reads views with an offset, and rejects other characters", () => {
    expect(Array.from(base64UrlToBytes("AQI="))).toEqual([1, 2]);
    expect(Array.from(base64UrlToBytes("AQI"))).toEqual([1, 2]);
    const view = new Uint8Array([9, 9, 1, 2, 9]).subarray(2, 4);
    expect(bytesToBase64Url(view)).toBe("AQI");
    expect(() => base64UrlToBytes("a+b/")).toThrow(TypeError);
    expect(() => base64UrlToBytes("a b")).toThrow(TypeError);
  });
});

describe("options from the server", () => {
  const creation = {
    publicKey: {
      rp: { id: "base.example.com", name: "OpenBase" },
      user: { id: "AQID", name: "ada@example.com", displayName: "Ada" },
      challenge: "BAUG",
      pubKeyCredParams: [{ type: "public-key", alg: -7 }],
      excludeCredentials: [{ type: "public-key", id: "CQg" }],
      authenticatorSelection: { residentKey: "required", requireResidentKey: true, userVerification: "required" },
      attestation: "none",
      timeout: 300000,
      extensions: { credProps: true },
    },
  };

  it("decodes the binary members of the registration options and keeps the rest", () => {
    const { publicKey } = creationOptionsFromJson(creation);
    expect(Array.from(new Uint8Array(publicKey!.challenge as ArrayBuffer))).toEqual([4, 5, 6]);
    expect(Array.from(new Uint8Array(publicKey!.user.id as ArrayBuffer))).toEqual([1, 2, 3]);
    expect(publicKey!.user.name).toBe("ada@example.com");
    expect(publicKey!.excludeCredentials).toHaveLength(1);
    expect(Array.from(new Uint8Array(publicKey!.excludeCredentials![0]!.id as ArrayBuffer))).toEqual([9, 8]);
    expect(publicKey!.authenticatorSelection).toEqual(creation.publicKey.authenticatorSelection);
    expect(publicKey!.rp).toEqual(creation.publicKey.rp);
    expect(publicKey!.extensions).toEqual({ credProps: true });
  });

  it("decodes the sign-in options and takes the mediation from the caller, not the server", () => {
    const options = { mediation: "conditional", publicKey: { challenge: "BAUG", rpId: "base.example.com", allowCredentials: [], userVerification: "required", timeout: 300000, extensions: { uvm: true } } };
    const modal = requestOptionsFromJson(options);
    expect(modal.mediation).toBeUndefined();
    expect(modal.publicKey!.rpId).toBe("base.example.com");
    expect(modal.publicKey!.userVerification).toBe("required");
    expect(modal.publicKey!.allowCredentials).toEqual([]);
    expect(Array.from(new Uint8Array(modal.publicKey!.challenge as ArrayBuffer))).toEqual([4, 5, 6]);
    expect(requestOptionsFromJson(options, "conditional").mediation).toBe("conditional");
  });

  it("refuses options that are not what the server sends", () => {
    expect(() => creationOptionsFromJson(null)).toThrow(TypeError);
    expect(() => creationOptionsFromJson({})).toThrow(TypeError);
    expect(() => requestOptionsFromJson({ publicKey: { challenge: "not base64!" } })).toThrow(TypeError);
  });
});

describe("credentials for the server", () => {
  it("turns a registration into the JSON register/finish takes, with the reported transports", () => {
    const credential = {
      id: "AQID",
      type: "public-key",
      rawId: buf(1, 2, 3),
      response: { attestationObject: buf(0xfb, 0xff), clientDataJSON: buf(123, 125), getTransports: () => ["internal", "hybrid"] },
      getClientExtensionResults: () => ({ credProps: { rk: true } }),
    } as unknown as PublicKeyCredential;
    expect(attestationToJson(credential)).toEqual({
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      response: { attestationObject: "-_8", clientDataJSON: "e30", transports: ["internal", "hybrid"] },
      clientExtensionResults: { credProps: { rk: true } },
    });
  });

  it("copes with a browser that has no getTransports or odd extension results", () => {
    const credential = {
      id: "AQ",
      type: "public-key",
      rawId: buf(1),
      response: { attestationObject: buf(1), clientDataJSON: buf(2) },
      getClientExtensionResults: () => {
        throw new Error("nope");
      },
    } as unknown as PublicKeyCredential;
    const json = attestationToJson(credential);
    expect((json["response"] as { transports: unknown }).transports).toEqual([]);
    expect(json["clientExtensionResults"]).toEqual({});
  });

  it("turns a sign-in into the JSON passkey-login/finish takes, with the user handle", () => {
    const make = (userHandle: ArrayBuffer | null) =>
      ({
        id: "AQID",
        type: "public-key",
        rawId: buf(1, 2, 3),
        response: { authenticatorData: buf(1), clientDataJSON: buf(2), signature: buf(3), userHandle },
        getClientExtensionResults: () => ({}),
      }) as unknown as PublicKeyCredential;
    expect(assertionToJson(make(buf(7, 8)))).toEqual({
      id: "AQID",
      rawId: "AQID",
      type: "public-key",
      response: { authenticatorData: "AQ", clientDataJSON: "Ag", signature: "Aw", userHandle: "Bwg" },
      clientExtensionResults: {},
    });
    expect((assertionToJson(make(null))["response"] as { userHandle: unknown }).userHandle).toBeNull();
  });
});

describe("talking to the browser", () => {
  const challenge = { publicKey: { challenge: "BAUG", rpId: "localhost", allowCredentials: [], userVerification: "required" } };

  it("detects support", async () => {
    expect(passkeysSupported()).toBe(false);
    expect(await conditionalMediationSupported()).toBe(false);
    vi.stubGlobal("PublicKeyCredential", Object.assign(function PublicKeyCredential() {}, { isConditionalMediationAvailable: async () => true }));
    vi.stubGlobal("navigator", { ...navigator, credentials: { create: vi.fn(), get: vi.fn() } });
    expect(passkeysSupported()).toBe(true);
    expect(await conditionalMediationSupported()).toBe(true);
    vi.stubGlobal("PublicKeyCredential", Object.assign(function PublicKeyCredential() {}, { isConditionalMediationAvailable: async () => Promise.reject(new Error("x")) }));
    expect(await conditionalMediationSupported()).toBe(false);
    vi.stubGlobal("PublicKeyCredential", function PublicKeyCredential() {});
    expect(await conditionalMediationSupported()).toBe(false);
  });

  it("passes decoded options and the abort signal to navigator.credentials and answers null when the prompt is dismissed", async () => {
    const get = vi.fn().mockResolvedValue(null);
    const create = vi.fn().mockResolvedValue(null);
    vi.stubGlobal("navigator", { ...navigator, credentials: { get, create } });
    const signal = new AbortController().signal;
    expect(await getPasskey(challenge, { mediation: "conditional", signal })).toBeNull();
    const arg = get.mock.calls[0]![0] as CredentialRequestOptions;
    expect(arg.mediation).toBe("conditional");
    expect(arg.signal).toBe(signal);
    expect((arg.publicKey!.challenge as ArrayBuffer).byteLength).toBe(3);
    expect(await createPasskey({ publicKey: { challenge: "BAUG", user: { id: "AQ", name: "a", displayName: "A" }, rp: { id: "localhost", name: "x" } } })).toBeNull();
    expect(create).toHaveBeenCalledOnce();
  });
});

describe("errors", () => {
  const named = (name: string, message = "m") => new DOMException(message, name);

  it("treats a closed or aborted prompt as a non-event", () => {
    expect(classifyWebAuthnError(named("NotAllowedError")).kind).toBe("cancelled");
    expect(classifyWebAuthnError(named("AbortError")).kind).toBe("cancelled");
  });

  it("explains the failures a person can act on", () => {
    expect(classifyWebAuthnError(named("InvalidStateError"))).toMatchObject({ kind: "already-registered", message: expect.stringContaining("already has a passkey") });
    expect(classifyWebAuthnError(named("SecurityError"))).toMatchObject({ kind: "wrong-address", message: expect.stringContaining("address") });
    expect(classifyWebAuthnError(named("NotSupportedError")).kind).toBe("unsupported");
    expect(classifyWebAuthnError(new Error("boom"))).toEqual({ kind: "other", message: "boom" });
    expect(classifyWebAuthnError("weird").kind).toBe("other");
  });
});

describe("naming and addresses", () => {
  const chrome = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36";
  const safari = "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";

  it("names a passkey after the browser and system", () => {
    expect(defaultPasskeyName({ userAgent: chrome })).toBe("Chrome on macOS");
    expect(defaultPasskeyName({ userAgent: safari })).toBe("Safari on iOS");
    expect(defaultPasskeyName({ userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:130.0) Gecko/20100101 Firefox/130.0" })).toBe("Firefox on Linux");
    expect(defaultPasskeyName({ userAgent: "Mozilla/5.0 (Windows NT 10.0) Chrome/130 Safari/537 Edg/130" })).toBe("Edge on Windows");
    expect(defaultPasskeyName({ userAgent: "", userAgentData: { platform: "Plan 9" } })).toBe("Plan 9");
    expect(defaultPasskeyName({ userAgent: "" })).toBe("Passkey");
  });

  it("knows whether the page is at the server's public address", () => {
    expect(atPublicAddress(window.location.origin)).toBe(true);
    expect(atPublicAddress(`${window.location.origin}/`)).toBe(true);
    expect(atPublicAddress("https://base.example.com")).toBe(false);
    expect(atPublicAddress("not a url")).toBe(false);
  });
});
