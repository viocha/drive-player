package main

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const videoDataBlockSize = 1024 * 1024
const videoVersionQuery = "__drive_version"

type VideoDataCacheStats struct {
	Count      int   `json:"count"`
	TotalBytes int64 `json:"totalBytes"`
}

type videoDataSegment struct {
	Key           string      `json:"key"`
	Version       string      `json:"version"`
	Validator     string      `json:"validator"`
	Total         int64       `json:"total"`
	Header        http.Header `json:"header"`
	File          string      `json:"file"`
	Start         int64       `json:"start"`
	Length        int64       `json:"length"`
	Created       time.Time   `json:"created"`
	Used          time.Time   `json:"used"`
	persistedUsed time.Time
}

type videoDataResource struct {
	version, validator string
	total              int64
	header             http.Header
	segments           []*videoDataSegment
	writers            int
}

// 数据按实际读取的区间保存；磁盘内容共用容量，内存只保存索引和每条流的一块写入缓冲。
type VideoDataCache struct {
	mu                   sync.Mutex
	dir                  string
	maxAge               time.Duration
	maxBytes, totalBytes int64
	resources            map[string]*videoDataResource
	versions             map[string]string
	now                  func() time.Time
}

func videoDataKey(parts ...string) string {
	data, _ := json.Marshal(parts)
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

func NewVideoDataCache(dir string, age time.Duration, size int64) (*VideoDataCache, error) {
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return nil, err
	}
	c := &VideoDataCache{dir: dir, maxAge: age, maxBytes: size, resources: make(map[string]*videoDataResource), versions: make(map[string]string), now: time.Now}
	files, err := os.ReadDir(dir)
	if err != nil {
		return nil, err
	}
	var segments []*videoDataSegment
	for _, file := range files {
		if file.IsDir() || !strings.HasSuffix(file.Name(), ".json") {
			continue
		}
		data, err := os.ReadFile(filepath.Join(dir, file.Name()))
		var segment videoDataSegment
		if err != nil || json.Unmarshal(data, &segment) != nil || segment.File != strings.TrimSuffix(file.Name(), ".json")+".bin" || filepath.Base(segment.File) != segment.File || segment.Length <= 0 || segment.Start < 0 || segment.Total <= 0 || segment.Length > segment.Total-segment.Start {
			_ = os.Remove(filepath.Join(dir, file.Name()))
			continue
		}
		info, err := os.Stat(filepath.Join(dir, segment.File))
		if err != nil || !info.Mode().IsRegular() || info.Size() != segment.Length {
			_ = os.Remove(filepath.Join(dir, file.Name()))
			continue
		}
		segments = append(segments, &segment)
	}
	sort.Slice(segments, func(i, j int) bool { return segments[i].Created.Before(segments[j].Created) })
	for _, segment := range segments {
		segment.persistedUsed = segment.Used
		resource := c.resources[segment.Key]
		if resource != nil && (resource.version != segment.Version || resource.validator != segment.Validator || resource.total != segment.Total) {
			c.dropLocked(segment.Key)
			resource = nil
		}
		if resource == nil {
			resource = &videoDataResource{version: segment.Version, validator: segment.Validator, total: segment.Total, header: segment.Header}
			c.resources[segment.Key] = resource
		}
		resource.segments = append(resource.segments, segment)
		c.totalBytes += segment.Length
	}
	c.pruneLocked()
	// 启动时删除中断提交留下的临时文件和没有索引的数据文件。
	valid := make(map[string]bool)
	for _, resource := range c.resources {
		for _, segment := range resource.segments {
			valid[segment.File] = true
		}
	}
	for _, file := range files {
		if strings.HasSuffix(file.Name(), ".tmp") || strings.HasSuffix(file.Name(), ".bin") && !valid[file.Name()] {
			_ = os.Remove(filepath.Join(dir, file.Name()))
		}
	}
	return c, nil
}

func (c *VideoDataCache) removeLocked(segment *videoDataSegment) {
	_ = os.Remove(filepath.Join(c.dir, strings.TrimSuffix(segment.File, ".bin")+".json"))
	_ = os.Remove(filepath.Join(c.dir, segment.File))
	c.totalBytes -= segment.Length
}

