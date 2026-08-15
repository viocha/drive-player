package main

import (
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

type RedirectCacheEntry struct {
	Path        string `json:"path"`
	SourceURL   string `json:"sourceUrl"`
	RedirectURL string `json:"redirectUrl"`
	CachedAt    string `json:"cachedAt"`
	ExpiresAt   string `json:"expiresAt"`
}

type redirectCacheValue struct {
	path        string
	sourceURL   string
	redirectURL string
	cachedAt    time.Time
	expiresAt   time.Time
}

type WebDAVProxy struct {
	endpoint *url.URL
	server   *http.Server
	listener net.Listener

	mu       sync.RWMutex
	username string
	password string
	ttl      time.Duration
	cache    map[string]redirectCacheValue

	noRedirectClient *http.Client
	streamClient     *http.Client
}

func NewWebDAVProxy(endpoint string, ttl time.Duration) (*WebDAVProxy, error) {
	base, err := url.Parse(endpoint)
	if err != nil {
		return nil, fmt.Errorf("parse WebDAV endpoint: %w", err)
	}
	if base.Scheme != "http" && base.Scheme != "https" {
		return nil, fmt.Errorf("unsupported WebDAV endpoint scheme %q", base.Scheme)
	}

	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return nil, fmt.Errorf("start local WebDAV proxy: %w", err)
	}

	p := &WebDAVProxy{
		endpoint: base,
		listener: listener,
		ttl:      ttl,
		cache:    make(map[string]redirectCacheValue),
		noRedirectClient: &http.Client{
			CheckRedirect: func(_ *http.Request, _ []*http.Request) error {
				return http.ErrUseLastResponse
			},
		},
		streamClient: &http.Client{},
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
	return "http://" + p.listener.Addr().String()
}

func (p *WebDAVProxy) URLForPath(remotePath string) string {
	u := &url.URL{
		Scheme: "http",
		Host:   p.listener.Addr().String(),
		Path:   "/webdav" + normalizeRemotePath(remotePath),
	}
	return u.String()
}

func (p *WebDAVProxy) SetCredentials(username, password string) {
	p.mu.Lock()
	p.username = username
	p.password = password
	p.mu.Unlock()
}

func (p *WebDAVProxy) SetTTL(ttl time.Duration) {
	p.mu.Lock()
	p.ttl = ttl
	now := time.Now()
	for key, item := range p.cache {
		item.expiresAt = item.cachedAt.Add(ttl)
		if !item.expiresAt.After(now) {
			delete(p.cache, key)
			continue
		}
		p.cache[key] = item
	}
	p.mu.Unlock()
}

func (p *WebDAVProxy) ClearCache() {
	p.mu.Lock()
	clear(p.cache)
	p.mu.Unlock()
}

func (p *WebDAVProxy) CacheEntries() []RedirectCacheEntry {
	now := time.Now()
	p.mu.Lock()
	entries := make([]RedirectCacheEntry, 0, len(p.cache))
	for key, item := range p.cache {
		if !item.expiresAt.After(now) {
			delete(p.cache, key)
			continue
		}
		entries = append(entries, RedirectCacheEntry{
			Path:        item.path,
			SourceURL:   item.sourceURL,
			RedirectURL: item.redirectURL,
			CachedAt:    item.cachedAt.Local().Format(time.RFC3339),
			ExpiresAt:   item.expiresAt.Local().Format(time.RFC3339),
		})
	}
	p.mu.Unlock()

	for i := 0; i < len(entries); i++ {
		for j := i + 1; j < len(entries); j++ {
			if entries[j].CachedAt > entries[i].CachedAt {
				entries[i], entries[j] = entries[j], entries[i]
			}
		}
	}
	return entries
}

func (p *WebDAVProxy) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !strings.HasPrefix(r.URL.Path, "/webdav") {
		http.NotFound(w, r)
		return
	}

	username, password := p.getCredentials()
	if username == "" || password == "" {
		http.Error(w, "not logged in", http.StatusUnauthorized)
		return
	}

	remotePath := normalizeRemotePath(strings.TrimPrefix(r.URL.Path, "/webdav"))
	query := cloneQuery(r.URL.Query())
	upstreamURL, err := buildUpstreamURL(p.endpoint.String(), remotePath, query)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	if r.Method == http.MethodGet {
		p.serveGET(w, r, remotePath, upstreamURL, username, password)
		return
	}
	p.proxyRequest(w, r, upstreamURL, username, password, true)
}

