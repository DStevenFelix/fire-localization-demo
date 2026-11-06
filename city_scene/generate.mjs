import { readFileSync, writeFileSync } from 'node:fs';

// 所有扩展几何从网格及原图真实出口生成，禁止改写原始数据。
const polygon = (x, y, w, h) => ({ type: 'Polygon', coordinates: [[[x,y],[x+w,y],[x+w,y+h],[x,y+h],[x,y]]] });
const line = points => ({ type: 'LineString', coordinates: points });
const object = (id, name, type, category, center, geometry) => ({ id, name, aliases: [name + '附近'], type, category, center, geometry, description: `${name}，城市扩展区空间参照物`, can_post: true, coordinate_system: 'CITY90x75' });
const xs = [3,15,25,65,77,87], ys = [3,12,20,55,63.5,72];
const roads = [], buildings = [], scene_pois = [], traffic_routes = [], pedestrian_paths = [];
function road(name, points, original_connection) {
  const a=points[0], b=points.at(-1), id=`EXT-R-${String(roads.length+1).padStart(3,'0')}`;
  roads.push({...object(id,name,'road','urban_road',[(a[0]+b[0])/2,(a[1]+b[1])/2],line(points)), centerline: line(points),
    bidirectional:true, vehicle_allowed:true, width:3.2, sidewalk_width:0.7,
    lanes:{forward:1,backward:1}, lane_directions:[{from:a,to:b,count:1},{from:b,to:a,count:1}], ...(original_connection?{original_connection}: {})});
}
xs.forEach((x,i)=>road(['西滨路','文景路','西环路','东环路','科创路','东滨路'][i],[[x,3],[x,72]]));
ys.forEach((y,i)=>road(['南滨大道','嘉禾大道','南环大道','北环大道','文澜大道','北滨大道'][i],[[3,y],[87,y]]));
const original=JSON.parse(readFileSync(new URL('../fire_poi/RoadGraph_motor_vehicle.json',import.meta.url),'utf8'));
for (const n of original.nodes) {
  const [x,y]=n.center, global=[x+30,y+25];
  let end;
  if(x===0)end=[25,global[1]]; else if(x===30)end=[65,global[1]];
  else if(y===0)end=[global[0],20]; else if(y===25)end=[global[0],55]; else continue;
  road(`园区${n.id}连接路`,[global,end],{node_id:n.id,local_center:n.center,global_center:global,road_ids:[...new Set(original.edges.filter(e=>e.from_node===n.id||e.to_node===n.id).map(e=>e.road_id))]});
}
const nodeByPoint=new Map();
function node(p) {
  const key=p.join(',');
  if(!nodeByPoint.has(key))nodeByPoint.set(key,{...object(`EXT-J-${String(nodeByPoint.size+1).padStart(3,'0')}`,'城市路口','intersection','road_junction',p,{type:'Point',coordinates:p}),road_ids:[],edge_ids:[]});
  return nodeByPoint.get(key);
}
const on=(p,r)=>{const [a,b]=r.centerline.coordinates; return Math.abs((p[0]-a[0])*(b[1]-a[1])-(p[1]-a[1])*(b[0]-a[0]))<1e-7 && p.every((v,i)=>v>=Math.min(a[i],b[i])-1e-7&&v<=Math.max(a[i],b[i])+1e-7);};
for(const r of roads) for(const p of r.centerline.coordinates)node(p);
for(const a of roads)for(const b of roads){const [p,q]=a.centerline.coordinates,[u,v]=b.centerline.coordinates; if(p[0]===q[0]&&u[1]===v[1]){const c=[p[0],u[1]];if(on(c,a)&&on(c,b))node(c);}}
const edges=[];
for(const r of roads){
  const ns=[...nodeByPoint.values()].filter(n=>on(n.center,r)).sort((a,b)=>a.center[0]-b.center[0]||a.center[1]-b.center[1]);
  r.node_ids=ns.map(n=>n.id); r.edge_ids=[];
  ns.forEach(n=>n.road_ids.push(r.id));
  for(let i=1;i<ns.length;i++){
    const a=ns[i-1],b=ns[i],id=`EXT-E-${String(edges.length+1).padStart(3,'0')}`;
    edges.push({id,road_id:r.id,from_node:a.id,to_node:b.id,bidirectional:true,vehicle_allowed:true,geometry:line([a.center,b.center])});
    r.edge_ids.push(id);a.edge_ids.push(id);b.edge_ids.push(id);
    // 步行路径在道路外侧并避开路口，不穿越车道。
    const h=a.center[1]===b.center[1],length=h?b.center[0]-a.center[0]:b.center[1]-a.center[1];
    if(length>5.2)for(const side of [-1,1]){
      const start=h?[a.center[0]+2.5,a.center[1]+side*1.95]:[a.center[0]+side*1.95,a.center[1]+2.5];
      const end=h?[b.center[0]-2.5,b.center[1]+side*1.95]:[b.center[0]+side*1.95,b.center[1]-2.5];
      pedestrian_paths.push({id:`EXT-W-${pedestrian_paths.length+1}`,road_id:r.id,width:.5,geometry:line([start,end]),speed:.18+(pedestrian_paths.length%4)*.025,phase:(pedestrian_paths.length*.173)%1});
    }
  }
}
for(let i=0;i<xs.length-1;i++)for(let j=0;j<ys.length-1;j++){
  const x=xs[i],y=ys[j],w=xs[i+1]-x,h=ys[j+1]-y;
  if(i===2&&j===2)continue;
  const block=(i*5+j),park=block%7===0;
  if(i===1&&j===1)continue; // 消防站独立预留街区。
  if(park){scene_pois.push(object(`EXT-P-${scene_pois.length+1}`,'文景口袋公园'+block,'park','public_space',[x+w/2,y+h/2],polygon(x+2.8,y+2.8,w-5.6,h-5.6)));}
  else {
    const cols=w>20?8:2, rows=h>20?7:1;
    for(let c=0;c<cols;c++)for(let r=0;r<rows;r++){
      const slotW=(w-5.8)/cols,slotH=(h-5.8)/rows;
      const bw=Math.min(slotW*(.66+((block+c+r)%3)*.045),3.1),bh=Math.min(slotH*(.58+((block+c*2+r)%4)*.035),2.1);
      const bx=x+2.9+c*slotW+(slotW-bw)/2,by=y+2.9+r*slotH+(slotH-bh)/2+(rows>1?(c%2-.5)*.28:0),category=['residential','commercial','public_facility'][block%3];
      const label={residential:'嘉禾住宅',commercial:'云港商务',public_facility:'城市公共服务'}[category];
      buildings.push({...object(`EXT-B-${String(buildings.length+1).padStart(3,'0')}`,label+(buildings.length+1)+'号楼','building',category,[bx+bw/2,by+bh/2],polygon(bx,by,bw,bh)),floors:2+(block+c+r)%4,model_variant:(block+c+r*3)%8,plot_geometry:polygon(bx-.3,by-.35,bw+.6,bh+.7),entrance:[bx+bw/2,by-.35]});
    }
  }
}
// 矩形街区的双向车道路线由道路网格派生，拐角始终处于路口范围内。
for(let i=0;i<xs.length-1;i++)for(let j=0;j<ys.length-1;j++){
  if(i===2&&j===2)continue;
  for(const dir of [-1,1]){
    const offset=dir*.8, a=xs[i]+offset,b=xs[i+1]-offset,c=ys[j]+offset,d=ys[j+1]-offset;
    let points=[[a,c],[b,c],[b,d],[a,d],[a,c]];if(dir===-1)points=points.reverse();
    traffic_routes.push({id:`EXT-T-${traffic_routes.length+1}`,road_ids:[roads[i].id,roads[i+1].id,roads[6+j].id,roads[7+j].id],geometry:line(points),speed:.9+(traffic_routes.length%5)*.13,phase:(traffic_routes.length*.217)%1});
  }
}
const reserve={...object('EXT-P-FIRE','消防站预留地','reserve','public_facility',[20,16],polygon(17.45,14.4,5.1,3.2)),reserved_use:'fire_station_future',vehicle_capacity:3,access:{road_id:roads[8].id,entrance:[20,17.6],road_connection:[20,20]},parking_spaces:[18.35,20,21.65].map(x=>({center:[x,16],geometry:polygon(x-.55,14.8,1.1,2.4)}))};
// 近邻街区沿原图真实边缘布置，避开全部出口，不形成装饰性边框。
const neighbours=[...[33,37,41,49].flatMap(y=>[[28.65,y],[61.35,y]]),...[40,44.5,49].flatMap(x=>[[x,51.35],[x,23.65]])];
neighbours.forEach((center,i)=>{
  const [x,y]=center,w=1.5+(i%3)*.15,h=1.2+(i%2)*.2;
  buildings.push({...object(`EXT-B-${String(buildings.length+1).padStart(3,'0')}`,'园区邻里'+(i+1)+'号楼','building','residential',center,polygon(x-w/2,y-h/2,w,h)),floors:2,model_variant:i%8,plot_geometry:polygon(x-w/2-.16,y-h/2-.18,w+.32,h+.36),entrance:[x,y-h/2-.18]});
});
// 原图仅叠加动态对象：从已有机动车路口取环路，从步行专用道路取独立步行路径。
const sw=original.nodes.find(n=>n.id==='J03').center,ne=original.nodes.find(n=>n.id==='J02').center;
for(const dir of [-1,1])for(let i=0;i<4;i++){
  const offset=dir*.45,a=sw[0]+30+offset,b=ne[0]+30-offset,c=sw[1]+25+offset,d=ne[1]+25-offset;
  let points=[[a,c],[b,c],[b,d],[a,d],[a,c]];if(dir===-1)points=points.reverse();
  traffic_routes.push({id:`EXT-T-${traffic_routes.length+1}`,road_ids:['R-01','R-02','R-03','R-04'],geometry:line(points),speed:.85+i*.09,phase:i*.24+(dir===1?.08:0)});
}
const originalRoads=JSON.parse(readFileSync(new URL('../fire_poi/Roads.json',import.meta.url),'utf8')).roads;
for(const r of originalRoads.filter(r=>['R-08','R-09','R-10','R-11'].includes(r.id))){
  const points=r.centerline.coordinates.map(p=>[p[0]+30,p[1]+25]);
  for(const index of [0,points.length-1]){const adjacent=points[index===0?1:index-1],p=points[index],distance=Math.hypot(adjacent[0]-p[0],adjacent[1]-p[1]),t=Math.min(.6/distance,.2);points[index]=p.map((v,i)=>v+(adjacent[i]-v)*t);}
  for(let i=0;i<2;i++)pedestrian_paths.push({id:`EXT-W-${pedestrian_paths.length+1}`,road_id:r.id,width:.3,geometry:line(points),speed:.16+i*.03,phase:i*.41});
}
const nodes=[...nodeByPoint.values()];
nodes.forEach(n=>{n.name=`${n.road_ids.map(id=>roads.find(r=>r.id===id).name).join(' / ')}路口`; n.junction_type=n.edge_ids.length>=4?'cross':n.edge_ids.length===3?'T':'boundary';});
// 装饰也由空间数据生成；不在原图内部布置任何新模型，不覆盖原始边界。
const landscape={trees:[],flowerbeds:[],paths:[]};
for(let i=0;i<xs.length-1;i++)for(let j=0;j<ys.length-1;j++){
  if(i===2&&j===2)continue;if(i===1&&j===1)continue;
  const x=xs[i],y=ys[j],w=xs[i+1]-x,h=ys[j+1]-y;
  landscape.paths.push({geometry:line([[x+w/2,y+2.5],[x+w/2,y+h-2.5]]),width:.25});
  landscape.paths.push({geometry:line([[x+2.5,y+2.55],[x+w-2.5,y+2.55]]),width:.3});
}
const box=geometry=>{const ps=geometry.coordinates[0];return [Math.min(...ps.map(p=>p[0])),Math.min(...ps.map(p=>p[1])),Math.max(...ps.map(p=>p[0])),Math.max(...ps.map(p=>p[1]))];};
const boxes=[...buildings.map(b=>b.plot_geometry),reserve.geometry].map(box);
const distanceTo=(p,a,b)=>{const dx=b[0]-a[0],dy=b[1]-a[1],t=Math.max(0,Math.min(1,((p[0]-a[0])*dx+(p[1]-a[1])*dy)/(dx*dx+dy*dy)));return Math.hypot(p[0]-a[0]-dx*t,p[1]-a[1]-dy*t);};
let seed=123456789;const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
for(let x=.35;x<90;x+=.47)for(let y=.35;y<75;y+=.47){
  const p=[x+(random()-.5)*.28,y+(random()-.5)*.28],size=.43+random()*.25;
  if(p[0]>30-size*.5&&p[0]<60+size*.5&&p[1]>25-size*.5&&p[1]<50+size*.5)continue;
  if(boxes.some(([a,b,c,d])=>p[0]>a-.2&&p[0]<c+.2&&p[1]>b-.2&&p[1]<d+.2))continue;
  if(roads.some(r=>distanceTo(p,...r.centerline.coordinates)<r.width/2+r.sidewalk_width+size*.45))continue;
  if(landscape.paths.some(r=>distanceTo(p,...r.geometry.coordinates)<r.width/2+size*.45))continue;
  const nearRoad=roads.some(r=>distanceTo(p,...r.centerline.coordinates)<3.2);
  if(random()<(nearRoad?.88:.72))landscape.trees.push({center:p,size,variant:random()>.18?8:9,rotation:Math.floor(random()*360)});
  else landscape.flowerbeds.push({center:p,size:.44+random()*.35,variant:random()>.2?11:10,rotation:Math.floor(random()*360)});
}
const scene={scene_config:{name:'云港新区城市应急态势',version:'1.1.0',extent:[0,0,90,75],scene_pixels:{width:3939,height:3150}},coordinate_system:{id:'CITY90x75',origin:'southwest',x_axis:'east',y_axis:'north',unit:'simulation_unit',extent:[0,0,90,75]},original_map_placement:{coordinate_system:'LOCAL30x25',offset:[30,25],extent:[30,25,60,50],pixels:{x:1313,y:1050,width:1313,height:1050},source:'fire_poi/map_original.png',sha256:'300f7e00b2d285e98c146e2e5f43846e862e5cd3bec59377846c275a84449eea'},buildings,roads,intersections:nodes.filter(n=>n.edge_ids.length>=3).map(n=>n.id),nodes,edges,pedestrian_paths,traffic_routes,scene_pois,fire_station_reserve:reserve,landscape};
writeFileSync(new URL('city_scene.json',import.meta.url),JSON.stringify(scene,null,2)+'\n');
console.log(JSON.stringify({buildings:buildings.length,roads:roads.length,nodes:nodes.length,edges:edges.length,vehicles:traffic_routes.length,pedestrians:pedestrian_paths.length,trees:landscape.trees.length,flowerbeds:landscape.flowerbeds.length}));
