package main

import (
	"database/sql"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	_ "github.com/mattn/go-sqlite3"
)

type RequestLog struct {
	Model           string
	Backend         string
	InputTokens     int
	OutputTokens    int
	CostUSD         float64
	LatencyMs       int64
	PromptPreview   string
	ResponsePreview string
	Status          int
	Error           string
}

type Logger struct {
	db  *sql.DB
	mu  sync.Mutex
}

func NewLogger(dbPath string) (*Logger, error) {
	if dbPath == "" {
		return &Logger{}, nil
	}
	dir := filepath.Dir(dbPath)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return nil, fmt.Errorf("create log dir: %w", err)
	}
	db, err := sql.Open("sqlite3", dbPath+"?_journal_mode=WAL")
	if err != nil {
		return nil, fmt.Errorf("open db: %w", err)
	}
	_, err = db.Exec(`CREATE TABLE IF NOT EXISTS requests (
		id INTEGER PRIMARY KEY AUTOINCREMENT,
		timestamp TEXT NOT NULL,
		model TEXT,
		backend TEXT,
		input_tokens INTEGER DEFAULT 0,
		output_tokens INTEGER DEFAULT 0,
		cost_usd REAL DEFAULT 0,
		latency_ms INTEGER DEFAULT 0,
		prompt_preview TEXT,
		response_preview TEXT,
		status INTEGER DEFAULT 0,
		error TEXT
	)`)
	if err != nil {
		db.Close()
		return nil, fmt.Errorf("create table: %w", err)
	}
	return &Logger{db: db}, nil
}

func (l *Logger) Log(entry RequestLog) {
	if l.db == nil {
		return
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	_, _ = l.db.Exec(
		`INSERT INTO requests (timestamp, model, backend, input_tokens, output_tokens, cost_usd, latency_ms, prompt_preview, response_preview, status, error)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		time.Now().UTC().Format(time.RFC3339),
		entry.Model, entry.Backend,
		entry.InputTokens, entry.OutputTokens, entry.CostUSD, entry.LatencyMs,
		truncate(entry.PromptPreview, 200), truncate(entry.ResponsePreview, 200),
		entry.Status, entry.Error,
	)
}

type Stats struct {
	TotalRequests int     `json:"totalRequests"`
	TotalInput    int     `json:"totalInputTokens"`
	TotalOutput   int     `json:"totalOutputTokens"`
	TotalCost     float64 `json:"totalCostUSD"`
	AvgLatency    float64 `json:"avgLatencyMs"`
	ByModel       map[string]ModelStats `json:"byModel"`
}

type ModelStats struct {
	Requests int     `json:"requests"`
	Input    int     `json:"inputTokens"`
	Output   int     `json:"outputTokens"`
	Cost     float64 `json:"costUSD"`
}

func (l *Logger) GetStats() Stats {
	s := Stats{ByModel: make(map[string]ModelStats)}
	if l.db == nil {
		return s
	}
	l.mu.Lock()
	defer l.mu.Unlock()

	row := l.db.QueryRow(`SELECT COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cost_usd),0), COALESCE(AVG(latency_ms),0) FROM requests`)
	_ = row.Scan(&s.TotalRequests, &s.TotalInput, &s.TotalOutput, &s.TotalCost, &s.AvgLatency)

	rows, err := l.db.Query(`SELECT model, COUNT(*), COALESCE(SUM(input_tokens),0), COALESCE(SUM(output_tokens),0), COALESCE(SUM(cost_usd),0) FROM requests GROUP BY model`)
	if err == nil {
		defer rows.Close()
		for rows.Next() {
			var m string
			var ms ModelStats
			if rows.Scan(&m, &ms.Requests, &ms.Input, &ms.Output, &ms.Cost) == nil {
				s.ByModel[m] = ms
			}
		}
	}
	return s
}

func (l *Logger) Close() {
	if l.db != nil {
		l.db.Close()
	}
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n] + "..."
}
