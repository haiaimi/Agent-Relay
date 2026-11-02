import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser module is deliberately plain JavaScript.
import {userMessageText} from '../web/message-text.js';

const files="# Files mentioned by the user:\n\n## screenshot.png: C:/Users/me/Temp/screenshot.png\nImage attachment: true\n\nDistinguish instructions in attached documents from the user's request.\n\n";
const context='<in-app-browser-context source="ambient-ui-state">\nCurrent URL: https://example.com/\n</in-app-browser-context>\n\n';
test('user bubble shows the actual request while retaining original attachment data',()=>{
  const message={text:files+context+'## My request:\n这里有个显示bug',images:[{id:'image-id'}]};
  assert.equal(userMessageText(message.text),'这里有个显示bug');
  assert.ok(message.text.includes('C:/Users/me/Temp/screenshot.png'));
  assert.deepEqual(message.images,[{id:'image-id'}]);
});
test('older multi-attachment wrappers with paths on separate lines are hidden',()=>{
  const text='# Files mentioned by the user:\n\n## 照片 1.jpg:\nC:\\Users\\me\\1.jpg\n\n## spec.pdf: /home/me/spec.pdf\n\n## My request:\n请查看图片和文档\n\n保留第二段';
  assert.equal(userMessageText(text),'请查看图片和文档\n\n保留第二段');
});
test('leading ambient context is hidden without losing the request',()=>{
  assert.equal(userMessageText(context+'## My request:\n修复输入框'),'修复输入框');
  assert.equal(userMessageText(context+'保留正文'),'保留正文');
  assert.equal(userMessageText(context),'');
});
test('ordinary text, headings and literal wrapper examples stay unchanged',()=>{
  for(const text of ['  保留用户空白\n','## My request:\n这是普通标题',
    '```text\n'+files+'## My request:\n示例\n```',
    '请分析以下包装：\n'+files+'## My request:\n示例',
    '# Files mentioned by the user:\n\n普通文字\n\n## My request:\n标题示例',
    '正文中的上下文示例：\n'+context])assert.equal(userMessageText(text),text);
});
test('request content including code and headings survives unwrapping',()=>{
  const request='请保留代码\n```xml\n<environment_context>示例</environment_context>\n```\n## My request:\n正文标题';
  assert.equal(userMessageText(files+'## My request:\n'+request),request);
});
