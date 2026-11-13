package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strings"
	"syscall"
	"time"

	"github.com/screen-gd/screen-time/backend/internal/mcp"
	"github.com/screen-gd/screen-time/backend/internal/server"
	"github.com/screen-gd/screen-time/backend/internal/store"
)

// version is reported in the MCP server's initialize handshake; keep it in
// step with package.json.
const version = "1.3.0"

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
	// `tally-backend mcp` runs the stdio MCP server for local agents instead of
	// the HTTP backend: no listener, no data file, stdout is protocol-only.
	if len(os.Args) > 1 && os.Args[1] == "mcp" {
		log.SetOutput(os.Stderr)
		mcp.New(version).Run(os.Stdin, os.Stdout)
		return
	}

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
	exitWithStdin := flag.Bool("exit-with-stdin", false, "save and exit when stdin closes (used by launchers that own the process)")
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
	if *exitWithStdin {
		// The OS closes the pipe when the launcher exits or crashes, so this also
		// covers parents that never get to signal us (and Windows, which has no SIGTERM).
		go func() {
			_, _ = io.Copy(io.Discard, os.Stdin)
			stop()
		}()
	}

	served := make(chan error, 1)
	go func() { served <- httpServer.Serve(listener) }()
	select {
	case err := <-served:
		data.Flush()
		log.Fatalf("serve: %v", err)
	case <-ctx.Done():
	}
	// Let in-flight writes land before the final save.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 3*time.Second)
	defer cancel()
	_ = httpServer.Shutdown(shutdownCtx)
	data.Flush()
	log.Printf("Tally backend stopped")
}
