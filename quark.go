package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"mime"
	"net"
	"net/http"
	"net/url"
	"path"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultQuarkAPIEndpoint = "https://drive-pc.quark.cn"
	defaultQuarkChunkSize   = int64(300 * 1024 * 1024)
	quarkListPageSize       = 50
)

const quarkDesktopUserAgent = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
	"(KHTML, like Gecko) quark-cloud-drive/3.14.2 Chrome/112.0.5615.165 " +
	"Electron/24.1.3.8 Safari/537.36 Channel/pckk_other_ch"

type QuarkIDCacheStats struct {
	Count int `json:"count"`
}

type quarkIDCacheValue struct {
	path        string
	fid         string
	isDirectory bool
	size        int64
	modifiedAt  string
	contentType string
	cachedAt    time.Time
	expiresAt   time.Time
}

type quarkDownloadCacheValue struct {
	path           string
	fid            string
	downloadURL    string
	downloadCookie string
	size           int64
	cachedAt       time.Time
	expiresAt      time.Time
}

type QuarkDrive struct {
	apiEndpoint *url.URL
	server      *http.Server
	listener    net.Listener

	mu          sync.RWMutex
	cookie      string
	downloadTTL time.Duration
	idTTL       time.Duration
	idCache     map[string]quarkIDCacheValue
	downloads   map[string]quarkDownloadCacheValue
	chunkSize   int64

	apiClient    *http.Client
	streamClient *http.Client
}

type quarkListItem struct {
	FID        string `json:"fid"`
	FileName   string `json:"file_name"`
	ParentFID  string `json:"pdir_fid"`
	Dir        bool   `json:"dir"`
	File       bool   `json:"file"`
	Size       int64  `json:"size"`
	FormatType string `json:"format_type"`
	UpdatedAt  int64  `json:"updated_at"`
}

type quarkListResponse struct {
	Status  int    `json:"status"`
	Code    int    `json:"code"`
	Message string `json:"message"`
	Data    struct {
		List []quarkListItem `json:"list"`
	} `json:"data"`
	Metadata struct {
		Page  int `json:"_page"`
		Size  int `json:"_size"`
		Count int `json:"_count"`
		Total int `json:"_total"`
	} `json:"metadata"`
}

type quarkDownloadItem struct {
	FID         string `json:"fid"`
	FileName    string `json:"file_name"`
	DownloadURL string `json:"download_url"`
	Size        int64  `json:"size"`
}

type quarkDownloadResponse struct {
	Status  int                 `json:"status"`
	Code    int                 `json:"code"`
	Message string              `json:"message"`
	Data    []quarkDownloadItem `json:"data"`
}

func NewQuarkDrive(downloadTTL, idTTL time.Duration) (*QuarkDrive, error) {
	return newQuarkDrive(defaultQuarkAPIEndpoint, downloadTTL, idTTL, defaultQuarkChunkSize)
}

func newQuarkDrive(apiEndpoint string, downloadTTL, idTTL time.Duration, chunkSize int64) (*QuarkDrive, error) {
	base, err := url.Parse(apiEndpoint)
	if err != nil {
		return nil, fmt.Errorf("parse Quark API endpoint: %w", err)
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return nil, fmt.Errorf("unsupported Quark API endpoint scheme %q", base.Scheme)
	}
	if chunkSize <= 0 {
		return nil, errors.New("Quark chunk size must be positive")
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("start local Quark proxy: %w", err)
	}

	q := &QuarkDrive{
		apiEndpoint:  base,
		listener:     listener,
		downloadTTL:  downloadTTL,
		idTTL:        idTTL,
		idCache:      make(map[string]quarkIDCacheValue),
		downloads:    make(map[string]quarkDownloadCacheValue),
		chunkSize:    chunkSize,
		apiClient:    &http.Client{Timeout: 30 * time.Second},
		streamClient: &http.Client{},
	}
	q.server = &http.Server{
		Handler:           q,
		ReadHeaderTimeout: 15 * time.Second,
	}
	go func() {
		_ = q.server.Serve(listener)
	}()
	return q, nil
}

