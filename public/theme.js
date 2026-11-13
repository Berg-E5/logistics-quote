/* ============================================================
   theme.js —— 白天 / 黑夜主题切换 (跟随系统 / 浅色 / 深色)

   为什么单独一个文件:
     前台 index.html 要支持 file:// 双击离线, 不能外链脚本;
     后台三页是 Vue, 要挂进 AppHeader。
     所以写成「一个纯函数 + 一段自启动代码」, 两边都能用:
       - 前台: 内联进 index.html (sync_ui_css.py 一样的注入方式)
       - 后台: 外链 /theme.js

   关键点: **首帧前就要把主题定下来**
     主题属性加在 <html> 上, 浏览器画第一帧之前必须已经写好,
     否则会先画一帧深色再跳到浅色 (白屏闪一下)。
     所以下面这段自启动代码是同步执行的, 放在 <head> 里。

   跟随系统怎么做的:
     不用 JS 监听 matchMedia 去切 class —— 那要等 JS 跑完才生效, 会闪。
     直接用 CSS 媒体查询:
       html[data-theme="auto"] + @media (prefers-color-scheme: light) { ... }
     令牌是 CSS 变量, 系统切换时浏览器自动重算, 零 JS、零闪烁。
     JS 只负责记住用户选了什么 (auto / light / dark) 写进 localStorage。
   ============================================================ */
(function (global) {
  'use strict';

  var KEY = 'quote.theme';
  var MODES = ['auto', 'light', 'dark'];

  function read() {
    try {
      var v = localStorage.getItem(KEY);
      return MODES.indexOf(v) >= 0 ? v : 'auto';
    } catch (e) {
      return 'auto';   // 隐私模式 / file:// 某些环境下 localStorage 会抛
    }
  }

  function save(v) {
    try { localStorage.setItem(KEY, v); } catch (e) { /* 忽略 */ }
  }

  /* 把主题写到 <html> 的 data-theme 上。
     auto 时不用写 —— 让 CSS 媒体查询接管, 系统切了浏览器自己跟上。 */
  function apply(mode) {
    var el = document.documentElement;
    if (!el) return;
    /* auto 时也要写 data-theme="auto", 不能 remove ——
       CSS 选择器是 html[data-theme="auto"], 属性没了就匹配不上。 */
    el.setAttribute('data-theme', mode);
    // 给 JS 侧一个「当前实际生效的是哪个」的答案 (auto 要问系统)
    el.setAttribute('data-theme-effective',
      mode === 'auto' ? (isDark() ? 'dark' : 'light') : mode);
  }

  function isDark() {
    try {
      return !!(global.matchMedia && global.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) {
      return true;   // 老浏览器 / 无 matchMedia -> 用深色 (这是原本的样子)
    }
  }

  /* 系统主题变化时, 如果用户选的是 auto, 更新一下 data-theme-effective
     (CSS 那部分浏览器自动处理, 这里只是让 JS 侧读得到) */
  function watchSystem() {
    if (!global.matchMedia) return;
    try {
      var mq = global.matchMedia('(prefers-color-scheme: dark)');
      /* 用事件对象上的 matches, 不要重新查 matchMedia ——
         change 事件触发时浏览器还没把 matchMedia 的状态更新过来,
         重新查会拿到**旧值**, 导致 data-theme-effective 慢一拍。 */
      var onChange = function (e) {
        if (read() !== 'auto') return;
        /* CSS 那半边浏览器自动切, 这里只更新 data-theme-effective */
        var dark = (e && typeof e.matches === 'boolean') ? e.matches : isDark();
        var el = document.documentElement;
        if (el) el.setAttribute('data-theme-effective', dark ? 'dark' : 'light');
      };
      if (mq.addEventListener) mq.addEventListener('change', onChange);
      else if (mq.addListener) mq.addListener(onChange);
    } catch (e) { /* 忽略 */ }
  }

  /* ---------- 控件 ---------- */
  /* 一个三态分段控件: 跟随系统 / 浅色 / 深色。
     不用 emoji (不同系统渲染差异大、显廉价), 用几何符号 + 文字。 */
  var Theme = {
    MODES: MODES,
    LABELS: { auto: '跟随系统', light: '浅色', dark: '深色' },
    read: read,
    apply: apply,
    save: save,
    isDark: isDark,
    current: function () { return read(); },
    effective: function () {
      var m = read();
      return m === 'auto' ? (isDark() ? 'dark' : 'light') : m;
    },
    set: function (mode) {
      if (MODES.indexOf(mode) < 0) mode = 'auto';
      save(mode);
      apply(mode);
      try {
        global.dispatchEvent(new CustomEvent('themechange', { detail: { mode: mode, effective: Theme.effective() } }));
      } catch (e) { /* 老浏览器没有 CustomEvent, 忽略 */ }
    },
    /* 循环切换: 跟随系统 -> 浅色 -> 深色 -> 跟随系统
       给只想点一个图标的场景用 (比如页头一个小按钮) */
    cycle: function () {
      var order = ['auto', 'light', 'dark'];
      var next = order[(order.indexOf(read()) + 1) % order.length];
      Theme.set(next);
      return next;
    },
    watchSystem: watchSystem
  };

  global.QuoteTheme = Theme;

  /* ---------- 自启动 ---------- */
  /* 必须在 head 里同步执行 —— 晚了就会闪。 */
  apply(read());

})(typeof window !== 'undefined' ? window : this);
