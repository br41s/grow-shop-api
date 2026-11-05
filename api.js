const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
// Traefik is the one proxy in front and sets X-Forwarded-For to the caller, so
// req.ip is the visitor. If Cloudflare ever proxies this host, req.ip becomes
// one of its edges, and remoteip and the rate limit below must change.
app.set('trust proxy', 1);
// Only the landing's pages may read responses. This binds browsers, not curl:
// what stops scripted use is Turnstile and the rate limit.
app.use(cors({ origin: ['https://grow-shop.com', 'https://www.grow-shop.com'] }));
app.use(express.json());

const RESEND_API_KEY = process.env.RESEND_API_KEY || process.env.ZEABUR_EMAIL_API_KEY;
if (!RESEND_API_KEY) {
  console.error('Missing Resend API key. Set RESEND_API_KEY or ZEABUR_EMAIL_API_KEY.');
  process.exit(1);
}
const resend = new Resend(RESEND_API_KEY);
const TO_EMAIL = process.env.TO_EMAIL || 'braisn@gmail.com';

const TURNSTILE_SECRET_KEY = process.env.TURNSTILE_SECRET_KEY;
if (!TURNSTILE_SECRET_KEY) {
  console.error('Missing Turnstile secret key. Set TURNSTILE_SECRET_KEY.');
  process.exit(1);
}

const TURNSTILE_HOSTNAMES = new Set(['grow-shop.com', 'www.grow-shop.com']);

async function verifyTurnstile(token, remoteip) {
  const params = new URLSearchParams();
  params.append('secret', TURNSTILE_SECRET_KEY);
  params.append('response', token || '');
  if (remoteip) params.append('remoteip', remoteip);

  const verifyRes = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
    method: 'POST',
    body: params,
    signal: AbortSignal.timeout(5000)
  });
  const data = await verifyRes.json();
  // Logged because the visitor only sees "try again": without this, a wrong
  // hostname list would lose real offers with no trace.
  if (data.success !== true) {
    console.warn('Turnstile rejected the token:', data['error-codes']);
    return false;
  }
  if (!TURNSTILE_HOSTNAMES.has(data.hostname)) {
    console.warn('Turnstile token from an unexpected hostname:', data.hostname);
    return false;
  }
  return true;
}

const HTML_ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

function escapeHtml(text) {
  return text.replace(/[&<>"']/g, (char) => HTML_ENTITIES[char]);
}

const MAX_LENGTHS = { name: 100, email: 254, offer: 100, message: 5000 };
// No commas, angle brackets or spaces, so it is always one recipient. No ? or &
// either, because it also goes into the owner's mailto: link.
const EMAIL_FORMAT = /^[\p{L}\p{N}._+'-]+@[\p{L}\p{N}-]+(?:\.[\p{L}\p{N}-]+)+$/u;
// name reaches a subject line, where a line break would start a new header.
// Single-line form inputs cannot produce these.
const CONTROL_CHARS = /[\p{Cc}\u2028\u2029]/u;

// The first field that is not acceptable, or null.
function invalidField(fields) {
  for (const [field, max] of Object.entries(MAX_LENGTHS)) {
    if (typeof fields[field] !== 'string' || fields[field].length > max) return field;
  }
  if (!fields.name.trim() || CONTROL_CHARS.test(fields.name)) return 'name';
  if (!EMAIL_FORMAT.test(fields.email)) return 'email';
  if (CONTROL_CHARS.test(fields.offer)) return 'offer';
  return null;
}

// Fixed window per visitor, in memory: there is one container, and a restart
// only resets the counts.
const RATE_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const RATE_LIMIT_MAX = 5;
const rateLimitBuckets = new Map(); // ip -> { count, resetAt }

function rateLimit(req, res, next) {
  const now = Date.now();
  let bucket = rateLimitBuckets.get(req.ip);
  if (!bucket || now >= bucket.resetAt) {
    bucket = { count: 0, resetAt: now + RATE_LIMIT_WINDOW_MS };
    rateLimitBuckets.set(req.ip, bucket);
  }
  bucket.count += 1;

  if (bucket.count > RATE_LIMIT_MAX) {
    console.warn('Offer form rate limit hit:', req.ip);
    res.set('Retry-After', String(Math.ceil((bucket.resetAt - now) / 1000)));
    return res.status(429).json({ error: 'Too many requests. Please try again later.' });
  }

  // Keeps the map from growing without bound across many IPs.
  if (rateLimitBuckets.size > 5000) {
    for (const [ip, { resetAt }] of rateLimitBuckets) {
      if (now >= resetAt) rateLimitBuckets.delete(ip);
    }
  }
  next();
}

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/submit-offer', rateLimit, async (req, res) => {
  const { name, email, offer = '', message = '', turnstileToken } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
  }

  // Logged because the landing shows a generic error, so a limit set too low
  // would otherwise lose real offers with no trace.
  const badField = invalidField({ name, email, offer, message });
  if (badField) {
    console.warn('Offer rejected, invalid field:', badField);
    return res.status(400).json({ error: `Invalid ${badField}` });
  }

  const humanVerified = await verifyTurnstile(turnstileToken, req.ip).catch((err) => {
    console.error('Turnstile check failed:', err.message);
    return false;
  });
  if (!humanVerified) {
    return res.status(400).json({ error: 'Verification failed. Please try again.' });
  }

  const htmlToOwner = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1f1c">
      <h2 style="color:#1a6b3c">Nueva oferta — grow-shop.com</h2>
      <table style="border-collapse:collapse;width:100%;font-size:15px">
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7;width:100px">Nombre</td>
            <td style="padding:10px 12px;border:1px solid #ddd">${escapeHtml(name)}</td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7">Email</td>
            <td style="padding:10px 12px;border:1px solid #ddd"><a href="mailto:${escapeHtml(email)}">${escapeHtml(email)}</a></td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7">Oferta</td>
            <td style="padding:10px 12px;border:1px solid #ddd;font-size:18px;font-weight:700;color:#1a6b3c">${escapeHtml(offer) || 'No especificada'}</td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7">Mensaje</td>
            <td style="padding:10px 12px;border:1px solid #ddd">${escapeHtml(message) || '—'}</td></tr>
      </table>
      <p style="margin-top:1.5rem;font-size:12px;color:#9aab9f">Enviado desde el formulario de grow-shop.com</p>
    </div>`;

  // Goes to an address nobody has confirmed, so it repeats nothing the sender
  // typed. Escaping stops HTML but not plain text like "Claim your refund at
  // evil.example", which mail clients turn into a link.
  const htmlToUser = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1f1c">
      <h2 style="color:#1a6b3c">Hemos recibido tu oferta</h2>
      <p>Hola, gracias por tu interés en grow-shop.com.</p>
      <p>Hemos recibido tu oferta y te responderemos lo antes posible.</p>
      <p style="margin-top:2rem;font-size:13px;color:#9aab9f">— El equipo de grow-shop.com</p>
    </div>`;

  try {
    // Email al dueño
    await resend.emails.send({
      from: 'contacto@grow-shop.com',
      to: [TO_EMAIL],
      subject: `Nueva oferta de ${name} — grow-shop.com`,
      html: htmlToOwner
    });

    // Confirmación al usuario
    await resend.emails.send({
      from: 'contacto@grow-shop.com',
      to: [email],
      subject: 'Hemos recibido tu oferta — grow-shop.com',
      html: htmlToUser
    });

    res.json({ success: true });
  } catch (err) {
    console.error('Resend error:', err);
    res.status(500).json({ error: err.message });
  }
});

if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`API running on port ${PORT}`));
}

module.exports = { app };