func (q *QuarkDrive) Close() error {
	if q.server == nil {
		return nil
	}
	return q.server.Close()
}

func (q *QuarkDrive) BaseURL() string {
	return "http://" + q.listener.Addr().String()
}

func (q *QuarkDrive) URLForPath(remotePath string) string {
	u := &url.URL{
		Scheme: "http",
		Host:   q.listener.Addr().String(),
		Path:   "/quark" + normalizeRemotePath(remotePath),
	}
	return u.String()
}

func (q *QuarkDrive) SetCookie(cookie string) {
	cookie = strings.TrimSpace(cookie)
	q.mu.Lock()
	if q.cookie != cookie {
		q.cookie = cookie
		clear(q.idCache)
		clear(q.downloads)
	} else {
		q.cookie = cookie
	}
	q.mu.Unlock()
}

func (q *QuarkDrive) SetDownloadTTL(ttl time.Duration) {
	q.mu.Lock()
	q.downloadTTL = ttl
	now := time.Now()
	for key, item := range q.downloads {
		item.expiresAt = item.cachedAt.Add(ttl)
		if !item.expiresAt.After(now) {
			delete(q.downloads, key)
			continue
		}
		q.downloads[key] = item
	}
	q.mu.Unlock()
}

func (q *QuarkDrive) SetIDTTL(ttl time.Duration) {
	q.mu.Lock()
	q.idTTL = ttl
	now := time.Now()
	for key, item := range q.idCache {
		item.expiresAt = item.cachedAt.Add(ttl)
		if !item.expiresAt.After(now) {
			delete(q.idCache, key)
			continue
		}
		q.idCache[key] = item
	}
	q.mu.Unlock()
}

func (q *QuarkDrive) ClearIDCache() QuarkIDCacheStats {
	q.mu.Lock()
	clear(q.idCache)
	q.mu.Unlock()
	return QuarkIDCacheStats{}
}

func (q *QuarkDrive) IDCacheStats() QuarkIDCacheStats {
	now := time.Now()
	q.mu.Lock()
	for key, item := range q.idCache {
		if !item.expiresAt.After(now) {
			delete(q.idCache, key)
		}
	}
	count := len(q.idCache)
	q.mu.Unlock()
	return QuarkIDCacheStats{Count: count}
}

func (q *QuarkDrive) ClearDownloadCache() {
	q.mu.Lock()
	clear(q.downloads)
	q.mu.Unlock()
}

func (q *QuarkDrive) DownloadCacheEntries() []RedirectCacheEntry {
	now := time.Now()
	q.mu.Lock()
	entries := make([]RedirectCacheEntry, 0, len(q.downloads))
	for key, item := range q.downloads {
		if !item.expiresAt.After(now) {
			delete(q.downloads, key)
			continue
		}
		entries = append(entries, RedirectCacheEntry{
			Path:        item.path,
			SourceURL:   "fid:" + item.fid,
			RedirectURL: item.downloadURL,
			CachedAt:    item.cachedAt.Local().Format(time.RFC3339),
			ExpiresAt:   item.expiresAt.Local().Format(time.RFC3339),
		})
	}
	q.mu.Unlock()
	return entries
}

func (q *QuarkDrive) ValidateCookie(ctx context.Context, cookie string) error {
	cookie = strings.TrimSpace(cookie)
	if cookie == "" {
		return errors.New("Cookie 不能为空")
	}
	_, err := q.listFolderPage(ctx, cookie, "0", 1)
	return err
}

