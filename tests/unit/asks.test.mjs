// Asks and answers on checklist steps (src/js/asks.js, app/asks.js), read from text lines. tests/parse.mjs covers reading the lines
// out of a description's or a comment's HTML.
import './browser.mjs';
import { component } from './fake.mjs';
import asksPart from '../../src/js/app/asks.js';
import runs from '../../src/js/app/runs.js';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { answerHtml, answerLines, answersOf, askLines, askMeta, askRows, asksOf, fieldValue, parseAsk, rangeText, readAnswers, asksText, savedValue } from '../../src/js/asks.js';

const ask = text => parseAsk(text);

test('an ask has a label before the first ": ", a type, and the type\'s arguments', () => {
  assert.deepEqual(ask('Notes: text'), { label: 'Notes', key: 'notes', type: 'text' });
  assert.deepEqual(ask('Seal intact: yes-no'), { label: 'Seal intact', key: 'seal intact', type: 'yes-no' });
  assert.deepEqual(ask('Temp: number °C 0..5'), { label: 'Temp', key: 'temp', type: 'number', unit: '°C', low: 0, high: 5 });
  assert.deepEqual(ask('Belt: choice Good | Worn | Replace'), { label: 'Belt', key: 'belt', type: 'choice', options: ['Good', 'Worn', 'Replace'] });
  assert.deepEqual(ask('number kg'), { label: '', key: '', type: 'number', unit: 'kg', low: null, high: null }, 'the label may be left out');
  assert.equal(ask('Seal intact: Yes-No').type, 'yes-no', 'the type is read in any case');
});

test('a number\'s range may come before its unit, be open at either end, be negative, and have decimals', () => {
  const r = t => { const a = ask(t); return a && [a.unit, a.low, a.high]; };
  assert.deepEqual(r('number 0..5 °C'), ['°C', 0, 5]);
  assert.deepEqual(r('number ..2.5 kg'), ['kg', null, 2.5]);
  assert.deepEqual(r('number km/h 0..'), ['km/h', 0, null]);
  assert.deepEqual(r('Freezer: number °C -18..-15'), ['°C', -18, -15]);
  assert.deepEqual(r('number °C −18..−15'), ['°C', -18, -15], 'a minus sign is read as a minus');
  assert.deepEqual(r('number per square metre'), ['per square metre', null, null], 'the unit is whatever words remain');
  assert.deepEqual(r('number 5..5'), ['', 5, 5], 'both ends are inclusive, so one value is a range');
});

test('an ask Pocket can\'t read is null: an unknown type, a malformed range, or a choice of fewer than two', () => {
  for (const t of ['Temp: numbr °C', 'Temp: number 5..0', 'Temp: number a..b', 'Temp: number ..', 'Temp: number 0..5 1..2', 'Belt: choice Good', 'Belt: choice Good | good', 'Temp:', '']) assert.equal(ask(t), null, t);
});

test('a choice\'s options are split on "|", with or without spaces, and keep their order', () => {
  assert.deepEqual(ask('choice Good|Worn | Replace now').options, ['Good', 'Worn', 'Replace now']);
});

test('a step\'s asks are its ask lines in order, the first of a label counts, and lines it can\'t use say why', () => {
  const lines = ['Read the probe on the top shelf.', 'pocket:ask Temp: number °C 0..5', 'pocket:order 3 4', 'pocket:ask Belt: choice Good', 'pocket:ask temp: text', 'POCKET:ASK Seal: yes-no'];
  const { asks, bad } = asksOf(lines);
  assert.deepEqual(asks.map(a => a.label), ['Temp', 'Seal']);
  assert.deepEqual(bad.map(b => b.why), ['it can\'t be read', 'another ask is labelled “temp”']);
});

test('a step with one ask may leave out its label, and a step with several needs one on each', () => {
  assert.deepEqual(asksOf(['pocket:ask number °C']).asks.map(a => a.type), ['number']);
  const { asks, bad } = asksOf(['pocket:ask number °C', 'pocket:ask Belt: choice Good | Worn']);
  assert.deepEqual(asks.map(a => a.label), ['Belt']);
  assert.deepEqual(bad, [{ line: 'pocket:ask number °C', why: 'a step with several asks needs a label on each' }]);
});

