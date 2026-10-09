// Interception rules applied to proxied HTTP (U6). The model and validation live
// in ../ruleModel.ts; this module runs the active list inside mockttp's
// passthrough callbacks and remembers, per exchange, what the rules did so the
// recorded entry shows the request as SENT upstream and the response as DELIVERED
// to the device, plus which rules ran.
//
// Request phase (`beforeRequest`): matching rules run in list order; `rewrite`
// changes the outgoing request, `delay` adds to a wait taken before forwarding,
// and the first `block`/`mock` answers the device without contacting upstream
// (mocked). Response phase (`beforeResponse`): `rewrite` and `delay` on the
// upstream answer. mockttp buffers every response it hands to beforeResponse, so
// the server routes ONLY requests a response rule matches through that callback
// (`wantsResponse`): streaming responses (SSE) are untouched otherwise.
//
// Matching always tests the device's request as it arrived, in both phases. The
// accumulated delay is capped at RULE_DELAY_MAX_MS per phase.
import { STATUS_CODES } from 'node:http';
import type { CompletedRequest, requestSteps } from 'mockttp';
import { ruleMatches, RULE_BODY_MAX, RULE_DELAY_MAX_MS, type AppliedRule, type Rule, type RuleRequest, type RewriteAction } from '../ruleModel.js';
import { redactUrl, type RedactMark } from '../redactor.js';
import type { Entry } from '../types.js';
import { log } from '../log.js';

type Headers = Record<string, string | string[] | undefined>;
type CallbackRequestResult = requestSteps.CallbackRequestResult;
type CallbackResponseResult = requestSteps.CallbackResponseResult;
type PassThroughResponse = requestSteps.PassThroughResponse;

// The request as it left the proxy (or would have, for a mocked one). `body`
// undefined means unchanged: the recorder reads the device's own body then.
export type SentRequest = { method: string; url: string; headers: Headers; body?: Buffer };

export type RuleEffects = {
  applied: AppliedRule[];
  // True when the device was answered (or cut off) by a rule without any upstream.
  mocked: boolean;
  original: { method: string; url: string };
  sent?: SentRequest;
};

type Exchange = RuleEffects & { responseRules: Rule[] };

export type RuleRunnerOptions = {
  rules: () => readonly Rule[];
  // True when a rewritten destination must not be contacted (the cloud metadata
  // address, a collector-internal endpoint): the connection is closed instead.
  refuseDestination: (hostname: string, port: number) => boolean;
  sleep?: (ms: number) => Promise<void>;
};

export type RuleRunner = {
  wantsResponse(req: RuleRequest): boolean;
  beforeRequest(req: CompletedRequest): Promise<CallbackRequestResult | undefined>;
  beforeResponse(res: PassThroughResponse, req: CompletedRequest): Promise<CallbackResponseResult | undefined>;
  // The effects recorded for one exchange, removed from the runner.
  take(id: string): RuleEffects | undefined;
  clear(): void;
};

// Exchanges whose response/abort event never arrives must not pile up.
const MAX_PENDING = 10_000;
const strictUtf8 = new TextDecoder('utf8', { fatal: true });
const defaultSleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

const lowerHeaders = (h: Headers): Headers => {
  const out: Headers = {};
  for (const [k, v] of Object.entries(h)) if (v !== undefined) out[k.toLowerCase()] = Array.isArray(v) ? [...v] : v;
  return out;
};
const withoutPseudo = (h: Headers): Headers => Object.fromEntries(Object.entries(h).filter(([k]) => !k.startsWith(':')));
const ruleBody = (a: { body?: string; bodyBase64?: string }): Buffer | undefined =>
  a.body !== undefined ? Buffer.from(a.body, 'utf8') : a.bodyBase64 !== undefined ? Buffer.from(a.bodyBase64, 'base64') : undefined;

// The replaced body may grow by at most this much past max(input, 1 MiB): a short
// `find` repeated through a body times a long `with` would otherwise multiply it.
export const RULE_REPLACE_OUTPUT_EXTRA = 1024 * 1024;

