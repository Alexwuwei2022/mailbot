/**
 * 默认配置。用户配置（data/config.json）与环境变量会在此基础上覆盖。
 * 这里是「服务器 / 端口 / 账号 / 授权码独立配置」的唯一事实来源。
 */
export const DEFAULTS = {
  /** 默认使用的邮箱实例 id */
  defaultInstanceId: 'default',

  instances: [
    {
      id: 'default',
      label: '企业邮箱',
      enabled: true,
      imap: {
        host: 'imap.exmail.qq.com',
        port: 993,
        secure: true,
        authUser: 'you@yourcompany.com',
        authPass: '',
      },
      smtp: {
        host: 'smtp.exmail.qq.com',
        port: 465,
        secure: true,
        authUser: 'you@yourcompany.com',
        authPass: '',
        /**
         * SMTP 认证方式：auto=自动协商（默认）/ PLAIN / LOGIN。
         * 部分企业邮箱（如腾讯企业邮箱）对 AUTH PLAIN 会回
         * 「535 authentication failed, system busy」，固定为 LOGIN 往往能通。
         */
        authMethod: 'auto',
      },
      identity: {
        name: '你的名字',
        email: 'you@yourcompany.com',
        replyTo: '',
      },
    },
  ],

  scan: {
    /** 回看窗口（小时），需求为近 24 小时 */
    windowHours: 24,
    /** 要扫描的文件夹，留空表示用 IMAP 命名空间里的 INBOX */
    folders: ['INBOX'],
    /** 单次最多处理多少封（防止误扫历史邮件） */
    maxMessages: 60,
    /** 是否把 IMAP 的 \Seen 视为已读线索（只读扫描，不会改动邮箱） */
    includeSeen: true,
    /** 只要这些标签的邮件，留空表示全部。例：['\\Flagged'] */
    requireFlags: [],
    /** 是否读取会话历史（同主题/同线索的旧邮件） */
    threadContextCount: 3,
    /** 单封正文送进模型的字符上限 */
    bodyCharsForLlm: 4000,
    /** 列表页摘要字符数 */
    snippetChars: 240,
  },

  draft: {
    /** 只为「需要回复」的邮件起草 */
    onlyWhenNeedsReply: true,
    /** 生成后是否自动追加到邮箱草稿箱 */
    saveToMailbox: true,
    /** 草稿语气：formal=正式商务 / concise=简洁 / warm=亲和 */
    tone: 'formal',
    /** 回复语言：auto=跟随来信语言 / zh / en */
    language: 'auto',
    /** 签名（留空则不追加） */
    signature: '',
    /**
     * 回复里是否附上原始邮件引文。
     *
     * 建议开启：收件人看到一封没有任何原文的回复，会不知道你在回哪一句，
     * 在企业邮箱里属于"不规范"；Foxmail / Outlook 中文版默认都会带。
     * 引文一律加在**签名之下**（顺序：新正文 → 签名 → 引文）。
     */
    quoteOriginal: true,
    /**
     * 引文风格：
     *   zh-client = `------------------ 原始邮件 ------------------` + 发件人/时间/收件人/主题（国内客户端习惯）
     *   prefix    = `在 … 写道：` + 每行 `> ` 缩进（Gmail / 国际习惯）
     */
    quoteStyle: 'zh-client',
    /** 引文正文的字符上限（超长从尾部截断并标注），避免回复被历史堆满 */
    quoteMaxChars: 2000,
    /**
     * 附件发送上限（按 base64 编码后的总字节算，默认 20 MB）。
     * 编码会膨胀约 1/3，所以这个数字大约对应"原始文件 15 MB"。
     * 多数企业邮箱的收件上限是 20 MB，卡在这里可以避免发送时才被服务器拒收。
     */
    attachmentMaxBytes: 20_000_000,
    /** 单封草稿最多几个附件（防止误选整个文件夹） */
    maxAttachments: 10,
    /** 生成后默认的发送策略 */
    sendPolicy: 'confirm',
    /** 单次最多起草多少封 */
    maxDrafts: 15,
    /** 模型并发 */
    concurrency: 3,
  },

  llm: {
    // DeepSeek 官方 API（OpenAI 兼容）
    baseUrl: 'https://api.deepseek.com',
    apiKey: '',
    model: 'deepseek-chat',
    temperature: 0.3,
    maxTokens: 4096,
    /** 单次请求超时（毫秒） */
    timeoutMs: 120_000,
    /** 单批发给模型的最大邮件数 */
    classifyBatchSize: 12,
    /** 失败重试次数 */
    maxRetries: 3,
    /** 是否用 JSON 输出模式 */
    jsonMode: true,
    /**
     * 仅本地模式：**只允许**把邮件内容发给本机（回环地址）上的模型。
     *
     * 打开后，任何指向局域网另一台机器或公网服务的模型地址都会被**直接拒绝**，
     * 而不是"提醒一下继续发"。默认关闭（保持原行为，升级上来的人不受影响）。
     *
     * 判断与提示见 server/lib/privacy.js——那里刻意不允许 192.168.x.x 之类私有网段：
     * 那是另一台电脑，数据已经离开了本机。
     */
    localOnly: false,
  },

  web: {
    host: '127.0.0.1',
    port: 8787,
    /** 非空时，所有 /api 请求需带 x-mailbot-token 或 Bearer（浏览器改用会话 Cookie） */
    authToken: '',
    /**
     * Host 白名单（防 DNS rebinding）。
     *
     * 服务只接受回环名（localhost / 127.0.0.1 / ::1）与 IP 字面量；
     * 想通过**域名**访问（反向代理、内网域名）就必须在这里登记。
     * 域名可以随时被解析到任意地址，正是 DNS rebinding 的载体，所以默认一个都不放。
     */
    allowedHosts: [],
    /** 信任 X-Forwarded-For：只有在反向代理后面才该打开，否则来源 IP 可被伪造 */
    trustProxy: false,
    /** 会话：空闲多久过期 / 最长多久必须重新登录 / 最多同时几个设备 */
    sessionIdleHours: 12,
    sessionAbsoluteDays: 7,
    sessionMaxCount: 20,
    /** 登录失败限速：窗口内失败多少次后、拒绝多久 */
    authMaxFailures: 10,
    authWindowMinutes: 5,
    authBlockMinutes: 5,
    /**
     * HTTPS。默认关闭——只在本机访问时 HTTP 足够，且自签证书会让浏览器警告。
     * 一旦要把服务暴露到局域网，就该打开它（否则令牌与邮件内容在链路上是明文）。
     */
    https: {
      enabled: false,
      /** 用自己的证书（推荐，浏览器不会警告）；两个都要填 */
      certFile: '',
      keyFile: '',
      /** 没有正式证书时用自签证书（会在 data/tls 下生成并复用） */
      selfSigned: true,
      /** 额外的证书备用名（域名或 IP），用于自签证书 */
      altNames: [],
    },
    /** 等价于 web.authToken，便于环境变量覆盖 */
    allowSend: null,
  },

  /** 日历数字人（Google Calendar） */
  calendar: {
    enabled: false,
    /** Google Cloud「Web 应用」OAuth 客户端凭据；回调地址需与之完全一致 */
    google: {
      clientId: '',
      clientSecret: '',
      redirectUri: '',
    },
    /** 目标日历：primary 表示账号主日历，也可填日历 ID（如 xxx@group.calendar.google.com） */
    calendarId: 'primary',
    /**
     * 访问 Google 走的 HTTP 代理（可留空）。
     *
     * Node 自带的 fetch 不读 HTTP_PROXY 环境变量，也不用系统代理，所以「浏览器能打开 Google、
     * 本程序报 fetch failed」是常态。国内网络下必须在这里填代理软件的 HTTP 端口。
     * 例：http://127.0.0.1:7890
     *
     * 只影响 Google（日历 / OAuth）；邮件与大模型走原网络，不受影响。
     */
    proxy: '',
    /** IANA 时区名，所有自然语言时间都按它解释 */
    timeZone: 'Asia/Shanghai',
    /** 新建日程后是否给参与者发邀请邮件 */
    sendUpdates: 'none',
    /** 「最近 N 天」分析窗口 */
    lookaheadDays: 7,
    /** 首页展示的即将到来的日程条数 */
    upcomingLimit: 20,
    /** 单次最多从邮件生成多少条日程建议 */
    maxFromEmails: 10,
    /** 日程提醒（分钟，留空则不加提醒） */
    reminders: [10],
    /**
     * 回顾分析的判定口径。
     *
     * 这些数字直接决定「忙碌时长」「深度工作时间」「晚间会议」怎么算，
     * 所以必须可配置——不同岗位的工作时段差别很大（有人 8 点上班、有人习惯晚上开会）。
     */
    review: {
      /** 工作时段（用于算"会议占工作时段的比例"与深度工作块） */
      workdayStart: '09:00',
      workdayEnd: '19:00',
      /** 工作日（0=周日 … 6=周六） */
      workdays: [1, 2, 3, 4, 5],
      /** 几点之后算「晚间会议」 */
      eveningAfterHour: 19,
      /** 超过多少分钟算「超长会议」 */
      longMeetingMin: 120,
      /** 两场会间隔小于多少分钟算「连续会议」（没有喘息） */
      backToBackGapMin: 10,
      /** 空档至少多少分钟才算「整块深度工作时间」 */
      deepBlockMin: 90,
      /** 各类 Top 榜取前几名 */
      topN: 8,
      /** 单次回顾最多取多少条日程（超出会如实提示截断） */
      maxEvents: 5000,
      /** 单次回顾最长多少天 */
      maxRangeDays: 366,
    },
  },

  /**
   * 对话式检索
   */
  search: {
    /**
     * 单次检索最多「按需回补分析」多少封邮件。
     * 检索范围超出本地已分析范围时，会去 IMAP 拉取该范围的邮件并分析，
     * 这个上限用来防止一次查询烧掉大量 token。设为 0 可关闭按需回补。
     */
    backfillMax: 40,
    /**
     * 单次检索最多扫描多少封信封（只取信头，不读正文、不调模型）。
     *
     * 它只服务于**列表完整性**：范围内对得上时间/发件人的邮件即使没有花额度分析，
     * 也要能列进命中列表。信封很小，所以这里可以比 backfillMax 大得多。
     *
     * 注意它只是**封顶值**，真正生效的预算是：
     *   `min(envelopeScanMax, max(backfillMax * 8, 600))`
     * 默认配置（backfillMax=40）下为 600 封；调大 backfillMax 会随之放大（100 → 800）。
     * 信封扫描不花模型额度，放大它不会增加模型调用量。
     *
     * 达到该上限时检索结果会明确标注「还有邮件未检查到」，绝不静默少给。
     */
    envelopeScanMax: 3000,
  },

  /**
   * 定时自动分析（主动性）。
   *
   * **默认关闭**：它会在你不知情的时候连邮箱、花 token，还可能把邮件正文送去模型。
   * 这种"替你做事"的能力必须由你明确打开。
   */
  schedule: {
    enabled: false,
    /**
     * 每天在哪些时刻跑（24 小时制，配置时区；可多个）。
     * 同一分钟内只会跑一次，重启也不会重复跑。
     */
    times: ['08:30'],
    /** 星期几跑：0=周日 … 6=周六。默认工作日 */
    days: [1, 2, 3, 4, 5],
    /** 每次分析的回看窗口（小时） */
    windowHours: 24,
  },

  /**
   * 分析完成后的提醒方式。
   *
   * 页内提示不用配置；自寄简报是**唯一在你不打开页面时也能收到**的渠道。
   */
  notify: {
    /** 页内提示（SSE 推送 + 弹条） */
    inApp: true,
    /** 浏览器桌面通知（需要页面开着并授权） */
    browser: false,
    /** 把简报寄给自己（默认关闭：它会发一封真邮件） */
    email: false,
    /**
     * 收件人。留空则发给本实例的发件身份（也就是你自己）。
     * 只在"确实有事"时才寄：无待办、无草稿就不打扰。
     */
    emailTo: '',
  },

  /**
   * 密钥保管（授权码 / API Key / 令牌放在哪里）。
   *
   * 名字叫 `vault`（保管库）而不是 `secrets`：这个配置节**自己不含任何密钥**，
   * 只说明密钥该放哪。叫 secrets 会让读配置的人以为密钥就在里面。
   *
   * 默认 `config` = 维持原样（明文写在 `config.json` / `.env` 里），
   * 这样升级上来的老用户行为完全不变——**"密钥搬到哪去了"这种事不能默认偷偷改变**。
   * 想用系统钥匙串，请在「设置 → 密钥存储」里显式迁移。
   *
   * mode 取值：
   *   config      明文留在配置文件（默认，向后兼容）
   *   auto        用本机可用的最佳加密后端（Windows DPAPI / macOS 钥匙串 / Linux Secret Service）；
   *               都没有时才退到**未加密**的本地文件，且该降级会在界面上明确说出来
   *   dpapi       Windows 凭据保护（DPAPI，CurrentUser 作用域）
   *   keychain    macOS 钥匙串
   *   libsecret   Linux Secret Service（GNOME Keyring / KWallet）
   *   file        未加密的本地文件 data/secrets.json（仅 600 权限）
   */
  vault: {
    mode: 'config',
  },

  /**
   * 跟催（我承诺了什么 / 等谁回复）。
   *
   * 两半的来源不同，成本也不同：
   *   - 「等谁回复」是**纯本地线程匹配**（我发出的邮件带 messageId，进来的邮件带
   *     In-Reply-To/References），不花一分钱，所以默认开启；
   *   - 「我承诺了什么」要用模型读**我自己发出的邮件**（数量很少），默认也开启，
   *     但可以单独关掉。
   */
  followUp: {
    enabled: true,
    /** 发出后多久还没回才算"在等对方"（避免刚发出去就催自己） */
    waitHours: 24,
    /** 是否用模型从我发出的邮件里提取承诺 */
    extractCommitments: true,
    /** 一次扫描最多提取多少条承诺 */
    maxCommitments: 20,
  },

  /**
   * 数据保留策略。
   *
   * 默认**什么都不自动删**（原文永久保留、分析上限沿用旧版的 3000）——
   * 清理会影响"历史还能不能查到"，必须由用户明确开启。
   */
  retention: {
    /**
     * 分析记录上限（超出后删最旧的）。旧版本写死 3000，现在可调。
     * ⚠️ 这是**历史记录本身**的上限：调小会让旧邮件从列表/统计/搜索里消失。
     */
    maxAnalyses: 3000,
    /**
     * 归档原文保留天数。**0 = 永久保留**。
     *
     * 设为正数后会删掉超期的 `data/raw/*.eml`，影响「查看原文 / 下载附件 / 重新起草」的
     * 离线可用性：邮件还在服务器上时程序会回连邮箱重取，邮件已被删除时就查不到了。
     */
    rawDays: 0,
  },

  /** 数据目录（相对项目根或绝对路径） */
  dataDir: './data',
};
/** 环境变量名 → 配置路径映射（便于在 .env 里放授权码，不进 config.json） */
export const ENV_MAP = {
  MAILBOT_DEFAULT_INSTANCE: 'defaultInstanceId',

  MAILBOT_IMAP_HOST: 'instances[].imap.host',
  MAILBOT_IMAP_PORT: 'instances[].imap.port',
  MAILBOT_IMAP_SECURE: 'instances[].imap.secure',
  MAILBOT_IMAP_USER: 'instances[].imap.authUser',
  MAILBOT_IMAP_PASS: 'instances[].imap.authPass',

  MAILBOT_SMTP_HOST: 'instances[].smtp.host',
  MAILBOT_SMTP_PORT: 'instances[].smtp.port',
  MAILBOT_SMTP_SECURE: 'instances[].smtp.secure',
  MAILBOT_SMTP_USER: 'instances[].smtp.authUser',
  MAILBOT_SMTP_PASS: 'instances[].smtp.authPass',
  MAILBOT_SMTP_AUTH_METHOD: 'instances[].smtp.authMethod',

  MAILBOT_EMAIL: 'instances[].identity.email',
  MAILBOT_SENDER_NAME: 'instances[].identity.name',

  DEEPSEEK_API_KEY: 'llm.apiKey',
  MAILBOT_LLM_API_KEY: 'llm.apiKey',
  MAILBOT_LLM_BASE_URL: 'llm.baseUrl',
  MAILBOT_LLM_MODEL: 'llm.model',

  MAILBOT_WEB_PORT: 'web.port',
  MAILBOT_WEB_HOST: 'web.host',
  MAILBOT_WEB_TOKEN: 'web.authToken',
  MAILBOT_ALLOW_SEND: 'web.allowSend',

  MAILBOT_WINDOW_HOURS: 'scan.windowHours',
  MAILBOT_DATA_DIR: 'dataDir',

  // 日历（Google Calendar）
  MAILBOT_CALENDAR_ENABLED: 'calendar.enabled',
  GOOGLE_CLIENT_ID: 'calendar.google.clientId',
  GOOGLE_CLIENT_SECRET: 'calendar.google.clientSecret',
  MAILBOT_GOOGLE_CLIENT_ID: 'calendar.google.clientId',
  MAILBOT_GOOGLE_CLIENT_SECRET: 'calendar.google.clientSecret',
  MAILBOT_GOOGLE_REDIRECT_URI: 'calendar.google.redirectUri',
  MAILBOT_CALENDAR_ID: 'calendar.calendarId',
  MAILBOT_TIMEZONE: 'calendar.timeZone',
  MAILBOT_GOOGLE_PROXY: 'calendar.proxy',
  MAILBOT_CALENDAR_SEND_UPDATES: 'calendar.sendUpdates',
  MAILBOT_CALENDAR_LOOKAHEAD_DAYS: 'calendar.lookaheadDays',
};

