/* ══════════════════════════════════════════════════════════════════
   maestro — the household alphabet, falling.
   Brass glyphs on charcoal. They part around the cursor the way staff
   part in a corridor: sideways, unhurried, back into line behind you.
   One column occasionally flashes teal. If you know, you know.

   No dependencies, no network, ~4KB. Pauses when the tab is hidden.
   ══════════════════════════════════════════════════════════════════ */
(function () {
  'use strict';

  var BRASS = '201,162,39';
  var TEAL  = '46,126,116';

  /* git glyphs, brackets, seat initials, and the estate itself */
  var GLYPHS = ('⎇✓⌁⎋[]{}<>/|·:;=+*#§' +
                'SERPCKMFHGX' +
                '荘').split('');
  var KANJI = '荘';

  var PART_RADIUS = 132;   /* css px — how close before he steps aside */
  var PART_PUSH   = 44;    /* css px — how far aside he steps */
  var LATERAL     = 0.42;  /* vertical share of the step; mostly sideways */

  var canvas = document.getElementById('rain');
  if (!canvas || !canvas.getContext) return;
  var ctx = canvas.getContext('2d', { alpha: false });

  var reduced = window.matchMedia
    ? window.matchMedia('(prefers-reduced-motion: reduce)')
    : { matches: false, addEventListener: null };

  var W = 0, H = 0, cell = 20, cols = [], raf = 0, last = 0;
  var flash = null, nextFlash = 0;

  /* eased cursor: position, and how much authority it currently has */
  var pt = { x: -9999, y: -9999, tx: -9999, ty: -9999, p: 0, tp: 0 };

  function rand(a, b) { return a + Math.random() * (b - a); }
  function glyph() { return GLYPHS[(Math.random() * GLYPHS.length) | 0]; }

  function size() {
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    W = window.innerWidth;
    H = window.innerHeight;
    canvas.width  = Math.floor(W * dpr);
    canvas.height = Math.floor(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    cell = W < 640 ? 16 : W < 1100 ? 18 : 20;
    ctx.font = cell + 'px ui-monospace, "DejaVu Sans Mono", "Liberation Mono", Menlo, Consolas, monospace';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
  }

  function build() {
    var n = Math.ceil(W / cell) + 1;
    var rows = Math.ceil(H / cell);
    cols = new Array(n);
    for (var i = 0; i < n; i++) {
      var len = Math.round(rand(9, 20));
      var buf = new Array(len);
      for (var j = 0; j < len; j++) buf[j] = glyph();
      cols[i] = {
        x: i * cell + cell / 2,
        row: rand(-rows, rows),          /* head position, in rows */
        speed: rand(1.6, 6.4),           /* rows per second */
        len: len,
        buf: buf,
        mark: -999                       /* last integer row, for shifting */
      };
    }
  }

  function paintBackdrop() {
    ctx.fillStyle = '#1A1714';
    ctx.fillRect(0, 0, W, H);
  }

  /* ── the still life, for those who asked not to be moved ──────── */
  function still() {
    paintBackdrop();
    var rows = Math.ceil(H / cell);
    var n = Math.ceil(W / cell);
    for (var i = 0; i < n; i++) {
      for (var j = 0; j < rows; j++) {
        if (Math.random() > 0.16) continue;
        ctx.fillStyle = 'rgba(' + BRASS + ',' + (0.03 + Math.random() * 0.07).toFixed(3) + ')';
        ctx.fillText(glyph(), i * cell + cell / 2, j * cell + cell / 2);
      }
    }
  }

  /* ── one frame ─────────────────────────────────────────────────── */
  function draw(dt, now) {
    paintBackdrop();

    /* the cursor's influence eases in and out; nothing snaps */
    pt.x += (pt.tx - pt.x) * Math.min(1, dt * 12);
    pt.y += (pt.ty - pt.y) * Math.min(1, dt * 12);
    pt.p += (pt.tp - pt.p) * Math.min(1, dt * 4.5);

    if (now > nextFlash) {
      flash = { col: (Math.random() * cols.length) | 0, t0: now, dur: 1.15 };
      nextFlash = now + rand(3.6, 8.2);
    }
    var fi = -1, fk = 0;
    if (flash) {
      var ft = (now - flash.t0) / flash.dur;
      if (ft >= 1) { flash = null; }
      else { fi = flash.col; fk = Math.sin(ft * Math.PI); }
    }

    var rows = H / cell;
    var pushing = pt.p > 0.004;
    var R2 = PART_RADIUS * PART_RADIUS;

    for (var i = 0; i < cols.length; i++) {
      var c = cols[i];
      c.row += c.speed * dt;

      var m = Math.floor(c.row);
      if (m !== c.mark) {
        if (c.mark !== -999) {
          var steps = Math.min(m - c.mark, c.len);
          for (var s = 0; s < steps; s++) { c.buf.pop(); c.buf.unshift(glyph()); }
        }
        c.mark = m;
      }
      if (c.row - c.len > rows + 2) {
        c.row = -rand(2, rows * 0.9);
        c.mark = -999;
        c.speed = rand(1.6, 6.4);
      }

      var lit = (i === fi);
      for (var j = 0; j < c.len; j++) {
        var y = (c.row - j) * cell;
        if (y < -cell || y > H + cell) continue;

        var a = j === 0 ? 0.85 : 0.34 * Math.pow(1 - j / c.len, 1.35);
        var x = c.x, dy = 0;

        if (pushing) {
          var ax = x - pt.x, ay = y - pt.y;
          var d2 = ax * ax + ay * ay;
          if (d2 < R2) {
            var d = Math.sqrt(d2) || 0.0001;
            var t = 1 - d / PART_RADIUS;
            var e = t * t * (3 - 2 * t);            /* smoothstep */
            var push = e * PART_PUSH * pt.p;
            x += (ax / d) * push;
            dy = (ay / d) * push * LATERAL;
            a *= 1 + e * 0.55;                       /* a small nod as he passes */
          }
        }

        if (lit) {
          ctx.fillStyle = 'rgba(' + TEAL + ',' + Math.min(0.95, a + fk * 0.55).toFixed(3) + ')';
          ctx.fillText(KANJI, x, y + dy);
        } else {
          ctx.fillStyle = 'rgba(' + BRASS + ',' + a.toFixed(3) + ')';
          ctx.fillText(c.buf[j], x, y + dy);
        }
      }
    }
  }

  function loop(ts) {
    raf = window.requestAnimationFrame(loop);
    var now = ts / 1000;
    var dt = last ? Math.min(now - last, 0.05) : 0.016;
    last = now;
    draw(dt, now);
  }

  function start() {
    if (raf || reduced.matches) return;
    last = 0;
    raf = window.requestAnimationFrame(loop);
  }
  function stop() {
    if (!raf) return;
    window.cancelAnimationFrame(raf);
    raf = 0;
  }

  function boot() {
    stop();
    size();
    build();
    if (reduced.matches) {
      still();
    } else {
      nextFlash = (window.performance ? performance.now() / 1000 : 0) + rand(2.5, 5);
      start();
    }
  }

  /* ── events ────────────────────────────────────────────────────── */

  var rt = 0;
  window.addEventListener('resize', function () {
    clearTimeout(rt);
    rt = setTimeout(boot, 180);
  }, { passive: true });

  document.addEventListener('visibilitychange', function () {
    if (document.hidden) stop(); else if (!reduced.matches) start();
  });

  /* mouse and pen only — touch devices get the rain, not the corridor */
  window.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    pt.tx = e.clientX; pt.ty = e.clientY; pt.tp = 1;
    if (pt.p === 0) { pt.x = e.clientX; pt.y = e.clientY; }
  }, { passive: true });

  window.addEventListener('pointerdown', function (e) {
    if (e.pointerType === 'touch') return;
    pt.tx = e.clientX; pt.ty = e.clientY; pt.tp = 1;
  }, { passive: true });

  document.documentElement.addEventListener('pointerleave', function () { pt.tp = 0; });
  window.addEventListener('pointerout', function (e) {
    if (!e.relatedTarget) pt.tp = 0;
  }, { passive: true });
  window.addEventListener('blur', function () { pt.tp = 0; });

  if (reduced.addEventListener) reduced.addEventListener('change', boot);

  boot();

  /* ── the house keeps its composure when the art is late ────────── */
  function hide(img) { img.classList.add('is-missing'); }
  function seat(img) {
    var frame = img.closest ? img.closest('.plate-frame') : img.parentNode;
    if (frame && frame.classList) frame.classList.add('has-art');
  }

  document.addEventListener('error', function (e) {
    var t = e.target;
    if (t && t.tagName === 'IMG') hide(t);
  }, true);

  /* images that resolved (or failed) before this script was parsed */
  Array.prototype.forEach.call(document.images, function (img) {
    if (img.complete) {
      if (img.naturalWidth === 0) hide(img); else seat(img);
    } else {
      img.addEventListener('error', function () { hide(img); });
      img.addEventListener('load', function () { seat(img); });
    }
  });

  /* ── copy the one-liner ────────────────────────────────────────── */
  document.addEventListener('click', function (e) {
    var btn = e.target.closest ? e.target.closest('.copy') : null;
    if (!btn) return;
    var src = document.querySelector(btn.getAttribute('data-copy'));
    if (!src) return;
    var text = src.textContent.trim();
    var done = function () {
      var was = btn.textContent;
      btn.textContent = 'Taken';
      btn.setAttribute('data-done', '1');
      setTimeout(function () {
        btn.textContent = was;
        btn.removeAttribute('data-done');
      }, 1600);
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(done, function () {});
    } else {
      var ta = document.createElement('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0';
      document.body.appendChild(ta);
      ta.select();
      try { document.execCommand('copy'); done(); } catch (err) { /* then read it aloud */ }
      document.body.removeChild(ta);
    }
  });
})();
