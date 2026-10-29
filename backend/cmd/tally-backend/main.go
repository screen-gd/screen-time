package main

import (
	"context"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"

	"github.com/screen-gd/screen-time/backend/internal/server"
	"github.com/screen-gd/screen-time/backend/internal/store"
)

func defaultDataFile() string {
	if value := os.Getenv("TALLY_DATA_FILE"); value != "" {
		return value
	}
	home, err := os.UserHomeDir()
	if err != nil {
		home = "."
	}
	switch runtime.GOOS {
	case "windows":
		if appData := os.Getenv("APPDATA"); appData != "" {
			return filepath.Join(appData, "Tally", "tally-data.json")
		}
		return filepath.Join(home, "AppData", "Roaming", "Tally", "tally-data.json")
	case "darwin":
		return filepath.Join(home, "Library", "Application Support", "Tally", "tally-data.json")
	default:
		if config := os.Getenv("XDG_CONFIG_HOME"); config != "" {
			return filepath.Join(config, "Tally", "tally-data.json")
		}
		return filepath.Join(home, ".config", "Tally", "tally-data.json")
	}
}

func splitList(value string) []string {
	var items []string
	for _, item := range strings.Split(value, ",") {
		if item = strings.TrimSpace(item); item != "" {
			items = append(items, item)
		}
	}
	return items
}

func main() {
	defaultPort := 43821
	if value := os.Getenv("TALLY_BACKEND_PORT"); value != "" {
		fmt.Sscanf(value, "%d", &defaultPort)
	}
	defaultBind := os.Getenv("TALLY_BACKEND_BIND")
	if defaultBind == "" {
		defaultBind = "127.0.0.1"
	}

	dataFile := flag.String("data", defaultDataFile(), "path to the shared Tally JSON data file")
	bind := flag.String("bind", defaultBind, "address to bind")
	port := flag.Int("port", defaultPort, "TCP port (0 chooses a free port)")
	frontendDir := flag.String("frontend-dir", "", "directory containing the browser frontend")
	allowHosts := flag.String("allow-host", os.Getenv("TALLY_BACKEND_ALLOWED_HOSTS"), "comma-separated extra Host names accepted besides loopback")
	allowOrigins := flag.String("allow-origin", os.Getenv("TALLY_BACKEND_ALLOWED_ORIGINS"), "comma-separated extra browser origins allowed to call the API")
	flag.Parse()

	hosts := splitList(*allowHosts)
	if ip := net.ParseIP(*bind); ip != nil && !ip.IsUnspecified() {
		hosts = append(hosts, ip.String())
	}

	data, err := store.Open(*dataFile)
	if err != nil {
		log.Fatalf("open data store: %v", err)
	}
	// TALLY_BACKEND_TOKEN lets a launcher (Electron) share the token; otherwise
	// a random one is generated and only exposed through the served index.html.
	api := server.New(data, *frontendDir, server.Options{
		Token: os.Getenv("TALLY_BACKEND_TOKEN"), AllowedHosts: hosts, AllowedOrigins: splitList(*allowOrigins),
	})
	defer data.Flush()
	listener, err := net.Listen("tcp", fmt.Sprintf("%s:%d", *bind, *port))
	if err != nil {
		log.Fatalf("listen: %v", err)
	}
	httpServer := &http.Server{Handler: api}
	baseURL := "http://" + listener.Addr().String()
	fmt.Printf("TALLY_BACKEND_READY=%s\n", baseURL)
	log.Printf("Tally backend listening on %s (data: %s)", baseURL, *dataFile)

	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	go func() {
		<-ctx.Done()
		shutdownCtx, cancel := context.WithTimeout(context.Background(), 3e9)
		defer cancel()
		_ = httpServer.Shutdown(shutdownCtx)
	}()

	if err := httpServer.Serve(listener); err != nil && err != http.ErrServerClosed {
		log.Fatalf("serve: %v", err)
	}
}