func (p *WebDAVProxy) getCredentials() (string, string) {
	p.mu.RLock()
	defer p.mu.RUnlock()
	return p.username, p.password
}

func (p *WebDAVProxy) serveGET(w http.ResponseWriter, r *http.Request, remotePath string, upstreamURL *url.URL, username, password string) {
	cacheKey := upstreamURL.String()
	if target, ok := p.cachedRedirect(cacheKey); ok {
		resp, err := p.doRequest(r, target, "", "", false, p.streamClient)
		if err == nil && !isExpiredSignedURLStatus(resp.StatusCode) {
			writeProxyResponse(w, resp)
			return
		}
		if resp != nil {
			resp.Body.Close()
		}
		p.deleteCache(cacheKey)
	}

	resp, err := p.doRequest(r, upstreamURL, username, password, true, p.noRedirectClient)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}

	if resp.StatusCode != http.StatusFound {
		writeProxyResponse(w, resp)
		return
	}

	location := resp.Header.Get("Location")
	resp.Body.Close()
	if location == "" {
		http.Error(w, "upstream 302 response has no Location header", http.StatusBadGateway)
		return
	}
	target, err := upstreamURL.Parse(location)
	if err != nil {
		http.Error(w, "invalid upstream redirect URL", http.StatusBadGateway)
		return
	}
	p.storeRedirect(cacheKey, remotePath, upstreamURL.String(), target.String())

	redirectResp, err := p.doRequest(r, target, "", "", false, p.streamClient)
	if err != nil {
		p.deleteCache(cacheKey)
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	if isExpiredSignedURLStatus(redirectResp.StatusCode) {
		p.deleteCache(cacheKey)
	}
	writeProxyResponse(w, redirectResp)
}

func (p *WebDAVProxy) proxyRequest(w http.ResponseWriter, r *http.Request, target *url.URL, username, password string, withAuth bool) {
	resp, err := p.doRequest(r, target, username, password, withAuth, p.noRedirectClient)
	if err != nil {
		http.Error(w, err.Error(), http.StatusBadGateway)
		return
	}
	writeProxyResponse(w, resp)
}

func (p *WebDAVProxy) doRequest(source *http.Request, target *url.URL, username, password string, withAuth bool, client *http.Client) (*http.Response, error) {
	req, err := http.NewRequestWithContext(source.Context(), source.Method, target.String(), source.Body)
	if err != nil {
		return nil, err
	}
	req.Header = source.Header.Clone()
	stripProxyOnlyHeaders(req.Header)
	if destination := req.Header.Get("Destination"); destination != "" {
		req.Header.Set("Destination", p.rewriteDestination(destination))
	}
	req.Header.Set("User-Agent", "DrivePlayer/1.0")
	if withAuth {
		req.SetBasicAuth(username, password)
	}
	return client.Do(req)
}

func (p *WebDAVProxy) rewriteDestination(destination string) string {
	u, err := url.Parse(destination)
	if err != nil {
		return destination
	}
	if u.Host != "" && !strings.EqualFold(u.Host, p.listener.Addr().String()) {
		return destination
	}
	if !strings.HasPrefix(u.Path, "/webdav") {
		return destination
	}
	query := cloneQuery(u.Query())
	target, err := buildUpstreamURL(p.endpoint.String(), strings.TrimPrefix(u.Path, "/webdav"), query)
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

func isExpiredSignedURLStatus(status int) bool {
	return status == http.StatusUnauthorized || status == http.StatusForbidden || status == http.StatusGone
}

func (p *WebDAVProxy) cachedRedirect(key string) (*url.URL, bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	item, ok := p.cache[key]
	if !ok {
		return nil, false
	}
	if !item.expiresAt.After(time.Now()) {
		delete(p.cache, key)
		return nil, false
	}
	target, err := url.Parse(item.redirectURL)
	if err != nil {
		delete(p.cache, key)
		return nil, false
	}
	return target, true
}

func (p *WebDAVProxy) storeRedirect(key, remotePath, sourceURL, redirectURL string) {
	p.mu.Lock()
	now := time.Now()
	p.cache[key] = redirectCacheValue{
		path:        remotePath,
		sourceURL:   sourceURL,
		redirectURL: redirectURL,
		cachedAt:    now,
		expiresAt:   now.Add(p.ttl),
	}
	p.mu.Unlock()
}

func (p *WebDAVProxy) deleteCache(key string) {
	p.mu.Lock()
	delete(p.cache, key)
	p.mu.Unlock()
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
		base.RawQuery = query.Encode()
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