// Literal find/replace over a UTF-8 body (left to right, non-overlapping, item by
// item); a binary (non-UTF-8) body is left alone (null). The output is capped at
// max(input, RULE_BODY_MAX) + RULE_REPLACE_OUTPUT_EXTRA bytes: the replacement
// that would cross it, and every later one, is not made (the rest of the body is
// left unchanged) and `capped` is set.
export function replaceText(buf: Buffer, items: RewriteAction['replace']): { body: Buffer; capped: boolean } | null {
  let text: string;
  try { text = strictUtf8.decode(buf); } catch { return null; }
  const cap = Math.max(buf.length, RULE_BODY_MAX) + RULE_REPLACE_OUTPUT_EXTRA;
  let size = buf.length;
  let capped = false;
  for (const it of items ?? []) {
    if (capped) break;
    const delta = Buffer.byteLength(it.with, 'utf8') - Buffer.byteLength(it.find, 'utf8');
    const parts: string[] = [];
    let i = 0;
    for (let j = text.indexOf(it.find); j >= 0; j = text.indexOf(it.find, i)) {
      if (delta > 0 && size + delta > cap) { capped = true; break; }
      parts.push(text.slice(i, j), it.with);
      size += delta;
      i = j + it.find.length;
    }
    if (parts.length) { parts.push(text.slice(i)); text = parts.join(''); }
  }
  return { body: Buffer.from(text, 'utf8'), capped };
}

const CAPPED_NOTE = `replace stopped at the ${RULE_REPLACE_OUTPUT_EXTRA}-byte growth cap; the rest of the body was left unchanged`;

function applyHeaderOps(headers: Headers, a: RewriteAction): boolean {
  let changed = false;
  for (const n of a.removeHeaders ?? []) if (n in headers) { delete headers[n]; changed = true; }
  for (const [n, v] of Object.entries(a.setHeaders ?? {})) { headers[n] = v; changed = true; }
  return changed;
}

const applied = (r: Rule): AppliedRule => ({ id: r.id, name: r.name, action: r.action.type, phase: r.phase });
const portOf = (u: URL): number => Number(u.port) || (u.protocol === 'https:' ? 443 : 80);

