/* ============================================================
   USAMBARA MALE HOSTELS — LIVE SECURE SERVER
   Overseer (admin) manages all records. Students log in with
   reg no + PIN and can ONLY view their own record and submit
   reports. No one else can alter the system.
   ============================================================ */
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = process.env.PORT || 3000;
const DATA_FILE = process.env.DATA_FILE || path.join(__dirname, 'data.json');
const DEFAULT_OVERSEER_PASSWORD = process.env.OVERSEER_PASSWORD || 'unguku123';
const MONGODB_URI = process.env.MONGODB_URI || '';   // if set, data is stored in MongoDB Atlas (permanent)

/* ---------------- WhatsApp notifications (Meta Cloud API) ----------------
   Optional. To enable automatic WhatsApp alerts to your phone when a student
   submits a report, set these environment variables on your host:
     WHATSAPP_PHONE_ID  = your WhatsApp Business phone-number ID
     WHATSAPP_TOKEN     = a Meta Graph access token for that number
     WHATSAPP_TO        = the number to notify (intl format), default 254769679217
   Without them the app works fine and just skips notifications.
---------------------------------------------------------------------------- */
const WA_PHONE_ID = process.env.WHATSAPP_PHONE_ID || '';
const WA_TOKEN    = process.env.WHATSAPP_TOKEN    || '';
const WA_TO       = process.env.WHATSAPP_TO       || '254769679217';
async function sendWhatsAppNotification(rep){
  if(!WA_PHONE_ID || !WA_TOKEN){
    console.log('WhatsApp notify skipped (WHATSAPP_PHONE_ID / WHATSAPP_TOKEN not set).');
    return;
  }
  const body = {
    messaging_product: 'whatsapp',
    to: WA_TO,
    type: 'text',
    text: {
      body: '🛎️ NEW REPORT — Usambara Male Hostels\n'
          + 'From: ' + rep.name + ' (' + rep.reg + ')\n'
          + 'Block ' + rep.block + ' · Room ' + rep.room
          + (rep.phone ? ' · WhatsApp ' + rep.phone : '') + '\n'
          + 'Urgency: ' + rep.urg + '\n'
          + 'Issue: ' + rep.msg + '\n\n'
          + 'Open the app to reply to this student.'
    }
  };
  try {
    const r = await fetch('https://graph.facebook.com/v18.0/' + WA_PHONE_ID + '/messages', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + WA_TOKEN, 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    console.log('WhatsApp notify:', r.status, r.status === 200 ? 'sent to ' + WA_TO : JSON.stringify(data).slice(0, 200));
  } catch(e){
    console.log('WhatsApp notify error:', e.message);
  }
}

/* ---------------- Password hashing (Node built-in scrypt) ---------------- */
function hashPassword(pw, salt) {
  salt = salt || crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return { salt, hash };
}
function verifyPassword(pw, salt, hash) {
  try {
    const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}

/* ---------------- Data store (pluggable) ----------------
   - If MONGODB_URI is set  -> uses MongoDB Atlas (permanent cloud DB, survives restarts).
   - Otherwise              -> uses a local JSON file (fine locally / for quick tests).
   The rest of the code just calls store.save(db) / store.load().
---------------------------------------------------------------------------- */
async function makeStore() {
  if (MONGODB_URI) {
    const { MongoClient } = require('mongodb');
    const client = new MongoClient(MONGODB_URI, { serverSelectionTimeoutMS: 15000 });
    await client.connect();
    const collection = client.db().collection('hostel'); // single document store
    return {
      async load() {
        const doc = await collection.findOne({ _id: 'main' });
        if (!doc) return null;
        delete doc._id;
        return doc;
      },
      async save(data) {
        await collection.replaceOne({ _id: 'main' }, { _id: 'main', ...data }, { upsert: true });
      }
    };
  }
  return {
    async load() {
      if (fs.existsSync(DATA_FILE)) {
        const d = JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
        return { overseer: d.overseer, students: d.students || [], reports: d.reports || [], reviews: d.reviews || [] };
      }
      return null;
    },
    async save(data) {
      const tmp = DATA_FILE + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
      fs.renameSync(tmp, DATA_FILE);
    }
  };
}

let db;
let store;

function seed() {
  // Sample students so the system is usable immediately.
  // PIN for all sample students = 1234  (delete these and add real students).
  const samples = [
    ['Baraka Mwangi', 'SU/2023/0456', '2', '2A', 'Double', '0700 123 456', 'John Mwangi', '0711 234 567'],
    ['Kevin Otieno', 'SU/2023/0231', '2', '2B', 'Quad', '0712 345 678', 'Grace Otieno', '0722 345 678'],
    ['Abdul Rashid', 'SU/2024/0112', '3', '3A', 'Single', '0733 456 789', 'Fatma Rashid', '0744 567 890'],
    ['Emmanuel Kimani', 'SU/2024/0055', '5', '5A', 'Hexagon', '0702 345 678', 'Alice Kimani', '0703 456 789'],
  ];
  samples.forEach(s => {
    const pin = hashPassword('1234');
    db.students.push({ id: uid(), name: s[0], reg: s[1], block: s[2], room: s[3], roomType: s[4],
      phone: s[5], guardian: s[6], guardianPhone: s[7], pin: pin, added: new Date().toISOString() });
  });
  // Sample reviews so the section is usable immediately
  db.reviews = [
    { id: uid(), name: 'Baraka Mwangi', rating: 5, comment: 'Clean rooms and a very supportive overseer. Highly recommended!', date: new Date().toISOString() },
    { id: uid(), name: 'Kevin Otieno', rating: 4, comment: 'Good environment. Water pressure could be better in the mornings.', date: new Date().toISOString() },
    { id: uid(), name: 'Abdul Rashid', rating: 5, comment: 'Quiet and safe. The overseer responds to problems quickly.', date: new Date().toISOString() },
  ];
}

async function loadDb() {
  store = await makeStore();
  db = await store.load();
  if (!db || !db.overseer) {
    db = { overseer: hashPassword(DEFAULT_OVERSEER_PASSWORD), students: [], reports: [], reviews: [] };
    seed();
    await saveDb();
  } else {
    db.students = db.students || [];
    db.reports = db.reports || [];
    db.reviews = db.reviews || [];
  }
}
async function saveDb() {
  await store.save(db);
}

/* ---------------- Sessions (in-memory tokens) ---------------- */
const sessions = new Map(); // token -> { role, studentId, exp }
function newToken(role, studentId) {
  const token = crypto.randomBytes(24).toString('hex');
  sessions.set(token, { role, studentId, exp: Date.now() + (1000 * 60 * 60 * 12) });
  return token;
}
function cleanup() {
  const now = Date.now();
  for (const [k, v] of sessions) if (v.exp < now) sessions.delete(k);
}
function uid() { return 'u' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7); }

/* ---------------- Helpers ---------------- */
function publicStudent(s) {
  return { id: s.id, name: s.name, reg: s.reg, block: s.block, room: s.room, roomType: s.roomType || '',
    phone: s.phone, guardian: s.guardian, guardianPhone: s.guardianPhone, added: s.added };
}

/* ---------------- App ---------------- */
const app = express();
app.use(express.json({ limit: '300kb' }));
// request logging so we can see traffic from the browser
app.use((req, res, next) => {
  const start = Date.now();
  res.on('finish', () => {
    console.log(req.method, req.url, res.statusCode, Date.now() - start + 'ms');
  });
  next();
});
// CORS — allow the app to be used cross-origin (deployed behind a proxy/preview)
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
// Never cache the HTML so browsers always load the latest fixed version
app.use(express.static(path.join(__dirname, 'public'), {
  setHeaders: (res) => { res.setHeader('Cache-Control', 'no-store'); }
}));

// Auth middleware
function auth(req, res, next) {
  cleanup();
  const h = req.headers['authorization'] || '';
  const token = h.replace(/^Bearer\s+/i, '');
  const s = sessions.get(token);
  if (!s) return res.status(401).json({ error: 'Not logged in' });
  req.session = s;
  next();
}
function overseerOnly(req, res, next) {
  if (req.session.role !== 'overseer') return res.status(403).json({ error: 'Overseer only' });
  next();
}
function studentOnly(req, res, next) {
  if (req.session.role !== 'student') return res.status(403).json({ error: 'Student only' });
  next();
}

/* ---------------- Auth endpoints ---------------- */
app.get('/api/me', auth, (req, res) => {
  if (req.session.role === 'overseer') {
    res.json({ role: 'overseer' });
  } else {
    const st = db.students.find(x => x.id === req.session.studentId);
    if (!st) return res.status(404).json({ error: 'Student record not found' });
    res.json({ role: 'student', student: publicStudent(st) });
  }
});

app.post('/api/login/overseer', (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ error: 'Password required' });
  if (verifyPassword(password, db.overseer.salt, db.overseer.hash)) {
    res.json({ token: newToken('overseer'), role: 'overseer' });
  } else {
    res.status(401).json({ error: 'Incorrect overseer password' });
  }
});

