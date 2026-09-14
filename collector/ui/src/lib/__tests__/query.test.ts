import { describe, it, expect } from 'vitest';
import { parseQuery, matchQuery, isEmptyQuery, type QueryRow } from '../query.js';

function row(over: Partial<QueryRow> = {}): QueryRow {
  return {
    method: 'GET',
    status: 200,
    host: 'api.test',
    path: '/users',
    source: 'atlantis',
    deviceId: 'phone-1',
    url: 'https://api.test/users',
    ...over,
  };
}

// A row matches a raw query string, optionally with a body-text accessor.
function matches(q: string, r: QueryRow, body?: (r: QueryRow) => string | null): boolean {
  return matchQuery(parseQuery(q), r, body);
}

describe('parseQuery — tokenizing', () => {
  it('an empty or whitespace input is the empty query', () => {
    expect(isEmptyQuery(parseQuery(''))).toBe(true);
    expect(isEmptyQuery(parseQuery('   '))).toBe(true);
  });

  it('a bare word is a free term (lowercased)', () => {
    expect(parseQuery('Login').free).toEqual(['login']);
  });

  it('splits free terms on unquoted whitespace', () => {
    expect(parseQuery('foo bar').free).toEqual(['foo', 'bar']);
  });

  it('a quoted phrase is one free term keeping its spaces', () => {
    expect(parseQuery('"two words" tail').free).toEqual(['two words', 'tail']);
  });

  it('a quoted value lets a typed term contain spaces', () => {
    expect(parseQuery('host:"api v2"').host).toEqual(['api v2']);
  });

  it('an unknown key becomes a free term, colon and all', () => {
    expect(parseQuery('foo:bar').free).toEqual(['foo:bar']);
    expect(parseQuery('foo:bar').host).toEqual([]);
  });

  it('a known key with no value is a no-op, not a free term', () => {
    const q = parseQuery('host:');
    expect(q.host).toEqual([]);
    expect(q.free).toEqual([]);
    expect(isEmptyQuery(q)).toBe(true);
  });
});

describe('parseQuery — typed keys', () => {
  it('method is lowercased and comma-splits into an OR list', () => {
    expect(parseQuery('method:GET,post').method).toEqual(['get', 'post']);
  });

  it('host/path/device/source keep a single (lowercased) value', () => {
    const q = parseQuery('host:API path:/Users device:Phone source:XHR');
    expect(q.host).toEqual(['api']);
    expect(q.path).toEqual(['/users']);
    expect(q.device).toEqual(['phone']);
    expect(q.source).toEqual(['xhr']);
  });

  it('repeating a key ORs the values', () => {
    expect(parseQuery('host:a host:b').host).toEqual(['a', 'b']);
  });

  it('body keeps a single substring', () => {
    expect(parseQuery('body:token').body).toEqual(['token']);
  });

  it('ignores an unparseable status value', () => {
    expect(parseQuery('status:nope').status).toHaveLength(0);
  });
});

describe('matchQuery — free terms (method + url, AND)', () => {
  it('matches a substring of the url, case-insensitively', () => {
    expect(matches('LOGIN', row({ url: 'https://a.test/login' }))).toBe(true);
    expect(matches('nope', row({ url: 'https://a.test/login' }))).toBe(false);
  });

  it('matches the method', () => {
    expect(matches('delete', row({ method: 'DELETE' }))).toBe(true);
  });

  it('ANDs multiple free terms', () => {
    const r = row({ method: 'POST', url: 'https://a.test/login' });
    expect(matches('post login', r)).toBe(true);
    expect(matches('post logout', r)).toBe(false);
  });
});

describe('matchQuery — method', () => {
  it('matches any value in the comma list, case-insensitively', () => {
    expect(matches('method:get,post', row({ method: 'POST' }))).toBe(true);
    expect(matches('method:get,post', row({ method: 'PUT' }))).toBe(false);
  });
});

describe('matchQuery — status', () => {
  it('exact code', () => {
    expect(matches('status:404', row({ status: 404 }))).toBe(true);
    expect(matches('status:404', row({ status: 400 }))).toBe(false);
  });

  it('class (5xx)', () => {
    expect(matches('status:5xx', row({ status: 503 }))).toBe(true);
    expect(matches('status:5xx', row({ status: 200 }))).toBe(false);
  });

  it('inclusive range', () => {
    expect(matches('status:400-499', row({ status: 404 }))).toBe(true);
    expect(matches('status:400-499', row({ status: 500 }))).toBe(false);
    expect(matches('status:400-499', row({ status: 400 }))).toBe(true);
    expect(matches('status:400-499', row({ status: 499 }))).toBe(true);
  });

  it('comma-separated matchers OR', () => {
    expect(matches('status:404,500', row({ status: 500 }))).toBe(true);
  });

  it('a null status never matches a status term', () => {
    expect(matches('status:5xx', row({ status: null }))).toBe(false);
  });
});

describe('matchQuery — host / path / source / device', () => {
  it('host is a case-insensitive substring', () => {
    expect(matches('host:api', row({ host: 'api.test' }))).toBe(true);
    expect(matches('host:cdn', row({ host: 'api.test' }))).toBe(false);
  });

  it('path is a case-insensitive substring', () => {
    expect(matches('path:user', row({ path: '/users/9' }))).toBe(true);
  });

  it('source is an exact (lowercased) match', () => {
    expect(matches('source:atlantis', row({ source: 'atlantis' }))).toBe(true);
    expect(matches('source:proxy', row({ source: 'atlantis' }))).toBe(false);
  });

  it('device is a case-insensitive substring of deviceId', () => {
    expect(matches('device:phone', row({ deviceId: 'phone-under-two-ids' }))).toBe(true);
    expect(matches('device:tablet', row({ deviceId: 'phone-1' }))).toBe(false);
  });
});

describe('matchQuery — body', () => {
  it('matches a substring of the supplied body text', () => {
    const r = row();
    expect(matches('body:secret', r, () => 'a SECRET value')).toBe(true);
    expect(matches('body:secret', r, () => 'nothing here')).toBe(false);
  });

  it('matches nothing when no body accessor is supplied', () => {
    expect(matches('body:secret', row())).toBe(false);
  });

  it('matches nothing when the accessor returns null (no resident body)', () => {
    expect(matches('body:secret', row(), () => null)).toBe(false);
  });
});

describe('matchQuery — composition (AND across keys)', () => {
  it('every typed term and free term must hold', () => {
    const r = row({ method: 'POST', status: 500, host: 'api.test', url: 'https://api.test/login' });
    expect(matches('method:post status:5xx host:api login', r)).toBe(true);
    expect(matches('method:post status:2xx host:api login', r)).toBe(false);
    expect(matches('method:get status:5xx host:api login', r)).toBe(false);
  });

  it('the empty query matches everything', () => {
    expect(matches('', row())).toBe(true);
  });
});
