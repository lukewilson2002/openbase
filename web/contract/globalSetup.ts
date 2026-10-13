/**
 * Vitest global setup for the live contract tests: build the debug server, start it on a free
 * port with a throwaway data directory, wait for /api/health, and stop it afterwards.
 *
 * Environment knobs:
 *   OPENGRID_CONTRACT_SKIP_BUILD=1   do not run `cargo build` (use binaries already built)
 *   OPENGRID_CONTRACT_KEEP_DATA=1    keep the temp data dir (its path is printed on teardown)
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { TestProject } from "vitest/node";

export interface ContractEnv {
  /** e.g. `http://127.0.0.1:41234` */
  baseUrl: string;
  /** OPENGRID_DATA_DIR of the running server. */
  dataDir: string;
  /** Path to the `contract_seed` example binary (adds a workspace + base for a user). */
  seedBin: string;
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
    if (child.exitCode !== null) throw new Error(`opengrid exited early (code ${child.exitCode}).\n${output()}`);
    try {
      const res = await fetch(`${baseUrl}/api/health`);
      if (res.ok) return;
    } catch {
      /* not listening yet */
    }
    await new Promise((r) => setTimeout(r, 100));
  }
  throw new Error(`opengrid did not answer ${baseUrl}/api/health within 30s.\n${output()}`);
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  if (!process.env["OPENGRID_CONTRACT_SKIP_BUILD"]) {
    console.log("[contract] cargo build -p opengrid (server binary + contract_seed example)");
    run("cargo", ["build", "-p", "opengrid", "--bin", "opengrid", "--example", "contract_seed"], "cargo build");
  }
  const meta = JSON.parse(run("cargo", ["metadata", "--format-version", "1", "--no-deps"], "cargo metadata")) as { target_directory: string };
  const bin = join(meta.target_directory, "debug", `opengrid${exe}`);
  const seedBin = join(meta.target_directory, "debug", "examples", `contract_seed${exe}`);
  for (const f of [bin, seedBin]) if (!existsSync(f)) throw new Error(`${f} not found; run without OPENGRID_CONTRACT_SKIP_BUILD.`);

  const dataDir = mkdtempSync(join(tmpdir(), "opengrid-contract-"));
  const port = await freePort();
  const baseUrl = `http://127.0.0.1:${port}`;
  let log = "";
  const child = spawn(bin, ["serve"], {
    cwd: dataDir,
    env: {
      ...process.env,
      OPENGRID_DATA_DIR: dataDir,
      OPENGRID_BIND: `127.0.0.1:${port}`,
      OPENGRID_PUBLIC_URL: baseUrl,
      OPENGRID_OPEN_SIGNUP: "false",
      // Loopback-only server: let each test profile present its own client address (see cookieJar.ts).
      OPENGRID_TRUST_PROXY: "true",
      OPENGRID_BACKUP_HOUR: "-1",
      OPENGRID_LOG: "warn",
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
  console.log(`[contract] opengrid listening on ${baseUrl} (data dir ${dataDir})`);
  project.provide("contract", { baseUrl, dataDir, seedBin });

  return async () => {
    if (child.exitCode === null) {
      const exited = new Promise<void>((r) => child.once("exit", () => r()));
      child.kill("SIGTERM");
      const timer = setTimeout(() => child.kill("SIGKILL"), 10_000);
      await exited;
      clearTimeout(timer);
    }
    if (process.env["OPENGRID_CONTRACT_KEEP_DATA"]) console.log(`[contract] data dir kept: ${dataDir}`);
    else rmSync(dataDir, { recursive: true, force: true });
  };
}
