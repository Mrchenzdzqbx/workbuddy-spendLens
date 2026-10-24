# -*- coding: utf-8 -*-
"""SpendLens 构建脚本

用法：
    python build.py            # 生成正式版 + 脱敏演示版
    python build.py --no-demo  # 只生成正式版

产物：
    out/SpendLens.html                 单文件离线版（打开后接入本机日志）
    out/SpendLens-脱敏演示版.html       内嵌脱敏快照，双击即看，可直接投稿/分享
"""
import json, os, re, sys, subprocess, hashlib, argparse, datetime

HERE = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(HERE, 'src')
OUT = os.path.join(HERE, 'out')
TOOLS = os.path.join(HERE, 'tools')

# 使用 PATH 中的 Node，不写入任何本机用户名或绝对路径。
NODE_CANDIDATES = ['node']

# ---------------------------------------------------------------- 脱敏映射
# 工作区默认按序号中性化。需要自定义时可在本地维护映射，但不要提交真实名称。
WS_MAP = {}

# 会话标题一律重写为「会话 NN · 任务原型」，不带任何内容线索。
# 任务原型由工具调用构成推导（Write/Edit/Read/Agent 的比例），属行为元数据，不含内容。

# 可选的私人敏感词表放在 tools/sensitive.txt（已被 .gitignore 排除），每行一个。
# 词表本身也可能泄露隐私，因此公开仓库不内置任何真实姓名、项目名或路径。
SENSITIVE_FILE = os.path.join(TOOLS, 'sensitive.txt')
SENSITIVE = []
if os.path.exists(SENSITIVE_FILE):
    with open(SENSITIVE_FILE, encoding='utf-8') as f:
        SENSITIVE = [line.strip() for line in f if line.strip() and not line.startswith('#')]


def find_node():
    for c in NODE_CANDIDATES:
        try:
            subprocess.run([c, '-v'], capture_output=True, check=True)
            return c
        except Exception:
            continue
    raise SystemExit('找不到 node，无法导出数据')


def read(name):
    with open(os.path.join(SRC, name), encoding='utf-8') as f:
        return f.read()


def build_html(data_js=None, demo=False):
    html = read('index.html')
    css = read('style.css')
    core = read('core.js')
    charts = read('charts.js')
    ui = read('ui.js')
    boot = read('boot.js')

    html = html.replace('/*__CSS__*/', css)
    html = html.replace('/*__CORE__*/', core)
    html = html.replace('/*__CHARTS__*/', charts)
    html = html.replace('/*__UI__*/', ui)

    if data_js is not None:
        payload = 'window.__SPENDLENS_DEMO__ = ' + data_js + ';\n'
        boot = payload + boot
        html = html.replace('<title>workbuddy-spendLens · 我帮你省钱</title>',
                            '<title>workbuddy-spendLens · 我帮你省钱（脱敏演示版）</title>')
        badge = ('<div style="position:fixed;right:14px;bottom:14px;z-index:50;font-size:10.5px;'
                 'color:#a78bfa;border:1px solid rgba(167,139,250,.34);background:rgba(167,139,250,.1);'
                 'padding:5px 10px;border-radius:999px;backdrop-filter:blur(8px)">'
                 '脱敏演示数据 · 标题/文件名/项目名已中性化</div>')
        html = html.replace('</body>', badge + '\n</body>')
    html = html.replace('/*__BOOT__*/', boot)
    return html


# ---------------------------------------------------------------- 脱敏
def anonymize(raw):
    d = json.loads(json.dumps(raw))  # deep copy

    # 工作空间
    for i, w in enumerate(d.get('ws', [])):
        lab = w.get('label', '')
        w['label'] = WS_MAP.get(lab, '临时工作区 %02d' % (i + 1))
        w['folder'] = w['label']

    # 文件名稳定映射
    fmap = {}
    counter = [0]

    def anon_file(name):
        if not name:
            return name
        if name in fmap:
            return fmap[name]
        counter[0] += 1
        m = re.search(r'(\.[A-Za-z0-9]{1,6})$', name)
        ext = m.group(1) if m else ''
        new = '文件-%02d%s' % (counter[0], ext)
        fmap[name] = new
        return new

    # 会话：标题一律中性化，只保留序号与任务原型
    for idx, s in enumerate(d.get('sessions', [])):
        arch = s.get('arch') or '会话'
        s['title'] = '会话 %02d · %s' % (idx + 1, arch)
        s['titleSrc'] = 'gen'
        # 会话 ID 稳定哈希
        s['id'] = hashlib.md5(str(s.get('id', idx)).encode()).hexdigest()[:8]
        # 文件名
        s['filesNew'] = [anon_file(x) for x in s.get('filesNew', [])]
        s['filesEdit'] = [anon_file(x) for x in s.get('filesEdit', [])]
        s['fileEdits'] = [[anon_file(k), v] for k, v in s.get('fileEdits', [])]
        s['fileReads'] = [[anon_file(k), v] for k, v in s.get('fileReads', [])]
        if s.get('worstRead'):
            s['worstRead'] = anon_file(s['worstRead'])
        # 子代理名
        amap = {}
        for k, v in s.get('agents', []):
            if k == 'cli':
                amap[k] = k
            else:
                amap.setdefault(k, '子代理-%02d' % (len([x for x in amap if x != 'cli']) + 1))
        s['agents'] = [[amap[k], v] for k, v in s.get('agents', [])]
        for r in s.get('rq', []):
            if len(r) > 8 and r[8]:
                r[8] = amap.get(r[8], '子代理')
    return d


