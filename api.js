const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
// Traefik is the one proxy in front and sets X-Forwarded-For to the caller, so
// req.ip is the visitor. If Cloudflare ever proxies this host, req.ip becomes
// one of its edges and remoteip below must change.
app.set('trust proxy', 1);
app.use(cors());
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

app.get('/health', (req, res) => res.json({ ok: true }));

app.post('/api/submit-offer', async (req, res) => {
  const { name, email, offer, message, turnstileToken } = req.body;

  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email are required' });
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
            <td style="padding:10px 12px;border:1px solid #ddd">${name}</td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7">Email</td>
            <td style="padding:10px 12px;border:1px solid #ddd"><a href="mailto:${email}">${email}</a></td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7">Oferta</td>
            <td style="padding:10px 12px;border:1px solid #ddd;font-size:18px;font-weight:700;color:#1a6b3c">${offer || 'No especificada'}</td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7">Mensaje</td>
            <td style="padding:10px 12px;border:1px solid #ddd">${message || '—'}</td></tr>
      </table>
      <p style="margin-top:1.5rem;font-size:12px;color:#9aab9f">Enviado desde el formulario de grow-shop.com</p>
    </div>`;

  const htmlToUser = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1f1c">
      <h2 style="color:#1a6b3c">Hemos recibido tu oferta</h2>
      <p>Hola ${name}, gracias por tu interés en grow-shop.com.</p>
      <p>Hemos recibido tu oferta de <strong>${offer || 'precio a negociar'}</strong> y te responderemos lo antes posible.</p>
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
