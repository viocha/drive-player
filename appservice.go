package main

import (
	"context"
	"encoding/json"
	"encoding/xml"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path"
	"path/filepath"
	"runtime"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
)

const (
	defaultWebDAVEndpoint         = "https://webdav.123pan.cn/webdav"
	defaultCacheTTL               = 30
	defaultThumbnailMaxAgeDays    = 30
	defaultThumbnailMaxSizeMB     = 512
	defaultThumbnailOffsetSeconds = 5
	defaultPlaybackMaxAgeDays     = 365
	defaultPlaybackMaxSizeMB      = 16
	minThumbnailMaxAgeDays        = 1
	maxThumbnailMaxAgeDays        = 3650
	minThumbnailMaxSizeMB         = 16
	maxThumbnailMaxSizeMB         = 10240
	minThumbnailOffsetSeconds     = 0
	maxThumbnailOffsetSeconds     = 3600
	minPlaybackMaxAgeDays         = 1
	maxPlaybackMaxAgeDays         = 3650
	minPlaybackMaxSizeMB          = 1
	maxPlaybackMaxSizeMB          = 1024
)

type AppState struct {
	Connected              bool   `json:"connected"`
	Username               string `json:"username"`
	Password               string `json:"password"`
	Endpoint               string `json:"endpoint"`
	CacheTTLMinutes        int    `json:"cacheTTLMinutes"`
	ThumbnailMaxAgeDays    int    `json:"thumbnailMaxAgeDays"`
	ThumbnailMaxSizeMB     int    `json:"thumbnailMaxSizeMB"`
	ThumbnailOffsetSeconds int    `json:"thumbnailOffsetSeconds"`
	PlaybackMaxAgeDays     int    `json:"playbackMaxAgeDays"`
	PlaybackMaxSizeMB      int    `json:"playbackMaxSizeMB"`
	StorageDirectory       string `json:"storageDirectory"`
	ConfigPath             string `json:"configPath"`
	ThumbnailDirectory     string `json:"thumbnailDirectory"`
	PlaybackProgressPath   string `json:"playbackProgressPath"`
	ProxyBaseURL           string `json:"proxyBaseUrl"`
}

type FileEntry struct {
	Name        string `json:"name"`
	Path        string `json:"path"`
	IsDirectory bool   `json:"isDirectory"`
	Size        int64  `json:"size"`
	ModifiedAt  string `json:"modifiedAt"`
	ContentType string `json:"contentType"`
}

type diskConfig struct {
	CacheTTLMinutes        int    `json:"cacheTTLMinutes"`
	ThumbnailMaxAgeDays    int    `json:"thumbnailMaxAgeDays"`
	ThumbnailMaxSizeMB     int    `json:"thumbnailMaxSizeMB"`
	ThumbnailOffsetSeconds int    `json:"thumbnailOffsetSeconds"`
	PlaybackMaxAgeDays     int    `json:"playbackMaxAgeDays"`
	PlaybackMaxSizeMB      int    `json:"playbackMaxSizeMB"`
	Username               string `json:"username"`
	Password               string `json:"password"`
}

type credentials struct {
	username string
	password string
}

type AppService struct {
	mu          sync.RWMutex
	credentials credentials
	connected   bool
	config      diskConfig
	configPath  string
	proxy       *WebDAVProxy
	thumbnails  *ThumbnailCache
	progress    *PlaybackProgressStore
	httpClient  *http.Client
}

