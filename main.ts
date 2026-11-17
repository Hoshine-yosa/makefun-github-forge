// Entry point: the harness lifecycle. This process is a server the trial env drives:
// it binds a port, hands the port to the env, and stays up until the env says the trial
// is over. Nothing here is scored — the forge itself lives in app.ts — but the lifecycle
// has to be exactly right or the trial never starts.
//
// Sequence:
//   1. Read MAKEFUN_ENV_URL (the env's origin). No env, no trial: exit 1.
//   2. Listen on port 0 so the kernel picks a free one. Never 8080; the env owns it.
//   3. POST the port to $MAKEFUN_ENV_URL/register. 200 registers us; 409 means a first
//      register already won and we just wait like any other entry. 400/405 are contract
//      errors and end the program; anything else is retried (the env may be starting).
//   4. GET $MAKEFUN_ENV_URL/done until it says {"done": true}. A poll is a quick request,
//      not a held connection; a failed poll just means "not done yet".
//   5. Close the server and exit 0. The harness stops the env, which writes the export.

import { createApp } from './app.ts';

const envUrl = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (envUrl === '') {
  process.stderr.write('[entry] MAKEFUN_ENV_URL is not set, so there is no env to register with\n');
  process.exit(1);
}

// One register/done request may take this long before it is abandoned and retried.
const REQUEST_TIMEOUT = 30_000;
// Backoff between retries: start here, double each time, never pass the cap.
const BACKOFF_FIRST = 250;
const BACKOFF_MAX = 2_000;

const pause = (ms: number): Promise<void> => new Promise((done) => setTimeout(done, ms));

// Wait after `n` failed attempts: exponential from BACKOFF_FIRST, capped at BACKOFF_MAX.
function backoff(n: number): number {
  return Math.min(BACKOFF_MAX, BACKOFF_FIRST * 2 ** Math.min(n, 8));
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

// Bind the port, register it, then wait for the env: the whole life of the process.
async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('the server did not bind an ephemeral TCP port');
  }
  process.stdout.write(`[entry] listening on port ${addr.port}\n`);

  await registerPort(addr.port);
  process.stdout.write('[entry] registered; waiting for the env to say done\n');

  await waitUntilDone();
  server.close();
  process.stdout.write('[entry] done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`[entry] ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
