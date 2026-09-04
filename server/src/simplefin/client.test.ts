import { test, describe } from 'node:test';
import assert from 'node:assert/strict';

import { fetchAccounts, splitCredentials, toCents } from './client.ts';

describe('splitCredentials', () => {
  // fetch() throws "Request cannot be constructed from a URL that includes credentials"
  // if userinfo survives into the Request. curl converts it silently, which is why the
  // same URL works on the command line and fails here.
  test('moves inline credentials into a Basic header', () => {
    const { url, authorization } = splitCredentials('https://user:pass@example.com/simplefin');
    assert.equal(url, 'https://example.com/simplefin');
    assert.equal(authorization, `Basic ${Buffer.from('user:pass').toString('base64')}`);
  });

  test('decodes percent-encoded credentials before encoding them', () => {
    // A generated password containing : or @ arrives percent-encoded in the URL, and
    // Basic auth wants the raw bytes. Getting this wrong produces a 403 that looks
    // exactly like a revoked connection.
    const { authorization } = splitCredentials('https://us%40er:p%3Ass@example.com/x');
    assert.equal(authorization, `Basic ${Buffer.from('us@er:p:ss').toString('base64')}`);
  });

  test('leaves a credential-free URL untouched', () => {
    const { url, authorization } = splitCredentials('https://example.com/simplefin');
    assert.equal(url, 'https://example.com/simplefin');
    assert.equal(authorization, null);
  });

  test('never leaves credentials in the returned URL', () => {
    const { url } = splitCredentials('https://user:pass@example.com/simplefin');
    assert.ok(!url.includes('user'), 'the URL is logged and must not carry the credential');
    assert.ok(!url.includes('pass'));
  });
});

describe('toCents', () => {
  test('parses a decimal string to integer cents', () => {
    assert.equal(toCents('1234.56'), 123_456);
    assert.equal(toCents('-1234.56'), -123_456);
    assert.equal(toCents('0.00'), 0);
  });

  test('rounds rather than truncating', () => {
    assert.equal(toCents('0.005'), 1);
  });

  test('throws on something unparseable rather than returning NaN', () => {
    assert.throws(() => toCents('not a number'));
  });
});

describe('fetchAccounts', () => {
  // The failure this guards against is not a slow sync, it is a sync that never ends:
  // POST /api/sync holds the connection open, the button spins forever, and the
  // in-flight guard blocks every later attempt until the process restarts.
  test('gives up on a request the Bridge never answers', async () => {
    const realFetch = globalThis.fetch;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) =>
      new Promise((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
      })) as typeof fetch;

    try {
      await assert.rejects(
        fetchAccounts('https://user:pass@example.com/simplefin', { timeoutMs: 20 }),
        /did not respond within/
      );
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test('passes an abort signal on every request', async () => {
    const realFetch = globalThis.fetch;
    let sawSignal = false;
    globalThis.fetch = ((_url: string | URL | Request, init?: RequestInit) => {
      sawSignal = init?.signal instanceof AbortSignal;
      return Promise.resolve(new Response('{"accounts":[],"errors":[]}', { status: 200 }));
    }) as typeof fetch;

    try {
      await fetchAccounts('https://user:pass@example.com/simplefin');
      assert.ok(sawSignal, 'a request without a deadline can hang the whole app');
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
