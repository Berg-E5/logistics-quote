'use strict';

const params = new URLSearchParams(location.search);
const reset = params.get('mode') === 'reset';
const title = document.getElementById('title');
const lead = document.getElementById('lead');
const submit = document.getElementById('submit');
const error = document.getElementById('error');
const form = document.getElementById('form');
const username = document.getElementById('username');

username.value = params.get('username') || 'admin';

if (reset) {
  document.title = '重置管理员密码';
  title.textContent = '重置管理员密码';
  lead.textContent = '本机已有管理员账户，但尚未完成明确的密码设置。请重新设置本地管理员密码。';
  submit.textContent = '保存新密码并进入系统';
  username.readOnly = true;
}

document.getElementById('cancel').addEventListener('click', () => window.adminSetup.cancel());

form.addEventListener('submit', async event => {
  event.preventDefault();
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;
  const accountName = username.value.trim();
  error.textContent = '';
  if (!/^[A-Za-z0-9_.-]{2,32}$/.test(accountName)) {
    error.textContent = '用户名只能使用字母、数字、下划线、点和横线，2–32 位';
    return;
  }
  if (password.length < 8) {
    error.textContent = '密码至少 8 位';
    return;
  }
  if (password !== confirm) {
    error.textContent = '两次输入的密码不一致';
    return;
  }
  submit.disabled = true;
  submit.textContent = '正在创建…';
  try {
    const result = await window.adminSetup.submit(accountName, password, confirm);
    if (!result.ok) {
      error.textContent = result.error || '设置失败';
      submit.disabled = false;
      submit.textContent = reset ? '保存新密码并进入系统' : '创建管理员并进入系统';
    }
  } catch (e) {
    error.textContent = e.message || '设置失败';
    submit.disabled = false;
  }
});

document.getElementById('password').focus();
