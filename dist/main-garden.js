import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { createEnvironment } from './environment-garden.js?v=16';
import { createFirstPerson } from './first-person-dissolve.js?v=16';
import { rooms } from './rooms-building2.js?v=16';
import { modelScale, sourceHeightOffset, modelPosition, buildingYOffset, groundY, rainShelter } from './building-placement.js?v=16';
import { createWalkDissolve } from './walk-dissolve.js?v=16';
import { createOutdoorZone, indoorDoor, doorIndoorSpawn, isWithinDoorTrigger } from './walk-zones.js?v=17';
import { createWindowRain } from './window-rain.js?v=17';
import { createGlassPanes } from './glass-panes.js?v=17';
import { createExteriorRain } from './weather/exterior-rain.js?v=15';
import { createWetGround } from './weather/wet-ground.js';
import { createWetMaterials } from './weather/wet-materials.js';
import { createRainRenderer } from './weather/rain-renderer.js';

const $ = id => document.getElementById(id);
const reducedMotion = matchMedia('(prefers-reduced-motion: reduce)').matches;
let renderer,scene,camera,controls,environment,model,frame,transition=null;
let minutes=900,weather='clear',timePlaying=false,night=0,loaded=false;
let ambient,sun,fill,interiorLights=[],windows=[],elapsed=0,last=0,firstPerson;
let toastTimer,audioContext,audioGain,audioFilter,soundOn=false;
let walkDissolve,floorVeil,currentFloor=1,windowRain,outdoorZone,doorAction=null;
let exteriorRain,wetGround,wetMaterials,rainRenderer;
const rainAccentLights=[];
const movementStops=[];
const dayColor=new THREE.Color(),backgroundColor=new THREE.Color();

function toast(message){$('toast').textContent=message;$('toast').classList.add('show');clearTimeout(toastTimer);toastTimer=setTimeout(()=>$('toast').classList.remove('show'),2300);}
function showError(error){cancelFloorDissolve();console.error(error);$('loading').hidden=true;$('error').hidden=false;$('error-message').textContent=error.message?.includes('WebGL')?'이 브라우저에서 3D 그래픽을 사용할 수 없어요. 하드웨어 가속을 켜거나 최신 브라우저에서 열어주세요.':'건물 파일을 불러오는 중 문제가 생겼어요. 연결을 확인한 뒤 다시 시도해주세요.';}

