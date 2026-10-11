import express from 'express';
import Database from 'better-sqlite3';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import crypto from 'node:crypto';
import { parseStatement, categorize } from './csv.js';

const SECRET = process.env.JWT_SECRET || 'dev-secret-change-me';
const db = new Database(process.env.DB_FILE || 'bizhub.db');
db.exec(`
CREATE TABLE IF NOT EXISTS users(
  id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, pass TEXT NOT NULL, balance REAL NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS events(
  id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL, title TEXT NOT NULL, amount REAL NOT NULL,
  due TEXT NOT NULL, category TEXT NOT NULL DEFAULT 'Прочее', done INTEGER NOT NULL DEFAULT 0);
CREATE INDEX IF NOT EXISTS idx_events_user ON events(user_id, due);`);

// миграция: источник и отпечаток операции (для защиты от дублей при повторном импорте)
for (const col of ['hash TEXT', "source TEXT NOT NULL DEFAULT 'manual'"]) {
  try { db.exec('ALTER TABLE events ADD COLUMN ' + col); } catch { /* уже есть */ }
}
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS idx_events_hash ON events(user_id, hash) WHERE hash IS NOT NULL');

const iso = (d) => d.toISOString().slice(0, 10);
const addDays = (n) => { const d = new Date(); d.setUTCHours(0, 0, 0, 0); d.setUTCDate(d.getUTCDate() + n); return iso(d); };
const isDate = (s) => /^\d{4}-\d{2}-\d{2}$/.test(s) && !isNaN(new Date(s));

const DEMO = [
  ['НДФЛ за сотрудников', -68000, -1, 'Налоги'], ['Аренда офиса', -95000, 2, 'Аренда'],
  ['Оплата от ООО «Вектор»', 130000, 4, 'Клиент'], ['Зарплата', -240000, 6, 'ФОТ'],
  ['Страховые взносы', -72000, 8, 'Налоги'], ['Поставщик «Север-Опт»', -150000, 12, 'Поставщик'],
  ['Оплата от ИП Громов', 90000, 15, 'Клиент'], ['УСН (авансовый платёж)', -110000, 20, 'Налоги'],
  ['Оплата от ООО «Меридиан»', 260000, 26, 'Клиент'],
];

// Прогноз остатка на 30 дней: просроченные операции учитываются в день 0
function forecast(balance, events) {
  const days = Array.from({ length: 31 }, (_, i) => addDays(i));
  let b = balance;
  return days.map((day, i) => {
    for (const e of events) if (!e.done && (e.due === day || (i === 0 && e.due < day))) b += e.amount;
    return { date: day, balance: b };
  });
}

const app = express();
app.use(express.json({ limit: '5mb' }));

const sign = (u) => jwt.sign({ id: u.id }, SECRET, { expiresIn: '7d' });
const auth = (req, res, next) => {
  try {
    req.uid = jwt.verify((req.headers.authorization || '').replace('Bearer ', ''), SECRET).id;
    next();
  } catch { res.status(401).json({ error: 'Требуется вход' }); }
};

app.post('/api/auth/register', (req, res) => {
  const { email, password, demo } = req.body || {};
  if (!/^\S+@\S+\.\S+$/.test(email || '') || (password || '').length < 6)
    return res.status(400).json({ error: 'Нужны корректный email и пароль от 6 символов' });
  if (db.prepare('SELECT 1 FROM users WHERE email=?').get(email))
    return res.status(409).json({ error: 'Email уже зарегистрирован' });
  const id = db.prepare('INSERT INTO users(email,pass,balance) VALUES(?,?,?)')
    .run(email, bcrypt.hashSync(password, 10), demo ? 420000 : 0).lastInsertRowid;
  if (demo) {
    const ins = db.prepare('INSERT INTO events(user_id,title,amount,due,category) VALUES(?,?,?,?,?)');
    DEMO.forEach(([t, a, d, c]) => ins.run(id, t, a, addDays(d), c));
  }
  res.status(201).json({ token: sign({ id }) });
});

app.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  const u = db.prepare('SELECT * FROM users WHERE email=?').get(email || '');
  if (!u || !bcrypt.compareSync(password || '', u.pass)) return res.status(401).json({ error: 'Неверный email или пароль' });
  res.json({ token: sign(u) });
});

app.get('/api/state', auth, (req, res) => {
  const { balance } = db.prepare('SELECT balance FROM users WHERE id=?').get(req.uid);
  const events = db.prepare('SELECT id,title,amount,due,category,done FROM events WHERE user_id=? ORDER BY due,id').all(req.uid)
    .map((e) => ({ ...e, done: !!e.done }));
  res.json({ balance, events, forecast: forecast(balance, events), today: addDays(0) });
});