func (q *QuarkDrive) ListDirectory(ctx context.Context, remotePath string) ([]FileEntry, error) {
	cookie, err := q.currentCookie()
	if err != nil {
		return nil, err
	}
	remotePath = normalizeRemotePath(remotePath)
	folder, err := q.resolvePath(ctx, cookie, remotePath)
	if err != nil {
		return nil, err
	}
	if !folder.isDirectory {
		return nil, fmt.Errorf("%s 不是目录", remotePath)
	}
	items, err := q.listFolderAll(ctx, cookie, folder.fid)
	if err != nil {
		return nil, err
	}

	entries := make([]FileEntry, 0, len(items))
	for _, item := range items {
		entryPath := joinRemotePath(remotePath, item.FileName)
		entry := quarkItemToFileEntry(entryPath, item)
		entries = append(entries, entry)
		q.storeID(entryPath, item)
	}
	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDirectory != entries[j].IsDirectory {
			return entries[i].IsDirectory
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}

func (q *QuarkDrive) resolvePath(ctx context.Context, cookie, remotePath string) (quarkIDCacheValue, error) {
	remotePath = normalizeRemotePath(remotePath)
	if remotePath == "/" {
		return quarkIDCacheValue{path: "/", fid: "0", isDirectory: true}, nil
	}
	if item, ok := q.cachedID(remotePath); ok {
		return item, nil
	}

	segments := strings.Split(strings.Trim(remotePath, "/"), "/")
	parentPath := "/"
	parentFID := "0"
	var resolved quarkIDCacheValue
	for _, segment := range segments {
		childPath := joinRemotePath(parentPath, segment)
		if cached, ok := q.cachedID(childPath); ok {
			resolved = cached
			parentPath = childPath
			parentFID = cached.fid
			continue
		}

		items, err := q.listFolderAll(ctx, cookie, parentFID)
		if err != nil {
			return quarkIDCacheValue{}, err
		}
		found := false
		for _, item := range items {
			itemPath := joinRemotePath(parentPath, item.FileName)
			q.storeID(itemPath, item)
			if item.FileName == segment {
				resolved, _ = q.cachedID(itemPath)
				found = true
			}
		}
		if !found {
			return quarkIDCacheValue{}, fmt.Errorf("夸克网盘路径不存在: %s", childPath)
		}
		parentPath = childPath
		parentFID = resolved.fid
	}
	return resolved, nil
}

func (q *QuarkDrive) listFolderAll(ctx context.Context, cookie, folderFID string) ([]quarkListItem, error) {
	items := make([]quarkListItem, 0, quarkListPageSize)
	for pageNumber := 1; ; pageNumber++ {
		page, err := q.listFolderPage(ctx, cookie, folderFID, pageNumber)
		if err != nil {
			return nil, err
		}
		items = append(items, page.Data.List...)
		if len(page.Data.List) < quarkListPageSize || (page.Metadata.Total > 0 && len(items) >= page.Metadata.Total) {
			break
		}
	}
	return items, nil
}

func (q *QuarkDrive) listFolderPage(ctx context.Context, cookie, folderFID string, pageNumber int) (quarkListResponse, error) {
	u := q.apiURL("/1/clouddrive/file/sort")
	query := u.Query()
	query.Set("pr", "ucpro")
	query.Set("fr", "pc")
	query.Set("pdir_fid", folderFID)
	query.Set("_page", strconv.Itoa(pageNumber))
	query.Set("_size", strconv.Itoa(quarkListPageSize))
	query.Set("_fetch_total", "1")
	query.Set("_sort", "file_type:asc,updated_at:desc")
	u.RawQuery = query.Encode()

	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return quarkListResponse{}, err
	}
	req.Header.Set("Cookie", cookie)

	var payload quarkListResponse
	if _, err := q.doJSON(req, &payload); err != nil {
		return quarkListResponse{}, err
	}
	return payload, nil
}

