/**
 * 测试用 Google Calendar / OAuth 模拟服务器（真实 HTTP）。
 *
 * 让日历数字人的全链路可以在完全离线的情况下被测到：
 *   POST /token                 换取/刷新令牌
 *   POST /revoke                撤销
 *   GET  /calendar/v3/users/me/calendarList
 *   GET  /calendar/v3/calendars/{id}
 *   GET  /calendar/v3/calendars/{id}/events        支持 timeMin/timeMax/q/maxResults
 *   POST /calendar/v3/calendars/{id}/events
 *   PATCH/DELETE /calendar/v3/calendars/{id}/events/{eventId}
 *   POST /calendar/v3/freeBusy
 */

import http from 'node:http';
import net from 'node:net';

const json = (res, status, body) => {
  const text = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(text);
};

function parseBody(req) {
  return new Promise((resolve) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      if (!raw) return resolve({});
      try {
        resolve(JSON.parse(raw));
      } catch {
        // form-encoded（OAuth 端点）
        const out = {};
        for (const [k, v] of new URLSearchParams(raw)) out[k] = v;
        resolve(out);
      }
    });
  });
}

let seq = 0;
const newEventId = () => `evt_${(seq += 1).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

/**
 * @param {object} options
 * @param {Array} [options.events] 初始日程，形如 { summary, start, end, allDay, location, description }
 * @param {boolean} [options.failAuth] 令牌端点是否返回 400（模拟授权失效）
 */
export async function startMockGoogle({
  port = 0,
  events = [],
  calendars,
  accessToken = 'mock-access-token',
  refreshToken = 'mock-refresh-token',
  failAuth = false,
  /** 模拟「Google Calendar API 未启用」：所有 calendar/v3 请求回 403 SERVICE_DISABLED */
  apiDisabled = false,
  projectNumber = '386604958647',
} = {}) {
  const store = {
    events: events.map((e) => {
      const id = e.id || newEventId();
      return {
        id,
        status: 'confirmed',
        summary: e.summary || '(无标题)',
        description: e.description || '',
        location: e.location || '',
        start: e.allDay ? { date: e.start } : { dateTime: e.start, timeZone: e.timeZone || 'Asia/Shanghai' },
        end: e.allDay ? { date: e.end } : { dateTime: e.end, timeZone: e.timeZone || 'Asia/Shanghai' },
        attendees: e.attendees || [],
        htmlLink: `https://calendar.google.com/event?eid=${id}`,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
        extendedProperties: e.extendedProperties || undefined,
      };
    }),
    requests: [],
    tokenCalls: [],
    revoked: [],
  };

  const calendarList =
    calendars ||
    [
      { id: 'primary', summary: '主要日历', primary: true, accessRole: 'owner', timeZone: 'Asia/Shanghai' },
      { id: 'work@group.calendar.google.com', summary: '工作', accessRole: 'writer', timeZone: 'Asia/Shanghai' },
    ];

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url || '/', 'http://127.0.0.1');
    const pathname = url.pathname;
    const body = await parseBody(req);
    store.requests.push({ method: req.method, path: pathname, query: Object.fromEntries(url.searchParams), body });

    /* ---------- OAuth ---------- */
    if (pathname === '/token') {
      store.tokenCalls.push(body);
      if (failAuth) {
        return json(res, 400, { error: 'invalid_grant', error_description: 'Token has been expired or revoked.' });
      }
      if (body.grant_type === 'authorization_code') {
        return json(res, 200, {
          access_token: accessToken,
          refresh_token: refreshToken,
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.events',
          token_type: 'Bearer',
        });
      }
      if (body.grant_type === 'refresh_token') {
        return json(res, 200, {
          access_token: `${accessToken}-refreshed`,
          expires_in: 3600,
          scope: 'https://www.googleapis.com/auth/calendar.events',
          token_type: 'Bearer',
        });
      }
      return json(res, 400, { error: 'unsupported_grant_type' });
    }
    if (pathname === '/revoke') {
      store.revoked.push(body.token);
      return json(res, 200, {});
    }

    /* ---------- 鉴权 ---------- */
    const auth = String(req.headers.authorization || '');
    if (!/^Bearer\s+/.test(auth)) {
      return json(res, 401, { error: { code: 401, message: 'Invalid Credentials', status: 'UNAUTHENTICATED' } });
    }

    // 模拟「API 未启用」：Google 会带上 extendedHelp 指向启用页面
    if (apiDisabled && pathname.startsWith('/calendar/v3/')) {
      return json(res, 403, {
        error: {
          code: 403,
          message:
            `Google Calendar API has not been used in project ${projectNumber} before or it is disabled. ` +
            `Enable it by visiting https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=${projectNumber} then retry. ` +
            'If you enabled this API recently, wait a few minutes for the action to propagate to our systems and retry.',
          status: 'PERMISSION_DENIED',
          details: [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'SERVICE_DISABLED', domain: 'googleapis.com' }],
          errors: [
            {
              message: 'Google Calendar API has not been used in the project before or it is disabled.',
              domain: 'usageLimits',
              reason: 'SERVICE_DISABLED',
              extendedHelp: `https://console.developers.google.com/apis/api/calendar-json.googleapis.com/overview?project=${projectNumber}`,
            },
          ],
        },
      });
    }

    const calMatch = pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)$/);
    const eventsMatch = pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events$/);
    const eventMatch = pathname.match(/^\/calendar\/v3\/calendars\/([^/]+)\/events\/([^/]+)$/);

    /* ---------- 日历列表 / 元信息 ---------- */
    if (pathname === '/calendar/v3/users/me/calendarList') {
      return json(res, 200, { kind: 'calendar#calendarList', items: calendarList });
    }
    if (calMatch) {
      const id = decodeURIComponent(calMatch[1]);
      const cal = calendarList.find((c) => c.id === id);
      if (!cal) return json(res, 404, { error: { code: 404, message: 'Not Found' } });
      return json(res, 200, { kind: 'calendar#calendar', id: cal.id, summary: cal.summary, timeZone: cal.timeZone });
    }

    /* ---------- 事件列表 ---------- */
    if (eventsMatch && req.method === 'GET') {
      const timeMin = url.searchParams.get('timeMin');
      const timeMax = url.searchParams.get('timeMax');
      const q = url.searchParams.get('q');
      const maxResults = Number(url.searchParams.get('maxResults') || 250);
      const pageToken = url.searchParams.get('pageToken');
      const min = timeMin ? new Date(timeMin).getTime() : -Infinity;
      const max = timeMax ? new Date(timeMax).getTime() : Infinity;
      const filtered = store.events
        .map((e, index) => ({ ...e, __seq: index }))
        .filter((e) => {
          const startMs = e.start.dateTime ? new Date(e.start.dateTime).getTime() : new Date(`${e.start.date}T00:00:00Z`).getTime();
          // 事件与窗口有交集
          const endMs = e.end.dateTime ? new Date(e.end.dateTime).getTime() : new Date(`${e.end.date}T00:00:00Z`).getTime();
          return endMs >= min && startMs <= max;
        })
        .filter((e) => (q ? `${e.summary} ${e.description}`.toLowerCase().includes(String(q).toLowerCase()) : true))
        .sort((a, b) => {
          const at = a.start.dateTime || a.start.date;
          const bt = b.start.dateTime || b.start.date;
          return String(at).localeCompare(String(bt));
        });

      /*
       * 分页：真实 Google 在结果超过 maxResults 时会返回 nextPageToken，
       * 客户端必须带 pageToken 再来取下一页。这里如实模拟，
       * 否则"忘了翻页会丢数据"这个最危险的缺陷就测不出来。
       */
      const offset = Number(pageToken || 0) || 0;
      const slice = filtered.slice(offset, offset + maxResults);
      const nextOffset = offset + slice.length;
      const nextPageToken = nextOffset < filtered.length ? String(nextOffset) : null;
      const items = slice.map(({ __seq, ...rest }) => rest);
      return json(res, 200, {
        kind: 'calendar#events',
        timeZone: 'Asia/Shanghai',
        items,
        ...(nextPageToken ? { nextPageToken } : {}),
        /** 便于断言：本次请求命中的总条数（真实 API 不返回，仅供测试参考） */
        __matched: filtered.length,
      });
    }

    /* ---------- 新建事件 ---------- */
    if (eventsMatch && req.method === 'POST') {
      if (!body.summary) return json(res, 400, { error: { code: 400, message: 'Missing title', status: 'INVALID_ARGUMENT' } });
      if (body.start?.dateTime && body.end?.dateTime && new Date(body.end.dateTime) <= new Date(body.start.dateTime)) {
        return json(res, 400, { error: { code: 400, message: 'Invalid Value: end must be after start' } });
      }
      const created = {
        id: newEventId(),
        status: 'confirmed',
        summary: body.summary,
        description: body.description || '',
        location: body.location || '',
        start: body.start,
        end: body.end,
        attendees: body.attendees || [],
        reminders: body.reminders,
        extendedProperties: body.extendedProperties,
        htmlLink: `https://calendar.google.com/event?eid=new`,
        created: new Date().toISOString(),
        updated: new Date().toISOString(),
      };
      store.events.push(created);
      return json(res, 200, { kind: 'calendar#event', ...created });
    }

    /* ---------- 更新 / 删除 ---------- */
    if (eventMatch) {
      const id = decodeURIComponent(eventMatch[2]);
      const index = store.events.findIndex((e) => e.id === id);
      if (index < 0) return json(res, 404, { error: { code: 404, message: 'Not Found' } });
      if (req.method === 'PATCH') {
        store.events[index] = { ...store.events[index], ...body, updated: new Date().toISOString() };
        return json(res, 200, { kind: 'calendar#event', ...store.events[index] });
      }
      if (req.method === 'DELETE') {
        store.events.splice(index, 1);
        res.writeHead(204);
        return res.end();
      }
      if (req.method === 'GET') {
        return json(res, 200, { kind: 'calendar#event', ...store.events[index] });
      }
    }

    /* ---------- freeBusy ---------- */
    if (pathname === '/calendar/v3/freeBusy' && req.method === 'POST') {
      return json(res, 200, { kind: 'calendar#freeBusy', timeMin: body.timeMin, timeMax: body.timeMax, calendars: { primary: { busy: [] } } });
    }

    return json(res, 404, { error: { code: 404, message: `未模拟的端点：${req.method} ${pathname}` } });
  });

  await new Promise((resolve) => server.listen(port, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    apiBase: `http://127.0.0.1:${actualPort}/calendar/v3`,
    oauthBase: `http://127.0.0.1:${actualPort}`,
    tokenBase: `http://127.0.0.1:${actualPort}`,
    store,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

/**
 * 测试用 HTTP 代理服务器。
 *
 * 覆盖两种真实代理行为：
 *   1. 普通 HTTP 目标：收到「绝对 URI」形式的请求，转发到上游（http 目标用这条路径）；
 *   2. HTTPS 目标：收到 `CONNECT host:port`，建立隧道后双向转发。
 *
 * 用它验证「填了代理之后请求真的走代理」，以及代理不通/要求认证时错误是否被翻译成可执行提示。
 *
 * @param {object} options
 * @param {string} [options.auth] 形如 `user:pass`；设置了就要求 Proxy-Authorization
 * @param {number} [options.connectStatus] 对 CONNECT 直接返回的状态码（用于模拟代理拒绝/要求认证）
 */
export async function startMockProxy({ auth = '', connectStatus = 0 } = {}) {
  const requests = [];

  const checkAuth = (req) => {
    if (!auth) return true;
    return req.headers['proxy-authorization'] === `Basic ${Buffer.from(auth).toString('base64')}`;
  };

  const server = http.createServer((req, res) => {
    requests.push({ kind: 'http', method: req.method, target: req.url });
    if (!checkAuth(req)) {
      res.writeHead(407, { 'proxy-authenticate': 'Basic realm="mock-proxy"' });
      res.end('proxy auth required');
      return;
    }
    // 绝对 URI 形式：http://host:port/path
    let target;
    try {
      target = new URL(req.url);
    } catch {
      res.writeHead(400);
      res.end('bad absolute uri');
      return;
    }
    const upstream = http.request(
      {
        hostname: target.hostname,
        port: target.port || 80,
        path: `${target.pathname}${target.search}`,
        method: req.method,
        headers: { ...req.headers, host: target.host },
      },
      (up) => {
        res.writeHead(up.statusCode || 502, up.headers);
        up.pipe(res);
      },
    );
    upstream.on('error', (err) => {
      res.writeHead(502);
      res.end(`upstream error: ${err.message}`);
    });
    req.pipe(upstream);
  });

  server.on('connect', (req, clientSocket, head) => {
    requests.push({ kind: 'connect', target: req.url, auth: req.headers['proxy-authorization'] || '' });
    if (!checkAuth(req)) {
      clientSocket.write('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    if (connectStatus) {
      clientSocket.write(`HTTP/1.1 ${connectStatus} Refused\r\n\r\n`);
      clientSocket.destroy();
      return;
    }
    const [host, port] = String(req.url).split(':');
    const upstream = net.connect(Number(port) || 443, host, () => {
      clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
      upstream.write(head);
      upstream.pipe(clientSocket);
      clientSocket.pipe(upstream);
    });
    upstream.on('error', () => clientSocket.destroy());
    clientSocket.on('error', () => upstream.destroy());
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const actualPort = server.address().port;
  return {
    port: actualPort,
    url: `http://127.0.0.1:${actualPort}`,
    requests,
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}
