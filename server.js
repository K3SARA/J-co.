const express = require('express');
const fs = require('fs');
const multer = require('multer');
const nodemailer = require('nodemailer');
const path = require('path');
const { GoogleGenerativeAI } = require('@google/generative-ai');
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

function normalizeEmailAddress(value) {
  const trimmed = String(value || '').trim();
  const match = trimmed.match(/^(.+?)\s*<([^<>@\s]+@[^<>@\s]+\.[^<>@\s]+)>$/);
  if (!match) return trimmed;
  return `${match[1].trim().replace(/^["']|["']$/g, '')} <${match[2]}>`;
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
        from: normalizeEmailAddress(process.env.RESEND_FROM_EMAIL),
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

// Chatbot API Endpoint
const systemPrompt = `You are a helpful customer support AI for J&co Software Solutions.
You must adhere strictly to the following knowledge base:

1. Services: We build tailored solutions—apps and software designed around the business and customers' needs. We can build ANY kind of software products and websites for visitors.
2. Cloud Database Subscription Costs:
  - Small Business – 500 LKR Per month
  - Intermediate Business – 1500 - 2000 LKR Per month
  - Enterprise Business – 5,000 LKR Per month
3. Software License & Service Agreement Policies:
  - License: Non-transferable license for internal business operations. The software remains the intellectual property of J&co.
  - Payment Terms: 50% advance before installation, 50% upon completion/handover. Net 7 days from invoice date for monthly services. Services suspended if 5 days past due date.
  - Refund Policy: Strict NO REFUND policy. All sales, contracts, and payments for software development, integrations, and licenses are final and non-refundable. Exception only if J&co completely fails to deliver core functionality.
  - Subscriptions: Cancellations require 14 days written notice.
4. Contact Info: 
  - Email: hello@jnco.tech
  - Web: www.jnco.tech
  - Phone: +94 77 065 4279
  - Address: N0 36A Agalawatta Road, Matale

Answer concisely, professionally, and warmly. If asked a question not covered here, state that you don't have that specific information and provide the contact email/phone number.`;

app.post('/api/chat', async (req, res) => {
  try {
    const userMessage = req.body.message;
    if (!userMessage) {
      return res.status(400).json({ error: 'Message is required' });
    }

    const apiKey = process.env.GEMINI_API_KEY;
    if (!apiKey) {
      return res.status(503).json({ error: 'Chat service is temporarily unavailable.' });
    }

    // Main model first, then an optional backup model from .env
    const models = [
      process.env.GEMINI_MODEL || 'gemini-3.8-flash',
      process.env.GEMINI_FALLBACK_MODEL
    ].filter(Boolean);

    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    let lastData = null;

    for (const model of models) {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`;
    

      for (let attempt = 1; attempt <= 4; attempt++) {
        const response = await fetch(url, {
          method: 'POST',
          headers: {
            'x-goog-api-key': apiKey,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            system_instruction: { parts: [{ text: systemPrompt }] },
            contents: [{ role: 'user', parts: [{ text: userMessage }] }]
          })
        });

        lastData = await response.json();

        if (response.ok) {
          const text = lastData.candidates?.[0]?.content?.parts?.[0]?.text || "Sorry, I couldn't generate a response.";
          return res.json({ reply: text });
        }

        console.error(`Gemini error (${model}, attempt ${attempt}):`, JSON.stringify(lastData));

        // 503 = high demand: wait longer each time (2s, 4s, 6s) and try again
        if (response.status === 503 && attempt < 4) {
          await sleep(2000 * attempt);
          continue;
        }
        break; // other errors: go to the next model
      }
    }

    return res.status(503).json({
      error: 'Our assistant is very busy right now. Please try again in a minute, or contact hello@jnco.tech.'
    });
  } catch (error) {
    console.error('Chat API Error:', error);
    return res.status(500).json({ error: 'Failed to process chat message' });
  }
});

    // ==========================================
// Project Cost & Scope Estimator Endpoint
// ==========================================
app.get('/estimator', (req, res) => {
  res.sendFile(path.join(__dirname, 'estimator.html'));
});

app.post('/api/estimate', async (req, res) => {
  try {
    const {
      name,
      email,
      businessTier,
      pricingModel,
      platform,
      design,
      features,
      estimatedCost,
      estimatedDuration
    } = req.body;

    if (!name || !email) {
      return res.status(400).json({ error: 'Name and email are required.' });
    }

    const cleanName = cleanText(name, 80);
    const cleanEmail = cleanText(email, 120);
    const cleanBusinessTier = cleanText(businessTier, 80);
    const cleanPricingModel = cleanText(pricingModel, 80);
    const cleanPlatform = cleanText(platform, 120);
    const cleanDesign = cleanText(design, 120);
    const cleanEstimatedCost = cleanText(estimatedCost, 120);
    const cleanEstimatedDuration = cleanText(estimatedDuration, 80);
    const selectedFeatures = Array.isArray(features)
      ? features.map((feature) => cleanText(feature, 120)).filter(Boolean)
      : [];
    const isCorporate = String(businessTier || '').toLowerCase().includes('corporate');
    const isAmc = String(pricingModel || '').toLowerCase().includes('amc');
    const businessScale = isCorporate ? 'Corporate' : 'SME';
    const pricingLabel = isAmc ? 'Setup + Monthly AMC' : 'Milestone Build';
    const projectPrices = {
      'POS & Inventory System': { sme: 250000, corporate: 450000 },
      'Custom Web App / Portal': { sme: 280000, corporate: 600000 },
      'Mobile App (Cross-Platform)': { sme: 390000, corporate: 725000 },
      'Enterprise Backend Services': { sme: 450000, corporate: 925000 }
    };
    const designPrices = {
      'Clean & Modern': 0,
      'Custom Brand UI': 50000,
      'High-End Motion': 90000
    };
    const featurePrices = {
      'Auth & RBAC': 35000,
      'Local Payment Gateway': 55000,
      'Analytics & BI': 60000,
      'AI / LLM Workflow': 110000
    };
    const formatLkr = (amount) => `LKR ${amount.toLocaleString('en-US')}`;
    const basePrice = projectPrices[cleanPlatform]?.[isCorporate ? 'corporate' : 'sme'];
    const uiPrice = designPrices[cleanDesign];
    const addonTotal = selectedFeatures.reduce((total, feature) => total + (featurePrices[feature] || 0), 0);
    const scopeTotal = basePrice === undefined || uiPrice === undefined
      ? cleanEstimatedCost
      : formatLkr(basePrice + uiPrice + addonTotal);
    const addonsSummary = selectedFeatures.length
      ? selectedFeatures.map((feature) => {
        const price = featurePrices[feature];
        return `  - ${feature}: ${price === undefined ? 'included / custom' : formatLkr(price)}`;
      }).join('\n')
      : '  - None selected';
    const emailContent = [
      'New Project Scope Estimate from J&co.',
      '====================================',
      `Client Name: ${cleanName}`,
      `Client Email: ${cleanEmail}`,
      `Business Scale: ${cleanBusinessTier || businessScale}`,
      `Payment Model: ${cleanPricingModel || pricingLabel}`,
      '',
      'Sri Lankan LKR project scope breakdown:',
      `Project Type: ${cleanPlatform || 'Not specified'} — ${basePrice === undefined ? 'as quoted' : formatLkr(basePrice)}`,
      `UI/UX Tier: ${cleanDesign || 'Not specified'} — ${uiPrice === undefined ? 'as quoted' : formatLkr(uiPrice)}`,
      `Domestic Add-on Modules (total: ${basePrice === undefined || uiPrice === undefined ? 'see selected modules' : formatLkr(addonTotal)}):`,
      addonsSummary,
      '',
      `Estimated Total: ${cleanEstimatedCost || scopeTotal}`,
      `Timeline: ${cleanEstimatedDuration || 'Not specified'}`
    ].join('\n');

    const smtpUser = process.env.SMTP_USER;
    const smtpPass = process.env.SMTP_PASS;
    const hasSmtpCredentials = Boolean(
      smtpUser &&
      smtpPass &&
      smtpUser !== 'your-smtp-username' &&
      smtpPass !== 'your-smtp-password'
    );
    const recipient = process.env.CAREERS_TO_EMAIL || 'hello@jnco.tech';

    if (hasSmtpCredentials) {
      const transporter = nodemailer.createTransport({
        host: process.env.SMTP_HOST || 'smtp.gmail.com',
        port: Number(process.env.SMTP_PORT) || 587,
        secure: process.env.SMTP_SECURE === 'true',
        auth: {
          user: smtpUser,
          pass: smtpPass
        }
      });
      const sentEmail = await transporter.sendMail({
        from: process.env.SMTP_FROM || smtpUser,
        to: recipient,
        replyTo: cleanEmail,
        subject: `New Project Lead: ${cleanName} (${cleanEmail}) - ${cleanEstimatedCost}`,
        text: emailContent
      });

      console.log('Estimate email sent via SMTP:', sentEmail.messageId);
    } else if (process.env.RESEND_API_KEY && process.env.RESEND_API_KEY !== 're_xxxxxxxxx') {
      const emailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json'
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || 'J&co. Leads <onboarding@resend.dev>',
          to: [recipient],
          reply_to: cleanEmail,
          subject: `New Project Lead: ${cleanName} (${cleanEmail}) - ${cleanEstimatedCost}`,
          text: emailContent
        })
      });

      const emailResult = await emailRes.json();
      if (!emailRes.ok) {
        throw new Error(`Resend API error: ${JSON.stringify(emailResult.error || emailResult)}`);
      }

      console.log('Estimate email sent via Resend:', emailResult.id);
    } else {
      console.log('Project Estimate Generated:\n', emailContent);
    }

    return res.status(200).json({ success: true });
  } catch (error) {
    console.error('Estimate Submission Error:', error);
    return res.status(500).json({ error: 'Failed to submit estimate.' });
  }
});


app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`J&co web running on http://localhost:${PORT}`);
  // eslint-disable-next-line no-console
  console.log(`Reviews DB path: ${DB_FILE}`);
});