func (q *QuarkDrive) getDownloadInfo(ctx context.Context, remotePath string, force bool) (quarkDownloadCacheValue, error) {
	remotePath = normalizeRemotePath(remotePath)
	if !force {
		if item, ok := q.cachedDownload(remotePath); ok {
			return item, nil
		}
	}

	cookie, err := q.currentCookie()
	if err != nil {
		return quarkDownloadCacheValue{}, err
	}
	resolved, err := q.resolvePath(ctx, cookie, remotePath)
	if err != nil {
		return quarkDownloadCacheValue{}, err
	}
	if resolved.isDirectory {
		return quarkDownloadCacheValue{}, fmt.Errorf("%s 是目录，无法下载", remotePath)
	}

	u := q.apiURL("/1/clouddrive/file/download")
	query := u.Query()
	query.Set("pr", "ucpro")
	query.Set("fr", "pc")
	u.RawQuery = query.Encode()
	body, err := json.Marshal(map[string]any{"fids": []string{resolved.fid}})
	if err != nil {
		return quarkDownloadCacheValue{}, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, u.String(), strings.NewReader(string(body)))
	if err != nil {
		return quarkDownloadCacheValue{}, err
	}
	req.Header.Set("Cookie", cookie)
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json, text/plain, */*")
	req.Header.Set("Origin", "https://pan.quark.cn")
	req.Header.Set("Referer", "https://pan.quark.cn/")
	req.Header.Set("User-Agent", quarkDesktopUserAgent)

	var payload quarkDownloadResponse
	resp, err := q.doJSON(req, &payload)
	if err != nil {
		return quarkDownloadCacheValue{}, err
	}
	if len(payload.Data) == 0 || payload.Data[0].DownloadURL == "" {
		return quarkDownloadCacheValue{}, errors.New("夸克下载接口没有返回 download_url")
	}
	downloadCookie := extractResponseCookies(resp.Header)
	if downloadCookie == "" {
		return quarkDownloadCacheValue{}, errors.New("夸克下载接口没有返回新的下载 Cookie")
	}

	downloadItem := payload.Data[0]
	size := downloadItem.Size
	if size <= 0 {
		size = resolved.size
	}
	now := time.Now()
	q.mu.RLock()
	ttl := q.downloadTTL
	q.mu.RUnlock()
	item := quarkDownloadCacheValue{
		path:           remotePath,
		fid:            resolved.fid,
		downloadURL:    downloadItem.DownloadURL,
		downloadCookie: downloadCookie,
		size:           size,
		cachedAt:       now,
		expiresAt:      now.Add(ttl),
	}
	q.mu.Lock()
	q.downloads[remotePath] = item
	q.mu.Unlock()
	return item, nil
}

func (q *QuarkDrive) doJSON(req *http.Request, target any) (*http.Response, error) {
	resp, err := q.apiClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4*1024*1024))
	if err != nil {
		return nil, err
	}
	if err := json.Unmarshal(body, target); err != nil {
		return nil, fmt.Errorf("解析夸克 API 响应失败 (%s): %s", resp.Status, strings.TrimSpace(string(body)))
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("夸克 API 请求失败: %s", resp.Status)
	}
	code, message := quarkPayloadCode(target)
	if code != 0 {
		return nil, fmt.Errorf("夸克 API 返回 %d: %s", code, message)
	}
	return resp, nil
}

func quarkPayloadCode(target any) (int, string) {
	switch value := target.(type) {
	case *quarkListResponse:
		return value.Code, value.Message
	case *quarkDownloadResponse:
		return value.Code, value.Message
	default:
		return 0, ""
	}
}

func (q *QuarkDrive) apiURL(endpointPath string) *url.URL {
	u := *q.apiEndpoint
	u.Path = endpointPath
	u.RawQuery = ""
	u.Fragment = ""
	return &u
}

func (q *QuarkDrive) currentCookie() (string, error) {
	q.mu.RLock()
	cookie := q.cookie
	q.mu.RUnlock()
	if cookie == "" {
		return "", errors.New("尚未登录夸克网盘")
	}
	return cookie, nil
}

func (q *QuarkDrive) storeID(remotePath string, item quarkListItem) {
	remotePath = normalizeRemotePath(remotePath)
	now := time.Now()
	q.mu.RLock()
	ttl := q.idTTL
	q.mu.RUnlock()
	entry := quarkIDCacheValue{
		path:        remotePath,
		fid:         item.FID,
		isDirectory: item.Dir,
		size:        item.Size,
		modifiedAt:  quarkModifiedAt(item.UpdatedAt),
		contentType: quarkContentType(item.FileName, item.FormatType, item.Dir),
		cachedAt:    now,
		expiresAt:   now.Add(ttl),
	}
	q.mu.Lock()
	q.idCache[remotePath] = entry
	q.mu.Unlock()
}

func (q *QuarkDrive) cachedID(remotePath string) (quarkIDCacheValue, bool) {
	remotePath = normalizeRemotePath(remotePath)
	q.mu.Lock()
	defer q.mu.Unlock()
	item, ok := q.idCache[remotePath]
	if !ok {
		return quarkIDCacheValue{}, false
	}
	if !item.expiresAt.After(time.Now()) {
		delete(q.idCache, remotePath)
		return quarkIDCacheValue{}, false
	}
	return item, true
}

func (q *QuarkDrive) cachedDownload(remotePath string) (quarkDownloadCacheValue, bool) {
	remotePath = normalizeRemotePath(remotePath)
	q.mu.Lock()
	defer q.mu.Unlock()
	item, ok := q.downloads[remotePath]
	if !ok {
		return quarkDownloadCacheValue{}, false
	}
	if !item.expiresAt.After(time.Now()) {
		delete(q.downloads, remotePath)
		return quarkDownloadCacheValue{}, false
	}
	return item, true
}

func (q *QuarkDrive) deleteDownload(remotePath string) {
	q.mu.Lock()
	delete(q.downloads, normalizeRemotePath(remotePath))
	q.mu.Unlock()
}

func (q *QuarkDrive) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/quark") {
		http.NotFound(w, r)
		return
	}
	if _, err := q.currentCookie(); err != nil {
		http.Error(w, err.Error(), http.StatusUnauthorized)
		return
	}
	remotePath := normalizeRemotePath(strings.TrimPrefix(r.URL.Path, "/quark"))
	switch r.Method {
	case http.MethodGet:
		q.serveGET(w, r, remotePath)
	case http.MethodHead:
		q.serveHEAD(w, r, remotePath)
	default:
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
	}
}

func (q *QuarkDrive) serveHEAD(w http.ResponseWriter, r *http.Request, remotePath string) {
	info, err := q.getDownloadInfo(r.Context(), remotePath, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if info.size <= 0 {
		http.Error(w, "夸克 API 未返回文件大小，无法安全代理下载", http.StatusBadGateway)
		return
	}
	w.Header().Set("Accept-Ranges", "bytes")
	w.Header().Set("Content-Length", strconv.FormatInt(info.size, 10))
	w.Header().Set("Content-Type", quarkContentType(path.Base(remotePath), "", false))
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(http.StatusOK)
}

func (q *QuarkDrive) serveGET(w http.ResponseWriter, r *http.Request, remotePath string) {
	info, err := q.getDownloadInfo(r.Context(), remotePath, false)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if info.size <= 0 {
		http.Error(w, "夸克 API 未返回文件大小，无法计算 GET 请求大小", http.StatusBadGateway)
		return
	}

	start, end, partial, err := parseSingleByteRange(r.Header.Get("Range"), info.size)
	if err != nil {
		w.Header().Set("Content-Range", fmt.Sprintf("bytes */%d", info.size))
		http.Error(w, "invalid range", http.StatusRequestedRangeNotSatisfiable)
		return
	}
	length := end - start + 1
	if length <= q.chunkSize {
		rangeHeader := ""
		if partial {
			rangeHeader = fmt.Sprintf("bytes=%d-%d", start, end)
		}
		q.serveSingleObjectRequest(w, r, remotePath, info, rangeHeader)
		return
	}

	q.serveChunkedObjectRequest(w, r, remotePath, info, start, end, partial)
}