func (c *VideoDataCache) dropLocked(key string) {
	if resource := c.resources[key]; resource != nil {
		for _, segment := range resource.segments {
			c.removeLocked(segment)
		}
	}
	delete(c.resources, key)
}

func (c *VideoDataCache) pruneLocked() {
	now := c.now()
	for key, resource := range c.resources {
		kept := resource.segments[:0]
		for _, segment := range resource.segments {
			if c.maxBytes == 0 || now.Sub(segment.Created) >= c.maxAge {
				c.removeLocked(segment)
			} else {
				kept = append(kept, segment)
			}
		}
		resource.segments = kept
		if len(kept) == 0 && resource.writers == 0 {
			delete(c.resources, key)
		}
	}
	for c.totalBytes > c.maxBytes {
		var oldest *videoDataSegment
		for _, resource := range c.resources {
			for _, segment := range resource.segments {
				if oldest == nil || segment.Used.Before(oldest.Used) {
					oldest = segment
				}
			}
		}
		if oldest == nil {
			break
		}
		resource := c.resources[oldest.Key]
		for i, segment := range resource.segments {
			if segment == oldest {
				resource.segments = append(resource.segments[:i], resource.segments[i+1:]...)
				break
			}
		}
		c.removeLocked(oldest)
		if len(resource.segments) == 0 && resource.writers == 0 {
			delete(c.resources, oldest.Key)
		}
	}
}

func (c *VideoDataCache) Stats() (VideoDataCacheStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.pruneLocked()
	count := 0
	for _, resource := range c.resources {
		if len(resource.segments) > 0 {
			count++
		}
	}
	return VideoDataCacheStats{Count: count, TotalBytes: c.totalBytes}, nil
}

func (c *VideoDataCache) Clear() (VideoDataCacheStats, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	// 先使正在写入的资源失效，清理失败时也不能由旧请求重新填回。
	c.resources = make(map[string]*videoDataResource)
	c.versions = make(map[string]string)
	c.totalBytes = 0
	files, err := os.ReadDir(c.dir)
	if err != nil {
		return VideoDataCacheStats{}, fmt.Errorf("读取视频数据缓存目录：%w", err)
	}
	for _, file := range files {
		if file.IsDir() || !(strings.HasSuffix(file.Name(), ".bin") || strings.HasSuffix(file.Name(), ".json") || strings.HasSuffix(file.Name(), ".tmp")) {
			continue
		}
		if err := os.Remove(filepath.Join(c.dir, file.Name())); err != nil && !os.IsNotExist(err) {
			return VideoDataCacheStats{}, fmt.Errorf("清空视频数据缓存：%w", err)
		}
	}
	return VideoDataCacheStats{}, nil
}

func (c *VideoDataCache) SetLimits(age time.Duration, size int64) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.maxAge, c.maxBytes = age, size
	c.pruneLocked()
	return nil
}

func (c *VideoDataCache) ObserveVersion(key, version string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.resources[key] == nil && c.versions[key] == "" {
		return
	}
	c.versions[key] = version
	if resource := c.resources[key]; resource != nil && resource.version != version {
		c.dropLocked(key)
	}
}

func videoDataRange(value string, total int64) (start, end int64, ok bool) {
	if value == "" {
		return 0, total - 1, total > 0
	}
	if !strings.HasPrefix(value, "bytes=") || strings.Contains(value, ",") {
		return 0, 0, false
	}
	left, right, found := strings.Cut(strings.TrimPrefix(value, "bytes="), "-")
	if !found {
		return 0, 0, false
	}
	if left == "" {
		length, err := strconv.ParseInt(right, 10, 64)
		if err != nil || length <= 0 {
			return 0, 0, false
		}
		return max(0, total-length), total - 1, total > 0
	}
	start, err := strconv.ParseInt(left, 10, 64)
	if err != nil || start < 0 || start >= total {
		return 0, 0, false
	}
	end = total - 1
	if right != "" {
		end, err = strconv.ParseInt(right, 10, 64)
		if err != nil || end < start {
			return 0, 0, false
		}
		end = min(end, total-1)
	}
	return start, end, true
}

