const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { app } = require('electron');

const dir = app.getPath('userData');
const db = new Database(path.join(dir, 'clinic.db'));
db.pragma('journal_mode = WAL');

db.exec(`
CREATE TABLE IF NOT EXISTS settings(key TEXT PRIMARY KEY, value TEXT);
CREATE TABLE IF NOT EXISTS patients(
  id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, phone TEXT UNIQUE,
  notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS treatments(
  id INTEGER PRIMARY KEY, name TEXT NOT NULL, default_price REAL DEFAULT 0);
CREATE TABLE IF NOT EXISTS appointments(
  id INTEGER PRIMARY KEY,
  patient_id INTEGER NOT NULL REFERENCES patients(id),
  date TEXT NOT NULL,              -- YYYY-MM-DD
  treatment_id INTEGER REFERENCES treatments(id),
  price REAL DEFAULT 0,
  status TEXT DEFAULT 'booked',    -- booked | done | cancelled
  source TEXT DEFAULT 'manual',    -- whatsapp | manual
  notes TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS payments(
  id INTEGER PRIMARY KEY,
  appointment_id INTEGER REFERENCES appointments(id),
  patient_id INTEGER REFERENCES patients(id),
  amount REAL NOT NULL, date TEXT DEFAULT (date('now')));
CREATE TABLE IF NOT EXISTS expenses(
  id INTEGER PRIMARY KEY, category TEXT, amount REAL NOT NULL,
  date TEXT DEFAULT (date('now')), note TEXT);
CREATE INDEX IF NOT EXISTS idx_app_date ON appointments(date, status);
`);

// الإعدادات الافتراضية
const defaults = { capacity: '10', working_days: '[0,1,2,3,4]', // الأحد-الخميس
  clinic_name: 'عيادة الأسنان', lang: 'ar', password: '' };
for (const [k, v] of Object.entries(defaults))
  db.prepare('INSERT OR IGNORE INTO settings VALUES(?,?)').run(k, v);

const getSetting = k => db.prepare('SELECT value FROM settings WHERE key=?').get(k)?.value;
const setSetting = (k, v) => db.prepare('INSERT OR REPLACE INTO settings VALUES(?,?)').run(k, String(v));

// ---- الحجز التلقائي (يستعمله بوت واتساب) ----
const iso = d => d.toLocaleDateString('en-CA');

function bookNextFree(fullName, phone) {
  const cap = +getSetting('capacity');
  const days = JSON.parse(getSetting('working_days'));
  let p = db.prepare('SELECT * FROM patients WHERE phone=?').get(phone);
  if (!p) {
    const r = db.prepare('INSERT INTO patients(full_name,phone) VALUES(?,?)').run(fullName, phone);
    p = { id: r.lastInsertRowid, full_name: fullName };
  }
  const d = new Date(); d.setDate(d.getDate() + 1);          // نبدأ من الغد
  for (let i = 0; i < 90; i++, d.setDate(d.getDate() + 1)) {
    if (!days.includes(d.getDay())) continue;
    const date = iso(d);
    const n = db.prepare(
      "SELECT COUNT(*) c FROM appointments WHERE date=? AND status!='cancelled'").get(date).c;
    if (n < cap) {
      db.prepare("INSERT INTO appointments(patient_id,date,source) VALUES(?,?,'whatsapp')")
        .run(p.id, date);
      return { date, queue: n + 1 };
    }
  }
  return null; // لا يوجد مكان خلال 90 يومًا
}

// ---- المالية ----
function dayReport(date) {
  const income = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE date=?').get(date).s;
  const exp = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE date=?').get(date).s;
  return { date, income, expenses: exp, net: income - exp };
}

function patientDebt(patientId) {
  const due = db.prepare("SELECT COALESCE(SUM(price),0) s FROM appointments WHERE patient_id=? AND status='done'").get(patientId).s;
  const paid = db.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE patient_id=?').get(patientId).s;
  return due - paid;
}

function backup() {
  const out = path.join(dir, 'backups'); fs.mkdirSync(out, { recursive: true });
  db.backup(path.join(out, `clinic-${iso(new Date())}.db`));
}

module.exports = { db, getSetting, setSetting, bookNextFree, dayReport, patientDebt, backup };