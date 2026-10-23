"""Offline validation of this package's data, contracts and deterministic queries."""
from pathlib import Path
from datetime import datetime
import hashlib,json,math
from spatial_repository import SpatialRepository
ROOT=Path(__file__).resolve().parents[1]
def read(name):return json.loads((ROOT/name).read_text(encoding='utf8'))

def validate(value,s,path='$'):
    """Validates only the JSON Schema keywords used by the three bundled contracts."""
    supported={'$schema','$id','title','description','type','const','enum','minimum','maximum','minLength','required','properties','additionalProperties','items','anyOf','allOf','if','then','else','format'}
    assert not set(s)-supported,(path,'unsupported schema keyword')
    kinds={'object':lambda v:isinstance(v,dict),'array':lambda v:isinstance(v,list),'string':lambda v:isinstance(v,str),'number':lambda v:isinstance(v,(int,float)) and not isinstance(v,bool) and math.isfinite(v),'boolean':lambda v:isinstance(v,bool),'null':lambda v:v is None}
    if 'type' in s:
        types=s['type'] if isinstance(s['type'],list) else [s['type']]
        assert any(kinds[t](value) for t in types),(path,'type')
    if 'const' in s:assert type(value) is type(s['const']) and value==s['const'],(path,'const')
    if 'enum' in s:assert any(type(value) is type(v) and value==v for v in s['enum']),(path,'enum')
    if isinstance(value,(int,float)) and not isinstance(value,bool):
        if 'minimum' in s:assert value>=s['minimum'],(path,'minimum')
        if 'maximum' in s:assert value<=s['maximum'],(path,'maximum')
    if isinstance(value,str):
        if 'minLength' in s:assert len(value)>=s['minLength'],(path,'minLength')
        if s.get('format')=='date-time':assert datetime.fromisoformat(value.replace('Z','+00:00')).tzinfo is not None
    if isinstance(value,dict):
        assert all(k in value for k in s.get('required',[])),(path,'required')
        props=s.get('properties',{})
        if s.get('additionalProperties') is False:assert not set(value)-set(props),(path,'additionalProperties')
        for k,v in value.items():
            if k in props:validate(v,props[k],path+'.'+k)
    if isinstance(value,list) and 'items' in s:
        for i,v in enumerate(value):validate(v,s['items'],path+f'[{i}]')
    for sub in s.get('allOf',[]):validate(value,sub,path)
    if 'anyOf' in s:
        good=False
        for sub in s['anyOf']:
            try:validate(value,sub,path);good=True;break
            except (AssertionError,ValueError):pass
        assert good,(path,'anyOf')
    if 'if' in s:
        try:validate(value,s['if'],path);condition=True
        except (AssertionError,ValueError):condition=False
        sub=s.get('then' if condition else 'else')
        if sub:validate(value,sub,path)

