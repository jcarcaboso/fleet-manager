import { vi } from 'vitest';

export interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: unknown;
  init: RequestInit;
}
export type Reply = Response | Error | ((seen: Seen) => Response | Promise<Response>);

export const jsonResponse = (body: unknown, status = 200): Response => new Response(body === null ? '' : JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } });

/** A `fetch` that answers from a list of replies in order (the last repeats) and records what it was asked. */
export function scriptedFetch(...replies: Reply[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const impl = vi.fn(async (input: RequestInfo | URL, init: RequestInit = {}): Promise<Response> => {
    const headers: Record<string, string> = {};
    new Headers(init.headers).forEach((v, k) => { headers[k.toLowerCase()] = v; });
    const entry: Seen = { url: String(input), method: init.method ?? 'GET', headers, body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined, init };
    seen.push(entry);
    const reply = replies[Math.min(i++, replies.length - 1)]!;
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply(entry) : reply.clone();
  });
  return { fetch: impl as unknown as typeof fetch, seen };
}
