// A relay that makes Vikunja's v2 writes safe to send twice, until Vikunja supports the Idempotency-Key header itself.
//
// Pocket sends a write to /api/v1/plugins/pocket/v2/<path> instead of /api/v2/<path>, with an Idempotency-Key header
// (the IETF httpapi draft). The relay forwards it to Vikunja's own /api/v2/<path> with the user's Authorization
// header, so Vikunja checks permissions, applies token scopes and sends events exactly as for a direct request. The
// relay stores the answer under (user, key). A request sent again with that key gets the stored answer, and Vikunja
// sees it once. When Vikunja supports the header, Pocket sends to /api/v2 again and this file is deleted.
//
// As the draft says:
//   - no key: 400;
//   - a key whose first request is still running: 409, with Retry-After;
//   - a key reused with a different method, path or body: 422;
//   - a key already answered: that answer again, with "Idempotent-Replayed: true".
//
// A key whose first request never finished (Vikunja stopped while it ran) also gets 409, with
// "Idempotency-Unknown: true", because the relay can't tell whether the change was made. So does a key older than the
// relay keeps answers, or from a clock more than a day fast. Every key starts with a UUIDv7, which holds the time it
// was made. A 5xx, a 408, a 429 or a failed forward isn't stored, so the request can be sent again. Vikunja rolls
// back a request that fails that way.

// Vikunja evaluates every .go file in this folder into one package, in name order, so main.go comes first. A second
// import of a package main.go imports fails to load ("redeclared in this block"). So this file imports only what
// main.go doesn't, and uses main.go's imports for the rest (net/http, strconv, strings, time, db, log, plugins,
// echo, viper, xorm). Vikunja asks main.go for NewPlugin, and this file for the routes and the table.
//go:build ignore

package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io"
	"net"

	"code.vikunja.io/api/pkg/user"

	"src.techknowlogick.com/xormigrate"
)

const (
	relayKeep    = 30 * 24 * time.Hour // how long an answer is kept for a retry
	relayAhead   = 24 * time.Hour      // how far ahead of the server's clock a phone's clock may be
	relayRunning = 2 * time.Minute     // a first request still pending after this never finished
	relayTimeout = 90 * time.Second    // how long a forwarded request may take
	relayMaxBody = 50 << 20            // attachments go through the relay too
)

type relay struct{}

func (r *relay) Name() string    { return "pocket-relay" }
func (r *relay) Version() string { return "0.0.0" }
func (r *relay) Init() error     { return nil }
func (r *relay) Shutdown() error { return nil }

// Plain SQL that SQLite, Postgres and MySQL all accept. A Go struct for xorm would be a type Yaegi defines at runtime,
// and xorm may not read those. MySQL's TEXT holds 64 KB, too little for a task with long notes, so it gets LONGTEXT.
// Postgres has no LONGTEXT, and its TEXT has no limit, as SQLite's has none.
func (r *relay) Migrations() []*xormigrate.Migration {
	return []*xormigrate.Migration{{
		ID:          "pocket-20261014-relay-keys",
		Description: "Pocket: remember the answer to each keyed write, so a retry isn't made twice.",
		Migrate: func(tx *xorm.Engine) error {
			text := "TEXT"
			if tx.DriverName() == "mysql" {
				text = "LONGTEXT"
			}
			_, err := tx.Exec("CREATE TABLE pocket_relay (user_id BIGINT NOT NULL, op_key VARCHAR(255) NOT NULL, fingerprint VARCHAR(64) NOT NULL, " +
				"state INT NOT NULL, code INT NOT NULL, content_type VARCHAR(255) NOT NULL, body " + text + " NOT NULL, created BIGINT NOT NULL, PRIMARY KEY (user_id, op_key))")
			return err
		},
		Rollback: func(tx *xorm.Engine) error {
			_, err := tx.Exec("DROP TABLE pocket_relay")
			return err
		},
	}}
}

func (r *relay) RegisterAuthenticatedRoutes(g *echo.Group) {
	g.POST("/pocket/v2/*", relayWrite)
	g.PUT("/pocket/v2/*", relayWrite)
	g.PATCH("/pocket/v2/*", relayWrite)
	g.DELETE("/pocket/v2/*", relayWrite)
}

const (
	statePending = 0
	stateDone    = 1
)

type relayRow struct {
	Fingerprint string
	State       int
	Code        int
	ContentType string
	Body        string
	Created     int64
}

