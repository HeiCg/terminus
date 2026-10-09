import { describe, it, expect, afterEach } from 'vitest';
import { isSensitiveName, nameWords, configureRedaction, redactionConfigFromEnv, parseNameList, type NameKind } from '../src/security/sensitiveNames.js';

const KINDS: NameKind[] = ['header', 'query', 'body'];

afterEach(() => configureRedaction({}));

describe('nameWords (P5)', () => {
  it.each([
    ['x-api-key', ['x', 'api', 'key']],
    ['nextPageToken', ['next', 'page', 'token']],
    ['APIKey', ['api', 'key']],
    ['X-Session-Id', ['x', 'session', 'id']],
    ['user.card_number', ['user', 'card', 'number']],
    ['otp2fa', ['otp', '2', 'fa']],
    ['2faCode', ['2', 'fa', 'code']],
    ['my password', ['my', 'password']],
  ])('%s -> %j', (name, words) => { expect(nameWords(name)).toEqual(words); });
});

describe('isSensitiveName word matcher (P5)', () => {
  const positives = [
    'password', 'Passwd', 'pwd', 'client_secret', 'token', 'apikey', 'APIKEY', 'auth', 'Authorization',
    'session', 'sessionid', 'SESSIONID', 'credential', 'credentials', 'otp', 'pin', 'cvv', 'cvc', 'signature', 'sig',
    'cookie', 'Set-Cookie', 'setcookie', 'accesstoken', 'x-api-key', 'X-Api-Key', 'api_key', 'apiKey', 'cardNumber',
    'card-number', 'proxy-authorization', 'x-amz-security-token', 'X-Session-Id', 'nextPageToken', 'refresh_token',
    'x-auth-token', 'X-CSRF-Token', 'user.password', 'otp2', 'x-apikey',
    // Simple plurals of a listed word match: strip one trailing `s`.
    'tokens_per_page', 'secrets', 'passwords', 'cookies', 'sessions', 'apiKeys', 'card_numbers',
  ];
  const negatives = [
    'shipping', 'author', 'authority', 'discard', 'cardinality', 'pinned', 'spinner', 'keyboard', 'monkey',
    'signal', 'design', 'key', 'card', 'number', 'api', 'page', 'content-type', 'accept', 'x-request-id', 'nested_key',
    'tokenizer', 'passage', 'xapikey',
  ];
  for (const kind of KINDS) {
    it.each(positives)(`${kind}: %s is sensitive`, (n) => { expect(isSensitiveName(n, kind)).toBe(true); });
    it.each(negatives)(`${kind}: %s is not sensitive`, (n) => { expect(isSensitiveName(n, kind)).toBe(false); });
  }
});

describe('legacy names stay redacted (pin of the pre-P5 lists)', () => {
  // collector/src/redactor.ts before P5: HEADERS, QUERY (case-sensitive) and the
  // TEXT_KEY body regex. Every one of them must still be sensitive.
  it.each(['access-token', 'client', 'authorization', 'cookie', 'set-cookie', 'uid'])('header %s', (n) => {
    expect(isSensitiveName(n, 'header')).toBe(true);
    expect(isSensitiveName(n.toUpperCase(), 'header')).toBe(true);
  });
  it.each(['access_token', 'client_id', 'uid'])('query %s', (n) => { expect(isSensitiveName(n, 'query')).toBe(true); });
  it.each(['access_token', 'access-token', 'accesstoken', 'client', 'authorization', 'uid', 'password',
    // The old regex was not anchored on the left: a key ENDING in a legacy name matched.
    'guid', 'api_client', 'my_access_token', 'Password'])('body key %s', (n) => {
    expect(isSensitiveName(n, 'body')).toBe(true);
  });
  it('legacy names stay scoped to the kind they had', () => {
    expect(isSensitiveName('client_id', 'header')).toBe(false);
    expect(isSensitiveName('guid', 'header')).toBe(false);
    expect(isSensitiveName('client', 'query')).toBe(false);
  });
});

describe('TERMINUS_REDACT_EXTRA / TERMINUS_REDACT_ALLOW (P5)', () => {
  it('extra adds whole names case-insensitively on every kind', () => {
    configureRedaction({ extra: ['X-Tenant', 'ssn'] });
    for (const kind of KINDS) {
      expect(isSensitiveName('x-tenant', kind)).toBe(true);
      expect(isSensitiveName('SSN', kind)).toBe(true);
      expect(isSensitiveName('ssn_hint', kind)).toBe(false); // whole name, not a word
    }
  });
  it('allow exempts a built-in name (nextPageToken) and wins over extra', () => {
    configureRedaction({ allow: ['nextPageToken', 'uid'], extra: ['nextpagetoken'] });
    expect(isSensitiveName('nextPageToken', 'body')).toBe(false);
    expect(isSensitiveName('NEXTPAGETOKEN', 'query')).toBe(false);
    expect(isSensitiveName('uid', 'header')).toBe(false);
    expect(isSensitiveName('pageToken', 'body')).toBe(true);
  });
  it('allow can never exempt authorization, cookie, set-cookie or proxy-authorization', () => {
    configureRedaction({ allow: ['Authorization', 'cookie', 'set-cookie', 'proxy-authorization'] });
    for (const n of ['authorization', 'Cookie', 'Set-Cookie', 'Proxy-Authorization']) {
      for (const kind of KINDS) expect(isSensitiveName(n, kind)).toBe(true);
    }
  });
  it('parses comma-separated lists, trimming blanks', () => {
    expect(parseNameList(' a, B ,,c ')).toEqual(['a', 'B', 'c']);
    expect(parseNameList(undefined)).toEqual([]);
  });
  it('reads both variables through env() (TERMINUS_ and the deprecated prefix)', () => {
    process.env.TERMINUS_REDACT_EXTRA = 'x-tenant, ssn';
    process.env.NETCAPTURE_REDACT_ALLOW = 'nextPageToken';
    try {
      expect(redactionConfigFromEnv()).toEqual({ extra: ['x-tenant', 'ssn'], allow: ['nextPageToken'] });
    } finally {
      delete process.env.TERMINUS_REDACT_EXTRA; delete process.env.NETCAPTURE_REDACT_ALLOW;
    }
  });
});
