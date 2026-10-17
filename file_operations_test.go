package main

import (
	"net/http"
	"net/http/httptest"
	"net/url"
	"strings"
	"testing"
)

func TestFileOperationsUseOneRequestAndSavedAccount(t *testing.T) {
	for _, method := range []string{"MOVE", "DELETE"} {
		t.Run(method, func(t *testing.T) {
			requests := 0
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				requests++
				username, password, ok := r.BasicAuth()
				if r.Method != method || r.URL.Path != "/dav/目录/片段 #1.mp4" || !ok || username != "u@name" || password != "p:/?# 密码" {
					t.Errorf("错误的上游请求：%s %s", r.Method, r.URL.Path)
				}
				if method == "MOVE" {
					destination, err := url.Parse(r.Header.Get("Destination"))
					if err != nil || destination.Path != "/dav/目录/新名称 #2.mp4" || destination.User != nil || r.Header.Get("Overwrite") != "F" {
						t.Errorf("重命名目标或覆盖行为错误：%s", r.Header.Get("Destination"))
					}
				}
				w.WriteHeader(http.StatusNoContent)
			}))
			defer server.Close()
			service := &AppService{config: diskConfig{ActiveAccountID: "other", Accounts: []WebDAVAccount{{ID: "test", Endpoint: server.URL + "/dav", Username: "u@name", Password: "p:/?# 密码"}}}, httpClient: server.Client()}
			if method == "MOVE" {
				got, err := service.RenameEntry(t.Context(), "test", "/目录/片段 #1.mp4", "新名称 #2", false)
				if err != nil || got != "/目录/新名称 #2.mp4" {
					t.Fatalf("重命名失败：%s %v", got, err)
				}
			} else if err := service.DeleteEntry(t.Context(), "test", "/目录/片段 #1.mp4"); err != nil {
				t.Fatal(err)
			}
			if requests != 1 || service.config.ActiveAccountID != "other" {
				t.Fatal("操作只能发出一次请求且不能切换账户")
			}
		})
	}
}

func TestFileLinksEncodeCredentialsAndPath(t *testing.T) {
	service := &AppService{config: diskConfig{Accounts: []WebDAVAccount{{ID: "test", Endpoint: "https://example.com/dav", Username: "u@name", Password: "p:/?# 密码"}}}}
	for _, credentials := range []bool{false, true} {
		link, err := service.GetFileLink("test", "/目录/片段 #1.mp4", credentials)
		if err != nil {
			t.Fatal(err)
		}
		u, err := url.Parse(link)
		if err != nil || u.Path != "/dav/目录/片段 #1.mp4" || u.Fragment != "" {
			t.Fatalf("链接编码错误：%s", link)
		}
		if credentials {
			password, ok := u.User.Password()
			if !ok || u.User.Username() != "u@name" || password != "p:/?# 密码" {
				t.Fatal("账号密码编码错误")
			}
		} else if u.User != nil {
			t.Fatal("普通链接不能包含账号密码")
		}
	}
}

