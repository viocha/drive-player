package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestWebDAVProxyCachesGETRedirect(t *testing.T) {
	var davHits atomic.Int32
	var signedHits atomic.Int32

	var server *httptest.Server
	server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/webdav/video.mp4":
			davHits.Add(1)
			user, pass, ok := r.BasicAuth()
			if !ok || user != "user" || pass != "pass" {
				http.Error(w, "bad auth", http.StatusUnauthorized)
				return
			}
			http.Redirect(w, r, server.URL+"/signed/video.mp4", http.StatusFound)
		case "/signed/video.mp4":
			signedHits.Add(1)
			if _, _, ok := r.BasicAuth(); ok {
				t.Fatalf("credentials must not be forwarded to signed URL")
			}
			if got := r.Header.Get("Range"); got != "bytes=2-5" {
				t.Fatalf("Range header = %q, want bytes=2-5", got)
			}
			w.Header().Set("Content-Type", "video/mp4")
			w.WriteHeader(http.StatusPartialContent)
			_, _ = io.WriteString(w, "3456")
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	proxy, err := NewWebDAVProxy(server.URL+"/webdav", 30*time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	proxy.SetCredentials("user", "pass")
	if strings.Contains(proxy.URLForPath("/video.mp4"), "token=") {
		t.Fatal("local proxy URL must not contain an authentication token")
	}

	client := &http.Client{}
	for range 2 {
		req, err := http.NewRequest(http.MethodGet, proxy.URLForPath("/video.mp4"), nil)
		if err != nil {
			t.Fatal(err)
		}
		req.Header.Set("Range", "bytes=2-5")
		resp, err := client.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if resp.StatusCode != http.StatusPartialContent || string(body) != "3456" {
			t.Fatalf("response = %d %q", resp.StatusCode, body)
		}
	}

	if got := davHits.Load(); got != 1 {
		t.Fatalf("WebDAV GET hits = %d, want 1", got)
	}
	if got := signedHits.Load(); got != 2 {
		t.Fatalf("signed URL hits = %d, want 2", got)
	}
	if got := len(proxy.CacheEntries()); got != 1 {
		t.Fatalf("cache entries = %d, want 1", got)
	}
}

func TestWebDAVProxyPassesThroughNonGET(t *testing.T) {
	var method string
	var body string
	var destination string
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		method = r.Method
		destination = r.Header.Get("Destination")
		data, _ := io.ReadAll(r.Body)
		body = string(data)
		w.WriteHeader(http.StatusCreated)
	}))
	defer server.Close()

	proxy, err := NewWebDAVProxy(server.URL+"/webdav", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	proxy.SetCredentials("user", "pass")

	req, _ := http.NewRequest("MKCOL", proxy.URLForPath("/folder"), strings.NewReader("payload"))
	req.Header.Set("Destination", proxy.URLForPath("/renamed"))
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()

	if method != "MKCOL" || body != "payload" {
		t.Fatalf("forwarded method/body = %q/%q", method, body)
	}
	if destination != server.URL+"/webdav/renamed" {
		t.Fatalf("Destination = %q, want %q", destination, server.URL+"/webdav/renamed")
	}
	if resp.StatusCode != http.StatusCreated {
		t.Fatalf("status = %d, want 201", resp.StatusCode)
	}
}

func TestWebDAVProxyAllowsCredentialFreeLocalAccess(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		user, pass, ok := r.BasicAuth()
		if !ok || user != "user" || pass != "pass" {
			http.Error(w, "bad upstream auth", http.StatusUnauthorized)
			return
		}
		if r.URL.Query().Get("download") != "1" {
			http.Error(w, "missing query", http.StatusBadRequest)
			return
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer server.Close()

	proxy, err := NewWebDAVProxy(server.URL+"/webdav", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	proxy.SetCredentials("user", "pass")

	localURL := proxy.URLForPath("/file.mp4") + "?download=1"
	req, _ := http.NewRequest(http.MethodHead, localURL, nil)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNoContent {
		t.Fatalf("status = %d, want 204", resp.StatusCode)
	}
}

func TestWebDAVProxyAddsCORSToErrors(t *testing.T) {
	proxy, err := NewWebDAVProxy("https://example.invalid/webdav", time.Minute)
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()

	resp, err := http.Get(proxy.URLForPath("/video.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusUnauthorized {
		t.Fatalf("status = %d, want 401", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want *", got)
	}
}
