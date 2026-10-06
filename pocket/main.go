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
//   - With step times turned on, one thing: when a step of a checklist run is marked done, it sets the due date of the
//     steps in that run timed from it (T#40m in their template step: 40 minutes after). It writes only due_date, and
//     the time of those steps' reminders counted from their due date (Vikunja works those out only when a task is
//     saved through it), only on steps of that run in the same project that aren't done, and nothing else, not even
//     the time a task was last changed. All of it is in setStepDueDates.
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
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode"

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
func (p *Pocket) Version() string { return "0.0.0-dev" } // set from the tag when a release is made
func (p *Pocket) Shutdown() error { return nil }

// Init turns on step times if asked to, and finds the app/ folder. Vikunja doesn't tell a plugin where it lives, so
// this looks in POCKET_APP_DIR, then in plugins/pocket/app under the working directory (Vikunja's rootpath on Cloudron
// and in Docker).
func (p *Pocket) Init() error {
	// Vikunja starts its events after its plugins, so a listener added here hears every one.
	if viper.GetBool("plugins.pocket.steptimes") {
		events.RegisterListener((&models.TaskUpdatedEvent{}).Name(), &stepTimes{})
		log.Infof("pocket: step times on: a checklist step marked done sets the due dates of the steps timed from it")
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
			log.Infof("pocket: serving %s at /api/v1/plugins/pocket/ (version %s)", abs, p.Version())
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
     {#roast}       names the step "roast"
     T#40m:roast    40 minutes after the step named "roast" is done
   Units d, h, m, s and ms, combined as in T#1h30m, up to a year. Pocket checks templates when they're made, changed and
   started, so anything else here (T#-10m, a name used twice) is simply not a time. */
var (
	stepTimeRe = regexp.MustCompile(`(?i)(?:^|\s)T#((?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+)(?::([a-z][\w-]*))?(?:\s|$)`)
	stepUnitRe = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)(ms|d|h|m|s)`)
	stepNameRe = regexp.MustCompile(`\{#([A-Za-z][\w-]*)\}`)
	stepUnits  = map[string]float64{"d": 86400000, "h": 3600000, "m": 60000, "s": 1000, "ms": 1}
	stepMax    = 365 * 86400000.0 // a year, in ms, as index.html
)

type stepTime struct {
	timed  bool
	offset time.Duration
	ref    string // the name it counts from, or "" for the step before
	name   string
}

func parseStepTime(title string) stepTime {
	// Any kind of space is a space, as in JavaScript, where Pocket checks the same title.
	title = strings.Map(func(r rune) rune {
		if unicode.IsSpace(r) || r == 0xFEFF {
			return ' '
		}
		return r
	}, title)
	st := stepTime{}
	if m := stepTimeRe.FindStringSubmatch(title); m != nil {
		ms := 0.0
		for _, u := range stepUnitRe.FindAllStringSubmatch(m[1], -1) {
			n, _ := strconv.ParseFloat(u[1], 64)
			ms += n * stepUnits[strings.ToLower(u[2])]
		}
		if ms <= stepMax {
			st.timed, st.offset, st.ref = true, time.Duration(math.Round(ms))*time.Millisecond, m[2]
		}
	}
	if m := stepNameRe.FindStringSubmatch(title); m != nil {
		st.name = m[1]
	}
	return st
}

// The fields of a task.updated event this needs.
type eventTask struct {
	ID     int64     `json:"id"`
	Done   bool      `json:"done"`
	DoneAt time.Time `json:"done_at"`
}
type taskEvent struct {
	Task eventTask `json:"task"`
}

// Each time a task was marked done that's been acted on: task id and done_at, kept for stepFresh.
type stepTick struct{ id, at int64 }

var (
	stepFresh   = 2 * time.Minute
	stepTicks   = map[stepTick]time.Time{}
	stepTicksMu sync.Mutex
)

type stepTimes struct{}

func (l *stepTimes) Name() string { return "pocket.steptimes" }

// Handle hears every task update and acts once on each time a task is marked done. Vikunja's event doesn't say what
// changed, but done_at changes only when a task is marked done: so a done task whose done_at is recent, and not acted on
// already. Saving it again, labelling or assigning it changes nothing; marking it not done forgets it, so the next tick
// counts even within the same second. (Just after Vikunja restarts, an edit within
// stepFresh of the tick can set the same dates again.) Our own writes send no event at all. Returning an error makes
// Vikunja try again, a few times.
func (l *stepTimes) Handle(msg *message.Message) error {
	ev := taskEvent{}
	if err := json.Unmarshal(msg.Payload, &ev); err != nil {
		return nil
	}
	t := ev.Task
	if !t.Done {
		stepTicksMu.Lock()
		for k := range stepTicks {
			if k.id == t.ID {
				delete(stepTicks, k)
			}
		}
		stepTicksMu.Unlock()
		return nil
	}
	if t.DoneAt.IsZero() || time.Since(t.DoneAt) > stepFresh {
		return nil
	}
	tick := stepTick{t.ID, t.DoneAt.Unix()}
	stepTicksMu.Lock()
	_, seen := stepTicks[tick]
	stepTicksMu.Unlock()
	if seen {
		return nil
	}
	handled, err := setStepDueDates(t.ID, t.DoneAt)
	if err != nil {
		log.Errorf("pocket: step times for task %d: %s", t.ID, err)
		return err
	}
	if !handled {
		return nil // undone since, or done again: that tick's own event is acted on in its turn
	}
	stepTicksMu.Lock()
	for k, at := range stepTicks {
		if time.Since(at) > stepFresh {
			delete(stepTicks, k)
		}
	}
	stepTicks[tick] = time.Now()
	stepTicksMu.Unlock()
	return nil
}

// setStepDueDates is the only place the plugin writes to Vikunja's data. Given a task marked done at doneAt that is a
// step of a checklist run, it sets the due date of each step of the same run timed from it: its done time plus the
// offset in the title of the template step that step was copied from. It writes only due_date (not even "updated"),
// and the time of the step's reminders counted from its due date, only on steps of that run in its project that aren't
// done, and only when the date changes. handled: whether the task was still done at doneAt, so this tick is dealt with.
//
// Vikunja lets anyone link a task they can edit to one they can only see, so the run is taken only as Pocket makes
// one: the run, its steps and its template all in the done step's project, the template labelled "template", and each
// step's offset read from a step of that template.
func setStepDueDates(stepID int64, doneAt time.Time) (handled bool, err error) {
	s := db.NewSession()
	defer s.Close()

	step := &models.Task{}
	if has, err := s.ID(stepID).Get(step); err != nil || !has || !step.Done || step.DoneAt.Unix() != doneAt.Unix() {
		return false, err
	}
	return true, writeStepDueDates(s, step)
}

func writeStepDueDates(s *xorm.Session, step *models.Task) error {
	stepID, project := step.ID, step.ProjectID
	// The run it's a step of: a copy of a template, and not a template itself, nor one still being set up.
	parents, err := relatedIDs(s, stepID, "parenttask")
	if err != nil || len(parents) != 1 {
		return err
	}
	run, err := taskIn(s, parents[0], project)
	if err != nil || run == nil {
		return err
	}
	if tpl, err := isTemplate(s, run.ID); err != nil || tpl {
		return err
	}
	from, err := relatedIDs(s, run.ID, "copiedfrom")
	if err != nil || len(from) == 0 {
		return err
	}
	template, err := taskIn(s, from[0], project)
	if err != nil || template == nil {
		return err
	}
	if tpl, err := isTemplate(s, template.ID); err != nil || !tpl {
		return err
	}

	// The template's steps, and the run's in their order, each with the template step it was copied from. A run's steps
	// are copied one at a time in its template's order, so they're in order by id, as Pocket shows them.
	tplStepIDs, err := relatedIDs(s, template.ID, "subtask")
	if err != nil || len(tplStepIDs) == 0 {
		return err
	}
	tplSteps := map[int64]*models.Task{}
	if err := s.In("id", tplStepIDs).And("project_id = ?", project).Find(&tplSteps); err != nil {
		return err
	}
	// All of them, wherever they are, so "the step before" is the one Pocket shows before it; only those in the
	// project are written to.
	runStepIDs, err := relatedIDs(s, run.ID, "subtask")
	if err != nil || len(runStepIDs) < 2 {
		return err
	}
	tasks := map[int64]*models.Task{}
	if err := s.In("id", runStepIDs).Find(&tasks); err != nil {
		return err
	}
	ids := []int64{}
	for _, id := range runStepIDs {
		if tasks[id] != nil {
			ids = append(ids, id)
		}
	}
	sort.Slice(ids, func(a, b int) bool { return ids[a] < ids[b] })
	copied := []*models.TaskRelation{}
	if err := s.In("task_id", ids).And("relation_kind = ?", "copiedfrom").OrderBy("id").Find(&copied); err != nil {
		return err
	}
	fromOf := map[int64]*models.Task{}
	for _, r := range copied {
		if t := tplSteps[r.OtherTaskID]; t != nil && fromOf[r.TaskID] == nil {
			fromOf[r.TaskID] = t
		}
	}
	steps, at := make([]stepTime, len(ids)), -1
	for i, id := range ids {
		if t := fromOf[id]; t != nil {
			steps[i] = parseStepTime(t.Title)
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
		if dep.Done || dep.ProjectID != project {
			continue
		}
		due := step.DoneAt.Add(st.offset).Truncate(time.Second)
		if dep.DueDate.Unix() == due.Unix() {
			continue
		}
		if _, err := s.ID(dep.ID).Cols("due_date").NoAutoTime().Update(&models.Task{DueDate: due}); err != nil {
			_ = s.Rollback()
			return err
		}
		// A reminder counted from the due date (Pocket gives timed steps one at it) moves with it, as Vikunja would
		// move it if the date were saved through Vikunja.
		reminders := []*models.TaskReminder{}
		if err := s.Where("task_id = ? AND relative_to = ?", dep.ID, "due_date").Find(&reminders); err != nil {
			_ = s.Rollback()
			return err
		}
		for _, r := range reminders {
			at := due.Add(time.Duration(r.RelativePeriod) * time.Second)
			if _, err := s.ID(r.ID).Cols("reminder").Update(&models.TaskReminder{Reminder: at}); err != nil {
				_ = s.Rollback()
				return err
			}
		}
		wrote = true
	}
	if !wrote {
		return nil
	}
	return s.Commit()
}

// A task, if it's in the project; nil if not.
func taskIn(s *xorm.Session, id, project int64) (*models.Task, error) {
	t := &models.Task{}
	if has, err := s.ID(id).Get(t); err != nil || !has || t.ProjectID != project {
		return nil, err
	}
	return t, nil
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

// The tasks related to a task by one kind of relation, in the order the relations were made.
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
