/**
 * 日程分类：判断一条日程到底算哪一类占用。
 *
 * 为什么需要单独一个模块：日历里混着大量**不是会议**的条目——
 * 「在家办公」「休假」「已拒绝的会」「不占忙的提醒」「专注时间块」，
 * 以及**生活事务**（散步、纪念日、接送孩子）。不区分就全算成"忙碌时长"，
 * 报告会系统性偏高，而用户看不出哪里错了。
 *
 * ## 关于"用标题识别会议"
 *
 * 真实数据教会我们一件重要的事：**很多人根本不发会议邀请**，
 * 而是把日历当工作日志用，把与会者写进标题（"与王梓核对综调网络拓扑图"）。
 * 实测某账号一个月内 17 条日程、**0 条有参与人**，其中大半明显是会议。
 * 如果只认 `attendees`，就会得出"会议 0 场、建议减少会议"这种荒谬结论。
 *
 * 所以会议判定采用**双通道**：
 *   1. 有除我之外的参与人 → 一定是会议（Google 语义最可靠）；
 *   2. 没有参与人，但标题符合"与…讨论/核对/评审/对齐"这类模式 → 也按会议计，
 *      并在报告里**明确标注"按标题识别"**，让读者知道口径。
 *
 * 判定只用规则、不用模型：这类标签很规则，而且统计必须可复现、可解释。
 */

/** 事件种类。 */
export const EVENT_KINDS = {
  meeting: '会议',
  work: '工作事项',
  focus: '专注时间',
  life: '生活/个人事务',
  ooo: '休假/外出',
  workingLocation: '办公地点',
  allDay: '全天事项',
};

/**
 * 生活子类。
 *
 * 用户想知道"生活/个人事务到底占了我多少时间、花在哪类事上"，
 * 所以生活不是被丢掉的数据，而是**另一个视角的统计对象**。
 * 顺序即优先级：先具体（运动、家庭、医疗），后笼统。
 */
const LIFE_RULES = [
  { key: '运动健身', re: /散步|遛弯|健身|运动|跑步|游泳|羽毛球|篮球|足球|瑜伽|爬山|骑行|球馆|锻炼|徒步/i },
  { key: '家庭陪伴', re: /陪(老婆|孩子|家人|父母|老人)|接(娃|孩子)|送(娃|孩子)|家人|孩子|父母|老婆|老公|纪念日|生日|婚礼|探亲/i },
  { key: '餐饮', re: /午餐|晚餐|早餐|聚餐|茶歇|下午茶|喝咖啡/i },
  { key: '医疗健康', re: /看病|医院|体检|买药|复诊|牙医|就诊|挂号|理疗/i },
  { key: '个人事务', re: /还款|缴费|转账|报销|取快递|理发|买菜|家务|打扫|搬家|装修|办证|跑腿|银行|物业/i },
  { key: '休闲娱乐', re: /电影|演唱会|展览|旅行|出游|度假|聚会|约会|游戏|追剧|音乐/i },
  { key: '休息', re: /午休|休息|放假|调休|小憩/i },
];

/** 生活子类归类（未命中则归"其他生活事务"）。 */
export function lifeKindOf(title) {
  const text = String(title || '');
  for (const rule of LIFE_RULES) if (rule.re.test(text)) return rule.key;
  return '其他生活事务';
}

/** 标题里出现这些，说明是"和别人一起做的事" → 会议。 */
const MEETING_TITLE_RE = new RegExp(
  [
    '(与|和|跟|同)[^,，。;；]{1,14}(讨论|沟通|核对|对齐|评审|确认|汇报|交流|面谈|碰|约|开会)',
    '会议|例会|周会|月会|站会|晨会|夕会|双周会|专题会|评审会|对齐会|沟通会|交流会|座谈会|研讨会|发布会|启动会|总结会|复盘会',
    '评审|汇报|面试|面谈|访谈|答辩|宣讲',
    'sync|standup|review|workshop|meeting',
  ].join('|'),
  'i',
);