test('a range reads as words, with the unit', () => {
  assert.equal(rangeText(ask('number °C 0..5')), '0 to 5 °C');
  assert.equal(rangeText(ask('number ..5')), '5 or less');
  assert.equal(rangeText(ask('number kg 0..')), '0 kg or more');
  assert.equal(rangeText(ask('number kg')), '');
});

test('a number field is saved as the number, a full stop for decimals, then the unit, and flagged outside its range', () => {
  const temp = ask('Temp: number °C 0..5');
  assert.deepEqual(fieldValue(temp, '7,50'), { text: '7.5 °C', num: 7.5, off: true });
  assert.deepEqual(fieldValue(temp, ' 4 '), { text: '4 °C', num: 4, off: false });
  assert.deepEqual(fieldValue(temp, '0'), { text: '0 °C', num: 0, off: false }, '0 is an answer, and both ends are in range');
  assert.deepEqual(fieldValue(temp, '−2'), { text: '-2 °C', num: -2, off: true });
  assert.equal(fieldValue(temp, '  '), null);
  assert.deepEqual(fieldValue(temp, '7 degrees'), { problem: 'Not a number, so it isn\'t saved' });
});

test('a text field is saved as one line', () => {
  assert.deepEqual(fieldValue(ask('Notes: text'), 'Door open\n  again '), { text: 'Door open again' });
  assert.deepEqual(fieldValue(ask('Seal: yes-no'), 'No'), { text: 'No' }, 'No is an answer');
});

test('a saved number is judged by its range, and a value that is not a number is shown as written', () => {
  const temp = ask('Temp: number °C 0..5');
  assert.deepEqual(savedValue(temp, '7.5 °C'), { text: '7.5 °C', num: 7.5, off: true });
  assert.deepEqual(savedValue(temp, 'about 4'), { text: 'about 4', num: null, off: false });
  assert.deepEqual(savedValue(ask('Seal: yes-no'), 'yes'), { text: 'Yes' });
  assert.deepEqual(savedValue(ask('Belt: choice Good | Worn'), 'Frayed'), { text: 'Frayed' }, 'a value that is no longer an option is kept');
});

test('an answer comment ends with the line pocket:answer', () => {
  assert.deepEqual(answerLines(['Temp: 7 °C', 'pocket:answer']), ['Temp: 7 °C']);
  assert.equal(answerLines(['Temp: 7 °C']), null);
  assert.equal(answerLines(['pocket:answer', 'Temp: 7 °C']), null);
  assert.equal(answerLines([]), null);
});

test('an answer line belongs to the ask whose label it starts with, in any case', () => {
  const { asks } = asksOf(['pocket:ask Temp: number °C', 'pocket:ask Temp max: number °C', 'pocket:ask Notes: text']);
  const read = readAnswers(asks, ['temp max: 9 °C', 'Temp: 7 °C', 'Notes: Door: left open', 'Belt: Worn', 'Notes: again']);
  assert.deepEqual([...read], [['temp max', '9 °C'], ['temp', '7 °C'], ['notes', 'Door: left open']]);
});

test('a step\'s only ask, unlabelled, takes the first line whole', () => {
  const { asks } = asksOf(['pocket:ask text']);
  assert.deepEqual([...readAnswers(asks, ['Note: the door was open'])], [['', 'Note: the door was open']]);
});

test('for each ask, the newest answer comment counts, and other comments are ignored', () => {
  const { asks } = asksOf(['pocket:ask Temp: number °C 0..5', 'pocket:ask Seal: yes-no']);
  const note = (id, mins, lines, author = 'You') => ({ id, author, created: new Date(Date.UTC(2026, 9, 14, 9, mins)).toISOString(), lines });
  const got = answersOf(asks, [note(3, 20, ['Temp: 4 °C', 'pocket:answer'], 'Jamie'), note(1, 10, ['Temp: 7 °C', 'Seal: No', 'pocket:answer']), note(2, 15, ['Temp: 9 °C'])]);
  assert.deepEqual(got.get('temp'), { text: '4 °C', num: 4, off: false, id: 3, author: 'Jamie', created: new Date(Date.UTC(2026, 9, 14, 9, 20)).toISOString() });
  assert.equal(got.get('seal').text, 'No', 'an answer stays until a newer comment answers the same ask');
});