func NewAppService() (*AppService, error) {
	configPath, err := resolveConfigPath()
	if err != nil {
		return nil, err
	}

	config := diskConfig{
		CacheTTLMinutes:        defaultCacheTTL,
		ThumbnailMaxAgeDays:    defaultThumbnailMaxAgeDays,
		ThumbnailMaxSizeMB:     defaultThumbnailMaxSizeMB,
		ThumbnailOffsetSeconds: defaultThumbnailOffsetSeconds,
		PlaybackMaxAgeDays:     defaultPlaybackMaxAgeDays,
		PlaybackMaxSizeMB:      defaultPlaybackMaxSizeMB,
	}
	if data, err := os.ReadFile(configPath); err == nil {
		_ = json.Unmarshal(data, &config)
	}
	if config.CacheTTLMinutes < 1 || config.CacheTTLMinutes > 24*60 {
		config.CacheTTLMinutes = defaultCacheTTL
	}
	if config.ThumbnailMaxAgeDays < minThumbnailMaxAgeDays || config.ThumbnailMaxAgeDays > maxThumbnailMaxAgeDays {
		config.ThumbnailMaxAgeDays = defaultThumbnailMaxAgeDays
	}
	if config.ThumbnailMaxSizeMB < minThumbnailMaxSizeMB || config.ThumbnailMaxSizeMB > maxThumbnailMaxSizeMB {
		config.ThumbnailMaxSizeMB = defaultThumbnailMaxSizeMB
	}
	if config.ThumbnailOffsetSeconds < minThumbnailOffsetSeconds || config.ThumbnailOffsetSeconds > maxThumbnailOffsetSeconds {
		config.ThumbnailOffsetSeconds = defaultThumbnailOffsetSeconds
	}
	if config.PlaybackMaxAgeDays < minPlaybackMaxAgeDays || config.PlaybackMaxAgeDays > maxPlaybackMaxAgeDays {
		config.PlaybackMaxAgeDays = defaultPlaybackMaxAgeDays
	}
	if config.PlaybackMaxSizeMB < minPlaybackMaxSizeMB || config.PlaybackMaxSizeMB > maxPlaybackMaxSizeMB {
		config.PlaybackMaxSizeMB = defaultPlaybackMaxSizeMB
	}

	proxy, err := NewWebDAVProxy(defaultWebDAVEndpoint, time.Duration(config.CacheTTLMinutes)*time.Minute)
	if err != nil {
		return nil, err
	}
	thumbnailCache, err := NewThumbnailCache(
		filepath.Join(filepath.Dir(configPath), "thumbnails"),
		time.Duration(config.ThumbnailMaxAgeDays)*24*time.Hour,
		int64(config.ThumbnailMaxSizeMB)*1024*1024,
	)
	if err != nil {
		_ = proxy.Close()
		return nil, err
	}
	playbackProgress, err := NewPlaybackProgressStore(
		filepath.Join(filepath.Dir(configPath), "playback-progress.json"),
		time.Duration(config.PlaybackMaxAgeDays)*24*time.Hour,
		int64(config.PlaybackMaxSizeMB)*1024*1024,
	)
	if err != nil {
		_ = proxy.Close()
		return nil, err
	}
	service := &AppService{
		config:     config,
		configPath: configPath,
		proxy:      proxy,
		thumbnails: thumbnailCache,
		progress:   playbackProgress,
		httpClient: &http.Client{Timeout: 30 * time.Second},
	}
	if config.Username != "" && config.Password != "" {
		service.credentials = credentials{username: config.Username, password: config.Password}
	}
	return service, nil
}

func resolveConfigPath() (string, error) {
	base, err := os.UserConfigDir()
	if err != nil {
		return "", fmt.Errorf("resolve config directory: %w", err)
	}
	dir := filepath.Join(base, "drive-player")
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return "", fmt.Errorf("create config directory: %w", err)
	}
	return filepath.Join(dir, "config.json"), nil
}

func (s *AppService) close() error {
	return s.proxy.Close()
}

func (s *AppService) GetState() AppState {
	s.mu.RLock()
	defer s.mu.RUnlock()
	storageDirectory := filepath.Dir(s.configPath)
	return AppState{
		Connected:              s.connected,
		Username:               s.credentials.username,
		Password:               s.credentials.password,
		Endpoint:               defaultWebDAVEndpoint,
		CacheTTLMinutes:        s.config.CacheTTLMinutes,
		ThumbnailMaxAgeDays:    s.config.ThumbnailMaxAgeDays,
		ThumbnailMaxSizeMB:     s.config.ThumbnailMaxSizeMB,
		ThumbnailOffsetSeconds: s.config.ThumbnailOffsetSeconds,
		PlaybackMaxAgeDays:     s.config.PlaybackMaxAgeDays,
		PlaybackMaxSizeMB:      s.config.PlaybackMaxSizeMB,
		StorageDirectory:       storageDirectory,
		ConfigPath:             s.configPath,
		ThumbnailDirectory:     filepath.Join(storageDirectory, "thumbnails"),
		PlaybackProgressPath:   s.progress.Path(),
		ProxyBaseURL:           s.proxy.BaseURL(),
	}
}

func (s *AppService) Login(ctx context.Context, username, password string) (AppState, error) {
	username = strings.TrimSpace(username)
	if username == "" || password == "" {
		return AppState{}, errors.New("账号和密码不能为空")
	}

	creds := credentials{username: username, password: password}
	if _, err := s.listDirectoryWithCredentials(ctx, "/", creds); err != nil {
		return AppState{}, fmt.Errorf("WebDAV 登录失败: %w", err)
	}

	s.mu.Lock()
	s.config.Username = username
	s.config.Password = password
	config := s.config
	s.credentials = creds
	s.connected = true
	s.mu.Unlock()
	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.connected = false
		s.mu.Unlock()
		return AppState{}, err
	}
	s.proxy.SetCredentials(username, password)
	s.proxy.ClearCache()

	return s.GetState(), nil
}

