/* ============================================================================
 * 后台三页共用的 Vue 层 (报价后台 / 改动记录 / 用户管理)
 *
 * 用的是 Vue 3 的 global build (IIFE), 没有构建步骤:
 *   - <script src="/vue.global.prod.js"></script>  -> 全局 Vue
 *   - 改完刷新就生效, 不用 npm / vite
 *
 * 为什么不用 ESM / 构建:
 *   前台 index.html 必须支持 file:// 双击离线打开, 而 file:// 下
 *   <script type="module"> 会被浏览器 CORS 拦掉, 只有 IIFE 的 global build 能用。
 * ========================================================================== */
(function (global) {
  'use strict';

  const { createApp, ref, reactive, computed, watch, onMounted, nextTick } = global.Vue;

  /* ---------------------------------------------------------------- API */
  async function api(path, opts) {
    opts = opts || {};
    const init = {
      method: opts.method || 'GET',
      credentials: 'same-origin',
      headers: Object.assign({}, opts.body ? { 'Content-Type': 'application/json' } : {}, opts.headers || {}),
    };
    if (opts.body) init.body = JSON.stringify(opts.body);
    const r = await fetch(path, init);
    const txt = await r.text();
    let j = null;
    try { j = txt ? JSON.parse(txt) : null; } catch (e) { j = null; }
    if (!r.ok) throw new Error((j && j.error) || ('HTTP ' + r.status));
    return j;
  }

  /* ------------------------------------------------------------- 小工具 */
  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"']/g, c =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  }
  function fmtTime(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    return isNaN(d.getTime()) ? String(iso) : d.toLocaleString('zh-CN');
  }
  function fmtMoney(n) {
    if (n === null || n === undefined || isNaN(n)) return '–';
    return Number(n).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function fmtTimeAgo(iso) {
    if (!iso) return '—';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return String(iso);
    const s = Math.floor((Date.now() - d.getTime()) / 1000);
    if (s < 60) return '刚刚';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    if (s < 86400 * 30) return Math.floor(s / 86400) + ' 天前';
    return d.toLocaleDateString('zh-CN');
  }

  /* ------------------------------------------------------- 分页状态 mixin */
  /** 统一的分页逻辑: 每页条数 / 页码 / 总数, 越界自动回退 */
  function usePaging(opts) {
    opts = opts || {};
    const PAGE = ref(1);
    const PAGE_SIZE = ref(opts.pageSize || 10);
    const TOTAL = ref(0);
    const PAGES = computed(() => Math.max(1, Math.ceil(TOTAL.value / PAGE_SIZE.value)));
    const OFFSET = computed(() => (PAGE.value - 1) * PAGE_SIZE.value);
    function setTotal(n) {
      TOTAL.value = n || 0;
      if (PAGE.value > PAGES.value) PAGE.value = PAGES.value;
      if (PAGE.value < 1) PAGE.value = 1;
    }
    function reset() { PAGE.value = 1; }
    watch(PAGE_SIZE, () => { PAGE.value = 1; });
    return { PAGE, PAGE_SIZE, TOTAL, PAGES, OFFSET, setTotal, reset };
  }

  /**
   * 登录态 —— 三态: checking / in / out
   *
   * 为什么需要 checking:
   *   以前只用 logged (布尔), 初始 false。Vue 第一次渲染就会把登录框画出来,
   *   等 /api/me 返回才隐藏 —— 每次刷新/跳页都会「闪一下登录框」。
   *   (2026-11-10 Berg 反馈)
   *
   * 用法:
   *   const { logged, checking, me, afterLogin } = A.useAuth(async () => {
   *     page.value = 1;
   *     await load();
   *   });
   *
   * 模板:
   *   <template v-if="checking">      <div class="gate"><p>正在检查登录状态…</p></div> </template>
   *   <template v-else-if="!logged">  <LoginGate ... @login="afterLogin" /> </template>
   *   <template v-else>               ...页面内容... </template>
   */
  function useAuth(onLoggedIn) {
    const logged = ref(false);
    const checking = ref(true);
    const me = ref({ user: '', role: '' });

    async function afterLogin() {
      try {
        const j = await api('/api/me');
        // 注意: checking 要等 /api/me 返回之后再置 false。
        // 提前置 false 会让登录框在 /api/me 还没回来时就渲染出来 —— 闪一下。
        checking.value = false;
        if (!j || !j.user) { logged.value = false; return; }   // 匿名: user 是 null
        me.value = { user: j.user || j.username || '', role: j.role || '' };
        logged.value = true;
        if (onLoggedIn) await onLoggedIn();
      } catch (e) {
        checking.value = false;
        logged.value = false;
      }
    }

    function reset() {
      logged.value = false;
      checking.value = false;      // 退出后别停在「检查中」
      me.value = { user: '', role: '' };
    }

    return { logged, checking, me, afterLogin, reset };
  }

  /* ------------------------------------------------------------ 组件们 */

  /** 页头: 标题 + 版本 + 右侧操作 + 用户菜单 */
  const AppHeader = {
    props: {
      title: { type: String, default: '' },
      version: { type: String, default: '' },
      user: { type: String, default: '' },
      role: { type: String, default: '' },
      badge: { type: Number, default: 0 },
      links: { type: Array, default: () => [] },   // [{href, text}]
      refresh: { type: Boolean, default: false },
    },
    emits: ['logout', 'password', 'refresh'],
    setup(props, { emit }) {
      const open = ref(false);
      function toggle(e) { e.stopPropagation(); open.value = !open.value; }
      document.addEventListener('click', () => { open.value = false; });
      onMounted(() => {
        document.addEventListener('keydown', e => { if (e.key === 'Escape') open.value = false; });
      });
      const roleCn = computed(() => props.role === 'admin' ? '管理员' : '普通用户');
      // 导航项: 当前页高亮。
      // 排除两类: 带「←」的是「返回」按钮; 「用户管理」是账号级功能,
      // 放在右上角用户名菜单里, 不占主导航位 (用户明确要求)。
      const nav = computed(() => {
        const here = location.pathname.replace(/\/$/, '');
        return props.links
          .filter(l => !/^←/.test(l.text) && l.text !== '用户管理')
          .map(l => ({ ...l, on: here === l.href.replace(/\/$/, '') }));
      });
      const back = computed(() => props.links.find(l => /^←/.test(l.text)) || null);
      return { open, toggle, roleCn, emit, nav, back };
    },
    template: `
      <header>
        <span class="hmark"><i></i><i></i><i></i><i></i></span>
        <h1>{{ title }}</h1>
        <nav class="hnav" v-if="nav.length">
          <a v-for="l in nav" :key="l.href" class="hn" :class="{on: l.on}" :href="l.href">{{ l.text }}</a>
        </nav>
        <span class="spacer"></span>
        <a v-if="back" class="tb back" :href="back.href">{{ back.text }}</a>
        <span class="tag" v-if="version">{{ version }}</span>
        <span class="badge" :class="{show: badge > 0}">{{ badge > 99 ? '99+' : badge }}</span>
        <button v-if="refresh" @click="emit('refresh')">刷新</button>
        <span class="usermenu" v-if="user">
          <button class="userchip" @click="toggle">
            <span class="avatar">{{ user.charAt(0) }}</span>
            <span>{{ user }}</span>
            <span class="caret">▾</span>
          </button>
          <div class="dropdown" :class="{open: open}" @click.stop>
            <div class="dd-head">
              <div class="dd-user">{{ user }}</div>
              <div class="dd-role">{{ roleCn }}</div>
            </div>
            <a class="dd-item" href="/admin"><span>后台改价</span></a>
            <a class="dd-item" href="/admin/changes"><span>改动记录</span></a>
            <a class="dd-item" href="/admin/users" v-if="role === 'admin'"><span>用户管理</span></a>
            <div class="dd-sep"></div>
            <button class="dd-item" @click="emit('password')"><span>修改密码</span></button>
            <button class="dd-item danger" @click="emit('logout')"><span>退出登录</span></button>
          </div>
        </span>
      </header>
    `,
  };

  /** 登录门: 用户名密码 + 错误提示 */
  const LoginGate = {
    props: { msg: { type: String, default: '' } },
    emits: ['login'],
    setup(props, { emit }) {
      const username = ref('');
      const password = ref('');
      const err = ref('');
      const busy = ref(false);
      async function submit() {
        if (!username.value.trim() || !password.value) {
          err.value = '用户名和密码都要填';
          return;
        }
        err.value = '';
        busy.value = true;
        try {
          await api('/api/login', { method: 'POST', body: { username: username.value.trim(), password: password.value } });
          emit('login');
        } catch (e) {
          err.value = e.message;
        } finally {
          busy.value = false;
        }
      }
      return { username, password, err, busy, submit };
    },
    template: `
      <div class="gate">
        <h2>请先登录</h2>
        <p>{{ msg || '登录后可以查看和管理报价数据。' }}</p>
        <label>用户名<input v-model="username" autocomplete="username" @keyup.enter="submit"></label>
        <label>密码<input v-model="password" type="password" autocomplete="current-password" @keyup.enter="submit"></label>
        <div class="err">{{ err }}</div>
        <div class="row">
          <button class="primary" style="flex:1" :disabled="busy" @click="submit">
            {{ busy ? '登录中…' : '登录' }}
          </button>
        </div>
      </div>
    `,
  };

  /** 翻页条: 每页条数 + 首页/上一页/页码/下一页/末页 */
  const Pager = {
    props: {
      page: { type: Number, required: true },
      pages: { type: Number, required: true },
      total: { type: Number, default: 0 },
      size: { type: Number, required: true },
      sizes: { type: Array, default: () => [10, 20, 30, 50, 100, 200, 500] },
      info: { type: String, default: '' },
      unit: { type: String, default: '条' },     // 每页 N 个什么
    },
    emits: ['update:page', 'update:size'],
    setup(props, { emit }) {
      const canPrev = computed(() => props.page > 1);
      const canNext = computed(() => props.page < props.pages);
      function go(p) { if (p >= 1 && p <= props.pages && p !== props.page) emit('update:page', p); }
      function setSize(e) { emit('update:size', Number(e.target.value)); }
      return { canPrev, canNext, go, setSize };
    },
    template: `
      <div class="pager">
        <span class="pgsize">
          每页
          <select :value="size" @change="setSize">
            <option v-for="n in sizes" :key="n" :value="n">{{ n }}</option>
          </select>
          {{ unit }}
        </span>
        <span class="pgsep"></span>
        <button :disabled="!canPrev" @click="go(1)">« 首页</button>
        <button :disabled="!canPrev" @click="go(page - 1)">‹ 上一页</button>
        <span class="pginfo">{{ info || ('第 ' + page + ' / ' + pages + ' 页') }}</span>
        <button :disabled="!canNext" @click="go(page + 1)">下一页 ›</button>
        <button :disabled="!canNext" @click="go(pages)">末页 »</button>
      </div>
    `,
  };

  /** 改密码弹窗 */
  const PasswordModal = {
    props: { show: { type: Boolean, default: false } },
    emits: ['close', 'done'],
    setup(props, { emit }) {
      const oldPw = ref('');
      const newPw = ref('');
      const newPw2 = ref('');
      const err = ref('');
      const ok = ref('');
      const busy = ref(false);
      async function submit() {
        err.value = ''; ok.value = '';
        if (newPw.value !== newPw2.value) { err.value = '两次输入的新密码不一样'; return; }
        if (!newPw.value || newPw.value.length < 8) { err.value = '新密码至少 8 位'; return; }
        busy.value = true;
        try {
          await api('/api/password', { method: 'POST', body: { oldPassword: oldPw.value, newPassword: newPw.value } });
          ok.value = '密码已改好';
          oldPw.value = ''; newPw.value = ''; newPw2.value = '';
          emit('done');
        } catch (e) { err.value = e.message; }
        finally { busy.value = false; }
      }
      function close() { err.value = ''; ok.value = ''; emit('close'); }
      return { oldPw, newPw, newPw2, err, ok, busy, submit, close };
    },
    template: `
      <div class="modal" v-if="show" @click.self="close">
        <div class="mbox">
          <h3>修改密码</h3>
          <label>当前密码<input v-model="oldPw" type="password" autocomplete="current-password"></label>
          <label>新密码<input v-model="newPw" type="password" autocomplete="new-password"></label>
          <label>确认新密码<input v-model="newPw2" type="password" autocomplete="new-password"></label>
          <div class="err">{{ err }}</div>
          <div style="color:var(--good);font-size:12.5px;min-height:18px">{{ ok }}</div>
          <div class="row">
            <button @click="close">取消</button>
            <button class="primary" :disabled="busy" @click="submit">保存</button>
          </div>
        </div>
      </div>
    `,
  };

  /* --------------------------------------------------------------- 导出 */
  global.QuoteAdmin = {
    api, esc, fmtTime, fmtMoney, fmtTimeAgo, usePaging, useAuth,
    AppHeader, LoginGate, Pager, PasswordModal,
    createApp,
  };
})(window);