func (q *QuarkDrive) serveSingleObjectRequest(w http.ResponseWriter, source *http.Request, remotePath string, info quarkDownloadCacheValue, rangeHeader string) {
	resp, _, err := q.openObjectRequest(source.Context(), source.Header, remotePath, info, rangeHeader, true)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeProxyResponse(w, resp)
}

func (q *QuarkDrive) serveChunkedObjectRequest(w http.ResponseWriter, source *http.Request, remotePath string, info quarkDownloadCacheValue, start, end int64, partial bool) {
	current := start
	currentInfo := info
	first := true
	headersWritten := false
	for current <= end {
		chunkEnd := current + q.chunkSize - 1
		if chunkEnd > end {
			chunkEnd = end
		}
		rangeHeader := fmt.Sprintf("bytes=%d-%d", current, chunkEnd)
		resp, refreshedInfo, err := q.openObjectRequest(source.Context(), source.Header, remotePath, currentInfo, rangeHeader, first)
		if err != nil {
			if !headersWritten {
				http.Error(w, err.Error(), http.StatusBadGateway)
			}
			return
		}
		currentInfo = refreshedInfo
		if first && resp.StatusCode == http.StatusNotModified {
			writeProxyResponse(w, resp)
			return
		}
		if resp.StatusCode != http.StatusPartialContent {
			resp.Body.Close()
			if !headersWritten {
				http.Error(w, fmt.Sprintf("夸克分块下载需要 206，实际返回 %s", resp.Status), http.StatusBadGateway)
			}
			return
		}

		if !headersWritten {
			copyQuarkObjectHeaders(w.Header(), resp.Header)
			w.Header().Set("Accept-Ranges", "bytes")
			w.Header().Set("Content-Length", strconv.FormatInt(end-start+1, 10))
			if partial {
				w.Header().Set("Content-Range", fmt.Sprintf("bytes %d-%d/%d", start, end, info.size))
			} else {
				w.Header().Del("Content-Range")
			}
			w.Header().Set("Access-Control-Allow-Origin", "*")
			if partial {
				w.WriteHeader(http.StatusPartialContent)
			} else {
				w.WriteHeader(http.StatusOK)
			}
			headersWritten = true
		}

		expected := chunkEnd - current + 1
		written, copyErr := io.Copy(w, resp.Body)
		resp.Body.Close()
		if copyErr != nil || written != expected {
			return
		}
		if flusher, ok := w.(http.Flusher); ok {
			flusher.Flush()
		}
		current = chunkEnd + 1
		first = false
	}
}

