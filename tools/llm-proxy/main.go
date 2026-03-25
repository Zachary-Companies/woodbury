package main

import (
	"flag"
	"fmt"
	"log"
	"net/http"
	"os"
	"path/filepath"
)

var version = "1.0.0"

func main() {
	port := flag.Int("port", 0, "Listen port (overrides config)")
	configPath := flag.String("config", "", "Config file path (default: config.yaml in binary dir)")
	showVersion := flag.Bool("version", false, "Show version")
	flag.Parse()

	if *showVersion {
		fmt.Printf("woodbury-llm-proxy v%s\n", version)
		os.Exit(0)
	}

	// Resolve config path
	cfgPath := *configPath
	if cfgPath == "" {
		exe, _ := os.Executable()
		cfgPath = filepath.Join(filepath.Dir(exe), "config.yaml")
		if _, err := os.Stat(cfgPath); os.IsNotExist(err) {
			cfgPath = "config.yaml"
		}
	}

	// Load config
	cfg, err := LoadConfig(cfgPath)
	if err != nil {
		log.Fatalf("Failed to load config: %v", err)
	}

	if *port > 0 {
		cfg.Port = *port
	}

	// Resolve API keys from environment
	cfg.ResolveAPIKeys()

	// Load .env from ~/.woodbury/.env if keys are empty
	loadDotEnv()
	cfg.ResolveAPIKeys()

	// Initialize logger
	var logger *Logger
	if cfg.Logging.Enabled {
		logger, err = NewLogger(cfg.Logging.DBPath)
		if err != nil {
			log.Printf("Warning: Failed to initialize logger: %v (logging disabled)", err)
			logger = &Logger{}
		} else {
			defer logger.Close()
			log.Printf("Logging to %s", cfg.Logging.DBPath)
		}
	} else {
		logger = &Logger{}
	}

	handler := NewProxyHandler(&cfg, logger)

	mux := http.NewServeMux()
	mux.HandleFunc("/v1/messages", handler.HandleMessages)
	mux.HandleFunc("/v1/chat/completions", handler.HandleChatCompletions)
	mux.HandleFunc("/v1/models", handler.HandleModels)
	mux.HandleFunc("/stats", handler.HandleStats)
	mux.HandleFunc("/health", handler.HandleHealth)

	// CORS middleware for browser access to /stats
	corsHandler := corsMiddleware(mux)

	addr := fmt.Sprintf(":%d", cfg.Port)
	log.Printf("woodbury-llm-proxy v%s listening on http://localhost%s", version, addr)
	log.Printf("Default backend: %s", cfg.DefaultBackend)
	for name, b := range cfg.Backends {
		hasKey := "✗"
		if b.APIKey != "" {
			hasKey = "✓"
		}
		log.Printf("  %s: %s (key: %s)", name, b.BaseURL, hasKey)
	}

	if err := http.ListenAndServe(addr, corsHandler); err != nil {
		log.Fatalf("Server failed: %v", err)
	}
}

func corsMiddleware(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, x-api-key, anthropic-version, anthropic-beta, Authorization")
		if r.Method == "OPTIONS" {
			w.WriteHeader(204)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func loadDotEnv() {
	home, err := os.UserHomeDir()
	if err != nil {
		return
	}
	envPath := filepath.Join(home, ".woodbury", ".env")
	data, err := os.ReadFile(envPath)
	if err != nil {
		return
	}
	for _, line := range splitLines(string(data)) {
		if len(line) == 0 || line[0] == '#' {
			continue
		}
		for i, c := range line {
			if c == '=' {
				key := line[:i]
				val := line[i+1:]
				// Strip surrounding quotes
				if len(val) >= 2 && ((val[0] == '"' && val[len(val)-1] == '"') || (val[0] == '\'' && val[len(val)-1] == '\'')) {
					val = val[1 : len(val)-1]
				}
				if os.Getenv(key) == "" {
					os.Setenv(key, val)
				}
				break
			}
		}
	}
}

func splitLines(s string) []string {
	var lines []string
	start := 0
	for i := 0; i < len(s); i++ {
		if s[i] == '\n' {
			line := s[start:i]
			if len(line) > 0 && line[len(line)-1] == '\r' {
				line = line[:len(line)-1]
			}
			lines = append(lines, line)
			start = i + 1
		}
	}
	if start < len(s) {
		lines = append(lines, s[start:])
	}
	return lines
}