/** 标题里出现这些，说明是**个人生活**事务（不该算进工作负荷）。 */
const LIFE_TITLE_RE = new RegExp(
  [
    '散步|遛弯|健身|运动|跑步|游泳|羽毛球|篮球|足球|瑜伽|爬山|骑行',
    '午餐|晚餐|早餐|聚餐|茶歇|下午茶|喝咖啡',
    '纪念日|生日|婚礼|探亲|家庭|陪(老婆|孩子|家人|父母)|接(娃|孩子)|送(娃|孩子)',
    '看病|医院|体检|买药|复诊|牙医',
    '买菜|家务|打扫|搬家|装修|缴费|还款|转账|报销|取快递|理发',
    '电影|演唱会|展览|旅行|出游|度假|聚会|约会|游戏|追剧',
    '年假|事假|病假|调休|休息|放假',
  ].join('|'),
  'i',
);

/** 标题里出现这些，说明是**独自完成的工作**（占用时间，但不是会议）。 */
const WORK_TITLE_RE = new RegExp(
  [
    '设计|开发|编码|实现|调试|联调|重构|部署|上线|发布|运维|巡检',
    '分析|整理|梳理|汇总|复盘|评估|调研|排查|定位|处理|核对|比对',
    '撰写|编写|写|起草|拟|方案|文档|材料|报告|汇报材料|立项',
    '测试|验证|复现|压测|演练|培训|学习|看书|研究',
    '优化|改进|迭代|规划|计划|排期|总结',
    '编程|代码|接口|数据|报表|架构',
  ].join('|'),
  'i',
);

export const MEETING_BY_TITLE_NOTE = '按标题识别（该条目没有邀请参与人）';

/** 当前账号是否拒绝了该会议。只看 `self: true` 那条，避免把"别人拒绝"当成"我拒绝"。 */
export function selfDeclined(event) {
  const me = (event.attendees || []).find((a) => a.self);
  return me?.responseStatus === 'declined';
}

/** 除我之外的参与人（用于"和谁开会"统计）。 */
export function otherAttendees(event) {
  return (event.attendees || [])
    .filter((a) => !a.self && !a.resource && a.email)
    .map((a) => ({ email: a.email, name: a.displayName || a.email }));
}

/** 标题是否像"和别人的会"。 */
export function looksLikeMeetingTitle(title) {
  return MEETING_TITLE_RE.test(String(title || ''));
}

/* ------------------------------------------------------------ 从标题解析人名 */

/**
 * 「与某某讨论…」里，动词前面的部分就是人名清单。
 * 覆盖真实数据里出现的写法：与A、B讨论 / 与A和B沟通 / 与A及B核对 / 跟A确认。
 */
const TITLE_PEOPLE_RE = /(?:与|和|跟|同)\s*([^，,。；;：:]{1,40}?)\s*(?:讨论|沟通|核对|对齐|评审|确认|汇报|交流|面谈|商议|碰头|开会|洽谈|约见|座谈|对接|同步|安排)/;

/** 人名之间可能用的分隔符。 */
const NAME_SPLIT_RE = /[、，,]|及|和|与|以及|\s+/;

/** 这些不是人名，是"某类人"的说法或语气词，出现时不要当成人。 */
const NOT_A_NAME_RE = /^(大家|各位|所有人|相关|有关|对方|客户|领导|同事|团队|部门|组|我方|双方|三方)$/;

/**
 * 从活动标题里解析出参与人名。
 *
 * 为什么要做这件事：这个用户的日历**从不填参会者**，而是把名字写在标题里。
 * 因此"我的时间被谁占用最多"只能从标题拿——这是 attendees 永远给不出的答案。
 *
 * 解析规则保守优先：宁可少识别几个，也不要把"过结婚纪念日午餐"里的
 * "老婆孩子"当成工作对象。所以：
 *   - 只认「与/和/跟/同 + 名字 + 会议动词」这个结构；
 *   - 名字逐个校验长度与形态，明显不是名字的整段丢弃；
 *   - 最多取 6 个，避免把一整句话切碎。
 *
 * @param {string} title
 * @returns {string[]}
 */
