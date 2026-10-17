package main

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"time"
)

type webDAVProxyAccount struct {
	endpoint *url.URL
	username string
	password string
}

type WebDAVProxy struct {
	server   *http.Server
	listener net.Listener

	mu               sync.RWMutex
	accounts         map[string]webDAVProxyAccount
	videoSnapshotDir string
	videoDataCache   *VideoDataCache
}

func NewWebDAVProxy() (*WebDAVProxy, error) {
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("start local WebDAV proxy: %w", err)
	}

	p := &WebDAVProxy{
		listener: listener,
		accounts: make(map[string]webDAVProxyAccount),
	}
	p.server = &http.Server{
		Handler:           p,
		ReadHeaderTimeout: 15 * time.Second,
	}
	go func() {
		_ = p.server.Serve(listener)
	}()
	return p, nil
}

func (p *WebDAVProxy) Close() error {
	if p.server == nil {
		return nil
	}
	return p.server.Close()
}

func (p *WebDAVProxy) BaseURL() string {
	return "http://" + p.localURLHost()
}

func (p *WebDAVProxy) localURLHost() string {
	_, port, err := net.SplitHostPort(p.listener.Addr().String())
	if err != nil {
		return p.listener.Addr().String()
	}
	return net.JoinHostPort("localhost", port)
}

func (p *WebDAVProxy) SetAccount(account WebDAVAccount) error {
	base, err := url.Parse(strings.TrimSpace(account.Endpoint))
	if err != nil {
		return fmt.Errorf("parse WebDAV endpoint: %w", err)
	}
	if (base.Scheme != "http" && base.Scheme != "https") || base.Host == "" {
		return fmt.Errorf("unsupported WebDAV endpoint %q", account.Endpoint)
	}

	p.mu.Lock()
	p.accounts[account.ID] = webDAVProxyAccount{
		endpoint: base,
		username: account.Username,
		password: account.Password,
	}
	p.mu.Unlock()
	return nil
}

func (p *WebDAVProxy) RemoveAccount(id string) {
	p.mu.Lock()
	delete(p.accounts, id)
	p.mu.Unlock()
}

func (p *WebDAVProxy) HasAccount(id string) bool {
	p.mu.RLock()
	_, ok := p.accounts[id]
	p.mu.RUnlock()
	return ok
}

func (p *WebDAVProxy) URLForPath(accountID, remotePath string) string {
	u := &url.URL{
		Scheme: "http",
		Host:   p.localURLHost(),
		Path:   "/webdav/" + accountID + normalizeRemotePath(remotePath),
	}
	return u.String()
}

func (p *WebDAVProxy) SetVideoDataCache(cache *VideoDataCache) {
	p.mu.Lock()
	p.videoDataCache = cache
	p.mu.Unlock()
}

func (p *WebDAVProxy) URLForFile(accountID, remotePath, modifiedAt string, size int64) string {
	local, _ := url.Parse(p.URLForPath(accountID, remotePath))
	version := videoDataKey(modifiedAt, fmt.Sprint(size))
	query := local.Query()
	query.Set(videoVersionQuery, version)
	local.RawQuery = query.Encode()
	if account, ok := p.getAccount(accountID); ok {
		p.mu.RLock()
		cache := p.videoDataCache
		p.mu.RUnlock()
		if cache != nil {
			target, _ := buildUpstreamURL(account.endpoint.String(), remotePath, nil)
			cache.ObserveVersion(proxyVideoDataKey(accountID, account, target), version)
		}
	}
	return local.String()
}

func proxyVideoDataKey(accountID string, account webDAVProxyAccount, target *url.URL) string {
	return videoDataKey(accountID, target.String(), account.username, account.password)
}

func cacheableVideoRequest(r *http.Request) bool {
	if r.Method != http.MethodGet || r.URL.Query().Get(videoVersionQuery) == "" || strings.Contains(r.Header.Get("Range"), ",") {
		return false
	}
	for _, header := range []string{"If-Match", "If-None-Match", "If-Modified-Since", "If-Unmodified-Since"} {
		if r.Header.Get(header) != "" {
			return false
		}
	}
	return true
}

func (p *WebDAVProxy) SetVideoSnapshotDirectory(dir string) {
	p.mu.Lock()
	p.videoSnapshotDir = dir
	p.mu.Unlock()
}

func (p *WebDAVProxy) VideoSnapshotURL(fileName string) string {
	u := &url.URL{
		Scheme: "http",
		Host:   p.localURLHost(),
		Path:   "/video-snapshots/" + fileName,
	}
	return u.String()
}

func (p *WebDAVProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.Header().Set("Access-Control-Expose-Headers", "Content-Range, Accept-Ranges")
	if strings.HasPrefix(r.URL.Path, "/video-snapshots/") {
		p.serveVideoSnapshot(w, r)
		return
	}

	accountID, remotePath, ok := parseProxyWebDAVPath(r.URL.Path)
	if !ok {
		http.NotFound(w, r)
		return
	}
	account, ok := p.getAccount(accountID)
	if !ok {
		http.NotFound(w, r)
		return
	}

	query := cloneQuery(r.URL.Query())
	version := query.Get(videoVersionQuery)
	query.Del(videoVersionQuery)
	upstreamURL, err := buildUpstreamURL(account.endpoint.String(), remotePath, query)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	p.mu.RLock()
	cache := p.videoDataCache
	p.mu.RUnlock()
	useCache := cache != nil && cacheableVideoRequest(r)
	key := proxyVideoDataKey(accountID, account, upstreamURL)
	if useCache && cache.Serve(w, r, key, version) {
		return
	}
	request := r
	if useCache {
		request = r.Clone(r.Context())
		request.Header.Set("Accept-Encoding", "identity")
	}
	resp, err := p.doRequest(request, accountID, account, upstreamURL)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if useCache {
		if capture := cache.Capture(key, version, resp); capture != nil {
			writeCachedProxyResponse(w, resp, capture)
			return
		}
	}
	writeProxyResponse(w, resp)
}