func (c *VideoDataCache) Serve(w http.ResponseWriter, r *http.Request, key, version string) bool {
	c.mu.Lock()
	c.pruneLocked()
	if expected := c.versions[key]; expected != "" && expected != version {
		c.mu.Unlock()
		return false
	}
	resource := c.resources[key]
	if resource == nil || resource.version != version {
		if resource != nil {
			c.dropLocked(key)
		}
		c.mu.Unlock()
		return false
	}
	if condition := r.Header.Get("If-Range"); condition != "" && (strings.HasPrefix(condition, "W/") || condition != resource.header.Get("ETag") && condition != resource.header.Get("Last-Modified")) {
		c.mu.Unlock()
		return false
	}
	start, end, ok := videoDataRange(r.Header.Get("Range"), resource.total)
	if !ok {
		c.mu.Unlock()
		return false
	}
	var readers []io.Reader
	var opened []*os.File
	var used []*videoDataSegment
	cursor := start
	for cursor <= end {
		var best *videoDataSegment
		for _, segment := range resource.segments {
			if segment.Start <= cursor && segment.Start+segment.Length > cursor && (best == nil || segment.Start+segment.Length > best.Start+best.Length) {
				best = segment
			}
		}
		if best == nil {
			break
		}
		file, err := os.Open(filepath.Join(c.dir, best.File))
		if err != nil {
			break
		}
		length := min(end+1, best.Start+best.Length) - cursor
		readers = append(readers, io.NewSectionReader(file, cursor-best.Start, length))
		opened = append(opened, file)
		used = append(used, best)
		cursor += length
	}
	defer func() {
		for _, file := range opened {
			_ = file.Close()
		}
	}()
	if cursor == start || r.Header.Get("Range") == "" && cursor <= end {
		c.mu.Unlock()
		return false
	}
	for _, segment := range used {
		// LRU 使用时间只在命中时落盘，最多每分钟写一次，不延长数据有效期。
		persist := c.now().Sub(segment.persistedUsed) >= time.Minute
		segment.Used = c.now()
		if persist && c.persistLocked(segment) == nil {
			segment.persistedUsed = segment.Used
		}
	}
	header, total := resource.header.Clone(), resource.total
	c.mu.Unlock()
	for name, values := range header {
		w.Header()[name] = values
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(cursor-start, 10))
	w.Header().Set("Cache-Control", "private, no-cache")
	if r.Header.Get("Range") != "" {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, cursor-1, total))
		w.WriteHeader(http.StatusPartialContent)
	} else {
		w.WriteHeader(http.StatusOK)
	}
	_, _ = io.Copy(w, io.MultiReader(readers...))
	return true
}

func (c *VideoDataCache) persistLocked(segment *videoDataSegment) error {
	data, err := json.Marshal(segment)
	if err != nil {
		return err
	}
	file, err := os.CreateTemp(c.dir, "index-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	_, err = file.Write(data)
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), filepath.Join(c.dir, strings.TrimSuffix(segment.File, ".bin")+".json"))
}

type videoDataCapture struct {
	cache            *VideoDataCache
	key              string
	resource         *videoDataResource
	start, remaining int64
	buffer           []byte
	failed           bool
}

