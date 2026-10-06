/**
 * 一键启动的**全部逻辑**（环境检查 → 装依赖 → 备好配置 → 起服务 → 开浏览器）。
 *
 * 为什么这些逻辑不在 start.cmd 里：
 *   cmd.exe 解析「含 UTF-8 中文 + 执行了 chcp 65001」的批处理时，文件位置的计算会在
 *   每个多字节字符之后错位，后续行会从错误的偏移开始执行、丢掉行首字符
 *   （`call` 变成 `all`、`echo` 消失、`node cli.js serve` 只剩 `serve`），
 *   于是用户看到的是一屏
 *       'xxx' is not recognized as an internal or external command
 *   把逻辑搬到 Node 里就完全绕开了这个解析器缺陷：start.cmd / start.sh 只负责
 *   「找到 Node 并把它叫起来」，所有检查与中文提示都在这里，三平台行为一致、也可被测试。
 */

import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import {
  ensureDirs,
  getConfig,
  getInstance,
  getPaths,
  loadConfig,
  resetConfigCache,
  validateInstance,
  validateLlm,
} from '../config/index.js';

/**
 * 用系统默认程序打开 URL。
 *
 * 刻意不引入第三方包（如 open）：这个项目的依赖越少，换一台机器部署越省事。
 * 打开失败不影响服务本身，只提示用户手动访问。
 */
export function openBrowser(url) {
  const platform = process.platform;
  let command;
  let argv;
  if (platform === 'win32') {
    // start 是 cmd 内建命令，第一个引号参数会被当成窗口标题，所以这里放一个空标题
    command = 'cmd';
    argv = ['/c', 'start', '', url];
  } else if (platform === 'darwin') {
    command = 'open';
    argv = [url];
  } else {
    command = 'xdg-open';
    argv = [url];
  }
  try {
    const child = spawn(command, argv, { stdio: 'ignore', detached: true });
    child.on('error', () => console.log('（未能自动打开浏览器，请手动访问上面的地址）'));
    child.unref();
  } catch {
    console.log('（未能自动打开浏览器，请手动访问上面的地址）');
  }
}

/** 依赖是否已安装（以核心依赖为标志，够用且快）。 */
export function depsInstalled(rootDir) {
  return fs.existsSync(path.join(rootDir, 'node_modules', 'imapflow'));
}

/**
 * 一键启动。
 *
 * @param {object} options
 * @param {string} options.rootDir 项目根目录
 * @param {object} [options.control] CLI flags：--check / --port / --host / --no-open
 * @param {(url: string) => void} [options.open] 打开浏览器的方式（测试里可注入）
 * @param {(line: string) => void} [options.log] 输出方式（测试里可收集）
 * @param {(opts: object) => Promise<{url: string}>} [options.startServer] 启动服务的方式（测试里可注入）
 * @returns {Promise<{ok: boolean, started: boolean, url: string|null, checks: object}>}
 */
