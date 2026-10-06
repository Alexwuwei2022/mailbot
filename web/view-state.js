/**
 * 视图状态持久化。
 *
 * 视图在导航切换时会被重新渲染。若每次都重建内部 state，用户切走再切回就会丢掉
 * 全部界面上下文——最典型的是日历页的**对话记录**与「待写入的日程」，
 * 以及草稿页未保存的编辑内容。
 *
 * 因此每个视图把自己的 state 托管给 app.viewStates，重绘时复用同一份对象；
 * 只有需要「每次都取值」的数据（如邮箱设置）才在每次渲染时重新拉取。
 */

/**
 * @param {object} app 主应用对象（提供 viewStates 容器）
 * @param {string} key 视图标识
 * @param {() => object} create 首次进入时的初始状态
 * @returns {{state: object, hydrated: boolean}} hydrated=false 表示这是首次渲染
 */
export function viewState(app, key, create) {
  if (!app.viewStates) app.viewStates = {};
  const existing = app.viewStates[key];
  if (existing) return { state: existing, hydrated: true };
  const fresh = create();
  app.viewStates[key] = fresh;
  return { state: fresh, hydrated: false };
}

/**
 * 统一渲染失败兜底：状态持久化意味着一次坏状态会被反复重绘，
 * 所以这里保证任何视图崩掉都只显示一条可恢复的错误，而不是整页白屏。
 */
export function renderInto(container, app, key, paintFn, resetFn) {
  try {
    paintFn();
  } catch (err) {
    const message = err?.message || String(err);
    container.innerHTML = '';
    const box = document.createElement('div');
    box.className = 'empty-state';
    const icon = document.createElement('div');
    icon.className = 'empty-icon';
    icon.textContent = '⚠️';
    const title = document.createElement('h3');
    title.textContent = '这个页面渲染出错了';
    const detail = document.createElement('p');
    detail.className = 'muted';
    detail.textContent = message;
    const btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = '重置该页面并重试';
    btn.addEventListener('click', () => {
      if (app.viewStates) delete app.viewStates[key];
      resetFn?.();
    });
    box.append(icon, title, detail, btn);
    container.append(box);
  }
}

/* ------------------------------------------------------------ 缓存失效 */

/*
 * 为什么需要这套机制：视图状态是**跨导航保留**的（为了不丢对话记录、滚动位置、
 * 正在编辑的正文），代价是「数据取过一次就不再取」。这对只读展示没问题，
 * 但总览页的按钮状态（这封邮件有没有草稿、草稿发了没有）**会被别的页面改写**：
 * 在草稿页点了「确认发送」，回总览却还显示「起草回复」，用户会以为按钮坏了。
 *
 * 实现用「数据版本号」而不是一次性标记：
 * 最初用 `Set` + 通配符 `'*'`，结果是**第一个渲染的视图就把通配符消费掉了**，
 * 其余视图再也看不到失效信号——发送后在草稿页刷新，回到总览仍是旧按钮。
 * （这正是前端渲染测试第二次跑就抓到的 bug。）
 * 版本号的语义是：任何变更都让全局版本 +1；每个视图记住自己"在哪个版本加载过"，
 * 两者不一致就重新取数。这样每个视图各自消费，互不影响。
 */

/** 声明数据已变更。任何会改数据的操作结束后都要调用。 */
export function invalidateAll(app) {
  app.dataVersion = (app.dataVersion || 0) + 1;
}

/** 只让某一个视图的数据过期（例如总览切换了时间窗口）。 */
export function invalidate(app, key) {
  if (!app.viewLoadedAt) app.viewLoadedAt = {};
  app.viewLoadedAt[key] = -1;
}

/** 该视图是否需要重新取数。 */
export function needsReload(app, key) {
  const version = app.dataVersion || 0;
  const loaded = app.viewLoadedAt?.[key];
  if (loaded === undefined) return true; // 从未加载过
  return loaded !== version;
}

/**
 * 记录「该视图已在当前数据版本下加载完成」。
 * 必须在**取数成功之后**调用，否则取数失败会被误当成已刷新。
 */
export function markLoaded(app, key) {
  if (!app.viewLoadedAt) app.viewLoadedAt = {};
  app.viewLoadedAt[key] = app.dataVersion || 0;
}

/** 旧命名（语义等同 needsReload，不做任何清除动作）。 */
export function consumeStale(app, key) {
  return needsReload(app, key);
}
