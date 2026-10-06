/**
 * 登录页。
 *
 * 什么时候出现：服务端配了访问令牌，而当前浏览器还没有有效会话。
 *
 * 设计上刻意很简单：**一个输入框 + 一个按钮**。这里没有用户名——令牌就是全部凭据；
 * 也没有"记住我"——登录成功后服务端会下发一个 HttpOnly Cookie，
 * 关掉浏览器再打开仍然有效（默认空闲 12 小时过期），所以不需要前端再存任何东西。
 */

import { api, getToken, login } from '../api.js';
import { h, mount, toastError } from '../dom.js';

export function renderLogin(root, app) {
  const container = h('div', { class: 'login-wrap' });
  mount(root, container);
  paint();

  function paint(message) {
    const input = h('input', {
      class: 'input',
      type: 'password',
      placeholder: '访问令牌',
      // 旧版本可能还在 localStorage 里留着令牌，直接填进去省得用户再找
      value: getToken() || '',
      autofocus: true,
      onkeydown: (ev) => {
        if (ev.key === 'Enter') submit();
      },
    });
    const btn = h('button', { class: 'btn btn-primary btn-block', onclick: submit }, '登录');
    const err = h('p', { class: 'error small', text: message || '' });

    async function submit() {
      const value = input.value.trim();
      if (!value) {
        err.textContent = '请输入访问令牌';
        input.focus();
        return;
      }
      btn.disabled = true;
      btn.textContent = '登录中…';
      err.textContent = '';
      try {
        await login(value);
        app.boot?.();
      } catch (e) {
        err.textContent = e?.message || '登录失败';
        btn.disabled = false;
        btn.textContent = '登录';
        input.select();
      }
    }

    mount(
      container,
      h(
        'div',
        { class: 'login-card' },
        h('div', { class: 'login-brand' }, h('span', { class: 'login-dot' }), h('b', { text: '轻效 · Ease & Effect' })),
        h('h2', { class: 'login-title', text: '需要访问令牌' }),
        h(
          'p',
          { class: 'muted small' },
          '这个服务设置了访问令牌。令牌在服务端「设置 → 访问与安全」里可以看到或重新生成；' +
            '登录后浏览器只保存一个短期会话（不保存令牌本身）。',
        ),
        input,
        btn,
        err,
        h(
          'details',
          { class: 'login-help' },
          h('summary', { text: '令牌是什么？去哪找？' }),
          h(
            'ol',
            { class: 'small muted' },
            h('li', { text: '令牌是启动服务时自动生成的一串随机字符，等同于这个服务的密码。' }),
            h('li', { text: '它在服务器的设置页「访问与安全」里显示（只在本机可见）。' }),
            h('li', { text: '也可以直接看 data/config.json 里的 web.authToken，或在 .env 里设 MAILBOT_WEB_TOKEN。' }),
            h('li', { text: '忘了也没关系：在服务器上重新生成即可，代价是所有设备都要重新登录。' }),
          ),
        ),
      ),
    );
  }
}
