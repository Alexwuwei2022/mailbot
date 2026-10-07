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
 * 唯一可靠的"钉住读取"办法，就是把搜索列表设成**只含目标钥匙串**。
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

/**
 * 解析 `security list-keychains` 的输出：每行一个带引号的路径（形如 `    "/Users/x/Library/Keychains/login.keychain-db"`）。
 *
 * 没有引号的行按整行取（不同 macOS 版本的输出格式不完全一样，宁可如实收下也不要丢项）。
 */
export function parseSearchList(text) {
  return String(text ?? '')
    .split('\n')
    .map((line) => {
      const m = line.match(/"([^"]+)"/);
      return m ? m[1] : line.trim();
    })
    .filter(Boolean);
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
    /** 把搜索列表设为**只包含**目标钥匙串——这是"读也落到它"的唯一可靠办法。 */
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