func (q *QuarkDrive) openObjectRequest(ctx context.Context, sourceHeaders http.Header, remotePath string, info quarkDownloadCacheValue, rangeHeader string, includeConditionals bool) (*http.Response, quarkDownloadCacheValue, error) {
	resp, err := q.doObjectRequest(ctx, sourceHeaders, info, rangeHeader, includeConditionals)
	if err != nil {
		return nil, info, err
	}
	if !isExpiredSignedURLStatus(resp.StatusCode) {
		return resp, info, nil
	}
	resp.Body.Close()
	q.deleteDownload(remotePath)
	fresh, err := q.getDownloadInfo(ctx, remotePath, true)
	if err != nil {
		return nil, info, err
	}
	resp, err = q.doObjectRequest(ctx, sourceHeaders, fresh, rangeHeader, includeConditionals)
	if err != nil {
		return nil, fresh, err
	}
	return resp, fresh, nil
}

func (q *QuarkDrive) doObjectRequest(ctx context.Context, sourceHeaders http.Header, info quarkDownloadCacheValue, rangeHeader string, includeConditionals bool) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, info.downloadURL, nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Cookie", info.downloadCookie)
	req.Header.Set("Accept-Encoding", "identity")
	if rangeHeader != "" {
		req.Header.Set("Range", rangeHeader)
	}
	if includeConditionals {
		for _, key := range []string{"If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since"} {
			if value := sourceHeaders.Get(key); value != "" {
				req.Header.Set(key, value)
			}
		}
	}
	return q.streamClient.Do(req)
}

