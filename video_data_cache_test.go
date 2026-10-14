package main

import (
	"bytes"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

type videoCacheFixture struct {
	proxy *WebDAVProxy
	cache *VideoDataCache
	data  []byte
	hits  atomic.Int32
	etag  string
}

func newVideoCacheFixture(t *testing.T) *videoCacheFixture {
	t.Helper()
	f := &videoCacheFixture{data: make([]byte, 3*videoDataBlockSize), etag: `"version-1"`}
	for i := range f.data {
		f.data[i] = byte(i % 251)
	}
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		f.hits.Add(1)
		if r.Method != http.MethodGet {
			t.Error("缓存不应发送预检查请求")
		}
		if r.URL.Query().Has(videoVersionQuery) {
			t.Error("本地版本参数不应发送到上游")
		}
		w.Header().Set("ETag", f.etag)
		w.Header().Set("Content-Type", "video/mp4")
		http.ServeContent(w, r, "video.mp4", time.Date(2026, 10, 14, 0, 0, 0, 0, time.UTC), bytes.NewReader(f.data))
	}))
	t.Cleanup(server.Close)
	var err error
	f.cache, err = NewVideoDataCache(t.TempDir(), time.Hour, 8*videoDataBlockSize)
	if err != nil {
		t.Fatal(err)
	}
	f.proxy, err = NewWebDAVProxy()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = f.proxy.Close() })
	f.proxy.SetVideoDataCache(f.cache)
	for _, id := range []string{"a", "b"} {
		mustSetProxyAccount(t, f.proxy, WebDAVAccount{ID: id, Endpoint: server.URL + "/dav"})
	}
	return f
}

func (f *videoCacheFixture) get(t *testing.T, id, file, version, requested string) *httptest.ResponseRecorder {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, f.proxy.URLForFile(id, file, version, int64(len(f.data))), nil)
	r.Header.Set("Range", requested)
	w := httptest.NewRecorder()
	f.proxy.ServeHTTP(w, r)
	if w.Code != http.StatusOK && w.Code != http.StatusPartialContent {
		t.Fatalf("响应失败：%d %s", w.Code, w.Body.String())
	}
	return w
}

func TestVideoDataCacheReusesRangesAndPersists(t *testing.T) {
	f := newVideoCacheFixture(t)
	f.get(t, "a", "/video.mp4", "v1", "bytes=0-1048575")
	w := f.get(t, "a", "/video.mp4", "v1", "bytes=16-127")
	if f.hits.Load() != 1 || !bytes.Equal(w.Body.Bytes(), f.data[16:128]) {
		t.Fatal("命中区间不应请求上游")
	}
	f.get(t, "a", "/video.mp4", "v1", "bytes=1048576-2097151")
	w = f.get(t, "a", "/video.mp4", "v1", "bytes=524288-")
	if f.hits.Load() != 2 || w.Header().Get("Content-Range") != "bytes 524288-2097151/3145728" || !bytes.Equal(w.Body.Bytes(), f.data[524288:2097152]) {
		t.Fatal("开放区间应复用连续的缓存片段")
	}
	cache, err := NewVideoDataCache(f.cache.dir, time.Hour, 8*videoDataBlockSize)
	if err != nil {
		t.Fatal(err)
	}
	f.cache = cache
	f.proxy.SetVideoDataCache(cache)
	w = f.get(t, "a", "/video.mp4", "v1", "bytes=524280-1048600")
	if f.hits.Load() != 2 || !bytes.Equal(w.Body.Bytes(), f.data[524280:1048601]) {
		t.Fatal("重启后的跨片段命中失败")
	}
	stats, _ := cache.Stats()
	if stats.Count != 1 || stats.TotalBytes != 2*videoDataBlockSize {
		t.Fatalf("空间统计错误：%+v", stats)
	}
}

