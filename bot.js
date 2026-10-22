const path = require('path');
const fs = require('fs');
const { app, ipcMain } = require('electron');
const QR = require('qrcode');
const pino = require('pino');
const D = require('./db');

try { D.db.exec('ALTER TABLE appointments ADD COLUMN reminded INTEGER DEFAULT 0'); } catch (e) {}

const authDir = path.join(app.getPath('userData'), 'wa-auth');
let sock = null, status = { state: 'connecting' }, push = () => {}, chain = Promise.resolve();
const queued = new Set();

const sleep = ms => new Promise(r => setTimeout(r, ms));
const rnd = (a, b) => a + Math.random() * (b - a);
const isAr = s => /[\u0600-\u06FF]/.test(s);
const today = () => new Date().toLocaleDateString('en-CA');
const setStatus = s => { status = s; push(s); };

const DAYS = {
  ar: ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'],
  fr: ['Dimanche', 'Lundi', 'Mardi', 'Mercredi', 'Jeudi', 'Vendredi', 'Samedi']
};
const dstr = (date, l) => {
  const d = new Date(date + 'T12:00:00');
  return `${DAYS[l][d.getDay()]} ${date.split('-').reverse().join('/')}`;
};

const MSG = {
  ask: (c, l) => l === 'ar'
    ? `مرحبًا بكم في ${c} 🦷\nمن فضلك اكتب *اسمك الكامل* (الاسم واللقب) لنسجّلك في أقرب موعد متاح.`
    : `Bienvenue chez ${c} 🦷\nVeuillez écrire votre *nom complet* (nom et prénom) pour vous inscrire au prochain rendez-vous disponible.`,
  booked: (n, r, l) => l === 'ar'
    ? `✅ تم تسجيلك يا ${n}\n📅 ${dstr(r.date, l)}\n🔢 رقمك في الدور: ${r.queue}\n\nلعرض موعدك اكتب: موعدي\nللإلغاء اكتب: إلغاء`
    : `✅ ${n}, votre rendez-vous est enregistré\n📅 ${dstr(r.date, l)}\n🔢 Votre numéro: ${r.queue}\n\nPour voir votre rendez-vous: mon rdv\nPour annuler: annuler`,
  mine: (r, l) => l === 'ar'
    ? `📌 لديك موعد محجوز\n📅 ${dstr(r.date, l)}\n🔢 رقمك في الدور: ${r.queue}\n\nللإلغاء اكتب: إلغاء`
    : `📌 Vous avez un rendez-vous\n📅 ${dstr(r.date, l)}\n🔢 Votre numéro: ${r.queue}\n\nPour annuler: annuler`,
  none: l => l === 'ar' ? 'ليس لديك موعد قادم.' : "Vous n'avez aucun rendez-vous à venir.",
  cancelled: l => l === 'ar' ? '✅ تم إلغاء موعدك.' : '✅ Votre rendez-vous a été annulé.',
  full: l => l === 'ar'
    ? 'عذرًا، لا توجد أماكن شاغرة حاليًا. حاول لاحقًا.'
    : "Désolé, aucune place disponible pour le moment. Réessayez plus tard.",
  remind: (r, l, c) => l === 'ar'
    ? `⏰ تذكير من ${c}\nموعدك غدًا ${dstr(r.date, l)}\n🔢 رقمك: ${r.queue}\nللإلغاء اكتب: إلغاء`
    : `⏰ Rappel de ${c}\nVotre rendez-vous est demain ${dstr(r.date, l)}\n🔢 Votre numéro: ${r.queue}\nPour annuler: annuler`
};