func parseSingleByteRange(header string, size int64) (start, end int64, partial bool, err error) {
	if size <= 0 {
		return 0, 0, false, errors.New("unknown file size")
	}
	header = strings.TrimSpace(header)
	if header == "" {
		return 0, size - 1, false, nil
	}
	if !strings.HasPrefix(strings.ToLower(header), "bytes=") || strings.Contains(header, ",") {
		return 0, 0, false, errors.New("unsupported range")
	}
	value := strings.TrimSpace(header[len("bytes="):])
	parts := strings.SplitN(value, "-", 2)
	if len(parts) != 2 {
		return 0, 0, false, errors.New("invalid range")
	}
	if parts[0] == "" {
		suffix, parseErr := strconv.ParseInt(parts[1], 10, 64)
		if parseErr != nil || suffix <= 0 {
			return 0, 0, false, errors.New("invalid suffix range")
		}
		if suffix > size {
			suffix = size
		}
		return size - suffix, size - 1, true, nil
	}
	start, err = strconv.ParseInt(parts[0], 10, 64)
	if err != nil || start < 0 || start >= size {
		return 0, 0, false, errors.New("invalid range start")
	}
	if parts[1] == "" {
		return start, size - 1, true, nil
	}
	end, err = strconv.ParseInt(parts[1], 10, 64)
	if err != nil || end < start {
		return 0, 0, false, errors.New("invalid range end")
	}
	if end >= size {
		end = size - 1
	}
	return start, end, true, nil
}

func copyQuarkObjectHeaders(target, source http.Header) {
	for _, key := range []string{"Content-Type", "Content-Disposition", "ETag", "Last-Modified", "Cache-Control"} {
		for _, value := range source.Values(key) {
			target.Add(key, value)
		}
	}
}

func extractResponseCookies(header http.Header) string {
	values := header.Values("Set-Cookie")
	pairs := make([]string, 0, len(values))
	for _, value := range values {
		if pair := strings.TrimSpace(strings.SplitN(value, ";", 2)[0]); pair != "" && strings.Contains(pair, "=") {
			pairs = append(pairs, pair)
		}
	}
	return strings.Join(pairs, "; ")
}

func joinRemotePath(parentPath, name string) string {
	parentPath = normalizeRemotePath(parentPath)
	name = strings.Trim(name, "/")
	if parentPath == "/" {
		return normalizeRemotePath("/" + name)
	}
	return normalizeRemotePath(parentPath + "/" + name)
}

func quarkItemToFileEntry(remotePath string, item quarkListItem) FileEntry {
	return FileEntry{
		Name:        item.FileName,
		Path:        normalizeRemotePath(remotePath),
		IsDirectory: item.Dir,
		Size:        item.Size,
		ModifiedAt:  quarkModifiedAt(item.UpdatedAt),
		ContentType: quarkContentType(item.FileName, item.FormatType, item.Dir),
	}
}

func quarkModifiedAt(value int64) string {
	if value <= 0 {
		return ""
	}
	if value > 1_000_000_000_000 {
		return time.UnixMilli(value).Local().Format(time.RFC3339)
	}
	return time.Unix(value, 0).Local().Format(time.RFC3339)
}

func quarkContentType(fileName, formatType string, isDirectory bool) string {
	if isDirectory {
		return ""
	}
	if strings.Contains(formatType, "/") {
		return formatType
	}
	if detected := mime.TypeByExtension(strings.ToLower(path.Ext(fileName))); detected != "" {
		return detected
	}
	return "application/octet-stream"
}
