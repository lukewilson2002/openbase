/**
 * Vitest global setup for the live contract tests: build the debug server, start it on a free
 * port with a throwaway data directory, wait for /api/health, and stop it afterwards.
 *
 * Environment knobs:
 *   OPENBASE_CONTRACT_SKIP_BUILD=1   do not run `cargo build` (use binaries already built)
 *   OPENBASE_CONTRACT_KEEP_DATA=1    keep the temp data dir (its path is printed on teardown)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

export interface ServerEnv {
  /** e.g. `http://127.0.0.1:41234` */
  baseUrl: string;
  /** OPENBASE_DATA_DIR of the running server. */
  dataDir: string;
}

export interface ContractEnv extends ServerEnv {
  /**
   * A second server whose first administrator already exists, for the tests that exercise the
   * workspace, schema and record APIs (the first server stays fresh for the first-run flow).
   */
  seeded: ServerEnv & { adminEmail: string; adminPassword: string };
}

declare module "vitest" {
  export interface ProvidedContext {
    contract: ContractEnv;
  }
}

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
const exe = process.platform === "win32" ? ".exe" : "";

function run(cmd: string, args: string[], what: string): string {
  const res = spawnSync(cmd, args, { cwd: repoRoot, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"], maxBuffer: 64 * 1024 * 1024 });
  if (res.error) throw new Error(`${what}: cannot run ${cmd}: ${res.error.message}. Is the Rust toolchain installed?`);
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
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`openbase did not answer ${baseUrl}/api/health within 30s.\n${output()}`);
}

interface Running extends ServerEnv {
  stop(): Promise<void>;
}

async function startServer(bin: string, label: string): Promise<Running> {
  const dataDir = mkdtempSync(join(tmpdir(), `openbase-contract-${label}-`));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let log = "";
  const child = spawn(bin, ["serve"], {
    cwd: dataDir,
    env: {
      ...process.env,
      OPENBASE_DATA_DIR: dataDir,
      OPENBASE_BIND: `127.0.0.1:${port}`,
      OPENBASE_PUBLIC_URL: baseUrl,
      OPENBASE_OPEN_SIGNUP: "false",
      // Loopback-only server: let each test profile present its own client address (see cookieJar.ts).
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

  try {
    await waitForHealth(baseUrl, child, () => log);
  } catch (e) {
    child.kill("SIGKILL");
    rmSync(dataDir, { recursive: true, force: true });
    throw e;
  }
  console.log(`[contract] openbase (${label}) listening on ${baseUrl} (data dir ${dataDir})`);
  return {
    baseUrl,
    dataDir,
    async stop() {
      if (child.exitCode === null) {
        const exited = new Promise<void>((r) => child.once("exit", () => r()));
        child.kill("SIGTERM");
        const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
        await exited;
        clearTimeout(timer);
      }
      if (process.env["OPENBASE_CONTRACT_KEEP_DATA"]) console.log(`[contract] data dir kept: ${dataDir}`);
      else rmSync(dataDir, { recursive: true, force: true });
    },
  };
}

/** First-run signup over plain HTTP (the first account becomes the administrator). */
async function signUpFirstAdmin(baseUrl: string, email: string, password: string): Promise<void> {
  const res = await fetch(`${baseUrl}/api/auth/signup`, {
    method: "POST",
    headers: { "content-type": "application/json", "x-openbase-csrf": "1", "x-forwarded-for": "10.0.0.1" },
    body: JSON.stringify({ email, name: "Seeded Admin", password }),
  });
  if (!res.ok) throw new Error(`could not create the seeded administrator: ${res.status} ${await res.text()}`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!process.env["OPENBASE_CONTRACT_SKIP_BUILD"]) {
    console.log("[contract] cargo build -p openbase");
    // Same feature set as the end-to-end tests (e2e/globalSetup.ts), so both share one binary.
    run("cargo", ["build", "-p", "openbase", "--bin", "openbase", "--features", "debug-embed"], "cargo build");
  }
  const meta = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--no-deps"], "cargo metadata")) as { target_directory: string };
  const bin = join(meta.target_directory, "debug", `openbase${exe}`);
  if (!existsSync(bin)) throw new Error(`${bin} not found; run without OPENBASE_CONTRACT_SKIP_BUILD.`);

  const fresh = await startServer(bin, "fresh");
  let seeded: Running | undefined;
  try {
    seeded = await startServer(bin, "seeded");
    const adminEmail = `seed-admin-${Math.random().toString(16).slice(2, 10)}@example.test`;
    const adminPassword = `pw-${Math.random().toString(16).slice(2)}-${Math.random().toString(16).slice(2)}`;
    await signUpFirstAdmin(seeded.baseUrl, adminEmail, adminPassword);
    project.provide("contract", { baseUrl: fresh.baseUrl, dataDir: fresh.dataDir, seeded: { baseUrl: seeded.baseUrl, dataDir: seeded.dataDir, adminEmail, adminPassword } });
  } catch (e) {
    await seeded?.stop();
    await fresh.stop();
    throw e;
  }

  return async () => {
    await Promise.all([fresh.stop(), seeded?.stop()]);
  };
}
