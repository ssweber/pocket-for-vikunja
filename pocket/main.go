// Serves Pocket for Vikunja from Vikunja itself, at <your Vikunja>/api/v1/plugins/pocket/.
//
// Install: copy this pocket/ folder into <Vikunja's rootpath>/plugins/, so there is plugins/pocket/main.go and
// plugins/pocket/app/index.html, then turn plugins on in Vikunja's config.yml
//
//	plugins:
//	  enabled: true
//	  loader: yaegi
//
// and restart Vikunja. Needs Vikunja 2.3 or later, which runs plugins from source with Yaegi (nothing to compile).
// The plugin only reads the files in app/; it doesn't touch Vikunja's data. If it fails to load, Vikunja logs it
// and keeps running.

// Yaegi evaluates this file at runtime through the factory functions below, so there is no func main.
//go:build ignore

package main

import (
	"net/http"
	"os"
	"path"
	"path/filepath"
	"strings"

	"code.vikunja.io/api/pkg/log"
	"code.vikunja.io/api/pkg/plugins"

	"github.com/labstack/echo/v5"
)

type Pocket struct{ dir string }

func (p *Pocket) Name() string    { return "pocket" }
func (p *Pocket) Version() string { return "1.0.0" }
func (p *Pocket) Shutdown() error { return nil }

// Init finds the app/ folder. Vikunja doesn't tell a plugin where it lives, so this looks in POCKET_APP_DIR, then
// in plugins/pocket/app under the working directory (Vikunja's rootpath on Cloudron and in Docker).
func (p *Pocket) Init() error {
	for _, d := range []string{os.Getenv("POCKET_APP_DIR"), filepath.Join("plugins", "pocket", "app"), "/app/data/plugins/pocket/app"} {
		if d == "" {
			continue
		}
		if st, err := os.Stat(filepath.Join(d, "index.html")); err == nil && !st.IsDir() {
			abs, err := filepath.Abs(d)
			if err != nil {
				return err
			}
			p.dir = abs
			log.Infof("pocket: serving %s at /api/v1/plugins/pocket/", abs)
			return nil
		}
	}
	log.Errorf("pocket: couldn't find app/index.html next to the plugin; set POCKET_APP_DIR to the app folder")
	return nil
}

func (p *Pocket) RegisterUnauthenticatedRoutes(g *echo.Group) {
	// Without the trailing slash, the page's relative links would point one folder up.
	g.GET("/pocket", func(c *echo.Context) error {
		return c.Redirect(http.StatusMovedPermanently, c.Request().URL.Path+"/")
	})
	g.GET("/pocket/*", p.serve)
}

// Types Go might not know, or might guess differently.
var contentTypes = map[string]string{
	".html":        "text/html; charset=utf-8",
	".js":          "text/javascript; charset=utf-8",
	".webmanifest": "application/manifest+json",
	".png":         "image/png",
}

func (p *Pocket) serve(c *echo.Context) error {
	if p.dir == "" {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	// Cleaning a rooted path drops any "..", and the prefix check below makes sure nothing outside app/ is served.
	name := path.Clean("/" + c.Param("*"))
	if name == "/" {
		name = "/index.html"
	}
	file := filepath.Join(p.dir, filepath.FromSlash(name))
	if !strings.HasPrefix(file, p.dir+string(filepath.Separator)) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	if st, err := os.Stat(file); err != nil || st.IsDir() {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	h := c.Response().Header()
	if t, ok := contentTypes[path.Ext(name)]; ok {
		h.Set("Content-Type", t)
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "frame-ancestors 'none'") // no framing by other sites
	h.Set("Referrer-Policy", "no-referrer")
	if name == "/index.html" {
		h.Set("Cache-Control", "no-cache") // pick up a new version as soon as it's uploaded
	}
	return c.File(file)
}

// One instance for every factory, as Vikunja's example plugin does.
var singleton = &Pocket{}

func NewPlugin() plugins.Plugin { return singleton }

// Yaegi needs a factory typed as the router interface for Vikunja to see the routes.
func NewUnauthenticatedRouterPlugin() plugins.UnauthenticatedRouterPlugin { return singleton }
