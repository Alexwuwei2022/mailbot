/**
 * macOS 钥匙串**搜索列表**的「记下 → 设为唯一 → 严格还原 → 核对」。
 *
 * ## 为什么需要这套东西
 *
 * `security find-generic-password` **没有**"指定去哪个钥匙串找"的选项——这不是推断，是 CI 上的
 * 原始报错：`find-generic-password: illegal option -- k`（上一轮误用了 `-k`）。而它末尾那个
 * `[keychain...]` 位置参数是**兜底**语义：先在搜索列表里找，找不到才拿这个路径兜底。于是
 * "从哪个钥匙串读"实际上由**系统搜索列表**决定——裸路径既不保证只读目标钥匙串，还会在搜索列表
 * 命中同名旧条目时把**别的钥匙串**（例如用户的登录钥匙串）的值读回来。
 * 唯一可靠的"钉住读取"办法，就是把目标钥匙串放在搜索列表**第一位**。
 *
 * ⚠️ 注意"第一位"而不是"只有它"：CI 实测（run 37626605652）表明
 * `security list-keychains -s <目标>` 之后，列表里**仍会列出只读的系统钥匙串**
 * （`/Library/Keychains/System.keychain`，root 属主、普通用户写不进去）。那不是解析出了幽灵项，
 * 而是 macOS 的搜索列表本来就包含系统域。所以调用方该断言的是**实质**：
 * ① 目标钥匙串排第一；② 用户登录钥匙串不在列表里（它在场才是真危险）。
 *
 * 但搜索列表是**全局机器状态**（改了它，同一台机器上所有程序找钥匙串的顺序都变了），
 * 所以这套动作必须：只在需要时改、无论成功失败都还原、还原之后还要**核对一致**。
 *
 * ## 为什么单独一个模块 + 依赖注入
 *
 * 本机是 Windows，macOS 的分支逻辑跑不到。抽成模块并注入 `run`，就能在
 * `test/secrets-platform.js` 里用**假 `security`** 把**同一份**守卫代码离线跑一遍
 * （含"还原失败必须被发现"的反例），而不是靠"读代码觉得对"。
 * 用注入而不是直接 `spawnSync`，还有个现实原因：受限沙箱里起不了管道子进程，
 * 注入式假实现验的是同一份代码，比另写一套仿真脚本更有说服力。
 * **离线仿真不等于真机验证**：真机结论只由 macOS CI 给出。
 *
 * ## 依据的用法文本
 *
 * macOS 自带 `security` 的用法行（SecurityTool 的 man page / `security <子命令> -h`）：
 *
 *   `list-keychains [-h] [-d user|system|common|dynamic] [-s [keychain...]]`
 *     - 不带 `-s`：**打印**当前搜索列表，每行一个**带引号**的路径；
 *     - 带 `-s`：把搜索列表**设为**后面给出的那几个钥匙串（一个都不给就是清空）。
 *
 * 因此解析必须按"引号里的路径"来，还原时必须把解析出来的路径**逐个**作为 argv 传回去，
 * 而不是凭猜拼一个字符串。
 */

import fs from 'node:fs';
import path from 'node:path';

/**
 * 解析 `security list-keychains` 的输出：每行一个带引号的路径（形如 `    "/Users/x/Library/Keychains/login.keychain-db"`）。
 *
 * 两条口径，都是为了"不制造假证据"：
 *   - **不许多解析出幽灵项**：只取引号里的内容，不按空格切、不做任何猜测；
 *   - **不许静默丢项**：同一行里出现多个带引号的路径时，**全部**收下。
 *
 * 第二条不是假想：原来的实现每行只取**第一个**引号串，于是"两个路径被打印在同一行"这种格式会
 * 悄悄少一项——而本用例的断言正是"列表里有哪些项"，少一项会让"只有它"这类前置条件**假通过**。
 * 反过来也要说清：CI run 37626605652 里那两行输出（`"…/mailbot-test.keychain" ⏎ "…/System.keychain"`）
 * 是**真的两行、真的两项**，不是解析出来的幽灵项——`⏎` 只是把真实换行压成一行显示的结果。
 *
 * 没有引号的行按整行取（不同 macOS 版本的输出格式不完全一样，宁可如实收下也不要丢项）。
 */