def snapshot_demo(raw):
    """跑一遍 node 导出真实数据（含 subagent 汇总），再脱敏"""
    node = find_node()
    raw_path = os.path.join(TOOLS, 'raw.json')
    r = subprocess.run([node, os.path.join(TOOLS, 'dump.js'), raw_path],
                       capture_output=True, text=True, encoding='utf-8')
    if r.returncode != 0:
        raise SystemExit('导出失败:\n' + (r.stderr or '')[:2000])
    with open(raw_path, encoding='utf-8') as f:
        data = json.load(f)
    return anonymize(data)


def check_clean(html, label):
    hits = [w for w in SENSITIVE if w in html]
    # 即使未配置私人词表，也拦截常见个人磁盘路径。
    path_patterns = {
        'Windows 用户路径': r'[A-Za-z]:[\\/]+Users[\\/]+[^\\/\s<>"\']+',
        'macOS 用户路径': r'/Users/[^/\s<>"\']+',
        'Linux 用户路径': r'/home/[^/\s<>"\']+',
    }
    path_hits = [name for name, pat in path_patterns.items() if re.search(pat, html)]
    if hits or path_hits:
        print('!! [%s] 产物里仍出现敏感串或路径: %s' %
              (label, ', '.join(sorted(set(hits + path_hits)))))
        return False
    print('   [%s] 脱敏校验通过：%d 个自定义敏感词及个人路径检查均未命中' %
          (label, len(SENSITIVE)))
    return True


def check_titles(demo):
    """会话标题必须全部是中性的「会话 NN · 任务原型」，一个都不许带内容线索"""
    bad = []
    for s in demo.get('sessions', []):
        t = s.get('title') or ''
        if not re.match(r'^会话 \d{2,3} · \S+$', t):
            bad.append(t)
    if bad:
        print('!! 有 %d 个会话标题未中性化，例如: %s' % (len(bad), bad[:3]))
        return False
    # 顺带检查文件名是否都是 文件-NN.ext
    badf = []
    PAT_F = re.compile(r'^文件-\d{2,3}(\.[A-Za-z0-9]{1,6})?$')
    for s in demo.get('sessions', []):
        files = list((s.get('filesNew') or []) + (s.get('filesEdit') or []))
        files += [k for k, v in (s.get('fileEdits') or []) + (s.get('fileReads') or [])]
        for f in files:
            if not PAT_F.match(f):
                badf.append(f)
        if s.get('worstRead') and not PAT_F.match(s['worstRead']):
            badf.append(s['worstRead'])
    if badf:
        print('!! 有 %d 个文件名未脱敏，例如: %s' % (len(badf), badf[:3]))
        return False
    print('   [脱敏演示版] 结构校验通过：%d 个会话标题、文件名全部中性化' % len(demo.get('sessions', [])))
    return True


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--no-demo', action='store_true')
    args = ap.parse_args()

    os.makedirs(OUT, exist_ok=True)

    # 1) 正式版
    html = build_html()
    p1 = os.path.join(OUT, 'workbuddy-spendLens.html')
    with open(p1, 'w', encoding='utf-8') as f:
        f.write(html)
    print('written:', p1, '(%.1f KB)' % (os.path.getsize(p1) / 1024))

    ok = True
    # 2) 脱敏演示版
    if not args.no_demo:
        demo = snapshot_demo(None)
        ok = check_titles(demo) and ok
        js = json.dumps(demo, ensure_ascii=False, separators=(',', ':'))
        html2 = build_html(data_js=js, demo=True)
        p2 = os.path.join(OUT, 'workbuddy-spendLens-脱敏演示版.html')
        with open(p2, 'w', encoding='utf-8') as f:
            f.write(html2)
        print('written:', p2, '(%.2f MB)' % (os.path.getsize(p2) / 1e6))
        ok = check_clean(html2, '脱敏演示版') and ok

    if not ok:
        print('\n!! 脱敏校验未通过，产物不可对外发布')
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