const CANCEL = ['إلغاء', 'الغاء', 'الغي', 'ألغي', 'annuler', 'annulation', 'cancel'];
const MINE = ['موعدي', 'موعد', 'mon rdv', 'rdv', 'mon rendez-vous', 'rendez-vous'];
const GREET = /^(سلام|السلام|مرحبا|صباح|مساء|اهلا|أهلا|salam|salut|bonjour|bonsoir|hello|hi\b|coucou)/i;
const validName = t => /^[\p{L}][\p{L}\s'’.-]{2,59}$/u.test(t) && t.trim().split(/\s+/).length >= 2;

const toJid = p => {
  let d = String(p).replace(/\D/g, '');
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = '213' + d.slice(1);
  return d + '@s.whatsapp.net';
};

function nextAppt(phone) {
  const v = [phone];
  if (phone.startsWith('213')) v.push('0' + phone.slice(3));
  return D.db.prepare(
    `SELECT a.id, a.date FROM appointments a JOIN patients p ON p.id=a.patient_id
     WHERE p.phone IN (${v.map(() => '?').join(',')}) AND a.status='booked' AND a.date>=?
     ORDER BY a.date, a.id LIMIT 1`).get(...v, today());
}
const queueOf = a => D.db.prepare(
  "SELECT COUNT(*) c FROM appointments WHERE date=? AND status!='cancelled' AND id<=?").get(a.date, a.id).c;

async function send(jid, text) {
  await sock.presenceSubscribe(jid);
  await sock.sendPresenceUpdate('composing', jid);
  await sleep(rnd(1500, 3500));
  await sock.sendPresenceUpdate('paused', jid);
  await sock.sendMessage(jid, { text });
}

async function handle(jid, phone, text) {
  const clinic = D.getSetting('clinic_name');
  const l = isAr(text) ? 'ar' : 'fr';
  const s = text.toLowerCase().replace(/\s+/g, ' ').trim();
  const a = nextAppt(phone);

  if (CANCEL.includes(s)) {
    if (!a) return send(jid, MSG.none(l));
    D.db.prepare("UPDATE appointments SET status='cancelled' WHERE id=?").run(a.id);
    return send(jid, MSG.cancelled(l));
  }
  if (a || MINE.includes(s)) {
    if (!a) return send(jid, MSG.none(l));
    return send(jid, MSG.mine({ date: a.date, queue: queueOf(a) }, l));
  }
  if (GREET.test(s) || !validName(text)) return send(jid, MSG.ask(clinic, l));

  const name = text.replace(/\s+/g, ' ').trim();
  const r = D.bookNextFree(name, phone);
  return send(jid, r ? MSG.booked(name, r, l) : MSG.full(l));
}

function checkReminders() {
  if (status.state !== 'connected') return;
  const h = new Date().getHours();
  if (h < 17 || h > 20) return;
  const t = new Date(); t.setDate(t.getDate() + 1);
  const rows = D.db.prepare(
    `SELECT a.id, a.date, p.full_name, p.phone FROM appointments a
     JOIN patients p ON p.id=a.patient_id
     WHERE a.date=? AND a.status='booked' AND a.reminded=0
     AND p.phone IS NOT NULL AND p.phone!=''`).all(t.toLocaleDateString('en-CA'));
  for (const r of rows) {
    if (queued.has(r.id)) continue;
    queued.add(r.id);
    chain = chain.then(async () => {
      try {
        await sleep(rnd(8000, 15000));
        const l = isAr(r.full_name) ? 'ar' : 'fr';
        await send(toJid(r.phone), MSG.remind({ date: r.date, queue: queueOf(r) }, l, D.getSetting('clinic_name')));
        D.db.prepare('UPDATE appointments SET reminded=1 WHERE id=?').run(r.id);
      } catch (e) { console.error('reminder', e.message); }
    });
  }
}

async function connect() {
  try {
    const B = require('@whiskeysockets/baileys');
    const { state, saveCreds } = await B.useMultiFileAuthState(authDir);
    const { version } = await B.fetchLatestBaileysVersion().catch(() => ({}));
    sock = B.default({
      version, auth: state, logger: pino({ level: 'silent' }),
      browser: ['DentaRDV', 'Desktop', '1.0'], markOnlineOnConnect: false, syncFullHistory: false
    });
    sock.ev.on('creds.update', saveCreds);

    sock.ev.on('connection.update', async u => {
      const { connection, lastDisconnect, qr } = u;
      if (qr) setStatus({ state: 'qr', qr: await QR.toDataURL(qr, { width: 300 }) });
      if (connection === 'open') setStatus({ state: 'connected' });
      if (connection === 'close') {
        const code = lastDisconnect?.error?.output?.statusCode;
        setStatus({ state: 'connecting' });
        if (code === B.DisconnectReason.loggedOut) {
          fs.rmSync(authDir, { recursive: true, force: true });
          setTimeout(connect, 1500);
        } else setTimeout(connect, 5000);
      }
    });

    sock.ev.on('messages.upsert', ({ messages, type }) => {
      if (type !== 'notify') return;
      for (const m of messages) {
        if (!m.message || m.key.fromMe) continue;
        const jid = m.key.remoteJid || '';
        if (!jid || jid.endsWith('@g.us') || jid.endsWith('@broadcast') || jid.endsWith('@newsletter')) continue;
        const text = (m.message.conversation || m.message.extendedTextMessage?.text || '').trim();
        if (!text) continue;
        const phone = (m.key.remoteJidAlt || jid).split('@')[0].split(':')[0];
        chain = chain.then(() => handle(jid, phone, text)).catch(e => console.error('bot', e.message));
      }
    });
  } catch (e) {
    console.error('connect', e.message);
    setStatus({ state: 'connecting' });
    setTimeout(connect, 10000);
  }
}

function init(win) {
  push = s => { if (!win.isDestroyed()) win.webContents.send('wa:status', s); };
  ipcMain.handle('wa:status', () => status);
  ipcMain.handle('wa:logout', async () => { try { await sock.logout(); } catch (e) {} });
  connect();
  setInterval(checkReminders, 30 * 60 * 1000);
  setTimeout(checkReminders, 60 * 1000);
}

module.exports = { init };