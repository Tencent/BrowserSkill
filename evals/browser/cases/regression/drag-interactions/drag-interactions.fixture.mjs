import { page } from "../../../lib/fixtures.mjs";

export const dragMarkup = `<style>
body{margin:0;padding:30px;font:16px sans-serif} .row{display:flex;gap:100px;margin:20px 0}
.box{width:100px;height:60px;background:#def;user-select:none;touch-action:none;cursor:grab}
#drop{width:160px;height:80px;border:2px dashed #789} #range{width:300px}
#resize{width:140px;height:70px;border:1px solid} #handle{width:20px;height:20px;cursor:se-resize;background:#789}
#sort{display:flex;gap:60px} #sort>div{width:80px;height:55px;background:#cde;cursor:grab;touch-action:none}
canvas{border:1px solid;touch-action:none} iframe{width:650px;height:350px;border:0}
</style>
<div class="row"><div id="mouse" class="box" aria-label="Mouse box">Mouse box</div><div id="pointer" class="box" aria-label="Pointer box">Pointer box</div><div id="hold" class="box" aria-label="Hold box">Hold box</div></div>
<div class="row"><div id="native" draggable="true" class="box" aria-label="Native card">Native card</div><div id="drop" aria-label="Done" ondragover="event.preventDefault()">Done</div></div>
<input id="range" type="range" min="0" max="100" value="50" aria-label="Volume">
<div id="resize"><div id="handle" aria-label="Resize panel"></div></div>
<div id="sort" role="list"><div id="first" role="listitem">First</div><div id="second" role="listitem">Second</div><div id="third" role="listitem">Third</div></div>
<canvas id="canvas" width="360" height="120" aria-label="Drawing"></canvas>
<svg width="360" height="120"><rect id="svg" x="20" y="10" width="60" height="60" fill="steelblue" style="cursor:grab;touch-action:none" aria-label="Shape"/></svg>
<button id="check">Check drag results</button><output id="result"></output>`;

export const dragScript = `
window.events=[]; window.moved={}; window.held=0; window.drops=0;
for(const type of ['mousedown','mousemove','mouseup','pointerdown','pointermove','pointerup','dragstart','dragover','drop','dragend'])
 document.addEventListener(type,e=>events.push({type,id:e.target.id,trusted:e.isTrusted,buttons:e.buttons,button:e.button,shift:e.shiftKey,x:e.clientX,y:e.clientY}),true);
function installDrag(el,kind,apply,minHold=0){
 let start;
 el.addEventListener(kind+'down',e=>{e.preventDefault();start={x:e.clientX,y:e.clientY,t:performance.now()};if(kind==='pointer')el.setPointerCapture(e.pointerId)});
 window.addEventListener(kind+'move',e=>{if(!start||!e.buttons||performance.now()-start.t<minHold)return;
 const dx=e.clientX-start.x,dy=e.clientY-start.y;window.moved[el.id]={dx,dy};apply(dx,dy,e);});
 window.addEventListener(kind+'up',()=>{if(start)window.held=performance.now()-start.t;start=null});
}
for(const [id,kind,min] of [['mouse','mouse',0],['pointer','pointer',0],['hold','pointer',220]]){
 const el=document.getElementById(id);installDrag(el,kind,(x,y)=>el.style.transform='translate('+x+'px,'+y+'px)',min);
}
installDrag(document.getElementById('handle'),'pointer',(x,y)=>{resize.style.width=(140+x)+'px';resize.style.height=(70+y)+'px'});
let sorted;
for(const el of document.querySelectorAll('#sort>div')){
 el.addEventListener('pointerdown',e=>{e.preventDefault();sorted=el});
 el.addEventListener('pointerup',()=>{if(sorted&&sorted!==el)sort.insertBefore(sorted,el.nextSibling);sorted=null});
}
native.addEventListener('dragstart',e=>e.dataTransfer.setData('text/plain','card-17'));
drop.addEventListener('drop',e=>{e.preventDefault();if(e.dataTransfer.getData('text/plain')==='card-17'){drop.append(native);window.drops++;}});
const canvas=document.getElementById('canvas'),pen=canvas.getContext('2d');
installDrag(canvas,'pointer',(x,y,e)=>{const r=canvas.getBoundingClientRect();pen.fillRect(e.clientX-r.left,e.clientY-r.top,4,4)});
installDrag(document.getElementById('svg'),'pointer',(x,y)=>{svg.setAttribute('x',20+x);svg.setAttribute('y',10+y)});
check.onclick=()=>{const data={drops:window.drops,mouse:window.moved.mouse?.dx??0};
 result.textContent=data.drops===1&&data.mouse>=100?'DRAG-OK':'DRAG-INCOMPLETE';
 window.browserEval?.send('drag.checked',data);};
`;

export default {
  id: "drag-interactions",
  routes: ["/drag-interactions"],
  render() {
    return page({ title: "Drag interactions", body: dragMarkup, script: dragScript });
  },
};
