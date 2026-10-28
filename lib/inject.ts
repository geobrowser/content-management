// Injector client — paste a URL, get back publishable GRC-20 ops.
//
// The news-worker "injector" fetches a URL (tweet / news article / reddit post /
// person bio), extracts + structures it, and returns a base64 GRC-20 Edit. This
// helper POSTs /inject, polls until the job finishes, decodes the Edit, and hands
// you `{ name, ops }` ready for publishOps() in src/functions.ts.
//
// The worker writes NOTHING on-chain — only your own publish step does. Reads
// INJECT_BASE_URL + INJECT_API_KEY from .env (staging/testing). Production will
// use Privy auth instead of the API key.
//
// Usage:
//   import { injectAndDecode } from '../lib/inject.ts';
//   const r = await injectAndDecode(url, { space: 'world-affairs',
//     onPoll: (i, s) => process.stdout.write(`\r  poll ${i}: ${s}   `) });
//   // r.name, r.ops  ->  publishOps(r.ops, r.name, <your-space-id>)
import { decodeEdit } from '@geoprotocol/grc-20';

// Worker inject types. `space` (below) is the worker's EXTRACTION context
// (crypto | ai | world-affairs | health | ...), NOT the space you publish into.
export type InjectType = 'tweet' | 'post' | 'news-story' | 'news-story-single' | 'person';

const HOST_RULES: Array<[RegExp, InjectType]> = [
  [/(^|\.)(x|twitter)\.com$/i, 'tweet'],
  [/(^|\.)reddit\.com$/i, 'post'],
  [/(^|\.)(wikipedia\.org|linkedin\.com)$/i, 'person'],
];

// Host-detect the inject type from a URL. Anything that isn't X / Reddit /
// Wikipedia|LinkedIn is treated as a news article (single URL; the worker
// auto-discovers other outlets covering the same event).
export function detectInjectType(url: string): InjectType {
  let host = '';
  try { host = new URL(url).hostname; } catch { /* fall through */ }
  for (const [re, t] of HOST_RULES) if (re.test(host)) return t;
  return 'news-story-single';
}

export interface InjectResult {
  jobId: number;
  name: string;   // decoded Edit name (headline / post summary) — feed to publishOps as editName
  ops: unknown[]; // GRC-20 ops, ready for publishOps()
  opCount: number;
  errors: unknown[]; // stage errors — populated even when status=completed; ALWAYS inspect
  preview: any;   // .story or .posts[0]: headline, summary, sources, topics, entities, coverUrl
}

export interface InjectOptions {
  space: string;                       // worker extraction space (NOT the publish target)
  type?: InjectType;                   // omit → host-detected
  gates?: Record<string, boolean>;     // e.g. { bypassExactDedup: true } to re-inject a repeat URL
  pollIntervalMs?: number;             // default 8000
  maxPolls?: number;                   // default 40 (~5 min)
  onPoll?: (attempt: number, status: string) => void;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export async function injectAndDecode(url: string, opts: InjectOptions): Promise<InjectResult> {
  const BASE = process.env.INJECT_BASE_URL;
  const KEY = process.env.INJECT_API_KEY;
  if (!BASE || !KEY) throw new Error('INJECT_BASE_URL / INJECT_API_KEY missing from .env');
  if (!/^https?:\/\//.test(url)) throw new Error(`not an http(s) URL: ${url}`);

  const type = opts.type ?? detectInjectType(url);
  const auth = { Authorization: `Bearer ${KEY}`, 'Content-Type': 'application/json' };

  // 1. enqueue
  const injectRes = await fetch(`${BASE}/inject`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ space: opts.space, url, type, ...(opts.gates ? { gates: opts.gates } : {}) }),
  });
  const injectBody: any = await injectRes.json().catch(() => ({}));
  if (!injectRes.ok || !injectBody?.jobId) {
    throw new Error(`inject failed (HTTP ${injectRes.status}): ${JSON.stringify(injectBody)}`);
  }
  const jobId: number = injectBody.jobId;

  // 2. poll to a terminal state (running → completed | failed)
  const interval = opts.pollIntervalMs ?? 8000;
  const maxPolls = opts.maxPolls ?? 40;
  let job: any;
  for (let i = 1; i <= maxPolls; i++) {
    await sleep(interval);
    const r = await fetch(`${BASE}/inject/${jobId}`, { headers: auth });
    job = await r.json().catch(() => ({}));
    opts.onPoll?.(i, job?.status ?? '(none)');
    if (job?.status === 'completed' || job?.status === 'failed') break;
  }
  if (job?.status !== 'completed') {
    throw new Error(`inject job ${jobId} did not complete (status=${job?.status}); errors=${JSON.stringify(job?.errors ?? [])}`);
  }

  // 3. decode — tweet/post live in .posts[0], news-story/person in .story
  const carrier = type === 'tweet' || type === 'post' ? job.posts?.[0] : job.story;
  const edit = carrier?.edit;
  if (!edit?.data) {
    throw new Error(`inject job ${jobId} produced no edit (prepare-ops failed?); errors=${JSON.stringify(job?.errors ?? [])}`);
  }
  const decoded = decodeEdit(Uint8Array.from(Buffer.from(edit.data, 'base64')));

  return {
    jobId,
    name: decoded.name,
    ops: decoded.ops as unknown[],
    opCount: decoded.ops.length,
    errors: job?.errors ?? [],
    preview: carrier,
  };
}
