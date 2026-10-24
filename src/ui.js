/* ============================================================
   SpendLens UI — 渲染与交互
   ============================================================ */
;(function (root) {
  'use strict';
  const $ = id => document.getElementById(id);
  const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const F = root.FMT, CH = root.CH;

  const ST = {
    RAW: null, AGG: null, ADV: null, RX: null,
    W: { d: 45, e: 35, h: 20 },
    win: 'all', ws: '', model: '',
    sortKey: 'credit', sortDir: -1,
    demo: false, sim: null, simM: null, tab: 'usage',
    plan: 'std', cycle: 'y', _defaultPlan: false,
  };

  /* 当前计费口径的说明文字：「实付」在套餐模式下其实是「分摊成本」 */
  function basisLabel() { return ST.plan === 'credit' ? '实付' : '套餐分摊'; }
  function planQuota(T) {
    if (ST.plan === 'credit') return null;
    const q = SL.planQuote(ST.plan, ST.cycle);
    if (!q) return null;
    const quota = q.credits * (T.days / 30.4375);
    const periodFee = q.fee * (T.days / 30.4375);   // 这段窗口里真正掏的钱
    return {
      q, quota, periodFee,
      rate: quota > 0 ? T.credit / quota : 0,
      waste: Math.max(0, quota - T.credit) * q.unit,
    };
  }

  /* 「省了多少」到底拿什么当成本？
     订阅是固定支出：这 47 天你实际掏的是「月费 × 47/30.44」，不是「已用积分 × 单价」。
     用后者会把「没用的额度」摊薄成 0 成本，导致买越贵越显得划算 —— 必须用期间实付。 */
  function costBase(T) {
    const pq = planQuota(T);
    if (pq && pq.periodFee > 0) {
      return {
        cost: pq.periodFee, save: T.official - pq.periodFee, pq,
        pct: T.official > 0 ? (T.official - pq.periodFee) / T.official : 0,
        label: '期间实付',
      };
    }
    return {
      cost: T.yuan, save: T.official - T.yuan, pq: null,
      pct: T.savePct, label: '实付',
    };
  }

  const ARCH_C = {
    '批量生产': '--m0', '精修迭代': '--m1', '代码勘探': '--m3', '工程执行': '--m2',
    '联网调研': '--m5', '多智能体编排': '--m4', '轻量问答': '--m7',
  };
  const archColor = a => CH.cssVar(ARCH_C[a] || '--m7');
  const modelColor = i => CH.cssVar('--m' + (i % 8));

  /* ---------------- 数字滚动 ---------------- */
  function countUp(el, target, fn) {
    if (!el) return;
    const dur = 620;
    el.textContent = fn(target);          // 先落到终值：rAF 被节流时也不会停在中间帧
    clearTimeout(el._cuT);
    el._cuT = setTimeout(() => { el.textContent = fn(target); }, dur + 150);
    const t0 = performance.now();
    function step(t) {
      const k = Math.min(1, (t - t0) / dur);
      if (k >= 1) { el.textContent = fn(target); return; }
      const e = 1 - Math.pow(1 - k, 3);
      el.textContent = fn(target * e);
      requestAnimationFrame(step);
    }
    requestAnimationFrame(step);
  }

  function toast(msg) {
    const t = $('toast');
    t.textContent = msg;
    t.classList.add('on');
    clearTimeout(t._h);
    t._h = setTimeout(() => t.classList.remove('on'), 3200);
  }

  /* ============================================================
   * 筛选与重算
   * ============================================================ */
  function buildFilter() {
    const R = ST.RAW;
    let from = 0, to = Infinity;
    if (ST.win !== 'all') {
      const anchor = R.range.max || Date.now();
      from = anchor - (+ST.win) * 86400000;
      to = anchor + 60000;
    }
    const ws = ST.ws === '' ? null : new Set([+ST.ws]);
    const models = ST.model === '' ? null : new Set([+ST.model]);
    return { from, to, ws, models };
  }

  function recompute() {
    ST.AGG = SL.aggregate(ST.RAW, buildFilter());
    SL.rescore(ST.AGG.sess, ST.W);
    ST.ADV = SL.advise(ST.AGG);
    ST.RX = SL.prescribe(ST.AGG);
  }

  /* ============================================================
   * 页签：一页只显示一个面板
   * 关键点：面板从 hidden 变可见的那一帧才量得到真实宽度，
   * 所以含 SVG 图表的面板必须在切换时重绘，否则会是 800px 兜底宽度缩放出来的糊图。
   * ============================================================ */
  const TABS = ['usage', 'save', 'money', 'value', 'model', 'ledger', 'method'];
  const TAB_CHARTS = {
    money: A => { renderCost(A); renderSankey(A); renderProjects(A); },
    value: A => { renderMap(A); },
  };
  const panelOf = t => 'panel' + t.charAt(0).toUpperCase() + t.slice(1);

  function switchTab(name) {
    if (TABS.indexOf(name) < 0) name = 'usage';
    ST.tab = name;
    const bar = $('tabBar');
    if (bar) bar.querySelectorAll('.tab').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
    TABS.forEach(t => { const p = $(panelOf(t)); if (p) p.hidden = t !== name; });
    const el = $(panelOf(name));
    if (el) { el.classList.remove('fade'); void el.offsetWidth; el.classList.add('fade'); }
    const sc = $('panels'); if (sc) sc.scrollTop = 0;
    const fn = TAB_CHARTS[name];
    if (fn && ST.AGG) requestAnimationFrame(() => fn(ST.AGG));
  }

  /* ============================================================
   * 顶部
   * ============================================================ */
  function renderTop() {
    const R = ST.RAW;
    const isDemo = ST.demo;
    const b = $('srcBadge');
    b.className = 'live' + (isDemo ? ' demo' : '');
    $('srcText').textContent = isDemo ? '脱敏演示数据' : '已接入本机日志';
    const d0 = new Date(R.range.min), d1 = new Date(R.range.max);
    $('rangeText').textContent = `${d0.getFullYear()}-${String(d0.getMonth() + 1).padStart(2, '0')}-${String(d0.getDate()).padStart(2, '0')} → ${String(d1.getMonth() + 1).padStart(2, '0')}-${String(d1.getDate()).padStart(2, '0')} · ${R.files} 个日志文件 · ${F.num(R.lineCount)} 行`;

    // 项目下拉
    const wsSel = $('wsSel');
    wsSel.innerHTML = '<option value="">全部项目</option>' + R.ws.map((w, i) =>
      `<option value="${i}">${esc(w.label)}</option>`).join('');
    wsSel.value = ST.ws;

    const mSel = $('modelSel');
    mSel.innerHTML = '<option value="">全部模型</option>' + R.models.map((m, i) =>
      `<option value="${i}">${esc(m)}</option>`).join('');
    mSel.value = ST.model;

    // 计费口径下拉：按积分牌价 + 三档套餐 × 三种付费周期（都带折算单价）
    const ps = $('planSel');
    if (ps) {
      if (!ps.dataset.built) {
        let h = '<option value="credit">计费口径：按积分牌价 ¥0.0500/积分</option>';
        for (const p of SL.PLANS) {
          h += `<optgroup label="${p.name} · 每月 ${F.int(p.credits)} 积分">`;
          for (const c of SL.CYCLES) {
            if (p.id === 'free' && c.id !== 'm') continue;
            const q = SL.planQuote(p.id, c.id);
            h += `<option value="${p.id}:${c.id}">${p.name} · ${c.name} ¥${q.fee.toFixed(0)}/月 · ¥${q.unit.toFixed(4)}/积分</option>`;
          }
          h += '</optgroup>';
        }
        ps.innerHTML = h;
        ps.dataset.built = '1';
      }
      ps.value = ST.plan === 'credit' ? 'credit' : ST.plan + ':' + ST.cycle;
    }
  }

  /* ============================================================
   * Hero
   * ============================================================ */
  function renderHero(A) {
    const T = A.T;
    const cb = costBase(T);
    const pq = cb.pq;

    /* 标题位 = 实际 token 消费。
       订阅制下「花了多少钱」是按下单周期摊的固定值，随用量变的是 token。
       把 ¥ 放标题位会让人误以为它是按量计费，所以钱只出现在下面的卡片里。 */
    $('heroEyebrow').textContent = (ST.win === 'all' ? '全部时间' : `近 ${ST.win} 天`) + ' · 实际 Token 消费';
    const totalTok = T.in + T.out;
    countUp($('heroMain'), totalTok, v => F.num(v));

    const days = T.days || 1;
    $('heroSub').innerHTML =
      `<span>输入 <b>${F.num(T.in)}</b>（命中缓存 ${F.pct(T.cacheRate, 1)}）</span><span class="dot"></span>` +
      `<span>输出 <b>${F.num(T.out)}</b></span><span class="dot"></span>` +
      `<span><b>${F.int(T.credit)}</b> 积分</span><span class="dot"></span>` +
      `<span><b>${F.int(T.reqs)}</b> 次请求</span><span class="dot"></span>` +
      `<span>日均 <b>${F.num(totalTok / days)}</b></span>`;

    /* ---- 省钱测算 ---- */
    const rx = ST.RX || [];
    const saveTotal = rx.reduce((a, f) => a + (f.est || 0), 0);
    const byTag = {};
    for (const f of rx) if (f.est > 0.005) byTag[f.tag] = (byTag[f.tag] || 0) + f.est;
    const chips = Object.entries(byTag).sort((a, b) => b[1] - a[1]).slice(0, 4);
    const share = T.official > 0 ? saveTotal / T.official : 0;   // 分母用官方等价，比例恒 ≤100%

    /* 订阅制最关键的一句：省积分 ≠ 省现金，只有能降档才落袋 */
    let cashNote = '';
    if (pq) {
      const cur = pq.q.plan;
      const monthly = T.perMonthCredit;
      const lowerOk = SL.PLANS
        .filter(p => p.fee > 0 && p.fee < cur.fee && p.credits >= monthly)
        .sort((a, b) => b.fee - a.fee)[0];
      const bigger = SL.PLANS.filter(p => p.credits >= monthly).sort((a, b) => a.fee - b.fee)[0];
      if (monthly > cur.credits) {
        // 这个窗口的节奏已经超出现有档位：要么省，要么升
        cashNote = `按当前节奏月化 <b>${F.int(monthly)} 积分</b>，已超出 ${cur.name} 额度 ${F.int(monthly - cur.credits)}` +
          (bigger && bigger.id !== cur.id
            ? `；要保住额度得升到 ${bigger.name}（<b>+¥${(bigger.fee - cur.fee).toFixed(0)}/月</b>）`
            : `；已超过旗舰版额度`);
      } else if (lowerOk) {
        const lq = SL.planQuote(lowerOk.id, ST.cycle);
        cashNote = `现金可省 <b>¥${(pq.q.fee - lq.fee).toFixed(0)}/月</b> —— 按你的月用量已能压到 ${lowerOk.name}`;
      } else {
        const up = SL.PLANS.filter(p => p.fee > cur.fee).sort((a, b) => a.fee - b.fee)[0];
        cashNote = `已是最低付费档：<b>省积分不会减少支出</b>` +
          `；月余量 ${F.int(cur.credits - monthly)} 积分，一旦超额就得升到 ${up ? up.name + ' ¥' + up.fee.toFixed(0) + '/月' : '更高档'}`;
      }
    }

    const sv = $('heroSave');
    if (sv) {
      if (saveTotal > 0.05) {
        sv.style.display = '';
        sv.innerHTML = `
          <div class="sv-head">
            <span class="sv-k">${pq ? '按本报告测算 · 积分可优化' : '按本报告测算 · 可省上限'}</span>
            <span class="sv-v">¥${saveTotal.toFixed(1)}</span>
            <span class="sv-p">${pq ? '折算价值 · ' : ''}占官方等价 ${F.pct(share, 0)}</span>
            <span class="sv-go">看处方 →</span>
          </div>
          <div class="sv-bar"><i data-w="${Math.min(100, share * 100).toFixed(1)}"></i></div>
          <div class="sv-chips">
            ${chips.map(([k, v]) => `<span>${esc(k)} <b>¥${v.toFixed(1)}</b></span>`).join('')}
          </div>
          ${cashNote ? `<div class="sv-note">${cashNote}</div>` : ''}`;
        requestAnimationFrame(() => {
          const bar = sv.querySelector('.sv-bar i');
          if (bar) bar.style.width = bar.dataset.w + '%';
        });
        sv.onclick = () => switchTab('save');
      } else {
        sv.style.display = 'none';
      }
    }

    renderHeat(A);
    renderDaily(A);

    const waste = T.failCredit * SL.CREDIT_PRICE;
    const noOut = A.sess.filter(s => s.chars === 0).reduce((a, s) => a + s.yuan, 0);
    const signed = v => (v < 0 ? '−' : '') + F.yuan(Math.abs(v));
    const perK = T.chars > 0 ? cb.cost / (T.chars / 1000) : null;

    const minis = [
      {
        k: pq ? '订阅成本 · 本期摊销' : '实际消费',
        v: F.yuan(cb.cost),
        s: pq
          ? `¥${pq.q.fee.toFixed(0)}/月 × ${Math.round(T.days)} 天<br>${pq.q.plan.name} · ${pq.q.cycle.name}`
          : `${F.int(T.credit)} 积分 × ¥${SL.CREDIT_PRICE.toFixed(4)}`,
        cls: '',
      },
      {
        k: '官方 API 等价', v: F.yuan(T.official),
        s: `按官网牌价重算<br>覆盖 ${F.pct(T.officialCover, 1)} 积分`,
        cls: '',
        tip: T.officialMissing.length ? `无公开牌价未计入：${T.officialMissing.join('、')}` : '',
      },
      {
        k: 'WorkBuddy 省下',
        v: signed(cb.save),
        s: cb.save >= 0
          ? `相对官网牌价省 ${F.pct(cb.pct, 0)}<br>官方 ${F.yuan(T.official)} − ${cb.label} ${F.yuan(cb.cost)}`
          : `相对官网反而多花 ${F.pct(-cb.pct, 0)}<br>官方 ${F.yuan(T.official)} − ${cb.label} ${F.yuan(cb.cost)}`,
        cls: cb.save >= 0 ? 'good' : 'bad',
      },
      {
        k: '额度使用率',
        v: pq ? F.pct(pq.rate, 0) : '—',
        s: pq
          ? (pq.rate > 1
            ? `额度 ${F.int(pq.quota)} · <b style="color:var(--rose)">超额 ${F.pct(pq.rate - 1, 0)}</b>`
            : `额度 ${F.int(pq.quota)} · ${pq.waste > 0.5 ? '浪费 ' + F.yuan(pq.waste) : '基本用满'}`)
          : '未绑定套餐',
        cls: pq ? (pq.rate > 0.95 ? 'warn' : pq.rate < 0.6 ? 'bad' : 'good') : '',
        bar: pq ? Math.min(1, pq.rate) : null,
      },
      {
        k: '有效产出', v: F.num(T.chars) + ' 字',
        s: `${F.int(T.filesNew)} 个新文件 · ${F.int(T.filesTouched)} 个文件被改`,
        cls: '',
      },
      {
        k: '单位成本', v: perK == null ? '—' : '¥' + perK.toFixed(4),
        s: pq ? '每千字（按订阅摊销算）' : '每千字（越低越省）',
        cls: 'good',
      },
      {
        k: '缓存替你挡下', v: F.yuan(T.cacheSaving),
        s: `命中率 ${F.pct(T.cacheRate)}，没有它这是额外账单`,
        cls: 'info', bar: T.cacheRate,
      },
      {
        k: '白烧掉', v: F.yuan(waste + noOut),
        s: `失败调用 ¥${waste.toFixed(2)} · 零产出 ¥${noOut.toFixed(2)}`,
        cls: 'bad',
      },
    ];
    $('miniGrid').innerHTML = minis.map(m => `
      <div class="mini ${m.cls}"${m.tip ? ` title="${esc(m.tip)}"` : ''}>
        <div class="k">${m.k}</div>
        <div class="v">${m.v}</div>
        <div class="s">${m.s}</div>
        ${m.bar != null ? `<div class="bar-mini"><i style="width:${(m.bar * 100).toFixed(1)}%"></i></div>` : ''}
      </div>`).join('');
  }

  /* ============================================================
   * Token 热点图：周一→周日 × 0–23 时
   * 用对数分档上色，否则一个尖峰会把其余格子压成同色
   * ============================================================ */
  const WD = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];
  function renderHeat(A) {
    const host = $('heroHeat');
    if (!host) return;
    const g = A.heatGrid || [];
    let max = 0, total = 0, pi = 0;
    for (let i = 0; i < g.length; i++) {
      total += g[i];
      if (g[i] > max) { max = g[i]; pi = i; }
    }
    if (!total) { host.innerHTML = ''; return; }

    const avg = total / g.length;
    /* 用分位数分档而不是固定阈值：使用时长极度不均（夜里大片空白、白天几个尖峰），
       固定阈值会让绝大多数格子挤在同一档。分位保证四档都有样本。 */
    const nz = Array.from(g).filter(v => v > 0).sort((a, b) => a - b);
    const q = p => nz[Math.min(nz.length - 1, Math.floor(p * nz.length))];
    const b1 = q(0.25), b2 = q(0.5), b3 = q(0.75);
    const level = v => (!v ? 0 : v <= b1 ? 1 : v <= b2 ? 2 : v <= b3 ? 3 : 4);
    const fill = v => {
      const L = level(v);
      if (!L) return 'var(--line)';
      const pct = [0, 24, 44, 68, 100][L];
      return `color-mix(in srgb, var(--teal) ${pct}%, var(--solid))`;
    };

    const rows = WD.map((name, w) => {
      let cells = '';
      for (let h = 0; h < 24; h++) {
        const v = g[w * 24 + h] || 0;
        cells += `<i class="hc" style="background:${fill(v)}" data-v="${v}" data-w="${w}" data-h="${h}"></i>`;
      }
      return `<div class="hrow"><span class="hlab">${name}</span>${cells}</div>`;
    }).join('');

    const xAxis = Array.from({ length: 24 }, (_, h) =>
      `<span>${h % 6 === 0 ? h : ''}</span>`).join('');

    const pw = WD[Math.floor(pi / 24)], ph = pi % 24;
    host.innerHTML = `
      <div class="heat-hd">
        <span class="heat-t">Token 热点<em>周一→周日 × 0–23 时</em></span>
        <span class="heat-peak">峰值 ${pw} ${String(ph).padStart(2, '0')}:00 · ${F.num(g[pi])}</span>
      </div>
      ${rows}
      <div class="heat-x">${xAxis}</div>
      <div class="heat-ft">
        <span class="heat-lg">少<span class="heat-ramp">${[0, 24, 44, 68, 100].map((p, i) =>
          `<i style="background:${i === 0 ? 'var(--line)' : `color-mix(in srgb, var(--teal) ${p}%, var(--solid))`}"></i>`).join('')}</span>多</span>
        <span class="heat-note">该时段累计 token，含缓存命中输入</span>
      </div>`;

    host.querySelectorAll('.hc').forEach(el => {
      const v = +el.dataset.v, w = +el.dataset.w, h = +el.dataset.h;
      CH.bindTip(el, () => `<div class="tt-h">${WD[w]} ${String(h).padStart(2, '0')}:00–${String(h + 1).padStart(2, '0')}:00</div>
        <div class="tt-r"><span>Token</span><b>${F.num(v)}</b></div>
        <div class="tt-r"><span>占全部</span><b>${F.pct(total ? v / total : 0, 2)}</b></div>
        <div class="tt-r"><span>相对均值</span><b>${avg ? (v / avg).toFixed(2) + '×' : '—'}</b></div>`);
    });
  }

  /* ============================================================
   * 每日模型消耗：堆叠柱 + 7 日均线
   * 缺失日期补 0（不跳过），否则「连续几天没干活」会被画成连续使用
   * 只画当期真正出现过、金额 > 0 的模型，图例按模型色固定
   * ============================================================ */
  function renderDaily(A) {
    const host = $('heroDaily');
    if (!host) return;
    const days = A.days || [];
    const R = A.RAW;
    if (!days.length) { host.innerHTML = ''; return; }

    const byD = new Map(days.map(d => [d.d, d]));
    const seq = [];
    const cur = new Date(days[0].d + 'T00:00:00');
    const endStr = days[days.length - 1].d;
    for (let g = 0; g < 420; g++) {
      const ss = cur.getFullYear() + '-' + String(cur.getMonth() + 1).padStart(2, '0') + '-' + String(cur.getDate()).padStart(2, '0');
      seq.push(ss);
      if (ss >= endStr) break;
      cur.setDate(cur.getDate() + 1);
    }

    const nM = R.models.length;
    const vals = seq.map(ds => {
      const d = byD.get(ds);
      const arr = new Array(nM).fill(0);
      let tot = 0;
      if (d) for (const kv of d.m) { arr[kv[0]] = kv[1]; tot += kv[1]; }
      return { d: ds, arr, tot };
    });
    const active = R.models.map((n, i) => i).filter(i => vals.some(v => v.arr[i] > 0));
    if (!active.length) { host.innerHTML = ''; return; }

    let mx = 0, peak = vals[0];
    for (const v of vals) { if (v.tot > mx) mx = v.tot; if (v.tot > peak.tot) peak = v; }
    mx = mx || 1;

    /* 日消耗极度偏斜（本机中位数 ~10 积分、峰值 3300+），线性轴下 90% 的日子是一条看不见的线。
       偏斜超过 30 倍就切对数轴 —— 与参考看板一致，并在标题里标出来，不偷偷改口径。 */
    const asc = vals.map(v => v.tot).sort((a, b) => a - b);
    const med = asc[Math.floor(asc.length * 0.5)] || 0;
    const useLog = mx / Math.max(1, med) > 30;
    const T = v => (useLog ? Math.log10(v + 1) : v);
    const maxT = Math.max(T(mx), 1e-9);

    const W = Math.max(300, host.clientWidth || 720), H = 118;
    const pL = 34, pR = 6, pT = 8, pB = 15;
    const iw = W - pL - pR, ih = H - pT - pB;
    const n = seq.length, pitch = iw / n;
    const bw = Math.max(1.6, Math.min(16, pitch * 0.62));
    const col = i => CH.cssVar('--m' + (i % 8));
    const yOf = v => pT + ih - (T(v) / maxT) * ih;

    let g = '';
    const ticks = useLog
      ? [1, 10, 100, 1000, 10000, 100000].filter(v => v <= mx)
      : [0, mx * 0.5, mx];
    ticks.forEach(v => {
      const y = yOf(v);
      g += '<line x1="' + pL + '" y1="' + y.toFixed(1) + '" x2="' + (W - pR) + '" y2="' + y.toFixed(1) +
        '" stroke="' + CH.cssVar('--line2') + '" stroke-width="1" stroke-dasharray="2 4"/>';
      g += '<text x="' + (pL - 6) + '" y="' + (y + 3).toFixed(1) + '" text-anchor="end" font-size="8.5" fill="' +
        CH.cssVar('--t4') + '">' + F.int(v) + '</text>';
    });

    let bars = '';
    vals.forEach((v, i) => {
      const x = pL + pitch * i + (pitch - bw) / 2;
      let cum = 0;
      for (const mi of active) {
        const val = v.arr[mi];
        if (!val) continue;
        const y1 = yOf(cum + val), y0 = yOf(cum);
        bars += '<rect x="' + x.toFixed(1) + '" y="' + y1.toFixed(1) + '" width="' + bw.toFixed(1) +
          '" height="' + Math.max(0.8, y0 - y1).toFixed(1) + '" fill="' + col(mi) + '" fill-opacity=".86"/>';
        cum += val;
      }
    });

    const ma = vals.map((_, i) => {
      const s0 = Math.max(0, i - 6);
      let sum = 0, c = 0;
      for (let k = s0; k <= i; k++) { sum += vals[k].tot; c++; }
      return sum / c;
    });
    const pts = ma.map((v, i) => (pL + pitch * i + pitch / 2).toFixed(1) + ',' + yOf(v).toFixed(1)).join(' ');
    const maLine = n > 1
      ? '<polyline points="' + pts + '" fill="none" stroke="' + CH.cssVar('--t2') +
        '" stroke-width="1.2" stroke-opacity=".5" stroke-dasharray="4 3" pointer-events="none"/>'
      : '';

    let xl = '';
    const step = Math.max(1, Math.ceil(n / 6));
    vals.forEach((v, i) => {
      if (i % step === 0 || i === n - 1) {
        xl += '<text x="' + (pL + pitch * i + pitch / 2).toFixed(1) + '" y="' + (H - 4) +
          '" text-anchor="middle" font-size="8.5" fill="' + CH.cssVar('--t4') + '">' + v.d.slice(5) + '</text>';
      }
    });

    let hits = '';
    vals.forEach((v, i) => {
      hits += '<rect x="' + (pL + pitch * i).toFixed(1) + '" y="' + pT + '" width="' + pitch.toFixed(1) +
        '" height="' + ih + '" fill="transparent" data-i="' + i + '"/>';
    });

    host.innerHTML =
      '<div class="daily-hd">' +
        '<span class="daily-t">模型消耗<em>按日堆叠 · 单位积分' + (useLog ? ' · log₁₀' : '') + '</em></span>' +
        '<span class="daily-peak">峰值 ' + peak.d.slice(5) + ' · ' + F.int(peak.tot) + '</span>' +
      '</div>' +
      '<svg viewBox="0 0 ' + W + ' ' + H + '" preserveAspectRatio="none" height="' + H + '">' + g + bars + maLine + xl + hits + '</svg>' +
      '<div class="daily-ft">' +
        '<span class="daily-lg">' + active.map(mi =>
          '<span><i style="background:' + col(mi) + '"></i>' + esc(R.models[mi]) + '</span>').join('') + '</span>' +
        '<span class="daily-note">虚线为 7 日均 · 悬停看当日明细</span>' +
      '</div>';

    host.querySelectorAll('svg rect[data-i]').forEach(el => {
      const v = vals[+el.dataset.i];
      CH.bindTip(el, () => {
        const rows = active.map(mi => ({ n: R.models[mi], v: v.arr[mi] }))
          .filter(o => o.v > 0).sort((a, b) => b.v - a.v);
        return '<div class="tt-h">' + v.d + '</div>' +
          '<div class="tt-r"><span>合计</span><b>' + F.int(v.tot) + ' 积分</b></div>' +
          (rows.length ? rows.map(o =>
            '<div class="tt-r"><span>' + esc(o.n) + '</span><b>' + F.int(o.v) +
            '（' + F.pct(o.v / (v.tot || 1), 0) + '）</b></div>').join('')
            : '<div class="tt-r"><span>当日</span><b>无请求</b></div>');
      });
    });
  }

  /* ============================================================
   * KPI
   * ============================================================ */
  function renderKpis(A) {
    const T = A.T;
    const items = [
      ['请求次数', F.int(T.reqs), `平均每次 ${F.num(T.reqs ? (T.in + T.out) / T.reqs : 0)} token`],
      ['会话数', F.int(A.sess.length), `平均 ${(T.reqs / Math.max(1, A.sess.length)).toFixed(0)} 次/会话`],
      ['项目数', F.int(A.byWs.length), `最贵：${A.byWs[0] ? A.byWs[0].label : '—'}`],
      ['平均上下文', F.num(T.avgIn), '每次请求带入的输入 token'],
      ['缓存命中率', F.pct(T.cacheRate), '输入里命中缓存的比例'],
      ['输出占比', F.pct(T.outputShare), '输出 token / 全部 token'],
      ['工具失败率', F.pct(T.calls ? T.fails / T.calls : 0), `${T.fails} 次非零退出`],
      ['重复读取', F.int(T.dupReads), '同一文件被重复读的次数'],
    ];

    // 计费口径：套餐模式下给出折算单价与额度使用率（这才是订阅用户真正关心的）
    const pq = planQuota(T);
    if (pq) {
      items.push(['套餐折算单价', '¥' + pq.q.unit.toFixed(4),
        `${pq.q.plan.name} · ${pq.q.cycle.name} · ¥${pq.q.fee.toFixed(0)}/月`]);
      items.push(['额度使用率', F.pct(pq.rate, 0),
        `额度 ${F.int(pq.quota)}（${Math.round(T.days)} 天折算）· ` +
        (pq.waste > 0.5 ? `浪费 ≈ ¥${pq.waste.toFixed(0)}` : '基本用满')]);
    } else {
      items.push(['积分牌价', '¥0.0500', '未选套餐，按名义牌价折算']);
    }

    $('kpis').innerHTML = items.map(([k, v, s]) => `
      <div class="kpi"><div class="k">${k}</div><b>${v}</b><div class="s">${s}</div></div>`).join('');
  }
  /* ============================================================
   * 洞察
   * ============================================================ */
  function renderInsights(A) {
    const T = A.T;
    const cs = T.costSplit;
    const out = [];

    // 1. 成本结构
    const missShare = cs.miss / Math.max(1e-9, T.yuan);
    const hitShare = cs.hit / Math.max(1e-9, T.yuan);
    const outShare = cs.out / Math.max(1e-9, T.yuan);
    out.push({
      c: '', ic: '◧', t: '钱到底买了什么',
      m: `输出只占账单的 <b>${F.pct(outShare)}</b>（${F.yuan(cs.out)}），读入占 <b>${F.pct(1 - outShare)}</b>。其中缓存读取 ${F.pct(hitShare)}、未命中输入 ${F.pct(missShare)} —— 你付的钱主要是「让它反复读」。`,
    });

    // 2. 模型结构错配
    const bm = A.byModel;
    if (bm.length > 1) {
      const main = bm.slice().sort((a, b) => b.reqs - a.reqs)[0];
      const mainUnit = main.credit / Math.max(1, main.reqs);
      const expensive = bm.slice()
        .filter(m => m.reqs >= 5)
        .sort((a, b) => (b.credit / Math.max(1, b.reqs)) - (a.credit / Math.max(1, a.reqs)))[0];
      if (expensive && expensive.m !== main.m) {
        out.push({
          c: 'b', ic: '⇅', t: '模型结构',
          m: `<b>${A.RAW.models[expensive.m]}</b> 只跑了 ${F.pct(expensive.reqs / Math.max(1, T.reqs))} 的请求，却吃掉 <b>${F.pct(expensive.credit / Math.max(1e-9, T.credit))}</b> 的预算。单次成本是主力模型 ${A.RAW.models[main.m]} 的 <b>${(expensive.credit / Math.max(1, expensive.reqs) / Math.max(1e-9, mainUnit)).toFixed(0)} 倍</b>。`,
        });
      }
    }

    // 3. 效率鸿沟：只在同一任务原型内部比较，避免拿轻活比重活
    let gap = null;
    for (const a of A.byArch) {
      const ss = A.sess.filter(s => s.arch === a.arch && s.chars >= 5000 && s.yuan >= 0.05);
      if (ss.length < 3) continue;
      const arr = ss.map(s => ({ s, v: s.chars / s.yuan })).sort((x, y) => y.v - x.v);
      const ratio = arr[0].v / Math.max(1, arr[arr.length - 1].v);
      if (!gap || ratio > gap.ratio) gap = { arch: a.arch, arr, ratio, n: ss.length };
    }
    if (gap) {
      const hi = gap.arr[0], lo = gap.arr[gap.arr.length - 1];
      out.push({
        c: '', ic: '⇢', t: '同类任务里的效率鸿沟',
        m: `在「${gap.arch}」这 ${gap.n} 个会话里，最省的每 1 元买到 <b>${F.num(hi.v)} 字</b>，最费的只有 <b>${F.num(lo.v)} 字</b> —— 差 <b>${gap.ratio.toFixed(1)} 倍</b>。同样的活，成本可以差一个量级。`,
      });
    }

    // 4. 缓存依赖
    out.push({
      c: 'v', ic: '⛁', t: '你最脆弱的地方',
      m: `缓存命中 <b>${F.pct(T.cacheRate)}</b>，按未命中价重算这张账单会变成 <b>${F.yuan(T.yuan + T.cacheSaving)}</b>（现在是 ${F.yuan(T.yuan)}）。中途切模型、改系统提示，都会让缓存前缀失效。`,
    });

    // 5. 峰值
    const topDay = A.days.slice().sort((a, b) => b.credit - a.credit)[0];
    const topSess = A.sess.slice().sort((a, b) => b.credit - a.credit)[0];
    if (topDay && topSess) {
      out.push({
        c: 'w', ic: '◈', t: '最贵的一天与最贵的会话',
        m: `<b>${topDay.d}</b> 一天花掉 ${F.yuan(topDay.credit * SL.CREDIT_PRICE)}；最贵的会话「${esc(topSess.title.slice(0, 22))}」花了 <b>${F.yuan(topSess.yuan)}</b>，产出 ${F.num(topSess.chars)} 字。`,
      });
    }

    $('insights').innerHTML = out.map(i => `
      <div class="ins ${i.c}"><div class="ic">${i.ic}</div><div><div class="t">${i.t}</div><div class="m">${i.m}</div></div></div>`).join('');
  }

  /* ============================================================
   * 01-A 成本构成
   * ============================================================ */
  function renderCost(A) {
    const T = A.T, cs = T.costSplit;
    const parts = [
      { k: '缓存读取', v: cs.hit, c: CH.cssVar('--m0'), note: '命中缓存', n2: F.num(T.hit) + ' tok' },
      { k: '未命中输入', v: cs.miss, c: CH.cssVar('--m2'), note: '全价输入', n2: F.num(T.in - T.hit) + ' tok' },
      { k: '输出', v: cs.out, c: CH.cssVar('--m1'), note: '生成', n2: F.num(T.out) + ' tok' },
    ];
    if (cs.other > 0.01) parts.push({ k: '其他', v: cs.other, c: CH.cssVar('--t3'), note: '生成类工具/牌价兜底', n2: '' });

    $('costCard').innerHTML = `
      <div class="sec" style="margin:0 0 6px">
        <h2 style="font-size:12.5px">成本构成 <span class="badge">按反解单价拆分</span></h2>
        <span class="note">合计 ${F.yuan(T.yuan)} · ${F.int(T.credit)} 积分</span>
      </div>
      <div id="costBar"></div>
      <div style="display:flex;gap:18px;flex-wrap:wrap;margin-top:6px" id="costLegend"></div>
      <div class="two" style="margin-top:20px">
        <div>
          <div class="note" style="margin-bottom:6px">钱花在哪个动作上</div>
          <div id="toolBars"></div>
        </div>
        <div>
          <div class="note" style="margin-bottom:6px">一天里什么时候最费钱</div>
          <div id="hourBars"></div>
          <div class="foot" id="hourNote"></div>
        </div>
      </div>`;

    CH.costSplit($('costBar'), parts, {
      title: '', right: `缓存命中 ${F.pct(T.cacheRate)} · 输出占比 ${F.pct(T.outputShare)}`,
    });
    $('costLegend').innerHTML = CH.costLegend(parts);

    // 工具族
    const famColors = { '执行': '--m2', '勘探': '--m3', '精修': '--m1', '创作': '--m0', '调研': '--m5', '编排': '--m4', '管理': '--m7', '交付': '--m7', '工具': '--m7', '应答': '--m6' };
    const rows = A.byTool.filter(t => t.credit > 0.001).slice(0, 8).map(t => ({
      k: t.f, v: t.credit * SL.CREDIT_PRICE,
      c: CH.cssVar(famColors[t.f] || '--m7'),
      sub: `${t.reqs} 次 · ${F.pct(t.reqs / Math.max(1, T.reqs), 0)}`,
      tip: () => `<div class="tt-h">${t.f}类动作</div>
        <div class="tt-r"><span>花费</span><b>${F.yuan(t.credit * SL.CREDIT_PRICE)}</b></div>
        <div class="tt-r"><span>请求</span><b>${F.int(t.reqs)}</b></div>
        <div class="tt-r"><span>平均每次</span><b>${F.yuan(t.credit * SL.CREDIT_PRICE / Math.max(1, t.reqs))}</b></div>`,
    }));
    CH.hbars($('toolBars'), rows, { rowH: 34, labelW: 80 });

    // 小时
    const hrs = new Array(24).fill(0);
    for (let i = 0; i < 7; i++) for (let h = 0; h < 24; h++) hrs[h] += A.hourGrid[i * 24 + h];
    CH.hourBars($('hourBars'), hrs.map(v => v * SL.CREDIT_PRICE), { title: '按小时汇总（周一到周日合计）' });
    const peak = hrs.indexOf(Math.max.apply(null, hrs));
    $('hourNote').innerHTML = `峰值时段 <b style="color:var(--t2)">${peak}:00–${(peak + 1) % 24}:00</b>，占全天 ${F.pct(hrs[peak] / Math.max(1, hrs.reduce((a, b) => a + b, 0)))}。深夜的会话往往上下文最长。`;
  }

  /* ============================================================
   * 01-B 桑基
   * ============================================================ */
  function renderSankey(A) {
    const links = [];
    const lTot = new Map(), rTot = new Map();
    for (const s of A.sess) {
      s.modelShare.forEach(ms => {
        const v = ms.credit * SL.CREDIT_PRICE;
        if (v <= 0.0005) return;
        links.push({ s: A.RAW.models[ms.m], t: s.arch, v });
        lTot.set(A.RAW.models[ms.m], (lTot.get(A.RAW.models[ms.m]) || 0) + v);
        rTot.set(s.arch, (rTot.get(s.arch) || 0) + v);
      });
    }
    const totalV = links.reduce((a, l) => a + l.v, 0) || 1;
    const top = (map) => {
      const arr = [...map.entries()].sort((a, b) => b[1] - a[1]);
      // 只保留占比 ≥2% 的节点，其余并成「其他」——避免出现一堆看不见的细线
      const head = arr.filter(x => x[1] / totalV >= 0.02).slice(0, 5).map(x => x[0]);
      const headSet = new Set(head);
      const rest = arr.filter(x => !headSet.has(x[0])).reduce((a, x) => a + x[1], 0);
      return { head: rest / totalV >= 0.005 ? head.concat(['其他']) : head };
    };
    const L = top(lTot).head, R = top(rTot).head;
    const Lset = new Set(L), Rset = new Set(R);
    const merged = new Map();
    for (const l of links) {
      const s2 = Lset.has(l.s) ? l.s : '其他';
      const t2 = Rset.has(l.t) ? l.t : '其他';
      const k = s2 + '\u0000' + t2;
      merged.set(k, (merged.get(k) || 0) + l.v);
    }
    const keep = [...merged.entries()].map(([k, v]) => {
      const [s2, t2] = k.split('\u0000');
      return { s: s2, t: t2, v };
    });

    $('sankeyCard').innerHTML = `
      <div class="sec" style="margin:0 0 8px">
        <h2 style="font-size:12.5px">钱从哪个模型流向哪类任务</h2>
        <span class="note">带宽 = 金额；左侧模型，右侧任务原型</span>
      </div>
      <div id="sankeyHost"></div>
      <div class="foot">读法：一条带子越粗，说明这类任务越依赖这个模型。如果某个便宜模型承担了大带宽，说明那块工作本来就不需要贵模型。</div>`;
    if (keep.length) CH.sankey($('sankeyHost'), keep, L, R, {});
    else $('sankeyHost').innerHTML = '<div class="empty">当前筛选下没有可展示的流向</div>';
  }

  /* ============================================================
   * 01-C 项目榜
   * ============================================================ */
  function renderProjects(A) {
    const T = A.T;
    const rows = A.byWs.slice(0, 10).map(w => ({
      k: w.label, v: w.credit * SL.CREDIT_PRICE,
      sub: `${w.sess.length} 个会话 · ${F.num(w.chars)} 字 · ${w.chars > 0 ? '¥' + (w.credit * SL.CREDIT_PRICE / (w.chars / 1000)).toFixed(3) + '/千字' : '无产出'}`,
      tip: () => `<div class="tt-h">${esc(w.label)}</div>
        <div class="tt-r"><span>花费</span><b>${F.yuan(w.credit * SL.CREDIT_PRICE)}</b></div>
        <div class="tt-r"><span>占总额</span><b>${F.pct(w.credit / Math.max(1e-9, T.credit))}</b></div>
        <div class="tt-r"><span>会话 / 请求</span><b>${w.sess.length} / ${F.int(w.reqs)}</b></div>
        <div class="tt-r"><span>产出</span><b>${F.num(w.chars)} 字</b></div>`,
    }));
    $('projectCard').innerHTML = `
      <div class="sec" style="margin:0 0 8px">
        <h2 style="font-size:12.5px">项目消耗榜</h2>
        <span class="note">${A.byWs.length} 个项目 · 最高占 ${F.pct((A.byWs[0] ? A.byWs[0].credit : 0) / Math.max(1e-9, T.credit))}</span>
      </div>
      <div id="projBars"></div>
      <div class="foot">「¥/千字」把花费摊到实际写出来的字数上，是跨项目比较的唯一公平尺子 —— 不同项目的会话长度差别极大，只比总额会误判。<b>条长为对数刻度</b>，否则头部项目会把其余全部压成一条线；精确金额见右侧数字。</div>`;
    if (rows.length) CH.hbars($('projBars'), rows, { rowH: 38, scale: 'log', labelW: Math.min(240, $('projBars').clientWidth * .28) });
    else $('projBars').innerHTML = '<div class="empty">无数据</div>';
  }

  /* ============================================================
   * 02-A 价值地图
   * ============================================================ */
  function renderMap(A) {
    const pts = A.sess.filter(s => s.yuan > 0).map(s => ({
      s, x: Math.max(0.002, s.yuan), y: Math.max(10, s.chars),
      v: s.value, c: archColor(s.arch), label: s.title.slice(0, 12),
      tip: `<div class="tt-h">${esc(s.title.slice(0, 40))}</div>
        <div class="tt-r"><span>原型</span><b>${s.arch}</b></div>
        <div class="tt-r"><span>花费</span><b>${F.yuan(s.yuan)}</b></div>
        <div class="tt-r"><span>产出</span><b>${F.num(s.chars)} 字</b></div>
        <div class="tt-r"><span>¥/千字</span><b>${s.perK == null ? '—' : '¥' + s.perK.toFixed(3)}</b></div>
        <div class="tt-r"><span>价值分</span><b>${s.value.toFixed(1)}</b></div>
        <div class="tt-r" style="color:var(--t4);margin-top:4px">点击看证据链 →</div>`,
    }));
    const arches = [...new Set(pts.map(p => p.s.arch))];
    $('mapCard').innerHTML = `
      <div class="sec" style="margin:0 0 8px">
        <h2 style="font-size:12.5px">每个会话的位置</h2>
        <div class="legend">${arches.map(a => `<span><i style="background:${archColor(a)}"></i>${a}</span>`).join('')}</div>
      </div>
      <div id="mapHost"></div>
      <div class="foot">气泡大小 = 综合价值分。虚线是中位数分界：右上角「花得多也产出多」是健康的，右下角「花得多产出少」要重点看。纯咨询类会话产出为 0，会贴在底边。</div>`;
    if (pts.length) CH.scatter($('mapHost'), pts, {
      height: 420,
      onClick: p => openDrawer(p.s),
    });
    else $('mapHost').innerHTML = '<div class="empty">无数据</div>';
  }

  /* ============================================================
   * 02-B 排行 + 权重
   * ============================================================ */
  function renderRank(A) {
    const sess = A.sess.slice().sort((a, b) => b.value - a.value);
    const top = sess.slice(0, 6);
    const effSorted = A.sess.filter(s => s.chars > 500 && s.yuan > 0.01).sort((a, b) => (b.chars / b.yuan) - (a.chars / a.yuan));
    const best = effSorted.slice(0, 4);
    const worst = effSorted.slice(-4).reverse();

    const rowHtml = (s, extra) => `
      <div class="it" data-sid="${esc(s.id)}" style="cursor:pointer">
        <span>${esc(s.title.slice(0, 26))}</span>
        <span>${extra}</span>
      </div>`;

    $('rankCard').innerHTML = `
      <div class="sec" style="margin:0 0 12px">
        <h2 style="font-size:12.5px">价值评分 <span class="badge t">权重可调</span></h2>
        <span class="note">拖动滑块，排名会实时重算 —— 我们不假装权重是唯一真理</span>
      </div>
      <div class="sliders">
        <div class="sl"><label><span>交付力 D</span><b id="wDv">${ST.W.d}</b></label>
          <input type="range" id="wD" min="0" max="100" value="${ST.W.d}"></div>
        <div class="sl"><label><span>效率 E</span><b id="wEv">${ST.W.e}</b></label>
          <input type="range" id="wE" min="0" max="100" value="${ST.W.e}"></div>
        <div class="sl"><label><span>健康 H</span><b id="wHv">${ST.W.h}</b></label>
          <input type="range" id="wH" min="0" max="100" value="${ST.W.h}"></div>
      </div>
      <div class="two" style="margin-top:18px">
        <div>
          <div class="note" style="margin-bottom:6px">综合价值 TOP</div>
          <div class="dlist" id="topList">
            ${top.map(s => rowHtml(s, `<b style="color:var(--teal)">${s.value.toFixed(1)}</b> <span style="color:var(--t4)">· ¥${s.yuan.toFixed(2)}</span>`)).join('') || '<div class="empty">无</div>'}
          </div>
        </div>
        <div>
          <div class="note" style="margin-bottom:6px">性价比两端（字/元）</div>
          <div class="dlist">
            ${best.map(s => rowHtml(s, `<b style="color:var(--teal)">${F.num(s.chars / s.yuan)}字/元</b>`)).join('')}
            ${worst.map(s => rowHtml(s, `<b style="color:var(--rose)">${F.num(s.chars / s.yuan)}字/元</b>`)).join('')}
          </div>
        </div>
      </div>
      <div class="foot">D 交付力：有没有真的落盘产出（对数尺度）。E 效率：单位成本相对本批中位数。H 健康：失败率、重复读取、上下文膨胀。<b>纯问答会话因无落盘产出，D 天然偏低 —— 这不代表它没用，只说明它不产生可复用的资产。</b></div>`;

    const bind = () => {
      const upd = () => {
        ST.W = { d: +$('wD').value, e: +$('wE').value, h: +$('wH').value };
        $('wDv').textContent = ST.W.d; $('wEv').textContent = ST.W.e; $('wHv').textContent = ST.W.h;
        SL.rescore(A.sess, ST.W);
        try { localStorage.setItem('sl.w', JSON.stringify(ST.W)); } catch (e) {}
        const s2 = A.sess.slice().sort((a, b) => b.value - a.value).slice(0, 6);
        $('topList').innerHTML = s2.map(s => rowHtml(s, `<b style="color:var(--teal)">${s.value.toFixed(1)}</b> <span style="color:var(--t4)">· ¥${s.yuan.toFixed(2)}</span>`)).join('');
        bindRows();
      };
      ['wD', 'wE', 'wH'].forEach(id => { $(id).oninput = upd; });
    };
    const bindRows = () => {
      document.querySelectorAll('#rankCard .it').forEach(el => {
        el.onclick = () => {
          const s = A.sess.find(x => x.id === el.dataset.sid);
          if (s) openDrawer(s);
        };
      });
    };
    bind(); bindRows();
  }

  /* ============================================================
   * 03-A 实测单价
   * ============================================================ */
  function renderPrice(A) {
    const rows = A.pricing.filter(p => p.n > 0).map(p => {
      const col = modelColor(p.m);
      return `<tr>
        <td class="l"><span style="display:inline-block;width:8px;height:8px;border-radius:2px;background:${col};margin-right:7px"></span>${esc(p.name)}</td>
        <td>${F.int(p.n)}</td>
        <td>${p.pm == null ? '—' : p.pm.toFixed(1)}</td>
        <td>${p.ph == null ? '—' : p.ph.toFixed(2)}</td>
        <td>${p.po == null ? '—' : p.po.toFixed(0)}</td>
        <td>${p.po == null ? '—' : '¥' + (p.po * SL.CREDIT_PRICE).toFixed(2)}</td>
        <td><span class="badge ${p.src === '实测拟合' ? 't' : 'a'}">${p.src}</span></td>
        <td>${p.r2 ? p.r2.toFixed(3) : '—'}</td>
      </tr>`;
    }).join('');

    $('priceCard').innerHTML = `
      <div class="sec" style="margin:0 0 8px">
        <h2 style="font-size:12.5px">单价反解 <span class="badge">最小二乘</span></h2>
        <span class="note">用 ${F.int(A.T.reqs)} 条真实账单拟合 credit = 单价 × token</span>
      </div>
      <div class="tbl-wrap"><table>
        <thead><tr>
          <th class="l">模型</th><th>样本</th><th>未命中输入</th><th>缓存命中</th><th>输出</th><th>输出折¥</th><th>来源</th><th>R²</th>
        </tr></thead>
        <tbody>${rows}</tbody>
      </table></div>
      <div class="foot">
        单位：<b>积分 / 百万 token</b>（最后一列按 ¥0.05/积分折算，仅供体感）。<br>
        「实测拟合」= 从你自己的 credit 字段反解，R² 越接近 1 越可信；R² 低说明该模型请求的 token 结构太单一，无法分离三个系数，此时回退到官方牌价。<br>
        <b>所有推荐结论只用积分比较，不依赖 ¥ 汇率假设</b> —— 即使 ¥0.05 这个换算不准，模型之间的相对结论依然成立。
      </div>`;
  }

  /* ============================================================
   * 03-B 顾问
   * ============================================================ */
  function renderAdvice(A) {
    const adv = ST.ADV || [];
    let usable = adv.filter(a => a.best && a.credit > 0.02 && a.saveSelYuan >= 0.02);
    if (!usable.length) usable = adv.filter(a => a.best && a.credit > 0.02);
    const totalSave = usable.reduce((x, a) => x + a.saveSelYuan, 0);

    const rows = usable.slice(0, 6).map(a => {
      const cur = a.credit * SL.CREDIT_PRICE;
      const mx = Math.max(cur, a.best.selYuan, a.best.fullYuan, 1e-9);
      const bar = (v, c, label) => `
        <div class="advbar">
          <span>${label}</span>
          <div class="track"><div class="fill" style="width:${(v / mx * 100).toFixed(1)}%;background:${c}"></div></div>
          <span style="text-align:right">¥${v.toFixed(2)}</span>
        </div>`;
      const stars = '★'.repeat(Math.max(1, a.conf)) + '☆'.repeat(3 - Math.max(1, a.conf));
      return `<div class="advrow">
        <div class="an">
          ${esc(a.arch)}
          <small>${a.n} 个会话 · ${F.int(a.reqs)} 次请求</small>
          <small class="conf" title="置信度：样本量 × 可比较模型数">${stars} <span style="color:var(--t4);letter-spacing:0">${a.conf >= 3 ? '结论稳' : a.conf === 2 ? '可参考' : '样本偏少'}</span></small>
        </div>
        <div class="bars">
          ${bar(cur, CH.cssVar('--rose'), '现在')}
          ${bar(a.best.selYuan, CH.cssVar('--cyan'), '保守下沉')}
          ${bar(a.best.fullYuan, CH.cssVar('--teal'), '全量替换')}
          <div style="font-size:10px;color:var(--t4);margin-top:2px">下沉目标：<b style="color:var(--t2)">${esc(a.best.name)}</b>${a.kept ? '（与现用量最大模型优势不足 8%，保持现状）' : ''}</div>
        </div>
        <div class="save">
          <b>−¥${a.saveSelYuan.toFixed(2)}</b>
          <small>省 ${F.pct(a.pctSel, 0)}${a.saveFullYuan > a.saveSelYuan ? ` · 全量可省 ¥${a.saveFullYuan.toFixed(2)}` : ''}</small>
        </div>
      </div>`;
    }).join('');

    $('adviceCard').innerHTML = `
      <div class="sec" style="margin:0 0 8px">
        <h2 style="font-size:12.5px">按任务类型给建议</h2>
        <span class="note">合计可省 <b style="color:var(--teal)">¥${totalSave.toFixed(2)}</b>（占本期 ${F.pct(totalSave / Math.max(0.01, A.T.yuan))}）</span>
      </div>
      <div class="adv">${rows || '<div class="empty">样本不足，无法给出可靠建议</div>'}</div>
      <div class="foot">
        <b>保守下沉</b> = 只把「勘探/执行/调研/管理」这类低判断力请求换到便宜模型，写作与审校留在原模型 —— 这是推荐做法。<br>
        <b>全量替换</b> = 整个会话都换，省得更多但质量风险实在，只作对照。<br>
        候选模型必须在该任务类型下真实跑过至少 8 次才纳入比较（标「待验证」的不计入节约估算）。这是为了防止拿一个从没干过这活儿的模型来「证明」便宜。
      </div>`;
  }

  /* ============================================================
   * 03-C 反事实模拟器
   * ============================================================ */
  function renderSim(A) {
    const sess = A.sess.slice().sort((a, b) => b.credit - a.credit);
    if (!sess.length) { $('simCard').innerHTML = '<div class="empty">无数据</div>'; return; }
    const sid = ST.sim || sess[0].id;
    const s = sess.find(x => x.id === sid) || sess[0];
    const priced = A.pricing.filter(p => p.pm != null);
    const curM = s.domModel;
    // 目标模型：优先用户显式选择，其次该原型顾问推荐的，最后取最便宜的替代
    let target = ST.simM != null ? priced.find(p => p.m === ST.simM) : null;
    if (!target) {
      const advRow = (ST.ADV || []).find(a => a.arch === s.arch && a.best && a.best.m !== curM);
      target = advRow ? priced.find(p => p.m === advRow.best.m) : null;
    }
    if (!target) {
      const alt = priced.filter(p => p.m !== curM).sort((a, b) => a.po - b.po);
      target = alt[0] || priced[0];
    }

    const full = SL.counterfactual(s, A.pricing, target.m);
    const sel = SL.counterfactualSelective(s, A.pricing, target.m);

    $('simCard').innerHTML = `
      <div class="sec" style="margin:0 0 10px">
        <h2 style="font-size:12.5px">反事实模拟器 <span class="badge v">挑一个会话算账</span></h2>
        <span class="note">同样的 token 结构，换个模型要花多少</span>
      </div>
      <div style="display:flex;gap:8px;flex-wrap:wrap;margin-bottom:14px">
        <select id="simSess" style="flex:1;min-width:240px">
          ${sess.slice(0, 40).map(x => `<option value="${esc(x.id)}" ${x.id === sid ? 'selected' : ''}>${esc(x.title.slice(0, 34))} · ¥${x.yuan.toFixed(2)}</option>`).join('')}
        </select>
        <select id="simModel" style="min-width:180px">
          ${priced.map(p => `<option value="${p.m}" ${p.m === target.m ? 'selected' : ''}>换成 ${esc(p.name)}</option>`).join('')}
        </select>
      </div>
      <div class="three" style="gap:12px">
        <div class="mini"><div class="k">当前花费</div><div class="v">${F.yuan(s.yuan)}</div><div class="s">${F.int(s.reqs)} 次请求 · ${F.num(s.chars)} 字</div></div>
        <div class="mini ${sel && sel.deltaYuan < 0 ? 'good' : 'warn'}"><div class="k">保守下沉（低判断力请求换模型）</div>
          <div class="v">${sel ? F.yuan(sel.yuan) : '—'}</div>
          <div class="s">${sel ? (sel.deltaYuan <= 0 ? '省 ' : '多花 ') + F.yuan(Math.abs(sel.deltaYuan)) + ` · 换 ${sel.switched} 条 / 保 ${sel.kept} 条` : '—'}</div></div>
        <div class="mini ${full && full.deltaYuan < 0 ? 'good' : 'warn'}"><div class="k">全量替换</div>
          <div class="v">${full ? F.yuan(full.yuan) : '—'}</div>
          <div class="s">${full ? (full.deltaYuan <= 0 ? '省 ' : '多花 ') + F.yuan(Math.abs(full.deltaYuan)) + ` · ${F.pct(Math.abs(full.pct), 0)}` : '该模型无可用单价'}</div></div>
      </div>
      <div class="foot">
        计算方式：把这个会话的真实 token 结构（未命中输入 / 缓存命中 / 输出）套到目标模型的实测单价上。
        <b>这不是预测，是同结构外推</b>：它假设换了模型后缓存行为、输出长度都不变，实际会有偏差。
        单价来源：${esc((full && full.src) || '—')}${full && full.src === '实测拟合' ? `（R²=${full.r2.toFixed(3)}）` : ''}。
      </div>`;

    $('simSess').onchange = e => { ST.sim = e.target.value; renderSim(ST.AGG); };
    $('simModel').onchange = e => { ST.sim = s.id; ST.simM = +e.target.value; renderSim(ST.AGG); };
  }

  /* ============================================================
   * 04 处方
   * ============================================================ */
  function renderRx(A) {
    const rx = ST.RX || [];
    const total = rx.reduce((a, f) => a + (f.est || 0), 0);
    const highN = rx.filter(f => f.level === 'high').length;
    const rc = $('rxCount');
    if (rc) rc.textContent = rx.length;
    const rs = $('rxSummary');
    if (rs) {
      rs.innerHTML = `可省上限 <b style="color:var(--teal)">¥${total.toFixed(2)}</b>` +
        `（占本期 ${F.pct(total / Math.max(0.01, A.T.yuan))}）· ${highN} 条高优先`;
    }
    $('rxList').innerHTML = rx.map(f => `
      <div class="rxcard ${f.level}">
        <div class="rxh">
          <h4>${esc(f.title)} <span class="badge ${f.level === 'high' ? 'r' : f.level === 'mid' ? 'a' : f.level === 'low' ? '' : 'v'}">${esc(f.tag)}</span></h4>
          ${f.est > 0.005 ? `<div class="amt">可省 ¥${f.est.toFixed(2)}</div>` : ''}
        </div>
        <div class="rxp">${f.detail}</div>
        ${f.evidence && f.evidence.length ? `<div class="rxev">${f.evidence.map(e => `<span>${esc(e.t)} <b>${esc(e.v)}</b></span>`).join('')}</div>` : ''}
        <div class="rxa"><b>怎么做 · </b>${f.action}</div>
      </div>`).join('') || '<div class="empty">没有发现明显浪费，这份账单挺健康</div>';

    $('rxList').insertAdjacentHTML('beforeend', `
      <div class="foot" style="margin-top:6px">
        以上可省金额合计 <b style="color:var(--teal)">¥${total.toFixed(2)}</b>，约占本期 ${F.pct(total / Math.max(0.01, A.T.yuan))}。
        <b>这是粗估上限，不是承诺</b>：规则之间有重叠（例如模型下沉与重复读取可能作用在同一批请求上），且假设替换后质量不下降。
      </div>`);
  }

  /* ============================================================
   * 05 账本
   * ============================================================ */
  const COLS = [
    { k: 'title', t: '会话', l: 1 },
    { k: 'arch', t: '原型' },
    { k: 'yuan', t: '花费' },
    { k: 'reqs', t: '请求' },
    { k: 'chars', t: '产出字' },
    { k: 'perK', t: '¥/千字' },
    { k: 'dshare', t: 'D/E/H' },
    { k: 'value', t: '价值' },
    { k: 'fails', t: '失败' },
  ];

  function renderLedger(A) {
    const key = ST.sortKey, dir = ST.sortDir;
    const rows = A.sess.slice().sort((a, b) => {
      let va, vb;
      if (key === 'dshare') { va = a.D; vb = b.D; }
      else if (key === 'perK') { va = a.perK == null ? Infinity : a.perK; vb = b.perK == null ? Infinity : b.perK; }
      else { va = a[key]; vb = b[key]; }
      if (va == null) va = -Infinity;
      if (vb == null) vb = -Infinity;
      return (va > vb ? 1 : va < vb ? -1 : 0) * (dir === -1 ? -1 : 1);
    });
    const head = COLS.map(c => `<th class="${c.l ? 'l' : ''}" data-k="${c.k}">${c.t}${key === c.k ? (dir === -1 ? ' ↓' : ' ↑') : ''}</th>`).join('');
    const body = rows.map(s => `
      <tr class="row" data-sid="${esc(s.id)}">
        <td class="name" title="${esc(s.title)}">${esc(s.title)}</td>
        <td><span class="tagline ${s.arch === '多智能体编排' ? 'vi' : s.arch === '批量生产' ? 'cool' : s.arch === '精修迭代' ? 'mid' : ''}">${esc(s.arch)}</span></td>
        <td>¥${s.yuan.toFixed(2)}</td>
        <td>${F.int(s.reqs)}</td>
        <td>${F.num(s.chars)}</td>
        <td>${s.perK == null ? '—' : s.perK.toFixed(3)}</td>
        <td style="color:var(--t3)">${s.D.toFixed(0)}/${s.E.toFixed(0)}/${s.H.toFixed(0)}</td>
        <td><b style="color:${s.value > 70 ? 'var(--teal)' : s.value < 55 ? 'var(--rose)' : 'var(--t1)'}">${s.value.toFixed(1)}</b></td>
        <td style="color:${s.fails > 5 ? 'var(--rose)' : 'var(--t3)'}">${s.fails}</td>
      </tr>`).join('');

    $('ledgerCard').innerHTML = `
      <div class="sec" style="margin:0 0 8px">
        <h2 style="font-size:12.5px">${rows.length} 个会话</h2>
        <span class="note">点表头排序，点行看证据</span>
      </div>
      <div class="tbl-wrap"><table id="ledgerTbl"><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;

    $('ledgerTbl').querySelectorAll('th').forEach(th => {
      th.onclick = () => {
        const k = th.dataset.k;
        if (ST.sortKey === k) ST.sortDir *= -1; else { ST.sortKey = k; ST.sortDir = -1; }
        renderLedger(A);
      };
    });
    $('ledgerTbl').querySelectorAll('tr.row').forEach(tr => {
      tr.onclick = () => {
        const s = A.sess.find(x => x.id === tr.dataset.sid);
        if (s) openDrawer(s);
      };
    });
  }

  /* ============================================================
   * 抽屉：会话证据链
   * ============================================================ */
  function openDrawer(s) {
    const A = ST.AGG;
    const dim = (label, v, na, color) => `
      <div class="dim"><span>${label}${na ? ' <em style="font-style:normal;color:var(--t4)">N/A</em>' : ''}</span>
        <div class="tr"><i style="width:${na ? 55 : v}%;background:${color}"></i></div><b>${na ? '中性' : v.toFixed(0)}</b></div>`;

    const models = s.modelShare.map(ms => {
      const col = modelColor(ms.m);
      const share = s.reqs ? ms.n / s.reqs : 0;
      return `<div class="it"><span><i style="display:inline-block;width:7px;height:7px;border-radius:2px;background:${col};margin-right:6px"></i>${esc(A.RAW.models[ms.m])}</span>
        <span>${ms.n} 次 · ¥${(ms.credit * SL.CREDIT_PRICE).toFixed(2)} · ${F.pct(share, 0)}</span></div>`;
    }).join('');

    const tools = Object.entries(s.toolCount).sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([k, v]) => `<span>${esc(k)} <b>${v}</b></span>`).join('');

    const newFiles = s.filesNew.slice(0, 12).map(f => `<div class="it"><span>＋ ${esc(f)}</span><span>新建</span></div>`).join('') || '<div class="it"><span style="color:var(--t4)">没有新建文件</span><span></span></div>';
    const editTop = [...s.fileEdits.entries()].sort((a, b) => b[1] - a[1]).slice(0, 8)
      .map(([f, c]) => `<div class="it"><span>${esc(f)}</span><span>${c} 次编辑</span></div>`).join('') || '<div class="it"><span style="color:var(--t4)">没有编辑记录</span><span></span></div>';

    const cf = SL.counterfactualSelective(s, A.pricing, (s.domModel + 1) % A.pricing.length);

    $('drawer').innerHTML = `
      <button class="x" id="drawerX">✕</button>
      <div class="badge ${s.arch === '多智能体编排' ? 'v' : 't'}" style="margin-bottom:10px">${esc(s.arch)}</div>
      <h3>${esc(s.title)}</h3>
      <div style="font-size:11px;color:var(--t3);margin-top:7px">
        ${F.dateTime(s.st)} → ${F.dateTime(s.en)} · 跨 ${F.dur(s.durMin)} · ${s.turns} 轮对话
      </div>

      <div class="dstat">
        <div><div class="k">花费</div><div class="v" style="color:var(--teal)">¥${s.yuan.toFixed(2)}</div></div>
        <div><div class="k">请求</div><div class="v">${F.int(s.reqs)}</div></div>
        <div><div class="k">产出</div><div class="v">${F.num(s.chars)} 字</div></div>
        <div><div class="k">¥/千字</div><div class="v">${s.perK == null ? '—' : s.perK.toFixed(3)}</div></div>
        <div><div class="k">每轮输入</div><div class="v">${F.num(s.avgIn)}</div></div>
        <div><div class="k">缓存命中</div><div class="v">${F.pct(s.in ? s.hit / s.in : 0, 0)}</div></div>
      </div>

      <div class="dims">
        ${dim('交付力 D', s.D, s.dNa, CH.cssVar('--teal'))}
        ${dim('效率 E', s.E, s.eNa, CH.cssVar('--cyan'))}
        ${dim('健康 H', s.H, false, CH.cssVar('--violet'))}
      </div>

      <div class="note" style="margin:14px 0 5px">模型构成</div>
      <div class="dlist">${models}</div>

      <div class="note" style="margin:14px 0 5px">动作构成（共 ${s.calls} 次工具调用）</div>
      <div class="rxev">${tools || '<span>无</span>'}</div>

      <div class="note" style="margin:14px 0 5px">产出证据 · 新建 ${s.filesNew.length} 个文件</div>
      <div class="dlist">${newFiles}</div>

      <div class="note" style="margin:14px 0 5px">改动最频繁的文件</div>
      <div class="dlist">${editTop}</div>

      <div class="note" style="margin:14px 0 5px">浪费证据</div>
      <div class="dlist">
        <div class="it"><span>失败工具调用</span><span>${s.fails} 次 · ¥${(s.failCredit * SL.CREDIT_PRICE).toFixed(2)}</span></div>
        <div class="it"><span>重复读取</span><span>${s.dupReads} 次${s.worstRead ? ' · 《' + esc(s.worstRead) + '》' + s.worstReadN + ' 次' : ''}</span></div>
        <div class="it"><span>子代理</span><span>${s.agentsN} 个 · ¥${(s.subCredit * SL.CREDIT_PRICE).toFixed(2)}</span></div>
      </div>

      ${cf ? `<div class="rxa" style="margin-top:16px">
        <b>换模型算账 · </b>若把低判断力请求下沉到 ${esc(cf.name)}，这个会话预计 ¥${cf.yuan.toFixed(2)}
        （${cf.deltaYuan <= 0 ? '省' : '多花'} ¥${Math.abs(cf.deltaYuan).toFixed(2)}，换 ${cf.switched} 条请求）。
      </div>` : ''}

      <div style="margin-top:20px"><button class="btn" id="drawerSim">用这个会话做反事实模拟 →</button></div>`;

    $('drawerBg').classList.add('on');
    $('drawer').classList.add('on');
    $('drawerX').onclick = closeDrawer;
    $('drawerSim').onclick = () => {
      ST.sim = s.id;
      renderSim(A);
      closeDrawer();
      $('simCard').scrollIntoView({ behavior: 'smooth', block: 'center' });
    };
  }
  function closeDrawer() {
    $('drawerBg').classList.remove('on');
    $('drawer').classList.remove('on');
  }

  /* ============================================================
   * 06 方法论
   * ============================================================ */
  function renderMethod(A) {
    const T = A.T;
    const cb = costBase(T);
    // 分模型反向：谁比官方价还贵、谁才是省下的主要贡献者
    const obm = T.officialByModel || [];
    const negs = obm.filter(x => x.delta != null && x.delta < -0.01);
    const poss = obm.filter(x => x.delta != null && x.delta > 0.01);
    let reversalTxt = '';
    if (negs.length) {
      const w = negs[0], b = poss[poss.length - 1];
      reversalTxt = `；分模型看常有反转 —— ${w.name} 反而比官方价多花 ¥${Math.abs(w.delta).toFixed(2)}` +
        (b ? `，${b.name} 省了 ¥${b.delta.toFixed(2)}` : '');
    } else if (poss.length) {
      const b = poss[poss.length - 1];
      reversalTxt = `；其中 ${b.name} 贡献最大，省了 ¥${b.delta.toFixed(2)}`;
    }
    $('methodCard').innerHTML = `
      <div class="two">
        <div>
          <div class="note" style="margin-bottom:8px">价值评分</div>
          <div class="formula">价值分 V = <b>wD·D</b> + <b>wE·E</b> + <b>wH·H</b>   （权重可调，默认 45/35/20）

D 交付力 = 100·log10(1+产出字符) / log10(1+本批最大产出)
           └ 有 present_files 交付 +6，无落盘产出则按检索覆盖计分（上限 42）

E 效率   = 60·√(本批中位单位成本 ÷ 本会话单位成本)   → 中位数得 60 分
           └ 无落盘产出时不可比，取中性分 55 并标 N/A

H 健康   = 100 − 45·min(1, 失败率/15%) − 30·min(1, 重复读占比/50%) − 25·min(1, 每轮输入/12万)</div>
          <div class="foot">
            产出字符 = 所有 Write 的 content 长度 + 所有 Edit 的 new_string 长度，即「真正写出来的新内容」。
            没有设「规模」这一维，因为它和 D 高度相关，重复计权会让大任务天然占优。
            成本不进入价值分，而是作为分母独立呈现为「字/元」。
          </div>
        </div>
        <div>
          <div class="note" style="margin-bottom:8px">单价反解</div>
          <div class="formula">对每个模型解一个三元一次方程组：

credit ≈ pm·(未命中输入/1e6) + ph·(缓存命中/1e6) + po·(输出/1e6)

pm/ph/po 用普通最小二乘求解，报告 R²。
若任一系数 ≤ 0（常见于 token 结构单一导致共线），
判定拟合不可靠，回退到该模型官方牌价并标注来源。</div>
          <div class="note" style="margin:16px 0 8px">已知偏差</div>
          <div class="dlist">
            <div class="it"><span>会话标题</span><span>取 AI 标题，缺失时取首条用户消息前 60 字</span></div>
            <div class="it"><span>子代理归属</span><span>subagents/*.jsonl 的费用归入父会话</span></div>
            <div class="it"><span>失败成本</span><span>用 callId 关联请求，仅统计能对上的失败</span></div>
            <div class="it"><span>信用点数</span><span>credit 四舍五入到 0.01，小请求噪声较大</span></div>
            <div class="it"><span>反事实</span><span>假设 token 结构不变，实际换模型后缓存行为会变</span></div>
            <div class="it"><span>跨会话比较</span><span>存在混杂：贵模型可能只是用在了更难的活上</span></div>
          </div>
        </div>
      </div>
      <div class="note" style="margin:20px 0 8px">数据口径</div>
      <div class="kvs two">
        <div>
          <div class="kv"><span>数据源</span><span>~/.workbuddy/projects/**/*.jsonl</span></div>
          <div class="kv"><span>请求级记录</span><span>providerData.rawUsage.total_tokens 非空</span></div>
          <div class="kv"><span>本次统计请求</span><span>${F.int(T.reqs)} 条</span></div>
          <div class="kv"><span>统计窗口</span><span>${Math.round(T.days)} 天 · 月均 ${F.int(T.perMonthCredit)} 积分</span></div>
          <div class="kv"><span>金额换算</span><span>1 积分 ≈ ¥${SL.CREDIT_PRICE.toFixed(4)}${ST.plan === 'credit' ? '（牌价）' : '（套餐折算）'}</span></div>
        </div>
        <div>
          <div class="kv"><span>总 token</span><span>${F.int(T.in + T.out)}</span></div>
          <div class="kv"><span>输入 / 输出</span><span>${F.num(T.in)} / ${F.num(T.out)}</span></div>
          <div class="kv"><span>缓存命中</span><span>${F.num(T.hit)}（${F.pct(T.cacheRate)}）</span></div>
          <div class="kv"><span>官方 API 等价</span><span>${F.yuan(T.official)}（覆盖 ${F.pct(T.officialCover, 1)} 积分）</span></div>
          <div class="kv"><span>WorkBuddy 省下</span><span>${T.saveYuan >= 0 ? '' : '−'}${F.yuan(Math.abs(T.saveYuan))}（${F.pct(Math.abs(T.savePct), 1)}）</span></div>
        </div>
      </div>
      <div class="foot" style="margin-top:12px;line-height:1.9">
        <b>计费口径：</b>${ST.plan === 'credit'
          ? '按积分牌价 ¥0.0500/积分（未绑定套餐，适合对比或未订阅时使用）'
          : `按「${(SL.planQuote(ST.plan, ST.cycle) || {}).label || ''}」折算 ¥${SL.CREDIT_PRICE.toFixed(4)}/积分`}。
        切换口径只改变所有「¥」的换算，不改变积分与 token 的原始记录，也不影响任何排名结论。<br>
        <b>三个「省」不是同一件事，别混：</b><br>
        ① <b>缓存替你挡下</b> = 假设没有缓存、按同一套单价重算，你要多付多少（规模最大，但它是「避免的损失」，不是账面减免）。<br>
        ② <b>WorkBuddy 省下</b> = 官方牌价等价 − ${cb.label}（${F.yuan(cb.cost)}），<b>已经发生</b>的价差${reversalTxt}。<br>
        ③ <b>可省上限</b> = 本报告建议的优化空间（<b>还没发生</b>），见「省钱关键点」页签。<br>
        <b>为什么用「期间实付」而不是「已用积分 × 单价」：</b>
        订阅是固定支出，没用的额度也已经付过钱了。若按「已用积分 × 单价」分摊，
        浪费掉的额度会被算成 0 成本，结果是<b>套餐买得越贵、账面越显得划算</b>——
        这正是最容易骗到自己的算法，所以不用它。
      </div>`;
  }

  function renderFoot(A) {
    $('footNote').innerHTML = `
      workbuddy-spendLens · 我帮你省钱 &nbsp;|&nbsp; 数据快照 ${new Date().toLocaleString('zh-CN')} &nbsp;|&nbsp;
      ${A.RAW.files} 个日志文件 / ${F.num(A.RAW.lineCount)} 行 / ${F.num(A.RAW.bytes)} 字符 &nbsp;|&nbsp;
      ${ST.demo ? '<b>当前为脱敏演示数据</b>：项目名、会话标题、文件名均已替换，数值与结构为真实分布' : '本页不上传任何数据，关闭页面即销毁内存中的数据'}
      <br>金额按 1 积分 ≈ ¥${SL.CREDIT_PRICE.toFixed(4)} 折算${ST.plan === 'credit' ? '（积分牌价）' : `（${(SL.planQuote(ST.plan, ST.cycle) || {}).label || '套餐'} 折算）`}；所有模型比较结论只依赖积分，不受汇率与套餐价差影响。`;
  }

  /* ============================================================
   * 总渲染
   * ============================================================ */
  function renderAll() {
    if (!ST.RAW) return;
    recompute();
    const A = ST.AGG;
    renderTop();
    renderHero(A);
    renderKpis(A);
    renderInsights(A);
    renderCost(A);
    renderSankey(A);
    renderProjects(A);
    renderMap(A);
    renderRank(A);
    renderPrice(A);
    renderAdvice(A);
    renderSim(A);
    renderRx(A);
    renderLedger(A);
    renderMethod(A);
    renderFoot(A);
  }

  function renderChartsOnly() {
    if (!ST.AGG) return;
    // 只重绘当前可见面板里的图表，隐藏面板切过去时再画
    const fn = TAB_CHARTS[ST.tab];
    if (fn) fn(ST.AGG);
    renderHeat(ST.AGG); renderDaily(ST.AGG);   // 首屏两张图按宽度绘制，需跟随窗口
  }

  /* ============================================================
   * 事件绑定
   * ============================================================ */
  function bindGlobal() {
    $('winSeg').addEventListener('click', e => {
      const b = e.target.closest('.pill');
      if (!b) return;
      [...$('winSeg').children].forEach(x => x.classList.remove('on'));
      b.classList.add('on');
      ST.win = b.dataset.w;
      renderAll();
    });
    $('wsSel').onchange = e => { ST.ws = e.target.value; renderAll(); };
    $('modelSel').onchange = e => { ST.model = e.target.value; renderAll(); };
    const psel = $('planSel');
    if (psel) psel.onchange = e => {
      const v = e.target.value;
      if (v === 'credit') {
        ST.plan = 'credit';
        SL.setCreditPrice(0.05);
      } else {
        const parts = v.split(':');
        ST.plan = parts[0]; ST.cycle = parts[1] || 'm';
        const q = SL.planQuote(ST.plan, ST.cycle);
        SL.setCreditPrice(q ? q.unit : 0.05);
      }
      try { localStorage.setItem('sl.plan', v); } catch (err) {}
      renderAll();
      const q2 = ST.plan === 'credit' ? null : SL.planQuote(ST.plan, ST.cycle);
      toast(q2 ? `已按「${q2.label}」折算：¥${q2.unit.toFixed(4)}/积分` : '已切换为积分牌价 ¥0.05/积分');
    };
    $('themeBtn').onclick = () => {
      const light = document.body.classList.toggle('light');
      $('themeBtn').textContent = light ? '◑' : '◐';
      try { localStorage.setItem('sl.theme', light ? 'light' : 'dark'); } catch (e) {}
      renderChartsOnly();
    };
    $('drawerBg').onclick = closeDrawer;
    $('tabBar').addEventListener('click', e => {
      const b = e.target.closest('.tab');
      if (b && b.dataset.tab) switchTab(b.dataset.tab);
    });
    document.addEventListener('keydown', e => { if (e.key === 'Escape') closeDrawer(); });
    let rt;
    window.addEventListener('resize', () => {
      clearTimeout(rt);
      rt = setTimeout(renderChartsOnly, 180);
    });
  }

  function initTheme() {
    let t = 'dark';
    try {
      // 支持 ?theme=light|dark 强制指定（截图 / 分享用）
      const q = (location.search.match(/[?&]theme=(light|dark)/) || [])[1];
      t = q || localStorage.getItem('sl.theme') || 'dark';
    } catch (e) {}
    if (t === 'light') { document.body.classList.add('light'); $('themeBtn').textContent = '◑'; }
    try {
      const w = localStorage.getItem('sl.w');
      if (w) { const o = JSON.parse(w); if (o && o.d != null) ST.W = o; }
    } catch (e) {}
    // 恢复上次的计费口径（套餐单价必须在首次渲染前就位）
    try {
      const qp = (location.search.match(/[?&]plan=([a-z]+:[a-z0-9]+|credit)/) || [])[1];
      const pv = qp || localStorage.getItem('sl.plan');
      if (pv === 'credit') { ST.plan = 'credit'; SL.setCreditPrice(0.05); }
      else if (pv) {
        const parts = pv.split(':');
        const q = SL.planQuote(parts[0], parts[1] || 'm');
        if (q) { ST.plan = parts[0]; ST.cycle = parts[1] || 'm'; SL.setCreditPrice(q.unit); }
      } else {
        // 首次使用：落到推荐档（标准版·连续包年），顶部下拉可换成实际套餐
        const q = SL.planQuote('std', 'y');
        if (q) { ST.plan = 'std'; ST.cycle = 'y'; SL.setCreditPrice(q.unit); ST._defaultPlan = true; }
      }
    } catch (e) {}
  }

  root.SLUI = {
    ST, renderAll, bindGlobal, initTheme, toast, recompute, switchTab,
    setData(RAW, demo) {
      ST.RAW = RAW; ST.demo = !!demo;
      ST.ws = ''; ST.model = ''; ST.sim = null; ST.simM = null;
      renderAll();
      if (ST._defaultPlan) {
        ST._defaultPlan = false;
        const q = SL.planQuote(ST.plan, ST.cycle);
        if (q) toast(`已按「${q.label}」折算 ¥${q.unit.toFixed(4)}/积分 —— 顶部下拉可换成你的实际套餐`);
      }
    },
  };
})(window);
