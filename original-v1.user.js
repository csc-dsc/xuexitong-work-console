// ==UserScript==
// @name         超星学习通自动刷任务点 统一版
// @namespace    https://github.com/custom/chaoxing-unified
// @version      1.0
// @description  自动检测课程类型：秒过型直接完成，90%门槛型稳健播放。一个脚本适用所有课程。
// @author       Claude
// @match        https://mooc1.chaoxing.com/mycourse/studentstudy?*
// @match        https://mooc2-ans.chaoxing.com/mooc2-ans/mycourse/stu?*
// @grant        none
// @run-at       document-end
// ==/UserScript==

(function() {
  'use strict';

  // ======================== CONFIG ========================
  const CFG = {
    speed: 2,
    stepInterval: 60,       // 渐进心跳间隔(秒) — 需足够长让服务器累积时长
    naturalPlay: 45,        // 秒过/渐进失败后的自然播放秒数
    heartbeatSec: 30,       // 90%门槛模式心跳间隔
    maxVideoMin: 45,        // 单个视频最长处理分钟数
    nextWait: 2,
    partWait: 2,
    startupDelay: 4,
    debug: true,
  };

  // ======================== LOG ========================
  const P = '[CX Uni]';
  function log(...a) { CFG.debug && console.log(P, ...a); }
  function warn(...a) { console.warn(P, ...a); }

  // ======================== UTIL ========================
  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const $ = (sel, root) => (root || document).querySelector(sel);
  const $$ = (sel, root) => (root || document).querySelectorAll(sel);
  function getChapterId() { return new URLSearchParams(location.search).get('chapterId'); }
  function isStudentStudy() { return location.href.includes('studentstudy'); }

  // ======================== CARD IFRAME ========================
  function cardDoc() { const f = $('#iframe'); if (!f) return null; try { return f.contentDocument; } catch(e) { return null; } }
  function cardWin() { const d = cardDoc(); return d ? d.defaultView : null; }
  function mArg() { const w = cardWin(); return w ? w.mArg : null; }
  function attachments() { const m = mArg(); return m ? m.attachments || [] : []; }
  function defaults() { const m = mArg(); return m ? m.defaults : null; }
  function mediaIframes() { const d = cardDoc(); return d ? $$('iframe.ans-attach-online', d) : []; }

  // ======================== ATTACHMENT HELPERS ========================
  function isMedia(a) { const m = a.property && a.property.module; return m === 'insertvideo' || m === 'insertaudio' || a.type === 'video' || a.type === 'audio'; }
  function isPassed(a) { return a.isPassed === true || a.isPassed === 1; }
  function attOid(a) { return a.objectId || (a.property && a.property.objectid) || ''; }
  function attName(a) { return (a.property && a.property.name) || a.name || '?'; }

  // ======================== PAGE CLASSIFICATION ========================
  function classifyPage() {
    const d = cardDoc(); if (!d) return 'loading';
    const atts = attachments();
    const jobIcons = $$('.ans-job-icon', d);

    let hasUnfinishedJob = false;
    for (const icon of jobIcons) {
      if (!icon.parentElement.classList.contains('ans-job-finished')) hasUnfinishedJob = true;
    }
    if (hasUnfinishedJob) return 'job_unfinished';

    for (const a of atts) {
      if (isMedia(a) && !isPassed(a) && jobIcons.length > 0) return 'media_uncompleted';
    }
    if (jobIcons.length > 0) return 'all_jobs_done';
    return 'text_page';
  }

  // ======================== COMPLETION CONDITION DETECTION ========================
  function detectThreshold() {
    const d = cardDoc(); if (!d) return 0;
    const text = (d.body && d.body.textContent) || '';
    const m90 = text.match(/观看时长[^0-9]*(\d+)\s*%/);
    if (m90) return parseInt(m90[1]) / 100;
    // Also check the "完成条件" element text
    const condEls = $$('[class*="condition"], [class*="job"], [aria-label*="完成"]', d);
    for (const el of condEls) {
      const t = (el.textContent || '').trim();
      const m = t.match(/(\d+)\s*%/);
      if (m) return parseInt(m[1]) / 100;
    }
    return 0;
  }

  // ======================== PART NAVIGATION ========================
  function partItems() { return $$('#prev_tab .prev_ul li'); }
  function partCount() { return partItems().length; }
  function switchPart(num) {
    const items = partItems();
    if (num < 1 || num > items.length) return false;
    const t = items[num - 1];
    if (t.classList.contains('active')) return true;
    t.click(); return true;
  }
  function waitCardReady(ms) {
    ms = ms || 30000; const start = Date.now();
    return new Promise((resolve, reject) => {
      (function check() { const d = cardDoc(); if (d && d.readyState === 'complete' && cardWin() && mArg()) return resolve(); if (Date.now() - start > ms) return reject(new Error('timeout')); setTimeout(check, 400); })();
    });
  }

  // ======================== PLAYER ========================
  function getPlayer(vf) { try { const w = vf.contentWindow; return (w && w.videojs) ? w.videojs.getAllPlayers()[0] || null : null; } catch(e) { return null; } }

  function bypassSeekBar(player) {
    try { const sb = player.controlBar.progressControl.seekBar; sb._disableSeek = false; sb._onlyBackward = false; sb.maxPercent = 1; player.dragCutOffTime = 99999; try { sb.on(sb.el(), 'mousedown', sb.handleMouseDown); sb.on(sb.el(), 'mouseup', sb.handleMouseUp); sb.on(sb.el(), 'click', sb.handleClick); } catch(e) {} } catch(e) {}
  }

  async function getDuration(player, oid, fid) {
    let d = Math.round(player.duration() || 0); if (d > 0) return d;
    try { const r = await fetch(`https://mooc1.chaoxing.com/ananas/status/${oid}?k=${fid}&flag=normal`, { credentials: 'include' }); const j = await r.json(); if (j.duration > 0) return Math.round(j.duration); } catch(e) {}
    return 0;
  }

  // ======================== SENDLOG ========================
  function sendReport(player, courseId, evt, pt) {
    return new Promise(resolve => {
      try {
        const sc = player.seekBarControl, opts = player.options_.plugins.seekBarControl;
        const win = player.el().ownerDocument.defaultView, OrigOpen = win.XMLHttpRequest.prototype.open;
        let captured = null, done = false;
        win.XMLHttpRequest.prototype.open = function(m, url) { if (url.includes('multimedia')) this.addEventListener('load', () => { captured = this.responseText; }); return OrigOpen.apply(this, arguments); };
        sc.isSendLog = true;
        opts.sendLog.call(sc, courseId, evt, pt, evt === 'ended' ? function(res) { if (done) return; done = true; win.XMLHttpRequest.prototype.open = OrigOpen; try { resolve(JSON.parse((res && res.responseText) || captured)); } catch(e) { resolve({ isPassed: false }); } } : null);
        setTimeout(() => { if (done) return; done = true; win.XMLHttpRequest.prototype.open = OrigOpen; if (captured) { try { resolve(JSON.parse(captured)); } catch(e) { resolve({ isPassed: false }); } } else resolve({ isPassed: false }); }, 4000);
      } catch(e) { resolve({ isPassed: false }); }
    });
  }

  // ======================== DOM FIXUP ========================
  function ensureJobFinished(vf) {
    try { if (vf.contentWindow && vf.contentWindow.greenligth) vf.contentWindow.greenligth(); } catch(e) {}
    try { vf.parentElement && vf.parentElement.classList.add('ans-job-finished'); } catch(e) {}
    const atts = attachments();
    for (const a of atts) { if (!a.isPassed) { try { const d = JSON.parse(vf.getAttribute('data') || '{}'); if (d.objectid === attOid(a)) a.isPassed = true; } catch(e) {} } }
  }

  // ======================== MEDIA PROCESSING ========================
  async function processOneMedia(vf, att, defs, label) {
    const player = getPlayer(vf);
    if (!player) { log('  ⚠ ' + label + ' 无播放器'); return false; }
    const courseId = defs.courseid, oid = attOid(att);
    const taskStart = Date.now();

    // Init
    try { const btn = vf.contentDocument.querySelector('.vjs-big-play-button'); if (btn) btn.click(); } catch(e) {}
    await sleep(1500); try { player.play(); await sleep(1000); } catch(e) {}

    const dur = await getDuration(player, oid, defs.fid);
    if (!dur) { log('  ⚠ ' + label + ' 无时长'); return false; }
    log('  📺 ' + label + ' | ' + dur + 's');

    bypassSeekBar(player);
    try { player.playbackRate(CFG.speed); } catch(e) {}

    // —— Tier 1: 秒过 ——
    let r = await sendReport(player, courseId, 'ended', dur);
    if (r.isPassed) { ensureJobFinished(vf); log('    ✅ 秒过'); return true; }
    log('    ⚠ 秒过失败');

    // —— Tier 2: 快速渐进 (适合纯秒过失败但无门槛的课程) ——
    log('    🔄 快速渐进...');
    try { player.play(); } catch(e) {}
    for (const frac of [0.25, 0.50, 0.75, 0.90, 1.0]) {
      if (Date.now() - taskStart > CFG.maxVideoMin * 60000) return false;
      const pt = Math.round(dur * frac);
      r = await sendReport(player, courseId, frac >= 1 ? 'ended' : 'playing', pt);
      if (r.isPassed) { ensureJobFinished(vf); log('    ✅ 渐进(' + Math.round(frac*100) + '%)'); return true; }
      await sleep(CFG.stepInterval * 1000);
    }

    // —— Tier 3: 稳健模式 (秒过和渐进都失败 → 真实播放+心跳+定期重试ended) ——
    // 服务器驱动的：只看行为，不预判DOM文字
    // 同时从DOM读取阈值作为目标参考（仅影响日志和目标时间，不影响是否进入此模式）
    const thresholdHint = detectThreshold();
    const targetRatio = thresholdHint > 0 ? thresholdHint : 0.90; // 默认目标90%
    const targetTime = Math.round(dur * targetRatio);
    log('    🎬 切换稳健模式 (目标' + Math.round(targetRatio*100) + '%=' + targetTime + 's)...');

    try { player.play(); } catch(e) {}
    const maxMs = Math.min(CFG.maxVideoMin * 60000, (dur / CFG.speed) * 1000 + 120000);
    let lastHb = player.currentTime() || 0, hbCount = 0;
    let endedRetryCount = 0;

    while (!CFG._stopFlag && Date.now() - taskStart < maxMs) {
      const ct = player.currentTime() || 0;

      // Try ended at 90%+ and then periodically
      if (ct >= targetTime && endedRetryCount === 0) {
        r = await sendReport(player, courseId, 'ended', dur);
        if (r.isPassed) { ensureJobFinished(vf); log('    ✅ 稳健(' + Math.round(ct) + 's)'); return true; }
        endedRetryCount++;
      }
      // Retry ended every ~2 minutes after reaching target
      if (ct >= targetTime && endedRetryCount > 0 && hbCount > 0 && hbCount % 4 === 0) {
        r = await sendReport(player, courseId, 'ended', dur);
        if (r.isPassed) { ensureJobFinished(vf); log('    ✅ 重试成功'); return true; }
        endedRetryCount++;
      }

      if (player.ended()) {
        r = await sendReport(player, courseId, 'ended', dur);
        if (r.isPassed) { ensureJobFinished(vf); log('    ✅ 播放完毕'); return true; }
        log('    ⚠ 播放完毕但未通过');
        return false;
      }

      if (player.paused()) { try { player.play(); } catch(e) {} if (player.paused()) { await sleep(5000); continue; } }

      // Heartbeat: report actual position to accumulate server play time
      if (ct - lastHb >= CFG.heartbeatSec) {
        hbCount++; await sendReport(player, courseId, 'playing', Math.round(ct)); lastHb = ct;
        if (hbCount % 8 === 0) log('    💓 #' + hbCount + ' ' + Math.round(ct) + '/' + dur + 's (' + Math.round(ct/dur*100) + '%)');
      }
      await sleep(5000);
    }

    log('    ❌ 超时或已停止');
    return false;
  }

  // ======================== PROCESS PAGE ========================
  async function processPage() {
    const d = cardDoc(); if (!d) return { done: 0, total: 0 };
    const atts = attachments(), defs = defaults();
    if (!defs) return { done: 0, total: 0 };
    const vfs = mediaIframes();
    const vfMap = {}; vfs.forEach(vf => { try { const d = JSON.parse(vf.getAttribute('data') || '{}'); vfMap[d.objectid] = vf; } catch(e) {} });

    let done = 0, total = 0;
    for (let i = 0; i < atts.length && !CFG._stopFlag; i++) {
      const a = atts[i]; if (!isMedia(a)) continue;
      if (isPassed(a)) {
        const oid = attOid(a), vf = vfMap[oid];
        if (vf && vf.parentElement && !vf.parentElement.classList.contains('ans-job-finished')) vf.parentElement.classList.add('ans-job-finished');
        continue;
      }
      total++; const oid = attOid(a); let vf = vfMap[oid];
      if (!vf) { warn('  ⚠ ' + attName(a) + ' 无播放器'); continue; }
      try { vf.scrollIntoView({ behavior: 'smooth', block: 'center' }); } catch(e) {}
      await sleep(800);
      if (await processOneMedia(vf, a, defs, '['+(i+1)+'] '+attName(a))) done++;
      await sleep(2000);
    }
    return { done, total };
  }

  // ======================== NAVIGATION ========================
  function findNextBtn() {
    for (const b of $$('.nextChapter, #prevNextFocusNext, .prev_next.next')) { if (b.offsetParent !== null) return b; }
    for (const el of $$('a, button, div[role="button"]')) { const t = (el.textContent||'').trim(); if ((t==='下一节'||t==='下一章') && el.offsetParent!==null) return el; }
    return null;
  }

  async function clickNext() {
    const before = getChapterId(), btn = findNextBtn();
    if (!btn) { warn('无下一节按钮'); return false; }
    btn.click(); await sleep(800);
    const popup = $('.jobFinishTip, [class*="jobFinishTip"]');
    if (popup && popup.offsetParent !== null) {
      warn('弹窗: 本章专题未完成');
      const c = popup.querySelector('.btn, button, a, [class*="close"]'); if (c) c.click();
      const vfs = mediaIframes(); vfs.forEach(vf => ensureJobFinished(vf));
      await sleep(1500); btn.click(); await sleep(800);
      if (popup.offsetParent !== null) { warn('弹窗仍在'); return false; }
    }
    const start = Date.now();
    while (Date.now() - start < 15000) {
      const now = getChapterId(); if (now && now !== before) return true;
      const iframe = $('#iframe');
      if (iframe && iframe.src.includes('knowledgeid=')) { const m = iframe.src.match(/knowledgeid=(\d+)/); if (m && m[1] !== before) return true; }
      await sleep(500);
    }
    warn('导航超时'); return false;
  }

  // ======================== MAIN LOOP ========================
  async function mainLoop() {
    log('══════ 统一版 V1 启动 ══════');
    let retryCount = 0, navFails = 0;

    while (!CFG._stopFlag) {
      try {
        try { await waitCardReady(30000); } catch(e) { warn('⚠ 等待超时'); await sleep(3000); continue; }
        await sleep(2500);

        let pageType = classifyPage();
        log('📄 ' + getChapterId() + ' → ' + pageType);
        const threshold = detectThreshold();
        if (threshold > 0) log('  📏 检测到完成条件: 观看时长需≥' + Math.round(threshold*100) + '%');

        if (pageType === 'media_uncompleted' || pageType === 'job_unfinished') {
          retryCount = 0; navFails = 0;
          const np = partCount();

          if (np > 0) {
            let anyUncompleted = false;
            for (let p = 1; p <= np && !CFG._stopFlag; p++) {
              switchPart(p); try { await waitCardReady(20000); } catch(e) {} await sleep(1500);
              const r = await processPage();
              log('  Part ' + p + ': done=' + r.done + ' total=' + r.total);
              // Check if this part still has uncompleted tasks after processing
              const pt = classifyPage();
              if (pt === 'media_uncompleted' || pt === 'job_unfinished') anyUncompleted = true;
              if (p < np) await sleep(CFG.partWait * 1000);
            }
            // After all parts: if any part still unfinished, set pageType accordingly
            pageType = anyUncompleted ? 'media_uncompleted' : classifyPage();
          } else {
            await processPage();
            await sleep(1000); pageType = classifyPage();
          }

          if (pageType === 'media_uncompleted' || pageType === 'job_unfinished') {
            if (++retryCount <= 2) { log('🔄 仍有任务未完成，重试(' + retryCount + '/2)...'); continue; }
            log('⚠ 达重试上限，跳过');
          } else {
            log('✅ 所有Part任务完成 → ' + pageType);
          }
        } else if (pageType === 'loading') { await sleep(5000); continue; }

        // ── Navigate ──
        await sleep(CFG.nextWait * 1000); if (CFG._stopFlag) break;
        if (!(await clickNext())) { if (++navFails >= 5) break; await sleep(5000); continue; }
        navFails = 0; await sleep(3000);
      } catch(e) { warn('💥 ' + e.message); console.error(e); await sleep(5000); }
    }
    log('══════ 循环结束 ══════'); updateUI('已停止', ''); CFG._stopFlag = true;
  }

  // ======================== UI ========================
  function updateUI(s, c) { const el = $('#cxuni-status'); if (el) { el.textContent = s; el.className = c || ''; } }

  function buildUI() {
    const old = $('#cxuni-panel'); if (old) old.remove();
    const p = document.createElement('div'); p.id = 'cxuni-panel';
    p.innerHTML = `<style>#cxuni-panel{position:fixed;bottom:20px;right:20px;z-index:99998;background:#0d1117;color:#c9d1d9;padding:12px 14px;border-radius:10px;font-family:monospace;font-size:11px;min-width:240px;box-shadow:0 4px 20px rgba(0,0,0,0.6);border:1px solid #30363d;user-select:none;}#cxuni-panel h3{margin:0 0 6px;color:#58a6ff;font-size:12px;}#cxuni-panel .r{display:flex;gap:5px;margin:3px 0;}#cxuni-panel button{flex:1;padding:5px 6px;background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:5px;cursor:pointer;font-size:10px;font-family:inherit;}#cxuni-panel button:hover{background:#1f6feb;border-color:#1f6feb;color:#fff;}#cxuni-panel button.go{background:#238636;border-color:#238636;color:#fff;}#cxuni-panel button.go:hover{background:#2ea043;}#cxuni-panel button.stop:hover{background:#da3633;border-color:#da3633;}#cxuni-panel .st{padding:4px 6px;border-radius:4px;margin:4px 0;font-size:10px;text-align:center;background:#161b22;}#cxuni-panel .st.ok{color:#3fb950}.st.warn{color:#d2991d}.st.err{color:#f85149}#cxuni-panel .info{color:#8b949e;font-size:9px;margin:3px 0;}#cxuni-panel select{width:100%;padding:3px 5px;background:#161b22;color:#c9d1d9;border:1px solid #30363d;border-radius:4px;font-size:10px;font-family:inherit;margin:3px 0;}</style><h3>CX 统一版</h3><div class="st" id="cxuni-status">就绪</div><div class="info" id="cxuni-info"></div><div class="r"><button id="cxuni-go" class="go">▶ 开始</button><button id="cxuni-next">➡ 下一节</button></div><div class="r"><select id="cxuni-speed"><option value="1">1x</option><option value="1.5">1.5x</option><option value="2" selected>2x</option><option value="3">3x</option></select></div><div class="r"><button id="cxuni-stop" class="stop">⏹ 停止</button><button id="cxuni-hide">✖</button></div>`;
    document.body.appendChild(p);
    $('#cxuni-go').onclick = () => { CFG._stopFlag = false; CFG.speed = +$('#cxuni-speed').value; updateUI('运行中...','warn'); mainLoop(); };
    $('#cxuni-next').onclick = () => clickNext();
    $('#cxuni-stop').onclick = () => { CFG._stopFlag = true; updateUI('已停止',''); };
    $('#cxuni-hide').onclick = () => { p.style.display = 'none'; const m = $('#cxuni-mini'); if (m) m.style.display = 'flex'; };
    $('#cxuni-speed').onchange = function() { CFG.speed = +this.value; };

    let mini = $('#cxuni-mini');
    if (!mini) { mini = document.createElement('div'); mini.id = 'cxuni-mini'; mini.textContent = 'Uni'; mini.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99999;width:32px;height:32px;border-radius:50%;background:#0d1117;color:#58a6ff;border:1px solid #30363d;cursor:pointer;font-size:9px;display:none;align-items:center;justify-content:center;font-family:monospace;font-weight:bold;'; mini.onclick = () => { p.style.display='block'; mini.style.display='none'; }; document.body.appendChild(mini); }

    setInterval(() => { const el = $('#cxuni-info'); if (el) { const t = detectThreshold(); el.textContent = 'ch:'+(getChapterId()||'?')+' | '+classifyPage()+(t>0?' | ≥'+Math.round(t*100)+'%':'')+' | '+CFG.speed+'x'; } }, 5000);
  }

  // ======================== INIT ========================
  function init() {
    if (!isStudentStudy()) { if (location.href.includes('mooc2-ans.chaoxing.com')) { const h = document.createElement('div'); h.style.cssText = 'position:fixed;bottom:20px;right:20px;z-index:99998;background:#0d1117;color:#58a6ff;padding:10px 14px;border-radius:8px;font-family:monospace;font-size:12px;border:1px solid #30363d;'; h.textContent='CX Uni V1 就绪 | 点击章节进入'; document.body.appendChild(h); } return; }
    log('CX 统一版 V1 初始化'); buildUI();
    if (CFG.startupDelay > 0) { updateUI('等待启动...','warn'); setTimeout(() => { if (!CFG._stopFlag) { updateUI('运行中...','warn'); mainLoop(); } }, CFG.startupDelay*1000); }
  }

  if (document.readyState === 'complete' || document.readyState === 'interactive') setTimeout(init, 500);
  else window.addEventListener('load', () => setTimeout(init, 500));
})();