app.post('/api/login/student', (req, res) => {
  const { reg, pin } = req.body || {};
  if (!reg || !pin) return res.status(400).json({ error: 'Reg no and PIN required' });
  const st = db.students.find(x => x.reg.toLowerCase() === String(reg).trim().toLowerCase());
  if (!st || !verifyPassword(String(pin), st.pin.salt, st.pin.hash)) {
    return res.status(401).json({ error: 'Reg no or PIN incorrect' });
  }
  res.json({ token: newToken('student', st.id), role: 'student', student: publicStudent(st) });
});

/* ---------------- Overseer: student records ---------------- */
app.get('/api/students', auth, overseerOnly, (req, res) => {
  res.json({ students: db.students.map(publicStudent) });
});

app.post('/api/students', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.name || !b.reg || !b.block || !b.room) return res.status(400).json({ error: 'Name, reg, block and room required' });
  if (!b.pin) return res.status(400).json({ error: 'Set a PIN for the student (4+ digits)' });
  if (db.students.some(x => x.reg.toLowerCase() === String(b.reg).trim().toLowerCase())) {
    return res.status(409).json({ error: 'A student with this reg no already exists' });
  }
  const rec = { id: uid(), name: b.name, reg: b.reg.trim(), block: b.block, room: b.room,
    roomType: b.roomType || '', phone: b.phone || '', guardian: b.guardian || '', guardianPhone: b.guardianPhone || '',
    pin: hashPassword(b.pin), added: new Date().toISOString() };
  db.students.push(rec);
  await saveDb();
  res.json({ student: publicStudent(rec) });
});