export function createRuleRunner(opts: RuleRunnerOptions): RuleRunner {
  const sleep = opts.sleep ?? defaultSleep;
  const exchanges = new Map<string, Exchange>();
  const remember = (id: string, x: Exchange): void => {
    exchanges.set(id, x);
    if (exchanges.size > MAX_PENDING) exchanges.delete(exchanges.keys().next().value as string);
  };
  const matching = (phase: Rule['phase'], req: RuleRequest): Rule[] =>
    opts.rules().filter((r) => r.enabled && r.phase === phase && ruleMatches(r.match, req));

  async function requestPhase(req: CompletedRequest): Promise<CallbackRequestResult | undefined> {
    const orig: RuleRequest = { method: req.method, url: req.url, headers: req.headers };
    const reqRules = matching('request', orig);
    const responseRules = matching('response', orig);
    if (reqRules.length === 0 && responseRules.length === 0) return undefined;
    const x: Exchange = { applied: [], mocked: false, original: { method: req.method, url: req.url }, responseRules };
    remember(req.id, x);

    let method = req.method;
    let url = req.url;
    const headers = lowerHeaders(req.headers);
    let body: Buffer | undefined; // set once a rule changed it
    let methodChanged = false; let urlChanged = false; let headersChanged = false; let hostSet = false;
    let delay = 0;
    const currentBody = async (): Promise<Buffer | undefined> => body ?? (await req.body.getDecodedBuffer().catch(() => undefined)) ?? undefined;
    const snapshot = (): SentRequest | undefined => {
      if (!methodChanged && !urlChanged && !headersChanged && body === undefined) return undefined;
      const h = { ...headers };
      if (urlChanged && !hostSet) h.host = new URL(url).host;
      if (body !== undefined && h['content-length'] !== undefined) h['content-length'] = String(body.length);
      return { method, url, headers: h, ...(body !== undefined ? { body } : {}) };
    };

    for (const r of reqRules) {
      const a = r.action;
      x.applied.push(applied(r));
      if (a.type === 'delay') { delay += a.ms; continue; }
      if (a.type === 'rewrite') {
        if (a.method && a.method !== method) { method = a.method; methodChanged = true; }
        if (a.url) {
          const next = a.url.startsWith('/') ? new URL(a.url, url).toString() : new URL(a.url).toString();
          if (next !== url) { url = next; urlChanged = true; }
        }
        if (applyHeaderOps(headers, a)) headersChanged = true;
        if (a.setHeaders && Object.hasOwn(a.setHeaders, 'host')) hostSet = true;
        const replacement = ruleBody(a);
        if (replacement) body = replacement;
        if (a.replace?.length) {
          const cur = await currentBody();
          const next = cur ? replaceText(cur, a.replace) : null;
          if (next) { body = next.body; if (next.capped) x.applied[x.applied.length - 1].note = CAPPED_NOTE; }
        }
        continue;
      }
      // block / mock: answer the device here; nothing reaches upstream.
      x.mocked = true;
      x.sent = snapshot();
      if (a.type === 'mock') {
        await sleep(Math.min(RULE_DELAY_MAX_MS, delay + (a.delayMs ?? 0)));
        return { response: { statusCode: a.status, headers: { ...(a.headers ?? {}) }, body: ruleBody(a) ?? '' } };
      }
      if (delay > 0) await sleep(Math.min(RULE_DELAY_MAX_MS, delay));
      if ('close' in a) return { response: 'close' };
      if ('reset' in a) return { response: 'reset' };
      return { response: { statusCode: a.status ?? 403, headers: { 'content-type': 'text/plain; charset=utf-8' }, body: a.body ?? '' } };
    }

    x.sent = snapshot();
    if (urlChanged) {
      const u = new URL(url);
      if (opts.refuseDestination(u.hostname.replace(/^\[|\]$/g, ''), portOf(u))) {
        log.warn('proxy: a rule rewrote a request to a refused destination; closing', u.host);
        x.mocked = true;
        return { response: 'close' };
      }
    }
    if (delay > 0) await sleep(Math.min(RULE_DELAY_MAX_MS, delay));
    if (!x.sent) return undefined;
    const out: CallbackRequestResult = {};
    if (methodChanged) out.method = method;
    if (urlChanged) out.url = url;
    if (headersChanged || urlChanged) {
      const h = withoutPseudo(headers);
      // Let mockttp derive Host from the new URL unless a rule set it explicitly.
      if (urlChanged && !hostSet) delete h.host;
      out.headers = h;
    }
    if (body !== undefined) out.body = body;
    return out;
  }

  async function responsePhase(res: PassThroughResponse, req: CompletedRequest): Promise<CallbackResponseResult | undefined> {
    const x = exchanges.get(req.id) ?? exchanges.get(res.id);
    if (!x || x.responseRules.length === 0) return undefined;
    let status = res.statusCode;
    const headers = lowerHeaders(res.headers);
    let body: Buffer | undefined;
    let statusChanged = false; let headersChanged = false;
    let delay = 0;
    for (const r of x.responseRules) {
      const a = r.action;
      x.applied.push(applied(r));
      if (a.type === 'delay') { delay += a.ms; continue; }
      if (a.type !== 'rewrite') continue; // validation never lets block/mock into this phase
      if (a.status !== undefined && a.status !== status) { status = a.status; statusChanged = true; }
      if (applyHeaderOps(headers, a)) headersChanged = true;
      const replacement = ruleBody(a);
      if (replacement) body = replacement;
      if (a.replace?.length) {
        const cur = body ?? (await res.body.getDecodedBuffer().catch(() => undefined)) ?? undefined;
        const next = cur ? replaceText(cur, a.replace) : null;
        if (next) { body = next.body; if (next.capped) x.applied[x.applied.length - 1].note = CAPPED_NOTE; }
      }
    }
    if (delay > 0) await sleep(Math.min(RULE_DELAY_MAX_MS, delay));
    if (!statusChanged && !headersChanged && body === undefined) return undefined;
    return {
      ...(statusChanged ? { statusCode: status, statusMessage: STATUS_CODES[status] ?? '' } : {}),
      ...(headersChanged ? { headers: withoutPseudo(headers) } : {}),
      ...(body !== undefined ? { body } : {}),
    };
  }

  return {
    wantsResponse(req) {
      try { return matching('response', req).length > 0; } catch { return false; }
    },
    // A failure inside a rule leaves the exchange untouched (logged), never a
    // half-applied request.
    async beforeRequest(req) {
      try { return await requestPhase(req); } catch (e) {
        exchanges.delete(req.id);
        log.warn('proxy: request rule failed; forwarding unchanged', String(e));
        return undefined;
      }
    },
    async beforeResponse(res, req) {
      try { return await responsePhase(res, req); } catch (e) {
        log.warn('proxy: response rule failed; delivering unchanged', String(e));
        return undefined;
      }
    },
    take(id) {
      const x = exchanges.get(id);
      if (!x) return undefined;
      exchanges.delete(id);
      const { responseRules: _r, ...fx } = x;
      return fx;
    },
    clear() { exchanges.clear(); },
  };
}

// The entry fields a rule leaves on its record: which rules ran, `mocked` when no
// upstream was contacted, and the device's original method/URL when a rewrite
// changed them (the URL redacted like every stored URL). `mark` collects whether
// that redaction masked anything, for the entry's `redacted` marker.
export function ruleEntryFields(fx: RuleEffects | undefined, mark?: RedactMark): Pick<Entry, 'rules' | 'mocked' | 'originalUrl' | 'originalMethod'> {
  if (!fx || fx.applied.length === 0) return {};
  const sent = fx.sent;
  return {
    rules: fx.applied,
    ...(fx.mocked ? { mocked: true } : {}),
    ...(sent && sent.url !== fx.original.url ? { originalUrl: redactUrl(fx.original.url, mark) } : {}),
    ...(sent && sent.method !== fx.original.method ? { originalMethod: fx.original.method } : {}),
  };
}
