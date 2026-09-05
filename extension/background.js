const HOST = 'local.chrome_parallel_download';
const requests = new Map();
const pending = new Map();
const active = new Set();
let port, nextId = 0, polling = false;
let tasks = {};
const terminal = new Set(['complete', 'fallback', 'cancelled', 'superseded']);
let cleaning = false;
async function cleanNativeHistory() {
  if (cleaning) return;
  cleaning = true;
  try { await native('prune', {keep: Object.keys(tasks)}); } catch {}
  finally { cleaning = false; }
}
async function persist() {
  for (const [gid, task] of Object.entries(tasks)) if (terminal.has(task.status)) delete tasks[gid];
  await chrome.storage.local.set({tasks});
  await chrome.action.setBadgeText({text: String(Object.values(tasks).filter(t => t.status === 'active').length || '')});
  void cleanNativeHistory();
}
const ready = chrome.storage.local.get({tasks: {}}).then(async s => { tasks = s.tasks; await persist(); });

function connect() {
  if (port) return port;
  const current = chrome.runtime.connectNative(HOST);
  port = current;
  current.onMessage.addListener(message => {
    const waiter = pending.get(message.id);
    if (!waiter) return;
    clearTimeout(waiter.timer);
    pending.delete(message.id);
    message.ok ? waiter.resolve(message.result) : waiter.reject(new Error(message.error));
  });
  current.onDisconnect.addListener(() => {
    const error = chrome.runtime.lastError?.message || '本机程序连接已断开';
    if (port === current) port = null;
    for (const p of pending.values()) { clearTimeout(p.timer); p.reject(new Error(error)); }
    pending.clear();
  });
  return current;
}

function native(action, args = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => { pending.delete(id); reject(new Error('本机程序响应超时')); }, 15000);
    pending.set(id, {resolve, reject, timer});
    try { connect().postMessage({id, action, ...args}); }
    catch (error) { clearTimeout(timer); pending.delete(id); reject(error); }
  });
}

// Keep only short-lived request metadata. Never read or store cookie values.
chrome.webRequest.onBeforeSendHeaders.addListener(details => {
  const headers = {};
  let privateRequest = false;
  for (const h of details.requestHeaders || []) {
    const key = h.name.toLowerCase();
    if (['cookie', 'authorization', 'proxy-authorization'].includes(key)) privateRequest = true;
    if (['referer', 'user-agent'].includes(key)) headers[key] = h.value || '';
  }
  requests.set(details.url, {method: details.method, privateRequest, headers, time: Date.now(),
    requestId: details.requestId});
  for (const [url, r] of requests) if (Date.now() - r.time > 60000) requests.delete(url);
  while (requests.size > 512) requests.delete(requests.keys().next().value);
}, {urls: ['http://*/*', 'https://*/*']}, ['requestHeaders', 'extraHeaders']);

async function resumeChrome(task, note) {
  await native('cancel', {gid: task.gid});
  const [original] = await chrome.downloads.search({id: task.chromeId});
  if (original?.state === 'in_progress' && original.paused) await chrome.downloads.resume(task.chromeId);
  else if (original?.state === 'interrupted' && original.canResume) await chrome.downloads.resume(task.chromeId);
  task.status = 'fallback';
  task.note = original?.state === 'interrupted' && !original.canResume
    ? '请在 Chrome 下载记录中重试' : note;
  await persist();
}

async function intercept(item, retryOf = null) {
  await ready;
  const retry = retryOf && tasks[retryOf]?.status === 'fallback' && tasks[retryOf].chromeId === item.id;
  if (retryOf && !retry) throw new Error('此任务当前不能重新接管');
  if (active.has(item.id) || Object.values(tasks).some(t => t.chromeId === item.id && (!retry || !terminal.has(t.status)))) {
    if (retry) throw new Error('该文件已在接管中');
    return;
  }
  const settings = await chrome.storage.local.get({enabled: true, connections: 8});
  const url = item.finalUrl || item.url;
  let request = requests.get(url);
  // An explicit retry only concerns a previously accepted GET task. Never send login credentials.
  if (retry && (!request || Date.now() - request.time > 60000)) request = {method:'GET',privateRequest:false,headers:{},time:Date.now()};
  if ((!settings.enabled && !retry) || item.byExtensionId || item.incognito || item.state !== 'in_progress' ||
      (item.paused && !retry) || !['safe', 'accepted'].includes(item.danger) || !/^https?:\/\//.test(url) ||
      !request || request.method !== 'GET' || request.privateRequest || Date.now() - request.time > 60000 ||
      (item.totalBytes >= 0 && item.totalBytes < 2 * 1024 * 1024)) {
    if (retry) throw new Error('任务已结束或不符合接管条件，请检查 Chrome 下载记录');
    return;
  }
  active.add(item.id);
  const gid = Array.from(crypto.getRandomValues(new Uint8Array(8)), b => b.toString(16).padStart(2, '0')).join('');
  const task = {gid, chromeId: item.id, name: item.filename.split(/[\\/]/).pop() || 'download.bin',
    status: 'preparing', created: Date.now(), totalLength: item.totalBytes, completedLength: 0};
  try {
    await native('ping');
    tasks[gid] = task;
    await persist();
    if (!item.paused) await chrome.downloads.pause(item.id);
    const [current] = await chrome.downloads.search({id: item.id});
    if (!current || current.state !== 'in_progress' || !current.paused) throw new Error('下载状态已改变');
    await native('prepare', {gid, url, filename: task.name, connections: settings.connections,
      expected: item.totalBytes, headers: request.headers});
    // Recheck cancellation after preparing the native task.
    const [check] = await chrome.downloads.search({id: item.id});
    if (!check || check.state !== 'in_progress' || !check.paused) {
      await native('cancel', {gid}); task.status = 'cancelled';
    } else {
      await native('start', {gid}); task.status = 'active';
      if (retry) {
        tasks[retryOf].status = 'superseded';
        tasks[retryOf].note = '已重新接管，请查看上方的新任务';
      }
    }
    await persist();
  } catch (error) {
    task.note = '接管失败，Chrome 继续下载';
    try {
      await native('cancel', {gid}).catch(() => {});
      const [original] = await chrome.downloads.search({id: item.id});
      if (original?.state === 'in_progress' && original.paused) await chrome.downloads.resume(item.id);
      if (tasks[gid]) { task.status = 'fallback'; await persist(); }
    } catch { task.note = '请在 Chrome 下载记录中恢复下载'; await persist(); }
  } finally { active.delete(item.id); }
}

