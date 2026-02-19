const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_FILE = path.join(__dirname, 'reviews.db.json');
const MAX_REVIEWS = 200;
const ADMIN_DELETE_KEY = process.env.ADMIN_DELETE_KEY || 'change-this-admin-delete-key';

app.use(express.json({ limit: '200kb' }));
app.use(express.static(__dirname));

function ensureDbFile() {
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

app.listen(PORT, () => {
  // eslint-disable-next-line no-console
  console.log(`J&co web running on http://localhost:${PORT}`);
});
