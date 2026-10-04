// Serves Pocket for Vikunja from Vikunja itself, at <your Vikunja>/api/v1/plugins/pocket/.
//
// Install: copy this pocket/ folder into <Vikunja's rootpath>/plugins/, so there is plugins/pocket/main.go and
// plugins/pocket/app/index.html, then turn plugins on in Vikunja's config.yml
//
//	plugins:
//	  enabled: true
//	  loader: yaegi
//
// and restart Vikunja. Needs Vikunja 2.7 or later; Vikunja runs plugins from source with Yaegi (nothing to compile).
// If it fails to load, Vikunja logs it and keeps running.
//
// What it does to Vikunja's data:
//
//   - By default, nothing. It only reads the files in app/ and serves them.
//   - With step times turned on, one thing: when a step of a workflow run is marked done, it sets the due date of the
//     steps in that run timed from it (T#40m in their template step: 40 minutes after). It writes only due_date, only
//     on steps of that run in the same project that aren't done, and nothing else. All of it is in setStepDueDates.
//     Turn it on in config.yml, or with the environment variable VIKUNJA_PLUGINS_POCKET_STEPTIMES=true:
//
//	plugins:
//	  pocket:
//	    steptimes: true

// Yaegi evaluates this file at runtime through the factory functions below, so there is no func main.
//go:build ignore

package main

import (
	"encoding/json"
	"math"
	"net/http"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"code.vikunja.io/api/pkg/db"
	"code.vikunja.io/api/pkg/events"
	"code.vikunja.io/api/pkg/log"
	"code.vikunja.io/api/pkg/models"
	"code.vikunja.io/api/pkg/plugins"

	"github.com/ThreeDotsLabs/watermill/message"
	"github.com/labstack/echo/v5"
	"github.com/spf13/viper"
	"xorm.io/xorm"
)

type Pocket struct{ dir string }

func (p *Pocket) Name() string    { return "pocket" }
func (p *Pocket) Version() string { return "1.1.0" }
func (p *Pocket) Shutdown() error { return nil }