def run():
    repo=SpatialRepository(ROOT);m=repo.model;checks=[]
    def check(name,yes):
        assert yes,name;checks.append(name)
    check('29 active POIs',len(repo.pois)==29)
    check('8 tanks',sum(p['entity_type']=='Tank' for p in repo.pois.values())==8)
    check('17 buildings',sum(p['entity_type']=='Building' for p in repo.pois.values())==17)
    check('12 community buildings',sum(p.get('building_use')=='community_building' for p in repo.pois.values())==12)
    check('5 depot ancillary buildings',sum(p.get('building_use')=='tank_area_ancillary' for p in repo.pois.values())==5)
    for old,new in {'U-E-01':'B-E-02','U-E-02':'B-E-03','U-E-03':'B-E-04','U-S-01':'B-S-03','B-D-06':'B-D-05'}.items():
        check('redirect '+old,repo.find(old)[0]['id']==new and old not in repo.pois)
    check('Chinese numeral alias',repo.find('锦安二号楼')[0]['id']=='B-W-02')
    check('NE tank direction',sorted(p['id'] for p in repo.related('A-DEPOT','northeast_of',target_type='Tank'))==['T-NE-01','T-NE-02'])
    check('opposite road candidates',sorted(p['id'] for p in repo.related('B-W-02','across_road','R-03','Tank'))==['T-NW-01','T-NW-02'])
    check('symmetric opposite lookup','B-W-02' in [p['id'] for p in repo.related('T-NW-01','across_road','R-03','Building')])
    walk=read('RoadGraph_pedestrian.json');motor=read('RoadGraph_motor_vehicle.json')
    blocked={'R-08','R-09','R-10','R-11'}
    check('pedestrian roads retained',blocked<={e['road_id'] for e in walk['edges']})
    check('pedestrian roads removed from motor graph',not blocked&{e['road_id'] for e in motor['edges']})
    a=repo.shortest_path('J14','J15','pedestrian');b=repo.shortest_path('J14','J15','motor_vehicle')
    check('motor path does not shortcut west walkway',a is not None and b is not None and b['length']>a['length'])
    check('walk-only node unavailable to motor routing',repo.shortest_path('J10','J11','motor_vehicle') is None)
    check('walk-only ring route available',repo.shortest_path('J10','J11','pedestrian') is not None)
    for p in m['pois']:
        x,y=p['center'];u=x*1312/30;v=(25-y)*1049/25
        check('coordinate bounds '+p['id'],0<=x<=30 and 0<=y<=25)
        check('coordinate inverse '+p['id'],abs(u*30/1312-x)<1e-8 and abs((1049-v)*25/1049-y)<1e-8)
    check('no POI in landscape and pavement regions',not any(p['parent_id'] in ['A-NORTH-GREEN','A-PAVE-SW','A-PAVE-SE'] for p in m['pois']))
    for f,k in [('POI.json','pois'),('Areas.json','areas'),('SpatialRelations.json','relations')]:check('combined equals '+f,read(f)[k]==m[k])
    for k in ['roads','nodes','edges']:check('combined Roads '+k,read('Roads.json')[k]==m[k])
    asc=read('schemas/alert_input.schema.json');qsc=read('schemas/localization_query.schema.json');rsc=read('schemas/localization_result.schema.json')
    for x in read('examples/sample_alerts.json'):validate(x,asc);check('alert contract '+x['event_id'],True)
    queries=read('examples/sample_normalized_queries.json');saved=read('examples/sample_localization_results.json')
    expected={'exact-west':'located','confirmed-east':'located','confirmed-south':'located','legacy-merge':'located','alias-chinese-number':'located','relative-opposite':'ambiguous','area-direction':'ambiguous','only-area':'ambiguous','missing-reference':'ambiguous','unknown-place':'not_found','landscape-not-building':'ambiguous'}
    for x,out in zip(queries,saved):
        validate(x['query'],qsc);actual=repo.query(x['event_id'],x['query']);validate(actual,rsc)
        check('query fixture '+x['event_id'],actual==out and actual['status']==expected[x['event_id']])
        if actual['location']:
            loc=actual['location'];check('result coordinate provenance '+x['event_id'],[loc['x'],loc['y']]==repo.pois[loc['poi_id']]['center'])
        else:check('no fabricated target coordinate '+x['event_id'],actual['status']!='located')
    bad=[{'event_type':'fire','x':20,'y':10},{'event_type':'fire','distance_m':3},{'event_type':'fire','distance':{'value':3,'unit':'m'}},{'event_type':'fire','explicit_target':{'name_text':['wrong']}},{'event_type':'fire','spatial_relation':[]},{'event_type':'fire','nearest':'yes'}]
    for i,q in enumerate(bad):
        check('invalid query rejected '+str(i),repo.query('invalid-'+str(i),q)['status']=='invalid')
        try:validate(q,qsc);rejected=False
        except (AssertionError,ValueError):rejected=True
        check('invalid schema rejected '+str(i),rejected)
    invalid_output=dict(saved[0],status='ambiguous')
    try:validate(invalid_output,rsc);rejected=False
    except (AssertionError,ValueError):rejected=True
    check('ambiguous forbids location',rejected)
    if (ROOT/'CHECKSUMS.sha256').exists():
        for line in (ROOT/'CHECKSUMS.sha256').read_text().splitlines():
            sha,path=line.split('  ',1);assert hashlib.sha256((ROOT/path).read_bytes()).hexdigest()==sha,('checksum',path)
    return {'status':'PASS','checks':len(checks),'check_names':checks,'schema_validation_scope':'bundled_keywords_only_no_external_schema_engine','interoperability_note':'No actual fire server or Socket integration performed'}

if __name__=='__main__':print(json.dumps(run(),ensure_ascii=False,indent=2))