func (s *AppService) Logout() AppState {
	s.mu.Lock()
	s.config.Username = ""
	s.config.Password = ""
	config := s.config
	s.credentials = credentials{}
	s.connected = false
	s.mu.Unlock()
	_ = s.saveConfig(config)
	s.proxy.SetCredentials("", "")
	s.proxy.ClearCache()
	return s.GetState()
}

func (s *AppService) ListDirectory(ctx context.Context, remotePath string) ([]FileEntry, error) {
	creds, err := s.currentCredentials()
	if err != nil {
		return nil, err
	}
	return s.listDirectoryWithCredentials(ctx, normalizeRemotePath(remotePath), creds)
}

func (s *AppService) GetPlaybackURL(remotePath string) (string, error) {
	if _, err := s.currentCredentials(); err != nil {
		return "", err
	}
	return s.proxy.URLForPath(normalizeRemotePath(remotePath)), nil
}

func (s *AppService) ListRedirectCache() []RedirectCacheEntry {
	return s.proxy.CacheEntries()
}

func (s *AppService) ClearRedirectCache() {
	s.proxy.ClearCache()
}

func (s *AppService) SetCacheTTL(minutes int) (AppState, error) {
	if minutes < 1 || minutes > 24*60 {
		return AppState{}, errors.New("缓存时间必须在 1 到 1440 分钟之间")
	}

	s.mu.Lock()
	s.config.CacheTTLMinutes = minutes
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		return AppState{}, err
	}
	s.proxy.SetTTL(time.Duration(minutes) * time.Minute)
	return s.GetState(), nil
}

func (s *AppService) GetThumbnail(remotePath, modifiedAt string) (ThumbnailResult, error) {
	creds, err := s.currentCredentials()
	if err != nil {
		return ThumbnailResult{}, err
	}
	s.mu.RLock()
	offsetSeconds := s.config.ThumbnailOffsetSeconds
	s.mu.RUnlock()
	return s.thumbnails.Get(thumbnailCacheKey(creds.username, remotePath, modifiedAt, offsetSeconds))
}

func (s *AppService) SaveThumbnail(remotePath, modifiedAt, dataURL string) (ThumbnailCacheStats, error) {
	creds, err := s.currentCredentials()
	if err != nil {
		return ThumbnailCacheStats{}, err
	}
	s.mu.RLock()
	offsetSeconds := s.config.ThumbnailOffsetSeconds
	s.mu.RUnlock()
	return s.thumbnails.Save(thumbnailCacheKey(creds.username, remotePath, modifiedAt, offsetSeconds), dataURL)
}

func (s *AppService) GetThumbnailCacheStats() (ThumbnailCacheStats, error) {
	return s.thumbnails.Stats()
}

func (s *AppService) ClearThumbnailCache() (ThumbnailCacheStats, error) {
	return s.thumbnails.Clear()
}

