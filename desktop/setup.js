'use strict';

const params = new URLSearchParams(location.search);
const purpose = params.get('purpose') || 'setup';
const DEFAULT_SERVER = 'https://quote.byberg.store';
const form = document.getElementById('form');
const serverUrl = document.getElementById('serverUrl');
const submit = document.getElementById('submit');
const error = document.getElementById('error');
const title = document.getElementById('title');
const lead = document.getElementById('lead');

serverUrl.value = params.get('serverUrl') || DEFAULT_SERVER;

if (purpose === 'switch') {
  document.title = '服务器连接设置';
  title.textContent = '服务器连接设置';
  lead.textContent = '修改中央服务器地址后客户端会重启。账号和价格表始终从所选服务器读取。';
}

document.getElementById('cancel').addEventListener('click', () => window.adminSetup.cancel());

form.addEventListener('submit', async event => {
  event.preventDefault();
  error.textContent = '';
  const value = serverUrl.value.trim();
  if (!value) {
    error.textContent = '请填写中央服务器地址';
    return;
  }

  submit.disabled = true;
  submit.textContent = '正在验证服务器…';
  try {
    const result = await window.adminSetup.submit({ mode: 'remote', serverUrl: value });
    if (!result.ok) {
      error.textContent = result.error || '连接失败';
      submit.disabled = false;
      submit.textContent = '连接并进入登录页';
    }
  } catch (e) {
    error.textContent = e.message || '连接失败';
    submit.disabled = false;
    submit.textContent = '连接并进入登录页';
  }
});

serverUrl.focus();
