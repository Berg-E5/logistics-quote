'use strict';

const params = new URLSearchParams(location.search);
const reset = params.get('mode') === 'reset';
const title = document.getElementById('title');
const lead = document.getElementById('lead');
const submit = document.getElementById('submit');
const error = document.getElementById('error');
const form = document.getElementById('form');

if (reset) {
  title.textContent = '重置管理员密码';
  lead.textContent = '本机已有管理员账户，但当前登录凭据不可用。请设置新的本地管理员密码。';
  submit.textContent = '保存新密码并进入系统';
}

document.getElementById('cancel').addEventListener('click', () => window.adminSetup.cancel());

form.addEventListener('submit', async event => {
  event.preventDefault();
  const password = document.getElementById('password').value;
  const confirm = document.getElementById('confirm').value;
  error.textContent = '';
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
    const result = await window.adminSetup.submit(password, confirm);
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