func TestVideoDataCacheVersionAccountAndValidatorIsolation(t *testing.T) {
	f := newVideoCacheFixture(t)
	oldURL := f.proxy.URLForFile("a", "/video.mp4", "v1", int64(len(f.data)))
	f.get(t, "a", "/video.mp4", "v1", "bytes=0-1023")
	f.get(t, "b", "/video.mp4", "v1", "bytes=0-1023")
	f.get(t, "a", "/video.mp4", "v2", "bytes=0-1023")
	if f.hits.Load() != 3 {
		t.Fatal("账户或文件版本变化必须重新读取")
	}
	// 过时页面的请求不能覆盖已经观察到的新文件版本。
	r := httptest.NewRequest(http.MethodGet, oldURL, nil)
	r.Header.Set("Range", "bytes=0-1023")
	f.proxy.ServeHTTP(httptest.NewRecorder(), r)
	f.get(t, "a", "/video.mp4", "v2", "bytes=0-1023")
	if f.hits.Load() != 4 {
		t.Fatal("过时的 URL 污染了新版本缓存")
	}
	f.etag = `"version-2"`
	f.get(t, "a", "/video.mp4", "v2", "bytes=2048-3071")
	f.get(t, "a", "/video.mp4", "v2", "bytes=0-1023")
	if f.hits.Load() != 6 {
		t.Fatal("上游 ETag 变化时必须丢弃旧片段")
	}
}

type disconnectedVideoWriter struct{ header http.Header }

func (w *disconnectedVideoWriter) Header() http.Header     { return w.header }
func (*disconnectedVideoWriter) WriteHeader(int)           {}
func (*disconnectedVideoWriter) Write([]byte) (int, error) { return 0, errors.New("客户端断开") }

func TestVideoDataCacheStoresOnlyReadPrefixAfterDisconnect(t *testing.T) {
	f := newVideoCacheFixture(t)
	r := httptest.NewRequest(http.MethodGet, f.proxy.URLForFile("a", "/video.mp4", "v1", int64(len(f.data))), nil)
	r.Header.Set("Range", "bytes=0-")
	f.proxy.ServeHTTP(&disconnectedVideoWriter{header: make(http.Header)}, r)
	stats, _ := f.cache.Stats()
	if stats.TotalBytes <= 0 || stats.TotalBytes >= int64(len(f.data)) {
		t.Fatalf("断开后只应缓存已读区间：%+v", stats)
	}
	w := f.get(t, "a", "/video.mp4", "v1", "bytes=0-")
	if f.hits.Load() != 1 || int64(w.Body.Len()) != stats.TotalBytes || !bytes.Equal(w.Body.Bytes(), f.data[:stats.TotalBytes]) {
		t.Fatal("已完成的前缀应直接复用")
	}
	f.get(t, "a", "/video.mp4", "v1", fmt.Sprintf("bytes=%d-%d", stats.TotalBytes, stats.TotalBytes+15))
	if f.hits.Load() != 2 {
		t.Fatal("未读取的区间不能当作缓存命中")
	}
}

