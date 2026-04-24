const express = require('express');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.resolve(process.env.REVIEWS_DB_FILE || path.join(__dirname, 'reviews.db.json'));
const MAX_REVIEWS = 200;
const ADMIN_DELETE_KEY = process.env.ADMIN_DELETE_KEY || 'change-this-admin-delete-key';
const CAREERS_TO_EMAIL = process.env.CAREERS_TO_EMAIL || 'hello@jnco.tech';
const MAX_CV_BYTES = 5 * 1024 * 1024;

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_CV_BYTES, files: 1 },
  fileFilter: (_req, file, cb) => {
    const allowedTypes = new Set([
      'application/pdf',
      'application/msword',
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
    ]);
    if (!allowedTypes.has(file.mimetype)) {
      return cb(new Error('Only PDF, DOC, or DOCX files are accepted.'));
    }
    return cb(null, true);
  }
});

app.use(express.json({ limit: '200kb' }));
app.use(express.static(__dirname));

function ensureDbFile() {
  const dir = path.dirname(DB_FILE);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  if (!fs.existsSync(DB_FILE)) {
    fs.writeFileSync(DB_FILE, JSON.stringify({ reviews: [] }, null, 2), 'utf8');
  }
}

function readDb() {
  ensureDbFile();
  const content = fs.readFileSync(DB_FILE, 'utf8');
  const data = JSON.parse(content || '{"reviews":[]}');
  if (!Array.isArray(data.reviews)) return { reviews: [] };
  // Ensure each review has a stable id for admin delete operations.
  data.reviews = data.reviews.map((r) => ({
    ...r,
    id: r.id || `${r.createdAt || Date.now()}-${Math.random().toString(36).slice(2, 8)}`
  }));
  return data;
}