export async function runStart({ rootDir, control = {}, open = openBrowser, log = console.log, startServer } = {}) {
  const root = rootDir || process.cwd();
  const checkOnly = control.check === true;
  const line = (s = '') => log(s);

  line('============================================================');
  line('           邮箱与日历数字人 · 一键启动');
  line('============================================================');
  line();

  /* 1. Node 版本（这里是运行时，理论上已经通过；仍要拦住 20 以下的版本） */
  const nodeVersion = process.versions.node;
  const major = Number(String(nodeVersion).split('.')[0]);
  line(`[1/4] Node.js v${nodeVersion}`);
  if (!Number.isFinite(major) || major < 20) {
    line();
    line(`  [错误] Node.js 版本过低（当前 v${nodeVersion}，需要 20 或更高）。`);
    line('         请到 https://nodejs.org/zh-cn/download 安装 LTS 版本后重试。');
    line();
    return { ok: false, started: false, url: null, checks: { nodeVersion, nodeOk: false } };
  }

  /* 2. 依赖 */
  let depsOk = depsInstalled(root);
  if (depsOk) {
    line('[2/4] 依赖已就绪');
  } else if (checkOnly) {
    line('[2/4] 缺少依赖：需要先执行 npm install');
  } else {
    line('[2/4] 首次运行：正在安装依赖（需要联网，约 1-2 分钟）...');
    line();
    const res = spawnSync('npm', ['install', '--no-audit', '--no-fund'], {
      cwd: root,
      // stdio 必须是 inherit：一是要把 npm 的进度原样显示给用户，
      // 二是管道抓取子进程输出在某些受限环境下会被直接拒绝
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });
    if (res.error || res.status !== 0) {
      line();
      line('  [错误] 依赖安装失败。请检查网络后重试。');
      line('         若提示 npm 缓存目录没有权限，可先手工执行：');
      line('             npm install --cache .\\.npm-cache --no-audit --no-fund');
      line();
      return { ok: false, started: false, url: null, checks: { nodeVersion, nodeOk: true, depsOk: false } };
    }
    depsOk = depsInstalled(root);
  }

  /* 3. 配置文件 */
  const envFile = path.join(root, '.env');
  const envExample = path.join(root, '.env.example');
  let envCreated = false;
  if (fs.existsSync(envFile)) {
    line('[3/4] 配置文件 .env 已存在');
  } else if (fs.existsSync(envExample)) {
    if (checkOnly) {
      line('[3/4] 缺少 .env（启动时会自动从 .env.example 生成）');
    } else {
      fs.copyFileSync(envExample, envFile);
      envCreated = true;
      // .env 刚生成：让配置重新加载一次，免得本进程还在用旧的环境变量
      resetConfigCache();
      loadConfig({ rootDir: root, force: true });
      line('[3/4] 已生成 .env（可稍后在界面「设置」里填写，或直接编辑该文件）');
    }
  } else {
    line('[3/4] 未找到 .env.example，跳过');
  }

  /* 收尾：配置体检（--check 时打印，正常启动时也顺手提示一下缺什么） */
  loadConfig({ rootDir: root });
  ensureDirs();
  const cfg = getConfig();
  const mailProblems = validateInstance(getInstance());
  const llmProblems = validateLlm(cfg);
  const ready = mailProblems.length === 0 && llmProblems.length === 0;

  if (checkOnly) {
    line('[4/4] 检查完成（--check 不启动服务）');
    line();
    line(`  默认实例：${cfg.instances[0].label}（${cfg.instances[0].imap.host || '未填 IMAP 服务器'}）`);
    line(`  邮箱配置：${mailProblems.length ? `待补全 → ${mailProblems.join('；')}` : '完整'}`);
    line(`  大模型　：${llmProblems.length ? `待补全 → ${llmProblems.join('；')}` : `已配置（${cfg.llm.model}）`}`);
    line(`  数据目录：${getPaths().dataDir}`);
    line();
    return {
      ok: true,
      started: false,
      url: null,
      checks: { nodeVersion, nodeOk: true, depsOk, envCreated, ready, mailProblems, llmProblems },
    };
  }

  /* 4. 启动 */
  const willOpen = control.open !== false && control['no-open'] !== true;
  line(`[4/4] 正在启动服务${willOpen ? '，浏览器会自动打开' : ''}...`);
  line();
  line('  关闭这个窗口即可停止服务（macOS/Linux 按 Ctrl+C）。');
  if (willOpen) line('  如果浏览器没有自动打开，请手动访问下面打印的地址。');
  if (!ready) {
    line();
    line('  [提示] 还差一些配置才能用：');
    for (const p of [...mailProblems, ...llmProblems]) line(`         · ${p}`);
    line('         服务会照常启动，请打开界面到「设置」里补全。');
  }
  line();

  const starter = startServer || (await import('../index.js')).startServer;
  const { url } = await starter({ rootDir: root, port: control.port ? Number(control.port) : undefined, host: control.host });
  line(`服务已启动：${url}`);
  if (willOpen) open(url);
  return { ok: true, started: true, url, checks: { nodeVersion, nodeOk: true, depsOk, envCreated, ready, mailProblems, llmProblems } };
}
