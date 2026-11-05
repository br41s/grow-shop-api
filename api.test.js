// POST /api/submit-offer through real Express. Only outbound calls are faked:
// Turnstile's siteverify and Resend, both of which go through global fetch.
process.env.RESEND_API_KEY = 're_test';
process.env.TURNSTILE_SECRET_KEY = 'test-secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./api.js');

const realFetch = global.fetch;
let server, base, siteverify, verifyCalls, emails;

before(async () => {
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('challenges.cloudflare.com')) {
      verifyCalls.push(init);
      return siteverify();
    }
    if (target.includes('api.resend.com')) {
      emails.push(target);
      return Response.json({ id: 'fake' });
    }
    return realFetch(url, init);
  };
  await new Promise((resolve) => {
    server = app.listen(0, '127.0.0.1', resolve);
  });
  base = `http://127.0.0.1:${server.address().port}`;
});

after(() => {
  global.fetch = realFetch;
  server.close();
});

beforeEach(() => {
  verifyCalls = [];
  emails = [];
  siteverify = () => Response.json({ success: true, hostname: 'grow-shop.com' });
});

function submit(headers = {}) {
  return fetch(`${base}/api/submit-offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', turnstileToken: 'token' })
  });
}

test('a valid token from our site sends both emails', async () => {
  const res = await submit();
  assert.equal(res.status, 200);
  assert.equal(emails.length, 2);
});

test('www.grow-shop.com is accepted too', async () => {
  siteverify = () => Response.json({ success: true, hostname: 'www.grow-shop.com' });
  assert.equal((await submit()).status, 200);
});

test('a token solved on another hostname sends nothing', async () => {
  siteverify = () => Response.json({ success: true, hostname: 'attacker.example' });
  assert.equal((await submit()).status, 400);
  assert.equal(emails.length, 0);
});

test('a response with no hostname sends nothing', async () => {
  siteverify = () => Response.json({ success: true });
  assert.equal((await submit()).status, 400);
  assert.equal(emails.length, 0);
});

test('a rejected token sends nothing', async () => {
  siteverify = () => Response.json({ success: false, 'error-codes': ['timeout-or-duplicate'] });
  assert.equal((await submit()).status, 400);
  assert.equal(emails.length, 0);
});

test('Turnstile being unreachable sends nothing and does not crash', async () => {
  siteverify = () => { throw new Error('network down'); };
  assert.equal((await submit()).status, 400);
  assert.equal(emails.length, 0);
});

test('Cloudflare is told the caller Traefik saw, not what the caller claims', async () => {
  await submit({ 'X-Forwarded-For': '198.51.100.9, 203.0.113.7' });
  assert.equal(verifyCalls[0].body.get('remoteip'), '203.0.113.7');
});

test('the check is bounded by a timeout', async () => {
  await submit();
  assert.ok(verifyCalls[0].signal instanceof AbortSignal);
});
