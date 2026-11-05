// POST /api/submit-offer through real Express. Only outbound calls are faked:
// Turnstile's siteverify and Resend, both of which go through global fetch.
process.env.RESEND_API_KEY = 're_test';
process.env.TURNSTILE_SECRET_KEY = 'test-secret';

const { test, before, after, beforeEach } = require('node:test');
const assert = require('node:assert/strict');
const { app } = require('./api.js');

const realFetch = global.fetch;
let server, base, siteverify, verifyCalls, emails, visitorIp;
let visitors = 0;

before(async () => {
  global.fetch = async (url, init) => {
    const target = String(url);
    if (target.includes('challenges.cloudflare.com')) {
      verifyCalls.push(init);
      return siteverify();
    }
    if (target.includes('api.resend.com')) {
      emails.push(JSON.parse(init.body));
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
  // Each test is its own visitor, so tests do not share a rate limit bucket.
  visitorIp = `192.0.2.${++visitors}`;
});

function submit(headers = {}, fields = {}) {
  return fetch(`${base}/api/submit-offer`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Forwarded-For': visitorIp, ...headers },
    body: JSON.stringify({ name: 'Ana', email: 'ana@example.com', turnstileToken: 'token', ...fields })
  });
}

function preflight(origin) {
  return fetch(`${base}/api/submit-offer`, {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'content-type'
    }
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

const PAYLOAD = '<a href="https://evil.example/login">Verify your account</a><script>alert(1)</script>';

test('injected HTML reaches the owner escaped, in every field', async () => {
  const res = await submit({}, {
    name: PAYLOAD,
    email: "o'brien@example.com",
    offer: '"><img src=x onerror=alert(1)>',
    message: PAYLOAD
  });
  assert.equal(res.status, 200);
  const { html } = emails[0];
  assert.ok(!html.includes('<script'));
  assert.ok(!html.includes('<a href="https://evil.example'));
  assert.ok(!html.includes('<img'));
  assert.ok(html.includes('&lt;a href=&quot;https://evil.example/login&quot;&gt;'));
  assert.ok(html.includes('o&#39;brien@example.com'));
});

test('the auto-reply repeats nothing the sender typed', async () => {
  await submit({}, {
    name: 'NAME-MARKER claim your refund at evil.example',
    offer: 'OFFER-MARKER',
    message: 'MESSAGE-MARKER'
  });
  const reply = JSON.stringify(emails[1]);
  assert.deepEqual(emails[1].to, ['ana@example.com']);
  assert.ok(!/MARKER|evil\.example/.test(reply));
});

test('a form submission still reaches the owner intact', async () => {
  await submit({}, { name: 'Ana Núñez', offer: '$9,900', message: 'Line one\nLine two' });
  assert.equal(emails[0].subject, 'Nueva oferta de Ana Núñez — grow-shop.com');
  assert.ok(emails[0].html.includes('Ana Núñez'));
  assert.ok(emails[0].html.includes('$9,900'));
  assert.ok(emails[0].html.includes('Line one\nLine two'));
});

test('email addresses real people use are accepted', async () => {
  for (const email of ['ana.b+offers@example.com', "o'brien@sub.example.co.uk", 'josé@españa.es']) {
    visitorIp = `198.51.100.${++visitors}`;
    assert.equal((await submit({}, { email })).status, 200, email);
  }
});

for (const [why, email] of [
  ['several recipients', 'a@example.com,b@example.com'],
  ['a display name', 'Support <a@example.com>'],
  ['a mailto query', 'a?bcc=b@example.com'],
  ['a line break', 'a@example.com\r\nBcc: b@example.com'],
  ['no domain dot', 'a@example'],
  ['an array', ['a@example.com', 'b@example.com']],
  ['an object', { address: 'a@example.com' }],
  ['excess length', `${'a'.repeat(250)}@example.com`]
]) {
  test(`an email with ${why} sends nothing and never reaches Turnstile`, async () => {
    assert.equal((await submit({}, { email })).status, 400);
    assert.equal(emails.length, 0);
    assert.equal(verifyCalls.length, 0);
  });
}

for (const [why, fields] of [
  ['a line break in name', { name: 'Ana\r\nBcc: evil@example.com' }],
  ['a blank name', { name: '   ' }],
  ['a long name', { name: 'a'.repeat(101) }],
  ['a non-string name', { name: ['Ana'] }],
  ['a long offer', { offer: '1'.repeat(101) }],
  ['a line break in offer', { offer: '100\nmore' }],
  ['a non-string offer', { offer: 9900 }],
  ['a long message', { message: 'a'.repeat(5001) }]
]) {
  test(`${why} sends nothing`, async () => {
    assert.equal((await submit({}, fields)).status, 400);
    assert.equal(emails.length, 0);
  });
}

test('the sixth attempt in a window gets 429 and sends nothing', async () => {
  for (let i = 0; i < 5; i++) assert.equal((await submit()).status, 200);
  const sent = emails.length;
  const res = await submit();
  assert.equal(res.status, 429);
  assert.ok(Number(res.headers.get('retry-after')) > 0);
  assert.equal(emails.length, sent);
  assert.equal(verifyCalls.length, 5);
});

test('invalid submissions count towards the limit', async () => {
  for (let i = 0; i < 5; i++) await submit({}, { email: 'nope' });
  assert.equal((await submit()).status, 429);
});

test('a forged X-Forwarded-For does not get a fresh bucket', async () => {
  for (let i = 0; i < 5; i++) {
    await submit({ 'X-Forwarded-For': `198.51.100.${i}, ${visitorIp}` });
  }
  const res = await submit({ 'X-Forwarded-For': `198.51.100.99, ${visitorIp}` });
  assert.equal(res.status, 429);
});

test('another visitor is not affected by someone else hitting the limit', async () => {
  for (let i = 0; i < 6; i++) await submit();
  visitorIp = `198.51.100.${++visitors}`;
  assert.equal((await submit()).status, 200);
});

test('the limit resets when the window ends', async () => {
  for (let i = 0; i < 6; i++) await submit();
  const realNow = Date.now;
  Date.now = () => realNow() + 15 * 60 * 1000 + 1;
  try {
    assert.equal((await submit()).status, 200);
  } finally {
    Date.now = realNow;
  }
});

test('the landing origins may read responses, including a 429', async () => {
  for (const origin of ['https://grow-shop.com', 'https://www.grow-shop.com']) {
    const res = await preflight(origin);
    assert.equal(res.status, 204);
    assert.equal(res.headers.get('access-control-allow-origin'), origin);
    assert.match(res.headers.get('access-control-allow-headers'), /content-type/i);
  }
  for (let i = 0; i < 5; i++) await submit();
  const limited = await submit({ Origin: 'https://grow-shop.com' });
  assert.equal(limited.status, 429);
  assert.equal(limited.headers.get('access-control-allow-origin'), 'https://grow-shop.com');
});

test('other origins get no CORS permission', async () => {
  for (const origin of ['https://evil.example', 'https://grow-shop.com.evil.example', 'http://grow-shop.com']) {
    const res = await preflight(origin);
    assert.equal(res.headers.get('access-control-allow-origin'), null);
  }
  const res = await submit({ Origin: 'https://evil.example' });
  assert.equal(res.headers.get('access-control-allow-origin'), null);
});