try{
  renderer=new THREE.WebGLRenderer({antialias:true,alpha:false,powerPreference:'high-performance'});
  renderer.setPixelRatio(Math.min(devicePixelRatio,innerWidth<=700?1.35:1.5));
  renderer.shadowMap.enabled=true;renderer.shadowMap.type=THREE.PCFSoftShadowMap;
  renderer.outputColorSpace=THREE.SRGBColorSpace;renderer.toneMapping=THREE.ACESFilmicToneMapping;
  renderer.toneMappingExposure=1.12;
  $('scene').appendChild(renderer.domElement);
  floorVeil=document.createElement('div');floorVeil.id='floor-dissolve';floorVeil.setAttribute('aria-hidden','true');
  floorVeil.style.cssText='position:fixed;inset:0;background:#000;opacity:0;pointer-events:none;z-index:100';
  document.body.appendChild(floorVeil);
  walkDissolve=createWalkDissolve({reducedMotion,onBusy:setFloorBusy,onOpacity:opacity=>floorVeil.style.opacity=String(opacity),onComplete:()=>{
    if(firstPerson?.active&&!document.querySelector('dialog[open]'))renderer.domElement.focus({preventScroll:true});
  }});
  renderer.domElement.setAttribute('aria-label','건물 3D 디오라마');
  renderer.domElement.tabIndex=0;
  firstPerson=createFirstPerson({canvas:renderer.domElement,onExit:exitIndoor,onFloorChange:floor=>{
    currentFloor=floor;
    const outside=floor==='outside';
    document.body.classList.toggle('outdoor',outside);
    $('room-name').textContent=outside?'정원 산책':floor===1?'1층 카페':'2층 창가';
    $('walk-mode').textContent=outside?'실외 1인칭':'실내 1인칭';
    $('floor-options').hidden=outside;
    $('indoor-ui').setAttribute('aria-label',outside?'실외 1인칭 조작':'실내 1인칭 조작');
    $('movement-pad').setAttribute('aria-label',outside?'정원 이동':'실내 이동');
    renderer.domElement.setAttribute('aria-label',outside?'실외 1인칭 풍경. 드래그로 시선을 돌리고 WASD 또는 방향키로 걸어 다니세요. 문 가까이에서 카페로 들어갈 수 있어요. Escape로 전체 시점으로 돌아갑니다.':'실내 1인칭 풍경. 드래그로 시선을 돌리고 WASD 또는 방향키로 이동하세요. 문 가까이에서 밖으로 나갈 수 있어요. Escape로 전체 시점으로 돌아갑니다.');
    document.querySelectorAll('[data-floor]').forEach(button=>button.setAttribute('aria-pressed',String(Number(button.dataset.floor)===floor)));
  }});
  renderer.domElement.addEventListener('webglcontextlost',e=>{e.preventDefault();cancelAnimationFrame(frame);showError(new Error('WebGL context lost'));});
  scene=new THREE.Scene();scene.background=new THREE.Color(0xe6e9d9);scene.fog=new THREE.FogExp2(0xe6e9d9,.008);
  camera=new THREE.OrthographicCamera(-15,15,15,-15,.1,180);
  controls=new OrbitControls(camera,renderer.domElement);controls.enableDamping=true;controls.dampingFactor=.065;
  controls.enablePan=false;controls.minZoom=.65;controls.maxZoom=3.5;controls.minPolarAngle=.12;controls.maxPolarAngle=Math.PI*.485;controls.autoRotateSpeed=.45;
  controls.addEventListener('start',()=>{transition=null;document.querySelectorAll('[data-view]').forEach(b=>{b.classList.remove('active');b.setAttribute('aria-pressed','false');});});
  ambient=new THREE.HemisphereLight(0xfff6da,0x697457,2.8);scene.add(ambient);
  sun=new THREE.DirectionalLight(0xffe2ae,3.3);sun.position.set(-12,19,11);sun.castShadow=true;
  sun.shadow.mapSize.set(2048,2048);Object.assign(sun.shadow.camera,{left:-18,right:18,top:18,bottom:-18,near:.5,far:70});sun.shadow.bias=-.0004;sun.shadow.normalBias=.025;sun.shadow.radius=3;scene.add(sun);scene.add(sun.target);
  fill=new THREE.DirectionalLight(0xcce3f0,.8);fill.position.set(8,12,-10);scene.add(fill);
  environment=createEnvironment(THREE,scene,{width:11.4,depth:12,height:5.4,pathStart:3.1,groundY});
  const weatherOptions={width:environment.width,depth:environment.depth,groundY,shelter:rainShelter,buildingYOffset,reducedMotion,mobile:innerWidth<=700};
  exteriorRain=createExteriorRain(THREE,scene,weatherOptions);
  wetGround=createWetGround(THREE,scene,weatherOptions);
  wetMaterials=createWetMaterials(THREE,{reducedMotion});wetMaterials.applyEnvironment(environment.group);
  rainRenderer=createRainRenderer(THREE,renderer,scene,{rain:exteriorRain,ground:wetGround,panes:()=>windows,mobile:innerWidth<=700,
    renderScene:(activeCamera,delta)=>windowRain?windowRain.render(activeCamera,delta,{enabled:firstPerson?.active&&weather==='rain'}):renderer.render(scene,activeCamera)});
  for(const [color,x,y,z,power] of [[0xffbd79,0,1.85,2.9,12],[0x8ecfe5,3.7,3.4,-1.5,5]]){
    const light=new THREE.PointLight(color,0,10,2);light.position.set(x,y+buildingYOffset,z);light.userData.rainPower=power;scene.add(light);rainAccentLights.push(light);
  }
  resize();setView('orbit',false);updateTime();
  new GLTFLoader().load('./assets/building2.glb',gltf=>{
    try{
      model=new THREE.Group();
      // Normalize the GLB export origin inside the shared placement parent.
      gltf.scene.position.y-=sourceHeightOffset;
      gltf.scene.traverse(obj=>{
        if(!obj.isMesh)return;
        // Keep the revision's authored materials and local transforms intact.
        obj.castShadow=true;obj.receiveShadow=true;
      });
      model.add(gltf.scene);
      const glassMaterial=new THREE.MeshPhysicalMaterial({color:0xe7f0e5,roughness:.075,metalness:0,transparent:true,opacity:.18,transmission:.62,thickness:.025,ior:1.45,reflectivity:.3,clearcoat:1,clearcoatRoughness:.08,side:THREE.DoubleSide,depthWrite:false});
      windows=createGlassPanes(THREE,model,glassMaterial);
      model.scale.setScalar(modelScale);model.position.copy(modelPosition);scene.add(model);
      outdoorZone=createOutdoorZone(THREE,environment,model);
      wetMaterials.applyModel(model);
      windowRain=createWindowRain(THREE,renderer,scene,windows,{reducedMotion,onError:error=>{
        console.error('Window rain:',error);toast('창문 빗방울을 불러오지 못했어요. 잠시 후 새로고침해주세요.');
      }});
      const bulbMaterial=new THREE.MeshStandardMaterial({color:0xfff0d0,emissive:0xffc37b,emissiveIntensity:.4,roughness:.5});
      // Front view: +X is right and +Z is forward, clear of the counter sign.
      for(const [x,y,z] of [[1.25,3.36,-2.25],[.2,6.35,-2.8]]){
        const light=new THREE.PointLight(0xffc17a,0,7,2);light.position.set(x,y-.13,z);model.add(light);interiorLights.push(light);
        const bulb=new THREE.Mesh(new THREE.CylinderGeometry(.25,.25,.055,24),bulbMaterial);bulb.position.set(x,y,z);model.add(bulb);
      }
      loaded=true;$('enter-indoor').disabled=false;$('enter-indoor').title='건물 안에서 창문 너머를 둘러보세요';$('load-bar').style.width='100%';$('load-progress').textContent='준비 완료';$('loading').classList.add('loaded');setTimeout(()=>$('loading').hidden=true,550);
      updateTime();
    }catch(error){showError(error);}
  },event=>{const progress=event.total?Math.round(event.loaded/event.total*100):Math.min(95,Math.round(event.loaded/10495444*100));$('load-bar').style.width=progress+'%';$('load-progress').textContent='건물 불러오는 중 · '+progress+'%';},showError);
  frame=requestAnimationFrame(animate);
}catch(error){showError(error);}

