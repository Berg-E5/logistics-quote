# 物流报价 Windows 客户端

客户端为**强制中央服务器模式**：

- 首次启动只允许填写和验证中央服务器地址，默认 `https://quote.byberg.store`；
- 不启动本地 Node 服务，不创建本机管理员，不保存本地价格表；
- 账号必须由服务端管理员添加，登录和权限完全由服务端校验；
- 网络不可用时显示连接错误页，可重试或修改服务器地址；
- 独立 Electron 窗口运行，不打开 Chrome/Edge，也不显示网页地址栏。

管理员 A 的普通用户只能读取 A 的价格表，管理员 B 的普通用户只能读取 B 的价格表。
服务端创建、停用、重置密码或删除账号后，客户端会直接受这些状态约束。

## 开发

```powershell
cd desktop
npm install
npm start
```

## 构建

```powershell
cd desktop
npm run dist
```

安装程序输出到 `desktop/dist/LogisticsQuote-Setup-*.exe`。构建固定使用
`node_modules/electron/dist`，不携带服务端、公共网页、Python、openpyxl 或商业价格数据。

客户端未配置代码签名，产物标记为 `NotSigned`。Windows SmartScreen 可能提示
“未知发布者”，安装前请核对 Release 页面的 SHA-256。

## 本机文件

- 设置：`%APPDATA%\物流报价\settings.json`
- 日志：`%APPDATA%\物流报价\logs\client.log`

旧版本遗留的 `%APPDATA%\物流报价\data` 不会自动删除，但 1.5.0 起客户端不会再启动或读取
其中的本机服务数据。

## 更新检查

“帮助 → 检查更新”会读取 GitHub 最新 Release，并对下载地址执行固定仓库前缀校验。
发现新版本时只显示版本和下载按钮，不会静默下载或执行安装。
