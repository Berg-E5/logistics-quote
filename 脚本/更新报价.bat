@echo off
chcp 65001 >nul
title 更新物流报价数据
cd /d "%~dp0"

echo ============================================
echo   更新物流报价数据
echo ============================================
echo.

rem 找 python
set PY=
where py >nul 2>nul && set PY=py
if not defined PY (
  where python >nul 2>nul && set PY=python
)
if not defined PY (
  echo [错误] 没找到 python。
  echo 请先安装 Python 3.10 以上, 并勾选 "Add to PATH"。
  pause
  exit /b 1
)

echo 用到的 Python: %PY%
echo.
echo 提示: 把新的《渠道整合报价》xlsx 放到这个文件夹, 或指定路径:
echo   更新报价.bat "D:\path\新报价表.xlsx"
echo.

%PY% 更新报价.py %*
set CODE=%ERRORLEVEL%

echo.
if "%CODE%"=="0" (
  echo [完成] 数据已更新, 打开 index.html 即可。
) else (
  echo [失败] 请看上面的报错信息。
)
pause
