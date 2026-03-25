package main

import (
	"os"
	"path/filepath"
	"strings"

	"gopkg.in/yaml.v3"
)

type Config struct {
	Port           int              `yaml:"port"`
	DefaultBackend string           `yaml:"default_backend"`
	Backends       map[string]Backend `yaml:"backends"`
	Routes         []Route          `yaml:"routes"`
	Logging        LoggingConfig    `yaml:"logging"`
	CostRates      map[string]CostRate `yaml:"cost_rates"`
}

type Backend struct {
	APIKeyEnv string `yaml:"api_key_env"`
	BaseURL   string `yaml:"base_url"`
	APIKey    string `yaml:"-"` // resolved at runtime
}

type Route struct {
	Match   string `yaml:"match"`
	Backend string `yaml:"backend"`
}

type LoggingConfig struct {
	Enabled bool   `yaml:"enabled"`
	DBPath  string `yaml:"db_path"`
}

type CostRate struct {
	InputPer1M  float64 `yaml:"input_per_1m"`
	OutputPer1M float64 `yaml:"output_per_1m"`
}

func DefaultConfig() Config {
	home, _ := os.UserHomeDir()
	return Config{
		Port:           8642,
		DefaultBackend: "anthropic",
		Backends: map[string]Backend{
			"anthropic": {APIKeyEnv: "ANTHROPIC_API_KEY", BaseURL: "https://api.anthropic.com"},
			"openai":    {APIKeyEnv: "OPENAI_API_KEY", BaseURL: "https://api.openai.com"},
		},
		Routes: []Route{
			{Match: "claude-*", Backend: "anthropic"},
			{Match: "gpt-*", Backend: "openai"},
			{Match: "o1-*", Backend: "openai"},
			{Match: "o3-*", Backend: "openai"},
			{Match: "*", Backend: "anthropic"},
		},
		Logging: LoggingConfig{
			Enabled: true,
			DBPath:  filepath.Join(home, ".woodbury", "data", "llm-proxy.db"),
		},
		CostRates: map[string]CostRate{
			"claude-sonnet-4-20250514": {InputPer1M: 3.0, OutputPer1M: 15.0},
			"claude-opus-4-20250514":   {InputPer1M: 15.0, OutputPer1M: 75.0},
			"gpt-4o":                   {InputPer1M: 2.5, OutputPer1M: 10.0},
			"gpt-4o-mini":              {InputPer1M: 0.15, OutputPer1M: 0.6},
		},
	}
}

func LoadConfig(path string) (Config, error) {
	cfg := DefaultConfig()
	if path == "" {
		return cfg, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		if os.IsNotExist(err) {
			return cfg, nil
		}
		return cfg, err
	}
	if err := yaml.Unmarshal(data, &cfg); err != nil {
		return cfg, err
	}
	return cfg, nil
}

func (c *Config) ResolveAPIKeys() {
	for name, b := range c.Backends {
		if b.APIKeyEnv != "" {
			b.APIKey = os.Getenv(b.APIKeyEnv)
		}
		c.Backends[name] = b
	}
}

func (c *Config) ResolveBackend(model string) string {
	model = strings.ToLower(model)
	for _, r := range c.Routes {
		pattern := strings.ToLower(r.Match)
		if pattern == "*" || matchGlob(pattern, model) {
			return r.Backend
		}
	}
	return c.DefaultBackend
}

func matchGlob(pattern, s string) bool {
	if pattern == "*" {
		return true
	}
	if strings.HasSuffix(pattern, "*") {
		return strings.HasPrefix(s, strings.TrimSuffix(pattern, "*"))
	}
	if strings.HasPrefix(pattern, "*") {
		return strings.HasSuffix(s, strings.TrimPrefix(pattern, "*"))
	}
	return pattern == s
}
