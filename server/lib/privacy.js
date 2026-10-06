/**
 * 数据出境：哪些内容会离开这台电脑、发到哪里，以及"仅本地模式"的硬拦截。
 *
 * ## 为什么要把这件事写成一个模块
 *
 * 交付给别人时，对方一定会问"我的邮件去哪了"。这个问题不能靠文档里写一段
 * 泛泛的"会调用大模型"来回答，而要能**按当前配置逐项说清**：
 * 送到哪个地址、送的是正文还是摘要、有没有走代理。
 * 所以这里的原则是：**报告从真实配置推导**，而不是抄一份写死的说明——
 * 用户改了模型地址，报告里的主机名必须跟着变。
 *
 * ## 仅本地模式的边界（重要，别搞混）
 *
 * `llm.localOnly = true` 时只允许**回环地址**（localhost / 127.0.0.1 / ::1）。
 *
 * 为什么不允许 `192.168.x.x` 这种私有网段？因为那是**另一台电脑**——
 * 把邮件正文发给它，数据已经离开了本机。Ollama 跑在同一台机器上是用回环地址的；
 * 如果你确实把模型跑在局域网的另一台机器上，那就不该开"仅本地模式"
 * （界面会明确告诉你怎么改）。
 */

import { AppError, log } from './util.js';