function writeDb(db) {
  const tmp = `${DB_FILE}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(db, null, 2), 'utf8');
  fs.renameSync(tmp, DB_FILE);
}

function cleanText(value, maxLen) {
  return String(value || '').trim().replace(/\s+/g, ' ').slice(0, maxLen);
}

function escapeHtml(value) {
  return String(value || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function hasSmtpConfig() {
  const host = process.env.SMTP_HOST || '';
  const user = process.env.SMTP_USER || '';
  const pass = process.env.SMTP_PASS || '';
  return Boolean(
    host &&
    user &&
    pass &&
    host !== 'smtp.example.com' &&
    user !== 'your-smtp-username' &&
    pass !== 'your-smtp-password'
  );
}

function hasResendConfig() {
  return Boolean(process.env.RESEND_API_KEY && process.env.RESEND_FROM_EMAIL);
}

function createMailTransport() {
  return nodemailer.createTransport({
    host: process.env.SMTP_HOST,
    port: Number(process.env.SMTP_PORT || 587),
    secure: String(process.env.SMTP_SECURE || '').toLowerCase() === 'true',
    connectionTimeout: Number(process.env.SMTP_CONNECTION_TIMEOUT || 10000),
    greetingTimeout: Number(process.env.SMTP_GREETING_TIMEOUT || 10000),
    socketTimeout: Number(process.env.SMTP_SOCKET_TIMEOUT || 15000),
    auth: {
      user: process.env.SMTP_USER,
      pass: process.env.SMTP_PASS
    }
  });
}

async function sendCareerApplicationEmail({ name, email, phone, role, experience, portfolio, message, submittedAt, html, file }) {
  const subject = `Career application: ${role} - ${name}`;
  const text = [
    'New career application',
    `Role: ${role}`,
    `Name: ${name}`,
    `Email: ${email}`,
    `Phone: ${phone}`,
    `Experience: ${experience}`,
    `Portfolio: ${portfolio || 'Not provided'}`,
    `Submitted: ${submittedAt}`,
    '',
    message
  ].join('\n');

  if (hasResendConfig()) {
    const response = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: process.env.RESEND_FROM_EMAIL,
        to: [CAREERS_TO_EMAIL],
        reply_to: email,
        subject,
        text,
        html,
        attachments: [
          {
            filename: file.originalname,
            content: file.buffer.toString('base64')
          }
        ]
      })
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new Error(`Email API failed: ${detail || response.statusText}`);
    }
    return;
  }

  if (!hasSmtpConfig()) {
    throw new Error('Career application email needs real SMTP settings or Resend settings.');
  }

  const transport = createMailTransport();
  await transport.sendMail({
    from: process.env.SMTP_FROM || process.env.SMTP_USER,
    to: CAREERS_TO_EMAIL,
    replyTo: email,
    subject,
    text,
    html,
    attachments: [
      {
        filename: file.originalname,
        content: file.buffer,
        contentType: file.mimetype
      }
    ]
  });
}

function requireAdmin(req, res, next) {
  const adminKey = req.get('x-admin-key');
  if (!adminKey || adminKey !== ADMIN_DELETE_KEY) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  return next();
}

app.get('/api/reviews', (_req, res) => {
  try {
    const db = readDb();
    const reviews = db.reviews
      .slice()
      .sort((a, b) => Number(b.createdAt) - Number(a.createdAt))
      .slice(0, MAX_REVIEWS);
    res.json(reviews);
  } catch (error) {
    res.status(500).json({ error: 'Failed to load reviews' });
  }
});

app.post('/api/reviews', (req, res) => {
  try {
    const name = cleanText(req.body?.name, 60);
    const text = cleanText(req.body?.text, 500);
    const rating = Number(req.body?.rating);

    if (!name || !text || !Number.isInteger(rating) || rating < 1 || rating > 5) {
      return res.status(400).json({ error: 'Invalid review payload' });
    }

    const db = readDb();
    const review = {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      name,
      text,
      rating,
      createdAt: Date.now()
    };

    db.reviews.unshift(review);
    db.reviews = db.reviews.slice(0, MAX_REVIEWS);
    writeDb(db);

    return res.status(201).json(review);
  } catch (error) {
    return res.status(500).json({ error: 'Failed to save review' });
  }
});

app.delete('/api/reviews/:id', requireAdmin, (req, res) => {
  try {
    const id = String(req.params.id || '');
    if (!id) return res.status(400).json({ error: 'Invalid review id' });

    const db = readDb();
    const beforeCount = db.reviews.length;
    db.reviews = db.reviews.filter((review) => review.id !== id);
    if (db.reviews.length === beforeCount) {
      return res.status(404).json({ error: 'Review not found' });
    }

    writeDb(db);
    return res.json({ ok: true });
  } catch (error) {
    return res.status(500).json({ error: 'Failed to delete review' });
  }
});

app.post('/api/reviews/admin-check', requireAdmin, (_req, res) => {
  return res.json({ ok: true });
});

function handleCareerUpload(req, res, next) {
  upload.single('cv')(req, res, (error) => {
    if (!error) return next();
    if (error instanceof multer.MulterError) {
      return res.status(400).json({ error: 'CV file is too large. Maximum size is 5MB.' });
    }
    return res.status(400).json({ error: error.message || 'Invalid CV upload.' });
  });
}

app.post('/api/careers/apply', handleCareerUpload, async (req, res) => {
  try {
    const name = cleanText(req.body?.name, 80);
    const email = cleanText(req.body?.email, 120);
    const phone = cleanText(req.body?.phone, 40);
    const role = cleanText(req.body?.role, 80);
    const experience = cleanText(req.body?.experience, 80);
    const portfolio = cleanText(req.body?.portfolio, 200);
    const message = cleanText(req.body?.message, 1200);

    if (!name || !email || !phone || !role || !experience || !message || !req.file) {
      return res.status(400).json({ error: 'Please complete all required fields and upload your CV.' });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Please enter a valid email address.' });
    }

    if (!hasSmtpConfig() && !hasResendConfig()) {
      return res.status(503).json({ error: 'Career application email needs real SMTP settings or Resend settings.' });
    }

    const submittedAt = new Date().toLocaleString('en-US', { timeZone: 'Asia/Colombo' });
    const html = `
      <h2>New career application</h2>
      <p><strong>Role:</strong> ${escapeHtml(role)}</p>
      <p><strong>Name:</strong> ${escapeHtml(name)}</p>
      <p><strong>Email:</strong> ${escapeHtml(email)}</p>
      <p><strong>Phone:</strong> ${escapeHtml(phone)}</p>
      <p><strong>Experience:</strong> ${escapeHtml(experience)}</p>
      <p><strong>Portfolio:</strong> ${portfolio ? `<a href="${escapeHtml(portfolio)}">${escapeHtml(portfolio)}</a>` : 'Not provided'}</p>
      <p><strong>Submitted:</strong> ${escapeHtml(submittedAt)}</p>
      <h3>Message</h3>
      <p>${escapeHtml(message)}</p>
    `;

    await sendCareerApplicationEmail({
      name,
      email,
      phone,
      role,
      experience,
      portfolio,
      message,
      submittedAt,
      html,
      file: req.file
    });

    return res.status(201).json({ ok: true });
  } catch (error) {
    if (['ETIMEDOUT', 'ESOCKET', 'ECONNECTION'].includes(error.code)) {
      return res.status(504).json({ error: 'Email server connection timed out. SMTP may be blocked on the deployed server.' });
    }
    return res.status(500).json({ error: error.message || 'Failed to submit application.' });
  }
});

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`J&co web running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Reviews DB path: ${DB_FILE}`);
});