func parseProxyWebDAVPath(localPath string) (accountID, remotePath string, ok bool) {
	const prefix = "/webdav/"
	if !strings.HasPrefix(localPath, prefix) {
		return "", "", false
	}
	remainder := strings.TrimPrefix(localPath, prefix)
	accountID, remainder, found := strings.Cut(remainder, "/")
	if !found || accountID == "" {
		return "", "", false
	}
	return accountID, normalizeRemotePath("/" + remainder), true
}

func (p *WebDAVProxy) serveVideoSnapshot(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		w.Header().Set("Allow", "GET, HEAD")
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}

	fileName := strings.TrimPrefix(r.URL.Path, "/video-snapshots/")
	if fileName == "" || strings.ContainsAny(fileName, `/\\`) || filepath.Base(fileName) != fileName || !isVideoSnapshotCacheFile(fileName) {
		http.NotFound(w, r)
		return
	}

	p.mu.RLock()
	dir := p.videoSnapshotDir
	p.mu.RUnlock()
	if dir == "" {
		http.NotFound(w, r)
		return
	}

	file, err := os.Open(filepath.Join(dir, fileName))
	if errors.Is(err, os.ErrNotExist) {
		http.NotFound(w, r)
		return
	}
	if err != nil {
		http.Error(w, "open video snapshot", http.StatusInternalServerError)
		return
	}
	defer file.Close()

	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		http.NotFound(w, r)
		return
	}
	mimeType := map[string]string{".png": "image/png", ".jpg": "image/jpeg", ".webp": "image/webp"}[strings.ToLower(filepath.Ext(fileName))]
	w.Header().Set("Content-Type", mimeType)
	w.Header().Set("ETag", fmt.Sprintf(`"%x-%x"`, info.ModTime().UnixNano(), info.Size()))
	w.Header().Set("Cache-Control", "private, no-cache")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	http.ServeContent(w, r, fileName, info.ModTime(), file)
}

func (p *WebDAVProxy) getAccount(id string) (webDAVProxyAccount, bool) {
	p.mu.RLock()
	account, ok := p.accounts[id]
	p.mu.RUnlock()
	return account, ok
}

func (p *WebDAVProxy) doRequest(source *http.Request, accountID string, account webDAVProxyAccount, target *url.URL) (*http.Response, error) {
	req, err := http.NewRequestWithContext(source.Context(), source.Method, target.String(), source.Body)
	if err != nil {
		return nil, err
	}
	req.Header = source.Header.Clone()
	req.ContentLength = source.ContentLength
	stripProxyOnlyHeaders(req.Header)
	if destination := req.Header.Get("Destination"); destination != "" {
		req.Header.Set("Destination", p.rewriteDestination(destination, accountID, account.endpoint))
	}
	req.Header.Set("User-Agent", "DrivePlayer/1.0")
	if account.username != "" || account.password != "" {
		req.SetBasicAuth(account.username, account.password)
	}
	return http.DefaultTransport.RoundTrip(req)
}

func (p *WebDAVProxy) rewriteDestination(destination, accountID string, endpoint *url.URL) string {
	u, err := url.Parse(destination)
	if err != nil {
		return destination
	}
	if u.Host != "" && !strings.EqualFold(u.Host, p.localURLHost()) {
		return destination
	}
	destinationAccountID, remotePath, ok := parseProxyWebDAVPath(u.Path)
	if !ok || destinationAccountID != accountID {
		return destination
	}
	target, err := buildUpstreamURL(endpoint.String(), remotePath, cloneQuery(u.Query()))
	if err != nil {
		return destination
	}
	return target.String()
}

func writeProxyResponse(w http.ResponseWriter, resp *http.Response) {
	defer resp.Body.Close()
	for key, values := range resp.Header {
		for _, value := range values {
			w.Header().Add(key, value)
		}
	}
	w.Header().Set("Access-Control-Allow-Origin", "*")
	w.WriteHeader(resp.StatusCode)
	_, _ = io.Copy(w, resp.Body)
}

func stripProxyOnlyHeaders(header http.Header) {
	header.Del("Authorization")
	header.Del("Cookie")
	header.Del("Origin")
	header.Del("Referer")
	header.Del("Connection")
	header.Del("Proxy-Connection")
}

func buildUpstreamURL(endpoint, remotePath string, query url.Values) (*url.URL, error) {
	base, err := url.Parse(endpoint)
	if err != nil {
		return nil, err
	}
	remotePath = normalizeRemotePath(remotePath)
	base.Path = strings.TrimSuffix(base.Path, "/") + remotePath
	base.RawPath = ""
	if query != nil {
		mergedQuery := base.Query()
		for key, values := range query {
			mergedQuery[key] = append([]string(nil), values...)
		}
		base.RawQuery = mergedQuery.Encode()
	}
	return base, nil
}

func cloneQuery(source url.Values) url.Values {
	target := make(url.Values, len(source))
	for key, values := range source {
		target[key] = append([]string(nil), values...)
	}
	return target
}
