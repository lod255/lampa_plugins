(function () {
    'use strict';
    if (window.lampa_internet_speed) return;
    var API = 'https://speed.cloudflare.com/__down';
    var LIMIT = 96 * 1024 * 1024;
    var DURATION = 15000;
    var active = null;
    var registered = false;
    function now() { return window.performance && window.performance.now ? window.performance.now() : Date.now(); }
    function median(values) {
        var sorted = values.slice().sort(function (a, b) { return a - b; });
        var mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
    }
    // No promises, fetch, streams or modern syntax: older Tizen WebViews use XHR.
    function measure(report, finish) {
        var xhr = null, timer = null, ended = false, seq = 0;
        var started = 0, bytes = 0, total = 0, samples = [], latency = [];
        function stop() {
            if (ended) return;
            ended = true;
            clearTimeout(timer);
            if (xhr) {
                xhr.onload = xhr.onerror = xhr.ontimeout = xhr.onprogress = null;
                xhr.abort();
                xhr = null;
            }
        }
        function done(error) {
            if (ended) return;
            var result = {
                error: error || null, bytes: bytes, samples: samples.length,
                mbps: total > 0 ? bytes * 8 / total / 1000 : null,
                latency: latency.length ? median(latency) : null
            };
            stop();
            finish(result);
        }
        function request(size, callback) {
            if (ended) return;
            var start = now(), loaded = 0;
            var req = new XMLHttpRequest();
            xhr = req;
            function fail(message) { if (!ended) done(message); }
            try {
                req.open('GET', API + '?bytes=' + size + '&lampa=' + Date.now() + '-' + (++seq), true);
                req.responseType = 'arraybuffer';
                req.timeout = 12000;
                req.onprogress = function (event) {
                    loaded = event.loaded || 0;
                    if (started) report({phase: 'download', bytes: bytes + loaded,
                        mbps: (bytes + loaded) * 8 / Math.max(1, total + now() - start) / 1000});
                };
                req.onerror = function () { fail('Сервер недоступен: возможны блокировка, CORS, TLS или ошибка сети.'); };
                req.ontimeout = function () { fail('Сервер не ответил за 12 секунд.'); };
                req.onload = function () {
                    if (ended) return;
                    xhr = null;
                    if (req.status !== 200) return fail('Ошибка тестового сервера: HTTP ' + req.status);
                    var count = req.response && req.response.byteLength;
                    if (count !== size) return fail('Сервер вернул неожиданный объём данных. Замер отклонён.');
                    callback(count, Math.max(1, now() - start));
                };
                req.send();
            } catch (e) { fail('Не удалось запустить запрос: ' + e.message); }
        }
        function download(size) {
            if (ended) return;
            if (bytes >= LIMIT || now() - started >= DURATION) return done();
            size = Math.min(size, LIMIT - bytes);
            request(size, function (count, elapsed) {
                bytes += count;
                total += elapsed;
                samples.push(count * 8 / elapsed / 1000);
                report({phase: 'download', bytes: bytes, mbps: bytes * 8 / total / 1000});
                var next = Math.max(262144, Math.min(8 * 1024 * 1024, Math.round(count * 1800 / elapsed)));
                download(next);
            });
        }
        function probe() {
            if (ended) return;
            report({phase: 'latency', index: latency.length});
            request(1, function (count, elapsed) {
                // First probe warms DNS/TLS; this is HTTP response time, not ICMP ping.
                if (seq > 1) latency.push(elapsed);
                if (latency.length < 4) probe();
                else {
                    started = now();
                    timer = setTimeout(function () {
                        // Incomplete chunks are excluded from the final average.
                        if (samples.length) done();
                        else done('За 15 секунд не завершилась первая загрузка. Скорость не определена.');
                    }, DURATION);
                    download(262144);
                }
            });
        }
        probe();
        return {stop: stop};
    }
    function show() {
        var L = window.Lampa, $ = window.jQuery || window.$;
        if (active) return;
        var html = $('<div></div>');
        var status = $('<div style="font-size:1.3em;margin-bottom:1em"></div>').text('Готов к проверке');
        var details = $('<div style="line-height:1.5;margin-bottom:1em"></div>');
        var action = $('<div class="selector" style="padding:0.8em;background:rgba(255,255,255,.12);border-radius:.3em"></div>');
        var hint = $('<div style="opacity:.65;margin-top:1em;font-size:.85em;line-height:1.4"></div>')
            .text('Cloudflare · до 15 с загрузки и до 96 МиБ данных. Измеряется путь от этого устройства до сервера, включая Wi-Fi и VPN. Остановите воспроизведение и фоновые загрузки.');
        html.append(status, details, action, hint);
        var job = null, running = false, closed = false;
        function format(value) { return value === null ? '—' : value.toFixed(1); }
        function idle() { running = false; job = null; action.text('Повторить тест'); }
        function cancel() {
            if (job) job.stop();
            idle();
            status.text('Тест остановлен');
            details.text('Незавершённый замер не сохранён.');
        }
        function close() {
            closed = true;
            if (job) job.stop();
            active = null;
        }
        active = {stop: close};
        action.text('Начать тест').on('hover:enter', function () {
            if (running) return cancel();
            running = true;
            action.text('Остановить тест');
            details.text('Подготовка соединения…');
            var handle = measure(function (progress) {
                if (closed) return;
                if (progress.phase === 'latency') status.text('Проверка HTTP-задержки…');
                else {
                    status.text('Загрузка: ' + format(progress.mbps) + ' Мбит/с');
                    details.text('Получено: ' + (progress.bytes / 1048576).toFixed(1) + ' МиБ');
                }
            }, function (result) {
                if (closed) return;
                idle();
                if (result.error) {
                    status.text('Тест не завершён');
                    details.text(result.error + ' Это не означает, что интернет отсутствует.');
                    return;
                }
                status.text('Входящая скорость: ' + format(result.mbps) + ' Мбит/с');
                details.text('HTTP-задержка: ' + Math.round(result.latency) + ' мс · Получено: ' +
                    (result.bytes / 1048576).toFixed(1) + ' МиБ. Скорость оценочная; это не тест TorrServer или источника фильма.');
                L.Storage.set('internet_speed_last_v1', {mbps: result.mbps, latency: result.latency, date: Date.now()});
            });
            if (running) job = handle;
        });
        var last = L.Storage.get('internet_speed_last_v1', null);
        if (last && typeof last.mbps === 'number') details.text('Последний замер: ' + format(last.mbps) +
            ' Мбит/с · ' + new Date(last.date).toLocaleString());
        L.Modal.open({title: 'Скорость интернета', html: html, size: 'medium', select: action[0],
            onBack: function () { close(); L.Modal.close(); L.Controller.toggle('settings_component'); }});
    }
    function init() {
        if (registered) return;
        var L = window.Lampa;
        if (!L || !L.SettingsApi) return;
        registered = true;
        L.SettingsApi.addComponent({component: 'internet_speed', name: 'Скорость интернета',
            icon: '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M11 3h2v10l4-4 1.4 1.4L12 17l-6.4-6.6L7 9l4 4V3zM4 19h16v2H4z"/></svg>'});
        L.SettingsApi.addParam({component: 'internet_speed', param: {name: 'internet_speed_run', type: 'button'},
            field: {name: 'Проверить скорость', description: 'Входящая скорость и HTTP-задержка · Cloudflare'}, onChange: show});
    }
    window.lampa_internet_speed = {version: '0.1.0', measure: measure, open: show,
        stop: function () { if (active) active.stop(); }};
    if (window.appready) init();
    else if (window.Lampa) window.Lampa.Listener.follow('app', function (event) { if (event.type === 'ready') init(); });
}());
