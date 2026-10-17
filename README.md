# Drive Player

基于 Wails v3 的 WebDAV 视频播放器。Drive Player 通过 WebDAV 访问视频文件；不同网盘的 API、路径 ID、临时下载地址等细节应由独立的 WebDAV 适配层处理。

## 功能

- 仅支持 WebDAV，可按需添加任意数量的 WebDAV 网盘。
- 每个网盘可自定义名称、WebDAV 地址以及可选的账号和密码，并可随时编辑或删除。
- 顶部可直接切换当前网盘；每个网盘独立保存本次运行中的目录缓存、滚动位置和前进 / 后退历史。
- 浏览 WebDAV 目录，支持面包屑、前进 / 后退、返回上级和刷新。刷新时保留列表和滚动位置，根据返回结果增量更新条目；桌面端分别显示大小、视频信息和修改时间。
- 文件和目录的右键菜单支持复制完整链接、复制带账号密码的链接、重命名、移动和删除。重命名通过对话框编辑主文件名，文件扩展名固定；目录名称可整体编辑。移动对话框默认浏览当前目录，通过路径栏和文件夹选择目标目录，文件项显示但禁用；手机端全屏展示，标题包含移动项名称，目录名称遵循全局行数设置。删除通过对话框确认，删除目录会包含其所有内容。
- 设置中的“显示”可配置列表标题最多显示 1 到 3 行，默认 1 行。该设置适用于文件列表和播放器侧栏的视频列表，超出行数时显示省略号，短标题按实际内容占用行数。
- 桌面端悬停视频封面可显示放大预览，复用已缓存封面。“显示”中的“封面悬浮预览”可关闭预览或选择 320、480、640 像素宽度，默认 480 像素；预览延迟可配置为 0 到 5000 毫秒，默认 0 毫秒，输入后按 Enter 或移出焦点保存。
- 点击视频文件直接使用 Video.js v10 播放。
- 目录封面和元信息先批量恢复本地缓存，再逐个视频补齐缺失项；每个视频的自动补全共用 10 秒总时限，超时取消请求并处理下一项，已完成结果立即保留。手动刷新封面或元信息的总时限为 10 秒，包含地址获取、解析、截图回退和缓存保存。切换目录会取消自动补全。封面默认截帧位置为视频时长的 50%，可在设置中修改。
- MP4、M4V 和 MOV 的封面与截图优先读取指定位置附近可独立解码的关键帧，共用容器索引、解码器和本机字节缓存。截图显示并跳转到实际取帧时间；补全按目标时间识别已完成项，相同关键帧只展示一次。其他容器或不支持 WebCodecs 的设备使用原生视频解码，批量截图最多并发两路，并行解码失败时串行补齐。主视频定位或缓冲期间后台截图让出资源，PNG 保留原始分辨率。
- 应用只启动一个本机 HTTP 代理，通过 WebDAV 配置 ID 路由到不同网盘；浏览器播放器无需接触上游账号和密码。
- 本机代理按账号配置转发 HTTP / WebDAV 请求，并缓存视频响应中实际读取的字节区间；上游下载地址等供应商细节由 WebDAV 适配层处理。
- MOVE / COPY 的 `Destination` 会从本机代理地址映射回对应 WebDAV Endpoint。
- 视频元信息、关键帧和播放进度按稳定的 WebDAV 配置 ID 隔离；修改名称或凭据不会与其他网盘混用。
- 配置了 WebDAV 账号或密码时会以明文写入本地配置文件；无认证 WebDAV 可以留空。

## 技术栈

- Go 1.26+
- Wails v3 `v3.0.0-beta.8`
- React + TypeScript + Vite
- bun
- Tailwind CSS v4 / shadcn
- `@videojs/react` `10.1.0`

项目使用 Video.js v10 稳定版及官方 React 组件、皮肤源码。

## 开发

确保 `wails3` 已安装：

```powershell
go install github.com/wailsapp/wails/v3/cmd/wails3@latest
```

安装前端依赖：

```powershell
cd D:\IT\js\wails\drive-player\frontend
bun install
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
video_snapshot_cache.go       视频关键帧缓存（包含封面）
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


## 播放链路

```text
Video.js
  -> http://localhost:<random-port>/webdav/<account-id>/<path>
  -> account-id 对应的 WebDAV Endpoint/<path>
  -> media response
```

Drive Player 的本机代理负责浏览器侧播放所需的凭据隔离、CORS、视频数据缓存和通用 HTTP / WebDAV 转发。具体网盘的路径解析、临时下载地址、签名 URL 生命周期和其他供应商细节由 WebDAV 适配层处理。

## 缓存

目录浏览缓存默认保留 60 分钟；目录浏览缓存和视频元信息缓存的默认大小上限均为 16 MB。视频关键帧缓存包含封面与关键帧截图，默认总大小上限为 512 MB，共用保留时间和容量淘汰规则。设置中的清空操作分别清理对应数据；刷新元信息只更新尺寸和帧率，刷新封面只更新封面。封面截帧位置在视频关键帧缓存中设置。

视频数据缓存独立保存视频文件的已读取字节区间，供播放、封面提取和元信息解析复用。数据存储在数据目录的 `video-data` 子目录，重启应用后可复用。默认总大小上限为 512 MB，最长保留时间为 60 分钟；容量满时淘汰最近最少使用的片段，命中不延长保留时间。设置中可修改上限、清空数据，或将容量设为 0 禁用。

缓存未命中时发送原有请求，不预读、不发送额外的 HEAD 等预检查。中断下载只保存实际收到的区间；开放的 Range 请求可以先返回已有的连续前缀，浏览器按需读取剩余部分。缓存按账户、凭据、路径和文件版本隔离；目录刷新发现修改时间或大小变化，或读取响应发现 ETag 等版本信息变化时丢弃旧片段。磁盘写入失败时仍返回播放数据。
