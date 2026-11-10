(function (root) {
    'use strict';
    var VERSION = '0.1.0';
    function absolute(value, base) {
        try {
            var url = new URL(value, base);
            return /^https?:$/.test(url.protocol) ? url.href : '';
        } catch (ignored) { return ''; }
    }
    function attributes(text) {
        var result = {}, match, pattern = /([\w-]+)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s,]+))/g;
        while ((match = pattern.exec(text))) result[match[1].toLowerCase()] = match[2] !== undefined ? match[2] : match[3] !== undefined ? match[3] : match[4];
        return result;
    }
    function commaOutsideQuotes(text) {
        var quote = '', i, ch;
        for (i = 0; i < text.length; i++) {
            ch = text.charAt(i);
            if (quote) { if (ch === quote) quote = ''; }
            else if (ch === '"' || ch === "'") quote = ch;
            else if (ch === ',') return i;
        }
        return -1;
    }
    function parse(text, base) {
        text = String(text).replace(/^\uFEFF/, '').replace(/^\s+/, '');
        if (!/^#EXTM3U(?:\s|$)/i.test(text)) throw new Error('Ответ не является M3U');
        var lines = text.split(/\r?\n/), channels = [], info = null, group = '', seen = {}, i;
        for (i = 1; i < lines.length; i++) {
            var line = lines[i].trim();
            if (/^#EXT-X-/i.test(line)) throw new Error('Указан HLS одного канала. Нужен общий M3U-плейлист');
            if (/^#EXTINF:/i.test(line)) {
                var index = commaOutsideQuotes(line), attr = attributes(index < 0 ? line : line.slice(0, index));
                info = {name: index < 0 ? '' : line.slice(index + 1).trim(), attr: attr};
                group = attr['group-title'] || '';
            } else if (/^#EXTGRP:/i.test(line)) group = line.slice(8).trim();
            else if (line && line.charAt(0) !== '#') {
                var url = absolute(line, base);
                if (url && !seen[url]) {
                    seen[url] = true;
                    channels.push({url: url, name: info && (info.name || info.attr['tvg-name']) || 'Канал ' + (channels.length + 1),
                        group: group || 'Без группы'});
                }
                info = null; group = '';
            }
        }
        if (!channels.length) throw new Error('В плейлисте нет HTTP(S)-каналов');
        return channels;
    }
    if (typeof module === 'object' && module.exports) { module.exports = {parse: parse}; return; }
    if (root.LampaLocalIPTV) return;
    var L, ready = false, dead = false, xhr = null, generation = 0, channels = [], menu, lastError = '', origin = 'menu';
    var prefix = 'local_iptv_', pageSize = 40;
    function escape(value) { return String(value).replace(/[&<>"']/g, function (c) { return {'&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'}[c]; }); }
    function stored(key, fallback) { return L.Storage.get(prefix + key, fallback); }
    function source() { return String(stored('url', 'http://192.168.1.2:8088/playlist.m3u') || '').trim(); }
    function favourites() { var value = stored('favourites', []); return Array.isArray(value) ? value : []; }
    function notify(text) { L.Noty.show(text); }
    function back() { L.Controller.toggle(origin); }
    function select(title, items, callback, onBack) {
        if (dead) return;
        L.Select.show({title: escape(title), items: items, onSelect: callback, onBack: onBack || home});
    }
    function cancel() { generation++; if (xhr) { xhr.abort(); xhr = null; } }
    function load() {
        cancel();
        var token = generation, request = new XMLHttpRequest(), url = source();
        if (!absolute(url)) { notify('Укажите HTTP(S)-адрес плейлиста'); return editURL(); }
        xhr = request;
        select('Загрузка плейлиста…', [{title: 'Отменить'}], function () { cancel(); home(); }, function () { cancel(); home(); });
        function fail(message) {
            if (dead || token !== generation) return;
            xhr = null; lastError = message; notify(message); home();
        }
        try { request.open('GET', url, true); }
        catch (error) { fail('Не удалось открыть адрес плейлиста'); return; }
        request.timeout = 60000;
        request.onload = function () {
            if (dead || token !== generation) return;
            if (request.status < 200 || request.status >= 300) return fail('Плейлист: HTTP ' + request.status);
            try { channels = parse(request.responseText, request.responseURL || url); }
            catch (error) { return fail(error.message); }
            xhr = null; lastError = ''; home();
        };
        request.onerror = function () { fail('Нет доступа к плейлисту: проверьте сеть, CORS и ограничения HTTP/HTTPS'); };
        request.ontimeout = function () { fail('Сервер плейлиста не ответил за 60 секунд'); };
        try { request.send(); } catch (error) { fail('Не удалось отправить запрос плейлиста'); }
    }
    function editURL() {
        L.Input.edit({title: 'HTTP(S)-адрес M3U', value: source(), free: true, nosave: true}, function (value) {
            value = String(value || '').trim();
            if (!value) return home();
            if (!absolute(value)) { notify('Нужен полный адрес http:// или https://'); return home(); }
            cancel(); channels = []; L.Storage.set(prefix + 'url', value); home();
        });
    }
    function home() {
        var items = [{title: 'Все каналы', subtitle: String(channels.length), action: 'all'},
            {title: 'Группы', action: 'groups'}, {title: 'Поиск', action: 'search'},
            {title: 'Избранное', action: 'favourites'}, {title: 'Загрузить / обновить плейлист', action: 'load'},
            {title: 'Адрес плейлиста', subtitle: 'Хранится только на этом устройстве', action: 'url'}];
        select('Локальное IPTV', items, function (item) {
            if (item.action === 'load') return load();
            if (item.action === 'url') return editURL();
            if (!channels.length) { notify('Сначала загрузите плейлист'); return home(); }
            if (item.action === 'all') return list(channels, 'Все каналы', 0, home);
            if (item.action === 'groups') return groups();
            if (item.action === 'search') return search();
            var fav = favourites();
            list(channels.filter(function (c) { return fav.indexOf(c.url) >= 0; }), 'Избранное', 0, home);
        }, back);
    }
    function groups() {
        var names = [], counts = {};
        channels.forEach(function (c) { var key = '$' + c.group; if (!counts[key]) names.push(c.group); counts[key] = (counts[key] || 0) + 1; });
        select('Группы', names.map(function (name) { return {title: escape(name), subtitle: String(counts['$' + name]), group: name}; }), function (item) {
            list(channels.filter(function (c) { return c.group === item.group; }), item.group, 0, groups);
        });
    }
    function search() {
        L.Input.edit({title: 'Название канала', value: '', free: true, nosave: true}, function (value) {
            var query = String(value || '').trim().toLowerCase();
            if (!query) return home();
            list(channels.filter(function (c) { return c.name.toLowerCase().indexOf(query) >= 0; }), 'Поиск: ' + query, 0, home);
        });
    }
    function list(collection, title, page, parent) {
        if (!collection.length) { notify('Каналы не найдены'); return parent(); }
        var pages = Math.ceil(collection.length / pageSize), fav = favourites();
        var items = collection.slice(page * pageSize, (page + 1) * pageSize).map(function (c) {
            return {title: escape((fav.indexOf(c.url) >= 0 ? '★ ' : '') + c.name), subtitle: escape(c.group), channel: c};
        });
        if (page > 0) items.push({title: '← Предыдущая страница', page: page - 1});
        if (page + 1 < pages) items.push({title: 'Следующая страница →', page: page + 1});
        function returnHere() { list(collection, title, page, parent); }
        select(title + ' · ' + (page + 1) + '/' + pages, items, function (item) {
            if (!item.channel) return list(collection, title, item.page, parent);
            channelMenu(item.channel, collection, returnHere);
        }, parent);
    }
    function channelMenu(channel, collection, parent) {
        var fav = favourites(), favourite = fav.indexOf(channel.url) >= 0;
        select(channel.name, [{title: 'Смотреть', play: true}, {title: favourite ? 'Убрать из избранного' : 'В избранное'}], function (item) {
            if (!item.play) {
                if (favourite) fav.splice(fav.indexOf(channel.url), 1); else fav.push(channel.url);
                L.Storage.set(prefix + 'favourites', fav); return parent();
            }
            function data(c) { return {title: c.name, url: c.url, tv: true, hls_manifest_timeout: 60000, hls_retry_timeout: 60000}; }
            L.Player.runas(L.Storage.field('player_iptv'));
            L.Player.play(data(channel));
            L.Player.playlist(collection.map(data));
            L.Player.callback(parent);
        }, parent);
    }
    function open(controller) { origin = controller || 'menu'; if (xhr) cancel(); home(); }
    function init() {
        if (ready || dead || !root.Lampa) return;
        L = root.Lampa; ready = true;
        var icon = '<svg viewBox="0 0 24 24"><path fill="currentColor" d="M3 4h18v14H3V4zm2 2v10h14V6H5zm3 14h8v2H8z"/></svg>';
        menu = $('<li class="menu__item selector"><div class="menu__ico">' + icon + '</div><div class="menu__text">Локальное IPTV</div></li>');
        menu.on('hover:enter', function () { open('menu'); });
        $('.menu .menu__list').eq(0).append(menu);
        L.SettingsApi.addComponent({component: 'local_iptv', name: 'Локальное IPTV', icon: icon});
        L.SettingsApi.addParam({component: 'local_iptv', param: {name: prefix + 'open', type: 'button'},
            field: {name: 'Открыть IPTV', description: 'M3U напрямую · без аккаунта CUB'}, onChange: function () { open('settings_component'); }});
    }
    function app(event) { if (event.type === 'ready') init(); }
    root.LampaLocalIPTV = {version: VERSION, open: open, parse: parse,
        getStatus: function () { return {version: VERSION, channels: channels.length, loading: !!xhr, error: lastError}; },
        destroy: function () {
            dead = true; cancel(); if (menu) menu.remove();
            if (L && L.Listener) L.Listener.remove('app', app);
        }};
    if (root.appready) init();
    else if (root.Lampa) root.Lampa.Listener.follow('app', app);
}(typeof window !== 'undefined' ? window : globalThis));
