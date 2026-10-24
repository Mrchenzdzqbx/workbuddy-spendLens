// 把本机真实日志解析成可序列化 RAW，供脱敏构建使用
const fs = require('fs');
const path = require('path');
const os = require('os');
const SL = require('../src/core.js');

const ROOT = path.join(os.homedir(), '.workbuddy', 'projects');
const OUT = process.argv[2] || path.join(__dirname, 'raw.json');

function walk(dir, out) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out);
    else if (e.name.endsWith('.jsonl')) out.push(p);
  }
  return out;
}

const abs = walk(ROOT, []);
const files = abs.map(p => ({ path: path.relative(ROOT, p).split(path.sep).join('/'), text: fs.readFileSync(p, 'utf8') }));
const RAW = SL.parseLogs(files);
const J = SL.serializeRAW(RAW);
fs.writeFileSync(OUT, JSON.stringify(J));
console.log('dumped', OUT, (fs.statSync(OUT).size / 1e6).toFixed(2) + 'MB',
  'sessions', J.sessions.length, 'models', J.models.length);
console.log('\n-- 会话标题清单 --');
J.sessions.slice().sort((a, b) => b.credit - a.credit).forEach((s, i) => {
  console.log(String(i).padStart(2), '|', (s.credit * 0.05).toFixed(2).padStart(7), '|', s.arch, '|', s.title);
});
