/* ============================================================
   SpendLens Boot — 本地数据接入
   三条路径：目录句柄（可自动复用）/ 拖拽 · 选文件夹 / 上次快照
   ============================================================ */
;(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const F = root.FMT;

  let dirHandle = null;
  let snapshot = null;

  /* ---------------- IndexedDB ---------------- */
  const DB = 'spendlens', STORE = 'kv';
  const withTimeout = (p, ms) => Promise.race([
    p,
    new Promise((_, rej) => setTimeout(() => rej(new Error('idb timeout')), ms)),
  ]);
  function idb() {
    return withTimeout(new Promise((res, rej) => {
      const r = indexedDB.open(DB, 1);
      r.onupgradeneeded = () => { if (!r.result.objectStoreNames.contains(STORE)) r.result.createObjectStore(STORE); };
      r.onsuccess = () => res(r.result);
      r.onerror = () => rej(r.error);
      r.onblocked = () => rej(new Error('idb blocked'));
    }), 1500);
  }
  async function idbGet(k) {
    try {
      const db = await idb();
      return await withTimeout(new Promise((res, rej) => {
        const t = db.transaction(STORE, 'readonly').objectStore(STORE).get(k);
        t.onsuccess = () => res(t.result);
        t.onerror = () => rej(t.error);
      }), 1500);
    } catch (e) { return null; }
  }
  async function idbSet(k, v) {
    try {
      const db = await idb();
      await withTimeout(new Promise((res, rej) => {
        const tx = db.transaction(STORE, 'readwrite');
        tx.objectStore(STORE).put(v, k);
        tx.oncomplete = res; tx.onerror = () => rej(tx.error);
      }), 4000);
      return true;
    } catch (e) { return false; }
  }

  /* ---------------- 路径归一 ---------------- */
  function normalizePath(p) {
    const parts = String(p).split('/').filter(Boolean);
    const i = parts.lastIndexOf('projects');
    let out = i >= 0 ? parts.slice(i + 1) : parts;
    if (out.length === 1) out = ['导入', out[0]];
    return out.join('/');
  }

  /* ---------------- 从目录句柄读取 ---------------- */
  async function walk(dir, prefix, out) {
    for await (const [name, h] of dir.entries()) {
      if (h.kind === 'directory') {
        await walk(h, prefix + name + '/', out);
      } else if (/\.jsonl$/i.test(name)) {
        out.push({ path: prefix + name, handle: h });
      }
    }
  }

  async function readFromHandle(handle, onStep) {
    const list = [];
    await walk(handle, handle.name + '/', list);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const f = await list[i].handle.getFile();
      out.push({ path: normalizePath(list[i].path), text: await f.text() });
      if (onStep && i % 8 === 0) onStep(i + 1, list.length);
    }
    return out;
  }

  /* ---------------- 进度 ---------------- */
  function progress(show, pct, label) {
    const el = document.querySelector('.progress');
    if (!el) return;
    el.classList.toggle('on', !!show);
    if (pct != null) el.firstElementChild.style.width = Math.min(100, pct) + '%';
    if (label) {
      const l = document.getElementById('progLabel');
      if (l) l.textContent = label;
    }
  }

  /* ---------------- 主流程 ---------------- */
  async function ingest(files, opts) {
    opts = opts || {};
    if (!files.length) {
      err('没有找到 .jsonl 日志文件。请选择 ~/.workbuddy/projects 目录（或它下面的子目录）。');
      return;
    }
    progress(true, 6, `已读取 ${files.length} 个文件，正在解析…`);
    await new Promise(r => setTimeout(r, 30));

    let RAW;
    try {
      RAW = root.SL.parseLogs(files);
    } catch (e) {
      console.error(e);
      err('解析失败：' + e.message);
      progress(false);
      return;
    }
    if (!RAW.sessions.length) {
      err('文件读到了，但没有找到任何带 usage 的请求记录。可能选的目录不对，或日志格式有变化。');
      progress(false);
      return;
    }
    progress(true, 70, `解析出 ${RAW.sessions.length} 个会话，正在建立快照…`);
    await new Promise(r => setTimeout(r, 20));

    // 存快照（失败不阻塞）
    try {
      const J = root.SL.serializeRAW(RAW);
      snapshot = { ts: Date.now(), data: J };
      await idbSet('snap', snapshot);
    } catch (e) { /* 忽略 */ }

    progress(true, 100, '完成');
    root.SLUI.setData(RAW, opts.demo);
    hideGate();
    setTimeout(() => progress(false), 400);
    if (opts.toast) root.SLUI.toast(opts.toast);
  }

  function err(msg) {
    const e = document.getElementById('gateErr');
    if (e) e.textContent = msg;
    else root.SLUI.toast(msg);
  }

  function hideGate() {
    const g = $('gate');
    g.classList.add('off');
    setTimeout(() => { g.style.display = 'none'; }, 400);
  }
  function showGate() {
    const g = $('gate');
    g.style.display = 'flex';
    requestAnimationFrame(() => g.classList.remove('off'));
  }

  /* ---------------- 目录直连 ---------------- */
  async function pickDir() {
    if (!window.showDirectoryPicker) {
      err('这个浏览器不支持目录直连（需要 Chrome/Edge 111+，且页面需在 http(s) 或本地服务下打开）。请用右侧的「拖入或选择文件夹」。');
      return false;
    }
    try {
      dirHandle = await window.showDirectoryPicker({ id: 'wb-projects', mode: 'read' });
    } catch (e) {
      if (e && e.name === 'AbortError') return false;
      err('目录授权被拒绝：' + (e && e.message ? e.message : e) + '。可以改用「拖入或选择文件夹」。');
      return false;
    }
    await idbSet('handle', dirHandle);
    progress(true, 2, '正在遍历目录…');
    const files = await readFromHandle(dirHandle, (i, n) => progress(true, 2 + i / n * 60, `读取日志 ${i}/${n}`));
    await ingest(files, { toast: `已接入 ${files.length} 个日志文件` });
    return true;
  }

  async function rescan() {
    if (dirHandle) {
      try {
        const p = await dirHandle.queryPermission({ mode: 'read' });
        if (p === 'granted' || p === 'prompt') {
          const r = await dirHandle.requestPermission({ mode: 'read' });
          if (r === 'granted') {
            root.SLUI.toast('正在重新扫描…');
            const files = await readFromHandle(dirHandle);
            await ingest(files, { toast: '已更新到最新' });
            return;
          }
        }
      } catch (e) { /* fallthrough */ }
    }
    // 没有句柄 → 走选目录 / 选文件
    if (window.showDirectoryPicker) {
      await pickDir();
    } else {
      pickFiles();
    }
  }

  /* ---------------- 文件 / 文件夹选择 ---------------- */
  function pickFiles() {
    const inp = document.createElement('input');
    inp.type = 'file';
    inp.multiple = true;
    inp.webkitdirectory = true;
    inp.accept = '.jsonl';
    inp.onchange = async () => {
      const fs = [...inp.files].filter(f => /\.jsonl$/i.test(f.name));
      if (!fs.length) { err('选中的文件夹里没有 .jsonl 文件。'); return; }
      progress(true, 4, `读取 ${fs.length} 个文件…`);
      const out = [];
      for (let i = 0; i < fs.length; i++) {
        const f = fs[i];
        out.push({ path: normalizePath(f.webkitRelativePath || f.name), text: await f.text() });
        if (i % 8 === 0) progress(true, 4 + i / fs.length * 60, `读取日志 ${i + 1}/${fs.length}`);
      }
      await ingest(out, { toast: `已接入 ${out.length} 个日志文件` });
    };
    inp.click();
  }

  /* ---------------- 拖拽 ---------------- */
  async function fromDrop(dt) {
    const items = [...(dt.items || [])];
    const entries = items.map(it => it.webkitGetAsEntry && it.webkitGetAsEntry()).filter(Boolean);
    if (!entries.length) {
      const fs = [...(dt.files || [])].filter(f => /\.jsonl$/i.test(f.name));
      const out = [];
      for (const f of fs) out.push({ path: normalizePath(f.name), text: await f.text() });
      await ingest(out, { toast: `已接入 ${out.length} 个日志文件` });
      return;
    }
    progress(true, 3, '正在读取拖入的目录…');
    const out = [];
    async function readEntry(entry, prefix) {
      if (entry.isFile) {
        if (!/\.jsonl$/i.test(entry.name)) return;
        const file = await new Promise((res, rej) => entry.file(res, rej));
        out.push({ path: normalizePath(prefix + entry.name), text: await file.text() });
        if (out.length % 8 === 0) progress(true, 3 + Math.min(60, out.length), `已读取 ${out.length} 个文件`);
      } else if (entry.isDirectory) {
        const rd = entry.createReader();
        let batch;
        do {
          batch = await new Promise((res, rej) => rd.readEntries(res, rej));
          for (const e of batch) await readEntry(e, prefix + entry.name + '/');
        } while (batch.length);
      }
    }
    for (const e of entries) await readEntry(e, '');
    if (!out.length) { err('拖入的内容里没有 .jsonl 文件。'); progress(false); return; }
    await ingest(out, { toast: `已接入 ${out.length} 个日志文件` });
  }

  /* ---------------- 门槛页 ---------------- */
  function renderGate(hasSnap) {
    const fsa = !!window.showDirectoryPicker;
    const ico = {
      dir: '<path d="M3 6a2 2 0 0 1 2-2h4l2 2h8a2 2 0 0 1 2 2v9a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/>',
      file: '<path d="M12 3v11m0 0l-4-4m4 4l4-4M4 18v2a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-2"/>',
      snap: '<circle cx="12" cy="12" r="9"/><path d="M12 7v5.5l3.5 2"/>',
    };
    const svgi = p => `<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${p}</svg>`;

    $('gateIn').innerHTML = `
      <div style="display:flex;align-items:center;justify-content:center;gap:11px;margin-bottom:26px">
        <div class="logo" style="width:34px;height:34px;border-radius:10px;font-size:15px">¥</div>
        <div style="text-align:left">
          <div style="font-size:14px;font-weight:660;letter-spacing:-.01em">workbuddy-spendLens<span style="color:var(--t3);font-weight:400;font-size:11px;letter-spacing:.14em;margin-left:7px">我帮你省钱</span></div>
          <div style="font-size:10px;color:var(--t4);letter-spacing:.16em;margin-top:1px">WORKBUDDY · 1024 造物挑战</div>
        </div>
      </div>
      <h2>你的 AI 账单<br><em>七成花在重复朗读</em></h2>
      <p>把 WorkBuddy 的本地用量日志读进来，算清每一分积分花在<b>哪个项目</b>、<b>哪类任务</b>、<b>哪个模型</b>上，并给出下次该用哪个模型的建议。</p>
      <p style="font-size:11.5px;color:var(--t4);margin-top:8px">本机实测：输入侧占账单 74%，输出只占 26% —— 钱主要买的是「让它反复读前文」。全部在浏览器内存里解析，不联网、不上传。</p>

      <div class="opts">
        <div class="opt" data-a="dir">
          <div class="oi" style="color:var(--teal)">${svgi(ico.dir)}</div>
          <h4>直连本机目录 ${fsa ? '<span class="rec">推荐</span>' : '<span class="rec" style="color:var(--amber);border-color:var(--amber)">不可用</span>'}</h4>
          <p>选择 <span class="mono" style="font-size:10px">~/.workbuddy/projects</span>。授权后会把句柄存进浏览器，下次打开自动复用。</p>
        </div>
        <div class="opt" data-a="file">
          <div class="oi" style="color:var(--cyan)">${svgi(ico.file)}</div>
          <h4>拖入或选择文件夹</h4>
          <p>把整个 projects 文件夹拖进窗口，或点这里选。任何浏览器都能用，无需授权。</p>
        </div>
        <div class="opt" data-a="snap" ${hasSnap ? '' : 'style="opacity:.45"'}>
          <div class="oi" style="color:var(--violet)">${svgi(ico.snap)}</div>
          <h4>载入上次快照</h4>
          <p>${hasSnap ? `上次扫描：${new Date(hasSnap.ts).toLocaleString('zh-CN')}，点这里立即恢复，不用再选目录。` : '还没有快照，先接入一次数据。'}</p>
        </div>
      </div>
      <div class="progress"><i></i></div>
      <div class="err" id="gateErr"></div>
      <div class="privacy">
        支持的日志：<span class="mono">~/.workbuddy/projects/**/*.jsonl</span>（含 subagents 子目录）· 生成的是一张完全离线的单文件网页。<br>
        目录直连依赖 File System Access API，需 Chrome / Edge 111+；若被浏览器拦下（部分环境禁止 file:// 页面调用），请用「拖入或选择文件夹」，效果完全一样。
      </div>`;

    $('gateIn').querySelectorAll('.opt').forEach(o => {
      o.onclick = async () => {
        const a = o.dataset.a;
        if (a === 'dir') await pickDir();
        else if (a === 'file') pickFiles();
        else if (a === 'snap' && snapshot) {
          progress(true, 40, '正在恢复快照…');
          root.SLUI.setData(root.SL.deserializeRAW(snapshot.data), false);
          hideGate();
          progress(false);
          root.SLUI.toast('已载入上次快照 · 点右上角「重扫」可更新');
        }
      };
    });

    // 拖拽
    const g = $('gate');
    ['dragenter', 'dragover'].forEach(t => g.addEventListener(t, e => {
      e.preventDefault(); g.querySelector('.opts').classList.add('hot');
    }));
    ['dragleave', 'drop'].forEach(t => g.addEventListener(t, e => {
      e.preventDefault(); g.querySelector('.opts').classList.remove('hot');
    }));
    g.addEventListener('drop', e => {
      e.preventDefault();
      if (e.dataTransfer) fromDrop(e.dataTransfer);
    });
  }

  /* ---------------- 启动 ---------------- */
  async function boot() {
    root.SLUI.initTheme();
    root.SLUI.bindGlobal();
    $('rescanBtn').onclick = () => rescan();

    // 1) 演示数据
    if (window.__SPENDLENS_DEMO__) {
      try {
        const RAW = root.SL.deserializeRAW(window.__SPENDLENS_DEMO__);
        root.SLUI.setData(RAW, true);
        hideGate();
        // 演示版是固定快照，隐藏「重扫」，避免用户以为能刷出自己机器上的数据
        const rb = $('rescanBtn');
        if (rb) { rb.style.display = 'none'; }
        const ws = $('wsSel'), ms = $('modelSel');
        if (ws) ws.style.display = '';
        return;
      } catch (e) {
        console.error('演示数据载入失败', e);
      }
    }

    // 2) 先立刻把门槛页画出来，绝不让用户看到白屏
    renderGate(null);

    // 3) 再异步探测上次快照与目录句柄
    const snap = await idbGet('snap');
    snapshot = snap || null;
    const h = await idbGet('handle');
    if (h) {
      dirHandle = h;
      try {
        const p = await h.queryPermission({ mode: 'read' });
        if (p === 'granted') {
          progress(true, 4, '已获得上次的目录授权，正在自动读取…');
          const files = await readFromHandle(h, (i, n) => progress(true, 4 + i / n * 60, `读取日志 ${i}/${n}`));
          await ingest(files, { toast: '已自动读取本机最新日志' });
          return;
        }
      } catch (e) { /* 忽略，走门槛页 */ }
    }

    // 4) 有快照就直接展示（打开即见数据）
    if (snapshot && snapshot.data) {
      root.SLUI.setData(root.SL.deserializeRAW(snapshot.data), false);
      hideGate();
      root.SLUI.toast('已载入上次快照 · 点「重扫」读取最新');
      return;
    }
    // 5) 更新门槛页文案（此时才知道有没有快照）
    renderGate(snapshot);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot);
  else boot();
})(window);
