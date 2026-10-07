/**
 * 首次运行（全新机器）体验自检。
 *
 * 目的：验证「把目录复制到另一台笔记本 → 装好 Node.js → 启动」这条路径上没有暗坑。
 * 因此这里刻意制造一个**干净环境**：
 *   - 一个全新的空数据目录（没有 config.json / state.json）
 *   - 清空所有 MAILBOT_* / DEEPSEEK_* / GOOGLE_* 环境变量（模拟机器上什么都没有）
 *   - 禁止读取本机 .env
 *
 * 检查点：能启动、静态资源齐全、空状态下不崩、未配置时给出可执行的中文指引、
 * 填完配置能落盘到 data/config.json。
 *
 *   node test/fresh-install.js
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTempDir } from './lib/tmp.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');

/* ------------------------------------------------------------ 干净环境 */

const freshDir = makeTempDir('mailbot-fresh-');
for (const key of Object.keys(process.env)) {
  if (/^(MAILBOT_|DEEPSEEK_|GOOGLE_)/.test(key)) delete process.env[key];
}
process.env.MAILBOT_DATA_DIR = freshDir;
process.env.MAILBOT_NO_DOTENV = '1';
process.env.MAILBOT_LOG_LEVEL = 'error';

const { startServer } = await import('../server/index.js');
const { loadConfig, getConfig, resetConfigCache } = await import('../server/config/index.js');
const { runStart } = await import('../server/lib/startup.js');

/* ------------------------------------------------------------ 断言 */

let passed = 0;
const failures = [];
async function test(name, fn) {
  try {
    const detail = await fn();
    passed += 1;
    console.log(`  ✓ ${name}${detail ? ` — ${detail}` : ''}`);
  } catch (err) {
    /*
     * 把底层 `cause` 也打出来。
     *
     * `fetch` 抛出的信息就是一句 "fetch failed"，真正的原因（ECONNREFUSED / 端口没起来 /
     * 沙箱拦截……）全在 `err.cause` 里。只打印 message 等于把线索丢掉，
     * 排查的人只能靠猜——这个坑我踩过一次，不留第二次。
     */
    const cause = err?.cause ? ` ← ${err.cause.code || err.cause.name || ''} ${err.cause.message || err.cause}` : '';
    failures.push({ name, message: (err?.stack || String(err)) + cause });
    console.log(`  ✗ ${name}\n      ${err?.message || err}${cause}`);
  }
}
function assert(cond, msg) {
  if (!cond) throw new Error(msg || '断言失败');
}
function assertEqual(actual, expected, msg) {
  if (actual !== expected) throw new Error(`${msg || '值不相等'}：期望 ${JSON.stringify(expected)}，实际 ${JSON.stringify(actual)}`);
}
function assertIncludes(hay, needle, msg) {
  if (!String(hay).includes(needle)) {
    throw new Error(`${msg || '未包含'}：期望包含 ${JSON.stringify(needle)}，实际 ${JSON.stringify(String(hay).slice(0, 300))}`);
  }
}

/**
 * 直接调用一键启动模块的 --check 路径并收集输出。
 *
 * 刻意**不**通过子进程执行 `node cli.js start --check`：抓取子进程输出在受限环境下会被拒绝，
 * 而且这里要验证的是逻辑本身，进程内调用更直接、更快，也不依赖 PATH。
 */
async function runStartCheck() {
  const lines = [];
  const result = await runStart({
    rootDir: root,
    control: { check: true },
    log: (s = '') => lines.push(String(s)),
    startServer: async () => ({ url: 'http://127.0.0.1:0' }),
    open: () => {},
  });
  assert(result.started === false, '--check 不应真的启动服务');
  return lines.join('\n');
}

/* ------------------------------------------------------------ 启动 */

console.log('\n首次运行（全新机器）体验自检\n');
console.log(`  数据目录：${freshDir}\n`);

loadConfig({ rootDir: root, force: true });
const { server, url } = await startServer({ rootDir: root, port: 0, host: '127.0.0.1' });
let token = '';

