const fs = require('fs'), path = require('path'), os = require('os');
const SL = require('../src/core.js');
const ROOT = path.join(os.homedir(), '.workbuddy', 'projects');
function walk(d, o) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) walk(p, o); else if (e.name.endsWith('.jsonl')) o.push(p); } return o; }
const files = walk(ROOT, []).map(p => ({ path: path.relative(ROOT, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));
const RAW = SL.parseLogs(files);
console.log('range', new Date(RAW.range.min).toISOString(), '→', new Date(RAW.range.max).toISOString());
console.log('first session st', RAW.sessions[0].st, new Date(RAW.sessions[0].st).toISOString());
const A = SL.aggregate(RAW, {});
const sumTool = A.byTool.reduce((a, t) => a + t.credit, 0);
const sumModel = A.byModel.reduce((a, m) => a + m.credit, 0);
const sumSess = A.sess.reduce((a, s) => a + s.credit, 0);
console.log('T.credit', A.T.credit.toFixed(2), 'sumTool', sumTool.toFixed(2), 'sumModel', sumModel.toFixed(2), 'sumSess', sumSess.toFixed(2));
console.log('byTool:'); A.byTool.forEach(t => console.log('  ', t.f, t.credit.toFixed(1), (t.credit * 0.05).toFixed(2), t.reqs));
console.log('costSplit', A.T.costSplit, 'yuan', A.T.yuan.toFixed(2));