func (c *VideoDataCache) Capture(key, version string, resp *http.Response) *videoDataCapture {
	if resp.Header.Get("Content-Encoding") != "" || strings.Contains(strings.ToLower(resp.Header.Get("Cache-Control")), "no-store") || resp.Header.Get("Vary") != "" {
		return nil
	}
	var start, end, total int64
	switch resp.StatusCode {
	case http.StatusOK:
		total = resp.ContentLength
		end = total - 1
	case http.StatusPartialContent:
		if _, err := fmt.Sscanf(resp.Header.Get("Content-Range"), "bytes %d-%d/%d", &start, &end, &total); err != nil {
			return nil
		}
	default:
		return nil
	}
	if total <= 0 || start < 0 || end < start || end >= total || resp.ContentLength >= 0 && resp.ContentLength != end-start+1 {
		return nil
	}
	header := make(http.Header)
	for _, name := range []string{"Content-Type", "Content-Disposition", "ETag", "Last-Modified"} {
		if value := resp.Header.Get(name); value != "" {
			header.Set(name, value)
		}
	}
	validator := header.Get("ETag")
	if strings.HasPrefix(validator, "W/") {
		validator = ""
	}
	if validator == "" {
		validator = header.Get("Last-Modified")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.maxBytes <= 0 {
		return nil
	}
	if expected := c.versions[key]; expected != "" && expected != version {
		return nil
	}
	resource := c.resources[key]
	if resource != nil && (resource.version != version || resource.validator != validator || resource.total != total) {
		c.dropLocked(key)
		resource = nil
	}
	if resource == nil {
		resource = &videoDataResource{version: version, validator: validator, total: total, header: header}
		c.resources[key] = resource
		c.versions[key] = version
	}
	resource.writers++
	return &videoDataCapture{cache: c, key: key, resource: resource, start: start, remaining: end - start + 1}
}

func (capture *videoDataCapture) Write(data []byte) (int, error) {
	length := len(data)
	if capture.failed {
		return length, nil
	}
	for len(data) > 0 && capture.remaining > 0 && !capture.failed {
		size := min(len(data), videoDataBlockSize-len(capture.buffer), int(capture.remaining))
		capture.buffer = append(capture.buffer, data[:size]...)
		capture.remaining -= int64(size)
		data = data[size:]
		if len(capture.buffer) == videoDataBlockSize {
			capture.flush()
		}
	}
	return length, nil
}

func (capture *videoDataCapture) flush() {
	if len(capture.buffer) == 0 || capture.failed {
		return
	}
	c := capture.cache
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.resources[capture.key] != capture.resource || int64(len(capture.buffer)) > c.maxBytes {
		capture.failed = true
		capture.buffer = nil
		return
	}
	for _, segment := range capture.resource.segments {
		if segment.Start <= capture.start && segment.Start+segment.Length >= capture.start+int64(len(capture.buffer)) {
			capture.start += int64(len(capture.buffer))
			capture.buffer = capture.buffer[:0]
			return
		}
	}
	file, err := os.CreateTemp(c.dir, "segment-*.tmp")
	if err != nil {
		capture.failed = true
		capture.buffer = nil
		return
	}
	temp := file.Name()
	defer os.Remove(temp)
	_, err = file.Write(capture.buffer)
	closeErr := file.Close()
	if err == nil {
		err = closeErr
	}
	name := strings.TrimSuffix(filepath.Base(temp), ".tmp") + ".bin"
	if err == nil {
		err = os.Rename(temp, filepath.Join(c.dir, name))
	}
	if err != nil {
		capture.failed = true
		capture.buffer = nil
		return
	}
	segment := &videoDataSegment{Key: capture.key, Version: capture.resource.version, Validator: capture.resource.validator, Total: capture.resource.total, Header: capture.resource.header, File: name, Start: capture.start, Length: int64(len(capture.buffer)), Created: c.now(), Used: c.now()}
	segment.persistedUsed = segment.Used
	if err := c.persistLocked(segment); err != nil {
		_ = os.Remove(filepath.Join(c.dir, name))
		capture.failed = true
		capture.buffer = nil
		return
	}
	capture.resource.segments = append(capture.resource.segments, segment)
	c.totalBytes += segment.Length
	capture.start += segment.Length
	capture.buffer = capture.buffer[:0]
	c.pruneLocked()
}

func writeCachedProxyResponse(w http.ResponseWriter, resp *http.Response, capture *videoDataCapture) {
	defer resp.Body.Close()
	defer func() {
		capture.cache.mu.Lock()
		defer capture.cache.mu.Unlock()
		capture.resource.writers--
		if capture.cache.resources[capture.key] == capture.resource && capture.resource.writers == 0 && len(capture.resource.segments) == 0 {
			delete(capture.cache.resources, capture.key)
		}
	}()
	for name, values := range resp.Header {
		w.Header()[name] = values
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(resp.StatusCode)
	// io.Copy 在客户端断开时停止读取；只提交已经收到的完整字节区间。
	_, _ = io.Copy(w, io.TeeReader(resp.Body, capture))
	capture.flush()
}