test('an answer comment has a paragraph for each answer in the asks\' order, then pocket:answer', () => {
  const { asks } = asksOf(['pocket:ask Temp: number °C', 'pocket:ask Belt: choice <5 | Salt & pepper']);
  assert.equal(answerHtml(asks, new Map([['belt', 'Salt & pepper'], ['temp', '7 °C']])), '<p>Temp: 7 °C</p><p>Belt: Salt &amp; pepper</p><p>pocket:answer</p>');
  assert.equal(answerHtml(asksOf(['pocket:ask number']).asks, new Map([['', '3']])), '<p>3</p><p>pocket:answer</p>');
  assert.equal(answerHtml(asks, new Map()), '');
});

test('the asks editor turns each row into the line it saves as, which reads back as the same ask', () => {
  const rows = [{ label: 'Temp', type: 'number', unit: '°C', low: '0', high: '5,5', options: '' }, { label: ' Seal  intact ', type: 'yes-no', unit: '', low: '', high: '', options: '' },
    { label: 'Belt', type: 'choice', unit: '', low: '', high: '', options: 'Good\n\n Worn \nReplace' }, { label: 'Freezer', type: 'number', unit: '', low: '−18', high: '', options: '' }];
  const made = askLines(rows);
  assert.deepEqual(made.map(m => m.line), ['pocket:ask Temp: number °C 0..5.5', 'pocket:ask Seal intact: yes-no', 'pocket:ask Belt: choice Good | Worn | Replace', 'pocket:ask Freezer: number -18..']);
  const back = asksOf(made.map(m => m.line)).asks;
  assert.deepEqual(askLines(askRows(back)).map(m => m.line), made.map(m => m.line), 'an ask read back and edited again saves as the same line');
});

test('the asks editor says what keeps a row from being saved', () => {
  const row = f => ({ label: 'Temp', type: 'number', unit: '', low: '', high: '', options: '', ...f });
  const problem = rows => askLines(rows).map(m => m.problem || '');
  assert.deepEqual(problem([row({ low: '5', high: '1' })]), ['The range starts above where it ends']);
  assert.deepEqual(problem([row({ low: 'cold' })]), ['The expected range must be numbers']);
  assert.deepEqual(problem([row({ label: 'Temp: top' })]), ['A label can\'t contain “: ”']);
  assert.deepEqual(problem([row({ type: 'choice', options: 'Good|ish\nBad' })]), ['An option can\'t contain “|”']);
  assert.deepEqual(problem([row({ type: 'choice', options: 'Good\ngood' })]), ['A choice needs at least two different options']);
  assert.deepEqual(problem([row({}), row({ label: 'temp' })]), ['', 'Another ask is labelled “temp”']);
  assert.deepEqual(problem([row({ label: '' }), row({ label: 'Seal' })]), ['Give each ask a label when a step has several', '']);
  assert.deepEqual(problem([row({ label: '' })]), [''], 'a step\'s only ask may have no label');
});

test('a checklist step\'s row shows its asks until one is answered, then its answers, amber outside the range, and what a done step left unrecorded', () => {
  const { asks } = asksOf(['pocket:ask Temp: number °C 0..5', 'pocket:ask Seal: yes-no']);
  assert.deepEqual(askMeta({ asks, answers: {}, done: false }), [{ key: 'asks', cls: 'note-mark', icon: 'comment', text: 'Asks: Temp, Seal' }]);
  assert.deepEqual(askMeta({ asks, answers: { temp: { text: '7 °C', off: true } }, done: false }), [{ key: 'ans0', cls: 'ans off', text: 'Temp 7 °C' }]);
  assert.deepEqual(askMeta({ asks, answers: { seal: { text: 'No', off: false } }, done: true }).map(m => m.text), ['Temp not recorded', 'Seal No']);
  assert.equal(asksText(asksOf(['pocket:ask number °C']).asks), 'Asks: a number');
  assert.deepEqual(askMeta({ asks: [], done: true }), []);
});

