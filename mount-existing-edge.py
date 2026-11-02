# browser-harness stdin program; do not run as a standalone Python script.
# Uses the current, already-open learning page. Does not start tasks or open tabs.
from pathlib import Path
import json
import re

source = (Path(__file__).resolve().parent / 'chaoxing-unified.user.js').read_text(encoding='utf-8-sig')
match = re.search(r'^//\s*@version\s+(\S+)', source, re.M)
if not match:
    raise RuntimeError('Local userscript version metadata is missing')
version = match.group(1)

check = js('''JSON.stringify((function () {
  var api = window.__CX_UNIFIED_V2__;
  return {
    host: location.hostname,
    path: location.pathname,
    top: window.top === window.self,
    loading: document.readyState === 'loading',
    loginPage: /login|passport|fanyalogin/i.test(location.pathname),
    existingVersion: api ? api.version : null,
    existingRunning: api && api.status ? !!api.status().running : false,
    legacyPanel: !!document.querySelector('#cxuni-panel')
  };
})())''')
info = json.loads(check) if isinstance(check, str) else check
if not isinstance(info, dict):
    raise RuntimeError('Unexpected browser result; mounting was not attempted')
print(json.dumps({'pageCheck': info, 'sourceVersion': version}, ensure_ascii=False))
if not (info['host'] == 'chaoxing.com' or info['host'].endswith('.chaoxing.com')):
    raise RuntimeError('Current tab is not Chaoxing. Select the existing learning tab and retry.')
if info['loginPage'] or not info['top'] or info['loading']:
    raise RuntimeError('Current page is a login page, a subframe, or is still loading; nothing mounted.')
if 'studentstudy' not in info['path'] and info['path'] != '/mooc2-ans/mycourse/stu':
    raise RuntimeError('This source currently supports studentstudy and mooc2-ans mycourse pages. Select an existing course page; no navigation was performed.')
if info['existingRunning']:
    print('An existing task is running; its script and settings were left untouched.')
elif info['existingVersion'] == version:
    print('The local latest version is already mounted; no replacement was needed.')
elif info['legacyPanel']:
    raise RuntimeError('A v1 panel is active. Refresh the current learning page manually before mounting v2.')
else:
    # Suppress both startup mechanisms before evaluating the reviewed local source.
    # Keep all other saved settings; do not read cookies or send progress requests.
    print(js('''(function () {
      var key = 'cx-unified:v2:settings';
      var cfg = {};
      try { cfg = JSON.parse(localStorage.getItem(key) || '{}') || {}; } catch (_) {}
      cfg.autoStart = false;
      localStorage.setItem(key, JSON.stringify(cfg));
      sessionStorage.removeItem('cx-unified:v2:continuation');
      window.__cxMountReviewedSource = '';
      return 'Automatic startup disabled for this mounting check';
    })()'''))
    try:
        for offset in range(0, len(source), 9000):
            js('window.__cxMountReviewedSource += ' + json.dumps(source[offset:offset + 9000], ensure_ascii=False) + "; 'source chunk loaded'")
        print(js('''(function () {
          (0, eval)(window.__cxMountReviewedSource);
          var api = window.__CX_UNIFIED_V2__;
          if (!api) throw new Error('Userscript did not expose its mounted API');
          var state = api.status();
          return JSON.stringify({version: api.version, status: state.status,
            running: state.running, taskCount: state.tasks.length,
            autoStart: state.settings.autoStart});
        })()'''))
    finally:
        js("delete window.__cxMountReviewedSource; 'temporary source buffer removed'")

# A previously saved hidden preference can otherwise make a successful mount invisible.
# Reveal idle panels only; leave an already running task and its UI untouched.
print(js('''(function () {
  var api = window.__CX_UNIFIED_V2__;
  if (!api) return 'No mounted API';
  if (!api.status().running) api.hide(false);
  var state = api.status();
  var host = document.getElementById('cx-unified-v2');
  return JSON.stringify({version: api.version, running: state.running,
    hidden: state.settings.hidden, panelVisible: !!(host && host.getClientRects().length)});
})()'''))

