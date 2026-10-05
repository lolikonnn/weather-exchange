import sys, io, os, json, urllib.parse
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve_cities as R

QS = ['徐家汇', '徐汇', '宝山', '浦东', '嘉定', '松江', '闵行', '崇明', '奉贤', '金山', '青浦',
      '沙坪坝', '渝北', '江北区', '九龙坡', '南岸', '北碚', '巴南', '万州', '涪陵', '永川',
      '上海', '上海市', '重庆', '重庆市', '天津市', '北京市']

for q in QS:
    try:
        d = json.loads(R.fetch('https://weather.cma.cn/api/autocomplete?q=' + urllib.parse.quote(q)))
        items = d.get('data') or []
    except Exception as e:
        print('%-8s ERR %s' % (q, e))
        continue
    hits = []
    for it in items:
        p = str(it).split('|')
        if len(p) >= 4 and p[3].strip() == '中国':
            hits.append('%s=%s(%s)' % (p[0], p[1], p[2]))
        if len(hits) >= 4:
            break
    print('%-8s %s' % (q, ' | '.join(hits) if hits else '(无中国结果)'))
