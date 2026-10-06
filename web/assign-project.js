/**
 * 归类对话框（时间线列表与邮件详情共用一份）。
 *
 * 为什么不各写一份：两处的规则必须一致——点已有项目一键归、填新名字即新建、
 * 说明"只改本机标签、不会被自动分析覆盖"。写成两份的那天起就会开始漂移。
 */

import { api } from './api.js';
import { confirmDialog, h, toast, toastError } from './dom.js';

/**
 * 打开归类对话框。
 *
 * @param {object} opts
 * @param {string} opts.folder
 * @param {number} opts.uid
 * @param {string} opts.title 邮件标题（显示在对话框标题里）
 * @param {string} [opts.current] 当前项目名（空 = 未归类）
 * @param {Array}  [opts.projects] 已有项目；不传就现取
 * @param {Function} [opts.onDone] 写成功后的回调（用于刷新视图）
 */
export async function openAssignDialog({ folder, uid, title, current = '', projects, onDone }) {
  let list = projects;
  if (!list) {
    try {
      list = (await api.projects()).projects || [];
    } catch {
      list = [];
    }
  }

  const input = h('input', { class: 'input', type: 'text', placeholder: '新项目名（2-16 字）' });
  const busy = { value: false };

  const chips = h(
    'div',
    { class: 'row-actions flex-wrap mb-2' },
    ...list.slice(0, 24).map((p) =>
      h(
        'button',
        {
          class: 'btn btn-small',
          type: 'button',
          onclick: () => submit(p.name),
        },
        p.name,
      ),
    ),
  );

  const ok = await confirmDialog({
    title: `归类「${title || '(无主题)'}」`,
    message: h(
      'div',
      {},
      current ? h('p', { class: 'muted small', text: `当前归类：${current}` }) : null,
      list.length ? h('p', { class: 'muted small', text: '归到已有项目（一键）：' }) : null,
      list.length ? chips : null,
      h('p', { class: 'muted small', text: '或填一个新项目名：' }),
      input,
      h(
        'p',
        { class: 'muted small' },
        '归类只改本机的标签，不动邮件本身；**手工归类不会被后来的自动分析覆盖**。留空并确认可移出项目。',
      ),
    ),
    confirmText: '归到这个新项目',
  });
  if (!ok) return;
  await submit(input.value.trim());

  async function submit(project) {
    if (busy.value) return;
    busy.value = true;
    try {
      const out = await api.assignProject(folder, uid, project);
      toast(out.message || '已归类', 'success');
      await onDone?.();
    } catch (err) {
      toastError(err);
    } finally {
      busy.value = false;
    }
  }
}