func TestVideoDataCacheExpiryLRUAndDisable(t *testing.T) {
	f := newVideoCacheFixture(t)
	now := time.Now()
	f.cache.now = func() time.Time { return now }
	f.get(t, "a", "/first.mp4", "v1", "bytes=0-511")
	now = now.Add(time.Second)
	f.get(t, "a", "/second.mp4", "v1", "bytes=0-511")
	now = now.Add(time.Second)
	f.get(t, "a", "/first.mp4", "v1", "bytes=0-511")
	_ = f.cache.SetLimits(time.Hour, 512)
	f.get(t, "a", "/first.mp4", "v1", "bytes=0-511")
	if f.hits.Load() != 2 {
		t.Fatal("容量淘汰应保留最近使用的数据")
	}
	now = now.Add(59 * time.Minute)
	f.get(t, "a", "/first.mp4", "v1", "bytes=0-511")
	now = now.Add(2 * time.Minute)
	f.get(t, "a", "/first.mp4", "v1", "bytes=0-511")
	if f.hits.Load() != 3 {
		t.Fatal("读取命中不应延长最长保留时间")
	}
	_ = f.cache.SetLimits(time.Hour, 0)
	f.get(t, "a", "/first.mp4", "v1", "bytes=0-511")
	f.get(t, "a", "/first.mp4", "v1", "bytes=0-511")
	stats, _ := f.cache.Stats()
	if f.hits.Load() != 5 || stats.TotalBytes != 0 {
		t.Fatal("容量为 0 时应禁用并清理数据")
	}
	_ = f.cache.SetLimits(time.Hour, 512)
	f.get(t, "a", "/first.mp4", "v2", "bytes=0-511")
	f.get(t, "a", "/first.mp4", "v2", "bytes=0-511")
	if f.hits.Load() != 6 {
		t.Fatal("重新启用后应缓存文件的新版本")
	}
}

func TestVideoDataCacheClearInvalidatesWritersAndCleansOrphans(t *testing.T) {
	f := newVideoCacheFixture(t)
	resp := &http.Response{StatusCode: 200, ContentLength: 4096, Header: make(http.Header)}
	capture := f.cache.Capture("key", "v1", resp)
	_, _ = capture.Write([]byte("已读取的片段"))
	_, _ = f.cache.Clear()
	capture.flush()
	stats, _ := f.cache.Stats()
	if stats.TotalBytes != 0 {
		t.Fatal("清空后旧写入不得填回缓存")
	}
	for _, name := range []string{"segment-orphan.bin", "segment-orphan.tmp", "broken.json"} {
		if err := os.WriteFile(filepath.Join(f.cache.dir, name), []byte("中断提交"), 0o600); err != nil {
			t.Fatal(err)
		}
	}
	_, err := NewVideoDataCache(f.cache.dir, time.Hour, 1024)
	if err != nil {
		t.Fatal(err)
	}
	files, _ := os.ReadDir(f.cache.dir)
	if len(files) != 0 {
		t.Fatal("启动时应清理没有完整索引的文件")
	}
}

func TestVideoDataCacheConditionalAndFullResponses(t *testing.T) {
	f := newVideoCacheFixture(t)
	f.get(t, "a", "/video.mp4", "v1", "")
	w := f.get(t, "a", "/video.mp4", "v1", "")
	if w.Code != 200 || f.hits.Load() != 1 || !bytes.Equal(w.Body.Bytes(), f.data) {
		t.Fatal("完整文件应复用缓存")
	}
	w = f.get(t, "a", "/video.mp4", "v1", "bytes=-16")
	if f.hits.Load() != 1 || !bytes.Equal(w.Body.Bytes(), f.data[len(f.data)-16:]) {
		t.Fatal("后缀区间命中失败")
	}
	r := httptest.NewRequest(http.MethodGet, f.proxy.URLForFile("a", "/video.mp4", "v1", int64(len(f.data))), nil)
	r.Header.Set("Range", "bytes=0-15")
	r.Header.Set("If-Range", `"different"`)
	w = httptest.NewRecorder()
	f.proxy.ServeHTTP(w, r)
	if f.hits.Load() != 2 || w.Code != 200 || !bytes.Equal(w.Body.Bytes(), f.data) {
		t.Fatal("If-Range 不匹配必须交给上游处理")
	}
	r.Header.Set("If-None-Match", f.etag)
	w = httptest.NewRecorder()
	f.proxy.ServeHTTP(w, r)
	if f.hits.Load() != 3 || w.Code != http.StatusNotModified {
		t.Fatal("条件请求应保留上游语义")
	}
}

