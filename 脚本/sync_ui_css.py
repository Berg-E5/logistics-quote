#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""
把 public/ui-common.css 的公共样式注入到 public/index.html 的内联 <style> 里。

为什么需要这个：
  前台 index.html 必须支持 file:// 双击离线打开（用户会把它单独复制走），
  所以不能外链 CSS —— 样式必须内联在文件里。
  但又不想维护两份（会漂移），于是公共样式只写在 ui-common.css 一处，
  用这个脚本同步进去。

用法：
  python 脚本/sync_ui_css.py           # 同步
  python 脚本/sync_ui_css.py --check   # 只检查有没有漂移, 不写文件（用于部署前校验）
"""
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.dirname(HERE)
CSS = os.path.join(ROOT, 'public', 'ui-common.css')
PAGES = [
    os.path.join(ROOT, 'public', 'index.html'),   # 线上版
    os.path.join(ROOT, 'index.html'),             # 离线双击版（复制品）
]

START = '/* @ui-common:start */'
END = '/* @ui-common:end */'
INLINE_START = '/* @ui-common:inline:start */'
INLINE_END = '/* @ui-common:inline:end */'


def read_common():
    with open(CSS, encoding='utf-8') as f:
        src = f.read()
    i = src.find(START)
    j = src.find(END)
    if i < 0 or j < 0:
        sys.exit(f'[错误] {CSS} 里找不到 {START} / {END} 标记')
    body = src[i + len(START):j]
    # 去掉标记行本身
    body = '\n'.join(l for l in body.split('\n') if l.strip() not in (START, END))
    # 每行缩进两格, 跟页面内的 <style> 对齐
    lines = []
    for l in body.split('\n'):
        lines.append(('  ' + l) if l.strip() else '')
    return '\n'.join(lines).strip('\n')


def sync(path, body, check):
    if not os.path.exists(path):
        print(f'  跳过（不存在）: {os.path.relpath(path, ROOT)}')
        return True
    with open(path, encoding='utf-8') as f:
        html = f.read()
    i = html.find(INLINE_START)
    j = html.find(INLINE_END)
    if i < 0 or j < 0:
        print(f'  [错误] {os.path.relpath(path, ROOT)} 里没有 {INLINE_START} / {INLINE_END} 标记')
        return False
    new = html[:i + len(INLINE_START)] + '\n' + body + '\n  ' + html[j:]
    rel = os.path.relpath(path, ROOT)
    if new == html:
        print(f'  已是同步状态: {rel}')
        return True
    if check:
        print(f'  [漂移] {rel} 需要重新同步')
        return False
    with open(path, 'w', encoding='utf-8', newline='') as f:
        f.write(new)
    print(f'  已同步: {rel}  (+{len(new) - len(html)} 字节)')
    return True


def main():
    check = '--check' in sys.argv
    body = read_common()
    print(f'公共样式 {len(body)} 字节' + ('（仅检查）' if check else ''))
    ok = True
    for p in PAGES:
        ok = sync(p, body, check) and ok
    if check and not ok:
        sys.exit(1)
    if not check:
        print('完成。前台 index.html 已是自包含单文件。')


if __name__ == '__main__':
    main()
