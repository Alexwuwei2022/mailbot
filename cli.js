#!/usr/bin/env node
/**
 * 命令行入口。适合做计划任务（Windows 任务计划 / cron）。
 *
 *   node cli.js start                      一键启动（检查环境 → 装依赖 → 备好配置 → 起服务 → 开浏览器）
 *   node cli.js serve                      启动 Web 后台
 *   node cli.js scan [--hours 24]          拉取并分析近 24 小时邮件、起草回复
 *   node cli.js doctor [--deep]            自检邮箱与大模型配置
 *   node cli.js drafts [--all]             列出草稿
 *   node cli.js send <draftId> --yes       发送指定草稿（需显式 --yes）
 *   node cli.js report [--id <reportId>]   查看简报
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ensureDirs, getConfig, getPaths, loadConfig, maskConfig, saveConfig } from './server/config/index.js';
import { APP_VERSION, log } from './server/lib/util.js';
import { openBrowser, runStart } from './server/lib/startup.js';
import { runDiagnostics } from './server/diagnostics.js';
import { runScan } from './server/ai/engine.js';
import { deleteDraft, listDrafts, sendDraft } from './server/mail/drafts.js';
import * as store from './server/store/state.js';
import { buildKnowledge, buildOverview } from './server/ai/insight.js';
import { chatWithCalendar, commitPending, getCalendarInsight, newSessionId, suggestEventsFromEmails } from './server/calendar/service.js';
import { startServer } from './server/index.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)));

function parseArgs(argv) {
  const args = { _: [], flags: {} };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token.startsWith('--')) {
      const [key, inline] = token.slice(2).split('=');
      if (inline !== undefined) args.flags[key] = inline;
      else if (argv[i + 1] && !argv[i + 1].startsWith('--')) args.flags[key] = argv[++i];
      else args.flags[key] = true;
    } else {
      args._.push(token);
    }
  }
  return args;
}

function usage() {
  console.log(`邮箱与日历数字人 v${APP_VERSION}

用法：
  node cli.js start [--port 8787]               一键启动（检查环境 → 装依赖 → 备好配置 → 起服务 → 开浏览器）
  node cli.js start --check                     只做启动前检查，不启动服务
  node cli.js serve [--open] [--port 8787]      启动本地 Web 后台（--open 自动打开浏览器）
  node cli.js scan [--hours 24] [--port 8787]   分析最近 N 小时邮件并起草回复
  node cli.js doctor [--deep]                   自检 IMAP / SMTP / 大模型
  node cli.js drafts [--status pending|sent]    列出草稿
  node cli.js show <draftId>                    查看草稿正文
  node cli.js send <draftId> --yes              发送草稿（必须显式 --yes）
  node cli.js drop <draftId>                    删除本地草稿记录
  node cli.js report [--list] [--id <id>]       查看/列出简报
  node cli.js calendar [--days 7] [--quiet]     今日/明日/最近 N 天日程分析
  node cli.js calendar-add "<描述>" [--yes]     用自然语言建日程（--yes 才真正写入）
  node cli.js calendar-emails [--hours 24]      从邮件里找出可写入日历的时间
  node cli.js config [--show]                    显示当前配置（授权码已脱敏）
  node cli.js env                                显示数据目录与关键路径
`);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const command = args._[0] || 'serve';
  loadConfig({ rootDir: ROOT });
  ensureDirs();

  switch (command) {
    case 'help':
    case '--help':
    case '-h':
      usage();
      return;

    case 'start':
      await runStart({ rootDir: ROOT, control: args.flags });
      return;

    case 'env': {
      const p = getPaths();
      const cfg = getConfig();
      console.log(JSON.stringify({ version: APP_VERSION, ...p, defaultInstanceId: cfg.defaultInstanceId, windowHours: cfg.scan.windowHours }, null, 2));
      return;
    }

    case 'config': {
      console.log(JSON.stringify(maskConfig(getConfig()), null, 2));
      return;
    }

    case 'verify': {
      // 内部使用：验证 config.json 是否为合法 JSON
      const p = getPaths();
      JSON.parse(fs.readFileSync(p.configFile, 'utf8'));
      console.log('config.json 合法');
      return;
    }

    case 'save-config': {
      const file = args.flags.file;
      if (!file) throw new Error('需要 --file <path>');
      const patch = JSON.parse(fs.readFileSync(file, 'utf8'));
      saveConfig(patch);
      console.log('配置已保存');
      return;
    }

    case 'serve': {
      const { url } = await startServer({
        rootDir: ROOT,
        port: args.flags.port ? Number(args.flags.port) : undefined,
        host: args.flags.host,
      });
      console.log(`服务已启动：${url}（Ctrl+C 停止）`);
      // --open：直接用系统默认浏览器打开带令牌的地址，省掉「复制粘贴」这一步
      if (args.flags.open) openBrowser(url);
      return;
    }

    case 'serve-test': {
      const { server, url } = await startServer({
        rootDir: ROOT,
        port: args.flags.port ? Number(args.flags.port) : 0,
        host: args.flags.host || '127.0.0.1',
      });
      console.log(JSON.stringify({ url }));
      if (args.flags.once) {
        server.close();
        return;
      }
      return;
    }

    case 'doctor': {
      const result = await runDiagnostics({ deep: !!args.flags.deep });
      for (const c of result.checks) {
        const icon = { ok: '✅', warn: '⚠️', error: '❌', skipped: '➖' }[c.status] || '•';
        console.log(`${icon} ${c.label}：${c.message}`);
      }
      process.exitCode = result.ok ? 0 : 2;
      return;
    }

    case 'scan': {
      const hours = args.flags.hours ? Number(args.flags.hours) : undefined;
      const result = await runScan({ windowHours: hours, force: true, trigger: 'cli' });
      console.log('');
      console.log(`分析完成：共 ${result.analyzed} 封，需回复 ${result.needsReply} 封，已起草 ${result.drafts} 封。`);
      if (result.reportId) {
        const report = store.getReport(result.reportId);
        console.log(`简报文件：${report?.file}`);
      }
      const drafts = listDrafts({ status: 'pending' });
      if (drafts.length) {
        console.log('\n待审核草稿：');
        for (const d of drafts) console.log(`  [${d.id}] → ${d.to}｜${d.subject}`);
        console.log('\n查看：node cli.js show <draftId>；发送：node cli.js send <draftId> --yes');
      }
      return;
    }

    case 'drafts': {
      const status = args.flags.all ? undefined : args.flags.status || 'pending';
      const drafts = listDrafts({ status });
      if (!drafts.length) {
        console.log('没有草稿。');
        return;
      }
      for (const d of drafts) {
        console.log(`${d.id}`);
        console.log(`  状态：${d.status}　收件人：${d.to}　生成：${d.createdAt}`);
        console.log(`  主题：${d.subject}`);
        if (d.reason) console.log(`  判断：${d.reason}`);
        console.log('');
      }
      return;
    }

    case 'show': {
      const id = args._[1];
      if (!id) throw new Error('需要草稿 id');
      const draft = store.getDraft(id);
      if (!draft) throw new Error(`未找到草稿 ${id}`);
      console.log(`收件人：${draft.to}`);
      if (draft.cc) console.log(`抄送：${draft.cc}`);
      console.log(`主题：${draft.subject}`);
      console.log(`状态：${draft.status}`);
      console.log('---');
      console.log(draft.body);
      if (draft.notes?.length) {
        console.log('---');
        console.log('需确认：');
        for (const n of draft.notes) console.log(`  - ${n}`);
      }
      return;
    }

    case 'send': {
      const id = args._[1];
      if (!id) throw new Error('需要草稿 id');
      if (args.flags.yes !== true) {
        console.error('发送不可撤销。确认无误后请加 --yes 重试。');
        process.exitCode = 1;
        return;
      }
      const out = await sendDraft(id, { confirm: true, deleteMailboxDraft: true, appendToSent: true });
      console.log(`已发送：${out.result.messageId} → ${out.draft.to}`);
      for (const note of out.result.notes || []) console.log(`  · ${note}`);
      return;
    }

    case 'drop': {
      const id = args._[1];
      if (!id) throw new Error('需要草稿 id');
      deleteDraft(id);
      console.log('已删除本地草稿记录');
      return;
    }

    case 'report': {
      if (args.flags.list) {
        for (const r of store.listReports(20)) {
          console.log(`${r.id}　${r.createdAt}　${r.total ?? ''} 封　需回复 ${r.needsReply ?? ''}　${r.file}`);
        }
        return;
      }
      const id = args.flags.id;
      const report = id ? store.getReport(id) : store.listReports(1)[0];
      if (!report) {
        console.log('暂无简报。');
        return;
      }
      console.log(store.readReportFile(report.file) || '（文件已不存在）');
      return;
    }

    case 'calendar': {
      // 今日 / 明日 / 最近 N 天日程分析
      const days = args.flags.days ? Number(args.flags.days) : undefined;
      const out = await getCalendarInsight({ lookaheadDays: days });
      console.log(`时区：${out.timeZone}　目标日历：${out.calendarId}`);
      console.log(
        `今日 ${out.stats.today} 条　明日 ${out.stats.tomorrow} 条　有安排 ${out.stats.busyDays}/${out.stats.days} 天　忙碌 ${out.stats.busyHours} 小时`,
      );
      if (out.conflicts.length) {
        console.log(`\n⚠️ 时间重叠 ${out.conflicts.length} 组：`);
        for (const c of out.conflicts) console.log(`  ${c.label}　「${c.a}」↔「${c.b}」`);
      }
      console.log('');
      console.log(out.analysis || '（无分析）');
      if (!args.flags.quiet) {
        console.log('\n--- 按天明细 ---');
        for (const day of out.days) {
          console.log(`\n${day.label}${day.count ? `（${day.count} 条）` : '（空闲）'}`);
          for (const e of day.events) console.log(`  ${e.timeLabel}\t${e.summary}${e.location ? `\t@${e.location}` : ''}`);
        }
      }
      return;
    }

    case 'calendar-add': {
      const text = args._.slice(1).join(' ').trim();
      if (!text) throw new Error('请提供日程描述，例如：node cli.js calendar-add "明天下午3点和客户电话沟通30分钟"');
      const sessionId = newSessionId();
      const out = await chatWithCalendar({ sessionId, message: text });
      console.log(out.assistant);
      if (out.kind !== 'confirm') {
        console.log('\n未写入日历（需要补充信息，或该请求不是创建日程）。');
        return;
      }
      if (args.flags.yes !== true) {
        console.log('\n确认写入请加 --yes 重试：');
        console.log(`  node cli.js calendar-add "${text}" --yes`);
        return;
      }
      const committed = await commitPending({ sessionId });
      console.log(`\n✅ 已写入日历：${committed.event.summary}　${committed.event.allDay ? committed.event.date : committed.event.startLocal}`);
      return;
    }

    case 'calendar-emails': {
      const out = await suggestEventsFromEmails({ windowHours: args.flags.hours ? Number(args.flags.hours) : undefined });
      if (!out.suggestions.length) {
        console.log(out.note || '没有从邮件中找到可写入日历的时间信息。');
        return;
      }
      console.log(`扫描 ${out.scanned} 封邮件，找到 ${out.suggestions.length} 条建议：\n`);
      for (const s of out.suggestions) {
        console.log(`- [${s.kind}] ${s.event.summary}`);
        console.log(`  时间：${s.event.allDay ? `${s.event.date}（全天）` : `${s.event.startLocal} → ${s.event.endLocal}`}`);
        console.log(`  来自：${s.mail.from?.address || ''}　${s.mail.subject || ''}`);
        if (s.evidence) console.log(`  依据：${s.evidence}`);
        console.log('');
      }
      console.log('请到界面「日历」页逐条确认写入。');
      return;
    }

    case 'overview': {
      const d = buildOverview({});
      console.log(`最近 ${d.windowHours} 小时：共 ${d.stats.total} 封，需回复 ${d.stats.needsReply} 封，待审核草稿 ${d.stats.drafts.pending} 封。`);
      console.log(`类型分布：${JSON.stringify(d.stats.byType)}`);
      console.log('');
      for (const item of d.needAction) {
        console.log(`- [${item.priority}] ${item.subject} — ${item.from?.address || ''}`);
        if (item.summary) console.log(`    ${item.summary}`);
      }
      return;
    }

    case 'knowledge': {
      const k = buildKnowledge({});
      console.log(`邮件条目：${k.keyFacts.total}，需回复：${k.keyFacts.needsReply}`);
      for (const t of k.topics) console.log(`  ${t.label}：${t.count}`);
      return;
    }

    default:
      usage();
      process.exitCode = 1;
  }
}

main().catch((err) => {
  log.error(err?.stack || err);
  process.exitCode = 1;
});
