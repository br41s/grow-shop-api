const express = require('express');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors());

const ZEABUR_API_KEY = process.env.ZEABUR_EMAIL_API_KEY;
const TO_EMAIL = process.env.TO_EMAIL;

// Health check
app.get('/health', (req, res) => res.json({ ok: true }));

// Submit offer endpoint
app.post('/api/submit-offer', async (req, res) => {
  const { name, email, offer, message } = req.body;

  // Validación básica
  if (!name || !email) {
    return res.status(400).json({ error: 'Name and email required' });
  }

  const htmlBody = `
    <div style="font-family:sans-serif;max-width:520px;margin:0 auto;color:#1a1f1c">
      <h2 style="color:#1a6b3c;margin-bottom:1rem">New offer for grow-shop.com</h2>
      <table style="border-collapse:collapse;width:100%;font-size:15px">
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7;width:110px">Name</td>
            <td style="padding:10px 12px;border:1px solid #ddd">${name}</td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7">Email</td>
            <td style="padding:10px 12px;border:1px solid #ddd"><a href="mailto:${email}">${email}</a></td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7">Offer</td>
            <td style="padding:10px 12px;border:1px solid #ddd;font-size:17px;font-weight:600;color:#1a6b3c">${offer || 'Not specified'}</td></tr>
        <tr><td style="padding:10px 12px;border:1px solid #ddd;font-weight:600;background:#f5faf7">Message</td>
            <td style="padding:10px 12px;border:1px solid #ddd">${message || '—'}</td></tr>
      </table>
      <p style="margin-top:1.5rem;font-size:13px;color:#9aab9f">Sent via grow-shop.com contact form</p>
    </div>`;

  try {
    const zeaburRes = await fetch('https://api.zeabur.com/api/v1/zsend/emails', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': 'Bearer ' + ZEABUR_API_KEY
      },
      body: JSON.stringify({
        from: 'sales@grow-shop.com',
        to: [TO_EMAIL],
        subject: `New offer from ${name} — grow-shop.com (${offer || 'amount not specified'})`,
        html: htmlBody
      })
    });

    if (!zeaburRes.ok) {
      const errData = await zeaburRes.text();
      console.error('Zeabur error:', zeaburRes.status, errData);
      return res.status(500).json({ error: 'Failed to send email' });
    }

    res.json({ success: true, message: 'Offer received' });
  } catch (err) {
    console.error('API error:', err);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 API running on port ${PORT}`));