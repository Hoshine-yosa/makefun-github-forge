// Entry point: the harness lifecycle. The forge itself is a Go binary; this
// Node process is only the lifecycle that starts it, registers its port with
// the trial env, and waits until the trial is over.
//
// Sequence:
//   1. Read MAKEFUN_ENV_URL (the env's origin). No env, no trial: exit 1.
//   2. Pick a free port, then start ./forge-go on it (FORGE_PORT). The binary
//      lives beside this file; /bot is read-only in the trial, so when the
//      binary is not directly executable it is copied to /tmp first.
//   3. Poll the binary's /healthz until it answers, then POST the port to
//      $MAKEFUN_ENV_URL/register. 200 registers us; 409 means a first
//      register already won and we just wait like any other entry. 400/405
//      are contract errors and end the program; anything else is retried
//      (the env may be starting).
//   4. GET $MAKEFUN_ENV_URL/done until it says {"done": true}. A poll is a
//      quick request, not a held connection; a failed poll just means
//      "not done yet".
//   5. Stop the Go binary and exit 0. The harness stops the env, which
//      writes the export.

import { spawn, type ChildProcess } from 'node:child_process';
import { copyFileSync, chmodSync, accessSync, constants } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set, so there is no env to register with\n');
  process.exit(1);
}

// One register/done/health request may take this long before it is abandoned and retried.
const REQUEST_TIMEOUT = 30_000;
// Backoff between retries: start here, double each time, never pass the cap.
const BACKOFF_FIRST = 250;
const BACKOFF_MAX = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Wait after `n` failed attempts: exponential from BACKOFF_FIRST, capped at BACKOFF_MAX.
function backoff(n: number): number {
  return Math.min(BACKOFF_MAX, BACKOFF_FIRST * 2 ** Math.min(n, 8));
}

/** Pick a free TCP port by binding port 0 and reading what the kernel chose. */
function pickPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once('error', reject);
    srv.listen(0, '127.0.0.1', () => {
      const addr = srv.address();
      const port = typeof addr === 'object' && addr !== null ? addr.port : 0;
      srv.close(() => resolve(port));
    });
  });
}

/** Start the Go binary on `port`. Returns the child process. */
function startForge(port: number): ChildProcess {
  const here = fileURLToPath(new URL('./forge-go', import.meta.url));
  let bin = here;
  try {
    accessSync(here, constants.X_OK);
  } catch {
    // Not executable (the committed binary lost its bit, or /bot is
    // read-only): copy it to /tmp and run it from there.
    const tmpBin = join(tmpdir(), 'forge-go');
    copyFileSync(here, tmpBin);
    chmodSync(tmpBin, 0o755);
    bin = tmpBin;
  }
  const child = spawn(bin, [], {
    env: { ...process.env, FORGE_PORT: String(port) },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout?.on('data', (d: Buffer) => process.stdout.write(d));
  child.stderr?.on('data', (d: Buffer) => process.stderr.write(d));
  return child;
}

/** Wait until the forge answers /healthz (or give up after the timeout). */
async function waitHealthy(port: number): Promise<void> {
  const deadline = Date.now() + REQUEST_TIMEOUT;
  for (let n = 0; ; n += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/healthz`, { signal: AbortSignal.timeout(5_000) });
      if (res.ok) return;
    } catch {
      // Not up yet.
    }
    if (Date.now() > deadline) throw new Error('the forge did not become healthy in time');
    await pause(backoff(n));
  }
}

// POST the bound port until the env accepts it.
async function registerPort(port: number): Promise<void> {
  for (let n = 0; ; n += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register failed with HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register failed with HTTP ')) throw err;
    }
    await pause(backoff(n));
  }
}

// Poll GET /done until it answers {"done": true}; never return before that.
async function waitUntilDone(): Promise<void> {
  for (let n = 0; ; n += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet, or the poll timed out: not done, poll again.
    }
    await pause(backoff(n));
  }
}

// Start the forge, register it, then wait for the env: the whole life of the process.
async function run(): Promise<void> {
  const port = await pickPort();
  if (!port) throw new Error('could not pick a free port');
  const child = startForge(port);
  // If the forge dies before the trial ends, that is a failure, not a wait.
  let forgeDead = false;
  child.once('exit', (code) => {
    forgeDead = true;
    if (code !== 0 && code !== null) {
      process.stderr.write(`[entry] the forge exited early with code ${code}\n`);
    }
  });
  process.stdout.write(`[entry] forge starting on port ${port}\n`);
  await waitHealthy(port);
  process.stdout.write('[entry] forge is healthy\n');
  await registerPort(port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');
  await waitUntilDone();
  if (!forgeDead) {
    child.kill('SIGTERM');
    await new Promise<void>((resolve) => {
      child.once('exit', () => resolve());
      setTimeout(resolve, 5_000);
    });
  }
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
