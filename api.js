const express = require('express');
const cors = require('cors');
const { Resend } = require('resend');

const app = express();
app.use(cors());
app.use(express.json());

const resend = new Resend(process.env.RESEND_API_KEY);

app.post('/api/contact', async (req, res) => {
  const { name, email, message } = req.body;
  try {
    // Email a vosotros
    await resend.emails.send({
      from: 'contacto@grow-shop.com',
      to: 'vuestro@email.com',
      subject: `Nuevo mensaje de ${name}`,
      html: `<p><b>Nombre:</b> ${name}</p>
             <p><b>Email:</b> ${email}</p>
             <p><b>Mensaje:</b> ${message}</p>`
    });
    // Confirmación al usuario
    await resend.emails.send({
      from: 'contacto@grow-shop.com',
      to: email,
      subject: 'Hemos recibido tu mensaje - Grow Shop',
      html: `<p>Hola ${name}, gracias por contactarnos. Te responderemos pronto.</p>`
    });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.listen(process.env.PORT || 3000);