export function extractPeopleFromTitle(title) {
  const text = String(title || '').replace(/\s+/g, ' ').trim();
  if (!text) return [];
  const m = TITLE_PEOPLE_RE.exec(text);
  if (!m) return [];
  const parts = m[1]
    .split(NAME_SPLIT_RE)
    .map((s) => s.trim())
    .filter(Boolean);

  const out = [];
  for (const raw of parts) {
    // 长度上限：名字/称呼一般不超过 12 字（"综维决策分析系统立项"这种是项目名，不要）
    if (raw.length > 12) continue;
    if (NOT_A_NAME_RE.test(raw)) continue;
    // 含明显的非人名信号（数字、标点、书名号）就跳过
    if (/[0-9０-９《》()（）「」【】]/.test(raw)) continue;
    if (!out.includes(raw)) out.push(raw);
    if (out.length >= 6) break;
  }
  // 一个都没识别出来时，整段也可能是"局方负责人"这类称呼
  if (!out.length && parts.length === 1 && parts[0].length <= 12 && !NOT_A_NAME_RE.test(parts[0])) out.push(parts[0]);
  return out;
}

/* ------------------------------------------------------------ 地点 */

/** 线上会议的识别线索。 */
const VIRTUAL_RE = /腾讯会议|zoom|teams|飞书|钉钉|webex|welink|线上|视频会议|电话会议|会议桥/i;

/**
 * 判断活动是线上还是线下。
 *
 * 只看"能确定的证据"：有 hangoutLink（Google Meet 链接）或地点里出现会议软件名。
 * 地点为空时返回 unknown，而不是猜成线下——猜错会把"未填"算成"到场"，结论就偏了。
 *
 * @returns {'virtual'|'onsite'|'unknown'}
 */
export function locationKind(event) {
  if (!event) return 'unknown';
  if (event.hangoutLink) return 'virtual';
  const text = `${event.location || ''} ${event.description || ''}`;
  if (VIRTUAL_RE.test(text)) return 'virtual';
  if (String(event.location || '').trim()) return 'onsite';
  return 'unknown';
}

/** 时长分层（分钟）。 */
export const DURATION_BUCKETS = [
  { id: 'short', label: '很短（<30 分钟）', max: 30 },
  { id: 'normal', label: '常规（30–60 分钟）', max: 60 },
  { id: 'long', label: '较长（1–2 小时）', max: 120 },
  { id: 'xlong', label: '超长（>2 小时）', max: Infinity },
];

/** 给一个时长（分钟）落到分层里。 */
export function durationBucket(minutes) {
  const n = Number(minutes) || 0;
  return DURATION_BUCKETS.find((b) => n <= b.max) || DURATION_BUCKETS[DURATION_BUCKETS.length - 1];
}


/** 标题是否像个人生活事务。 */
export function looksLikeLifeTitle(title) {
  return LIFE_TITLE_RE.test(String(title || ''));
}

/** 标题是否像独自完成的工作。 */
export function looksLikeWorkTitle(title) {
  return WORK_TITLE_RE.test(String(title || ''));
}

/**
 * 给一条日程定性。
 *
 * 顺序很重要：先看 Google 的语义标注（办公地点/休假/专注），
 * 再看"我拒绝了/不占忙"，再看全天，最后才按标题判断工作还是生活——
 * 顺序错了会出现"休假被算成会议"这类荒谬结论。
 *
 * ## 为什么不再用单一的 excluded
 *
 * 用户记日历的目的是**把这段时间标记为忙碌**（免得别人来占），
 * 所以"生活/个人事务"同样是他要分析的对象，不能一丢了之。
 * 于是判定拆成两个正交的问题：
 *
 *   - `occupies`：**这段时间是不是真的被占了**（计入总占用、清单、热力图）
 *   - `isWork`  ：**它算不算工作负荷**（计入会议/独自工作/专注、工作负荷比例）
 *
 * 「和老婆孩子过结婚纪念日午餐」→ occupies=true、isWork=false：
 * 它占了我的时间（要统计），但不是工作（不污染工作负荷口径）。
 *
 * 真正**一条都不算**的只有四种，因为它们描述的不是"我被占用的时间段"：
 * 已取消、我明确标了"不占忙"、我已拒绝的会、以及办公地点标注（通常跨全天，计入会严重虚增）。
 *
 * @returns {{kind: string, occupies: boolean, isWork: boolean, reason: string, byTitle?: boolean}}
 */
