let loader;
const unsafeCss=value=>/@(?:import|font-face)|(?:https?:|data:|javascript:)/i.test(value)||[...value.matchAll(/url\(([^)]*)\)/gi)].some(m=>!/^['"]?#[\w:.-]+['"]?$/.test(m[1].trim()));
export function safeSvg(source){
  if(typeof source!=='string'||source.length>1_000_000||/<!DOCTYPE|<!ENTITY/i.test(source))throw Error('SVG 内容无效或过大');
  const parsed=new DOMParser().parseFromString(source,'image/svg+xml');if(parsed.querySelector('parsererror')||parsed.documentElement.localName!=='svg'||parsed.querySelectorAll('*').length>8000)throw Error('SVG 格式无效');
  const clean=window.DOMPurify.sanitize(source,{USE_PROFILES:{svg:true,svgFilters:true},FORBID_TAGS:['foreignObject','image','animate','animateMotion','animateTransform','set','a'],RETURN_DOM:false});
  const doc=new DOMParser().parseFromString(clean,'image/svg+xml'),svg=doc.documentElement;if(svg.localName!=='svg')throw Error('SVG 清理失败');
  for(const element of [svg,...svg.querySelectorAll('*')]){
    if(element.localName==='style'&&unsafeCss(element.textContent))element.remove();
    for(const attr of [...element.attributes]){
      const name=attr.localName.toLowerCase(),value=attr.value;
      if(name.startsWith('on')||['href','src'].includes(name)&&!/^#[\w:.-]+$/.test(value)||/url\(/i.test(value)&&unsafeCss(value)||name==='style'&&unsafeCss(value))element.removeAttributeNode(attr);
    }
  }
  svg.setAttribute('xmlns','http://www.w3.org/2000/svg');return new XMLSerializer().serializeToString(svg);
}
async function mermaid(){
  if(!loader)loader=new Promise((resolve,reject)=>{const script=document.createElement('script');script.src='/vendor/mermaid.tiny.js';script.onload=()=>{window.mermaid.initialize({startOnLoad:false,securityLevel:'strict',suppressErrorRendering:true,theme:'default',htmlLabels:false,flowchart:{htmlLabels:false},fontFamily:'Arial, sans-serif',maxTextSize:30000,maxEdges:150});resolve(window.mermaid);};script.onerror=()=>{loader=null;script.remove();reject(Error('图表组件加载失败'));};document.head.append(script);});
  return loader;
}
export function svgCard(source,title='SVG 设计示意'){
  const card=document.createElement('figure');card.className='diagram-card';const img=document.createElement('img'),clean=safeSvg(source),url=URL.createObjectURL(new Blob([clean],{type:'image/svg+xml'}));img.src=url;img.alt=title;img.dataset.objectUrl=url;card.append(img);
  const toolbar=document.createElement('figcaption'),label=document.createElement('span');label.textContent=title;toolbar.append(label);
  const zoom=document.createElement('button');zoom.type='button';zoom.className='quiet';zoom.textContent='放大查看';zoom.onclick=()=>{
    const dialog=document.createElement('dialog');dialog.className='diagram-dialog';const bar=document.createElement('div');bar.className='diagram-controls';const viewport=document.createElement('div');viewport.className='diagram-canvas';const picture=img.cloneNode();picture.removeAttribute('data-object-url');let scale=1;
    for(const [text,fn] of [['−',()=>{scale=Math.max(.25,scale/1.4);picture.style.width=scale*100+'%';}],['＋',()=>{scale=Math.min(6,scale*1.4);picture.style.width=scale*100+'%';}],['关闭',()=>dialog.close()]]){const b=document.createElement('button');b.type='button';b.className='quiet';b.textContent=text;b.onclick=fn;bar.append(b);}viewport.append(picture);dialog.append(bar,viewport);dialog.addEventListener('close',()=>dialog.remove(),{once:true});document.body.append(dialog);dialog.showModal();
  };
  const download=document.createElement('a');download.href=url;download.download='design-review.svg';download.className='button quiet';download.textContent='下载 SVG';toolbar.append(zoom,download);card.append(toolbar);return card;
}
export function enhanceDiagrams(root){
  for(const code of root.querySelectorAll('pre>code.language-svg,pre>code.language-mermaid')){
    const pre=code.parentElement;if(pre.dataset.diagramProcessing)continue;pre.dataset.diagramProcessing='true';const source=code.textContent,svg=code.classList.contains('language-svg');
    void (async()=>{try{
      let content=source;if(!svg){if(source.length>30000)throw Error('图表内容过大');const m=await mermaid();const result=await m.render('diagram-'+crypto.randomUUID().replaceAll('-',''),source);content=result.svg;}
      if(!pre.isConnected)return;const card=svgCard(content,svg?'SVG 设计示意':'设计图表');const details=document.createElement('details'),summary=document.createElement('summary');summary.textContent='查看图表源码';details.append(summary);pre.replaceWith(card);details.append(pre);card.append(details);
    }catch(e){if(!pre.isConnected)return;const error=document.createElement('p');error.className='fine';error.textContent='图表暂未渲染：'+e.message+'。可查看下方源码。';pre.before(error);}})();
  }
}
