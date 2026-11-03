import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';

const source=readFileSync(new URL('../web/theme.js',import.meta.url),'utf8');
function browser(dark:boolean,saved:string|null=null,unavailable=false){
  const dataset:Record<string,string>={},handlers=new Map(),media={matches:dark,addEventListener:(_:string,fn:()=>void)=>handlers.set('system',fn)};
  const attributes:Record<string,string>={},button={dataset:{},textContent:'',setAttribute:(key:string,value:string)=>attributes[key]=value};
  const storage=new Map(saved?[['agent-relay-theme',saved]]:[]);
  runInNewContext(source,{matchMedia:()=>media,localStorage:{getItem:(key:string)=>{if(unavailable)throw Error('disabled');return storage.get(key)??null},setItem:(key:string,value:string)=>{if(unavailable)throw Error('disabled');storage.set(key,value)}},document:{documentElement:{dataset},querySelectorAll:()=>[button],querySelector:()=>null,addEventListener:(name:string,fn:()=>void)=>handlers.set(name,fn)}});
  handlers.get('DOMContentLoaded')();
  return {dataset,storage,attributes,change:(value:boolean)=>{media.matches=value;handlers.get('system')()},click:()=>handlers.get('click')({target:{closest:()=>button}})};
}
test('theme defaults to and tracks system, preserves explicit choices, and can return to system',()=>{
  const page=browser(false);assert.equal(page.dataset.theme,'light');assert.equal(page.dataset.themeMode,'system');
  page.change(true);assert.equal(page.dataset.theme,'dark');
  page.click();assert.equal(page.dataset.themeMode,'light');page.change(false);page.change(true);assert.equal(page.dataset.theme,'light');
  page.click();assert.equal(page.dataset.theme,'dark');page.click();assert.equal(page.dataset.themeMode,'system');
  page.change(false);assert.equal(page.dataset.theme,'light');assert.equal(page.storage.get('agent-relay-theme'),'system');
  assert.match(page.attributes['aria-label'],/跟随系统/);
  assert.equal(browser(false,'dark').dataset.theme,'dark');assert.equal(browser(true,'light').dataset.theme,'light');
  const privatePage=browser(true,null,true);assert.equal(privatePage.dataset.theme,'dark');privatePage.change(false);assert.equal(privatePage.dataset.theme,'light');privatePage.click();
});
