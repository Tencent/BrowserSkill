import { page } from "../../../lib/fixtures.mjs";

// Synthetic click-release/move/click-release grid, modeled on the reported interaction.
export const rangeMarkup = `<style>body{margin:30px;font:16px sans-serif}.grid{display:flex;user-select:none}.grid-item{width:50px;height:40px;border:1px solid #888;cursor:pointer}.selected{background:#69c}</style>
<div role="group" aria-label="Time range"><div>16:00 — 16:30 — 17:00 — 17:30</div><div class="grid">${[14, 15, 16].map((i) => `<div class="grid-item" id="slot-${i}" data-index="${i}"></div>`).join("")}</div></div><output id="selection-result"></output>`;
export const rangeScript = `
window.rangeEvents=[];window.rangeState={start:null,end:null,preview:[],completed:false};
const cells=[...document.querySelectorAll('.grid-item')];
function preview(index){const lo=Math.min(rangeState.start,index),hi=Math.max(rangeState.start,index);cells.forEach(el=>el.classList.toggle('selected',Number(el.dataset.index)>=lo&&Number(el.dataset.index)<=hi));rangeState.preview=cells.filter(el=>el.classList.contains('selected')).map(el=>Number(el.dataset.index));}
for(const type of ['mousedown','mouseup','mousemove','click'])document.addEventListener(type,e=>rangeEvents.push({type,index:e.target.dataset?.index,buttons:e.buttons,trusted:e.isTrusted}),true);
for(const el of cells){el.onclick=()=>{const i=Number(el.dataset.index);if(rangeState.start===null){rangeState.start=i;preview(i);}else{rangeState.end=i;preview(i);rangeState.completed=true;document.querySelector('#selection-result').textContent='Selected '+rangeState.preview.join(',');}};el.onmousemove=e=>{if(rangeState.start!==null&&!rangeState.completed&&e.buttons===0)preview(Number(el.dataset.index));};}
`;

export default {
  id: "range-selection",
  routes: ["/range-selection"],
  render() {
    return page({ title: "Range selection", body: rangeMarkup, script: rangeScript });
  },
};