chrome.downloads.onDeterminingFilename.addListener((item, suggest) => {
  suggest();
  void intercept(item);
});

async function poll() {
  await ready;
  if (polling) return;
  const running = Object.values(tasks).filter(t => !terminal.has(t.status) && !active.has(t.chromeId));
  if (!running.length) { void cleanNativeHistory(); return; }
  polling = true;
  try {
    const states = await native('status', {gids: running.map(t => t.gid)});
    for (const state of states) {
      const task = tasks[state.gid];
      if (!task || terminal.has(task.status)) continue;
      if (['error', 'missing', 'removed'].includes(state.status)) {
        await resumeChrome(task, '多线程下载失败，Chrome 已接回');
      } else if (state.status === 'complete') {
        Object.assign(task, state);
        await persist();
        await chrome.downloads.cancel(task.chromeId).catch(() => {});
      } else {
        const [original] = await chrome.downloads.search({id: task.chromeId});
        if (!original || original.state !== 'in_progress') {
          await native('cancel', {gid: task.gid}); task.status = 'cancelled';
        } else if (!original.paused) {
          await resumeChrome(task, '你在 Chrome 点了继续，已切回原下载。');
        } else {
          if (task.status === 'preparing' && state.status === 'paused') await native('start', {gid: task.gid});
          Object.assign(task, state);
        }
      }
    }
    await persist();
    await chrome.action.setBadgeText({text: String(Object.values(tasks).filter(t => t.status === 'active').length || '')});
  } catch { /* Keep originals paused while a disconnected host reconnects. Never lose a task. */ }
  finally { polling = false; }
}

chrome.downloads.onChanged.addListener(async delta => {
  await ready;
  const task = Object.values(tasks).find(t => t.chromeId === delta.id && !terminal.has(t.status));
  if (!task || active.has(delta.id)) return;
  if (delta.state?.current === 'interrupted') {
    try { await native('cancel', {gid: task.gid}); task.status = 'cancelled'; await persist(); } catch {}
  }
});

chrome.runtime.onMessage.addListener((msg, sender, respond) => {
  if (sender.id !== chrome.runtime.id) return;
  (async () => {
    await ready;
    if (msg.action === 'view') {
      let engine;
      try { engine = await native('ping'); } catch { engine = {error: '本机程序未连接，请运行 install.ps1'}; }
      await poll();
      return {tasks: Object.values(tasks).sort((a,b) => b.created - a.created).slice(0, 100), engine,
        settings: await chrome.storage.local.get({enabled: true, connections: 8})};
    }
    if (msg.action === 'settings') {
      const connections = [4, 8, 16, 32, 64].includes(Number(msg.connections)) ? Number(msg.connections) : 8;
      await chrome.storage.local.set({enabled: !!msg.enabled, connections});
      return {};
    }
    const task = tasks[msg.gid];
    if (!task) throw new Error('任务不存在');
    if (msg.action === 'retry') {
      const [original] = await chrome.downloads.search({id: task.chromeId});
      if (!original) throw new Error('Chrome 原任务已不存在，请从网页重新下载');
      await intercept(original, task.gid);
    } else if (msg.action === 'fallback') await resumeChrome(task, '已切回 Chrome 下载。');
    else if (['pause', 'start', 'show'].includes(msg.action)) {
      await native(msg.action, {gid: task.gid});
      if (msg.action !== 'show') task.status = msg.action === 'pause' ? 'paused' : 'active';
      await persist();
    } else if (msg.action === 'cancel') {
      await native('cancel', {gid: task.gid});
      task.status = 'cancelled'; await persist();
      await chrome.downloads.cancel(task.chromeId).catch(() => {});
    } else throw new Error('未知操作');
    return {};
  })().then(result => respond({ok: true, result}), error => respond({ok: false, error: error.message}));
  return true;
});

chrome.alarms.create('recover', {periodInMinutes: 1});
chrome.alarms.onAlarm.addListener(() => void poll());
setInterval(() => void poll(), 1000);
void poll();
