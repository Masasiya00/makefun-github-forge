// Trial entrypoint: connects the forge to the environment that grades it.
// Binds a free port, announces it, then waits for the trial to finish.

import { createApp } from './app.ts';

const base = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');
if (!base) {
  process.stderr.write('MAKEFUN_ENV_URL is not set\n');
  process.exit(1);
}

const TIMEOUT_MS = 30000;
const FIRST_PAUSE_MS = 250;
const MAX_PAUSE_MS = 2000;

const pause = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

function pauseFor(attempt: number): number {
  return Math.min(MAX_PAUSE_MS, FIRST_PAUSE_MS * 2 ** Math.min(attempt, 8));
}

async function announce(port: number): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${base}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register refused: HTTP ${res.status}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register refused:')) throw err;
    }
    await pause(pauseFor(attempt));
  }
}

async function awaitDone(): Promise<void> {
  for (let attempt = 0; ; attempt++) {
    try {
      const res = await fetch(`${base}/done`, {
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // Still running — poll again.
    }
    await pause(pauseFor(attempt));
  }
}

async function run(): Promise<void> {
  const server = createApp();
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const addr = server.address();
  if (addr === null || typeof addr === 'string') {
    throw new Error('no ephemeral port bound');
  }
  process.stdout.write(`listening on ${addr.port}\n`);
  await announce(addr.port);
  process.stdout.write('registered, waiting for done\n');
  await awaitDone();
  server.close();
  process.stdout.write('done\n');
}

try {
  await run();
  process.exit(0);
} catch (err) {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
}