/**
 * 主流大模型服务商预设。
 *
 * 全部按 **OpenAI 兼容协议**列出（本程序的 LLM 客户端只说这一套协议），
 * 这样"选服务商"就等价于"填 baseUrl + 模型名"，用户不必去翻文档抄地址。
 *
 * 几点注意事项（也展示在界面上）：
 *   - `keyUrl`：去哪儿申请 Key，直接给用户可点的链接；
 *   - `needsKey: false`：本地部署（Ollama / vLLM）不需要 Key；
 *   - `note`：网络可达性、计费方式等容易踩的坑。
 */
export const LLM_PRESETS = [
  {
    id: 'deepseek',
    label: 'DeepSeek 官方',
    baseUrl: 'https://api.deepseek.com',
    models: ['deepseek-chat', 'deepseek-reasoner'],
    defaultModel: 'deepseek-chat',
    keyUrl: 'https://platform.deepseek.com/api_keys',
    note: '国内直连、价格低。deepseek-chat 适合日常分类与起草；deepseek-reasoner 更慢更贵，一般不必要',
  },
  {
    id: 'dashscope',
    label: '阿里云百炼（通义千问）',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    models: ['qwen-plus', 'qwen-max', 'qwen-turbo', 'qwen-long'],
    defaultModel: 'qwen-plus',
    keyUrl: 'https://bailian.console.aliyun.com/',
    note: '国内直连，需在百炼控制台开通并创建 API-KEY',
  },
  {
    id: 'moonshot',
    label: '月之暗面 Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    models: ['moonshot-v1-8k', 'moonshot-v1-32k', 'moonshot-v1-128k'],
    defaultModel: 'moonshot-v1-32k',
    keyUrl: 'https://platform.moonshot.cn/console/api-keys',
    note: '长上下文见长，适合一次投喂很多邮件正文',
  },
  {
    id: 'zhipu',
    label: '智谱 GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    models: ['glm-4-plus', 'glm-4-air', 'glm-4-flash'],
    defaultModel: 'glm-4-air',
    keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys',
    note: 'glm-4-flash 有免费额度，适合先试跑',
  },
  {
    id: 'siliconflow',
    label: '硅基流动 SiliconFlow',
    baseUrl: 'https://api.siliconflow.cn/v1',
    models: ['deepseek-ai/DeepSeek-V3', 'Qwen/Qwen2.5-72B-Instruct', 'Qwen/Qwen2.5-7B-Instruct'],
    defaultModel: 'deepseek-ai/DeepSeek-V3',
    keyUrl: 'https://cloud.siliconflow.cn/account/ak',
    note: '一个 Key 聚合多家开源模型，模型名按「组织/模型」写法',
  },
  {
    id: 'openai',
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1-mini'],
    defaultModel: 'gpt-4o-mini',
    keyUrl: 'https://platform.openai.com/api-keys',
    note: '国内需自备网络出口（本程序不会自动使用系统代理）',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter（聚合）',
    baseUrl: 'https://openrouter.ai/api/v1',
    models: ['deepseek/deepseek-chat', 'openai/gpt-4o-mini', 'anthropic/claude-3.5-sonnet'],
    defaultModel: 'deepseek/deepseek-chat',
    keyUrl: 'https://openrouter.ai/keys',
    note: '一个 Key 调多家模型，模型名带厂商前缀；国内同样需要网络出口',
  },
  {
    id: 'ollama',
    label: '本地部署（Ollama / vLLM）',
    baseUrl: 'http://127.0.0.1:11434/v1',
    models: ['qwen2.5:7b', 'qwen2.5:14b', 'llama3.1:8b'],
    defaultModel: 'qwen2.5:7b',
    needsKey: false,
    note: '完全离线、不花钱；API Key 留空即可。需要本机已装 Ollama 并用 `ollama pull` 拉过模型；小模型对中文邮件的判断明显弱于在线模型',
  },
];

