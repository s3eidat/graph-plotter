/* Graph Plotter — expressions are parsed by our own parser (no eval) and drawn on a canvas. */
(function () {
  "use strict";
  var $ = S3.$, $$ = S3.$$;
  var KEY = "gp.v1";

  // ---------- expression engine: tokenizer → recursive-descent parser → closures. No eval, no globals. ----------
  // Precedence (low → high): + −  |  × ÷ and implicit multiplication  |  unary −  |  ^ (right-assoc)  |  postfix ! %
  // so 2^3^2 = 512, −2^2 = −4, 2(3+4) = 14, 2x^2 = 2·(x²).
  var Expr = (function () {
    var FN = Object.create(null), CONST = Object.create(null);
    function def(name, arity, f, angle) { FN[name] = { arity: arity, f: f, angle: !!angle }; } // angle: f(…, mode)
    function snap(v) { return Math.abs(v) < 1e-15 ? 0 : v; }
    // Trig in degrees is exact at multiples of 90° (sin 180° = 0, cos 90° = 0, tan 90° undefined).
    function trig(name, x, mode) {
      var deg = mode === "deg" ? x : mode === "grad" ? x * 0.9 : null;
      if (deg !== null && isFinite(deg) && deg % 90 === 0) {
        var q = (((deg / 90) % 4) + 4) % 4, s = [0, 1, 0, -1][q], c = [1, 0, -1, 0][q];
        if (name === "sin") return s; if (name === "cos") return c;
        if (name === "tan") return c === 0 ? NaN : s / c; if (name === "cot") return s === 0 ? NaN : c / s;
        if (name === "sec") return c === 0 ? NaN : 1 / c; if (name === "csc") return s === 0 ? NaN : 1 / s;
      }
      var r = deg !== null ? deg * Math.PI / 180 : x;
      var v = name === "sin" ? Math.sin(r) : name === "cos" ? Math.cos(r) : name === "tan" ? Math.tan(r) :
        name === "sec" ? 1 / Math.cos(r) : name === "csc" ? 1 / Math.sin(r) : 1 / Math.tan(r);
      return snap(v);
    }
    function inv(v, mode) { return mode === "deg" ? v * 180 / Math.PI : mode === "grad" ? v * 200 / Math.PI : v; }
    ["sin", "cos", "tan", "sec", "csc", "cot"].forEach(function (n) { def(n, 1, function (x, m) { return trig(n, x, m); }, true); });
    def("asin", 1, function (x, m) { return inv(Math.asin(x), m); }, true); def("acos", 1, function (x, m) { return inv(Math.acos(x), m); }, true);
    def("atan", 1, function (x, m) { return inv(Math.atan(x), m); }, true);
    def("atan2", 2, function (y, x, m) { return inv(Math.atan2(y, x), m); }, true);
    def("sinh", 1, Math.sinh); def("cosh", 1, Math.cosh); def("tanh", 1, Math.tanh);
    def("asinh", 1, Math.asinh); def("acosh", 1, Math.acosh); def("atanh", 1, Math.atanh);
    def("sqrt", 1, Math.sqrt); def("cbrt", 1, Math.cbrt); def("abs", 1, Math.abs); def("exp", 1, Math.exp);
    def("ln", 1, Math.log); def("log10", 1, Math.log10); def("log2", 1, Math.log2);
    def("log", [1, 2], function (x, b) { return b === undefined ? Math.log10(x) : Math.log(x) / Math.log(b); });
    def("root", 2, function (x, n) { return x < 0 && Math.round(n) === n && n % 2 ? -Math.pow(-x, 1 / n) : Math.pow(x, 1 / n); });
    def("floor", 1, Math.floor); def("ceil", 1, Math.ceil); def("round", 1, Math.round); def("sign", 1, Math.sign);
    def("min", [1, 99], Math.min); def("max", [1, 99], Math.max);
    def("mod", 2, function (a, b) { return a - b * Math.floor(a / b); });
    def("nCr", 2, function (n, r) { return comb(n, r, false); }); def("nPr", 2, function (n, r) { return comb(n, r, true); });
    def("fact", 1, factorial); def("gamma", 1, gamma);
    CONST.pi = Math.PI; CONST["π"] = Math.PI; CONST.e = Math.E; CONST.tau = 2 * Math.PI; CONST.phi = (1 + Math.sqrt(5)) / 2;

    function comb(n, r, perm) {
      if (!(Number.isInteger(n) && Number.isInteger(r)) || n < 0 || r < 0 || r > n) return NaN;
      var v = 1;
      if (perm) { for (var i = 0; i < r; i++) v *= n - i; return v; }
      r = Math.min(r, n - r);
      for (i = 1; i <= r; i++) v = v * (n - r + i) / i;
      return Math.round(v);
    }
    function factorial(n) {
      if (Number.isInteger(n)) { if (n < 0) return NaN; if (n > 170) return Infinity; var v = 1; for (var i = 2; i <= n; i++) v *= i; return v; }
      return gamma(n + 1);
    }
    var LG = [0.99999999999980993, 676.5203681218851, -1259.1392167224028, 771.32342877765313, -176.61502916214059,
      12.507343278686905, -0.13857109526572012, 9.9843695780195716e-6, 1.5056327351493116e-7];
    function gamma(z) { // Lanczos
      if (Number.isInteger(z) && z <= 0) return NaN;
      if (z < 0.5) return Math.PI / (Math.sin(Math.PI * z) * gamma(1 - z));
      z -= 1;
      var x = LG[0], t = z + 7.5;
      for (var i = 1; i < 9; i++) x += LG[i] / (z + i);
      return Math.sqrt(2 * Math.PI) * Math.pow(t, z + 0.5) * Math.exp(-t) * x;
    }

    function Err(msg, pos) { var e = new Error(msg); e.pos = pos; e.expr = true; return e; }

    function tokenize(src) {
      var s = String(src).replace(/[−–]/g, "-").replace(/[×·∙]/g, "*").replace(/÷/g, "/").replace(/\*\*/g, "^")
        .replace(/²/g, "^2").replace(/³/g, "^3");
      var out = [], i = 0, m;
      while (i < s.length) {
        var c = s[i];
        if (/\s/.test(c)) { i++; continue; }
        if ((m = /^(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?/.exec(s.slice(i)))) { out.push({ t: "num", v: parseFloat(m[0]), p: i }); i += m[0].length; continue; }
        if ((m = /^[A-Za-zπθ][A-Za-z0-9πθ]*/.exec(s.slice(i)))) { out.push({ t: "id", v: m[0], p: i }); i += m[0].length; continue; }
        if ("+-*/^()!%,√".indexOf(c) >= 0) { out.push({ t: "op", v: c, p: i }); i++; continue; }
        throw Err("Unexpected character “" + c + "”", i);
      }
      return out;
    }

    // Split an unknown run like "ax" or "pix" into known names (a·x, π·x). Functions may only come last.
    function split(word, vars, beforeParen) {
      var memo = {};
      function go(i) {
        if (i === word.length) return [];
        if (i in memo) return memo[i];
        var best = null;
        for (var j = word.length; j > i; j--) {
          var part = word.slice(i, j);
          var isFn = part in FN && j === word.length && beforeParen, isVal = part in CONST || vars.has(part);
          if (!isFn && !isVal) continue;
          var rest = go(j);
          if (rest) { best = [part].concat(rest); break; }
        }
        return (memo[i] = best);
      }
      return go(0);
    }

    function parse(src, opts) {
      opts = opts || {};
      var vars = new Set(opts.vars || []), toks = tokenize(src), k = 0, used = new Set();
      // Expand identifiers into known names up front.
      var t2 = [];
      toks.forEach(function (t, idx) {
        if (t.t !== "id") return t2.push(t);
        var next = toks[idx + 1], paren = !!(next && next.t === "op" && next.v === "(");
        if ((t.v in FN && paren) || t.v in CONST || vars.has(t.v)) return t2.push(t);
        var parts = split(t.v, vars, paren);
        if (!parts) throw Err(t.v in FN ? t.v + " needs brackets, like " + t.v + "(x)" : "Unknown name “" + t.v + "”", t.p);
        parts.forEach(function (p) { t2.push({ t: "id", v: p, p: t.p }); });
      });
      toks = t2;
      function peek() { return toks[k]; }
      function isOp(v) { var t = toks[k]; return t && t.t === "op" && t.v === v; }
      function expect(v) { if (!isOp(v)) throw Err("Expected “" + v + "”", toks[k] ? toks[k].p : String(src).length); k++; }
      function startsPrimary(t) { return t && (t.t === "num" || t.t === "id" || (t.t === "op" && (t.v === "(" || t.v === "√"))); }

      function sum() {
        var n = product();
        while (isOp("+") || isOp("-")) { var op = toks[k++].v; n = { t: "bin", op: op, a: n, b: product() }; }
        return n;
      }
      function product() {
        var n = unary();
        for (;;) {
          if (isOp("*") || isOp("/")) { var op = toks[k++].v; n = { t: "bin", op: op, a: n, b: unary() }; }
          else if (startsPrimary(peek())) {
            if (peek().t === "num") throw Err("Missing operator before " + peek().v, peek().p); // "3 4" is a typo, not 12
            n = { t: "bin", op: "*", a: n, b: unary() }; // implicit: 2x, 2(3+4), (a)(b)
          }
          else return n;
        }
      }
      function unary() {
        if (isOp("-")) { k++; return { t: "neg", a: unary() }; }
        if (isOp("+")) { k++; return unary(); }
        if (isOp("√")) { k++; return { t: "call", f: "sqrt", args: [unary()] }; }
        return power();
      }
      function power() {
        var base = postfix();
        if (isOp("^")) { k++; return { t: "bin", op: "^", a: base, b: unary() }; } // right-assoc, allows 2^-1
        return base;
      }
      function postfix() {
        var n = primary();
        for (;;) {
          if (isOp("!")) { k++; n = { t: "call", f: "fact", args: [n] }; }
          else if (isOp("%") && opts.percent) { k++; n = { t: "bin", op: "/", a: n, b: { t: "num", v: 100 } }; }
          else return n;
        }
      }
      function primary() {
        var t = toks[k];
        if (!t) throw Err("Unexpected end", String(src).length);
        if (t.t === "num") { k++; return { t: "num", v: t.v }; }
        if (t.t === "op" && t.v === "(") { k++; var e = sum(); expect(")"); return e; }
        if (t.t === "id") {
          k++;
          if (t.v in FN && isOp("(")) {
            k++;
            var args = [];
            if (!isOp(")")) { args.push(sum()); while (isOp(",")) { k++; args.push(sum()); } }
            expect(")");
            var ar = FN[t.v].arity, lo = Array.isArray(ar) ? ar[0] : ar, hi = Array.isArray(ar) ? ar[1] : ar;
            if (args.length < lo || args.length > hi) throw Err(t.v + " takes " + (lo === hi ? lo : lo + "–" + hi) + " argument" + (hi === 1 ? "" : "s"), t.p);
            return { t: "call", f: t.v, args: args };
          }
          if (t.v in CONST) return { t: "num", v: CONST[t.v] };
          if (vars.has(t.v)) { used.add(t.v); return { t: "var", n: t.v }; }
          throw Err("Unknown name “" + t.v + "”", t.p);
        }
        throw Err("Unexpected “" + t.v + "”", t.p);
      }
      if (!toks.length) throw Err("Empty expression", 0);
      var ast = sum();
      if (k < toks.length) throw Err("Unexpected “" + toks[k].v + "”", toks[k].p);
      return { ast: ast, used: used };
    }

    // Closures over the AST: variables are read from a null-prototype map, never from globals.
    function compile(ast, opts) {
      var mode = (opts && opts.angle) || "rad";
      function c(n) {
        if (n.t === "num") { var v = n.v; return function () { return v; }; }
        if (n.t === "var") { var name = n.n; return function (env) { var x = env[name]; return typeof x === "number" ? x : NaN; }; }
        if (n.t === "neg") { var a = c(n.a); return function (env) { return -a(env); }; }
        if (n.t === "bin") {
          var l = c(n.a), r = c(n.b);
          switch (n.op) {
            case "+": return function (e) { return l(e) + r(e); };
            case "-": return function (e) { return l(e) - r(e); };
            case "*": return function (e) { return l(e) * r(e); };
            case "/": return function (e) { return l(e) / r(e); };
            case "^": return function (e) {
              var b = l(e), p = r(e);
              if (b < 0 && !Number.isInteger(p)) { var q = 1 / p; if (Number.isInteger(Math.round(q * 1e9) / 1e9) && Math.round(q) % 2) return -Math.pow(-b, p); } // (−8)^(1/3) = −2
              return Math.pow(b, p);
            };
          }
        }
        if (n.t === "call") {
          var fn = FN[n.f], args = n.args.map(c), m = mode;
          return function (e) { var vals = args.map(function (g) { return g(e); }); if (fn.angle) vals.push(m); return fn.f.apply(null, vals); };
        }
        throw Err("Bad expression", 0);
      }
      return c(ast);
    }

    function evaluate(src, env, opts) {
      opts = opts || {};
      var p = parse(src, { vars: Object.keys(env || {}), percent: opts.percent });
      var e = Object.create(null); for (var key in env) if (Object.prototype.hasOwnProperty.call(env, key)) e[key] = env[key];
      return compile(p.ast, opts)(e);
    }
    return { parse: parse, compile: compile, evaluate: evaluate, FN: FN, CONST: CONST, gamma: gamma, factorial: factorial };
  })();

  var COLORS = ["#0ea5a0", "#e07b00", "#7c5cff", "#e0457b", "#2f80ed", "#16a34a"];
  var VARS = ["x", "a", "b", "c"];
  var saved = S3.store(KEY) || {};
  var state = {
    fns: Array.isArray(saved.fns) && saved.fns.length ? saved.fns : [{ src: "x^2 - 2", on: true }, { src: "sin(x)", on: true }],
    p: Object.assign({ a: 1, b: 0, c: 0 }, saved.p || {}),
    angle: saved.angle === "deg" ? "deg" : "rad",
    view: saved.view && isFinite(saved.view.cx) ? saved.view : { cx: 0, cy: 0, scale: 50 },
    hover: null, pts: []
  };
  var compiled = [];

  // ---------- functions ----------
  function compileAll() {
    compiled = state.fns.map(function (f) {
      if (!f.src.trim()) return { fn: null, err: "" };
      try {
        var p = Expr.parse(f.src.replace(/^\s*(y|f\s*\(\s*x\s*\))\s*=/i, ""), { vars: VARS });
        var g = Expr.compile(p.ast, { angle: state.angle });
        return { fn: g, err: "", uses: p.used };
      } catch (e) { return { fn: null, err: e.expr ? e.message : "Can't read this" }; }
    });
  }
  function env(x) { var e = Object.create(null); e.x = x; e.a = state.p.a; e.b = state.p.b; e.c = state.p.c; return e; }
  function evalAt(i, x) { var c = compiled[i]; if (!c || !c.fn) return NaN; var y = c.fn(env(x)); return typeof y === "number" ? y : NaN; }

  // ---------- roots: sample, bracket sign changes, bisect; reject poles ----------
  function zeros(h, x0, x1, n) {
    var out = [], step = (x1 - x0) / n, prevX = x0, prevY = h(x0);
    var tol = Math.max(1e-12, (x1 - x0) * 1e-10);
    function push(x) { if (!out.length || Math.abs(out[out.length - 1] - x) > tol * 100) out.push(x); }
    if (prevY === 0) push(x0);
    for (var i = 1; i <= n; i++) {
      var x = x0 + step * i, y = h(x);
      if (y === 0) push(x);
      else if (isFinite(prevY) && isFinite(y) && prevY !== 0 && (prevY < 0) !== (y < 0)) {
        var lo = prevX, hi = x, flo = prevY;
        for (var k = 0; k < 80 && hi - lo > tol; k++) {
          var mid = (lo + hi) / 2, fm = h(mid);
          if (!isFinite(fm)) { lo = NaN; break; }
          if ((fm < 0) === (flo < 0)) { lo = mid; flo = fm; } else hi = mid;
        }
        var r = (lo + hi) / 2, fr = h(r);
        // A sign change across a pole (tan x, 1/x) leaves |f| large: not a root.
        if (isFinite(r) && isFinite(fr) && Math.abs(fr) < 1e-6 * Math.max(1, Math.abs(prevY), Math.abs(y))) push(r);
      }
      prevX = x; prevY = y;
    }
    return out;
  }
  function clean(v) { var r = Math.round(v); return Math.abs(v - r) < 1e-9 ? r : v; }
  function findPoints() {
    var b = bounds(), pts = [];
    compiled.forEach(function (c, i) {
      if (!c.fn || !state.fns[i].on) return;
      zeros(function (x) { return evalAt(i, x); }, b.x0, b.x1, 1600).forEach(function (x) { pts.push({ kind: "root", i: i, x: clean(x), y: 0 }); });
      for (var j = i + 1; j < compiled.length; j++) {
        if (!compiled[j].fn || !state.fns[j].on) continue;
        (function (j) {
          zeros(function (x) { return evalAt(i, x) - evalAt(j, x); }, b.x0, b.x1, 1600).forEach(function (x) {
            var y = evalAt(i, x); if (isFinite(y)) pts.push({ kind: "cross", i: i, j: j, x: clean(x), y: clean(y) });
          });
        })(j);
      }
    });
    state.pts = pts.slice(0, 60);
  }

  // ---------- view ----------
  var cv = $("#cv"), W = 0, H = 0, dpr = 1;
  function bounds() { return { x0: state.view.cx - W / 2 / state.view.scale, x1: state.view.cx + W / 2 / state.view.scale, y0: state.view.cy - H / 2 / state.view.scale, y1: state.view.cy + H / 2 / state.view.scale }; }
  function px(x) { return W / 2 + (x - state.view.cx) * state.view.scale; }
  function py(y) { return H / 2 - (y - state.view.cy) * state.view.scale; }
  function ux(p) { return state.view.cx + (p - W / 2) / state.view.scale; }
  function uy(p) { return state.view.cy - (p - H / 2) / state.view.scale; }
  function niceStep(raw) { var p = Math.pow(10, Math.floor(Math.log10(raw))), f = raw / p; return (f < 1.5 ? 1 : f < 3.5 ? 2 : f < 7.5 ? 5 : 10) * p; }
  function label(v, step) {
    if (Math.abs(v) < step / 1e6) return "0";
    var d = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
    if (Math.abs(v) >= 1e6 || (Math.abs(v) < 1e-4)) return v.toExponential(1).replace("e+", "e");
    return v.toFixed(d).replace("-", "−");
  }
  function css(n) { return getComputedStyle(document.documentElement).getPropertyValue(n).trim(); }
  function fmt(v) { if (!isFinite(v)) return "undefined"; var s = +v.toPrecision(10); return String(s).replace("-", "−"); }

  function draw(target, scale) {
    var c = target || cv, g = c.getContext("2d"), k = scale || dpr;
    g.setTransform(k, 0, 0, k, 0, 0);
    var bg = css("--surface"), line = css("--line"), lineStrong = css("--line-strong"), t3 = css("--text-3"), t2 = css("--text-2");
    g.fillStyle = bg; g.fillRect(0, 0, W, H);
    var b = bounds(), step = niceStep(80 / state.view.scale), minor = step / 5;
    var font = getComputedStyle(document.body).fontFamily;
    // grid
    g.lineWidth = 1;
    g.strokeStyle = line; g.globalAlpha = 0.55; g.beginPath();
    for (var x = Math.ceil(b.x0 / minor) * minor; x <= b.x1; x += minor) { var X = Math.round(px(x)) + .5; g.moveTo(X, 0); g.lineTo(X, H); }
    for (var y = Math.ceil(b.y0 / minor) * minor; y <= b.y1; y += minor) { var Y = Math.round(py(y)) + .5; g.moveTo(0, Y); g.lineTo(W, Y); }
    g.stroke(); g.globalAlpha = 1;
    g.strokeStyle = lineStrong; g.beginPath();
    for (x = Math.ceil(b.x0 / step) * step; x <= b.x1; x += step) { X = Math.round(px(x)) + .5; g.moveTo(X, 0); g.lineTo(X, H); }
    for (y = Math.ceil(b.y0 / step) * step; y <= b.y1; y += step) { Y = Math.round(py(y)) + .5; g.moveTo(0, Y); g.lineTo(W, Y); }
    g.stroke();
    // axes
    var ax = Math.min(Math.max(px(0), 0), W), ay = Math.min(Math.max(py(0), 0), H);
    g.strokeStyle = t2; g.lineWidth = 1.5; g.beginPath();
    if (px(0) >= 0 && px(0) <= W) { g.moveTo(Math.round(ax) + .5, 0); g.lineTo(Math.round(ax) + .5, H); }
    if (py(0) >= 0 && py(0) <= H) { g.moveTo(0, Math.round(ay) + .5); g.lineTo(W, Math.round(ay) + .5); }
    g.stroke();
    // labels (stick to the edge when an axis is off screen)
    g.font = "11px " + font; g.fillStyle = t3;
    var ly = Math.min(Math.max(ay + 4, 4), H - 16), lx = Math.min(Math.max(ax - 6, 30), W - 6);
    g.textAlign = "center"; g.textBaseline = "top";
    for (x = Math.ceil(b.x0 / step) * step; x <= b.x1; x += step) { if (Math.abs(x) < step / 2) continue; g.fillText(label(x, step), px(x), ly); }
    g.textAlign = "right"; g.textBaseline = "middle";
    for (y = Math.ceil(b.y0 / step) * step; y <= b.y1; y += step) { if (Math.abs(y) < step / 2) continue; g.fillText(label(y, step), lx, py(y)); }
    if (px(0) >= 0 && px(0) <= W && py(0) >= 0 && py(0) <= H) { g.textAlign = "right"; g.textBaseline = "top"; g.fillText("0", ax - 5, ay + 4); }
    // curves
    g.lineWidth = 2.25; g.lineJoin = "round"; g.lineCap = "round";
    compiled.forEach(function (cf, i) {
      if (!cf.fn || !state.fns[i].on) return;
      g.strokeStyle = COLORS[i % COLORS.length]; g.beginPath();
      var pen = false, prev = null, n = Math.ceil(W * 2);
      for (var s = 0; s <= n; s++) {
        var sx = s / 2, yv = evalAt(i, ux(sx)), sy = py(yv);
        if (!isFinite(sy)) { pen = false; prev = null; continue; }
        // Break the line at a jump through the screen (asymptote): both ends far off-screen, opposite sides.
        if (prev !== null && Math.abs(sy - prev) > H * 1.5 && ((sy < -H) !== (prev < -H) || (sy > 2 * H) !== (prev > 2 * H))) pen = false;
        var cy = Math.max(-H * 4, Math.min(H * 5, sy));
        if (pen) g.lineTo(sx, cy); else { g.moveTo(sx, cy); pen = true; }
        prev = sy;
      }
      g.stroke();
    });
    // root / intersection markers
    state.pts.forEach(function (p) {
      g.fillStyle = bg; g.strokeStyle = COLORS[p.i % COLORS.length]; g.lineWidth = 2;
      g.beginPath(); g.arc(px(p.x), py(p.y), 4.5, 0, Math.PI * 2); g.fill(); g.stroke();
    });
    // trace
    if (state.hover && !target) {
      var hx = state.hover.x, xv = ux(hx), rows = [];
      g.strokeStyle = t3; g.setLineDash([4, 4]); g.lineWidth = 1; g.beginPath(); g.moveTo(hx + .5, 0); g.lineTo(hx + .5, H); g.stroke(); g.setLineDash([]);
      compiled.forEach(function (cf, i) {
        if (!cf.fn || !state.fns[i].on) return;
        var yv = evalAt(i, xv);
        rows.push({ i: i, y: yv });
        if (isFinite(yv) && py(yv) > -10 && py(yv) < H + 10) {
          g.fillStyle = COLORS[i % COLORS.length]; g.beginPath(); g.arc(hx, py(yv), 4.5, 0, Math.PI * 2); g.fill();
        }
      });
      var lines = ["x = " + fmt(+xv.toPrecision(6))].concat(rows.map(function (r) { return "f" + (r.i + 1) + " = " + fmt(r.y); }));
      g.font = "12px " + font;
      var tw = Math.max.apply(null, lines.map(function (l) { return g.measureText(l).width; })) + 20, th = lines.length * 18 + 10;
      var bx = hx + 12 + tw > W ? hx - 12 - tw : hx + 12, by = 10;
      g.fillStyle = css("--surface-3"); g.globalAlpha = 0.94; roundRect(g, bx, by, tw, th, 8); g.fill(); g.globalAlpha = 1;
      g.textAlign = "left"; g.textBaseline = "middle";
      lines.forEach(function (l, k) {
        g.fillStyle = k === 0 ? t2 : COLORS[rows[k - 1].i % COLORS.length];
        g.fillText(l, bx + 10, by + 14 + k * 18);
      });
    }
  }
  function roundRect(g, x, y, w, h, r) { g.beginPath(); g.moveTo(x + r, y); g.arcTo(x + w, y, x + w, y + h, r); g.arcTo(x + w, y + h, x, y + h, r); g.arcTo(x, y + h, x, y, r); g.arcTo(x, y, x + w, y, r); g.closePath(); }

  function resize() {
    var r = cv.getBoundingClientRect(); dpr = window.devicePixelRatio || 1;
    W = Math.max(10, r.width); H = Math.max(10, r.height);
    cv.width = Math.round(W * dpr); cv.height = Math.round(H * dpr);
    refresh(true);
  }

  // ---------- UI ----------
  function renderPoints() {
    var box = $("#points"); box.textContent = "";
    if (!state.pts.length) { box.appendChild(S3.h("div", { "class": "empty" }, [S3.h("b", { text: "None in view" }), "Roots and crossings of the visible functions appear here. Pan or zoom out to find more."])); return; }
    var ul = S3.h("ul", { "class": "gp-list" });
    state.pts.forEach(function (p) {
      var who = p.kind === "root" ? "f" + (p.i + 1) + " = 0" : "f" + (p.i + 1) + " = f" + (p.j + 1);
      ul.appendChild(S3.h("li", {}, [S3.h("i", { style: "background:" + COLORS[p.i % COLORS.length] }), S3.h("span", { "class": "faint", text: who }),
        S3.h("b", { "class": "mono", text: "(" + fmt(p.x) + ", " + fmt(p.y) + ")" })]));
    });
    box.appendChild(ul);
  }
  function renderRange() { var b = bounds(); $("#range").textContent = "x " + fmt(+b.x0.toPrecision(3)) + " … " + fmt(+b.x1.toPrecision(3)) + "   y " + fmt(+b.y0.toPrecision(3)) + " … " + fmt(+b.y1.toPrecision(3)); }
  var savePts = S3.debounce(function () { findPoints(); renderPoints(); draw(); }, 180);
  function refresh(full) {
    if (full) { findPoints(); renderPoints(); } else savePts();
    draw(); renderRange(); persist();
  }
  var persist = S3.debounce(function () { S3.store(KEY, { fns: state.fns, p: state.p, angle: state.angle, view: state.view }); }, 400);

  function fnRow(f, i) {
    var inp = S3.h("input", { "class": "input mono", value: f.src, spellcheck: "false", autocomplete: "off", "aria-label": "Function " + (i + 1), dir: "ltr" });
    var vis = S3.h("button", { "class": "gp-sw", type: "button", style: "--c:" + COLORS[i % COLORS.length], "aria-pressed": String(f.on), title: "Show or hide", "aria-label": "Show function " + (i + 1) });
    var del = S3.h("button", { "class": "btn ghost icon small", type: "button", "aria-label": "Remove function " + (i + 1), html: S3.icon("x") });
    var err = S3.h("div", { "class": "gp-err", role: "status" });
    var row = S3.h("div", { "class": "gp-fn" }, [vis, S3.h("span", { "class": "gp-lab mono", text: "f" + (i + 1) + "(x) =" }), inp, del, err]);
    inp.value = f.src;
    inp.addEventListener("input", function () { f.src = inp.value; compileAll(); showErrs(); refresh(true); });
    vis.addEventListener("click", function () { f.on = !f.on; vis.setAttribute("aria-pressed", String(f.on)); refresh(true); });
    del.addEventListener("click", function () { state.fns.splice(state.fns.indexOf(f), 1); renderFns(); });
    return row;
  }
  function showErrs() { $$(".gp-fn").forEach(function (row, i) { var e = compiled[i] && compiled[i].err; row.lastChild.textContent = e || ""; row.classList.toggle("is-bad", !!e); }); }
  function renderFns() {
    var box = $("#fns"); box.textContent = "";
    state.fns.forEach(function (f, i) { box.appendChild(fnRow(f, i)); });
    $("#addFn").disabled = state.fns.length >= 6;
    compileAll(); showErrs(); refresh(true);
  }
  function renderSliders() {
    var box = $("#sliders"); box.textContent = "";
    ["a", "b", "c"].forEach(function (k) {
      var val = S3.h("output", { "class": "mono", text: fmt(state.p[k]) });
      var r = S3.h("input", { type: "range", min: "-10", max: "10", step: "0.1", value: String(state.p[k]), "aria-label": "Parameter " + k });
      r.addEventListener("input", function () { state.p[k] = +r.value; val.textContent = fmt(state.p[k]); refresh(false); });
      box.appendChild(S3.h("label", { "class": "gp-slider" }, [S3.h("b", { "class": "mono", text: k }), r, val]));
    });
  }

  // pan / zoom / pinch / trace
  var ptrs = new Map(), drag = null, pinch = null;
  function zoomAt(f, sx, sy) {
    var x = ux(sx), y = uy(sy);
    state.view.scale = Math.max(1e-6, Math.min(1e7, state.view.scale * f));
    state.view.cx = x - (sx - W / 2) / state.view.scale; state.view.cy = y + (sy - H / 2) / state.view.scale;
  }
  function local(e) { var r = cv.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; }
  cv.addEventListener("pointerdown", function (e) {
    cv.setPointerCapture(e.pointerId); ptrs.set(e.pointerId, local(e));
    if (ptrs.size === 1) drag = { p: local(e), cx: state.view.cx, cy: state.view.cy };
    if (ptrs.size === 2) { var a = Array.from(ptrs.values()); pinch = { d: Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y), s: state.view.scale }; drag = null; }
  });
  cv.addEventListener("pointermove", function (e) {
    var p = local(e);
    if (ptrs.has(e.pointerId)) ptrs.set(e.pointerId, p);
    if (pinch && ptrs.size === 2) {
      var a = Array.from(ptrs.values()), d = Math.hypot(a[0].x - a[1].x, a[0].y - a[1].y);
      zoomAt(pinch.s * d / pinch.d / state.view.scale, (a[0].x + a[1].x) / 2, (a[0].y + a[1].y) / 2);
      state.hover = null; refresh(false); return;
    }
    if (drag) {
      state.view.cx = drag.cx - (p.x - drag.p.x) / state.view.scale; state.view.cy = drag.cy + (p.y - drag.p.y) / state.view.scale;
      state.hover = e.pointerType === "mouse" ? { x: p.x } : null; refresh(false); return;
    }
    state.hover = { x: p.x }; draw();
  });
  function up(e) { ptrs.delete(e.pointerId); if (ptrs.size < 2) pinch = null; if (!ptrs.size) drag = null; }
  cv.addEventListener("pointerup", up); cv.addEventListener("pointercancel", up);
  cv.addEventListener("pointerleave", function (e) { if (e.pointerType === "mouse" && !drag) { state.hover = null; draw(); } });
  cv.addEventListener("wheel", function (e) { e.preventDefault(); var p = local(e); zoomAt(Math.exp(-e.deltaY * 0.0015), p.x, p.y); refresh(false); }, { passive: false });
  cv.addEventListener("dblclick", function (e) { var p = local(e); zoomAt(2, p.x, p.y); refresh(true); });
  $("#zin").addEventListener("click", function () { zoomAt(1.5, W / 2, H / 2); refresh(true); });
  $("#zout").addEventListener("click", function () { zoomAt(1 / 1.5, W / 2, H / 2); refresh(true); });
  $("#home").addEventListener("click", function () { state.view = { cx: 0, cy: 0, scale: 50 }; refresh(true); });
  $("#addFn").addEventListener("click", function () { if (state.fns.length >= 6) return; state.fns.push({ src: "", on: true }); renderFns(); var ins = $$(".gp-fn input"); ins[ins.length - 1].focus(); });
  $$("#angle button").forEach(function (b) {
    b.setAttribute("aria-pressed", String(b.dataset.v === state.angle));
    b.addEventListener("click", function () { state.angle = b.dataset.v; $$("#angle button").forEach(function (x) { x.setAttribute("aria-pressed", String(x === b)); }); compileAll(); refresh(true); });
  });
  $("#png").addEventListener("click", function () {
    var k = Math.max(2, dpr), c = document.createElement("canvas"); c.width = Math.round(W * k); c.height = Math.round(H * k);
    var hv = state.hover; state.hover = null; draw(c, k); state.hover = hv;
    c.toBlob(function (blob) { S3.download(blob, "graph.png", "image/png"); S3.done(); }, "image/png");
  });
  $("#copyPts").addEventListener("click", function () {
    if (!state.pts.length) return S3.toast("No points in view", "error");
    S3.copy(state.pts.map(function (p) { return (p.kind === "root" ? "f" + (p.i + 1) + " = 0" : "f" + (p.i + 1) + " = f" + (p.j + 1)) + ": (" + p.x + ", " + p.y + ")"; }).join("\n")); S3.done();
  });
  if (window.ResizeObserver) new ResizeObserver(S3.debounce(resize, 50)).observe(cv);
  new MutationObserver(function () { draw(); }).observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });

  renderSliders(); renderFns(); resize();

  window.S3_DEMO = function () {
    state.fns = [{ src: "x^2 - 2", on: true }, { src: "2sin(x)", on: true }, { src: "a x^3 + b x + c", on: true }];
    state.p = { a: 0.1, b: -1, c: 1 }; state.angle = "rad"; state.view = { cx: 0, cy: 0.5, scale: 55 };
    renderSliders(); renderFns(); resize();
    state.hover = { x: px(1.2) }; draw();
  };

  // ---------- self-test ----------
  window.S3_SELFTEST = function () {
    var f = [];
    function near(a, b, eps) { return Math.abs(a - b) <= (eps || 1e-9); }
    function ev(s, envv, o) { return Expr.evaluate(s, envv || {}, o); }
    function throws(s) { try { Expr.parse(s, { vars: VARS }); return false; } catch (e) { return e.expr === true; } }
    function ok(n, c) { if (!c) f.push(n); }
    ok("2^3^2", ev("2^3^2") === 512);
    ok("-2^2", ev("-2^2") === -4);
    ok("2(3+4)", ev("2(3+4)") === 14);
    ok("sin(90) deg", ev("sin(90)", {}, { angle: "deg" }) === 1);
    ok("2x^2", ev("2x^2", { x: 3 }) === 18);
    ok("1/2x", ev("1/2x", { x: 4 }) === 2);
    ok("2^-1", ev("2^-1") === 0.5);
    ok("(-8)^(1/3)", near(ev("(-8)^(1/3)"), -2));
    ok("implicit names", ev("ax^2+bx+c", { a: 1, b: 2, c: 3, x: 2 }) === 11 && near(ev("2pi"), 2 * Math.PI));
    ok("functions", ev("sqrt(16)+abs(-3)+ln(e)+log(1000)+exp(0)+floor(2.7)+ceil(2.1)+round(2.5)+min(4,2)+max(1,9)") === 4 + 3 + 1 + 3 + 1 + 2 + 3 + 3 + 2 + 9);
    ok("hyperbolic/inverse", near(ev("sinh(0)+cosh(0)+tanh(0)"), 1) && near(ev("asin(1)"), Math.PI / 2) && near(ev("atan(1)", {}, { angle: "deg" }), 45));
    ["alert(1)", "constructor", "__proto__", "x.constructor", "window", "document", "this", "Function", "globalThis", "y", "x=1", "[1]", "'a'", "`a`", "sin x", "2 3"].forEach(function (s) { ok("rejects " + s, throws(s)); });
    // Roots of x^2 − 2 and an intersection.
    state.fns = [{ src: "x^2 - 2", on: true }, { src: "x", on: true }, { src: "tan(x)", on: true }];
    var ang = state.angle; state.angle = "rad";
    state.view = { cx: 0, cy: 0, scale: 50 }; W = 600; H = 400; compileAll(); findPoints(); state.angle = ang;
    var roots = state.pts.filter(function (p) { return p.kind === "root" && p.i === 0; }).map(function (p) { return p.x; });
    ok("roots x^2-2", roots.length === 2 && near(roots[0], -Math.SQRT2, 1e-8) && near(roots[1], Math.SQRT2, 1e-8));
    var cr = state.pts.filter(function (p) { return p.kind === "cross" && p.i === 0 && p.j === 1; });
    ok("x^2-2 = x at -1 and 2", cr.length === 2 && near(cr[0].x, -1, 1e-8) && near(cr[1].x, 2, 1e-8));
    var tr = state.pts.filter(function (p) { return p.kind === "root" && p.i === 2; }).map(function (p) { return p.x; });
    ok("tan roots, no poles", tr.length === 3 && near(tr[0], -Math.PI, 1e-8) && tr[1] === 0 && near(tr[2], Math.PI, 1e-8));
    state.fns = Array.isArray(saved.fns) && saved.fns.length ? saved.fns : [{ src: "x^2 - 2", on: true }, { src: "sin(x)", on: true }];
    state.view = saved.view && isFinite(saved.view.cx) ? saved.view : { cx: 0, cy: 0, scale: 50 };
    renderFns(); resize();
    return f.length ? f : true;
  };
})();
