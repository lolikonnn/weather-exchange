import sys, io, os, json
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve_cities as R

d = json.load(open(R.OUT, encoding='utf-8'))
cs = d['cities']
no = [c['name'] for c in cs if not c.get('cma')]
print('无站号 %d 城:' % len(no))
print('  ' + '、'.join(no))
print()

# 候选站号：气象局大站（直辖市/省会/重点城市）
CAND = {
    '上海': ['58367', '58362', '58361'],
    '重庆': ['57516', '57517', '57518'],
    '深圳': ['59493'],
    '厦门': ['59234'],
    '青岛': ['54857'],
    '大连': ['54662'],
    '宁波': ['58562'],
    '苏州': ['58357'],
    '无锡': ['58354'],
    '温州': ['58659'],
    '香港': ['45007', '45004', 'HKO'],
    '乌鲁木齐': ['51463'],
}
for name, ids in CAND.items():
    prov = next((c['prov'] for c in cs if c['name'] == name), '')
    for cid in ids:
        v = R.cma_verify(cid, name, prov)
        print('%-8s %-10s %s' % (name, cid, v if v else '-- 不匹配'))