/** 回环地址：这些才叫"数据没离开这台机器" */
export function isLoopbackHost(hostname) {
  const h = String(hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
  return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0';
}

/** 私有/局域网地址：同一网络里的**另一台机器** */
export function isPrivateLanHost(hostname) {
  const h = String(hostname || '');
  return (
    /^10\./.test(h) ||
    /^192\.168\./.test(h) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
    /^169\.254\./.test(h) ||
    /\.local$/i.test(h)
  );
}

/**
 * 仅本地模式下的裁决。
 *
 * @returns {{allowed: boolean, host: string|null, kind: 'loopback'|'lan'|'public'|'invalid', message: string}}
 */
export function localOnlyVerdict(baseUrl) {
  let host = null;
  try {
    host = new URL(String(baseUrl || '')).hostname;
  } catch {
    return { allowed: false, host: null, kind: 'invalid', message: `大模型地址无法解析：${baseUrl || '(空)'}` };
  }
  if (isLoopbackHost(host)) return { allowed: true, host, kind: 'loopback', message: `只在本机（${host}）' 处理` };
  if (isPrivateLanHost(host)) {
    return {
      allowed: false,
      host,
      kind: 'lan',
      message:
        `已阻止：${host} 是局域网里的**另一台机器**，把邮件正文发过去等于数据离开了本机。` +
        '若你的模型确实跑在那台机器上，请到「设置 → 数据去向」关掉「仅本地模式」（并知悉这一后果）。',
    };
  }
  return {
    allowed: false,
    host,
    kind: 'public',
    message:
      `已阻止：${host} 是公网服务，邮件正文会离开本机并经过第三方服务器。` +
      '想继续用它，请到「设置 → 数据去向」关掉「仅本地模式」。',
  };
}

/**
 * 在发请求之前把关。仅本地模式**只在这里判断**，所以不存在"某个调用点忘了检查"。
 *
 * `llmConfig` 是**大模型那一段配置**（`config.llm`）——所有调用点都是这么传的
 * （`new LlmClient(config.llm)`）。为了让"不小心传了整个 config"也不至于失效，
 * 这里同时认 `llmConfig.llm.localOnly`：安全开关**宁可多拦，不可漏拦**。
 */
export function assertEgressAllowed(llmConfig, baseUrl) {
  const localOnly = llmConfig?.localOnly === true || llmConfig?.llm?.localOnly === true;
  if (!localOnly) return;
  const verdict = localOnlyVerdict(baseUrl);
  if (verdict.allowed) return;
  throw new AppError(verdict.message, {
    code: 'LLM_LOCAL_ONLY_BLOCKED',
    status: 400,
    detail: { host: verdict.host, kind: verdict.kind, localOnly: true },
  });
}

/**
 * 数据去向报告：按**真实配置**逐项说明。
 *
 * 每一项都写清"发什么"和"发给谁"，以及"不发什么"——
 * 后者同样重要：用户最担心的往往是附件内容会不会被传出去。
 */
export function egressReport({ config } = {}) {
  const llm = config?.llm || {};
  const host = (() => {
    try {
      return new URL(String(llm.baseUrl || '')).hostname;
    } catch {
      return null;
    }
  })();
  const localOnly = llm.localOnly === true;
  const verdict = llm.baseUrl ? localOnlyVerdict(llm.baseUrl) : null;
  const bodyChars = config?.scan?.bodyCharsForLlm || 4000;
  const cal = config?.calendar || {};
  const notify = config?.notify || {};

  const items = [
    {
      feature: '分析邮件',
      enabled: !!llm.apiKey || localOnly,
      destination: llm.baseUrl || '（未配置）',
      destinationKind: verdict?.kind || null,
      sends: [
        '邮件主题',
        '发件人 / 收件人 / 抄送地址',
        '正文（**截取前 ' + bodyChars + ' 个字符**，可调）',
        '附件**文件名**',
        '邮件时间',
      ],
      notSends: ['附件内容（文件本身不会被上传）', '你邮箱的密码/授权码（只用于连 IMAP/SMTP，绝不发给模型）'],
    },
    {
      feature: '起草回复',
      enabled: !!llm.apiKey || localOnly,
      destination: llm.baseUrl || '（未配置）',
      destinationKind: verdict?.kind || null,
      sends: ['同上（这封来信的主题、地址、正文片段）', '你的签名与起草偏好（语气/语言）', '你手动补充的指令'],
      notSends: ['历史邮件全文（只带必要的线程上下文）'],
    },
    {
      feature: '对话查邮件',
      enabled: !!llm.apiKey || localOnly,
      destination: llm.baseUrl || '（未配置）',
      destinationKind: verdict?.kind || null,
      sends: ['你输入的问题', '命中的邮件片段（用于回答问题）'],
      notSends: ['未命中的邮件'],
    },
    {
      feature: '日历（Google）',
      enabled: !!cal.enabled,
      destination: cal.enabled ? 'Google Calendar API（googleapis.com）' : '（未启用）',
      destinationKind: cal.enabled ? 'public' : null,
      sends: cal.enabled ? ['日程标题、时间、地点、描述、参与者邮箱'] : [],
      notSends: cal.enabled ? ['邮件正文（日历功能不会读取邮件）'] : [],
    },
    {
      feature: '自寄简报',
      enabled: !!notify.email,
      destination: notify.email ? notify.emailTo || '你自己的邮箱' : '（未启用）',
      destinationKind: 'mail',
      sends: notify.email ? ['统计数字与你要求写进简报的要点'] : [],
      notSends: ['原始邮件内容'],
    },
    {
      feature: '网络代理',
      enabled: !!(cal.proxy || config?.llm?.proxy),
      destination: cal.proxy || config?.llm?.proxy || '（未配置）',
      destinationKind: 'proxy',
      sends: ['经它转发的上述请求（代理可见明文请求内容，若是 HTTP 代理）'],
      notSends: [],
    },
  ];

  return {
    localOnly,
    llmHost: host,
    llmKind: verdict?.kind || null,
    llmAllowed: verdict ? verdict.allowed : false,
    /** 仅本地模式开着、而地址却不是本机 → 现在调用模型会直接失败（这是有意的） */
    blocked: localOnly && verdict ? !verdict.allowed : false,
    bodyCharsForLlm: bodyChars,
    items,
    /** 永远不出本机的数据（说清楚能让人放心） */
    stays: [
      '邮箱授权码 / 大模型 API Key / Google 令牌（除非你自己导出包含密钥的备份包）',
      '邮件原文归档（data/raw）与附件文件：只留在本机磁盘上',
      '分析结果、草稿、简报、操作台账（data/ 目录）',
      '界面访问令牌与登录会话',
    ],
  };
}

/** 记录一次"因仅本地模式被拦下"（便于排查"为什么分析不动了"）。 */
export function logEgressBlock(config, baseUrl) {
  const v = localOnlyVerdict(baseUrl);
  log.warn(`仅本地模式已阻止向 ${v.host || baseUrl} 发送邮件内容（${v.kind}）`);
}
