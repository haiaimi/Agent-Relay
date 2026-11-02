(function installRelayGlass(){
  const root=document.documentElement;
  const wallpaper=document.getElementById('glassWallpaper');
  if(!wallpaper || typeof createLayerGlassRenderer!=='function' || typeof renderBackdropOnGpu!=='function')return;
  const renderer=createLayerGlassRenderer();
  root.dataset.glassRenderer='webgl2';
  let request=0,activeUrls=null,resizeTimer=0;
  const source=fetch('/wallpaper.jpg').then(response=>{
    if(!response.ok)throw new Error('Wallpaper unavailable');
    return response.blob();
  });
  const sceneSize=()=>{const rect=wallpaper.getBoundingClientRect();return {width:rect.width,height:rect.height}};
  let renderedSize=sceneSize();
  async function rebuild(){
    const sequence=++request;
    let bitmap,outerUrl,innerUrl;
    try{
      bitmap=await createImageBitmap(await source);
      outerUrl=await renderBackdropOnGpu(bitmap,1,12);
      innerUrl=await renderBackdropOnGpu(bitmap,1,24);
      if(sequence!==request){URL.revokeObjectURL(outerUrl);URL.revokeObjectURL(innerUrl);return}
      const previous=activeUrls;activeUrls={outerUrl,innerUrl};
      root.style.setProperty('--lq-backdrop','url("'+outerUrl+'")');
      root.style.setProperty('--lq-inner-backdrop','url("'+innerUrl+'")');
      wallpaper.style.backgroundImage='url("'+outerUrl+'")';
      renderer.setScene();
      root.dataset.glassReady='1';
      if(previous)setTimeout(()=>{URL.revokeObjectURL(previous.outerUrl);URL.revokeObjectURL(previous.innerUrl)},600);
    }catch(error){
      if(outerUrl)URL.revokeObjectURL(outerUrl);
      if(innerUrl)URL.revokeObjectURL(innerUrl);
      if(sequence===request){renderer.setScene();root.dataset.glassReady='fallback'}
    }finally{bitmap?.close?.()}
  }
  window.addEventListener('resize',()=>{
    clearTimeout(resizeTimer);
    resizeTimer=setTimeout(()=>{
      const next=sceneSize();
      if(Math.abs(next.width-renderedSize.width)<3&&Math.abs(next.height-renderedSize.height)<3)return;
      renderedSize=next;rebuild();
    },350);
  },{passive:true});
  rebuild();
})();
