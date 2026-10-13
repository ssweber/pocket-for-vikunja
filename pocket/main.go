// Serves Pocket for Vikunja from Vikunja itself, at <your Vikunja>/api/v1/plugins/pocket/.
//
// Install: copy this pocket/ folder into <Vikunja's rootpath>/plugins/, so there is plugins/pocket/main.go and
// plugins/pocket/app/index.html, then turn plugins on in Vikunja's config.yml
//
//	plugins:
//	  enabled: true
//	  loader: yaegi
//
// and restart Vikunja. Needs Vikunja 2.7 or later. Vikunja runs plugins from source with Yaegi, so there is nothing
// to compile. If the plugin fails to load, Vikunja logs the error and keeps running.
//
// What it does to Vikunja's data:
//
//   - By default, nothing. It only reads the files in app/ and serves them.
//   - With step times turned on, one thing. When a step of a checklist run is marked done, it sets the due date of the
//     steps in that run that are timed from it (T#40m in their template step means 40 minutes after). It writes only
//     due_date, and the time of those steps' reminders that count from their due date (Vikunja works those out only
//     when a task is saved through it). It writes only on steps of that run, in the same project, that aren't done.
//     It writes nothing else, not even the time a task was last changed. When the step is marked not done again, it
//     removes those due dates, and the reminders' times with them, so no reminder goes off for a step that is still
//     waiting. All of this is in writeStepDueDates.
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
	"html"
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
func (p *Pocket) Version() string { return "0.0.0-dev" } // replaced with the tag when a release is made
func (p *Pocket) Shutdown() error { return nil }

// Init turns on step times if the config asks for them, and finds the app/ folder. Vikunja doesn't tell a plugin where
// it is installed, so Init looks in POCKET_APP_DIR, then in plugins/pocket/app under the working directory (which is
// Vikunja's rootpath on Cloudron and in Docker).
func (p *Pocket) Init() error {
	// Vikunja starts its events after its plugins, so a listener added here receives every event.
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
	// Without the trailing slash, the page's relative links would resolve one folder too high.
	g.GET("/pocket", func(c *echo.Context) error {
		return c.Redirect(http.StatusMovedPermanently, c.Request().URL.Path+"/")
	})
	g.GET("/pocket/*", p.serve)
}

