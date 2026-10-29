(function () {
    'use strict';
    var KEY = 'LampaTorrentAudio';
    if (window[KEY] && window[KEY].destroy) window[KEY].destroy();
    var L, session, request, pending, initialized = false, dead = false;
    var bindings = [], retry, restoreTimer, originalTracks, tracksWrapper, lastError = null;
    var gatewayDefault = 'http://192.168.1.2:8090';

    function notify(message) { if (L && L.Noty) L.Noty.show(message); }
    function failure(stage, error) {
        lastError = {
            stage: stage,
            name: error && error.name ? String(error.name) : 'Error',
            message: String(error && error.message || error || 'Без описания').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 400)
        };
        return 'Torrent Audio 0.1.3 [' + stage + ']: ' + lastError.name + ': ' + lastError.message;
    }
    function listen(bus, event, callback) {
        bus.follow(event, callback);
        bindings.push([bus, event, callback]);
    }
    function parse(url) {
        try { return new URL(url); } catch (e) { return null; }
    }
    function gateway() {
        return String(L.Storage.get('torrent_audio_gateway', gatewayDefault) || gatewayDefault).replace(/\/+$/, '');
    }
    function media(url) {
        var u = parse(url), g = parse(gateway());
        if (!u || !g) return null;
        var match = u.pathname.match(/^\/gst\/([a-f0-9]{40})\/master\.m3u8$/i);
        if (match) return u;
        // Only convert streams belonging to the configured server host.
        if (u.hostname !== g.hostname || !/^\/stream(?:\/|$)/.test(u.pathname)) return null;
        var hash = u.searchParams.get('link'), index = u.searchParams.get('index');
        if (!/^[a-f0-9]{40}$/i.test(hash || '') || !/^\d+$/.test(index || '')) return null;
        var hls = parse(gateway() + '/gst/' + hash + '/master.m3u8');
        hls.searchParams.set('index', index);
        hls.searchParams.set('audio', '0');
        return hls;
    }
    function clearRestore() {
        clearInterval(restoreTimer);
        restoreTimer = null;
        pending = null;
    }
    function reset() {
        session = null;
        if (request) { request.abort(); request = null; }
        clearRestore();
    }
    function current(s) { return !dead && session === s; }
    function paint(s) {
        if (!current(s) || !s.tracks.length) return;
        s.data.voiceovers = s.tracks;
        // The stock panel otherwise substitutes ffprobe names by array position.
        s.data.translate = s.data.translate || {};
        s.data.translate.tracks = s.tracks;
        originalTracks.call(L.PlayerPanel, s.tracks);
    }
    function rollback(message) {
        var p = pending;
        if (!p) return;
        clearRestore();
        var s = p.session;
        if (!current(s)) return;
        notify(message);
        if (p.rollback) return;
        s.audio = p.oldAudio;
        s.data.url = p.oldURL;
        s.tracks.forEach(function (t) { t.selected = t.enabled = t.index === s.audio; });
        pending = {session: s, time: p.time, paused: p.paused, deadline: Date.now() + 60000, attempted: false, rollback: true};
        var stage = 'rollback.destroy';
        try {
            L.PlayerVideo.destroy(true);
            stage = 'rollback.url';
            L.PlayerVideo.url(p.oldURL, false);
            restoreTimer = setInterval(restore, 500);
        } catch (e) {
            clearRestore();
            notify(failure(stage, e) + '. Откройте фильм заново.');
        }
        paint(s);
    }
    function restore() {
        var p = pending;
        if (!p || !current(p.session)) return clearRestore();
        if (Date.now() > p.deadline) {
            rollback(p.rollback ? 'Не удалось восстановить прежний поток. Откройте фильм заново.' : 'Новая дорожка не запустилась. Возвращаю прежний поток.');
            return;
        }
        var v = L.PlayerVideo.video();
        if (!v || !(v.duration > 0) || !isFinite(v.duration)) return;
        // Reassigning currentTime while a seek is pending can restart that seek
        // indefinitely in TV engines, preventing playback from ever resuming.
        if (v.seeking || (typeof v.readyState === 'number' && v.readyState < 1)) return;
        var target = Math.min(p.time, Math.max(0, v.duration - 0.1));
        if (!p.attempted || Math.abs(v.currentTime - target) > 2) {
            try {
                v.currentTime = target;
                p.attempted = true;
            } catch (e) { return; }
            return;
        }
        var paused = p.paused;
        clearRestore();
        if (paused) L.PlayerVideo.pause();
        else L.PlayerVideo.play();
        paint(p.session);
    }
    function choose(s, index) {
        if (!current(s)) return;
        if (pending || s.audio === index) {
            s.tracks.forEach(function (t) { t.selected = t.enabled = t.index === s.audio; });
            paint(s);
            return;
        }
        var v = L.PlayerVideo.video();
        if (!v || !isFinite(v.currentTime)) return notify('Подождите начала воспроизведения.');
        var oldURL = s.data.url, oldAudio = s.audio;
        var u = parse(s.hlsURL);
        if (!u) return;
        u.searchParams.set('audio', String(index));
        pending = {session: s, time: v.currentTime, paused: !!v.paused, deadline: Date.now() + 60000, attempted: false, oldURL: oldURL, oldAudio: oldAudio};
        s.audio = index;
        s.data.url = u.href;
        s.tracks.forEach(function (t) { t.selected = t.enabled = t.index === index; });
        // A new audio stream needs normal HLS initialization. Passing true here
        // bypasses Lampa's manifest parser and loads the master directly on TVs.
        s.data.hls_manifest_timeout = Math.max(60000, Number(s.data.hls_manifest_timeout) || 0);
        var stage = 'switch.destroy';
        try {
            L.PlayerVideo.destroy(true);
            stage = 'switch.url';
            L.PlayerVideo.url(s.data.url, false);
            restoreTimer = setInterval(restore, 500);
        } catch (e) {
            rollback(failure(stage, e) + '. Возвращаю прежний поток.');
        }
        paint(s);
    }
    function loadTracks(s) {
        if (request) request.abort();
        var u = parse(s.hlsURL);
        u.pathname = u.pathname.replace(/master\.m3u8$/, 'probe');
        u.searchParams.delete('audio');
        var xhr = new XMLHttpRequest();
        request = xhr;
        xhr.open('GET', u.href, true);
        xhr.timeout = 60000;
        xhr.onload = function () {
            if (!current(s) || request !== xhr) return;
            request = null;
            try {
                if (xhr.status < 200 || xhr.status >= 300) throw new Error('HTTP');
                var json = JSON.parse(xhr.responseText);
                if (!Array.isArray(json.Tracks)) throw new Error('Tracks');
                s.tracks = json.Tracks.filter(function (t) {
                    return t.Type === 'audio' && typeof t.Index === 'number' && t.Index >= 0 && Math.floor(t.Index) === t.Index;
                }).map(function (t) {
                    return {
                        index: t.Index,
                        name: t.Title || 'Дорожка ' + (t.Index + 1),
                        language: t.Language || 'und',
                        label: t.Title || '',
                        extra: {channels: t.Channels, fourCC: t.CapsName || ''},
                        selected: t.Index === s.audio,
                        enabled: t.Index === s.audio,
                        onSelect: function () { choose(s, t.Index); }
                    };
                });
                if (!s.tracks.length) return notify('Сервер не обнаружил аудиодорожки.');
                paint(s);
            } catch (e) { notify('Не удалось прочитать аудиодорожки: некорректный ответ /probe.'); }
        };
        xhr.onerror = xhr.ontimeout = function () {
            if (current(s) && request === xhr) { request = null; notify('Аудиодорожки: сервер /probe недоступен. Проверьте сеть и CORS.'); }
        };
        xhr.send();
    }
    function start(data) {
        reset();
        if (!data || data.iptv || typeof data.url !== 'string') return;
        var u = media(data.url);
        if (!u) return;
        // Do not force audio=0 or replace a working direct stream on startup.
        // The HLS gateway is activated only by an explicit track selection.
        var direct = /\/stream(?:\/|\?)/.test(data.url);
        var s = {data: data, hlsURL: u.href, audio: direct ? null : Number(u.searchParams.get('audio') || 0), tracks: []};
        session = s;
        loadTracks(s);
    }
    function init() {
        if (dead) return;
        L = window.Lampa;
        if (!L || !window.appready) { retry = setTimeout(init, 500); return; }
        if (!L.Player || !L.Player.listener || !L.PlayerPanel || !L.PlayerPanel.setTracks ||
            !L.PlayerVideo || !L.PlayerVideo.listener || !L.PlayerVideo.video || !L.PlayerVideo.url ||
            !L.PlayerVideo.destroy || !L.PlayerVideo.pause || !L.PlayerVideo.play || !window.URL || !window.URLSearchParams) {
            notify('Torrent Audio: эта версия Lampa или браузера не поддерживается.');
            return;
        }
        initialized = true;
        originalTracks = L.PlayerPanel.setTracks;
        tracksWrapper = function (tracks) {
            return originalTracks.call(this, session && session.tracks.length ? session.tracks : tracks);
        };
        L.PlayerPanel.setTracks = tracksWrapper;
        listen(L.Player.listener, 'start', start);
        listen(L.Player.listener, 'destroy', reset);
        listen(L.PlayerVideo.listener, 'canplay', restore);
        listen(L.PlayerVideo.listener, 'loadeddata', restore);
        listen(L.PlayerVideo.listener, 'error', function () {
            if (pending) rollback(pending.rollback ? 'Ошибка прежнего потока. Откройте фильм заново.' : 'Ошибка новой дорожки. Возвращаю прежний поток.');
        });
    }
    window[KEY] = {
        version: '0.1.3',
        getLastError: function () {
            return lastError ? {stage: lastError.stage, name: lastError.name, message: lastError.message} : null;
        },
        setGateway: function (url) {
            var u = parse(url);
            if (!u || !/^https?:$/.test(u.protocol) || u.username || u.password || u.search || u.hash || u.pathname !== '/') {
                throw new Error('Укажите http(s)://адрес:порт без пути и параметров');
            }
            if (!initialized) throw new Error('Lampa ещё не готова');
            L.Storage.set('torrent_audio_gateway', u.origin);
        },
        refresh: function () { if (session) loadTracks(session); },
        destroy: function () {
            dead = true;
            clearTimeout(retry);
            reset();
            bindings.forEach(function (b) { if (b[0].remove) b[0].remove(b[1], b[2]); });
            bindings = [];
            if (initialized && L.PlayerPanel.setTracks === tracksWrapper) L.PlayerPanel.setTracks = originalTracks;
        }
    };
    init();
})();