// Init turns on step times if asked to, and finds the app/ folder. Vikunja doesn't tell a plugin where it lives, so
// this looks in POCKET_APP_DIR, then in plugins/pocket/app under the working directory (Vikunja's rootpath on Cloudron
// and in Docker).
func (p *Pocket) Init() error {
	// Vikunja starts its events after its plugins, so a listener added here hears every one.
	if viper.GetBool("plugins.pocket.steptimes") {
		events.RegisterListener((&models.TaskUpdatedEvent{}).Name(), &stepTimes{})
		log.Infof("pocket: step times on: a workflow step marked done sets the due dates of the steps timed from it")
	}
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

/* ---------- step times ---------- */

/* A template step's title says when a run's copy of it is due, as Pocket's app reads it (parseStep in index.html):
     T#20m          20 minutes after the step before it is done
     {#dryer}       names the step "dryer"
     T#40m:dryer    40 minutes after the step named "dryer" is done
   Units d, h, m, s and ms, combined as in T#1h30m. Pocket checks templates when they're made, changed and started, so
   anything else here (T#-10m, a name used twice) is simply not a time. */
var (
	stepTimeRe = regexp.MustCompile(`(?i)(?:^|\s)T#((?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+)(?::([a-z][\w-]*))?(?:\s|$)`)
	stepUnitRe = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)(ms|d|h|m|s)`)
	stepNameRe = regexp.MustCompile(`\{#([A-Za-z][\w-]*)\}`)
	stepUnits  = map[string]float64{"d": 86400000, "h": 3600000, "m": 60000, "s": 1000, "ms": 1}
)

type stepTime struct {
	timed  bool
	offset time.Duration
	ref    string // the name it counts from, or "" for the step before
	name   string
}

func parseStepTime(title string) stepTime {
	st := stepTime{}
	if m := stepTimeRe.FindStringSubmatch(title); m != nil {
		ms := 0.0
		for _, u := range stepUnitRe.FindAllStringSubmatch(m[1], -1) {
			n, _ := strconv.ParseFloat(u[1], 64)
			ms += n * stepUnits[strings.ToLower(u[2])]
		}
		st.timed, st.offset, st.ref = true, time.Duration(math.Round(ms))*time.Millisecond, m[2]
	}
	if m := stepNameRe.FindStringSubmatch(title); m != nil {
		st.name = m[1]
	}
	return st
}

// The fields of a task.updated event this needs.
type eventTask struct {
	ID      int64     `json:"id"`
	Done    bool      `json:"done"`
	DoneAt  time.Time `json:"done_at"`
	Updated time.Time `json:"updated"`
}
type taskEvent struct {
	Task eventTask `json:"task"`
}

type stepTimes struct{}

func (l *stepTimes) Name() string { return "pocket.steptimes" }

// Handle hears every task update. It acts on a task just marked done: Vikunja sets done_at only then, in the same save
// that sets "updated". Saving a done task again later, or labelling it, sends the event with a later "updated", and is
// left alone. Our own writes send no event at all. Returning an error makes Vikunja try again, a few times.
func (l *stepTimes) Handle(msg *message.Message) error {
	ev := taskEvent{}
	if err := json.Unmarshal(msg.Payload, &ev); err != nil {
		return nil
	}
	t := ev.Task
	if !t.Done || t.DoneAt.IsZero() {
		return nil
	}
	if gap := t.Updated.Sub(t.DoneAt); gap > 2*time.Second || gap < -2*time.Second {
		return nil
	}
	err := setStepDueDates(t.ID)
	if err != nil {
		log.Errorf("pocket: step times for task %d: %s", t.ID, err)
	}
	return err
}

// setStepDueDates is the only place the plugin writes to Vikunja's data. Given a task just marked done that is a step
// of a workflow run, it sets the due date of each step of the same run timed from it: its done time plus the offset in
// the title of the template step that step was copied from. It writes only due_date, only on steps of that run in the
// same project as the done step, only on those not done, and only when the date changes.
func setStepDueDates(stepID int64) error {
	s := db.NewSession()
	defer s.Close()

	step := &models.Task{}
	if has, err := s.ID(stepID).Get(step); err != nil || !has || !step.Done {
		return err
	}
	// The run it's a step of: a copy of a template, and not a template itself (a template's steps are done too).
	parents, err := relatedIDs(s, stepID, "parenttask")
	if err != nil || len(parents) != 1 {
		return err
	}
	runID := parents[0]
	if from, err := relatedIDs(s, runID, "copiedfrom"); err != nil || len(from) == 0 {
		return err
	}
	if tpl, err := isTemplate(s, runID); err != nil || tpl {
		return err
	}

	// The run's steps in their order, each with the title of the template step it was copied from.
	ids, err := relatedIDs(s, runID, "subtask")
	if err != nil || len(ids) < 2 {
		return err
	}
	tasks := map[int64]*models.Task{}
	if err := s.In("id", ids).Find(&tasks); err != nil {
		return err
	}
	copied := []*models.TaskRelation{}
	if err := s.In("task_id", ids).And("relation_kind = ?", "copiedfrom").OrderBy("id").Find(&copied); err != nil {
		return err
	}
	fromOf, tplIDs := map[int64]int64{}, []int64{}
	for _, r := range copied {
		if _, ok := fromOf[r.TaskID]; !ok {
			fromOf[r.TaskID] = r.OtherTaskID
			tplIDs = append(tplIDs, r.OtherTaskID)
		}
	}
	tpls := map[int64]*models.Task{}
	if len(tplIDs) > 0 {
		if err := s.In("id", tplIDs).Find(&tpls); err != nil {
			return err
		}
	}
	steps, at := make([]stepTime, len(ids)), -1
	for i, id := range ids {
		if tpl := tpls[fromOf[id]]; tpl != nil {
			steps[i] = parseStepTime(tpl.Title)
		}
		if id == stepID {
			at = i
		}
	}
	if at < 0 {
		return nil
	}

	wrote := false
	for i := at + 1; i < len(ids); i++ {
		st := steps[i]
		if !st.timed || stepFrom(steps, i) != at {
			continue
		}
		dep := tasks[ids[i]]
		if dep == nil || dep.Done || dep.ProjectID != step.ProjectID {
			continue
		}
		due := step.DoneAt.Add(st.offset).Truncate(time.Second)
		if dep.DueDate.Unix() == due.Unix() {
			continue
		}
		if _, err := s.ID(dep.ID).Cols("due_date").Update(&models.Task{DueDate: due}); err != nil {
			_ = s.Rollback()
			return err
		}
		wrote = true
	}
	if !wrote {
		return nil
	}
	return s.Commit()
}

// stepFrom is which step a timed step counts from: the one before it, or the earlier one with its name; -1 if none.
func stepFrom(steps []stepTime, i int) int {
	if steps[i].ref == "" {
		return i - 1
	}
	for j := 0; j < i; j++ {
		if strings.EqualFold(steps[j].name, steps[i].ref) {
			return j
		}
	}
	return -1
}

// The tasks related to a task by one kind of relation, in the order the relations were made (a run's steps' order).
func relatedIDs(s *xorm.Session, taskID int64, kind string) ([]int64, error) {
	rels := []*models.TaskRelation{}
	if err := s.Where("task_id = ? AND relation_kind = ?", taskID, kind).OrderBy("id").Find(&rels); err != nil {
		return nil, err
	}
	ids := make([]int64, 0, len(rels))
	for _, r := range rels {
		ids = append(ids, r.OtherTaskID)
	}
	return ids, nil
}

// Whether a task has the label "template", as Pocket marks a template.
func isTemplate(s *xorm.Session, taskID int64) (bool, error) {
	links := []*models.LabelTask{}
	if err := s.Where("task_id = ?", taskID).Find(&links); err != nil || len(links) == 0 {
		return false, err
	}
	ids := make([]int64, 0, len(links))
	for _, l := range links {
		ids = append(ids, l.LabelID)
	}
	labels := []*models.Label{}
	if err := s.In("id", ids).Find(&labels); err != nil {
		return false, err
	}
	for _, l := range labels {
		if strings.EqualFold(strings.TrimSpace(l.Title), "template") {
			return true, nil
		}
	}
	return false, nil
}

// One instance for every factory, as Vikunja's example plugin does.
var singleton = &Pocket{}

func NewPlugin() plugins.Plugin { return singleton }

// Yaegi needs a factory typed as the router interface for Vikunja to see the routes.
func NewUnauthenticatedRouterPlugin() plugins.UnauthenticatedRouterPlugin { return singleton }
