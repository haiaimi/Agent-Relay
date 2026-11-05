import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,mkdirSync,writeFileSync,rmSync,symlinkSync,unlinkSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {BridgeStore} from '../src/bridge/store.js';
import {studioArtifact} from '../src/bridge/studio-artifact.js';
import {MediaStore} from '../src/shared/media.js';
import {validateAction,type Session} from '../src/shared/protocol.js';
test('visual previews read only real image files in the demand workspace and return immutable content hashes',()=>{
  const root=mkdtempSync(join(tmpdir(),'studio-visual-')),cwd=join(root,'workspace'),outside=join(root,'outside');mkdirSync(cwd);mkdirSync(outside);const store=new BridgeStore(join(root,'store')),media=new MediaStore(join(root,'store'),store.db),session:Session={id:'pc:codex:'+randomUUID(),hostId:'pc',provider:'codex',nativeId:randomUUID(),cwd,title:'原画',status:'idle',updatedAt:Date.now(),managed:true,projectId:'studio-'+randomUUID()},png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1cAAAAASUVORK5CYII=','base64');
  try{
    writeFileSync(join(cwd,'concept.png'),png);const payload=studioArtifact(media,session,'concept.png');assert.equal(payload.id,createHash('sha256').update(png).digest('hex'));assert.equal(payload.mime,'image/png');assert.deepEqual(Buffer.from(payload.data,'base64'),png);
    const unchanged=studioArtifact(media,session,'concept.png',cwd,payload.id);assert.equal(unchanged.unchanged,true);assert.equal(unchanged.data,'');assert.equal(unchanged.id,payload.id);
    writeFileSync(join(outside,'secret.png'),png);assert.throws(()=>studioArtifact(media,session,'../outside/secret.png'),/超出/);writeFileSync(join(cwd,'fake.png'),'private text');assert.throws(()=>studioArtifact(media,session,'fake.png'),/实际/);assert.throws(()=>studioArtifact(media,{...session,projectId:'game'},'concept.png'),/工作副本/);assert.equal(studioArtifact(media,{...session,managed:false,statusOrigin:'native'},'concept.png').id,payload.id);mkdirSync(join(cwd,'project'));assert.equal(studioArtifact(media,{...session,cwd:join(cwd,'project')},'concept.png',cwd).id,payload.id);assert.throws(()=>studioArtifact(media,{...session,cwd:outside},'concept.png',cwd),/会话不属于/);
    symlinkSync(outside,join(cwd,'linked'),'junction');assert.throws(()=>studioArtifact(media,session,'linked/secret.png'),/超出/);
    const command={id:randomUUID(),type:'studio-artifact',sessionId:session.id,artifactPath:'concept.png'};assert.doesNotThrow(()=>validateAction(command));assert.doesNotThrow(()=>validateAction({...command,artifactHash:payload.id}));assert.throws(()=>validateAction({...command,artifactHash:'bad'}),/版本/);assert.throws(()=>validateAction({...command,sessionId:undefined}),/Session/);assert.throws(()=>validateAction({...command,artifactPath:'\0'}),/原画/);assert.throws(()=>validateAction({...command,type:'send',text:'hi'}),/原画路径/);
  }finally{store.close();try{unlinkSync(join(cwd,'linked'));}catch(e){if((e as NodeJS.ErrnoException).code!=='ENOENT')throw e;}rmSync(root,{recursive:true,force:true,maxRetries:4,retryDelay:100});}
});
