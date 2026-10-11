// Разбор банковской выписки в CSV: авто-определение разделителя, колонок, форматов дат и сумм.
const norm = (s) => String(s ?? '').trim();

export function parseCsv(text) {
  text = text.replace(/^\uFEFF/, '');
  const first = text.split(/\r?\n/).find((l) => l.trim()) || '';
  const delim = [';', '\t', ','].map((d) => [d, first.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cur = '', q = false;
  const endRow = () => { row.push(cur); if (row.some((x) => x.trim())) rows.push(row); row = []; cur = ''; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) {
      if (c === '"') { if (text[i + 1] === '"') { cur += '"'; i++; } else q = false; } else cur += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cur); cur = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && text[i + 1] === '\n') i++; endRow(); }
    else cur += c;
  }
  endRow();
  return rows;
}

export function parseDate(s) {
  s = norm(s);
  let m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return `${m[1]}-${m[2]}-${m[3]}`;
  m = s.match(/^(\d{1,2})[./](\d{1,2})[./](\d{2,4})/);
  if (!m) return null;
  const y = m[3].length === 2 ? '20' + m[3] : m[3];
  const iso = `${y}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isNaN(new Date(iso)) ? null : iso;
}

export function parseAmount(s) {
  s = norm(s).replace(/[\s\u00a0RUBрубРУБ₽]/g, '').replace(/[−–—]/g, '-').replace(',', '.');
  if (!/^[-+]?\d+(\.\d+)?$/.test(s)) return null;
  return Number(s);
}

const COL = {
  debit: /дебет|списани|расход|debit|withdraw/i,
  credit: /кредит|зачислен|поступлен|приход|credit|deposit/i,
  desc: /назначение|описание|контрагент|получатель|плательщик|description|details|purpose|counterparty/i,
  date: /дата|date/i,
  amount: /сумма|amount/i,
};

export function parseStatement(text) {
  const rows = parseCsv(text);
  let hi = -1, map;
  for (let i = 0; i < Math.min(rows.length, 15) && hi < 0; i++) {
    const m = { desc: [] };
    rows[i].forEach((h, j) => {
      const k = ['debit', 'credit', 'desc', 'date', 'amount'].find((k) => COL[k].test(h));
      if (k === 'desc') m.desc.push(j); else if (k && m[k] === undefined) m[k] = j;
    });
    if (m.date !== undefined && (m.amount !== undefined || m.debit !== undefined || m.credit !== undefined)) { hi = i; map = m; }
  }
  if (hi < 0) throw new Error('Не нашёл строку заголовка: нужны колонки «Дата» и «Сумма» (или «Дебет»/«Кредит»)');

  const out = [];
  for (const r of rows.slice(hi + 1)) {
    const date = parseDate(r[map.date]);
    if (!date) continue; // итоги, пустые и служебные строки
    let amount = null;
    if (map.amount !== undefined) amount = parseAmount(r[map.amount]);
    else {
      const d = Math.abs(parseAmount(r[map.debit]) || 0), c = Math.abs(parseAmount(r[map.credit]) || 0);
      amount = c - d;
    }
    if (!amount) continue;
    const description = map.desc.map((j) => norm(r[j])).filter(Boolean).join(' · ') || 'Операция по выписке';
    out.push({ date, amount, description });
  }
  return out;
}

const RULES = [
  [/ндфл|фнс|налог|усн|ндс|страхов|взнос|пфр|сфр/i, 'Налоги'],
  [/аренд/i, 'Аренда'],
  [/зарплат|заработн|аванс.*сотрудн|отпускн/i, 'ФОТ'],
  [/поставщик|закупк|товар|материал/i, 'Поставщик'],
];
export function categorize(description, amount) {
  for (const [re, cat] of RULES) if (re.test(description)) return cat;
  return amount > 0 ? 'Клиент' : 'Прочее';
}
