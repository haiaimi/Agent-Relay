import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser module has no import-time browser dependency.
import {ConversationCache,conversationIdentity,pagedConversationCache,conversationCache} from '../web/conversation-cache.js';
function disk(){const entries=new Map<string,any>();return {entries,async read(key:string){return entries.get(key);},async write(value:any){entries.set(value.key,structuredClone(value));},async clear(){entries.clear();}};}
test('conversation cache restores a durable transcript with pagination and reading position; identity and size remain bounded',async()=>{
  const store=disk(),cache=new ConversationCache({disk:store,maxEntries:2}),session={id:'pc:claude:a',hostId:'pc',nativeId:'a',provider:'claude',cwd:'E:/game'},identity=conversationIdentity(session);
  const value={messages:[{id:'m',text:'Saved reply'}],pager:{initialized:true,cursor:25,olderLoaded:true},view:{anchor:{id:'m',offset:-50},scrollTop:440,follow:false}};
  cache.put('a',identity,value);value.messages[0].text='Changed caller object';assert.equal(cache.peek('a',identity).messages[0].text,'Saved reply');await cache.writes;
  const reopened=new ConversationCache({disk:store});assert.deepEqual(await reopened.read('a',identity),{...value,messages:[{id:'m',text:'Saved reply'}]});assert.equal(await reopened.read('a',conversationIdentity({...session,cwd:'E:/other'})),null);
  cache.put('b','b',{});cache.peek('a',identity);cache.put('c','c',{});assert.equal(cache.entries.has('b'),false);assert.equal(cache.entries.has('a'),true);assert.equal(cache.entries.has('c'),true);
  cache.put('huge','h',{text:'x'.repeat(9*1024*1024)});assert.equal(cache.entries.has('huge'),false);
});
test('storage rejection leaves instant memory caching usable; logout invalidates pending disk reads and queued writes',async()=>{
  const cache=new ConversationCache({disk:{async read(){throw Error('denied');},async write(){throw Error('quota');},async clear(){throw Error('denied');}}});cache.put('a','a',{messages:['memory']});await cache.writes;assert.deepEqual(cache.peek('a','a'),{messages:['memory']});assert.equal(await cache.read('missing','missing'),null);
  let release!:(value:any)=>void;const pending=new Promise<any>(r=>release=r),store=disk(),other=new ConversationCache({disk:{...store,read:()=>pending}}),read=other.read('a','a');
  other.put('b','b',{messages:['before logout']});await other.clear();release({version:1,key:'a',identity:'a',size:10,value:{messages:['late']}});assert.equal(await read,null);assert.equal(other.peek('b','b'),null);other.put('c','c',{});assert.equal(other.entries.size,0);assert.equal(store.entries.size,0);
  other.enable();other.put('new','new',{messages:['after login']});await other.writes;assert.equal(store.entries.size,1);
});
test('a disk read cannot overwrite a newer in-memory transcript',async()=>{
  let release!:(value:any)=>void;const cache=new ConversationCache({disk:{read:()=>new Promise(r=>release=r),async write(){},async clear(){}}}),read=cache.read('a','a');cache.put('a','a',{messages:['new']});release({version:1,key:'a',identity:'a',size:10,value:{messages:['old']}});assert.deepEqual(await read,{messages:['new']});
});
test('studio page cache restores role/group history and cursor, retains hidden reading position and never replays cached approvals',async()=>{
  conversationCache.enable();let identity='studio-role-a',generation=1,nextCursor:any=20;
  const pages=new Map<any,any>([['latest',{messages:[{id:'a',text:'Role A'}],questions:[{id:'pending'}],events:[{type:'message',data:{id:'tool'}},{type:'approval',data:{id:'permission'}},{type:'question',data:{id:'question'}}]}]]),timeline={scrollTop:300,scrollHeight:1000,clientHeight:200};let restored=0;
  const cache=pagedConversationCache({target:()=>({identity,generation}),pages,cursor:()=>nextCursor,restore:(v:any)=>{nextCursor=v.cursor;restored++;},view:()=>timeline,note(){}});
  cache.save();timeline.clientHeight=0;timeline.scrollTop=0;cache.save();pages.clear();timeline.clientHeight=200;cache.load();assert.equal(restored,1);assert.equal(timeline.scrollTop,300);assert.equal(nextCursor,20);assert.equal(pages.get('latest').questions,undefined);assert.deepEqual(pages.get('latest').events.map((e:any)=>e.type),['message']);
  pages.clear();identity='studio-role-b';generation++;cache.load();await Promise.resolve();assert.equal(pages.size,0);await conversationCache.clear();
});
