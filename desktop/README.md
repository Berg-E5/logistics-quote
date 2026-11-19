# 物流报价 Windows 客户端

Electron 窗口启动一个仅监听 `127.0.0.1` 的本地 Node 服务，并随安装包携带
Python 3.12、openpyxl 和现有 XLSX 抽取管道。用户看到的是独立桌面窗口，
不会打开 Chrome/Edge，也不会显示地址栏。

## 开发

```powershell
cd desktop
npm install
npm start
```

`prepare:python` 会自动下载 Python embeddable 运行时，并把 openpyxl 安装到
`desktop/resources/python/Lib/site-packages`。

## 构建

```powershell
cd desktop
npm run dist
```

安装程序输出到 `desktop/dist/LogisticsQuote-Setup-*.exe`。

## 本地数据

- 数据：`%APPDATA%\物流报价\data`
- 日志：`%APPDATA%\物流报价\logs`
- 设置：`%APPDATA%\物流报价\settings.json`

本地管理员凭据使用 Electron `safeStorage`（Windows DPAPI）加密保存。
客户端首次启动时自动创建管理员并登录，不显示登录页。
