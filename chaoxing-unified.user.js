// ==UserScript==
// @name         超星学习通自动刷任务点 统一版
// @namespace    https://github.com/custom/chaoxing-unified
// @version      2.1.5
// @description  学习控制、PPT 末页、按需英语翻译；可暂停、可停止、进度队列、运行日志。
// @author       Custom
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy?*
// @match        https://mooc1.chaoxing.com/mooc-ans/mycourse/studentstudy?*
// @match        https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?*
// @grant        GM_getValue
// @grant        GM_setValue
// @grant        GM_xmlhttpRequest
// @grant        GM_openInTab
// @connect      *
// @noframes
// @run-at       document-end
// ==/UserScript==

(function () {
  'use strict';

  // Every wait, including a paused wait, belongs to one cancellable run.
  const abortError = () => new DOMException('已停止', 'AbortError');
  function delay(ms, signal) {
    return new Promise((resolve, reject) => {
      if (signal.aborted) { reject(abortError()); return; }
      const end = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); resolve(); };
      const cancel = () => { clearTimeout(timer); signal.removeEventListener('abort', cancel); reject(abortError()); };
      const timer = setTimeout(end, ms);
      signal.addEventListener('abort', cancel, { once: true });
    });
  }
  class Run {
    constructor() {
      this.controller = new AbortController();
      this.signal = this.controller.signal;
      this.started = performance.now();
      this.pausedAt = null;
      this.pausedMs = 0;
      this.guard = null;
    }
    get paused() { return this.pausedAt !== null; }
    get elapsed() { return (this.pausedAt ?? performance.now()) - this.started - this.pausedMs; }
    pause() { if (!this.paused) this.pausedAt = performance.now(); }
    resume() {
      if (this.paused) { this.pausedMs += performance.now() - this.pausedAt; this.pausedAt = null; }
    }
    stop() { this.controller.abort(); }
    check() {
      if (this.signal.aborted) throw abortError();
      if (this.guard && !this.guard()) throw new Error('页面已切换，本次运行已结束；可在新页面重新开始');
    }
    async gate() {
      this.check();
      while (this.paused) { await delay(100, this.signal); this.check(); }
      this.check();
    }
    async wait(ms, tick) {
      const end = this.elapsed + ms;
      do {
        await this.gate();
        const remaining = end - this.elapsed;
        if (remaining <= 0) break;
        if (tick) tick(remaining);
        await delay(Math.min(200, remaining), this.signal);
      } while (true);
      await this.gate();
    }
  }

  const reportLocks = new WeakSet();
  function parseReport(raw) {
    try {
      const value = typeof raw === 'string' ? JSON.parse(raw) : raw;
      return value && typeof value === 'object' ? value : null;
    } catch { return null; }
  }
  function passed(value) { return value === true || value === 1 || value === 'true' || value === '1'; }

  // Capture only the XHR synchronously opened by this sendLog invocation.
  // Never keep a global XHR wrapper installed between requests.
  async function sendReport(player, event, position, run, timeout = 7000) {
    await run.gate();
    const win = player.el().ownerDocument.defaultView;
    const proto = win.XMLHttpRequest.prototype;
    const opts = player.options_?.plugins?.seekBarControl;
    if (typeof opts?.sendLog !== 'function' || opts.isSendLog !== true ||
        !player.usingPlugin?.('seekBarControl')) {
      return { unavailable: true, reason: '播放器上报接口不兼容，改用正常播放' };
    }
    if (reportLocks.has(proto)) throw new Error('已有上报请求进行中');
    const plugin = player.seekBarControl();
    const original = proto.open;
    reportLocks.add(proto);
    return new Promise((resolve, reject) => {
      let finished = false, dispatching = false, captured = null;
      let timer;
      const listeners = [];
      function clean() {
        clearTimeout(timer);
        if (proto.open === wrappedOpen) proto.open = original;
        run.signal.removeEventListener('abort', cancel);
        for (const [xhr, type, fn] of listeners) xhr.removeEventListener(type, fn);
        reportLocks.delete(proto);
      }
      function finish(value, error) {
        if (finished) return;
        finished = true;
        clean();
        if (error) reject(error); else resolve(value);
      }
      function cancel() { finish(null, abortError()); }
      function wrappedOpen(method, url, ...rest) {
        if (dispatching && !captured && String(url).includes('multimedia')) {
          captured = this;
          const loaded = () => {
            let body = null;
            try { body = parseReport(this.responseType === 'json' ? this.response : this.responseText); } catch {}
            finish(body || { isPassed: false, reason: '返回内容无法解析' });
          };
          const failed = () => finish({ isPassed: false, reason: '上报请求失败' });
          for (const [type, fn] of [['load', loaded], ['error', failed], ['abort', failed]]) {
            this.addEventListener(type, fn);
            listeners.push([this, type, fn]);
          }
        }
        return original.call(this, method, url, ...rest);
      }
      run.signal.addEventListener('abort', cancel, { once: true });
      timer = setTimeout(() => finish({ isPassed: false, reason: '等待上报响应超时' }), timeout);
      try {
        proto.open = wrappedOpen;
        dispatching = true;
        // Verified on the September 2026 player: (player, event, time, plugin).
        opts.sendLog.call(opts, player, event, Math.round(position), plugin);
      } catch (error) {
        finish({ isPassed: false, unavailable: true, reason: '上报接口异常：' + error.message });
      } finally {
        dispatching = false;
        if (proto.open === wrappedOpen) proto.open = original;
      }
    });
  }

  // Window geometry is independent of course tasks and can be tested offline.
  function floatingRect(rect, viewportWidth, viewportHeight) {
    const clampValue = (value, min, max) => Math.min(max, Math.max(min, value));
    const maxWidth = Math.max(1, viewportWidth - 16), maxHeight = Math.max(1, viewportHeight - 16);
    const width = clampValue(rect.width, Math.min(300, maxWidth), maxWidth);
    const height = clampValue(rect.height, Math.min(240, maxHeight), maxHeight);
    return { x: clampValue(rect.x, 8, Math.max(8, viewportWidth - width - 8)),
      y: clampValue(rect.y, 8, Math.max(8, viewportHeight - height - 8)), width, height };
  }
  function resizedFloatingRect(box, direction, dx, dy, viewportWidth, viewportHeight) {
    const rect = floatingRect(box, viewportWidth, viewportHeight);
    const clampValue = (value, min, max) => Math.min(max, Math.max(min, value));
    const right = rect.x + rect.width, bottom = rect.y + rect.height;
    const minWidth = Math.min(300, Math.max(1, viewportWidth - 16));
    const minHeight = Math.min(240, Math.max(1, viewportHeight - 16));
    if (direction.includes('e')) rect.width = clampValue(rect.width + dx, minWidth, viewportWidth - rect.x - 8);
    if (direction.includes('s')) rect.height = clampValue(rect.height + dy, minHeight, viewportHeight - rect.y - 8);
    if (direction.includes('w')) { rect.width = clampValue(rect.width - dx, minWidth, right - 8); rect.x = right - rect.width; }
    if (direction.includes('n')) { rect.height = clampValue(rect.height - dy, minHeight, bottom - 8); rect.y = bottom - rect.height; }
    return rect;
  }
  function floatingShortcut(event) {
    if (!event.altKey || event.ctrlKey || event.metaKey) return null;
    if (event.shiftKey && event.code === 'KeyC') return 'visibility';
    if (event.code === 'NumpadAdd' || event.key === '+' || (!event.shiftKey && event.code === 'Equal')) return 'grow';
    if (event.code === 'NumpadSubtract' || (!event.shiftKey && (event.key === '-' || event.code === 'Minus'))) return 'shrink';
    return null;
  }

  // MyMemory accepts at most 500 UTF-8 bytes per query, not 500 characters.
  function translationByteChunks(text, maxBytes = 450) {
    if (!Number.isInteger(maxBytes) || maxBytes < 4) throw new RangeError('Invalid translation byte limit');
    const encoder = new TextEncoder(), chunks = [];
    let current = '', bytes = 0;
    for (const char of String(text)) {
      const size = encoder.encode(char).length;
      if (bytes + size > maxBytes) {
        let boundary = -1;
        for (let i = 0; i < current.length; i++) if (/\s/.test(current[i])) boundary = i + 1;
        const cut = boundary >= current.length * 0.6 ? boundary : current.length;
        chunks.push(current.slice(0, cut)); current = current.slice(cut);
        bytes = encoder.encode(current).length;
      }
      current += char; bytes += size;
    }
    if (current) chunks.push(current);
    return chunks;
  }

  function nativeProgressPercent(loaded, total) {
    const n = Number(loaded), d = Number(total);
    if (!Number.isFinite(n) || !Number.isFinite(d) || d <= 0) return null;
    return Math.max(0, Math.min(100, Math.round(n / d * 100)));
  }
  function nativeTranslationStatusLabel(status, percent = null) {
    if (status === 'available') return '本地翻译已就绪';
    if (status === 'downloadable') return '点击翻译时自动准备本地模型';
    if (status === 'downloading') return percent == null ? '正在准备本地翻译模型…' : '正在准备本地翻译模型 ' + percent + '%';
    if (status === 'unavailable') return '当前 Edge 不支持本地英中翻译';
    if (status === 'error') return '本地翻译准备失败，可打开手工指引';
    return '正在检查本地翻译能力…';
  }

  // The same cancellation/report code is exercised by node --test.
  if (typeof document === 'undefined') {
    if (typeof module !== 'undefined') module.exports = { Run, delay, sendReport, parseReport, passed, floatingRect, resizedFloatingRect, floatingShortcut, translationByteChunks, nativeProgressPercent, nativeTranslationStatusLabel };
    return;
  }
  if (window.top !== window.self) return;
  window.__CX_UNIFIED_V2__?.destroy();
  window.__CX_UNIFIED_MERGED__ = true;
  const VERSION = '2.1.5';
  const STORAGE = 'cx-unified:v2:settings';
  const RESUME = 'cx-unified:v2:continuation';
  const defaults = {
    mode: 'smart', speed: 2, autoNext: true, autoStart: false,
    muted: false, stepInterval: 60, maxVideoMin: 60, retries: 1,
    minimized: false, hidden: false, position: null, width: 420, height: 560, theme: 'light'
  };
  const read = (store, key) => { try { return JSON.parse(store.getItem(key) || 'null'); } catch { return null; } };
  const clamp = (v, min, max) => Math.max(min, Math.min(max, v));
  const number = (v, fallback, min, max) => Number.isFinite(Number(v)) ? clamp(Number(v), min, max) : fallback;
  function normalize(raw) {
    raw = raw && typeof raw === 'object' ? raw : {};
    const out = { ...defaults };
    for (const key of ['autoNext', 'autoStart', 'muted', 'minimized', 'hidden']) if (typeof raw[key] === 'boolean') out[key] = raw[key];
    out.mode = raw.mode === 'natural' ? 'natural' : 'smart';
    out.speed = [0.75, 1, 1.25, 1.5, 2, 3].includes(raw.speed) ? raw.speed : defaults.speed;
    out.stepInterval = number(raw.stepInterval, 60, 10, 180);
    out.maxVideoMin = number(raw.maxVideoMin, 60, 5, 240);
    out.retries = Math.round(number(raw.retries, 1, 0, 2));
    out.theme = raw.theme === 'dark' ? 'dark' : 'light';
    if (Number.isFinite(raw.position?.x) && Number.isFinite(raw.position?.y)) out.position = raw.position;
    out.width = number(raw.width, defaults.width, 300, Number.MAX_SAFE_INTEGER);
    out.height = number(raw.height, defaults.height, 240, Number.MAX_SAFE_INTEGER);
    return out;
  }
  const cfg = normalize(read(localStorage, STORAGE));
  const save = () => { try { localStorage.setItem(STORAGE, JSON.stringify(cfg)); } catch {} };
  const q = (selector, root = document) => root?.querySelector(selector);
  const qa = (selector, root = document) => Array.from(root?.querySelectorAll(selector) || []);
  const safe = (fn, fallback = null) => { try { return fn() ?? fallback; } catch { return fallback; } };
  const visible = el => !!el?.getClientRects().length && getComputedStyle(el).visibility !== 'hidden';
  const fmt = value => {
    if (!Number.isFinite(value)) return '--:--';
    value = Math.max(0, Math.floor(value));
    return (value >= 3600 ? Math.floor(value / 3600) + ':' : '') +
      String(Math.floor(value / 60) % 60).padStart(2, '0') + ':' + String(value % 60).padStart(2, '0');
  };
  const cardDoc = () => safe(() => q('#iframe').contentDocument);
  const arg = () => safe(() => cardDoc().defaultView.mArg);
  const parts = () => qa('#prev_tab .prev_ul li');
  const activePart = () => Math.max(0, parts().findIndex(el => el.classList.contains('active')));
  const course = () => new URLSearchParams(location.search).get('courseId') || String(arg()?.defaults?.courseid || '');
  function cardKey() {
    const src = q('#iframe')?.getAttribute('src');
    const url = safe(() => new URL(src, location.href));
    return [course(), url?.searchParams.get('knowledgeid') ||
      new URLSearchParams(location.search).get('chapterId') || '', url?.searchParams.get('num') || activePart()].join(':');
  }
  const objectId = a => String(a.objectId || a.property?.objectid || '');
  const media = a => ['video', 'audio'].includes(a.type) || ['insertvideo', 'insertaudio'].includes(a.property?.module);
  const playerFor = frame => safe(() => frame.contentWindow.videojs?.getAllPlayers().find(p => !p.isDisposed?.()));
  const state = {
    run: null, promise: null, active: null, phase: '准备就绪', detail: '点击开始，按队列处理当前章节',
    status: 'idle', logs: [], confirmed: new Set(), failures: new Map(),
    elapsed: 0, timer: null, startup: null, countdown: '', destroyed: false, unloading: false, queueSignature: '', focusKey: null,
    translation: { eligible: false, page: 'learning', source: '', result: '', status: '等待检测', busy: false, lastKey: '', nativeStatus: 'unknown', nativePercent: null, nativeError: '' }
  };
  let host, root;
  function log(message, level = 'info') {
    const item = { time: new Date().toLocaleTimeString('zh-CN', { hour12: false }), message: String(message), level };
    state.logs.push(item);
    if (state.logs.length > 160) state.logs.shift();
    console[level === 'error' ? 'warn' : 'log']('[CX v2]', item.message);
    renderLogs();
  }
  function phase(title, detail = '') { state.phase = title; state.detail = detail; render(); }
  function taskList() {
    const d = cardDoc(), data = arg();
    if (!d || !data) return [];
    const frames = qa('iframe.ans-attach-online', d);
    const map = new Map(frames.map(frame => {
      let data = {};
      try { data = JSON.parse(frame.getAttribute('data') || '{}'); } catch {}
      return [String(data.objectid || ''), frame];
    }));
    return (data.attachments || []).filter(media).map((a, index) => {
      const frame = map.get(objectId(a));
      const container = frame?.closest('.ans-attach-ct') || frame?.parentElement;
      const key = cardKey() + ':' + (a.jobid || a.property?.jobid || objectId(a) || index);
      const isTask = !!(a.job || a.jobid || a.property?.jobid || q('.ans-job-icon', container));
      const done = passed(a.isPassed) || container?.classList.contains('ans-job-finished') || state.confirmed.has(key);
      return { key, att: a, frame, container, player: playerFor(frame), name: a.property?.name || a.name || '媒体 ' + (index + 1), isTask, done };
    });
  }
  function threshold(task) {
    const text = task?.container?.innerText || cardDoc()?.body?.innerText || '';
    const match = text.match(/观看时长[^%]*?(\d+(?:\.\d+)?)\s*%/);
    return match ? clamp(Number(match[1]) / 100, 0.01, 1) : null;
  }
  function isDone(task) {
    return state.confirmed.has(task.key) || taskList().find(t => t.key === task.key)?.done === true;
  }
  function pauseMedia() {
    for (const task of taskList()) safe(() => task.player?.pause());
    safe(() => state.active?.player?.pause());
  }
  function cancelStartup() { clearTimeout(state.startup); state.startup = null; }
  function clearContinuation() { try { sessionStorage.removeItem(RESUME); } catch {} }
  function continuation() {
    try { sessionStorage.setItem(RESUME, JSON.stringify({ course: course(), at: Date.now() })); } catch {}
  }
  function stop(message = '已停止') {
    cancelStartup();
    clearContinuation();
    state.run?.stop();
    pauseMedia();
    state.status = 'idle';
    state.countdown = '';
    phase(message, '播放已暂停，可以重新开始');
  }
  function togglePause() {
    const run = state.run;
    if (!run || run.signal.aborted) return;
    if (run.paused) {
      run.resume();
      state.status = 'running';
      const player = state.active?.player;
      if (player && !safe(() => player.ended(), true)) {
        applyPlayback(player);
        safe(() => player.play()?.catch(error => log('恢复播放失败：' + error.message, 'warn')));
      }
      log('继续运行');
    } else {
      run.pause();
      state.status = 'paused';
      pauseMedia();
      log('已暂停；计时和后续步骤一起暂停');
    }
    render();
  }
  async function waitReady(run, previousDoc = null, timeout = 30000) {
    const start = run.elapsed;
    while (run.elapsed - start < timeout) {
      await run.gate();
      const d = cardDoc();
      if (d && d !== previousDoc && d.readyState === 'complete' && arg()) return d;
      await run.wait(250);
    }
    throw new Error('等待课件加载超时，请检查页面后重新开始');
  }
  async function readyPlayer(task, run) {
    const start = run.elapsed;
    while (run.elapsed - start < 20000) {
      await run.gate();
      task.player = playerFor(task.frame);
      if (task.player) return task.player;
      await run.wait(300);
    }
    throw new Error('播放器未就绪：' + task.name);
  }
  function applyPlayback(player) {
    safe(() => player.playbackRate(cfg.speed));
    safe(() => player.muted(cfg.muted));
  }
  async function play(player, run) {
    await run.gate();
    applyPlayback(player);
    let rejected = null;
    try {
      // Do not block Stop on a pending HTMLMediaElement.play() promise.
      const pending = player.play();
      if (pending?.catch) pending.catch(error => { rejected = error; });
    } catch (error) { rejected = error; }
    await run.wait(700);
    if (rejected || player.paused()) throw new Error('播放器未开始播放，请处理页面提示或手动点击视频播放，再按开始');
  }
  async function report(task, event, position, run) {
    const result = await sendReport(task.player, event, position, run);
    run.check();
    if (passed(result.isPassed)) {
      state.confirmed.add(task.key);
      log('服务器确认完成：' + task.name, 'success');
      return true;
    }
    if (result.reason) log(result.reason, 'warn');
    return result.unavailable ? null : false;
  }
  async function processMedia(task, run) {
    state.active = task;
    state.focusKey = task.key;
    phase('加载播放器', task.name);
    const player = await readyPlayer(task, run);
    await play(player, run);
    const metadataStart = run.elapsed;
    let duration = player.duration();
    while (!Number.isFinite(duration) || duration <= 0) {
      if (run.elapsed - metadataStart > 20000) throw new Error('视频时长加载超时，请检查网络');
      await run.wait(300);
      duration = player.duration();
    }
    const start = run.elapsed;
    const expired = () => {
      if (run.elapsed - start > cfg.maxVideoMin * 60000) throw new Error('单个视频处理超时：' + task.name);
    };
    const target = duration * (threshold(task) || 0.90);
    let canReport = cfg.mode === 'smart';
    log('开始：' + task.name + ' · ' + fmt(duration));
    if (cfg.mode === 'smart') {
      phase('快速尝试', '等待服务器确认');
      const fast = await report(task, 'ended', duration, run);
      if (fast === true || isDone(task)) return;
      if (fast === null) canReport = false;
      if (fast !== null) {
        log('快速尝试未通过，进入渐进尝试', 'warn');
        for (const fraction of [0.25, 0.5, 0.75, 0.9, 1]) {
          await run.gate();
          expired();
          if (isDone(task)) return;
          if (player.paused()) await play(player, run);
          phase('渐进尝试 · ' + Math.round(fraction * 100) + '%', '等待服务器确认');
          const result = await report(task, fraction === 1 ? 'ended' : 'playing', duration * fraction, run);
          if (result === true || isDone(task)) return;
          if (result === null) { canReport = false; break; }
          if (fraction < 1) {
            await run.wait(cfg.stepInterval * 1000, left => {
              state.countdown = '下次尝试 ' + Math.ceil(left / 1000) + ' 秒';
            });
          }
        }
      }
      state.countdown = '';
      log('转入正常播放；按实际进度等待任务状态更新');
    }
    phase('正常播放', '播放进度达到参考门槛后，仍需平台确认任务完成');
    if (!player.ended() && player.paused()) await play(player, run);
    let nextEnded = 0, lastPosition = player.currentTime(), stalledAt = run.elapsed, pauseRetries = 0;
    while (true) {
      await run.gate();
      expired();
      if (isDone(task)) return;
      const current = player.currentTime();
      if (player.error?.()) throw new Error('播放器报告错误，请检查网络或刷新页面');
      if (current > lastPosition + 0.25) {
        stalledAt = run.elapsed;
        lastPosition = current;
        pauseRetries = 0;
      }
      if (canReport && current >= target && run.elapsed >= nextEnded) {
        nextEnded = run.elapsed + 120000;
        if (await report(task, 'ended', duration, run) === true || isDone(task)) return;
      }
      if (player.ended()) {
        phase('等待完成状态', '视频已播完，等待平台更新（最多 15 秒）');
        const end = run.elapsed + 15000;
        while (run.elapsed < end) { if (isDone(task)) return; await run.wait(500); }
        throw new Error('视频已播放完，但平台尚未确认完成');
      }
      if (player.paused()) {
        if (++pauseRetries > 2) throw new Error('播放器连续被暂停，请先处理页面中的提示');
        await play(player, run);
        stalledAt = run.elapsed;
      }
      if (run.elapsed - stalledAt > 90000) throw new Error('播放进度超过 90 秒未变化，请检查网络或页面提示');
      await run.wait(700);
    }
  }

  function unfinishedOtherTasks() {
    const tasks = taskList();
    return qa('.ans-job-icon', cardDoc()).filter(icon => {
      const container = icon.closest('.ans-attach-ct') || icon.parentElement;
      if (container?.classList.contains('ans-job-finished')) return false;
      return !tasks.some(task => task.container === container && task.done);
    }).length;
  }
  async function processCard(run) {
    const d = await waitReady(run);
    await scrollPptToEndBeforeStart(run);
    const key = cardKey();
    run.guard = () => cardDoc() === d && cardKey() === key;
    const tasks = taskList().filter(t => t.isTask);
    if (!tasks.length) log('当前分段没有音视频任务点');
    for (const task of tasks) {
      if (isDone(task)) continue;
      let success = false;
      for (let attempt = 0; attempt <= cfg.retries; attempt++) {
        await run.gate();
        try {
          await processMedia(task, run);
          success = true;
          break;
        } catch (error) {
          if (error.name === 'AbortError') throw error;
          run.check();
          state.failures.set(task.key, error.message);
          log(error.message, 'error');
          if (attempt === cfg.retries) throw error;
          phase('等待重试', '第 ' + (attempt + 1) + '/' + cfg.retries + ' 次重试，5 秒后执行');
          await run.wait(5000);
        } finally {
          safe(() => task.player?.pause());
          state.countdown = '';
        }
      }
      if (success) {
        state.failures.delete(task.key);
        log('本任务处理完成：' + task.name, 'success');
      }
      state.active = null;
    }
    if (unfinishedOtherTasks()) throw new Error('本分段仍有未完成任务，请检查测验、文档或平台状态后继续');
    run.guard = null;
  }
  async function switchPart(index, run) {
    if (index === activePart()) return;
    const item = parts()[index];
    if (!item) throw new Error('找不到该分段，请刷新列表');
    await run.gate();
    run.guard = null;
    const previous = cardDoc();
    pauseMedia();
    phase('切换分段', '正在加载第 ' + (index + 1) + ' 段');
    item.click();
    await waitReady(run, previous);
    log('已进入第 ' + (index + 1) + ' 段');
  }
  function nextButton() {
    return qa('#prevNextFocusNext,.nextChapter,.prev_next.next').find(el =>
      visible(el) && el.getAttribute('aria-disabled') !== 'true' && !el.classList.contains('disabled'));
  }
  async function nextChapter(run, keepRunning) {
    await run.gate();
    const button = nextButton();
    if (!button) { log('没有可用的下一节按钮'); return false; }
    run.guard = null;
    const old = cardDoc(), key = cardKey();
    phase('切换下一节', '等待新课件加载');
    if (keepRunning) continuation();
    button.click();
    try {
      const start = run.elapsed;
      while (run.elapsed - start < 15000) {
        await run.gate();
        const popup = qa('.jobFinishTip,[class*="jobFinishTip"],#workpop,#hintPop').find(visible);
        if (popup) throw new Error('平台弹窗阻止切换，请处理提示后重新开始');
        const d = cardDoc();
        if (d && d !== old && cardKey() !== key && d.readyState === 'complete' && arg()) {
          log('已进入下一节');
          return true;
        }
        await run.wait(300);
      }
      throw new Error('下一节加载超时，已停止自动切换');
    } finally { if (!state.unloading) clearContinuation(); }
  }
  async function main(run) {
    let chapters = 0;
    while (true) {
      await waitReady(run);
      const count = Math.max(1, parts().length);
      for (let index = 0; index < count; index++) {
        await switchPart(index, run);
        await processCard(run);
      }
      chapters++;
      log('本章任务已完成', 'success');
      if (!cfg.autoNext) { phase('本章处理完成', '自动下一节已关闭'); return; }
      if (chapters >= 200) throw new Error('已连续处理 200 章，请检查后重新开始');
      phase('准备下一节', '0.5 秒后切换，可随时暂停或停止');
      await run.wait(500, left => { state.countdown = (left / 1000).toFixed(1) + ' 秒后切换'; });
      state.countdown = '';
      if (!cfg.autoNext) { phase('本章处理完成', '自动下一节已关闭'); return; }
      if (!(await nextChapter(run, true))) { phase('已到课程末尾', '没有可用的下一节'); return; }
    }
  }
  function launch(operation = main) {
    if (state.promise) { log('已有运行任务，请暂停/继续或停止后再开始'); return state.promise; }
    cancelStartup();
    const run = new Run();
    state.run = run;
    state.status = 'running';
    state.elapsed = 0;
    state.countdown = '';
    log('启动 · ' + (cfg.mode === 'smart' ? '快速尝试 → 正常播放' : '正常播放'));
    phase('准备运行', '正在识别课件与任务');
    // Assign the lock before executing any asynchronous page work.
    state.promise = Promise.resolve().then(() => operation(run)).catch(error => {
      if (error.name === 'AbortError') return;
      state.status = 'error';
      phase('需要处理', error.message);
      log(error.message, 'error');
    }).finally(() => {
      pauseMedia();
      state.elapsed = run.elapsed;
      state.active = null;
      state.countdown = '';
      state.run = null;
      state.promise = null;
      if (state.status === 'running' || state.status === 'paused') state.status = 'idle';
      render();
    });
    render();
    return state.promise;
  }

  function viewedTask(tasks = taskList()) {
    return tasks.find(task => task.key === state.focusKey) ||
      tasks.find(task => task.key === state.active?.key) ||
      tasks.find(task => task.isTask && !task.done) || tasks[0] || null;
  }
  function locateTask(task) {
    if (!task?.frame) { log('该视频尚未加载，稍后刷新识别再试', 'warn'); return; }
    state.focusKey = task.key;
    task.frame.scrollIntoView({ behavior: 'smooth', block: 'center' });
    safe(() => task.container?.animate([
      { outline: '3px solid #3265e8', outlineOffset: '4px' },
      { outline: '3px solid transparent', outlineOffset: '4px' }
    ], { duration: 1500 }));
    render();
  }
  function locateAdjacent(direction) {
    const tasks = taskList();
    const index = tasks.findIndex(task => task.key === viewedTask(tasks)?.key);
    const next = index + direction;
    if (index >= 0 && next >= 0 && next < tasks.length) locateTask(tasks[next]);
  }
  function pptViewer() {
    const outer = cardDoc();
    if (!outer) return null;
    const frame = outer.querySelector('iframe.insertdoc-online-ppt, iframe[id^="ext-gen"]');
    const pdf = safe(() => frame?.contentDocument);
    const pan = pdf?.querySelector('#panView');
    const doc = safe(() => pan?.contentDocument);
    const win = safe(() => pan?.contentWindow);
    if (!doc || !win) return null;
    const root = doc.scrollingElement || doc.documentElement || doc.body;
    if (!root || root.scrollHeight <= root.clientHeight) return null;
    return { doc, win, root, pages: doc.querySelectorAll('li[id^="anchor"]').length };
  }
  function scrollPptToEnd() {
    const viewer = pptViewer();
    if (!viewer) {
      log('当前课件没有可滚动的 PPT 阅读器', 'warn');
      return false;
    }
    const target = Math.max(0, viewer.root.scrollHeight - viewer.root.clientHeight);
    viewer.win.scrollTo({ top: target, behavior: 'smooth' });
    viewer.doc.documentElement.scrollTop = target;
    if (viewer.doc.body) viewer.doc.body.scrollTop = target;
    log('PPT 已滚动到末页（共 ' + viewer.pages + ' 页）', 'success');
    return true;
  }
  async function scrollPptToEndBeforeStart(run) {
    let viewer = pptViewer();
    if (!viewer) return false;
    phase('PPT 翻到末页', '开始前自动滚动阅读器');
    let stable = 0, lastMax = -1;
    const deadline = run.elapsed + 15000;
    while (run.elapsed < deadline && stable < 3) {
      await run.gate();
      viewer = pptViewer();
      if (!viewer) return false;
      const max = Math.max(0, viewer.root.scrollHeight - viewer.root.clientHeight);
      viewer.win.scrollTo({ top: max, behavior: 'auto' });
      viewer.doc.documentElement.scrollTop = max;
      if (viewer.doc.body) viewer.doc.body.scrollTop = max;
      await run.wait(250);
      const current = viewer.root.scrollTop;
      const nextMax = Math.max(0, viewer.root.scrollHeight - viewer.root.clientHeight);
      if (Math.abs(current - nextMax) <= 8 && nextMax === lastMax) stable++;
      else stable = 0;
      lastMax = nextMax;
    }
    if (stable < 3) throw new Error('PPT 翻到末页超时，请检查课件阅读器');
    log('开始前已自动翻到 PPT 末页（共 ' + (viewer.pages || 0) + ' 页）', 'success');
    return true;
  }

  const translationStore = (key, fallback) => {
    try { if (typeof GM_getValue === 'function') return GM_getValue(key, fallback); } catch {}
    try { return JSON.parse(localStorage.getItem('cx-merged:' + key) || 'null') ?? fallback; } catch { return fallback; }
  };
  const translationSave = (key, value) => {
    try { if (typeof GM_setValue === 'function') { GM_setValue(key, value); return; } } catch {}
    try { localStorage.setItem('cx-merged:' + key, JSON.stringify(value)); } catch {}
  };
  if (!translationStore('cx_native_engine_migrated', false)) {
    translationSave('cx_engine', 'native');
    translationSave('cx_native_engine_migrated', true);
  }
  function translationApiConfig() { return translationStore('cx_api_config', { url: '', key: '', model: 'deepseek-chat' }); }
  function translationRequest(options) {
    if (typeof GM_xmlhttpRequest === 'function') return new Promise((resolve, reject) => GM_xmlhttpRequest({ ...options, onload: r => r.status >= 200 && r.status < 300 ? resolve(r.responseText) : reject(new Error('HTTP ' + r.status)), onerror: () => reject(new Error('网络请求失败')), ontimeout: () => reject(new Error('请求超时')) }));
    return fetch(options.url, { method: options.method || 'GET', headers: options.headers || {}, body: options.data }).then(r => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); });
  }
  function translationClean(raw) {
    if (!raw) return '';
    let text = String(raw).replace(/\u00a0/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    for (const pattern of [/\bAnswers?\s*:/i, /\b参考答案\b/, /\b答案[：:]/]) { const at = text.search(pattern); if (at > 100) { text = text.slice(0, at).trim(); break; } }
    return text.slice(0, 16000);
  }
  function translationDocs(doc, seen = new Set(), depth = 0) {
    if (!doc || seen.has(doc) || depth > 3) return [];
    seen.add(doc); const out = []; try { if (doc.body?.innerText) out.push(doc.body.innerText); for (const frame of doc.querySelectorAll('iframe')) { try { out.push(...translationDocs(frame.contentDocument, seen, depth + 1)); } catch {} } } catch {}
    return out;
  }
  function translationSource() {
    const direct = translationClean(safe(() => cardDoc()?.body?.innerText, ''));
    if (direct.length >= 30 && englishSignal(direct)) return direct;
    const candidates = translationDocs(document).map(translationClean).filter(text => text.length >= 30 && englishSignal(text));
    candidates.sort((a, b) => b.length - a.length);
    return candidates[0] || direct || '';
  }
  function englishSignal(text) {
    const letters = (text.match(/[A-Za-z]/g) || []).length;
    const words = (text.match(/\b[A-Za-z]{2,}\b/g) || []).length;
    const han = (text.match(/[\u3400-\u9fff]/g) || []).length;
    return letters >= 60 && words >= 8 && (han === 0 || letters >= han * 0.35);
  }
  function translationEngines() { return { native: 'Edge 本地翻译（推荐）', google: 'Google（需梯子）', mymemory: 'MyMemory', customapi: '自定义 API' }; }
  function translationEngine() { return translationStore('cx_engine', 'native'); }
  function translationSetEngine(value) { translationSave('cx_engine', value); }
  function translationParagraphs(text) {
    const raw = text.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean); const result = []; let buf = '';
    for (const part of raw) { buf += (buf ? '\n' : '') + part; if (buf.length >= 900 || part === raw[raw.length - 1]) { result.push(buf); buf = ''; } }
    return result.length ? result : [text];
  }
  const NATIVE_TRANSLATOR_GUIDE = 'https://microsoftedge.github.io/Demos/built-in-ai/playgrounds/translator-api/';
  function nativeAvailabilityTimeout(promise, timeout = 8000) {
    return Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('本地翻译能力检查超时')), timeout))]);
  }
  async function refreshNativeTranslationStatus() {
    const t = state.translation;
    if (typeof Translator !== 'function') { t.nativeStatus = 'unavailable'; t.nativeError = '当前 Edge 未提供 Translator 接口'; render(); return t.nativeStatus; }
    try {
      const value = await nativeAvailabilityTimeout(Translator.availability({ sourceLanguage: 'en', targetLanguage: 'zh-Hans' }));
      t.nativeStatus = value === 'available' ? 'available' : value === 'downloading' ? 'downloading' : value === 'downloadable' ? 'downloadable' : 'unavailable';
      t.nativeError = '';
    } catch (error) { t.nativeStatus = 'error'; t.nativeError = error.message; }
    render(); return t.nativeStatus;
  }
  function openNativeTranslationGuide() {
    try {
      if (typeof GM_openInTab === 'function') { GM_openInTab(NATIVE_TRANSLATOR_GUIDE, { active: true, insert: true, setParent: true }); return; }
    } catch {}
    window.open(NATIVE_TRANSLATOR_GUIDE, '_blank', 'noopener');
  }
  async function translateNativeText(text) {
    if (typeof Translator !== 'function') throw new Error('当前 Edge 不支持本地翻译');
    const t = state.translation;
    t.nativeStatus = 'downloading'; t.nativePercent = 0; t.nativeError = ''; t.status = '正在准备本地翻译模型…'; render();
    const session = await Translator.create({ sourceLanguage: 'en', targetLanguage: 'zh-Hans', monitor(monitor) {
      monitor.addEventListener('downloadprogress', event => {
        t.nativePercent = nativeProgressPercent(event.loaded, event.total);
        t.nativeStatus = t.nativePercent === 100 ? 'available' : 'downloading';
        t.status = nativeTranslationStatusLabel(t.nativeStatus, t.nativePercent); render();
      });
    } });
    t.nativeStatus = 'available'; t.nativePercent = 100; t.status = '本地模型已就绪，正在翻译…'; render();
    const chunks = translationParagraphs(text);
    const out = [];
    for (const part of chunks) { if (part.trim()) out.push(await session.translate(part)); }
    try { session.destroy?.(); } catch {}
    return out.join('\n\n');
  }

  async function translateTextMerged(text) {
    const engine = translationEngine(); const cfg = translationApiConfig();
    if (engine === 'native') return translateNativeText(text);
    async function one(part) {
      if (engine === 'google') { const raw = await translationRequest({ url: 'https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=zh-CN&dt=t&q=' + encodeURIComponent(part) }); return JSON.parse(raw)[0].map(item => item[0]).join(''); }
      if (engine === 'mymemory') { const raw = await translationRequest({ url: 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(part) + '&langpair=en|zh-CN' }); const data = JSON.parse(raw); if (data.responseStatus === 200 && data.responseData) return data.responseData.translatedText; throw new Error(data.responseDetails || '翻译服务返回失败'); }
      if (!cfg.url) throw new Error('请先在 API 设置中填写地址');
      const raw = await translationRequest({ method: 'POST', url: cfg.url, headers: { 'Content-Type': 'application/json', ...(cfg.key ? { Authorization: 'Bearer ' + cfg.key } : {}) }, data: JSON.stringify({ model: cfg.model || 'deepseek-chat', messages: [{ role: 'system', content: '你是专业翻译，将英文翻译为自然流畅的中文。只输出翻译结果。' }, { role: 'user', content: '将以下英文翻译为中文，只输出翻译结果：\n\n' + part }], temperature: 0.3 }) });
      const data = JSON.parse(raw); if (data.choices?.[0]?.message?.content) return data.choices[0].message.content.trim(); throw new Error(data.error?.message || 'API 返回格式异常');
    }
    const chunks = engine === 'mymemory' ? translationByteChunks(text) : translationParagraphs(text);
    const out = []; for (const part of chunks) { if (part.trim()) out.push(await one(part)); } return out.join('\n\n');
  }
  function renderTranslationAvailability() {
    const source = translationSource(); const eligible = englishSignal(source); const t = state.translation;
    t.source = source; t.eligible = eligible;
    const tabs = root?.getElementById('page-tabs'), open = root?.getElementById('translate-open'), tab = root?.getElementById('page-translation');
    if (tabs) tabs.hidden = !eligible; if (open) open.hidden = !eligible; if (tab) tab.hidden = !eligible;
    if (!eligible && t.page === 'translation') t.page = 'learning';
    if (root?.getElementById('translation-detected')) root.getElementById('translation-detected').textContent = eligible ? '检测到英文正文，可按需翻译' : '当前章节没有足够的英文正文';
    renderTranslationPage();
  }
  function renderTranslationPage() {
    if (!root) return; const learning = root.getElementById('learning-view'), page = root.getElementById('translation-page');
    const translation = state.translation.page === 'translation' && state.translation.eligible;
    if (learning) learning.hidden = translation; if (page) page.hidden = !translation;
    root.getElementById('page-learning')?.classList.toggle('active', !translation); root.getElementById('page-translation')?.classList.toggle('active', translation);
    const source = root.getElementById('translation-source'), result = root.getElementById('translation-result');
    if (source && source.textContent !== (state.translation.source || '检测中…')) source.textContent = state.translation.source || '检测中…';
    if (result && state.translation.result) result.textContent = state.translation.result;
    const select = root.getElementById('translation-engine'); if (select && select.value !== translationEngine()) select.value = translationEngine();
    const status = root.getElementById('translation-status'); if (status) { status.textContent = state.translation.status; status.className = 'translation-status' + (state.translation.status.includes('失败') || state.translation.status.includes('请先') ? ' error' : state.translation.status.includes('完成') ? ' ok' : ''); }
    const guide = root.getElementById('translation-native-guide'), note = root.getElementById('translation-native-note');
    const nativeMode = translationEngine() === 'native';
    if (guide) guide.hidden = !nativeMode || !['unavailable', 'error'].includes(state.translation.nativeStatus);
    if (note) { note.hidden = !nativeMode; note.className = 'translation-native-note' + (['unavailable', 'error'].includes(state.translation.nativeStatus) ? ' error' : ''); note.textContent = nativeMode ? nativeTranslationStatusLabel(state.translation.nativeStatus, state.translation.nativePercent) : ''; }
  }
  function openTranslationPage() { renderTranslationAvailability(); if (!state.translation.eligible) { log('当前页面未检测到足够的英文正文', 'warn'); return; } state.translation.page = 'translation'; render(); if (translationEngine() === 'native' && state.translation.nativeStatus === 'unknown') refreshNativeTranslationStatus(); }
  async function runTranslation() {
    if (state.translation.busy) return; const source = translationSource(); state.translation.source = source; state.translation.eligible = englishSignal(source); if (!state.translation.eligible) { state.translation.status = '当前页面没有可翻译的英文正文'; render(); return; }
    state.translation.busy = true; state.translation.status = translationEngine() === 'native' ? '正在准备本地翻译…' : '正在翻译…'; render();
    try { state.translation.result = await translateTextMerged(source); state.translation.status = '翻译完成'; translationSave('cx_last_translation', { url: location.href, source, result: state.translation.result, time: Date.now() }); }
    catch (error) { state.translation.nativeStatus = translationEngine() === 'native' ? 'error' : state.translation.nativeStatus; state.translation.nativeError = error.message; state.translation.status = '翻译失败：' + error.message; }
    finally { state.translation.busy = false; render(); }
  }
  function loadTranslationSettings() { const cfg = translationApiConfig(); root.getElementById('translation-url').value = cfg.url || ''; root.getElementById('translation-key').value = cfg.key || ''; root.getElementById('translation-model').value = cfg.model || 'deepseek-chat'; }
  function saveTranslationSettings() { translationSave('cx_api_config', { url: root.getElementById('translation-url').value.trim(), key: root.getElementById('translation-key').value.trim(), model: root.getElementById('translation-model').value.trim() || 'deepseek-chat' }); state.translation.status = 'API 设置已保存'; render(); }

  function buildUI() {
    host = document.createElement('div');
    host.id = 'cx-unified-v2';
    host.style.cssText = 'all:initial;position:fixed;left:auto;top:96px;right:20px;z-index:2147483645;display:block;box-sizing:border-box';
    root = host.attachShadow({ mode: 'open' });
    root.innerHTML = `
<style>
:host{--bg:#fff;--soft:#f4f7fb;--ink:#202b40;--muted:#6f7b90;--line:#e5eaf2;--accent:#3265e8;--good:#16835c;--warn:#ad6a13;--bad:#c6404a;--shadow:0 14px 50px #22335429;color:var(--ink);font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color-scheme:light}
:host([data-theme=dark]){--bg:#172133;--soft:#202c41;--ink:#e3eaf5;--muted:#a2b0c7;--line:#34425b;--accent:#84a9ff;--good:#6bdbac;--warn:#ffd189;--bad:#ff9ba3;--shadow:0 14px 50px #0006;color-scheme:dark}
*{box-sizing:border-box}button,input,select{font:inherit}button,select,summary,input{accent-color:var(--accent)}
button{border:1px solid var(--line);border-radius:9px;background:var(--bg);color:var(--ink);cursor:pointer;min-height:34px;padding:6px 10px;font-weight:550}
button:hover:not(:disabled){background:var(--soft);border-color:var(--accent)}button:focus-visible,select:focus-visible,summary:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
button:disabled{opacity:.4;cursor:default}button.primary{background:#3265e8;border-color:#3265e8;color:white}button.primary:hover:not(:disabled){background:#2456d7}
button.danger{color:var(--bad)}button.icon{width:30px;min-height:30px;padding:2px;font-size:16px;border:0;background:transparent}
.panel,.mini{font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI","Microsoft YaHei",sans-serif;color:var(--ink)}
.panel{display:flex;flex-direction:column;width:100%;height:100%;min-width:0;min-height:0;max-width:none;max-height:none;overflow:hidden;border:1px solid var(--line);border-radius:16px;background:var(--bg);box-shadow:var(--shadow);scrollbar-width:thin}
.learning-view{flex:1 1 auto;min-height:0;overflow:auto;overscroll-behavior:contain}.learning-view .content{min-height:100%}:host([data-minimized=true]) .resize-handle{display:none}
.head{position:relative;z-index:2;flex:0 0 auto;background:var(--bg);display:flex;align-items:center;gap:9px;padding:10px 12px;cursor:grab;touch-action:none;user-select:none}.head:active{cursor:grabbing}
.mark{width:32px;height:32px;display:grid;place-items:center;border-radius:10px;background:#3265e8;color:#fff;font-size:12px;font-weight:800;letter-spacing:.5px}
.brand{flex:1;min-width:0}.brand strong{font-size:13px;font-weight:700;letter-spacing:.2px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.content{padding:0 15px 12px}.chapter{font-weight:600;line-height:1.65;margin:5px 0 10px;max-height:44px;overflow:hidden}
.statusline{display:flex;justify-content:space-between;align-items:center;gap:8px}.badge{font-size:11px;color:var(--accent);background:var(--soft);padding:3px 8px;border-radius:20px;white-space:nowrap}
.badge[data-status=paused]{color:var(--warn)}.badge[data-status=error]{color:var(--bad)}.subtle{font-size:11px;color:var(--muted)}
.stage{font-size:15px;font-weight:650;margin:8px 0 2px}.detail{font-size:11px;color:var(--muted);min-height:32px;overflow-wrap:anywhere}
.now{margin-top:12px;font-size:12px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.time{display:flex;justify-content:space-between;align-items:baseline;margin:5px 0}
.time strong{font-size:23px;letter-spacing:-.7px;font-variant-numeric:tabular-nums}.time span{font-size:11px;color:var(--muted)}
progress{appearance:none;display:block;width:100%;height:6px;border:0;border-radius:5px;overflow:hidden;background:var(--line);color:var(--accent)}
progress::-webkit-progress-bar{background:var(--line)}progress::-webkit-progress-value{background:var(--accent);border-radius:5px}
.metrics{display:flex;justify-content:space-between;font-size:10px;color:var(--muted);margin:6px 0 10px}.countdown{color:var(--warn);min-height:15px;font-size:11px}
.controls{display:grid;grid-template-columns:1.25fr 1fr 1fr;gap:7px;margin:8px 0}.secondary{display:flex;gap:7px}.secondary button{flex:1;font-size:11px;min-height:30px}
.video-nav{display:grid;grid-template-columns:1fr auto 1fr;align-items:center;gap:8px;margin-top:9px}.video-nav button{font-size:11px;min-height:30px}.view-label{font-size:10px;color:var(--muted);text-align:center}
.queuehead{display:flex;justify-content:space-between;align-items:center;margin:13px 0 5px;font-size:11px;font-weight:600}
.queue{max-height:123px;overflow:auto;scrollbar-width:thin}.task{width:100%;text-align:left;background:transparent;border:0;border-radius:6px;font-weight:400;display:grid;grid-template-columns:20px 1fr auto;align-items:center;gap:6px;padding:7px 0;border-bottom:1px solid var(--line);font-size:11px}
.task:last-child{border-bottom:0}.task.viewing{background:var(--soft)}.task:hover:not(:disabled){background:var(--soft)}.task .name{white-space:nowrap;overflow:hidden;text-overflow:ellipsis}.task .num{width:19px;height:19px;display:grid;place-items:center;border-radius:6px;background:var(--soft);color:var(--muted)}
.task.done .num,.task.done .tag{color:var(--good)}.task.active .num,.task.active .tag{color:var(--accent)}.task.failed .tag{color:var(--bad)}.tag{color:var(--muted);font-size:10px}
details{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}summary{cursor:pointer;font-size:11px;font-weight:600;padding:2px 0;user-select:none}
.settings{display:grid;grid-template-columns:1fr 1fr;gap:9px;margin-top:9px}.settings label{font-size:11px;color:var(--muted)}
.settings .wide{grid-column:1/-1}select,input[type=number]{width:100%;height:31px;border:1px solid var(--line);border-radius:7px;background:var(--soft);color:var(--ink);padding:4px 6px;margin-top:4px}
.check{display:flex;align-items:center;gap:5px}.check input{margin:0;width:14px;height:14px}.settings small{font-size:10px;color:var(--muted)}
.logs{max-height:130px;overflow:auto;scrollbar-width:thin;font:10px/1.65 ui-monospace,Consolas,monospace;user-select:text;margin:8px 0}
.entry{padding:3px 0;overflow-wrap:anywhere;border-bottom:1px solid var(--line)}.entry time{color:var(--muted);margin-right:6px}.entry.warn{color:var(--warn)}.entry.error{color:var(--bad)}.entry.success{color:var(--good)}
.logtools{display:flex;gap:6px}.logtools button{font-size:10px;min-height:26px;padding:3px 8px}
.footer{border-top:1px solid var(--line);display:flex;align-items:center;justify-content:space-between;padding-top:9px;margin-top:10px;font-size:10px;color:var(--muted)}.footer button{border:0;min-height:22px;font-size:10px;padding:1px 0;color:var(--muted)}
.mini{border-radius:30px;box-shadow:var(--shadow);background:var(--bg);padding:10px 14px;border:1px solid var(--line);display:flex;align-items:center;gap:8px;max-width:calc(100vw - 16px);cursor:grab;touch-action:none;user-select:none}
.dot{width:7px;height:7px;border-radius:50%;background:var(--accent)}[hidden]{display:none!important}
.resize-handle{position:absolute;z-index:30;display:block;touch-action:none;user-select:none}.resize-handle.n,.resize-handle.s{left:10px;right:10px;height:8px;cursor:ns-resize}.resize-handle.n{top:-3px}.resize-handle.s{bottom:-3px}.resize-handle.e,.resize-handle.w{top:10px;bottom:10px;width:8px;cursor:ew-resize}.resize-handle.e{right:-3px}.resize-handle.w{left:-3px}.resize-handle.ne,.resize-handle.nw,.resize-handle.se,.resize-handle.sw{width:14px;height:14px}.resize-handle.ne{top:-4px;right:-4px;cursor:nesw-resize}.resize-handle.nw{top:-4px;left:-4px;cursor:nwse-resize}.resize-handle.se{right:-4px;bottom:-4px;cursor:nwse-resize}.resize-handle.sw{left:-4px;bottom:-4px;cursor:nesw-resize}
.page-tabs{flex:0 0 auto;display:flex;gap:5px;padding:8px 15px 0;background:var(--bg);border-bottom:1px solid var(--line)}
.page-tabs button{border:0;border-radius:8px 8px 0 0;min-height:29px;padding:4px 11px;font-size:11px;background:transparent;color:var(--muted)}
.page-tabs button.active{background:var(--soft);color:var(--accent);font-weight:700}
.translation-page{padding:12px;flex:1 1 auto;min-width:0;min-height:0;overflow:auto;display:flex;flex-direction:column;gap:10px;overscroll-behavior:contain}
.translation-head{flex:0 0 auto;display:flex;align-items:center;justify-content:space-between;gap:8px}.translation-head strong{font-size:14px}.translation-head small{display:block;color:var(--muted);font-size:10px;margin-top:2px}
.translation-columns{display:grid;grid-template-columns:1fr 1fr;gap:8px;min-width:0;min-height:140px;flex:1 1 0}.translation-box{min-width:0;min-height:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--soft);display:flex;flex-direction:column}.translation-box h4{margin:0;padding:7px 9px;font-size:10px;color:var(--muted);border-bottom:1px solid var(--line)}.translation-box pre{margin:0;padding:10px;white-space:pre-wrap;word-break:break-word;overflow:auto;flex:1;font-family:inherit;font-size:12px;line-height:1.65;min-height:0;color:var(--ink)}
.translation-actions{flex:0 0 auto;display:flex;align-items:center;gap:6px;flex-wrap:wrap}.translation-actions select,.translation-actions button{font-size:11px;min-height:29px}.translation-actions select{max-width:142px}.translation-actions .primary{margin-left:auto}
.translation-settings{flex:0 0 auto;border:1px solid var(--line);border-radius:9px;padding:8px 10px;background:var(--soft)}.translation-settings summary{font-size:11px}.translation-settings-grid{display:grid;grid-template-columns:1fr 1fr;gap:7px;margin-top:8px}.translation-settings-grid label{font-size:10px;color:var(--muted)}.translation-settings-grid label.wide{grid-column:1/-1}.translation-settings-grid input{width:100%;margin-top:3px;height:29px;border:1px solid var(--line);border-radius:7px;background:var(--bg);color:var(--ink);padding:4px 6px;font-size:11px}
.translation-status{flex:0 0 auto;min-height:16px;font-size:10px;color:var(--muted)}.translation-native-note{font-size:10px;color:var(--muted);line-height:1.45}.translation-native-note.error{color:var(--bad)}.translation-status.error{color:var(--bad)}.translation-status.ok{color:var(--good)}
@media(max-width:520px){.translation-columns{grid-template-columns:1fr;grid-template-rows:1fr 1fr;min-height:180px}.translation-actions .primary{margin-left:0}.translation-settings-grid{grid-template-columns:1fr}.translation-settings-grid label.wide{grid-column:auto}}
</style>
<section class="panel" aria-label="超星学习助手">
  <header class="head" id="drag" title="拖动面板">
    <div class="brand"><strong>控制台 · 2.1.5</strong></div>
    <button class="icon" id="theme" aria-label="切换深浅主题" title="切换主题">◐</button>
    <button class="icon" id="minimize" aria-label="收起面板" title="收起面板">−</button>
    <button class="icon danger" id="hide" aria-label="完全隐藏控制台" title="完全隐藏；按 Alt+Shift+C 恢复">×</button>
  </header>
  <div class="page-tabs" id="page-tabs" hidden><button id="page-learning" class="active">学习控制</button><button id="page-translation">翻译</button></div>
  <div class="learning-view" id="learning-view"><div class="content">
    <div class="chapter" id="chapter"></div>
    <div class="statusline"><span class="badge" id="badge" role="status"></span><span class="subtle" id="elapsed">本次 00:00</span></div>
    <div class="stage" id="phase"></div><div class="detail" id="detail"></div>
    <div class="now" id="now"></div>
    <div class="time"><strong id="time">00:00</strong><span id="total"></span></div>
    <progress id="progress" max="100" value="0" aria-label="视频播放进度"></progress>
    <div class="metrics"><span id="percent"></span><span id="eta"></span></div>
    <div class="countdown" id="countdown"></div>
    <div class="controls">
      <button id="start" class="primary">开始</button><button id="pause" disabled>暂停</button><button id="stop" class="danger">停止</button>
    </div>
    <div class="secondary"><button id="next">下一节</button><button id="locate" title="定位当前正在处理的视频">当前任务</button><button id="rescan">刷新识别</button></div>
    <div class="secondary"><button id="ppt-end" title="将当前 PPT 阅读器滚动到最后一页">PPT 翻到末页</button><button id="translate-open" hidden title="打开英语翻译页面">翻译英语</button></div>
    <div class="video-nav"><button id="prev-video">← 上一视频</button><span class="view-label" id="view-label">查看 0 / 0</span><button id="next-video">下一视频 →</button></div>
    <div class="queuehead"><span id="queue-label">当前分段</span><span id="queue-count"></span></div>
    <div class="queue" id="queue"></div>
    <details id="settings"><summary>播放与任务设置</summary>
      <div class="settings">
        <label class="wide">处理方式<select id="mode"><option value="smart">快速尝试 → 渐进尝试 → 正常播放</option><option value="natural">仅正常播放</option></select></label>
        <label>播放倍速<select id="speed"><option value="0.75">0.75×</option><option value="1">1×</option><option value="1.25">1.25×</option><option value="1.5">1.5×</option><option value="2">2×</option><option value="3">3×</option></select></label>
        <label>跳转分段<select id="part"></select></label>
        <label class="check"><input type="checkbox" id="autoNext">自动下一节</label>
        <label class="check"><input type="checkbox" id="muted">静音播放</label>
        <label class="check wide"><input type="checkbox" id="autoStart">打开学习页后 5 秒自动开始</label>
        <label>渐进间隔（秒）<input id="stepInterval" type="number" min="10" max="180" step="1"></label>
        <label>单视频上限（分钟）<input id="maxVideoMin" type="number" min="5" max="240" step="1"></label>
        <label>失败重试次数<select id="retries"><option value="0">不重试</option><option value="1">1 次</option><option value="2">2 次</option></select></label>
        <small>倍速以播放器实际生效值为准。暂停期间不计超时。</small>
      </div>
    </details>
    <details id="log-section"><summary>运行日志</summary><div class="logs" id="logs"></div><div class="logtools"><button id="export">导出日志</button><button id="clear-logs">清空</button></div></details>
    <div class="footer"><span>v2.1.5 · 播放进度 ≠ 累计观看时长</span><button id="reset-position">重置位置</button></div>
  </div></div>
  <div class="translation-page" id="translation-page" hidden>
    <div class="translation-head"><div><strong>英语翻译</strong><small id="translation-detected">检测当前课程正文</small></div><button id="translation-refresh">重新检测</button></div>
    <div class="translation-columns"><div class="translation-box"><h4>原文</h4><pre id="translation-source">检测到英文内容后会显示在这里。</pre></div><div class="translation-box"><h4>中文译文</h4><pre id="translation-result">点击“翻译当前内容”开始。</pre></div></div>
    <div class="translation-actions"><select id="translation-engine"><option value="native">Edge 本地翻译（推荐）</option><option value="google">Google（需梯子）</option><option value="mymemory">MyMemory</option><option value="customapi">自定义 API</option></select><button id="translation-settings-toggle">API 设置</button><button id="translation-native-guide" hidden>打开手工指引</button><button id="translation-run" class="primary">翻译当前内容</button></div>
    <details class="translation-settings" id="translation-settings"><summary>自定义 API 设置（可选）</summary><div class="translation-settings-grid"><label class="wide">API 地址<input id="translation-url" placeholder="https://api.deepseek.com/v1/chat/completions"></label><label>API Key<input id="translation-key" type="password" placeholder="本地代理可留空"></label><label>模型<input id="translation-model" value="deepseek-chat"></label></div><div style="display:flex;justify-content:flex-end;margin-top:7px"><button id="translation-settings-save">保存设置</button></div></details>
    <div class="translation-status" id="translation-status">翻译功能按需使用，不会自动发起请求。</div><div class="translation-native-note" id="translation-native-note" hidden></div>
  </div>
</section>
<button class="mini" id="mini" hidden title="拖动位置；点击展开学习控制台"><span class="dot"></span><span id="mini-text">CX · 就绪</span></button>
<div class="resize-handle n" data-resize="n"></div><div class="resize-handle e" data-resize="e"></div><div class="resize-handle s" data-resize="s"></div><div class="resize-handle w" data-resize="w"></div><div class="resize-handle ne" data-resize="ne"></div><div class="resize-handle nw" data-resize="nw"></div><div class="resize-handle se" data-resize="se"></div><div class="resize-handle sw" data-resize="sw"></div>`;
    document.body.appendChild(host);
    root.getElementById('start').onclick = () => launch();
    root.getElementById('pause').onclick = togglePause;
    root.getElementById('stop').onclick = () => { stop(); log('已停止'); };
    root.getElementById('next').onclick = async () => {
      stop('准备手动切换');
      if (state.promise) await state.promise;
      launch(run => nextChapter(run, false).then(ok => phase(ok ? '已切换下一节' : '没有下一节', '点击开始处理新章节')));
    };
    root.getElementById('locate').onclick = () => {
      const task = state.active || taskList().find(t => !t.done) || taskList()[0];
      locateTask(task);
    };
    root.getElementById('prev-video').onclick = () => locateAdjacent(-1);
    root.getElementById('next-video').onclick = () => locateAdjacent(1);
    root.getElementById('rescan').onclick = () => { render(); log('已重新识别当前页面'); };
    root.getElementById('ppt-end').onclick = scrollPptToEnd;
    root.getElementById('translate-open').onclick = openTranslationPage;
    root.getElementById('page-learning').onclick = () => { state.translation.page = 'learning'; render(); };
    root.getElementById('page-translation').onclick = openTranslationPage;
    root.getElementById('translation-refresh').onclick = () => { renderTranslationAvailability(); state.translation.status = state.translation.eligible ? '已重新检测英文正文' : '当前章节没有足够的英文正文'; render(); };
    root.getElementById('translation-engine').onchange = event => { translationSetEngine(event.target.value); if (event.target.value === 'customapi') loadTranslationSettings(); if (event.target.value === 'native') refreshNativeTranslationStatus(); render(); };
    root.getElementById('translation-run').onclick = runTranslation;
    root.getElementById('translation-native-guide').onclick = openNativeTranslationGuide;
    root.getElementById('translation-settings-toggle').onclick = () => { const box = root.getElementById('translation-settings'); box.open = !box.open; if (box.open) loadTranslationSettings(); };
    root.getElementById('translation-settings-save').onclick = saveTranslationSettings;
    let suppressMiniClick = false;
    root.getElementById('minimize').onclick = () => minimize(true);
    root.getElementById('hide').onclick = () => fullHide(true);
    root.getElementById('mini').onclick = () => {
      if (suppressMiniClick) { suppressMiniClick = false; return; }
      minimize(false);
    };
    root.getElementById('theme').onclick = () => { cfg.theme = cfg.theme === 'light' ? 'dark' : 'light'; save(); render(); };
    root.getElementById('reset-position').onclick = () => { cfg.position = null; save(); position(); };
    root.getElementById('clear-logs').onclick = () => { state.logs = []; renderLogs(); };
    root.getElementById('export').onclick = () => {
      const body = ['CX Unified ' + VERSION, ...state.logs.map(l => l.time + ' [' + l.level + '] ' + l.message)].join('\n');
      const url = URL.createObjectURL(new Blob([body], { type: 'text/plain;charset=utf-8' }));
      const link = document.createElement('a');
      link.href = url; link.download = 'cx-unified-log-' + new Date().toISOString().slice(0, 10) + '.txt';
      link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    };
    for (const key of ['mode', 'speed', 'autoNext', 'autoStart', 'muted', 'stepInterval', 'maxVideoMin', 'retries']) {
      const element = root.getElementById(key);
      if (element.type === 'checkbox') element.checked = cfg[key]; else element.value = String(cfg[key]);
      element.onchange = () => {
        const value = element.type === 'checkbox' ? element.checked : key === 'mode' ? element.value : Number(element.value);
        Object.assign(cfg, normalize({ ...cfg, [key]: value }));
        if (element.type !== 'checkbox') element.value = String(cfg[key]);
        if (key === 'speed' || key === 'muted') for (const task of taskList()) if (task.player) applyPlayback(task.player);
        if (key === 'autoStart' && !cfg.autoStart) cancelStartup();
        save(); render();
      };
    }
    root.getElementById('part').onchange = async event => {
      const index = Number(event.target.value);
      stop('准备切换分段');
      if (state.promise) await state.promise;
      launch(run => switchPart(index, run).then(() => phase('分段已切换', '点击开始处理本章节')));
    };
    function installDrag(handle, ignoreButtons, movedCallback) {
      let drag = null;
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || (ignoreButtons && event.target.closest('button'))) return;
        event.preventDefault();
        const box = host.getBoundingClientRect();
        drag = { x: event.clientX - box.left, y: event.clientY - box.top,
          startX: event.clientX, startY: event.clientY, moved: false };
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointermove', event => {
        if (!drag) return;
        event.preventDefault();
        if (!drag.moved) {
          if (Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY) < 4) return;
          drag.moved = true;
        }
        cfg.position = { x: event.clientX - drag.x, y: event.clientY - drag.y };
        position();
      });
      const finish = () => {
        if (!drag) return;
        if (drag.moved) movedCallback?.();
        drag = null;
        save();
      };
      handle.addEventListener('pointerup', finish);
      handle.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
    }
    installDrag(root.getElementById('drag'), true);
    installDrag(root.getElementById('mini'), false, () => { suppressMiniClick = true; });
    function installResize(handle) {
      let resize = null;
      handle.addEventListener('pointerdown', event => {
        if (event.button !== 0 || cfg.minimized || cfg.hidden) return;
        event.preventDefault(); event.stopPropagation();
        const box = host.getBoundingClientRect();
        resize = { dir: handle.dataset.resize, x: event.clientX, y: event.clientY, box };
        handle.setPointerCapture(event.pointerId);
      });
      handle.addEventListener('pointermove', event => {
        if (!resize) return;
        event.preventDefault();
        const d = resize;
        const rect = resizedFloatingRect({ x: d.box.left, y: d.box.top, width: d.box.width, height: d.box.height },
          d.dir, event.clientX - d.x, event.clientY - d.y, innerWidth, innerHeight);
        cfg.width = rect.width; cfg.height = rect.height; cfg.position = { x: rect.x, y: rect.y }; position();
      });
      const finish = () => { if (resize) { resize = null; save(); } };
      handle.addEventListener('pointerup', finish); handle.addEventListener('pointercancel', finish);
      handle.addEventListener('lostpointercapture', finish);
    }
    root.querySelectorAll('.resize-handle').forEach(installResize);
    root.getElementById('settings').addEventListener('toggle', position);
    root.getElementById('log-section').addEventListener('toggle', position);
    window.addEventListener('resize', position);
    minimize(cfg.minimized);
    fullHide(cfg.hidden);
  }
  function minimize(value) {
    cfg.minimized = value;
    host.dataset.minimized = String(value);
    root.querySelector('.panel').hidden = value;
    root.getElementById('mini').hidden = !value;
    save(); position();
  }
  function fullHide(value) {
    cfg.hidden = value;
    host.style.display = value ? 'none' : 'block';
    save();
    if (!value) { minimize(cfg.minimized); render(); }
  }
  function onVisibilityShortcut(event) {
    const action = floatingShortcut(event);
    if (!action) return;
    if (action === 'visibility') { event.preventDefault(); fullHide(!cfg.hidden); return; }
    if (cfg.hidden || cfg.minimized) return;
    event.preventDefault();
    resizeByFactor(action === 'grow' ? 1.1 : 1 / 1.1);
  }
  // Keyboard events inside a same-origin course frame do not bubble to its parent.
  const shortcutDocuments = new Set();
  function syncShortcutDocuments() {
    const found = new Set();
    function visit(doc, depth) {
      if (!doc || found.has(doc) || depth > 4) return;
      found.add(doc);
      if (doc !== document && !shortcutDocuments.has(doc)) {
        doc.addEventListener('keydown', onVisibilityShortcut, true); shortcutDocuments.add(doc);
      }
      for (const frame of doc.querySelectorAll('iframe')) { try { visit(frame.contentDocument, depth + 1); } catch {} }
    }
    visit(document, 0);
    for (const doc of shortcutDocuments) if (!found.has(doc)) {
      doc.removeEventListener('keydown', onVisibilityShortcut, true); shortcutDocuments.delete(doc);
    }
  }
  function position() {
    if (!host || cfg.hidden) return;
    const rect = floatingRect({ width: Number(cfg.width) || 420, height: Number(cfg.height) || 560,
      x: cfg.position?.x ?? innerWidth - (Number(cfg.width) || 420) - 20, y: cfg.position?.y ?? 96 }, innerWidth, innerHeight);
    cfg.width = rect.width; cfg.height = rect.height;
    let width = rect.width, height = rect.height, x = rect.x, y = rect.y;
    if (cfg.minimized) {
      host.style.width = 'max-content'; host.style.height = 'auto';
      const mini = root.getElementById('mini').getBoundingClientRect();
      width = mini.width; height = mini.height;
      x = clamp(cfg.position?.x ?? rect.x, 8, Math.max(8, innerWidth - width - 8));
      y = clamp(cfg.position?.y ?? rect.y, 8, Math.max(8, innerHeight - height - 8));
    } else {
      host.style.width = width + 'px'; host.style.height = height + 'px';
    }
    cfg.position = { x, y };
    host.style.left = x + 'px'; host.style.top = y + 'px'; host.style.right = 'auto';
  }
  function resizeByFactor(factor) {
    if (!host || cfg.hidden || cfg.minimized) return;
    const box = host.getBoundingClientRect();
    const width = box.width * factor, height = box.height * factor;
    const rect = floatingRect({ x: box.left + (box.width - width) / 2,
      y: box.top + (box.height - height) / 2, width, height }, innerWidth, innerHeight);
    cfg.width = rect.width; cfg.height = rect.height; cfg.position = { x: rect.x, y: rect.y };
    position(); save();
  }
  const setText = (id, value) => { const el = root?.getElementById(id); if (el && el.textContent !== String(value)) el.textContent = String(value); };
  function renderLogs() {
    const container = root?.getElementById('logs');
    if (!container) return;
    const bottom = container.scrollHeight - container.scrollTop - container.clientHeight < 25;
    container.replaceChildren(...state.logs.map(item => {
      const row = document.createElement('div');
      row.className = 'entry ' + item.level;
      const time = document.createElement('time'); time.textContent = item.time;
      row.append(time, document.createTextNode(item.message));
      return row;
    }));
    if (bottom) container.scrollTop = container.scrollHeight;
  }
  function render() {
    if (!root || state.destroyed) return;
    host.dataset.theme = cfg.theme;
    syncShortcutDocuments();
    const tasks = taskList(), running = !!state.promise, paused = state.run?.paused;
    const active = viewedTask(tasks);
    const viewIndex = tasks.findIndex(task => task.key === active?.key);
    setText('view-label', '查看 ' + (viewIndex + 1) + ' / ' + tasks.length);
    root.getElementById('prev-video').disabled = viewIndex <= 0;
    root.getElementById('next-video').disabled = viewIndex < 0 || viewIndex >= tasks.length - 1;
    root.getElementById('locate').disabled = !tasks.length;
    const p = active?.player, ct = safe(() => p.currentTime(), 0), dur = safe(() => p.duration(), 0);
    const ratio = dur > 0 ? clamp(ct / dur * 100, 0, 100) : 0, rate = safe(() => p.playbackRate(), cfg.speed);
    const reference = threshold(active);
    const status = state.status === 'error' ? '需要处理' : paused ? '已暂停' : running ? '运行中' : '待机';
    setText('chapter', arg()?.knowledgename || '等待课件加载');
    setText('badge', status); root.getElementById('badge').dataset.status = state.status;
    setText('phase', paused ? '已暂停' : state.phase);
    setText('detail', paused ? '播放、等待与计时均已暂停，点击继续恢复' : state.detail);
    setText('elapsed', '本次 ' + fmt((state.run?.elapsed ?? state.elapsed) / 1000));
    setText('now', active?.name || '暂无音视频任务');
    root.getElementById('now').title = active?.name || '';
    setText('time', fmt(ct)); setText('total', '/ ' + fmt(dur) + ' · ' + rate + '×');
    root.getElementById('progress').value = ratio;
    setText('percent', '播放 ' + ratio.toFixed(1) + '%' + (reference ? ' · 条件 ≥' + Math.round(reference * 100) + '%' : ''));
    setText('eta', dur > 0 && rate > 0 ? '距播完约 ' + fmt((dur - ct) / rate) : '');
    setText('countdown', paused ? '' : state.countdown);
    setText('mini-text', 'CX · ' + status + (dur > 0 ? ' · ' + Math.round(ratio) + '%' : ''));
    root.getElementById('start').disabled = running;
    root.getElementById('pause').disabled = !running || state.run?.signal.aborted;
    setText('pause', paused ? '继续' : '暂停');
    for (const id of ['mode', 'stepInterval', 'maxVideoMin', 'retries', 'part']) root.getElementById(id).disabled = running;
    setText('queue-label', '当前分段 ' + (activePart() + 1) + '/' + Math.max(1, parts().length));
    const jobs = tasks.filter(t => t.isTask);
    setText('queue-count', jobs.filter(t => t.done).length + ' / ' + jobs.length + ' 已完成');
    const signature = tasks.map(t => [t.key, t.name, t.done, state.active?.key === t.key, active?.key === t.key, state.failures.get(t.key)].join('|')).join('\n');
    if (signature !== state.queueSignature || !root.getElementById('queue').childNodes.length) {
      state.queueSignature = signature;
      const nodes = tasks.map((task, index) => {
        const row = document.createElement('button');
        row.type = 'button';
        row.title = '点击定位：' + task.name;
        row.setAttribute('aria-label', '定位视频 ' + (index + 1) + '：' + task.name);
        row.setAttribute('aria-pressed', String(viewedTask(tasks)?.key === task.key));
        row.onclick = () => locateTask(task);
        const active = state.active?.key === task.key;
        row.className = 'task' + (task.done ? ' done' : active ? ' active' : state.failures.has(task.key) ? ' failed' : '');
        if (viewedTask(tasks)?.key === task.key) row.classList.add('viewing');
        const num = document.createElement('span'); num.className = 'num'; num.textContent = task.done ? '✓' : String(index + 1);
        const name = document.createElement('span'); name.className = 'name'; name.textContent = task.name; name.title = task.name;
        const tag = document.createElement('span'); tag.className = 'tag';
        tag.textContent = task.done ? '已完成' : active ? '处理中' : state.failures.has(task.key) ? '待处理' : task.isTask ? '待开始' : '非任务';
        row.append(num, name, tag); return row;
      });
      if (!nodes.length) { const empty = document.createElement('div'); empty.className = 'subtle'; empty.textContent = '本分段暂无音视频任务'; nodes.push(empty); }
      root.getElementById('queue').replaceChildren(...nodes);
    }
    const part = root.getElementById('part'), count = Math.max(1, parts().length);
    if (part.options.length !== count) {
      part.replaceChildren(...Array.from({ length: count }, (_, i) => {
        const option = document.createElement('option'); option.value = String(i); option.textContent = '第 ' + (i + 1) + ' 段'; return option;
      }));
    }
    part.value = String(activePart());
    position();
    renderTranslationAvailability();
  }

  function onPageHide() {
    state.unloading = true;
    cancelStartup();
    state.run?.stop();
    clearInterval(state.timer);
  }
  function onPageShow(event) {
    if (!event.persisted || state.destroyed) return;
    state.unloading = false;
    clearInterval(state.timer);
    state.timer = setInterval(render, 1000);
    phase('已返回学习页面', '点击开始恢复处理');
  }
  function destroy() {
    stop();
    state.destroyed = true;
    clearInterval(state.timer);
    window.removeEventListener('resize', position);
    window.removeEventListener('pagehide', onPageHide);
    window.removeEventListener('pageshow', onPageShow);
    window.removeEventListener('keydown', onVisibilityShortcut, true);
    for (const doc of shortcutDocuments) doc.removeEventListener('keydown', onVisibilityShortcut, true);
    shortcutDocuments.clear();
    host?.remove();
    if (window.__CX_UNIFIED_V2__?.destroy === destroy) delete window.__CX_UNIFIED_V2__;
  }
  function init() {
    if (!location.pathname.includes('studentstudy') && location.pathname !== '/mooc2-ans/mycourse/stu') return;
    // A previous v1 closure cannot be destroyed safely. Reload after updating v1.
    if (q('#cxuni-panel')) {
      q('#cxuni-stop')?.click();
      console.warn('[CX v2] 检测到旧版运行实例；请先刷新页面，再加载新版');
      return;
    }
    buildUI();
    window.__CX_UNIFIED_V2__ = {
      version: VERSION, start: () => launch(), stop, pause: togglePause, hide: fullHide, destroy,
      status: () => ({ status: state.status, running: !!state.promise, paused: !!state.run?.paused, phase: state.phase, viewing: viewedTask()?.name || null,
        tasks: taskList().map(t => ({ name: t.name, done: t.done })), settings: { ...cfg }, translation: { eligible: state.translation.eligible, page: state.translation.page, status: state.translation.status } })
    };
    log('控制台已就绪；完成状态以服务器响应或平台自身标记为准');
    state.timer = setInterval(render, 1000);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('pageshow', onPageShow);
    window.addEventListener('keydown', onVisibilityShortcut, true);
    render();
    const resume = read(sessionStorage, RESUME);
    clearContinuation();
    if (resume && resume.course === course() && Date.now() - resume.at < 120000) {
      state.startup = setTimeout(() => launch(), 1000);
      phase('继续上一章节的运行', '1 秒后开始；停止可取消');
    } else if (cfg.autoStart) {
      state.startup = setTimeout(() => launch(), 5000);
      phase('等待自动开始', '5 秒后开始；停止可取消');
    }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
