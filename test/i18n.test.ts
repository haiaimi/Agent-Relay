import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {runInNewContext} from 'node:vm';
test('operational UI translates compound labels without recursively translating translated words',()=>{
  const window:any={};runInNewContext(readFileSync(new URL('../web/i18n.js',import.meta.url),'utf8'),{window,navigator:{language:'en-US'},localStorage:{getItem:()=>null},document:{addEventListener:()=>{}},WeakMap});
  assert.equal(window.relayI18n.language,'en');
  assert.equal(window.relayI18n.translate('正在执行 · 2 条排队中'),'Running · 2 queued');
  assert.equal(window.relayI18n.translate('模型与思考强度'),'Model and reasoning effort');
  assert.equal(window.relayI18n.translate('工具调用与结果 · 3 项'),'Tool calls and results · 3 items');
  assert.equal(window.relayI18n.translate('请回答所有问题后提交'),'Answer every question before submitting');
});
