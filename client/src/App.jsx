import { useEffect, useState } from 'react';
import { api, setToken, hasToken } from './api.js';

const money = (n) => Math.round(n).toLocaleString('ru-RU') + ' ₽';
const dm = (s) => new Date(s).toLocaleDateString('ru-RU', { day: 'numeric', month: 'short' });

function Auth({ onDone }) {
  const [f, setF] = useState({ email: '', password: '', demo: true });
  const [mode, setMode] = useState('login');
  const [err, setErr] = useState('');
  const submit = async (e) => {
    e.preventDefault();
    try {
      const { token } = await api('/auth/' + mode, 'POST', f);
      setToken(token); onDone();
    } catch (x) { setErr(x.message); }
  };
  return (
    <form className="card auth" onSubmit={submit}>
      <h1>BizHub</h1>
      <input placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
      <input type="password" placeholder="Пароль" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
      {mode === 'register' && (
        <label><input type="checkbox" checked={f.demo} onChange={(e) => setF({ ...f, demo: e.target.checked })} /> Загрузить демо-данные</label>
      )}
      {err && <div className="err">{err}</div>}
      <button>{mode === 'login' ? 'Войти' : 'Зарегистрироваться'}</button>
      <a href="#" onClick={(e) => { e.preventDefault(); setMode(mode === 'login' ? 'register' : 'login'); setErr(''); }}>
        {mode === 'login' ? 'Создать аккаунт' : 'Уже есть аккаунт'}
      </a>
    </form>
  );
}

function Chart({ data }) {
  const W = 600, H = 170, vals = data.map((d) => d.balance);
  const lo = Math.min(0, ...vals), hi = Math.max(...vals), rg = hi - lo || 1;
  const X = (i) => 8 + (i * (W - 16)) / 30, Y = (v) => 10 + (H - 20) * (1 - (v - lo) / rg);
  return (
    <svg viewBox={`0 0 ${W} ${H}`}>
      <line x1="8" x2={W - 8} y1={Y(0)} y2={Y(0)} stroke="#ccc" strokeDasharray="4 4" />
      <polyline fill="none" stroke="#0a5cff" strokeWidth="2.5" points={vals.map((v, i) => `${X(i)},${Y(v)}`).join(' ')} />
    </svg>
  );
}

const STATUS = { new: 'новая', matched: 'сопоставлена с планом', duplicate: 'дубликат (пропустим)' };

function Import({ onDone }) {
  const [csv, setCsv] = useState('');
  const [prev, setPrev] = useState(null);
  const [apply, setApply] = useState(true);
  const [err, setErr] = useState('');
  const pick = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    const buf = await f.arrayBuffer();
    let text; // банки часто отдают windows-1251
    try { text = new TextDecoder('utf-8', { fatal: true }).decode(buf); } catch { text = new TextDecoder('windows-1251').decode(buf); }
    setCsv(text);
    try { setPrev(await api('/import', 'POST', { csv: text, dryRun: true })); setErr(''); } catch (x) { setErr(x.message); setPrev(null); }
  };
  const commit = async () => {
    try { await api('/import', 'POST', { csv, applyBalance: apply }); setPrev(null); setCsv(''); onDone(); } catch (x) { setErr(x.message); }
  };
  return (
    <div className="card">
      <b>Импорт выписки (CSV)</b>
      <p><input type="file" accept=".csv,.txt" onChange={pick} /></p>
      {err && <div className="err">{err}</div>}
      {prev && (
        <>
          <small>Всего {prev.summary.total}: новых {prev.summary.added}, сопоставлено {prev.summary.matched}, дубликатов {prev.summary.skipped}</small>
          <div className="scroll">
            {prev.rows.map((r, i) => (
              <div key={i} className={'row' + (r.status === 'duplicate' ? ' done' : '')}>
                <span className="t"><b>{r.description}</b><small>{dm(r.date)} · {r.category} · {STATUS[r.status]}{r.matchTitle ? ': ' + r.matchTitle : ''}</small></span>
                <span>{r.amount > 0 ? '+' : '−'}{money(Math.abs(r.amount))}</span>
              </div>
            ))}
          </div>
          <label><input type="checkbox" checked={apply} onChange={(e) => setApply(e.target.checked)} /> Учесть операции в остатке на счёте</label>
          <p><button onClick={commit} disabled={!prev.summary.added && !prev.summary.matched}>Импортировать</button></p>
        </>
      )}
    </div>
  );
}

function Dashboard() {
  const [s, setS] = useState(null);
  const [form, setForm] = useState({ title: '', amount: '', sign: -1, due: new Date().toISOString().slice(0, 10) });
  const load = () => api('/state').then(setS);
  useEffect(() => { load(); }, []);
  if (!s) return <p>Загрузка…</p>;

  const min = s.forecast.reduce((m, p) => (p.balance < m.balance ? p : m));
  const open = s.events.filter((e) => !e.done);
  const sum = (arr) => arr.reduce((t, e) => t + Math.abs(e.amount), 0);
  const act = (fn) => fn().then(load);
  const add = (e) => {
    e.preventDefault();
    act(() => api('/events', 'POST', { title: form.title, amount: form.sign * Math.abs(form.amount), due: form.due }))
      .then(() => setForm({ ...form, title: '', amount: '' }));
  };

  return (
    <>
      <div className="top"><h1>BizHub</h1><button className="g" onClick={() => { setToken(null); location.reload(); }}>Выйти</button></div>
      {min.balance < 0 && <div className="alert">⚠ Риск кассового разрыва {dm(min.date)}: {money(min.balance)}</div>}
      <div className="grid">
        <div className="card"><small>Остаток</small><b>{money(s.balance)}</b></div>
        <div className="card"><small>Получим</small><b>{money(sum(open.filter((e) => e.amount > 0)))}</b></div>
        <div className="card"><small>Оплатим</small><b>{money(sum(open.filter((e) => e.amount < 0)))}</b></div>
        <div className="card"><small>Через 30 дней</small><b>{money(s.forecast[30].balance)}</b></div>
      </div>
      <div className="card"><Chart data={s.forecast} /></div>
      <div className="card">
        {s.events.map((e) => (
          <div key={e.id} className={'row' + (e.done ? ' done' : '')}>
            <span className="t"><b>{e.title}</b><small className={!e.done && e.due < s.today ? 'err' : ''}>{dm(e.due)} · {e.category}</small></span>
            <span>{e.amount > 0 ? '+' : '−'}{money(Math.abs(e.amount))}</span>
            {!e.done && <button onClick={() => act(() => api(`/events/${e.id}/done`, 'POST'))}>{e.amount > 0 ? 'Получено' : 'Оплатить'}</button>}
            <button className="g" onClick={() => act(() => api(`/events/${e.id}`, 'DELETE'))}>✕</button>
          </div>
        ))}
      </div>
      <Import onDone={load} />
      <form className="card add" onSubmit={add}>
        <input required placeholder="Название" value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} />
        <input required type="number" min="1" placeholder="Сумма" value={form.amount} onChange={(e) => setForm({ ...form, amount: e.target.value })} />
        <select value={form.sign} onChange={(e) => setForm({ ...form, sign: +e.target.value })}><option value="-1">Платёж</option><option value="1">Поступление</option></select>
        <input type="date" value={form.due} onChange={(e) => setForm({ ...form, due: e.target.value })} />
        <button>Добавить</button>
      </form>
    </>
  );
}

export default function App() {
  const [ok, setOk] = useState(hasToken());
  return <main>{ok ? <Dashboard /> : <Auth onDone={() => setOk(true)} />}</main>;
}