function resize(){
  const width=innerWidth,height=innerHeight,aspect=width/height,mobile=width<=620;
  const half=mobile?Math.max(15,12.4/aspect):height<650?12.6:12.3;
  camera.left=-half*aspect;camera.right=half*aspect;camera.top=half;camera.bottom=-half;
  camera.clearViewOffset();
  if(!mobile)camera.setViewOffset(width,height,-width*.11,height*.05,width,height);
  else camera.setViewOffset(width,height,0,height*.005,width,height);
  camera.updateProjectionMatrix();firstPerson?.resize(width,height);renderer.setSize(width,height);
}

function enterIndoor(floor=1){
  if(!loaded||!firstPerson){toast('건물을 불러온 뒤 들어갈 수 있어요');return;}
  cancelFloorDissolve();
  transition=null;controls.enabled=false;firstPerson.enter(floor,rooms[floor]);
  document.body.classList.add('indoor');$('indoor-ui').hidden=false;$('enter-indoor').setAttribute('aria-pressed','true');
  renderer.domElement.focus({preventScroll:true});
  toast('문 가까이에서 밖으로 나갈 수 있어요');
}

function exitIndoor(){
  cancelFloorDissolve();
  firstPerson?.exit();if(controls)controls.enabled=true;
  document.body.classList.remove('indoor','outdoor');$('indoor-ui').hidden=true;$('door-prompt').hidden=true;doorAction=null;$('enter-indoor').setAttribute('aria-pressed','false');
  renderer?.domElement.setAttribute('aria-label','건물 3D 디오라마');
  $('enter-indoor').focus({preventScroll:true});
}

function setFloorBusy(busy){
  firstPerson?.setSuspended(busy);
  if(floorVeil)floorVeil.style.pointerEvents=busy?'auto':'none';
  $('indoor-ui').setAttribute('aria-busy',String(busy));
  document.querySelectorAll('[data-floor],[data-move],#door-action').forEach(button=>button.disabled=busy);
  movementStops.forEach(stop=>stop());
  if(busy){$('door-prompt').hidden=true;doorAction=null;}
}

function cancelFloorDissolve(){
  walkDissolve?.cancel();
}

