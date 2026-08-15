# Drive Player

基于 Wails v3 的 123 云盘桌面视频播放器，通过 123 云盘 WebDAV 浏览目录，并在本机代理层优化视频 GET 请求。

## 功能

- 只需要填写 123 云盘“第三方挂载”生成的 WebDAV 账号和应用密码。
- 浏览 WebDAV 目录，支持路径输入、上级目录、面包屑和刷新。
- 点击视频文件直接使用 Video.js v10 Beta 播放。
- 本机 WebDAV 代理监听 `127.0.0.1`，本机访问无需账号、密码或 token；代理内部自动使用保存的上游 WebDAV 凭据。
- GET 请求遇到 302 时缓存最终 `Location`，后续 GET/Range 直接访问缓存 URL。
- 缓存签名 URL 返回 401/403/410 时自动失效并重新从 WebDAV 获取 302。
- 其他 WebDAV 方法保持方法、body、headers 透传；MOVE/COPY 的 `Destination` 会映射到上游 WebDAV 地址。
- 缓存 TTL 默认 30 分钟，可设置 1–1440 分钟，可查看和清空缓存。
- WebDAV 账号和密码会以明文写入本地配置文件；应用启动时读取保存的凭据并自动尝试登录，失败时登录页会回填原账号和密码供直接修改。

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
appservice.go        Wails 服务、WebDAV 登录、PROPFIND 目录解析、设置
proxy.go             本机 WebDAV 代理、GET 302 URL 缓存、Range 转发
proxy_test.go        GET 缓存与非 GET 透传测试
main.go              Wails 应用入口
frontend/src/App.tsx 登录、文件浏览、播放器、缓存与设置 UI
frontend/src/components/ui/
                     shadcn 组件
```

配置文件保存在系统用户配置目录的 `drive-player/config.json`，其中包含缓存 TTL、WebDAV 账号和明文密码。Windows 通常位于 `%AppData%\drive-player\config.json`。

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
