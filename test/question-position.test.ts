import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser helper is plain JavaScript.
import {QuestionPanel} from '../web/questions.js';

test('confirmed question answers keep their values and queue receipt when a legacy worker later closes the prompt',()=>{
 const panel=new QuestionPanel({},()=>{},()=>true,()=>{}),card={id:'q',questions:[],createdAt:1,source:'async:call',status:'answered',answers:{q0:['A']},delivery:'queued'};
 panel.event(card);panel.event({...card,status:'cancelled',answers:undefined});panel.event({...card,status:'answered',answers:undefined,delivery:undefined});assert.deepEqual(panel.cards.get('q').answers,{q0:['A']});assert.equal(panel.cards.get('q').delivery,'queued');assert.equal(panel.cards.get('q').status,'answered');
});
test('live question captures its trigger once; answers and stream replacements preserve that anchor',()=>{
  const panel=new QuestionPanel({},()=>{},()=>true,()=>{});let latest='original';panel.anchor=()=>latest;
  const card={id:'q',questions:[],createdAt:100,status:'pending',source:'async:call'};
  panel.event(card,true);latest='later';panel.event({...card,status:'answered',answers:{}},true);
  assert.equal(panel.cards.get('q').anchorId,'original');
  panel.replaceAnchors(['original'],'canonical-original');assert.equal(panel.cards.get('q').anchorId,'canonical-original');
  panel.event(card,true);assert.equal(panel.cards.get('q').status,'answered');
  panel.event({...card,id:'replayed',status:'answered'});assert.equal(panel.cards.get('replayed').anchorId,undefined);
});
