# 物流报价 Windows 客户端

Electron 窗口支持两种模式：

- **本机独立模式**：启动仅监听 `127.0.0.1` 的本地 Node 服务，随安装包携带
  Python 3.12、openpyxl 和 XLSX 抽取管道，数据保存在本机；
- **中央服务器模式（默认推荐）**：预填 `https://quote.byberg.store`，不启动本地数据服务，
  也不创建本机管理员。网络不可用时显示独立错误页，可重新连接、复制地址或修改设置。

两种模式都使用独立桌面窗口，不会打开 Chrome/Edge，也不会显示地址栏。

## 开发

```powershell
cd desktop
npm install
npm start
```

`prepare:python` 会下载 Python embeddable 运行时并校验固定 SHA-256，再用
`deploy/python-requirements.txt` 的 wheel 哈希安装 `openpyxl 3.1.5`、
`et_xmlfile` 和 `defusedxml`。下载或哈希不匹配时构建会失败。

## 构建

```powershell
cd desktop
npm run dist
```

安装程序输出到 `desktop/dist/LogisticsQuote-Setup-*.exe`。

构建不强制代码签名；未配置证书时产物会标记为 NotSigned。打包固定使用
`node_modules/electron/dist`，避免构建机器因重复下载 Electron 而卡住。

## 本地数据

- 数据：`%APPDATA%\物流报价\data`
- 日志：`%APPDATA%\物流报价\logs`
- 设置：`%APPDATA%\物流报价\settings.json`

首次启动会显示“本机独立 / 中央服务器”选择页。

- 本机模式允许自定义管理员用户名并设置密码，密码只以加盐 scrypt 哈希保存；
- 中央服务器模式会先验证服务器地址，然后直接显示中央登录页，本机不生成账号库。

总管理员可以创建多个管理员。管理员 A/B 各自维护独立价格表，只能创建和管理自己名下的
普通账号；A 的普通用户只能读取 A 的价格表，B 的普通用户只能读取 B 的价格表。
首次创建本机管理员后自动登录一次，后续启动显示登录页。

## 更新检查

“帮助 → 检查更新”会读取 GitHub 最新 Release，并对下载地址做固定仓库前缀校验。
发现新版本时只显示版本和下载按钮，不会静默下载或执行安装。安装前请核对 Release
页面的 SHA-256；未签名安装包可能触发 Windows SmartScreen。