func relayWrite(c *echo.Context) error {
	// The draft's value is a structured-field string, so it may come quoted.
	key := strings.Trim(strings.TrimSpace(c.Request().Header.Get("Idempotency-Key")), `"`)
	if len(key) < 16 || len(key) > 255 {
		return echo.NewHTTPError(http.StatusBadRequest, "send an Idempotency-Key header of 16 to 255 characters")
	}
	// A key older than the relay keeps answers may have been answered and forgotten, so running it could make the
	// change twice. A key from the future comes from a phone whose clock is wrong, and would outlive the answer.
	made, ok := relayKeyTime(key)
	if !ok {
		return echo.NewHTTPError(http.StatusBadRequest, "the Idempotency-Key must start with a UUIDv7")
	}
	if age := time.Since(made); age > relayKeep || age < -relayAhead {
		return relayUnknown(c, "this Idempotency-Key is older than the relay keeps answers, or from the future, so it isn't known whether it made the change")
	}
	u, err := user.GetCurrentUser(c)
	if err != nil {
		return err
	}
	body, err := io.ReadAll(io.LimitReader(c.Request().Body, relayMaxBody+1))
	if err != nil {
		return echo.NewHTTPError(http.StatusBadRequest, "the body couldn't be read")
	}
	if len(body) > relayMaxBody {
		return echo.NewHTTPError(http.StatusRequestEntityTooLarge, "the body is too large")
	}
	target := "/api/v2/" + c.Param("*")
	if q := c.Request().URL.RawQuery; q != "" {
		target += "?" + q
	}
	sum := sha256.Sum256(append([]byte(c.Request().Method+" "+target+"\n"), body...))
	fp := hex.EncodeToString(sum[:])

	// Claim the key. The primary key lets only one request do so. Any other gets the row the first one wrote.
	if claimed, err := relayClaim(u.ID, key, fp); err != nil {
		return err
	} else if !claimed {
		row, ok, err := relayGet(u.ID, key)
		if err != nil {
			return err
		}
		if !ok { // the first request failed in a way that can be retried, and released the key in the meantime
			return relayBusy(c, false)
		}
		if row.Fingerprint != fp {
			return echo.NewHTTPError(http.StatusUnprocessableEntity, "this Idempotency-Key was used for a different request")
		}
		if row.State == statePending {
			return relayBusy(c, time.Since(time.Unix(row.Created, 0)) > relayRunning)
		}
		c.Response().Header().Set("Idempotent-Replayed", "true")
		return relayAnswer(c, row.Code, row.ContentType, []byte(row.Body))
	}

	// The phone may hang up while this runs. The forward doesn't use the request's context, so it finishes and its
	// answer is stored for the retry.
	code, ct, out, err := relayForward(c.Request(), target, body)
	// A 5xx, or a 408 or 429 (Vikunja busy or rate-limited), says nothing was changed, and Pocket sends it again.
	if err != nil || code >= 500 || code == http.StatusRequestTimeout || code == http.StatusTooManyRequests {
		relayRelease(u.ID, key)
		if err != nil {
			log.Errorf("pocket: relay couldn't reach Vikunja: %s", err)
			return echo.NewHTTPError(http.StatusBadGateway, "the relay couldn't reach Vikunja")
		}
		return relayAnswer(c, code, ct, out)
	}
	if err := relayStore(u.ID, key, code, ct, out); err != nil {
		// The change was made, but a retry would make it again. Say so in the log. The answer still goes back.
		log.Errorf("pocket: relay made a change but couldn't store its answer for key %q: %s", key, err)
	}
	return relayAnswer(c, code, ct, out)
}

func relayBusy(c *echo.Context, unknown bool) error {
	if unknown {
		return relayUnknown(c, "the first request with this Idempotency-Key never finished, so it isn't known whether it made the change")
	}
	c.Response().Header().Set("Retry-After", "2")
	return echo.NewHTTPError(http.StatusConflict, "the first request with this Idempotency-Key is still running")
}

// relayUnknown tells the phone to stop sending and ask the user, because the relay can't say whether the change was
// made.
func relayUnknown(c *echo.Context, msg string) error {
	c.Response().Header().Set("Idempotency-Unknown", "true")
	return echo.NewHTTPError(http.StatusConflict, msg)
}

// relayKeyTime reads when a key was made from the UUIDv7 it starts with, whose first 48 bits are milliseconds since
// 1970. Pocket adds a request's stage and part after the UUID.
func relayKeyTime(key string) (time.Time, bool) {
	if len(key) < 36 || key[8] != '-' || key[13] != '-' || key[14] != '7' || key[18] != '-' || key[23] != '-' {
		return time.Time{}, false
	}
	ms, err := strconv.ParseInt(key[:8]+key[9:13], 16, 64)
	if err != nil {
		return time.Time{}, false
	}
	return time.UnixMilli(ms), true
}

func relayAnswer(c *echo.Context, code int, ct string, body []byte) error {
	if ct != "" {
		c.Response().Header().Set("Content-Type", ct)
	}
	c.Response().WriteHeader(code)
	_, err := c.Response().Write(body)
	return err
}

