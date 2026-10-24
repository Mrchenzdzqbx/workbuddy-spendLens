// 边界检查：筛选、空数据、单模型、时间窗
const fs = require('fs'), path = require('path'), os = require('os');
const SL = require('../src/core.js');
const ROOT = path.join(os.homedir(), '.workbuddy', 'projects');
function walk(d, o) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (e.name.endsWith('.jsonl')) o.push(p); } return o; }
const files = walk(ROOT, []).map(p => ({ path: path.relative(ROOT, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));
const RAW = SL.parseLogs(files);

function bad(v, tag) { if (v == null || (typeof v === 'number' && !isFinite(v))) console.log('  !! NaN/undefined:', tag, v); }
function audit(A, label) {
  const T = A.T;
  console.log(`\n[${label}] sess=${A.sess.length} req=${T.reqs} credit=${T.credit.toFixed(2)} ¥${T.yuan.toFixed(2)} chars=${T.chars} perK=${T.perKChar}`);
  bad(T.credit, 'T.credit'); bad(T.yuan, 'T.yuan'); bad(T.cacheRate, 'cacheRate');
  for (const s of A.sess) {
    bad(s.credit, 's.credit'); bad(s.chars, 's.chars'); bad(s.value, 's.value');
    bad(s.D, 'D'); bad(s.E, 'E'); bad(s.H, 'H');
  }
  const sumS = A.sess.reduce((a, s) => a + s.credit, 0);
  const sumM = A.byModel.reduce((a, m) => a + m.credit, 0);
  const sumT = A.byTool.reduce((a, m) => a + m.credit, 0);
  const sumA = A.byArch.reduce((a, m) => a + m.credit, 0);
  console.log(`  对账 session=${sumS.toFixed(2)} model=${sumM.toFixed(2)} tool=${sumT.toFixed(2)} arch=${sumA.toFixed(2)} T=${T.credit.toFixed(2)}`);
  const last = A.days[A.days.length - 1];
  console.log(`  days=${A.days.length} lastDay=${last && last.d}  pricing=${A.pricing.filter(p => p.pm != null).length}/${A.pricing.length}`);
  const adv = SL.advise(A), rx = SL.prescribe(A);
  console.log(`  adv=${adv.length} rx=${rx.length} rxSum=¥${rx.reduce((a, f) => a + (f.est || 0), 0).toFixed(2)}`);
  for (const a of adv) {
    bad(a.saveSelYuan, 'saveSelYuan');
    if (a.best) bad(a.best.selYuan, 'best.selYuan');
  }
  // 反事实
  if (A.sess[0] && A.pricing.length > 1) {
    const cf = SL.counterfactual(A.sess[0], A.pricing, A.pricing[1].m);
    const cs = SL.counterfactualSelective(A.sess[0], A.pricing, A.pricing[1].m);
    console.log(`  cf全量=${cf ? cf.yuan.toFixed(2) : 'null'} cf下沉=${cs ? cs.yuan.toFixed(2) : 'null'} switched=${cs && cs.switched}`);
  }
}

audit(SL.aggregate(RAW, {}), '全部');
audit(SL.aggregate(RAW, { models: new Set([0]) }), '只模型0');
audit(SL.aggregate(RAW, { models: new Set([3]) }), '只模型3(最贵)');
audit(SL.aggregate(RAW, { ws: new Set([0]) }), '只项目0');
const max = RAW.range.max;
audit(SL.aggregate(RAW, { from: max - 3 * 864e5, to: max }), '近3天');
audit(SL.aggregate(RAW, { from: 0, to: 1 }), '空区间');
