'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { Run, sendReport, passed } = require('./chaoxing-unified.user.js');
const nap = ms => new Promise(resolve => setTimeout(resolve, ms));

function fixture(handler) {
  class XHR extends EventTarget {
    open(method, url) { this.url = url; }
  }
  const original = XHR.prototype.open;
  const plugin = { name: 'actual plugin instance' };
  const opts = {
    isSendLog: true,
    sendLog(...args) { assert.equal(this, opts); handler(XHR, args); }
  };
  const player = {
    el: () => ({ ownerDocument: { defaultView: { XMLHttpRequest: XHR } } }),
    options_: { plugins: { seekBarControl: opts } },
    usingPlugin: name => name === 'seekBarControl',
    seekBarControl: () => plugin
  };
  return { XHR, original, plugin, opts, player };
}

test('Stop cancels a long wait immediately', async () => {
  const run = new Run();
  const result = assert.rejects(run.wait(60000), { name: 'AbortError' });
  run.stop();
  await result;
});

test('Paused time is excluded and Stop works while paused', async () => {
  const run = new Run();
  run.pause();
  const elapsed = run.elapsed;
  await nap(30);
  assert.equal(run.elapsed, elapsed);
  const result = assert.rejects(run.gate(), { name: 'AbortError' });
  run.stop();
  await result;
});

test('Resume releases the pause gate', async () => {
  const run = new Run();
  run.pause();
  let finished = false;
  const pending = run.wait(10).then(() => { finished = true; });
  await nap(30);
  assert.equal(finished, false);
  run.resume();
  await pending;
  assert.equal(finished, true);
});

test('Changing the document stops a run', async () => {
  const run = new Run();
  run.guard = () => false;
  await assert.rejects(run.gate(), /页面已切换/);
});

test('Native sendLog argument order and scoped response capture', async () => {
  let args;
  const f = fixture((XHR, a) => {
    args = a;
    const req = new XHR();
    req.open('GET', '/multimedia/log/a');
    req.responseText = '{"isPassed":true}';
    setTimeout(() => req.dispatchEvent(new Event('load')), 10);
  });
  const result = await sendReport(f.player, 'ended', 42.3, new Run(), 200);
  assert.equal(args[0], f.player);
  assert.equal(args[1], 'ended');
  assert.equal(args[2], 42);
  assert.equal(args[3], f.plugin);
  assert.equal(result.isPassed, true);
  assert.equal(f.XHR.prototype.open, f.original);
});

test('sendLog exception always restores open', async () => {
  const f = fixture(() => { throw new Error('synthetic failure'); });
  const result = await sendReport(f.player, 'ended', 42, new Run(), 200);
  assert.equal(result.unavailable, true);
  assert.equal(f.XHR.prototype.open, f.original);
});

test('Stop releases a pending report and its lock', async () => {
  const f = fixture(() => {});
  const run = new Run();
  const request = sendReport(f.player, 'ended', 42, run, 60000);
  await nap(0);
  const check = assert.rejects(request, { name: 'AbortError' });
  run.stop();
  await check;
  assert.equal(f.XHR.prototype.open, f.original);
  assert.equal((await sendReport(f.player, 'ended', 42, new Run(), 15)).isPassed, false);
});

test('Overlapping reports are rejected without replacing another wrapper', async () => {
  const f = fixture(() => {});
  const run = new Run();
  const first = sendReport(f.player, 'ended', 42, run, 60000);
  await nap(0);
  await assert.rejects(sendReport(f.player, 'ended', 42, new Run(), 200), /已有上报请求/);
  const check = assert.rejects(first, { name: 'AbortError' });
  run.stop();
  await check;
  assert.equal(f.XHR.prototype.open, f.original);
});

test('Timeout / malformed response never means completed', async () => {
  const f = fixture((XHR) => {
    const req = new XHR(); req.open('GET', '/multimedia/log/a');
    req.responseText = '<html>login</html>';
    setTimeout(() => req.dispatchEvent(new Event('load')), 5);
  });
  const result = await sendReport(f.player, 'ended', 42, new Run(), 200);
  assert.equal(result.isPassed, false);
  assert.equal(f.XHR.prototype.open, f.original);
});

test('Unrelated requests cannot satisfy a report', async () => {
  const f = fixture(XHR => {
    const req = new XHR(); req.open('GET', '/unrelated');
    req.responseText = '{"isPassed":true}';
    setTimeout(() => req.dispatchEvent(new Event('load')), 5);
  });
  const result = await sendReport(f.player, 'ended', 42, new Run(), 20);
  assert.equal(result.isPassed, false);
});

test('Other extensions changing open are preserved', async () => {
  let replacement;
  const f = fixture(XHR => { replacement = function () {}; XHR.prototype.open = replacement; });
  await sendReport(f.player, 'ended', 42, new Run(), 15);
  assert.equal(f.XHR.prototype.open, replacement);
});

test('Completion flags normalize values without accepting false strings', () => {
  for (const value of [true, 1, '1', 'true']) assert.equal(passed(value), true);
  for (const value of [false, 0, '0', 'false', undefined, null, {}]) assert.equal(passed(value), false);
});