// relayForward sends the request to Vikunja itself, at the address it listens on, as the same user.
func relayForward(in *http.Request, target string, body []byte) (int, string, []byte, error) {
	ctx, cancel := context.WithTimeout(context.Background(), relayTimeout)
	defer cancel()
	base, transport := relayTarget()
	req, err := http.NewRequestWithContext(ctx, in.Method, base+target, bytes.NewReader(body))
	if err != nil {
		return 0, "", nil, err
	}
	for _, h := range []string{"Authorization", "Content-Type", "Accept", "Accept-Language", "User-Agent"} {
		if v := in.Header.Get(h); v != "" {
			req.Header.Set(h, v)
		}
	}
	res, err := (&http.Client{Transport: transport}).Do(req)
	if err != nil {
		return 0, "", nil, err
	}
	defer res.Body.Close()
	out, err := io.ReadAll(res.Body)
	if err != nil {
		return 0, "", nil, err
	}
	return res.StatusCode, res.Header.Get("Content-Type"), out, nil
}

// relayTarget is Vikunja's own address: its Unix socket if it listens on one, or else its TCP interface on this
// machine. The transport ignores HTTP_PROXY, which must not see a request to Vikunja itself.
func relayTarget() (string, *http.Transport) {
	t := &http.Transport{Proxy: nil}
	if sock := viper.GetString("service.unixsocket"); sock != "" {
		t.DialContext = func(ctx context.Context, _, _ string) (net.Conn, error) {
			return (&net.Dialer{}).DialContext(ctx, "unix", sock)
		}
		return "http://vikunja", t
	}
	host, port, err := net.SplitHostPort(viper.GetString("service.interface"))
	if err != nil || port == "" {
		port = "3456"
	}
	if host == "" || host == "0.0.0.0" || host == "::" {
		host = "127.0.0.1"
	}
	return "http://" + net.JoinHostPort(host, port), t
}

func relayClaim(userID int64, key, fp string) (bool, error) {
	s := db.NewSession()
	defer s.Close()
	now := time.Now()
	// Old answers go as new keys come in. The table stays small, so a scan is cheap.
	if _, err := s.Exec("DELETE FROM pocket_relay WHERE created < ?", now.Add(-relayKeep).Unix()); err != nil {
		_ = s.Rollback()
		return false, err
	}
	if err := s.Commit(); err != nil {
		return false, err
	}
	t := db.NewSession()
	defer t.Close()
	_, err := t.Exec("INSERT INTO pocket_relay (user_id, op_key, fingerprint, state, code, content_type, body, created) VALUES (?, ?, ?, ?, 0, '', '', ?)",
		userID, key, fp, statePending, now.Unix())
	if err == nil {
		err = t.Commit()
	}
	if err != nil {
		// Taken already, most likely. relayGet decides.
		_ = t.Rollback()
		return false, nil
	}
	return true, nil
}

func relayGet(userID int64, key string) (relayRow, bool, error) {
	s := db.NewSession()
	defer s.Close()
	rows, err := s.QueryString("SELECT fingerprint, state, code, content_type, body, created FROM pocket_relay WHERE user_id = ? AND op_key = ?", userID, key)
	if err != nil || len(rows) == 0 {
		return relayRow{}, false, err
	}
	r := rows[0]
	state, _ := strconv.Atoi(r["state"])
	code, _ := strconv.Atoi(r["code"])
	created, _ := strconv.ParseInt(r["created"], 10, 64)
	return relayRow{Fingerprint: r["fingerprint"], State: state, Code: code, ContentType: r["content_type"], Body: r["body"], Created: created}, true, nil
}

func relayStore(userID int64, key string, code int, ct string, body []byte) error {
	s := db.NewSession()
	defer s.Close()
	if _, err := s.Exec("UPDATE pocket_relay SET state = ?, code = ?, content_type = ?, body = ? WHERE user_id = ? AND op_key = ?",
		stateDone, code, ct, string(body), userID, key); err != nil {
		_ = s.Rollback()
		return err
	}
	return s.Commit()
}

func relayRelease(userID int64, key string) {
	s := db.NewSession()
	defer s.Close()
	if _, err := s.Exec("DELETE FROM pocket_relay WHERE user_id = ? AND op_key = ? AND state = ?", userID, key, statePending); err != nil {
		_ = s.Rollback()
		log.Errorf("pocket: relay couldn't release key %q: %s", key, err)
		return
	}
	_ = s.Commit()
}

var relayPlugin = &relay{}

func NewAuthenticatedRouterPlugin() plugins.AuthenticatedRouterPlugin { return relayPlugin }
func NewMigrationPlugin() plugins.MigrationPlugin                     { return relayPlugin }
