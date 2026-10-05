import sys, io, os
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding='utf-8')
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import resolve_cities as R

print('PURE_ID pattern:', R.PURE_ID.pattern)
for name, prov in [('北京', '北京市'), ('上海', '上海市'), ('天津', '天津市'),
                   ('重庆', '重庆市'), ('长春', '吉林省'), ('沈阳', '辽宁省'),
                   ('承德', '河北省'), ('吕梁', '山西省')]:
    print('cma_find(%s) ->' % name, R.cma_find(name, prov))

print()
print('cma_view(54511):', R.cma_view('54511'))
print('cma_verify(54511,北京,北京市):', R.cma_verify('54511', '北京', '北京市'))
print('autocomplete(北京):', R.cma_autocomplete('北京')[:3])
