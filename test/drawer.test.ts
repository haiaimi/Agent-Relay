import {test} from 'node:test';
import assert from 'node:assert/strict';
// @ts-expect-error Browser helper is plain JavaScript.
import {dragOffset,horizontalIntent,drawerOpens} from '../web/drawer.js';
test('drawer gestures preserve vertical scrolling, clamp movement, and settle by distance or swipe velocity',()=>{
 assert.equal(horizontalIntent(5,60),false);assert.equal(horizontalIntent(30,25),false);assert.equal(horizontalIntent(60,10),true);
 assert.equal(dragOffset(-320,500,320),0);assert.equal(dragOffset(0,-500,320),-320);
 assert.equal(drawerOpens(-100,320,.1),true);assert.equal(drawerOpens(-240,320,.1),false);
 assert.equal(drawerOpens(-260,320,.8),true);assert.equal(drawerOpens(-40,320,-.8),false);
});
