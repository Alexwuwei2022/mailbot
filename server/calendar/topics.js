/**
 * 日程主题归类。
 *
 * 放在共享模块里而不是某个路由文件里：日历知识库与「回顾分析」都要用，
 * 两处各写一份必然慢慢分叉，出现"同一个会在一处算例会、在另一处算评审"。
 *
 * 归类是**关键词规则**、不是模型判断——主题统计要可复现、可解释，
 * 而且这些标签本来就很规则（周会/站会/评审/面试）。
 */

const RULES = [
  // 会议类
  { key: '例会', re: /周会|例会|站会|晨会|夕会|双周会|月会|sync|standup|daily/i },
  { key: '评审', re: /评审|review|验收|方案讨论|技术方案/i },
  { key: '客户/外部', re: /客户|拜访|接待|商务|厂商|供应商|合作伙伴|外部/i },
  { key: '面试招聘', re: /面试|招聘|候选人/i },
  { key: '培训分享', re: /培训|分享|宣讲|沙龙/i },
  { key: '出差', re: /出差|行程|差旅/i },
  { key: '一对一', re: /1on1|1v1|一对一|one on one/i },
  // 独自工作类——很多人把日历当工作日志用，这些类别才反映真实时间去向
  { key: '开发实现', re: /开发|编码|实现|调试|联调|重构|部署|上线|发布|编程|接口|脚本|应用|系统|平台/i },
  { key: '方案设计', re: /设计|架构|方案|规划|排期|计划|立项|需求/i },
  { key: '分析整理', re: /分析|整理|梳理|汇总|评估|调研|复盘|总结|比对|核对|数据|报表/i },
  { key: '问题处理', re: /排查|定位|处理|修复|运维|巡检|压测|演练|故障|告警/i },
  { key: '材料汇报', re: /材料|文档|报告|汇报|撰写|起草|拟|PPT|稿/i },
  { key: '学习提升', re: /学习|研究|看书|阅读|啃|探索/i },
  { key: '协调推进', re: /协调|对接|跟进|推动|沟通|联络|催|讨论|商议|碰头|对齐/i },
  { key: '交付/截止', re: /截止|deadline|交付|提交/i },
];

/**
 * 把事件按主题分组。
 * @param {Array} events
 * @param {object} [options] { maxSamples } 每组保留几个标题样例（供报告引用）
 */
export function groupEventTopics(events, { maxSamples = 4 } = {}) {
  const buckets = new Map();
  for (const e of events || []) {
    const text = `${e.summary || ''} ${e.location || ''}`;
    let key = '其他';
    for (const rule of RULES) {
      if (rule.re.test(text)) {
        key = rule.key;
        break;
      }
    }
    const bucket = buckets.get(key) || { topic: key, count: 0, minutes: 0, samples: [] };
    bucket.count += 1;
    if (bucket.samples.length < maxSamples && e.summary) bucket.samples.push(e.summary);
    buckets.set(key, bucket);
  }
  return [...buckets.values()].sort((a, b) => b.count - a.count);
}
