export function fixture(height = 2603, lazy = false, delayedBatches = 0) {
  const rows = Array.from(
    { length: height },
    (_, y) =>
      `<div style="height:1px;background:rgb(${y % 256},${Math.floor(y / 256)},127)"></div>`,
  ).join("");
  return `<!doctype html><html><head><meta charset="utf-8"><title>Long screenshot test</title><style>
    html { scroll-behavior: smooth; } body { margin:0; }
    #pattern { display:block;position:relative;width:100%;height:${height}px; }
    #fixed { position:fixed;top:0;right:0;width:80px;height:40px;background:#ff00ff; }
    #footer { position:fixed;bottom:0;right:0;width:80px;height:80px;background:#ff8800; }
    #sticky { position:sticky;top:0;height:31px;background:#00ffff; }
    </style></head><body><div id="sticky">Sticky heading</div><div id="pattern" data-height="${height}">${rows}</div>${delayedBatches ? '<footer style="height:1200px;background:#7850c8"></footer><span id="loading" style="position:absolute;left:100px;width:200px;height:30px;background:red">加载中...</span>' : ""}<div id="fixed"></div><div id="footer"></div><script>
    window.scrollTo({top:333,behavior:'instant'});
    ${
      lazy
        ? `window.addEventListener('scroll',function loadMore(){
      if(scrollY<innerHeight)return;window.removeEventListener('scroll',loadMore);
      setTimeout(()=>{const pattern=document.querySelector('#pattern');
        for(let y=${height};y<${height + 400};y++){const row=document.createElement('div');row.style.cssText='height:1px;background:rgb('+(y%256)+','+Math.floor(y/256)+',127)';pattern.append(row);}
        pattern.style.height='${height + 400}px';
      },200);
    });`
        : ""
    }
    ${
      delayedBatches
        ? `
    {let batches=0, pending=false, rows=${height};
    const loader=document.querySelector('#loading');
    const place=()=>loader.style.top=(31+rows-30)+'px';place();
    window.addEventListener('scroll',()=>{
      if(pending||batches>=${delayedBatches}||scrollY+innerHeight<rows+31)return;
      pending=true;loader.style.visibility='visible';
      setTimeout(()=>{
        const pattern=document.querySelector('#pattern');
        for(let y=rows;y<rows+900;y++){const row=document.createElement('div');row.style.cssText='height:1px;background:rgb('+(y%256)+','+Math.floor(y/256)+',127)';pattern.append(row);}
        rows+=900;pattern.style.height=rows+'px';batches++;pending=false;place();
        if(batches===${delayedBatches})loader.remove();
      },2600);
    });}
    `
        : ""
    }
    </script></body></html>`;
}
