(function () {
    'use strict';
    var KEY = 'LampaTorrentAudio';
    if (window[KEY] && window[KEY].destroy) window[KEY].destroy();
    var L, session, request, pending, initialized = false, dead = false;
    var bindings = [], retry, restoreTimer, originalTracks, tracksWrapper, lastError = null, lastStatus = null;
    var gatewayDefault = 'http://192.168.1.2:8090';

    function notify(message) { if (L && L.Noty) L.Noty.show(message); }
    function failure(stage, error) {
        lastError = {
            stage: stage,
            name: error && error.name ? String(error.name) : 'Error',
            message: String(error && error.message || error || 'Без описания').replace(/https?:\/\/[^\s"'<>]+/g, '[URL]').slice(0, 400)
        };
        return 'Torrent Audio 0.1.7 [' + stage + ']: ' + lastError.name + ': ' + lastError.message;
    }
    function status() {
        var p = pending, v = null;
        try { v = L.PlayerVideo.video(); } catch (ignored) {}
        var result = {
            phase: p ? p.phase : 'idle',
            target: p ? Math.round(p.time) : null,
            time: v ? String(v.currentTime) : 'no-video',
            duration: v ? String(v.duration) : 'no-video',
            readyState: v && typeof v.readyState !== 'undefined' ? v.readyState : '?',
            networkState: v && typeof v.networkState !== 'undefined' ? v.networkState : '?',
            paused: v ? !!v.paused : null,
            seeking: v ? !!v.seeking : null,
            mediaError: v && v.error ? v.error.code : 0,
            resumeRequested: !!(p && p.resumeRequested),
            playAttempts: p ? p.playAttempts || 0 : 0,
            playResult: p ? p.playResult || 'none' : 'none'
        };
        return result;
    }
    function timeoutDetails() {
        lastStatus = status();
        return ' [TA 0.1.7 phase=' + lastStatus.phase +
            ' t=' + lastStatus.time + '/' + lastStatus.target +
            ' d=' + lastStatus.duration + ' ready=' + lastStatus.readyState +
            ' net=' + lastStatus.networkState + ' err=' + lastStatus.mediaError +
            ' pause=' + Number(lastStatus.paused) + ' seek=' + Number(lastStatus.seeking) +
            ' resume=' + Number(lastStatus.resumeRequested) +
            ' plays=' + lastStatus.playAttempts + ' play=' + lastStatus.playResult + ']';
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
    function reset(preserveTransition) {
        session = null;
        if (request) { request.abort(); request = null; }
        if (!preserveTransition) clearRestore();
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
    function playbackData(source, url) {
        var data = {};
        Object.keys(source).forEach(function (key) { data[key] = source[key]; });
        data.url = url;
        data.launch_player = 'inner';
        data.continue_play = true;
        data.hls_manifest_timeout = Math.max(60000, Number(source.hls_manifest_timeout) || 0);
        delete data.quality;
        delete data.url_reserve;
        delete data.voiceovers;
        if (source.translate) {
            data.translate = {};
            Object.keys(source.translate).forEach(function (key) {
                if (key !== 'tracks') data.translate[key] = source.translate[key];
            });
        }
        if (source.timeline) {
            data.timeline = {};
            Object.keys(source.timeline).forEach(function (key) { data.timeline[key] = source.timeline[key]; });
            // Restore ourselves after metadata; do not show the resume dialog.
            data.timeline.time = 0;
            data.timeline.percent = 0;
            data.timeline.waiting_for_user = false;
        }
        return data;
    }
    function restart(p, data) {
        p.expected = data;
        p.restarting = true;
        p.phase = 'restart';
        p.attempted = false;
        p.resumeRequested = false;
        p.resumeFrom = 0;
        p.playAttempts = 0;
        p.playResult = 'none';
        p.lastPlayAt = 0;
        p.progressAt = 0;
        p.progressPosition = 0;
        p.deadline = Date.now() + 60000;
        // Arm before sending: Lampa synchronously emits destroy/start here.
        if (!restoreTimer) restoreTimer = setInterval(restore, 500);
        var list = L.PlayerPlaylist.get().slice();
        var oldURL = p.session.data.url;
        list = list.map(function (item) { return item.url === oldURL ? data : item; });
        // Lampa's own series-change handler destroys Player, invokes play(),
        // preserves the back callback, and restores the playlist and video params.
        L.PlayerPlaylist.listener.send('select', {item: data, playlist: list});
        if (!dead && pending === p) L.PlayerPlaylist.set(list);
    }
    function rollback(message) {
        var p = pending;
        if (!p) return;
        notify(message);
        if (p.rollback || p.phase === 'prepare') {
            clearRestore();
            if (request) { request.abort(); request = null; }
            return;
        }
        p.rollback = true;
        try { restart(p, playbackData(p.previousData, p.oldURL)); }
        catch (e) {
            clearRestore();
            notify(failure('rollback.restart', e) + '. Откройте фильм заново.');
        }
    }
    function requestResume(p) {
        // Arm before play(): media events may synchronously call restore().
        p.playAttempts++;
        p.lastPlayAt = Date.now();
        p.playResult = 'calling';
        try {
            var result = L.PlayerVideo.play();
            p.playResult = 'returned';
            // Some Lampa versions return nothing; returned is not proof of playback.
            if (result && typeof result.then === 'function') {
                var attempt = p.playAttempts;
                result.then(function () {
                    if (pending === p && p.playAttempts === attempt) p.playResult = 'resolved';
                }, function (error) {
                    if (pending !== p || p.playAttempts !== attempt) return;
                    p.playResult = 'rejected';
                    failure('restore.play', error);
                });
            }
        } catch (error) {
            p.playResult = 'threw';
            failure('restore.play', error);
        }
    }
    function restore() {
        var p = pending;
        if (!p || dead) return clearRestore();
        if (Date.now() > p.deadline) {
            rollback((p.rollback ? 'Не удалось восстановить прежний поток. Откройте фильм заново.' : 'Новая дорожка не запустилась. Возвращаю прежний поток.') + timeoutDetails());
            return;
        }
        if (p.phase !== 'restore' || !current(p.session)) return;
        var v = L.PlayerVideo.video();
        if (!v || !(v.duration > 0) || !isFinite(v.duration)) return;
        if (typeof v.readyState === 'number' && v.readyState < 2) return;
        // An accepted currentTime assignment alone does not prove playback.
        // Keep the watchdog until the new stream actually advances.
        if (p.resumeRequested) {
            if (v.currentTime > p.resumeFrom + 0.2) {
                clearRestore();
                paint(p.session);
                return;
            }
            var now = Date.now();
            if (v.currentTime > p.progressPosition + 0.2) {
                p.progressPosition = v.currentTime;
                p.progressAt = now;
            }
            // Initial call plus at most three retries, only while time is stalled.
            // Do not seek again or extend the existing rollback deadline.
            if (p.playAttempts < 4 && now - p.lastPlayAt >= 3000 && now - p.progressAt >= 3000) {
                requestResume(p);
            }
            return;
        }
        var target = Math.min(p.time, Math.max(0, v.duration - 0.1));
        // Seek at most once, and skip the seek when already near the target.
        // Do not wait for seeking=false before play(): some TV engines need
        // playback to run before an outstanding seek can finish.
        if (!p.attempted) {
            try {
                if (Math.abs(v.currentTime - target) > 2) v.currentTime = target;
                p.attempted = true;
            } catch (e) { return; }
        }
        if (p.paused) {
            if (Math.abs(v.currentTime - target) > 2) return;
            L.PlayerVideo.pause();
            clearRestore();
            paint(p.session);
        }
        else {
            p.resumeRequested = true;
            p.resumeFrom = target;
            p.progressPosition = v.currentTime;
            p.progressAt = Date.now();
            requestResume(p);
        }
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
        var u = parse(s.hlsURL);
        if (!u) return;
        u.searchParams.set('audio', String(index));
        var p = {session: s, previousData: s.data, oldURL: s.data.url, time: v.currentTime,
            paused: !!v.paused, deadline: Date.now() + 60000, phase: 'prepare', attempted: false};
        pending = p;
        restoreTimer = setInterval(restore, 500);
        notify('Torrent Audio 0.1.7: подготовка дорожки. Текущее видео пока не останавливается.');
        var xhr = new XMLHttpRequest();
        request = xhr;
        xhr.open('GET', u.href, true);
        xhr.timeout = 60000;
        xhr.onload = function () {
            if (dead || pending !== p || !current(s) || request !== xhr) return;
            request = null;
            if (xhr.status < 200 || xhr.status >= 300 || !/^\s*#EXTM3U/.test(xhr.responseText)) {
                return rollback('HLS не готов (HTTP ' + xhr.status + '). Прежнее видео сохранено.');
            }
            // Capture the current position now, not before the HLS preparation.
            var video = L.PlayerVideo.video();
            if (video && isFinite(video.currentTime)) { p.time = video.currentTime; p.paused = !!video.paused; }
            try { restart(p, playbackData(s.data, u.href)); }
            catch (e) { rollback(failure('switch.restart', e) + '. Возвращаю прежний поток.'); }
        };
        xhr.onerror = xhr.ontimeout = function () {
            if (pending === p && request === xhr) rollback('HLS недоступен: сеть, CORS или таймаут. Прежнее видео сохранено.');
        };
        try { xhr.send(); }
        catch (e) { rollback(failure('switch.prepare', e)); }
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
        var transition = pending && pending.expected === data ? pending : null;
        reset(!!transition);
        if (!data || data.iptv || typeof data.url !== 'string') return;
        var u = media(data.url);
        if (!u) return;
        // Do not force audio=0 or replace a working direct stream on startup.
        // The HLS gateway is activated only by an explicit track selection.
        var direct = /\/stream(?:\/|\?)/.test(data.url);
        var s = {data: data, hlsURL: u.href, audio: direct ? null : Number(u.searchParams.get('audio') || 0), tracks: []};
        session = s;
        if (transition) {
            transition.session = s;
            transition.restarting = false;
            transition.phase = 'restore';
            transition.deadline = Date.now() + 60000;
        }
        loadTracks(s);
    }
    function init() {
        if (dead) return;
        L = window.Lampa;
        if (!L || !window.appready) { retry = setTimeout(init, 500); return; }
        if (!L.PlayerPlaylist || !L.PlayerPlaylist.get || !L.PlayerPlaylist.set || !L.PlayerPlaylist.listener || !L.PlayerPlaylist.listener.send ||
            !L.Player || !L.Player.listener || !L.PlayerPanel || !L.PlayerPanel.setTracks ||
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
        listen(L.Player.listener, 'destroy', function () { reset(!!(pending && pending.restarting)); });
        listen(L.Player.listener, 'close', function () { reset(); });
        listen(L.PlayerVideo.listener, 'canplay', restore);
        listen(L.PlayerVideo.listener, 'loadeddata', restore);
        listen(L.PlayerVideo.listener, 'error', function () {
            if (pending && pending.phase === 'restore') rollback(pending.rollback ? 'Ошибка прежнего потока. Откройте фильм заново.' : 'Ошибка новой дорожки. Возвращаю прежний поток.');
        });
    }
    window[KEY] = {
        version: '0.1.7',
        getStatus: status,
        getLastStatus: function () { return lastStatus ? JSON.parse(JSON.stringify(lastStatus)) : null; },
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
        refresh: function () { if (session && !pending) loadTracks(session); },
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
