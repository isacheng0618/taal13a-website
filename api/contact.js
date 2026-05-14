export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { name, email, topic, message } = req.body || {};

    if (!name || !email || !message) {
      return res.status(400).json({ error: 'Missing required fields' });
    }

    const apiKey = process.env.RESEND_API_KEY;

    if (!apiKey) {
      return res.status(500).json({ error: 'Missing RESEND_API_KEY' });
    }

    const subject = `Taal13A contactformulier: ${topic || 'Nieuwe vraag'}`;

    const ownerEmailHtml = `
      <h2>Nieuwe contactaanvraag via Taal13A</h2>
      <p><strong>Naam:</strong> ${name}</p>
      <p><strong>Email:</strong> ${email}</p>
      <p><strong>Onderwerp:</strong> ${topic || '-'}</p>
      <p><strong>Bericht:</strong></p>
      <p>${String(message).replace(/\n/g, '<br>')}</p>
    `;

    const autoReplyHtml = `
      <p>Beste ${name},</p>
      <p>Bedankt voor je bericht aan Taal13A. We hebben je bericht goed ontvangen en reageren zo snel mogelijk.</p>
      <p><strong>Je bericht:</strong></p>
      <p>${String(message).replace(/\n/g, '<br>')}</p>
      <p>Met vriendelijke groet,<br>Taal13A</p>
    `;

    async function sendEmail(payload) {
      const response = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify(payload)
      });

      const data = await response.json();

      if (!response.ok) {
        console.error('Resend error:', data);
        throw new Error(data.message || 'Email sending failed');
      }

      return data;
    }

    await sendEmail({
      from: 'Taal13A <onboarding@resend.dev>',
      to: ['taal13a@gmail.com'],
      reply_to: email,
      subject,
      html: ownerEmailHtml
    });

    await sendEmail({
      from: 'Taal13A <onboarding@resend.dev>',
      to: [email],
      subject: 'We hebben je bericht ontvangen | Taal13A',
      html: autoReplyHtml
    });

    return res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Contact API error:', error);
    return res.status(500).json({ error: 'Could not send message' });
  }
}
