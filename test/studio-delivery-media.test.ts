import {test} from 'node:test';import assert from 'node:assert/strict';
// @ts-ignore Browser pure helper.
import {deliveryReferences} from '../web/studio-delivery-media.js';
test('delivery previews use scoped actual artifacts, deduplicate paths and keep video on its stream route',()=>{
 const a={id:'art',sessionId:'s1',artifacts:[{path:'project/A.png',description:'A'}]},b={id:'models',sessionId:'s2',artifacts:[{path:'project\\A.png'},{path:'project/contact.png'},{path:'project/showcase.mp4'}]},delivery={id:'studio-delivery',sessionId:'s3',artifacts:[{path:'project/contact.png'}]};
 const refs=deliveryReferences({tasks:[a,b]},delivery);assert.equal(refs.length,3);assert.deepEqual(refs.map((r:any)=>r.taskId),['art','models','models']);assert.equal(refs[2].kind,'video');assert.equal(refs[2].index,2);assert.equal(deliveryReferences({tasks:[a,b]},a).length,1);
});