function switchFloor(floor){
  if(!firstPerson?.active||currentFloor==='outside'||walkDissolve?.active||floor===currentFloor||!rooms[floor])return;
  walkDissolve.start(()=>firstPerson.setFloor(floor,rooms[floor]));
}

function availableDoorAction(){
  if(!firstPerson?.active||walkDissolve?.active||document.querySelector('dialog[open]'))return null;
  const door=currentFloor===1?indoorDoor:currentFloor==='outside'?outdoorZone?.door:null;
  if(!door)return null;
  const position=firstPerson.camera.position;
  return isWithinDoorTrigger(position,door)?(currentFloor===1?'leave':'enter'):null;
}

function updateDoorPrompt(){
  const action=availableDoorAction();
  if(action===doorAction)return;
  doorAction=action;$('door-prompt').hidden=!action;
  if(action){
    $('door-caption').textContent=action==='leave'?'입구 · 정원으로 이어지는 문':'입구 · 작은 카페';
    $('door-action').textContent=action==='leave'?'외부로 나가기 ↗':'카페로 들어가기 ↗';
  }
}

function useDoor(){
  const action=availableDoorAction();
  if(!action||!outdoorZone)return;
  walkDissolve.start(()=>{
    const outside=action==='leave';
    firstPerson.setFloor(outside?'outside':1,outside?outdoorZone:doorIndoorSpawn);
  });
}

function setView(view,animateView=true){
  if(!camera)return;
  const target=new THREE.Vector3(0,1.5,0);
  const positions={orbit:new THREE.Vector3(17,14,23),front:new THREE.Vector3(1,9,29),top:new THREE.Vector3(1,31,.8)};
  const destination=positions[view]||positions.orbit;
  if(animateView&&!reducedMotion)transition={start:performance.now(),from:camera.position.clone(),to:destination,fromTarget:controls.target.clone(),target,zoom:camera.zoom};
  else{camera.position.copy(destination);controls.target.copy(target);camera.zoom=1;camera.updateProjectionMatrix();controls.update();}
  document.querySelectorAll('[data-view]').forEach(button=>{const active=button.dataset.view===view;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});
}

function updateTime(){
  const hour=minutes/60;
  const daylight=Math.max(0,Math.sin((hour-6)/12*Math.PI));
  const twilight=Math.max(0,1-Math.abs(hour-18)/1.8)+Math.max(0,1-Math.abs(hour-6)/1.4);
  night=1-THREE.MathUtils.smoothstep(daylight,0,.35);
  dayColor.set(0xe6e9d9);
  if(weather==='cloudy')dayColor.set(0xc9d4cc);
  if(weather==='rain')dayColor.set(0x96aeb7);
  backgroundColor.copy(dayColor).lerp(new THREE.Color(0xe7bda1),Math.min(1,twilight)*(weather==='rain'?.18:.65)).lerp(new THREE.Color(weather==='rain'?0x172c3b:0x253e46),night);
  scene.background.copy(backgroundColor);scene.fog.color.copy(backgroundColor);
  scene.fog.density=weather==='rain'?.018+night*.008:.008;
  const cloudy=weather==='clear'?1:weather==='cloudy'?.48:.25;
  sun.intensity=(.12+3.4*daylight)*cloudy;
  sun.color.set(0xffedcd).lerp(new THREE.Color(0xffa164),Math.min(1,twilight));
  const angle=(hour-6)/12*Math.PI;sun.position.set(Math.cos(angle)*19,4+Math.max(0,Math.sin(angle))*22,10);
  ambient.intensity=.55+2*daylight;ambient.color.set(0xe5eff1).lerp(new THREE.Color(0x97b9cf),night);
  if(weather==='rain')ambient.intensity*=.77;
  ambient.groundColor.set(0x768460).lerp(new THREE.Color(0x465e57),night);
  fill.intensity=.3+daylight*.45;
  fill.color.set(weather==='rain'?0x9fcada:0xcce3f0);
  renderer.toneMappingExposure=weather==='rain'?1.02+night*.06:1.07+night*.23;
  interiorLights.forEach((light,index)=>{light.intensity=(index===0?7:9)*night+.22;});
  rainAccentLights.forEach(light=>{light.intensity=weather==='rain'?(.05+night)*light.userData.rainPower:0;});
  document.body.classList.toggle('night',night>.55);
  $('time').value=String(Math.round(minutes));
  const h=Math.floor(minutes/60),m=Math.floor(minutes%60);$('time-display').textContent=String(h).padStart(2,'0')+':'+String(m).padStart(2,'0');
  $('time').setAttribute('aria-valuetext',$('time-display').textContent);
  $('mood').textContent=hour<5||hour>=21?'별빛이 머무는 밤':hour<8?'하루가 시작되는 아침':hour<12?'싱그러운 오전':hour<16?'느긋한 오후':hour<19.5?'노을이 내려앉는 시간':'불빛이 반가운 저녁';
  $('weather-caption').textContent={clear:night>.5?'고요한 밤하늘':'맑은 하늘',cloudy:'구름 낀 하늘',rain:'촉촉한 빗소리'}[weather];
  if(audioFilter)audioFilter.frequency.setTargetAtTime(weather==='rain'?2100:600,audioContext.currentTime,1);
  if(audioGain&&soundOn)audioGain.gain.setTargetAtTime(weather==='rain'?.16:.06,audioContext.currentTime,.5);
}

