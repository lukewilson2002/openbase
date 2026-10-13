/**
 * Playwright global setup: build the web client, build the server with the web client embedded,
 * start it on a free port with a throwaway data directory, and publish its URL.
 *
 * It also proves that the server really serves the embedded copy: while the first request is
 * answered, `web/dist` is moved out of the way, so a server that read the folder at run time (or
 * a Vite dev server) would fail the check.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, renameSync, rmSync, utimesSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { request } from "node:http";

const webDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(webDir, "..");
const exe = process.platform === "win32" ? ".exe" : "";

function run(cmd: string, args: string[], cwd: string, what: string): string {
  console.log(`[e2e] ${what}: ${cmd} ${args.join(" ")}`);
  const res = spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`${what}: cannot run ${cmd}: ${res.error.message}`);
  if (res.status !== 0) throw new Error(`${what} failed (exit ${res.status}).`);
  return res.stdout;
}

function freePort(): Promise<number> {
  return new Promise((resolvePort, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      srv.close(() => resolvePort(port));
    });
  });
}

async function waitForHealth(baseUrl: string, child: ChildProcess, output: () => string): Promise<void> {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`openbase exited early (code ${child.exitCode}).\n${output()}`);
    try {
      if ((await fetch(`${baseUrl}/api/health`)).ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`openbase did not answer ${baseUrl}/api/health within 30s.\n${output()}`);
}

/** GET `/` with Node's http (no keep-alive), returning the status and body. */
function get(baseUrl: string, path: string): Promise<{ status: number; type: string; body: string }> {
  return new Promise((resolveGet, reject) => {
    const req = request(`${baseUrl}${path}`, { agent: false }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => (body += c));
      res.on("end", () => resolveGet({ status: res.statusCode ?? 0, type: String(res.headers["content-type"] ?? ""), body }));
    });
    req.on("error", reject);
    req.end();
  });
}

/** With `web/dist` moved away, `/` and an asset must still be served: they come from the binary. */
async function assertEmbedded(baseUrl: string): Promise<void> {
  const dist = join(webDir, "dist");
  const away = `${dist}.away-${process.pid}`;
  const before = await get(baseUrl, "/");
  const asset = /\/assets\/[^"']+\.js/.exec(before.body)?.[0];
  renameSync(dist, away);
  try {
    const index = await get(baseUrl, "/");
    if (index.status !== 200 || !index.type.includes("text/html") || !index.body.includes('id="root"')) {
      throw new Error(`the server did not serve the embedded app shell without web/dist (status ${index.status}, ${index.type}).`);
    }
    if (!asset) throw new Error("the app shell references no script under /assets/.");
    const script = await get(baseUrl, asset);
    if (script.status !== 200) throw new Error(`the embedded asset ${asset} was not served without web/dist (status ${script.status}).`);
  } finally {
    renameSync(away, dist);
  }
}

export default async function globalSetup(): Promise<(() => Promise<void>) | undefined> {
  if (!process.env["OPENBASE_E2E"]) return undefined;
  if (process.env["OPENBASE_E2E_URL"]) {
    console.log(`[e2e] using the server at ${process.env["OPENBASE_E2E_URL"]}`);
    return undefined;
  }

  if (!process.env["OPENBASE_E2E_SKIP_BUILD"]) {
    run("npm", ["run", "build"], webDir, "build the web client");
    // rust-embed tracks the files it embedded, not new ones: make sure the crate is rebuilt.
    const webRs = join(repoRoot, "crates/server/src/web.rs");
    const now = new Date();
    utimesSync(webRs, now, now);
    run("cargo", ["build", "-p", "openbase", "--bin", "openbase", "--features", "debug-embed"], repoRoot, "build the server");
  }
  const meta = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--no-deps"], repoRoot, "locate the target directory")) as { target_directory: string };
  const bin = join(meta.target_directory, "debug", `openbase${exe}`);
  if (!existsSync(bin)) throw new Error(`${bin} not found; run without OPENBASE_E2E_SKIP_BUILD.`);
  if (!existsSync(join(webDir, "dist", "index.html"))) throw new Error("web/dist/index.html is missing; run without OPENBASE_E2E_SKIP_BUILD.");

  const dataDir = mkdtempSync(join(tmpdir(), "openbase-e2e-"));
  const port = await freePort();
  // `localhost`, not 127.0.0.1: passkeys (WebAuthn) need a domain name as the relying party, and
  // `localhost` is the one name browsers treat as a secure context over plain http. The server still
  // listens on the IPv4 loopback only; the browser and Node fall back to it from ::1.
  const baseUrl = `http://localhost:${port}`;
  let log = "";
  const child = spawn(bin, ["serve"], {
    cwd: dataDir,
    env: {
      ...process.env,
      OPENBASE_DATA_DIR: dataDir,
      OPENBASE_BIND: `127.0.0.1:${port}`,
      OPENBASE_PUBLIC_URL: baseUrl,
      // grid.spec.ts signs up its own user after the journey has created the administrator.
      OPENBASE_OPEN_SIGNUP: "true",
      // The server listens on the loopback only, so nobody but the tests can send X-Forwarded-For.
      // Every test presents its own client address (fixtures.ts), which gives it its own bucket in the
      // real, unchanged rate limits (10 sign-ins a minute, 10 sign-ups an hour per address) instead of
      // the whole suite sharing 127.0.0.1's. The same is done by web/contract.
      OPENBASE_TRUST_PROXY: "true",
      OPENBASE_BACKUP_HOUR: "-1",
      OPENBASE_LOG: "warn",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk: Buffer) => {
    log = (log + chunk.toString()).slice(-8000);
  };
  child.stdout?.on("data", collect);
  child.stderr?.on("data", collect);
  const cleanup = () => rmSync(dataDir, { recursive: true, force: true });

  try {
    await waitForHealth(baseUrl, child, () => log);
    await assertEmbedded(baseUrl);
  } catch (e) {
    child.kill("SIGKILL");
    cleanup();
    throw e;
  }
  process.env["OPENBASE_E2E_URL"] = baseUrl;
  console.log(`[e2e] openbase listening on ${baseUrl} (data dir ${dataDir}); web client served from the embedded build`);

  return async () => {
    if (child.exitCode === null) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    if (process.env["OPENBASE_E2E_KEEP_DATA"]) console.log(`[e2e] data dir kept: ${dataDir}`);
    else cleanup();
  };
}
