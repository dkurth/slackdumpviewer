package server

import (
	"bytes"
	"encoding/binary"
	"encoding/json"
	"fmt"
	"image"
	"image/color"
	"image/draw"
	"image/gif"
	"image/jpeg"
	"image/png"
	"mime"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
	"sync"

	xdraw "golang.org/x/image/draw"
	_ "golang.org/x/image/webp"

	"github.com/dkurth/slackdumpviewer/internal/archive"
)

// GET /files/{id}/{name...}[?download=1]
func (s *Server) handleFile(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	p, ok := s.a.UploadPath(id, r.PathValue("name"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	f, err := os.Open(p)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	st, err := f.Stat()
	if err != nil {
		http.NotFound(w, r)
		return
	}
	name := filepath.Base(p)
	ctype := mime.TypeByExtension(strings.ToLower(filepath.Ext(name)))
	if ctype == "" {
		ctype = "application/octet-stream"
	}
	// Don't let uploaded HTML/SVG run as a page on our origin.
	inlineSafe := strings.HasPrefix(ctype, "image/") && !strings.Contains(ctype, "svg") ||
		strings.HasPrefix(ctype, "video/") || strings.HasPrefix(ctype, "audio/") ||
		ctype == "application/pdf" || strings.HasPrefix(ctype, "text/plain")
	if strings.HasPrefix(ctype, "text/") || strings.Contains(ctype, "json") || strings.Contains(ctype, "xml") || strings.Contains(ctype, "javascript") {
		if r.URL.Query().Get("raw") == "1" {
			ctype, inlineSafe = "text/plain; charset=utf-8", true
		}
	}
	disp := "attachment"
	if inlineSafe && r.URL.Query().Get("download") != "1" {
		disp = "inline"
	}
	w.Header().Set("Content-Type", ctype)
	w.Header().Set("Content-Disposition", fmt.Sprintf("%s; filename*=UTF-8''%s", disp, url.PathEscape(name)))
	w.Header().Set("Content-Security-Policy", "sandbox; default-src 'none'; img-src 'self'; media-src 'self'; style-src 'unsafe-inline'")
	w.Header().Set("Cache-Control", "private, max-age=86400")
	http.ServeContent(w, r, "", st.ModTime(), f)
}

// ---- thumbnails ----

type thumbnailer struct {
	dir   string
	sem   chan struct{}
	mu    sync.Mutex
	locks map[string]*sync.Mutex
}

func newThumbnailer(dir string) *thumbnailer {
	return &thumbnailer{dir: dir, sem: make(chan struct{}, max(2, runtime.NumCPU())), locks: map[string]*sync.Mutex{}}
}

func (t *thumbnailer) lock(key string) func() {
	t.mu.Lock()
	l := t.locks[key]
	if l == nil {
		l = &sync.Mutex{}
		t.locks[key] = l
	}
	t.mu.Unlock()
	l.Lock()
	return l.Unlock
}

var thumbSizes = []int{64, 128, 256, 360, 480, 720, 960, 1440}

func snapSize(w int) int {
	for _, s := range thumbSizes {
		if w <= s {
			return s
		}
	}
	return thumbSizes[len(thumbSizes)-1]
}

// get returns the path to a cached thumbnail (generating it if needed), or
// "" if the source should be served as-is (small, animated or undecodable).
func (t *thumbnailer) get(key, src string, size int, square bool) (string, string, error) {
	unlock := t.lock(key)
	defer unlock()
	for _, ext := range []string{".jpg", ".png", ".orig"} {
		p := filepath.Join(t.dir, key+ext)
		if _, err := os.Stat(p); err == nil {
			if ext == ".orig" {
				return "", "", nil
			}
			return p, ext, nil
		}
	}
	t.sem <- struct{}{}
	defer func() { <-t.sem }()
	if err := os.MkdirAll(t.dir, 0o755); err != nil {
		return "", "", err
	}
	data, err := os.ReadFile(src)
	if err != nil {
		return "", "", err
	}
	marker := func() (string, string, error) {
		os.WriteFile(filepath.Join(t.dir, key+".orig"), nil, 0o644)
		return "", "", nil
	}
	cfg, format, err := image.DecodeConfig(bytes.NewReader(data))
	if err != nil {
		return marker()
	}
	if format == "gif" {
		if g, err := gif.DecodeAll(bytes.NewReader(data)); err == nil && len(g.Image) > 1 {
			return marker() // keep animation
		}
	}
	orient := 1
	if format == "jpeg" {
		orient = jpegOrientation(data)
	}
	longest := max(cfg.Width, cfg.Height)
	if !square && longest <= size && orient == 1 {
		return marker()
	}
	img, _, err := image.Decode(bytes.NewReader(data))
	if err != nil {
		return marker()
	}
	b := img.Bounds()
	var dst *image.RGBA
	if square {
		side := min(b.Dx(), b.Dy())
		x0 := b.Min.X + (b.Dx()-side)/2
		y0 := b.Min.Y + (b.Dy()-side)/2
		crop := image.Rect(x0, y0, x0+side, y0+side)
		n := min(size, side)
		dst = image.NewRGBA(image.Rect(0, 0, n, n))
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, crop, xdraw.Over, nil)
	} else {
		scale := float64(size) / float64(max(b.Dx(), b.Dy()))
		if scale > 1 {
			scale = 1
		}
		nw, nh := max(1, int(float64(b.Dx())*scale)), max(1, int(float64(b.Dy())*scale))
		dst = image.NewRGBA(image.Rect(0, 0, nw, nh))
		xdraw.CatmullRom.Scale(dst, dst.Bounds(), img, b, xdraw.Over, nil)
	}
	if o := applyOrientation(dst, orient); o != image.Image(dst) {
		dst = o.(*image.RGBA)
	}
	var buf bytes.Buffer
	ext := ".jpg"
	if format == "png" || format == "gif" || format == "webp" {
		if hasAlpha(dst) {
			ext = ".png"
		}
	}
	if ext == ".png" {
		err = (&png.Encoder{CompressionLevel: png.BestSpeed}).Encode(&buf, dst)
	} else {
		opaque := image.NewRGBA(dst.Bounds())
		draw.Draw(opaque, opaque.Bounds(), &image.Uniform{color.White}, image.Point{}, draw.Src)
		draw.Draw(opaque, opaque.Bounds(), dst, image.Point{}, draw.Over)
		err = jpeg.Encode(&buf, opaque, &jpeg.Options{Quality: 85})
	}
	if err != nil {
		return "", "", err
	}
	p := filepath.Join(t.dir, key+ext)
	tmp := p + ".tmp"
	if err := os.WriteFile(tmp, buf.Bytes(), 0o644); err != nil {
		return "", "", err
	}
	return p, ext, os.Rename(tmp, p)
}

func hasAlpha(img *image.RGBA) bool {
	for i := 3; i < len(img.Pix); i += 4 {
		if img.Pix[i] != 0xff {
			return true
		}
	}
	return false
}

func serveThumb(w http.ResponseWriter, r *http.Request, p, ext, fallback string) {
	w.Header().Set("Cache-Control", "private, max-age=604800")
	if p == "" {
		ctype := mime.TypeByExtension(strings.ToLower(filepath.Ext(fallback)))
		if !strings.HasPrefix(ctype, "image/") || strings.Contains(ctype, "svg") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", ctype)
		http.ServeFile(w, r, fallback)
		return
	}
	if ext == ".png" {
		w.Header().Set("Content-Type", "image/png")
	} else {
		w.Header().Set("Content-Type", "image/jpeg")
	}
	http.ServeFile(w, r, p)
}

// GET /thumbs/{id}?w=360
func (s *Server) handleThumb(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	src, ok := s.a.UploadPath(id, r.URL.Query().Get("name"))
	if !ok {
		http.NotFound(w, r)
		return
	}
	size := snapSize(qInt(r, "w", 720, 16, 4096))
	p, ext, err := s.thumbs.get(fmt.Sprintf("%s_%d", id, size), src, size, false)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	serveThumb(w, r, p, ext, src)
}

// GET /avatars/{userID}?s=72
func (s *Server) handleAvatar(w http.ResponseWriter, r *http.Request) {
	id := r.PathValue("id")
	if s.a.Avatars == "" || !archive.ValidFileID(id) {
		http.NotFound(w, r)
		return
	}
	dir := filepath.Join(s.a.Avatars, id)
	ents, err := os.ReadDir(dir)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	var src string
	for _, e := range ents {
		if e.Type().IsRegular() && !strings.HasPrefix(e.Name(), ".") {
			src = filepath.Join(dir, e.Name())
			if strings.Contains(e.Name(), "original") {
				break
			}
		}
	}
	if src == "" {
		http.NotFound(w, r)
		return
	}
	size := snapSize(qInt(r, "s", 72, 16, 1024))
	p, ext, err := s.thumbs.get(fmt.Sprintf("avatar_%s_%d", id, size), src, size, true)
	if err != nil {
		http.Error(w, err.Error(), 500)
		return
	}
	serveThumb(w, r, p, ext, src)
}

// ---- custom emoji ----

var emojiNameRe = regexp.MustCompile(`^[a-z0-9_+\-'.]+$`)

// loadCustomEmoji reads slackdump's emoji output: image files named
// <name>.<ext> and an optional JSON index (name -> url or "alias:other", or
// name -> {aliases: [...]}).
func loadCustomEmoji(dir string) map[string]string {
	out := map[string]string{}
	if dir == "" {
		return out
	}
	var jsons []string
	filepath.WalkDir(dir, func(p string, d os.DirEntry, err error) error {
		if err != nil || d.IsDir() {
			return nil
		}
		ext := strings.ToLower(filepath.Ext(p))
		name := strings.ToLower(strings.TrimSuffix(d.Name(), filepath.Ext(d.Name())))
		switch ext {
		case ".png", ".gif", ".jpg", ".jpeg", ".webp":
			if emojiNameRe.MatchString(name) {
				out[name] = p
			}
		case ".json":
			jsons = append(jsons, p)
		}
		return nil
	})
	// Also look for an index next to the emoji dir.
	parent := filepath.Dir(dir)
	for _, n := range []string{"emoji.json", "emojis.json", "index.json"} {
		if _, err := os.Stat(filepath.Join(parent, n)); err == nil {
			jsons = append(jsons, filepath.Join(parent, n))
		}
	}
	for _, j := range jsons {
		b, err := os.ReadFile(j)
		if err != nil {
			continue
		}
		var m map[string]json.RawMessage
		if json.Unmarshal(b, &m) != nil {
			continue
		}
		for name, v := range m {
			var sv string
			if json.Unmarshal(v, &sv) == nil {
				if strings.HasPrefix(sv, "alias:") {
					out[name] = sv
				}
				continue
			}
			var obj struct {
				Aliases []string `json:"aliases"`
			}
			if json.Unmarshal(v, &obj) == nil {
				for _, a := range obj.Aliases {
					if _, exists := out[a]; !exists {
						out[a] = "alias:" + name
					}
				}
			}
		}
	}
	return out
}

func (s *Server) handleEmoji(w http.ResponseWriter, r *http.Request) {
	name := r.PathValue("name")
	for i := 0; i < 3; i++ { // follow aliases
		v, ok := s.emoji[name]
		if !ok {
			http.NotFound(w, r)
			return
		}
		if strings.HasPrefix(v, "alias:") {
			name = strings.TrimPrefix(v, "alias:")
			continue
		}
		ctype := mime.TypeByExtension(strings.ToLower(filepath.Ext(v)))
		if !strings.HasPrefix(ctype, "image/") {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", ctype)
		w.Header().Set("Cache-Control", "private, max-age=604800")
		http.ServeFile(w, r, v)
		return
	}
	http.NotFound(w, r)
}

// ---- EXIF orientation ----

// jpegOrientation returns the EXIF orientation (1–8) of a JPEG, or 1.
func jpegOrientation(b []byte) int {
	if len(b) < 4 || b[0] != 0xFF || b[1] != 0xD8 {
		return 1
	}
	i := 2
	for i+4 <= len(b) {
		if b[i] != 0xFF {
			return 1
		}
		marker := b[i+1]
		size := int(binary.BigEndian.Uint16(b[i+2:]))
		if marker == 0xDA || size < 2 || i+2+size > len(b) {
			return 1
		}
		if marker == 0xE1 && size > 8 && string(b[i+4:i+10]) == "Exif\x00\x00" {
			return tiffOrientation(b[i+10 : i+2+size])
		}
		i += 2 + size
	}
	return 1
}

func tiffOrientation(t []byte) int {
	if len(t) < 8 {
		return 1
	}
	var bo binary.ByteOrder
	switch string(t[:2]) {
	case "II":
		bo = binary.LittleEndian
	case "MM":
		bo = binary.BigEndian
	default:
		return 1
	}
	off := int(bo.Uint32(t[4:]))
	if off+2 > len(t) {
		return 1
	}
	n := int(bo.Uint16(t[off:]))
	for k := 0; k < n; k++ {
		e := off + 2 + k*12
		if e+12 > len(t) {
			return 1
		}
		if bo.Uint16(t[e:]) == 0x0112 {
			v := int(bo.Uint16(t[e+8:]))
			if v >= 1 && v <= 8 {
				return v
			}
			return 1
		}
	}
	return 1
}

// applyOrientation rotates/flips img per EXIF orientation.
func applyOrientation(img image.Image, o int) image.Image {
	if o <= 1 || o > 8 {
		return img
	}
	b := img.Bounds()
	w, h := b.Dx(), b.Dy()
	var dst *image.RGBA
	if o >= 5 {
		dst = image.NewRGBA(image.Rect(0, 0, h, w))
	} else {
		dst = image.NewRGBA(image.Rect(0, 0, w, h))
	}
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			c := img.At(b.Min.X+x, b.Min.Y+y)
			var dx, dy int
			switch o {
			case 2:
				dx, dy = w-1-x, y
			case 3:
				dx, dy = w-1-x, h-1-y
			case 4:
				dx, dy = x, h-1-y
			case 5:
				dx, dy = y, x
			case 6:
				dx, dy = h-1-y, x
			case 7:
				dx, dy = h-1-y, w-1-x
			case 8:
				dx, dy = y, w-1-x
			}
			dst.Set(dx, dy, c)
		}
	}
	return dst
}
