import assert from 'node:assert/strict';
import { parseStatement, parseAmount, parseDate, categorize } from './csv.js';

assert.equal(parseAmount('−1 234,56 ₽'), -1234.56);
assert.equal(parseAmount('abc'), null);
assert.equal(parseDate('05.10.26'), '2026-10-05');
assert.equal(parseDate('2026-10-05 12:00:00'), '2026-10-05');

// одна колонка со знаком, разделитель запятая, кавычки
let r = parseStatement('Date,Description,Amount\n2026-10-01,"Rent, office",-95000\n2026-10-02,Client,130000.50\nИтого,,1');
assert.equal(r.length, 2); assert.equal(r[0].description, 'Rent, office'); assert.equal(r[1].amount, 130000.5);
// дебет/кредит, «;», служебные строки до заголовка
r = parseStatement('Выписка по счёту\n\nДата;Назначение;Дебет;Кредит\n01.10.2026;Аренда;1 000,00;\n02.10.2026;Оплата;;2 500,00');
assert.deepEqual(r.map((x) => x.amount), [-1000, 2500]);
assert.throws(() => parseStatement('a;b\n1;2'), /заголовка/);
assert.equal(categorize('Оплата НДФЛ', -1), 'Налоги');
assert.equal(categorize('Перевод', 5), 'Клиент');
console.log('csv tests ok');