function setWeather(key){weather=key;environment?.setWeather?.(key);document.querySelectorAll('[data-weather]').forEach(button=>{const active=button.dataset.weather===key;button.classList.toggle('active',active);button.setAttribute('aria-pressed',String(active));});updateTime();}

function animate(timestamp){
  frame=requestAnimationFrame(animate);
  if(document.hidden){last=timestamp;return;}
  const delta=Math.min(.05,(timestamp-last)/1000||0);last=timestamp;elapsed+=delta;
  if(timePlaying){minutes=(minutes+delta*2.4)%1440;updateTime();}
  if(transition){const t=Math.min(1,(timestamp-transition.start)/1000),k=t*t*(3-2*t);camera.position.lerpVectors(transition.from,transition.to,k);controls.target.lerpVectors(transition.fromTarget,transition.target,k);camera.zoom=THREE.MathUtils.lerp(transition.zoom,1,k);camera.updateProjectionMatrix();if(t===1)transition=null;}
  if(firstPerson?.active)firstPerson.update(delta);else controls.update();
  walkDissolve?.update(delta);
  updateDoorPrompt();
  environment?.update(reducedMotion?0:elapsed,reducedMotion?0:delta,weather,night);
  const activeCamera=firstPerson?.active?firstPerson.camera:camera;
  const rainState={enabled:weather==='rain',night,camera:activeCamera};
  exteriorRain?.update(reducedMotion?0:elapsed,delta,rainState);
  wetGround?.update(reducedMotion?0:elapsed,delta,rainState);
  wetMaterials?.update(reducedMotion?0:elapsed,delta,rainState);
  if(rainRenderer)rainRenderer.render(activeCamera,delta,rainState);
  else renderer.render(scene,activeCamera);
}

async function toggleSound(){
  try{
    if(!audioContext){
      const AudioContext=window.AudioContext||window.webkitAudioContext;if(!AudioContext)throw new Error('Audio unavailable');
      audioContext=new AudioContext();audioGain=audioContext.createGain();audioGain.gain.value=0;audioGain.connect(audioContext.destination);
      audioFilter=audioContext.createBiquadFilter();audioFilter.type='lowpass';audioFilter.frequency.value=600;audioFilter.Q.value=.5;audioFilter.connect(audioGain);
      const length=audioContext.sampleRate*4,buffer=audioContext.createBuffer(1,length,audioContext.sampleRate),data=buffer.getChannelData(0);let previous=0;
      for(let i=0;i<length;i++){previous=(previous+Math.random()*.04-.02)/1.02;data[i]=previous*3;}
      const noise=audioContext.createBufferSource();noise.buffer=buffer;noise.loop=true;noise.connect(audioFilter);noise.start();
      const lfo=audioContext.createOscillator(),lfoGain=audioContext.createGain();lfo.frequency.value=.16;lfoGain.gain.value=180;lfo.connect(lfoGain);lfoGain.connect(audioFilter.frequency);lfo.start();
    }
    await audioContext.resume();soundOn=!soundOn;audioGain.gain.setTargetAtTime(soundOn?(weather==='rain'?.16:.06):0,audioContext.currentTime,.5);
    $('sound').setAttribute('aria-pressed',String(soundOn));$('sound').setAttribute('aria-label',soundOn?'자연 소리 끄기':'자연 소리 켜기');toast(soundOn?'자연 소리를 켰어요':'자연 소리를 껐어요');
  }catch{toast('이 브라우저에서는 소리를 재생할 수 없어요.');}
}

