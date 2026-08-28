package main

import (
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func mustSetProxyAccount(t *testing.T, proxy *WebDAVProxy, account WebDAVAccount) {
	t.Helper()
	if err := proxy.SetAccount(account); err != nil {
		t.Fatal(err)
	}
}

func TestWebDAVProxyReturnsUpstreamResponseUnchanged(t *testing.T) {
	var davHits atomic.Int32
	var otherHits atomic.Int32

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
			if got := r.Header.Get("Range"); got != "bytes=2-5" {
				t.Fatalf("Range header = %q, want bytes=2-5", got)
			}
			w.Header().Set("Location", server.URL+"/other/video.mp4")
			w.WriteHeader(http.StatusFound)
		case "/other/video.mp4":
			otherHits.Add(1)
			w.WriteHeader(http.StatusNoContent)
		default:
			http.NotFound(w, r)
		}
	}))
	defer server.Close()

	proxy, err := NewWebDAVProxy()
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	if !strings.HasPrefix(proxy.BaseURL(), "http://localhost:") {
		t.Fatalf("proxy BaseURL = %q, want localhost", proxy.BaseURL())
	}
	mustSetProxyAccount(t, proxy, WebDAVAccount{ID: "account-a", Endpoint: server.URL + "/webdav", Username: "user", Password: "pass"})
	if strings.Contains(proxy.URLForPath("account-a", "/video.mp4"), "token=") {
		t.Fatal("local proxy URL must not contain an authentication token")
	}

	req, err := http.NewRequest(http.MethodGet, proxy.URLForPath("account-a", "/video.mp4"), nil)
	if err != nil {
		t.Fatal(err)
	}
	req.Header.Set("Range", "bytes=2-5")
	resp, err := http.DefaultTransport.RoundTrip(req)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusFound {
		t.Fatalf("status = %d, want 302", resp.StatusCode)
	}
	if got := resp.Header.Get("Location"); got != server.URL+"/other/video.mp4" {
		t.Fatalf("Location = %q, want %q", got, server.URL+"/other/video.mp4")
	}

	if got := davHits.Load(); got != 1 {
		t.Fatalf("WebDAV GET hits = %d, want 1", got)
	}
	if got := otherHits.Load(); got != 0 {
		t.Fatalf("proxy issued an unexpected second request, hits = %d", got)
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

	proxy, err := NewWebDAVProxy()
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	mustSetProxyAccount(t, proxy, WebDAVAccount{ID: "account-a", Endpoint: server.URL + "/webdav", Username: "user", Password: "pass"})

	req, _ := http.NewRequest("MKCOL", proxy.URLForPath("account-a", "/folder"), strings.NewReader("payload"))
	req.Header.Set("Destination", proxy.URLForPath("account-a", "/renamed"))
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

	proxy, err := NewWebDAVProxy()
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	mustSetProxyAccount(t, proxy, WebDAVAccount{ID: "account-a", Endpoint: server.URL + "/webdav", Username: "user", Password: "pass"})

	localURL := proxy.URLForPath("account-a", "/file.mp4") + "?download=1"
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

func TestWebDAVProxySupportsAnonymousWebDAVAndAddsCORS(t *testing.T) {
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if _, _, ok := r.BasicAuth(); ok {
			t.Fatal("anonymous WebDAV request must not contain Basic Auth")
		}
		http.Error(w, "upstream error", http.StatusBadGateway)
	}))
	defer server.Close()

	proxy, err := NewWebDAVProxy()
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	mustSetProxyAccount(t, proxy, WebDAVAccount{ID: "account-a", Endpoint: server.URL + "/webdav"})

	resp, err := http.Get(proxy.URLForPath("account-a", "/video.mp4"))
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusBadGateway {
		t.Fatalf("status = %d, want 502", resp.StatusCode)
	}
	if got := resp.Header.Get("Access-Control-Allow-Origin"); got != "*" {
		t.Fatalf("Access-Control-Allow-Origin = %q, want *", got)
	}
}

func TestWebDAVProxyRoutesMultipleAccountsThroughOneListener(t *testing.T) {
	serverA := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, pass, ok := r.BasicAuth(); !ok || user != "a" || pass != "pa" {
			http.Error(w, "bad auth a", http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, "A:"+r.URL.Path)
	}))
	defer serverA.Close()
	serverB := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if user, pass, ok := r.BasicAuth(); !ok || user != "b" || pass != "pb" {
			http.Error(w, "bad auth b", http.StatusUnauthorized)
			return
		}
		_, _ = io.WriteString(w, "B:"+r.URL.Path)
	}))
	defer serverB.Close()

	proxy, err := NewWebDAVProxy()
	if err != nil {
		t.Fatal(err)
	}
	defer proxy.Close()
	mustSetProxyAccount(t, proxy, WebDAVAccount{ID: "account-a", Endpoint: serverA.URL + "/dav", Username: "a", Password: "pa"})
	mustSetProxyAccount(t, proxy, WebDAVAccount{ID: "account-b", Endpoint: serverB.URL + "/dav", Username: "b", Password: "pb"})

	urlA := proxy.URLForPath("account-a", "/movie.mp4")
	urlB := proxy.URLForPath("account-b", "/movie.mp4")
	if !strings.HasPrefix(urlA, proxy.BaseURL()+"/webdav/account-a/") || !strings.HasPrefix(urlB, proxy.BaseURL()+"/webdav/account-b/") {
		t.Fatalf("accounts must share one proxy base URL: %q %q", urlA, urlB)
	}

	for target, want := range map[string]string{urlA: "A:/dav/movie.mp4", urlB: "B:/dav/movie.mp4"} {
		resp, err := http.Get(target)
		if err != nil {
			t.Fatal(err)
		}
		body, _ := io.ReadAll(resp.Body)
		resp.Body.Close()
		if string(body) != want {
			t.Fatalf("GET %s = %q, want %q", target, body, want)
		}
	}

	proxy.RemoveAccount("account-a")
	resp, err := http.Get(urlA)
	if err != nil {
		t.Fatal(err)
	}
	resp.Body.Close()
	if resp.StatusCode != http.StatusNotFound {
		t.Fatalf("removed account status = %d, want 404", resp.StatusCode)
	}
}
