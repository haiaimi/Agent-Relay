import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {RelayStore} from '../src/relay/store.js';
import {MediaStore} from '../src/shared/media.js';
import {StudioPreviews} from '../src/relay/studio-previews.js';

test('review previews coalesce transfers, survive restart and stay isolated by session and review version',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'review-cache-')),store=new RelayStore(dir),media=new MediaStore(dir,store.db);
  const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=','base64'),ref=media.put('one',png,'concept.png');
  const key=JSON.stringify(['run','art','action',1,'review','one','concept.png']);let reads=0;
  const load=async()=>{reads++;await new Promise(r=>setImmediate(r));return {bytes:png,mime:'image/png',name:'concept.png',sha256:ref.id!};};
  try{
    const cache=new StudioPreviews(store.db,media),results=await Promise.all([cache.get(key,'one',load),cache.get(key,'one',load)]);
    assert.equal(reads,1);assert.equal(results[0].sha256,ref.id);
    const restarted=new StudioPreviews(store.db,media);assert.equal((await restarted.get(key,'one',load)).source,'server-review-cache');assert.equal(reads,1);assert.equal(restarted.knownHash('one','concept.png'),ref.id);assert.equal(restarted.knownHash('two','concept.png'),undefined);
    await assert.rejects(restarted.get(key,'two',load),/安全缓存/);
    await restarted.get(key.replace('review','review2'),'one',load);assert.equal(reads,3);
    await restarted.get(key,'one',load,true);assert.equal(reads,4);
  }finally{store.close();rmSync(dir,{recursive:true,force:true});}
});