func (s *AppService) SetThumbnailSettings(maxAgeDays, maxSizeMB, offsetSeconds int) (AppState, error) {
	if maxAgeDays < minThumbnailMaxAgeDays || maxAgeDays > maxThumbnailMaxAgeDays {
		return AppState{}, fmt.Errorf("缩略图保留时间必须在 %d 到 %d 天之间", minThumbnailMaxAgeDays, maxThumbnailMaxAgeDays)
	}
	if maxSizeMB < minThumbnailMaxSizeMB || maxSizeMB > maxThumbnailMaxSizeMB {
		return AppState{}, fmt.Errorf("缩略图缓存上限必须在 %d 到 %d MB 之间", minThumbnailMaxSizeMB, maxThumbnailMaxSizeMB)
	}
	if offsetSeconds < minThumbnailOffsetSeconds || offsetSeconds > maxThumbnailOffsetSeconds {
		return AppState{}, fmt.Errorf("缩略图截帧位置必须在 %d 到 %d 秒之间", minThumbnailOffsetSeconds, maxThumbnailOffsetSeconds)
	}

	s.mu.Lock()
	previous := s.config
	s.config.ThumbnailMaxAgeDays = maxAgeDays
	s.config.ThumbnailMaxSizeMB = maxSizeMB
	s.config.ThumbnailOffsetSeconds = offsetSeconds
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	if err := s.thumbnails.SetLimits(time.Duration(maxAgeDays)*24*time.Hour, int64(maxSizeMB)*1024*1024); err != nil {
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) GetPlaybackProgress(remotePath string) (PlaybackProgressResult, error) {
	creds, err := s.currentCredentials()
	if err != nil {
		return PlaybackProgressResult{}, err
	}
	return s.progress.Get(creds.username, normalizeRemotePath(remotePath))
}

func (s *AppService) SavePlaybackProgress(remotePath string, position, duration float64) (PlaybackProgressStats, error) {
	creds, err := s.currentCredentials()
	if err != nil {
		return PlaybackProgressStats{}, err
	}
	return s.progress.Save(creds.username, normalizeRemotePath(remotePath), position, duration)
}

func (s *AppService) GetPlaybackProgressStats() (PlaybackProgressStats, error) {
	return s.progress.Stats()
}

func (s *AppService) ClearPlaybackProgress() (PlaybackProgressStats, error) {
	return s.progress.Clear()
}

func (s *AppService) SetPlaybackProgressSettings(maxAgeDays, maxSizeMB int) (AppState, error) {
	if maxAgeDays < minPlaybackMaxAgeDays || maxAgeDays > maxPlaybackMaxAgeDays {
		return AppState{}, fmt.Errorf("播放进度保留时间必须在 %d 到 %d 天之间", minPlaybackMaxAgeDays, maxPlaybackMaxAgeDays)
	}
	if maxSizeMB < minPlaybackMaxSizeMB || maxSizeMB > maxPlaybackMaxSizeMB {
		return AppState{}, fmt.Errorf("播放进度存储上限必须在 %d 到 %d MB 之间", minPlaybackMaxSizeMB, maxPlaybackMaxSizeMB)
	}

	s.mu.Lock()
	previous := s.config
	s.config.PlaybackMaxAgeDays = maxAgeDays
	s.config.PlaybackMaxSizeMB = maxSizeMB
	config := s.config
	s.mu.Unlock()

	if err := s.saveConfig(config); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		return AppState{}, err
	}
	if err := s.progress.SetLimits(time.Duration(maxAgeDays)*24*time.Hour, int64(maxSizeMB)*1024*1024); err != nil {
		s.mu.Lock()
		s.config = previous
		s.mu.Unlock()
		_ = s.saveConfig(previous)
		_ = s.progress.SetLimits(time.Duration(previous.PlaybackMaxAgeDays)*24*time.Hour, int64(previous.PlaybackMaxSizeMB)*1024*1024)
		return AppState{}, err
	}
	return s.GetState(), nil
}

func (s *AppService) OpenStorageDirectory() error {
	dir := filepath.Dir(s.configPath)
	var cmd *exec.Cmd
	switch runtime.GOOS {
	case "windows":
		cmd = exec.Command("explorer.exe", dir)
	case "darwin":
		cmd = exec.Command("open", dir)
	default:
		cmd = exec.Command("xdg-open", dir)
	}
	if err := cmd.Start(); err != nil {
		return fmt.Errorf("open storage directory: %w", err)
	}
	return nil
}

func (s *AppService) saveConfig(config diskConfig) error {
	data, err := json.MarshalIndent(config, "", "  ")
	if err != nil {
		return fmt.Errorf("encode settings: %w", err)
	}
	if err := os.WriteFile(s.configPath, data, 0o600); err != nil {
		return fmt.Errorf("save settings: %w", err)
	}
	return nil
}

func (s *AppService) currentCredentials() (credentials, error) {
	s.mu.RLock()
	defer s.mu.RUnlock()
	if !s.connected || s.credentials.username == "" || s.credentials.password == "" {
		return credentials{}, errors.New("尚未登录 WebDAV")
	}
	return s.credentials, nil
}

