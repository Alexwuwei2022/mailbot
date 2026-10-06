/** 草稿页：左侧列表 + 右侧编辑、重新起草、存草稿箱、确认发送。 */

import { api } from '../api.js';
import { attachmentButton, confirmDialog, copyButton, fmtAddress, fmtBytes, fmtFull, fmtMailTime, h, mount, toast, toastError } from '../dom.js';
import { typeTag } from '../type-meta.js';
import { markLoaded, needsReload, renderInto, viewState } from '../view-state.js';

const STATUS_LABEL = {
  pending: '待审核',
  sending: '发送中',
  sent: '已发送',
  failed: '发送失败',
};

export function renderDrafts(root, app) {
  // 状态托管给 app：切走再切回不会丢掉正在编辑的内容与选中的草稿
  const { state } = viewState(app, 'drafts', () => ({
    loading: true,
    error: null,
    drafts: [],
    activeId: null,
    filter: 'pending',
    signature: '',
    saving: false,
    fetched: false,
    /** 三个标签的数量（不受当前筛选影响，切标签时数字不会互相归零） */
    counts: { pending: 0, sent: 0, failed: 0, all: 0 },
    quoteOriginal: true,
    quoteStyle: 'zh-client',
    /** 附件上限（编码后字节 / 最多个数），由 /api/drafts 下发 */
    attachmentMaxBytes: 20_000_000,
    maxAttachments: 10,
  }));

  const container = h('div', { class: 'view view-drafts' });
  mount(root, container);

  const paint = () => renderInto(container, app, 'drafts', paintInner, () => renderDrafts(root, app));

  const paintInner = async () => {
    const active = state.drafts.find((d) => d.id === state.activeId) || null;
    mount(
      container,
      h(
        'section',
        { class: 'page-head' },
        h(
          'div',
          {},
          h('h2', { text: '邮件草稿' }),
          h('p', { class: 'muted', text: 'AI 起草的回复。请逐封审核后再发送——发送是不可撤销操作。' }),
        ),
        h(
          'div',
          { class: 'head-actions' },
          h(
            'button',
            {
              class: 'btn',
              disabled: app.running,
              title: '按总览页选定的时间范围再跑一次分析，把新邮件补进待审核列表',
              onclick: () => analyzeMore(),
            },
            app.running ? '分析中…' : '继续分析新邮件',
          ),
        ),
      ),
      h(
        'div',
        { class: 'tabs tabs-inline' },
        ...['pending', 'sent', 'all'].map((key) => {
          const label = key === 'pending' ? '待审核' : key === 'sent' ? '已发送' : '全部';
          // 数量取全量统计：切到「已发送」时「待审核」的数字不能变成 0
          const count = key === 'pending' ? state.counts.pending + state.counts.failed : key === 'sent' ? state.counts.sent : state.counts.all;
          return h(
            'button',
            {
              class: `tab ${state.filter === key ? 'active' : ''}`,
              title: `${label}（${count} 封）`,
              onclick: async () => {
                state.filter = key;
                await refresh();
              },
            },
            label,
            h('span', { class: 'tab-badge', text: String(count) }),
          );
        }),
      ),
      state.loading
        ? h('p', { class: 'muted pad', text: '加载中…' })
        : state.error
          ? h('p', { class: 'error pad', text: state.error })
          : state.drafts.length === 0
            ? h(
                'div',
                { class: 'empty-state' },
                h('div', { class: 'empty-icon', text: '📝' }),
                h('h3', { text: state.filter === 'pending' ? '没有待审核的草稿' : '暂无草稿' }),
                h('p', { class: 'muted', text: '运行一次分析后，需要回复的邮件会自动起草。' }),
              )
            : h(
                'div',
                { class: 'draft-layout' },
                h('div', { class: 'draft-list' }, ...state.drafts.map((d) => draftListItem(d, state, paint))),
                h(
                  'div',
                  { class: 'draft-editor' },
                  signatureBanner(state, load),
                  quoteBanner(state, load),
                  active ? editor(active, state, reloadActive) : h('p', { class: 'muted pad', text: '从左侧选择一封草稿' }),
                ),
              ),
    );
  };

  /**
   * 已有草稿未带原始邮件引文时，提示并可一键补上。
   *
   * 与签名横幅同理：草稿是用户要审核的内容，不静默改写，只给显式操作。
   * 用户中途打开 `draft.quoteOriginal`、或草稿是升级前生成的，都会走到这里。
   */
  function quoteBanner(state, reload) {
    if (!state.quoteOriginal || !state.drafts.length) return null;
    const missing = state.drafts.filter((d) => d.status !== 'sent' && d.quoted !== true);
    if (!missing.length) return null;
    return h(
      'div',
      { class: 'alert alert-warn banner-row' },
      h('span', { text: `有 ${missing.length} 封草稿的正文里还没有原始邮件引文。` }),
      h(
        'button',
        {
          class: 'btn btn-small',
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            btn.textContent = '插入中…';
            try {
              const res = await api.applyQuote({ ids: missing.map((d) => d.id) });
              toast(res.message, 'success', 5000);
              app.invalidateAll();
              await reload();
            } catch (err) {
              toast(err.message, 'error');
              btn.disabled = false;
              btn.textContent = '插入原文';
            }
          },
        },
        '插入原文',
      ),
    );
  }

  /**
   * 已有草稿未带当前签名时，提示并可一键补上（不静默改写用户草稿）。
   *
   * 判断交给**服务端**（`hasSignature`）：规则是「包含当前签名，且位于引文之上」。
   * 早期在前端用 `endsWith` 判断，加了引文之后签名不再位于正文末尾，
   * 于是横幅永远消不掉、按钮点了也没反应——同一个判断只能有一处实现。
   */
  function signatureBanner(state, reload) {
    if (!state.signature || !state.drafts.length) return null;
    const missing = state.drafts.filter((d) => d.status !== 'sent' && d.hasSignature !== true);
    if (!missing.length) return null;
    const misplaced = missing.filter((d) => d.signatureMisplaced);
    return h(
      'div',
      { class: 'alert alert-warn banner-row' },
      h('span', {
        text: misplaced.length
          ? `有 ${missing.length} 封草稿的签名不在正确位置（应在引文之前），其中 ${misplaced.length} 封需要调整。`
          : `有 ${missing.length} 封草稿的正文还没有带上当前签名。`,
      }),
      h(
        'button',
        {
          class: 'btn btn-small',
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            btn.textContent = '插入中…';
            try {
              const res = await api.applySignature({ ids: missing.map((d) => d.id) });
              toast(res.message, 'success', 5000);
              app.invalidateAll();
              await reload();
            } catch (err) {
              toast(err.message, 'error');
              btn.disabled = false;
              btn.textContent = '插入签名';
            }
          },
        },
        '插入签名',
      ),
    );
  }

  /**
   * 「继续分析新邮件」：按**总览页当前选定的窗口**再跑一次分析，然后把列表刷新出来。
   *
   * 它和总览页的分析按钮是同一件事，放在这里是为了「审完这批接着看下一批」不用来回跳。
   * 早先的实现跑完只调 renderView()，而本页 load() 见到 `state.fetched` 就直接重绘，
   * 于是导航徽标变了、列表却没变——用户必须手动刷新页面才看到新草稿。
   */
  async function analyzeMore() {
    const hours = app.viewStates?.overview?.windowHours || 24;
    try {
      const r = await app.analyze({ windowHours: hours });
      // analyze() 内部已失效所有视图；这里再强制重取一次，确保列表是新的
      await refresh();
      const added = r?.drafts ?? 0;
      const skipped = r?.skippedDrafts ?? 0;
      const truncated = r?.truncation?.length ? `；有邮件超出取信上限未分析` : '';
      toast(
        `分析完成：新增 ${added} 封草稿${skipped ? `，已有草稿跳过 ${skipped} 封` : ''}${truncated}`,
        added ? 'success' : 'info',
        6000,
      );
    } catch (err) {
      toast(err.message, 'error', 8000);
    }
  }

  /**
   * 附件区：选择/拖拽文件、逐个上传、列出、删除，并显示体积预算。
   *
   * 为什么要把"编码后体积"摆在界面上：base64 会让体积涨约 1/3，
   * 一个 18 MB 的文件编码后 24 MB，超过多数企业邮箱 20 MB 的上限。
   * 如果只在发送时才报错，用户已经白等了一次上传。所以这里实时显示
   * 「已用 / 上限」，超了就把发送按钮禁掉并说明原因。
   */
  function attachmentEditor(draft, state, reload) {
    const list = Array.isArray(draft.attachments) ? draft.attachments : [];
    const maxBytes = state.attachmentMaxBytes || 20_000_000;
    const maxCount = state.maxAttachments || 10;
    // 后端给的预算优先（它读的是真实配置）；没有就用本地估算兜底
    const budget = draft.attachmentBudget || null;
    const encoded = budget ? budget.encodedBytes : list.reduce((s, a) => s + Math.ceil((a.size || 0) / 3) * 4 + 200, 0);
    const over = encoded > maxBytes;
    const readOnly = draft.status === 'sent' || draft.status === 'sending';

    const fileInput = h('input', {
      type: 'file',
      multiple: true,
      class: 'attachment-input',
      // 每次选完清空 value，否则连续选同一个文件不会触发 change
      onchange: (ev) => uploadFiles([...ev.target.files], ev.target),
    });

    /** 逐个上传：串行可以给出稳定的进度与错误归属，也避免占满带宽。 */
    async function uploadFiles(files, input) {
      if (!files.length) return;
      let okCount = 0;
      for (const file of files) {
        if (list.length + okCount >= maxCount) {
          toast(`单封草稿最多 ${maxCount} 个附件，其余已跳过`, 'error', 6000);
          break;
        }
        try {
          await api.uploadDraftAttachment(draft.id, file);
          okCount += 1;
        } catch (err) {
          toast(`「${file.name}」添加失败：${err.message}`, 'error', 8000);
        }
      }
      if (input) input.value = '';
      if (okCount) {
        toast(`已添加 ${okCount} 个附件`, 'success');
        app.invalidateAll();
        await reload();
      }
    }

    return h(
      'div',
      { class: `attachment-editor ${over ? 'is-over' : ''}`.trim() },
      h(
        'div',
        { class: 'attachment-editor-head' },
        h('span', { class: 'attachment-editor-title' }, `附件（${list.length}）`),
        h(
          'span',
          { class: 'muted small' },
          `已用 ${fmtBytes(Math.round(encoded))} / 上限 ${fmtBytes(maxBytes)}（按发送编码后计算）`,
        ),
      ),
      list.length
        ? h(
            'div',
            { class: 'attachment-list' },
            ...list.map((a) =>
              h(
                'div',
                { class: 'attachment-row' },
                h('span', { class: 'attachment-icon', text: '📎' }),
                h('span', { class: 'attachment-name', title: a.filename }, a.filename),
                h('span', { class: 'attachment-meta', text: `${a.contentType || ''} · ${fmtBytes(a.size || 0)}`.replace(/^ · /, '') }),
                attachmentButton(() => api.draftAttachmentUrl(draft.id, a.id), a.filename),
                readOnly
                  ? null
                  : h(
                      'button',
                      {
                        class: 'btn btn-small btn-danger-quiet',
                        title: '移除这个附件',
                        onclick: async (ev) => {
                          ev.stopPropagation();
                          const btn = ev.currentTarget;
                          btn.disabled = true;
                          try {
                            await api.deleteDraftAttachment(draft.id, a.id);
                            toast(`已移除附件：${a.filename}`, 'success');
                            app.invalidateAll();
                            await reload();
                          } catch (err) {
                            toast(err.message, 'error');
                            btn.disabled = false;
                          }
                        },
                      },
                      '移除',
                    ),
              ),
            ),
          )
        : h('p', { class: 'muted small attachment-empty', text: '还没有附件。' }),
      over
        ? h(
            'div',
            { class: 'alert alert-warn' },
            `附件合计编码后约 ${fmtBytes(Math.round(encoded))}，超过单封上限 ${fmtBytes(maxBytes)}。请移除部分附件，或改用压缩包/网盘链接。`,
          )
        : null,
      readOnly
        ? null
        : h(
            'div',
            { class: 'attachment-drop', ondragover: (ev) => ev.preventDefault(), ondrop: (ev) => {
              ev.preventDefault();
              uploadFiles([...((ev.dataTransfer && ev.dataTransfer.files) || [])], null);
            } },
            h('span', { class: 'muted small', text: '把文件拖到这里，或' }),
            h(
              'button',
              { class: 'btn btn-small', onclick: () => fileInput.click() },
              '选择文件',
            ),
            fileInput,
            h('span', { class: 'muted small', text: `最多 ${maxCount} 个` }),
          ),
    );
  }

  function draftListItem(d, state, paintFn) {
    const isActive = d.id === state.activeId;
    const src = d.source || {};
    const analysis = d.analysis || null;
    return h(
      'article',
      {
        class: `draft-item ${isActive ? 'active' : ''}`,
        onclick: () => {
          state.activeId = d.id;
          paintFn();
        },
      },
      h(
        'div',
        { class: 'draft-item-head' },
        h('span', { class: `status-chip status-${d.status}`, text: STATUS_LABEL[d.status] || d.status }),
        // 列表项显示**来信时间**（与总览/检索统一），不再用「9 小时前」这种相对时间
        h('span', { class: 'draft-time', text: fmtMailTime(src.date || d.createdAt) }),
      ),
      h('h4', { class: 'draft-subject', text: d.subject }),
      // 审稿时最该知道「这是回复谁的哪封」，所以把来信人一起显示出来
      h(
        'p',
        { class: 'draft-to' },
        `回复：${src.from?.name || src.from?.address || '未知发件人'}`,
        h('span', { class: 'draft-dot', text: '·' }),
        `收件人：${fmtAddress(d.to)}`,
      ),
      analysis?.type ? h('div', { class: 'draft-tags' }, typeTag(analysis.type, { h, extraClass: 'tag-quiet' }), d.quoted ? h('span', { class: 'tag tag-quiet', text: '含原文' }) : null) : null,
      d.reason ? h('p', { class: 'draft-reason', text: d.reason }) : null,
    );
  }

  function editor(draft, state, reload) {
    const dirty = { value: false };
    const toInput = h('input', { class: 'input', type: 'text', value: draft.to, oninput: () => (dirty.value = true) });
    const ccInput = h('input', { class: 'input', type: 'text', value: draft.cc || '', placeholder: '可选', oninput: () => (dirty.value = true) });
    const subjectInput = h('input', { class: 'input', type: 'text', value: draft.subject, oninput: () => (dirty.value = true) });
    const bodyArea = h('textarea', { class: 'textarea', rows: 18, oninput: () => (dirty.value = true) });
    bodyArea.value = draft.body;

    const sendBtn = h(
      'button',
      {
        class: 'btn btn-primary',
        disabled: draft.status === 'sent' || draft.status === 'sending' || attachmentOverBudget(),
        title: attachmentOverBudget() ? '附件合计超过单封上限，请先移除部分附件' : '',
        onclick: async () => {
          const current = collect();
          if (!current.to) return toast('请填写收件人', 'error');
          if (attachmentOverBudget()) return toast('附件合计超过单封上限，请先移除部分附件', 'error', 7000);
          const files = Array.isArray(draft.attachments) ? draft.attachments : [];
          const ok = await confirmDialog({
            title: '确认发送这封邮件？',
            message: h(
              'div',
              {},
              h('p', { text: '发送后无法撤回。请确认收件人、主题、正文与附件无误：' }),
              h('p', { class: 'kv' }, h('b', { text: '收件人：' }), current.to),
              current.cc ? h('p', { class: 'kv' }, h('b', { text: '抄送：' }), current.cc) : null,
              h('p', { class: 'kv' }, h('b', { text: '主题：' }), current.subject),
              // 附件必须逐项列出：发出去就撤不回来了
              files.length
                ? h(
                    'div',
                    { class: 'kv' },
                    h('b', { text: `附件（${files.length}）：` }),
                    h('ul', { class: 'confirm-attachments' }, ...files.map((a) => h('li', { text: `${a.filename}（${fmtBytes(a.size || 0)}）` }))),
                    h('p', { class: 'muted small', text: `编码后合计约 ${fmtBytes(attachmentEncodedBytes())}` }),
                  )
                : h('p', { class: 'kv' }, h('b', { text: '附件：' }), '无'),
            ),
            details: current.body.length > 900 ? `${current.body.slice(0, 900)}\n…（正文共 ${current.body.length} 字）` : current.body,
            confirmText: '确认发送',
            danger: true,
          });
          if (!ok) return;
          sendBtn.disabled = true;
          sendBtn.textContent = '发送中…';
          try {
            await api.updateDraft(draft.id, current);
            const res = await api.sendDraft(draft.id, { confirm: true, deleteMailboxDraft: true, appendToSent: true });
            // 发送后会改变「这封邮件有没有草稿、发出去没有」——总览的按钮状态依赖它
            app.invalidateAll();
            // 发送成功后草稿会从「待审核」消失、列表可能就空了。
            // 如果只弹一句 toast，用户会以为出了错——所以直接把落点说出来，并给一键跳转。
            const link = h(
              'button',
              {
                class: 'link-btn',
                onclick: () => app.navigate('drafts', { tab: 'sent', draftId: draft.id }),
              },
              '查看已发送',
            );
            const node = toast(res.message || `已发送至 ${draft.to}`, 'success', 8000);
            node.querySelector('.toast-body')?.append('　', link);
            await refresh();
          } catch (err) {
            toast(err.message, 'error');
            sendBtn.disabled = false;
            sendBtn.textContent = '确认发送';
          }
        },
      },
      '确认发送',
    );

    const saveBtn = h(
      'button',
      {
        class: 'btn',
        onclick: async (ev) => {
          const btn = ev.currentTarget;
          btn.disabled = true;
          try {
            await api.updateDraft(draft.id, collect());
            toast('草稿已保存到本地', 'success');
            dirty.value = false;
            app.invalidateAll();
            await reload();
          } catch (err) {
            toast(err.message, 'error');
          } finally {
            btn.disabled = false;
          }
        },
      },
      '保存修改',
    );

    const instructionInput = h('input', {
      class: 'input',
      type: 'text',
      placeholder: '可选：告诉 AI 怎么改，例如「更简短些，明确同意周三交付」',
    });

    function collect() {
      return {
        to: toInput.value.trim(),
        cc: ccInput.value.trim(),
        subject: subjectInput.value.trim(),
        body: bodyArea.value,
      };
    }

    /** 附件编码后的合计体积（与后端同一算法，用于实时提示与发送前拦截）。 */
    function attachmentEncodedBytes() {
      const list = Array.isArray(draft.attachments) ? draft.attachments : [];
      if (draft.attachmentBudget) return draft.attachmentBudget.encodedBytes;
      return list.reduce((s, a) => s + Math.ceil((a.size || 0) / 3) * 4 + 200, 0);
    }

    function attachmentOverBudget() {
      return attachmentEncodedBytes() > (state.attachmentMaxBytes || 20_000_000);
    }

    return h(
      'div',
      { class: 'editor-inner' },
      h(
        'div',
        { class: 'editor-head' },
        h('span', { class: `status-chip status-${draft.status}`, text: STATUS_LABEL[draft.status] || draft.status }),
        h('span', { class: 'muted small', text: `生成于 ${fmtFull(draft.createdAt)}${draft.model ? ` · ${draft.model}` : ''}${draft.confidence != null ? ` · 置信度 ${(draft.confidence * 100).toFixed(0)}%` : ''}` }),
        copyButton(() => collect().body, { label: '复制正文', className: 'btn btn-small' }),
      ),
      draft.error ? h('div', { class: 'alert alert-warn', text: draft.error }) : null,
      draft.mailbox
        ? h(
            'div',
            { class: `alert ${draft.mailbox.stale ? 'alert-warn' : 'alert-info'}` },
            draft.mailbox.stale
              ? `邮箱草稿箱里的副本已是旧版本（${draft.mailbox.folder} UID ${draft.mailbox.uid}）。点「同步到邮箱草稿箱」会替换它。`
              : `已同步到邮箱草稿箱：${draft.mailbox.folder}（UID ${draft.mailbox.uid}）`,
          )
        : null,
      draft.status === 'sent' && draft.sentAt
        ? h('div', { class: 'alert alert-ok', text: `已于 ${fmtFull(draft.sentAt)} 发送${draft.sendResult?.notes?.length ? ` · ${draft.sendResult.notes.join('；')}` : ''}` })
        : null,

      h('label', { class: 'field' }, h('span', { text: '收件人' }), toInput),
      h('label', { class: 'field' }, h('span', { text: '抄送' }), ccInput),
      h('label', { class: 'field' }, h('span', { text: '主题' }), subjectInput),
      h(
        'label',
        { class: 'field' },
        h(
          'span',
          {},
          '正文',
          h('span', { class: 'muted small', text: `　${bodyArea.value.length} 字` }),
        ),
        bodyArea,
      ),

      draft.notes?.length
        ? h(
            'div',
            { class: 'notes-box' },
            h('div', { class: 'notes-title', text: '需要你确认的事项' }),
            h('ul', {}, ...draft.notes.map((n) => h('li', { text: n }))),
          )
        : null,

      attachmentEditor(draft, state, reload),

      draft.reason ? h('div', { class: 'reason-box' }, h('b', { text: 'AI 的判断：' }), draft.reason) : null,

      h('div', { class: 'regenerate-row' }, instructionInput, h(
        'button',
        {
          class: 'btn',
          onclick: async (ev) => {
            const btn = ev.currentTarget;
            btn.disabled = true;
            btn.textContent = '重新起草中…';
            try {
              const res = await api.regenerateDraft(draft.id, instructionInput.value.trim() || undefined);
              toast(res.mailboxNote || '已重新起草', 'success', res.mailboxNote ? 7000 : 4200);
              app.invalidateAll();
              await refresh();
            } catch (err) {
              toast(err.message, 'error');
            } finally {
              btn.disabled = false;
              btn.textContent = '让 AI 重写';
            }
          },
        },
        '让 AI 重写',
      )),

      h(
        'div',
        { class: 'editor-actions' },
        sendBtn,
        saveBtn,
        h(
          'button',
          {
            class: 'btn',
            onclick: async (ev) => {
              const btn = ev.currentTarget;
              btn.disabled = true;
              try {
                await api.updateDraft(draft.id, collect());
                const res = await api.syncDraft(draft.id);
                toast(res.message || '已同步到草稿箱', 'success');
                app.invalidateAll();
                await refresh();
              } catch (err) {
                toast(err.message, 'error');
              } finally {
                btn.disabled = false;
              }
            },
          },
          '同步到邮箱草稿箱',
        ),
        h(
          'button',
          {
            class: 'btn btn-danger-quiet',
            onclick: async () => {
              const ok = await confirmDialog({
                title: '删除这封草稿？',
                message: '仅删除本地记录；已写入邮箱草稿箱的副本需要你到邮件客户端里删除。',
                confirmText: '删除',
                danger: true,
              });
              if (!ok) return;
              try {
                await api.deleteDraft(draft.id);
                toast('草稿已删除', 'success');
                state.activeId = null;
                app.invalidateAll();
                await refresh();
              } catch (err) {
                toast(err.message, 'error');
              }
            },
          },
          '删除草稿',
        ),
      ),

      sourcePanel(draft),
    );
  }

  function sourcePanel(draft) {
    const src = draft.source || {};
    const mail = draft.analysis?.mail || {};
    const context = draft.analysis?.context || [];
    return h(
      'details',
      { class: 'source-panel' },
      h('summary', { text: '查看原始来信与会话上下文' }),
      h(
        'div',
        { class: 'source-inner' },
        h('h4', { text: src.subject || '(无主题)' }),
        h(
          'p',
          { class: 'muted small' },
          `发件人：${fmtAddress(src.from)}　时间：${fmtFull(src.date)}　文件夹：${src.folder} #${src.uid}`,
        ),
        src.messageId ? h('p', { class: 'muted small mono', text: `Message-ID: ${src.messageId}` }) : null,
        mail.snippet ? h('blockquote', { class: 'quote', text: mail.snippet }) : null,
        mail.attachments?.length
          ? h('p', { class: 'muted small', text: `附件：${mail.attachments.map((a) => a.filename || a.contentType).join('、')}` })
          : null,
        context.length
          ? h(
              'div',
              {},
              h('h5', { text: '此前往来' }),
              ...context.map((c) =>
                h(
                  'div',
                  { class: 'context-item' },
                  h('div', { class: 'muted small', text: `${c.direction === 'outgoing' ? '我方发出' : '对方来信'} · ${fmtFull(c.date)} · ${fmtAddress(c.from)}` }),
                  h('pre', { class: 'context-body', text: c.body || '' }),
                ),
              ),
            )
          : h('p', { class: 'muted small', text: '没有找到更早的往来邮件。' }),
      ),
    );
  }

  async function load() {
    // 跨视图跳转参数：例如总览页点「已发送邮件」要直达「已发送」标签并选中那封草稿
    const nav = app.takeNavParams?.('drafts');
    if (nav && (nav.tab || nav.draftId)) {
      if (nav.tab) state.filter = nav.tab;
      if (nav.draftId) state.activeId = nav.draftId;
      return refresh();
    }
    // 数据在别处被改动过（新起草 / 发送 / 补签名补引文）→ 必须重取，否则看不到新草稿。
    // 否则保留现有数据，避免切回页面时冲掉正在编辑的内容。
    if (state.fetched && !needsReload(app, 'drafts')) {
      paint();
      return;
    }
    return refresh();
  }

  /** 强制重新取草稿列表（切换筛选、保存后、用户主动刷新时用）。 */
  async function refresh() {
    state.loading = !state.fetched;
    paint();
    try {
      const res = await api.drafts(state.filter === 'all' ? {} : { status: state.filter === 'sent' ? 'sent' : undefined });
      state.drafts = state.filter === 'pending' ? res.drafts.filter((d) => d.status !== 'sent') : res.drafts;
      state.signature = String(res.signature || '').replace(/\r\n/g, '\n').trimEnd();
      // 标签计数用服务端给的全量统计（不受当前筛选影响）
      state.counts = { pending: 0, sent: 0, failed: 0, all: 0, ...(res.counts || {}) };
      state.quoteOriginal = res.quoteOriginal !== false;
      state.quoteStyle = res.quoteStyle || 'zh-client';
      state.attachmentMaxBytes = res.attachmentMaxBytes || 20_000_000;
      state.maxAttachments = res.maxAttachments || 10;
      if (!state.drafts.some((d) => d.id === state.activeId)) state.activeId = state.drafts[0]?.id || null;
      state.error = null;
      state.fetched = true;
      markLoaded(app, 'drafts');
    } catch (err) {
      state.error = err.message;
      state.drafts = [];
    } finally {
      state.loading = false;
      paint();
    }
  }

  async function reloadActive() {
    if (!state.activeId) return refresh();
    try {
      const res = await api.draft(state.activeId);
      const idx = state.drafts.findIndex((d) => d.id === state.activeId);
      if (idx >= 0) state.drafts[idx] = res.draft;
      paint();
    } catch {
      await refresh();
    }
  }

  load();
  return { reload: refresh };
}