export function parseSearchList(text) {
  const out = [];
  for (const line of String(text ?? '').split('\n')) {
    const quoted = [...line.matchAll(/"([^"]+)"/g)].map((m) => m[1]).filter(Boolean);
    if (quoted.length) out.push(...quoted);
    else {
      const t = line.trim();
      if (t) out.push(t);
    }
  }
  return out;
}

/**
 * 把一条钥匙串路径规范化成**可比形态**，用来回答"这两条路径说的是不是同一个钥匙串"。
 *
 * 为什么不能直接 `===`（两个坑都是 macOS CI 上实测到的，不是假想）：
 *
 *   1. **符号链接前缀**：`/var/...` 与 `/private/var/...` 是同一个地方，而 `os.tmpdir()` 给我们的是
 *      前者、`security` 回显的是后者——CI 原始输出里就是
 *      `"/private/var/folders/36/…/mailbot-keychain-S8Ttzp/mailbot-test.keychain"`。
 *      同一轮日志里测试自己打印的数据目录却是 `/var/folders/36/…`，两者指的是一处。
 *   2. **落盘后缀**：新版 macOS 的钥匙串文件是 `<名字>-db`，而 `security` 回显时这个后缀时有时无
 *      （同一份 CI 输出里，登录钥匙串带 `-db`、临时钥匙串没带）。
 *
 * 两处都只归一"同一个钥匙串的两种写法"：目录用 `realpath` 解析（父目录必然存在，叶子不存在也不会
 * 抛错），叶子名只脱掉 `-db`，其余一字不改。刻意**不**做大小写折叠或模糊匹配——那会把
 * "两个不同的钥匙串"判成同一个，正是这类断言最不能出的错。
 */
export function canonKeychainPath(p) {
  const s = String(p ?? '')
    .trim()
    .replace(/^"|"$/g, '');
  if (!s) return '';
  const stripDb = (name) => (name.endsWith('-db') ? name.slice(0, -3) : name);
  const build = (dir) => path.join(dir, stripDb(path.basename(s)));
  try {
    return build(fs.realpathSync(path.dirname(s)));
  } catch {
    return build(path.dirname(s));
  }
}

/**
 * 判断搜索列表**是否已经把目标钥匙串钉住**——本用例真正需要的那个"实质"。
 *
 * 判定两条，缺一不可：
 *   ① 目标钥匙串排在**第一位**（读按这个顺序找，第一位不可能被别的钥匙串抢先）；
 *   ② 用户的**登录钥匙串不在列表里**（它在场才是真危险：同名旧条目会抢先被读到，
 *      上一轮 CI"裸路径读"红的真因就是这个）。
 *
 * 系统钥匙串（`/Library/Keychains/System.keychain`）在场是**允许**的：root 属主，用例写不进去。
 * 因此这里判的是"目标排第一 + 登录不在场"，而**不是**"列表长度等于 1"——后者是上一轮的写法，
 * 与 macOS 的实际行为不符（CI run 37626605652 实测：`-s` 之后系统钥匙串仍在列表里）。
 * 注意这条**不是**"读落到了哪里"的判决——那件事由用例里的真读校验（写探测值 → 同款读法读回）裁判。
 *
 * 抽成纯函数是为了能在**本机（Windows）**上用真实世界的两种列表形态离线跑一遍：
 * `[临时, 系统]` 必须放行（CI 实测形态），`[登录, 临时]` 必须拦下（上一轮出事的形态）。
 *
 * @returns {{ ok: boolean, problems: string[] }}
 */
