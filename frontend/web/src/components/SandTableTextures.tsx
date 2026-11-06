import { memo } from 'react';
import models from '../../../../city_scene/assets/physical-model-atlas.png';
import materials from '../../../../city_scene/assets/physical-material-atlas.png';
import foliage from '../../../../city_scene/assets/physical-foliage-atlas.png';

export const SandTableDefs=memo(function SandTableDefs(){
  return <defs>
    <filter id="sand-grass-tone" colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values=".826 0 0 0 0  0 1.206 0 0 0  0 0 3 0 0  0 0 0 1 0"/></filter>
    <filter id="sand-tree-tone" colorInterpolationFilters="sRGB"><feColorMatrix type="matrix" values=".9 0 0 0 0  0 1.05 0 0 0  0 0 1.35 0 0  0 0 0 1 0"/></filter>
    {[['asphalt',0,180],['pavement',1,110],['grass',2,160]].map(([name,index,size])=><pattern key={name} id={`sand-${name}`} width={size} height={size} patternUnits="userSpaceOnUse">
      {name==='asphalt'&&<rect width={size} height={size} fill="#3b3c3b"/>}
      {name==='grass'&&<rect width={size} height={size} fill="#38782a"/>}
      <svg width={size} height={size} viewBox={`${Number(index)*724} 0 724 724`} preserveAspectRatio="none" filter={name==='grass'?'url(#sand-grass-tone)':undefined} opacity={name==='asphalt'?.3:name==='grass'?.4:1}><image href={materials} width="2172" height="724"/></svg>
    </pattern>)}
    {Array.from({length:8},(_,i)=><symbol key={i} id={`physical-model-${i}`} viewBox={`${i%4*362} ${Math.floor(i/4)*362} 362 362`} preserveAspectRatio="none"><image href={models} width="1448" height="1086"/></symbol>)}
    {[0,1,3,2].map((cell,i)=><symbol key={i+8} id={`physical-model-${i+8}`} viewBox={`${cell%2*640} ${Math.floor(cell/2)*640} 640 640`} preserveAspectRatio="none"><image href={foliage} width="1280" height="1280" filter={i<2?'url(#sand-tree-tone)':undefined}/></symbol>)}
  </defs>;
});