func (s *AppService) listDirectoryWithCredentials(ctx context.Context, remotePath string, creds credentials) ([]FileEntry, error) {
	remotePath = normalizeRemotePath(remotePath)
	upstreamURL, err := buildUpstreamURL(defaultWebDAVEndpoint, remotePath, nil)
	if err != nil {
		return nil, err
	}

	const propfindBody = `<?xml version="1.0" encoding="utf-8" ?>
<d:propfind xmlns:d="DAV:">
  <d:prop>
    <d:displayname />
    <d:resourcetype />
    <d:getcontentlength />
    <d:getlastmodified />
    <d:getcontenttype />
  </d:prop>
</d:propfind>`

	req, err := http.NewRequestWithContext(ctx, "PROPFIND", upstreamURL.String(), strings.NewReader(propfindBody))
	if err != nil {
		return nil, err
	}
	req.SetBasicAuth(creds.username, creds.password)
	req.Header.Set("Depth", "1")
	req.Header.Set("Content-Type", `application/xml; charset="utf-8"`)
	req.Header.Set("User-Agent", "DrivePlayer/1.0")

	resp, err := s.httpClient.Do(req)
	if err != nil {
		return nil, err
	}
	defer resp.Body.Close()
	if resp.StatusCode == http.StatusUnauthorized || resp.StatusCode == http.StatusForbidden {
		return nil, fmt.Errorf("认证失败 (%s)", resp.Status)
	}
	if resp.StatusCode != http.StatusMultiStatus && (resp.StatusCode < 200 || resp.StatusCode >= 300) {
		body, _ := io.ReadAll(io.LimitReader(resp.Body, 4096))
		return nil, fmt.Errorf("PROPFIND %s: %s %s", remotePath, resp.Status, strings.TrimSpace(string(body)))
	}

	var result davMultiStatus
	if err := xml.NewDecoder(resp.Body).Decode(&result); err != nil {
		return nil, fmt.Errorf("parse WebDAV response: %w", err)
	}

	entries := make([]FileEntry, 0, len(result.Responses))
	for _, item := range result.Responses {
		entry, ok := davResponseToEntry(item)
		if !ok || sameRemotePath(entry.Path, remotePath) {
			continue
		}
		entries = append(entries, entry)
	}

	sort.SliceStable(entries, func(i, j int) bool {
		if entries[i].IsDirectory != entries[j].IsDirectory {
			return entries[i].IsDirectory
		}
		return strings.ToLower(entries[i].Name) < strings.ToLower(entries[j].Name)
	})
	return entries, nil
}

type davMultiStatus struct {
	Responses []davResponse `xml:"response"`
}

type davResponse struct {
	Href      string        `xml:"href"`
	PropStats []davPropStat `xml:"propstat"`
}

type davPropStat struct {
	Status string  `xml:"status"`
	Prop   davProp `xml:"prop"`
}

type davProp struct {
	DisplayName   string          `xml:"displayname"`
	ResourceType  davResourceType `xml:"resourcetype"`
	ContentLength string          `xml:"getcontentlength"`
	LastModified  string          `xml:"getlastmodified"`
	ContentType   string          `xml:"getcontenttype"`
}

type davResourceType struct {
	Collection *struct{} `xml:"collection"`
}

func davResponseToEntry(item davResponse) (FileEntry, bool) {
	var prop *davProp
	for i := range item.PropStats {
		if strings.Contains(item.PropStats[i].Status, " 200 ") {
			prop = &item.PropStats[i].Prop
			break
		}
	}
	if prop == nil && len(item.PropStats) > 0 {
		prop = &item.PropStats[0].Prop
	}
	if prop == nil {
		return FileEntry{}, false
	}

	remotePath := remotePathFromHref(item.Href)
	if remotePath == "" {
		return FileEntry{}, false
	}
	name := strings.TrimSpace(prop.DisplayName)
	if name == "" {
		name = path.Base(strings.TrimSuffix(remotePath, "/"))
	}

	var size int64
	if prop.ContentLength != "" {
		size, _ = strconv.ParseInt(prop.ContentLength, 10, 64)
	}

	modifiedAt := ""
	if prop.LastModified != "" {
		if parsed, err := http.ParseTime(prop.LastModified); err == nil {
			modifiedAt = parsed.Local().Format(time.RFC3339)
		} else {
			modifiedAt = prop.LastModified
		}
	}

	return FileEntry{
		Name:        name,
		Path:        remotePath,
		IsDirectory: prop.ResourceType.Collection != nil,
		Size:        size,
		ModifiedAt:  modifiedAt,
		ContentType: prop.ContentType,
	}, true
}

func remotePathFromHref(href string) string {
	u, err := url.Parse(href)
	if err != nil {
		return ""
	}
	decoded, err := url.PathUnescape(u.EscapedPath())
	if err != nil {
		decoded = u.Path
	}
	base, _ := url.Parse(defaultWebDAVEndpoint)
	basePath := strings.TrimSuffix(base.Path, "/")
	if strings.HasPrefix(decoded, basePath) {
		decoded = strings.TrimPrefix(decoded, basePath)
	}
	return normalizeRemotePath(decoded)
}

func normalizeRemotePath(value string) string {
	value = strings.TrimSpace(value)
	if value == "" || value == "/" {
		return "/"
	}
	value = "/" + strings.TrimLeft(value, "/")
	cleaned := path.Clean(value)
	if cleaned == "." {
		return "/"
	}
	return cleaned
}

func sameRemotePath(a, b string) bool {
	return strings.TrimSuffix(normalizeRemotePath(a), "/") == strings.TrimSuffix(normalizeRemotePath(b), "/")
}
