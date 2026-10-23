"""Current-map spatial data adapter. Standard library only; no LLM, network or server."""
from pathlib import Path
import argparse, hashlib, heapq, json, math, re

class SpatialRepository:
    def __init__(self, directory=None):
        self.directory=Path(directory) if directory else Path(__file__).resolve().parents[1]
        self.model=json.loads((self.directory/'fire_sandbox_spatial_model.json').read_text(encoding='utf8'))
        self.pois={p['id']:p for p in self.model['pois']}
        self.entities={e['id']:e for group in ['pois','areas','roads','nodes'] for e in self.model[group]}
        self.redirects=self.model['id_redirects']
        self.aliases={}
        for name,ids in self.model['alias_index'].items():
            for i in ids:
                if i not in self.aliases.setdefault(self.normalize(name),[]):self.aliases[self.normalize(name)].append(i)
        actual=hashlib.sha256((self.directory/self.model['source']['file']).read_bytes()).hexdigest()
        if actual!=self.model['source']['sha256']:raise ValueError('Basemap SHA-256 mismatch')

    @staticmethod
    def normalize(text):
        text=re.sub(r'\s+','',str(text)).lower()
        digits={'一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9','十':'10'}
        return re.sub(r'([一二三四五六七八九十])(?=号楼|号罐|号储罐|栋)',lambda m:digits[m[1]],text)

    def canonical_id(self,entity_id):
        # Current mapping is one-hop; guard future versions against cycles.
        seen=set()
        while entity_id in self.redirects:
            if entity_id in seen:raise ValueError('ID redirect cycle')
            seen.add(entity_id);entity_id=self.redirects[entity_id]
        return entity_id

    def find(self,name,entity_type=None):
        key=self.canonical_id(name)
        ids=[key] if key in self.entities else self.aliases.get(self.normalize(name),[])
        return [self.entities[i] for i in ids if entity_type is None or self.entities[i]['entity_type']==entity_type]

    def within(self,area_id):
        area_id=self.canonical_id(area_id);out=[]
        for p in self.pois.values():
            parent=p['parent_id'];seen=set()
            while parent:
                if parent in seen:raise ValueError('Area hierarchy cycle')
                seen.add(parent)
                if parent==area_id:out.append(p);break
                parent=self.entities[parent].get('parent_id')
        return out

    @staticmethod
    def direction(a,b):
        # a relative to b, not the reverse.
        dx,dy=a[0]-b[0],a[1]-b[1]
        if math.hypot(dx,dy)<1e-8:return None
        k=int((math.degrees(math.atan2(dy,dx))+22.5)%360//45)
        return ['east_of','northeast_of','north_of','northwest_of','west_of','southwest_of','south_of','southeast_of'][k]

    def related(self,reference_id,predicate,road_id=None,target_type=None):
        reference_id=self.canonical_id(reference_id)
        if reference_id not in self.entities:return []
        ids=set()
        if predicate.endswith('_of'):
            center=self.entities[reference_id].get('center')
            if center is not None:ids={p['id'] for p in self.pois.values() if self.direction(p['center'],center)==predicate}
        else:
            for r in self.model['relations']:
                if r['predicate']!=predicate or (road_id and r.get('via_road_id')!=road_id):continue
                if r['subject_id']==reference_id:ids.add(r['object_id'])
                elif r.get('symmetric') and r['object_id']==reference_id:ids.add(r['subject_id'])
        return [p for i,p in sorted(self.pois.items()) if i in ids and i!=reference_id and (not target_type or p['entity_type']==target_type)]

    def query(self,event_id,query):
        result={'event_id':event_id,'status':'invalid','confidence':0.0,'confidence_kind':'heuristic_not_calibrated','location':None,'candidates':[],'evidence':[],'normalized_query':query if isinstance(query,dict) else None,'model_version':self.model['model_version'],'coordinate_system':'LOCAL30x25','unit':'simulation_unit'}
        if not isinstance(event_id,str) or not event_id or not isinstance(query,dict) or query.get('event_type')!='fire':
            result['message']='event_id和event_type=fire必填';return result
        allowed={'event_type','explicit_target','reference','spatial_relation','distance','road_hint','area_hint','nearest','raw_text'}
        if set(query)-allowed:
            result['message']='未知查询字段；禁止由解析器传入坐标或旧distance_m字段';return result
        target=query.get('explicit_target') or {};reference=query.get('reference') or {}
        if not isinstance(target,dict) or not isinstance(reference,dict):result['message']='target/reference须为对象';return result
        if any(x.get(k) is not None and not isinstance(x[k],str) for x in [target,reference] for k in ['poi_id','name_text','target_type']):result['message']='实体引用字段须为字符串';return result
        if any(query.get(k) is not None and not isinstance(query[k],str) for k in ['spatial_relation','road_hint','area_hint','raw_text']):result['message']='关系/提示字段须为字符串';return result
        if 'nearest' in query and not isinstance(query['nearest'],bool):result['message']='nearest须为布尔值';return result
        typ=target.get('target_type')
        if typ and typ not in ['Tank','Building','Facility']:result['message']='未知目标类型';return result
        if any(set(x)-{'poi_id','name_text','target_type'} for x in [target,reference]):result['message']='target/reference含未知字段';return result
        predicate={'opposite':'across_road','adjacent_to':'adjacent',**{k:k+'_of' for k in ['north','south','east','west','northeast','northwest','southeast','southwest']}}.get(query.get('spatial_relation'),query.get('spatial_relation'))
        if predicate not in [None,'across_road','near','adjacent','north_of','south_of','east_of','west_of','northeast_of','northwest_of','southeast_of','southwest_of']:
            result['message']='未知空间关系';return result
        distance=query.get('distance')
        if distance is not None and (not isinstance(distance,dict) or distance.get('unit')!='simulation_unit' or not isinstance(distance.get('value'),(int,float)) or isinstance(distance.get('value'),bool) or not math.isfinite(distance['value']) or distance['value']<0):
            result['message']='distance须使用非负仿真单位';return result
        source=target.get('poi_id') or target.get('name_text');ref_entities=[];candidates=[];scope=False
        if source:
            found=self.find(source)
            candidates=[p for p in found if p['id'] in self.pois]
            if any(p['id'] not in self.pois for p in found):scope=True
            result['evidence'].append('名称/旧ID归一化检索：'+source)
        elif predicate:
            refname=reference.get('poi_id') or reference.get('name_text')
            if not refname:
                result.update(status='ambiguous',message='缺少报告人位置或参照实体，不能把报告人当作着火目标');return result
            ref_entities=self.find(refname)
            if len(ref_entities)>1:result.update(status='ambiguous',message='参照实体存在歧义');return result
            if not ref_entities:result.update(status='not_found',message='参照实体不在当前模型');return result
            hint=query.get('road_hint');road_id=None
            if hint:
                match=self.find(hint,'Road')
                if len(match)!=1:result.update(status='not_found' if not match else 'ambiguous',message='道路提示无法唯一匹配');return result
                road_id=match[0]['id']
            candidates=self.related(ref_entities[0]['id'],predicate,road_id,typ)
            result['evidence'].append(f"参照{ref_entities[0]['id']}，关系{predicate}"+(f'，道路{road_id}' if road_id else ''))
        elif query.get('area_hint'):
            found=self.find(query['area_hint']);area_ids=[a['id'] for a in found if a['id'] not in self.pois and 'geometry' in a and a['geometry']['type']=='Polygon']
            candidates=[p for aid in area_ids for p in self.within(aid)];scope=bool(area_ids)
            result['evidence'].append('区域提示仅形成候选范围，不生成区域中心火点')
        else:
            result.update(status='ambiguous',message='没有可用的目标或空间约束');return result
        if query.get('area_hint') and (source or predicate):
            matches=self.find(query['area_hint']);area_ids=[a['id'] for a in matches if a['entity_type'] in ['Region','Green Area','Pavement']]
            ids={p['id'] for aid in area_ids for p in self.within(aid)};candidates=[p for p in candidates if p['id'] in ids]
        candidates=[p for p in candidates if not typ or p['entity_type']==typ]
        if distance is not None:
            if len(ref_entities)!=1:result.update(status='invalid',message='距离约束需要唯一参照');return result
            tol=distance.get('tolerance',.5)
            if not isinstance(tol,(int,float)) or not math.isfinite(tol) or tol<0:result['message']='距离容差非法';return result
            candidates=[p for p in candidates if abs(math.dist(p['center'],ref_entities[0]['center'])-distance['value'])<=tol]
        unique={p['id']:p for p in candidates};candidates=list(unique.values())
        if ref_entities:
            candidates.sort(key=lambda p:(math.dist(p['center'],ref_entities[0]['center']),p['id']))
            if query.get('nearest') and len(candidates)>1 and math.dist(candidates[1]['center'],ref_entities[0]['center'])-math.dist(candidates[0]['center'],ref_entities[0]['center'])>1e-6:
                candidates=candidates[:1];result['evidence'].append('依据显式nearest修饰词选取最近候选')
        if scope:
            result.update(status='ambiguous',confidence=.3,message='只确定区域或道路范围，location保持null')
        elif not candidates:
            result.update(status='not_found',message='当前约束下未匹配到POI')
        elif len(candidates)==1:
            result.update(status='located',confidence=.99 if source else .85)
            p=candidates[0];result['location']={'poi_id':p['id'],'name':p['name'],'x':p['center'][0],'y':p['center'][1],'area_id':p['parent_id']}
            result['evidence'].append('坐标直接读取当前版本规范POI，未由语言模型生成')
        else:result.update(status='ambiguous',confidence=.5,message='多个合理候选，不强行给出唯一坐标')
        result['candidates']=[{'poi_id':p['id'],'name':p['name'],'x':p['center'][0],'y':p['center'][1],'score':1.0 if len(candidates)==1 else .5} for p in candidates]
        return result

    def shortest_path(self,start,end,mode='motor_vehicle'):
        if mode not in ['motor_vehicle','pedestrian']:raise ValueError('Unknown routing mode')
        g=json.loads((self.directory/f'RoadGraph_{mode}.json').read_text());adj={n['id']:[] for n in g['nodes']}
        for e in g['edges']:
            if mode not in e['allowed_modes']:raise ValueError('Mode violation in graph')
            adj[e['from_node']].append((e['to_node'],e));adj[e['to_node']].append((e['from_node'],e))
        if start not in adj or end not in adj:return None
        heap=[(0,start,[],[start])];dist={start:0}
        while heap:
            cost,n,es,ns=heapq.heappop(heap)
            if cost>dist[n]+1e-9:continue
            if n==end:return {'mode':mode,'node_ids':ns,'edge_ids':es,'length':round(cost,6),'unit':'simulation_unit'}
            for nxt,e in adj[n]:
                total=cost+e['length']
                if total<dist.get(nxt,float('inf')):dist[nxt]=total;heapq.heappush(heap,(total,nxt,es+[e['id']],ns+[nxt]))
        return None

if __name__=='__main__':
    cli=argparse.ArgumentParser();cli.add_argument('--name');cli.add_argument('--query-json');cli.add_argument('--event-id',default='demo-001');args=cli.parse_args();repo=SpatialRepository()
    result=repo.query(args.event_id,json.loads(args.query_json)) if args.query_json else repo.find(args.name) if args.name else {'model_version':repo.model['model_version'],'pois':len(repo.pois)}
    print(json.dumps(result,ensure_ascii=False,indent=2))
