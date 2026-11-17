// The forge's HTTP server: one in-memory store, four surfaces.
// Routing: /healthz (boot probe, no auth), /api/v3 (REST), /api/graphql,
// /mcp, /<owner>/<repo>.git (git smart HTTP). Everything else: JSON 404.
// Every reply carries a non-empty X-GitHub-Request-Id and is JSON, never HTML.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { sendJson, handleRest } from './rest.ts';
import { handleGraphql } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { handleGit } from './git.ts';

function pathOf(req: IncomingMessage): { pathname: string; query: URLSearchParams } {
  try {
    const u = new URL(req.url ?? '/', 'http://entry');
    return { pathname: u.pathname, query: u.searchParams };
  } catch {
    return { pathname: '/', query: new URLSearchParams() };
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const { pathname, query } = pathOf(req);
        const method = req.method ?? 'GET';
        const reqId = store.nextRequestId();
        const headers: Record<string, string> = { 'x-github-request-id': reqId };

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && pathname === '/healthz') {
          sendJson(res, 200, { ok: true }, headers);
          return;
        }

        if (pathname === '/api/v3' || pathname.startsWith('/api/v3/')) {
          await handleRest(req, res, store, pathname, query);
          return;
        }

        if (pathname === '/api/graphql') {
          await handleGraphql(req, res, store);
          return;
        }

        if (pathname === '/mcp') {
          await handleMcp(req, res, store);
          return;
        }

        if (await handleGit(req, res, store, pathname, query)) return;

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' }, headers);
      } catch (err) {
        // Never crash a request and never answer HTML.
        try { sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' }); } catch { /* socket gone */ }
      }
    })();
  });
}
