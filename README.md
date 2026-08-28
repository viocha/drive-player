# Drive Player

基于 Wails v3 的 WebDAV 视频播放器。Drive Player 只面向 WebDAV，不再感知具体网盘类型；不同网盘的 API、路径 ID、临时下载地址等细节应由独立的 WebDAV 适配层处理。

## 功能

- 仅支持 WebDAV，可按需添加任意数量的 WebDAV 网盘。
- 每个网盘可自定义名称、WebDAV 地址以及可选的账号和密码，并可随时编辑或删除。
- 顶部可直接切换当前网盘；每个网盘独立保存本次运行中的目录缓存、滚动位置和前进 / 后退历史。
- 浏览 WebDAV 目录，支持面包屑、前进 / 后退、返回上级和刷新。
- 点击视频文件直接使用 Video.js v10 Beta 播放。
- 应用只启动一个本机 HTTP 代理，通过 WebDAV 配置 ID 路由到不同网盘；浏览器播放器无需接触上游账号和密码。
- 本机代理只负责按账号配置透明转发 HTTP / WebDAV 请求，不解析或缓存上游下载地址等服务端实现细节。
- MOVE / COPY 的 `Destination` 会从本机代理地址映射回对应 WebDAV Endpoint。
- 视频元信息、时间点截图和播放进度按稳定的 WebDAV 配置 ID 隔离；修改名称或凭据不会与其他网盘混用。
- 配置了 WebDAV 账号或密码时会以明文写入本地配置文件；无认证 WebDAV 可以留空。

## 技术栈

- Go 1.26+
- Wails v3 `v3.0.0-beta.8`
- React + TypeScript + Vite
- pnpm
- Tailwind CSS v4 / shadcn
- `@videojs/react` `10.0.0-beta.26`

Video.js v10 当前仍处于 Beta，项目使用新的 `@videojs/react` API。

## 开发

确保 `wails3` 已安装：

```powershell
go install github.com/wailsapp/wails/v3/cmd/wails3@latest
```

安装前端依赖：

```powershell
cd D:\IT\js\wails\drive-player\frontend
pnpm install
```

开发模式：

```powershell
cd D:\IT\js\wails\drive-player
wails3 dev
```

## 构建与测试

```powershell
cd D:\IT\js\wails\drive-player
go test ./...

cd frontend
pnpm build

cd ..
task build
```

## 代码结构

```text
appservice.go                 Wails 服务、WebDAV 配置管理、目录浏览与本地设置
proxy.go                      通用本机 WebDAV / 视频播放透明代理
proxy_test.go                 认证隔离、多账号路由与 WebDAV 透传测试
appservice_accounts_test.go   多 WebDAV 配置切换和删除测试
appservice_cancel_test.go     WebDAV PROPFIND 取消传播测试
playback_progress.go          播放进度存储
video_metadata_cache.go       视频元信息缓存
video_snapshot_cache.go       视频截图缓存
main.go                       Wails 应用入口
frontend/src/App.tsx          WebDAV 管理、文件浏览、播放器与设置 UI
```

## 配置

配置文件保存在系统用户配置目录的 `drive-player/config.json`。Windows 通常位于 `%AppData%\drive-player\config.json`。

WebDAV 配置按数组保存，并通过稳定 ID 标识：

```json
{
  "accounts": [
    {
      "id": "...",
      "name": "WebDAV",
      "endpoint": "http://localhost:9000/dav",
      "username": "user",
      "password": "password"
    }
  ],
  "activeAccountId": "..."
}
```

本次架构调整不兼容旧的 123 / 夸克配置格式，不包含迁移逻辑。

## 播放链路

```text
Video.js
  -> http://localhost:<random-port>/webdav/<account-id>/<path>
  -> account-id 对应的 WebDAV Endpoint/<path>
  -> media response
```

Drive Player 的本机代理只负责浏览器侧播放所需的凭据隔离、CORS 和通用 HTTP / WebDAV 转发。具体网盘的路径解析、临时下载地址、签名 URL 生命周期和其他供应商细节不属于本项目。
