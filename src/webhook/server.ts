/**
 * Webhook ingress.
 *
 * Built on node:http directly. An HTTP framework would earn nothing here: this server
 * has one route, and the two things it must get exactly right - reading the RAW body
 * bytes for signature verification, and committing to the inbox before doing any work -
 * are both things a framework's body parser actively gets in the way of.
 *
 * The handler is deliberately tiny. It verifies, dedupes, stores, and returns 200. It
 * does NOT process the event inline: a gateway that times out will redeliver, and slow
 * handlers are how you turn one event into five. Processing happens off the inbox.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';

import { optionalEnv } from '../config.ts';
import { acceptEvent } from '../durable/inbox.ts';
import { SIGNATURE_HEADER, verifySignature } from './verify.ts';

/** Cap the body so an unauthenticated caller cannot exhaust memory before we verify. */
const MAX_BODY_BYTES = 1_000_000;

async function readRawBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    total += buf.length;
    if (total > MAX_BODY_BYTES) throw new Error('request body too large');
    chunks.push(buf);
  }
  return Buffer.concat(chunks);
}

export interface WebhookServerOptions {
  readonly port?: number;
  readonly secret?: string;
  readonly path?: string;
}

export interface WebhookServerHandle {
  readonly server: Server;
  readonly port: number;
  close(): Promise<void>;
}

export function createWebhookHandler(secret: string, path: string) {
  return async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    if (req.method !== 'POST' || req.url !== path) {
      res.writeHead(404, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'not found' }));
      return;
    }

    let raw: Buffer;
    try {
      raw = await readRawBody(req);
    } catch {
      res.writeHead(413, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'payload too large' }));
      return;
    }

    const signature = req.headers[SIGNATURE_HEADER];
    const provided = Array.isArray(signature) ? signature[0] : signature;

    // Verify against the raw bytes, before parsing. An unverified body is untrusted
    // input and must not reach a parser-driven code path any earlier than necessary.
    if (!verifySignature(raw, provided, secret)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'invalid signature' }));
      return;
    }

    let parsed: { event?: string; id?: string; payload?: Record<string, unknown> };
    try {
      parsed = JSON.parse(raw.toString('utf8')) as typeof parsed;
    } catch {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'malformed json' }));
      return;
    }

    const eventId = parsed.id;
    const eventType = parsed.event;
    if (typeof eventId !== 'string' || typeof eventType !== 'string') {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'missing id or event' }));
      return;
    }

    const result = await acceptEvent({
      eventId,
      eventType,
      payload: parsed.payload ?? {},
    });

    // A duplicate is a SUCCESS, not an error. Returning non-2xx would make the gateway
    // redeliver forever, turning correct dedupe into an infinite retry loop.
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true, duplicate: result.duplicate }));
  };
}

export async function startWebhookServer(
  opts: WebhookServerOptions = {},
): Promise<WebhookServerHandle> {
  const secret = opts.secret ?? optionalEnv('RAZORPAY_WEBHOOK_SECRET', '');
  if (secret === '') {
    throw new Error('RAZORPAY_WEBHOOK_SECRET is not set; refusing to start unauthenticated');
  }
  const path = opts.path ?? '/webhooks/razorpay';
  const handler = createWebhookHandler(secret, path);

  const server = createServer((req, res) => {
    handler(req, res).catch((err: unknown) => {
      console.error('webhook handler failed:', err);
      if (!res.headersSent) {
        res.writeHead(500, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'internal error' }));
      }
    });
  });

  const port = await new Promise<number>((resolve, reject) => {
    server.once('error', reject);
    server.listen(opts.port ?? 0, '127.0.0.1', () => {
      const addr = server.address();
      if (addr === null || typeof addr === 'string') {
        reject(new Error('failed to determine bound port'));
        return;
      }
      resolve(addr.port);
    });
  });

  return {
    server,
    port,
    close: () =>
      new Promise<void>((resolve, reject) => {
        server.close((err) => (err ? reject(err) : resolve()));
      }),
  };
}

if (import.meta.filename === process.argv[1]) {
  const handle = await startWebhookServer({ port: Number(optionalEnv('WEBHOOK_PORT', '8787')) });
  console.log(`webhook ingress listening on http://127.0.0.1:${handle.port}/webhooks/razorpay`);
}
