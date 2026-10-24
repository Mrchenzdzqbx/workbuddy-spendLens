/* ============================================================
   SpendLens Charts — 手写 SVG，无第三方依赖
   ============================================================ */
;(function (root) {
  'use strict';
  const NS = 'http://www.w3.org/2000/svg';

  /* ---------------- 格式化 ---------------- */
  const FMT = {
    yuan(v, d) {
      if (v == null || !isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a >= 10000) return '¥' + (v / 1000).toFixed(0) + 'k';
      if (a >= 100) return '¥' + v.toFixed(0);
      if (a >= 10) return '¥' + v.toFixed(1);
      if (a >= 1) return '¥' + v.toFixed(2);
      if (a >= 0.01) return '¥' + v.toFixed(2);
      return '¥' + v.toFixed(3);
    },
    num(v) {
      if (v == null || !isFinite(v)) return '—';
      const a = Math.abs(v);
      if (a >= 1e9) return (v / 1e9).toFixed(2) + 'B';
      if (a >= 1e6) return (v / 1e6).toFixed(2) + 'M';
      if (a >= 1e4) return (v / 1e3).toFixed(1) + 'k';
      if (a >= 1000) return (v / 1000).toFixed(2) + 'k';
      return String(Math.round(v * 10) / 10);
    },
    int(v) { return (v == null || !isFinite(v)) ? '—' : Math.round(v).toLocaleString('zh-CN'); },
    pct(v, d) { return (v == null || !isFinite(v)) ? '—' : (v * 100).toFixed(d == null ? 1 : d) + '%'; },
    date(ts) { const d = new Date(ts); return d.getMonth() + 1 + '/' + d.getDate(); },
    dateTime(ts) {
      const d = new Date(ts);
      const p = n => String(n).padStart(2, '0');
      return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
    },
    dur(min) {
      if (!min || min < 1) return '<1 分钟';
      if (min < 60) return Math.round(min) + ' 分钟';
      return (min / 60).toFixed(1) + ' 小时';
    },
  };

  /* ---------------- SVG 基础 ---------------- */
  function svgEl(tag, attrs, parent) {
    const e = document.createElementNS(NS, tag);
    if (attrs) for (const k in attrs) {
      if (attrs[k] == null) continue;
      e.setAttribute(k, attrs[k]);
    }
    if (parent) parent.appendChild(e);
    return e;
  }
  function cssVar(name) {
    return getComputedStyle(document.body).getPropertyValue(name).trim();
  }
  function clear(host) { while (host.firstChild) host.removeChild(host.firstChild); }
  function mkSvg(host, w, h) {
    clear(host);
    const s = svgEl('svg', { width: '100%', height: h, viewBox: `0 0 ${w} ${h}`, class: 'chart', preserveAspectRatio: 'xMidYMid meet' }, host);
    return s;
  }

  /* ---------------- Tooltip ---------------- */
  const tip = () => document.getElementById('tip');
  function showTip(ev, html) {
    const t = tip();
    if (!t) return;
    t.innerHTML = html;
    t.classList.add('on');
    moveTip(ev);
  }
  function moveTip(ev) {
    const t = tip();
    if (!t || !t.classList.contains('on')) return;
    const pad = 14;
    const r = t.getBoundingClientRect();
    let x = ev.clientX + pad, y = ev.clientY + pad;
    if (x + r.width > innerWidth - 8) x = ev.clientX - r.width - pad;
    if (y + r.height > innerHeight - 8) y = ev.clientY - r.height - pad;
    t.style.left = Math.max(6, x) + 'px';
    t.style.top = Math.max(6, y) + 'px';
  }
  function hideTip() { const t = tip(); if (t) t.classList.remove('on'); }
  function bindTip(node, htmlFn) {
    node.addEventListener('mouseenter', e => showTip(e, htmlFn()));
    node.addEventListener('mousemove', moveTip);
    node.addEventListener('mouseleave', hideTip);
  }

  /* ---------------- 1. 成本构成堆叠条（标签外置，避免深浅主题对比度问题） ---------------- */
  function costSplit(host, parts, opts) {
    opts = opts || {};
    const W = host.clientWidth || 800, H = 74;
    const s = mkSvg(host, W, H);
    const total = parts.reduce((a, p) => a + Math.max(0, p.v), 0) || 1;
    const barY = 20, barH = 36, r = 7;
    let x = 0;

    svgEl('rect', { x: 0, y: barY, width: W, height: barH, rx: r, fill: cssVar('--line') }, s);

    parts.forEach((p, i) => {
      const w = Math.max(0, p.v) / total * W;
      if (w < 0.5) return;
      const g = svgEl('g', { style: 'cursor:default' }, s);
      const isFirst = i === 0, isLast = i === parts.length - 1;
      const rr = Math.min(r, w / 2);
      const x0 = x, x1 = x + w;
      let d;
      if (isFirst && isLast) d = `M${x0 + rr},${barY}h${w - 2 * rr}a${rr},${rr} 0 0 1 0,${barH}h${-(w - 2 * rr)}a${rr},${rr} 0 0 1 0,${-barH}z`;
      else if (isFirst) d = `M${x0 + rr},${barY}h${w - rr}v${barH}h${-(w - rr)}a${rr},${rr} 0 0 1 0,${-barH}z`;
      else if (isLast) d = `M${x0},${barY}h${w - rr}a${rr},${rr} 0 0 1 0,${barH}h${-(w - rr)}z`;
      else d = `M${x0},${barY}h${w}v${barH}h${-w}z`;
      const path = svgEl('path', { d, fill: p.c, opacity: .92 }, g);
      path.addEventListener('mouseenter', () => path.setAttribute('opacity', 1));
      path.addEventListener('mouseleave', () => path.setAttribute('opacity', .92));
      bindTip(g, () => `<div class="tt-h">${p.k}</div>
        <div class="tt-r"><span>金额</span><b>${FMT.yuan(p.v)}</b></div>
        <div class="tt-r"><span>占比</span><b>${FMT.pct(p.v / total)}</b></div>
        <div class="tt-r"><span>${p.note || ''}</span><b>${p.n2 || ''}</b></div>`);
      x = x1;
    });

    // 段间分隔线，避免同色系混淆
    let acc = 0;
    parts.forEach((p, i) => {
      acc += Math.max(0, p.v);
      if (i === parts.length - 1) return;
      const xx = acc / total * W;
      svgEl('line', { x1: xx, x2: xx, y1: barY, y2: barY + barH, stroke: cssVar('--bg'), 'stroke-width': 2 }, s);
    });

    if (opts.title) svgEl('text', { x: 0, y: 10, fill: cssVar('--t3'), 'font-size': 10.5 }, s).textContent = opts.title;
    if (opts.right) svgEl('text', { x: W, y: 10, 'text-anchor': 'end', fill: cssVar('--t4'), 'font-size': 10.5 }, s).textContent = opts.right;
    return s;
  }

  /* 成本构成图例（HTML，便于排版与主题切换） */
  function costLegend(parts) {
    const total = parts.reduce((a, p) => a + Math.max(0, p.v), 0) || 1;
    return parts.map(p => `
      <div style="display:flex;gap:7px;align-items:baseline;white-space:nowrap">
        <i style="width:8px;height:8px;border-radius:2px;background:${p.c};display:inline-block;transform:translateY(-1px)"></i>
        <span style="font-size:11px;color:var(--t2)">${p.k}</span>
        <b style="font-size:12px;color:var(--t1);font-weight:650">${FMT.yuan(p.v)}</b>
        <span style="font-size:10px;color:var(--t4)">${FMT.pct(p.v / total)} · ${p.n2 || ''}</span>
      </div>`).join('');
  }

  /* ---------------- 2. 桑基图（两层） ---------------- */
  function sankey(host, links, leftOrder, rightOrder, opts) {
    opts = opts || {};
    const W = host.clientWidth || 900;
    const n = Math.max(leftOrder.length, rightOrder.length);
    const H = opts.height || Math.max(300, Math.min(480, n * 62));
    const s = mkSvg(host, W, H);
    const L = leftOrder, R = rightOrder;
    const gap = 14, nodeW = 10;
    const xL = Math.min(170, W * 0.22), xR = W - Math.min(190, W * 0.24);

    const lTot = new Map(), rTot = new Map(), total = links.reduce((a, l) => a + l.v, 0) || 1;
    L.forEach(k => lTot.set(k, 0)); R.forEach(k => rTot.set(k, 0));
    for (const l of links) {
      lTot.set(l.s, (lTot.get(l.s) || 0) + l.v);
      rTot.set(l.t, (rTot.get(l.t) || 0) + l.v);
    }

    // 每个节点保底 8px，剩余空间按金额分配 —— 否则小额节点会挤成看不见的线
    const layout = (keys, totMap) => {
      const minH = 8;
      const avail = H - gap * Math.max(0, keys.length - 1);
      const extra = Math.max(0, avail - minH * keys.length);
      const sum = keys.reduce((a, k) => a + (totMap.get(k) || 0), 0) || 1;
      const pos = new Map();
      let y = 0;
      for (const k of keys) {
        const h = minH + (totMap.get(k) || 0) / sum * extra;
        pos.set(k, { y, h });
        y += h + gap;
      }
      return pos;
    };
    const lPos = layout(L, lTot), rPos = layout(R, rTot);

    // 颜色：左侧模型色
    const colorOf = new Map();
    L.forEach((k, i) => colorOf.set(k, cssVar('--m' + (i % 8))));

    // 分配链接端点
    const lCur = new Map(L.map(k => [k, 0]));
    const rCur = new Map(R.map(k => [k, 0]));
    const sorted = links.slice().sort((a, b) => {
      const ia = L.indexOf(a.s), ib = L.indexOf(b.s);
      if (ia !== ib) return ia - ib;
      return R.indexOf(a.t) - R.indexOf(b.t);
    });

    const g = svgEl('g', {}, s);
    for (const l of sorted) {
      const lp = lPos.get(l.s), rp = rPos.get(l.t);
      if (!lp || !rp) continue;
      const lh = lp.h * (l.v / Math.max(1e-9, lTot.get(l.s)));
      const rh = rp.h * (l.v / Math.max(1e-9, rTot.get(l.t)));
      const y0 = lp.y + lCur.get(l.s), y1 = rp.y + rCur.get(l.t);
      lCur.set(l.s, lCur.get(l.s) + lh);
      rCur.set(l.t, rCur.get(l.t) + rh);
      const c = (xR - xL) * .42;
      const d = `M${xL},${y0} C${xL + c},${y0} ${xR - c},${y1} ${xR},${y1}
                 L${xR},${y1 + rh} C${xR - c},${y1 + rh} ${xL + c},${y0 + lh} ${xL},${y0 + lh} Z`;
      const p = svgEl('path', {
        d, fill: colorOf.get(l.s), opacity: .26, stroke: 'none',
        style: 'transition:opacity .15s;cursor:default'
      }, g);
      p.addEventListener('mouseenter', () => { p.setAttribute('opacity', .6); });
      p.addEventListener('mouseleave', () => { p.setAttribute('opacity', .26); });
      bindTip(p, () => `<div class="tt-h">${l.s} → ${l.t}</div>
        <div class="tt-r"><span>金额</span><b>${FMT.yuan(l.v)}</b></div>
        <div class="tt-r"><span>占总额</span><b>${FMT.pct(l.v / total)}</b></div>`);
    }

    // 节点 + 标签
    L.forEach(k => {
      const p = lPos.get(k);
      svgEl('rect', { x: xL - nodeW, y: p.y, width: nodeW, height: Math.max(2, p.h), rx: 3, fill: colorOf.get(k) }, s);
      const cy = p.y + p.h / 2;
      svgEl('text', {
        x: xL - nodeW - 9, y: cy + (p.h >= 26 ? -2 : 4), 'text-anchor': 'end',
        fill: cssVar('--t2'), 'font-size': 11.5, 'font-weight': 500
      }, s).textContent = k.length > 19 ? k.slice(0, 18) + '…' : k;
      if (p.h >= 26) {
        svgEl('text', {
          x: xL - nodeW - 9, y: cy + 14, 'text-anchor': 'end',
          fill: cssVar('--t4'), 'font-size': 9.5
        }, s).textContent = FMT.yuan(lTot.get(k) || 0);
      }
    });
    R.forEach(k => {
      const p = rPos.get(k);
      svgEl('rect', { x: xR, y: p.y, width: nodeW, height: Math.max(2, p.h), rx: 3, fill: cssVar('--t3') }, s);
      const cy = p.y + p.h / 2;
      svgEl('text', {
        x: xR + nodeW + 9, y: cy + (p.h >= 26 ? -2 : 4), fill: cssVar('--t1'),
        'font-size': 11.5, 'font-weight': 500
      }, s).textContent = k;
      if (p.h >= 26) {
        svgEl('text', {
          x: xR + nodeW + 9, y: cy + 14, fill: cssVar('--t4'), 'font-size': 9.5
        }, s).textContent = FMT.yuan(rTot.get(k) || 0) + ' · ' + FMT.pct((rTot.get(k) || 0) / total, 0);
      }
    });
    return s;
  }

  /* ---------------- 3. 横向条形（项目榜） ---------------- */
  function hbars(host, rows, opts) {
    opts = opts || {};
    const W = host.clientWidth || 800;
    const rowH = opts.rowH || 34;
    const H = rows.length * rowH + 8;
    const s = mkSvg(host, W, H);
    const maxV = Math.max.apply(null, rows.map(r => r.v)) || 1;
    const logScale = opts.scale === 'log';
    const frac = v => {
      if (!logScale) return Math.max(0, v) / maxV;
      const t = Math.log10(1 + Math.max(0, v)) / Math.log10(1 + maxV);
      return 0.07 + 0.93 * Math.sqrt(t);
    };
    const labelW = opts.labelW || Math.min(220, W * .3);
    const valW = 92;
    const trackX = labelW + 8;
    const trackW = Math.max(40, W - trackX - valW);

    rows.forEach((r, i) => {
      const y = i * rowH;
      const g = svgEl('g', { style: 'cursor:pointer' }, s);
      svgEl('rect', { x: 0, y: y + 2, width: W, height: rowH - 4, rx: 7, fill: 'transparent', class: 'hb-hit' }, g);
      // 名称（有副标题时上移，副标题放下面一行）
      const t = svgEl('text', {
        x: 0, y: y + rowH / 2 + (r.sub ? -1 : 4), fill: cssVar('--t1'), 'font-size': 11.5, 'font-weight': 500
      }, g);
      t.textContent = r.k.length > 18 ? r.k.slice(0, 17) + '…' : r.k;
      if (r.sub) {
        svgEl('text', {
          x: 0, y: y + rowH / 2 + 12, fill: cssVar('--t4'), 'font-size': 9.5
        }, g).textContent = r.sub;
      }
      // 轨道
      svgEl('rect', { x: trackX, y: y + rowH / 2 - 5, width: trackW, height: 10, rx: 5, fill: cssVar('--line') }, g);
      const w = Math.max(3, frac(r.v) * trackW);
      const bar = svgEl('rect', {
        x: trackX, y: y + rowH / 2 - 5, width: 0, height: 10, rx: 5,
        fill: r.c || cssVar('--teal')
      }, g);
      requestAnimationFrame(() => { bar.setAttribute('width', w); bar.style.transition = 'width .7s cubic-bezier(.2,.7,.3,1)'; });
      // 值
      svgEl('text', {
        x: W, y: y + rowH / 2 + 4, 'text-anchor': 'end', fill: cssVar('--t1'), 'font-size': 11.5, 'font-weight': 600
      }, g).textContent = r.vText || FMT.yuan(r.v);
      if (opts.onClick) {
        g.addEventListener('click', () => opts.onClick(r));
      }
      if (r.tip) bindTip(g, r.tip);
    });
    return s;
  }

  /* ---------------- 4. 四象限散点 ---------------- */
  function scatter(host, pts, opts) {
    opts = opts || {};
    const W = host.clientWidth || 900;
    const H = opts.height || 420;
    const m = { l: 62, r: 24, t: 20, b: 44 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const s = mkSvg(host, W, H);

    const xs = pts.map(p => Math.max(1e-4, p.x));
    const ys = pts.map(p => Math.max(1, p.y));
    const x0 = Math.log10(Math.min.apply(null, xs)) - .15;
    const x1 = Math.log10(Math.max.apply(null, xs)) + .15;
    const y0 = Math.log10(Math.min.apply(null, ys)) - .15;
    const y1 = Math.log10(Math.max.apply(null, ys)) + .15;
    const sx = v => m.l + (Math.log10(Math.max(1e-4, v)) - x0) / (x1 - x0) * iw;
    const sy = v => m.t + ih - (Math.log10(Math.max(1, v)) - y0) / (y1 - y0) * ih;

    // 网格
    const gGrid = svgEl('g', {}, s);
    for (let e = Math.ceil(x0); e <= Math.floor(x1); e++) {
      const x = m.l + (e - x0) / (x1 - x0) * iw;
      svgEl('line', { x1: x, x2: x, y1: m.t, y2: m.t + ih, stroke: cssVar('--line'), 'stroke-dasharray': '2 4' }, gGrid);
      svgEl('text', {
        x, y: m.t + ih + 16, 'text-anchor': 'middle', fill: cssVar('--t4'), 'font-size': 10
      }, gGrid).textContent = '¥' + (Math.pow(10, e) >= 1 ? Math.pow(10, e).toFixed(0) : Math.pow(10, e).toFixed(Math.min(4, -e)));
    }
    for (let e = Math.ceil(y0); e <= Math.floor(y1); e++) {
      const y = m.t + ih - (e - y0) / (y1 - y0) * ih;
      svgEl('line', { x1: m.l, x2: m.l + iw, y1: y, y2: y, stroke: cssVar('--line'), 'stroke-dasharray': '2 4' }, gGrid);
      svgEl('text', {
        x: m.l - 9, y: y + 3.5, 'text-anchor': 'end', fill: cssVar('--t4'), 'font-size': 10
      }, gGrid).textContent = FMT.num(Math.pow(10, e));
    }
    // 轴标题
    svgEl('text', { x: m.l + iw, y: H - 6, 'text-anchor': 'end', fill: cssVar('--t3'), 'font-size': 10.5 }, s).textContent = '花费（对数）';
    svgEl('text', { x: 4, y: m.t + 4, fill: cssVar('--t3'), 'font-size': 10.5 }, s).textContent = '有效产出（字符）';

    // 参考线：中位数
    const med = arr => { const a = arr.slice().sort((p, q) => p - q); return a[Math.floor(a.length / 2)]; };
    const mx = sx(med(xs)), my = sy(med(ys));
    svgEl('line', { x1: mx, x2: mx, y1: m.t, y2: m.t + ih, stroke: cssVar('--line2'), 'stroke-dasharray': '4 4' }, s);
    svgEl('line', { x1: m.l, x2: m.l + iw, y1: my, y2: my, stroke: cssVar('--line2'), 'stroke-dasharray': '4 4' }, s);

    // 象限标注（x=花费，y=产出）
    const ql = [
      { x: m.l + iw - 10, y: m.t + 16, t: '明星 · 花得多也产出多', a: 'end', c: cssVar('--teal') },
      { x: m.l + iw - 10, y: m.t + ih - 10, t: '黑洞 · 花得多产出少', a: 'end', c: cssVar('--rose') },
      { x: m.l + 10, y: m.t + 16, t: '捡漏 · 花得少产出多', a: 'start', c: cssVar('--teal') },
      { x: m.l + 10, y: m.t + ih - 10, t: '轻活 · 花得少产出少', a: 'start', c: cssVar('--t4') },
    ];
    ql.forEach(q => {
      svgEl('text', { x: q.x, y: q.y, 'text-anchor': q.a, fill: q.c, 'font-size': 9.5, opacity: .75 }, s).textContent = q.t;
    });

    // 点
    const gP = svgEl('g', {}, s);
    const rMax = 17;
    pts.forEach(p => {
      const r = 5 + (p.v / 100) * (rMax - 5);
      const c = svgEl('circle', {
        cx: sx(p.x), cy: sy(p.y), r,
        fill: p.c, opacity: .5, stroke: p.c, 'stroke-width': 1,
        style: 'cursor:pointer;transition:opacity .15s,r .15s'
      }, gP);
      c.addEventListener('mouseenter', () => { c.setAttribute('opacity', .95); c.setAttribute('r', r + 3); });
      c.addEventListener('mouseleave', () => { c.setAttribute('opacity', .5); c.setAttribute('r', r); });
      bindTip(c, () => p.tip);
      if (opts.onClick) c.addEventListener('click', () => opts.onClick(p));
      p._el = c;
    });
    // 标签：最大价值前 3
    const tops = pts.slice().sort((a, b) => b.v - a.v).slice(0, 3);
    tops.forEach(p => {
      svgEl('text', {
        x: sx(p.x), y: sy(p.y) - (6 + p.v / 100 * 12), 'text-anchor': 'middle',
        fill: cssVar('--t2'), 'font-size': 9.5, 'pointer-events': 'none'
      }, s).textContent = p.label;
    });
    return s;
  }

  /* ---------------- 5. 24 小时柱状 ---------------- */
  function hourBars(host, vals, opts) {
    opts = opts || {};
    const W = host.clientWidth || 600, H = 96;
    const s = mkSvg(host, W, H);
    const m = { l: 2, r: 2, t: 14, b: 18 };
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    const max = Math.max.apply(null, vals) || 1;
    const bw = iw / 24;
    const cAcc = cssVar('--teal');
    vals.forEach((v, i) => {
      const h = Math.max(1, v / max * ih);
      const x = m.l + i * bw + bw * .12, w = bw * .76;
      const g = svgEl('g', {}, s);
      svgEl('rect', { x, y: m.t + ih - h, width: w, height: h, rx: Math.min(2, w / 2), fill: cAcc, opacity: .28 + .72 * (v / max) }, g);
      bindTip(g, () => `<div class="tt-h">${i}:00 – ${i}:59</div><div class="tt-r"><span>消费</span><b>${FMT.yuan(v)}</b></div>`);
      if (i % 3 === 0) {
        svgEl('text', { x: m.l + i * bw + bw / 2, y: H - 6, 'text-anchor': 'middle', fill: cssVar('--t4'), 'font-size': 9 }, s).textContent = i;
      }
    });
    svgEl('text', { x: 0, y: 9, fill: cssVar('--t3'), 'font-size': 10 }, s).textContent = opts.title || '';
    return s;
  }

  /* ---------------- 6. 迷你甜甜圈（模型占比） ---------------- */
  function donut(host, items, opts) {
    opts = opts || {};
    const W = host.clientWidth || 260, H = opts.height || 200;
    const s = mkSvg(host, W, H);
    const R = Math.min(W, H) / 2 - 10, r = R * .62;
    const cx = W / 2, cy = H / 2;
    const total = items.reduce((a, i) => a + i.v, 0) || 1;
    let a0 = -Math.PI / 2;
    items.forEach(it => {
      const a1 = a0 + it.v / total * Math.PI * 2;
      const large = (a1 - a0) > Math.PI ? 1 : 0;
      const p = (rad, ang) => [cx + rad * Math.cos(ang), cy + rad * Math.sin(ang)];
      const [x0, y0] = p(R, a0), [x1, y1] = p(R, a1), [x2, y2] = p(r, a1), [x3, y3] = p(r, a0);
      const d = `M${x0},${y0} A${R},${R} 0 ${large} 1 ${x1},${y1} L${x2},${y2} A${r},${r} 0 ${large} 0 ${x3},${y3} Z`;
      const path = svgEl('path', { d, fill: it.c, opacity: .85, style: 'cursor:default' }, s);
      path.addEventListener('mouseenter', () => path.setAttribute('opacity', 1));
      path.addEventListener('mouseleave', () => path.setAttribute('opacity', .85));
      bindTip(path, () => `<div class="tt-h">${it.k}</div><div class="tt-r"><span>金额</span><b>${FMT.yuan(it.v)}</b></div><div class="tt-r"><span>占比</span><b>${FMT.pct(it.v / total)}</b></div>`);
      a0 = a1;
    });
    if (opts.center) {
      svgEl('text', { x: cx, y: cy - 2, 'text-anchor': 'middle', fill: cssVar('--t1'), 'font-size': 17, 'font-weight': 650 }, s).textContent = opts.center;
      if (opts.centerSub) svgEl('text', { x: cx, y: cy + 15, 'text-anchor': 'middle', fill: cssVar('--t4'), 'font-size': 9.5 }, s).textContent = opts.centerSub;
    }
    return s;
  }

  /* ---------------- 7. 折线（日趋势） ---------------- */
  function line(host, pts, opts) {
    opts = opts || {};
    const W = host.clientWidth || 800, H = opts.height || 140;
    const m = { l: 44, r: 14, t: 12, b: 22 };
    const s = mkSvg(host, W, H);
    const iw = W - m.l - m.r, ih = H - m.t - m.b;
    if (pts.length < 2) return s;
    const max = Math.max.apply(null, pts.map(p => p.v)) || 1;
    const sx = i => m.l + (i / (pts.length - 1)) * iw;
    const sy = v => m.t + ih - (v / max) * ih;
    let d = '', area = `M${m.l},${m.t + ih}`;
    pts.forEach((p, i) => {
      const X = sx(i), Y = sy(p.v);
      d += (i ? 'L' : 'M') + X + ',' + Y;
      area += `L${X},${Y}`;
    });
    area += `L${sx(pts.length - 1)},${m.t + ih}Z`;
    const gid = 'lg' + Math.random().toString(36).slice(2, 7);
    const defs = svgEl('defs', {}, s);
    const gr = svgEl('linearGradient', { id: gid, x1: 0, y1: 0, x2: 0, y2: 1 }, defs);
    svgEl('stop', { offset: '0%', 'stop-color': opts.color || cssVar('--teal'), 'stop-opacity': .3 }, gr);
    svgEl('stop', { offset: '100%', 'stop-color': opts.color || cssVar('--teal'), 'stop-opacity': 0 }, gr);
    svgEl('path', { d: area, fill: `url(#${gid})` }, s);
    svgEl('path', { d, fill: 'none', stroke: opts.color || cssVar('--teal'), 'stroke-width': 1.6, 'stroke-linejoin': 'round' }, s);
    svgEl('text', { x: m.l - 6, y: m.t + 4, 'text-anchor': 'end', fill: cssVar('--t4'), 'font-size': 9 }, s).textContent = FMT.num(max);
    svgEl('text', { x: m.l - 6, y: m.t + ih, 'text-anchor': 'end', fill: cssVar('--t4'), 'font-size': 9 }, s).textContent = '0';
    svgEl('text', { x: m.l, y: H - 5, fill: cssVar('--t4'), 'font-size': 9 }, s).textContent = pts[0].k;
    svgEl('text', { x: W - m.r, y: H - 5, 'text-anchor': 'end', fill: cssVar('--t4'), 'font-size': 9 }, s).textContent = pts[pts.length - 1].k;
    return s;
  }

  root.CH = { costSplit, costLegend, sankey, hbars, scatter, hourBars, donut, line, showTip, hideTip, bindTip, cssVar };
  root.FMT = FMT;
})(typeof window !== 'undefined' ? window : globalThis);