app.post('/api/events', auth, (req, res) => {
  const { title, amount, due, category } = req.body || {};
  if (!title?.trim() || !Number.isFinite(+amount) || +amount === 0 || !isDate(due))
    return res.status(400).json({ error: 'Проверьте название, сумму и дату' });
  const id = db.prepare('INSERT INTO events(user_id,title,amount,due,category) VALUES(?,?,?,?,?)')
    .run(req.uid, title.trim(), +amount, due, category || 'Прочее').lastInsertRowid;
  res.status(201).json({ id });
});

app.post('/api/events/:id/done', auth, (req, res) => {
  const e = db.prepare('SELECT * FROM events WHERE id=? AND user_id=?').get(req.params.id, req.uid);
  if (!e) return res.sendStatus(404);
  if (!e.done) db.transaction(() => {
    db.prepare('UPDATE events SET done=1 WHERE id=?').run(e.id);
    db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(e.amount, req.uid);
  })();
  res.sendStatus(204);
});

app.delete('/api/events/:id', auth, (req, res) => {
  db.prepare('DELETE FROM events WHERE id=? AND user_id=?').run(req.params.id, req.uid);
  res.sendStatus(204);
});

// Импорт выписки: dryRun=true — только предпросмотр, иначе запись.
// Операции из выписки — фактические: сопоставляем с плановыми (±1% суммы, ±5 дней) или создаём как выполненные.
app.post('/api/import', auth, (req, res) => {
  const { csv, dryRun, applyBalance = true } = req.body || {};
  let parsed;
  try { parsed = parseStatement(String(csv || '')); } catch (e) { return res.status(400).json({ error: e.message }); }
  if (!parsed.length) return res.status(400).json({ error: 'В файле не найдено операций' });
  if (parsed.length > 5000) return res.status(400).json({ error: 'Слишком много строк (максимум 5000)' });

  const planned = db.prepare("SELECT * FROM events WHERE user_id=? AND done=0 AND source!='import'").all(req.uid);
  const claimed = new Set(), seen = {};
  const rows = parsed.map((r) => {
    const key = `${r.date}|${r.amount}|${r.description.toLowerCase()}`;
    seen[key] = (seen[key] || 0) + 1; // одинаковые операции в одном файле различаем по порядковому номеру
    const hash = crypto.createHash('sha1').update(key + '#' + seen[key]).digest('hex');
    const category = categorize(r.description, r.amount);
    if (db.prepare('SELECT 1 FROM events WHERE user_id=? AND hash=?').get(req.uid, hash)) return { ...r, category, hash, status: 'duplicate' };
    const day = (d) => Date.parse(d) / 864e5;
    const m = planned
      .filter((e) => !claimed.has(e.id) && Math.sign(e.amount) === Math.sign(r.amount)
        && Math.abs(Math.abs(e.amount) - Math.abs(r.amount)) <= Math.abs(r.amount) * 0.01
        && Math.abs(day(e.due) - day(r.date)) <= 5)
      .sort((a, b) => Math.abs(day(a.due) - day(r.date)) - Math.abs(day(b.due) - day(r.date)))[0];
    if (m) { claimed.add(m.id); return { ...r, category: m.category, hash, status: 'matched', matchId: m.id, matchTitle: m.title }; }
    return { ...r, category, hash, status: 'new' };
  });

  const count = (s) => rows.filter((r) => r.status === s).length;
  const summary = { total: rows.length, added: count('new'), matched: count('matched'), skipped: count('duplicate') };
  if (dryRun) return res.json({ rows: rows.map(({ hash, ...r }) => r), summary });

  db.transaction(() => {
    const ins = db.prepare("INSERT INTO events(user_id,title,amount,due,category,done,source,hash) VALUES(?,?,?,?,?,1,'import',?)");
    const upd = db.prepare("UPDATE events SET done=1, hash=?, due=? WHERE id=?");
    let delta = 0;
    for (const r of rows) {
      if (r.status === 'new') ins.run(req.uid, r.description.slice(0, 200), r.amount, r.date, r.category, r.hash);
      else if (r.status === 'matched') upd.run(r.hash, r.date, r.matchId);
      if (r.status !== 'duplicate') delta += r.amount;
    }
    if (applyBalance) db.prepare('UPDATE users SET balance=balance+? WHERE id=?').run(delta, req.uid);
  })();
  res.json({ summary });
});

app.listen(process.env.PORT || 3001, () => console.log('BizHub API: http://localhost:' + (process.env.PORT || 3001)));
