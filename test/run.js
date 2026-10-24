// Node 端验证：用真实日志跑 core.js，与 Python 探针数字对账
const fs = require('fs');
const path = require('path');
const os = require('os');
const SL = require('../src/core.js');

const ROOT = path.join(os.homedir(), '.workbuddy', 'projects');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const t0 = Date.now();
const abs = walk(ROOT, []);
const files = abs.map(p => ({ path: path.relative(ROOT, p), text: fs.readFileSync(p, 'utf8') }));
console.log('files', files.length, 'read in', Date.now() - t0, 'ms');

const t1 = Date.now();
const RAW = SL.parseLogs(files);
console.log('parsed in', Date.now() - t1, 'ms');
console.log('sessions', RAW.sessions.length, 'models', RAW.models, 'ws', RAW.ws.map(w => w.label));
console.log('lines', RAW.lineCount, 'bad', RAW.badLines);

const AGG = SL.aggregate(RAW, {});
const T = AGG.T;
console.log('\n=== 总量 ===');
console.log('credit', T.credit.toFixed(2), '¥', T.yuan.toFixed(2));
console.log('in', SL.fmtInt(T.in), 'hit', SL.fmtInt(T.hit), 'out', SL.fmtInt(T.out), 'cache', (T.cacheRate * 100).toFixed(2) + '%');
console.log('reqs', T.reqs, 'chars', T.chars, '¥/千字', T.perKChar?.toFixed(4));
console.log('fails', T.fails, 'failCredit', T.failCredit.toFixed(2), 'dupReads', T.dupReads);
console.log('cacheSaving ¥', T.cacheSaving.toFixed(2));

console.log('\n=== 定价反解 ===');
for (const p of AGG.pricing) {
  console.log(`${p.name.padEnd(20)} n=${String(p.n).padEnd(6)} ${p.src} R2=${p.r2.toFixed(4)}  pm=${p.pm?.toFixed(1)} ph=${p.ph?.toFixed(2)} po=${p.po?.toFixed(0)}  积分/千输出=¥${p.yuanPerMOut?.toFixed(2)}/M`);
}

console.log('\n=== 模型直接汇总 ===');
for (const m of AGG.byModel) {
  console.log(`${RAW.models[m.m].padEnd(20)} req=${String(m.reqs).padEnd(6)} credit=${m.credit.toFixed(1).padStart(8)} chars=${Math.round(m.chars)}`);
}

console.log('\n=== 工作空间 ===');
for (const w of AGG.byWs) console.log(`  ${w.label.padEnd(34)} ¥${w.credit * 0.05 + ''}`.replace(/(\d+\.\d\d)\d+/, '$1'), 'credit', w.credit.toFixed(1), 'sess', w.sess.length);

console.log('\n=== 会话 TOP10（按积分）===');
const sorted = [...AGG.sess].sort((a, b) => b.credit - a.credit).slice(0, 10);
for (const s of sorted) {
  console.log(`¥${s.yuan.toFixed(2).padStart(7)} ${String(s.reqs).padStart(5)}req ${String(Math.round(s.chars)).padStart(7)}字 (${s.perK ? (s.credit / (s.chars / 1000)).toFixed(2) : '—'}/千字) D${s.D.toFixed(0)} E${s.E.toFixed(0)}${s.eNa ? '*' : ''} H${s.H.toFixed(0)} V${s.value.toFixed(1)} [${s.arch}] ${s.title.slice(0, 26)}`);
}

console.log('\n=== 原型分布 ===');
for (const a of AGG.byArch) console.log(`  ${a.arch.padEnd(12)} n=${String(a.n).padStart(2)} req=${String(a.reqs).padStart(5)} credit=${a.credit.toFixed(0).padStart(6)} chars=${Math.round(a.chars)}`);

console.log('\n=== 顾问 ===');
for (const a of SL.advise(AGG)) {
  console.log(`[${a.arch}] conf=${a.conf} 当前¥${(a.credit * 0.05).toFixed(2)} 下沉省¥${a.saveSelYuan.toFixed(2)} (${(a.pctSel * 100).toFixed(0)}%) 全量省¥${a.saveFullYuan.toFixed(2)} best=${a.best ? a.best.name : '—'}`);
  for (const c of a.cands) console.log(`      ${c.name.padEnd(20)} 全量¥${c.fullYuan.toFixed(2).padStart(7)} 下沉¥${c.selYuan.toFixed(2).padStart(7)} 实测${String(c.obsReqs).padStart(5)}次 ${c.eligible ? '' : '(待验证)'} ${c.src}`);
}

console.log('\n=== 处方 ===');
for (const f of SL.prescribe(AGG)) console.log(`  [${f.level}/${f.tag}] ${f.title}  est=¥${f.est.toFixed(2)}`);
