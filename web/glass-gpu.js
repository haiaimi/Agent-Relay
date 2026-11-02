// Two separable Gaussian passes, repeated twice. WebGL2 keeps the enlarged
// background blur on the GPU while producing a single raster for every lens.
// Serial jobs cap concurrent WebGL contexts during rapid poster/theme changes.
let backdropGpuQueue=Promise.resolve();
// Match a wide desktop viewport instead of stretching a 900 px blur across it.
// Keep coarse-pointer devices on the smaller texture budget used by iOS.
function backdropRasterDimensions(screenWidth,screenHeight){
  const wideDesktop=screenWidth>=1100&&matchMedia('(pointer: fine)').matches;
  const maxWidth=wideDesktop?2560:900;
  const maxPixels=wideDesktop?3200000:1600000;
  const scale=Math.min(1,maxWidth/screenWidth,Math.sqrt(maxPixels/(screenWidth*screenHeight)));
  let width=Math.max(390,Math.round(screenWidth*scale));
  let height=Math.max(1,Math.round(width*screenHeight/screenWidth));
  while(width>390&&width*height>maxPixels){width--;height=Math.max(1,Math.round(width*screenHeight/screenWidth))}
  return {width,height,wideDesktop};
}
function renderBackdropOnGpu(bitmap,brightness,radius){
  const job=backdropGpuQueue.then(()=>renderBackdropRaster(bitmap,[brightness],radius));
  backdropGpuQueue=job.catch(()=>{});return job.then(urls=>urls[0]);
}
function renderBackdropVariantsOnGpu(bitmap,darkBrightness,lightBrightness,radius){
  const job=backdropGpuQueue.then(()=>renderBackdropRaster(bitmap,[darkBrightness,lightBrightness],radius));
  backdropGpuQueue=job.catch(()=>{});
  return job.then(urls=>({dark:urls[0],light:urls[1]}));
}
async function renderBackdropRaster(bitmap, brightnesses, radius) {
  const viewport=document.getElementById('glassGpu')?.getBoundingClientRect();
  const sceneHeight=document.getElementById('glassWallpaper')?.getBoundingClientRect().height||window.innerHeight;
  const anchored=document.documentElement.dataset.glassScroll==='anchored';
  const screenWidth=anchored?window.innerWidth:viewport?.width||window.innerWidth;
  const screenHeight=anchored?sceneHeight:viewport?.height||sceneHeight;
  const dimensions=backdropRasterDimensions(screenWidth,screenHeight);
  const {width,height,wideDesktop}=dimensions;
  const source=document.createElement('canvas');source.width=width;source.height=height;
  const ctx=source.getContext('2d');
  const fit=Math.max(width/bitmap.width,height/bitmap.height);
  const dw=bitmap.width*fit,dh=bitmap.height*fit;
  ctx.drawImage(bitmap,(width-dw)/2,(height-dh)/2,dw,dh);
  const output=document.createElement('canvas');output.width=width;output.height=height;
  const gl=output.getContext('webgl2',{alpha:false,antialias:false,preserveDrawingBuffer:true});
  if(!gl){source.width=source.height=output.width=output.height=1;throw Error('WebGL2 unavailable')}
  const textures=[],frames=[],buffers=[],programs=[],shaders=[],urls=[];
  try{
  // Preserve the fractional values created by each blur pass. Keep the
  // larger touch/tablet textures on RGBA8 to bound iOS GPU memory usage.
  const canUseFloat=()=>{
    if((!wideDesktop&&width*height>900000)||!gl.getExtension('EXT_color_buffer_float')||!gl.getExtension('OES_texture_float_linear'))return false;
    const probe=gl.createTexture(),frame=gl.createFramebuffer();
    gl.bindTexture(gl.TEXTURE_2D,probe);
    gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,1,1,0,gl.RGBA,gl.HALF_FLOAT,null);
    gl.bindFramebuffer(gl.FRAMEBUFFER,frame);
    gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,probe,0);
    const supported=gl.checkFramebufferStatus(gl.FRAMEBUFFER)===gl.FRAMEBUFFER_COMPLETE;
    gl.bindFramebuffer(gl.FRAMEBUFFER,null);gl.deleteFramebuffer(frame);gl.deleteTexture(probe);
    return supported;
  };
  const floatIntermediates=canUseFloat();
  document.documentElement.dataset.glassBlurPrecision=floatIntermediates?'rgba16f':'rgba8';
  const shader=(type,code)=>{
    const value=gl.createShader(type);shaders.push(value);gl.shaderSource(value,code);gl.compileShader(value);
    if(!gl.getShaderParameter(value,gl.COMPILE_STATUS))throw Error(gl.getShaderInfoLog(value));
    return value;
  };
  const program=gl.createProgram();programs.push(program);
  gl.attachShader(program,shader(gl.VERTEX_SHADER,`#version 300 es
  layout(location=0) in vec2 p;out vec2 uv;
  void main(){uv=(p+1.0)*0.5;gl_Position=vec4(p,0.0,1.0);}`));
  gl.attachShader(program,shader(gl.FRAGMENT_SHADER,`#version 300 es
  precision highp float;in vec2 uv;out vec4 color;
  uniform sampler2D image;uniform vec2 direction;uniform float tone;uniform float grain;
  void main(){
    vec3 c=texture(image,uv).rgb*0.227027;
    c+=(texture(image,uv+direction).rgb+texture(image,uv-direction).rgb)*0.194595;
    c+=(texture(image,uv+direction*2.0).rgb+texture(image,uv-direction*2.0).rgb)*0.121622;
    c+=(texture(image,uv+direction*3.0).rgb+texture(image,uv-direction*3.0).rgb)*0.054054;
    c+=(texture(image,uv+direction*4.0).rgb+texture(image,uv-direction*4.0).rgb)*0.016216;
    float noise=fract(sin(dot(gl_FragCoord.xy,vec2(12.9898,78.233)))*43758.5453)-0.5;
    color=vec4(clamp(c*tone+vec3(noise*grain/255.0),0.0,1.0),1.0);
  }`));
  gl.linkProgram(program);
  if(!gl.getProgramParameter(program,gl.LINK_STATUS))throw Error(gl.getProgramInfoLog(program));
  gl.useProgram(program);gl.viewport(0,0,width,height);
  const buffer=gl.createBuffer();buffers.push(buffer);gl.bindBuffer(gl.ARRAY_BUFFER,buffer);
  gl.bufferData(gl.ARRAY_BUFFER,new Float32Array([-1,-1,1,-1,-1,1,1,1]),gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);gl.vertexAttribPointer(0,2,gl.FLOAT,false,0,0);
  const texture=(pixels)=>{
    const tex=gl.createTexture();textures.push(tex);gl.bindTexture(gl.TEXTURE_2D,tex);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_S,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_WRAP_T,gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MIN_FILTER,gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D,gl.TEXTURE_MAG_FILTER,gl.LINEAR);
    if(pixels)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,gl.RGBA,gl.UNSIGNED_BYTE,pixels);
    else if(floatIntermediates)gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA16F,width,height,0,gl.RGBA,gl.HALF_FLOAT,null);
    else gl.texImage2D(gl.TEXTURE_2D,0,gl.RGBA,width,height,0,gl.RGBA,gl.UNSIGNED_BYTE,null);
    return tex;
  };
  gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL,true);
  const input=texture(source);const horizontal=texture(null);const vertical=texture(null);
  const frame=(tex)=>{const f=gl.createFramebuffer();frames.push(f);gl.bindFramebuffer(gl.FRAMEBUFFER,f);gl.framebufferTexture2D(gl.FRAMEBUFFER,gl.COLOR_ATTACHMENT0,gl.TEXTURE_2D,tex,0);if(gl.checkFramebufferStatus(gl.FRAMEBUFFER)!==gl.FRAMEBUFFER_COMPLETE)throw Error('GPU framebuffer incomplete');return f};
  const hFrame=frame(horizontal),vFrame=frame(vertical);
  const direction=gl.getUniformLocation(program,'direction'),tone=gl.getUniformLocation(program,'tone'),grain=gl.getUniformLocation(program,'grain');
  const draw=(from,to,x,y,light,dither=0)=>{
    gl.bindFramebuffer(gl.FRAMEBUFFER,to);gl.activeTexture(gl.TEXTURE0);gl.bindTexture(gl.TEXTURE_2D,from);
    gl.uniform2f(direction,x,y);gl.uniform1f(tone,light);gl.uniform1f(grain,dither);gl.drawArrays(gl.TRIANGLE_STRIP,0,4);
  };
  // Vary sample spacing across rounds. Reusing one wide spacing produces
  // visible stripes on high contrast poster lettering.
  const blurRadius=wideDesktop?radius*width/900:radius;
  const steps=[blurRadius/14,blurRadius/7,blurRadius/4,blurRadius/2.8];
  let from=input;
  for(let i=0;i<steps.length;i++){
    draw(from,hFrame,steps[i]/width,0,1);
    if(i!==steps.length-1)draw(horizontal,vFrame,0,steps[i]/height,1);
    from=vertical;
  }
  for(const brightness of brightnesses){
    draw(horizontal,null,0,steps[steps.length-1]/height,brightness,1);
    const blob=await new Promise(resolve=>output.toBlob(resolve,'image/png'));
    if(!blob)throw Error('GPU output unavailable');
    urls.push(URL.createObjectURL(blob));
  }
  return urls;
  }catch(error){
    for(const url of urls)URL.revokeObjectURL(url);
    throw error;
  }finally{
    for(const t of textures)gl.deleteTexture(t);
    for(const f of frames)gl.deleteFramebuffer(f);
    for(const b of buffers)gl.deleteBuffer(b);
    for(const p of programs)gl.deleteProgram(p);
    for(const s of shaders)gl.deleteShader(s);
    gl.getExtension('WEBGL_lose_context')?.loseContext();
    source.width=source.height=output.width=output.height=1;
  }
}