addEventListener('resize',()=>{if(renderer&&camera)resize();});
$('time').addEventListener('input',event=>{minutes=Number(event.target.value);updateTime();});
document.querySelectorAll('[data-time]').forEach(button=>button.addEventListener('click',()=>{minutes=Number(button.dataset.time);updateTime();}));
document.querySelectorAll('[data-weather]').forEach(button=>button.addEventListener('click',()=>setWeather(button.dataset.weather)));
document.querySelectorAll('[data-view]').forEach(button=>button.addEventListener('click',()=>setView(button.dataset.view)));
$('time-play').addEventListener('click',()=>{timePlaying=!timePlaying;$('time-play').textContent=timePlaying?'Ⅱ':'▶';$('time-play').setAttribute('aria-pressed',String(timePlaying));$('time-play').setAttribute('aria-label',timePlaying?'시간 자동 흐름 끄기':'시간 자동 흐름 켜기');toast(timePlaying?'10분 동안 하루가 흘러요':'이 순간에 잠깐 머물러요');});
$('rotate').addEventListener('click',()=>{controls.autoRotate=!controls.autoRotate;$('rotate').setAttribute('aria-pressed',String(controls.autoRotate));$('rotate').setAttribute('aria-label',controls.autoRotate?'자동 회전 끄기':'자동 회전 켜기');});
$('sound').addEventListener('click',toggleSound);
$('fullscreen').addEventListener('click',async()=>{try{if(!document.fullscreenElement)await document.documentElement.requestFullscreen();else await document.exitFullscreen();}catch{toast('전체 화면은 별도 브라우저에서 사용할 수 있어요.');}});
document.addEventListener('fullscreenchange',()=>$('fullscreen').setAttribute('aria-pressed',String(!!document.fullscreenElement)));
$('reset').addEventListener('click',()=>{if(firstPerson?.active)exitIndoor();minutes=900;setWeather('clear');setView('orbit');controls.autoRotate=false;$('rotate').setAttribute('aria-pressed','false');$('rotate').setAttribute('aria-label','자동 회전 켜기');if(timePlaying)$('time-play').click();toast('처음의 오후 풍경으로 돌아왔어요');});
$('enter-indoor').addEventListener('click',()=>enterIndoor(1));
$('exit-indoor').addEventListener('click',exitIndoor);
$('door-action').addEventListener('click',useDoor);
document.querySelectorAll('[data-floor]').forEach(button=>button.addEventListener('click',()=>switchFloor(Number(button.dataset.floor))));
document.querySelectorAll('[data-move]').forEach(button=>{
  let pointer=null,timer;
  const stop=()=>{clearTimeout(timer);firstPerson?.setMove(button.dataset.move,false);button.classList.remove('pressed');pointer=null;};
  movementStops.push(stop);
  button.addEventListener('pointerdown',event=>{event.preventDefault();pointer=event.pointerId;button.setPointerCapture?.(pointer);firstPerson?.setMove(button.dataset.move,true);button.classList.add('pressed');});
  button.addEventListener('pointerup',stop);button.addEventListener('pointercancel',stop);button.addEventListener('lostpointercapture',stop);
  button.addEventListener('click',event=>{if(event.detail===0){clearTimeout(timer);firstPerson?.setMove(button.dataset.move,true);timer=setTimeout(stop,180);}});
});
$('info').addEventListener('click',()=>$('about').showModal());$('close-info').addEventListener('click',()=>$('about').close());$('about').addEventListener('click',e=>{if(e.target===$('about')){const r=$('about').getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)$('about').close();}});
$('reload').addEventListener('click',()=>location.reload());
document.addEventListener('visibilitychange',()=>{if(audioContext){if(document.hidden)audioContext.suspend();else if(soundOn)audioContext.resume().catch(()=>{});}});
addEventListener('pagehide',event=>{if(!event.persisted){rainRenderer?.dispose();exteriorRain?.dispose();wetGround?.dispose();wetMaterials?.dispose();windowRain?.dispose();}});