app.put('/api/students/:id', auth, overseerOnly, async (req, res) => {
  const st = db.students.find(x => x.id === req.params.id);
  if (!st) return res.status(404).json({ error: 'Student not found' });
  const b = req.body || {};
  if (b.name !== undefined) st.name = b.name;
  if (b.block !== undefined) st.block = b.block;
  if (b.room !== undefined) st.room = b.room;
  if (b.roomType !== undefined) st.roomType = b.roomType;
  if (b.phone !== undefined) st.phone = b.phone;
  if (b.guardian !== undefined) st.guardian = b.guardian;
  if (b.guardianPhone !== undefined) st.guardianPhone = b.guardianPhone;
  if (b.pin) st.pin = hashPassword(b.pin); // reset PIN
  await saveDb();
  res.json({ student: publicStudent(st) });
});

app.delete('/api/students/:id', auth, overseerOnly, async (req, res) => {
  const before = db.students.length;
  db.students = db.students.filter(x => x.id !== req.params.id);
  if (db.students.length === before) return res.status(404).json({ error: 'Student not found' });
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Overseer: reports ---------------- */
app.get('/api/reports', auth, overseerOnly, (req, res) => {
  res.json({ reports: db.reports });
});

app.put('/api/reports/:id', auth, overseerOnly, async (req, res) => {
  const r = db.reports.find(x => x.id === req.params.id);
  if (!r) return res.status(404).json({ error: 'Report not found' });
  const b = req.body || {};
  if (b.status !== undefined) r.status = b.status;
  await saveDb();
  res.json({ report: r });
});

app.delete('/api/reports/:id', auth, overseerOnly, async (req, res) => {
  const before = db.reports.length;
  db.reports = db.reports.filter(x => x.id !== req.params.id);
  if (db.reports.length === before) return res.status(404).json({ error: 'Report not found' });
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Overseer: change password ---------------- */
app.put('/api/overseer/password', auth, overseerOnly, async (req, res) => {
  const b = req.body || {};
  if (!b.current || !b.next) return res.status(400).json({ error: 'Current and new password required' });
  if (!verifyPassword(b.current, db.overseer.salt, db.overseer.hash)) {
    return res.status(401).json({ error: 'Current password is incorrect' });
  }
  if (String(b.next).length < 6) return res.status(400).json({ error: 'New password must be 6+ characters' });
  db.overseer = hashPassword(b.next);
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Student endpoints (no edit rights) ---------------- */
app.post('/api/reports', auth, studentOnly, async (req, res) => {
  const st = db.students.find(x => x.id === req.session.studentId);
  if (!st) return res.status(404).json({ error: 'Student record not found' });
  const b = req.body || {};
  if (!b.msg) return res.status(400).json({ error: 'Please describe the problem' });
  const rec = { id: uid(), studentId: st.id, name: st.name, reg: st.reg, phone: st.phone,
    block: st.block, room: st.room, msg: b.msg, urg: b.urg || 'Normal',
    status: 'open', date: new Date().toISOString() };
  db.reports.unshift(rec);
  await saveDb();
  res.json({ report: rec });
  sendWhatsAppNotification(rec); // fire-and-forget alert to the overseer's WhatsApp
});

app.get('/api/reports/mine', auth, studentOnly, (req, res) => {
  const mine = db.reports.filter(x => x.studentId === req.session.studentId);
  res.json({ reports: mine });
});

/* ---------------- Reviews (5-star rating + comments) ---------------- */
app.get('/api/reviews', (req, res) => {
  const list = db.reviews.slice().reverse(); // newest first
  const avg = list.length ? (list.reduce((a, r) => a + r.rating, 0) / list.length) : 0;
  res.json({ reviews: list, average: Math.round(avg * 10) / 10, count: list.length });
});

app.post('/api/reviews', auth, studentOnly, async (req, res) => {
  const st = db.students.find(x => x.id === req.session.studentId);
  if (!st) return res.status(404).json({ error: 'Student record not found' });
  const b = req.body || {};
  const rating = parseInt(b.rating, 10);
  if (!rating || rating < 1 || rating > 5) return res.status(400).json({ error: 'Rating must be between 1 and 5 stars' });
  if (!b.comment || !String(b.comment).trim()) return res.status(400).json({ error: 'Please write a short comment' });
  const rec = { id: uid(), name: st.name, rating: rating, comment: String(b.comment).trim(), date: new Date().toISOString() };
  db.reviews.push(rec);
  await saveDb();
  res.json({ review: rec });
});

app.delete('/api/reviews/:id', auth, overseerOnly, async (req, res) => {
  const before = db.reviews.length;
  db.reviews = db.reviews.filter(x => x.id !== req.params.id);
  if (db.reviews.length === before) return res.status(404).json({ error: 'Review not found' });
  await saveDb();
  res.json({ ok: true });
});

/* ---------------- Root ---------------- */
app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

// Fallback for unmatched routes / wrong methods — always clean JSON, never an HTML error
app.use((req, res) => {
  res.status(404).json({ error: 'Not found: ' + req.method + ' ' + req.path });
});

// Global error handler
app.use((err, req, res, next) => {
  console.error('Error:', err.message);
  res.status(err.status || 500).json({ error: err.message || 'Server error' });
});

/* ---------------- Start ---------------- */
async function start() {
  try {
    await loadDb();
    app.listen(PORT, '0.0.0.0', () => {
      console.log('Usambara Male Hostels live server running on port ' + PORT);
      console.log('Storage: ' + (MONGODB_URI ? 'MongoDB Atlas (permanent)' : 'local JSON file'));
    });
  } catch(e) {
    console.error('Failed to start server:', e.message);
    process.exit(1);
  }
}
start();
