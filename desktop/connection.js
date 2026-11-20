'use strict';

const params = new URLSearchParams(location.search);
const server = params.get('server') || '未配置服务器地址';
document.getElementById('server').textContent = server;
document.getElementById('error').textContent = params.get('error') || '连接失败';
document.getElementById('retry').addEventListener('click', () => window.connectionPage.retry());
document.getElementById('settings').addEventListener('click', () => window.connectionPage.settings());
document.getElementById('copy').addEventListener('click', () => {
  window.connectionPage.copyServer(server);
  document.getElementById('copy').textContent = '已复制';
});