func TestVideoDataCacheDiskFailureDoesNotInterruptPlayback(t *testing.T) {
	f := newVideoCacheFixture(t)
	if err := os.Remove(f.cache.dir); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.cache.dir, []byte("目录不可写"), 0o600); err != nil {
		t.Fatal(err)
	}
	w := f.get(t, "a", "/video.mp4", "v1", "bytes=0-1048575")
	if !bytes.Equal(w.Body.Bytes(), f.data[:videoDataBlockSize]) {
		t.Fatal("缓存写入失败不能影响播放响应")
	}
	if _, err := f.cache.Clear(); err == nil {
		t.Fatal("清空失败时应向设置界面报告错误")
	}
}

func TestVideoDataSettingsPersist(t *testing.T) {
	service := newMultiAccountTestService(t)
	cache, err := NewVideoDataCache(t.TempDir(), time.Hour, 1024)
	if err != nil {
		t.Fatal(err)
	}
	service.videoData = cache
	state, err := service.SetVideoDataSettings(60, 512)
	if err != nil || state.VideoDataMaxAgeMinutes != 60 || state.VideoDataMaxSizeMB != 512 {
		t.Fatalf("设置保存失败：%v", err)
	}
	data, _ := os.ReadFile(service.configPath)
	if !strings.Contains(string(data), `"videoDataMaxAgeMinutes": 60`) || !strings.Contains(string(data), `"videoDataMaxSizeMB": 512`) {
		t.Fatal("设置未持久化")
	}
	if _, err := service.SetVideoDataSettings(0, 512); err == nil {
		t.Fatal("无效的保留时间应拒绝")
	}
	if _, err := service.SetVideoDataSettings(60, -1); err == nil {
		t.Fatal("无效的容量应拒绝")
	}
}

type videoProgressWriter struct {
	*httptest.ResponseRecorder
	ready chan struct{}
	bytes int
}

func (w *videoProgressWriter) Write(data []byte) (int, error) {
	n, err := w.ResponseRecorder.Write(data)
	w.bytes += n
	if w.ready != nil && w.bytes >= videoDataBlockSize {
		close(w.ready)
		w.ready = nil
	}
	return n, err
}

func TestVideoDataCacheSharesCompletedBlocksWhileSourceIsStreaming(t *testing.T) {
	data := bytes.Repeat([]byte{42}, 2*videoDataBlockSize)
	resume := make(chan struct{})
	var hits atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		hits.Add(1)
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 0-%d/%d", len(data)-1, len(data)))
		w.WriteHeader(http.StatusPartialContent)
		_, _ = w.Write(data[:videoDataBlockSize])
		w.(http.Flusher).Flush()
		<-resume
		_, _ = w.Write(data[videoDataBlockSize:])
	}))
	defer server.Close()
	proxy, err := NewWebDAVProxy()
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	cache, err := NewVideoDataCache(t.TempDir(), time.Hour, 4*videoDataBlockSize)
	if err != nil {
		t.Fatal(err)
	}
	proxy.SetVideoDataCache(cache)
	mustSetProxyAccount(t, proxy, WebDAVAccount{ID: "a", Endpoint: server.URL})
	url := proxy.URLForFile("a", "/video.mp4", "v1", int64(len(data)))
	ready, done := make(chan struct{}), make(chan struct{})
	r := httptest.NewRequest(http.MethodGet, url, nil)
	r.Header.Set("Range", "bytes=0-")
	w := &videoProgressWriter{ResponseRecorder: httptest.NewRecorder(), ready: ready}
	go func() { proxy.ServeHTTP(w, r); close(done) }()
	<-ready
	r = httptest.NewRequest(http.MethodGet, url, nil)
	r.Header.Set("Range", "bytes=128-255")
	second := httptest.NewRecorder()
	proxy.ServeHTTP(second, r)
	close(resume)
	<-done
	if hits.Load() != 1 || !bytes.Equal(second.Body.Bytes(), data[128:256]) || !bytes.Equal(w.Body.Bytes(), data) {
		t.Fatal("主播放尚未结束时，已写入的片段应供其他读取复用")
	}
}