// A step on a checklist's card that asks for Temp and Seal, with Temp answered 4 °C by someone else.
const cardStep = () => {
  const app = component(asksPart), { asks } = asksOf(['pocket:ask Temp: number °C 0..5', 'pocket:ask Seal: yes-no']);
  app.runDrafts = {};
  return { app, s: { id: 7, done: false, asks, answers: { temp: { text: '4 °C', num: 4, off: false, author: 'Jamie', mine: false, created: new Date().toISOString() } } } };
};
const temp = s => s.asks[0], seal = s => s.asks[1];

test('a field shows the answer that counts until something is typed, and only what differs from it is unsent', () => {
  const { app, s } = cardStep();
  assert.deepEqual([app.askDraft(s, temp(s)), app.askDraft(s, seal(s))], ['4', ''], 'a number shows without its unit');
  assert.equal(app.unsentAnswers(s).size, 0);
  app.setAsk(s, temp(s), '4');
  assert.equal(app.unsentAnswers(s).size, 0, 'typing the answer that counts again sends nothing');
  app.setAsk(s, temp(s), '7,5'); app.pickAsk(s, seal(s), 'No');
  assert.deepEqual([...app.unsentAnswers(s)], [['temp', '7.5 °C'], ['seal', 'No']]);
  assert.equal(app.saveLabel(s), 'Save 2 answers');
  app.pickAsk(s, seal(s), 'No');
  assert.deepEqual([app.askDraft(s, seal(s)), app.saveLabel(s)], ['', 'Save answer'], 'tapping the picked option again clears it');
  app.setAsk(s, temp(s), 'warm');
  assert.deepEqual([app.unsentAnswers(s).size, app.askNote(s, temp(s))], [0, { text: "Not a number, so it isn't saved", cls: 'bad' }]);
});

test('± turns a number negative and back, and shows only where a number may be below zero', () => {
  const { app, s } = cardStep();
  app.setAsk(s, temp(s), '3'); app.flipAsk(s, temp(s));
  assert.equal(app.askDraft(s, temp(s)), '-3');
  app.flipAsk(s, temp(s));
  assert.equal(app.askDraft(s, temp(s)), '3');
  assert.deepEqual([app.askSigned(temp(s)), app.askSigned(parseAsk('number ..5')), app.askSigned(parseAsk('number -18..-15'))], [false, true, true]);
});

test('beside each label is who recorded the answer that counts, or that a done step has none', () => {
  const { app, s } = cardStep();
  assert.match(app.askBy(s, temp(s)), /^Jamie · /);
  assert.equal(app.askBy(s, seal(s)), '', "an open step's missing answer says nothing");
  assert.equal(app.askBy({ ...s, done: true }, seal(s)), 'Not recorded');
  assert.equal(app.askBy({ ...s, answers: { temp: { ...s.answers.temp, waiting: true } } }, temp(s)), 'Waiting to send');
});

test('Done sends the unsent answers as their own comment before the tick and the typed comment, and Skip sends none', async () => {
  const { app, s } = cardStep(), sent = [];
  Object.defineProperties(app, Object.getOwnPropertyDescriptors(runs));
  Object.defineProperty(app, 'runView', { value: null });
  Object.assign(app, { view: { shownRun: { id: 1 } }, user: { id: 1 }, unlockSound(){}, act: async f => { sent.push(f); return { status: 'sent' }; } });
  app.runDrafts = { '7:temp': '7.5', 7: 'Door was open' };
  await app.tickStep(s, 'skip', true);
  assert.deepEqual(sent.map(f => f.op), ['skip']);
  assert.equal(app.runDrafts['7:temp'], '7.5', 'a skip keeps what was typed in the fields');
  sent.length = 0;
  await app.tickStep(s, 'done', true);
  assert.deepEqual(sent.map(f => [f.op, f.html]), [['answer', '<p>Temp: 7.5 °C</p><p>pocket:answer</p>'], ['done', '']]);
  assert.equal('7:temp' in app.runDrafts, false, 'the field shows the answer that counts again');
});