func TestFileMutationReportsFailuresAndPreservesExtension(t *testing.T) {
	requests := 0
	status := http.StatusPreconditionFailed
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.WriteHeader(status)
		if status == http.StatusMultiStatus {
			_, _ = w.Write([]byte(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/folder/locked.mp4</d:href><d:status>HTTP/1.1 423 Locked</d:status></d:response></d:multistatus>`))
		}
	}))
	defer server.Close()
	service := &AppService{config: diskConfig{Accounts: []WebDAVAccount{{ID: "test", Endpoint: server.URL + "/dav"}}}, httpClient: server.Client()}
	for _, invalid := range []string{"", " ", ".", "..", "../escape", "a\\b", "a\nb", "a\tb"} {
		if _, err := service.RenameEntry(t.Context(), "test", "/video.mp4", invalid, false); err == nil {
			t.Errorf("不应允许无效名称 %q", invalid)
		}
	}
	if err := service.DeleteEntry(t.Context(), "test", "/"); err == nil || requests != 0 {
		t.Fatal("不能请求删除根目录")
	}
	if _, err := service.RenameEntry(t.Context(), "test", "/video.mp4", "renamed", false); err == nil || !strings.Contains(err.Error(), "412") {
		t.Fatalf("目标已存在应报告失败：%v", err)
	}
	status = http.StatusMultiStatus
	if err := service.DeleteEntry(t.Context(), "test", "/folder"); err == nil || !strings.Contains(err.Error(), "423") {
		t.Fatalf("部分删除失败不能报告成功：%v", err)
	}
}

func TestRenamePreservesOnlyFileExtension(t *testing.T) {
	for _, item := range []struct {
		original, expected string
		directory          bool
	}{
		{"/movie.part.MP4", "/new.MP4", false},
		{"/movie", "/new", false},
		{"/.hidden", "/new", false},
		{"/folder.name", "/new", true},
	} {
		t.Run(item.original, func(t *testing.T) {
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				destination, err := url.Parse(r.Header.Get("Destination"))
				if err != nil || destination.Path != "/dav"+item.expected {
					t.Errorf("错误的目标名称：%s", r.Header.Get("Destination"))
				}
				w.WriteHeader(http.StatusCreated)
			}))
			defer server.Close()
			service := &AppService{config: diskConfig{Accounts: []WebDAVAccount{{ID: "test", Endpoint: server.URL + "/dav"}}}, httpClient: server.Client()}
			got, err := service.RenameEntry(t.Context(), "test", item.original, "new", item.directory)
			if err != nil || got != item.expected {
				t.Fatalf("文件扩展名处理错误：%s %v", got, err)
			}
		})
	}
}

func TestMoveEntryKeepsNameAndUsesSingleRequest(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		user, password, ok := r.BasicAuth()
		destination, err := url.Parse(r.Header.Get("Destination"))
		if r.Method != "MOVE" || r.URL.Path != "/dav/来源/视频 #1.MP4" || !ok || user != "user" || password != "password" || r.Header.Get("Overwrite") != "F" || err != nil || destination.Path != "/dav/目标/视频 #1.MP4" {
			t.Errorf("移动请求错误：%s %s %s", r.Method, r.URL.Path, r.Header.Get("Destination"))
		}
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()
	service := &AppService{config: diskConfig{ActiveAccountID: "other", Accounts: []WebDAVAccount{{ID: "test", Endpoint: server.URL + "/dav", Username: "user", Password: "password"}}}, httpClient: server.Client()}
	for _, target := range []string{"/来源/视频 #1.MP4", "/来源/视频 #1.MP4/child"} {
		if _, err := service.MoveEntry(t.Context(), "test", "/来源/视频 #1.MP4", target); err == nil {
			t.Fatal("不能移动到自身或子目录")
		}
	}
	if _, err := service.MoveEntry(t.Context(), "test", "/", "/目标"); err == nil {
		t.Fatal("不能移动根目录")
	}
	if _, err := service.MoveEntry(t.Context(), "test", "/来源/视频 #1.MP4", "/来源"); err != nil || requests != 0 {
		t.Fatal("原目录无需发送移动请求")
	}
	got, err := service.MoveEntry(t.Context(), "test", "/来源/视频 #1.MP4", "/目标")
	if err != nil || got != "/目标/视频 #1.MP4" || requests != 1 || service.config.ActiveAccountID != "other" {
		t.Fatalf("移动结果错误：%s %v，%d 次请求", got, err, requests)
	}
}

func TestMoveDirectoryBrowserUsesSpecifiedAccount(t *testing.T) {
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		user, _, ok := r.BasicAuth()
		if r.Method != "PROPFIND" || r.URL.Path != "/dav/目标" || r.Header.Get("Depth") != "1" || !ok || user != "test" {
			t.Errorf("目录请求错误")
		}
		w.WriteHeader(http.StatusMultiStatus)
		_, _ = w.Write([]byte(`<d:multistatus xmlns:d="DAV:"><d:response><d:href>/dav/目标/note.txt</d:href><d:propstat><d:prop><d:displayname>note.txt</d:displayname><d:resourcetype/></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response></d:multistatus>`))
	}))
	defer server.Close()
	service := &AppService{config: diskConfig{ActiveAccountID: "other", Accounts: []WebDAVAccount{{ID: "test", Endpoint: server.URL + "/dav", Username: "test"}}}, httpClient: server.Client()}
	entries, err := service.ListAccountDirectory(t.Context(), "test", "/目标")
	if err != nil || len(entries) != 1 || entries[0].Name != "note.txt" || requests != 1 || service.config.ActiveAccountID != "other" {
		t.Fatalf("目录结果错误：%v %v", entries, err)
	}
}