try {
  await test('启动：全新数据目录下能直接起服务', async () => {
    const res = await fetch(`${url}/api/meta`);
    assertEqual(res.status, 200, 'meta 接口状态码');
    const meta = await res.json();
    token = getConfig().web.authToken || '';
    assert(!token, '全新安装默认不应要求访问令牌（否则用户会被 401 挡住）');
    return `${url} · v${meta.version}`;
  });

  await test('目录：data / reports / raw 自动创建', async () => {
    for (const dir of ['', 'reports', 'raw']) {
      const p = path.join(freshDir, dir);
      assert(fs.existsSync(p) && fs.statSync(p).isDirectory(), `缺少目录 ${p}`);
    }
    return freshDir;
  });

  await test('静态资源：前端所有模块都能取到（不缺文件、无 404）', async () => {
    const files = [];
    const walk = (dir, rel = '') => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const next = path.join(dir, entry.name);
        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) walk(next, relPath);
        else files.push(relPath);
      }
    };
    walk(path.join(root, 'web'));
    assert(files.length > 10, `前端文件过少：${files.length}`);

    const bad = [];
    for (const f of files) {
      const res = await fetch(`${url}/${f}`);
      if (res.status !== 200) bad.push(`${f}(${res.status})`);
    }
    assert(!bad.length, `以下前端资源无法访问：${bad.join('、')}`);
    return `${files.length} 个文件全部 200`;
  });

  await test('静态资源：Logo 与入口脚本类型正确', async () => {
    const logo = await fetch(`${url}/assets/logo.png`);
    assertEqual(logo.status, 200, 'Logo 状态码');
    assertIncludes(logo.headers.get('content-type'), 'image/png', 'Logo MIME');
    const main = await fetch(`${url}/main.js`);
    assertIncludes(main.headers.get('content-type'), 'javascript', 'main.js MIME');
    const theme = await fetch(`${url}/theme.js`);
    assertEqual(theme.status, 200, 'theme.js 可访问');
    return 'image/png · text/javascript';
  });

  await test('空状态：未配置邮箱时不崩，且给出可执行指引', async () => {
    const overview = await (await fetch(`${url}/api/overview`)).json();
    assertEqual(overview.ok, true, 'overview.ok');
    assertEqual(overview.stats.total, 0, '全新机器不应有任何分析结果');
    assertEqual(overview.needAction.length, 0, '待处理清单应为空');
    assertEqual(overview.stats.drafts.total, 0, '不应有草稿');

    const knowledge = await (await fetch(`${url}/api/knowledge`)).json();
    assertEqual(knowledge.ok, true, 'knowledge.ok');
    assertEqual(knowledge.entries.length, 0, '知识库应为空');
    return '总览与知识库均为空但不报错';
  });

  /**
   * 这一条测的就是「交付给别人」的第一个画面。
   *
   * 别人装完打开，看到的必须是**明确的下一步**，而不是空页面 + 一堆"未配置"；
   * 向导靠 /api/health 判断落点，所以这里断言全新机器上它确实判定为"全新"。
   */
  await test('首次上手：全新机器上判定为 fresh，并指出第一步是「连接邮箱」', async () => {
    const res = await fetch(`${url}/api/health`);
    assertEqual(res.status, 200, '体检接口应可用');
    const h = await res.json();
    assertEqual(h.fresh, true, '全新机器应判定为 fresh（界面据此直接进向导）');
    assertEqual(h.ready, false, '没配完就不能说"可以用了"');
    assertEqual(h.nextStepId, 'mailbox', '第一步必须是「连接邮箱」');
    assertEqual(h.steps.length, 3, '应是三步');
    assertEqual(
      h.steps.map((s) => s.id).join(','),
      'mailbox,llm,calendar',
      '步骤顺序：邮箱 → 大模型 → 日历',
    );
    assertEqual(
      h.steps.filter((s) => s.required).length,
      2,
      '必需项只有两个（日历可选，不用日历的人不该被卡住）',
    );
    // 每一步都要说清"差什么"，否则用户只知道没配好、不知道配什么
    for (const s of h.steps.filter((x) => x.required)) {
      assert(s.detail && s.detail.length > 0, `步骤「${s.title}」必须给出原因`);
      assertEqual(s.done, false, `全新机器上「${s.title}」不应是已完成`);
    }
    assert(typeof h.version === 'string' && h.version.length > 0, '应带版本号（报问题时要附上）');
    return `fresh，下一步=mailbox，版本 ${h.version}`;
  });

  await test('未配置：运行分析时给出中文原因而不是堆栈', async () => {
    const res = await fetch(`${url}/api/runs`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ trigger: 'fresh-test' }),
    });
    assert(res.status >= 400 && res.status < 500, `应为 4xx，实际 ${res.status}`);
    const body = await res.json();
    assertEqual(body.code, 'INSTANCE_INVALID', '错误码');
    assertIncludes(body.message, '邮箱配置不完整', '错误信息');
    assertIncludes(body.message, '授权码', '应指出缺哪一项');
    return body.code;
  });

  await test('未配置：自检给出逐项可读结论', async () => {
    const out = await (await fetch(`${url}/api/diagnostics`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).json();
    assertEqual(out.ok, false, '未配置时自检整体应为未通过');
    const errors = out.result.checks.filter((c) => c.status === 'error');
    assert(errors.length > 0, '应有失败项');
    assert(
      errors.every((c) => c.message && /[\u4e00-\u9fa5]/.test(c.message)),
      `失败项都应有中文说明：${errors.map((c) => `${c.label}=${c.message}`).join('; ')}`,
    );
    return `${errors.length} 项待修复`;
  });

  await test('未配置：日历状态给出授权前指引', async () => {
    const status = await (await fetch(`${url}/api/calendar/status`)).json();
    assertEqual(status.ok, true, 'calendar.status ok');
    assertEqual(status.ready, false, '未配置时不应显示为可用');
    assertEqual(status.connected, false, '未配置时不应显示为已连接');
    return `configured=${status.configured}`;
  });

  await test('配置：在界面上填完能落盘到 data/config.json', async () => {
    const res = await fetch(`${url}/api/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        instances: [
          {
            id: 'default',
            label: '我的企业邮箱',
            imap: { host: 'imap.example.cn', port: 993, secure: true, authUser: 'me@example.cn', authPass: 'secret-code' },
            smtp: { host: 'smtp.example.cn', port: 465, secure: true, authUser: 'me@example.cn', authPass: 'secret-code', authMethod: 'auto' },
            identity: { name: '我', email: 'me@example.cn' },
          },
        ],
        llm: { apiKey: 'sk-fresh-test' },
        scan: { windowHours: 48 },
      }),
    });
    assertEqual(res.status, 200, '保存状态码');
    const saved = await res.json();
    assertEqual(saved.config.instances[0].imap.authPass, '***', '返回内容必须脱敏');
    assertEqual(saved.config.llm.apiKey, '***', 'API Key 必须脱敏');

    const file = path.join(freshDir, 'config.json');
    assert(fs.existsSync(file), `应生成 ${file}`);
    const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
    assertEqual(onDisk.instances[0].imap.authPass, 'secret-code', '磁盘上应保存真实授权码');
    assertEqual(onDisk.scan.windowHours, 48, '改动应生效');

    resetConfigCache();
    loadConfig({ rootDir: root, force: true });
    assertEqual(getConfig().instances[0].smtp.host, 'smtp.example.cn', '重启后配置应仍在');
    return file;
  });

  await test('交付物：一键启动脚本与配置模板齐全', async () => {
    const need = ['start.cmd', 'start.sh', '.env.example', 'cli.js', 'package.json'];
    for (const f of need) assert(fs.existsSync(path.join(root, f)), `缺少 ${f}`);
    const cmd = fs.readFileSync(path.join(root, 'start.cmd'), 'utf8');
    assertIncludes(cmd, 'node cli.js start', 'start.cmd 应调用 node cli.js start');
    const sh = fs.readFileSync(path.join(root, 'start.sh'), 'utf8');
    assertIncludes(sh, 'node cli.js start', 'start.sh 应调用 node cli.js start');
    const env = fs.readFileSync(path.join(root, '.env.example'), 'utf8');
    for (const key of ['MAILBOT_IMAP_HOST', 'MAILBOT_SMTP_HOST', 'DEEPSEEK_API_KEY', 'MAILBOT_WEB_PORT']) {
      assertIncludes(env, key, `.env.example 应包含 ${key}`);
    }
    const pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    assert(pkg.scripts.serve, 'package.json 应有 serve 脚本');
    return need.join(' / ');
  });

  await test('start.cmd：纯 ASCII + CRLF（否则 cmd.exe 会报一屏 not recognized）', async () => {
    const buf = fs.readFileSync(path.join(root, 'start.cmd'));

    // 1) 不得含非 ASCII 字节：cmd.exe 解析「UTF-8 中文 + chcp 65001」的批处理时，
    //    文件位置会在多字节字符之后错位，后续行从错误偏移开始执行、丢掉行首字符
    //    （call→all、echo 消失、node cli.js serve→serve），
    //    于是满屏 "'xxx' is not recognized as an internal or external command"。
    const nonAscii = [...buf].filter((b) => b > 127).length;
    assertEqual(nonAscii, 0, `start.cmd 必须是纯 ASCII（发现 ${nonAscii} 个非 ASCII 字节）`);

    // 2) 不得有裸 LF：cmd.exe 期望 CRLF，只有 LF 时 goto/标签会失效
    let crlf = 0;
    let bareLf = 0;
    for (let i = 0; i < buf.length; i += 1) {
      if (buf[i] !== 10) continue;
      if (i > 0 && buf[i - 1] === 13) crlf += 1;
      else bareLf += 1;
    }
    assertEqual(bareLf, 0, `start.cmd 不应有裸 LF 换行（发现 ${bareLf} 处）`);
    assert(crlf > 3, `start.cmd 应有 CRLF 换行（实际 ${crlf} 行）`);

    // 3) 不得**执行** chcp 65001 —— 正是它触发了上面那个解析缺陷
    //    （注释里提到它是可以的，所以要先剥掉 rem 行再判断）
    const code = buf
      .toString('utf8')
      .split(/\r?\n/)
      .filter((l) => !/^\s*(rem\b|::)/i.test(l))
      .join('\n');
    assert(!/chcp\s+65001/i.test(code), 'start.cmd 不应执行 chcp 65001');

    // 4) 中文提示必须放在 Node 侧：批处理只负责找到 Node 并把它叫起来
    const out = await runStartCheck();
    assertIncludes(out, '一键启动', 'node cli.js start 应输出中文启动横幅');
    assertIncludes(out, 'Node.js', '应打印 Node 版本');
    assertIncludes(out, '检查完成', '--check 应只做检查并结束');
    return `ASCII ${buf.length}B · CRLF ${crlf} 行 · 中文提示在 Node 侧`;
  });

  await test('一键启动：缺 .env 时自动生成，并接着启动服务', async () => {
    // 这个「刚复制过来」的假项目目录由 test/lib/tmp.js 统一在进程退出时清理
    const tmpRoot = makeTempDir('mailbot-root-');
    // 造一个「刚复制过来、还没装依赖、也没有 .env」的项目目录
    fs.copyFileSync(path.join(root, '.env.example'), path.join(tmpRoot, '.env.example'));
    fs.mkdirSync(path.join(tmpRoot, 'node_modules', 'imapflow'), { recursive: true });

    const lines = [];
    let startedWith = null;
    const result = await runStart({
      rootDir: tmpRoot,
      control: {},
      log: (s = '') => lines.push(String(s)),
      open: () => {},
      startServer: async (opts) => {
        startedWith = opts;
        return { url: 'http://127.0.0.1:8787/?token=test' };
      },
    });

    const out = lines.join('\n');
    assertIncludes(out, '已生成 .env', '应自动从 .env.example 生成 .env');
    assert(fs.existsSync(path.join(tmpRoot, '.env')), '.env 应真的落盘');
    assertEqual(result.started, true, '应继续启动服务');
    assertEqual(result.url, 'http://127.0.0.1:8787/?token=test', '应返回服务地址');
    assertIncludes(out, '服务已启动', '应打印启动结果');
    assert(startedWith && startedWith.rootDir === tmpRoot, '应把 rootDir 传给服务');
    return '生成 .env + 启动服务';
  });

  await test('文档：需求文档与运行配置文档存在且非空', async () => {
    const docs = ['docs/需求文档.md', 'docs/运行与配置文档.md'];
    for (const d of docs) {
      const p = path.join(root, d);
      assert(fs.existsSync(p), `缺少 ${d}`);
      const text = fs.readFileSync(p, 'utf8');
      assert(text.length > 2000, `${d} 内容过少（${text.length} 字符）`);
    }
    const runDoc = fs.readFileSync(path.join(root, 'docs/运行与配置文档.md'), 'utf8');
    for (const key of ['start.cmd', 'node cli.js serve', 'MAILBOT_IMAP_PASS', '常见问题']) {
      assertIncludes(runDoc, key, `运行配置文档应覆盖 ${key}`);
    }
    return docs.join(' / ');
  });
} finally {
  await new Promise((r) => server.close(r));
  // 数据目录 freshDir 由 test/lib/tmp.js 在进程退出时统一清理（容忍失败并重试）
}

console.log(`\n通过 ${passed} 项，失败 ${failures.length} 项。`);
if (failures.length) {
  console.log('\n失败详情：');
  for (const f of failures) console.log(`\n[${f.name}]\n${f.message}`);
}
process.exit(failures.length ? 1 : 0);
