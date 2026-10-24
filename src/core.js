/* ============================================================
 * SpendLens Core — WorkBuddy 账单解析与省钱分析引擎
 * 纯浏览器端，无依赖。数据不出本机。
 * 数据契约见 README「数据模型」。
 * ============================================================ */
;(function (root) {
  'use strict';

  /* 两个「积分值多少钱」的口径，别混：
     CP_USER    —— 展示口径。按用户实际计费方式折算（套餐折算单价 或 积分牌价 ¥0.05）
     CP_NOMINAL —— 名义口径。只用于把官方牌价 ¥/M 换算成积分/M，不应随套餐变化 */
  let CP_USER = 0.05;
  const CP_NOMINAL = 0.05;

  /* ---------------- 工具族 ---------------- */
  const FAMILY = {
    Bash: '执行', PowerShell: '执行',
    Read: '勘探', Grep: '勘探', Glob: '勘探', LSP: '勘探',
    Edit: '精修',
    Write: '创作',
    WebSearch: '调研', WebFetch: '调研',
    Agent: '编排', SendMessage: '编排', TeamCreate: '编排', TeamDelete: '编排',
    TaskCreate: '管理', TaskUpdate: '管理', TaskList: '管理', TaskGet: '管理', TaskStop: '管理',
    present_files: '交付',
  };
  const FAMILY_LIST = ['执行', '勘探', '精修', '创作', '调研', '编排', '管理', '交付', '工具', '应答'];

  function familyOf(name, args) {
    if (!name) return '应答';
    if (name === 'DeferExecuteTool' || name.startsWith('mcp__')) {
      const t = args && (args.toolName || args.tool_name);
      if (t && FAMILY[t]) return FAMILY[t];
      return '工具';
    }
    return FAMILY[name] || '工具';
  }

  /* ---------------- 小工具 ---------------- */
  const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
  const log2 = Math.log2;

  function tsOf(v) {
    // 统一返回毫秒时间戳
    if (typeof v === 'number') {
      if (v > 1e12) return Math.round(v);          // 已是毫秒
      if (v > 1e9) return Math.round(v * 1000);    // 秒
      return 0;
    }
    if (typeof v === 'string' && v) {
      const t = Date.parse(v);
      if (!isNaN(t)) return t;
      const n = parseFloat(v);
      if (!isNaN(n)) return n > 1e12 ? Math.round(n) : Math.round(n * 1000);
    }
    return 0;
  }

  function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    let s = '';
    for (const seg of content) {
      if (seg && typeof seg === 'object' && typeof seg.text === 'string') s += seg.text;
    }
    return s;
  }

  function outText(o) {
    const out = o.output;
    if (typeof out === 'string') return out;
    if (Array.isArray(out)) {
      let s = '';
      for (const seg of out) if (seg && typeof seg === 'object' && typeof seg.text === 'string') s += seg.text;
      return s;
    }
    if (out && typeof out === 'object') return typeof out.text === 'string' ? out.text : '';
    return '';
  }

  function baseName(p) {
    if (!p) return '';
    const i = Math.max(p.lastIndexOf('/'), p.lastIndexOf('\\'));
    return i >= 0 ? p.slice(i + 1) : p;
  }

  /* ============================================================
   * 1. 解析：jsonl 行 → 会话聚合
   * files: [{ path, text }]   path 形如 <workdir>/<sid>/subagents/agent-x.jsonl
   * ============================================================ */
  function parseLogs(files, opt) {
    opt = opt || {};
    const S = new Map();          // sid -> session
    const wsSet = new Map();      // folder -> idx
    const wsArr = [];
    const modelSet = new Map();
    const models = [];
    let bytes = 0, lineCount = 0, badLines = 0, creditRows = 0, genTools = [];

    const getWs = (folder, label) => {
      if (!wsSet.has(folder)) {
        wsSet.set(folder, wsArr.length);
        wsArr.push({ folder, label: label || shortWs(folder) });
      }
      return wsSet.get(folder);
    };
    const getModel = (m) => {
      if (!modelSet.has(m)) { modelSet.set(m, models.length); models.push(m); }
      return modelSet.get(m);
    };
    const getSess = (sid, wsIdx) => {
      let s = S.get(sid);
      if (!s) {
        s = {
          id: sid, ws: wsIdx, title: '', titleSrc: '', st: 0, en: 0,
          rq: [],                       // 请求级
          toolCount: {}, calls: 0, fails: 0, failCredit: 0,
          filesNew: [], filesEdit: [], fileEdits: new Map(), fileReads: new Map(),
          chars: 0, charsNew: 0, charsEdit: 0, pf: 0, turns: 0,
          agentCalls: 0, agents: new Map(), subCredit: 0,
          callIdx: new Map(),           // callId -> 请求索引（用于失败回填）
        };
        S.set(sid, s);
      }
      return s;
    };

    for (const f of files) {
      const path = f.path || '';
      const parts = path.split(/[\\/]/).filter(Boolean);
      if (parts.length < 2) continue;
      const folder = parts[0];
      const isSub = parts.length > 2;
      const sid = isSub ? parts[1] : parts[1].replace(/\.jsonl$/i, '');
      const wsIdx = getWs(folder);
      const s = getSess(sid, wsIdx);
      const text = f.text || '';
      bytes += text.length;

      const lines = text.split('\n');
      for (let li = 0; li < lines.length; li++) {
        const line = lines[li];
        if (!line) continue;
        let o;
        try { o = JSON.parse(line); } catch (e) { badLines++; continue; }
        if (!o || typeof o !== 'object') continue;
        lineCount++;
        const type = o.type;

        /* ---- 标题 ---- */
        if (type === 'ai-title' && o.aiTitle && !s.title) {
          s.title = String(o.aiTitle).slice(0, 60); s.titleSrc = 'ai';
        }

        /* ---- 用户轮次 / 兜底标题 ---- */
        if ((type === 'message' || o.role === 'user') && o.role === 'user') {
          const t = textOf(o.content).trim();
          if (t && t.charCodeAt(0) !== 60 /* < */) {
            s.turns++;
            if (!s.title) { s.title = t.replace(/\s+/g, ' ').slice(0, 60); s.titleSrc = 'user'; }
          }
        }

        const pd = o.providerData;
        const ru = pd && typeof pd === 'object' ? pd.rawUsage : null;

        /* ---- 工具调用 ---- */
        if (type === 'function_call') {
          s.calls++;
          const name = o.name || '';
          const fam = familyOf(name, o._argsParsed);
          s.toolCount[fam] = (s.toolCount[fam] || 0) + 1;

          let a = null;
          try { a = JSON.parse(o.arguments || '{}'); } catch (e) { a = null; }
          if (!a || typeof a !== 'object') a = {};
          const fam2 = familyOf(name, a);
          if (fam2 !== fam) { s.toolCount[fam]--; s.toolCount[fam2] = (s.toolCount[fam2] || 0) + 1; }

          if (name === 'Write' && a.file_path) {
            const c = typeof a.content === 'string' ? a.content : '';
            s.chars += c.length; s.charsNew += c.length;
            const b = baseName(a.file_path);
            if (s.filesNew.indexOf(b) < 0) s.filesNew.push(b);
            s.filesNew.paths = s.filesNew.paths || {};
            s.filesNew.paths[b] = a.file_path;
          } else if (name === 'Edit' && a.file_path) {
            const c = typeof a.new_string === 'string' ? a.new_string : '';
            s.chars += c.length; s.charsEdit += c.length;
            const b = baseName(a.file_path);
            if (s.filesEdit.indexOf(b) < 0) s.filesEdit.push(b);
            s.fileEdits.set(b, (s.fileEdits.get(b) || 0) + 1);
          } else if (name === 'Read' && a.file_path) {
            const b = baseName(a.file_path);
            s.fileReads.set(b, (s.fileReads.get(b) || 0) + 1);
          } else if (name === 'present_files') {
            s.pf++;
          } else if (name === 'Agent') {
            s.agentCalls++;
          }
          if (o.callId && ru && ru.total_tokens) s.callIdx.set(o.callId, s.rq.length);
          else if (o.callId) s.callIdx.set(o.callId, -1);
        }

        /* ---- 工具结果：失败检测 ---- */
        if (type === 'function_call_result') {
          let bad = false;
          if (o.status && o.status !== 'completed') bad = true;
          else {
            const t = outText(o);
            const m = /Exit Code:\s*(-?\d+)/.exec(t);
            if (m) bad = m[1] !== '0';
            else if (/^(error|exception)[:\s]/i.test(t)) bad = true;
          }
          if (bad) {
            s.fails++;
            const ri = o.callId ? s.callIdx.get(o.callId) : -1;
            if (ri >= 0 && s.rq[ri]) { s.rq[ri].fail = 1; s.failCredit += s.rq[ri].cr; }
          }
        }

        /* ---- 请求级 usage ---- */
        if (ru && ru.total_tokens) {
          const ts = tsOf(o.timestamp);
          if (!ts) continue;
          const it = (ru.prompt_tokens != null ? ru.prompt_tokens : 0) | 0;
          const ot = (ru.completion_tokens != null ? ru.completion_tokens : 0) | 0;
          let hit = ru.prompt_cache_hit_tokens;
          if (hit == null) {
            const d = ru.prompt_tokens_details || {};
            hit = d.cached_tokens || 0;
          }
          hit = hit | 0;
          let cw = ru.prompt_cache_write_tokens || 0;
          if (!cw) {
            const d = ru.prompt_tokens_details || {};
            cw = d.cache_write_tokens || d.cache_creation_tokens || 0;
          }
          const cr = ru.credit != null ? +ru.credit : null;
          const model = pd.model || pd.requestModelId || pd.requestModelName || 'unknown';
          const agent = pd.agent || '';
          const toolName = type === 'function_call' ? (o.name || '') : '';
          let fam3 = '应答';
          if (toolName) {
            let a2 = null;
            try { a2 = JSON.parse(o.arguments || '{}'); } catch (e) { a2 = null; }
            fam3 = familyOf(toolName, a2);
          }
          s.rq.push({
            ts, it, ot, hit, cw, cr: cr == null ? 0 : cr, m: getModel(model),
            f: fam3, sub: agent, fail: 0, tid: s.rq.length,
          });
          if (cr != null) creditRows++;
          if (!s.st) s.st = ts;
          s.en = Math.max(s.en || 0, ts);
          if (agent) {
            s.agents.set(agent, (s.agents.get(agent) || 0) + 1);
            if (isSub) s.subCredit += (cr || 0);
          }
        }

        /* ---- 非 token 计费（生成类工具）---- */
        if (type === 'credit-usage') {
          const pd2 = o.providerData || {};
          const stage = String(pd2.stageId || '');
          if (pd2.source === 'generation_tool' && pd2.credit != null) {
            genTools.push({ ts: tsOf(o.timestamp), credit: +pd2.credit, stage, sid, ws: wsIdx });
          }
        }
      }
    }

    /* ---- 收尾：清洗 + 排序 ---- */
    const sessions = [];
    for (const s of S.values()) {
      if (!s.rq.length) continue;
      s.rq.sort((a, b) => a.ts - b.ts);
      s.rq.forEach((r, i) => { r.tid = i; });
      // 重复读取
      let dup = 0, readN = 0, worst = null, worstN = 0;
      for (const [f, n] of s.fileReads) {
        readN += n;
        if (n > 1) {
          dup += n - 1;
          if (n > worstN) { worstN = n; worst = f; }
        }
      }
      s.dupReads = dup; s.readCalls = readN; s.worstRead = worst; s.worstReadN = worstN;
      s.filesTouched = uniq(s.filesNew.concat(s.filesEdit)).length;
      s.credit = s.rq.reduce((a, r) => a + r.cr, 0);
      s.in = s.rq.reduce((a, r) => a + r.it, 0);
      s.hit = s.rq.reduce((a, r) => a + r.hit, 0);
      s.out = s.rq.reduce((a, r) => a + r.ot, 0);
      s.reqs = s.rq.length;
      s.durMin = s.en > s.st ? (s.en - s.st) / 60000 : 0;
      // 主导模型 + 模型构成（含积分/输出分摊）
      const mc = new Map();
      for (const r of s.rq) {
        let e = mc.get(r.m);
        if (!e) { e = { m: r.m, n: 0, credit: 0, out: 0, in: 0, hit: 0 }; mc.set(r.m, e); }
        e.n++; e.credit += r.cr; e.out += r.ot; e.in += r.it; e.hit += r.hit;
      }
      let best = -1, bn = 0;
      for (const [m, e] of mc) if (e.n > bn) { bn = e.n; best = m; }
      s.domModel = best;
      s.modelShare = Array.from(mc.values()).sort((a, b) => b.n - a.n);
      s.toolTop = Object.entries(s.toolCount).sort((a, b) => b[1] - a[1]).slice(0, 4);
      s.agentsN = s.agents.size;
      s.arch = classifyArch(s);
      sessions.push(s);
    }
    sessions.sort((a, b) => a.st - b.st);

    // 生成类工具计费按会话回填
    for (const g of genTools) {
      for (const s of sessions) {
        if (s.id === g.sid) { s.genCredit = (s.genCredit || 0) + g.credit; break; }
      }
    }

    const range = { min: Infinity, max: 0 };
    for (const s of sessions) { range.min = Math.min(range.min, s.st); range.max = Math.max(range.max, s.en); }
    if (!isFinite(range.min)) range.min = Date.now();

    return {
      sessions, ws: wsArr, models, range,
      files: files.length, bytes, lineCount, badLines, creditRows,
      genTools,
    };
  }

  function uniq(a) { return Array.from(new Set(a)); }

  function shortWs(name) {
    const i = name.lastIndexOf('-WorkBuddy-');
    if (i >= 0 && name.slice(i + 11)) return name.slice(i + 11);
    return name;
  }

  /* ============================================================
   * 2. 任务原型分类
   * ============================================================ */
  const ARCHS = ['批量生产', '精修迭代', '代码勘探', '工程执行', '联网调研', '多智能体编排', '轻量问答'];
  const ARCH_DESC = {
    '批量生产': '大量新建文件、单轮产出高，常见于写稿/生成资料/批量落盘',
    '精修迭代': '反复编辑同一批文件，逐轮打磨',
    '代码勘探': '以读取与检索为主，低成本摸清现状',
    '工程执行': '以命令行执行为主，跑脚本、装依赖、构建验证',
    '联网调研': '以搜索与抓取为主，收集外部信息',
    '多智能体编排': '派生多个子代理并行作业',
    '轻量问答': '少量请求、低产出，以对话为主',
  };

  function classifyArch(s) {
    const c = Math.max(1, s.calls);
    const sh = k => (s.toolCount[k] || 0) / c;
    const perReq = s.chars / Math.max(1, s.rq.length);
    if (sh('编排') > 0.05 || s.agentsN >= 3 || s.agentCalls >= 4) return '多智能体编排';
    if (sh('创作') > 0.16 || perReq > 2200) return '批量生产';
    if (sh('调研') > 0.08) return '联网调研';
    if (sh('精修') > 0.38) return '精修迭代';
    if (sh('勘探') > 0.45) return '代码勘探';
    if (sh('执行') > 0.40) return '工程执行';
    return '轻量问答';
  }

  /* ============================================================
   * 3. 价格系数反解（加权最小二乘 + 一次截尾）
   * credit ≈ pm*miss + ph*hit + po*out   （单位：积分 / 百万 token）
   * ============================================================ */
  const OFFICIAL = {   // 官方牌价 ¥/百万 token（兜底用），hit=缓存命中，po=输出
    'deepseek-v4.1-flash': { pm: 1.065, ph: 0.0426, po: 4.26, src: 'DeepSeek 官网（峰谷价取下限）' },
    'kimi-k3.1-pro': { pm: 13, ph: 1.3, po: 68, src: 'Kimi 开放平台 K3 系列' },
    'hy4-preview': { pm: 6, ph: 0.3, po: 18, src: '腾讯混元 Hy4 preview' },
  };

  function solve3(A, b) {
    const M = [[...A[0], b[0]], [...A[1], b[1]], [...A[2], b[2]]];
    for (let i = 0; i < 3; i++) {
      let p = i;
      for (let r = i + 1; r < 3; r++) if (Math.abs(M[r][i]) > Math.abs(M[p][i])) p = r;
      if (Math.abs(M[p][i]) < 1e-12) return null;
      [M[i], M[p]] = [M[p], M[i]];
      for (let r = 0; r < 3; r++) {
        if (r === i) continue;
        const f = M[r][i] / M[i][i];
        for (let c2 = i; c2 < 4; c2++) M[r][c2] -= f * M[i][c2];
      }
    }
    return [M[0][3] / M[0][0], M[1][3] / M[1][1], M[2][3] / M[2][2]];
  }

  function fitOnce(rows, w) {
    const X = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], Y = [0, 0, 0];
    for (const r of rows) {
      const v = [r.miss / 1e6, r.hit / 1e6, r.out / 1e6];
      const wt = w ? w(r) : 1;
      for (let i = 0; i < 3; i++) {
        Y[i] += wt * v[i] * r.cr;
        for (let j = 0; j < 3; j++) X[i][j] += wt * v[i] * v[j];
      }
    }
    const co = solve3(X, Y);
    if (!co) return null;
    let sse = 0, sst = 0, n = 0, mean = 0;
    for (const r of rows) { mean += r.cr; n++; }
    mean /= Math.max(1, n);
    for (const r of rows) {
      const p = co[0] * r.miss / 1e6 + co[1] * r.hit / 1e6 + co[2] * r.out / 1e6;
      sse += (p - r.cr) * (p - r.cr);
      sst += (r.cr - mean) * (r.cr - mean);
    }
    return { co, r2: sst > 0 ? 1 - sse / sst : 0, n };
  }

  function fitPricing(sessions, models) {
    const byModel = new Map();
    for (const s of sessions) {
      for (const r of s.rq) {
        let b = byModel.get(r.m);
        if (!b) { b = []; byModel.set(r.m, b); }
        b.push({ miss: Math.max(0, r.it - r.hit), hit: r.hit, out: r.ot, cr: r.cr });
      }
    }
    const out = [];
    for (const [mi, rows] of byModel) {
      const name = models[mi];
      let fit = null;
      if (rows.length >= 40) {
        fit = fitOnce(rows);
        if (fit && (fit.co[0] <= 0 || fit.co[1] < 0 || fit.co[2] <= 0)) fit = null;
      }
      const totCredit = rows.reduce((a, r) => a + r.cr, 0);
      const totOut = rows.reduce((a, r) => a + r.out, 0);
      const totIn = rows.reduce((a, r) => a + r.miss + r.hit, 0);
      const totHit = rows.reduce((a, r) => a + r.hit, 0);
      let price, priceSrc, r2 = 0;
      if (fit) { price = fit.co; priceSrc = '实测拟合'; r2 = fit.r2; }
      else if (OFFICIAL[name]) {
        const o = OFFICIAL[name];
        price = [o.pm / CP_NOMINAL, o.ph / CP_NOMINAL, o.po / CP_NOMINAL];
        priceSrc = '官方牌价'; r2 = 0;
      } else {
        price = null; priceSrc = '未知';
      }
      out.push({
        m: mi, name, n: rows.length, credit: totCredit, out: totOut, in: totIn, hit: totHit,
        // 积分/百万 token
        pm: price ? price[0] : null, ph: price ? price[1] : null, po: price ? price[2] : null,
        src: priceSrc, r2,
        // 有效单价：每百万「有效折算 token」的积分
        blended: price ? price[0] * (1 - totIn ? 0 : totHit / totIn) + price[1] * (totIn ? totHit / totIn : 0) : null,
        yuanPerMOut: price ? price[2] * CP_USER : null,
      });
    }
    out.sort((a, b) => b.credit - a.credit);
    return out;
  }

  /* ============================================================
   * 4. 聚合（带筛选）
   * filter: { from, to, ws:Set|null, models:Set|null }
   * ============================================================ */
  function aggregate(RAW, filter) {
    filter = filter || {};
    const from = filter.from || 0, to = filter.to || Infinity;
    const wsF = filter.ws && filter.ws.size ? filter.ws : null;
    const mF = filter.models && filter.models.size ? filter.models : null;

    const sess = [];
    for (const s of RAW.sessions) {
      if (s.en < from || s.st > to) continue;
      if (wsF && !wsF.has(s.ws)) continue;
      const rq = s.rq.filter(r => r.ts >= from && r.ts <= to && (!mF || mF.has(r.m)));
      if (!rq.length) continue;
      sess.push(mkView(s, rq));
    }

    // 全局
    const T = {
      credit: 0, in: 0, hit: 0, out: 0, reqs: 0, chars: 0, calls: 0, fails: 0,
      failCredit: 0, dupReads: 0, readCalls: 0, pf: 0, turns: 0, filesNew: 0, filesTouched: 0,
      genCredit: 0, subCredit: 0,
    };
    const byModel = new Map(), byWs = new Map(), byTool = new Map(), byArch = new Map();
    const byDay = new Map();
    const hourGrid = new Float64Array(7 * 24);
    const heatGrid = new Float64Array(7 * 24);   // 周一→周日 × 0-23 时，单位 token
    const reqSizes = [];

    for (const s of sess) {
      T.credit += s.credit; T.in += s.in; T.hit += s.hit; T.out += s.out;
      T.reqs += s.reqs; T.chars += s.chars; T.calls += s.calls; T.fails += s.fails;
      T.failCredit += s.failCredit; T.dupReads += s.dupReads; T.readCalls += s.readCalls;
      T.pf += s.pf; T.turns += s.turns; T.filesNew += s.filesNew.length; T.filesTouched += s.filesTouched;
      T.genCredit += s.genCredit || 0; T.subCredit += s.subCredit || 0;

      // 模型
      for (const r of s.rq) {
        let m = byModel.get(r.m);
        if (!m) { m = { m: r.m, reqs: 0, credit: 0, in: 0, hit: 0, out: 0, miss: 0, sess: new Set(), fails: 0, chars: 0 }; byModel.set(r.m, m); }
        m.reqs++; m.credit += r.cr; m.in += r.it; m.hit += r.hit; m.out += r.ot;
        m.miss += Math.max(0, r.it - r.hit); m.fails += r.fail; m.sess.add(s.id);
        // 工具族
        let t = byTool.get(r.f);
        if (!t) { t = { f: r.f, reqs: 0, credit: 0, in: 0, hit: 0, out: 0 }; byTool.set(r.f, t); }
        t.reqs++; t.credit += r.cr; t.in += r.it; t.hit += r.hit; t.out += r.ot;
        const d = dayKey(r.ts);
        let dd = byDay.get(d);
        if (!dd) { dd = { d, credit: 0, reqs: 0, out: 0, m: new Map() }; byDay.set(d, dd); }
        dd.credit += r.cr; dd.reqs++; dd.out += r.ot;
        dd.m.set(r.m, (dd.m.get(r.m) || 0) + r.cr);
        const dt = new Date(r.ts);
        hourGrid[dt.getDay() * 24 + dt.getHours()] += r.cr;
        heatGrid[((dt.getDay() + 6) % 7) * 24 + dt.getHours()] += (r.it + r.ot);
        if (reqSizes.length < 40000) reqSizes.push(r.it + r.ot);
      }
      // 会话的产出字符按输出 token 占比分摊（写作量与输出强相关，优于按请求数分摊）
      for (const ms of s.modelShare) {
        const m = byModel.get(ms.m);
        if (m) m.chars += s.chars * (ms.out / Math.max(1, s.out));
      }
      // 工作空间
      let w = byWs.get(s.ws);
      if (!w) { w = { w: s.ws, label: RAW.ws[s.ws] ? RAW.ws[s.ws].label : 'ws' + s.ws, credit: 0, reqs: 0, chars: 0, sess: [], out: 0, in: 0 }; byWs.set(s.ws, w); }
      w.credit += s.credit; w.reqs += s.reqs; w.chars += s.chars; w.out += s.out; w.in += s.in;
      w.sess.push(s);
      // 原型
      let a = byArch.get(s.arch);
      if (!a) { a = { arch: s.arch, credit: 0, chars: 0, reqs: 0, n: 0, models: new Map() }; byArch.set(s.arch, a); }
      a.credit += s.credit; a.chars += s.chars; a.reqs += s.reqs; a.n++;
      for (const ms of s.modelShare) {
        const prev = a.models.get(ms.m) || { m: ms.m, credit: 0, n: 0, chars: 0, out: 0 };
        prev.credit += ms.credit; prev.n += ms.n; prev.out += ms.out; prev.chars += s.chars * (ms.out / Math.max(1, s.out));
        a.models.set(ms.m, prev);
      }
    }

    const pricing = fitPricing(sess, RAW.models);

    // 派生
    T.yuan = T.credit * CP_USER;
    T.cacheRate = T.in ? T.hit / T.in : 0;
    T.outputShare = (T.in + T.out) ? T.out / (T.in + T.out) : 0;
    T.avgIn = T.reqs ? T.in / T.reqs : 0;
    T.perKChar = T.chars > 0 ? T.yuan / (T.chars / 1000) : null;
    T.cacheSaving = 0;
    const split = { miss: 0, hit: 0, out: 0 };
    for (const m of pricing) {
      if (m.pm == null) continue;
      const bm = byModel.get(m.m);
      if (!bm) continue;
      const missC = bm.miss / 1e6 * m.pm;
      const hitC = bm.hit / 1e6 * m.ph;
      const outC = bm.out / 1e6 * m.po;
      split.miss += missC * CP_USER;
      split.hit += hitC * CP_USER;
      split.out += outC * CP_USER;
      T.cacheSaving += bm.hit / 1e6 * (m.pm - m.ph) * CP_USER;
    }
    split.other = Math.max(0, T.yuan - split.miss - split.hit - split.out);
    T.costSplit = split;
    T.cacheSaving = Math.max(0, T.cacheSaving);

    /* 官方 API 等价：与上面的「实测拟合」是两套口径 ——
       这里用官网公开牌价 × 你的真实 token 结构，回答「如果直接调官方 API 要花多少」。
       没有公开牌价的模型不计入，并返回覆盖比例，避免拿部分样本冒充全量。 */
    let official = 0, officialCover = 0;
    const officialMissing = [];
    const officialByModel = [];
    for (const m of byModel.values()) {
      const name = RAW.models[m.m];
      const o = OFFICIAL[name];
      const actual = m.credit * CP_USER;
      if (!o) {
        officialMissing.push(name);
        officialByModel.push({ m: m.m, name, official: null, actual, delta: null });
        continue;
      }
      const c = (m.miss / 1e6) * o.pm + (m.hit / 1e6) * o.ph + (m.out / 1e6) * o.po;
      official += c;
      officialCover += m.credit;
      officialByModel.push({ m: m.m, name, official: c, actual, delta: c - actual });
    }
    officialByModel.sort((a, b) => (a.delta == null ? 1 : b.delta == null ? -1 : a.delta - b.delta));
    T.official = official;
    T.officialCover = T.credit > 0 ? officialCover / T.credit : 0;
    T.officialMissing = officialMissing;
    T.officialByModel = officialByModel;
    T.saveYuan = official - T.yuan;                       // 官方等价 − 实付积分折算
    T.savePct = official > 0 ? T.saveYuan / official : 0;

    /* 统计窗口天数：按「日历天数」算，不按有活动的天数。
       订阅费是按下单周期摊的固定支出，7 天窗口就是 7 天的钱，
       跟这 7 天里有几天真的在干活无关。 */
    const effFrom = Math.max(from || 0, RAW.range.min);
    const effTo = Math.min(to === Infinity ? RAW.range.max : to, RAW.range.max);
    const winDays = Math.max(1, (effTo - effFrom) / 86400000);
    T.days = winDays;
    T.perMonthCredit = T.credit / (winDays / 30.4375);

    // 会话评分（需要全局中位数）
    const effs = sess.filter(s => s.chars > 0).map(s => s.credit / (s.chars / 1000) * CP_USER).sort((a, b) => a - b);
    const medianEff = effs.length ? effs[Math.floor(effs.length / 2)] : null;
    const maxChars = sess.reduce((a, s) => Math.max(a, s.chars), 1);
    const maxRead = sess.reduce((a, s) => Math.max(a, s.fileReads.size), 1);
    for (const s of sess) scoreSession(s, medianEff, maxChars, maxRead);

    const days = Array.from(byDay.values()).sort((a, b) => a.d < b.d ? -1 : 1);

    return {
      RAW, filter, sess, T, pricing, medianEff, days, hourGrid, heatGrid,
      byModel: Array.from(byModel.values()).sort((a, b) => b.credit - a.credit),
      byWs: Array.from(byWs.values()).sort((a, b) => b.credit - a.credit),
      byTool: Array.from(byTool.values()).sort((a, b) => b.credit - a.credit),
      byArch: Array.from(byArch.values()).sort((a, b) => b.credit - a.credit),
      reqSizes,
    };
  }

  function mkView(s, rq) {
    const inT = rq.reduce((a, r) => a + r.it, 0);
    const hitT = rq.reduce((a, r) => a + r.hit, 0);
    const outT = rq.reduce((a, r) => a + r.ot, 0);
    const credit = rq.reduce((a, r) => a + r.cr, 0);
    // 会话级指标（产出字数/失败数/重复读）在筛选后按输出 token 占比折算，
    // 否则「按模型筛」或「按时间窗筛」时会把整会话的量算到子集上。
    const f = s.out > 0 ? clamp(outT / s.out, 0, 1) : (rq.length === s.reqs ? 1 : 0);
    const full = rq.length === s.reqs;
    // 模型构成也要按筛选后的请求重算，否则桑基图会画出被筛掉的模型
    const mc = new Map();
    for (const r of rq) {
      let e = mc.get(r.m);
      if (!e) { e = { m: r.m, n: 0, credit: 0, out: 0, in: 0, hit: 0 }; mc.set(r.m, e); }
      e.n++; e.credit += r.cr; e.out += r.ot; e.in += r.it; e.hit += r.hit;
    }
    return {
      id: s.id, ws: s.ws, title: s.title || '(未命名会话)', titleSrc: s.titleSrc,
      arch: s.arch, st: s.st, en: s.en, rq,
      reqs: rq.length, credit, in: inT, hit: hitT, out: outT,
      chars: Math.round(s.chars * f),
      calls: full ? s.calls : rq.length,
      fails: full ? s.fails : Math.round(s.fails * f),
      failCredit: s.failCredit * f,
      dupReads: Math.round(s.dupReads * f), readCalls: full ? s.readCalls : Math.round(s.readCalls * f),
      worstRead: s.worstRead, worstReadN: s.worstReadN,
      filesNew: s.filesNew, filesEdit: s.filesEdit, fileEdits: s.fileEdits, fileReads: s.fileReads,
      filesTouched: full ? s.filesTouched : Math.round(s.filesTouched * f),
      pf: s.pf, turns: s.turns,
      toolCount: s.toolCount, toolTop: s.toolTop,
      modelShare: Array.from(mc.values()).sort((a, b) => b.n - a.n),
      domModel: (Array.from(mc.values()).sort((a, b) => b.n - a.n)[0] || { m: s.domModel }).m,
      agentsN: s.agentsN, agentCalls: s.agentCalls, agents: s.agents,
      genCredit: (s.genCredit || 0) * f, subCredit: s.subCredit * f,
      durMin: s.en > s.st ? (s.en - s.st) / 60000 : 0,
      charsNew: Math.round(s.charsNew * f), charsEdit: Math.round(s.charsEdit * f),
      partial: !full,
    };
  }

  function dayKey(ts) {
    const d = new Date(ts);
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  /* ============================================================
   * 5. 价值评分（三维 + 可调权重）
   *    设计取舍：不设「规模」维，因为它与交付力高度相关，重复计权会放大
   *    大任务的优势。成本不进入价值分，而是作为分母独立呈现为性价比。
   * ============================================================ */
  const W_DEFAULT = { d: 0.45, e: 0.35, h: 0.20 };

  function scoreSession(s, medianEff, maxChars, maxRead) {
    const yuan = s.credit * CP_USER;
    const perK = s.chars > 0 ? yuan / (s.chars / 1000) : null;

    /* 交付力 D：有没有真的落下东西（对数尺度，相对本批最大产出归一） */
    let D, dNa = false;
    if (s.chars > 0) {
      D = 100 * Math.log10(1 + s.chars) / Math.log10(1 + Math.max(maxChars, 10));
      if (s.pf > 0) D = Math.min(100, D + 6);
    } else if (s.filesTouched > 0) {
      D = Math.min(45, 12 * Math.log10(1 + s.filesTouched));
      dNa = true;
    } else {
      D = Math.min(42, 100 * Math.log10(1 + s.fileReads.size) / Math.log10(1 + Math.max(maxRead, 10)) * 0.42);
      dNa = true;
    }
    D = clamp(D, 0, 100);

    /* 效率 E：单位成本 vs 本批中位数。无落盘产出时不可比，取中性分 */
    let E, eNa = false;
    if (perK != null && medianEff) {
      E = clamp(60 * Math.sqrt(medianEff / Math.max(perK, 1e-4)), 0, 100);
    } else {
      E = 55; eNa = true;
    }

    /* 健康 H：失败、重复读、上下文膨胀 */
    const errRate = s.calls ? s.fails / s.calls : 0;
    const dupShare = s.readCalls ? s.dupReads / s.readCalls : 0;
    const avgIn = s.reqs ? s.in / s.reqs : 0;
    const bloat = clamp(avgIn / 120000, 0, 1);
    const H = clamp(100 - 45 * clamp(errRate / 0.15, 0, 1) - 30 * clamp(dupShare / 0.5, 0, 1) - 25 * bloat, 0, 100);

    s.D = D; s.E = E; s.H = H; s.dNa = dNa; s.eNa = eNa;
    s.perK = perK;
    s.yuan = yuan;
    s.eff = s.chars > 0 ? s.chars / Math.max(yuan, 0.01) : 0;  // 字/元
    s.errRate = errRate; s.dupShare = dupShare; s.avgIn = avgIn;
    s.value = (W_DEFAULT.d * D + W_DEFAULT.e * E + W_DEFAULT.h * H);
    return s;
  }

  function rescore(sessions, w) {
    const sw = (w.d + w.e + w.h) || 1;
    for (const s of sessions) {
      s.value = (w.d * s.D + w.e * s.E + w.h * s.H) / sw;
    }
    return sessions;
  }

  /* ============================================================
   * 6. 反事实：这个会话换模型会花多少
   * ============================================================ */
  function counterfactual(s, pricing, targetM) {
    const p = pricing.find(x => x.m === targetM);
    if (!p || p.pm == null) return null;
    let miss = 0, hit = 0, out = 0;
    for (const r of s.rq) { miss += Math.max(0, r.it - r.hit); hit += r.hit; out += r.ot; }
    const credits = (miss / 1e6) * p.pm + (hit / 1e6) * p.ph + (out / 1e6) * p.po;
    return {
      m: targetM, name: p.name, credits,
      yuan: credits * CP_USER,
      deltaYuan: (credits - s.credit) * CP_USER,
      pct: s.credit > 0 ? (credits / s.credit - 1) : 0,
      src: p.src, r2: p.r2,
    };
  }

  /* 选择性替换：只替换低判断力动作（勘探/执行/调研/管理）的请求 */
  const LOW_JUDGMENT = new Set(['勘探', '执行', '调研', '管理']);

  function counterfactualSelective(s, pricing, targetM) {
    const p = pricing.find(x => x.m === targetM);
    if (!p || p.pm == null) return null;
    let credits = 0, switched = 0, kept = 0;
    const byModel = new Map(pricing.map(x => [x.m, x]));
    for (const r of s.rq) {
      const cur = byModel.get(r.m);
      if (LOW_JUDGMENT.has(r.f) && cur && cur.pm != null) {
        credits += (Math.max(0, r.it - r.hit) / 1e6) * p.pm + (r.hit / 1e6) * p.ph + (r.ot / 1e6) * p.po;
        switched++;
      } else {
        credits += r.cr; kept++;
      }
    }
    return {
      m: targetM, name: p.name, credits, yuan: credits * CP_USER,
      deltaYuan: (credits - s.credit) * CP_USER,
      pct: s.credit > 0 ? (credits / s.credit - 1) : 0,
      switched, kept, src: p.src,
    };
  }

  /* ============================================================
   * 7. 模型顾问：按任务原型给推荐（只依赖积分，不依赖汇率）
   * ============================================================ */
  function advise(AGG) {
    const priced = AGG.pricing.filter(p => p.pm != null && p.pm > 0);
    const out = [];
    for (const a of AGG.byArch) {
      if (a.credit <= 0) continue;
      const sess = AGG.sess.filter(s => s.arch === a.arch);
      if (!sess.length) continue;
      const cur = sess.reduce((x, s) => x + s.credit, 0);

      const cands = priced.map(p => {
        let full = 0, sel = 0;
        for (const s of sess) {
          for (const r of s.rq) {
            const unit = (Math.max(0, r.it - r.hit) / 1e6) * p.pm + (r.hit / 1e6) * p.ph + (r.ot / 1e6) * p.po;
            full += unit;
            sel += LOW_JUDGMENT.has(r.f) ? unit : r.cr;
          }
        }
        const obs = a.models.get(p.m);
        const obsReqs = obs ? obs.n : 0;
        const obsChars = obs ? obs.chars : 0;
        return {
          m: p.m, name: p.name, full, sel,
          fullYuan: full * CP_USER, selYuan: sel * CP_USER,
          obsReqs, obsChars,
          obsOutPerReq: obsReqs ? (obs.out || 0) / obsReqs : 0,
          charsPerReq: obsReqs ? obsChars / obsReqs : 0,
          src: p.src, r2: p.r2,
          // 只有在该原型下真实跑过、且样本不是零星几次，才允许作为推荐目标
          eligible: obsReqs >= Math.max(20, a.reqs * 0.02),
        };
      });

      const elig = cands.filter(c => c.eligible);
      const bySel = elig.slice().sort((x, y) => x.sel - y.sel);
      let best = bySel[0] || null;
      // 稳定器：若最省模型相对「本原型下用得最多的模型」优势不足 8%，不折腾
      const incumb = elig.slice().sort((x, y) => y.obsReqs - x.obsReqs)[0] || null;
      let kept = false;
      if (best && incumb && best.m !== incumb.m && best.sel > incumb.sel * 0.92) {
        best = incumb; kept = true;
      }
      const curTop = cands.slice().sort((x, y) => y.obsReqs - x.obsReqs)[0] || null;
      const saveSel = best ? Math.max(0, cur - best.sel) : 0;
      const saveFull = bySel.length ? Math.max(0, cur - bySel[0].full) : 0;

      // 置信度：原型样本量 × 可比较模型数
      let conf = 0;
      if (a.reqs >= 2000 && elig.length >= 2) conf = 3;
      else if (a.reqs >= 300 && elig.length >= 2) conf = 2;
      else if (elig.length >= 1 && a.reqs >= 30) conf = 1;

      out.push({
        arch: a.arch, desc: ARCH_DESC[a.arch], n: a.n, reqs: a.reqs, credit: cur,
        chars: a.chars, perKChar: a.chars > 0 ? cur / (a.chars / 1000) : null,
        cands: cands.sort((x, y) => x.sel - y.sel),
        best, curTop, kept,
        saveSel, saveSelYuan: saveSel * CP_USER,
        saveFull, saveFullYuan: saveFull * CP_USER,
        saveCredit: saveSel, saveYuan: saveSel * CP_USER,
        pctSel: cur > 0 ? saveSel / cur : 0,
        conf,
      });
    }
    out.sort((a, b) => b.saveSel - a.saveSel || b.credit - a.credit);
    return out;
  }

  /* ============================================================
   * 8. 省钱处方（规则引擎）
   * ============================================================ */
  function prescribe(AGG) {
    const F = [];
    const T = AGG.T;
    const r2 = n => Math.round(n * 100) / 100;

    /* 规则 1：无产出的高消耗会话 */
    const noOut = AGG.sess.filter(s => s.chars === 0 && s.yuan >= 0.5).sort((a, b) => b.yuan - a.yuan);
    if (noOut.length) {
      const sum = noOut.reduce((a, s) => a + s.yuan, 0);
      F.push({
        id: 'no-output', level: sum > T.yuan * 0.08 ? 'high' : 'mid',
        title: '花了钱，但什么都没落盘',
        detail: `${noOut.length} 个会话零文件产出，合计 ¥${r2(sum)}。这类会话通常是长期对话、只读排查，或任务中途被放弃。`,
        est: sum, tag: '空转',
        evidence: noOut.slice(0, 5).map(s => ({ t: s.title, v: `¥${r2(s.yuan)} / ${s.reqs} 次请求` })),
        action: '把「先问清楚再动手」变成习惯：只在确认方向后再开长会话；纯咨询类问题用短会话，避免上下文滚雪球。',
      });
    }

    /* 规则 2：重复读取同一文件 */
    const dup = AGG.sess.filter(s => s.dupReads >= 15).sort((a, b) => b.dupReads - a.dupReads);
    if (dup.length) {
      let est = 0;
      for (const s of dup) {
        const share = s.readCalls ? s.dupReads / Math.max(1, s.calls) : 0;
        est += s.yuan * Math.min(0.35, share);
      }
      F.push({
        id: 'dup-read', level: est > T.yuan * 0.05 ? 'high' : 'mid',
        title: '同一份文件被反复读取',
        detail: `${dup.length} 个会话存在大量重复读取，最严重的是《${dup[0].worstRead || '—'}》被读了 ${dup[0].worstReadN} 次。每次重读都要把整段内容重新灌进上下文。`,
        est, tag: '重复劳动',
        evidence: dup.slice(0, 5).map(s => ({ t: s.title, v: `${s.dupReads} 次重复读 · ¥${r2(s.yuan)}` })),
        action: '把关键结论写进项目 memory 或一个「摘要文件」，下次直接读摘要；长文档交给子代理去读，只回传要点。',
      });
    }

    /* 规则 3：失败工具调用的成本 */
    if (T.failCredit > 0) {
      const est = T.failCredit * CP_USER;
      F.push({
        id: 'fail-retry', level: est > T.yuan * 0.03 ? 'high' : 'low',
        title: '失败的工具调用也在计费',
        detail: `${T.fails} 次工具调用以非零退出码结束，这些请求仍消耗 ¥${r2(est)}。多为路径不存在、依赖缺失、命令语法错误。`,
        est, tag: '无效开销',
        evidence: AGG.sess.filter(s => s.fails > 0).sort((a, b) => b.fails - a.fails).slice(0, 5)
          .map(s => ({ t: s.title, v: `${s.fails} 次失败 / ¥${r2(s.yuan)}` })),
        action: '让 Agent 先 `ls` 或 `--version` 探路再执行；把常用路径与虚拟环境写进项目约定，减少试错轮次。',
      });
    }

    /* 规则 4：上下文复读税 */
    if (T.hit > 0 && T.cacheSaving > 0) {
      const extra = T.cacheSaving * 0.5;   // 命中率腰斩 → 多付的部分
      F.push({
        id: 'cache', level: 'info',
        title: `你省下的 ¥${r2(T.cacheSaving)} 全靠缓存命中`,
        detail: `输入的 ${(T.cacheRate * 100).toFixed(1)}% 命中缓存。若命中率掉到 50%，同样工作量大约多花 ¥${r2(extra)}。`,
        est: 0, tag: '风险敞口',
        evidence: [
          { t: '缓存命中 input', v: fmtInt(T.hit) + ' tokens' },
          { t: '未命中 input', v: fmtInt(T.in - T.hit) + ' tokens' },
          { t: '输出', v: fmtInt(T.out) + ' tokens' },
        ],
        action: '缓存是长会话的命门：不要在会话中途大改系统提示或切换模型，那会让整段前缀缓存失效。',
      });
    }

    /* 规则 5：上下文膨胀 */
    const big = AGG.sess.filter(s => s.reqs >= 200 && s.avgIn > 100000).sort((a, b) => b.avgIn - a.avgIn);
    if (big.length) {
      F.push({
        id: 'bloat', level: 'mid',
        title: '超长会话的上下文滚雪球',
        detail: `${big.length} 个会话平均每轮带入 ${fmtInt(big[0].avgIn)} tokens 输入（${big[0].reqs} 轮）。每一轮都在为前文付钱，哪怕命中缓存也是成本。`,
        est: 0, tag: '结构性成本',
        evidence: big.slice(0, 5).map(s => ({ t: s.title, v: `每轮 ${fmtInt(s.in / s.reqs)} tok · ${s.reqs} 轮` })),
        action: '把长任务切成阶段，每个阶段结束就开新会话并只带「结论」入场；中间过程丢给子代理，主线程保持干净。',
      });
    }

    /* 规则 6：文件反复编辑（打磨 vs 空转） */
    const churn = AGG.sess.map(s => {
      let worst = null, n = 0;
      for (const [f, c] of s.fileEdits) if (c > n) { n = c; worst = f; }
      return { s, worst, n };
    }).filter(x => x.n >= 10).sort((a, b) => b.n - a.n);
    if (churn.length) {
      F.push({
        id: 'churn', level: 'low',
        title: '同一个文件被改了十几遍',
        detail: `《${churn[0].worst}》在单个会话里被编辑 ${churn[0].n} 次。如果是逐字打磨，这是正常成本；如果是改错方向反复回滚，就是纯浪费。`,
        est: 0, tag: '返工',
        evidence: churn.slice(0, 5).map(x => ({ t: `${x.worst}`, v: `${x.n} 次编辑 · ${x.s.title.slice(0, 18)}` })),
        action: '大改前先让 Agent 复述一遍方案，确认后再写；单次 Edit 的范围给足，避免「改一句看一眼」的碎步。',
      });
    }

    /* 规则 7：模型错配（来自顾问结论） */
    const adv = advise(AGG).filter(a => a.best && a.saveSelYuan > 0.05);
    for (const a of adv.slice(0, 3)) {
      F.push({
        id: 'route-' + a.arch, level: a.saveSelYuan > T.yuan * 0.05 ? 'high' : 'mid',
        title: `「${a.arch}」类任务的下沉空间 ¥${r2(a.saveSelYuan)}`,
        detail: `这类任务共 ${a.reqs} 次请求、当前 ¥${r2(a.credit * CP_USER)}。把检索/执行/调研这类低判断力请求下沉到 ${a.best.name}，预计降到 ¥${r2(a.best.selYuan)}（-${(a.pctSel * 100).toFixed(0)}%）；若全量替换则 ¥${r2(a.best.fullYuan)}。`,
        est: a.saveSelYuan, tag: '模型路由',
        evidence: a.cands.slice(0, 4).map(c => ({
          t: c.name + (c.eligible ? '' : ' · 待验证'),
          v: `全量 ¥${r2(c.fullYuan)} · 下沉 ¥${r2(c.selYuan)} · 实测 ${c.obsReqs} 次`,
        })),
        action: `写作、审校、方案设计继续留高档模型；「${a.arch}」的检索与执行类请求走 ${a.best.name}。前提：先小批量验一次质量，别一次性全切。`,
      });
    }

    /* 规则 8：子代理的重复上下文 */
    const sub = AGG.sess.filter(s => s.agentsN >= 3 && s.subCredit > 0).sort((a, b) => b.subCredit - a.subCredit);
    if (sub.length) {
      const total = sub.reduce((a, s) => a + s.subCredit * CP_USER, 0);
      F.push({
        id: 'subagent', level: 'info',
        title: '子代理花掉了多少',
        detail: `${sub.length} 个会话派生了子代理，子代理侧消耗 ¥${r2(total)}，占这些会话的 ${((total / (sub.reduce((a, s) => a + s.yuan, 0) || 1)) * 100).toFixed(0)}%。`,
        est: 0, tag: '结构分布',
        evidence: sub.slice(0, 5).map(s => ({ t: s.title, v: `${s.agentsN} 个子代理 · ¥${r2(s.subCredit * CP_USER)}` })),
        action: '并行子代理只在任务可切分时才划算；给每个子代理的 prompt 要自带完整上下文，否则它们会重复读同一批文件。',
      });
    }

    /* 规则 9：套餐选型 —— 按月度用量找「刚好够用的最便宜档」 */
    if (T.perMonthCredit > 0) {
      const perMonth = T.perMonthCredit;
      const quotes = PLANS.filter(p => p.id !== 'free').map(p => planQuote(p.id, 'y'));
      const enough = quotes.filter(q => q.credits >= perMonth * 1.02).sort((a, b) => a.fee - b.fee);
      const best = enough[0] || quotes[quotes.length - 1];
      const fits = !!enough.length;
      const wasted = best.credits - perMonth;
      F.push({
        id: 'plan', level: fits ? 'info' : 'mid', tag: '套餐选型',
        title: fits ? `按你的用量，${best.plan.name} 就够（¥${best.fee.toFixed(0)}/月）` : `用量已超出旗舰版额度`,
        detail: `本期 ${Math.round(T.days)} 天用掉 ${fmtInt(T.credit)} 积分，折合每月约 ${fmtInt(perMonth)} 积分。`
          + (fits
            ? `${best.plan.name} 每月 ${fmtInt(best.credits)} 积分，覆盖后仍余 ${fmtInt(wasted)}；连续包年折合 ¥${best.fee.toFixed(0)}/月，即 ¥${best.unit.toFixed(4)}/积分。`
            : `旗舰版每月 ${fmtInt(best.credits)} 积分仍不够，需要靠多账号或企业版。`),
        est: 0,
        evidence: quotes.map(q => ({
          t: q.plan.name + (q.credits >= perMonth ? ' ✓' : ' ✗'),
          v: `¥${q.fee.toFixed(0)}/月 · ${fmtInt(q.credits)} 积分 · ¥${q.unit.toFixed(4)}/积分`,
        })),
        action: fits
          ? `按连续包年买 ${best.plan.name} 最划算。别为了「保险」上更高档 —— 用不到的额度是全损的沉没成本。`
          : `考虑把长会话拆短、降低重复读取，把月用量压到 5 万积分以内再谈套餐。`,
      });
    }

    const order = { high: 0, mid: 1, low: 2, info: 3 };
    F.sort((a, b) => (order[a.level] - order[b.level]) || (b.est - a.est));
    return F;
  }

  function avgMissMinusHit(AGG) {
    let s = 0, n = 0;
    for (const p of AGG.pricing) if (p.pm != null) { s += (p.pm - p.ph); n++; }
    return n ? s / n : 20;
  }

  function fmtInt(v) {
    if (v == null) return '—';
    if (Math.abs(v) >= 1e9) return (v / 1e9).toFixed(2) + 'B';
    if (Math.abs(v) >= 1e6) return (v / 1e6).toFixed(2) + 'M';
    if (Math.abs(v) >= 1e4) return (v / 1e3).toFixed(1) + 'k';
    return String(Math.round(v));
  }

  /* ============================================================
   * 9. 套餐口径：1 积分值多少钱，由你的实际订阅决定
   *    官方个人版档位（2026-07 起）：体验 / 标准 / 高级 / 旗舰
   *    实得积分 = 基础积分 + 限时加赠（加赠部分到账起 1 个月内有效）
   * ============================================================ */
  const PLANS = [
    { id: 'free', name: '体验版', fee: 0, m70: 0, year: 0, credits: 500 },
    { id: 'std', name: '标准版', fee: 99, m70: 70, year: 672, credits: 4000 },
    { id: 'pro', name: '高级版', fee: 199, m70: 140, year: 1344, credits: 9000 },
    { id: 'ultra', name: '旗舰版', fee: 999, m70: 700, year: 6720, credits: 50000 },
  ];
  const CYCLES = [
    { id: 'm', name: '月付', mult: 1 },
    { id: 'm7', name: '连续包月', mult: 0.707 },
    { id: 'y', name: '连续包年', mult: 0.563 },
  ];

  function planQuote(planId, cycleId) {
    const p = PLANS.find(x => x.id === planId);
    if (!p) return null;
    const cyc = CYCLES.find(c => c.id === cycleId) || CYCLES[0];
    let fee;
    if (p.id === 'free') fee = 0;
    else if (cyc.id === 'm7') fee = p.m70;
    else if (cyc.id === 'y') fee = p.year / 12;
    else fee = p.fee;
    return {
      plan: p, cycle: cyc, fee, credits: p.credits,
      unit: p.credits > 0 ? fee / p.credits : 0,           // ¥ / 积分
      yearFee: p.id === 'free' ? 0 : (cyc.id === 'y' ? p.year : fee * 12),
      label: p.id === 'free' ? '体验版（免费）' : `${p.name} · ${cyc.name}`,
    };
  }

  /* ---------------- 序列化（快照 / 演示数据） ---------------- */
  function serializeRAW(R) {
    return {
      v: 2, models: R.models, ws: R.ws, range: R.range, files: R.files, bytes: R.bytes,
      lineCount: R.lineCount, badLines: R.badLines, creditRows: R.creditRows,
      sessions: R.sessions.map(s => ({
        id: s.id, ws: s.ws, title: s.title, titleSrc: s.titleSrc, st: s.st, en: s.en,
        chars: s.chars, charsNew: s.charsNew, charsEdit: s.charsEdit, calls: s.calls,
        fails: s.fails, failCredit: s.failCredit, pf: s.pf, turns: s.turns,
        filesNew: s.filesNew.slice(), filesEdit: s.filesEdit.slice(),
        filesTouched: s.filesTouched, dupReads: s.dupReads, readCalls: s.readCalls,
        worstRead: s.worstRead, worstReadN: s.worstReadN,
        fileEdits: Array.from(s.fileEdits), fileReads: Array.from(s.fileReads),
        agents: Array.from(s.agents),
        toolCount: s.toolCount, toolTop: s.toolTop, domModel: s.domModel,
        arch: s.arch, modelShare: s.modelShare,
        agentsN: s.agentsN, agentCalls: s.agentCalls,
        genCredit: s.genCredit || 0, subCredit: s.subCredit,
        credit: s.credit, in: s.in, hit: s.hit, out: s.out, reqs: s.reqs, durMin: s.durMin,
        rq: s.rq.map(r => [r.ts, r.it, r.ot, r.hit, r.cw, r.cr, r.m, r.f, r.sub, r.fail]),
      })),
    };
  }

  function deserializeRAW(J) {
    const sessions = (J.sessions || []).map(s => {
      const o = Object.assign({}, s);
      o.fileEdits = new Map(s.fileEdits || []);
      o.fileReads = new Map(s.fileReads || []);
      o.agents = new Map(s.agents || []);
      o.rq = (s.rq || []).map(a => ({
        ts: a[0], it: a[1], ot: a[2], hit: a[3], cw: a[4], cr: a[5],
        m: a[6], f: a[7], sub: a[8] || '', fail: a[9] || 0, tid: 0,
      }));
      o.rq.forEach((r, i) => { r.tid = i; });
      o.modelShare = (s.modelShare || []).map(ms => ({ m: ms.m, n: ms.n, credit: ms.credit, out: ms.out || 0, in: ms.in || 0, hit: ms.hit || 0 }));
      return o;
    });
    return {
      sessions, ws: J.ws || [], models: J.models || [], range: J.range || { min: Date.now(), max: Date.now() },
      files: J.files || sessions.length, bytes: J.bytes || 0, lineCount: J.lineCount || 0,
      badLines: J.badLines || 0, creditRows: J.creditRows || 0, genTools: [],
    };
  }

  /* ---------------- 导出 ---------------- */
  root.SL = {
    get CREDIT_PRICE() { return CP_USER; },
    setCreditPrice(v) { if (isFinite(v) && v >= 0) CP_USER = v; },
    PLANS, CYCLES, planQuote, FAMILY_LIST, ARCHS, ARCH_DESC, W_DEFAULT, OFFICIAL,
    parseLogs, aggregate, rescore, advise, prescribe, counterfactual, counterfactualSelective,
    classifyArch, fitPricing, fmtInt, familyOf, baseName, dayKey, serializeRAW, deserializeRAW,
    LOW_JUDGMENT,
  };
  if (typeof module !== 'undefined' && module.exports) module.exports = root.SL;
})(typeof window !== 'undefined' ? window : globalThis);
