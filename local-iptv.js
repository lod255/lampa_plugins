(function (root) {
    'use strict';
    var VERSION = '0.3.1';
    function absolute(value, base) {
        if (typeof value !== 'string' || !value.trim()) return '';
        try { var u = new URL(value, base); return /^https?:$/.test(u.protocol) ? u.href : ''; } catch (e) { return ''; }
    }
    function attributes(text) {
        var result = Object.create(null), m, re = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
        while ((m = re.exec(text))) result[m[1].toLowerCase()] = m[2] !== undefined ? m[2] : m[3] !== undefined ? m[3] : m[4];
        return result;
    }
    function commaOutsideQuotes(text) {
        var q = '', i, c;
        for (i = 0; i < text.length; i++) { c = text.charAt(i); if (q) { if (q === c) q = ''; } else if (c === '"' || c === "'") q = c; else if (c === ',') return i; }
        return -1;
    }
    function parsePlaylist(text, base) {
        text = String(text).replace(/^\uFEFF/, '').replace(/^\s+/, '');
        if (!/^#EXTM3U(?:\s|$)/i.test(text)) throw new Error('Ответ не является M3U');
        var lines = text.split(/\r?\n/), header = attributes(lines[0]), channels = [], info = null, group = '', seen = Object.create(null);
        for (var i = 1; i < lines.length; i++) {
            var line = lines[i].trim();
            if (/^#EXT-X-/i.test(line)) throw new Error('Указан HLS одного канала. Нужен общий M3U-плейлист');
            if (/^#EXTINF:/i.test(line)) {
                var at = commaOutsideQuotes(line);
                info = {name: at < 0 ? '' : line.slice(at + 1).trim(), attr: attributes(at < 0 ? line : line.slice(0, at)), http: {}};
                group = info.attr['group-title'] || '';
            } else if (/^#EXTGRP:/i.test(line)) group = line.slice(8).trim();
            else if (/^#EXTVLCOPT:/i.test(line) && info) {
                var option = line.slice(11).split('='), key = option.shift().toLowerCase();
                if (key === 'http-referrer' || key === 'http-user-agent') info.http[key] = option.join('=').replace(/^['"]|['"]$/g, '');
            } else if (line && line.charAt(0) !== '#') {
                var parts = line.split('|'), url = absolute(parts[0], base), a = info ? info.attr : {}, c;
                if (url && !seen[url]) {
                    seen[url] = true;
                    c = {url: url, name: info && (info.name || a['tvg-name']) || 'Канал ' + (channels.length + 1), group: group || 'Без группы'};
                    var logo = absolute(a['tvg-logo'], base);
                    if (logo) c.logo = logo;
                    if (a['tvg-id'] || a['tvg-name']) c.tvg = {id: a['tvg-id'] || '', name: a['tvg-name'] || ''};
                    var days = Number(a['catchup-days'] || a['tvg-rec'] || header['catchup-days'] || 0);
                    if (days > 0 && a['catchup-enable'] !== '0' && (a.catchup || header.catchup) !== 'disabled') c.catchup = {days: Math.min(days, 365), type: a.catchup || header.catchup || ((a['catchup-source'] || header['catchup-source']) ? 'default' : 'shift'), source: a['catchup-source'] || header['catchup-source'] || ''};
                    if (a['tvg-shift'] || header['tvg-shift']) c.shift = Number(a['tvg-shift'] || header['tvg-shift']) || 0;
                    var http = info ? info.http : {}, params = parts.slice(1).join('|').split('&');
                    params.forEach(function (p) { var pos = p.indexOf('='); if (pos < 0) return; var k = p.slice(0, pos).toLowerCase(), v = p.slice(pos + 1); try { v = decodeURIComponent(v); } catch (e) {} if (k === 'user-agent') http['http-user-agent'] = v; if (k === 'referer' || k === 'referrer') http['http-referrer'] = v; });
                    if (a['user-agent'] && !http['http-user-agent']) http['http-user-agent'] = a['user-agent'];
                    if (Object.keys(http).length) c.http = http;
                    channels.push(c);
                }
                info = null; group = '';
            }
        }
        if (!channels.length) throw new Error('В плейлисте нет HTTP(S)-каналов');
        var guides = (header['x-tvg-url'] || header['url-tvg'] || '').split(',').map(function (u) { return absolute(u.trim(), base); }).filter(Boolean);
        return {channels: channels, guides: guides};
    }
    function parse(text, base) { return parsePlaylist(text, base).channels; }
    function xmlText(text) {
        return String(text || '').replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1').replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos);/gi, function (all, code) {
            var entities = {amp: '&', lt: '<', gt: '>', quot: '"', apos: "'"};
            if (code.charAt(0) !== '#') return entities[code.toLowerCase()] || all;
            var n = code.charAt(1).toLowerCase() === 'x' ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
            if (n < 0 || n > 1114111) return '';
            return n <= 65535 ? String.fromCharCode(n) : String.fromCharCode(55296 + ((n - 65536) >> 10), 56320 + ((n - 65536) & 1023));
        });
    }
    function xmlDate(value) {
        var m = String(value || '').match(/^(\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?\s*(Z|[+-]\d{4})?$/);
        if (!m) return NaN;
        var offset = !m[7] || m[7] === 'Z' ? 0 : (Number(m[7].slice(1, 3)) * 60 + Number(m[7].slice(3))) * (m[7].charAt(0) === '-' ? -1 : 1);
        return Date.UTC(+m[1], +m[2] - 1, +m[3], +m[4], +m[5], +(m[6] || 0)) - offset * 60000;
    }
    function normalize(name) { return String(name || '').toLowerCase().replace(/ё/g, 'е').replace(/[\s._-]+/g, ' ').trim(); }
    function xmlField(body, tag) {
        var re = new RegExp('<' + tag + '(?:\\s[^>]*)?>([\\s\\S]*?)</' + tag + '\\s*>', 'gi'), m, first = '';
        while ((m = re.exec(body))) { if (!first) first = xmlText(m[1]); if (/lang\s*=\s*["']ru["']/i.test(m[0])) return xmlText(m[1]); }
        return first;
    }
    // Incremental XMLTV scanner: keeps only relevant channels and a bounded time window.
    function GuideParser(list, now) {
        var result = {programs: Object.create(null), names: Object.create(null), logos: Object.create(null)}, buffer = '', valid = false, ended = false, total = 0;
        var ids = Object.create(null), names = Object.create(null), aliases = Object.create(null), oldest = now - 86400000;
        list.forEach(function (c) { if (c.tvg && c.tvg.id) ids[c.tvg.id] = true; names[normalize(c.name)] = true; if (c.tvg && c.tvg.name) names[normalize(c.tvg.name)] = true; oldest = Math.min(oldest, now - ((c.catchup && c.catchup.days) || 1) * 86400000); });
        function element(tag, rawAttr, body) {
            var a = attributes(rawAttr), id = xmlText(a.id || a.channel), m;
            if (!id) return;
            if (tag === 'channel') {
                var found = [], re = /<display-name(?:\s[^>]*)?>([\s\S]*?)<\/display-name\s*>/gi;
                while ((m = re.exec(body))) found.push(normalize(xmlText(m[1])));
                if (ids[id] || found.some(function (n) { return names[n]; })) {
                    aliases[id] = true;
                    found.forEach(function (n) { result.names[n] = id; });
                    m = body.match(/<icon\b([^>]*)\/?\s*>/i);
                    if (m) result.logos[id] = xmlText(attributes(m[1]).src || '');
                }
            } else if (ids[id] || aliases[id]) {
                var start = xmlDate(a.start), stop = xmlDate(a.stop);
                if (!isFinite(start) || !isFinite(stop) || stop <= start || stop < oldest || start > now + 8 * 86400000) return;
                if (++total > 200000) throw new Error('Слишком много передач в EPG');
                (result.programs[id] || (result.programs[id] = [])).push({start: start, stop: stop, title: xmlField(body, 'title') || 'Без названия', desc: xmlField(body, 'desc')});
            }
        }
        this.push = function (text, final) {
            if (ended) return result;
            buffer += text;
            if (/<tv(?:\s|>)/i.test(buffer)) valid = true;
            if (/<!DOCTYPE[^>]*\[/i.test(buffer) || /<!ENTITY/i.test(buffer)) throw new Error('EPG с XML-сущностями не поддерживается');
            var re = /<(channel|programme)\b([^>]*)>([\s\S]*?)<\/\1\s*>/gi, m, consumed = 0;
            while ((m = re.exec(buffer))) { element(m[1].toLowerCase(), m[2], m[3]); consumed = re.lastIndex; }
            if (consumed) buffer = buffer.slice(consumed);
            if (buffer.length > 2 * 1024 * 1024) throw new Error('Некорректный или слишком большой элемент XMLTV');
            if (final) {
                if (!valid || !/<\/tv\s*>/i.test(buffer) || /<(channel|programme)\b/i.test(buffer)) throw new Error('Ответ не является полным XMLTV');
                Object.keys(result.programs).forEach(function (id) { result.programs[id].sort(function (a, b) { return a.start - b.start; }); });
                ended = true;
            }
            return result;
        };
    }
    function programsFor(guide, c) {
        var id = c.tvg && c.tvg.id;
        if (!id || !Array.isArray(guide.programs[id])) id = guide.names[normalize(c.tvg && c.tvg.name || c.name)];
        var list = typeof id === 'string' && Array.isArray(guide.programs[id]) ? guide.programs[id] : [], shift = (c.shift || 0) * 3600000;
        return shift ? list.map(function (p) { return {start: p.start + shift, stop: p.stop + shift, title: p.title, desc: p.desc}; }) : list;
    }
    function programPosition(list, now) {
        for (var i = 0; i < list.length; i++) if (list[i].stop > now) return i;
        return list.length;
    }
    function progress(program, now) { return Math.max(0, Math.min(100, (now - program.start) / (program.stop - program.start) * 100)); }
    function archiveURL(c, p, now) {
        var catchup = c.catchup;
        if (!catchup || p.start >= now || p.start < now - catchup.days * 86400000) return '';
        var type = catchup.type.toLowerCase(), source = catchup.source, url = c.url, start = Math.floor(p.start / 1000), end = Math.floor(Math.min(now, p.stop) / 1000), duration = Math.max(1, end - start);
        if (type === 'disabled') return '';
        if (type === 'append' && !source) return '';
        if (type === 'append') url = /^https?:\/\//i.test(source) ? source : url + source;
        else if (/^(shift|timeshift)$/.test(type)) url = (source || url) + ((source || url).indexOf('?') < 0 ? '?' : '&') + 'utc={utc}&lutc={lutc}';
        else if (/^(flussonic|flussonic-hls|flussonic-ts|fs)$/.test(type)) url = url.replace(/\/(video\d*|mono\d*)\.(m3u8|ts)(\?|$)/, '/$1-{utc}-{duration}.$2$3').replace(/\/(index|playlist)\.(m3u8|ts)(\?|$)/, '/archive-{utc}-{duration}.$2$3').replace(/\/mpegts(\?|$)/, '/timeshift_abs-{utc}.ts$1').replace(/\/live(\?|$)/, '/{utc}.ts$1');
        else if (type === 'xc') url = url.replace(/^(https?:\/\/[^/]+)(?:\/live)?(\/[^/]+\/[^/]+)\/([^/.?]+)(\.(?:m3u8|ts))?(\?.*)?$/, '$1/timeshift$2/{minutes}/{date}/$3$4$5');
        else if (type === 'default') url = source || url;
        else return '';
        function pad(n) { return ('0' + n).slice(-2); }
        var d = new Date(p.start), values = {utc: start, start: start, end: end, utcend: end, duration: duration, durationfs: p.stop > now ? 'now' : duration, offset: Math.floor(now / 1000) - start, now: Math.floor(now / 1000), lutc: Math.floor(now / 1000), timestamp: Math.floor(now / 1000), minutes: Math.max(1, Math.ceil(duration / 60)), date: d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ':' + pad(d.getHours()) + '-' + pad(d.getMinutes())};
        if (url.indexOf('{') < 0) return '';
        function formatTime(time, format, utc, offset) {
            var date = new Date(time + Number(offset || 0) * 1000), pre = utc ? 'getUTC' : 'get';
            var fields = {yyyy: date[pre + 'FullYear'](), MM: pad(date[pre + 'Month']() + 1), dd: pad(date[pre + 'Date']()), HH: pad(date[pre + 'Hours']()), mm: pad(date[pre + 'Minutes']()), ss: pad(date[pre + 'Seconds']()), UTF: Math.floor(time / 1000)};
            return format.replace(/yyyy|MM|dd|HH|mm|ss|UTF/g, function (key) { return fields[key]; });
        }
        url = url.replace(/\$\{\((b|e|n)(u)?([+-]\d+)?\)([^{}]+)\}/g, function (all, kind, utc, offset, format) {
            return encodeURIComponent(formatTime(kind === 'b' ? p.start : kind === 'e' ? p.stop : now, format, utc, offset));
        }).replace(/\$\{\(d\)([^{}]+)\}/g, function (all, format) {
            var fields = {M: Math.floor(duration / 60), S: duration, h: Math.floor(duration / 3600), m: pad(Math.floor(duration / 60) % 60), s: pad(duration % 60)};
            return format.replace(/[MShms]/g, function (key) { return fields[key]; });
        });
        values.Y = d.getFullYear(); values.m = pad(d.getMonth() + 1); values.d = pad(d.getDate()); values.H = pad(d.getHours()); values.M = pad(d.getMinutes()); values.S = pad(d.getSeconds());
        url = url.replace(/\$?\{([\w]+)(?::\d+)?\}/g, function (m, key) { return key in values ? values[key] : m; });
        if (/\{/.test(url)) return '';
        return absolute(url, c.url);
    }

    // Local gzip/UTF-8 decoder from the supplied reference plugin; no remote scripts.
  var UnpackStream = function () {
    var t = {},
        n = Uint8Array,
        i = Uint16Array,
        e = Uint32Array,
        r = new n(0),
        a = new n([0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 2, 2, 2, 2, 3, 3, 3, 3, 4, 4, 4, 4, 5, 5, 5, 5, 0, 0, 0, 0]),
        s = new n([0, 0, 0, 0, 1, 1, 2, 2, 3, 3, 4, 4, 5, 5, 6, 6, 7, 7, 8, 8, 9, 9, 10, 10, 11, 11, 12, 12, 13, 13, 0, 0]),
        o = new n([16, 17, 18, 0, 8, 7, 9, 6, 10, 5, 11, 4, 12, 3, 13, 2, 14, 1, 15]),
        h = function h(t, n) {
      for (var r = new i(31), a = 0; a < 31; ++a) {
        r[a] = n += 1 << t[a - 1];
      }

      for (var s = new e(r[30]), o = 1; o < 30; ++o) {
        for (var h = r[o]; h < r[o + 1]; ++h) {
          s[h] = h - r[o] << 5 | o;
        }
      }

      return [r, s];
    },
        f = h(a, 2),
        l = f[0],
        p = f[1];

    l[28] = 258, p[258] = 28;
    var v,
        u = h(s, 0)[0],
        d = new i(32768);

    for (v = 0; v < 32768; ++v) {
      var c = (43690 & v) >>> 1 | (21845 & v) << 1;
      c = (61680 & (c = (52428 & c) >>> 2 | (13107 & c) << 2)) >>> 4 | (3855 & c) << 4, d[v] = ((65280 & c) >>> 8 | (255 & c) << 8) >>> 1;
    }

    var g = function g(t, n, e) {
      for (var r = t.length, a = 0, s = new i(n); a < r; ++a) {
        t[a] && ++s[t[a] - 1];
      }

      var o,
          h = new i(n);

      for (a = 0; a < n; ++a) {
        h[a] = h[a - 1] + s[a - 1] << 1;
      }

      if (e) {
        o = new i(1 << n);
        var f = 15 - n;

        for (a = 0; a < r; ++a) {
          if (t[a]) for (var l = a << 4 | t[a], p = n - t[a], v = h[t[a] - 1]++ << p, u = v | (1 << p) - 1; v <= u; ++v) {
            o[d[v] >>> f] = l;
          }
        }
      } else for (o = new i(r), a = 0; a < r; ++a) {
        t[a] && (o[a] = d[h[t[a] - 1]++] >>> 15 - t[a]);
      }

      return o;
    },
        w = new n(288);

    for (v = 0; v < 144; ++v) {
      w[v] = 8;
    }

    for (v = 144; v < 256; ++v) {
      w[v] = 9;
    }

    for (v = 256; v < 280; ++v) {
      w[v] = 7;
    }

    for (v = 280; v < 288; ++v) {
      w[v] = 8;
    }

    var y = new n(32);

    for (v = 0; v < 32; ++v) {
      y[v] = 5;
    }

    var m = g(w, 9, 1),
        b = g(y, 5, 1),
        T = function T(t) {
      for (var n = t[0], i = 1; i < t.length; ++i) {
        t[i] > n && (n = t[i]);
      }

      return n;
    },
        E = function E(t, n, i) {
      var e = n / 8 | 0;
      return (t[e] | t[e + 1] << 8) >> (7 & n) & i;
    },
        k = function k(t, n) {
      var i = n / 8 | 0;
      return (t[i] | t[i + 1] << 8 | t[i + 2] << 16) >> (7 & n);
    },
        C = function C(t, r, a) {
      (null == r || r < 0) && (r = 0), (null == a || a > t.length) && (a = t.length);
      var s = new (2 === t.BYTES_PER_ELEMENT ? i : 4 === t.BYTES_PER_ELEMENT ? e : n)(a - r);
      return s.set(t.subarray(r, a)), s;
    };

    t.FlateErrorCode = {
      UnexpectedEOF: 0,
      InvalidBlockType: 1,
      InvalidLengthLiteral: 2,
      InvalidDistance: 3,
      StreamFinished: 4,
      NoStreamHandler: 5,
      InvalidHeader: 6,
      NoCallback: 7,
      InvalidUTF8: 8,
      ExtraFieldTooLong: 9,
      InvalidDate: 10,
      FilenameTooLong: 11,
      StreamFinishing: 12,
      InvalidZipData: 13,
      UnknownCompressionMethod: 14
    };

    var F = ["unexpected EOF", "invalid block type", "invalid length/literal", "invalid distance", "stream finished", "no stream handler", "invalid header", "no callback", "invalid UTF-8 data", "extra field too long", "date not in range 1980-2099", "filename too long", "stream finishing", "invalid zip data", "determined by unknown compression method"],
        S = function S(t, n, i) {
      var e = new Error(n || F[t]);
      if (e.code = t, !i) throw e;
      return e;
    },
        x = function () {
      function t(t) {
        this.s = {}, this.p = new n(0), this.ondata = t;
      }

      return t.prototype.e = function (t) {
        this.ondata || S(5), this.d && S(4);
        var i = this.p.length,
            e = new n(i + t.length);
        e.set(this.p), e.set(t, i), this.p = e;
      }, t.prototype.c = function (t) {
        this.d = this.s.i = t || !1;

        var i = this.s.b,
            e = function (t, i, e) {
          var r = t.length;
          if (!r || e && e.f && !e.l) return i || new n(0);
          var h = !i || e,
              f = !e || e.i;
          e || (e = {}), i || (i = new n(3 * r));

          var p = function p(t) {
            var e = i.length;

            if (t > e) {
              var r = new n(Math.max(2 * e, t));
              r.set(i), i = r;
            }
          },
              v = e.f || 0,
              d = e.p || 0,
              c = e.b || 0,
              w = e.l,
              y = e.d,
              F = e.m,
              x = e.n,
              I = 8 * r;

          do {
            if (!w) {
              v = E(t, d, 1);
              var U = E(t, d + 1, 3);

              if (d += 3, !U) {
                var D = 4 + ((d + 7) / 8 | 0),
                    L = t[D - 4] | t[D - 3] << 8,
                    z = D + L;

                if (z > r) {
                  f && S(0);
                  break;
                }

                h && p(c + L), i.set(t.subarray(D, z), c), e.b = c += L, e.p = d = 8 * z, e.f = v;
                continue;
              }

              if (1 === U) w = m, y = b, F = 9, x = 5;else if (2 === U) {
                var B = E(t, d, 31) + 257,
                    M = E(t, d + 10, 15) + 4,
                    N = B + E(t, d + 5, 31) + 1;
                d += 14;

                var _,
                    A = new n(N),
                    G = new n(19);

                for (_ = 0; _ < M; ++_) {
                  G[o[_]] = E(t, d + 3 * _, 7);
                }

                d += 3 * M;
                var H = T(G),
                    O = (1 << H) - 1,
                    P = g(G, H, 1);

                for (_ = 0; _ < N;) {
                  var R = P[E(t, d, O)];
                  d += 15 & R;
                  var Y = R >>> 4;
                  if (Y < 16) A[_++] = Y;else {
                    var Z = 0,
                        j = 0;

                    for (16 === Y ? (j = 3 + E(t, d, 3), d += 2, Z = A[_ - 1]) : 17 === Y ? (j = 3 + E(t, d, 7), d += 3) : 18 === Y && (j = 11 + E(t, d, 127), d += 7); j--;) {
                      A[_++] = Z;
                    }
                  }
                }

                var q = A.subarray(0, B),
                    J = A.subarray(B);
                F = T(q), x = T(J), w = g(q, F, 1), y = g(J, x, 1);
              } else S(1);

              if (d > I) {
                f && S(0);
                break;
              }
            }

            h && p(c + 131072);

            for (var K = (1 << F) - 1, Q = (1 << x) - 1, V = d;; V = d) {
              var W = w[k(t, d) & K],
                  X = W >>> 4;

              if ((d += 15 & W) > I) {
                f && S(0);
                break;
              }

              if (W || S(2), X < 256) i[c++] = X;else {
                if (256 === X) {
                  V = d, w = null;
                  break;
                }

                var $ = X - 254;

                if (X > 264) {
                  var tt = X - 257,
                      nt = a[tt];
                  $ = E(t, d, (1 << nt) - 1) + l[tt], d += nt;
                }

                var it = y[k(t, d) & Q],
                    et = it >>> 4;
                it || S(3), d += 15 & it;
                var rt = u[et];

                if (et > 3) {
                  var at = s[et];
                  rt += k(t, d) & (1 << at) - 1, d += at;
                }

                if (d > I) {
                  f && S(0);
                  break;
                }

                h && p(c + 131072);

                for (var st = c + $; c < st; c += 4) {
                  i[c] = i[c - rt], i[c + 1] = i[c + 1 - rt], i[c + 2] = i[c + 2 - rt], i[c + 3] = i[c + 3 - rt];
                }

                c = st;
              }
            }

            e.l = w, e.p = V, e.b = c, e.f = v, w && (v = 1, e.m = F, e.d = y, e.n = x);
          } while (!v);

          return c === i.length ? i : C(i, 0, c);
        }(this.p, this.o, this.s);

        this.ondata(C(e, i, this.s.b), this.d), this.o = C(e, this.s.b - 32768), this.s.b = this.o.length, this.p = C(this.p, this.s.p / 8 | 0), this.s.p &= 7;
      }, t.prototype.push = function (t, n) {
        this.e(t), this.c(n);
      }, t;
    }();

    t.Inflate = x;

    var I = function () {
      function t(t) {
        this.ondata = t;
      }

      return t.prototype.push = function (t, n) {
        this.ondata(t, n);
      }, t;
    }();

    t.TextBytes = I;

    var U = function () {
      function t(t) {
        this.v = 1, x.call(this, t);
      }

      return t.prototype.push = function (t, n) {
        if (x.prototype.e.call(this, t), this.v) {
          var i = this.p.length > 3 ? function (t) {
            31 === t[0] && 139 === t[1] && 8 === t[2] || S(6, "invalid gzip data");
            var n = t[3],
                i = 10;
            4 & n && (i += 2 + (t[10] | t[11] << 8));

            for (var e = (n >> 3 & 1) + (n >> 4 & 1); e > 0;) {
              e -= !t[i++];
            }

            return i + (2 & n);
          }(this.p) : 4;
          if (i >= this.p.length && !n) return;
          this.p = this.p.subarray(i), this.v = 0;
        }

        n && (this.p.length < 8 && S(6, "invalid gzip data"), this.p = this.p.subarray(0, -8)), x.prototype.c.call(this, n);
      }, t;
    }();

    t.Gunzip = U, t.Decompress = function () {
      function t(t) {
        this.G = U, this.I = x, this.T = I, this.ondata = t;
      }

      return t.prototype.push = function (t, i) {
        if (this.ondata || S(5), this.s) this.s.push(t, i);else {
          if (this.p && this.p.length) {
            var e = new n(this.p.length + t.length);
            e.set(this.p), e.set(t, this.p.length), this.p = e;
          } else this.p = t;

          if (this.p.length > 2) {
            var r = this,
                a = function a() {
              r.ondata.apply(r, arguments);
            };

            this.s = 31 === this.p[0] && 139 === this.p[1] && 8 === this.p[2] ? new this.G(a) : new this.T(a), this.s.push(this.p, i), this.p = null;
          }
        }
      }, t;
    }();
    var D = "undefined" != typeof TextDecoder && new TextDecoder(),
        L = 0;

    try {
      D.decode(r, {
        stream: !0
      }), L = 1;
    } catch (t) {}

    return t.DecodeUTF8 = function () {
      function t(t) {
        this.ondata = t, L ? this.t = new TextDecoder() : this.p = r;
      }

      return t.prototype.push = function (t, i) {
        if (this.ondata || S(5), i = !!i, this.t) return this.ondata(this.t.decode(t, {
          stream: !0
        }), i), void (i && (this.t.decode().length && S(8), this.t = null));
        this.p || S(4);
        var e = new n(this.p.length + t.length);
        e.set(this.p), e.set(t, this.p.length);

        var r = function (t) {
          for (var n = "", i = 0;;) {
            var e = t[i++],
                r = (e > 127) + (e > 223) + (e > 239);
            if (i + r > t.length) return [n, C(t, i - 1)];
            r ? 3 === r ? (e = ((15 & e) << 18 | (63 & t[i++]) << 12 | (63 & t[i++]) << 6 | 63 & t[i++]) - 65536, n += String.fromCharCode(55296 | e >> 10, 56320 | 1023 & e)) : n += 1 & r ? String.fromCharCode((31 & e) << 6 | 63 & t[i++]) : String.fromCharCode((15 & e) << 12 | (63 & t[i++]) << 6 | 63 & t[i++]) : n += String.fromCharCode(e);
          }
        }(e),
            a = r[0],
            s = r[1];

        i ? (s.length && S(8), this.p = null) : this.p = s, this.ondata(a, i);
      }, t;
    }(), t;
  }();

    var exported = {parse: parse, parsePlaylist: parsePlaylist, GuideParser: GuideParser, xmlDate: xmlDate, programsFor: programsFor, programPosition: programPosition, progress: progress, archiveURL: archiveURL, UnpackStream: UnpackStream};
    if (typeof module === 'object' && module.exports) { module.exports = exported; return; }
    if (root.LampaLocalIPTV) return;
    var L, ready = false, dead = false, channels = [], guides = [], guide = emptyGuide(), guideState = '', lastError = '', menu, style, screen = null;
    var prefix = 'local_iptv_', xhr = null, guideXHR = null, generation = 0, guideToken = 0, guideTimer = null, refreshTimer = null, playerCleanup = null, origin = 'menu';
    var dbPromise = null;
    function emptyGuide() { return {programs: Object.create(null), names: Object.create(null), logos: Object.create(null)}; }
    function stored(key, fallback) { return L.Storage.get(prefix + key, fallback); }
    function save(key, value) { L.Storage.set(prefix + key, value); }
    function safeSave(key, value) { try { save(key, value); } catch (e) { notify('Не удалось сохранить настройки: память устройства заполнена'); } }
    function escape(value) { return String(value).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
    function notify(text) { if (!dead) L.Noty.show(text); }
    function playlists() {
        var list = stored('playlists', []);
        if (!Array.isArray(list) || !list.length) {
            list = [{id: 'default', name: 'Мой плейлист', url: String(stored('url', 'http://192.168.1.2:8088/playlist.m3u') || ''), epg: '', update: 6}];
            safeSave('playlists', list);
        }
        return list;
    }
    function activePlaylist() { var list = playlists(), id = stored('active', 'default'); return list.filter(function (p) { return p.id === id; })[0] || list[0]; }
    function source() { return activePlaylist().url; }
    function updatePlaylist(p) { var list = playlists(); list = list.map(function (x) { return x.id === p.id ? p : x; }); safeSave('playlists', list); }
    function favourites() { var a = stored('favourites', []); return Array.isArray(a) ? a : []; }
    function favoriteKey(c) { return stored('favorite_key', 'url') === 'name' ? 'name:' + normalize(c.name) : c.url; }
    function isFavorite(c) { return favourites().indexOf(favoriteKey(c)) >= 0; }
    function toggleFavorite(c) { var values = favourites(), key = favoriteKey(c), at = values.indexOf(key); if (at >= 0) values.splice(at, 1); else values.push(key); safeSave('favourites', values); }
    function locked(c) { var a = stored('locked', []); return a.indexOf('url:' + c.url) >= 0 || a.indexOf('group:' + c.group) >= 0; }
    function lockKey(c) { var values = stored('locked', []); return values.indexOf('url:' + c.url) >= 0 || values.indexOf('group:' + c.group) < 0 ? 'url:' + c.url : 'group:' + c.group; }
    function authorize(c, action, back) { if (locked(c)) { if (L.ParentalControl && L.ParentalControl.enabled()) L.ParentalControl.query(action, back); else { notify('Для заблокированного канала настройте PIN в родительском контроле Lampa'); back(); } } else action(); }
    function toggleLock(key, back) {
        var values = stored('locked', []), at = values.indexOf(key);
        function apply() { if (at >= 0) values.splice(at, 1); else values.push(key); safeSave('locked', values); back(); }
        if (!L.ParentalControl || !L.ParentalControl.enabled()) { notify('Сначала включите родительский контроль и задайте PIN в Lampa'); return back(); }
        L.ParentalControl.query(apply, back);
    }
    function history() { var a = stored('history', []); return Array.isArray(a) ? a : []; }
    function remember(c) {
        safeSave('last_channel', c.url);
        var a = history().filter(function (x) { return x !== c.url; }); a.unshift(c.url); safeSave('history', a.slice(0, 30));
        var views = stored('views', {}); views[c.url] = (Number(views[c.url]) || 0) + 1;
        // Bound statistics to channels still present in this playlist.
        var bounded = {}; channels.forEach(function (item) { if (views[item.url]) bounded[item.url] = views[item.url]; }); safeSave('views', bounded);
    }
    function database() {
        if (dbPromise) return dbPromise;
        dbPromise = new Promise(function (resolve) {
            if (!root.indexedDB) return resolve(null);
            try {
                var request = root.indexedDB.open('lampa_local_iptv', 1), settled = false;
                var timeout = setTimeout(function () { settled = true; resolve(null); }, 3000);
                request.onupgradeneeded = function () { request.result.createObjectStore('cache'); };
                request.onerror = request.onblocked = function () { clearTimeout(timeout); settled = true; resolve(null); };
                request.onsuccess = function () { clearTimeout(timeout); if (settled || dead) { request.result.close(); resolve(null); } else resolve(request.result); };
            } catch (e) { resolve(null); }
        });
        return dbPromise;
    }
    function cache(key, value) {
        return database().then(function (db) { return new Promise(function (resolve) {
            if (!db || dead) return resolve(null);
            try {
                var writing = value !== undefined, tx = db.transaction('cache', writing ? 'readwrite' : 'readonly'), request = writing ? tx.objectStore('cache').put(value, key) : tx.objectStore('cache').get(key), result;
                request.onsuccess = function () { result = request.result; };
                tx.oncomplete = function () { resolve(result || null); };
                tx.onerror = tx.onabort = function () { resolve(null); };
            } catch (e) { resolve(null); }
        }); });
    }
    function select(title, items, callback, onBack) { if (!dead) L.Select.show({title: escape(title), items: items, onSelect: callback, onBack: onBack || home}); }
    function input(title, value, callback, onBack) {
        L.Input.edit({title: title, value: value || '', free: true, nosave: true}, callback);
        // Lampa's Input API returns to the previous controller on cancellation.
    }
    function stopGuide() { guideToken++; clearTimeout(guideTimer); guideTimer = null; if (guideXHR) { guideXHR.abort(); guideXHR = null; } }
    function cancel() { generation++; if (xhr) { xhr.abort(); xhr = null; } stopGuide(); }
    function home() { if (L.Select.hide) L.Select.hide(); if (L.Activity && L.Activity.mixState) L.Activity.mixState(); if (screen) { screen.refresh(); screen.start(); } else legacyHome(); }
    function load() {
        cancel();
        var token = generation, request = new XMLHttpRequest(), p = activePlaylist(), url = p.url;
        if (!absolute(url)) { notify('Укажите HTTP(S)-адрес плейлиста'); return editURL(); }
        xhr = request;
        select('Загрузка плейлиста…', [{title: 'Отменить'}], function () { cancel(); home(); }, function () { cancel(); home(); });
        function fail(message) { if (dead || token !== generation) return; xhr = null; lastError = message; notify(message + (channels.length ? ' · Оставлен предыдущий список' : '')); home(); }
        try { request.open('GET', url, true); } catch (e) { return fail('Не удалось открыть адрес плейлиста'); }
        request.timeout = 60000;
        request.onprogress = function (e) { if (e.loaded > 16 * 1024 * 1024) { request.abort(); fail('M3U превышает 16 МБ'); } };
        request.onload = function () {
            if (dead || token !== generation) return;
            if (request.status < 200 || request.status >= 300) return fail('Плейлист: HTTP ' + request.status);
            try { var parsed = parsePlaylist(request.responseText, request.responseURL || url); channels = parsed.channels; guides = parsed.guides; } catch (e) { return fail(e.message); }
            xhr = null; lastError = ''; guide = emptyGuide(); guideState = '';
            cache('playlist:' + p.id, {url: url, time: Date.now(), channels: channels, guides: guides});
            safeSave('updated_' + p.id, Date.now()); home(); loadGuide(false);
        };
        request.onerror = function () { fail('Нет доступа к плейлисту: проверьте сеть, CORS и HTTP/HTTPS'); };
        request.ontimeout = function () { fail('Сервер плейлиста не ответил за 60 секунд'); };
        try { request.send(); } catch (e) { fail('Не удалось отправить запрос плейлиста'); }
    }
    function restore() {
        var token = generation, p = activePlaylist();
        cache('playlist:' + p.id).then(function (saved) {
            if (dead || token !== generation || activePlaylist().id !== p.id || !screen) return;
            if (saved && saved.url === p.url && Array.isArray(saved.channels)) { channels = saved.channels; guides = saved.guides || []; home(); loadGuide(false); }
            if (!channels.length || p.update > 0 && (!saved || Date.now() - saved.time > p.update * 3600000)) load();
        });
    }
    function editURL() {
        input('HTTP(S)-адрес M3U', source(), function (value) {
            value = String(value || '').trim(); if (!value) return home();
            if (!absolute(value)) { notify('Нужен полный адрес http:// или https://'); return home(); }
            var p = activePlaylist(); p.url = value; updatePlaylist(p); safeSave('url', value); cancel(); channels = []; guide = emptyGuide(); guides = []; home(); load();
        });
    }
    function loadGuide(force) {
        stopGuide(); var p = activePlaylist(), url = p.epg || guides[0], token = guideToken, playlistToken = generation;
        var signature = channels.map(function (c) { return (c.tvg && c.tvg.id || '') + '|' + normalize(c.tvg && c.tvg.name || c.name); }).join('\n');
        if (!url || !channels.length) { guideState = 'Укажите адрес XMLTV в настройках плейлиста'; if (screen) screen.updateDetails(); return; }
        guideState = 'Загрузка телепрограммы…'; if (screen) screen.updateDetails();
        function current() { return !dead && token === guideToken && playlistToken === generation; }
        cache('guide:' + p.id).then(function (saved) {
            if (!current()) return;
            if (saved && saved.url === url && saved.signature === signature) {
                guide = saved.data; if (screen) screen.updateDetails();
                if (saved.time > Date.now() - 12 * 3600000 && !force) { guideState = ''; if (screen) screen.updateDetails(); return; }
            }
            var request = new XMLHttpRequest(); guideXHR = request;
            function fail(message) { if (!current()) return; guideXHR = null; guideState = message; if (screen) screen.updateDetails(); if (force) notify(message); }
            try { request.open('GET', url, true); request.responseType = 'arraybuffer'; } catch (e) { return fail('Не удалось открыть EPG'); }
            request.timeout = 90000;
            request.onprogress = function (e) { if (e.loaded > 32 * 1024 * 1024) { request.abort(); fail('Файл EPG превышает 32 МБ'); } };
            request.onerror = function () { fail('Нет доступа к EPG: проверьте CORS и HTTP/HTTPS'); };
            request.ontimeout = function () { fail('Истекло время загрузки EPG'); };
            request.onload = function () {
                if (!current()) return;
                if (request.status < 200 || request.status >= 300) return fail('EPG: HTTP ' + request.status);
                guideXHR = null;
                try {
                    var bytes = new Uint8Array(request.response), pos = 0, inflated = 0, parser = new GuideParser(channels, Date.now());
                    var decoder = new UnpackStream.DecodeUTF8(function (text, final) { inflated += text.length; if (inflated > 128 * 1024 * 1024) throw new Error('Распакованный EPG превышает 128 МБ'); parser.push(text, final); });
                    var unzip = bytes[0] === 31 && bytes[1] === 139 ? new UnpackStream.Decompress(function (chunk, final) { decoder.push(chunk, final); }) : decoder;
                    function next() {
                        guideTimer = null;
                        if (!current()) return;
                        try {
                            var end = Math.min(bytes.length, pos + 32768), final = end === bytes.length;
                            unzip.push(bytes.subarray(pos, end), final); pos = end;
                            if (!final) guideTimer = setTimeout(next, 0);
                            else { guide = parser.push('', true); guideState = ''; cache('guide:' + p.id, {url: url, time: Date.now(), signature: signature, data: guide}); if (screen) screen.updateDetails(); if (force) notify('Телепрограмма обновлена'); }
                        } catch (e) { fail(e.message || 'Не удалось разобрать XMLTV'); }
                    }
                    next();
                } catch (e) { fail('Не удалось прочитать EPG'); }
            };
            try { request.send(); } catch (e) { fail('Не удалось отправить запрос EPG'); }
        });
    }
    function playlistMenu() {
        var list = playlists(), p = activePlaylist();
        select('Плейлисты', list.map(function (item) { return {title: escape((item.id === p.id ? '✓ ' : '') + item.name), playlist: item}; }).concat([{title: '+ Добавить плейлист', add: true}, {title: 'Настроить текущий', settings: true}]), function (item) {
            if (item.settings) return playlistSettings();
            if (item.add) return input('Адрес нового M3U', '', function (value) {
                value = String(value || '').trim(); if (!value) return playlistMenu();
                if (!absolute(value)) { notify('Нужен HTTP(S)-адрес'); return playlistMenu(); }
                input('Название плейлиста', 'Плейлист ' + (list.length + 1), function (name) {
                    var next = {id: 'p' + Date.now() + Math.floor(Math.random() * 10000), name: String(name || 'Плейлист').slice(0, 100), url: value, epg: '', update: 6};
                    list.push(next); safeSave('playlists', list); switchPlaylist(next);
                });
            });
            switchPlaylist(item.playlist);
        });
    }
    function switchPlaylist(p) { cancel(); safeSave('active', p.id); safeSave('filter_' + p.id, 'all'); channels = []; guides = []; guide = emptyGuide(); guideState = ''; if (screen) screen.reset(); home(); restore(); }
    function playlistSettings() {
        var p = activePlaylist();
        select(p.name, [{title: 'Название', subtitle: escape(p.name), action: 'name'}, {title: 'Адрес M3U', action: 'url'}, {title: 'Адрес телепрограммы XMLTV / XML.GZ', subtitle: p.epg ? 'Задан вручную' : guides.length ? 'Из заголовка M3U' : 'Не задан', action: 'epg'},
            {title: 'Обновить телепрограмму', action: 'guide'}, {title: 'Обновление плейлиста', subtitle: p.update ? 'Каждые ' + p.update + ' ч' : 'Вручную', action: 'update'},
            {title: 'Сортировка каналов', subtitle: stored('sort', 'playlist') === 'name' ? 'По названию' : stored('sort', 'playlist') === 'views' ? 'По просмотрам' : 'Как в плейлисте', action: 'sort'},
            {title: 'Сохранять избранное', subtitle: stored('favorite_key', 'url') === 'name' ? 'По названию канала' : 'По URL', action: 'favorite'}, {title: 'Очистить историю', action: 'history'}, {title: 'Удалить плейлист', action: 'delete'}], function (item) {
            if (item.action === 'url') return editURL();
            if (item.action === 'guide') { home(); return loadGuide(true); }
            if (item.action === 'name') return input('Название', p.name, function (v) { if (String(v || '').trim()) { p.name = String(v).trim().slice(0, 100); updatePlaylist(p); } playlistSettings(); });
            if (item.action === 'epg') return input('HTTP(S)-адрес XMLTV (пусто — из M3U)', p.epg, function (v) { v = String(v || '').trim(); if (v && !absolute(v)) { notify('Нужен HTTP(S)-адрес'); return playlistSettings(); } p.epg = v; updatePlaylist(p); guide = emptyGuide(); home(); loadGuide(true); });
            if (item.action === 'update') return select('Обновлять плейлист', [0, 1, 6, 12, 24].map(function (n) { return {title: n ? 'Каждые ' + n + ' ч' : 'Вручную', value: n}; }), function (a) { p.update = a.value; updatePlaylist(p); playlistSettings(); }, playlistSettings);
            if (item.action === 'sort') return select('Сортировка', [{title: 'Как в плейлисте', value: 'playlist'}, {title: 'По названию', value: 'name'}, {title: 'По просмотрам', value: 'views'}], function (a) { safeSave('sort', a.value); home(); }, playlistSettings);
            if (item.action === 'favorite') return select('Избранное', [{title: 'По URL', value: 'url'}, {title: 'По названию (при смене URL)', value: 'name'}], function (a) {
                var old = favourites(), converted = channels.filter(isFavorite); safeSave('favorite_key', a.value);
                safeSave('favourites', old.concat(converted.map(favoriteKey)).filter(function (v, i, all) { return all.indexOf(v) === i; })); home();
            }, playlistSettings);
            if (item.action === 'history') { safeSave('history', []); return home(); }
            if (item.action === 'delete') select('Удалить «' + p.name + '»?', [{title: 'Отмена'}, {title: 'Удалить', yes: true}], function (a) {
                if (!a.yes) return playlistSettings();
                var remaining = playlists().filter(function (x) { return x.id !== p.id; });
                if (!remaining.length) { notify('Нельзя удалить единственный плейлист — можно изменить его адрес'); return playlistSettings(); }
                safeSave('playlists', remaining); cache('playlist:' + p.id, null); cache('guide:' + p.id, null); switchPlaylist(remaining[0]);
            }, playlistSettings);
        }, home);
    }
    function clock(ms) { var d = new Date(ms); return ('0' + d.getHours()).slice(-2) + ':' + ('0' + d.getMinutes()).slice(-2); }
    function programMenu(c, back, playLive) {
        var programs = programsFor(guide, c), now = Date.now(), items = [];
        programs.forEach(function (p) {
            var archive = archiveURL(c, p, now);
            if (p.stop < now && !archive) return;
            items.push({title: escape(clock(p.start) + ' · ' + p.title), subtitle: escape(new Date(p.start).toLocaleDateString() + (archive ? ' · Архив' : p.start <= now ? ' · В эфире' : '')), program: p, url: archive});
        });
        if (!items.length) { notify(guideState || 'Для этого канала нет телепрограммы'); return back(); }
        select(c.name, items, function (item) {
            if (item.url) playArchive(c, item.program, back);
            else if (item.program.start <= Date.now()) playLive();
            else { notify(item.program.desc || 'Передача ещё не началась'); programMenu(c, back, playLive); }
        }, back);
    }
    function playArchive(c, p, back) {
        authorize(c, function () {
            var url = archiveURL(c, p, Date.now()); if (!url) { notify('Архив этой передачи недоступен'); return back(); }
            if (L.Player.close) L.Player.close();
            if (playerCleanup) playerCleanup();
            L.Player.runas(L.Storage.field('player_iptv'));
            L.Player.play({title: c.name + ' · ' + p.title, url: url, iptv: true, need_check_live_stream: true});
            L.Player.playlist([]); L.Player.callback(back);
        }, back);
    }
    function play(c, collection, back) {
        authorize(c, function () {
            if (playerCleanup) playerCleanup();
            function data(item) { return {title: item.name, name: escape(item.name), group: escape(item.group), icons: isFavorite(item) ? ['<svg viewBox="0 0 24 24"><path fill="currentColor" d="m12 2 3 6 7 1-5 5 1 8-6-4-6 4 1-8-5-5 7-1z"/></svg>'] : [], logo: item.logo || '', url: item.url, tv: true, iptv: true, http: item.http || {}, locked: locked(item), original: item, hls_manifest_timeout: 60000, hls_retry_timeout: 60000}; }
            L.Player.runas(L.Storage.field('player_iptv'));
            if (!L.Player.iptv) {
                remember(c); L.Player.play(data(c));
                L.Player.playlist(collection.filter(function (item) { return item === c || !locked(item); }).map(data));
                return L.Player.callback(back);
            }
            var items = collection.slice(), position = items.indexOf(c), alive = true, currentChannel = null, timer;
            if (position < 0) { items.unshift(c); position = 0; }
            function ready(item) {
                if (!alive || !item) return;
                var list = programsFor(guide, item.original);
                if (L.Player.programReady) L.Player.programReady({channel: item, position: programPosition(list, Date.now()), total: list.length});
            }
            function playerBack() { if (alive) L.Controller.toggle('player_tv'); else back(); }
            var config = data(c);
            config.position = position; config.total = items.length;
            config.onGetChannel = function (index) {
                if (!alive || !items[index]) return data(c);
                currentChannel = data(items[index]); ready(currentChannel); return currentChannel;
            };
            config.onPlay = function (item) { if (alive) { remember(item.original); if (screen) screen.rememberChannel(item.original); } };
            config.onGetProgram = function (item, index, container) {
                var list = programsFor(guide, item.original), target = $(container); target.empty();
                list.slice(index, index + 2).forEach(function (p) {
                    var row = $('<div class="player-panel-iptv-item__prog-item"></div>'); $('<span></span>').text(clock(p.start) + ' — ' + clock(p.stop) + '  ' + p.title).appendTo(row);
                    if (p.start <= Date.now() && p.stop > Date.now()) {
                        row.addClass('watch'); var line = $('<div class="player-panel-iptv-item__prog-timeline"><div></div></div>'); line.find('div').css('width', progress(p, Date.now()) + '%'); row.append(line);
                    }
                    target.append(row);
                });
                if (!list.length) $('<div class="player-panel-iptv-item__prog-load"></div>').text('Нет телепрограммы').appendTo(target);
            };
            config.onPlaylistProgram = function (item) { programMenu(item.original, playerBack, playerBack); };
            config.onMenu = function (item) {
                var original = item.original;
                select(original.name, [{title: isFavorite(original) ? 'Убрать из избранного' : 'В избранное', action: 'favorite'}, {title: 'Телепрограмма / архив', action: 'program'}, {title: locked(original) ? 'Снять блокировку' : 'Заблокировать канал', action: 'lock'}], function (a) {
                    if (a.action === 'favorite') { toggleFavorite(original); if (L.PlayerIPTV && L.PlayerIPTV.redrawChannel) L.PlayerIPTV.redrawChannel(); playerBack(); }
                    if (a.action === 'lock') toggleLock(lockKey(original), playerBack);
                    if (a.action === 'program') programMenu(original, playerBack, playerBack);
                }, playerBack);
            };
            function cleanup() {
                alive = false; clearInterval(timer);
                if (L.Player.listener) L.Player.listener.remove('destroy', cleanup);
                if (playerCleanup === cleanup) playerCleanup = null;
            }
            // Register after iptv() because opening the new player destroys the old instance.
            L.Player.iptv(config); L.Player.callback(function () { cleanup(); if (screen) screen.refresh(); back(); });
            timer = setInterval(function () { ready(currentChannel); }, 15000);
            if (L.Player.listener) L.Player.listener.follow('destroy', cleanup);
            playerCleanup = cleanup;
        }, back);
    }
    // Fallback for older Lampa versions without custom activity components.
    function legacyHome() {
        select('Локальное IPTV', [{title: 'Все каналы', action: 'all'}, {title: 'Группы', action: 'groups'}, {title: 'Поиск', action: 'search'}, {title: 'Избранное', action: 'favourites'}, {title: 'Загрузить / обновить плейлист', action: 'load'}, {title: 'Плейлисты', action: 'playlists'}, {title: 'Адрес плейлиста', action: 'url'}], function (a) {
            if (a.action === 'load') return load(); if (a.action === 'url') return editURL(); if (a.action === 'playlists') return playlistMenu();
            if (a.action === 'favourites') return legacyList(channels.filter(isFavorite), 0);
            if (a.action === 'search') return input('Название канала', '', function (value) { legacyList(channels.filter(function (c) { return normalize(c.name).indexOf(normalize(value)) >= 0; }), 0); });
            if (a.action === 'groups') {
                var names = [];
                channels.forEach(function (c) { if (names.indexOf(c.group) < 0) names.push(c.group); });
                return select('Группы', names.map(function (name) { return {title: escape(name), group: name}; }), function (item) { legacyList(channels.filter(function (c) { return c.group === item.group; }), 0); }, legacyHome);
            }
            legacyList(channels, 0);
        }, function () { L.Controller.toggle(origin); });
    }
    function legacyList(list, page) {
        if (!list.length) { notify('Сначала загрузите плейлист'); return legacyHome(); }
        var items = list.slice(page * 40, (page + 1) * 40).map(function (c) { return {title: escape(c.name), channel: c}; });
        if (page > 0) items.push({title: 'Предыдущая страница', page: page - 1}); if ((page + 1) * 40 < list.length) items.push({title: 'Следующая страница', page: page + 1});
        select('Каналы', items, function (a) {
            if (!a.channel) return legacyList(list, a.page);
            select(a.channel.name, [{title: 'Смотреть', play: true}, {title: isFavorite(a.channel) ? 'Убрать из избранного' : 'В избранное'}], function (b) {
                if (b.play) play(a.channel, list, function () { legacyList(list, page); }); else { toggleFavorite(a.channel); legacyList(list, page); }
            }, function () { legacyList(list, page); });
        }, legacyHome);
    }
    function IPTVScreen() {
        var self = this, html, side, rows, details, scrolls = {}, collection = [], selected = null, focus = {side: null, rows: null, details: null}, area = 'side', rendered = 0, rowItems = [], initialized = false, detailTimer = null, detailToken = 0, paused = false;
        var filter = stored('filter_' + activePlaylist().id, 'all'), query = stored('query', '');
        function node(tag, cls, text) { var el = $('<' + tag + '></' + tag + '>').addClass(cls); if (text !== undefined) el.text(text); return el; }
        function reveal(name, el) { if (scrolls[name]) scrolls[name].update(el, true); else if (el && el.scrollIntoView) el.scrollIntoView({block: 'nearest'}); }
        function navigator() { return root.Navigator || L.Navigator; }
        function activate(name, el) {
            if (!html || dead) return; area = name;
            var target = name === 'side' ? side : name === 'rows' ? rows : details;
            L.Controller.collectionSet(target);
            L.Controller.collectionFocus(el || focus[name] || target.find('.selector')[0], target);
        }
        function bind(item, name, enter, long) {
            item.on('hover:focus', function () { area = name; focus[name] = item[0]; reveal(name, item[0]); });
            item.on('hover:hover hover:touch', function () { activate(name, item[0]); });
            if (enter) item.on('hover:enter', enter); if (long) item.on('hover:long', long);
        }
        function button(title, count, value, action, long) {
            var item = $('<div class="local-iptv__group selector"><span></span><small></small></div>');
            item.find('span').text(title); item.find('small').text(count === undefined ? '' : count); item.toggleClass('active', value === filter);
            bind(item, 'side', action || function () { choose(value); }, long); side.append(item); return item;
        }
        function choose(value) { filter = value; safeSave('filter_' + activePlaylist().id, filter); selected = null; focus.rows = null; self.refresh(); area = collection.length ? 'rows' : 'side'; self.start(); }
        function context(c) {
            select(c.name, [{title: 'Смотреть', action: 'play'}, {title: isFavorite(c) ? 'Убрать из избранного' : 'В избранное', action: 'favorite'}, {title: 'Телепрограмма / архив', action: 'program'}, {title: locked(c) ? 'Снять блокировку канала' : 'Заблокировать канал', action: 'lock'}], function (a) {
                if (a.action === 'play') return play(c, collection, self.start);
                if (a.action === 'program') return programMenu(c, self.start, function () { play(c, collection, self.start); });
                if (a.action === 'lock') return toggleLock(lockKey(c), function () { self.refresh(); self.start(); });
                toggleFavorite(c); self.refresh(); self.start();
            }, self.start);
        }
        function loadLogo(c, row) {
            var id = c.tvg && c.tvg.id || guide.names[normalize(c.tvg && c.tvg.name || c.name)], url = c.logo || absolute(guide.logos[id]);
            if (!url || row.data('logo-started')) return;
            row.data('logo-started', true);
            var img = $('<img class="local-iptv__logo" alt="">');
            img.on('load', function () { row.find('.local-iptv__fallback').hide(); }); img.on('error', function () { img.remove(); });
            row.find('.local-iptv__tile').append(img); img.attr('src', url);
        }
        function appendRows() {
            if (!rows || rendered >= collection.length) return;
            var end = Math.min(collection.length, rendered + 30);
            for (var i = rendered; i < end; i++) (function (index) {
                var c = collection[index], row = $('<div class="local-iptv__channel selector"><div class="local-iptv__number"></div><div class="local-iptv__tile"><div class="local-iptv__fallback"></div><div class="local-iptv__badges"></div></div></div>');
                row.attr('aria-label', c.name); row.find('.local-iptv__number').text(('000' + (index + 1)).slice(-Math.max(3, String(index + 1).length)));
                row.find('.local-iptv__fallback').text(c.name);
                row.find('.local-iptv__badges').text((isFavorite(c) ? '★ ' : '') + (locked(c) ? '🔒' : ''));
                row.toggleClass('active', c.url === stored('last_channel', ''));
                bind(row, 'rows', function () { play(c, collection, self.start); }, function () { context(c); });
                row.on('hover:focus', function () {
                    if (index >= rendered - 6) appendRows();
                    selected = c; self.updateDetails();
                    rowItems.slice(Math.max(0, index - 3), index + 8).forEach(function (item, offset) { loadLogo(collection[Math.max(0, index - 3) + offset], item); });
                });
                row.on('visible', function () { loadLogo(c, row); });
                rows.append(row); rowItems.push(row);
                if (index < 10) loadLogo(c, row);
            }(i));
            var added = rowItems.slice(rendered, end).map(function (item) { return item[0]; });
            rendered = end;
            if (area === 'rows' && !paused && L.Controller.own && L.Controller.own(self)) {
                L.Controller.collectionAppend(added);
                if (L.Layer) L.Layer.update(html[0]);
            }
        }
        function drawRows() {
            rows.empty(); if (scrolls.rows) scrolls.rows.reset(); rendered = 0; rowItems = []; focus.rows = null;
            var recent = history(), views = stored('views', {}), sort = stored('sort', 'playlist');
            collection = channels.filter(function (c) { return filter === 'all' || filter === 'favourites' && isFavorite(c) || filter === 'history' && recent.indexOf(c.url) >= 0 || filter === 'search' && normalize(c.name).indexOf(normalize(query)) >= 0 || filter === 'group:' + c.group; });
            if (filter === 'history') collection.sort(function (a, b) { return recent.indexOf(a.url) - recent.indexOf(b.url); });
            else if (sort === 'name') collection.sort(function (a, b) { return a.name.localeCompare(b.name); });
            else if (sort === 'views') collection.sort(function (a, b) { return (views[b.url] || 0) - (views[a.url] || 0); });
            appendRows();
            var index = -1, previous = selected && selected.url || stored('last_channel', '');
            collection.some(function (c, i) { if (c.url === previous) { index = i; return true; } return false; });
            // Restore deep selection in batches; logos remain lazy.
            if (index >= 0) { while (rendered <= index) appendRows(); selected = collection[index]; focus.rows = rowItems[index][0]; }
            else { selected = collection[0] || null; if (rowItems.length) focus.rows = rowItems[0][0]; }
            if (!collection.length) node('div', 'local-iptv__empty', channels.length ? 'Каналы не найдены' : 'Добавьте адрес M3U или обновите плейлист').appendTo(rows);
            self.updateDetails();
        }
        this.updateDetails = function () {
            if (!details || !html) return; detailToken++; var token = detailToken, c = selected; details.empty(); focus.details = null;
            if (scrolls.details) scrolls.details.reset();
            if (!c) return;
            var quality = c.name.match(/\b(4K|UHD|FHD|HD|SD)\b/i), tag = node('div', 'local-iptv__tag');
            if (c.catchup) node('span', 'local-iptv__label', 'A').appendTo(tag); if (quality) node('span', 'local-iptv__label', quality[1].toUpperCase()).appendTo(tag);
            node('span', '', c.group).appendTo(tag); tag.appendTo(details);
            node('div', 'local-iptv__title', c.name).appendTo(details);
            node('div', 'local-iptv__hint', 'OK — смотреть · Удерживайте OK — действия').appendTo(details);
            var list = programsFor(guide, c), now = Date.now(), position = programPosition(list, now), start = Math.max(0, position - (c.catchup ? 4 : 0));
            if (!list.length) { node('div', 'local-iptv__empty', guideState || 'Для этого канала нет телепрограммы').appendTo(details); return; }
            var previousDay = '';
            list.slice(start, start + 30).forEach(function (p) {
                var day = new Date(p.start).toLocaleDateString(); if (day !== previousDay) { node('div', 'local-iptv__date', day).appendTo(details); previousDay = day; }
                var archive = archiveURL(c, p, now), current = p.start <= now && p.stop > now;
                var row = $('<div class="local-iptv__program selector"><div class="local-iptv__time"></div><div class="local-iptv__program-body"><div class="local-iptv__program-title"></div></div></div>');
                row.find('.local-iptv__time').text(clock(p.start)); row.find('.local-iptv__program-title').text((archive && !current ? '↶ ' : '') + p.title); row.toggleClass('current', current);
                if (current) {
                    var bar = $('<div class="local-iptv__progress"><div></div></div>'); bar.find('div').css('width', progress(p, now) + '%'); row.find('.local-iptv__program-body').append(bar);
                    if (p.desc) node('div', 'local-iptv__description', p.desc.slice(0, 350)).appendTo(row.find('.local-iptv__program-body'));
                }
                bind(row, 'details', function () {
                    if (token !== detailToken) return;
                    if (archive) playArchive(c, p, self.start); else if (current) play(c, collection, self.start); else { notify(p.desc || 'Передача ещё не началась'); self.start(); }
                }); details.append(row);
            });
        };
        this.rememberChannel = function (c) { selected = c; };
        this.reset = function () { filter = stored('filter_' + activePlaylist().id, 'all'); selected = null; focus = {side: null, rows: null, details: null}; area = 'side'; };
        this.refresh = function () {
            if (!html) return; side.empty(); focus.side = null;
            var p = activePlaylist(), groups = [], counts = Object.create(null);
            node('div', 'local-iptv__heading', p.name).appendTo(side);
            button('☆ Избранное', channels.filter(isFavorite).length, 'favourites');
            button('◷ Недавние', channels.filter(function (c) { return history().indexOf(c.url) >= 0; }).length, 'history');
            button('⌕ Поиск', query ? channels.filter(function (c) { return normalize(c.name).indexOf(normalize(query)) >= 0; }).length : 0, 'search', function () {
                input('Название канала', query, function (v) { query = String(v || '').trim(); safeSave('query', query); choose(query ? 'search' : 'all'); });
            });
            button('Все каналы', channels.length, 'all');
            channels.forEach(function (c) { if (!counts[c.group]) groups.push(c.group); counts[c.group] = (counts[c.group] || 0) + 1; });
            if (filter.indexOf('group:') === 0 && !counts[filter.slice(6)]) filter = 'all';
            groups.forEach(function (name) {
                var groupLocked = stored('locked', []).indexOf('group:' + name) >= 0;
                button((groupLocked ? '🔒 ' : '▤ ') + name, counts[name], 'group:' + name, null, function () {
                    select(name, [{title: groupLocked ? 'Снять блокировку группы' : 'Заблокировать группу'}], function () { toggleLock('group:' + name, function () { self.refresh(); self.start(); }); }, self.start);
                });
            });
            button('▤ Плейлисты', playlists().length, '', playlistMenu); button('↻ Обновить плейлист', undefined, '', load); button('⚙ Настройки плейлиста', undefined, '', playlistSettings);
            focus.side = side.find('.active')[0] || side.find('.selector')[0]; drawRows();
            if (L.Layer) { L.Layer.update(html[0]); L.Layer.visible(html[0]); }
        };
        function pane(name, target) {
            if (L.Scroll) { var mobile = root.innerWidth < 768, scroll = new L.Scroll({mask: !mobile, over: true, horizontal: mobile && name !== 'details'}); scroll.append(target); if (!mobile || name === 'details') scroll.minus(); scrolls[name] = scroll; return scroll.render(); }
            return target;
        }
        this.create = function () {
            screen = self; html = $('<div class="local-iptv"></div>'); side = $('<div class="local-iptv__sidebar"></div>'); rows = $('<div class="local-iptv__channels"></div>'); details = $('<div class="local-iptv__details"></div>');
            ['side', 'rows', 'details'].forEach(function (name) { var wrap = node('div', 'local-iptv__column local-iptv__column--' + name); wrap.append(pane(name, name === 'side' ? side : name === 'rows' ? rows : details)); html.append(wrap); });
            if (scrolls.rows) scrolls.rows.onEnd = appendRows;
            self.refresh();
        };
        function startTimer() {
            clearInterval(detailTimer); detailTimer = setInterval(function () {
                if (!paused && selected && area !== 'details') self.updateDetails();
            }, 30000);
        }
        this.start = function () {
            if (!html || dead) return;
            if (L.Activity.active && self.activity && L.Activity.active() && L.Activity.active().activity !== self.activity) return;
            screen = self; paused = false;
            if (self.activity) self.activity.loader(false);
            L.Controller.add('content', {
                link: self,
                toggle: function () { activate(area); },
                left: function () { if (area === 'details') activate('rows'); else if (area === 'rows') activate('side'); else L.Controller.toggle('menu'); },
                right: function () { if (area === 'side' && collection.length) activate('rows'); else if (area === 'rows' && details.find('.selector').length) activate('details'); },
                up: function () { if (navigator().canmove('up')) navigator().move('up'); else if (area === 'side') L.Controller.toggle('head'); },
                down: function () { navigator().move('down'); },
                back: function () { if (area === 'details') activate('rows'); else if (area === 'rows') activate('side'); else L.Activity.backward(); }
            });
            L.Controller.toggle('content'); startTimer();
            if (!initialized) { initialized = true; if (!channels.length) restore(); else loadGuide(false); }
        };
        this.isActive = function () { return !paused && !!html; };
        this.pause = function () { paused = true; clearInterval(detailTimer); };
        this.stop = this.pause;
        this.render = function (js) { return js ? html[0] : html; };
        this.destroy = function () {
            paused = true; detailToken++; clearInterval(detailTimer);
            if (screen === self) { screen = null; cancel(); }
            Object.keys(scrolls).forEach(function (name) { scrolls[name].destroy(); });
            if (html) html.remove(); html = null;
        };
    }
    function open(controller) {
        if (dead || !L) return; origin = controller || 'menu';
        if (screen && L.Activity.active && L.Activity.active() && L.Activity.active().component === 'local_iptv') return home();
        if (L.Component && L.Activity) L.Activity.push({title: 'Локальное IPTV', component: 'local_iptv', url: ''}); else legacyHome();
    }
    function init() {
        if (ready || dead || !root.Lampa) return; L = root.Lampa; ready = true;
        if (L.Component) {
            L.Component.add('local_iptv', IPTVScreen);
            style = $('<style></style>').text(
                '.local-iptv{display:flex;box-sizing:border-box;min-height:calc(100vh - 6em);background:linear-gradient(110deg,#292929,#151515)}' +
                '.local-iptv__column{min-width:0}.local-iptv__column--side{width:26%;flex-shrink:0}.local-iptv__column--rows{width:29%;flex-shrink:0}.local-iptv__column--details{width:45%}' +
                '.local-iptv__sidebar{padding:1.5em .5em 2em 1em}.local-iptv__heading{font-size:1.7em;color:#999;margin:.3em .3em 1em;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}' +
                '.local-iptv__group{display:flex;align-items:center;justify-content:space-between;padding:.65em .8em;border-radius:.8em;color:#aaa;margin-bottom:.3em}.local-iptv__group span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.local-iptv__group small{font-size:1em;margin-left:.7em}' +
                '.local-iptv__group.active{background:rgba(255,255,255,.1);color:white}.local-iptv__group.focus{background:white;color:#111}' +
                '.local-iptv__channels{padding:2.2em 1em 2em 4em}.local-iptv__channel{position:relative;margin-bottom:1em;border:2px solid transparent;border-radius:1em}' +
                '.local-iptv__tile{position:relative;width:100%;padding-bottom:72%;background:#414141;border-radius:.8em;overflow:hidden}.local-iptv__fallback{position:absolute;top:0;left:0;width:100%;height:100%;display:flex;align-items:center;justify-content:center;padding:1em;box-sizing:border-box;text-align:center;word-break:break-word}' +
                '.local-iptv__number{position:absolute;right:100%;top:50%;margin-right:.5em;transform:translateY(-50%);font-size:1.5em;color:#888;font-weight:bold}' +
                '.local-iptv__logo{position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);max-width:80%;max-height:80%;object-fit:contain}.local-iptv__badges{position:absolute;top:.4em;right:.5em}' +
                '.local-iptv__channel.focus:before,.local-iptv__channel.active:before{content:"";position:absolute;top:-.4em;bottom:-.4em;left:-.4em;right:-.4em;border:.2em solid #888;border-radius:1.2em}.local-iptv__channel.focus:before{border-color:white}' +
                '.local-iptv__details{padding:2.5em 2em 3em 1.5em}.local-iptv__tag{color:#aaa;margin-bottom:.7em;line-height:1.6}.local-iptv__label{display:inline-block;background:#555;color:white;padding:0 .4em;margin-right:.6em;border-radius:.2em}.local-iptv__title{font-size:2.8em;line-height:1.2;font-weight:700;word-break:break-word}' +
                '.local-iptv__hint{color:#888;font-size:.8em;margin:1em 0 2em;line-height:1.5}.local-iptv__date{color:#888;margin:1.4em 0 .8em 4.5em;font-size:.9em}' +
                '.local-iptv__program{display:flex;padding:.5em .3em;margin-bottom:.7em;border-radius:.4em;line-height:1.4}.local-iptv__program.focus{background:#3b3b3b;outline:2px solid white}.local-iptv__time{width:4em;flex-shrink:0;color:#aaa}.local-iptv__program-body{flex:1;min-width:0}.local-iptv__program.current .local-iptv__program-title{font-weight:bold}.local-iptv__description{font-size:.85em;color:#aaa;margin-top:.6em}' +
                '.local-iptv__progress{background:#444;height:.2em;min-height:2px;margin-top:.7em}.local-iptv__progress>div{height:100%;background:white}.local-iptv__empty{color:#999;padding:1em 0;line-height:1.5}' +
                '.local-iptv .selector{cursor:pointer}' +
                '@media(max-width:767px){.local-iptv{display:block}.local-iptv__column--side,.local-iptv__column--rows,.local-iptv__column--details{width:100%}.local-iptv__sidebar,.local-iptv__channels{display:flex;padding:1em}.local-iptv__heading{display:none}.local-iptv__group{flex-shrink:0;margin:0 .5em 0 0}.local-iptv__channel{width:12em;flex-shrink:0;margin:0 1em 0 0}.local-iptv__number{display:none}.local-iptv__details{padding:1.5em}.local-iptv__title{font-size:2em}.local-iptv__column--details .scroll{height:50vh!important}}'
            ); $('body').append(style);
        }
        var icon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 4h18v14H3V4zm2 2v10h14V6H5zm3 14h8v2H8z"/></svg>';
        menu = $('<li class="menu__item selector"><div class="menu__ico">' + icon + '</div><div class="menu__text">Локальное IPTV</div></li>'); menu.on('hover:enter', function () { open('menu'); }); $('.menu .menu__list').eq(0).append(menu);
        L.SettingsApi.addComponent({component: 'local_iptv', name: 'Локальное IPTV', icon: icon});
        L.SettingsApi.addParam({component: 'local_iptv', param: {name: prefix + 'open', type: 'button'}, field: {name: 'Открыть IPTV', description: 'Локальные M3U, XMLTV и архив · без аккаунта CUB'}, onChange: function () { open('settings_component'); }});
        refreshTimer = setInterval(function () {
            if (!screen || xhr || playerCleanup || !screen.isActive()) return;
            if (L.Controller.enabled && L.Controller.enabled().name !== 'content') return;
            var p = activePlaylist(), updated = stored('updated_' + p.id, 0);
            if (p.update > 0 && updated && Date.now() - updated > p.update * 3600000) load();
        }, 60000);
    }
    function app(event) { if (event.type === 'ready') init(); }
    root.LampaLocalIPTV = {version: VERSION, open: open, parse: parse, getStatus: function () { return {version: VERSION, channels: channels.length, loading: !!xhr, guideLoading: !!guideXHR || !!guideTimer, guideChannels: Object.keys(guide.programs).length, guideStatus: guideState, error: lastError}; },
        destroy: function () {
            dead = true; cancel(); clearInterval(refreshTimer); if (playerCleanup) playerCleanup(); if (screen) screen.destroy(); if (menu) menu.remove(); if (style) style.remove();
            if (L && L.Listener) L.Listener.remove('app', app); if (dbPromise) dbPromise.then(function (db) { if (db) db.close(); });
        }
    };
    if (root.appready) init(); else if (root.Lampa) root.Lampa.Listener.follow('app', app);
}(typeof window !== 'undefined' ? window : globalThis));