/** 常见企业邮箱服务商的服务器/端口预设，方便界面一键填充。 */
export const PRESETS = [  {
    id: 'exmail-qq',
    label: '腾讯企业邮箱 (exmail.qq.com)',
    note: '授权码：邮箱设置 → 客户端专用密码/授权码，不是登录密码',
    imap: { host: 'imap.exmail.qq.com', port: 993, secure: true },
    smtp: { host: 'smtp.exmail.qq.com', port: 465, secure: true },
  },
  {
    id: 'aliyun',
    label: '阿里云企业邮箱',
    note: 'imap.qiye.aliyun.com:993 / smtp.qiye.aliyun.com:465',
    imap: { host: 'imap.qiye.aliyun.com', port: 993, secure: true },
    smtp: { host: 'smtp.qiye.aliyun.com', port: 465, secure: true },
  },
  {
    id: 'netease-qiye',
    label: '网易企业邮箱',
    note: 'imaphz.qiye.163.com:993 / smtphz.qiye.163.com:465（按机房域名可能不同）',
    imap: { host: 'imaphz.qiye.163.com', port: 993, secure: true },
    smtp: { host: 'smtphz.qiye.163.com', port: 465, secure: true },
  },
  {
    id: 'outlook365',
    label: 'Microsoft 365 / Outlook',
    note: '通常需 OAuth2；若管理员已开启基本认证可用授权码',
    imap: { host: 'outlook.office365.com', port: 993, secure: true },
    smtp: { host: 'smtp.office365.com', port: 587, secure: false },
  },
  {
    id: 'gmail',
    label: 'Google Workspace / Gmail',
    note: '需开启两步验证并使用「应用专用密码」',
    imap: { host: 'imap.gmail.com', port: 993, secure: true },
    smtp: { host: 'smtp.gmail.com', port: 465, secure: true },
  },
  {
    id: 'feishu',
    label: '飞书邮箱 / Lark',
    note: 'imap.feishu.cn:993 / smtp.feishu.cn:465',
    imap: { host: 'imap.feishu.cn', port: 993, secure: true },
    smtp: { host: 'smtp.feishu.cn', port: 465, secure: true },
  },
  {
    id: 'zoho',
    label: 'Zoho Mail',
    note: 'imappro.zoho.com:993 / smtppro.zoho.com:465',
    imap: { host: 'imappro.zoho.com', port: 993, secure: true },
    smtp: { host: 'smtppro.zoho.com', port: 465, secure: true },
  },
  {
    id: 'custom',
    label: '自定义 / 自建服务器',
    note: '按管理员提供的 IMAP / SMTP 地址与端口填写',
    imap: { host: '', port: 993, secure: true },
    smtp: { host: '', port: 465, secure: true },
  },
];
