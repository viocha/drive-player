# Drive Player

基于 Wails v3 的云盘桌面视频播放器，支持 123 云盘 WebDAV 和夸克网盘，并在本机代理层优化视频 GET 请求。

## 功能

- 123 云盘使用“第三方挂载”生成的 WebDAV 账号和应用密码登录。
- 夸克网盘使用浏览器登录后的 Cookie 登录。
- 两个网盘可以同时保持登录，顶部可直接切换当前浏览网盘；未登录的一侧可从顶部直接补登录。
- 浏览云盘目录，支持路径输入、历史前进/后退、面包屑和刷新。
- 点击视频文件直接使用 Video.js v10 Beta 播放。
- 本机 WebDAV 代理监听 `127.0.0.1`，本机访问无需账号、密码或 token；代理内部自动使用保存的上游 WebDAV 凭据。
- GET 请求遇到 302 时缓存最终 `Location`，后续 GET/Range 直接访问缓存 URL。
- 缓存签名 URL 返回 401/403/410 时自动失效并重新从 WebDAV 获取 302。
- 其他 WebDAV 方法保持方法、body、headers 透传；MOVE/COPY 的 `Destination` 会映射到上游 WebDAV 地址。
- 夸克后端缓存路径到 FID，以及路径到临时下载 URL、下载 Cookie 和文件大小的映射。
- 夸克对象存储单次请求固定控制在最多 300 MiB；更大的整文件 GET 或 Range 会拆成多个上游 Range 顺序拼流返回。
- URL 缓存和夸克路径 ID 缓存默认 30 分钟，可设置 1–1440 分钟并手动清空。
- WebDAV 账号/密码和夸克 Cookie 会以明文写入本地配置文件；应用启动时会分别恢复两个已保存的账号，并恢复上次使用的当前网盘。

## 技术栈

- Go 1.26+
- Wails v3 `v3.0.0-beta.8`
- React + TypeScript + Vite
- pnpm
- shadcn CLI 当前默认组件栈 + Tailwind CSS v4
- `@videojs/react` `10.0.0-beta.26`

Video.js v10 当前仍处于 Beta，项目使用新的 `@videojs/react` API，而不是旧版 `video.js` 包。

## 开发

确保 `wails3` 已安装：

```powershell
go install github.com/wailsapp/wails/v3/cmd/wails3@latest
```

安装前端依赖：

```powershell
cd D:\tmp\drive-player\frontend
pnpm install
```

开发模式：

```powershell
cd D:\tmp\drive-player
wails3 dev
```

如果 `wails3` 不在 `PATH`：

```powershell
& "$(go env GOPATH)\bin\wails3.exe" dev
```

## 构建与测试

```powershell
cd D:\tmp\drive-player\frontend
pnpm build

cd ..
go test ./...
& "$(go env GOPATH)\bin\wails3.exe" build
```

Windows 构建产物：

```text
D:\tmp\drive-player\bin\drive-player.exe
```

## 代码结构

```text
appservice.go        Wails 服务、账号登录、云盘路由与设置
proxy.go             本机 WebDAV 代理、GET 302 URL 缓存、Range 转发
proxy_test.go        GET 缓存与非 GET 透传测试
quark.go             夸克 API、路径/FID 缓存、下载 URL 缓存、300 MiB 分块代理
quark_test.go        夸克下载 Cookie、分块拼流、Range 与取消传播测试
main.go              Wails 应用入口
frontend/src/App.tsx 登录、文件浏览、播放器、缓存与设置 UI
frontend/src/components/ui/
                     shadcn 组件
```

配置文件保存在系统用户配置目录的 `drive-player/config.json`，其中包含缓存设置、WebDAV 账号/明文密码和夸克 Cookie。Windows 通常位于 `%AppData%\drive-player\config.json`。

## WebDAV GET 缓存流程

```text
Video.js
  -> http://127.0.0.1:<random-port>/webdav/<path>
  -> cache hit: signed URL
  -> cache miss: https://webdav.123pan.cn/webdav/<path>
       -> 302 Location: <signed URL>
       -> cache Location with TTL
       -> signed URL
```

播放器发出的 `Range`、`If-Range` 等请求头会继续传递给签名 URL，因此拖动进度条和分段读取不会因为缓存 302 而丢失 Range 语义。

## 夸克 GET 代理流程

```text
Video.js
  -> http://127.0.0.1:<random-port>/quark/<path>
  -> path -> fid cache
  -> POST /1/clouddrive/file/download (登录 Cookie + 桌面 UA)
       -> download_url + size + Set-Cookie
  -> cache path -> download_url/download Cookie/size
  -> requested length <= 300 MiB: one upstream request
  -> requested length > 300 MiB: fixed Range chunks <= 300 MiB
       -> sequential io.Copy with downstream backpressure/cancellation
       -> one continuous 200/206 response to the player
```
