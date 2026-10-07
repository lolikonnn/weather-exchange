"""本地服务端点冒烟测试：逐个打一遍所有 /api/* 与静态资源。"""
import json
import sys
import io
import urllib.request
import urllib.error

sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
BASE = 'http://127.0.0.1:8765'
PATHS = [
    '/api/health',
    '/api/cma/now?st=59493',
    '/api/cma/view?st=59493',
    '/api/cma/hourly?st=59493',
    '/api/cma/now?st=54511&ttl=60',
    '/api/cn/snapshot?code=101010100',
    '/api/cn/forecast?code=101010100',
    '/api/cn/calendar?code=101010100&ym=202610',
    '/api/cn/full?code=101010100',
    '/api/cn/search?q=%E6%9D%AD%E5%B7%9E',
    '/api/om/v1/forecast?latitude=39.9&longitude=116.4&current=temperature_2m',
    '/data/cities.json',
    '/js/api.js',
    '/js/app.js',
    '/js/chart.js',
    '/js/util.js',
    '/js/indicators.js',
    '/js/astro.js',
    '/css/app.css',
    '/vendor/echarts.min.js',
    '/',
]

fail = 0
for p in PATHS:
    url = BASE + p
    try:
        with urllib.request.urlopen(url, timeout=45) as r:
            body = r.read()
            n = len(body)
            head = ''
            if p.endswith('.json') or p.startswith('/api/'):
                try:
                    o = json.loads(body.decode('utf-8'))
                    head = json.dumps(o, ensure_ascii=False)[:150]
                except Exception as e:
                    head = '<not json: %s> %s' % (e, body[:100])
            print('%-52s %s %7d  %s' % (p, r.status, n, head))
    except urllib.error.HTTPError as e:
        fail += 1
        print('%-52s HTTP %s  %s' % (p, e.code, e.read()[:160]))
    except Exception as e:
        fail += 1
        print('%-52s ERR %s: %s' % (p, type(e).__name__, e))

print('\n失败 %d / %d' % (fail, len(PATHS)))