// Content types that Go might not know, or might guess differently.
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
	// Cleaning a rooted path removes any "..", and the prefix check below makes sure nothing outside app/ is served.
	name := path.Clean("/" + c.Param("*"))
	if name == "/" {
		name = "/index.html"
	}
	file := filepath.Join(p.dir, filepath.FromSlash(name))
	if !strings.HasPrefix(file, p.dir+string(filepath.Separator)) {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	// The compressed copies of the page are sent only in place of index.html (below), never under their own names.
	if ext := path.Ext(name); ext == ".br" || ext == ".gz" {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	st, err := os.Stat(file)
	if err != nil || st.IsDir() {
		return echo.NewHTTPError(http.StatusNotFound, "not found")
	}
	h := c.Response().Header()
	if t, ok := contentTypes[path.Ext(name)]; ok {
		h.Set("Content-Type", t)
	}
	h.Set("X-Content-Type-Options", "nosniff")
	h.Set("Content-Security-Policy", "frame-ancestors 'none'") // other sites can't embed Pocket in a frame
	h.Set("Referrer-Policy", "no-referrer")
	if name == "/index.html" {
		h.Set("Cache-Control", "no-cache") // browsers pick up a new version as soon as it is uploaded
		h.Set("Vary", "Accept-Encoding")
		// The build also writes compressed copies of the page (index.html.br and .gz, a fifth and a quarter of its size).
		// They go to browsers that accept them, with the page's own modified time, so Pocket's check for a new version
		// works the same on a compressed copy.
		if enc, ext := pageEncoding(c.Request().Header.Get("Accept-Encoding")); enc != "" {
			if f, err := os.Open(file + ext); err == nil {
				defer f.Close()
				h.Set("Content-Encoding", enc)
				http.ServeContent(c.Response(), c.Request(), "index.html", st.ModTime(), f)
				return nil
			}
		}
	}
	return c.File(file)
}

// pageEncoding returns the compressed page to send for an Accept-Encoding header such as "gzip, deflate, br". It
// prefers brotli, then gzip, and returns "" for the uncompressed page. An encoding with q=0 ("br;q=0") is refused.
func pageEncoding(accept string) (string, string) {
	taken := map[string]bool{}
	for _, part := range strings.Split(accept, ",") {
		f := strings.Split(part, ";")
		name := strings.ToLower(strings.TrimSpace(f[0]))
		taken[name] = true
		for _, p := range f[1:] {
			if q := strings.TrimSpace(p); strings.HasPrefix(q, "q=") {
				if v, err := strconv.ParseFloat(q[2:], 64); err == nil && v == 0 {
					taken[name] = false
				}
			}
		}
	}
	if taken["br"] {
		return "br", ".br"
	}
	if taken["gzip"] {
		return "gzip", ".gz"
	}
	return "", ""
}

/* ---------- step times ---------- */

/* A template step's title says when a run's copy of that step is due. This is how Pocket's app reads it (parseStep in
   index.html):
     T#20m          20 minutes after the step before it is done
     {#roast}       names the step "roast"
     T#40m:roast    40 minutes after the step named "roast" is done
   The units are d, h, m, s and ms, combined as in T#1h30m, up to a year. Pocket checks templates when they are made,
   changed and started, so anything else here (T#-10m, a name used twice) is simply not a time. */
var (
	stepTimeRe = regexp.MustCompile(`(?i)(?:^|\s)T#((?:\d+(?:\.\d+)?(?:ms|d|h|m|s))+)(?::([a-z][\w-]*))?(?:\s|$)`)
	stepUnitRe = regexp.MustCompile(`(?i)(\d+(?:\.\d+)?)(ms|d|h|m|s)`)
	stepNameRe = regexp.MustCompile(`\{#([A-Za-z][\w-]*)\}`)
	stepUnits  = map[string]float64{"d": 86400000, "h": 3600000, "m": 60000, "s": 1000, "ms": 1}
	stepMax    = 365 * 86400000.0 // a year in ms, the same limit as index.html
	// A run keeps what it was started from (checklists.js). Its description has "pocket:run", and each step's description
	// has "pocket:step <title of the template step when the run started>". Changing or deleting the template later
	// then affects only later runs.
	runLineRe  = regexp.MustCompile(`(?im)(?:^|>)\s*pocket:run\s*(?:<|$)`)
	stepLineRe = regexp.MustCompile(`(?im)(?:^|>)\s*pocket:step\s+([^<\n]+)`)
	// A run's step order, "pocket:order 12 15 13", is written when the run starts and when a step is inserted. A step
	// inserted or repeated during the run gets "pocket:added". A repeated step also keeps the "pocket:step" line of the
	// step it repeats.
	orderLineRe = regexp.MustCompile(`(?im)(?:^|>)\s*pocket:order((?:\s+\d+)*)\s*(?:<|$)`)
	addedLineRe = regexp.MustCompile(`(?im)(?:^|>)\s*pocket:added\s*(?:<|$)`)
)

// orderOf returns each task id in a run's order line with its index in that line, or nil for a run without an order line.
func orderOf(desc string) map[int64]int {
	m := orderLineRe.FindStringSubmatch(desc)
	if m == nil {
		return nil
	}
	at := map[int64]int{}
	for k, f := range strings.Fields(m[1]) {
		if id, err := strconv.ParseInt(f, 10, 64); err == nil {
			if _, seen := at[id]; !seen {
				at[id] = k
			}
		}
	}
	return at
}

// stepLineOf reads, from a step's description, the title its template step had when the run started. ok is false for a
// step in a run started before steps kept this line.
func stepLineOf(desc string) (title string, ok bool) {
	m := stepLineRe.FindStringSubmatch(desc)
	if m == nil {
		return "", false
	}
	return strings.TrimSpace(html.UnescapeString(m[1])), true
}

type stepTime struct {
	timed  bool
	offset time.Duration
	ref    string // the name of the step it counts from, or "" for the previous step
	name   string
}

func parseStepTime(title string) stepTime {
	// Treat every kind of whitespace as a space, because JavaScript does, and Pocket checks the same title there.
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

// The fields of a task.updated event that the plugin uses.
type eventTask struct {
	ID     int64     `json:"id"`
	Done   bool      `json:"done"`
	DoneAt time.Time `json:"done_at"`
}
type taskEvent struct {
	Task eventTask `json:"task"`
}

// A time a task was marked done that the plugin has already acted on: the task id and its done_at. Kept for stepFresh.
type stepTick struct{ id, at int64 }

var (
	stepFresh   = 2 * time.Minute
	stepTicks   = map[stepTick]time.Time{}
	stepTicksMu sync.Mutex
)

type stepTimes struct{}

func (l *stepTimes) Name() string { return "pocket.steptimes" }

// Handle receives every task update and acts once each time a task is marked done. Vikunja's event doesn't say what
// changed. But done_at changes only when a task is marked done, so Handle acts on a done task whose done_at is recent
// and not yet acted on. Saving the task again, labelling it or assigning it does nothing. Marking it not done forgets
// the earlier mark, so the next time it is marked done counts even within the same second. It also removes the due
// dates that mark set on the steps waiting for it. (Just after Vikunja restarts, an edit within stepFresh of the mark
// can set the same dates again.) The plugin's own writes send no event. If Handle returns an error, Vikunja tries
// again a few times.
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
		if err := clearStepDueDates(t.ID); err != nil {
			log.Errorf("pocket: step times for task %d: %s", t.ID, err)
			return err
		}
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
		return nil // marked not done since, or done again: the event for that change is handled separately
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

// setStepDueDates takes a task that was marked done at doneAt. If it is a step of a checklist run, the function sets
// the due date of each step in the same run that is timed from it (see writeStepDueDates). handled reports whether the
// task was still done at doneAt. If so, this mark as done is dealt with.
//
// Vikunja lets anyone link a task they can edit to a task they can only view. So the plugin accepts a run only in the
// shape Pocket makes: the run and its steps are in the done step's project. Each step's offset comes from its own
// "pocket:step" line. For a run started before runs kept that line, it comes from a step of the run's template, which
// must be in the same project and have the label "template".
func setStepDueDates(stepID int64, doneAt time.Time) (handled bool, err error) {
	s := db.NewSession()
	defer s.Close()

	step := &models.Task{}
	if has, err := s.ID(stepID).Get(step); err != nil || !has || !step.Done || step.DoneAt.Unix() != doneAt.Unix() {
		return false, err
	}
	return true, writeStepDueDates(s, step)
}

// clearStepDueDates takes a task that was marked not done. If it is a step of a checklist run, the steps timed from it
// that aren't done lose their due date until it is done again, as Pocket shows them. If the step was repeated, they
// count from a copy that is still done instead. The task is read again because events can arrive out of order. A step
// that was marked done again since is left to the event for that change.
func clearStepDueDates(stepID int64) error {
	s := db.NewSession()
	defer s.Close()

	step := &models.Task{}
	if has, err := s.ID(stepID).Get(step); err != nil || !has || step.Done {
		return err
	}
	return writeStepDueDates(s, step)
}

// writeStepDueDates is the only place the plugin writes to Vikunja's data. It takes a step of a checklist run and sets
// the due date of each step in the same run that is timed from it. The date is when the step was done (or when the last
// of its repeats was done) plus the offset in the timed step's template step title. If none of them is done, the date
// is cleared. It writes only due_date (not even "updated") and the time of the timed step's reminders that count from
// its due date. It writes only on steps of that run, in the step's project, that aren't done, and only when the date
// changes.
func writeStepDueDates(s *xorm.Session, step *models.Task) error {
	stepID, project := step.ID, step.ProjectID
	// Find the run this step belongs to. It must be a copy of a template, not a template itself and not one still being
	// set up.
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
	// The template's steps, for a run started before runs kept their steps' times. The template is the one the run was
	// copied from, in the same project, with the label "template". A run that keeps the times needs no template, which
	// may have been deleted since.
	tplSteps := map[int64]*models.Task{}
	from, err := relatedIDs(s, run.ID, "copiedfrom")
	if err != nil {
		return err
	}
	if len(from) > 0 {
		template, err := taskIn(s, from[0], project)
		if err != nil {
			return err
		}
		if template != nil {
			tpl, err := isTemplate(s, template.ID)
			if err != nil {
				return err
			}
			if tpl {
				tplStepIDs, err := relatedIDs(s, template.ID, "subtask")
				if err != nil {
					return err
				}
				if len(tplStepIDs) > 0 {
					if err := s.In("id", tplStepIDs).And("project_id = ?", project).Find(&tplSteps); err != nil {
						return err
					}
				}
			}
		}
	}
	if len(tplSteps) == 0 && !runLineRe.MatchString(run.Description) {
		return nil // Pocket didn't make this run
	}

	// Put the run's steps in the order Pocket shows them. The run's order line (written when the run starts and when a
	// step is inserted) comes first, then any steps it doesn't list, in the order they were copied, by id. This includes
	// steps in other projects, so "the previous step" is the one Pocket shows before this step. Only steps in this
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
	order := orderOf(run.Description)
	rank := func(id int64) int {
		if k, ok := order[id]; ok {
			return k
		}
		return math.MaxInt32
	}
	sort.Slice(ids, func(a, b int) bool {
		if ra, rb := rank(ids[a]), rank(ids[b]); ra != rb {
			return ra < rb
		}
		return ids[a] < ids[b]
	})
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
	/* Read each step's time and group. The time comes from the step's own line, or else from the template step it was
	   copied from. "The previous step" and step names are looked up among the template's steps only. A step inserted
	   during the run ("pocket:added", with no template step) has no time, and the timing ignores it. A repeated step
	   (added, with the line of the step it repeats) has no time of its own but joins that step's group. A step timed
	   from a group counts from whichever step in the group was done last. group[i] is the index in steps of step i's
	   template step, or -1. */
	// Keep each of these to one assignment per line, because Yaegi gets an index and an append in the same assignment wrong.
	steps, place, at := []stepTime{}, []int{}, -1
	group, lines := make([]int, len(ids)), make([]string, len(ids))
	for i, id := range ids {
		desc := tasks[id].Description
		title, ok := stepLineOf(desc)
		if t := fromOf[id]; !ok && t != nil {
			title, ok = t.Title, true
		}
		lines[i] = title
		group[i] = -1
		if !addedLineRe.MatchString(desc) {
			group[i] = len(steps)
			steps = append(steps, parseStepTime(title))
			place = append(place, i)
		} else if ok {
			for j := i - 1; j >= 0; j-- {
				if group[j] >= 0 && lines[j] == title {
					group[i] = group[j]
					break
				}
			}
		}
		if id == stepID {
			at = i
		}
	}
	if at < 0 || group[at] < 0 {
		return nil
	}
	// The time the group was last done. It stays zero if no step in the group is done any more.
	g := group[at]
	last := time.Time{}
	for i, id := range ids {
		if t := tasks[id]; group[i] == g && t.Done && t.DoneAt.After(last) {
			last = t.DoneAt
		}
	}

	wrote := false
	for k := g + 1; k < len(steps); k++ {
		st := steps[k]
		if !st.timed || stepFrom(steps, k) != g {
			continue
		}
		dep := tasks[ids[place[k]]]
		if dep.Done || dep.ProjectID != project {
			continue
		}
		due := time.Time{}
		if !last.IsZero() {
			due = last.Add(st.offset).Truncate(time.Second)
		}
		if dep.DueDate.Unix() == due.Unix() {
			continue
		}
		if _, err := s.ID(dep.ID).Cols("due_date").NoAutoTime().Update(&models.Task{DueDate: due}); err != nil {
			_ = s.Rollback()
			return err
		}
		// A reminder relative to the due date (Pocket gives timed steps one) moves with it, as it would if the date were
		// saved through Vikunja. When there is no due date, the reminder is cleared, which Vikunja never does on its own.
		reminders := []*models.TaskReminder{}
		if err := s.Where("task_id = ? AND relative_to = ?", dep.ID, "due_date").Find(&reminders); err != nil {
			_ = s.Rollback()
			return err
		}
		for _, r := range reminders {
			at := time.Time{}
			if !due.IsZero() {
				at = due.Add(time.Duration(r.RelativePeriod) * time.Second)
			}
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

// taskIn returns the task if it is in the project, or nil if it is not.
func taskIn(s *xorm.Session, id, project int64) (*models.Task, error) {
	t := &models.Task{}
	if has, err := s.ID(id).Get(t); err != nil || !has || t.ProjectID != project {
		return nil, err
	}
	return t, nil
}

// stepFrom returns the index of the step that timed step i counts from. That is the previous step, or the earlier step
// with the name it refers to. It returns -1 if there is none.
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

// relatedIDs returns the ids of the tasks related to a task by one kind of relation, in the order the relations were
// made.
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

// isTemplate reports whether a task has the label "template", which is how Pocket marks a template.
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

// Every factory returns this one instance, as Vikunja's example plugin does.
var singleton = &Pocket{}

func NewPlugin() plugins.Plugin { return singleton }

// Yaegi needs this factory typed as the router interface, or Vikunja doesn't see the routes.
func NewUnauthenticatedRouterPlugin() plugins.UnauthenticatedRouterPlugin { return singleton }
