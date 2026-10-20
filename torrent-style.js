(function ()
{
    'use strict';

    var KEY = 'LampaTorrentStyle';
    var VERSION = '1.0.1';
    var STYLE_ID = 'lampa-torrent-style-css';
    var ATTRIBUTE = 'data-lts';
    var config = {
        seedsLow: 5,
        seedsHigh: 20,
        bitrateMedium: 20,
        bitrateHigh: 50,
        sizeLowGB: 5,
        sizeMediumGB: 10,
        sizeHighGB: 25,
        updateDelay: 80
    };

    // При повторной загрузке освобождаем наблюдатель и таймер предыдущей версии.
    if (window[KEY] && typeof window[KEY].destroy === 'function')
    {
        window[KEY].destroy();
    }

    var observer = null;
    var timer = null;
    var destroyed = false;
    var started = false;
    var palette = {
        red: ['#ff7384', 'rgba(255,115,132,.12)'],
        amber: ['#ffd080', 'rgba(255,208,128,.12)'],
        green: ['#63dcb0', 'rgba(99,220,176,.12)'],
        blue: ['#80c9ff', 'rgba(128,201,255,.12)'],
        purple: ['#c2a1ff', 'rgba(194,161,255,.12)']
    };

    function each(nodes, callback)
    {
        for (var i = 0; i < nodes.length; i++)
        {
            callback(nodes[i]);
        }
    }

    function text(element)
    {
        return element ? (element.textContent || '').replace(/\u00a0|\u202f/g, ' ').trim() : '';
    }

    function number(value)
    {
        var match = value.replace(/(\d)\s+(?=\d)/g, '$1').match(/\d+(?:[.,]\d+)?/);
        return match ? parseFloat(match[0].replace(',', '.')) : null;
    }

    function sizeGB(value)
    {
        var match = value.match(/(\d+(?:[.,]\d+)?)\s*(KiB|MiB|GiB|TiB|KB|MB|GB|TB|КБ|МБ|ГБ|ТБ)\b/i);
        // Для кириллических единиц граница слова в старых движках не подходит.
        if (!match) match = value.match(/(\d+(?:[.,]\d+)?)\s*(КБ|МБ|ГБ|ТБ)/i);
        if (!match) return null;
        var unit = match[2].toLowerCase();
        var amount = parseFloat(match[1].replace(',', '.'));
        if (/^(t|т)/.test(unit)) return amount * 1024;
        if (/^(g|г)/.test(unit)) return amount;
        if (/^(m|м)/.test(unit)) return amount / 1024;
        return amount / (1024 * 1024);
    }

    function mark(element, color)
    {
        if (color) element.setAttribute(ATTRIBUTE, color);
        else element.removeAttribute(ATTRIBUTE);
    }

    function resolution(value)
    {
        if (/\b(8K|4320p?)\b/i.test(value)) return ['8K', 'purple'];
        if (/\b(4K|UHD|2160p?)\b/i.test(value)) return ['4K', 'purple'];
        if (/\b(2K|QHD|1440p?)\b/i.test(value)) return ['2K', 'blue'];
        if (/\b(FHD|Full\s*HD|1080[pi]?)\b/i.test(value)) return ['FHD', 'green'];
        if (/\b(HD|720p?)\b/i.test(value)) return ['HD', 'amber'];
        if (/\b(SD|480p?|576[pi]?)\b/i.test(value)) return ['SD', 'red'];
        return null;
    }

    function updateItem(item)
    {
        each(item.querySelectorAll('.torrent-item__seeds span'), function (element)
        {
            var value = number(text(element));
            mark(element, value === null ? null : value < config.seedsLow ? 'red' : value >= config.seedsHigh ? 'green' : 'amber');
        });
        each(item.querySelectorAll('.torrent-item__grabs span'), function (element)
        {
            mark(element, number(text(element)) === null ? null : 'blue');
        });
        each(item.querySelectorAll('.torrent-item__bitrate span'), function (element)
        {
            var value = number(text(element));
            mark(element, value === null ? null : value >= config.bitrateHigh ? 'red' : value >= config.bitrateMedium ? 'amber' : 'blue');
        });
        each(item.querySelectorAll('.torrent-item__size'), function (element)
        {
            var value = sizeGB(text(element));
            mark(element, value === null ? null : value >= config.sizeHighGB ? 'red' : value >= config.sizeMediumGB ? 'amber' : value >= config.sizeLowGB ? 'blue' : 'green');
        });

        var existing = item.querySelectorAll('.torrent-item__ffprobe .m-resolution');
        each(existing, function (element)
        {
            var result = resolution(text(element));
            mark(element, result ? result[1] : null);
        });

        // Если клиент не вывел разрешение, берём только явное обозначение из названия.
        var badge = item.querySelector('[data-lts-resolution]');
        var details = item.querySelector('.torrent-item__details');
        var title = item.querySelector('.torrent-item__title');
        var inferred = resolution(text(title));
        if (!existing.length && inferred && details)
        {
            if (!badge)
            {
                badge = document.createElement('span');
                badge.setAttribute('data-lts-resolution', 'true');
                details.appendChild(badge);
            }
            badge.textContent = inferred[0];
            mark(badge, inferred[1]);
        }
        else if (badge && badge.parentNode)
        {
            badge.parentNode.removeChild(badge);
        }
    }

    function observe()
    {
        if (observer && !destroyed)
        {
            observer.observe(document.body, { childList: true, subtree: true, characterData: true });
        }
    }

    function update()
    {
        timer = null;
        if (destroyed) return;
        // Собственные изменения не должны повторно запускать обновление.
        if (observer) observer.disconnect();
        try
        {
            each(document.querySelectorAll('.torrent-item'), updateItem);
        }
        finally
        {
            observe();
        }
    }

    function schedule()
    {
        if (destroyed || timer !== null) return;
        timer = setTimeout(update, config.updateDelay);
    }

    function relevant(node)
    {
        if (!node) return false;
        var element = node.nodeType === 1 ? node : node.parentNode;
        if (!element) return false;
        if (element.querySelector && element.querySelector('.torrent-item')) return true;
        while (element && element !== document.body)
        {
            if (element.classList && element.classList.contains('torrent-item')) return true;
            element = element.parentNode;
        }
        return false;
    }

    function start()
    {
        if (started || destroyed) return;
        started = true;
        var selector = '.torrent-item [' + ATTRIBUTE + ']';
        var css = selector + '{display:inline-flex;align-items:center;justify-content:center;box-sizing:border-box;min-height:1.7em;padding:.12em .42em;border:1px solid currentColor;border-radius:.45em;font-size:.9em;font-weight:700;line-height:1.2;white-space:nowrap;vertical-align:middle;font-variant-numeric:tabular-nums;}';
        for (var color in palette)
        {
            if (Object.prototype.hasOwnProperty.call(palette, color))
            {
                css += '.torrent-item [' + ATTRIBUTE + '="' + color + '"]{color:' + palette[color][0] + '!important;background:' + palette[color][1] + '!important;}';
            }
        }
        css += '.torrent-item [data-lts-resolution]{margin-left:.4em;}';
        var style = document.createElement('style');
        style.id = STYLE_ID;
        style.textContent = css;
        document.head.appendChild(style);

        if (window.MutationObserver)
        {
            observer = new window.MutationObserver(function (mutations)
            {
                for (var i = 0; i < mutations.length; i++)
                {
                    var mutation = mutations[i];
                    if (relevant(mutation.target))
                    {
                        schedule();
                        return;
                    }
                    for (var j = 0; j < mutation.addedNodes.length; j++)
                    {
                        if (relevant(mutation.addedNodes[j]))
                        {
                            schedule();
                            return;
                        }
                    }
                }
            });
        }
        update();
    }

    function destroy()
    {
        destroyed = true;
        clearTimeout(timer);
        if (observer) observer.disconnect();
        document.removeEventListener('DOMContentLoaded', start, false);
        var style = document.getElementById(STYLE_ID);
        if (style && style.parentNode) style.parentNode.removeChild(style);
        each(document.querySelectorAll('[data-lts-resolution]'), function (element)
        {
            if (element.parentNode) element.parentNode.removeChild(element);
        });
        each(document.querySelectorAll('[' + ATTRIBUTE + ']'), function (element)
        {
            element.removeAttribute(ATTRIBUTE);
        });
    }

    window[KEY] = { version: VERSION, config: config, refresh: schedule, destroy: destroy };
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, false);
    else start();
})();