export function searchListRestriction({ list, target, loginKeychain = null }) {
  const problems = [];
  const items = Array.isArray(list) ? list : [];
  if (items.length === 0) {
    problems.push('搜索列表是空的：不带钥匙串参数的读无从定位');
  } else if (canonKeychainPath(items[0]) !== canonKeychainPath(target)) {
    problems.push(`目标钥匙串不在第一位（第一位是 ${items[0]}，期望 ${target}）`);
  }
  if (loginKeychain && items.some((p) => canonKeychainPath(p) === canonKeychainPath(loginKeychain))) {
    problems.push(`登录钥匙串 ${loginKeychain} 出现在搜索列表里（它里面的同名旧条目会抢先被读到）`);
  }
  return { ok: problems.length === 0, problems };
}

/** 逐项（含**顺序**）等值：搜索列表的顺序就是查找优先级，顺序变了不算"还原"。 */
export function sameList(a, b) {
  return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((p, i) => p === b[i]);
}

/** 集合等值（不看顺序）：用来把"多了一个/少了一个"与"只是顺序不同"分开报。 */
export function sameSet(a, b) {
  const A = new Set(Array.isArray(a) ? a : []);
  const B = new Set(Array.isArray(b) ? b : []);
  return A.size === B.size && [...A].every((p) => B.has(p));
}

/**
 * 造一个搜索列表守卫。
 *
 * @param {{ run: (args: string[]) => { status: number|null, stdout?: string, stderr?: string } }} deps
 *   `run` 就是"跑一条 security 命令并回传原始结果"——真机用例传真的 `security`，
 *   离线仿真传假的实现。
 */
export function createSearchListGuard({ run }) {
  if (typeof run !== 'function') throw new Error('createSearchListGuard 需要注入 run(args)');
  /** snapshot() 记下的原始列表；null 表示还没记过（那就绝不允许动搜索列表） */
  let before = null;
  /** 有没有动过搜索列表（动过就必须还原，哪怕没记成也如实报出来） */
  let touched = false;

  const read = () => {
    const res = run(['list-keychains']);
    return { res, list: parseSearchList(res?.stdout) };
  };

  return {
    /** 动过搜索列表没有？（没动过就不必还原） */
    touched: () => touched,
    /** snapshot() 记下的原始值（给的是副本，改不到内部状态）；没记过就是 null */
    before: () => (before ? [...before] : null),
    /** 现在读一次搜索列表 */
    read,
    /**
     * 记下当前搜索列表。**必须在任何改动之前调用**——否则"原始值"本身就是被污染的。
     *
     * `ok` 同时要求命令成功且列表非空：读不出来或读成空，说明这个"原始值"不可信，
     * 调用方必须据此失败，而不是拿它去还原。
     */
    snapshot() {
      const r = read();
      before = r.list;
      return { ok: r.res?.status === 0 && r.list.length > 0, res: r.res, list: r.list };
    },
    /** 把目标钥匙串放到搜索列表**第一位**（`-s` 是"设为这几个"，所以只传它 = 它排第一）。 */
    restrictTo(keychain) {
      if (before === null) throw new Error('必须先 snapshot() 记下原始列表，再 restrictTo()（否则没法还原）');
      touched = true;
      const res = run(['list-keychains', '-s', String(keychain)]);
      return { ok: res?.status === 0, res };
    },
    /**
     * 严格还原成 snapshot() 记下的那一份，并**当场核对**。
     *
     * 返回 `{ ok, skipped, before, after, sameSet, res, check }`：
     *   - `ok=false` 时调用方**必须**据此判失败，并把 before / after 两个原值都打出来——
     *     "看起来还原了"是这里最不能接受的事；
     *   - `sameSet` 用来区分"少了/多了钥匙串"（`sameSet=false`）与"只是顺序不同"；
     *   - 没 snapshot 过（或压根没动过）就什么都不做，返回 `{ ok: true, skipped: true }`。
     */
    restore() {
      if (before === null) {
        return { ok: true, skipped: true, before: null, after: [], sameSet: true, res: null, check: null };
      }
      const res = run(['list-keychains', '-s', ...before]);
      const check = read();
      const after = check.list;
      const setOk = sameSet(before, after);
      return {
        ok: res?.status === 0 && sameList(before, after),
        skipped: false,
        before: [...before],
        after,
        sameSet: setOk,
        res,
        check: check.res,
      };
    },
  };
}
