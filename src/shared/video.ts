// Identify supported containers from bytes, never from a caller-supplied MIME or filename.
export function videoMime(bytes:Buffer):string|undefined{
  if(bytes.length>=16&&bytes.toString('ascii',4,8)==='ftyp'){
    const box=bytes.readUInt32BE(0);if(box<16||box>bytes.length)return;
    const brands=[bytes.toString('ascii',8,12)];for(let i=16;i+4<=Math.min(box,256);i+=4)brands.push(bytes.toString('ascii',i,i+4));
    if(brands.includes('qt  '))return 'video/quicktime';
    if(brands.some(b=>/^(?:isom|iso[2-9]|mp4[12]|avc1|M4V |MSNV|dash)$/.test(b)))return 'video/mp4';
  }
  if(bytes.length>=12&&bytes.readUInt32BE(0)===0x1a45dfa3&&bytes.subarray(4,Math.min(bytes.length,4096)).includes(Buffer.from('webm')))return 'video/webm';
}
