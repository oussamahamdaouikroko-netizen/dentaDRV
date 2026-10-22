const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
let D;

app.whenReady().then(() => {
  D = require('./db');
  D.backup();

  const q = D.db;
  const h = (ch, fn) => ipcMain.handle(ch, (_, ...a) => fn(...a));

  h('settings:get', k => D.getSetting(k));
  h('settings:set', (k, v) => D.setSetting(k, v));

  h('agenda', date => q.prepare(
    `SELECT a.*, p.full_name, p.phone,
      (SELECT COALESCE(SUM(amount),0) FROM payments WHERE appointment_id=a.id) AS paid
     FROM appointments a JOIN patients p ON p.id=a.patient_id
     WHERE a.date=? AND a.status!='cancelled' ORDER BY a.id`).all(date));

  h('appt:add', f => {
    let p = f.phone ? q.prepare('SELECT * FROM patients WHERE phone=?').get(f.phone) : null;
    if (!p) {
      const r = q.prepare('INSERT INTO patients(full_name,phone) VALUES(?,?)')
        .run(f.name, f.phone || null);
      p = { id: r.lastInsertRowid };
    }
    q.prepare("INSERT INTO appointments(patient_id,date,source) VALUES(?,?,'manual')")
      .run(p.id, f.date);
  });

  h('appt:update', (id, f) => q.prepare(
    'UPDATE appointments SET price=?, status=?, treatment_id=?, notes=? WHERE id=?')
    .run(f.price, f.status, f.treatment_id || null, f.notes || '', id));

  h('pay:add', f => q.prepare(
    'INSERT INTO payments(appointment_id,patient_id,amount) VALUES(?,?,?)')
    .run(f.appointment_id, f.patient_id, f.amount));

  h('treatments:list', () => q.prepare('SELECT * FROM treatments ORDER BY name').all());
  h('treatments:add', (n, p) => q.prepare('INSERT INTO treatments(name,default_price) VALUES(?,?)').run(n, p));
  h('treatments:del', id => q.prepare('DELETE FROM treatments WHERE id=?').run(id));

  h('expense:add', f => q.prepare(
    'INSERT INTO expenses(category,amount,note) VALUES(?,?,?)').run(f.category, f.amount, f.note));
  h('expenses:list', m => q.prepare(
    'SELECT * FROM expenses WHERE date LIKE ? ORDER BY date DESC, id DESC').all(m + '%'));
  h('expense:del', id => q.prepare('DELETE FROM expenses WHERE id=?').run(id));

  h('report:day', d => D.dayReport(d));
  h('report:month', m => {
    const income = q.prepare('SELECT COALESCE(SUM(amount),0) s FROM payments WHERE date LIKE ?').get(m + '%').s;
    const exp = q.prepare('SELECT COALESCE(SUM(amount),0) s FROM expenses WHERE date LIKE ?').get(m + '%').s;
    return { income, expenses: exp, net: income - exp };
  });
  h('debts:list', () => q.prepare(
    `SELECT * FROM (SELECT p.id, p.full_name, p.phone,
      COALESCE((SELECT SUM(price) FROM appointments WHERE patient_id=p.id AND status='done'),0) -
      COALESCE((SELECT SUM(amount) FROM payments WHERE patient_id=p.id),0) AS debt
      FROM patients p) WHERE debt > 0 ORDER BY debt DESC`).all());

  const win = new BrowserWindow({
    width: 1200, height: 800, autoHideMenuBar: true,
    webPreferences: { preload: path.join(__dirname, 'preload.js') }
  });
    win.loadFile('renderer/index.html');
  require('./bot').init(win);
});

app.on('window-all-closed', () => app.quit());