export function classifyEvent(event) {
  if (!event) return { kind: 'life', occupies: false, isWork: false, reason: '无效条目' };
  if (event.status === 'cancelled') return { kind: 'life', occupies: false, isWork: false, reason: '已取消' };

  const type = String(event.eventType || 'default');
  if (type === 'workingLocation') {
    return { kind: 'workingLocation', occupies: false, isWork: false, reason: '办公地点标注（通常跨全天，计入会虚增）' };
  }
  // 休假/外出：不是工作，但**确实占了这段时间**（人不在），所以计入占用、单独统计
  if (type === 'outOfOffice') {
    return { kind: 'ooo', occupies: true, isWork: false, reason: '', lifeKind: '休假/外出' };
  }
  if (type === 'focusTime') return { kind: 'focus', occupies: true, isWork: true, reason: '' };

  if (String(event.transparency) === 'transparent') {
    // 用户自己标了"不占忙"，那就是没占
    return { kind: event.allDay ? 'allDay' : 'life', occupies: false, isWork: false, reason: '已标记为不占忙' };
  }
  if (selfDeclined(event)) {
    return { kind: event.allDay ? 'allDay' : 'meeting', occupies: false, isWork: false, reason: '我已拒绝' };
  }
  // 全天事项：占"这一天有安排"，但小时数不计（否则一天能被算成 24 小时）
  if (event.allDay) return { kind: 'allDay', occupies: true, isWork: false, reason: '', allDayOnly: true };

  const title = event.summary || '';
  // 1) 有别人参与 → 铁定是会议
  if (otherAttendees(event).length > 0) return { kind: 'meeting', occupies: true, isWork: true, reason: '' };
  // 2) 生活事务优先于工作判定："和老婆孩子过结婚纪念日午餐"里也含"午餐/纪念日"
  if (looksLikeLifeTitle(title)) {
    return { kind: 'life', occupies: true, isWork: false, reason: '', lifeKind: lifeKindOf(title) };
  }
  // 3) 无参与人但标题像会议 → 按会议计，并标注识别方式
  if (looksLikeMeetingTitle(title)) return { kind: 'meeting', occupies: true, isWork: true, reason: '', byTitle: true };
  // 4) 标题像独自工作 → 工作事项（占时间，但不是会议）
  if (looksLikeWorkTitle(title)) return { kind: 'work', occupies: true, isWork: true, reason: '' };
  // 5) 兜底：当成个人安排，占时间但不是会议
  return { kind: 'work', occupies: true, isWork: true, reason: '' };
}

/**
 * 一次分类所有事件。
 *
 * 返回两组信息：
 *   - `kept`：**占用了时间**的条目（含生活事务），供统计占用与列清单；
 *   - `notOccupied`：真正被丢弃的条目及原因（取消/不占忙/已拒绝/办公地点标注）。
 *
 * @returns {{kept, excluded, excludedReasons, meetingsByTitle, meetingsByAttendees, occupied, lifeCount, workCount}}
 */
export function classifyEvents(events) {
  const kept = [];
  const excludedReasons = {};
  let excluded = 0;
  let occupied = 0;
  let lifeCount = 0;
  let workCount = 0;
  let meetingsByTitle = 0;
  let meetingsByAttendees = 0;

  for (const e of events || []) {
    const c = classifyEvent(e);
    if (!c.occupies) {
      excluded += 1;
      excludedReasons[c.reason] = (excludedReasons[c.reason] || 0) + 1;
      continue;
    }
    occupied += 1;
    if (c.kind === 'life' || c.kind === 'ooo') lifeCount += 1;
    if (c.isWork && !c.allDayOnly) workCount += 1;
    if (c.kind === 'meeting') {
      if (c.byTitle) meetingsByTitle += 1;
      else meetingsByAttendees += 1;
    }
    kept.push({ ...e, kind: c.kind, isWork: !!c.isWork, lifeKind: c.lifeKind || null, meetingByTitle: !!c.byTitle });
  }
  return { kept, excluded, excludedReasons, meetingsByTitle, meetingsByAttendees, occupied, lifeCount, workCount };
}

/** 只统计真正的"会议"。 */
export function isMeeting(event) {
  return event?.kind === 'meeting';
}
